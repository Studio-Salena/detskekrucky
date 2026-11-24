// SEO krok 2 proti SKUTEČNÉMU PostgreSQL: export katalogu (jedna transakce REPEATABLE READ
// READ ONLY), přesměrování po sloučení modelů a zámek adresy kategorie.
// Jen s TEST_PG_URL (dočasná testovací DB, nikdy produkce), každý běh ve vlastním schématu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrovatModely } = require('../lib/modely');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'test-heslo';

async function pripravit() {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'katalogtest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  await pool.query(`
    CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev VARCHAR(255) NOT NULL, znacka VARCHAR(255), emoji VARCHAR(255),
      popis TEXT, kategorie VARCHAR(50), cena INTEGER NOT NULL, cena_puvodni INTEGER, na_eshopu BOOLEAN NOT NULL DEFAULT true, typ_nohy TEXT);
    CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost INTEGER NOT NULL,
      pocet_kusu INTEGER NOT NULL DEFAULT 0, delka_mm INTEGER, sirka_mm INTEGER, dostupnost TEXT NOT NULL DEFAULT 'skladem',
      ean TEXT, min_pocet INTEGER NOT NULL DEFAULT 1, UNIQUE(produkt_id, velikost));
    CREATE TABLE product_images (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), url TEXT, alt TEXT,
      storage_key TEXT, is_primary BOOLEAN NOT NULL DEFAULT false, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE kategorie (id SERIAL PRIMARY KEY, nazev TEXT, slug TEXT, poradi INTEGER DEFAULT 0, popis TEXT, znacky TEXT,
      ikona TEXT, obrazek_url TEXT, obrazek_key TEXT);
    CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
    INSERT INTO kategorie (nazev, slug, poradi, obrazek_key) VALUES ('Celoročky', 'celorocky', 1, 'tajny/klic'), ('Papuče', 'papuce', 2, NULL);
  `);
  const vlozit = async (znacka, nazev, kategorie, cena, velikosti, { naEshopu = true, ean = null } = {}) => {
    const p = await pool.query('INSERT INTO produkty (znacka, nazev, kategorie, cena, na_eshopu) VALUES ($1,$2,$3,$4,$5) RETURNING id', [znacka, nazev, kategorie, cena, naEshopu]);
    for (const [velikost, kusy, dostupnost] of velikosti) {
      await pool.query('INSERT INTO sklad (produkt_id, velikost, pocet_kusu, dostupnost, ean) VALUES ($1,$2,$3,$4,$5)', [p.rows[0].id, velikost, kusy, dostupnost || 'skladem', ean]);
    }
    return p.rows[0].id;
  };
  return { pool, vlozit, uklid: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}

const zavolat = async (handler, req) => { const res = vytvoritRes(); res.hlavicky = {}; res.set = (k, v) => { res.hlavicky[k] = v; return res; }; await handler({ params: {}, body: {}, query: {}, ...req }, res); return res; };

test('export: modely na e-shopu, dostupnost a cena, bez skrytých produktů a interních údajů; migrace jde spustit opakovaně', { skip: preskocit }, async () => {
  const { pool, vlozit, uklid } = await pripravit();
  try {
    await vlozit('Froddo', 'Autumn', 'celorocky', 1490, [[24, 2], [25, 0], [26, 0, 'dodavatel']], { ean: '8590000000001' });
    await vlozit('Beda', 'Zuzi', 'papuce', 690, [[22, 0]]);                         // vyprodaná
    await vlozit('Jen', 'Prodejna', 'papuce', 300, [[0, 5]], { naEshopu: false });  // skrytá z e-shopu
    await migrovatModely(pool);
    await migrovatModely(pool); // idempotentní (i tabulka modely_presmerovani)
    const router = nacistRouterSMocky('../routes/katalog.js', { '../db/pool': pool });
    const res = await zavolat(najitHandler(router, 'get', '/export'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.hlavicky['Cache-Control'], 'no-store');
    const d = res.body;
    assert.deepEqual(d.kategorie.map(k => k.slug), ['celorocky', 'papuce']);
    assert.deepEqual(d.modely.map(m => [m.slug, m.dostupnost]), [['beda-zuzi', 'vyprodano'], ['froddo-autumn', 'skladem']]);
    const froddo = d.modely.find(m => m.slug === 'froddo-autumn');
    assert.deepEqual(froddo.velikosti.map(v => [v.velikost, v.stav]), [[24, 'skladem'], [25, 'vyprodano'], [26, 'dodavatel']]);
    const text = JSON.stringify(d);
    assert.doesNotMatch(text, /8590000000001|tajny\/klic|pocet_kusu|jen-prodejna/);

    const model = await zavolat(najitHandler(router, 'get', '/model/:slug'), { params: { slug: 'froddo-autumn' } });
    assert.equal(model.statusCode, 200);
    assert.equal(model.body.model.cena, 1490);
    const skryty = await zavolat(najitHandler(router, 'get', '/model/:slug'), { params: { slug: 'jen-prodejna' } });
    assert.equal(skryty.statusCode, 404);
    const zly = await zavolat(najitHandler(router, 'get', '/model/:slug'), { params: { slug: "x' OR 1=1" } });
    assert.equal(zly.statusCode, 404);
  } finally { await uklid(); }
});

test('sloučení modelů: stará adresa přesměruje na cílový model, řetěz přesměrování se přenese, export ho vrátí', { skip: preskocit }, async () => {
  const { pool, vlozit, uklid } = await pripravit();
  try {
    await vlozit('Froddo', 'Autumn', 'celorocky', 1490, [[24, 1]]);
    await vlozit('Froddo', 'Autumn Black', 'celorocky', 1490, [[25, 1]]);
    await vlozit('Froddo', 'Autumn Old', 'celorocky', 1490, [[26, 1]]);
    await migrovatModely(pool);
    const id = async slug => (await pool.query('SELECT id FROM modely WHERE slug = $1', [slug])).rows[0].id;
    const modely = nacistRouterSMocky('../routes/modely.js', { '../db/pool': pool });
    const sloucit = najitHandler(modely, 'post', '/:id/sloucit');
    // Old -> Black, pak Black -> Autumn: obě staré adresy musí vést na Autumn
    let r = await zavolat(sloucit, { params: { id: String(await id('froddo-autumn-old')) }, body: { do: await id('froddo-autumn-black') } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    r = await zavolat(sloucit, { params: { id: String(await id('froddo-autumn-black')) }, body: { do: await id('froddo-autumn') } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const katalog = nacistRouterSMocky('../routes/katalog.js', { '../db/pool': pool });
    const d = (await zavolat(najitHandler(katalog, 'get', '/export'))).body;
    assert.deepEqual(d.modely.map(m => m.slug), ['froddo-autumn']);
    assert.deepEqual(d.presmerovani, [
      { stary_slug: 'froddo-autumn-black', novy_slug: 'froddo-autumn' },
      { stary_slug: 'froddo-autumn-old', novy_slug: 'froddo-autumn' }
    ]);
  } finally { await uklid(); }
});

test('kategorie: přejmenování (i se slugem poslaným starším oknem adminu) adresu nezmění', { skip: preskocit }, async () => {
  const { pool, uklid } = await pripravit();
  try {
    const router = nacistRouterSMocky('../routes/kategorie.js', { '../db/pool': pool });
    const id = (await pool.query("SELECT id FROM kategorie WHERE slug = 'celorocky'")).rows[0].id;
    const r = await zavolat(najitHandler(router, 'patch', '/:id'), { params: { id: String(id) }, body: { nazev: 'Celoroční botičky', slug: 'celorocni-boticky', poradi: 1 } });
    assert.equal(r.statusCode, 200);
    const k = (await pool.query('SELECT nazev, slug FROM kategorie WHERE id = $1', [id])).rows[0];
    assert.deepEqual(k, { nazev: 'Celoroční botičky', slug: 'celorocky' });
    const nenalezena = await zavolat(najitHandler(router, 'patch', '/:id'), { params: { id: '99999' }, body: { nazev: 'X' } });
    assert.equal(nenalezena.statusCode, 404);
  } finally { await uklid(); }
});
