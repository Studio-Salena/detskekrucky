const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Vytvoření tabulky při startu serveru (stejný vzor jako rezervace)
async function initNewsletterTabulka() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS newsletter (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Newsletter tabulka OK');
  } catch (e) {
    console.log('Newsletter tabulka chyba:', e.message);
  }
}
initNewsletterTabulka();

// POST /api/newsletter – zákazník se přihlásí k odběru
router.post('/', async (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ chyba: 'Zadejte prosím platný e-mail.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO newsletter (email) VALUES ($1) RETURNING *',
      [email.toLowerCase().trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // unique constraint - email už existuje
      return res.status(400).json({ chyba: 'Tento e-mail je již přihlášený k odběru.' });
    }
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/newsletter – seznam přihlášených e-mailů (pro admin)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM newsletter ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// DELETE /api/newsletter/:id – smazat přihlášeného (admin)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM newsletter WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
