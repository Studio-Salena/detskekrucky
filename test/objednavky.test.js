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

// Každé volání z jiné adresy - limit objednávek na IP by jinak zastavil pozdější testy (429)
let posledniIp = 0;
async function zavolatHandler(handler, body) {
  const req = { body, ip: '10.30.' + Math.floor(++posledniIp / 250) + '.' + (posledniIp % 250 + 1) };
  const res = vytvoritRes();
  await handler(req, res);
  return res;
}

test('podvržená cena z requestu (1 Kč) neprojde - 409, nic se nezaloží ani neodečte, odpověď nese cenu z DB', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 1 }]
  }));

  assert.equal(res.statusCode, 409);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.objednavkyPolozky.length, 0);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 3); // sklad nedotčen
  assert.deepEqual(res.body.zmeny.map(z => [z.produkt_id, z.velikost, z.cena, z.videna_cena]), [[1, 24, 500, 1]]);
  // text platí i pro starší otevřenou stránku e-shopu, která košík sama neaktualizuje
  assert.match(res.body.chyba, /Objednávka nebyla odeslána. Obnovte prosím stránku/);
  assert.doesNotMatch(res.body.chyba, /Košík jsme aktualizovali/);
});

test('cena, kterou zákaznice viděla, sedí s DB - objednávka projde za cenu z DB', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 500, dostupnost: 'skladem' }]
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.celkem, 500);
  assert.equal(stav.objednavkyPolozky[0].cena, 500);
});

test('změna ceny v adminu mezi přidáním do košíku a objednáním - 409 se novou cenou, po potvrzení projde', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  stav.sklad.find(r => r.produkt_id === 1).cena = 450; // majitelka zlevnila
  const prvni = await zavolatHandler(handler, objednavkovyPozadavek({ polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 500 }] }));
  assert.equal(prvni.statusCode, 409);
  assert.equal(prvni.body.zmeny[0].cena, 450);
  assert.equal(stav.objednavky.length, 0);
  const druha = await zavolatHandler(handler, objednavkovyPozadavek({ polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 450 }] }));
  assert.equal(druha.statusCode, 200);
  assert.equal(druha.body.celkem, 450);
});

test('změna dostupnosti (skladem -> u dodavatele) mezi košíkem a objednáním - 409 s novou dodací lhůtou', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  Object.assign(stav.sklad.find(r => r.produkt_id === 1), { dostupnost: 'dodavatel', pocet_kusu: 0 });
  const res = await zavolatHandler(handler, objednavkovyPozadavek({ polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 500, dostupnost: 'skladem' }] }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.zmeny[0].dostupnost, 'dodavatel');
  assert.equal(stav.objednavky.length, 0);
});

test('položka bez ceny (starší klient) se neporovnává - projde za cenu z DB', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({ polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }] }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.celkem, 500);
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
      { produkt_id: 1, velikost: 24, pocet: 2, cena: 500 },
      { produkt_id: 2, velikost: 25, pocet: 1, cena: 700 }
    ]
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.celkem, 2 * 500 + 1 * 700); // 1700, každá položka z DB
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
      { produkt_id: 1, velikost: 24, pocet: 2, cena: 500 },
      { produkt_id: 1, velikost: 24, pocet: 3, cena: 500 }
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

test('produkt skrytý v adminu (na_eshopu = false) nejde objednat a sklad zůstane nedotčen', async () => {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 3, velikost: 0, pocet_kusu: 10, dostupnost: 'skladem', cena: 300, nazev: 'Taška', na_eshopu: false });
  const handler = pripravitHandler(stav);
  // Vlastní IP - ostatní testy v souboru už vyčerpaly limit objednávek pro 127.0.0.1
  const res = vytvoritRes();
  await handler({ body: objednavkovyPozadavek({ polozky: [{ produkt_id: 3, velikost: 0, pocet: 1, cena: 300 }] }), ip: '10.0.0.3' }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /už není v nabídce e-shopu/);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.sklad.find(r => r.produkt_id === 3).pocet_kusu, 10); // sklad nedotčen
});

