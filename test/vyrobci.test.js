// Výrobci podle značek (GPSR): pravidla (lib/vyrobci.js), API (routes/vyrobci.js)
// proti skutečnému PostgreSQL (jen s TEST_PG_URL), detail boty v e-shopu
// a záložka Výrobci v adminu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { klicZnacky, overitVyrobce } = require('../lib/vyrobci');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'test-heslo';

const KOREN = path.join(__dirname, '..');
const ESHOP = fs.readFileSync(path.join(KOREN, 'eshop.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(KOREN, 'admin.html'), 'utf8');
const PAYLOAD = '<img src=x onerror=alert(1)>';
const FRODDO = { znacka: 'Froddo', vyrobce: 'Froddo d.o.o.', adresa: 'Ulica 1, 10000 Zagreb, Chorvatsko', kontakt: 'info@froddo.com' };

function vytahnout(html, nazev) {
  const start = html.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, nazev);
  let hloubka = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') hloubka++;
    else if (html[i] === '}' && --hloubka === 0) return (html.slice(start - 6, start) === 'async ' ? 'async ' : '') + html.slice(start, i + 1);
  }
  throw new Error('konec ' + nazev);
}

test('klíč značky: bez diakritiky, velikosti písmen a přebytečných mezer; e-shop počítá stejně', () => {
  assert.equal(klicZnacky('  FRODDO '), 'froddo');
  assert.equal(klicZnacky('Bundgaard  Petit'), 'bundgaard petit');
  assert.equal(klicZnacky('Vlnka Školka'), 'vlnka skolka');
  assert.equal(klicZnacky(null), '');
  const eshop = vm.runInNewContext(vytahnout(ESHOP, 'klicZnacky') + '; klicZnacky', {});
  for (const z of ['  FRODDO ', 'Vlnka Školka', 'Bundgaard  Petit']) assert.equal(eshop(z), klicZnacky(z));
});

test('ověření: povinný výrobce, adresa a kontakt; vše prázdné = smazat; délky a typy', () => {
  const { hodnoty, prazdne } = overitVyrobce({ ...FRODDO, znacka: ' Froddo ', osoba_eu: '  ' });
  assert.equal(prazdne, false);
  assert.deepEqual(hodnoty, { klic: 'froddo', znacka: 'Froddo', vyrobce: 'Froddo d.o.o.', adresa: FRODDO.adresa, kontakt: 'info@froddo.com', osoba_eu: null, upozorneni: null });
  assert.equal(overitVyrobce({ znacka: 'Froddo', vyrobce: '', adresa: '', kontakt: '' }).prazdne, true);
  assert.match(overitVyrobce({ znacka: 'Froddo', vyrobce: 'Froddo' }).chyba, /Vyplňte výrobce, jeho adresu a e-mail nebo web/);
  assert.match(overitVyrobce({ ...FRODDO, adresa: '' }).chyba, /Vyplňte/);
  assert.match(overitVyrobce({ ...FRODDO, znacka: '' }).chyba, /Chybí značka/);
  assert.match(overitVyrobce({ ...FRODDO, vyrobce: 'x'.repeat(151) }).chyba, /Výrobce: nejvýš 150/);
  assert.match(overitVyrobce({ ...FRODDO, kontakt: ['a'] }).chyba, /neplatná hodnota/);
  assert.match(overitVyrobce(null).chyba, /Chybí značka/);
});

test('e-shop: detail boty ukáže výrobce značky (escapovaně), bez údajů je sekce skrytá', () => {
  const prvky = { detailVyrobceSekce: { hidden: true }, detailVyrobce: { innerHTML: '' } };
  const sandbox = { document: { getElementById: id => prvky[id] } };
  vm.createContext(sandbox);
  vm.runInContext(['escHtml', 'klicZnacky', 'vyrobceDetailHtml', 'vykreslitVyrobceDetailu'].map(n => vytahnout(ESHOP, n)).join('\n'), sandbox);
  sandbox.vyrobciZnacek = new Map([['froddo', { ...FRODDO, klic: 'froddo', osoba_eu: null, upozorneni: PAYLOAD }]]);
  vm.runInContext('var vyrobciZnacek = this.vyrobciZnacek; vykreslitVyrobceDetailu({ znacka: "FRODDO" });', sandbox);
  assert.equal(prvky.detailVyrobceSekce.hidden, false);
  const h = prvky.detailVyrobce.innerHTML;
  assert.match(h, /<strong>Výrobce:<\/strong> Froddo d\.o\.o\./);
  assert.match(h, /<strong>Adresa:<\/strong> Ulica 1, 10000 Zagreb, Chorvatsko/);
  assert.match(h, /<strong>Kontakt:<\/strong> info@froddo\.com/);
  assert.doesNotMatch(h, /Odpovědná osoba/);
  assert.ok(!h.includes(PAYLOAD) && h.includes('&lt;img'));
  vm.runInContext('vykreslitVyrobceDetailu({ znacka: "Beda" });', sandbox);
  assert.equal(prvky.detailVyrobceSekce.hidden, true);
  assert.equal(prvky.detailVyrobce.innerHTML, '');
  // sekce v detailu, načtení z API, proměnná dřív než fetch (jinak ReferenceError)
  assert.match(ESHOP, /<section class="detail-sekce" id="detailVyrobceSekce" hidden><h3>Výrobce a bezpečnost<\/h3>/);
  assert.match(ESHOP, /fetch\(API \+ '\/vyrobci'\)/);
  assert.ok(ESHOP.indexOf('let vyrobciZnacek') < ESHOP.indexOf("fetch(API + '/vyrobci')"));
  assert.match(ESHOP, /getElementById\('detailPopis'\)\.textContent = [^\n]*\n  vykreslitVyrobceDetailu\(p\);/);
});

