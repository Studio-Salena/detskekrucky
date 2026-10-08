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
      popis TEXT, kategorie VARCHAR(50), cena INTEGER NOT NULL, cena_puvodni INTEGER, na_eshopu BOOLEAN NOT NULL DEFAULT true, typ_nohy TEXT);
    CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost INTEGER NOT NULL,
      pocet_kusu INTEGER NOT NULL DEFAULT 0, delka_mm INTEGER, sirka_mm INTEGER, dostupnost TEXT NOT NULL DEFAULT 'skladem',
      ean TEXT, min_pocet INTEGER NOT NULL DEFAULT 1, UNIQUE(produkt_id, velikost));
    CREATE TABLE product_images (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), url TEXT, alt TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false, position INTEGER NOT NULL DEFAULT 0);
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

    // Veřejné /api/sklad (krok 1): ke každé velikosti adresa modelu a vlastnosti pro filtry
    const skladPath = require.resolve('../routes/sklad.js');
    delete require.cache[skladPath];
    const sklad = require(skladPath);
    // Načtení routy spustí její startovní migraci (ALTER TABLE) - počkat, než doběhne,
    // jinak se s ní dotaz může zablokovat (deadlock), stejně jako při startu serveru
    for (let i = 0; i < 50; i++) {
      const bezi = await pool.query(`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active' AND query ILIKE '%ALTER TABLE%'`);
      if (!bezi.rows[0].n) break;
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 100));
    const l = sklad.stack.find(x => x.route && x.route.path === '/' && x.route.methods.get);
    const r6 = res();
    await l.route.stack[l.route.stack.length - 1].handle({}, r6);
    delete require.cache[skladPath];
    assert.equal(r6.statusCode, 200, JSON.stringify(r6.body));
    assert.equal(r6.body.length, 2);
    for (const radek of r6.body) {
      assert.equal(radek.model_slug, 'froddo-autumn');
      assert.equal(radek.model_id, m.id);
      assert.equal(radek.barefoot, true);
      assert.deepEqual(radek.sirka_nohy, ['siroka']);
      assert.deepEqual(radek.zapinani, ['suchy_zip', 'tkanicky']);
      assert.equal(radek.membrana, false);
      assert.equal('min_pocet' in radek || 'ean' in radek, false);
    }
  } finally {
    delete require.cache[poolPath];
    delete require.cache[routePath];
    await uklid();
  }
});

