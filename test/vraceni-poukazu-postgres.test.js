// Vrácení peněz za poukaz proti SKUTEČNÉMU PostgreSQL.
// Peníze za poukaz se vracejí JEN při odstoupení od nákupu nepoužitého poukazu v e-shopu
// (celá hodnota, oznámení do 14 dnů od úhrady). Před výplatou se v jedné transakci
// zamknou poukaz, vklady kreditu a původní platba a ověří se soulad zůstatku, vkladů,
// úhrady a dřívějších vrácení (lib/souladPoukazu.js).
//
// Regrese z ověření návratu (18. 11. 2026): stará verze 98593ee vyčerpá 200 Kč bez zápisu
// kreditu → nová verze těch 200 Kč nesmí vyplatit.
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');
const { dnesVPraze } = require('../lib/poukazPlatnost');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

test('PostgreSQL vrácení peněz za poukaz: jen odstoupení z e-shopu, soulad, regrese staré verze, souběh', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'vraceni_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 15 });
  const puvodniLog = console.log; console.log = () => {};
  const puvodniZamek = process.env.EET_ZAMEK_OD; delete process.env.EET_ZAMEK_OD;
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
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Sandál', 'Značka', 500);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '25', 1000);
    `);
    const mocky = { '../db/pool': pool, './emaily': new Proxy({}, { get: () => async () => {} }) };
    const nacist = r => nacistRouterSMocky('../routes/' + r + '.js', mocky);
    const prodejna = nacist('prodejna'); assert.equal(await vsePripraveno(20000), true);
    const poukazy = nacist('poukazy'); assert.equal(await vsePripraveno(20000), true);
    nacist('objednavky'); nacist('promo'); nacist('poukazoveKarty'); assert.equal(await vsePripraveno(20000), true);
    const evRouter = nacist('evidencePlateb'); assert.equal(await vsePripraveno(20000), true);

    const zavolat = async (router, metoda, cesta, req = {}) => {
      const res = vytvoritRes();
      await najitHandler(router, metoda, cesta)({ params: {}, query: {}, ip: '10.5.5.' + Math.floor(Math.random() * 250), ...req }, res);
      return res;
    };
    const q = async (sql, p) => (await pool.query(sql, p)).rows;
    const dnes = dnesVPraze();
    const polozka = cena => ({ produkt_id: 1, nazev: 'Sandál', velikost: '25', pocet: 1, cena });
    const prodat = body => zavolat(prodejna, 'post', '/', { body: { potvrdit_duplicitu: true, ...body } });
    const vratit = (id, body) => zavolat(poukazy, 'post', '/:id/vraceni', { params: { id: String(id) }, body: { odstoupeno_dne: dnes, ...body } });
    const nahled = async id => (await zavolat(poukazy, 'get', '/:id/vraceni', { params: { id: String(id) } })).body;
    const vraceniPenez = async id => (await q("SELECT COALESCE(SUM(castka), 0)::int s FROM platby WHERE typ = 'vraceni' AND zdroj_typ = 'poukaz' AND zdroj_id = $1", [id]))[0].s;
    // poukaz koupený v e-shopu, zaplacený (převodem / volnou platbou)
    let n = 0;
    const eshopovy = async (hodnota = 500, volnou = false) => {
      n++;
      const vytvoren = await zavolat(poukazy, 'post', '/', { body: { klic: `eshop-poukaz-${n}`, hodnota, zakoupeno_kde: 'eshop' } });
      assert.equal(vytvoren.statusCode, 200, JSON.stringify(vytvoren.body));
      const p = vytvoren.body;
      let body = { klic: `es-plat-${n}`, zpusob: 'prevod' };
      if (volnou) body = { klic: `es-plat-${n}`, platba_id: (await zavolat(evRouter, 'post', '/volna', { body: { klic: `es-volna-${n}`, zpusob: 'prevod', castka: hodnota } })).body.id };
      const r = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(p.id) }, body });
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      return r.body;
    };

    // ── 1) REGRESE: stará verze vyčerpá 200 Kč bez zápisu kreditu → nová verze je nevyplatí ──
    const reg = await eshopovy(500);
    assert.equal((await nahled(reg.id)).lze, 500, 'před zásahem staré verze jde odstoupit');
    // přesně to, co dělá /api/poukazy/pouzit ve verzi 98593ee: zůstatek a použití, bez kreditu
    await q("UPDATE darkove_poukazy SET zustatek = $1, stav = $2 WHERE id = $3", [300, 'aktivni', reg.id]);
    await q('INSERT INTO poukazy_pouziti (poukaz_id, castka, prodej_id) VALUES ($1, $2, NULL)', [reg.id, 200]);
    const nReg = await nahled(reg.id);
    assert.equal(nReg.lze, 0);
    assert.match(nReg.duvod, /nesedí/);
    assert.ok(nReg.nesoulad.some(t => /300 Kč nesedí s pohyby kreditu 500 Kč/.test(t)), JSON.stringify(nReg.nesoulad));
    for (const castka of [undefined, 200, 300, 500]) {
      const r = await vratit(reg.id, { klic: 'regrese-' + castka, zpusob: 'prevod', ...(castka ? { castka } : {}) });
      assert.equal(r.statusCode, 409, `výplata ${castka} Kč musí být odmítnutá: ` + JSON.stringify(r.body));
      assert.match(r.body.chyba, /nesedí/);
    }
    assert.equal(await vraceniPenez(reg.id), 0, 'nevyplatilo se nic');
    assert.equal((await q("SELECT COUNT(*)::int n FROM kredit_pohyby WHERE poukaz_id = $1 AND typ IN ('vyplaceni', 'zruseni')", [reg.id]))[0].n, 0, 'kredit se neopravil ani nezrušil');
    const regPo = (await q('SELECT stav, zustatek::int FROM darkove_poukazy WHERE id = $1', [reg.id]))[0];
    assert.deepEqual(regPo, { stav: 'aktivni', zustatek: 300 }, 'nesoulad se automaticky neopravuje');
    const kontrola = (await zavolat(evRouter, 'get', '/kontrola')).body;
    const regRozdily = kontrola.rozdily.filter(r => r.doklad === `poukaz ${reg.kod}`);
    assert.ok(regRozdily.length >= 2 && regRozdily.every(r => /zablokované/.test(r.co)), 'Kontrola plateb ukáže problém: ' + JSON.stringify(regRozdily));

    // ── 2) platné odstoupení (celá hodnota) a opakovaný požadavek ──
    const ok = await eshopovy(500, true);
    const nOk = await nahled(ok.id);
    assert.equal(nOk.lze, 500); assert.equal(nOk.duvod, null); assert.ok(nOk.lhuta_do > dnes);
    // částečné vrácení peněz za poukaz neexistuje
    let r = await vratit(ok.id, { klic: 'odst-castecne', zpusob: 'prevod', castka: 200 });
    assert.equal(r.statusCode, 400); assert.match(r.body.chyba, /celá hodnota/);
    r = await vratit(ok.id, { klic: 'odst-bez-dne', zpusob: 'prevod', odstoupeno_dne: null });
    assert.equal(r.statusCode, 400); assert.match(r.body.chyba, /odstoupil/);
    r = await vratit(ok.id, { klic: 'odst-budouci', zpusob: 'prevod', odstoupeno_dne: '2099-01-01' });
    assert.equal(r.statusCode, 400, 'budoucí den');
    // po lhůtě: úhrada před 20 dny (posunutý čas přiřazení i poukazu)
    const pozde = await eshopovy(500);
    await q("ALTER TABLE platby DISABLE TRIGGER USER");
    await q("UPDATE platby SET prijato_at = NOW() - interval '20 days' WHERE zdroj_typ = 'poukaz' AND zdroj_id = $1", [pozde.id]);
    await q("ALTER TABLE platby ENABLE TRIGGER USER");
    await q("UPDATE darkove_poukazy SET vytvoreno = NOW() - interval '20 days' WHERE id = $1", [pozde.id]);
    r = await vratit(pozde.id, { klic: 'odst-po-lhute', zpusob: 'prevod' });
    assert.equal(r.statusCode, 409, JSON.stringify(r.body)); assert.match(r.body.chyba, /Lhůta pro odstoupení skončila/);
    // včas oznámené odstoupení jde zpracovat i po lhůtě
    const oznameno = (await nahled(pozde.id)).lhuta_do;
    r = await vratit(pozde.id, { klic: 'odst-vcas-ozn', zpusob: 'prevod', odstoupeno_dne: oznameno });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    // stejný klíč 3× souběžně = jedna výplata
    const tri = await Promise.all([1, 2, 3].map(() => vratit(ok.id, { klic: 'odst-platne-1', zpusob: 'prevod', castka: 500 })));
    assert.ok(tri.every(x => x.statusCode === 200), JSON.stringify(tri.map(x => x.body)));
    assert.equal(tri.filter(x => x.body.opakovane).length, 2);
    r = await vratit(ok.id, { klic: 'odst-platne-1', zpusob: 'hotovost', castka: 500 });
    assert.equal(r.statusCode, 409, 'stejný klíč s jiným obsahem');
    r = await vratit(ok.id, { klic: 'odst-platne-2', zpusob: 'prevod' });
    assert.equal(r.statusCode, 409, 'jiný klíč: poukaz už je zrušený');
    assert.equal(await vraceniPenez(ok.id), 500);
    const volnaId = (await q('SELECT platba_id FROM platby_prirazeni WHERE poukaz_id = $1', [ok.id]))[0].platba_id;
    assert.deepEqual(await q("SELECT castka::int, vraci_id FROM platby WHERE typ = 'vraceni' AND zdroj_typ = 'poukaz' AND zdroj_id = $1", [ok.id]), [{ castka: 500, vraci_id: volnaId }]);
    assert.deepEqual(await q("SELECT typ, castka::int FROM kredit_pohyby WHERE poukaz_id = $1 AND typ IN ('vyplaceni', 'zruseni')", [ok.id]), [{ typ: 'vyplaceni', castka: 500 }]);
    assert.deepEqual((await q('SELECT stav, zustatek::int FROM darkove_poukazy WHERE id = $1', [ok.id]))[0], { stav: 'zruseny', zustatek: 0 });
    // zrušený poukaz už nejde použít
    r = await prodat({ klic: 'prodej-po-odst', platba: 'poukaz', poukaz_kod: ok.kod, polozky: [polozka(100)] });
    assert.notEqual(r.statusCode, 200);

    // ── 3) použitý poukaz: od použitého se neodstupuje ──
    const pouzity = await eshopovy(500);
    r = await prodat({ klic: 'pouzity-prodej', platba: 'poukaz', poukaz_kod: pouzity.kod, polozky: [polozka(200)] });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.match((await nahled(pouzity.id)).duvod, /použitý/);
    r = await vratit(pouzity.id, { klic: 'pouzity-vraceni', zpusob: 'prevod' });
    assert.equal(r.statusCode, 409); assert.equal(await vraceniPenez(pouzity.id), 0);

    // ── 4) souběh čerpání s vrácením: vždy jen jedno z obojího, záznamy sedí ──
    for (let i = 0; i < 6; i++) {
      const sb = await eshopovy(500);
      const [prodej, vraceni] = await Promise.all([
        prodat({ klic: `sb-prodej-${i}`, platba: 'poukaz', poukaz_kod: sb.kod, polozky: [polozka(200)] }),
        vratit(sb.id, { klic: `sb-vraceni-${i}`, zpusob: 'prevod' })
      ]);
      const uspechy = [prodej.statusCode === 200, vraceni.statusCode === 200];
      assert.equal(uspechy.filter(Boolean).length, 1, `souběh ${i}: prodej ${prodej.statusCode}, vrácení ${vraceni.statusCode}`);
      const stav = (await q('SELECT stav, zustatek::int FROM darkove_poukazy WHERE id = $1', [sb.id]))[0];
      if (uspechy[1]) {
        assert.deepEqual(stav, { stav: 'zruseny', zustatek: 0 });
        assert.equal(await vraceniPenez(sb.id), 500);
      } else {
        assert.equal(stav.zustatek, 300);
        assert.equal(await vraceniPenez(sb.id), 0);
      }
    }

    // Kontrola plateb: jediné rozdíly jsou u poukazu poškozeného starou verzí
    const k2 = (await zavolat(evRouter, 'get', '/kontrola')).body;
    assert.deepEqual([...new Set(k2.rozdily.map(x => x.doklad))], [`poukaz ${reg.kod}`], JSON.stringify(k2.rozdily));
  } finally {
    console.log = puvodniLog;
    if (puvodniZamek !== undefined) process.env.EET_ZAMEK_OD = puvodniZamek;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
