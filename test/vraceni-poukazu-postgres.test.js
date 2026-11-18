// Vrácení peněz za poukaz proti SKUTEČNÉMU PostgreSQL.
// Poukaz nelze směnit za hotovost; peníze se vracejí jen při zákonném odstoupení od nákupu
// poukazu přes e-shop (smlouva na dálku, § 1829 obč. zák.). Vrací se skutečně zaplacená
// částka (§ 1832), lhůta běží od pozdějšího z uzavření smlouvy a převzetí poukazu (doručení
// kódu e-mailem nebo zadaný den převzetí), NE od zaplacení; bez doloženého poučení se
// prodlužuje o rok (§ 1829 odst. 4). Plastová karta koupená online se nevylučuje.
// Před výplatou se v jedné transakci zamknou poukaz, vklady kreditu a původní platba
// a ověří se soulad (lib/souladPoukazu.js).
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

// den v Praze před n dny (RRRR-MM-DD) a odpovídající okamžik v poledne
const predDny = n => dnesVPraze(new Date(Date.now() - n * 86400000));
const pridatDny = (den, n) => { const d = new Date(den + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('PostgreSQL vrácení peněz za poukaz: odstoupení z e-shopu, lhůta, sleva, karta, soulad, regrese, souběh', { skip: preskocit }, async () => {
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
    nacist('objednavky'); nacist('promo'); assert.equal(await vsePripraveno(20000), true);
    const karty = nacist('poukazoveKarty'); assert.equal(await vsePripraveno(20000), true);
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
    // výchozí: odstoupeno dnes, převzato dnes (u poukazu bez zapsaného doručení e-mailem)
    const vratit = (id, body) => zavolat(poukazy, 'post', '/:id/vraceni', { params: { id: String(id) }, body: { odstoupeno_dne: dnes, prevzato_dne: dnes, ...body } });
    const nahled = async (id, prevzato) => (await zavolat(poukazy, 'get', '/:id/vraceni', { params: { id: String(id) }, query: prevzato ? { prevzato_dne: prevzato } : {} })).body;
    const vraceniPenez = async id => (await q("SELECT COALESCE(SUM(castka), 0)::int s FROM platby WHERE typ = 'vraceni' AND zdroj_typ = 'poukaz' AND zdroj_id = $1", [id]))[0].s;
    const stavPoukazu = async id => (await q('SELECT stav, zustatek::int FROM darkove_poukazy WHERE id = $1', [id]))[0];
    const posunout = (id, sloupec, dny) => q(`UPDATE darkove_poukazy SET ${sloupec} = NOW() - ($2 || ' days')::interval WHERE id = $1`, [id, String(dny)]);
    // poukaz koupený v e-shopu a zaplacený (převodem / volnou platbou); s e-mailem se po platbě
    // odešle kód (mock) a zapíše kod_odeslan_at
    let n = 0;
    const eshopovy = async (hodnota = 500, { volnou = false, email = false } = {}) => {
      n++;
      const vytvoren = await zavolat(poukazy, 'post', '/', { body: { klic: `eshop-poukaz-${n}`, hodnota, zakoupeno_kde: 'eshop', ...(email ? { kupujici_email: `zakaznik${n}@example.test` } : {}) } });
      assert.equal(vytvoren.statusCode, 200, JSON.stringify(vytvoren.body));
      let body = { klic: `es-plat-${n}`, zpusob: 'prevod' };
      if (volnou) body = { klic: `es-plat-${n}`, platba_id: (await zavolat(evRouter, 'post', '/volna', { body: { klic: `es-volna-${n}`, zpusob: 'prevod', castka: hodnota } })).body.id };
      const r = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(vytvoren.body.id) }, body });
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      if (email) {
        for (let i = 0; i < 100 && !(await q('SELECT kod_odeslan_at FROM darkove_poukazy WHERE id = $1', [r.body.id]))[0].kod_odeslan_at; i++) await new Promise(ok => setTimeout(ok, 20));
        assert.ok((await q('SELECT kod_odeslan_at FROM darkove_poukazy WHERE id = $1', [r.body.id]))[0].kod_odeslan_at, 'po odeslání e-mailu s kódem se zapíše doručení');
      }
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
    assert.deepEqual(await stavPoukazu(reg.id), { stav: 'aktivni', zustatek: 300 }, 'nesoulad se automaticky neopravuje');
    const kontrola = (await zavolat(evRouter, 'get', '/kontrola')).body;
    const regRozdily = kontrola.rozdily.filter(r => r.doklad === `poukaz ${reg.kod}`);
    assert.ok(regRozdily.length >= 2 && regRozdily.every(r => /zablokované/.test(r.co)), 'Kontrola plateb ukáže problém: ' + JSON.stringify(regRozdily));

    // ── 2) počátek lhůty: převzetí (doručení kódu), ne zaplacení; pozdější z uzavření a převzetí ──
    const lh = await eshopovy(500, { email: true });
    let nl = await nahled(lh.id);
    assert.deepEqual([nl.pocatek, nl.lhuta_do, nl.pouceni_dolozeno], [dnes, pridatDny(dnes, 14), true], 'doručeno dnes s poučením');
    // zaplaceno před 30 dny, smlouva před 31 dny, kód doručen před 10 dny → počátek = doručení
    await q('ALTER TABLE platby DISABLE TRIGGER USER');
    await q("UPDATE platby SET prijato_at = NOW() - interval '30 days' WHERE zdroj_typ = 'poukaz' AND zdroj_id = $1", [lh.id]);
    await q('ALTER TABLE platby ENABLE TRIGGER USER');
    await posunout(lh.id, 'vytvoreno', 31); await posunout(lh.id, 'kod_odeslan_at', 10);
    nl = await nahled(lh.id);
    assert.deepEqual([nl.pocatek, nl.lhuta_do], [predDny(10), pridatDny(predDny(10), 14)], 'datum zaplacení se za převzetí nepovažuje');
    // smlouva uzavřená (poukaz vydaný) až po doručení → počátek = uzavření
    await posunout(lh.id, 'vytvoreno', 3); await posunout(lh.id, 'kod_odeslan_at', 20);
    nl = await nahled(lh.id);
    assert.equal(nl.pocatek, predDny(3), 'pozdější z uzavření a převzetí');
    // doručeno před 20 dny, smlouva před 21 dny: dnes už pozdě, včas oznámené odstoupení projde
    await posunout(lh.id, 'vytvoreno', 21);
    nl = await nahled(lh.id);
    assert.equal(nl.lhuta_do, pridatDny(predDny(20), 14));
    let r = await vratit(lh.id, { klic: 'lhuta-pozde', zpusob: 'prevod', prevzato_dne: undefined });
    assert.equal(r.statusCode, 409, JSON.stringify(r.body)); assert.match(r.body.chyba, /Lhůta pro odstoupení skončila/);
    r = await vratit(lh.id, { klic: 'lhuta-vcas-oznameno', zpusob: 'prevod', prevzato_dne: undefined, odstoupeno_dne: nl.lhuta_do });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));

    // ── 3) doručení není zapsané: správce zadá den převzetí; poučení nedoložené → o rok déle ──
    const bez = await eshopovy(500);
    nl = await nahled(bez.id);
    assert.equal(nl.lze, 500); assert.equal(nl.chybi_prevzeti, true); assert.equal(nl.lhuta_do, null);
    r = await vratit(bez.id, { klic: 'bez-prevzeti', zpusob: 'prevod', prevzato_dne: undefined });
    assert.equal(r.statusCode, 400); assert.match(r.body.chyba, /převzal/);
    r = await vratit(bez.id, { klic: 'prevzeti-budouci', zpusob: 'prevod', prevzato_dne: '2099-01-01' });
    assert.equal(r.statusCode, 400);
    const prevzato = predDny(40);
    nl = await nahled(bez.id, prevzato);
    assert.equal(nl.pouceni_dolozeno, false);
    assert.equal(nl.pocatek, dnes, 'smlouva (vydání poukazu) je pozdější než zadané převzetí');
    await posunout(bez.id, 'vytvoreno', 45);
    nl = await nahled(bez.id, prevzato);
    assert.equal(nl.pocatek, prevzato);
    const zakladni = pridatDny(prevzato, 14);
    assert.equal(nl.lhuta_do, `${Number(zakladni.slice(0, 4)) + 1}${zakladni.slice(4)}`, '§ 1829 odst. 4: bez poučení o jeden rok déle');
    r = await vratit(bez.id, { klic: 'bez-pouceni-ok', zpusob: 'prevod', prevzato_dne: prevzato });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(await vraceniPenez(bez.id), 500);

    // ── 4) nákup se slevou: vrací se skutečně zaplacená částka, zbytek kreditu se zruší bez peněz ──
    // (dnes systém slevu na poukaz neumí – zápis simuluje doklad úhrady 900 Kč za poukaz 1000 Kč)
    const sl = (await zavolat(poukazy, 'post', '/', { body: { klic: 'eshop-sleva-1', hodnota: 1000, zakoupeno_kde: 'eshop' } })).body;
    const ev = require('../lib/evidencePlateb'), kredit = require('../lib/kreditVklady');
    { const c = await pool.connect(); try {
      await c.query('BEGIN');
      const platba = await ev.zapsatPlatbu(c, { klic: 'sleva-platba-1', typ: 'prijem', castka: 900, zpusob: 'prevod', okolnosti: 'eshop', kontaktni: false, zdroj_typ: 'poukaz', zdroj_id: sl.id, urceno_k_cerpani: 900 });
      const akt = (await c.query("UPDATE darkove_poukazy SET stav = 'aktivni', platba_stav = 'zaplaceno' WHERE id = $1 RETURNING *", [sl.id])).rows[0];
      await kredit.nabit(c, { poukaz: akt, castka: 1000, puvod: 'zaplaceny', platba, klic: 'sleva-nabiti-1' });
      await c.query('COMMIT');
    } finally { c.release(); } }
    nl = await nahled(sl.id, dnes);
    assert.deepEqual([nl.lze, nl.hodnota, nl.zaplaceno], [900, 1000, 900]);
    r = await vratit(sl.id, { klic: 'sleva-nominal', zpusob: 'prevod', castka: 1000 });
    assert.equal(r.statusCode, 400, 'nominální hodnotu vrátit nejde'); assert.match(r.body.chyba, /900 Kč/);
    r = await vratit(sl.id, { klic: 'sleva-ok', zpusob: 'prevod', castka: 900 });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(await vraceniPenez(sl.id), 900);
    assert.deepEqual(await q("SELECT typ, castka::int FROM kredit_pohyby WHERE poukaz_id = $1 AND typ IN ('vyplaceni', 'zruseni') ORDER BY id", [sl.id]),
      [{ typ: 'vyplaceni', castka: 900 }, { typ: 'zruseni', castka: 100 }]);
    assert.deepEqual(await stavPoukazu(sl.id), { stav: 'zruseny', zustatek: 0 });

    // ── 5) plastová karta koupená online: nevylučuje se; vratka k účtence prodeje karty ──
    const karta = (await zavolat(karty, 'post', '/', { body: {} })).body;
    assert.ok(karta && karta.ean, JSON.stringify(karta));
    const kp = (await zavolat(poukazy, 'post', '/', { body: { klic: 'karta-online-1', hodnota: 700, karta_ean: karta.ean, platba: 'prevod', zakoupeno_kde: 'eshop' } })).body;
    assert.ok(kp.prodej && kp.karta, JSON.stringify(kp));
    nl = await nahled(kp.id, dnes);
    assert.equal(nl.lze, 700, JSON.stringify(nl));
    r = await vratit(kp.id, { klic: 'karta-online-vr', zpusob: 'prevod' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual(await q('SELECT castka::int, zpusob_vraceni FROM vratky WHERE prodej_id = $1', [kp.prodej.id]), [{ castka: 700, zpusob_vraceni: 'prevod' }]);
    assert.deepEqual(await stavPoukazu(kp.id), { stav: 'zruseny', zustatek: 0 });
    // karta koupená v prodejně: peníze se nevracejí
    const karta2 = (await zavolat(karty, 'post', '/', { body: {} })).body;
    const kp2 = (await zavolat(poukazy, 'post', '/', { body: { klic: 'karta-prodejna-1', hodnota: 700, karta_ean: karta2.ean, platba: 'karta', zakoupeno_kde: 'prodejna' } })).body;
    assert.match((await nahled(kp2.id, dnes)).duvod, /nelze směnit za hotovost/);
    assert.equal((await vratit(kp2.id, { klic: 'karta-prodejna-vr', zpusob: 'karta' })).statusCode, 409);

    // ── 6) platné odstoupení a opakovaný požadavek ──
    const ok = await eshopovy(500, { volnou: true });
    const nOk = await nahled(ok.id, dnes);
    assert.equal(nOk.lze, 500); assert.equal(nOk.duvod, null);
    r = await vratit(ok.id, { klic: 'odst-castecne', zpusob: 'prevod', castka: 200 });
    assert.equal(r.statusCode, 400); assert.match(r.body.chyba, /částečné vrácení/);
    r = await vratit(ok.id, { klic: 'odst-bez-dne', zpusob: 'prevod', odstoupeno_dne: null });
    assert.equal(r.statusCode, 400); assert.match(r.body.chyba, /odstoupil/);
    r = await vratit(ok.id, { klic: 'odst-budouci', zpusob: 'prevod', odstoupeno_dne: '2099-01-01' });
    assert.equal(r.statusCode, 400, 'budoucí den');
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
    assert.deepEqual(await stavPoukazu(ok.id), { stav: 'zruseny', zustatek: 0 });
    r = await prodat({ klic: 'prodej-po-odst', platba: 'poukaz', poukaz_kod: ok.kod, polozky: [polozka(100)] });
    assert.notEqual(r.statusCode, 200, 'zrušený poukaz už nejde použít');

    // ── 7) použitý poukaz: systém peníze nevrátí ──
    const pouzity = await eshopovy(500);
    r = await prodat({ klic: 'pouzity-prodej', platba: 'poukaz', poukaz_kod: pouzity.kod, polozky: [polozka(200)] });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.match((await nahled(pouzity.id, dnes)).duvod, /použitý/);
    r = await vratit(pouzity.id, { klic: 'pouzity-vraceni', zpusob: 'prevod' });
    assert.equal(r.statusCode, 409); assert.equal(await vraceniPenez(pouzity.id), 0);

    // ── 8) souběh čerpání s vrácením: vždy jen jedno z obojího, záznamy sedí ──
    for (let i = 0; i < 6; i++) {
      const sb = await eshopovy(500);
      const [prodej, vraceni] = await Promise.all([
        prodat({ klic: `sb-prodej-${i}`, platba: 'poukaz', poukaz_kod: sb.kod, polozky: [polozka(200)] }),
        vratit(sb.id, { klic: `sb-vraceni-${i}`, zpusob: 'prevod' })
      ]);
      const uspechy = [prodej.statusCode === 200, vraceni.statusCode === 200];
      assert.equal(uspechy.filter(Boolean).length, 1, `souběh ${i}: prodej ${prodej.statusCode}, vrácení ${vraceni.statusCode}`);
      if (uspechy[1]) {
        assert.deepEqual(await stavPoukazu(sb.id), { stav: 'zruseny', zustatek: 0 });
        assert.equal(await vraceniPenez(sb.id), 500);
      } else {
        assert.equal((await stavPoukazu(sb.id)).zustatek, 300);
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
