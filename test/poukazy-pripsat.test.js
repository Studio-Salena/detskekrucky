// Připsání částky zpět na dárkový poukaz (vrácené zboží placené poukazem):
// proti skutečnému PostgreSQL (jen s TEST_PG_URL) + tlačítko v adminu
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'test-heslo';

const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

test('admin: tlačítko Připsat jen u nezrušeného poukazu, ze kterého se už čerpalo', () => {
  assert.match(ADMIN, /p\.stav !== 'zruseny' && Number\(p\.zustatek\) < Number\(p\.hodnota\) \? `<button[^`]*onclick="pripsatNaPoukaz\(\$\{p\.id\}\)"/);
  assert.match(ADMIN, /API \+ '\/poukazy\/' \+ id \+ '\/pripsat'/);
});

test('API proti PostgreSQL: připsání vrátí zůstatek, oživí vyčerpaný poukaz, nepřesáhne hodnotu, admin ochrana', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'poukazytest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const routePath = require.resolve('../routes/poukazy.js');
  const poolPath = require.resolve('../db/pool');
  try {
    await pool.query('CREATE TABLE prodejna_prodeje (id SERIAL PRIMARY KEY)');
    delete require.cache[routePath];
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
    const router = require(routePath);
    await require('../lib/startServeru').vsePripraveno();
    await pool.query(`INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde)
      VALUES ('DK-AAAA-BBBB', '2100000000001', 1000, 0, '2099-12-31', 'pouzity', 'prodejna'),
             ('DK-CCCC-DDDD', '2100000000002', 500, 200, '2099-12-31', 'zruseny', 'prodejna')`);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/poukazy', router);
    const server = app.listen(0);
    const url = `http://127.0.0.1:${server.address().port}/api/poukazy`;
    const H = { 'Content-Type': 'application/json', 'x-admin-heslo': process.env.ADMIN_HESLO };
    const pripsat = (id, castka, h = H) => fetch(`${url}/${id}/pripsat`, { method: 'POST', headers: h, body: JSON.stringify({ castka }) });
    try {
      assert.equal((await pripsat(1, 100, { 'Content-Type': 'application/json' })).status, 403);
      assert.equal((await pripsat(1, 0)).status, 400);
      assert.equal((await pripsat(1, 12.5)).status, 400);
      assert.equal((await pripsat(2, 100)).status, 400, 'zrušený poukaz ne');
      assert.equal((await pripsat(99, 100)).status, 404);

      let r = await pripsat(1, 600);
      assert.equal(r.status, 200);
      const p = await r.json();
      assert.equal(Number(p.zustatek), 600);
      assert.equal(p.stav, 'aktivni', 'vyčerpaný poukaz zase platí');

      r = await pripsat(1, 401);
      assert.equal(r.status, 400);
      assert.match((await r.json()).chyba, /nejvýš 400 Kč/);

      // v historii jako záporné uplatnění (report "uplatněno" pak sedí)
      const h = await pool.query('SELECT castka FROM poukazy_pouziti WHERE poukaz_id = 1');
      assert.deepEqual(h.rows.map(x => Number(x.castka)), [-600]);
      // a poukaz jde v e-shopu ověřit
      r = await fetch(`${url}/overit/DK-AAAA-BBBB`);
      assert.equal(Number((await r.json()).zustatek), 600);
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
