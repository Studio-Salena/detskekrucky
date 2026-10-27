// Výrobci podle značek (GPSR) - viz lib/vyrobci.js. Veřejně jen vyplněné údaje
// pro detail boty v e-shopu, úpravy a přehled všech značek jen pro admina.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { klicZnacky, overitVyrobce } = require('../lib/vyrobci');

async function initVyrobci() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS znacky_vyrobci (
        klic TEXT PRIMARY KEY,
        znacka TEXT NOT NULL,
        vyrobce TEXT NOT NULL,
        adresa TEXT NOT NULL,
        kontakt TEXT NOT NULL,
        osoba_eu TEXT,
        upozorneni TEXT,
        upraveno TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('Vyrobci OK');
  } catch (e) {
    console.log('Vyrobci chyba:', e.message);
  }
}
pripravit(initVyrobci());

const SLOUPCE = 'klic, znacka, vyrobce, adresa, kontakt, osoba_eu, upozorneni';

// Veřejné - e-shop ukáže v detailu boty
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`SELECT ${SLOUPCE} FROM znacky_vyrobci ORDER BY klic`);
    res.set('Cache-Control', 'public, max-age=300');
    res.json(r.rows);
  } catch (e) {
    console.error('Výrobci - načtení selhalo:', e.message);
    res.status(500).json({ chyba: 'Údaje o výrobcích se nepodařilo načíst.' });
  }
});

// Admin: všechny značky z katalogu (i bez údajů) + kolik mají modelů
router.get('/admin', vyzadovatAdmina, async (req, res) => {
  try {
    const [znacky, ulozene] = await Promise.all([
      pool.query("SELECT znacka, COUNT(*)::int AS pocet FROM modely WHERE TRIM(COALESCE(znacka, '')) <> '' GROUP BY znacka"),
      pool.query(`SELECT ${SLOUPCE} FROM znacky_vyrobci`)
    ]);
    const mapa = new Map();
    // Značka psaná různě ("Froddo", "FRODDO ") = jedna; zobrazí se nejčastější zápis
    const zapisy = znacky.rows
      .map(z => ({ ...z, znacka: z.znacka.replace(/\s+/g, ' ').trim() }))
      .sort((a, b) => b.pocet - a.pocet || a.znacka.localeCompare(b.znacka, 'cs'));
    for (const z of zapisy) {
      const klic = klicZnacky(z.znacka);
      const zaznam = mapa.get(klic) || { klic, znacka: z.znacka, pocet_modelu: 0 };
      zaznam.pocet_modelu += z.pocet;
      mapa.set(klic, zaznam);
    }
    // uložené údaje i u značky, která v katalogu zrovna není (ať nezmizí)
    for (const v of ulozene.rows) mapa.set(v.klic, { pocet_modelu: 0, ...mapa.get(v.klic), ...v });
    res.json([...mapa.values()].sort((a, b) => a.znacka.localeCompare(b.znacka, 'cs')));
  } catch (e) {
    console.error('Výrobci - přehled selhal:', e.message);
    res.status(500).json({ chyba: 'Značky se nepodařilo načíst.' });
  }
});

// Admin: uložit údaje značky (vše prázdné = smazat)
router.put('/', vyzadovatAdmina, async (req, res) => {
  const { chyba, hodnoty, prazdne } = overitVyrobce(req.body);
  if (chyba) return res.status(400).json({ chyba });
  try {
    if (prazdne) {
      await pool.query('DELETE FROM znacky_vyrobci WHERE klic = $1', [hodnoty.klic]);
      return res.json({ ...hodnoty, smazano: true });
    }
    const r = await pool.query(`
      INSERT INTO znacky_vyrobci (klic, znacka, vyrobce, adresa, kontakt, osoba_eu, upozorneni)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (klic) DO UPDATE SET znacka = $2, vyrobce = $3, adresa = $4, kontakt = $5, osoba_eu = $6, upozorneni = $7, upraveno = NOW()
      RETURNING ${SLOUPCE}`,
      [hodnoty.klic, hodnoty.znacka, hodnoty.vyrobce, hodnoty.adresa, hodnoty.kontakt, hodnoty.osoba_eu, hodnoty.upozorneni]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Výrobci - uložení selhalo:', e.message);
    res.status(500).json({ chyba: 'Údaje o výrobci se nepodařilo uložit.' });
  }
});

module.exports = router;
