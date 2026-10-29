// Číslo faktury (POST /:id/faktura) se vystavuje jen jednou na objednávku,
// je sekvenční v rámci roku a opakované volání vrací stále stejné číslo.
// Vystavení vždy uloží i neměnnou podobu dokladu (lib/vystaveniFaktury.js).
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

const ROK = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric' }).format(new Date()));
// objednávka se snímkem údajů zákazníka (jako každá objednávka z e-shopu)
// (s položkou a uloženou cenou dopravy - bez nich faktura nevznikne, viz kontrola částek)
const polozka = id => ({ objednavka_id: id, produkt_id: 5, velikost: 24, pocet: 1, cena: 500, nazev: 'Bota' });
const obj = id => ({ id, stav: 'nova', celkem: 500, doprava: 'osobni_odber', platba: 'na_prodejne', doprava_cena: 0, platba_priplatek: 0, sleva: 0, vytvoreno: new Date(), obj_jmeno: 'Jana', obj_email: 'jana@example.com', obj_telefon: '777 123 456', obj_ulice: 'A 1', obj_mesto: 'Hulín', obj_psc: '76824' });

test('první vystavení faktury vrátí číslo RRRR001', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push(obj(1));
  stav.objednavkyPolozky.push(polozka(1));
  const handler = pripravitHandler(stav);

  const res = await zavolatHandler(handler, 1);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.faktura_cislo, `${ROK}001`);
  assert.equal(stav.objednavky[0].faktura_cislo, `${ROK}001`);
  assert.equal(stav.faktury.length, 1, 'uložená podoba dokladu');
  assert.equal(stav.faktury[0].cislo, `${ROK}001`);
});

test('opakované vystavení stejné objednávky vrátí stejné číslo (žádné přečíslování)', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push(obj(1));
  stav.objednavkyPolozky.push(polozka(1));
  const handler = pripravitHandler(stav);

  const prvni = await zavolatHandler(handler, 1);
  const druhy = await zavolatHandler(handler, 1);

  assert.equal(prvni.body.faktura_cislo, druhy.body.faktura_cislo);
});

test('druhá objednávka dostane další číslo v pořadí', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push(obj(1), obj(2));
  stav.objednavkyPolozky.push(polozka(1), polozka(2));
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
