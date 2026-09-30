const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const cloudinaryLib = require('../lib/cloudinary');
const { MAX_MB, MAX_BYTES, overitSoubor } = require('../lib/overeniObrazku');

// Obrázek dlaždice "Dárkové poukazy" v rozcestníku e-shopu. Není to kategorie
// v tabulce kategorie, takže se drží v tabulce nastaveni jako { url, key }.
// Bez nahraného obrázku e-shop ukáže výchozí náhled poukazu (poukaz-dlazdice.png).
const KLIC = 'poukazDlazdice';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES }
});

async function nacistUlozene() {
  const result = await pool.query('SELECT hodnota FROM nastaveni WHERE klic = $1', [KLIC]);
  return (result.rows.length && result.rows[0].hodnota) || {};
}

async function ulozit(hodnota) {
  await pool.query(
    'INSERT INTO nastaveni (klic, hodnota) VALUES ($1, $2) ON CONFLICT (klic) DO UPDATE SET hodnota = $2',
    [KLIC, JSON.stringify(hodnota)]
  );
}

async function smazatZUloziste(publicId) {
  if (!publicId) return;
  const vysledek = await cloudinaryLib.smazatObrazek(publicId);
  if (!vysledek || vysledek.ok === false) {
    console.error('Smazání obrázku dlaždice poukazu z Cloudinary se nepovedlo, storage_key pro ruční úklid:', publicId);
  }
}

router.get('/', async (req, res) => {
  try {
    const { url } = await nacistUlozene();
    res.json({ obrazek_url: url ? cloudinaryLib.ziskatOptimalizovanouUrl(url, 400) : null });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.use(vyzadovatAdmina);

router.post('/obrazek', (req, res, next) => {
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
  if (!req.file) return res.status(400).json({ chyba: 'Chybí soubor k nahrání.' });
  const chybaSouboru = overitSoubor(req.file);
  if (chybaSouboru) return res.status(400).json({ chyba: chybaSouboru });
  if (!cloudinaryLib.jeNakonfigurovano()) {
    return res.status(503).json({ chyba: 'Nahrávání fotografií není momentálně nakonfigurováno.' });
  }

  try {
    const puvodni = await nacistUlozene();
    let nahrany;
    try {
      nahrany = await cloudinaryLib.nahratObrazek(req.file.buffer, { folder: 'detskekrucky/poukaz-dlazdice' });
    } catch (e) {
      console.error('Cloudinary upload obrázku dlaždice poukazu selhal:', e.message);
      return res.status(502).json({ chyba: 'Nahrání do úložiště fotografií selhalo.' });
    }
    try {
      await ulozit({ url: nahrany.secure_url, key: nahrany.public_id });
    } catch (e) {
      await smazatZUloziste(nahrany.public_id);
      throw e;
    }
    await smazatZUloziste(puvodni.key);
    res.json({ obrazek_url: nahrany.secure_url });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.delete('/obrazek', async (req, res) => {
  try {
    const puvodni = await nacistUlozene();
    await ulozit({});
    await smazatZUloziste(puvodni.key);
    res.json({ obrazek_url: null });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
