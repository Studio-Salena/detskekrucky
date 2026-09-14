// Číslo objednávky (cislo, RRMMNN) se na rozdíl od čísla faktury přiděluje
// HNED při vzniku objednávky - je tak rovnou vidět v odpovědi i v e-mailu,
// a pokračuje v pořadí celý rok (nerestartuje se každý měsíc).
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
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 10, dostupnost: 'skladem', cena: 500 });
  return stav;
}

function objednavkovyPozadavek(email) {
  return {
    jmeno: 'Jana Nováková', email, telefon: '777 123 456',
    ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
    doprava: 'osobni_odber', platba: 'prevod', poznamka: '',
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 500 }]
  };
}

async function zavolatHandler(handler, body) {
  const req = { body, ip: '127.0.0.1' };
  const res = vytvoritRes();
  await handler(req, res);
  return res;
}

const ted = new Date();
const OCEKAVANY_PREFIX = String(ted.getFullYear()).slice(-2) + String(ted.getMonth() + 1).padStart(2, '0');

test('nová objednávka dostane cislo ve formátu RRMMNN hned v odpovědi', async () => {
  const stav = zakladniStav();
  const handler = pripravitHandler(stav);
  const res = await zavolatHandler(handler, objednavkovyPozadavek('a@example.com'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cislo, `${OCEKAVANY_PREFIX}01`);
  assert.equal(stav.objednavky[0].cislo, `${OCEKAVANY_PREFIX}01`);
});

test('druhá objednávka ve stejném měsíci pokračuje v pořadí (02, ne restart)', async () => {
  const stav = zakladniStav();
  stav.sklad[0].pocet_kusu = 10;
  const handler = pripravitHandler(stav);

  await zavolatHandler(handler, objednavkovyPozadavek('a@example.com'));
  const res2 = await zavolatHandler(handler, objednavkovyPozadavek('b@example.com'));

  assert.equal(res2.body.cislo, `${OCEKAVANY_PREFIX}02`);
});