test('admin: záložka Výrobci, řádek za značku s poli a počtem chybějících, escapování', () => {
  const produkty = ADMIN.slice(ADMIN.indexOf('id="page-produkty"'), ADMIN.indexOf('<!-- PRODEJNA -->'));
  assert.match(produkty, /data-cil="vyrobci"[^>]*>Výrobci<\/button>/);
  assert.match(produkty, /data-pohled="vyrobci"[\s\S]*id="vyrobciTable"/);
  assert.match(ADMIN, /async function loadProdukty\(\) \{\s*await Promise\.all\(\[loadModely\(\), loadVyrobci\(\)\]\);/);
  const prvky = { vyrobciTable: { innerHTML: '' }, vyrobciPocet: { textContent: '' } };
  const sandbox = { document: { getElementById: id => prvky[id] } };
  vm.createContext(sandbox);
  const konst = ADMIN.match(/const VYROBCI_POLE = \[[\s\S]*?\n\];/)[0];
  vm.runInContext([konst, ...['escH', 'escAttr', 'pocetSlovy', 'vykreslitVyrobce'].map(n => vytahnout(ADMIN, n))].join('\n'), sandbox);
  sandbox.data = [{ klic: 'beda', znacka: 'Beda', pocet_modelu: 3 }, { klic: 'froddo', znacka: PAYLOAD, pocet_modelu: 1, ...FRODDO, znacka: PAYLOAD }];
  vm.runInContext('var vyrobciData = this.data; vykreslitVyrobce();', sandbox);
  const h = prvky.vyrobciTable.innerHTML;
  assert.equal(prvky.vyrobciPocet.textContent, 'Značky (2) – bez výrobce: 1');
  assert.match(h, /data-klic="beda"[\s\S]*chybí výrobce/);
  assert.match(h, /data-pole="vyrobce"[^>]*value="Froddo d\.o\.o\."/);
  for (const pole of ['vyrobce', 'adresa', 'kontakt', 'osoba_eu', 'upozorneni']) assert.match(h, new RegExp(`data-pole="${pole}"`));
  assert.ok(!h.includes(PAYLOAD));
});

test('API proti PostgreSQL: přehled značek z modelů, uložení, veřejný seznam, smazání, admin ochrana', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'vyrobcitest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const routePath = require.resolve('../routes/vyrobci.js');
  const poolPath = require.resolve('../db/pool');
  try {
    await pool.query("CREATE TABLE modely (id SERIAL PRIMARY KEY, znacka TEXT); INSERT INTO modely (znacka) VALUES ('Froddo'), ('Froddo'), ('FRODDO '), ('Beda'), (''), (NULL)");
    delete require.cache[routePath];
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
    const router = require(routePath);
    await require('../lib/startServeru').vsePripraveno();
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/vyrobci', router);
    const server = app.listen(0);
    const url = `http://127.0.0.1:${server.address().port}/api/vyrobci`;
    const H = { 'Content-Type': 'application/json', 'x-admin-heslo': process.env.ADMIN_HESLO };
    try {
      let r = await fetch(url + '/admin', { headers: H });
      assert.deepEqual(await r.json(), [{ klic: 'beda', znacka: 'Beda', pocet_modelu: 1 }, { klic: 'froddo', znacka: 'Froddo', pocet_modelu: 3 }].sort((a, b) => a.znacka.localeCompare(b.znacka, 'cs')));
      assert.equal((await fetch(url + '/admin')).status, 403);
      assert.equal((await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FRODDO) })).status, 403);

      r = await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify({ ...FRODDO, znacka: 'froddo' }) });
      assert.equal(r.status, 200);
      r = await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify({ ...FRODDO, upozorneni: 'Nevhodné pro děti do 3 let.' }) });
      assert.equal((await r.json()).upozorneni, 'Nevhodné pro děti do 3 let.');
      assert.equal((await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify({ znacka: 'Beda', vyrobce: 'Beda' }) })).status, 400);

      r = await fetch(url);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
      assert.deepEqual(await r.json(), [{ klic: 'froddo', znacka: 'Froddo', ...FRODDO, osoba_eu: null, upozorneni: 'Nevhodné pro děti do 3 let.' }]);
      const prehled = await (await fetch(url + '/admin', { headers: H })).json();
      assert.equal(prehled.find(v => v.klic === 'froddo').vyrobce, 'Froddo d.o.o.');
      assert.equal(prehled.find(v => v.klic === 'froddo').pocet_modelu, 3);

      r = await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify({ znacka: 'Froddo', vyrobce: '', adresa: '', kontakt: '' }) });
      assert.equal((await r.json()).smazano, true);
      assert.deepEqual(await (await fetch(url)).json(), []);
    } finally {
      server.close();
    }
  } finally {
    delete require.cache[poolPath];
    delete require.cache[routePath];
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
