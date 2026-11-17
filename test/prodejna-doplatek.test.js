// Prodej v pokladně (POST /api/prodejna, lib/prodejPokladna.js): sklad, poukaz
// (celý nákup i s doplatkem), sleva a účtenka v jedné transakci; opakované
// odeslání se stejným klíčem prodej nezdvojí. Paměťová DB - chování proti
// skutečnému PostgreSQL (souběh, ROLLBACK) hlídá prodejna-prodej-postgres.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pripravitProdej, variantyKOdectu } = require('../lib/prodejPokladna');
const { obsluhaEvidence } = require('../test-helpers/evidenceMock');

function vytvoritStav(poukaz, sklad) {
  return {
    poukazy: [{ id: 1, kod: 'DK-AAAA-BBBB', ean: '2200000000001', stav: 'aktivni', zustatek: 1000, platnost_do: '2099-01-01', ...poukaz }],
    sklad: sklad || [{ produkt_id: 1, velikost: '25', pocet_kusu: 3 }],
    prodeje: [], pouziti: [], pohyby: [], log: []
  };
}

// Transakce nad kopií stavu: COMMIT ji přenese, ROLLBACK zahodí
function vytvoritMockClient(stav) {
  let tx = null;
  const db = () => tx || stav;
  return {
    release() {},
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      stav.log.push(s.split(' ')[0]);
      if (s === 'BEGIN') { tx = structuredClone({ ...stav, log: [] }); return {}; }
      if (s === 'COMMIT') { const log = stav.log; Object.assign(stav, tx, { log }); tx = null; return {}; }
      if (s === 'ROLLBACK') { tx = null; return {}; }
      if (/^(CREATE|ALTER)/.test(s) || s.startsWith('SELECT pg_advisory_xact_lock')) return {};
      const d = db();
      const ev = obsluhaEvidence(d, s, params);
      if (ev) return ev;
      if (s.startsWith('SELECT * FROM prodejna_prodeje WHERE klic')) return { rows: d.prodeje.filter(p => p.klic === params[0]) };
      if (s.startsWith('SELECT pocet_kusu FROM sklad')) return { rows: d.sklad.filter(x => x.produkt_id === params[0] && x.velikost === params[1]) };
      if (s.startsWith('UPDATE sklad SET pocet_kusu')) { d.sklad.find(x => x.produkt_id === params[0] && x.velikost === params[1]).pocet_kusu -= params[2]; return {}; }
      if (s.startsWith('INSERT INTO pohyby_skladu')) { d.pohyby.push({ produkt_id: params[0], velikost: params[1], pocet: params[2], poznamka: params[3] }); return {}; }
      if (s.startsWith('SELECT * FROM darkove_poukazy')) return { rows: d.poukazy.filter(p => p.kod === params[0] || p.ean === params[0]).map(p => ({ ...p })) };
      if (s.startsWith('SELECT * FROM poukazove_karty')) return { rows: [] };
      if (s.startsWith('INSERT INTO prodejna_prodeje')) {
        const [zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, hotovost_vraceno, poukaz_castka, poukaz_kod, klic, klic_otisk, obsah_otisk] = params;
        const prodej = { id: 50 + d.prodeje.length, datum: new Date(), zakaznik, platba, polozky: JSON.parse(polozky), celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, hotovost_vraceno, poukaz_castka, poukaz_kod, klic, klic_otisk, obsah_otisk };
        d.prodeje.push(prodej);
        return { rows: [prodej] };
      }
      if (s.startsWith('UPDATE darkove_poukazy SET zustatek = $1, stav = $2')) {
        Object.assign(d.poukazy.find(p => p.id === params[2]), { zustatek: params[0], stav: params[1] });
        return {};
      }
      if (s.startsWith('INSERT INTO poukazy_pouziti')) { d.pouziti.push({ poukaz_id: params[0], castka: params[1], prodej_id: params[2] }); return {}; }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistRouter(stav) {
  const routePath = require.resolve('../routes/prodejna.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  const pool = { async connect() { return vytvoritMockClient(stav); }, async query(sql, p) { return vytvoritMockClient(stav).query(sql, p); } };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  const layer = router.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function vytvoritRes() {
  const res = { statusCode: 200, body: null };
  res.status = kod => { res.statusCode = kod; return res; };
  res.json = telo => { res.body = telo; return res; };
  return res;
}

let poradi = 0;
const PRODEJ = () => ({ klic: 'test-prodej-' + (++poradi), polozky: [{ produkt_id: 1, nazev: 'Bota', velikost: 25, pocet: 1, cena: 1600 }], celkem: 1600, mezisoucet: 1600, sleva: 0 });
async function prodat(stav, body) { const res = vytvoritRes(); await nacistRouter(stav)({ body }, res); return res; }

test('poukaz 1000 Kč na nákup 1600 Kč: doplatek 600 Kč kartou, poukaz vyčerpaný, sklad odečtený', async () => {
  const stav = vytvoritStav();
  const res = await prodat(stav, { ...PRODEJ(), platba: 'poukaz', poukaz_kod: 'dk-aaaa-bbbb', doplatek_platba: 'karta' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const p = stav.prodeje[0];
  assert.deepEqual([p.platba, p.celkem, p.mezisoucet, p.poukaz_castka, p.poukaz_kod, p.hotovost_prijato], ['karta', 600, 1600, 1000, 'DK-AAAA-BBBB', null]);
  assert.deepEqual([stav.poukazy[0].zustatek, stav.poukazy[0].stav], [0, 'pouzity']);
  assert.deepEqual(stav.pouziti, [{ poukaz_id: 1, castka: 1000, prodej_id: 50 }]);
  assert.equal(stav.sklad[0].pocet_kusu, 2);
  assert.deepEqual(stav.pohyby, [{ produkt_id: 1, velikost: '25', pocet: 1, poznamka: 'Prodej v prodejně – účtenka #50' }]);
  assert.equal(stav.log.at(-1), 'COMMIT');
});

test('celý nákup poukazem: záznam jako dřív (platba poukaz, celkem = cena), poukaz se čerpá na serveru', async () => {
  const stav = vytvoritStav({ zustatek: 2000 });
  const res = await prodat(stav, { ...PRODEJ(), platba: 'poukaz', poukaz_kod: '2200000000001' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const p = stav.prodeje[0];
  assert.deepEqual([p.platba, p.celkem, p.poukaz_castka, p.poukaz_kod], ['poukaz', 1600, null, 'DK-AAAA-BBBB']);
  assert.deepEqual([stav.poukazy[0].zustatek, stav.poukazy[0].stav], [400, 'aktivni']);
  assert.deepEqual(stav.pouziti, [{ poukaz_id: 1, castka: 1600, prodej_id: 50 }]);
});

test('doplatek hotově: přijato a vráceno spočítá server z doplatku', async () => {
  const stav = vytvoritStav();
  const res = await prodat(stav, { ...PRODEJ(), platba: 'poukaz', poukaz_kod: '2200000000001', doplatek_platba: 'hotovost', hotovost_prijato: 1000, hotovost_vraceno: 5 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([stav.prodeje[0].hotovost_prijato, stav.prodeje[0].hotovost_vraceno], [1000, 400]);
});

test('opakované odeslání se stejným klíčem (výpadek spojení): jeden prodej, jeden odečet, jedno čerpání', async () => {
  const stav = vytvoritStav({ zustatek: 5000 });
  const body = { ...PRODEJ(), platba: 'poukaz', poukaz_kod: 'DK-AAAA-BBBB' };
  const prvni = await prodat(stav, body);
  const druhy = await prodat(stav, body);
  assert.equal(prvni.statusCode, 200);
  assert.equal(druhy.statusCode, 200);
  assert.equal(druhy.body.id, prvni.body.id);
  assert.equal(druhy.body.opakovane, true);
  assert.equal(stav.prodeje.length, 1);
  assert.equal(stav.sklad[0].pocet_kusu, 2);
  assert.equal(stav.pouziti.length, 1);
  assert.equal(stav.poukazy[0].zustatek, 3400);

  // stejný klíč, jiný obsah: odmítne a řekne, která účtenka se uložila
  const jiny = await prodat(stav, { ...body, polozky: [{ ...body.polozky[0], pocet: 2 }], celkem: 3200 });
  assert.equal(jiny.statusCode, 409);
  assert.equal(jiny.body.ulozeny_prodej_id, prvni.body.id);
  assert.equal(stav.prodeje.length, 1);
});

test('nedostatek na skladu: nic se neuloží, poukaz se nečerpá', async () => {
  const stav = vytvoritStav({ zustatek: 5000 }, [{ produkt_id: 1, velikost: '25', pocet_kusu: 1 }]);
  const res = await prodat(stav, { ...PRODEJ(), polozky: [{ produkt_id: 1, nazev: 'Bota', velikost: '25', pocet: 2, cena: 800 }], platba: 'poukaz', poukaz_kod: 'DK-AAAA-BBBB' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /na skladě 1 ks, prodává se 2 ks/);
  assert.deepEqual([stav.prodeje.length, stav.pouziti.length, stav.sklad[0].pocet_kusu, stav.poukazy[0].zustatek], [0, 0, 1, 5000]);
});

test('částka z pokladny nesedí se serverem (sleva) = 409, nic se neuloží', async () => {
  const stav = vytvoritStav();
  const res = await prodat(stav, { ...PRODEJ(), platba: 'karta', sleva: 100, celkem: 1600 });
  assert.equal(res.statusCode, 409);
  assert.equal(stav.prodeje.length, 0);
  assert.equal(stav.sklad[0].pocet_kusu, 3);
});

test('odmítne: neaktivní, prošlý, neznámý poukaz, nepokrytý nákup bez doplatku, málo hotovosti, stará pokladna', async () => {
  const pripady = [
    [{ stav: 'pouzity' }, { doplatek_platba: 'karta' }, /není aktivní/],
    [{ platnost_do: '2020-01-01' }, { doplatek_platba: 'karta' }, /vypršela/],
    [{ kod: 'JINY', ean: 'JINY' }, { doplatek_platba: 'karta' }, /nebyl nalezen/],
    [{}, {}, /vyberte, jak zákazník doplatí zbytek 600 Kč/],
    [{}, { doplatek_platba: 'poukaz' }, /doplatí zbytek/],
    [{}, { doplatek_platba: 'hotovost', hotovost_prijato: 500 }, /menší než částka k zaplacení 600 Kč/],
    [{}, { doplatek_platba: 'karta', klic: undefined }, /Obnovte stránku/]
  ];
  for (const [poukaz, prepis, chyba] of pripady) {
    const stav = vytvoritStav(poukaz);
    const res = await prodat(stav, { ...PRODEJ(), platba: 'poukaz', poukaz_kod: 'DK-AAAA-BBBB', ...prepis });
    assert.ok(res.statusCode === 400 || res.statusCode === 409 || res.statusCode === 404, String(chyba) + ' ' + res.statusCode);
    assert.match(res.body.chyba, chyba);
    assert.deepEqual([stav.prodeje.length, stav.pouziti.length, stav.sklad[0].pocet_kusu], [0, 0, 3], 'nic se neuloží');
  }
});

test('vstup: velikost jako text, sčítání stejných variant, ruční řádek bez produktu', () => {
  const v = pripravitProdej({ klic: 'abcdefgh', platba: 'karta', polozky: [
    { produkt_id: 2, velikost: 24.5, pocet: 1, cena: 100 }, { produkt_id: 2, velikost: '24.5', pocet: 2, cena: 100 }, { nazev: 'Taška', pocet: 1, cena: 20 }
  ] });
  assert.equal(v.mezisoucet, 320);
  assert.deepEqual(variantyKOdectu(v.polozky).map(x => [x.produkt_id, x.velikost, x.pocet]), [[2, '24.5', 3]]);
  assert.match(pripravitProdej({ klic: 'abcdefgh', platba: 'karta', polozky: [{ typ: 'poukaz', pocet: 1, cena: 500 }] }).chyba, /Dárkové poukazy/);
  assert.match(pripravitProdej({ klic: 'abcdefgh', platba: 'bitcoin', polozky: [{ pocet: 1, cena: 1 }] }).chyba, /způsob platby/);
  assert.match(pripravitProdej({ klic: 'abcdefgh', platba: 'karta', sleva: 50, polozky: [{ pocet: 1, cena: 10 }] }).chyba, /Neplatná sleva/);
});

test('tržby: prodej s doplatkem se z tržeb nevyřazuje (počítá se jen doplatek)', () => {
  const zdroj = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'poukazy.js'), 'utf8');
  assert.match(zdroj, /AND COALESCE\(pr\.poukaz_castka, 0\) = 0\) AS zapocitano_pri_vydani/);
  assert.match(zdroj, /LEFT JOIN prodejna_prodeje pr ON pr\.id = pp\.prodej_id/);
});

test('admin: pokladna neodečítá sklad ani nečerpá poukaz sama, posílá klíč prodeje', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
  const zacatek = html.indexOf('async function ulozitProdejnaProdatJednou()');
  const telo = html.slice(zacatek, html.indexOf('\nfunction prepnoutPoukazPole()', zacatek));
  assert.ok(zacatek > 0 && telo.length > 100);
  assert.doesNotMatch(telo, /sklad\/odecist/);
  assert.doesNotMatch(telo, /poukazy\/pouzit/);
  assert.match(telo, /klic: klicProdeje/);
  // neodeslaný prodej se uloží i s klíčem PŘED odesláním (přežije obnovení stránky)
  const odeslat = telo.slice(telo.indexOf('async function odeslatProdej('));
  assert.ok(odeslat.indexOf('ulozitNedokoncenyProdej(prodej)') > 0 && odeslat.indexOf('ulozitNedokoncenyProdej(prodej)') < odeslat.indexOf("adminFetch(API+'/prodejna'"));
  assert.match(telo, /nedokonceny.prodej.klic !== klicProdeje/, 'nový prodej nepřepíše čekající nedokončený');
});

test('stará pokladna (okno otevřené před nasazením): /sklad/odecist s poznámkou prodeje se odmítne, ruční odečet funguje', async () => {
  const { nacistRouterSMocky, najitHandler } = require('../test-helpers/_pomocnik');
  const dotazy = [];
  const pool = { async query(sql, params) { dotazy.push(sql); return { rows: /SELECT pocet_kusu/.test(sql) ? [{ pocet_kusu: 5 }] : [] }; } };
  const handler = najitHandler(nacistRouterSMocky('../routes/sklad.js', { '../db/pool': pool }), 'post', '/odecist');
  let res = vytvoritRes();
  await handler({ body: { produkt_id: 1, velikost: 25, pocet: 1, poznamka: 'Prodej v prodejně' } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.chyba, /Obnovte stránku/);
  assert.equal(dotazy.filter(s => /UPDATE sklad/.test(s)).length, 0);
  res = vytvoritRes();
  await handler({ body: { produkt_id: 1, velikost: 25, pocet: 1, poznamka: 'Odečtení z adminu' } }, res);
  assert.equal(res.statusCode, 200);
});

// ── „Zahodit“ nepotvrzený prodej a stejný nákup zadaný znovu ──
function nacistHandler(stav, metoda, cesta) {
  const routePath = require.resolve('../routes/prodejna.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  const pool = { async connect() { return vytvoritMockClient(stav); }, async query(sql, p) { return vytvoritMockClient(stav).query(sql, p); } };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  const layer = router.stack.find(l => l.route && l.route.path === cesta && l.route.methods[metoda]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

test('Zahodit po ztracené odpovědi: server prodej uložil → nezahodí se, vrátí účtenku; nové zadání téhož nákupu se bez potvrzení neuloží', async () => {
  const stav = vytvoritStav();
  const nakup = { ...PRODEJ(), platba: 'karta' };
  // 1) server prodej uloží, odpověď se ztratí (pokladna ji nedostane)
  assert.equal((await prodat(stav, nakup)).statusCode, 200);
  // 2) obsluha zvolí Zahodit → server pod stejným klíčem prodej najde
  const res = vytvoritRes();
  await nacistHandler(stav, 'post', '/nedokonceny/:klic/zahodit')({ params: { klic: nakup.klic } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stav, 'ulozeny');
  assert.equal(res.body.prodej.id, stav.prodeje[0].id);
  assert.equal(stav.evidence.zahozene.length, 0, 'uložený prodej se nezahazuje');
  // 3) obsluha zadá stejný nákup znovu (nový klíč) → upozornění, nic se neuloží
  const znovu = await prodat(stav, { ...nakup, klic: 'test-znovu-1' });
  assert.equal(znovu.statusCode, 409);
  assert.equal(znovu.body.mozna_duplicita, true);
  assert.equal(znovu.body.ulozeny_prodej_id, stav.prodeje[0].id);
  assert.equal(stav.prodeje.length, 1, 'žádný druhý prodej');
  assert.equal(stav.sklad[0].pocet_kusu, 2, 'sklad odečtený jen jednou');
  assert.equal(stav.evidence.platby.length, 1, 'jedna platba');
  // 4) jen výslovné potvrzení „je to další nákup“ uloží druhý
  const potvrzeny = await prodat(stav, { ...nakup, klic: 'test-znovu-1', potvrdit_duplicitu: true });
  assert.equal(potvrzeny.statusCode, 200);
  assert.equal(stav.prodeje.length, 2);
});

test('Zahodit, když se požadavek na server nedostal: klíč se zneplatní a pozdní pokus nic neuloží', async () => {
  const stav = vytvoritStav();
  const nakup = { ...PRODEJ(), platba: 'karta' };
  const res = vytvoritRes();
  await nacistHandler(stav, 'post', '/nedokonceny/:klic/zahodit')({ params: { klic: nakup.klic } }, res);
  assert.equal(res.body.stav, 'zahozeny');
  const pozde = await prodat(stav, nakup);
  assert.equal(pozde.statusCode, 409);
  assert.equal(pozde.body.zahozeno, true);
  assert.deepEqual([stav.prodeje.length, stav.sklad[0].pocet_kusu, stav.evidence.platby.length], [0, 3, 0]);
});

test('evidence z pokladny: příjem jen skutečných peněz, čerpání poukazu jako kredit s původem', async () => {
  const stav = vytvoritStav({ druh: 'dar' });
  await prodat(stav, { ...PRODEJ(), platba: 'poukaz', poukaz_kod: 'DK-AAAA-BBBB', doplatek_platba: 'hotovost', hotovost_prijato: 1000 });
  assert.deepEqual(stav.evidence.platby.map(p => [p.typ, p.castka, p.zpusob, p.okolnosti, p.kontaktni, p.zdroj_typ]), [['prijem', 600, 'hotovost', 'prodejna', true, 'prodej']]);
  assert.deepEqual(stav.evidence.kredit_pohyby.map(k => [k.typ, k.castka, k.puvod, k.eet_pravidlo]), [['cerpani', 1000, 'darovany', 'nevyreseno']],
    'darovaný kredit: pravidlo EET výslovně nevyřešené');
});

test('admin: Zahodit se ptá serveru a bez spojení nezahodí; možná duplicita jen s potvrzením', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
  const z = html.slice(html.indexOf('async function zahoditNedokoncenyProdej()'), html.indexOf('\nfunction prepnoutPoukazPole()'));
  assert.match(z, /\/prodejna\/nedokonceny\/' \+ encodeURIComponent\(z\.prodej\.klic\) \+ '\/zahodit'/);
  const ulozeni = z.indexOf("data.stav === 'ulozeny'"), smazani = z.indexOf('smazatNedokoncenyProdej()');
  assert.ok(ulozeni > 0 && smazani > z.indexOf('if (!res.ok)'), 'klíč se maže až po odpovědi serveru');
  assert.match(z, /catch \(e\) \{\s*msg\.innerHTML = '<div class="error-msg">Bez spojení/);
  assert.match(html, /data\.mozna_duplicita && !prodej\.potvrdit_duplicitu/);
});
