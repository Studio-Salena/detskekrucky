// Jednotná evidence plateb (lib/evidencePlateb.js) proti SKUTEČNÉMU PostgreSQL:
// migrace 2×, souběžné a opakované požadavky, rollback, neměnnost záznamů,
// osobní odběr, poukazy (zaplacené i darované), dobírka, opravy navázanými
// záznamy, kontrola dokladů proti evidenci a nezměněné účetní součty.
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

test('PostgreSQL evidence plateb: pokladna, poukazy, osobní odběr, dobírka, opravy, kontrola, součty', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'evidence_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 15 });
  const puvodniLog = console.log; console.log = () => {};
  const puvodniKlic = process.env.ZASILKOVNA_API_KLIC;
  delete process.env.ZASILKOVNA_API_KLIC;
  try {
    await pool.query(`
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
      CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, znacka TEXT, cena NUMERIC, na_eshopu BOOLEAN DEFAULT true, cena_pred_slevou INTEGER);
      CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost TEXT, pocet_kusu INTEGER, dostupnost TEXT DEFAULT 'skladem', UNIQUE (produkt_id, velikost));
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER REFERENCES zakaznici(id), stav TEXT DEFAULT 'nova',
        celkem NUMERIC, doprava TEXT, platba TEXT, poznamka TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER REFERENCES objednavky(id), produkt_id INTEGER, velikost TEXT, pocet INTEGER, cena NUMERIC);
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, datum TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Zimní bota', 'Značka', 1200), ('Sandál', 'Značka', 800);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 20), (2, '25', 20);
    `);
    const emaily = new Proxy({}, { get: () => async () => {} });
    const mocky = { '../db/pool': pool, './emaily': emaily };
    // migrace postupně (na prázdné DB závisí na sobě), evidence dvakrát
    const prodejna = nacistRouterSMocky('../routes/prodejna.js', mocky); assert.equal(await vsePripraveno(20000), true);
    const poukazy = nacistRouterSMocky('../routes/poukazy.js', mocky); assert.equal(await vsePripraveno(20000), true);
    const objednavky = nacistRouterSMocky('../routes/objednavky.js', mocky); assert.equal(await vsePripraveno(20000), true);
    nacistRouterSMocky('../routes/promo.js', mocky); assert.equal(await vsePripraveno(20000), true);
    nacistRouterSMocky('../routes/evidencePlateb.js', mocky); assert.equal(await vsePripraveno(20000), true);
    const evidenceRouter = nacistRouterSMocky('../routes/evidencePlateb.js', mocky); assert.equal(await vsePripraveno(20000), true);
    await require('../lib/evidencePlateb').migrovat(pool);
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = current_schema()::regnamespace AND t.tgname IN ('platby_nemenna', 'platby_prirazeni_nemenna', 'kredit_pohyby_nemenna', 'dobirky_vyuctovani_nemenna', 'dobirky_nemenna')`)).rows[0].n, 5, 'triggery neměnnosti');

    const zavolat = async (router, metoda, cesta, req = {}) => {
      const res = vytvoritRes();
      await najitHandler(router, metoda, cesta)({ params: {}, query: {}, ip: '10.2.2.' + Math.floor(Math.random() * 250), ...req }, res);
      return res;
    };
    const q = async (sql, p) => (await pool.query(sql, p)).rows;
    const n = async (tab, kde = 'TRUE', p = []) => (await q(`SELECT COUNT(*)::int n FROM ${tab} WHERE ${kde}`, p))[0].n;
    const kusu = async id => (await q('SELECT pocet_kusu FROM sklad WHERE produkt_id = $1', [id]))[0].pocet_kusu;
    // Účetní součty stejně jako admin (Účetnictví: e-shop bez zrušených + prodejna − vratky)
    const soucty = async () => (await q(`SELECT
      (SELECT COALESCE(SUM(celkem),0) FROM objednavky WHERE stav <> 'zrusena')::numeric AS eshop,
      (SELECT COALESCE(SUM(celkem),0) FROM prodejna_prodeje)::numeric AS prodejna,
      (SELECT COALESCE(SUM(castka),0) FROM vratky)::numeric AS vratky,
      (SELECT COALESCE(SUM(castka),0) FROM poukazy_pouziti)::numeric AS uplatneno`))[0];
    const bota = (k = 1) => [{ produkt_id: 1, nazev: 'Zimní bota', velikost: '24', pocet: k, cena: 1200 }];

    // ── 1) pokladna: 5× stejný klíč souběžně = jedna platba ──
    let res = (await Promise.all([1, 2, 3, 4, 5].map(() => zavolat(prodejna, 'post', '/', { body: { klic: 'ev-prodej-1', platba: 'hotovost', polozky: bota() } }))));
    assert.ok(res.every(r => r.statusCode === 200), JSON.stringify(res.map(r => r.body)));
    const prodej1 = res[0].body;
    assert.deepEqual(await q("SELECT typ, castka::int, zpusob, okolnosti, kontaktni, zdroj_typ FROM platby WHERE zdroj_id = $1 AND zdroj_typ = 'prodej'", [prodej1.id]),
      [{ typ: 'prijem', castka: 1200, zpusob: 'hotovost', okolnosti: 'prodejna', kontaktni: true, zdroj_typ: 'prodej' }]);

    // ── 2) rollback: chyba při zápisu platby vrátí prodej, sklad i poukaz ──
    await pool.query(`CREATE FUNCTION selhat_platba() RETURNS trigger AS $$ BEGIN IF NEW.castka = 777 THEN RAISE EXCEPTION 'simulovaný výpadek'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER selhat_platba BEFORE INSERT ON platby FOR EACH ROW EXECUTE FUNCTION selhat_platba();`);
    const pred = { prodeje: await n('prodejna_prodeje'), sklad: await kusu(1), platby: await n('platby') };
    res = await zavolat(prodejna, 'post', '/', { body: { klic: 'ev-rollback-1', platba: 'karta', polozky: [{ produkt_id: 1, nazev: 'Bota', velikost: '24', pocet: 1, cena: 777 }] } });
    assert.equal(res.statusCode, 500);
    assert.deepEqual({ prodeje: await n('prodejna_prodeje'), sklad: await kusu(1), platby: await n('platby') }, pred, 'nic se neuložilo');
    await pool.query('DROP TRIGGER selhat_platba ON platby');

    // ── 3) neměnnost ──
    await assert.rejects(pool.query('UPDATE platby SET castka = 1 WHERE id = (SELECT MIN(id) FROM platby)'), /neměnný/);
    await assert.rejects(pool.query('DELETE FROM platby'), /neměnný/);

    // ── 4) poukazy: prodej (3× stejný klíč), dar, čerpání daru, připsání, dodatečný dar ──
    res = await Promise.all([1, 2, 3].map(() => zavolat(poukazy, 'post', '/', { body: { klic: 'ev-poukaz-1', hodnota: 1000, platba: 'karta', zakoupeno_kde: 'prodejna' } })));
    assert.ok(res.every(r => r.statusCode === 200), JSON.stringify(res.map(r => r.body)));
    const zaplaceny = res[0].body;
    assert.equal(await n('darkove_poukazy'), 1, 'jeden poukaz');
    assert.deepEqual(await q("SELECT typ, castka::int, urceno_k_cerpani::int, zdroj_typ FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1", [zaplaceny.prodej.id]),
      [{ typ: 'prijem', castka: 1000, urceno_k_cerpani: 1000, zdroj_typ: 'prodej' }]);
    assert.deepEqual(await q('SELECT typ, puvod, eet_pravidlo FROM kredit_pohyby WHERE poukaz_id = $1', [zaplaceny.id]), [{ typ: 'nabiti', puvod: 'zaplaceny', eet_pravidlo: 'urceno_cerp_zuct' }]);

    res = await zavolat(poukazy, 'post', '/', { body: { klic: 'ev-dar-1', hodnota: 500, druh: 'dar', zakoupeno_kde: 'prodejna' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const dar = res.body;
    assert.deepEqual(await q('SELECT typ, puvod, eet_pravidlo, platba_id FROM kredit_pohyby WHERE poukaz_id = $1', [dar.id]), [{ typ: 'nabiti', puvod: 'darovany', eet_pravidlo: 'neeviduje', platba_id: null }]);
    assert.equal(await n('platby', "zdroj_typ = 'prodej' AND zdroj_id IS NULL"), 0, 'dar žádnou platbu nemá');
    // čerpání daru v pokladně: kredit 'darovany', pravidlo EET výslovně nevyřešené; doplatek je skutečná platba
    res = await zavolat(prodejna, 'post', '/', { body: { klic: 'ev-cerpani-daru', platba: 'poukaz', poukaz_kod: dar.kod, doplatek_platba: 'karta', polozky: [{ produkt_id: 2, nazev: 'Sandál', velikost: '25', pocet: 1, cena: 800 }] } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(await q("SELECT typ, castka::int, puvod, kontaktni, eet_pravidlo FROM kredit_pohyby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1", [res.body.id]),
      [{ typ: 'cerpani', castka: 500, puvod: 'darovany', kontaktni: true, eet_pravidlo: 'nevyreseno' }]);
    assert.deepEqual(await q("SELECT typ, castka::int FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1", [res.body.id]), [{ typ: 'prijem', castka: 300 }]);
    // připsání zpět na poukaz (vrácení zboží), 2× stejný klíč = jednou
    const pripsatDvakrat = await Promise.all([1, 2].map(() => zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(dar.id) }, body: { klic: 'ev-pripsat-1', castka: 200 } })));
    assert.ok(pripsatDvakrat.every(r => r.statusCode === 200), JSON.stringify(pripsatDvakrat.map(r => r.body)));
    assert.equal(Number((await q('SELECT zustatek FROM darkove_poukazy WHERE id = $1', [dar.id]))[0].zustatek), 200);
    assert.deepEqual(await q("SELECT puvod, eet_pravidlo FROM kredit_pohyby WHERE poukaz_id = $1 AND typ = 'pripsani'", [dar.id]), [{ puvod: 'vraceny', eet_pravidlo: 'nevyreseno' }]);
    // dodatečně dar: původní příjem i zaplacený kredit dostanou storno, zůstanou v evidenci
    res = await zavolat(poukazy, 'patch', '/:id/dar', { params: { id: String(zaplaceny.id) } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual((await q("SELECT typ FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1 ORDER BY id", [zaplaceny.prodej.id])).map(r => r.typ), ['prijem', 'storno_prijmu']);
    assert.deepEqual((await q('SELECT typ, puvod FROM kredit_pohyby WHERE poukaz_id = $1 ORDER BY id', [zaplaceny.id])).map(r => r.typ + ':' + r.puvod),
      ['nabiti:zaplaceny', 'storno_nabiti:zaplaceny', 'nabiti:darovany']);
    assert.equal(await n('prodejna_prodeje', 'id = $1', [zaplaceny.prodej.id]), 0, 'doklad prodeje smazán jako dřív (součty)');

    // ── 5) osobní odběr: objednávka s poukazem online, platba při vyzvednutí ──
    res = await zavolat(poukazy, 'post', '/', { body: { klic: 'ev-poukaz-eshop', hodnota: 500, platba: 'karta', zakoupeno_kde: 'prodejna' } });
    const poukazEshop = res.body;
    const skladPred = await kusu(1);
    const prodejuPred = await n('prodejna_prodeje');
    res = await zavolat(objednavky, 'post', '/', { body: { jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
      doprava: 'osobni_odber', platba: 'na_prodejne', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }], poukaz_kod: poukazEshop.kod } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const objId = res.body.objednavka_id;
    const obj = (await q('SELECT * FROM objednavky WHERE id = $1', [objId]))[0];
    assert.equal(Number(obj.celkem), 700);
    assert.equal(await kusu(1), skladPred - 1);
    assert.deepEqual(await q("SELECT typ, castka::int, kontaktni, eet_pravidlo FROM kredit_pohyby WHERE zdroj_typ = 'objednavka' AND zdroj_id = $1", [objId]),
      [{ typ: 'cerpani', castka: 500, kontaktni: false, eet_pravidlo: 'neeviduje' }], 'poukaz čerpaný online');
    // bez platby nejde označit jako zaplacenou ani vyzvednutou
    for (const stav of ['zaplacena', 'dorucena']) {
      res = await zavolat(objednavky, 'patch', '/:id/stav', { params: { id: String(objId) }, body: { stav } });
      assert.equal(res.statusCode, 409, stav);
      assert.equal(res.body.chybi_platba, true);
    }
    const soucetPredPlatbou = await soucty();
    // přijetí platby: 5× stejný klíč souběžně = jedna platba, žádný prodej, sklad beze změny
    res = await Promise.all([1, 2, 3, 4, 5].map(() => zavolat(objednavky, 'post', '/:id/platby', { params: { id: String(objId) }, body: { klic: 'ev-odber-1', zpusob: 'hotovost', castka: 700, hotovost_prijato: 1000 } })));
    assert.ok(res.every(r => r.statusCode === 200), JSON.stringify(res.map(r => r.body)));
    assert.deepEqual(await q("SELECT typ, castka::int, zpusob, okolnosti, kontaktni FROM platby WHERE zdroj_typ = 'objednavka' AND zdroj_id = $1", [objId]),
      [{ typ: 'prijem', castka: 700, zpusob: 'hotovost', okolnosti: 'osobni_odber', kontaktni: true }]);
    assert.equal((await q('SELECT stav FROM objednavky WHERE id = $1', [objId]))[0].stav, 'zaplacena');
    assert.equal(await n('prodejna_prodeje'), prodejuPred + 0, 'nevznikl prodej v pokladně');
    assert.equal(await kusu(1), skladPred - 1, 'sklad se neodečetl podruhé');
    assert.deepEqual(await soucty(), soucetPredPlatbou, 'účetní součty se zápisem platby nezměnily');
    res = await zavolat(objednavky, 'post', '/:id/platby', { params: { id: String(objId) }, body: { klic: 'ev-odber-2', zpusob: 'karta', castka: 1 } });
    assert.equal(res.statusCode, 409, 'přeplatek / už zaplaceno');
    assert.equal((await zavolat(objednavky, 'patch', '/:id/stav', { params: { id: String(objId) }, body: { stav: 'dorucena' } })).statusCode, 200);

    // zrušení zaplacené objednávky: nejdřív vrácení peněz, pak zrušení; čerpání poukazu storno navázaným řádkem
    res = await zavolat(objednavky, 'post', '/', { body: { jmeno: 'Petr Novák', email: 'petr@example.com', telefon: '777 000 111', ulice: 'Hlavní 2', mesto: 'Hulín', psc: '768 24',
      doprava: 'osobni_odber', platba: 'na_prodejne', polozky: [{ produkt_id: 2, velikost: 25, pocet: 1 }] } });
    const obj2 = res.body.objednavka_id;
    await zavolat(objednavky, 'post', '/:id/platby', { params: { id: String(obj2) }, body: { klic: 'ev-odber-3', zpusob: 'karta' } });
    res = await zavolat(objednavky, 'patch', '/:id/stav', { params: { id: String(obj2) }, body: { stav: 'zrusena' } });
    assert.equal(res.statusCode, 409);
    assert.match(res.body.chyba, /vrácení peněz/);
    res = await zavolat(objednavky, 'post', '/:id/platby/vraceni', { params: { id: String(obj2) }, body: { klic: 'ev-vraceni-1', zpusob: 'karta', castka: 800 } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.prijato, 0);
    assert.equal((await zavolat(objednavky, 'patch', '/:id/stav', { params: { id: String(obj2) }, body: { stav: 'zrusena' } })).statusCode, 200);

    // přiřazení existující (volné) platby: převod přišel dřív, pak se spáruje s objednávkou
    res = await zavolat(objednavky, 'post', '/', { body: { jmeno: 'Eva Malá', email: 'eva@example.com', telefon: '777 000 222', ulice: 'Hlavní 3', mesto: 'Hulín', psc: '768 24',
      doprava: 'osobni_odber', platba: 'na_prodejne', polozky: [{ produkt_id: 2, velikost: 25, pocet: 1 }] } });
    const obj3 = res.body.objednavka_id;
    const volna = (await zavolat(evidenceRouter, 'post', '/volna', { body: { klic: 'ev-volna-1', zpusob: 'prevod', castka: 1000 } })).body;
    assert.equal(volna.kontaktni, false);
    res = await zavolat(objednavky, 'post', '/:id/platby', { params: { id: String(obj3) }, body: { klic: 'ev-prirazeni-1', platba_id: volna.id } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.prijato, 800);
    res = await zavolat(objednavky, 'post', '/:id/platby', { params: { id: String(obj2) }, body: { klic: 'ev-prirazeni-2', platba_id: volna.id, castka: 300 } });
    assert.equal(res.statusCode, 409, 'zrušená objednávka');

    // ── 6) dobírka: úhrada zákazníka jednou, vyúčtování brutto − poplatek = netto bez nového příjmu ──
    const dob = (await q(`INSERT INTO objednavky (stav, celkem, doprava, platba, dopravce) VALUES ('odeslana', 1079, 'zasilkovna', 'dobirka', 'zasilkovna') RETURNING id`))[0].id;
    const soucetPredDobirkou = await soucty();
    res = await Promise.all([1, 2, 3].map(() => zavolat(objednavky, 'post', '/:id/dobirka', { params: { id: String(dob) }, body: { klic: 'ev-dobirka-1' } })));
    assert.ok(res.every(r => r.statusCode === 200), JSON.stringify(res.map(r => r.body)));
    assert.equal((await zavolat(objednavky, 'post', '/:id/dobirka', { params: { id: String(dob) }, body: { klic: 'ev-dobirka-2' } })).statusCode, 409);
    const dobirka = (await q('SELECT * FROM dobirky WHERE objednavka_id = $1', [dob]))[0];
    res = await Promise.all([1, 2].map(() => zavolat(evidenceRouter, 'post', '/dobirky/vyuctovani', { body: { klic: 'ev-vyuct-1', dopravce: 'zasilkovna', poplatek: 25, dobirky: [dobirka.id] } })));
    assert.ok(res.every(r => r.statusCode === 200), JSON.stringify(res.map(r => r.body)));
    assert.deepEqual([Number(res[0].body.brutto), Number(res[0].body.poplatek), Number(res[0].body.netto)], [1079, 25, 1054]);
    assert.equal(await n('dobirky_vyuctovani'), 1);
    assert.equal((await zavolat(evidenceRouter, 'post', '/dobirky/vyuctovani', { body: { klic: 'ev-vyuct-2', dopravce: 'zasilkovna', dobirky: [dobirka.id] } })).statusCode, 409, 'podruhé vyúčtovat nejde');
    assert.deepEqual(await q("SELECT typ, castka::int, zpusob, kontaktni FROM platby WHERE zdroj_typ = 'objednavka' AND zdroj_id = $1", [dob]),
      [{ typ: 'prijem', castka: 1079, zpusob: 'dobirka', kontaktni: false }], 'příjem z dobírky jen jednou');
    assert.deepEqual(await soucty(), soucetPredDobirkou, 'dobírka ani vyúčtování nemění účetní součty');
    await assert.rejects(pool.query('UPDATE dobirky SET castka = 1 WHERE id = $1', [dobirka.id]), /jen jednou doplnit vyúčtování/);

    // ── 7) opravy navázanými záznamy: změna způsobu platby, smazání účtenky ──
    res = await zavolat(prodejna, 'put', '/:id', { params: { id: String(prodej1.id) }, body: { platba: 'karta' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual((await q("SELECT typ, zpusob FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1 ORDER BY id", [prodej1.id])).map(r => r.typ + ':' + r.zpusob),
      ['prijem:hotovost', 'storno_prijmu:hotovost', 'prijem:karta']);
    assert.equal((await zavolat(prodejna, 'put', '/:id', { params: { id: String(prodej1.id) }, body: { platba: 'poukaz' } })).statusCode, 409);
    res = await zavolat(prodejna, 'post', '/', { body: { klic: 'ev-smazat-1', platba: 'qr', polozky: [{ produkt_id: 2, nazev: 'Sandál', velikost: '25', pocet: 2, cena: 800 }] } });
    const smazat = res.body;
    assert.equal((await zavolat(prodejna, 'delete', '/:id', { params: { id: String(smazat.id) } })).statusCode, 200);
    assert.deepEqual((await q("SELECT typ FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1 ORDER BY id", [smazat.id])).map(r => r.typ), ['prijem', 'storno_prijmu']);

    // ── 8) vratka a výměna s klíčem: opakování nic nezdvojí ──
    res = await Promise.all([1, 2].map(() => zavolat(prodejna, 'post', '/vratky', { body: { klic: 'ev-vratka-1', prodej_id: prodej1.id, polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }], castka: 1200, zpusob_vraceni: 'hotovost' } })));
    assert.ok(res.every(r => r.statusCode === 200), JSON.stringify(res.map(r => r.body)));
    assert.equal(await n('vratky', 'prodej_id = $1', [prodej1.id]), 1);
    assert.deepEqual(await q("SELECT typ, castka::int, zpusob, vraci_id IS NOT NULL AS navazana FROM platby WHERE zdroj_typ = 'vratka'"), [{ typ: 'vraceni', castka: 1200, zpusob: 'hotovost', navazana: true }]);
    assert.equal((await zavolat(prodejna, 'post', '/vratky', { body: { prodej_id: null, polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }], castka: 100 } })).statusCode, 400, 'vratka s penězi bez způsobu');
    const k = await zavolat(prodejna, 'post', '/', { body: { klic: 'ev-k-vymene', platba: 'karta', polozky: [{ produkt_id: 2, nazev: 'Sandál', velikost: '25', pocet: 1, cena: 800 }], potvrdit_duplicitu: true } });
    res = await Promise.all([1, 2].map(() => zavolat(prodejna, 'post', '/vymeny', { body: { klic: 'ev-vymena-1', prodej_id: k.body.id, vracene: [{ produkt_id: 2, velikost: '25', pocet: 1, cena: 800 }],
      nove: [{ produkt_id: 1, nazev: 'Zimní bota', velikost: '24', pocet: 1, cena: 1200 }], zapocet: 800, platba: 'hotovost' } })));
    assert.ok(res.every(r => r.statusCode === 200), JSON.stringify(res.map(r => r.body)));
    assert.equal(await n('vratky', 'prodej_id = $1', [k.body.id]), 1);
    assert.deepEqual(await q("SELECT typ, castka::int FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1", [res[0].body.prodej.id]), [{ typ: 'prijem', castka: 400 }], 'jen doplatek');

    // ── 9) kontrola dokladů proti evidenci ──
    let kontrola = await zavolat(evidenceRouter, 'get', '/kontrola');
    assert.equal(kontrola.statusCode, 200);
    assert.deepEqual(kontrola.body.rozdily, [], JSON.stringify(kontrola.body.rozdily));
    assert.ok(kontrola.body.zkontrolovano.prodeje >= 5 && kontrola.body.zkontrolovano.poukazy >= 3);
    await pool.query('UPDATE prodejna_prodeje SET celkem = celkem + 1 WHERE id = $1', [prodej1.id]);
    kontrola = await zavolat(evidenceRouter, 'get', '/kontrola');
    assert.deepEqual(kontrola.body.rozdily.map(r => r.doklad), [`účtenka #${prodej1.id}`]);
    await pool.query('UPDATE prodejna_prodeje SET celkem = celkem - 1 WHERE id = $1', [prodej1.id]);

    // ── 10) součty: zrušení objednávky s poukazem vrací čerpání záporným řádkem (stejný součet jako dřív smazání) ──
    const poukaz4 = (await zavolat(poukazy, 'post', '/', { body: { klic: 'ev-poukaz-4', hodnota: 500, platba: 'hotovost', zakoupeno_kde: 'prodejna' } })).body;
    res = await zavolat(objednavky, 'post', '/', { body: { jmeno: 'Ota Malý', email: 'ota@example.com', telefon: '777 000 333', ulice: 'Hlavní 4', mesto: 'Hulín', psc: '768 24',
      doprava: 'osobni_odber', platba: 'na_prodejne', polozky: [{ produkt_id: 2, velikost: 25, pocet: 1 }], poukaz_kod: poukaz4.kod } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const obj4 = res.body.objednavka_id;
    assert.equal((await zavolat(objednavky, 'patch', '/:id/stav', { params: { id: String(obj4) }, body: { stav: 'zrusena' } })).statusCode, 200);
    assert.equal(Number((await q('SELECT COALESCE(SUM(castka),0) s FROM poukazy_pouziti WHERE objednavka_id = $1', [obj4]))[0].s), 0, 'čisté čerpání zrušené objednávky = 0');
    assert.equal((await q('SELECT COUNT(*)::int n FROM poukazy_pouziti WHERE objednavka_id = $1', [obj4]))[0].n, 2, 'původní řádek zůstal + navázané vrácení');
    assert.deepEqual((await q("SELECT typ FROM kredit_pohyby WHERE zdroj_typ = 'objednavka' AND zdroj_id = $1 ORDER BY id", [obj4])).map(r => r.typ), ['cerpani', 'storno_cerpani']);
    kontrola = await zavolat(evidenceRouter, 'get', '/kontrola');
    assert.deepEqual(kontrola.body.rozdily, [], 'zůstatky poukazů sedí s kreditem: ' + JSON.stringify(kontrola.body.rozdily));
  } finally {
    console.log = puvodniLog;
    if (puvodniKlic !== undefined) process.env.ZASILKOVNA_API_KLIC = puvodniKlic;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
