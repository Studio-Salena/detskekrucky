// C1 test 10 - migrace snímků údajů objednávek proti SKUTEČNÉMU PostgreSQL
// (UPDATE ... FROM, NULL podmínky a atomicitu mock nedokáže věrně ověřit).
//
// Spouští se jen s proměnnou TEST_PG_URL (dočasná testová databáze, NIKDY
// produkce) - bez ní se přeskočí. Každý běh pracuje ve vlastním dočasném
// schématu, které na konci smaže.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrovatSnapshoty, SQL_UDAJE_OBJEDNAVKY } = require('../lib/objednavkySnapshot');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

async function pripojitSchema() {
  const { Client } = require('pg');
  const db = new Client({ connectionString: URL_DB });
  await db.connect();
  const schema = 'c1test_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  // Tvar tabulek jako na produkci PŘED zavedením snímku (bez obj_* sloupců)
  await db.query(`
    CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
    CREATE TABLE darkove_poukazy (id SERIAL PRIMARY KEY, kod TEXT);
    CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER REFERENCES zakaznici(id), cislo TEXT,
      stav TEXT DEFAULT 'nova', celkem NUMERIC, doprava TEXT, platba TEXT, poukaz_id INTEGER, vytvoreno TIMESTAMPTZ DEFAULT NOW());
  `);
  return { db, uklid: async () => { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } };
}

const SNIMEK = 'obj_jmeno, obj_email, obj_telefon, obj_ulice, obj_mesto, obj_psc, udaje_doplneny_zpetne';
async function vsechnyObjednavky(db) {
  return (await db.query(`SELECT id, ${SNIMEK} FROM objednavky ORDER BY id`)).rows;
}

test('C1 test 10: migrace doplní starým objednávkám snímek, označí je a druhé spuštění nic nezmění', { skip: preskocit }, async () => {
  const { db, uklid } = await pripojitSchema();
  try {
    await db.query(`INSERT INTO zakaznici (jmeno, email, telefon, ulice, mesto, psc) VALUES
      ('Jana A', 'jana@example.com', '111', 'Lipová 1', 'Hulín', '76824'),
      ('Eva', 'eva@example.com', '222', 'Dlouhá 2', 'Zlín', '76001')`);
    await db.query(`INSERT INTO objednavky (zakaznik_id, cislo, celkem) VALUES (1, '260801', 500), (2, '260802', 700)`);

    // 1. spuštění: sloupce vzniknou a staré objednávky dostanou snímek
    assert.deepEqual(await migrovatSnapshoty(db), [], 'žádná objednávka nezůstala bez snímku');
    let objednavky = await vsechnyObjednavky(db);
    assert.deepEqual(objednavky[0], { id: 1, obj_jmeno: 'Jana A', obj_email: 'jana@example.com', obj_telefon: '111', obj_ulice: 'Lipová 1', obj_mesto: 'Hulín', obj_psc: '76824', udaje_doplneny_zpetne: true });
    assert.equal(objednavky[1].obj_email, 'eva@example.com');
    const pocetBez = (await db.query('SELECT COUNT(*)::int AS n FROM objednavky WHERE obj_email IS NULL OR obj_jmeno IS NULL OR obj_ulice IS NULL OR obj_mesto IS NULL OR obj_psc IS NULL OR obj_telefon IS NULL')).rows[0].n;
    assert.equal(pocetBez, 0);

    // nová objednávka se snímkem (jako POST /api/objednavky) + pozdější změna zákazníka
    await db.query(`INSERT INTO objednavky (zakaznik_id, cislo, celkem, ${SNIMEK.replace(', udaje_doplneny_zpetne', '')})
      VALUES (1, '261001', 900, 'Jana B', 'jana@example.com', '333', 'Nová 5', 'Brno', '60200')`);
    await db.query(`UPDATE zakaznici SET jmeno = 'Jana C', ulice = 'Jiná 7' WHERE id = 1`);
    const pred = await vsechnyObjednavky(db);

    // 2. spuštění: nic se nezmění - doplněné ani nové snímky se nepřepíšou
    assert.deepEqual(await migrovatSnapshoty(db), []);
    assert.deepEqual(await vsechnyObjednavky(db), pred);
    const nova = pred.find(o => o.id === 3);
    assert.equal(nova.obj_jmeno, 'Jana B');
    assert.equal(nova.udaje_doplneny_zpetne, false);
    assert.equal(pred[0].obj_jmeno, 'Jana A', 'doplněný snímek se změnou zákazníka nezměnil');
  } finally {
    await uklid();
  }
});

test('C1 test 10b: objednávka bez zákazníka zůstane bez snímku a migrace ji jen nahlásí', { skip: preskocit }, async () => {
  const { db, uklid } = await pripojitSchema();
  try {
    await db.query(`INSERT INTO objednavky (zakaznik_id, cislo, celkem) VALUES (NULL, '260901', 100)`);
    const bez = await migrovatSnapshoty(db);
    assert.deepEqual(bez.map(o => o.cislo), ['260901']);
    assert.equal((await vsechnyObjednavky(db))[0].obj_email, null, 'žádné vymyšlené údaje');
  } finally {
    await uklid();
  }
});

