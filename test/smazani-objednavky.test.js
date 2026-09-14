// Trvalé smazání objednávky (DELETE /:id) - povoleno jen pro už zrušenou
// objednávku, ať se nedá omylem smazat aktivní záznam bez vrácení skladu/poukazu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

function pripravitHandler(stav) {
  const pool = vytvoritMockPool(stav);
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {} }
  });
  return najitHandler(router, 'delete', '/:id');
}

async function zavolatHandler(handler, id) {
  const req = { params: { id: String(id) } };
  const res = vytvoritRes();
  await handler(req, res);
  return res;
}

test('zrušenou objednávku lze trvale smazat', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 1, stav: 'zrusena' });
  stav.objednavkyPolozky.push({ objednavka_id: 1, produkt_id: 5, velikost: 24, pocet: 1, cena: 500 });
  const handler = pripravitHandler(stav);

  const res = await zavolatHandler(handler, 1);

  assert.equal(res.statusCode, 200);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.objednavkyPolozky.length, 0);
});

test('aktivní (nezrušenou) objednávku nelze smazat', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 1, stav: 'nova' });
  const handler = pripravitHandler(stav);

  const res = await zavolatHandler(handler, 1);

  assert.equal(res.statusCode, 400);
  assert.equal(stav.objednavky.length, 1); // nesmazáno
});

test('smazání neexistující objednávky vrátí 404', async () => {
  const stav = pocatecniStav();
  const handler = pripravitHandler(stav);

  const res = await zavolatHandler(handler, 999);

  assert.equal(res.statusCode, 404);
});
