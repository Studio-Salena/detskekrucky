const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');

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
  if (!objednavka_id || !email) {
    return res.status(400).json({ chyba: 'Zadejte prosím číslo objednávky a e-mail.' });
  }
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
  const { objednavka_id, email, jmeno, telefon, polozky, duvod } = req.body;

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

    const result = await pool.query(
      'INSERT INTO vratky_zadosti (objednavka_id, jmeno, email, telefon, polozky, duvod) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [objednavka_id, jmeno || null, email, telefon || null, JSON.stringify(polozky), duvod || null]
    );

    res.json(result.rows[0]);
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
