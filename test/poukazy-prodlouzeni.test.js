// Dárkové poukazy / plastové karty: platnost na účtence, kartička s hodnotou,
// prodloužení platnosti správcem (POST /api/poukazy/:id/prodlouzit) s historií.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chybaProdlouzeni } = require('../lib/poukazPlatnost');

const TED = new Date('2026-11-11T10:00:00Z');
const POUKAZ = { stav: 'aktivni', zustatek: '650', platnost_do: '2027-11-11' };

test('prodloužení: pravidla', () => {
  assert.equal(chybaProdlouzeni(POUKAZ, '2028-02-11', TED), null);
  assert.match(chybaProdlouzeni({ ...POUKAZ, stav: 'zruseny' }, '2028-02-11', TED), /Zrušený/);
  assert.match(chybaProdlouzeni({ ...POUKAZ, zustatek: '0' }, '2028-02-11', TED), /Vyčerpaný/);
  assert.match(chybaProdlouzeni({ ...POUKAZ, stav: 'pouzity' }, '2028-02-11', TED), /Vyčerpaný/);
  assert.match(chybaProdlouzeni(POUKAZ, '2027-02-30', TED), /Neplatné/);
  assert.match(chybaProdlouzeni(POUKAZ, '11.2.2028', TED), /Neplatné/);
  assert.match(chybaProdlouzeni(POUKAZ, '2027-11-11', TED), /pozdější/);
  assert.match(chybaProdlouzeni(POUKAZ, '2028-11-12', TED), /2 roky/);
  // propadlý poukaz se zůstatkem jde prodloužit, ale ne do minulosti
  const propadly = { ...POUKAZ, platnost_do: '2026-10-01' };
  assert.equal(chybaProdlouzeni(propadly, '2026-12-31', TED), null);
  assert.match(chybaProdlouzeni(propadly, '2026-11-01', TED), /minulosti/);
  assert.match(chybaProdlouzeni(null, '2028-01-01', TED), /nalezen/);
});

test('admin: účtenka ukáže platnost, kartička s hodnotou, tlačítka prodloužení', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n'); // CRLF na Windows (core.autocrlf)
  assert.match(html, /p\.typ==='poukaz'&&p\.platnost_do\?`<div style="font-size:11px">Platí do \$\{escH\(datumCesky\(p\.platnost_do\)\)\} včetně/);
  assert.match(html, /function tisknoutKartickuPoukazu\(/);
  assert.match(html, /onclick="tisknoutKartickuKarty\(\)">🖨️ Kartička s hodnotou/);
  assert.match(html, /Vytisknout kartičku s hodnotou do obalu karty/);
  assert.match(html, /onclick="prodlouzitPoukaz\(\$\{p\.id\}\)">📅/);
  assert.match(html, /onclick="prodlouzitPoukaz\(\$\{Number\(p\.id\)\}, true\)">📅 Prodloužit platnost/);
  assert.match(html, /prodlouzeni: 'Platnost prodloužena'/);
  // datumCesky
  const a = html.indexOf('function datumCesky(');
  const fn = new Function(html.slice(a, html.indexOf('\n}\n', a) + 2) + '; return datumCesky;')();
  assert.equal(fn('2027-11-11'), '11. 11. 2027');
  assert.equal(fn('2027-01-05T00:00:00.000Z'), '5. 1. 2027');
  assert.equal(fn(''), '');
});

const URL_DB = process.env.TEST_PG_URL;

test('PostgreSQL: nabití karty zapíše platnost do účtenky, prodloužení s historií karty i poukazu', { skip: !URL_DB && 'bez TEST_PG_URL' }, async () => {
  const { Client, Pool } = require('pg');
  const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
  const { vsePripraveno } = require('../lib/startServeru');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'poukazprodl_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 5 });
  try {
    await pool.query(`CREATE TABLE prodejna_prodeje (id SERIAL PRIMARY KEY, datum TIMESTAMPTZ DEFAULT NOW(), zakaznik TEXT, platba TEXT, poznamka TEXT,
      polozky JSONB NOT NULL, celkem NUMERIC NOT NULL, mezisoucet NUMERIC, sleva NUMERIC DEFAULT 0, vytvoreno TIMESTAMPTZ DEFAULT NOW())`);
    const router = nacistRouterSMocky('../routes/poukazy.js', { '../db/pool': pool });
    await vsePripraveno();
    await pool.query("INSERT INTO poukazove_karty (cislo, ean) VALUES ('DK-26-00001', '2300000000017')");

    // nabití karty 1 000 Kč kartou
    let res = vytvoritRes();
    await najitHandler(router, 'post', '/')({ body: { karta_ean: '2300000000017', hodnota: 1000, platba: 'karta', zakoupeno_kde: 'prodejna' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const polozka = res.body.prodej.polozky[0];
    assert.match(polozka.platnost_do, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(polozka.karta, 'DK-26-00001');
    const poukazId = res.body.id;

    // prodloužení o 3 měsíce za původní konec
    const dosud = polozka.platnost_do;
    const d = new Date(dosud + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 3);
    const novy = d.toISOString().slice(0, 10);
    res = vytvoritRes();
    await najitHandler(router, 'post', '/:id/prodlouzit')({ params: { id: String(poukazId) }, body: { platnost_do: novy } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.body.zmena, /^Platnost prodloužena z .+ na .+$/);
    const ulozeno = (await pool.query("SELECT to_char(platnost_do, 'YYYY-MM-DD') AS d FROM darkove_poukazy WHERE id = $1", [poukazId])).rows[0].d;
    assert.equal(ulozeno, novy);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM poukazy_zmeny WHERE poukaz_id = $1', [poukazId])).rows[0].n, 1);
    const udalost = (await pool.query("SELECT akce, poznamka FROM poukazove_karty_udalosti WHERE akce = 'prodlouzeni'")).rows;
    assert.equal(udalost.length, 1);

    // stejné nebo dřívější datum odmítne a nic nezapíše
    res = vytvoritRes();
    await najitHandler(router, 'post', '/:id/prodlouzit')({ params: { id: String(poukazId) }, body: { platnost_do: novy } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM poukazy_zmeny')).rows[0].n, 1);
    // neexistující poukaz
    res = vytvoritRes();
    await najitHandler(router, 'post', '/:id/prodlouzit')({ params: { id: '99999' }, body: { platnost_do: novy } }, res);
    assert.equal(res.statusCode, 404);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('platnost nového poukazu / nabití karty: 1 rok podle českého data', () => {
  const { platnostNovehoPoukazu } = require('../lib/poukazPlatnost');
  // 11. 11. 2026 0:30 v Praze = 10. 11. 23:30 UTC – dřív vycházelo o den méně
  assert.equal(platnostNovehoPoukazu(new Date('2026-11-10T23:30:00Z')), '2027-11-11');
  // léto (UTC+2): 1. 7. 2026 1:30 v Praze
  assert.equal(platnostNovehoPoukazu(new Date('2026-06-30T23:30:00Z')), '2027-07-01');
  assert.equal(platnostNovehoPoukazu(new Date('2026-11-11T10:00:00Z')), '2027-11-11');
});