test('C1 test 10c: selže-li doplnění, nevzniknou ani sloupce (jedna transakce)', { skip: preskocit }, async () => {
  const { db, uklid } = await pripojitSchema();
  try {
    await db.query('ALTER TABLE zakaznici DROP COLUMN psc'); // doplnění (z.psc) musí selhat
    await db.query(`INSERT INTO zakaznici (jmeno, email) VALUES ('Jana', 'jana@example.com')`);
    await db.query(`INSERT INTO objednavky (zakaznik_id, cislo, celkem) VALUES (1, '260801', 500)`);
    await assert.rejects(migrovatSnapshoty(db));
    const sloupce = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'objednavky' AND column_name LIKE 'obj_%'`)).rows;
    assert.deepEqual(sloupce, [], 'ALTER TABLE se vrátil spolu s neúspěšným UPDATE');
  } finally {
    await uklid();
  }
});

test('C1 test 10d: doplněný snímek s prázdným polem se nikdy nedoskládá z aktuálního zákazníka', { skip: preskocit }, async () => {
  const { db, uklid } = await pripojitSchema();
  try {
    // zákazník bez telefonu a ulice (např. dřívější registrace, která adresu vymazala)
    await db.query(`INSERT INTO zakaznici (jmeno, email, telefon, ulice, mesto, psc) VALUES ('Jana A', 'jana@example.com', NULL, NULL, 'Hulín', '76824')`);
    await db.query(`INSERT INTO objednavky (zakaznik_id, cislo, celkem) VALUES (1, '260801', 500)`);
    await migrovatSnapshoty(db);
    const snimek = (await vsechnyObjednavky(db))[0];
    assert.equal(snimek.obj_email, 'jana@example.com', 'snímek existuje');
    assert.equal(snimek.obj_telefon, null, 'předpoklad: pole snímku je prázdné');

    // zákazník se později změní (např. úprava adminem)
    await db.query(`UPDATE zakaznici SET jmeno = 'Jana Nová', telefon = '777000111', ulice = 'Nová 5', mesto = 'Zlín', psc = '76001' WHERE id = 1`);

    // stejný tvar dotazu jako GET /api/objednavky/:id
    const detail = (await db.query(`
      SELECT o.*, ${SQL_UDAJE_OBJEDNAVKY}, dp.kod AS poukaz_kod
      FROM objednavky o JOIN zakaznici z ON o.zakaznik_id = z.id LEFT JOIN darkove_poukazy dp ON o.poukaz_id = dp.id
      WHERE o.id = 1`)).rows[0];
    assert.deepEqual(
      { jmeno: detail.jmeno, email: detail.email, telefon: detail.telefon, ulice: detail.ulice, mesto: detail.mesto, psc: detail.psc },
      { jmeno: 'Jana A', email: 'jana@example.com', telefon: null, ulice: null, mesto: 'Hulín', psc: '76824' },
      'vše ze snímku, prázdná pole zůstala prázdná, nic z aktuálního zákazníka'
    );
  } finally {
    await uklid();
  }
});

test('C1 test 9 (PostgreSQL): čtení údajů objednávky - snímek má přednost, bez snímku fallback na zákazníka', { skip: preskocit }, async () => {
  const { db, uklid } = await pripojitSchema();
  try {
    await migrovatSnapshoty(db);
    await db.query(`INSERT INTO zakaznici (jmeno, email, telefon, ulice, mesto, psc) VALUES ('Jana A', 'jana@example.com', '111', 'Lipová 1', 'Hulín', '76824')`);
    await db.query(`INSERT INTO objednavky (zakaznik_id, cislo, celkem, obj_jmeno, obj_email, obj_telefon, obj_ulice, obj_mesto, obj_psc)
      VALUES (1, '261001', 900, 'Jana B', 'jana@example.com', '333', 'Nová 5', 'Brno', '60200')`);
    await db.query(`INSERT INTO objednavky (zakaznik_id, cislo, celkem) VALUES (1, '261002', 100)`); // bez snímku (např. starší verze kódu)
    // stejný tvar dotazu jako GET /api/objednavky/:id
    const detail = async id => (await db.query(`
      SELECT o.*, ${SQL_UDAJE_OBJEDNAVKY}, dp.kod AS poukaz_kod
      FROM objednavky o JOIN zakaznici z ON o.zakaznik_id = z.id LEFT JOIN darkove_poukazy dp ON o.poukaz_id = dp.id
      WHERE o.id = $1`, [id])).rows[0];
    const se = await detail(1);
    assert.equal(se.jmeno, 'Jana B');
    assert.equal(se.ulice, 'Nová 5');
    const bez = await detail(2);
    assert.equal(bez.jmeno, 'Jana A');
    assert.equal(bez.ulice, 'Lipová 1');
  } finally {
    await uklid();
  }
});
