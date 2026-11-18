// Dokončení kroku 2 proti SKUTEČNÉMU PostgreSQL: vrácení zaplaceného poukazu, strop peněz
// u výměny (smíšené úhrady, souběh), částečné přiřazení a jeho storno, původ vráceného
// kreditu, ochrana dokladů s událostí EET nezávislá na EET_ZAMEK_OD.
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

test('PostgreSQL opravy kroku 2: vrácení poukazu, výměna, přiřazení, původ kreditu, ochrana EET', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'opravy_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
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
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Bota', 'Značka', 1000), ('Sandál', 'Značka', 500);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 100), (2, '25', 100);
    `);
    const mocky = { '../db/pool': pool, './emaily': new Proxy({}, { get: () => async () => {} }) };
    const nacist = r => nacistRouterSMocky('../routes/' + r + '.js', mocky);
    const prodejna = nacist('prodejna'); assert.equal(await vsePripraveno(20000), true);
    const poukazy = nacist('poukazy'); assert.equal(await vsePripraveno(20000), true);
    const objednavky = nacist('objednavky'); assert.equal(await vsePripraveno(20000), true);
    nacist('promo'); nacist('poukazoveKarty'); assert.equal(await vsePripraveno(20000), true);
    const evRouter = nacist('evidencePlateb'); assert.equal(await vsePripraveno(20000), true);
    nacist('evidencePlateb'); assert.equal(await vsePripraveno(20000), true); // migrace 2×

    const zavolat = async (router, metoda, cesta, req = {}) => {
      const res = vytvoritRes();
      await najitHandler(router, metoda, cesta)({ params: {}, query: {}, ip: '10.4.4.' + Math.floor(Math.random() * 250), ...req }, res);
      return res;
    };
    const q = async (sql, p) => (await pool.query(sql, p)).rows;
    const kredit = require('../lib/kreditVklady');
    const prodat = body => zavolat(prodejna, 'post', '/', { body: { potvrdit_duplicitu: true, ...body } });
    const polozka = (produkt, cena, pocet = 1) => ({ produkt_id: produkt, nazev: produkt === 1 ? 'Bota' : 'Sandál', velikost: produkt === 1 ? '24' : '25', pocet, cena });
    const ucet = async () => (await q(`SELECT (SELECT COALESCE(SUM(celkem),0) FROM prodejna_prodeje)::int AS prodejna, (SELECT COALESCE(SUM(castka),0) FROM vratky)::int AS vratky`))[0];

    // ── 1) vrácení zaplaceného poukazu ──
    let res = await zavolat(poukazy, 'post', '/', { body: { klic: 'vr-poukaz-1', hodnota: 1000, platba: 'karta', zakoupeno_kde: 'prodejna' } });
    const pk = res.body;
    res = await prodat({ klic: 'vr-cerpani-1', platba: 'poukaz', poukaz_kod: pk.kod, polozky: [polozka(2, 300)] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    let n = await zavolat(poukazy, 'get', '/:id/vraceni', { params: { id: String(pk.id) } });
    assert.deepEqual([n.body.lze, n.body.zaplaceno, n.body.vraceno, n.body.zaplaceny_kredit], [700, 1000, 0, 700], 'vyčerpaný kredit se vrátit nedá');
    assert.equal((await zavolat(poukazy, 'post', '/:id/vraceni', { params: { id: String(pk.id) }, body: { klic: 'vr-moc-1', zpusob: 'karta', castka: 800 } })).statusCode, 400);
    const ucetPred = await ucet();
    const tri = await Promise.all([1, 2, 3].map(() => zavolat(poukazy, 'post', '/:id/vraceni', { params: { id: String(pk.id) }, body: { klic: 'vraceni-ok-1', zpusob: 'karta' } })));
    assert.ok(tri.every(r => r.statusCode === 200), JSON.stringify(tri.map(r => r.body)));
    const jiny = await zavolat(poukazy, 'post', '/:id/vraceni', { params: { id: String(pk.id) }, body: { klic: 'vr-znovu-1', zpusob: 'hotovost' } });
    assert.equal(jiny.statusCode, 409, 'podruhé (jiný klíč) už nic');
    const poVraceni = (await q('SELECT stav, zustatek FROM darkove_poukazy WHERE id = $1', [pk.id]))[0];
    assert.deepEqual([poVraceni.stav, Number(poVraceni.zustatek)], ['zruseny', 0]);
    const puvodniPlatba = (await q("SELECT * FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1 AND typ = 'prijem'", [pk.prodej.id]))[0];
    assert.equal(Number(puvodniPlatba.castka), 1000, 'původní platba zachovaná');
    assert.deepEqual(await q("SELECT typ, castka::int, zdroj_typ, vraci_id FROM platby WHERE typ = 'vraceni' AND vraci_id = $1", [puvodniPlatba.id]),
      [{ typ: 'vraceni', castka: 700, zdroj_typ: 'vratka', vraci_id: puvodniPlatba.id }]);
    assert.equal((await q('SELECT COUNT(*)::int n FROM vratky WHERE prodej_id = $1', [pk.prodej.id]))[0].n, 1, 'vratka k účtence prodeje poukazu');
    assert.deepEqual(await ucet(), { prodejna: ucetPred.prodejna, vratky: ucetPred.vratky + 700 }, 'Účetnictví: tržby sníženy přes vratku');
    assert.deepEqual((await q("SELECT typ, castka::int FROM kredit_pohyby WHERE poukaz_id = $1 AND typ IN ('vyplaceni', 'zruseni')", [pk.id])), [{ typ: 'vyplaceni', castka: 700 }]);
    // smíšený kredit: e-shop poukaz zaplacený volnou platbou + připsaný kredit bez vazby → vrátit jde jen zaplacený
    const volna = (await zavolat(evRouter, 'post', '/volna', { body: { klic: 'vr-volna-1', zpusob: 'prevod', castka: 500 } })).body;
    const ep = (await zavolat(poukazy, 'post', '/', { body: { klic: 'vr-eshop-1', hodnota: 500, zakoupeno_kde: 'eshop' } })).body;
    assert.equal((await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(ep.id) }, body: { klic: 'vr-eshop-plat', platba_id: volna.id } })).statusCode, 200);
    await prodat({ klic: 'vr-eshop-cerp', platba: 'poukaz', poukaz_kod: ep.kod, polozky: [polozka(2, 200)] });
    assert.equal((await zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(ep.id) }, body: { klic: 'vr-eshop-prip', castka: 100 } })).statusCode, 200);
    n = await zavolat(poukazy, 'get', '/:id/vraceni', { params: { id: String(ep.id) } });
    assert.equal(n.body.lze, 300, 'zůstatek 400, z toho zaplaceného 300 (připsaný bez vazby se nevyplácí)');
    res = await zavolat(poukazy, 'post', '/:id/vraceni', { params: { id: String(ep.id) }, body: { klic: 'vr-eshop-vrat', zpusob: 'prevod' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual((await q("SELECT typ, castka::int FROM kredit_pohyby WHERE poukaz_id = $1 AND typ IN ('vyplaceni', 'zruseni') ORDER BY id", [ep.id])),
      [{ typ: 'vyplaceni', castka: 300 }, { typ: 'zruseni', castka: 100 }]);
    assert.deepEqual(await q("SELECT zdroj_typ, vraci_id FROM platby WHERE typ = 'vraceni' AND zdroj_typ = 'poukaz' AND zdroj_id = $1", [ep.id]), [{ zdroj_typ: 'poukaz', vraci_id: volna.id }]);
    assert.equal((await q('SELECT COUNT(*)::int n FROM platby_prirazeni WHERE poukaz_id = $1', [ep.id]))[0].n, 1, 'přiřazení původní platby zůstává');
    // darovaný poukaz: peníze vrátit nejde
    const dar = (await zavolat(poukazy, 'post', '/', { body: { klic: 'vr-dar-1', hodnota: 500, druh: 'dar', zakoupeno_kde: 'prodejna' } })).body;
    n = await zavolat(poukazy, 'get', '/:id/vraceni', { params: { id: String(dar.id) } });
    assert.equal(n.body.lze, 0); assert.match(n.body.duvod, /darovaný nebo historický/);

    // ── 2) výměna: penězi nejvýš peníze z původní účtenky ──
    const pk2 = (await zavolat(poukazy, 'post', '/', { body: { klic: 'vymena-poukaz-1', hodnota: 1000, platba: 'karta', zakoupeno_kde: 'prodejna' } })).body;
    res = await prodat({ klic: 'vymena-smisena-1', platba: 'poukaz', poukaz_kod: pk2.kod, doplatek_platba: 'karta', polozky: [polozka(1, 1200)] });
    const smisena = res.body; // 1000 poukazem + 200 kartou
    const vymena = (klic, prodejId, vracene, nove, zapocet, platba = 'hotovost') => zavolat(prodejna, 'post', '/vymeny', { body: { klic, prodej_id: prodejId, vracene, nove, zapocet, platba } });
    res = await vymena('vymena-moc-1', smisena.id, [polozka(1, 1200)], [polozka(2, 500)], 1200);
    assert.equal(res.statusCode, 400, 'rozdíl 700 > 200 Kč zaplacených penězi');
    assert.match(res.body.chyba, /nejvýš 200 Kč/);
    res = await vymena('vymena-ok-1', smisena.id, [polozka(1, 1200)], [polozka(2, 500, 2)], 1200);
    assert.equal(res.statusCode, 200, 'rozdíl 200 = peníze z účtenky: ' + JSON.stringify(res.body));
    // účtenka zaplacená jen darovaným poukazem: penězi nic
    const dar2 = (await zavolat(poukazy, 'post', '/', { body: { klic: 'vymena-dar-1', hodnota: 1000, druh: 'dar', zakoupeno_kde: 'prodejna' } })).body;
    const darem = (await prodat({ klic: 'vymena-darem-1', platba: 'poukaz', poukaz_kod: dar2.kod, polozky: [polozka(1, 900)] })).body;
    res = await vymena('vymena-darem-v', darem.id, [polozka(1, 900)], [polozka(2, 500)], 900);
    assert.equal(res.statusCode, 400, 'hodnotu z daru nejde vyplatit penězi');
    // historická účtenka (bez evidence) placená poukazem: strop podle dokladu = 0
    const hist = (await q(`INSERT INTO prodejna_prodeje (platba, polozky, celkem, vytvoreno) VALUES ('poukaz', $1, 800, '2026-01-05') RETURNING id`, [JSON.stringify([polozka(1, 800)])]))[0];
    res = await vymena('vymena-hist-1', hist.id, [polozka(1, 800)], [polozka(2, 500)], 800);
    assert.equal(res.statusCode, 400, 'historická účtenka poukazem: penězi nic');
    // souběh: účtenka 2× bota po 750, 1000 poukazem + 500 kartou; dvě výměny po 300 Kč rozdílu → projde jedna
    const pk3 = (await zavolat(poukazy, 'post', '/', { body: { klic: 'vymena-poukaz-3', hodnota: 1000, platba: 'karta', zakoupeno_kde: 'prodejna' } })).body;
    const dvaRes = await prodat({ klic: 'vymena-dva-1', platba: 'poukaz', poukaz_kod: pk3.kod, doplatek_platba: 'karta', polozky: [polozka(1, 750, 2)] });
    assert.equal(dvaRes.statusCode, 200, JSON.stringify(dvaRes.body));
    const dva = dvaRes.body;
    const soubeh = await Promise.all([1, 2].map(i => vymena('vymena-soubeh-' + i, dva.id, [polozka(1, 750)], [polozka(2, 450)], 750)));
    assert.deepEqual(soubeh.map(r => r.statusCode).sort(), [200, 400], 'druhá výměna by překročila 500 Kč zaplacených kartou: ' + JSON.stringify(soubeh.map(r => r.body)));
    // vratka po výměně: z 500 Kč zbývá vrátit penězi 200 → 250 neprojde
    res = await zavolat(prodejna, 'post', '/vratky', { body: { klic: 'vymena-vratka-po', prodej_id: dva.id, polozky: [polozka(1, 500)].map(({ produkt_id, velikost }) => ({ produkt_id, velikost, pocet: 1 })), castka: 250, zpusob_vraceni: 'hotovost' } });
    assert.equal(res.statusCode, 400);

    // ── 3) částečné přiřazení: součty, souběh, opakování, storno ──
    const obj = async (celkem, cislo) => (await q(`INSERT INTO objednavky (stav, celkem, doprava, platba, cislo) VALUES ('nova', $1, 'zasilkovna', 'prevod', $2) RETURNING id`, [celkem, cislo]))[0].id;
    const o1 = await obj(700, 'P-1'), o2 = await obj(600, 'P-2'), o3 = await obj(800, 'P-3');
    const v1 = (await zavolat(evRouter, 'post', '/volna', { body: { klic: 'pr-volna-1', zpusob: 'prevod', castka: 1000 } })).body;
    const priradit = (o, klic, platba_id, castka) => zavolat(objednavky, 'post', '/:id/platby', { params: { id: String(o) }, body: { klic, platba_id, castka } });
    res = await Promise.all([priradit(o1, 'prirazeni-o1', v1.id, 700), priradit(o2, 'prirazeni-o2', v1.id, 600)]);
    assert.deepEqual(res.map(r => r.statusCode).sort(), [200, 400], 'jedna platba 1000 nepokryje 700 + 600: ' + JSON.stringify(res.map(r => r.body)));
    const prvni = res.find(r => r.statusCode === 200).body.objednavka.id;
    // dvě volné platby na jednu objednávku souběžně: součet nepřekročí dluh
    const v2 = (await zavolat(evRouter, 'post', '/volna', { body: { klic: 'pr-volna-2', zpusob: 'prevod', castka: 500 } })).body;
    const v3 = (await zavolat(evRouter, 'post', '/volna', { body: { klic: 'pr-volna-3', zpusob: 'prevod', castka: 500 } })).body;
    res = await Promise.all([priradit(o3, 'prirazeni-o3a', v2.id, 500), priradit(o3, 'prirazeni-o3b', v3.id, 500)]);
    assert.deepEqual(res.map(r => r.statusCode).sort(), [200, 400], 'objednávka 800 nepřijme 2× 500: ' + JSON.stringify(res.map(r => r.body)));
    res = await priradit(o3, 'prirazeni-o3c', v3.id, null); // zbytek dluhu
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.prijato, res.body.objednavka.stav], [800, 'zaplacena']);
    // opakování stejného klíče = jedno přiřazení
    const o4 = await obj(300, 'P-4');
    const v4 = (await zavolat(evRouter, 'post', '/volna', { body: { klic: 'pr-volna-4', zpusob: 'prevod', castka: 300 } })).body;
    const opak = await Promise.all([1, 2, 3].map(() => priradit(o4, 'pr-opak-1', v4.id, 300)));
    assert.ok(opak.every(r => r.statusCode === 200), JSON.stringify(opak.map(r => r.body)));
    assert.equal((await q('SELECT COUNT(*)::int n FROM platby_prirazeni WHERE objednavka_id = $1', [o4]))[0].n, 1, '3× stejný klíč = jedno přiřazení');
    // storno přiřazení: objednávka zpět mezi nezaplacené, platba zase volná, podruhé nic
    const prO3 = (await q('SELECT id, platba_id FROM platby_prirazeni WHERE objednavka_id = $1 ORDER BY id LIMIT 1', [o3]))[0];
    const st = await Promise.all([1, 2].map(i => zavolat(evRouter, 'post', '/prirazeni/:id/storno', { params: { id: String(prO3.id) }, body: { klic: 'pr-storno-' + i } })));
    assert.deepEqual(st.map(r => r.statusCode).sort(), [200, 409], 'storno nejvýš jednou');
    const poStornu = st.find(r => r.statusCode === 200).body;
    assert.equal(poStornu.stav_objednavky, 'vyrizuje');
    assert.equal((await q('SELECT stav, zaplaceno_at FROM objednavky WHERE id = $1', [o3]))[0].zaplaceno_at, null);
    const volno = (await zavolat(evRouter, 'get', '/volne')).body.find(p => p.id === prO3.platba_id).volno;
    assert.ok(volno >= 500, 'platba je zase volná');
    await q("UPDATE objednavky SET stav = 'odeslana' WHERE id = $1", [prvni]);
    const prPrvni = (await q('SELECT id FROM platby_prirazeni WHERE objednavka_id = $1', [prvni]))[0];
    assert.equal((await zavolat(evRouter, 'post', '/prirazeni/:id/storno', { params: { id: String(prPrvni.id) }, body: { klic: 'pr-storno-odesl' } })).statusCode, 409);
    // uhrazený stav = součet platných úhrad (všechny objednávky)
    for (const o of await q("SELECT id, stav, celkem FROM objednavky WHERE platba = 'prevod'")) {
      const prijato = await require('../lib/evidencePlateb').prijatoNaObjednavku(pool, o.id);
      if (o.stav === 'zaplacena') assert.ok(prijato >= Number(o.celkem), `objednávka ${o.id} zaplacená bez úhrad`);
      if (o.stav === 'nova' || o.stav === 'vyrizuje') assert.ok(prijato < Number(o.celkem), `objednávka ${o.id} uhrazená, ale nezaplacená`);
      assert.ok(prijato <= Number(o.celkem), 'přiřazení nepřekročí dluh');
    }
    for (const p of (await zavolat(evRouter, 'get', '/volne')).body) assert.ok(p.volno >= 0, 'přiřazení nepřekročí platbu');

    // ── 4) původ: vrácený kredit drží vazbu na zdroj a jeho pravidlo EET ──
    const pm = (await q(`INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, druh, platba_stav)
      VALUES ('DK-MIX-0002', '2100000000777', 500, 500, '2099-12-31', 'aktivni', 'prodejna', 'prodej', 'zaplaceno') RETURNING *`))[0];
    { const c = await pool.connect(); await c.query('BEGIN');
      await kredit.nabit(c, { poukaz: pm, castka: 300, puvod: 'zaplaceny', platba: { id: null, kontaktni: true }, klic: 'mix2:zapl' });
      await kredit.nabit(c, { poukaz: pm, castka: 200, puvod: 'darovany', platba: null, klic: 'mix2:dar' });
      await c.query('COMMIT'); c.release(); }
    const smis = (await prodat({ klic: 'mix2-prodej', platba: 'poukaz', poukaz_kod: pm.kod, polozky: [polozka(2, 500)] })).body;
    const vratkaMix = (await zavolat(prodejna, 'post', '/vratky', { body: { klic: 'mix2-vratka', prodej_id: smis.id, polozky: [{ produkt_id: 2, velikost: '25', pocet: 1 }], castka: 0 } })).body;
    res = await zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(pm.id) }, body: { klic: 'mix2-pripsat', castka: 250, vratka_id: vratkaMix.id } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    // v opačném pořadí, než se čerpalo: nejdřív darovaná část (200), pak zaplacená (50)
    assert.deepEqual(await q(`SELECT v.puvod, v.eet_zaklad, v.castka::int, zv.puvod AS zdroj_puvod FROM kredit_vklady v
      JOIN kredit_vklady_zdroje z ON z.vklad_id = v.id JOIN kredit_casti c ON c.id = z.zdroj_cast_id JOIN kredit_vklady zv ON zv.id = c.vklad_id
      WHERE v.poukaz_id = $1 AND v.puvod = 'vraceny' ORDER BY v.id`, [pm.id]),
      [{ puvod: 'vraceny', eet_zaklad: 'darovany', castka: 200, zdroj_puvod: 'darovany' }, { puvod: 'vraceny', eet_zaklad: 'zaplaceny', castka: 50, zdroj_puvod: 'zaplaceny' }]);
    // nové čerpání vráceného kreditu: darovaný základ zůstává nevyřešený
    const znovu = (await prodat({ klic: 'mix2-znovu', platba: 'poukaz', poukaz_kod: pm.kod, polozky: [polozka(2, 250)] })).body;
    const casti = await q(`SELECT c.castka::int, c.eet_pravidlo, v.eet_zaklad FROM kredit_casti c JOIN kredit_pohyby k ON k.id = c.kredit_pohyb_id JOIN kredit_vklady v ON v.id = c.vklad_id
      WHERE k.zdroj_typ = 'prodej' AND k.zdroj_id = $1 AND k.typ = 'cerpani' ORDER BY c.id`, [znovu.id]);
    assert.deepEqual(casti.map(c => [c.eet_zaklad, c.eet_pravidlo]).sort(), [['darovany', 'nevyreseno'], ['zaplaceny', 'cerp_zuct']]);
    assert.equal((await zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(pm.id) }, body: { klic: 'mix2-pripsat-2', castka: 251, vratka_id: vratkaMix.id } })).statusCode, 400, 'víc, než se čerpalo a nevrátilo');
    // historický poukaz s dokladem prodeje = zaplacený, bez dokladu = nedoložený
    const hp = (await q(`INSERT INTO prodejna_prodeje (platba, polozky, celkem, vytvoreno) VALUES ('hotovost', '[]', 400, '2026-01-02') RETURNING id`))[0].id;
    await q(`INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, druh, vydano_prodej_id, platba_stav)
      VALUES ('DK-HP-0001', '2100000000888', 400, 400, '2099-12-31', 'aktivni', 'prodejna', 'prodej', $1, 'historicky'),
             ('DK-HP-0002', '2100000000895', 400, 400, '2099-12-31', 'aktivni', 'eshop', 'prodej', NULL, 'historicky')`, [hp]);
    await prodat({ klic: 'hist-prodej-1', platba: 'poukaz', poukaz_kod: 'DK-HP-0001', polozky: [polozka(2, 100)] });
    await prodat({ klic: 'hist-prodej-2', platba: 'poukaz', poukaz_kod: 'DK-HP-0002', polozky: [polozka(2, 100)] });
    assert.deepEqual(await q(`SELECT d.kod, v.puvod FROM kredit_vklady v JOIN darkove_poukazy d ON d.id = v.poukaz_id WHERE d.kod LIKE 'DK-HP-%' ORDER BY d.kod`),
      [{ kod: 'DK-HP-0001', puvod: 'zaplaceny' }, { kod: 'DK-HP-0002', puvod: 'nedolozeny' }]);

    // ── 5) událost EET chrání doklad i bez EET_ZAMEK_OD ──
    const evProdej = (await prodat({ klic: 'eet-prodej-1', platba: 'hotovost', polozky: [polozka(2, 400)] })).body;
    await q("INSERT INTO eet_udalosti (klic, zdroj_typ, zdroj_id) VALUES ('eet:prodej:test', 'prodej', $1)", [evProdej.id]);
    assert.equal(process.env.EET_ZAMEK_OD, undefined);
    assert.equal((await zavolat(prodejna, 'delete', '/:id', { params: { id: String(evProdej.id) } })).statusCode, 409);
    assert.equal((await zavolat(prodejna, 'put', '/:id', { params: { id: String(evProdej.id) }, body: { platba: 'karta' } })).statusCode, 409);
    assert.equal((await zavolat(prodejna, 'put', '/:id', { params: { id: String(evProdej.id) }, body: { platba: 'hotovost', poznamka: 'jen poznámka' } })).statusCode, 200);
    await assert.rejects(q('UPDATE prodejna_prodeje SET celkem = 1 WHERE id = $1', [evProdej.id]), /událost EET/, 'přímý zásah do DB');
    await assert.rejects(q('DELETE FROM prodejna_prodeje WHERE id = $1', [evProdej.id]), /událost EET/);
    await assert.rejects(q("DELETE FROM eet_udalosti WHERE klic = 'eet:prodej:test'"), /nejde smazat/);
    await assert.rejects(q("UPDATE eet_udalosti SET zdroj_id = 0 WHERE klic = 'eet:prodej:test'"), /přesměrovat/);
    await q("UPDATE eet_udalosti SET stav = 'chyba' WHERE klic = 'eet:prodej:test'"); // stav měnit jde (podle povolených přechodů)
    // zpětné datování nepomůže: datum je chráněný sloupec a zámek podle data vzniku
    await assert.rejects(q("UPDATE prodejna_prodeje SET datum = '2020-01-01' WHERE id = $1", [evProdej.id]), /událost EET/);
    // poukaz s událostí: dar ani smazání
    const evPoukaz = (await zavolat(poukazy, 'post', '/', { body: { klic: 'eet-poukaz-1', hodnota: 500, platba: 'karta', zakoupeno_kde: 'prodejna' } })).body;
    await q("INSERT INTO eet_udalosti (klic, zdroj_typ, zdroj_id) VALUES ('eet:prodej:poukaz', 'prodej', $1)", [evPoukaz.prodej.id]);
    assert.equal((await zavolat(poukazy, 'patch', '/:id/dar', { params: { id: String(evPoukaz.id) } })).statusCode, 409);
    assert.equal((await zavolat(poukazy, 'delete', '/:id', { params: { id: String(evPoukaz.id) } })).statusCode, 409);
    // oprava navázaným záznamem jde: vratka k chráněné účtence
    res = await zavolat(prodejna, 'post', '/vratky', { body: { klic: 'eet-vratka-1', prodej_id: evProdej.id, polozky: [{ produkt_id: 2, velikost: '25', pocet: 1 }], castka: 400, zpusob_vraceni: 'hotovost' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    // ── kontrola: v rozsahu bez rozdílů ──
    const k = await zavolat(evRouter, 'get', '/kontrola');
    assert.deepEqual(k.body.rozdily, [], JSON.stringify(k.body.rozdily));
  } finally {
    console.log = puvodniLog;
    if (puvodniZamek !== undefined) process.env.EET_ZAMEK_OD = puvodniZamek;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
