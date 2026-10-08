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
// Vánoční poukaz (2026-10): druhá karta v dlaždici, { vanocni: { url, key, zobrazit } };
// bez nahraného obrázku výchozí vanocni-poukaz-dlazdice.jpg, zobrazit výchozí ano.
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

const jeVanocni = req => req.query && req.query.typ === 'vanocni';

router.get('/', async (req, res) => {
  try {
    const { url, vanocni = {} } = await nacistUlozene();
    res.json({
      obrazek_url: url ? cloudinaryLib.ziskatOptimalizovanouUrl(url, 400) : null,
      vanocni: {
        zobrazit: vanocni.zobrazit !== false,
        obrazek_url: vanocni.url ? cloudinaryLib.ziskatOptimalizovanouUrl(vanocni.url, 400) : null
      }
    });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.use(vyzadovatAdmina);

// Zapnout / vypnout vánoční poukaz v dlaždici (např. po Vánocích)
router.put('/vanocni', async (req, res) => {
  if (!req.body || typeof req.body.zobrazit !== 'boolean') return res.status(400).json({ chyba: 'Chybí zobrazit (ano/ne).' });
  try {
    const ulozene = await nacistUlozene();
    await ulozit({ ...ulozene, vanocni: { ...(ulozene.vanocni || {}), zobrazit: req.body.zobrazit } });
    res.json({ zobrazit: req.body.zobrazit });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

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
    const vanocni = jeVanocni(req);
    try {
      await ulozit(vanocni
        ? { ...puvodni, vanocni: { ...(puvodni.vanocni || {}), url: nahrany.secure_url, key: nahrany.public_id } }
        : { ...puvodni, url: nahrany.secure_url, key: nahrany.public_id });
    } catch (e) {
      await smazatZUloziste(nahrany.public_id);
      throw e;
    }
    await smazatZUloziste(vanocni ? (puvodni.vanocni || {}).key : puvodni.key);
    res.json({ obrazek_url: nahrany.secure_url });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.delete('/obrazek', async (req, res) => {
  try {
    const puvodni = await nacistUlozene();
    if (jeVanocni(req)) {
      const { url, key, ...zbytek } = puvodni.vanocni || {};
      await ulozit({ ...puvodni, vanocni: zbytek });
      await smazatZUloziste(key);
    } else {
      const { url, key, ...zbytek } = puvodni;
      await ulozit(zbytek);
      await smazatZUloziste(key);
    }
    res.json({ obrazek_url: null });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
