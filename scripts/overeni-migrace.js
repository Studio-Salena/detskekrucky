#!/usr/bin/env node
// Ověření migrace na IZOLOVANÉ KOPII databáze (ne na produkci!).
// Postup a obnova zálohy: docs/postup-overeni-migrace.md
//
//   node scripts/overeni-migrace.js "postgres://uzivatel@localhost:5432/dk_kopie_20261117"
//
// Co dělá:
//   1. ověří, že cíl je lokální kopie (host localhost, název obsahuje kopie/test/sim)
//      a že se NErovná DATABASE_URL
//   2. vypne e-maily a externí služby (Resend, Cloudinary, dopravci, Stripe) - proměnné
//      se smažou a modul e-mailů i DB pool se podstrčí, žádná síťová operace neproběhne
//   3. udělá snímek finančních dat: součty jako v Účetnictví/uzávěrkách + otisk obsahu
//      dosavadních sloupců finančních tabulek
//   4. spustí všechny startovní migrace aplikace (2×, jako dva restarty)
//   5. snímek znovu → porovná (obsah dosavadních sloupců se nesmí změnit)
//   6. vypíše kontrolu evidence: doklady mimo rozsah (starší bez evidence) zvlášť
//   Výsledek: zprava-overeni-migrace.json vedle skriptu (nebo cesta ve 2. argumentu).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const KOREN = path.join(__dirname, '..');
const url = process.argv[2] || process.env.KOPIE_DB_URL;
const vystup = process.argv[3] || path.join(__dirname, 'zprava-overeni-migrace.json');

function konec(zprava) { console.error('STOP: ' + zprava); process.exit(2); }
if (!url) konec('Zadejte URL kopie databáze (argument nebo KOPIE_DB_URL).');
let cil;
try { cil = new URL(url); } catch { konec('Neplatné URL databáze.'); }
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(cil.hostname)) konec(`Cíl ${cil.hostname} není lokální - skript běží jen proti lokální kopii.`);
const nazevDb = decodeURIComponent(cil.pathname.replace(/^\//, ''));
if (!/kopie|test|sim/i.test(nazevDb)) konec(`Databáze „${nazevDb}“ nevypadá jako kopie (název musí obsahovat kopie / test / sim).`);
if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) konec('URL je stejné jako DATABASE_URL - to je produkce, nepokračuji.');

// Žádné externí služby ani e-maily
for (const k of Object.keys(process.env)) {
  if (/^(RESEND|CLOUDINARY|ZASILKOVNA|GLS|PPL|STRIPE|SMTP|EMAIL)/.test(k)) delete process.env[k];
}
process.env.DATABASE_URL = url;
// interní tajemství (ne externí služba) - bez něj modul přihlašování jen hlásí varování
process.env.JWT_SECRET = process.env.JWT_SECRET || 'overeni-migrace-' + crypto.randomBytes(8).toString('hex');
process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'overeni-migrace-' + crypto.randomBytes(6).toString('hex');

const { Pool } = require(path.join(KOREN, 'node_modules', 'pg'));
const pool = new Pool({ connectionString: url, max: 5 });
const tichyPool = pool;

// DB pool a e-maily podstrčit dřív, než se načte jakákoli routa
const cestaPool = require.resolve(path.join(KOREN, 'db', 'pool'));
require.cache[cestaPool] = { id: cestaPool, filename: cestaPool, loaded: true, exports: tichyPool };
const cestaEmaily = require.resolve(path.join(KOREN, 'routes', 'emaily'));
const odeslane = [];
require.cache[cestaEmaily] = { id: cestaEmaily, filename: cestaEmaily, loaded: true,
  exports: new Proxy({}, { get: (_, jmeno) => async (...a) => { odeslane.push(String(jmeno)); } }) };

// Povinné tabulky musí v kopii produkce existovat (jinak to není úplná kopie a ověření selže);
// volitelné se porovnají, jen pokud existují. Po migraci musí existovat tabulky evidence.
const POVINNE = ['prodejna_prodeje', 'vratky', 'objednavky', 'objednavky_polozky', 'darkove_poukazy', 'poukazy_pouziti', 'sklad', 'pohyby_skladu'];
const VOLITELNE = ['faktury', 'promo_pouziti', 'poukazove_karty', 'nakupni_faktury'];
const FINANCNI_TABULKY = [...POVINNE, ...VOLITELNE];
const POVINNE_PO_MIGRACI = ['platby', 'platby_prirazeni', 'platby_prirazeni_storna', 'kredit_pohyby', 'kredit_vklady', 'kredit_casti',
  'kredit_vklady_zdroje', 'dobirky', 'dobirky_vyuctovani', 'operace_klice', 'prodejna_klice', 'eet_udalosti'];
const chyby = { chybejici_povinne: [], chybejici_po_migraci: [], chyby_dotazu: [], chyby_migrace: [], rozdily_dat: [] };
// Dotaz, jehož chyba znamená neúspěch ověření (nesmí se jen vypsat vedle výsledku)
async function bezpecne(popis, fn, nahrada = null) {
  try { return await fn(); } catch (e) { chyby.chyby_dotazu.push(`${popis}: ${e.message}`); return nahrada; }
}

async function existuje(tabulka) {
  return (await pool.query('SELECT to_regclass($1) IS NOT NULL AS e', [tabulka])).rows[0].e;
}
async function sloupce(tabulka) {
  return (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [tabulka])).rows.map(r => r.column_name);
}

