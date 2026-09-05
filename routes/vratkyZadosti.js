const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { jeZablokovana, zaznamenatZadost } = require('../middleware/vratkyLimiter');
const { odeslat_potvrzeni_vratky, odeslat_upozorneni_vratky } = require('./emaily');

async function initTabulka() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vratky_zadosti (
        id SERIAL PRIMARY KEY,
        objednavka_id INTEGER REFERENCES objednavky(id) ON DELETE SET NULL,
        jmeno TEXT,
        email TEXT NOT NULL,
        telefon TEXT,
        polozky JSONB NOT NULL,
        duvod TEXT,
        stav TEXT DEFAULT 'nova',
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Vratky_zadosti tabulka OK');
  } catch (e) {
    console.log('Vratky_zadosti tabulka chyba:', e.message);
  }
}
initTabulka();

// ═══════════════════════════════
// VEŘEJNÉ – zákazník ověří objednávku a podá žádost
// ═══════════════════════════════

// POST /api/vratky-zadosti/overit – najít objednávku podle čísla + e-mailu
router.post('/overit', async (req, res) => {
  const { objednavka_id, email } = req.body;

  // Rate limit i tady - endpoint jen ověřuje shodu čísla objednávky a e-mailu,
  // bez něj by šlo hádat platné kombinace hrubou silou.
  const zbyvaSekund = jeZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho pokusů z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }

  if (!objednavka_id || !email) {
    return res.status(400).json({ chyba: 'Zadejte prosím číslo objednávky a e-mail.' });
  }
  zaznamenatZadost(req.ip);
  try {
    const objednavka = await pool.query(`
      SELECT o.id, o.stav, o.celkem, o.vytvoreno, z.email
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      WHERE o.id = $1
    `, [objednavka_id]);

    if (objednavka.rows.length === 0 || objednavka.rows[0].email.toLowerCase() !== String(email).toLowerCase().trim()) {
      return res.status(404).json({ chyba: 'Objednávka s tímto číslem a e-mailem nebyla nalezena.' });
    }

    const polozky = await pool.query(`
      SELECT op.produkt_id, op.velikost, op.pocet, op.cena, p.nazev
      FROM objednavky_polozky op
      JOIN produkty p ON op.produkt_id = p.id
      WHERE op.objednavka_id = $1
    `, [objednavka_id]);

    res.json({ objednavka: objednavka.rows[0], polozky: polozky.rows });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/vratky-zadosti – podat žádost o vrácení
router.post('/', async (req, res) => {
  const { objednavka_id, email, jmeno, telefon, polozky, duvod, webova_stranka } = req.body;

  // Honeypot - skryté pole, které reální uživatelé nikdy nevyplní.
  if (webova_stranka) {
    return res.json({ id: 0 });
  }

  const zbyvaSekund = jeZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho žádostí z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }

  if (!objednavka_id || !email || !Array.isArray(polozky) || !polozky.length) {
    return res.status(400).json({ chyba: 'Chybí povinné údaje.' });
  }

  try {
    // Znovu ověřit, že objednávka a e-mail sedí (nespoléhat jen na frontend)
    const objednavka = await pool.query(`
      SELECT o.id, z.email FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      WHERE o.id = $1
    `, [objednavka_id]);

    if (objednavka.rows.length === 0 || objednavka.rows[0].email.toLowerCase() !== String(email).toLowerCase().trim()) {
      return res.status(404).json({ chyba: 'Objednávka s tímto číslem a e-mailem nebyla nalezena.' });
    }

    // Položky k vrácení se nikdy neukládají tak, jak je poslal klient (to by
    // znamenalo věřit i vymyšlenému produktu/názvu/množství) - ověří se proti
    // skutečným položkám téhle objednávky a uloží se autoritativní název/cena z DB.
    const skutecnePolozky = await pool.query(`
      SELECT op.produkt_id, op.velikost, op.pocet, op.cena, p.nazev
      FROM objednavky_polozky op
      JOIN produkty p ON op.produkt_id = p.id
      WHERE op.objednavka_id = $1
    `, [objednavka_id]);
    const mapaObjednanych = new Map(skutecnePolozky.rows.map(r => [`${r.produkt_id}_${r.velikost}`, r]));

    const pozadovaneSoucty = new Map(); // klíč -> součet požadovaného počtu (kdyby klient poslal položku vícekrát)
    const overenePolozky = [];
    for (const p of polozky) {
      if (!p || !Number.isInteger(p.produkt_id) || p.velikost === undefined || p.velikost === null) {
        return res.status(400).json({ chyba: 'Neplatná položka k vrácení.' });
      }
      if (!Number.isInteger(p.pocet) || p.pocet <= 0) {
        return res.status(400).json({ chyba: 'Neplatný počet kusů k vrácení.' });
      }
      const klic = `${p.produkt_id}_${p.velikost}`;
      const objednano = mapaObjednanych.get(klic);
      if (!objednano) {
        return res.status(400).json({ chyba: 'Vybraná položka nebyla součástí této objednávky.' });
      }
      const celkemPozadovano = (pozadovaneSoucty.get(klic) || 0) + p.pocet;
      if (celkemPozadovano > objednano.pocet) {
        return res.status(400).json({ chyba: `Nelze vrátit ${celkemPozadovano} ks položky "${objednano.nazev}" - objednáno bylo jen ${objednano.pocet} ks.` });
      }
      pozadovaneSoucty.set(klic, celkemPozadovano);
      overenePolozky.push({ produkt_id: p.produkt_id, velikost: p.velikost, pocet: p.pocet, nazev: objednano.nazev, cena: Number(objednano.cena) });
    }

    const result = await pool.query(
      'INSERT INTO vratky_zadosti (objednavka_id, jmeno, email, telefon, polozky, duvod) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [objednavka_id, jmeno || null, email, telefon || null, JSON.stringify(overenePolozky), duvod || null]
    );

    zaznamenatZadost(req.ip);
    res.json(result.rows[0]);

    // Potvrzení zákazníkovi (zákonná povinnost) i upozornění majitelce se posílají
    // až po odpovědi, ať prodleva/chyba s odesláním žádost o vrácení nezablokuje.
    const zadost = { objednavka_id, jmeno, email, telefon, polozky: overenePolozky, duvod };
    odeslat_potvrzeni_vratky(zadost).catch(e => console.error('Potvrzeni zadosti o vratku se nepodarilo odeslat:', e.message));
    odeslat_upozorneni_vratky(zadost).catch(e => console.error('Upozorneni majitelce o vratce se nepodarilo odeslat:', e.message));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// ═══════════════════════════════
// ADMIN – správa žádostí
// ═══════════════════════════════

router.get('/', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vratky_zadosti ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.patch('/:id/stav', vyzadovatAdmina, async (req, res) => {
  const { stav } = req.body;
  const povolene = ['nova', 'schvalena', 'zamitnuta', 'vyrizena'];
  if (!povolene.includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  try {
    const result = await pool.query('UPDATE vratky_zadosti SET stav=$1 WHERE id=$2 RETURNING *', [stav, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.delete('/:id', vyzadovatAdmina, async (req, res) => {
  try {
    await pool.query('DELETE FROM vratky_zadosti WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
