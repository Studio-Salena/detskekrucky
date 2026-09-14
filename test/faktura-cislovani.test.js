// Číslo faktury (POST /:id/faktura) se vystavuje jen jednou na objednávku,
// je sekvenční v rámci roku a opakované volání vrací stále stejné číslo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

function pripravitHandler(stav) {
  const pool = vytvoritMockPool(stav);
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {} }
  });
  return najitHandler(router, 'post', '/:id/faktura');
}

async function zavolatHandler(handler, id) {
  const req = { params: { id: String(id) } };
  const res = vytvoritRes();
  await handler(req, res);
  return res;
}

const ROK = new Date().getFullYear();

test('první vystavení faktury vrátí číslo RRRR001', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 1, stav: 'nova' });
  const handler = pripravitHandler(stav);

  const res = await zavolatHandler(handler, 1);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.faktura_cislo, `${ROK}001`);
  assert.equal(stav.objednavky[0].faktura_cislo, `${ROK}001`);
});

test('opakované vystavení stejné objednávky vrátí stejné číslo (žádné přečíslování)', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 1, stav: 'nova' });
  const handler = pripravitHandler(stav);

  const prvni = await zavolatHandler(handler, 1);
  const druhy = await zavolatHandler(handler, 1);

  assert.equal(prvni.body.faktura_cislo, druhy.body.faktura_cislo);
});

test('druhá objednávka dostane další číslo v pořadí', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 1, stav: 'nova' }, { id: 2, stav: 'nova' });
  const handler = pripravitHandler(stav);

  await zavolatHandler(handler, 1);
  const res2 = await zavolatHandler(handler, 2);

  assert.equal(res2.body.faktura_cislo, `${ROK}002`);
});

test('neexistující objednávka vrátí 404', async () => {
  const stav = pocatecniStav();
  const handler = pripravitHandler(stav);

  const res = await zavolatHandler(handler, 999);

  assert.equal(res.statusCode, 404);
});