// Otisk obsahu daných sloupců (seřazeno podle id / všech sloupců)
async function otiskTabulky(tabulka, sl) {
  const seznam = sl.map(c => `"${c}"`).join(', ');
  const r = await pool.query(`SELECT md5(COALESCE(string_agg(radek, '|' ORDER BY radek), '')) AS otisk, COUNT(*)::int AS pocet
    FROM (SELECT row(${seznam})::text AS radek FROM "${tabulka}") x`);
  return r.rows[0];
}

async function soucty() {
  const q = async (sql) => (await pool.query(sql)).rows;
  const vysledek = {};
  if (await existuje('prodejna_prodeje')) vysledek.prodejna_podle_platby = await q(`SELECT COALESCE(platba, '-') AS platba, COUNT(*)::int AS pocet, SUM(celkem)::text AS celkem FROM prodejna_prodeje GROUP BY 1 ORDER BY 1`);
  if (await existuje('vratky')) vysledek.vratky_podle_zpusobu = await q(`SELECT COALESCE(zpusob_vraceni, '-') AS zpusob, COUNT(*)::int AS pocet, SUM(castka)::text AS castka FROM vratky GROUP BY 1 ORDER BY 1`);
  if (await existuje('objednavky')) vysledek.objednavky_podle_stavu = await q(`SELECT stav, COUNT(*)::int AS pocet, SUM(celkem)::text AS celkem FROM objednavky GROUP BY 1 ORDER BY 1`);
  if (await existuje('poukazy_pouziti')) vysledek.poukazy_uplatneno = await q(`SELECT COUNT(*)::int AS pocet, COALESCE(SUM(castka),0)::text AS castka FROM poukazy_pouziti`);
  if (await existuje('darkove_poukazy')) vysledek.poukazy_podle_stavu = await q(`SELECT stav, druh, COUNT(*)::int AS pocet, SUM(hodnota)::text AS hodnota, SUM(zustatek)::text AS zustatek FROM darkove_poukazy GROUP BY 1, 2 ORDER BY 1, 2`);
  // Účetnictví (stejný vzorec jako admin): e-shop bez zrušených + prodejna − vratky
  if (await existuje('objednavky') && await existuje('prodejna_prodeje') && await existuje('vratky')) {
    vysledek.ucetnictvi = (await q(`SELECT
      (SELECT COALESCE(SUM(celkem),0) FROM objednavky WHERE stav <> 'zrusena')::text AS eshop,
      (SELECT COALESCE(SUM(celkem),0) FROM prodejna_prodeje)::text AS prodejna,
      (SELECT COALESCE(SUM(castka),0) FROM vratky)::text AS vratky,
      (SELECT COALESCE(SUM(celkem),0) FROM prodejna_prodeje WHERE platba = 'poukaz')::text AS prodejna_poukazem`))[0];
  }
  return vysledek;
}

