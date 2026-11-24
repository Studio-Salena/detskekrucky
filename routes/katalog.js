// Veřejný export katalogu (SEO krok 2): GitHub Actions z něj sestaví samostatné
// stránky /kategorie/<slug>/ a /produkt/<slug>/. Jen čtení, žádný tajný údaj.
//
//   GET /api/katalog/export        celý katalog (kategorie, modely na e-shopu, přesměrování)
//   GET /api/katalog/model/:slug   jeden model - statická stránka si po načtení dočte
//                                  aktuální cenu a dostupnost (404 = model už není v nabídce)
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { ziskatOptimalizovanouUrl } = require('../lib/cloudinary');
const { sestavitExport, SLUG } = require('../lib/katalogExport');

async function nacist(db, slug = null) {
  const filtr = slug ? 'AND m.slug = $1' : '';
  const par = slug ? [slug] : [];
  const kategorie = slug ? { rows: [] } : await db.query('SELECT slug, nazev, popis, poradi, obrazek_url FROM kategorie ORDER BY poradi, id');
  const modely = await db.query(`
    SELECT m.id, m.slug, m.znacka, m.nazev, m.kategorie, m.barefoot, m.sirka, m.nart, m.dominantni_palec,
           m.zapinani, m.membrana, m.material, m.opatek, m.pohlavi, m.proc_jsme_vybrali
    FROM modely m
    WHERE EXISTS (SELECT 1 FROM produkty p WHERE p.model_id = m.id AND p.na_eshopu) ${filtr}
    ORDER BY m.slug`, par);
  const produkty = await db.query(`
    SELECT p.id AS produkt_id, p.model_id, p.kategorie, p.cena, p.cena_puvodni, p.popis, p.emoji,
           s.velikost, s.pocet_kusu, s.dostupnost, s.delka_mm
    FROM produkty p
    JOIN modely m ON m.id = p.model_id
    LEFT JOIN sklad s ON s.produkt_id = p.id
    WHERE p.na_eshopu ${filtr}
    ORDER BY p.model_id, s.velikost, p.id`, par);
  const fotky = await db.query(`
    SELECT pi.id, pi.produkt_id, pi.url, pi.alt, pi.is_primary, pi.position
    FROM product_images pi
    JOIN produkty p ON p.id = pi.produkt_id
    JOIN modely m ON m.id = p.model_id
    WHERE p.na_eshopu ${filtr}`, par);
  const presmerovani = slug ? { rows: [] } : await db.query(`
    SELECT r.stary_slug, m.slug AS novy_slug FROM modely_presmerovani r JOIN modely m ON m.id = r.model_id`);
  return sestavitExport({
    kategorie: kategorie.rows, modely: modely.rows, produkty: produkty.rows, fotky: fotky.rows,
    presmerovani: presmerovani.rows, optimalizovat: ziskatOptimalizovanouUrl
  });
}

// Jeden konzistentní snímek: sklad, kategorie a modely ze stejného okamžiku
async function vTransakci(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const vysledek = await fn(client);
    await client.query('COMMIT');
    return vysledek;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

router.get('/export', async (req, res) => {
  try {
    const data = await vTransakci(db => nacist(db));
    res.set('Cache-Control', 'no-store');
    res.json({ ...data, vygenerovano: new Date().toISOString() });
  } catch (err) {
    console.error('Export katalogu selhal:', err.message);
    res.status(500).json({ chyba: 'Export katalogu se nepodařilo připravit.' });
  }
});

router.get('/model/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!SLUG.test(slug)) return res.status(404).json({ chyba: 'Model nenalezen.' });
  try {
    const data = await vTransakci(db => nacist(db, slug));
    const model = data.modely.find(m => m.slug === slug);
    if (!model) return res.status(404).json({ chyba: 'Model už není v nabídce.' });
    res.set('Cache-Control', 'no-store');
    res.json({ model });
  } catch (err) {
    console.error('Model katalogu selhal:', err.message);
    res.status(500).json({ chyba: 'Model se nepodařilo načíst.' });
  }
});

module.exports = router;
module.exports.nacist = nacist;
