// scripts/overeni-migrace.js proti SKUTEČNÉMU PostgreSQL (samostatný proces, vlastní schéma):
// chybějící povinná tabulka / chyba migrace = OVĚŘENÍ SELHALO a nenulový kód; úplná kopie
// = OVĚŘENÍ PROŠLO, obsah dosavadních sloupců beze změny, žádné platby se nedoplní.
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
const SKRIPT = path.join(__dirname, '..', 'scripts', 'overeni-migrace.js');

function urlSeSchematem(schema) {
  const u = new URL(URL_DB);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}
function spustit(schema) {
  const zprava = path.join(os.tmpdir(), `zprava-overeni-${schema}.json`);
  const env = { ...process.env }; delete env.DATABASE_URL;
  const r = spawnSync(process.execPath, [SKRIPT, urlSeSchematem(schema), zprava], { encoding: 'utf8', env, timeout: 180000 });
  const json = fs.existsSync(zprava) ? JSON.parse(fs.readFileSync(zprava, 'utf8')) : null;
  if (fs.existsSync(zprava)) fs.unlinkSync(zprava);
  return { kod: r.status, vystup: (r.stdout || '') + (r.stderr || ''), zprava: json };
}

test('ověřovací skript: neúplná kopie selže, úplná projde', { skip: preskocit }, async () => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const neuplne = 'overeni_neupl_' + Date.now();
  const uplne = 'overeni_upl_' + Date.now();
  try {
    // 1) neúplná kopie: jen část povinných tabulek
    await admin.query(`CREATE SCHEMA ${neuplne}; SET search_path = ${neuplne};
      CREATE TABLE prodejna_prodeje (id SERIAL PRIMARY KEY, celkem NUMERIC);`);
    let r = spustit(neuplne);
    assert.notEqual(r.kod, 0, r.vystup);
    assert.match(r.vystup.split('\n')[0], /^OVĚŘENÍ SELHALO/, 'verdikt je první řádek');
    assert.match(r.vystup, /chybí povinná tabulka: vratky/);
    assert.doesNotMatch(r.vystup, /OVĚŘENÍ PROŠLO/);
    assert.equal(r.zprava.vysledek, 'SELHALO');

    // 2) „úplná“ kopie (schéma jako produkce před krokem 2, s daty)
    await admin.query(`CREATE SCHEMA ${uplne}; SET search_path = ${uplne};
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT, heslo TEXT);
      CREATE TABLE kategorie (id SERIAL PRIMARY KEY, nazev TEXT);
      CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, znacka TEXT, emoji TEXT, kategorie TEXT, cena NUMERIC, cena_puvodni NUMERIC, typ_nohy TEXT, popis TEXT, na_eshopu BOOLEAN DEFAULT true);
      CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost TEXT, ean TEXT, pocet_kusu INTEGER, min_pocet INTEGER DEFAULT 0, delka_mm INTEGER, sirka_mm INTEGER, dostupnost TEXT DEFAULT 'skladem', UNIQUE (produkt_id, velikost));
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER REFERENCES zakaznici(id), stav TEXT DEFAULT 'nova', celkem NUMERIC, doprava TEXT, platba TEXT, poznamka TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER REFERENCES objednavky(id), produkt_id INTEGER, velikost TEXT, pocet INTEGER, cena NUMERIC);
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, datum TIMESTAMPTZ DEFAULT NOW(), vytvoreno TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
      INSERT INTO produkty (nazev, cena) VALUES ('Bota', 1000);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 5);`);
    // první běh (bez dat v dokladech): migrace založí tabulky dokladů jako starší verze aplikace
    r = spustit(uplne);
    await admin.query(`SET search_path = ${uplne};
      INSERT INTO prodejna_prodeje (platba, polozky, celkem) VALUES ('hotovost', '[]', 1000), ('poukaz', '[]', 500);
      INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, druh, platba_stav) VALUES ('DK-OV-1', '2100000000990', 500, 300, '2099-12-31', 'aktivni', 'eshop', 'prodej', NULL);
      INSERT INTO objednavky (stav, celkem, doprava, platba) VALUES ('zaplacena', 700, 'osobni_odber', 'na_prodejne');`);
    // 2a) migrace by změnila hodnotu v UŽ EXISTUJÍCÍM sloupci (platba_stav NULL → historicky) = rozdíl v datech → selhání
    r = spustit(uplne);
    assert.notEqual(r.kod, 0, r.vystup);
    assert.match(r.vystup.split('\n')[0], /^OVĚŘENÍ SELHALO/);
    assert.match(r.vystup, /rozdíl v datech: darkove_poukazy: změnil se obsah dosavadních sloupců/);
    // 2b) stav jako produkce PŘED krokem 2: sloupec platba_stav ještě neexistuje
    await admin.query(`ALTER TABLE ${uplne}.darkove_poukazy DROP COLUMN platba_stav`);
    r = spustit(uplne);
    assert.equal(r.kod, 0, r.vystup);
    assert.match(r.vystup.split('\n')[0], /^OVĚŘENÍ PROŠLO/);
    assert.equal(r.zprava.vysledek, 'OK');
    assert.equal(r.zprava.soucty_shodne, true);
    assert.equal(r.zprava.nove_tabulky_radky.platby, 0, 'historie se nedoplňuje');
    assert.equal(r.zprava.nove_tabulky_radky.kredit_vklady, 0);
    assert.deepEqual(r.zprava.kontrola_evidence.v_rozsahu, { prodeje: 0, vratky: 0, poukazy: 0, objednavky: 0 });
    assert.ok(r.zprava.kontrola_evidence.mimo_rozsah.prodeje >= 2, 'starší doklady mimo rozsah, ne spárované');
    assert.deepEqual(r.zprava.odeslane_emaily, []);
    // EET: tabulky a ochrana založené, nic nezapnuto, nic zpětně evidováno, žádná síť
    assert.deepEqual(r.zprava.eet_po_migraci, { eet_udalosti: 0, eet_udalosti_radky: 0, eet_pokusy: 0, eet_provoz: 0 });
    assert.deepEqual([...r.zprava.eet_triggery].sort(), ['eet_pokusy_jednou', 'eet_provoz_nemenny', 'eet_udalosti_nemenna', 'eet_udalosti_vznik']);
    assert.deepEqual(r.zprava.pokusy_o_sit, []);
    // historický poukaz označený, ne zablokovaný
    const p = (await admin.query(`SELECT stav, platba_stav FROM ${uplne}.darkove_poukazy WHERE kod = 'DK-OV-1'`)).rows[0];
    assert.deepEqual(p, { stav: 'aktivni', platba_stav: 'historicky' });

    // 3) skript odmítne nelokální cíl a databázi bez „kopie/test/sim“ v názvu
    const ciz = spawnSync(process.execPath, [SKRIPT, 'postgres://u@db.example.com/dk_kopie'], { encoding: 'utf8' });
    assert.notEqual(ciz.status, 0); assert.match(ciz.stderr, /není lokální/);
    const nazev = spawnSync(process.execPath, [SKRIPT, 'postgres://u@localhost/detskekrucky'], { encoding: 'utf8' });
    assert.notEqual(nazev.status, 0); assert.match(nazev.stderr, /nevypadá jako kopie/);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${neuplne} CASCADE; DROP SCHEMA IF EXISTS ${uplne} CASCADE`);
    await admin.end();
  }
});
