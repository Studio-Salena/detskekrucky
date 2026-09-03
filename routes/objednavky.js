const { odeslat_potvrzeni, odeslat_upozorneni_objednavky } = require('./emaily');
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { jeZablokovana, zaznamenatObjednavku } = require('../middleware/objednavkyLimiter');

// Idempotentní migrace - vazba objednávky na uplatněný dárkový poukaz.
async function initObjednavkySloupce() {
  try {
    await pool.query(`
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS poukaz_id INTEGER;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS sleva NUMERIC NOT NULL DEFAULT 0;
    `);
    console.log('Objednavky sloupce OK');
  } catch (e) {
    console.log('Objednavky sloupce chyba:', e.message);
  }
}
initObjednavkySloupce();

const DOPRAVA_CENY = { zasilkovna: 79, ceska_posta: 89, osobni_odber: 0 };
const DOPRAVA_ZDARMA_OD = 800;

function vypocitatDopravu(doprava, mezisoucet) {
  if (doprava === 'osobni_odber') return 0;
  if (mezisoucet >= DOPRAVA_ZDARMA_OD) return 0;
  return DOPRAVA_CENY[doprava] ?? 79;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFON_RE = /^(\+420\s?)?\d{3}\s?\d{3}\s?\d{3}$/;
const PSC_RE = /^\d{3}\s?\d{2}$/;

function validovatObjednavku({ jmeno, email, telefon, ulice, mesto, psc }) {
  if (!jmeno || jmeno.trim().split(/\s+/).length < 2) return 'Zadejte prosím jméno a příjmení.';
  if (!email || !EMAIL_RE.test(email.trim())) return 'Zadejte prosím platnou e-mailovou adresu.';
  if (!telefon || !TELEFON_RE.test(telefon.trim())) return 'Zadejte prosím platné telefonní číslo (např. 777 123 456).';
  if (!ulice || ulice.trim().length < 3) return 'Zadejte prosím ulici a číslo popisné.';
  if (!mesto || mesto.trim().length < 2) return 'Zadejte prosím město.';
  if (!psc || !PSC_RE.test(psc.trim())) return 'Zadejte prosím platné PSČ (např. 768 24).';
  return null;
}

// Vytvorit novou objednavku
router.post('/', async (req, res) => {
  const { jmeno, email, telefon, ulice, mesto, psc, doprava, platba, poznamka, polozky, webova_stranka, poukaz_kod } = req.body;

  // Honeypot - skryté pole, které reální uživatelé nikdy nevyplní, ale
  // formulářoví boti ano. Předstíráme úspěch, aby se bot nenaučil rozpoznat blokaci.
  if (webova_stranka) {
    return res.json({ zprava: 'Objednavka uspesne vytvorena', objednavka_id: 0, celkem: 0 });
  }

  const zbyvaSekund = jeZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho objednávek z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }

  if (!Array.isArray(polozky) || !polozky.length) {
    return res.status(400).json({ chyba: 'Košík je prázdný.' });
  }
  const chybaValidace = validovatObjednavku({ jmeno, email, telefon, ulice, mesto, psc });
  if (chybaValidace) {
    return res.status(400).json({ chyba: chybaValidace });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Vytvorit nebo najit zakaznika
    let zakaznik = await client.query(
      'SELECT id FROM zakaznici WHERE email = $1', [email]
    );
    let zakaznik_id;
    if (zakaznik.rows.length === 0) {
      const novy = await client.query(
        'INSERT INTO zakaznici (jmeno, email, telefon, ulice, mesto, psc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [jmeno, email, telefon, ulice, mesto, psc]
      );
      zakaznik_id = novy.rows[0].id;
    } else {
      zakaznik_id = zakaznik.rows[0].id;
    }

    // Zkontrolovat sklad (FOR UPDATE - zamkne řádky do konce transakce, aby dvě
    // souběžné objednávky na poslední kus nemohly obě projít kontrolou) a spocitat celkem.
    // Položky "u dodavatele" nemají reálnou sledovanou zásobu - projdou bez ohledu
    // na pocet_kusu a při expedici se ze skladu neodečítají (viz níže).
    let celkem = 0;
    const dostupnostMap = new Map(); // "produkt_id_velikost" -> 'skladem' | 'dodavatel'
    for (const p of polozky) {
      const sklad = await client.query(
        'SELECT pocet_kusu, dostupnost FROM sklad WHERE produkt_id = $1 AND velikost = $2 FOR UPDATE',
        [p.produkt_id, p.velikost]
      );
      if (sklad.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: `Nedostatek zbozi na sklade: produkt ${p.produkt_id} velikost ${p.velikost}` });
      }
      const radek = sklad.rows[0];
      const jeUDodavatele = radek.dostupnost === 'dodavatel';
      if (!jeUDodavatele && radek.pocet_kusu < p.pocet) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: `Nedostatek zbozi na sklade: produkt ${p.produkt_id} velikost ${p.velikost}` });
      }
      dostupnostMap.set(`${p.produkt_id}_${p.velikost}`, radek.dostupnost);
      celkem += p.cena * p.pocet;
    }

    const mezisoucet = celkem;

    // Uplatnit dárkový poukaz (pokud je zadaný) - stejná transakce jako sklad,
    // ať se poukaz odečte, jen když se objednávka opravdu založí (a naopak).
    // FOR UPDATE zamkne řádek poukazu, aby ho nešlo dvakrát souběžně přečerpat.
    let poukaz_id = null, sleva = 0;
    if (poukaz_kod) {
      const kodNorm = String(poukaz_kod).trim().toUpperCase();
      const poukazRes = await client.query(
        'SELECT * FROM darkove_poukazy WHERE (UPPER(kod) = $1 OR ean = $1) FOR UPDATE',
        [kodNorm]
      );
      if (poukazRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Poukaz nebyl nalezen.' });
      }
      const poukaz = poukazRes.rows[0];
      if (poukaz.stav !== 'aktivni' || Number(poukaz.zustatek) <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Tento poukaz je již plně vyčerpaný nebo zrušený.' });
      }
      if (new Date(poukaz.platnost_do) < new Date()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Platnost poukazu vypršela.' });
      }
      poukaz_id = poukaz.id;
      sleva = Math.min(Number(poukaz.zustatek), mezisoucet);
    }

    // Doprava - podle zvoleného způsobu (po odečtení poukazu), osobní odběr je vždy zdarma
    const dopravaCena = vypocitatDopravu(doprava, mezisoucet - sleva);
    celkem = mezisoucet - sleva + dopravaCena;

    // Vytvorit objednavku
    const objednavka = await client.query(
      'INSERT INTO objednavky (zakaznik_id, doprava, platba, celkem, poznamka, poukaz_id, sleva) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [zakaznik_id, doprava, platba, celkem, poznamka, poukaz_id, sleva]
    );
    const objednavka_id = objednavka.rows[0].id;

    // Pokud byl uplatněn poukaz, teď skutečně odečíst zůstatek
    if (poukaz_id) {
      await client.query(
        'UPDATE darkove_poukazy SET zustatek = zustatek - $1, stav = CASE WHEN zustatek - $1 <= 0 THEN \'pouzity\' ELSE stav END WHERE id = $2',
        [sleva, poukaz_id]
      );
      await client.query(
        'INSERT INTO poukazy_pouziti (poukaz_id, castka, objednavka_id) VALUES ($1,$2,$3)',
        [poukaz_id, sleva, objednavka_id]
      );
    }

    // Vlozit polozky a odecist ze skladu (u položek "u dodavatele" se sklad
    // neodečítá - pocet_kusu tam nereprezentuje reálnou fyzickou zásobu)
    for (const p of polozky) {
      await client.query(
        'INSERT INTO objednavky_polozky (objednavka_id, produkt_id, velikost, pocet, cena) VALUES ($1,$2,$3,$4,$5)',
        [objednavka_id, p.produkt_id, p.velikost, p.pocet, p.cena]
      );
      if (dostupnostMap.get(`${p.produkt_id}_${p.velikost}`) !== 'dodavatel') {
        await client.query(
          'UPDATE sklad SET pocet_kusu = pocet_kusu - $3 WHERE produkt_id = $1 AND velikost = $2',
          [p.produkt_id, p.velikost, p.pocet]
        );
        await client.query(
          'INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES ($1,$2,$3,$4,$5)',
          [p.produkt_id, p.velikost, 'prodej', p.pocet, `Objednavka #${objednavka_id}`]
        );
      }
    }

    await client.query('COMMIT');
    zaznamenatObjednavku(req.ip);
    // Odeslat potvrzovaci email
