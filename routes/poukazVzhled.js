const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const cloudinaryLib = require('../lib/cloudinary');
const { MAX_MB, MAX_BYTES, overitSoubor } = require('../lib/overeniObrazku');

// Vzhled TIŠTĚNÉHO poukazu (klasický a vánoční): vlastní obrázek podkladu, do
// kterého admin dopíše částku, Pro, Věnováno od, Platnost do a EAN, a pozice
// těchto údajů v % obrázku. Drží se v nastaveni jako
// { klasicky: { url, key, pozice }, vanocni: { url, key, pozice } }.
// Bez obrázku platí výchozí: vánoční vanocni-poukaz.png, klasický s logem.
const KLIC = 'poukazVzhled';
const TYPY = ['klasicky', 'vanocni'];
// Povolené pozice (v % šířky/výšky obrázku) a velikost písma (v % výchozí)
const POZICE = {
  castkaTop: [0, 100], castkaLeft: [0, 100], castkaSirka: [5, 100],
  radkyLeft: [0, 100], proTop: [0, 100], odTop: [0, 100], platnostTop: [0, 100],
  eanTop: [0, 100], eanLeft: [0, 100], eanSirka: [5, 50],
  pismo: [50, 250]
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

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
    console.error('Smazání obrázku poukazu z Cloudinary se nepovedlo, storage_key pro ruční úklid:', publicId);
  }
}

function overitPozice(telo) {
  if (!telo || typeof telo !== 'object' || Array.isArray(telo)) return { chyba: 'Chybí pozice.' };
  const pozice = {};
  for (const [klic, hodnota] of Object.entries(telo)) {
    if (!POZICE[klic]) return { chyba: `Neznámá pozice ${klic}.` };
    const [min, max] = POZICE[klic];
    if (typeof hodnota !== 'number' || !Number.isFinite(hodnota) || hodnota < min || hodnota > max) {
      return { chyba: `Pozice ${klic} musí být číslo ${min}–${max}.` };
    }
    pozice[klic] = Math.round(hodnota * 10) / 10;
  }
  return { pozice };
}

// Tiskne se jen v adminu, proto celé admin-only
router.use(vyzadovatAdmina);

const typZAdresy = (req, res, next) => TYPY.includes(req.params.typ) ? next() : res.status(400).json({ chyba: 'Neznámý vzhled poukazu.' });

router.get('/', async (req, res) => {
  try {
    const ulozene = await nacistUlozene();
    res.json(Object.fromEntries(TYPY.map(t => {
      const { url = null, pozice = {} } = ulozene[t] || {};
      return [t, { obrazek_url: url, pozice }];
    })));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.put('/:typ/pozice', typZAdresy, async (req, res) => {
  const { chyba, pozice } = overitPozice(req.body && req.body.pozice);
  if (chyba) return res.status(400).json({ chyba });
  try {
    const ulozene = await nacistUlozene();
    await ulozit({ ...ulozene, [req.params.typ]: { ...(ulozene[req.params.typ] || {}), pozice } });
    res.json({ pozice });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.post('/:typ/obrazek', typZAdresy, (req, res, next) => {
  upload.single('obrazek')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ chyba: `Soubor je příliš velký (max ${MAX_MB} MB).` });
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
  const typ = req.params.typ;
  try {
    const puvodni = await nacistUlozene();
    let nahrany;
    try {
      nahrany = await cloudinaryLib.nahratObrazek(req.file.buffer, { folder: 'detskekrucky/poukaz-vzhled' });
    } catch (e) {
      console.error('Cloudinary upload obrázku poukazu selhal:', e.message);
      return res.status(502).json({ chyba: 'Nahrání do úložiště fotografií selhalo.' });
    }
    try {
      await ulozit({ ...puvodni, [typ]: { ...(puvodni[typ] || {}), url: nahrany.secure_url, key: nahrany.public_id } });
    } catch (e) {
      await smazatZUloziste(nahrany.public_id);
      throw e;
    }
    await smazatZUloziste((puvodni[typ] || {}).key);
    res.json({ obrazek_url: nahrany.secure_url });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Vrátit výchozí vzhled: smaže obrázek i vlastní pozice
router.delete('/:typ', typZAdresy, async (req, res) => {
  try {
    const puvodni = await nacistUlozene();
    const { key } = puvodni[req.params.typ] || {};
    const { [req.params.typ]: _, ...zbytek } = puvodni;
    await ulozit(zbytek);
    await smazatZUloziste(key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
