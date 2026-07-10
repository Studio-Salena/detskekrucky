const express = require('express');
const router = express.Router();

// Jednoduché dočasné úložiště v paměti (relace -> naskenovaný kód)
// Relace = náhodné ID, které spojuje telefon a PC dohromady
const skeny = new Map();

function vycistitStareRelace() {
  const ted = Date.now();
  for (const [id, data] of skeny.entries()) {
    if (ted - data.cas > 30 * 60 * 1000) skeny.delete(id); // starší než 30 minut
  }
}

// Telefon: odešle naskenovaný EAN kód pro danou relaci
router.post('/:sessionId', (req, res) => {
  const { ean } = req.body;
  if (!ean) return res.status(400).json({ chyba: 'Chybí EAN kód.' });
  vycistitStareRelace();
  skeny.set(req.params.sessionId, { ean, cas: Date.now(), precteno: false });
  res.json({ ok: true });
});

// PC: zeptá se, jestli přišel nový kód (a označí ho jako přečtený, aby se nenačetl 2x)
router.get('/:sessionId', (req, res) => {
  vycistitStareRelace();
  const data = skeny.get(req.params.sessionId);
  if (!data || data.precteno) return res.json({ ean: null });
  data.precteno = true;
  res.json({ ean: data.ean });
});

module.exports = router;