try {
  await odeslat_potvrzeni({
    objednavka_id,
    celkem,
    jmeno,
    email,
    doprava,
    platba,
    polozky,
    sleva
  });
} catch (emailErr) {
  console.error('Chyba pri odesilani emailu:', emailErr.message);
}

res.json({ zprava: 'Objednavka uspesne vytvorena', objednavka_id, celkem });

// Upozornění majitelce se posílá až po odpovědi zákazníkovi, ať prodleva/chyba
// s odesláním objednávku nezablokuje (stejný vzor jako u rezervací).
odeslat_upozorneni_objednavky({
  objednavka_id, celkem, jmeno, email, telefon, ulice, mesto, psc, doprava, platba, polozky, sleva
}).catch(e => console.error('Upozorneni majitelce o objednavce se nepodarilo odeslat:', e.message));

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// Ziskat vsechny objednavky (jen pro admin – obsahuje osobní údaje zákazníků)
router.get('/', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.id, o.stav, o.doprava, o.platba, o.celkem, o.vytvoreno,
             z.jmeno, z.email, z.telefon, z.mesto
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      ORDER BY o.vytvoreno DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Detail objednavky (jen pro admin)
router.get('/:id', vyzadovatAdmina, async (req, res) => {
  try {
    const objednavka = await pool.query(`
      SELECT o.*, z.jmeno, z.email, z.telefon, z.ulice, z.mesto, z.psc, dp.kod AS poukaz_kod
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      LEFT JOIN darkove_poukazy dp ON o.poukaz_id = dp.id
      WHERE o.id = $1
    `, [req.params.id]);

    const polozky = await pool.query(`
      SELECT op.*, p.nazev, p.znacka
      FROM objednavky_polozky op
      JOIN produkty p ON op.produkt_id = p.id
      WHERE op.objednavka_id = $1
    `, [req.params.id]);

    res.json({ ...objednavka.rows[0], polozky: polozky.rows });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Zmenit stav objednavky (jen pro admin)
router.patch('/:id/stav', vyzadovatAdmina, async (req, res) => {
  const { stav } = req.body;
  const stavy = ['nova', 'zaplacena', 'odeslana', 'dorucena', 'zrusena'];
  if (!stavy.includes(stav)) {
    return res.status(400).json({ chyba: 'Neplatny stav' });
  }
  try {
    await pool.query('UPDATE objednavky SET stav = $1 WHERE id = $2', [stav, req.params.id]);
    res.json({ zprava: 'Stav aktualizovan' });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
