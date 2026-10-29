// Platnost dárkového poukazu: platí do data platnosti VČETNĚ (celý poslední den
// podle českého času), následující den už ne - stejně v e-shopu i na prodejně.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { poukazPoPlatnosti, datumPlatnosti, dnesVPraze } = require('../lib/poukazPlatnost');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

// Poukaz vydaný 31. 12. 2026 s platností do 31. 12. 2027. Sloupec DATE vrací pg
// jako Date o půlnoci v pásmu serveru - tak ho tu vytváříme.
const PLATNOST_PG = new Date(2027, 11, 31);
const VYDANO = '2026-12-31T10:00:00+01:00';
const POSLEDNI_DEN_RANO = '2027-12-31T00:05:00+01:00';
const POSLEDNI_DEN_VECER = '2027-12-31T23:59:00+01:00';
const DALSI_DEN = '2028-01-01T00:00:00+01:00';

test('pravidlo: platí první den i celý poslední den, následující den ne (Date z pg i řetězec)', () => {
  for (const platnost of [PLATNOST_PG, '2027-12-31', '2027-12-31T00:00:00.000Z']) {
    assert.equal(poukazPoPlatnosti(platnost, new Date(VYDANO)), false, 'první den');
    assert.equal(poukazPoPlatnosti(platnost, new Date(POSLEDNI_DEN_RANO)), false, 'poslední den ráno');
    assert.equal(poukazPoPlatnosti(platnost, new Date(POSLEDNI_DEN_VECER)), false, 'poslední den večer');
    assert.equal(poukazPoPlatnosti(platnost, new Date(DALSI_DEN)), true, 'následující den');
  }
});

test('pravidlo: rozhoduje český čas, ne UTC (letní čas: 23:30 UTC je už další den v Praze)', () => {
  const platnost = '2027-07-15';
  assert.equal(poukazPoPlatnosti(platnost, new Date('2027-07-15T21:59:00Z')), false, '23:59 v Praze');
  assert.equal(poukazPoPlatnosti(platnost, new Date('2027-07-15T22:00:00Z')), true, '00:00 dalšího dne v Praze');
  assert.equal(dnesVPraze(new Date('2027-12-31T23:30:00Z')), '2028-01-01');
});

test('pravidlo: nečitelné nebo chybějící datum = neplatný poukaz', () => {
  assert.equal(poukazPoPlatnosti(null), true);
  assert.equal(poukazPoPlatnosti('nesmysl'), true);
  assert.equal(poukazPoPlatnosti(new Date('x')), true);
  assert.equal(datumPlatnosti(PLATNOST_PG), '2027-12-31');
});

// --- Všechny cesty, kudy se poukaz ověřuje nebo uplatňuje, pod falešnými hodinami ---
function priCase(cas, fn) {
  return async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(cas) });
    try { await fn(); } finally { mock.timers.reset(); }
  };
}
const poukaz = (prepis = {}) => ({ id: 1, kod: 'DK-AAAA-BBBB', ean: '2200000000001', hodnota: 1000, zustatek: 1000, stav: 'aktivni', platnost_do: PLATNOST_PG, druh: 'dar', ...prepis });

// Klient se zámkem: vrací poukaz na SELECT ... FOR UPDATE a zapisuje změny
function klientSPoukazem(p) {
  const zapisy = [];
  const client = {
    query: async (sql, params) => {
      if (/FROM darkove_poukazy WHERE/.test(sql)) return { rows: p ? [p] : [] };
      if (/^UPDATE darkove_poukazy/.test(sql)) { zapisy.push(sql); if (/zustatek=\$1/.test(sql)) { p.zustatek = params[0]; p.stav = params[1]; } else { p.zustatek = 0; p.stav = 'pouzity'; } return { rows: [] }; }
      if (/^INSERT INTO prodejna_prodeje/.test(sql)) return { rows: [{ id: 9 }] };
      if (/^INSERT INTO poukazy_pouziti/.test(sql)) { zapisy.push(sql); return { rows: [] }; }
      return { rows: [] };
    },
    release() {}
  };
  return { pool: { connect: async () => client, query: client.query }, zapisy };
}

