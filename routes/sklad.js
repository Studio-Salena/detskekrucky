const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nazev, p.znacka, p.emoji, p.kategorie, p.cena, p.ean,
             s.velikost, s.pocet_kusu, s.min_pocet,
             CASE WHEN s.pocet_kusu <= s.min_pocet THEN true ELSE false END as nizky_stav
      FROM produkty p
      JOIN sklad s ON p.id = s.produkt_id
      ORDER BY p.nazev, s.velikost
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.post('/naskladnit', async (req, res) => {
  const { produkt_id, velikost, pocet, poznamka } = req.body;
  try {
    await pool.query(`
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu)
      VALUES ($1, $2, $3)
      ON CONFLICT (produkt_id, velikost)
      DO UPDATE SET pocet_kusu = sklad.pocet_kusu + $3
    `, [produkt_id, velikost, pocet]);
    await pool.query(`
      INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka)
      VALUES ($1, $2, 'naskladneni', $3, $4)
    `, [produkt_id, velikost, pocet, poznamka]);
    res.json({ zprava: 'Naskladneno uspesne' });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.post('/odecist', async (req, res) => {
  const { produkt_id, velikost, pocet, poznamka } = req.body;
  try {
    const check = await pool.query(`
      SELECT pocet_kusu FROM sklad
      WHERE produkt_id = $1 AND velikost = $2
    `, [produkt_id, velikost]);
    if (check.rows.length === 0 || check.rows[0].pocet_kusu < pocet) {
      return res.status(400).json({ chyba: 'Nedostatek zbozi na sklade' });
    }
    await pool.query(`
      UPDATE sklad SET pocet_kusu = pocet_kusu - $3
      WHERE produkt_id = $1 AND velikost = $2
    `, [produkt_id, velikost, pocet]);
    await pool.query(`
      INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka)
      VALUES ($1, $2, 'prodej', $3, $4)
    `, [produkt_id, velikost, pocet, poznamka]);
    res.json({ zprava: 'Odecteno uspesne' });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.get('/historie', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ph.*, p.nazev, p.znacka
      FROM pohyby_skladu ph
      JOIN produkty p ON ph.produkt_id = p.id
      ORDER BY ph.vytvoreno DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.get('/nizky-stav', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.nazev, p.znacka, s.velikost, s.pocet_kusu, s.min_pocet
      FROM sklad s
      JOIN produkty p ON s.produkt_id = p.id
      WHERE s.pocet_kusu <= s.min_pocet
      ORDER BY s.pocet_kusu ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});


// Přidat nový produkt
router.post('/produkty', async (req, res) => {
  const { nazev, znacka, emoji, popis, kategorie, cena, cena_puvodni, ean } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO produkty (nazev, znacka, emoji, popis, kategorie, cena, cena_puvodni, ean) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [nazev, znacka, emoji||'', popis||'', kategorie, cena, cena_puvodni||null, ean||null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Upravit produkt
router.patch('/produkty/:id', async (req, res) => {
  const { nazev, znacka, cena, cena_puvodni, popis, ean } = req.body;
  try {
    const result = await pool.query(
      'UPDATE produkty SET nazev=$1, znacka=$2, cena=$3, cena_puvodni=$4, popis=$5, ean=$6 WHERE id=$7 RETURNING *',
      [nazev, znacka, cena, cena_puvodni||null, popis||'', ean||null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Získat všechny kategorie
router.get('/kategorie', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM kategorie ORDER BY poradi');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Přidat kategorii
router.post('/kategorie', async (req, res) => {
  const { nazev, slug, poradi } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO kategorie (nazev, slug, poradi) VALUES ($1,$2,$3) RETURNING *',
      [nazev, slug, poradi||0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Smazat kategorii
router.delete('/kategorie/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM kategorie WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});
// Smazat jednu položku skladu (konkrétní velikost produktu)
router.delete('/polozka/:produktId/:velikost', async (req, res) => {
  try {
    await pool.query('DELETE FROM sklad WHERE produkt_id=$1 AND velikost=$2', [req.params.produktId, req.params.velikost]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Smazat celý produkt (včetně jeho položek skladu a historie pohybů)
router.delete('/produkty/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM pohyby_skladu WHERE produkt_id=$1', [req.params.id]);
    await client.query('DELETE FROM sklad WHERE produkt_id=$1', [req.params.id]);
    await client.query('DELETE FROM produkty WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;


