const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { nacistNastaveniDopravy, overitNastaveniDopravy, verejneNastaveni, METODY, PORADI } = require('../lib/doprava');
const { overitVydejniMisto } = require('../lib/glsVydejniMista');
const gls = require('../lib/gls');
const zasilkovna = require('../lib/zasilkovna');
const zasilkovnaApi = require('../lib/zasilkovnaApi');

// Nabízené způsoby dopravy a ceny pro e-shop (jen zapnuté a s cenou)
router.get('/', async (req, res) => {
  const nastaveni = await nacistNastaveniDopravy(pool);
  res.json(verejneNastaveni(nastaveni));
});

// Ověření výdejního místa GLS podle ID z mapy GLS. Vrací údaje z oficiálního
// seznamu GLS, e-shop je zobrazí místo údajů ze zprávy z mapy.
router.get('/gls-misto/:id', async (req, res) => {
  try {
    const misto = await overitVydejniMisto(req.params.id);
    if (!misto) return res.status(404).json({ chyba: 'Výdejní místo GLS se nepodařilo najít. Vyberte prosím jiné.' });
    const { id, nazev, ulice, mesto, psc, stat, box } = misto;
    res.json({ id, nazev, ulice, mesto, psc, stat, box });
  } catch (e) {
    console.error('Ověření výdejního místa GLS selhalo:', e.message);
    res.status(503).json({ chyba: 'Výdejní místo GLS se teď nepodařilo ověřit. Zkuste to prosím za chvíli.' });
  }
});

// Admin: celé nastavení + stav GLS API (jen ano/ne a názvy chybějících proměnných)
router.get('/admin', vyzadovatAdmina, async (req, res) => {
  const nastaveni = await nacistNastaveniDopravy(pool);
  res.json({
    nastaveni,
    metody: PORADI.map(kod => ({ kod, nazev: METODY[kod].nazev, vzdyZdarma: !!METODY[kod].vzdyZdarma })),
    glsApi: gls.stav(),
    zasilkovna: zasilkovna.stav(),
    zasilkovnaApi: zasilkovnaApi.stav()
  });
});

// Admin: zkouška spojení s MyGLS (čtecí dotaz, nic nezakládá) - tlačítko v Nastavení -> Doprava
router.post('/gls-test', vyzadovatAdmina, async (req, res) => {
  try {
    const v = await gls.overitSpojeni();
    res.json({ ok: true, prostredi: v.prostredi, zprava: `Spojení s GLS funguje (${v.prostredi === 'test' ? 'testovací' : 'ostré'} prostředí, zásilek za poslední den: ${v.pocetZasilek}).` });
  } catch (e) {
    console.error('Zkouška spojení s GLS selhala:', e.message);
    res.status(502).json({ ok: false, chyba: e.message });
  }
});

router.put('/', vyzadovatAdmina, async (req, res) => {
  const { chyba, hodnoty } = overitNastaveniDopravy(req.body);
  if (chyba) return res.status(400).json({ chyba });
  try {
    await pool.query(
      'INSERT INTO nastaveni (klic, hodnota) VALUES ($1, $2) ON CONFLICT (klic) DO UPDATE SET hodnota = $2',
      ['doprava', JSON.stringify(hodnoty)]
    );
    res.json({ zprava: 'Nastavení dopravy uloženo', nastaveni: hodnoty });
  } catch (e) {
    console.error('Uložení nastavení dopravy selhalo:', e.message);
    res.status(500).json({ chyba: 'Nastavení dopravy se nepodařilo uložit.' });
  }
});

module.exports = router;
