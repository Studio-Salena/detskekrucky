// Výměna zboží v prodejně (lib/vymena.js, POST /api/prodejna/vymeny a
// /vymeny/prevest): do tržeb a hotovosti jde jen doplatek / vrácený rozdíl,
// sklad sedí, dodatečný převod (případ účtenka 272 → vratka #6) nemění čistý příjem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vymena = require('../lib/vymena');

// ─── výpočty bez databáze ───

test('výpočet: doplatek, vrácený rozdíl, stejná cena', () => {
  assert.deepEqual(vymena.spocitatVymenu(1656, 1849), { kredit: 1656, doplatek: 193, vraceno: 0 });
  assert.deepEqual(vymena.spocitatVymenu(1656, 1290), { kredit: 1290, doplatek: 0, vraceno: 366 });
  assert.deepEqual(vymena.spocitatVymenu(1656, 1656), { kredit: 1656, doplatek: 0, vraceno: 0 });
});

const VRACENE = [{ produkt_id: 5, nazev: 'Husky', velikost: '27', pocet: 1, cena: 1840 }];
const NOVE = [{ produkt_id: 8, nazev: 'Nové', velikost: '28', pocet: 1, cena: 1849 }];

test('kontrola požadavku: účtenka, položky, hodnota zboží, platba doplatku', () => {
  assert.match(vymena.pripravitVymenu({ vracene: VRACENE, nove: NOVE, zapocet: 1656, platba: 'hotovost' }).chyba, /původní účtenku/);
  assert.match(vymena.pripravitVymenu({ prodej_id: 272, vracene: [], nove: NOVE, zapocet: 0 }).chyba, /vrácené zboží/);
  assert.match(vymena.pripravitVymenu({ prodej_id: 272, vracene: VRACENE, nove: [{ produkt_id: 8, pocet: 1, cena: 10 }], zapocet: 0 }).chyba, /velikost/);
  assert.match(vymena.pripravitVymenu({ prodej_id: 272, vracene: VRACENE, nove: NOVE, zapocet: 2000, platba: 'hotovost' }).chyba, /nemůže být vyšší/);
  assert.match(vymena.pripravitVymenu({ prodej_id: 272, vracene: VRACENE, nove: NOVE, zapocet: 1656 }).chyba, /doplácí/);
  const ok = vymena.pripravitVymenu({ prodej_id: 272, vracene: VRACENE, nove: NOVE, zapocet: 1656, platba: 'hotovost' });
  assert.deepEqual([ok.kredit, ok.doplatek, ok.vraceno, ok.noveCelkem], [1656, 193, 0, 1849]);
  // stejná cena: platba není potřeba
  assert.equal(vymena.pripravitVymenu({ prodej_id: 272, vracene: VRACENE, nove: [{ ...NOVE[0], cena: 1656 }], zapocet: 1656 }).doplatek, 0);
});

test('dodatečný převod: částky a pojistky', () => {
  const vratka = { id: 6, prodej_id: 272, castka: '1656', vytvoreno: '2026-11-11T10:00:00Z' };
  const prodej = { id: 280, celkem: '1849', platba: 'hotovost', datum: '2026-11-11T10:12:00Z' };
  const p = vymena.prevodNaVymenu(vratka, prodej);
  assert.deepEqual([p.prodejCelkem, p.kredit, p.vratkaCastka, p.zpusobVraceni], [193, 1656, 0, 'vymena']);
  assert.match(vymena.prevodNaVymenu({ ...vratka, vymena_prodej_id: 1 }, prodej).chyba, /už je výměnou/);
  assert.match(vymena.prevodNaVymenu(vratka, { ...prodej, vymena_castka: 100 }).chyba, /už je výměnou/);
  assert.match(vymena.prevodNaVymenu(vratka, { ...prodej, poukaz_castka: 500 }).chyba, /poukazem/);
  assert.match(vymena.prevodNaVymenu(vratka, { ...prodej, id: 272 }).chyba, /stejné účtenky/);
  assert.match(vymena.prevodNaVymenu(vratka, { ...prodej, datum: '2026-11-10T10:00:00Z' }).chyba, /starší/);
  // nové zboží levnější: rozdíl se vrátil stejným způsobem, jakým byl nový nákup zaplacen
  const levnejsi = vymena.prevodNaVymenu(vratka, { ...prodej, celkem: '1290' });
  assert.deepEqual([levnejsi.prodejCelkem, levnejsi.vratkaCastka, levnejsi.zpusobVraceni], [0, 366, 'hotovost']);
});

