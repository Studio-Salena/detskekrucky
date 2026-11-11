// Slevové kódy – veřejný náhled slevy v košíku e-shopu (nic se nezapisuje).
// Závazné uplatnění je v transakci objednávky (routes/objednavky.js) a prodeje
// v pokladně (routes/prodejna.js), pravidla v lib/promo.js.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const promo = require('../lib/promo');

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

module.exports = router;
module.exports.zakladZKosiku = zakladZKosiku;
