// Krok 0 - migrace modelů a SQL routes/modely.js proti SKUTEČNÉMU PostgreSQL
// (ARRAY_AGG, TEXT[], FK a ON CONFLICT mock věrně neověří).
//
// Spouští se jen s proměnnou TEST_PG_URL (dočasná testová databáze, NIKDY
// produkce) - bez ní se přeskočí. Každý běh pracuje ve vlastním dočasném
// schématu, které na konci smaže.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrovatModely } = require('../lib/modely');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'test-heslo';

async function pripravitSchema() {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'modelytest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  // Tvar tabulek jako na produkci před zavedením modelů
  await pool.query(`
    CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev VARCHAR(255) NOT NULL, znacka VARCHAR(255), emoji VARCHAR(10),
      popis TEXT, kategorie VARCHAR(50), cena INTEGER NOT NULL, cena_puvodni INTEGER, na_eshopu BOOLEAN NOT NULL DEFAULT true);
    CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost INTEGER NOT NULL,
      pocet_kusu INTEGER NOT NULL DEFAULT 0, UNIQUE(produkt_id, velikost));
    CREATE TABLE product_images (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), url TEXT);
    CREATE TABLE kategorie (id SERIAL PRIMARY KEY, nazev TEXT, slug TEXT);
    CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
    INSERT INTO kategorie (nazev, slug) VALUES ('Celoročky', 'celorocky'), ('Papuče', 'papuce'), ('Doplňky', 'doplnky');
  `);
  return {
    pool,
    uklid: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  };
}

async function vlozitProdukt(pool, znacka, nazev, kategorie, velikost, kusy) {
  const p = await pool.query('INSERT INTO produkty (znacka, nazev, kategorie, cena) VALUES ($1,$2,$3,1000) RETURNING id', [znacka, nazev, kategorie]);
  await pool.query('INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES ($1,$2,$3)', [p.rows[0].id, velikost, kusy]);
  return p.rows[0].id;
}

test('migrace: seskupí velikosti do modelů (bez ohledu na velká písmena), kategorie většinou, druhé spuštění nic nemění', { skip: preskocit }, async () => {
  const { pool, uklid } = await pripravitSchema();
  try {
    await vlozitProdukt(pool, 'Froddo', 'AUTUMN BLACK+', 'celorocky', 24, 1);
    await vlozitProdukt(pool, 'Froddo', 'AUTUMN BLACK+ ', 'celorocky', 25, 2);
    await vlozitProdukt(pool, 'Froddo', 'Autumn Black+', 'papuce', 26, 0);
    await vlozitProdukt(pool, 'BEDA', 'Zuzi', 'papuce', 22, 1);
    await vlozitProdukt(pool, 'Beda', 'Zuzi', 'papuce', 23, 1);
    await vlozitProdukt(pool, 'Froddo', 'Autumn Black Plus', 'celorocky', 27, 1); // jiný klíč, stejný slug

    assert.deepEqual(await migrovatModely(pool), { zalozenoSkupin: 3, prirazenoProduktu: 6 });
    const modely = (await pool.query('SELECT id, slug, znacka, nazev, kategorie, sirka FROM modely ORDER BY id')).rows;
    assert.deepEqual(modely.map(m => [m.slug, m.kategorie]), [
      ['froddo-autumn-black-plus', 'celorocky'],
      ['beda-zuzi', 'papuce'],
      ['froddo-autumn-black-plus-2', 'celorocky']
    ]);
    assert.deepEqual(modely[0].sirka, [], 'TEXT[] vrací pole');
    const bez = (await pool.query('SELECT COUNT(*)::int AS n FROM produkty WHERE model_id IS NULL')).rows[0].n;
    assert.equal(bez, 0);

    const pred = (await pool.query('SELECT id, model_id FROM produkty ORDER BY id')).rows;
    assert.deepEqual(await migrovatModely(pool), { zalozenoSkupin: 0, prirazenoProduktu: 0 });
    assert.deepEqual((await pool.query('SELECT id, model_id FROM produkty ORDER BY id')).rows, pred);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM modely')).rows[0].n, 3);

    // Nová velikost existujícího modelu se při dalším startu přiřadí k němu
    const nova = await vlozitProdukt(pool, 'froddo', 'autumn black+', 'celorocky', 28, 1);
    await migrovatModely(pool);
    assert.equal((await pool.query('SELECT model_id FROM produkty WHERE id = $1', [nova])).rows[0].model_id, modely[0].id);
  } finally {
    await uklid();
  }
});

test('API proti PostgreSQL: seznam modelů a úprava s propsáním do produktů', { skip: preskocit }, async () => {
  const { pool, uklid } = await pripravitSchema();
  const routePath = require.resolve('../routes/modely.js');
  const poolPath = require.resolve('../db/pool');
  try {
    await vlozitProdukt(pool, 'Froddo', 'Autumn', 'celorocky', 24, 1);
    await vlozitProdukt(pool, 'Froddo', 'Autumn', 'papuce', 25, 2);
    await migrovatModely(pool);

    delete require.cache[routePath];
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
    const router = require(routePath);
    const najit = (method, cesta) => {
      const l = router.stack.find(x => x.route && x.route.path === cesta && x.route.methods[method]);
      return l.route.stack[l.route.stack.length - 1].handle;
    };
    const res = () => { const r = { statusCode: 200 }; r.status = k => { r.statusCode = k; return r; }; r.json = b => { r.body = b; return r; }; return r; };

    const r1 = res();
    await najit('get', '/')({}, r1);
    assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
    const m = r1.body.modely[0];
    assert.deepEqual(m.velikosti, [24, 25]);
    assert.equal(m.kusu, 3);
    assert.equal(m.pocet_produktu, 2);
    assert.equal(m.kategorie_ke_kontrole, true);
    assert.equal(m.ma_fotku, false);

    const r2 = res();
    await najit('patch', '/:id')({ params: { id: String(m.id) }, body: { kategorie: 'celorocky', znacka: 'FRODDO', barefoot: true, sirka: ['siroka'], zapinani: ['suchy_zip', 'tkanicky'], membrana: false, material: 'kuze' } }, r2);
    assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.vyplneno, true);
    assert.deepEqual(r2.body.zapinani, ['suchy_zip', 'tkanicky']);
    const produkty = (await pool.query('SELECT znacka, kategorie FROM produkty ORDER BY id')).rows;
    assert.deepEqual(produkty, [{ znacka: 'FRODDO', kategorie: 'celorocky' }, { znacka: 'FRODDO', kategorie: 'celorocky' }]);

    const r3 = res();
    await najit('get', '/')({}, r3);
    assert.equal(r3.body.modely[0].kategorie_ke_kontrole, false);

    // Hromadná změna (= ANY(int[])) včetně propsání kategorie do velikostí
    const r4 = res();
    await najit('post', '/hromadne')({ body: { ids: [m.id], zmeny: { kategorie: 'papuce' } } }, r4);
    assert.equal(r4.statusCode, 200, JSON.stringify(r4.body));
    assert.deepEqual((await pool.query('SELECT DISTINCT kategorie FROM produkty')).rows, [{ kategorie: 'papuce' }]);
    const r5 = res();
    await najit('post', '/hromadne')({ body: { ids: [m.id, 999999], zmeny: { barefoot: false } } }, r5);
    assert.equal(r5.statusCode, 404);
    assert.equal((await pool.query('SELECT barefoot FROM modely WHERE id = $1', [m.id])).rows[0].barefoot, true, 'transakce vrácena');
  } finally {
    delete require.cache[poolPath];
    delete require.cache[routePath];
    await uklid();
  }
});
