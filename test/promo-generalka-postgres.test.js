// Generálka vánoční slevy od stromečku (KRUCKY2026) proti SKUTEČNÉMU PostgreSQL:
// skutečné migrace, skutečný POST /api/objednavky (e-shop) a POST /api/prodejna
// (pokladna) s nasimulovaným datem - den před začátkem, první minuta akce,
// zboží ve slevě, nákup pod 500 Kč, společný strop, zrušení objednávky a konec akce.
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

test('PostgreSQL generálka KRUCKY2026: e-shop i pokladna od 30. 11. 2026, strop, zrušení, konec akce', { skip: preskocit }, async (t) => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'generalka_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const puvodniLog = console.log; console.log = () => {};
  const puvodniKlic = process.env.ZASILKOVNA_API_KLIC;
  delete process.env.ZASILKOVNA_API_KLIC;
  try {
    await pool.query(`
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
      CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, znacka TEXT, cena NUMERIC, na_eshopu BOOLEAN DEFAULT true);
      CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost TEXT, pocet_kusu INTEGER, dostupnost TEXT DEFAULT 'skladem');
      CREATE TABLE darkove_poukazy (id SERIAL PRIMARY KEY, kod TEXT, ean TEXT, zustatek NUMERIC, stav TEXT, platnost_do DATE);
      CREATE TABLE poukazy_pouziti (id SERIAL PRIMARY KEY, poukaz_id INTEGER, castka NUMERIC, objednavka_id INTEGER);
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER REFERENCES zakaznici(id), stav TEXT DEFAULT 'nova',
        celkem NUMERIC, doprava TEXT, platba TEXT, poznamka TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER REFERENCES objednavky(id), produkt_id INTEGER, velikost TEXT, pocet INTEGER, cena NUMERIC);
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, datum TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Zimní bota', 'Značka', 1200), ('Bota ve slevě', 'Značka', 800), ('Ponožky', 'Značka', 300);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 10), (2, '25', 10), (3, '26', 10);
    `);
    const emaily = { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {}, odeslat_email_storno: async () => {} };
    const objednavky = nacistRouterSMocky('../routes/objednavky.js', { '../db/pool': pool, './emaily': emaily });
    const prodejna = nacistRouterSMocky('../routes/prodejna.js', { '../db/pool': pool });
    const promoRouter = nacistRouterSMocky('../routes/promo.js', { '../db/pool': pool });
    assert.equal(await vsePripraveno(20000), true);
    await pool.query('UPDATE produkty SET cena_pred_slevou = 1000 WHERE id = 2');

    const zavolat = async (router, metoda, cesta, req) => { const res = vytvoritRes(); await najitHandler(router, metoda, cesta)({ params: {}, ip: '10.1.1.' + Math.floor(Math.random() * 250), ...req }, res); return res; };
    const objednat = (polozky, kod) => zavolat(objednavky, 'post', '/', { body: {
      jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
      doprava: 'zasilkovna', platba: 'prevod', polozky, promo_kod: kod } });
    const pocetObjednavek = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM objednavky')).rows[0].n;
    const sklad = async id => (await pool.query('SELECT pocet_kusu FROM sklad WHERE produkt_id = $1', [id])).rows[0].pocet_kusu;
    const pouzito = async () => (await pool.query("SELECT COUNT(*)::int AS n FROM promo_pouziti WHERE kod = 'KRUCKY2026' AND uvolneno IS NULL")).rows[0].n;

    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-29T22:59:00Z') }); // 29. 11. 23:59 v Praze

    // 1) den před začátkem: e-shop i pokladna odmítnou, nic nevznikne
    let res = await objednat([{ produkt_id: 1, velikost: 24, pocet: 1 }], 'KRUCKY2026');
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /platí od 30\. 11\. 2026/);
    assert.equal(await pocetObjednavek(), 0);
    assert.equal(await sklad(1), 10, 'sklad se nesnížil');
    res = await zavolat(prodejna, 'post', '/', { body: { platba: 'karta', polozky: [{ produkt_id: 1, nazev: 'Zimní bota', velikost: '24', pocet: 1, cena: 1200 }], promo_kod: 'KRUCKY2026' } });
    assert.equal(res.statusCode, 400);

    // 2) 30. 11. v 0:01: e-shop – 10 % ze zboží, kód psaný s diakritikou a mezerou
    t.mock.timers.setTime(new Date('2026-11-29T23:01:00Z').getTime());
    res = await objednat([{ produkt_id: 1, velikost: 24, pocet: 1 }], 'krůčky 2026');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const obj1 = (await pool.query('SELECT * FROM objednavky WHERE id = $1', [res.body.objednavka_id])).rows[0];
    assert.equal(obj1.promo_kod, 'KRUCKY2026');
    assert.equal(Number(obj1.promo_sleva), 120);
    assert.equal(Number(obj1.celkem), 1200 - 120 + Number(obj1.doprava_cena), 'celkem = zboží − sleva + doprava');
    assert.equal(await sklad(1), 9);

    // náhled slevy v košíku (POST /api/promo/overit) ukáže stejnou slevu
    res = await zavolat(promoRouter, 'post', '/overit', { body: { kod: 'KRUCKY2026', polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }] } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.sleva, 120);

    // 3) zboží ve slevě se nepočítá, nákup pod 500 Kč neprojde
    res = await objednat([{ produkt_id: 2, velikost: 25, pocet: 1 }], 'KRUCKY2026');
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /ve slevě/);
    res = await objednat([{ produkt_id: 3, velikost: 26, pocet: 1 }], 'KRUCKY2026');
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /od 500 Kč/);
    // kombinace: sleva jen z boty, bota ve slevě za plnou cenu
    res = await objednat([{ produkt_id: 1, velikost: 24, pocet: 1 }, { produkt_id: 2, velikost: 25, pocet: 1 }], 'KRUCKY2026');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const obj2 = (await pool.query('SELECT * FROM objednavky WHERE id = $1', [res.body.objednavka_id])).rows[0];
    assert.equal(Number(obj2.promo_sleva), 120);

    // 4) pokladna: stejný kód, sleva spočítaná serverem
    res = await zavolat(prodejna, 'post', '/', { body: { platba: 'hotovost', hotovost_prijato: 2000, polozky: [{ produkt_id: 1, nazev: 'Zimní bota', velikost: '24', pocet: 1, cena: 1200 }], promo_kod: 'krucky2026' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(Number(res.body.celkem), 1080);
    assert.equal(Number(res.body.sleva), 120);
    assert.equal(Number(res.body.hotovost_vraceno), 920);
    assert.equal(await pouzito(), 3, 'e-shop i pokladna ve společném stropu');

    // stránka stromečku: veřejné info
    const info = await require('../lib/promo').verejneInfo(pool, 'KRUCKY2026');
    assert.equal(info.od_den, '2026-11-30');
    assert.equal(info.do_den, '2026-12-31');
    assert.equal(info.max_pouziti, 50);

    // 5) zrušení objednávky vrátí místo ve stropu
    res = await zavolat(objednavky, 'patch', '/:id/stav', { params: { id: String(obj1.id) }, body: { stav: 'zrusena' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(await pouzito(), 2);

    // 6) strop: po 50 použitích další nákup neprojde
    await pool.query(`INSERT INTO promo_pouziti (kod, kanal, prodej_id, mezisoucet, sleva)
      SELECT 'KRUCKY2026', 'prodejna', 1000 + g, 1000, 100 FROM generate_series(1, 48) g`);
    assert.equal(await pouzito(), 50);
    res = await objednat([{ produkt_id: 1, velikost: 24, pocet: 1 }], 'KRUCKY2026');
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /všech 50/);
    await pool.query('DELETE FROM promo_pouziti WHERE prodej_id > 1000');

    // 7) 31. 12. ve 23:59 ještě platí, 1. 1. 2027 už ne
    t.mock.timers.setTime(new Date('2026-12-31T22:59:00Z').getTime());
    res = await objednat([{ produkt_id: 1, velikost: 24, pocet: 1 }], 'KRUCKY2026');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.mock.timers.setTime(new Date('2026-12-31T23:01:00Z').getTime());
    res = await objednat([{ produkt_id: 1, velikost: 24, pocet: 1 }], 'KRUCKY2026');
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /skončila/);
  } finally {
    t.mock.timers.reset();
    console.log = puvodniLog;
    if (puvodniKlic !== undefined) process.env.ZASILKOVNA_API_KLIC = puvodniKlic;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