test('oblíbené modely proti PostgreSQL: e-shop bez zrušených + prodejna (JSONB), skryté a staré prodeje se nepočítají', { skip: preskocit }, async () => {
  const { pool, uklid } = await pripravitSchema();
  const routePath = require.resolve('../routes/modely.js');
  const poolPath = require.resolve('../db/pool');
  try {
    await pool.query(`
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, stav TEXT DEFAULT 'nova', vytvoreno TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER REFERENCES objednavky(id), produkt_id INTEGER, velikost INTEGER, pocet INTEGER, cena NUMERIC);
      CREATE TABLE prodejna_prodeje (id SERIAL PRIMARY KEY, datum TIMESTAMPTZ NOT NULL DEFAULT NOW(), polozky JSONB NOT NULL, celkem NUMERIC NOT NULL DEFAULT 0);
    `);
    const a = await vlozitProdukt(pool, 'Froddo', 'Autumn', 'celorocky', 24, 1);
    const a2 = await vlozitProdukt(pool, 'Froddo', 'Autumn', 'celorocky', 25, 1);
    const b = await vlozitProdukt(pool, 'Beda', 'Zuzi', 'papuce', 22, 1);
    const c = await vlozitProdukt(pool, 'Jonap', 'Skryta', 'celorocky', 26, 1);
    const d = await vlozitProdukt(pool, 'Demar', 'Holinka', 'celorocky', 27, 1);
    await pool.query('UPDATE produkty SET na_eshopu = false WHERE id = $1', [c]);
    await migrovatModely(pool);
    // E-shop: Autumn 2 ks (dvě velikosti), Zuzi 5 ks ve zrušené objednávce (nepočítá se), Demar 3 ks před rokem (nepočítá se)
    await pool.query(`INSERT INTO objednavky (stav, vytvoreno) VALUES ('dorucena', NOW()), ('zrusena', NOW()), ('dorucena', NOW() - INTERVAL '1 year')`);
    await pool.query('INSERT INTO objednavky_polozky (objednavka_id, produkt_id, velikost, pocet, cena) VALUES (1,$1,24,1,1000), (1,$2,25,1,1000), (2,$3,22,5,500), (3,$4,27,3,800)', [a, a2, b, d]);
    // Prodejna: Zuzi 3 ks, skrytá bota 9 ks (nepočítá se), nesmyslné položky se přeskočí
    await pool.query(`INSERT INTO prodejna_prodeje (polozky) VALUES ('{"stary": "zaznam"}')`); // ne pole - nesmí shodit dotaz
    await pool.query(`INSERT INTO prodejna_prodeje (polozky) VALUES ($1), ($2)`, [
      JSON.stringify([{ produkt_id: b, velikost: 22, pocet: 3 }, { produkt_id: c, velikost: 26, pocet: 9 }]),
      JSON.stringify([{ produkt_id: 'x' }, { nazev: 'bez id' }, { produkt_id: String(b), pocet: 'abc' }])
    ]);

    delete require.cache[routePath];
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
    const router = require(routePath);
    const layer = router.stack.find(l => l.route && l.route.path === '/oblibene');
    const r = { statusCode: 200, set() { return r; }, status(k) { r.statusCode = k; return r; }, json(x) { r.body = x; return r; } };
    await layer.route.stack[0].handle({}, r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    // Zuzi 3 + 1 (pocet 'abc' = 1) = 4 > Autumn 2; Demar a skrytá bota vůbec
    assert.deepEqual(r.body, ['beda-zuzi', 'froddo-autumn']);
  } finally {
    delete require.cache[poolPath];
    delete require.cache[routePath];
    await uklid();
  }
});

test('Produkty v adminu proti PostgreSQL: seznam s cenou od-do a skrytými, detail modelu s velikostmi, skladem a fotkami', { skip: preskocit }, async () => {
  const { pool, uklid } = await pripravitSchema();
  const routePath = require.resolve('../routes/modely.js');
  const poolPath = require.resolve('../db/pool');
  try {
    const p24 = await vlozitProdukt(pool, 'Froddo', 'Autumn', 'celorocky', 24, 1);
    const p25 = await vlozitProdukt(pool, 'Froddo', 'Autumn', 'celorocky', 25, 3);
    await vlozitProdukt(pool, 'Beda', 'Zuzi', 'papuce', 22, 2);
    await pool.query("UPDATE produkty SET cena = 1390, na_eshopu = false WHERE id = $1", [p25]);
    await pool.query("UPDATE sklad SET ean = '8590000000024' WHERE produkt_id = $1", [p24]);
    await pool.query("INSERT INTO product_images (produkt_id, url, alt, is_primary, position) VALUES ($1, 'https://img.example/b.jpg', 'bok', false, 1), ($1, 'https://img.example/a.jpg', 'předek', true, 0)", [p24]);
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
    const froddo = r1.body.modely.find(m => m.znacka === 'Froddo');
    assert.equal(Number(froddo.cena_od), 1000);
    assert.equal(Number(froddo.cena_do), 1390);
    assert.equal(froddo.skryto, 1);
    assert.equal(r1.body.modely.find(m => m.znacka === 'Beda').skryto, 0);
    assert.deepEqual(froddo.eany, ['8590000000024'], 'EAN kódy modelu pro hledání');
    assert.equal(froddo.foto, 'https://img.example/a.jpg', 'úvodní fotka = hlavní nahraná');
    assert.equal(r1.body.modely.find(m => m.znacka === 'Beda').foto, null, 'bez fotky null');

    const r2 = res();
    await najit('get', '/:id')({ params: { id: String(froddo.id) } }, r2);
    assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
    assert.equal('klic' in r2.body.model, false);
    assert.deepEqual(r2.body.varianty.map(v => [v.velikost, v.pocet_kusu, v.nizky_stav, v.na_eshopu]), [[24, 1, true, true], [25, 3, false, false]]);
    assert.equal(r2.body.varianty[0].ean, '8590000000024');
    assert.deepEqual(r2.body.fotky.map(f => f.url), ['https://img.example/a.jpg', 'https://img.example/b.jpg'], 'fotky podle pořadí');
    const r3 = res();
    await najit('get', '/:id')({ params: { id: '999999' } }, r3);
    assert.equal(r3.statusCode, 404);

    // Rozměry všech velikostí najednou (průvodce velikostí)
    const ulozit = najit('put', '/:id/rozmery');
    const r4 = res();
    await ulozit({ params: { id: String(froddo.id) }, body: { rozmery: [
      { produkt_id: p24, velikost: '24', delka_mm: 156, sirka_mm: 64 },
      { produkt_id: p25, velikost: 25, delka_mm: 163, sirka_mm: null }
    ] } }, r4);
    assert.equal(r4.statusCode, 200, JSON.stringify(r4.body));
    const ulozene = (await pool.query('SELECT velikost, delka_mm, sirka_mm FROM sklad WHERE produkt_id IN ($1, $2) ORDER BY velikost', [p24, p25])).rows;
    assert.deepEqual(ulozene.map(x => [x.velikost, x.delka_mm, x.sirka_mm]), [[24, 156, 64], [25, 163, null]]);
    // velikost cizího modelu: nic se neuloží (ani ta platná)
    const beda = r1.body.modely.find(m => m.znacka === 'Beda');
    const r5 = res();
    await ulozit({ params: { id: String(beda.id) }, body: { rozmery: [{ produkt_id: p24, velikost: '24', delka_mm: 200, sirka_mm: null }] } }, r5);
    assert.equal(r5.statusCode, 400);
    const r6 = res();
    await ulozit({ params: { id: String(froddo.id) }, body: { rozmery: [
      { produkt_id: p24, velikost: '24', delka_mm: 170, sirka_mm: null },
      { produkt_id: p25, velikost: '99', delka_mm: 180, sirka_mm: null }
    ] } }, r6);
    assert.equal(r6.statusCode, 400);
    assert.equal((await pool.query('SELECT delka_mm FROM sklad WHERE produkt_id = $1', [p24])).rows[0].delka_mm, 156, 'všechno, nebo nic');
    const r7 = res();
    await ulozit({ params: { id: String(froddo.id) }, body: { rozmery: [{ produkt_id: p24, velikost: '24', delka_mm: 5000 }] } }, r7);
    assert.equal(r7.statusCode, 400);
  } finally {
    delete require.cache[poolPath];
    delete require.cache[routePath];
    await uklid();
  }
});
