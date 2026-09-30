const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const cloudinaryLib = require('../lib/cloudinary');
const { MAX_MB, MAX_BYTES, overitSoubor } = require('../lib/overeniObrazku');

// Idempotentní migrace - dlaždice kategorie v rozcestníku e-shopu má buď
// emoji ikonu, nebo nahraný obrázek (obrázek má přednost).
async function initKategorieSloupce() {
  try {
    await pool.query(`ALTER TABLE kategorie ADD COLUMN IF NOT EXISTS ikona TEXT`);
    await pool.query(`ALTER TABLE kategorie ADD COLUMN IF NOT EXISTS obrazek_url TEXT`);
    await pool.query(`ALTER TABLE kategorie ADD COLUMN IF NOT EXISTS obrazek_key TEXT`);
    console.log('Kategorie sloupce OK');
  } catch (e) {
    console.log('Kategorie sloupce chyba:', e.message);
  }
}
initKategorieSloupce();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES }
});

async function smazatObrazekZUloziste(publicId) {
  if (!publicId) return;
  const vysledek = await cloudinaryLib.smazatObrazek(publicId);
  if (!vysledek || vysledek.ok === false) {
    console.error('Smazání obrázku kategorie z Cloudinary se nepovedlo, storage_key pro ruční úklid:', publicId);
  }
}

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM kategorie ORDER BY poradi');
    // Dlaždice je malá - posílat zmenšenou verzi, ne originál z telefonu.
    // storage_key je interní údaj úložiště, veřejně ho neposílat.
    res.json(result.rows.map(({ obrazek_key, ...k }) => ({
      ...k,
      obrazek_url: k.obrazek_url ? cloudinaryLib.ziskatOptimalizovanouUrl(k.obrazek_url, 240) : null
    })));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Vše pod touto řádkou (přidání/úprava/smazání kategorie) vyžaduje administraci
router.use(vyzadovatAdmina);

router.post('/', async (req, res) => {
  const { nazev, slug, poradi, popis, znacky, ikona } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO kategorie (nazev, slug, poradi, popis, znacky, ikona) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [nazev, slug, poradi||0, popis||'', znacky||'', ikona || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  const { nazev, slug, poradi, popis, znacky, ikona } = req.body;
  try {
    const result = await pool.query(
      'UPDATE kategorie SET nazev=$1, slug=$2, poradi=$3, popis=$4, znacky=$5, ikona=$6 WHERE id=$7 RETURNING *',
      [nazev, slug, poradi||0, popis||'', znacky||'', ikona || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /:id/obrazek - nahrát (nebo nahradit) obrázek dlaždice, pole "obrazek"
router.post('/:id/obrazek', (req, res, next) => {
  upload.single('obrazek')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ chyba: `Soubor je příliš velký (max ${MAX_MB} MB).` });
      }
      return res.status(400).json({ chyba: 'Nahrání souboru selhalo.' });
    }
    next();
  });
}, async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.status(400).json({ chyba: 'Chybí soubor k nahrání.' });
  const chybaSouboru = overitSoubor(req.file);
  if (chybaSouboru) return res.status(400).json({ chyba: chybaSouboru });
  if (!cloudinaryLib.jeNakonfigurovano()) {
    return res.status(503).json({ chyba: 'Nahrávání fotografií není momentálně nakonfigurováno.' });
  }

  try {
    const puvodni = await pool.query('SELECT obrazek_key FROM kategorie WHERE id=$1', [id]);
    if (!puvodni.rows.length) return res.status(404).json({ chyba: 'Kategorie nenalezena.' });

    let nahrany;
    try {
      nahrany = await cloudinaryLib.nahratObrazek(req.file.buffer, { folder: `detskekrucky/kategorie/${id}` });
    } catch (e) {
      console.error('Cloudinary upload obrázku kategorie selhal:', e.message);
      return res.status(502).json({ chyba: 'Nahrání do úložiště fotografií selhalo.' });
    }

    let result;
    try {
      result = await pool.query(
        'UPDATE kategorie SET obrazek_url=$1, obrazek_key=$2 WHERE id=$3 RETURNING *',
        [nahrany.secure_url, nahrany.public_id, id]
      );
    } catch (e) {
      await smazatObrazekZUloziste(nahrany.public_id);
      throw e;
    }
    if (!result.rows.length) {
      // Kategorii mezitím někdo smazal - nahraný soubor by zůstal osiřelý.
      await smazatObrazekZUloziste(nahrany.public_id);
      return res.status(404).json({ chyba: 'Kategorie nenalezena.' });
    }
    await smazatObrazekZUloziste(puvodni.rows[0].obrazek_key);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// DELETE /:id/obrazek - odebrat obrázek, dlaždice se vrátí k emoji ikoně
router.delete('/:id/obrazek', async (req, res) => {
  try {
    const puvodni = await pool.query('SELECT obrazek_key FROM kategorie WHERE id=$1', [req.params.id]);
    if (!puvodni.rows.length) return res.status(404).json({ chyba: 'Kategorie nenalezena.' });
    const result = await pool.query(
      'UPDATE kategorie SET obrazek_url=NULL, obrazek_key=NULL WHERE id=$1 RETURNING *',
      [req.params.id]
    );
    await smazatObrazekZUloziste(puvodni.rows[0].obrazek_key);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM kategorie WHERE id=$1 RETURNING obrazek_key', [req.params.id]);
    if (result.rows.length) await smazatObrazekZUloziste(result.rows[0].obrazek_key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
