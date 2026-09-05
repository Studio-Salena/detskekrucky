// P0.1 - server nesmí věřit ceně/množství z klienta. Testuje se skutečný
// route handler POST /api/objednavky (routes/objednavky.js) s mockovanou DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

const emailyMock = {
  odeslat_potvrzeni: async () => {},
  odeslat_upozorneni_objednavky: async () => {}
};

function pripravitHandler(stav) {
  const pool = vytvoritMockPool(stav);
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': emailyMock
  });
  return najitHandler(router, 'post', '/');
}

function zakladniStav() {
  const stav = pocatecniStav();
  // Produkt 1, velikost 24: skladem 3ks za 500 Kč. Produkt 2, velikost 25: skladem 5ks za 700 Kč.
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 3, dostupnost: 'skladem', cena: 500 });
  stav.sklad.push({ produkt_id: 2, velikost: 25, pocet_kusu: 5, dostupnost: 'skladem', cena: 700 });
  return stav;
}

function objednavkovyPozadavek(prepis = {}) {
  return {
    jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456',
    ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
    doprava: 'osobni_odber', platba: 'prevod', poznamka: '',
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 500 }],
    ...prepis
  };
}

async function zavolatHandler(handler, body) {
  const req = { body, ip: '127.0.0.1' };
  const res = vytvoritRes();
  await handler(req, res);
  return res;
}

test('cena z requestu (1 Kč) se ignoruje - použije se cena z DB', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 1 }]
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.celkem, 500); // ne 1 Kč
  assert.equal(stav.objednavkyPolozky[0].cena, 500);
});

test('záporný počet je odmítnut', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: -2, cena: 500 }]
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 3); // sklad nedotčen
});

test('počet = 0 je odmítnut', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 0, cena: 500 }]
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(stav.objednavky.length, 0);
});

test('desetinný počet je odmítnut', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 1.5, cena: 500 }]
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(stav.objednavky.length, 0);
});

test('nesmyslně vysoký počet je odmítnut', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 999999999, cena: 500 }]
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(stav.objednavky.length, 0);
});

test('objednání většího množství než je na skladě je odmítnuto', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 10, cena: 500 }] // sklad má jen 3
  }));

  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /Nedostatek zbozi/);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 3); // sklad nedotčen
});

test('normální správná objednávka projde a odečte sklad', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 2, cena: 500 }]
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.celkem, 1000); // 2 x 500, osobní odběr zdarma
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 1); // 3 - 2
  assert.equal(stav.objednavky.length, 1);
});

test('více produktů v jedné objednávce - každá položka se oceňuje zvlášť z DB', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [
      { produkt_id: 1, velikost: 24, pocet: 2, cena: 1 },   // reálně 500 Kč/ks
      { produkt_id: 2, velikost: 25, pocet: 1, cena: 999999 } // reálně 700 Kč/ks
    ]
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.celkem, 2 * 500 + 1 * 700); // 1700, ne podvržené ceny
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 1);
  assert.equal(stav.sklad.find(r => r.produkt_id === 2).pocet_kusu, 4);
  assert.equal(stav.objednavkyPolozky.length, 2);
  assert.ok(stav.objednavkyPolozky.every(p => p.cena === 500 || p.cena === 700));
});

test('duplicitní SKU v requestu (3+3, sklad má 5) se agreguje na 6 PŘED kontrolou skladu a je odmítnuto', async () => {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 5, dostupnost: 'skladem', cena: 500 });
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [
      { produkt_id: 1, velikost: 24, pocet: 3, cena: 500 },
      { produkt_id: 1, velikost: 24, pocet: 3, cena: 500 }
    ]
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 5); // sklad nedotčen
});

test('duplicitní SKU v requestu (2+3, sklad má 5) se agreguje na jeden řádek s pocet=5 a projde', async () => {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 5, dostupnost: 'skladem', cena: 500 });
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [
      { produkt_id: 1, velikost: 24, pocet: 2, cena: 1 },       // podvržená cena, ignoruje se
      { produkt_id: 1, velikost: 24, pocet: 3, cena: 999999 }   // podvržená cena, ignoruje se
    ]
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.celkem, 5 * 500); // 5 ks x skutečná DB cena
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 0); // 5 - 5
  assert.equal(stav.objednavkyPolozky.length, 1); // jeden agregovaný řádek, ne dva
  assert.equal(stav.objednavkyPolozky[0].pocet, 5);
  assert.equal(stav.objednavkyPolozky[0].cena, 500);
});

test('stejné SKU se záporným řádkem (6 + -1) je odmítnuto, i když součet (5) je kladný', async () => {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 5, dostupnost: 'skladem', cena: 500 });
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [
      { produkt_id: 1, velikost: 24, pocet: 6, cena: 500 },
      { produkt_id: 1, velikost: 24, pocet: -1, cena: 500 }
    ]
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 5); // sklad nedotčen
});

test('sklad se zamyká v pevném pořadí (produkt_id, velikost), ne v pořadí z požadavku - ochrana proti deadlocku', async () => {
  const stav = zakladniStav();
  stav.callLog = [];
  const handler = pripravitHandler(stav);
  // Košík úmyslně v OPAČNÉM pořadí (produkt 2 první, produkt 1 druhý).
  await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [
      { produkt_id: 2, velikost: 25, pocet: 1, cena: 700 },
      { produkt_id: 1, velikost: 24, pocet: 1, cena: 500 }
    ]
  }));

  const zamykaciDotazy = stav.callLog.filter(c => c.sql.includes('FROM sklad s JOIN produkty p'));
  assert.equal(zamykaciDotazy.length, 2);
  assert.deepEqual(zamykaciDotazy[0].params, [1, 24]); // produkt 1 se zamyká první bez ohledu na pořadí v košíku
  assert.deepEqual(zamykaciDotazy[1].params, [2, 25]);
});
