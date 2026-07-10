const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const vyzadovatAdmina = require('../middleware/adminAuth');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('CHYBA: JWT_SECRET není nastaven v proměnných prostředí! Přihlašování zákazníků nebude fungovat bezpečně.');
}

// Registrace
router.post('/registrace', async (req, res) => {
  const { jmeno, email, heslo, telefon, ulice, mesto, psc } = req.body;
  try {
    const existuje = await pool.query('SELECT id FROM zakaznici WHERE email = $1', [email]);
    if (existuje.rows.length > 0) {
      return res.status(400).json({ chyba: 'Email je jiz registrovan' });
    }
    const hash = await bcrypt.hash(heslo, 10);
    const result = await pool.query(
      'INSERT INTO zakaznici (jmeno, email, heslo, telefon, ulice, mesto, psc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [jmeno, email, hash, telefon, ulice, mesto, psc]
    );
    const token = jwt.sign({ id: result.rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ zprava: 'Registrace uspesna', token });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Prihlaseni
router.post('/prihlaseni', async (req, res) => {
  const { email, heslo } = req.body;
  try {
    const result = await pool.query('SELECT * FROM zakaznici WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ chyba: 'Neplatny email nebo heslo' });
    }
    const zakaznik = result.rows[0];
    const shoda = await bcrypt.compare(heslo, zakaznik.heslo);
    if (!shoda) {
      return res.status(400).json({ chyba: 'Neplatny email nebo heslo' });
    }
    const token = jwt.sign({ id: zakaznik.id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, jmeno: zakaznik.jmeno, email: zakaznik.email });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Profil zakaznika
router.get('/profil', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ chyba: 'Neprihlaseno' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT id, jmeno, email, telefon, ulice, mesto, psc FROM zakaznici WHERE id = $1',
      [decoded.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(401).json({ chyba: 'Neplatny token' });
  }
});

// Historie objednavek zakaznika
router.get('/moje-objednavky', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ chyba: 'Neprihlaseno' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(`
      SELECT o.id, o.stav, o.celkem, o.vytvoreno, o.doprava
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      WHERE z.id = $1
      ORDER BY o.vytvoreno DESC
    `, [decoded.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Všichni zákazníci (jen pro admin – obsahuje osobní údaje)
router.get('/zakaznici', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, jmeno, email, telefon, ulice, mesto, psc, vytvoreno FROM zakaznici ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Přidat zákazníka ručně (jen pro admin / prodejna)
router.post('/zakaznici', vyzadovatAdmina, async (req, res) => {
  const { jmeno, email, telefon, ulice, mesto, psc, newsletter } = req.body;
  if (!jmeno || !email) return res.status(400).json({ chyba: 'Vyplňte prosím jméno a e-mail.' });
  try {
    const existuje = await pool.query('SELECT id FROM zakaznici WHERE email = $1', [email]);
    if (existuje.rows.length > 0) {
      return res.status(400).json({ chyba: 'Zákazník s tímto e-mailem už existuje.' });
    }

    // Vygenerovat náhodné heslo (zákazník přidaný na prodejně se zatím nepřihlašuje online)
    const nahodneHeslo = Math.random().toString(36).slice(-12);
    const hash = await bcrypt.hash(nahodneHeslo, 10);

    const result = await pool.query(
      'INSERT INTO zakaznici (jmeno, email, heslo, telefon, ulice, mesto, psc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, jmeno, email, telefon, ulice, mesto, psc, vytvoreno',
      [jmeno, email, hash, telefon || null, ulice || null, mesto || null, psc || null]
    );

    if (newsletter) {
      try {
        await pool.query('INSERT INTO newsletter (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
      } catch (e) { /* newsletter tabulka může chybět, ignorovat */ }
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;

