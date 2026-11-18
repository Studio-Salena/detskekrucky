// EET 2.0 (krok 3) proti SKUTEČNÉMU PostgreSQL: události ve stejné transakci jako operace,
// částky (peníze a kredit) na konkrétních příkladech, neměnnost, fronta odesílání
// (restart, souběžní zpracovatelé, timeout, ztracená odpověď, pád po odeslání,
// podvržená odpověď, trvalá chyba, opravy), ověřovací mód a okamžité odeslání po COMMIT.
//
// Odpovědi dává LOKÁLNÍ falešný FS (test-helpers/eetFs.js, testovací CA) – nic se
// neodesílá po síti. Skutečný test proti Playgroundu: scripts/eet-playground.js.
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');
const { konfigTest, falesnyFs } = require('../test-helpers/eetFs');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
const pockat = ms => new Promise(r => setTimeout(r, ms));

test('PostgreSQL EET: události, částky, neměnnost a fronta odesílání', { skip: preskocit, timeout: 120000 }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'eet_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 20 });
  const puvodniLog = console.log; console.log = () => {};
  const tichyLog = { log() {}, warn() {}, error() {} };
  const udalosti = require('../lib/eetUdalosti');
  const { Fronta } = require('../lib/eetFronta');
  const konfig = konfigTest();
  udalosti.nastavitKonfiguraci(konfig);
  const fronty = [];
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
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Bota', 'Značka', 1000), ('Sandál', 'Značka', 500);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 200), (2, '25', 200);
    `);
    const mocky = { '../db/pool': pool, './emaily': new Proxy({}, { get: () => async () => {} }) };
    const nacist = r => nacistRouterSMocky('../routes/' + r + '.js', mocky);
    const prodejna = nacist('prodejna'); assert.equal(await vsePripraveno(20000), true);
    const poukazy = nacist('poukazy'); assert.equal(await vsePripraveno(20000), true);
    const objednavky = nacist('objednavky'); assert.equal(await vsePripraveno(20000), true);
    nacist('promo'); nacist('poukazoveKarty'); assert.equal(await vsePripraveno(20000), true);
    const evRouter = nacist('evidencePlateb'); assert.equal(await vsePripraveno(20000), true);
    nacist('evidencePlateb'); assert.equal(await vsePripraveno(20000), true); // migrace 2× (idempotentní)
    const eetRouter = nacist('eet');

    const zavolat = async (router, metoda, cesta, req = {}) => {
      const res = vytvoritRes();
      await najitHandler(router, metoda, cesta)({ params: {}, query: {}, ip: '10.5.5.' + Math.floor(Math.random() * 250), ...req }, res);
      return res;
    };
    const q = async (sql, p) => (await pool.query(sql, p)).rows;
    const prodat = body => zavolat(prodejna, 'post', '/', { body: { potvrdit_duplicitu: true, ...body } });
    const polozka = (produkt, cena, pocet = 1) => ({ produkt_id: produkt, nazev: produkt === 1 ? 'Bota' : 'Sandál', velikost: produkt === 1 ? '24' : '25', pocet, cena });
    const vratit = p => ({ produkt_id: p, velikost: p === 1 ? '24' : '25', pocet: 1 });
    const castky = u => [u.stav, Number(u.celk_trzba), u.urceno_cerp_zuct == null ? null : Number(u.urceno_cerp_zuct), u.cerp_zuct == null ? null : Number(u.cerp_zuct)];
    const udalostiDokladu = (typ, id) => udalosti.stavDokladu(pool, typ, id).then(r => Promise.all(r.map(x => q('SELECT * FROM eet_udalosti WHERE id = $1', [x.id]).then(a => a[0]))));
    const jedna = async (typ, id) => { const u = await udalostiDokladu(typ, id); assert.equal(u.length, 1, `${typ} ${id}: ${JSON.stringify(u.map(castky))}`); return u[0]; };
    const pocetUdalosti = async () => (await q('SELECT COUNT(*)::int n FROM eet_udalosti'))[0].n;
    const ucet = async () => (await q(`SELECT (SELECT COALESCE(SUM(celkem),0) FROM prodejna_prodeje)::int AS prodejna, (SELECT COALESCE(SUM(castka),0) FROM vratky)::int AS vratky`))[0];

    // ═══ A) Částky na konkrétních příkladech ═══
    // A1 běžný prodej v hotovosti
    let res = await prodat({ klic: 'eet-hotove-1', platba: 'hotovost', polozky: [polozka(1, 1000)] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const hotove = res.body;
    assert.deepEqual(castky(await jedna('prodej', hotove.id)), ['ceka', 1000, null, null]);
    assert.equal(hotove.eet.length, 1, 'pokladna dostane stav EET odděleně od uloženého prodeje');
    assert.equal(hotove.eet[0].stav, 'ceka');
    const u1 = await jedna('prodej', hotove.id);
    assert.match(u1.porad_cis, /^\d{4}-\d{6}$/);
    assert.match(u1.dat_trzby, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0[12]:00$/);
    assert.deepEqual([u1.eic, u1.id_provoz, u1.id_pokl, u1.prostredi, u1.typ], ['CZ00000019', '11', 'POKL-1', 'test', 'trzba']);
    assert.equal(new Date(u1.lhuta_do) - new Date(u1.vytvoreno), 48 * 3600e3, 'lhůta 48 h od tržby');
    // opakované odeslání téhož prodeje (stejný klíč) událost nezdvojí
    const pred = await pocetUdalosti();
    res = await prodat({ klic: 'eet-hotove-1', platba: 'hotovost', polozky: [polozka(1, 1000)] });
    assert.equal(res.body.opakovane, true);
    assert.equal(await pocetUdalosti(), pred);
    // neuložený prodej (málo skladem) = žádná událost (stejná transakce, ROLLBACK)
    res = await prodat({ klic: 'eet-moc-1', platba: 'hotovost', polozky: [polozka(1, 1000, 999)] });
    assert.equal(res.statusCode, 400);
    assert.equal(await pocetUdalosti(), pred);

    // A2 prodej poukazu kartou = tržba s částkou určenou k čerpání
    res = await zavolat(poukazy, 'post', '/', { body: { klic: 'eet-poukaz-1', hodnota: 1000, platba: 'karta', zakoupeno_kde: 'prodejna' } });
    const pk = res.body;
    assert.deepEqual(castky(await jedna('prodej', pk.prodej.id)), ['ceka', 1000, 1000, null]);
    // A3 celý nákup zaplaceným poukazem = čerpání (cerp_zuct) a je i v celkové částce
    res = await prodat({ klic: 'eet-cerpani-1', platba: 'poukaz', poukaz_kod: pk.kod, polozky: [polozka(2, 300)] });
    const cerpani = res.body;
    assert.deepEqual(castky(await jedna('prodej', cerpani.id)), ['ceka', 300, null, 300]);
    // A4 poukaz + doplatek = JEDNA zpráva (ne zpráva za každý řádek plateb)
    res = await prodat({ klic: 'eet-doplatek-1', platba: 'poukaz', poukaz_kod: pk.kod, doplatek_platba: 'hotovost', polozky: [polozka(1, 1000)] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const doplatek = res.body;
    assert.deepEqual(castky(await jedna('prodej', doplatek.id)), ['ceka', 1000, null, 700]);
    // A5 darovaný poukaz + doplatek: peníze se evidují, darovaná část čeká na rozhodnutí (ne zaplacená, ne vynechaná)
    const dar = (await zavolat(poukazy, 'post', '/', { body: { klic: 'eet-dar-1', hodnota: 500, druh: 'dar', zakoupeno_kde: 'prodejna' } })).body;
    assert.equal(await pocetUdalosti(), pred + 3, 'darovaný poukaz (bez peněz) tržbu netvoří');
    res = await prodat({ klic: 'eet-dar-prodej-1', platba: 'poukaz', poukaz_kod: dar.kod, doplatek_platba: 'karta', polozky: [polozka(1, 800)] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const sDarem = await udalostiDokladu('prodej', res.body.id);
    assert.deepEqual(sDarem.map(castky), [['ceka', 300, null, null], ['rozhodnuti', 500, null, 500]]);
    assert.match(sDarem[1].rozhodnuti_duvod, /darovaného nebo nedoloženého/);
    const rozhodnutiId = sDarem[1].id;

    // A6 vratka v hotovosti k evidované účtence = záporná tržba
    res = await zavolat(prodejna, 'post', '/vratky', { body: { klic: 'eet-vratka-1', prodej_id: hotove.id, polozky: [vratit(1)], castka: 400, zpusob_vraceni: 'hotovost' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const vr1 = await jedna('vratka', res.body.id);
    assert.deepEqual(castky(vr1), ['ceka', -400, null, null]);
    assert.equal(vr1.typ, 'oprava');
    // A7 vrácení zboží placeného poukazem zpět na poukaz = storno čerpání (celk −, cerp −)
    res = await zavolat(prodejna, 'post', '/vratky', { body: { klic: 'eet-vratka-2', prodej_id: cerpani.id, polozky: [vratit(2)], castka: 0 } });
    const vr2 = res.body;
    assert.equal((await udalostiDokladu('vratka', vr2.id)).length, 0, 'vratka bez peněz sama tržbu netvoří');
    res = await zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(pk.id) }, body: { klic: 'eet-pripsani-1', castka: 300, vratka_id: vr2.id } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(castky(await jedna('vratka', vr2.id)), ['ceka', -300, null, -300]);
    // A8 výměna s doplatkem = jen doplatek; výměna s vráceným rozdílem = jen rozdíl (−)
    const levny = (await prodat({ klic: 'eet-levny-1', platba: 'hotovost', polozky: [polozka(2, 500)] })).body;
    res = await zavolat(prodejna, 'post', '/vymeny', { body: { klic: 'eet-vymena-1', prodej_id: levny.id, vracene: [{ ...polozka(2, 500) }], nove: [polozka(1, 1000)], zapocet: 500, platba: 'karta' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const vym1 = res.body;
    assert.deepEqual(castky(await jedna('prodej', vym1.prodej.id)), ['ceka', 500, null, null]);
    assert.equal((await q('SELECT zdroj_typ FROM eet_udalosti WHERE id = $1', [(await jedna('prodej', vym1.prodej.id)).id]))[0].zdroj_typ, 'prodej');
    const drahy = (await prodat({ klic: 'eet-drahy-1', platba: 'hotovost', polozky: [polozka(1, 1000)] })).body;
    res = await zavolat(prodejna, 'post', '/vymeny', { body: { klic: 'eet-vymena-2', prodej_id: drahy.id, vracene: [polozka(1, 1000)], nove: [polozka(2, 500)], zapocet: 1000, platba: 'hotovost' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const vym2 = await jedna('vratka', res.body.vratka.id);
    assert.deepEqual(castky(vym2), ['ceka', -500, null, null]);
    // nový prodej výměny bez doplatku nemá peníze ani kredit (celkem 0) – tržbou je jen vrácený rozdíl;
    // jeho účtenku chrání pravidlo „účtenku výměny nejde smazat“
    assert.equal((await udalostiDokladu('prodej', res.body.prodej.id)).length, 0);
    assert.equal((await zavolat(prodejna, 'delete', '/:id', { params: { id: String(res.body.prodej.id) } })).statusCode, 409);
    // A9 osobní odběr: platba na prodejně a vrácení peněz
    const obj = (await q("INSERT INTO objednavky (stav, celkem, doprava, platba) VALUES ('nova', 1200, 'osobni_odber', 'na_prodejne') RETURNING id"))[0];
    res = await zavolat(objednavky, 'post', '/:id/platby', { params: { id: String(obj.id) }, body: { klic: 'eet-odber-1', zpusob: 'hotovost' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    res = await zavolat(objednavky, 'post', '/:id/platby/vraceni', { params: { id: String(obj.id) }, body: { klic: 'eet-odber-vr-1', zpusob: 'hotovost', castka: 200 } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual((await udalostiDokladu('objednavka', obj.id)).map(castky), [['ceka', 1200, null, null], ['ceka', -200, null, null]]);
    // A10 poukaz z e-shopu zaplacený u pultu + vrácení peněz za něj (storno nabití: celk −, urceno −)
    const epRes = await zavolat(poukazy, 'post', '/', { body: { klic: 'eet-eshop-1', hodnota: 500, zakoupeno_kde: 'eshop' } });
    assert.equal(epRes.statusCode, 200, JSON.stringify(epRes.body));
    const ep = epRes.body;
    assert.equal((await udalostiDokladu('poukaz', ep.id)).length, 0, 'čekající poukaz bez platby tržbu netvoří');
    res = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(ep.id) }, body: { klic: 'eet-eshop-platba-1', zpusob: 'hotovost' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    res = await zavolat(poukazy, 'post', '/:id/vraceni', { params: { id: String(ep.id) }, body: { klic: 'eet-eshop-vr-1', zpusob: 'hotovost', castka: 250 } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual((await udalostiDokladu('poukaz', ep.id)).map(castky), [['ceka', 500, 500, null], ['ceka', -250, -250, null]]);
    // A11 převod se neeviduje (prodej poukazu převodem, platba objednávky převodem)
    const prevodem = (await zavolat(poukazy, 'post', '/', { body: { klic: 'eet-prevod-1', hodnota: 500, platba: 'prevod', zakoupeno_kde: 'prodejna' } })).body;
    assert.equal((await udalostiDokladu('prodej', prevodem.prodej.id)).length, 0);
    // A12 volná platba u pultu: účel se musí zadat při přijetí a bez zpětného data; převod se neeviduje a jeho přiřazení tržbu netvoří
    res = await zavolat(evRouter, 'post', '/volna', { body: { klic: 'eet-volna-hot-1', zpusob: 'hotovost', castka: 500 } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /EET/);
    res = await zavolat(evRouter, 'post', '/volna', { body: { klic: 'eet-volna-hot-2', zpusob: 'hotovost', castka: 500, ucel: 'zbozi', prijato_at: '2026-11-01T12:00:00+01:00' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /okamžiku přijetí/);
    const volna = (await zavolat(evRouter, 'post', '/volna', { body: { klic: 'eet-volna-prevod-1', zpusob: 'prevod', castka: 500 } })).body;
    const ep2 = (await zavolat(poukazy, 'post', '/', { body: { klic: 'eet-eshop-2', hodnota: 500, zakoupeno_kde: 'eshop' } })).body;
    const predPrirazenim = await pocetUdalosti();
    res = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(ep2.id) }, body: { klic: 'eet-prirazeni-1', platba_id: volna.id } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(await pocetUdalosti(), predPrirazenim, 'přiřazení platby netvoří druhou tržbu');
    // A13 starší okno pokladny (samostatné čerpání poukazu) se zapnutým EET odmítnuto
    res = await zavolat(poukazy, 'post', '/pouzit', { body: { kod: pk.kod, castka: 10 } });
    assert.equal(res.statusCode, 409);

    // A14 volná HOTOVOST „za zboží“, později přiřazená poukazu: tržba vznikla při přijetí; přiřazení
    // nevytvoří druhou tržbu ani nepřepíše původní zprávu – vznikne opravná dvojice (−1000 | +1000 z toho 1000 k čerpání)
    const volnaUdalosti = id => q('SELECT * FROM eet_udalosti WHERE volna_platba_id = $1 ORDER BY id', [id]);
    res = await zavolat(evRouter, 'post', '/volna', { body: { klic: 'eet-volna-zbozi-1', zpusob: 'hotovost', castka: 1000, ucel: 'zbozi' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const vz = res.body;
    assert.equal(vz.urceno_k_cerpani, null);
    assert.deepEqual(res.body.eet.map(e => [e.stav, Number(e.celk_trzba)]), [['ceka', 1000]], 'odpověď nese stav EET odděleně od uložené platby');
    let vu = await volnaUdalosti(vz.id);
    assert.deepEqual(vu.map(castky), [['ceka', 1000, null, null]]);
    const puvodniVolna = vu[0];
    const ep3 = (await zavolat(poukazy, 'post', '/', { body: { klic: 'eet-eshop-3', hodnota: 1000, zakoupeno_kde: 'eshop' } })).body;
    res = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(ep3.id) }, body: { klic: 'eet-prirazeni-volna-1', platba_id: vz.id } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    vu = await volnaUdalosti(vz.id);
    assert.deepEqual(vu.map(castky), [['ceka', 1000, null, null], ['ceka', -1000, null, null], ['ceka', 1000, 1000, null]]);
    assert.deepEqual(vu.map(u => u.typ), ['trzba', 'oprava', 'trzba']);
    assert.equal(vu.reduce((a, u) => a + Number(u.celk_trzba), 0), 1000, 'celková tržba z platby zůstává 1000 (žádná druhá tržba)');
    assert.deepEqual((await q('SELECT dat_trzby, celk_trzba, porad_cis FROM eet_udalosti WHERE id = $1', [puvodniVolna.id]))[0],
      { dat_trzby: puvodniVolna.dat_trzby, celk_trzba: puvodniVolna.celk_trzba, porad_cis: puvodniVolna.porad_cis }, 'původní zpráva beze změny');
    assert.equal(new Set(vu.map(u => u.porad_cis)).size, 3, 'každá oprava má vlastní pořadové číslo');
    // opakované přiřazení (stejný klíč) nic nezdvojí
    res = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(ep3.id) }, body: { klic: 'eet-prirazeni-volna-1', platba_id: vz.id } });
    assert.equal(res.body.opakovane, true);
    assert.equal((await volnaUdalosti(vz.id)).length, 3);
    // vrácení části peněz za takto zaplacený poukaz = storno nabití (celk −, urceno − podle evidovaného určení)
    res = await zavolat(poukazy, 'post', '/:id/vraceni', { params: { id: String(ep3.id) }, body: { klic: 'eet-volna-vraceni-1', zpusob: 'hotovost', castka: 300, zrusit: false } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual((await udalostiDokladu('poukaz', ep3.id)).filter(u => u.zdroj_typ === 'poukaz').map(castky), [['ceka', -300, -300, null]]);
    // čerpání takového poukazu = zaplacený kredit (cerp_zuct)
    res = await prodat({ klic: 'eet-volna-cerpani-1', platba: 'poukaz', poukaz_kod: ep3.kod, polozky: [polozka(2, 500)] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(castky(await jedna('prodej', res.body.id)), ['ceka', 500, null, 500]);

    // A15 volná KARTA „na poukaz“ přiřazená (částí) objednávce a pak storno přiřazení: oprava tam i zpět
    res = await zavolat(evRouter, 'post', '/volna', { body: { klic: 'eet-volna-poukaz-1', zpusob: 'karta', castka: 800, ucel: 'poukaz' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const vp = res.body;
    assert.equal(Number(vp.urceno_k_cerpani), 800);
    assert.deepEqual((await volnaUdalosti(vp.id)).map(castky), [['ceka', 800, 800, null]]);
    const obj2 = (await q("INSERT INTO objednavky (stav, celkem, doprava, platba) VALUES ('nova', 500, 'zasilkovna', 'prevod') RETURNING id"))[0];
    res = await zavolat(objednavky, 'post', '/:id/platby', { params: { id: String(obj2.id) }, body: { klic: 'eet-prirazeni-obj-1', platba_id: vp.id, castka: 500 } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual((await volnaUdalosti(vp.id)).map(castky), [['ceka', 800, 800, null], ['ceka', -500, -500, null], ['ceka', 500, null, null]]);
    const prirazeniObj = res.body.zapis.id;
    res = await zavolat(evRouter, 'post', '/prirazeni/:id/storno', { params: { id: String(prirazeniObj) }, body: { klic: 'eet-prirazeni-obj-storno-1' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    vu = await volnaUdalosti(vp.id);
    assert.deepEqual(vu.slice(3).map(castky), [['ceka', -500, null, null], ['ceka', 500, 500, null]]);
    assert.equal(vu.reduce((a, u) => a + Number(u.urceno_cerp_zuct || 0), 0), 800, 'po stornu přiřazení je celá platba zase určená k čerpání');
    assert.equal(vu.reduce((a, u) => a + Number(u.celk_trzba), 0), 800);

    // A16 storno omylem zapsaného příjmu u evidované účtenky = záporná (opravná) tržba
    const omyl = (await prodat({ klic: 'eet-storno-1', platba: 'hotovost', polozky: [polozka(2, 500)] })).body;
    const evid = require('../lib/evidencePlateb');
    const klientStorna = await pool.connect();
    try {
      await klientStorna.query('BEGIN');
      await evid.stornovatPrijmy(klientStorna, { zdroj_typ: 'prodej', zdroj_id: omyl.id, klicPrefix: 'eet-storno-test', poznamka: 'test' });
      await udalosti.zaznamenat(klientStorna, { zdroj_typ: 'prodej', zdroj_id: omyl.id, klic: 'storno-test' });
      await klientStorna.query('COMMIT');
    } finally { klientStorna.release(); }
    assert.deepEqual((await udalostiDokladu('prodej', omyl.id)).map(u => [u.typ, ...castky(u)]), [['trzba', 'ceka', 500, null, null], ['oprava', 'ceka', -500, null, null]]);

    // ═══ B) Ochrana a neměnnost ═══
    res = await zavolat(prodejna, 'delete', '/:id', { params: { id: String(hotove.id) } });
    assert.equal(res.statusCode, 409, 'účtenku s událostí EET nejde smazat');
    await assert.rejects(q('DELETE FROM vratky WHERE id = $1', [vym2.zdroj_id]), /událost EET/, 'vratka výměny chráněná i přes vazbu řádků');
    await assert.rejects(q('DELETE FROM prodejna_prodeje WHERE id = $1', [vym1.prodej.id]), /událost EET/);
    await assert.rejects(q('UPDATE eet_udalosti SET celk_trzba = 1 WHERE id = $1', [u1.id]), /neměnné/);
    await assert.rejects(q("UPDATE eet_udalosti SET dat_trzby = '2026-01-01T00:00:00+01:00' WHERE id = $1", [u1.id]), /neměnné/);
    await assert.rejects(q("UPDATE eet_udalosti SET stav = 'potvrzeno' WHERE id = $1", [u1.id]), /POK/);
    await assert.rejects(q("UPDATE eet_udalosti SET stav = 'neevidovano', rozhodnuti_poznamka = 'x' WHERE id = $1", [u1.id]), /Nepovolená změna stavu/);
    await assert.rejects(q('DELETE FROM eet_udalosti_radky'), /neměnný/);
    await assert.rejects(q('DELETE FROM eet_udalosti WHERE id = $1', [u1.id]), /nejde smazat/);
    // testovací potvrzení nejde uložit jako produkční: POK bez -ff ani bez příznaku test; produkce v DB zakázaná
    await assert.rejects(q("UPDATE eet_udalosti SET stav = 'potvrzeno', pok = 'b3a09b52-7c87-4014-a496-4c7a53cf9125-03', pok_test = true WHERE id = $1", [u1.id]), /označené jako test/);
    await assert.rejects(q("UPDATE eet_udalosti SET stav = 'potvrzeno', pok = 'b3a09b52-7c87-4014-a496-4c7a53cf9125-ff', pok_test = false WHERE id = $1", [u1.id]), /označené jako test/);
    await assert.rejects(q("INSERT INTO eet_udalosti (klic, zdroj_typ, zdroj_id, prostredi) VALUES ('x-produkce', 'prodej', 1, 'produkce')"), /eet_udalosti_jen_neprodukce/);
    // rozhodnutí o darovaném kreditu: s odůvodněním, jednou
    res = await zavolat(eetRouter, 'post', '/udalosti/:id/rozhodnuti', { params: { id: String(rozhodnutiId) }, body: { volba: 'neevidovat' } });
    assert.equal(res.statusCode, 400);
    res = await zavolat(eetRouter, 'post', '/udalosti/:id/odeslat', { params: { id: String(rozhodnutiId) } });
    assert.equal(res.statusCode, 409, 'nerozhodnutou událost nejde odeslat');

    // ═══ C) Fronta: první odeslání, identita tržby, žádné opakování po potvrzení ═══
    const ucetPred = await ucet();
    const fs1 = falesnyFs();
    const f1 = new Fronta({ db: pool, konfig, transport: fs1.transport, log: tichyLog });
    const cekajici = await q("SELECT * FROM eet_udalosti WHERE stav = 'ceka' ORDER BY id");
    let souhrn = await f1.zpracovat({ limit: 100 });
    assert.equal(souhrn.zpracovano, cekajici.length);
    for (const u of cekajici) {
      const po = (await q('SELECT * FROM eet_udalosti WHERE id = $1', [u.id]))[0];
      assert.equal(po.stav, 'potvrzeno', JSON.stringify(po.posledni_chyba));
      assert.equal(po.pok_test, true, 'testovací potvrzení je označené jako test – nejde o evidenci');
      const odeslano = fs1.prijate.filter(p => p.poradCis === u.porad_cis);
      assert.equal(odeslano.length, 1);
      const o = odeslano[0];
      assert.equal(o.podpisOk, true);
      assert.equal(o.prvni, 'true');
      assert.deepEqual([o.eic, o.idJednotky, o.idPokl, o.datTrzby, o.celk], [u.eic, u.id_provoz, u.id_pokl, u.dat_trzby, Number(u.celk_trzba).toFixed(2)]);
      assert.equal(o.urceno, u.urceno_cerp_zuct == null ? null : Number(u.urceno_cerp_zuct).toFixed(2));
      assert.equal(o.cerp, u.cerp_zuct == null ? null : Number(u.cerp_zuct).toFixed(2));
    }
    assert.equal((await q("SELECT COUNT(*)::int n FROM eet_udalosti WHERE stav = 'rozhodnuti'"))[0].n, 1, 'rozhodovací událost se neodeslala');
    assert.ok(fs1.prijate.every(p => p.poradCis !== sDarem[1].porad_cis));
    souhrn = await f1.zpracovat({ limit: 100 });
    assert.equal(souhrn.zpracovano, 0, 'potvrzené se znovu neodesílají');
    await assert.rejects(q("UPDATE eet_udalosti SET pok = 'jiny' WHERE id = $1", [u1.id]), /uzavřená/);
    res = await zavolat(eetRouter, 'post', '/udalosti/:id/odeslat', { params: { id: String(u1.id) } });
    assert.equal(res.statusCode, 409, 'potvrzenou událost nejde odeslat znovu');
    assert.deepEqual(await ucet(), ucetPred, 'účetní součty se odesíláním nemění (EET je oddělené)');
    // rozhodnutí „evidovat“ → do fronty se svými (neměnnými) údaji
    res = await zavolat(eetRouter, 'post', '/udalosti/:id/rozhodnuti', { params: { id: String(rozhodnutiId) }, body: { volba: 'evidovat', poznamka: 'Rozhodnutí podle účetní – evidovat jako čerpání.' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    res = await zavolat(eetRouter, 'post', '/udalosti/:id/rozhodnuti', { params: { id: String(rozhodnutiId) }, body: { volba: 'neevidovat', poznamka: 'Podruhé už nejde.' } });
    assert.equal(res.statusCode, 409);
    await f1.zpracovat();
    assert.equal((await q('SELECT stav FROM eet_udalosti WHERE id = $1', [rozhodnutiId]))[0].stav, 'potvrzeno');

    const novaUdalost = async klic => (await jedna('prodej', (await prodat({ klic, platba: 'hotovost', polozky: [polozka(2, 500)] })).body.id));
    const pokusy = async id => q('SELECT * FROM eet_pokusy WHERE udalost_id = $1 ORDER BY id', [id]);
    const uspisit = id => q('UPDATE eet_udalosti SET dalsi_pokus_at = now() WHERE id = $1', [id]);

    // ═══ D) Timeout → opakování s novým UUID, prvni_zaslani=false, stejná identita tržby ═══
    let u = await novaUdalost('eet-timeout-1');
    const fs2 = falesnyFs({ scenare: ['timeout'] });
    const f2 = new Fronta({ db: pool, konfig, transport: fs2.transport, log: tichyLog });
    await f2.zpracovat();
    let po = (await q('SELECT * FROM eet_udalosti WHERE id = $1', [u.id]))[0];
    assert.equal(po.stav, 'ceka');
    assert.equal(po.posledni_vysledek, 'timeout');
    assert.ok(new Date(po.dalsi_pokus_at) > new Date(), 'další pokus naplánovaný');
    assert.equal((await f2.zpracovat()).zpracovano, 0, 'před naplánovaným časem se nezkouší');
    await uspisit(u.id);
    await f2.zpracovat();
    po = (await q('SELECT * FROM eet_udalosti WHERE id = $1', [u.id]))[0];
    assert.equal(po.stav, 'potvrzeno');
    let p = await pokusy(u.id);
    assert.deepEqual(p.map(x => [x.vysledek, x.prvni_zaslani]), [['timeout', true], ['potvrzeno', false]]);
    assert.notEqual(p[0].uuid_zpravy, p[1].uuid_zpravy);
    assert.equal(fs2.prijate[0].datTrzby, fs2.prijate[1].datTrzby, 'dat_trzby se při opakování nemění');
    assert.equal(fs2.prijate[0].poradCis, fs2.prijate[1].poradCis);
    assert.deepEqual([fs2.prijate[0].prvni, fs2.prijate[1].prvni], ['true', 'false']);

    // ═══ E) Ztracená odpověď (FS zprávu přijal) → opakování dostane stejný POK ═══
    u = await novaUdalost('eet-ztracena-1');
    const fs3 = falesnyFs({ scenare: ['ztracena'] });
    const f3 = new Fronta({ db: pool, konfig, transport: fs3.transport, log: tichyLog });
    await f3.zpracovat(); await uspisit(u.id); await f3.zpracovat();
    p = await pokusy(u.id);
    assert.deepEqual(p.map(x => x.vysledek), ['sit', 'potvrzeno']);
    assert.equal(fs3.prijate.length, 2);
    assert.equal(fs3.prijate[1].prvni, 'false');

    // ═══ F) Pád po přijetí zprávy FS, před uložením potvrzení → restart (nová fronta) dokončí ═══
    u = await novaUdalost('eet-pad-1');
    await q("UPDATE eet_udalosti SET zamek_token = 'mrtvy-proces', zamek_do = now() - interval '1 second', pocet_pokusu = 1 WHERE id = $1", [u.id]);
    await q("INSERT INTO eet_pokusy (udalost_id, uuid_zpravy, prvni_zaslani, dat_odesl, prostredi) VALUES ($1, gen_random_uuid()::text, true, '2026-11-17T10:00:00+01:00', 'test')", [u.id]);
    const fs4 = falesnyFs();
    const f4 = new Fronta({ db: pool, konfig, transport: fs4.transport, log: tichyLog }); // „po restartu“
    await f4.zpracovat();
    p = await pokusy(u.id);
    assert.deepEqual(p.map(x => [x.vysledek, x.prvni_zaslani]), [['nedokonceno', true], ['potvrzeno', false]]);
    assert.equal((await q('SELECT stav FROM eet_udalosti WHERE id = $1', [u.id]))[0].stav, 'potvrzeno');
    await assert.rejects(q("UPDATE eet_pokusy SET vysledek = 'chyba' WHERE id = $1", [p[1].id]), /neměnný/);

    // ═══ G) Souběžní zpracovatelé: každá událost odeslaná právě jednou ═══
    const nove = [];
    for (let i = 0; i < 8; i++) nove.push(await novaUdalost('eet-soubeh-' + i));
    const fs5 = falesnyFs({ zpozdeni: 30 });
    const tri = [0, 1, 2].map(() => new Fronta({ db: pool, konfig, transport: fs5.transport, log: tichyLog }));
    await Promise.all(tri.map(f => f.zpracovat({ limit: 3 }).then(() => f.zpracovat({ limit: 3 })).then(() => f.zpracovat({ limit: 3 }))));
    for (const n of nove) {
      assert.equal(fs5.prijate.filter(x => x.poradCis === n.porad_cis).length, 1, 'odesláno právě jednou');
      assert.equal((await q('SELECT stav FROM eet_udalosti WHERE id = $1', [n.id]))[0].stav, 'potvrzeno');
    }

    // ═══ H) Vypršelý pronájem: pomalý zpracovatel nepřepíše výsledek toho, kdo událost převzal ═══
    u = await novaUdalost('eet-pomaly-1');
    let pustit;
    const fsPomaly = falesnyFs();
    const pomalyTransport = async a => { await new Promise(r => { pustit = r; }); return fsPomaly.transport(a); };
    const fPomala = new Fronta({ db: pool, konfig, transport: pomalyTransport, log: tichyLog, zamekMs: 50 });
    const bezi = fPomala.zpracovat();
    while (!pustit) await pockat(10);
    await pockat(80); // pronájem vypršel
    const fs6 = falesnyFs({ scenare: ['ok'] });
    await new Fronta({ db: pool, konfig, transport: fs6.transport, log: tichyLog }).zpracovat();
    const potvrzenoPrvni = (await q('SELECT pok FROM eet_udalosti WHERE id = $1', [u.id]))[0].pok;
    pustit(); await bezi;
    po = (await q('SELECT * FROM eet_udalosti WHERE id = $1', [u.id]))[0];
    assert.equal(po.stav, 'potvrzeno');
    assert.equal(po.pok, potvrzenoPrvni, 'pozdní výsledek nic nepřepsal');
    assert.equal((await pokusy(u.id)).length, 2);

    // ═══ I) Podvržené / neplatné odpovědi = výsledek neznámý → opakovat; trvalá chyba → stav chyba ═══
    u = await novaUdalost('eet-podvrh-1');
    const fs7 = falesnyFs({ scenare: ['podvrh', 'jiny-uuid', 'bez-podpisu', 'fault', 'chyba-1', 'varovani'] });
    const f7 = new Fronta({ db: pool, konfig, transport: fs7.transport, log: tichyLog });
    for (let i = 0; i < 6; i++) { await uspisit(u.id); await f7.zpracovat(); }
    p = await pokusy(u.id);
    assert.deepEqual(p.map(x => x.vysledek), ['neplatna_odpoved', 'neplatna_odpoved', 'neplatna_odpoved', 'neplatna_odpoved', 'chyba', 'potvrzeno']);
    assert.equal(p[4].kod_chyby, -1);
    po = (await q('SELECT * FROM eet_udalosti WHERE id = $1', [u.id]))[0];
    assert.equal(po.stav, 'potvrzeno');
    assert.deepEqual(po.varovani.map(v => v.kod), [5]);
    assert.ok(p.slice(1).every(x => x.prvni_zaslani === false));
    u = await novaUdalost('eet-chyba3-1');
    const fs8 = falesnyFs({ scenare: ['chyba3'] });
    const f8 = new Fronta({ db: pool, konfig, transport: fs8.transport, log: tichyLog });
    await f8.zpracovat();
    po = (await q('SELECT * FROM eet_udalosti WHERE id = $1', [u.id]))[0];
    assert.equal(po.stav, 'chyba');
    assert.match(po.posledni_chyba, /Chyba 3/);
    await uspisit(u.id);
    assert.equal((await f8.zpracovat()).zpracovano, 0, 'trvalá chyba se sama neopakuje');
    res = await zavolat(eetRouter, 'post', '/udalosti/:id/odeslat', { params: { id: String(u.id) } });
    assert.equal(res.statusCode, 200);
    await f8.zpracovat();
    assert.equal((await q('SELECT stav FROM eet_udalosti WHERE id = $1', [u.id]))[0].stav, 'potvrzeno');
    // klíč nepatří k certifikátu (konfigurace to jinak odmítne předem) → FS kód 4 → trvalá chyba
    u = await novaUdalost('eet-podpis-1');
    const { PKI } = require('../test-helpers/eetFs');
    const fs9 = falesnyFs();
    await new Fronta({ db: pool, konfig: { ...konfig, klicPem: PKI.fsKlic }, transport: fs9.transport, log: tichyLog }).zpracovat();
    po = (await q('SELECT * FROM eet_udalosti WHERE id = $1', [u.id]))[0];
    assert.equal(fs9.prijate[0].podpisOk, false);
    assert.deepEqual([po.stav, (await pokusy(u.id))[0].kod_chyby], ['chyba', 4]);
    // zpráva změněná po podpisu (cestou) → FS ji odmítne kódem 4 → trvalá chyba
    u = await novaUdalost('eet-podpis-2');
    const fs9b = falesnyFs();
    const pozmenit = a => fs9b.transport({ ...a, xml: a.xml.replace(/celk_trzba="[^"]+"/, 'celk_trzba="1.00"') });
    await new Fronta({ db: pool, konfig, transport: pozmenit, log: tichyLog }).zpracovat();
    po = (await q('SELECT * FROM eet_udalosti WHERE id = $1', [u.id]))[0];
    assert.equal(fs9b.prijate[0].podpisOk, false);
    assert.deepEqual([po.stav, (await pokusy(u.id))[0].kod_chyby], ['chyba', 4]);

    // ═══ J) Ověřovací mód: neeviduje, nic nepotvrdí ═══
    const potvrzenychPred = (await q("SELECT COUNT(*)::int n FROM eet_udalosti WHERE stav = 'potvrzeno'"))[0].n;
    const fs10 = falesnyFs();
    const ov = await new Fronta({ db: pool, konfig, transport: fs10.transport, log: tichyLog }).overitSpojeni();
    assert.equal(ov.ok, true, JSON.stringify(ov));
    assert.equal(fs10.prijate[0].overeni, 'true');
    assert.equal((await q("SELECT COUNT(*)::int n FROM eet_udalosti WHERE stav = 'potvrzeno'"))[0].n, potvrzenychPred);
    assert.deepEqual(await q("SELECT udalost_id, vysledek, overeni, pok FROM eet_pokusy WHERE overeni"), [{ udalost_id: null, vysledek: 'overeno', overeni: true, pok: null }]);

    // ═══ K) Okamžité odeslání po COMMIT (LISTEN/NOTIFY), bez čekání na interval ═══
    const fs11 = falesnyFs();
    const fZiva = new Fronta({ db: pool, konfig, transport: fs11.transport, log: tichyLog, intervalMs: 3600e3 });
    fronty.push(fZiva);
    await fZiva.spustit();
    await pockat(100); // první průchod fronty doběhl
    assert.equal(fZiva.stav().posloucha, true);
    const zacatek = Date.now();
    const ziva = (await prodat({ klic: 'eet-ziva-1', platba: 'karta', polozky: [polozka(2, 500)] })).body;
    let stavZive;
    for (let i = 0; i < 100; i++) {
      stavZive = (await udalosti.stavDokladu(pool, 'prodej', ziva.id))[0];
      if (stavZive.stav === 'potvrzeno') break;
      await pockat(20);
    }
    assert.equal(stavZive.stav, 'potvrzeno');
    assert.ok(Date.now() - zacatek < 2000, 'odesláno hned po uložení');
    await fZiva.zastavit();

    // ═══ K2) Okamžité odeslání přímo z požadavku: pokladna dostane POK (test) v odpovědi; výpadek FS = prodej uložen, EET čeká ═══
    const eetFronta = require('../lib/eetFronta');
    const zastavenaOdeslala = fs11.prijate.length;
    const fs12 = falesnyFs({ zpozdeni: 20 });
    const fHlavni = new Fronta({ db: pool, konfig, transport: fs12.transport, log: tichyLog, intervalMs: 3600e3 });
    fronty.push(fHlavni);
    await fHlavni.spustit(); // posluchač NOTIFY běží souběžně s odesláním z požadavku
    eetFronta.nastavitHlavni(fHlavni);
    await pockat(50);
    res = await prodat({ klic: 'eet-ihned-1', platba: 'hotovost', polozky: [polozka(2, 500)] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.eet.length, 1);
    assert.equal(res.body.eet[0].stav, 'potvrzeno', JSON.stringify(res.body.eet));
    assert.match(res.body.eet[0].pok, /-ff$/);
    assert.deepEqual([res.body.eet[0].pok_test, res.body.eet[0].testovaci], [true, true], 'testovací potvrzení je v odpovědi označené jako test');
    const ihned = (await jedna('prodej', res.body.id));
    assert.equal(fs12.prijate.filter(p => p.poradCis === ihned.porad_cis).length, 1, 'posluchač a požadavek neodeslaly zprávu dvakrát');
    assert.equal(fs11.prijate.length, zastavenaOdeslala, 'zastavená fronta už nereaguje na NOTIFY (ani na znovu použitém spojení z poolu)');
    assert.equal((await pokusy(ihned.id))[0].prvni_zaslani, true);
    // výpadek FS: prodej uložený (200), EET „čeká“, nic se nezadává znovu; fronta to pak dokončí
    await fHlavni.zastavit();
    const fs13 = falesnyFs({ scenare: ['sit'] });
    const fVypadek = new Fronta({ db: pool, konfig, transport: fs13.transport, log: tichyLog, intervalMs: 3600e3 });
    eetFronta.nastavitHlavni(fVypadek);
    res = await prodat({ klic: 'eet-ihned-vypadek-1', platba: 'karta', polozky: [polozka(2, 500)] });
    assert.equal(res.statusCode, 200, 'prodej je uložený i při výpadku EET');
    assert.equal(res.body.eet[0].stav, 'ceka');
    assert.match(res.body.eet[0].chyba, /zopakuje/);
    const vypadek = await jedna('prodej', res.body.id);
    await uspisit(vypadek.id);
    await fVypadek.zpracovat();
    assert.equal((await q('SELECT stav FROM eet_udalosti WHERE id = $1', [vypadek.id]))[0].stav, 'potvrzeno');
    assert.deepEqual((await pokusy(vypadek.id)).map(x => x.prvni_zaslani), [true, false]);
    eetFronta.nastavitHlavni(null);

    // ═══ K3) Kontrola řádků bez události: kontaktní příjem zapsaný mimo běžnou cestu se ukáže k rozhodnutí ═══
    assert.deepEqual(await udalosti.nepokryteRadky(pool), [], 'běžné operace nic nepokrytého nenechají');
    const bezUdalosti = (await q("INSERT INTO platby (klic, typ, castka, zpusob, okolnosti, kontaktni, prijato_at, zdroj_typ, zdroj_id) " +
      "VALUES ('eet-bez-udalosti-1', 'prijem', 123, 'hotovost', 'prodejna', true, now(), 'prodej', $1) RETURNING id", [omyl.id]))[0];
    assert.deepEqual((await udalosti.nepokryteRadky(pool)).map(r => [r.druh, r.id]), [['platba', bezUdalosti.id]]);

    // ═══ L) Přehled pro admin ═══
    await novaUdalost('eet-prehled-1'); // jedna čekající
    res = await zavolat(eetRouter, 'get', '/stav');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.produkce_povolena, false);
    assert.ok(res.body.pocty.ceka >= 1 && res.body.pocty.potvrzeno > 10);
    assert.equal(res.body.pocty.chyba, 2);
    assert.ok(res.body.upozorneni.some(t => /trvalou chybou/.test(t)));
    assert.equal(res.body.nepokryte.length, 1);
    assert.ok(res.body.upozorneni.some(t => /bez události EET/.test(t)));
    res = await zavolat(eetRouter, 'get', '/udalosti', { query: { stav: 'ceka' } });
    assert.ok(res.body.length >= 1 && res.body.every(x => x.stav === 'ceka' && typeof x.stari_s === 'number'));
    res = await zavolat(eetRouter, 'get', '/udalosti/:id', { params: { id: String(u1.id) } });
    assert.equal(res.body.pokusy.length, 1);
    assert.equal(res.body.radky.length, 1);
    assert.equal(res.body.zamek_token, undefined);
    assert.equal(res.body.kod_trzby.split('|').length, 6);
    // blížící se lhůta 48 h
    await q("UPDATE eet_udalosti SET zamek_do = NULL WHERE stav = 'ceka'");
    const cek = (await q("SELECT id FROM eet_udalosti WHERE stav = 'ceka' ORDER BY id DESC LIMIT 1"))[0];
    await q('ALTER TABLE eet_udalosti DISABLE TRIGGER eet_udalosti_nemenna');
    await q("UPDATE eet_udalosti SET lhuta_do = now() + interval '2 hours' WHERE id = $1", [cek.id]); // simulace staré tržby
    await q('ALTER TABLE eet_udalosti ENABLE TRIGGER eet_udalosti_nemenna');
    res = await zavolat(eetRouter, 'get', '/stav');
    assert.equal(res.body.neodeslane.blizi_se, 1);
    assert.ok(res.body.upozorneni.some(t => /končí lhůta 48 h/.test(t)));
  } finally {
    for (const f of fronty) await f.zastavit().catch(() => {});
    udalosti.nastavitKonfiguraci(null);
    console.log = puvodniLog;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
