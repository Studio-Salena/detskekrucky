const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { odeslat_potvrzeni_poradna, odeslat_upozorneni_poradna } = require('./emaily');

async function initTabulka() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS poradna_zadosti (
        id SERIAL PRIMARY KEY,
        vek_dite TEXT,
        delka_mm INTEGER,
        poznamka TEXT,
        email TEXT,
        telefon TEXT,
        stav TEXT NOT NULL DEFAULT 'nova',
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Poradna_zadosti tabulka OK');
  } catch (e) {
    console.log('Poradna_zadosti tabulka chyba:', e.message);
  }
}
initTabulka();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFON_RE = /^(\+420\s?)?\d{3}\s?\d{3}\s?\d{3}$/;

// POST /api/poradna-zadosti – maminka odešle krátký dotaz na velikost (veřejné)
router.post('/', async (req, res) => {
  const { vek_dite, delka_mm, poznamka, email, telefon, webova_stranka } = req.body;

  // Honeypot - skryté pole, které reální uživatelé nikdy nevyplní.
  if (webova_stranka) {
    return res.json({ id: 0 });
  }

  const emailOk = email && EMAIL_RE.test(String(email).trim());
  const telefonOk = telefon && TELEFON_RE.test(String(telefon).trim());
  if (!emailOk && !telefonOk) {
    return res.status(400).json({ chyba: 'Zadejte prosím platný e-mail nebo telefon, ať se vám můžeme ozvat.' });
  }
  if (!vek_dite && !delka_mm) {
    return res.status(400).json({ chyba: 'Napište prosím aspoň věk dítěte nebo naměřenou délku nožičky.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO poradna_zadosti (vek_dite, delka_mm, poznamka, email, telefon) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [vek_dite || null, delka_mm ? parseInt(delka_mm) : null, poznamka || null, email || null, telefon || null]
    );
    const zadost = result.rows[0];
    res.json(zadost);

    // E-maily se posílají až po odpovědi, ať prodleva/chyba s odesláním dotaz nezablokuje.
    if (emailOk) {
      odeslat_potvrzeni_poradna(zadost).catch(e => console.error('Potvrzeni dotazu na poradnu se nepodarilo odeslat:', e.message));
    }
    odeslat_upozorneni_poradna(zadost).catch(e => console.error('Upozorneni majitelce o dotazu na poradnu se nepodarilo odeslat:', e.message));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/poradna-zadosti – seznam dotazů (jen pro admin)
router.get('/', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM poradna_zadosti ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// PATCH /api/poradna-zadosti/:id/stav – označit jako vyřízené
router.patch('/:id/stav', vyzadovatAdmina, async (req, res) => {
  const { stav } = req.body;
  if (!['nova', 'vyrizena'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  try {
    const result = await pool.query('UPDATE poradna_zadosti SET stav=$1 WHERE id=$2 RETURNING *', [stav, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// DELETE /api/poradna-zadosti/:id
router.delete('/:id', vyzadovatAdmina, async (req, res) => {
  try {
    await pool.query('DELETE FROM poradna_zadosti WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