async function snimek(sloupcePred, faze) {
  const obsah = {};
  for (const t of FINANCNI_TABULKY) {
    if (!(await existuje(t))) continue;
    const sl = sloupcePred ? sloupcePred[t] : await sloupce(t);
    if (!sl) continue;
    const o = await bezpecne(`otisk ${t} (${faze})`, () => otiskTabulky(t, sl));
    if (o) obsah[t] = { sloupce: sl, ...o };
  }
  return { obsah, soucty: await bezpecne(`účetní součty (${faze})`, soucty, {}) };
}

async function spustitMigrace(kolo) {
  // stejné routy jako index.js; načtení = spuštění jejich startovních migrací
  const routy = fs.readFileSync(path.join(KOREN, 'index.js'), 'utf8').match(/require\('\.\/routes\/([^']+)'\)/g)
    .map(s => s.replace(/require\('\.\/routes\/|'\)/g, '')).filter(r => r !== 'emaily');
  for (const r of routy) {
    const cesta = require.resolve(path.join(KOREN, 'routes', r));
    delete require.cache[cesta];
  }
  const startServeru = require(path.join(KOREN, 'lib', 'startServeru'));
  const chyby = [];
  const puvodniLog = console.log, puvodniErr = console.error;
  console.log = (...a) => { const t = a.join(' '); if (/chyba|error/i.test(t)) chyby.push(t); };
  console.error = (...a) => chyby.push(a.join(' '));
  try {
    for (const r of routy) require(path.join(KOREN, 'routes', r));
    const ok = await startServeru.vsePripraveno(60000);
    if (!ok) chyby.push('Migrace nedoběhly do 60 s');
  } finally { console.log = puvodniLog; console.error = puvodniErr; }
  return { kolo, routy: routy.length, chyby };
}