async function eshopOverit(p) {
  const { pool } = klientSPoukazem(p);
  const router = nacistRouterSMocky('../routes/poukazy.js', { '../db/pool': pool, './emaily': {} });
  const res = vytvoritRes();
  await najitHandler(router, 'get', '/overit/:kod')({ params: { kod: p.kod } }, res);
  return res;
}
async function prodejnaPouzit(p, castka = 300) {
  const { pool, zapisy } = klientSPoukazem(p);
  const router = nacistRouterSMocky('../routes/poukazy.js', { '../db/pool': pool, './emaily': {} });
  const res = vytvoritRes();
  await najitHandler(router, 'post', '/pouzit')({ body: { kod: p.kod, castka } }, res);
  return { res, zapisy };
}
async function prodejnaDoplatek(p) {
  const { pool, zapisy } = klientSPoukazem(p);
  const router = nacistRouterSMocky('../routes/prodejna.js', { '../db/pool': pool });
  const res = vytvoritRes();
  await najitHandler(router, 'post', '/')({ body: { polozky: [{ nazev: 'Bota', pocet: 1, cena: 1500 }], celkem: 1500, poukaz_kod: p.kod, doplatek_platba: 'hotovost' } }, res);
  return { res, zapisy };
}
async function eshopObjednat(stav) {
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': vytvoritMockPool(stav),
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {} }
  });
  const res = vytvoritRes();
  await najitHandler(router, 'post', '/')({ ip: '10.9.9.' + Math.floor(Math.random() * 200), body: {
    jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
    doprava: 'osobni_odber', platba: 'na_prodejne', poznamka: '', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 1 }], poukaz_kod: 'DK-AAAA-BBBB'
  } }, res);
  return res;
}
function stavEshopu(p) {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 5, dostupnost: 'skladem', cena: 500, nazev: 'Bota' });
  stav.poukazy.push(p);
  return stav;
}

for (const [nazev, cas, ocekavam] of [['první den platnosti', VYDANO, 'platny'], ['poslední den platnosti (večer)', POSLEDNI_DEN_VECER, 'platny'], ['následující den', DALSI_DEN, 'neplatny']]) {
  test(`konzistence e-shop / prodejna: ${nazev}`, priCase(cas, async () => {
    const platny = ocekavam === 'platny';
    const overit = await eshopOverit(poukaz());
    assert.equal(overit.statusCode, platny ? 200 : 400, 'e-shop i pokladna: ověření');

    const stav = stavEshopu(poukaz());
    const objednavka = await eshopObjednat(stav);
    assert.equal(objednavka.statusCode, platny ? 200 : 400, 'e-shop: objednávka s poukazem');
    assert.equal(stav.poukazy[0].zustatek, platny ? 500 : 1000);

    const pouzit = await prodejnaPouzit(poukaz());
    assert.equal(pouzit.res.statusCode, platny ? 200 : 400, 'prodejna: platba poukazem');
    assert.equal(pouzit.zapisy.length, platny ? 2 : 0, 'neplatný poukaz se nečerpá');

    const doplatek = await prodejnaDoplatek(poukaz());
    assert.equal(doplatek.res.statusCode, platny ? 200 : 400, 'prodejna: poukaz + doplatek');
    if (!platny) {
      for (const r of [overit, objednavka, pouzit.res, doplatek.res]) assert.match(r.body.chyba, /Platnost poukazu vypršela/);
    }
  }));
}

test('poslední den: ochrana proti opakovanému uplatnění a přečerpání zůstává', priCase(POSLEDNI_DEN_VECER, async () => {
  // e-shop: celý poukaz spotřebovaný první objednávkou, druhá stejným poukazem neprojde
  const stav = stavEshopu(poukaz({ zustatek: 500 }));
  assert.equal((await eshopObjednat(stav)).statusCode, 200);
  assert.equal(stav.poukazy[0].stav, 'pouzity');
  const druha = await eshopObjednat(stav);
  assert.equal(druha.statusCode, 400);
  assert.match(druha.body.chyba, /vyčerpaný|zrušený/);
  assert.equal(stav.poukazyPouziti.length, 1);

  // prodejna: vyčerpaný poukaz ani částka nad zůstatek neprojde
  assert.equal((await prodejnaPouzit(poukaz({ zustatek: 0, stav: 'pouzity' }))).res.statusCode, 400);
  const nad = await prodejnaPouzit(poukaz({ zustatek: 200 }), 300);
  assert.equal(nad.res.statusCode, 400);
  assert.equal(nad.zapisy.length, 0);
  assert.equal((await eshopOverit(poukaz({ stav: 'zruseny' }))).statusCode, 400);
}));

test('kód: všechny cesty používají jedno pravidlo, staré porovnání s okamžikem zmizelo', () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const soubor of ['routes/poukazy.js', 'routes/objednavky.js', 'routes/prodejna.js']) {
    const kod = fs.readFileSync(path.join(__dirname, '..', soubor), 'utf8');
    assert.match(kod, /require\('\.\.\/lib\/poukazPlatnost'\)/, soubor);
    assert.doesNotMatch(kod, /new Date\(poukaz\.platnost_do\)/, soubor);
  }
});
