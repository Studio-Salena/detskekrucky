// Slevové kódy – veřejný náhled slevy v košíku e-shopu (nic se nezapisuje),
// veřejné podmínky akce pro stránku stromečku a správa akce v adminu.
// Závazné uplatnění je v transakci objednávky (routes/objednavky.js) a prodeje
// v pokladně (routes/prodejna.js), pravidla v lib/promo.js.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const promo = require('../lib/promo');
const vyzadovatAdmina = require('../middleware/adminAuth');

async function initPromo() {
  try {
    await promo.migrovat(pool);
    console.log('Slevove kody OK');
  } catch (e) {
    console.log('Slevove kody chyba:', e.message);
  }
}
pripravit(initPromo());

// Základ slevy z košíku: ceny z databáze (klientovi se nevěří), bez zboží ve slevě
async function zakladZKosiku(db, polozky) {
  const pocty = new Map();
  for (const p of polozky) {
    if (!p || !Number.isInteger(p.produkt_id) || !Number.isInteger(p.pocet) || p.pocet <= 0 || p.pocet > 1000) return null;
    pocty.set(p.produkt_id, (pocty.get(p.produkt_id) || 0) + p.pocet);
  }
  const r = await db.query('SELECT id, cena, cena_pred_slevou FROM produkty WHERE id = ANY($1::int[])', [[...pocty.keys()]]);
  let zaklad = 0;
  for (const radek of r.rows) {
    if (radek.cena_pred_slevou == null) zaklad += Number(radek.cena) * pocty.get(radek.id);
  }
  return zaklad;
}

// POST /api/promo/overit { kod, polozky: [{ produkt_id, velikost, pocet }] }
router.post('/overit', async (req, res) => {
  const { kod, polozky } = req.body || {};
  if (!Array.isArray(polozky) || !polozky.length || polozky.length > 100) {
    return res.status(400).json({ chyba: 'Košík je prázdný.' });
  }
  try {
    const zaklad = await zakladZKosiku(pool, polozky);
    if (zaklad == null) return res.status(400).json({ chyba: 'Neplatná položka v košíku.' });
    const v = await promo.overit(pool, kod, { zaklad, kanal: 'eshop' });
    if (!v.ok) return res.status(400).json({ chyba: v.chyba });
    res.json({ kod: v.kod, procenta: v.procenta, sleva: v.sleva, popis: v.popis, zaklad });
  } catch (e) {
    console.error('Ověření slevového kódu selhalo:', e.message);
    res.status(500).json({ chyba: 'Slevový kód se teď nepodařilo ověřit. Zkuste to prosím znovu.' });
  }
});

// GET /api/promo/info/:kod – veřejné podmínky akce (stránka u stromečku si
// z nich bere „platí do“ a počet slev, takže po prodloužení v adminu sedí)
router.get('/info/:kod', async (req, res) => {
  try {
    const info = await promo.verejneInfo(pool, req.params.kod);
    if (!info) return res.status(404).json({ chyba: 'Akce nebyla nalezena.' });
    res.set('Cache-Control', 'public, max-age=300');
    res.json(info);
  } catch (e) {
    res.status(500).json({ chyba: 'Podmínky akce se nepodařilo načíst.' });
  }
});

// ═══════════════════════════════
// ADMIN – E-shop → Slevové akce
// ═══════════════════════════════

// GET /api/promo/akce – akce s počtem použití (e-shop + prodejna)
router.get('/akce', vyzadovatAdmina, async (req, res) => {
  try {
    res.json({ akce: await promo.prehledAkci(pool), vypnutoNaServeru: promo.akceVypnuta() });
  } catch (e) {
    res.status(500).json({ chyba: e.message });
  }
});

// GET /api/promo/akce/:kod/pouziti – nákupy s kódem a historie změn akce
router.get('/akce/:kod/pouziti', vyzadovatAdmina, async (req, res) => {
  try {
    const kod = promo.normalizovatKod(req.params.kod);
    const [pouziti, zmeny] = await Promise.all([promo.pouzitiAkce(pool, kod), promo.zmenyAkce(pool, kod)]);
    res.json({ pouziti, zmeny });
  } catch (e) {
    res.status(500).json({ chyba: e.message });
  }
});

// PATCH /api/promo/akce/:kod { max_pouziti?, do_den? (YYYY-MM-DD, včetně), aktivni? }
router.patch('/akce/:kod', vyzadovatAdmina, async (req, res) => {
  const b = req.body || {};
  const zmeny = {};
  for (const k of ['max_pouziti', 'do_den', 'aktivni']) if (b[k] !== undefined) zmeny[k] = b[k];
  try {
    const v = await promo.upravitAkci(pool, req.params.kod, zmeny);
    if (v.chyba) return res.status(v.status).json({ chyba: v.chyba });
    res.json(v);
  } catch (e) {
    res.status(500).json({ chyba: e.message });
  }
});

module.exports = router;
module.exports.zakladZKosiku = zakladZKosiku;
