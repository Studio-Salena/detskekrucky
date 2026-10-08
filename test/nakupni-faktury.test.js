// Nákupní faktury: výpočet Kč a DPH, kontrola vstupu, API (admin) a SQL proti PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { overitFakturu, spocitat, vychoziRezim } = require('../lib/nakupniFaktury');

process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'test-heslo';
const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

const ZAKLAD = { dodavatel: 'Froddo d.o.o.', zeme: 'HR', cislo_faktury: '2026-0153', datum_vystaveni: '2026-10-01', mena: 'EUR', castka: 1000, kurz: 25.2 };

test('výpočet: tuzemsko z ceny s DPH, EU a dovoz DPH ze základu, bez DPH nula', () => {
  assert.deepEqual(spocitat({ castka: 1210, mena: 'CZK', kurz: 1, rezim_dph: 'tuzemsko', sazba_dph: 21 }), { castka_czk: 1210, zaklad_czk: 1000, dph_czk: 210 });
  assert.deepEqual(spocitat({ castka: 1000, mena: 'EUR', kurz: 25.2, rezim_dph: 'eu_prenesena', sazba_dph: 21 }), { castka_czk: 25200, zaklad_czk: 25200, dph_czk: 5292 });
  assert.deepEqual(spocitat({ castka: 100, mena: 'USD', kurz: 23.456, rezim_dph: 'dovoz', sazba_dph: 21 }), { castka_czk: 2345.6, zaklad_czk: 2345.6, dph_czk: 492.58 });
  assert.deepEqual(spocitat({ castka: 500, mena: 'CZK', kurz: 1, rezim_dph: 'bez_dph', sazba_dph: 0 }), { castka_czk: 500, zaklad_czk: 500, dph_czk: 0 });
});

test('výchozí režim DPH podle země: CZ tuzemsko, EU přenesená povinnost, jinak dovoz', () => {
  assert.equal(vychoziRezim('CZ'), 'tuzemsko');
  assert.equal(vychoziRezim('HR'), 'eu_prenesena');
  assert.equal(vychoziRezim('SK'), 'eu_prenesena');
  assert.equal(vychoziRezim('CN'), 'dovoz');
  assert.equal(vychoziRezim('GB'), 'dovoz');
});

test('kontrola: povinné údaje, platná data, kurz u cizí měny, sazba; přepočet do Kč', () => {
  const ok = overitFakturu(ZAKLAD).hodnoty;
  assert.equal(ok.rezim_dph, 'eu_prenesena', 'režim podle země');
  assert.equal(ok.castka_czk, 25200);
  assert.equal(ok.dph_czk, 5292);
  assert.equal(ok.datum_uhrady, null, 'nevyplněná úhrada = nezaplaceno');
  assert.match(overitFakturu({ ...ZAKLAD, dodavatel: '  ' }).chyba, /dodavatele/);
  assert.match(overitFakturu({ ...ZAKLAD, cislo_faktury: '' }).chyba, /číslo faktury/);
  assert.match(overitFakturu({ ...ZAKLAD, datum_vystaveni: '2026-02-30' }).chyba, /datum vystavení/);
  assert.match(overitFakturu({ ...ZAKLAD, datum_uhrady: 'včera' }).chyba, /Datum úhrady/);
  assert.match(overitFakturu({ ...ZAKLAD, kurz: '' }).chyba, /kurz/);
  assert.match(overitFakturu({ ...ZAKLAD, castka: -5 }).chyba, /kladné/);
  assert.match(overitFakturu({ ...ZAKLAD, mena: 'BTC' }).chyba, /měna/);
  assert.match(overitFakturu({ ...ZAKLAD, sazba_dph: 15 }).chyba, /Sazba/);
  assert.match(overitFakturu({ ...ZAKLAD, rezim_dph: 'neco' }).chyba, /režim/);
  assert.match(overitFakturu({ ...ZAKLAD, zeme: 'Chorvatsko' }).chyba, /Země/);
  const czk = overitFakturu({ ...ZAKLAD, zeme: 'cz', mena: 'CZK', castka: 2420, kurz: 999, sazba_dph: 21 }).hodnoty;
  assert.deepEqual([czk.zeme, czk.kurz, czk.castka_czk, czk.zaklad_czk, czk.dph_czk], ['CZ', 1, 2420, 2000, 420], 'u Kč se kurz nepoužije');
  assert.equal(overitFakturu({ ...ZAKLAD, rezim_dph: 'bez_dph', sazba_dph: 21 }).hodnoty.sazba_dph, 0);
});

