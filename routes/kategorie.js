const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM kategorie ORDER BY poradi');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Vše pod touto řádkou (přidání/úprava/smazání kategorie) vyžaduje administraci
router.use(vyzadovatAdmina);

router.post('/', async (req, res) => {
  const { nazev, slug, poradi, popis, znacky } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO kategorie (nazev, slug, poradi, popis, znacky) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nazev, slug, poradi||0, popis||'', znacky||'']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  const { nazev, slug, poradi, popis, znacky } = req.body;
  try {
    const result = await pool.query(
      'UPDATE kategorie SET nazev=$1, slug=$2, poradi=$3, popis=$4, znacky=$5 WHERE id=$6 RETURNING *',
      [nazev, slug, poradi||0, popis||'', znacky||'', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM kategorie WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
