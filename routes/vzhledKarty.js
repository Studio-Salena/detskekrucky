const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const cloudinaryLib = require('../lib/cloudinary');
const { MAX_MB, MAX_BYTES, overitSoubor } = require('../lib/overeniObrazku');

// Vzhled plastové dárkové karty (admin Dárkové poukazy → Plastové karty → Vzhled
// karty). Majitelka si karty tiskne sama (a laminuje), proto si nahraje grafiku
// přední a zadní strany; na zadní stranu admin při tisku doplní číslo a čárový
// kód konkrétní karty. Drží se v tabulce nastaveni:
//   { predni: { url, key }, zadni: { url, key }, poziceKodu: 'vpravo-dole' | … }
// Bez nahrané přední strany admin použije výchozí karta-jezek.jpg, bez zadní
// strany vykreslí jednoduchou zadní stranu s textem.
const KLIC = 'vzhledKarty';
const STRANY = ['predni', 'zadni'];
const POZICE_KODU = ['vpravo-dole', 'vlevo-dole', 'uprostred-dole', 'vpravo-nahore', 'vlevo-nahore'];
// pro tisk: 1800 px na 85,6 mm ≈ 530 dpi; náhled v adminu stačí menší
const SIRKA_TISK = 1800;
const SIRKA_NAHLED = 500;

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
    console.error('Smazání obrázku vzhledu karty z Cloudinary se nepovedlo, storage_key pro ruční úklid:', publicId);
  }
}

function proKlienta(ulozene) {
  const strana = s => (ulozene[s] && ulozene[s].url ? {
    nahled_url: cloudinaryLib.ziskatOptimalizovanouUrl(ulozene[s].url, SIRKA_NAHLED),
    tisk_url: cloudinaryLib.ziskatOptimalizovanouUrl(ulozene[s].url, SIRKA_TISK)
  } : null);
  return {
    predni: strana('predni'),
    zadni: strana('zadni'),
    poziceKodu: POZICE_KODU.includes(ulozene.poziceKodu) ? ulozene.poziceKodu : 'vpravo-dole'
  };
}

router.use(vyzadovatAdmina);

router.get('/', async (req, res) => {
  try {
    res.json(proKlienta(await nacistUlozene()));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Kam na zadní straně přijde bílé pole s čárovým kódem a číslem karty
router.put('/pozice', async (req, res) => {
  const pozice = req.body && req.body.poziceKodu;
  if (!POZICE_KODU.includes(pozice)) return res.status(400).json({ chyba: 'Neznámá pozice kódu.' });
  try {
    const ulozene = await nacistUlozene();
    await ulozit({ ...ulozene, poziceKodu: pozice });
    res.json(proKlienta({ ...ulozene, poziceKodu: pozice }));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

function overitStranu(req, res, next) {
  if (!STRANY.includes(req.params.strana)) return res.status(400).json({ chyba: 'Strana musí být predni nebo zadni.' });
  next();
}

router.post('/:strana', overitStranu, (req, res, next) => {
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
  if (!cloudinaryLib.jeNakonfigurovano()) return res.status(503).json({ chyba: 'Nahrávání obrázků není momentálně nakonfigurováno.' });
  const strana = req.params.strana;
  try {
    const puvodni = await nacistUlozene();
    let nahrany;
    try {
      nahrany = await cloudinaryLib.nahratObrazek(req.file.buffer, { folder: 'detskekrucky/vzhled-karty' });
    } catch (e) {
      console.error('Cloudinary upload vzhledu karty selhal:', e.message);
      return res.status(502).json({ chyba: 'Nahrání do úložiště obrázků selhalo.' });
    }
    const nove = { ...puvodni, [strana]: { url: nahrany.secure_url, key: nahrany.public_id } };
    try {
      await ulozit(nove);
    } catch (e) {
      await smazatZUloziste(nahrany.public_id);
      throw e;
    }
    await smazatZUloziste((puvodni[strana] || {}).key);
    res.json(proKlienta(nove));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Vrátit stranu na výchozí vzhled (smaže nahraný obrázek)
router.delete('/:strana', overitStranu, async (req, res) => {
  const strana = req.params.strana;
  try {
    const puvodni = await nacistUlozene();
    const { [strana]: smazana, ...zbytek } = puvodni;
    await ulozit(zbytek);
    await smazatZUloziste((smazana || {}).key);
    res.json(proKlienta(zbytek));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
module.exports.POZICE_KODU = POZICE_KODU;
