// Návštěvnost webu bez cookies - viz lib/navstevnost.js. Záznam posílá
// navstevnost.js na stránkách webu, přehled je jen pro admina (Reporty).
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const {
  NAZVY_STRANEK, normalizovatStranku, normalizovatProdukt, jeRobot, zarizeni,
  zdrojNavstevy, otiskNavstevnika, overitObdobi
} = require('../lib/navstevnost');

async function initNavstevnost() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS navstevy (
        id BIGSERIAL PRIMARY KEY,
        cas TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        den DATE NOT NULL,
        stranka TEXT NOT NULL,
        produkt TEXT,
        zdroj TEXT,
        zarizeni TEXT NOT NULL,
        navstevnik TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS navstevy_den_idx ON navstevy (den);
      CREATE TABLE IF NOT EXISTS navstevnost_sul (
        den DATE PRIMARY KEY,
        sul TEXT NOT NULL
      );
    `);
    console.log('Navstevnost OK');
  } catch (e) {
    console.log('Navstevnost chyba:', e.message);
  }
}
pripravit(initNavstevnost());

// Dnešní datum v českém čase (YYYY-MM-DD)
function dnesPraha() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
}

// Sůl platí jeden den, starší se smaže - otisky z minulých dnů pak nejde spojit
let sulDne = { den: null, sul: null };
async function dnesniSul(den) {
  if (sulDne.den === den) return sulDne.sul;
  await pool.query('INSERT INTO navstevnost_sul (den, sul) VALUES ($1, $2) ON CONFLICT (den) DO NOTHING', [den, crypto.randomBytes(32).toString('hex')]);
  const r = await pool.query('SELECT sul FROM navstevnost_sul WHERE den = $1', [den]);
  await pool.query('DELETE FROM navstevnost_sul WHERE den < $1', [den]);
  sulDne = { den, sul: r.rows[0].sul };
  return sulDne.sul;
}

// Ochrana proti zahlcení: nejvýš 120 záznamů z jedné IP za 10 minut, další se tiše zahodí
const LIMIT = 120;
const OKNO_MS = 10 * 60 * 1000;
const pocty = new Map(); // ip -> { pocet, od }
function prekrocenLimit(ip) {
  const ted = Date.now();
  if (pocty.size > 5000) for (const [k, v] of pocty) if (ted - v.od > OKNO_MS) pocty.delete(k);
  let z = pocty.get(ip);
  if (!z || ted - z.od > OKNO_MS) z = { pocet: 0, od: ted };
  z.pocet++;
  pocty.set(ip, z);
  return z.pocet > LIMIT;
}

// Veřejné: záznam zobrazení stránky. Tělo jde jako text/plain (bez CORS preflightu),
// odpověď je vždy 204 - stránce na výsledku nezáleží.
router.post('/', express.text({ type: '*/*', limit: '2kb' }), async (req, res) => {
  res.status(204).end();
  try {
    const ua = req.headers['user-agent'];
    if (jeRobot(ua) || prekrocenLimit(req.ip)) return;
    let d;
    try {
      d = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return;
    }
    if (!d || typeof d !== 'object') return;
    const den = dnesPraha();
    const sul = await dnesniSul(den);
    await pool.query(
      'INSERT INTO navstevy (den, stranka, produkt, zdroj, zarizeni, navstevnik) VALUES ($1, $2, $3, $4, $5, $6)',
      [den, normalizovatStranku(d.stranka), normalizovatProdukt(d.produkt), zdrojNavstevy(d.odkaz, d.kampan), zarizeni(ua), otiskNavstevnika(sul, req.ip, ua)]
    );
  } catch (e) {
    console.error('Návštěvnost - záznam selhal:', e.message);
  }
});

// Admin: přehled za období ?od=YYYY-MM-DD&do=YYYY-MM-DD.
// Návštěvníci = unikátní za den (otisk se denně mění), za delší období jejich součet.
router.get('/prehled', vyzadovatAdmina, async (req, res) => {
  const obdobi = overitObdobi(req.query.od, req.query.do);
  if (obdobi.chyba) return res.status(400).json({ chyba: obdobi.chyba });
  const p = [obdobi.od, obdobi.do];
  const vObdobi = 'den BETWEEN $1 AND $2';
  try {
    const [souhrn, dny, stranky, produkty, zdroje, zar, obj] = await Promise.all([
      // zobrazení = načtení stránky; otevření detailu boty se počítá zvlášť
      pool.query(`
        SELECT COALESCE(SUM(zobrazeni), 0)::int AS zobrazeni,
          COALESCE(SUM(zobrazeni_bot), 0)::int AS zobrazeni_bot,
          COALESCE(SUM(n), 0)::int AS navstevnici,
          COALESCE(SUM(n_eshop), 0)::int AS navstevnici_eshop
        FROM (
          SELECT COUNT(*) FILTER (WHERE produkt IS NULL) AS zobrazeni,
            COUNT(*) FILTER (WHERE produkt IS NOT NULL) AS zobrazeni_bot,
            COUNT(DISTINCT navstevnik) AS n,
            COUNT(DISTINCT navstevnik) FILTER (WHERE stranka = '/eshop.html') AS n_eshop
          FROM navstevy WHERE ${vObdobi} GROUP BY den
        ) u`, p),
      pool.query(`
        SELECT to_char(den, 'YYYY-MM-DD') AS den, COUNT(*) FILTER (WHERE produkt IS NULL)::int AS zobrazeni,
          COUNT(DISTINCT navstevnik)::int AS navstevnici
        FROM navstevy WHERE ${vObdobi} GROUP BY den ORDER BY den`, p),
      pool.query(`
        SELECT stranka, COUNT(*)::int AS zobrazeni, COUNT(DISTINCT (den, navstevnik))::int AS navstevnici
        FROM navstevy WHERE ${vObdobi} AND produkt IS NULL GROUP BY stranka ORDER BY zobrazeni DESC`, p),
      pool.query(`
        SELECT n.produkt, MAX(m.znacka) AS znacka, MAX(m.nazev) AS nazev,
          COUNT(*)::int AS zobrazeni, COUNT(DISTINCT (n.den, n.navstevnik))::int AS navstevnici
        FROM navstevy n LEFT JOIN modely m ON m.slug = n.produkt
        WHERE n.${vObdobi} AND n.produkt IS NOT NULL
        GROUP BY n.produkt ORDER BY zobrazeni DESC LIMIT 30`, p),
      pool.query(`
        SELECT zdroj, COUNT(DISTINCT (den, navstevnik))::int AS navstevnici
        FROM navstevy WHERE ${vObdobi} AND zdroj IS NOT NULL
        GROUP BY zdroj ORDER BY navstevnici DESC LIMIT 20`, p),
      pool.query(`
        SELECT zarizeni, COUNT(DISTINCT (den, navstevnik))::int AS navstevnici
        FROM navstevy WHERE ${vObdobi} GROUP BY zarizeni ORDER BY navstevnici DESC`, p),
      pool.query(`
        SELECT COUNT(*)::int AS pocet FROM objednavky
        WHERE stav <> 'zrusena' AND (vytvoreno::timestamptz AT TIME ZONE 'Europe/Prague')::date BETWEEN $1 AND $2`, p)
        .catch(() => ({ rows: [{ pocet: null }] }))
    ]);
    res.json({
      od: obdobi.od,
      do: obdobi.do,
      souhrn: { ...souhrn.rows[0], objednavky: obj.rows[0].pocet },
      dny: dny.rows,
      stranky: stranky.rows.map(s => ({ ...s, nazev: NAZVY_STRANEK[s.stranka] || s.stranka })),
      produkty: produkty.rows,
      zdroje: zdroje.rows,
      zarizeni: zar.rows
    });
  } catch (e) {
    console.error('Návštěvnost - přehled selhal:', e.message);
    res.status(500).json({ chyba: 'Návštěvnost se nepodařilo načíst.' });
  }
});

module.exports = router;
