// /api/evidence-plateb – kniha plateb a kreditu (lib/evidencePlateb.js), jen pro admina.
// Zápisy z běžných operací dělají jejich vlastní routy ve stejné transakci;
// tady je přehled, volná platba, vyúčtování dobírek a kontrola proti dokladům.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const ev = require('../lib/evidencePlateb');

router.use(vyzadovatAdmina);

pripravit(ev.migrovat(pool).then(() => console.log('Evidence plateb OK')).catch(e => console.log('Evidence plateb chyba:', e.message)));

const kc = ev.kc;

async function vTransakci(res, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vysledek = await fn(client);
    await client.query('COMMIT');
    res.json(vysledek);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ev.ChybaEvidence) return res.status(err.status).json({ chyba: err.chyba, ...err.data });
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
}

// GET /api/evidence-plateb?od=RRRR-MM-DD&do=RRRR-MM-DD&zdroj_typ=&zdroj_id=
router.get('/', async (req, res) => {
  try {
    const { od, do: doDne, zdroj_typ, zdroj_id } = req.query;
    const p = (await pool.query(`SELECT * FROM platby
      WHERE ($1::date IS NULL OR prijato_at >= $1::date) AND ($2::date IS NULL OR prijato_at < $2::date + 1)
        AND ($3::text IS NULL OR zdroj_typ = $3) AND ($4::int IS NULL OR zdroj_id = $4) ORDER BY id DESC LIMIT 1000`,
      [od || null, doDne || null, zdroj_typ || null, zdroj_id ? Number(zdroj_id) : null])).rows;
    const k = (await pool.query(`SELECT * FROM kredit_pohyby
      WHERE ($1::date IS NULL OR vytvoreno >= $1::date) AND ($2::date IS NULL OR vytvoreno < $2::date + 1)
        AND ($3::text IS NULL OR zdroj_typ = $3) AND ($4::int IS NULL OR zdroj_id = $4) ORDER BY id DESC LIMIT 1000`,
      [od || null, doDne || null, zdroj_typ || null, zdroj_id ? Number(zdroj_id) : null])).rows;
    res.json({ platby: p, kredit: k });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/evidence-plateb/volna { klic, zpusob, castka, prijato_at?, poznamka? } – platba,
// která ještě nemá doklad (např. převod, který přišel na účet); přiřadí se později k objednávce
router.post('/volna', (req, res) => vTransakci(res, async client => {
  const b = req.body || {};
  if (!b.klic) throw new ev.ChybaEvidence(400, 'Chybí identifikátor operace.');
  if (!['prevod', 'hotovost', 'karta', 'qr'].includes(b.zpusob)) throw new ev.ChybaEvidence(400, 'Neplatný způsob platby.');
  const castka = kc(b.castka);
  if (!(castka > 0) || castka > 1e7) throw new ev.ChybaEvidence(400, 'Neplatná částka.');
  const { vysledek } = await ev.jednou(client, 'volna', b.klic, { zpusob: b.zpusob, castka, prijato_at: b.prijato_at || null }, async () =>
    ev.zapsatPlatbu(client, { klic: 'volna:' + b.klic, typ: 'prijem', castka, zpusob: b.zpusob,
      okolnosti: b.zpusob === 'prevod' ? 'eshop' : 'prodejna', kontaktni: b.zpusob !== 'prevod',
      prijato_at: b.prijato_at || null, zdroj_typ: 'volna', zdroj_id: null, poznamka: b.poznamka ? String(b.poznamka).slice(0, 300) : null }));
  return vysledek;
}));

// GET /api/evidence-plateb/dobirky?nevyuctovane=1
router.get('/dobirky', async (req, res) => {
  try {
    const r = await pool.query(`SELECT d.*, o.cislo AS objednavka_cislo, p.prijato_at FROM dobirky d
      JOIN platby p ON p.id = d.platba_id LEFT JOIN objednavky o ON o.id = d.objednavka_id
      WHERE ($1::boolean IS NOT TRUE OR d.vyuctovani_id IS NULL) ORDER BY d.id DESC`, [req.query.nevyuctovane === '1']);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/evidence-plateb/dobirky/vyuctovani { klic, dopravce, vyplaceno_at, poplatek, dobirky: [id...] }
// Vyúčtování od dopravce: brutto = součet dobírek, netto = brutto − poplatek.
// Příjem od zákazníka už je zapsaný u dobírky - tady se znovu nepočítá.
router.post('/dobirky/vyuctovani', (req, res) => vTransakci(res, async client => {
  const b = req.body || {};
  if (!b.klic) throw new ev.ChybaEvidence(400, 'Chybí identifikátor operace.');
  const ids = Array.isArray(b.dobirky) ? [...new Set(b.dobirky.map(Number))].filter(Number.isInteger).sort((a, c) => a - c) : [];
  if (!ids.length) throw new ev.ChybaEvidence(400, 'Vyberte dobírky, které dopravce vyúčtoval.');
  const poplatek = kc(b.poplatek || 0);
  if (!(poplatek >= 0)) throw new ev.ChybaEvidence(400, 'Neplatný poplatek.');
  const { vysledek } = await ev.jednou(client, 'dobirky-vyuctovani', b.klic, { ids, poplatek, dopravce: b.dopravce || null, vyplaceno_at: b.vyplaceno_at || null }, async () => {
    const dobirky = (await client.query('SELECT * FROM dobirky WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids])).rows;
    if (dobirky.length !== ids.length) throw new ev.ChybaEvidence(404, 'Některá dobírka neexistuje.');
    const vyuctovana = dobirky.find(d => d.vyuctovani_id);
    if (vyuctovana) throw new ev.ChybaEvidence(409, `Dobírka objednávky #${vyuctovana.objednavka_id} už je vyúčtovaná.`);
    const dopravce = String(b.dopravce || dobirky[0].dopravce || '').slice(0, 50);
    if (!dopravce) throw new ev.ChybaEvidence(400, 'Zadejte dopravce.');
    if (dobirky.some(d => d.dopravce && d.dopravce !== dopravce)) throw new ev.ChybaEvidence(400, 'Vyúčtování musí být od jednoho dopravce.');
    const brutto = kc(dobirky.reduce((s, d) => s + Number(d.castka), 0));
    if (poplatek > brutto) throw new ev.ChybaEvidence(400, 'Poplatek je vyšší než vyúčtované dobírky.');
    const v = (await client.query(
      `INSERT INTO dobirky_vyuctovani (klic, dopravce, vyplaceno_at, brutto, poplatek, netto, poznamka)
       VALUES ($1,$2,COALESCE($3::timestamptz, NOW()),$4,$5,$6,$7) RETURNING *`,
      ['vyuct:' + b.klic, dopravce, b.vyplaceno_at || null, brutto, poplatek, kc(brutto - poplatek), b.poznamka ? String(b.poznamka).slice(0, 300) : null])).rows[0];
    await client.query('UPDATE dobirky SET vyuctovani_id = $1 WHERE id = ANY($2::int[])', [v.id, ids]);
    return v;
  });
  return vysledek;
}));

// GET /api/evidence-plateb/kontrola?od=RRRR-MM-DD – porovná doklady s knihou plateb a kreditu.
// Kontrolují se jen doklady od začátku evidence (první zápis), starší evidenci nemají
// a nic se jim nedopočítává.
router.get('/kontrola', async (req, res) => {
  try {
    res.json(await kontrola(pool, req.query.od || null));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

const PENIZE = ['hotovost', 'karta', 'qr', 'prevod'];

async function kontrola(db, od) {
  const zacatek = od || (await db.query(`SELECT LEAST((SELECT MIN(vytvoreno) FROM platby), (SELECT MIN(vytvoreno) FROM kredit_pohyby)) AS z`)).rows[0].z;
  if (!zacatek) return { od: null, rozdily: [], zkontrolovano: { prodeje: 0, vratky: 0, poukazy: 0 } };
  const netto = (sloupce) => `COALESCE(SUM(CASE WHEN typ IN (${sloupce.plus}) THEN castka WHEN typ IN (${sloupce.minus}) THEN -castka ELSE 0 END), 0)`;
  const prodeje = (await db.query(`
    SELECT pr.id, pr.platba, pr.celkem, pr.poukaz_castka,
      (SELECT ${netto({ plus: "'prijem'", minus: "'storno_prijmu'" })} FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = pr.id) AS prijato,
      (SELECT ${netto({ plus: "'cerpani'", minus: "'storno_cerpani'" })} FROM kredit_pohyby WHERE zdroj_typ = 'prodej' AND zdroj_id = pr.id) AS cerpano
    FROM prodejna_prodeje pr WHERE pr.vytvoreno >= $1 ORDER BY pr.id`, [zacatek])).rows;
  const vratky = (await db.query(`
    SELECT v.id, v.castka, v.zpusob_vraceni,
      (SELECT ${netto({ plus: "'vraceni'", minus: "'storno_vraceni'" })} FROM platby WHERE zdroj_typ = 'vratka' AND zdroj_id = v.id) AS vraceno
    FROM vratky v WHERE v.vytvoreno >= $1 ORDER BY v.id`, [zacatek])).rows;
  const poukazy = (await db.query(`
    SELECT d.id, d.kod, d.zustatek,
      (SELECT ${netto({ plus: "'nabiti','pripsani','storno_cerpani'", minus: "'cerpani','storno_nabiti','storno_pripsani'" })} FROM kredit_pohyby WHERE poukaz_id = d.id) AS kredit
    FROM darkove_poukazy d WHERE d.vytvoreno >= $1 ORDER BY d.id`, [zacatek])).rows;

  const rozdily = [];
  for (const p of prodeje) {
    const ocekPrijem = PENIZE.includes(p.platba) ? kc(p.celkem) : 0;
    const ocekCerpani = p.platba === 'poukaz' ? kc(p.celkem) : kc(p.poukaz_castka || 0);
    if (kc(p.prijato) !== ocekPrijem) rozdily.push({ doklad: `účtenka #${p.id}`, co: 'příjem peněz', doklad_castka: ocekPrijem, evidence: kc(p.prijato) });
    if (kc(p.cerpano) !== ocekCerpani) rozdily.push({ doklad: `účtenka #${p.id}`, co: 'čerpání poukazu', doklad_castka: ocekCerpani, evidence: kc(p.cerpano) });
  }
  for (const v of vratky) {
    const oc = PENIZE.includes(v.zpusob_vraceni) ? kc(v.castka) : 0;
    if (kc(v.vraceno) !== oc) rozdily.push({ doklad: `vratka #${v.id}`, co: 'vrácené peníze', doklad_castka: oc, evidence: kc(v.vraceno) });
  }
  for (const d of poukazy) {
    if (kc(d.kredit) !== kc(d.zustatek)) rozdily.push({ doklad: `poukaz ${d.kod}`, co: 'zůstatek kreditu', doklad_castka: kc(d.zustatek), evidence: kc(d.kredit) });
  }
  return { od: zacatek, rozdily, zkontrolovano: { prodeje: prodeje.length, vratky: vratky.length, poukazy: poukazy.length } };
}

module.exports = router;
module.exports.kontrola = kontrola;