(async () => {
  for (const t of POVINNE) if (!(await existuje(t))) chyby.chybejici_povinne.push(t);
  const sloupcePred = {};
  for (const t of FINANCNI_TABULKY) if (await existuje(t)) sloupcePred[t] = await sloupce(t);
  const pred = await snimek(sloupcePred, 'před');
  const migrace1 = await spustitMigrace(1);
  const migrace2 = await spustitMigrace(2);
  for (const m of [migrace1, migrace2]) for (const c of m.chyby) chyby.chyby_migrace.push(`kolo ${m.kolo}: ${c}`);
  for (const t of POVINNE_PO_MIGRACI) if (!(await existuje(t))) chyby.chybejici_po_migraci.push(t);
  const po = await snimek(sloupcePred, 'po');

  for (const [t, v] of Object.entries(pred.obsah)) {
    const p = po.obsah[t];
    if (!p) { chyby.rozdily_dat.push(`${t}: tabulka (nebo její otisk) po migraci chybí`); continue; }
    if (p.pocet !== v.pocet) chyby.rozdily_dat.push(`${t}: počet řádků ${v.pocet} → ${p.pocet}`);
    else if (p.otisk !== v.otisk) chyby.rozdily_dat.push(`${t}: změnil se obsah dosavadních sloupců`);
  }
  const souctyShodne = JSON.stringify(pred.soucty) === JSON.stringify(po.soucty);
  if (!souctyShodne) chyby.rozdily_dat.push('účetní součty se liší (viz soucty_pred / soucty_po)');
  if (odeslane.length) chyby.rozdily_dat.push(`během migrace se pokusilo odeslat ${odeslane.length} e-mailů`);

  const { kontrola } = require(path.join(KOREN, 'routes', 'evidencePlateb'));
  const k = await bezpecne('kontrola evidence', () => kontrola(pool, null), { od: null, v_rozsahu: {}, mimo_rozsah: {}, ceka_na_platbu: 0, rozdily: [] });
  if (k.rozdily && k.rozdily.length) chyby.rozdily_dat.push(`kontrola evidence našla ${k.rozdily.length} rozdílů`);
  const nove = {};
  for (const t of ['platby', 'kredit_pohyby', 'kredit_vklady', 'prodejna_klice', 'eet_udalosti']) {
    if (await existuje(t)) nove[t] = await bezpecne(`počet ${t}`, async () => Number((await pool.query(`SELECT COUNT(*) n FROM ${t}`)).rows[0].n));
  }
  if (nove.platby > 0 || nove.kredit_vklady > 0) chyby.rozdily_dat.push('migrace vytvořila platby nebo vklady kreditu - historie se nemá doplňovat');
  const historicke = (await existuje('darkove_poukazy'))
    ? await bezpecne('stav poukazů', async () => (await pool.query(`SELECT COALESCE(platba_stav, '-') AS platba_stav, stav, COUNT(*)::int AS pocet FROM darkove_poukazy GROUP BY 1, 2 ORDER BY 1, 2`)).rows, []) : [];

  const pocetChyb = Object.values(chyby).reduce((a, x) => a + x.length, 0);
  const zprava = {
    cas: new Date().toISOString(), databaze: `${cil.hostname}/${nazevDb}`,
    vysledek: pocetChyb ? 'SELHALO' : 'OK', chyby,
    povinne_tabulky: POVINNE, volitelne_tabulky: VOLITELNE.map(t => ({ tabulka: t, existuje: !!sloupcePred[t] })),
    migrace: [migrace1, migrace2], odeslane_emaily: odeslane,
    soucty_pred: pred.soucty, soucty_po: po.soucty, soucty_shodne: souctyShodne,
    nove_tabulky_radky: nove,
    kontrola_evidence: {
      poznamka: 'Doklady MIMO ROZSAH nejsou spárované - jen vznikly před evidencí plateb a nekontrolují se.',
      od: k.od, v_rozsahu: k.v_rozsahu, mimo_rozsah: k.mimo_rozsah, ceka_na_platbu: k.ceka_na_platbu, rozdily: k.rozdily
    },
    poukazy_podle_stavu_platby: historicke
  };
  fs.writeFileSync(vystup, JSON.stringify(zprava, null, 2));
  // Verdikt jako PRVNÍ řádek; při chybě se úspěšné dílčí výsledky nevypisují jako „OK“
  if (pocetChyb) {
    console.log(`OVĚŘENÍ SELHALO (${pocetChyb} chyb):`);
    const popisy = { chybejici_povinne: 'chybí povinná tabulka', chybejici_po_migraci: 'po migraci chybí tabulka evidence', chyby_dotazu: 'chyba dotazu', chyby_migrace: 'chyba migrace', rozdily_dat: 'rozdíl v datech' };
    for (const [k2, seznam] of Object.entries(chyby)) for (const c of seznam) console.log(`  ✖ ${popisy[k2]}: ${c}`);
  } else {
    console.log('OVĚŘENÍ PROŠLO');
    console.log(`  obsah dosavadních finančních sloupců beze změny, účetní součty shodné, e-maily 0`);
    console.log(`  mimo rozsah kontroly (starší doklady bez evidence, NEspárované): ${JSON.stringify(k.mimo_rozsah)}`);
  }
  console.log(`Kopie: ${cil.hostname}/${nazevDb}`);
  console.log(`Zpráva: ${vystup}`);
  await pool.end();
  process.exit(pocetChyb ? 1 : 0);
})().catch(async e => { console.log('OVĚŘENÍ SELHALO (neočekávaná chyba): ' + e.message); await pool.end().catch(() => {}); process.exit(1); });
