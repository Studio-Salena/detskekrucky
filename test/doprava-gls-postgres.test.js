// Doprava a GLS (2026-10) proti SKUTEČNÉMU PostgreSQL: migrace sloupců
// objednávek a tabulky zasilky (i opakovaně), uložení nastavení dopravy,
// skutečný POST /api/objednavky s ověřeným výdejním místem a převod na zásilku.
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce),
// jinak se přeskočí. Každý běh má vlastní dočasné schéma, které na konci smaže.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');
const gls = require('../lib/gls');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

const MISTO = { id: '39301-ELPESRO', nazev: 'Elpe s.r.o.', ulice: 'Myslotínská 2449', mesto: 'Pelhřimov', psc: '39301', stat: 'CZ', box: false, dobirka: true };

function nacistObjednavky(pool) {
  return nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {} },
    '../lib/glsVydejniMista': { overitVydejniMisto: async id => (id === MISTO.id ? { ...MISTO } : null) }
  });
}

test('PostgreSQL: migrace, nastavení dopravy, objednávka GLS do výdejního místa a převod na zásilku', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'glstest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const puvodniLog = console.log; console.log = () => {};
  try {
    // Tvar tabulek jako na produkci PŘED touto změnou
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
      INSERT INTO zakaznici (jmeno, email, telefon, ulice, mesto, psc) VALUES ('Stará Objednávka', 'stara@example.com', '111', 'A 1', 'Hulín', '76824');
      INSERT INTO objednavky (zakaznik_id, celkem, doprava, platba) VALUES (1, 579, 'zasilkovna', 'prevod');
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Bota', 'Značka', 500);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 3);
    `);

    // Migrace 2x (idempotence) - stejně jako při dvou restartech serveru
    nacistObjednavky(pool);
    assert.equal(await vsePripraveno(20000), true);
    const router = nacistObjednavky(pool);
    assert.equal(await vsePripraveno(20000), true);

    const sloupce = (await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objednavky' AND (column_name LIKE 'vydejni_misto%' OR column_name IN ('doprava_cena', 'dopravce'))`, [schema])).rows;
    assert.deepEqual(Object.fromEntries(sloupce.map(s => [s.column_name, s.data_type])), {
      doprava_cena: 'numeric', dopravce: 'text', vydejni_misto_id: 'text', vydejni_misto_nazev: 'text', vydejni_misto_ulice: 'text',
      vydejni_misto_mesto: 'text', vydejni_misto_psc: 'text', vydejni_misto_stat: 'text'
    });
    const stara = (await pool.query('SELECT doprava, doprava_cena, dopravce, vydejni_misto_id FROM objednavky WHERE id = 1')).rows[0];
    assert.deepEqual(stara, { doprava: 'zasilkovna', doprava_cena: null, dopravce: null, vydejni_misto_id: null }, 'stará objednávka beze změny');

    // Nastavení dopravy přes skutečný PUT /api/doprava: GLS výdejní místo za 69 Kč
    const dopravaRouter = nacistRouterSMocky('../routes/doprava.js', { '../db/pool': pool });
    const { VYCHOZI_NASTAVENI } = require('../lib/doprava');
    let res = vytvoritRes();
    await najitHandler(dopravaRouter, 'put', '/')({ body: { zdarmaOd: 2000, metody: { ...VYCHOZI_NASTAVENI.metody, gls_vydejni_misto: { aktivni: true, cena: 69 } }, priplatky: { dobirka: null } } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    res = vytvoritRes();
    await najitHandler(dopravaRouter, 'get', '/')({}, res);
    assert.ok(res.body.metody.some(m => m.kod === 'gls_vydejni_misto' && m.cena === 69));

    // Skutečný POST /api/objednavky
    const post = najitHandler(router, 'post', '/');
    res = vytvoritRes();
    await post({ ip: '10.9.9.9', body: { jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
      doprava: 'gls_vydejni_misto', platba: 'prevod', poznamka: '', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }],
      vydejni_misto_id: MISTO.id, vydejni_misto_nazev: 'PODVRH' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.celkem, 569);
    const nova = (await pool.query('SELECT * FROM objednavky WHERE id = $1', [res.body.objednavka_id])).rows[0];
    assert.equal(Number(nova.doprava_cena), 69);
    assert.equal(nova.dopravce, 'gls');
    assert.equal(nova.vydejni_misto_id, '39301-ELPESRO');
    assert.equal(nova.vydejni_misto_nazev, 'Elpe s.r.o.');
    assert.equal(nova.vydejni_misto_psc, '39301');
    assert.equal(nova.obj_jmeno, 'Jana Nováková');

    // Bez výdejního místa: odmítnuto, nic nového v DB
    res = vytvoritRes();
    await post({ ip: '10.9.9.8', body: { jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
      doprava: 'gls_vydejni_misto', platba: 'prevod', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }] } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM objednavky')).rows[0].n, 2);

    // Detail pro admin (GET /:id, o.*) obsahuje nové sloupce
    res = vytvoritRes();
    await najitHandler(router, 'get', '/:id')({ params: { id: String(nova.id) } }, res);
    assert.equal(res.body.vydejni_misto_nazev, 'Elpe s.r.o.');
    res = vytvoritRes();
    await najitHandler(router, 'get', '/')({}, res);
    assert.equal(res.body.find(o => o.id === nova.id).vydejni_misto_nazev, 'Elpe s.r.o.');

    // Převod objednávky na zásilku a uložení do tabulky zasilky (bez volání API)
    const data = gls.sestavitZasilku(nova);
    assert.deepEqual(data.sluzby, [{ kod: 'PSD', vydejniMistoId: '39301-ELPESRO' }]);
    await pool.query('INSERT INTO zasilky (objednavka_id, dopravce, data) VALUES ($1, $2, $3)', [nova.id, 'gls', JSON.stringify(data)]);
    const zasilka = (await pool.query('SELECT stav, cislo_zasilky, data FROM zasilky WHERE objednavka_id = $1', [nova.id])).rows[0];
    assert.equal(zasilka.stav, 'pripravena');
    assert.equal(zasilka.cislo_zasilky, null);
    assert.equal(zasilka.data.reference, nova.cislo);
    // smazání objednávky smaže i její zásilky
    await pool.query('DELETE FROM objednavky_polozky WHERE objednavka_id = $1', [nova.id]);
    await pool.query('DELETE FROM objednavky WHERE id = $1', [nova.id]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM zasilky')).rows[0].n, 0);
  } finally {
    console.log = puvodniLog;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('PostgreSQL: když tabulka zasilky nejde vytvořit, sloupce objednávek přesto vzniknou', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'glstest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const logy = [];
  const puvodniLog = console.log; console.log = (...a) => logy.push(a.join(' '));
  try {
    // objednavky.id bez PRIMARY KEY -> cizí klíč ze zasilky nejde vytvořit
    await pool.query(`
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
      CREATE TABLE darkove_poukazy (id SERIAL PRIMARY KEY, kod TEXT);
      CREATE TABLE objednavky (id INTEGER, zakaznik_id INTEGER, celkem NUMERIC, doprava TEXT, platba TEXT, cislo TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
    `);
    nacistObjednavky(pool);
    assert.equal(await vsePripraveno(20000), true);
    const sloupce = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objednavky' AND column_name IN ('doprava_cena', 'dopravce', 'vydejni_misto_id')`, [schema])).rows;
    assert.equal(sloupce.length, 3);
    assert.ok(logy.some(l => l.startsWith('Zasilky chyba:')), 'chyba zásilek je zalogovaná');
    assert.ok(logy.includes('Objednavky sloupce OK'));
  } finally {
    console.log = puvodniLog;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