test('krok 4a: doprava a platba jen z nabídky e-shopu - jiná hodnota je odmítnuta a nic se nezapíše', async () => {
  // Každé volání z jiné IP - limiter počtu objednávek z jednoho místa tu nehraje roli
  let ip = 0;
  const zavolat = async (handler, body) => { const res = vytvoritRes(); await handler({ body, ip: '10.40.0.' + (++ip) }, res); return res; };
  for (const [prepis, chyba] of [
    [{ doprava: 'drak' }, /způsob dopravy/],
    [{ doprava: undefined }, /způsob dopravy/],
    [{ platba: 'karta' }, /způsob platby/],
    [{ platba: 'dobirka' }, /Dobírka u tohoto způsobu dopravy není možná/],
    [{ platba: { x: 1 } }, /způsob platby/]
  ]) {
    const stav = zakladniStav();
    const res = await zavolat(pripravitHandler(stav), objednavkovyPozadavek(prepis));
    assert.equal(res.statusCode, 400, JSON.stringify(prepis));
    assert.match(res.body.chyba, chyba);
    assert.equal(stav.objednavky.length, 0);
    assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 3);
  }
  for (const doprava of ['zasilkovna', 'ceska_posta', 'osobni_odber']) {
    for (const platba of ['prevod']) {
      const res = await zavolat(pripravitHandler(zakladniStav()), objednavkovyPozadavek({ doprava, platba }));
      assert.equal(res.statusCode, 200, `${doprava}/${platba}`);
    }
  }
});

test('dobírka (2026-10-08): jen s příplatkem z nastavení, ne u osobního odběru; příplatek v celkové ceně i při dopravě zdarma', async () => {
  let ip = 0;
  const zavolat = async (handler, body) => { const res = vytvoritRes(); await handler({ body, ip: '10.42.0.' + (++ip) }, res); return res; };
  const sDobirkou = () => {
    const stav = zakladniStav();
    stav.nastaveniDopravy = { zdarmaOd: 2000, metody: {}, priplatky: { dobirka: 40 } };
    return stav;
  };
  const stav = sDobirkou();
  const ok = await zavolat(pripravitHandler(stav), objednavkovyPozadavek({ doprava: 'zasilkovna', platba: 'dobirka' }));
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  const ulozena = stav.objednavky[0];
  assert.equal(ulozena.platba, 'dobirka');
  assert.equal(Number(ulozena.platba_priplatek ?? 40), 40);
  const odber = sDobirkou();
  const ne = await zavolat(pripravitHandler(odber), objednavkovyPozadavek({ doprava: 'osobni_odber', platba: 'dobirka' }));
  assert.equal(ne.statusCode, 400);
  assert.match(ne.body.chyba, /Dobírka u tohoto způsobu dopravy není možná/);
  assert.equal(odber.objednavky.length, 0);
  // převod bez příplatku
  const prevod = sDobirkou();
  await zavolat(pripravitHandler(prevod), objednavkovyPozadavek({ doprava: 'zasilkovna', platba: 'prevod' }));
  assert.equal(Number(prevod.objednavky[0].celkem), Number(ulozena.celkem) - 40);
});

test('platba na prodejně jen při osobním odběru (majitelka 2026-10-07)', async () => {
  let ip = 0;
  const zavolat = async (handler, body) => { const res = vytvoritRes(); await handler({ body, ip: '10.41.0.' + (++ip) }, res); return res; };
  const ok = await zavolat(pripravitHandler(zakladniStav()), objednavkovyPozadavek({ doprava: 'osobni_odber', platba: 'na_prodejne' }));
  assert.equal(ok.statusCode, 200);
  for (const doprava of ['zasilkovna', 'ceska_posta']) {
    const stav = zakladniStav();
    const res = await zavolat(pripravitHandler(stav), objednavkovyPozadavek({ doprava, platba: 'na_prodejne' }));
    assert.equal(res.statusCode, 400, doprava);
    assert.match(res.body.chyba, /jen při osobním odběru/);
    assert.equal(stav.objednavky.length, 0);
  }
});

test('stejné SKU ve dvou řádcích s různou viděnou cenou (podvržená jedna z nich) - 409, nic se nezaloží', async () => {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 5, dostupnost: 'skladem', cena: 500 });
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek({
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 2, cena: 500 }, { produkt_id: 1, velikost: 24, pocet: 3, cena: 1 }]
  }));
  assert.equal(res.statusCode, 409);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 5);
});
