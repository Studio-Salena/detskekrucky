const { odeslat_potvrzeni, odeslat_upozorneni_objednavky } = require('./emaily');
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { jeZablokovana, zaznamenatObjednavku } = require('../middleware/objednavkyLimiter');

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
  const { jmeno, email, telefon, ulice, mesto, psc, doprava, platba, poznamka, polozky, webova_stranka } = req.body;

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
    // souběžné objednávky na poslední kus nemohly obě projít kontrolou) a spocitat celkem
    let celkem = 0;
    for (const p of polozky) {
      const sklad = await client.query(
        'SELECT pocet_kusu FROM sklad WHERE produkt_id = $1 AND velikost = $2 FOR UPDATE',
        [p.produkt_id, p.velikost]
      );
      if (sklad.rows.length === 0 || sklad.rows[0].pocet_kusu < p.pocet) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: `Nedostatek zbozi na sklade: produkt ${p.produkt_id} velikost ${p.velikost}` });
      }
      celkem += p.cena * p.pocet;
    }

    // Doprava - podle zvoleného způsobu, osobní odběr je vždy zdarma
    const dopravaCena = vypocitatDopravu(doprava, celkem);
    celkem += dopravaCena;

    // Vytvorit objednavku
    const objednavka = await client.query(
      'INSERT INTO objednavky (zakaznik_id, doprava, platba, celkem, poznamka) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [zakaznik_id, doprava, platba, celkem, poznamka]
    );
    const objednavka_id = objednavka.rows[0].id;

    // Vlozit polozky a odecist ze skladu
    for (const p of polozky) {
      await client.query(
        'INSERT INTO objednavky_polozky (objednavka_id, produkt_id, velikost, pocet, cena) VALUES ($1,$2,$3,$4,$5)',
        [objednavka_id, p.produkt_id, p.velikost, p.pocet, p.cena]
      );
      await client.query(
        'UPDATE sklad SET pocet_kusu = pocet_kusu - $3 WHERE produkt_id = $1 AND velikost = $2',
        [p.produkt_id, p.velikost, p.pocet]
      );
      await client.query(
        'INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES ($1,$2,$3,$4,$5)',
        [p.produkt_id, p.velikost, 'prodej', p.pocet, `Objednavka #${objednavka_id}`]
      );
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
    polozky
  });
} catch (emailErr) {
  console.error('Chyba pri odesilani emailu:', emailErr.message);
}

res.json({ zprava: 'Objednavka uspesne vytvorena', objednavka_id, celkem });

// Upozornění majitelce se posílá až po odpovědi zákazníkovi, ať prodleva/chyba
// s odesláním objednávku nezablokuje (stejný vzor jako u rezervací).
odeslat_upozorneni_objednavky({
  objednavka_id, celkem, jmeno, email, telefon, ulice, mesto, psc, doprava, platba, polozky
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
      SELECT o.*, z.jmeno, z.email, z.telefon, z.ulice, z.mesto, z.psc
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
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
