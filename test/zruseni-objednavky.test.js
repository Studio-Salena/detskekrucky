// P1.3 - zrušení objednávky musí vrátit sklad a hodnotu poukazu, a musí to
// jít udělat jen jednou (idempotence). Testuje se PATCH /:id/stav handler.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

function pripravitHandler(stav) {
  const pool = vytvoritMockPool(stav);
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {} }
  });
  return najitHandler(router, 'patch', '/:id/stav');
}

async function zavolatHandler(handler, id, stav) {
  const req = { params: { id: String(id) }, body: { stav } };
  const res = vytvoritRes();
  await handler(req, res);
  return res;
}

// Nasimuluje stav DB tak, jako by objednávka #1 už úspěšně proběhla přes
// POST / - 2ks produktu 1/vel.24 odečtené ze skladu (sklad byl 5, teď 3),
// uplatněný poukaz KUPON (byl 300, po slevě 200 zůstalo 100 a poukaz je 'pouzity').
function stavPoZalozeniObjednavky() {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 3, dostupnost: 'skladem', cena: 500 });
  stav.poukazy.push({ id: 1, kod: 'KUPON', ean: null, zustatek: 0, stav: 'pouzity' });
  stav.objednavky.push({ id: 1, zakaznik_id: 1, celkem: 800, poukaz_id: 1, sleva: 200, stav: 'nova' });
  stav.pohybySkladu.push({ produkt_id: 1, velikost: 24, typ: 'prodej', pocet: 2, poznamka: 'Objednavka #1' });
  return stav;
}

test('zrušení objednávky vrátí položky do skladu', async () => {
  const stav = stavPoZalozeniObjednavky();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, 1, 'zrusena');

  assert.equal(res.statusCode, 200);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 5); // 3 + 2 vrácené
  assert.equal(stav.objednavky[0].stav, 'zrusena');
});

test('zrušení objednávky vrátí zůstatek dárkového poukazu', async () => {
  const stav = stavPoZalozeniObjednavky();
  const handler = pripravitHandler(stav);
  await zavolatHandler(handler, 1, 'zrusena');

  const poukaz = stav.poukazy.find(p => p.id === 1);
  assert.equal(poukaz.zustatek, 200); // 0 + 200 vrácených
  assert.equal(poukaz.stav, 'aktivni'); // z 'pouzity' zpět na 'aktivni'
});

test('opakované zrušení stejné objednávky nevrátí sklad podruhé (idempotence)', async () => {
  const stav = stavPoZalozeniObjednavky();
  const handler = pripravitHandler(stav);

  await zavolatHandler(handler, 1, 'zrusena');
  const res2 = await zavolatHandler(handler, 1, 'zrusena'); // podruhé stejný stav

  assert.equal(res2.statusCode, 200);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 5); // ne 7
  assert.equal(stav.poukazy.find(p => p.id === 1).zustatek, 200); // ne 400
});

test('neplatný stav je odmítnut beze změny skladu', async () => {
  const stav = stavPoZalozeniObjednavky();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, 1, 'neexistujici_stav');

  assert.equal(res.statusCode, 400);
  assert.equal(stav.sklad.find(r => r.produkt_id === 1).pocet_kusu, 3);
});