function nacistRouter(pool) {
  const routePath = require.resolve('../routes/nakupniFaktury.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  return router;
}
async function spustit(pool, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/nakupni-faktury', nacistRouter(pool));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/nakupni-faktury`;
  const volat = async (cesta, { method = 'GET', body, admin = true } = {}) => {
    const r = await fetch(base + cesta, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-heslo': process.env.ADMIN_HESLO } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn(volat); } finally { await new Promise(r => server.close(r)); }
}

test('API bez hesla: 403 a nic se nepošle do DB; neplatná data 400 bez DB', async () => {
  const dotazy = [];
  const pool = { async query(sql) { dotazy.push(sql); return { rows: [] }; } };
  await spustit(pool, async volat => {
    const pred = dotazy.length;
    for (const [cesta, method] of [['/', 'GET'], ['/', 'POST'], ['/1', 'PUT'], ['/1/uhrada', 'PATCH'], ['/1', 'DELETE']]) {
      assert.equal((await volat(cesta, { method, body: method === 'GET' || method === 'DELETE' ? undefined : ZAKLAD, admin: false })).status, 403, method + ' ' + cesta);
    }
    assert.equal((await volat('/', { method: 'POST', body: { ...ZAKLAD, dodavatel: '' } })).status, 400);
    assert.equal((await volat('/x', { method: 'DELETE' })).status, 400);
    assert.equal((await volat('/1/uhrada', { method: 'PATCH', body: { datum_uhrady: '32.1.' } })).status, 400);
    assert.equal(dotazy.length, pred, 'žádný dotaz do DB');
  });
});

test('PostgreSQL: migrace 2x, zápis, duplicita 409, úhrada, úprava, mazání, data bez posunu času', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'nftest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const { vsePripraveno } = require('../lib/startServeru');
  const log = console.log; console.log = () => {};
  try {
    nacistRouter(pool); assert.equal(await vsePripraveno(20000), true);
    nacistRouter(pool); assert.equal(await vsePripraveno(20000), true);
    await spustit(pool, async volat => {
      let r = await volat('/', { method: 'POST', body: ZAKLAD });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const id = r.body.id;
      r = await volat('/', { method: 'POST', body: { ...ZAKLAD, dodavatel: 'FRODDO D.O.O.' } });
      assert.equal(r.status, 409, 'stejné číslo od stejného dodavatele (bez ohledu na velká písmena)');
      assert.equal((await volat('/', { method: 'POST', body: { ...ZAKLAD, dodavatel: 'Beda s.r.o.', zeme: 'CZ', mena: 'CZK', castka: 12100, datum_vystaveni: '2026-09-15', datum_uhrady: '2026-09-20' } })).status, 201);
      r = await volat('/');
      assert.equal(r.body.length, 2);
      assert.deepEqual(r.body.map(f => f.datum_vystaveni), ['2026-10-01', '2026-09-15'], 'od nejnovější, datum jako text bez posunu');
      const froddo = r.body.find(f => f.id === id);
      assert.deepEqual([froddo.castka, froddo.kurz, froddo.castka_czk, froddo.dph_czk, froddo.rezim_dph, froddo.datum_uhrady], [1000, 25.2, 25200, 5292, 'eu_prenesena', null]);
      assert.equal(r.body.find(f => f.dodavatel === 'Beda s.r.o.').zaklad_czk, 10000);
      assert.equal((await volat(`/${id}/uhrada`, { method: 'PATCH', body: { datum_uhrady: '2026-10-07' } })).status, 200);
      assert.equal((await volat('/')).body.find(f => f.id === id).datum_uhrady, '2026-10-07');
      assert.equal((await volat(`/${id}/uhrada`, { method: 'PATCH', body: { datum_uhrady: null } })).status, 200, 'zrušení úhrady');
      r = await volat(`/${id}`, { method: 'PUT', body: { ...ZAKLAD, castka: 2000 } });
      assert.equal(r.status, 200);
      assert.equal((await volat('/')).body.find(f => f.id === id).castka_czk, 50400);
      assert.equal((await volat('/999999', { method: 'PUT', body: ZAKLAD })).status, 404);
      assert.equal((await volat(`/${id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await volat(`/${id}`, { method: 'DELETE' })).status, 404);
      assert.equal((await volat('/')).body.length, 1);
    });
  } finally {
    console.log = log;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