test('admin: výměna, způsob vrácení u vratky, převod, uzávěrka odečte hotově vrácené', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n'); // CRLF na Windows (core.autocrlf)
  assert.match(html, /onclick="otevritVymenu\(\)"/);
  assert.match(html, /id="modalVymena"/);
  assert.match(html, /id="vratkaZpusob"/);
  assert.match(html, /zpusob_vraceni: zpusobVraceni/);
  assert.match(html, /onclick="prevestNaVymenu\(\$\{Number\(v\.id\)\}\)"/);
  assert.match(html, /\/prodejna\/vymeny\/prevest/);
  assert.match(html, /function hotovostVPokladne\(/);
  assert.equal((html.match(/pokladnaRadkyUzaverky\(/g) || []).length, 3, 'definice + denní + měsíční uzávěrka');
  assert.match(html, /Number\(prodej\.vymena_castka\)>0\?'DOPLATEK'|\|\|Number\(prodej\.vymena_castka\)>0\?'DOPLATEK'/);
  // logika uzávěrky: hotovost v pokladně = hotovost z prodejů − hotově vrácené
  const a = html.indexOf('function hotovostVPokladne(');
  const kod = html.slice(a, html.indexOf('\n}\n', a) + 2);
  const fn = new Function(kod + '; return hotovostVPokladne;')();
  const k = fn(1849, [{ celkem: 193, vymena_castka: 1656 }, { celkem: 1000 }], [{ zpusob_vraceni: 'hotovost', castka: 300 }, { zpusob_vraceni: 'vymena', castka: 0 }, { zpusob_vraceni: null, castka: 100 }]);
  assert.deepEqual(k, { vracenoHotove: 300, vPokladne: 1549, vymenyPocet: 1, vymenyZapocet: 1656, vymenyDoplatek: 193, vratkyBezUdaje: 1 });
});

// ─── proti PostgreSQL ───

const URL_DB = process.env.TEST_PG_URL;

test('PostgreSQL: výměna s doplatkem, sklad, tržby; převod vratky #6 + účtenky na výměnu', { skip: !URL_DB && 'bez TEST_PG_URL' }, async () => {
  const { Client, Pool } = require('pg');
  const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
  const { vsePripraveno } = require('../lib/startServeru');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'vymenatest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 5 });
  try {
    await pool.query(`
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, stav TEXT);
      CREATE TABLE objednavky_polozky (objednavka_id INTEGER, produkt_id INTEGER, velikost TEXT, pocet INTEGER);
      CREATE TABLE sklad (produkt_id INTEGER, velikost TEXT, pocet_kusu INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (produkt_id, velikost));
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO sklad VALUES (5, '27', 0), (8, '28', 2), (9, '29', 1);
    `);
    const router = nacistRouterSMocky('../routes/prodejna.js', { '../db/pool': pool });
    await vsePripraveno();
    const zavolat = async (metoda, cesta, body) => { const res = vytvoritRes(); await najitHandler(router, metoda, cesta)({ body, params: {} }, res); return res; };
    const trzby = async () => {
      const p = (await pool.query('SELECT COALESCE(SUM(celkem),0)::float AS s, COALESCE(SUM(celkem) FILTER (WHERE platba = $1),0)::float AS h FROM prodejna_prodeje', ['hotovost'])).rows[0];
      const v = (await pool.query('SELECT COALESCE(SUM(castka),0)::float AS s FROM vratky')).rows[0];
      return { cisty: p.s - v.s, hotovostProdeje: p.h };
    };

    // původní nákup: Husky 1 840 − 10 % = 1 656 Kč hotově
    const puvodni = (await pool.query(`INSERT INTO prodejna_prodeje (platba, polozky, celkem, mezisoucet, sleva)
      VALUES ('hotovost', $1, 1656, 1840, 184) RETURNING id`, [JSON.stringify(VRACENE)])).rows[0].id;
    const pred = await trzby();

    // nová výměna: vrací Husky (zápočet 1 656), bere boty za 1 849, doplácí 193 hotově
    let r = await zavolat('post', '/vymeny', { prodej_id: puvodni, vracene: VRACENE, nove: NOVE, zapocet: 1656, platba: 'hotovost', hotovost_prijato: 200 });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual([Number(r.body.prodej.celkem), Number(r.body.prodej.vymena_castka), r.body.prodej.platba, Number(r.body.prodej.hotovost_vraceno)], [193, 1656, 'hotovost', 7]);
    assert.deepEqual([Number(r.body.vratka.castka), Number(r.body.vratka.hodnota_zbozi), r.body.vratka.zpusob_vraceni, r.body.vratka.vymena_prodej_id], [0, 1656, 'vymena', r.body.prodej.id]);
    const po = await trzby();
    assert.equal(po.cisty - pred.cisty, 193, 'do tržeb jde jen doplatek');
    assert.equal(po.hotovostProdeje - pred.hotovostProdeje, 193, 'hotovost v pokladně +193');
    const sklad = Object.fromEntries((await pool.query('SELECT produkt_id, pocet_kusu FROM sklad')).rows.map(x => [x.produkt_id, x.pocet_kusu]));
    assert.deepEqual(sklad, { 5: 1, 8: 1, 9: 1 });
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM pohyby_skladu WHERE poznamka LIKE 'Výměna%'")).rows[0].n, 2);

    // stejné kusy znovu vrátit nejde (už vráceno)
    r = await zavolat('post', '/vymeny', { prodej_id: puvodni, vracene: VRACENE, nove: [{ ...NOVE[0], produkt_id: 9, velikost: '29' }], zapocet: 1656, platba: 'hotovost' });
    assert.equal(r.statusCode, 400);
    // nové zboží, které není skladem, nic nezapíše
    const puvodni2 = (await pool.query(`INSERT INTO prodejna_prodeje (platba, polozky, celkem, mezisoucet, sleva) VALUES ('karta', $1, 1840, 1840, 0) RETURNING id`, [JSON.stringify(VRACENE)])).rows[0].id;
    const pocetVratek = (await pool.query('SELECT COUNT(*)::int AS n FROM vratky')).rows[0].n;
    r = await zavolat('post', '/vymeny', { prodej_id: puvodni2, vracene: VRACENE, nove: [{ ...NOVE[0], produkt_id: 9, velikost: '29', pocet: 5 }], zapocet: 1840, platba: 'karta' });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.chyba, /není skladem/);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM vratky')).rows[0].n, pocetVratek);

    // výměna za levnější: vracíme rozdíl kartou
    r = await zavolat('post', '/vymeny', { prodej_id: puvodni2, vracene: VRACENE, nove: [{ ...NOVE[0], produkt_id: 9, velikost: '29', cena: 1500 }], zapocet: 1840, platba: 'karta' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual([Number(r.body.prodej.celkem), r.body.prodej.platba, Number(r.body.vratka.castka), r.body.vratka.zpusob_vraceni], [0, 'vymena', 340, 'karta']);

    // ── dnešní případ: dřív zadané jako vratka (1 656 Kč) + běžný prodej 1 849 Kč hotově ──
    const p272 = (await pool.query(`INSERT INTO prodejna_prodeje (platba, polozky, celkem, mezisoucet, sleva, datum) VALUES ('hotovost', $1, 1656, 1840, 184, '2026-10-26T13:00:00Z') RETURNING id`, [JSON.stringify(VRACENE)])).rows[0].id;
    const v6 = (await pool.query(`INSERT INTO vratky (prodej_id, polozky, castka, duvod, vytvoreno) VALUES ($1, $2, 1656, 'výměna', '2026-11-11T09:00:00Z') RETURNING id`, [p272, JSON.stringify(VRACENE)])).rows[0].id;
    const p1112 = (await pool.query(`INSERT INTO prodejna_prodeje (platba, polozky, celkem, mezisoucet, sleva, hotovost_prijato, hotovost_vraceno, datum) VALUES ('hotovost', $1, 1849, 1849, 0, 2000, 151, '2026-11-11T10:12:00Z') RETURNING id`, [JSON.stringify(NOVE)])).rows[0].id;
    const predPrevodem = await trzby();
    const pohybyPred = (await pool.query('SELECT COUNT(*)::int AS n FROM pohyby_skladu')).rows[0].n;

    r = await zavolat('post', '/vymeny/prevest', { vratka_id: v6, prodej_id: p1112 });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual([Number(r.body.prodej.celkem), Number(r.body.prodej.vymena_castka), r.body.prodej.hotovost_prijato], [193, 1656, null]);
    assert.deepEqual([Number(r.body.vratka.castka), Number(r.body.vratka.hodnota_zbozi), r.body.vratka.zpusob_vraceni, r.body.vratka.vymena_prodej_id], [0, 1656, 'vymena', p1112]);
    const poPrevodu = await trzby();
    assert.equal(poPrevodu.cisty, predPrevodem.cisty, 'čistý příjem se převodem nemění');
    assert.equal(predPrevodem.hotovostProdeje - poPrevodu.hotovostProdeje, 1656, 'hotovost z prodejů klesne o „vrácené“ peníze, které nikdy neodešly');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM pohyby_skladu')).rows[0].n, pohybyPred, 'sklad se převodem nemění');
    const oprava = (await pool.query('SELECT * FROM prodejna_opravy')).rows;
    assert.equal(oprava.length, 1);
    assert.equal(Number(oprava[0].puvodni.prodej.celkem), 1849);
    assert.equal(Number(oprava[0].puvodni.vratka.castka), 1656);

    // podruhé to nejde, ani s jinou vratkou na stejnou účtenku
    assert.equal((await zavolat('post', '/vymeny/prevest', { vratka_id: v6, prodej_id: p1112 })).statusCode, 400);
    // účtenku výměny nejde smazat
    const del = vytvoritRes();
    await najitHandler(router, 'delete', '/:id')({ params: { id: String(p1112) } }, del);
    assert.equal(del.statusCode, 409);

    // vratka se způsobem vrácení
    r = await zavolat('post', '/vratky', { prodej_id: puvodni2, polozky: [], castka: 10 });
    assert.equal(r.statusCode, 400);
    r = await zavolat('post', '/vratky', { polozky: [{ produkt_id: 9, velikost: '29', pocet: 1 }], castka: 100, zpusob_vraceni: 'bitcoin' });
    assert.match(r.body.chyba, /způsob vrácení/);
    r = await zavolat('post', '/vratky', { polozky: [{ produkt_id: 9, velikost: '29', pocet: 1 }], castka: 100, zpusob_vraceni: 'hotovost', vratit_na_sklad: false });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.zpusob_vraceni, 'hotovost');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
