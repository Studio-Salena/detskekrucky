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

test('faktura: zrušenou objednávku BEZ faktury lze smazat (beze změny pravidel)', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 1, stav: 'zrusena', faktura_cislo: null });
  const res = await zavolatHandler(pripravitHandler(stav), 1);
  assert.equal(res.statusCode, 200);
  assert.equal(stav.objednavky.length, 0);
});

test('faktura: objednávku s vystavenou fakturou nelze smazat, i když je zrušená', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 1, stav: 'zrusena', faktura_cislo: '2026004', faktura_datum: '2026-10-27T09:00:00Z' });
  const res = await zavolatHandler(pripravitHandler(stav), 1);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /vystavená faktura 2026004/);
});

test('faktura: po odmítnutí zůstane objednávka, položky, použití poukazu i číslo faktury beze změny', async () => {
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 1, stav: 'zrusena', faktura_cislo: '2026004', faktura_datum: '2026-10-27T09:00:00Z' });
  stav.objednavkyPolozky.push({ objednavka_id: 1, produkt_id: 5, velikost: 24, pocet: 1, cena: 1679 });
  stav.poukazyPouziti.push({ poukaz_id: 3, castka: 500, objednavka_id: 1 });
  const pred = JSON.stringify([stav.objednavky, stav.objednavkyPolozky, stav.poukazyPouziti]);
  await zavolatHandler(pripravitHandler(stav), 1);
  assert.equal(JSON.stringify([stav.objednavky, stav.objednavkyPolozky, stav.poukazyPouziti]), pred);
});

test('faktura: kontrola je na serveru a v transakci se zámkem řádku (souběžné vystavení ji neobejde)', () => {
  const kod = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'objednavky.js'), 'utf8');
  const smazani = kod.slice(kod.indexOf("router.delete('/:id'"), kod.indexOf('module.exports'));
  assert.match(smazani, /SELECT stav, faktura_cislo FROM objednavky WHERE id=\$1 FOR UPDATE/);
  assert.ok(smazani.indexOf('faktura_cislo) {') < smazani.indexOf('DELETE FROM objednavky_polozky'), 'kontrola faktury před mazáním');
  const vystaveni = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'vystaveniFaktury.js'), 'utf8');
  assert.match(vystaveni, /WHERE o\.id = \$1\s+FOR UPDATE OF o/, 'vystavení faktury zamyká stejný řádek objednávky');
});

// Jiná cesta, kudy by objednávka mohla zmizet: smazání zákazníka (routes/auth.js)
function smazaniZakaznika(objednavky) {
  const dotazy = [];
  const pool = {
    query: async (sql, params) => {
      dotazy.push(sql);
      if (/FROM objednavky WHERE zakaznik_id=\$1 AND faktura_cislo IS NOT NULL/.test(sql)) {
        return { rows: objednavky.filter(o => o.zakaznik_id === Number(params[0]) && o.faktura_cislo).map(o => ({ faktura_cislo: o.faktura_cislo })) };
      }
      if (/^DELETE FROM zakaznici/.test(sql)) return { rows: [{ id: Number(params[0]) }] };
      return { rows: [] };
    }
  };
  const router = nacistRouterSMocky('../routes/auth.js', { '../db/pool': pool, './emaily': {} });
  return { handler: najitHandler(router, 'delete', '/zakaznici/:id'), dotazy };
}

test('faktura: zákazníka s fakturovanou objednávkou nelze smazat (objednávka by zmizela s ním)', async () => {
  const { handler, dotazy } = smazaniZakaznika([{ zakaznik_id: 7, faktura_cislo: '2026004' }]);
  const res = vytvoritRes();
  await handler({ params: { id: '7' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /fakturou 2026004/);
  assert.equal(dotazy.some(s => /^DELETE FROM zakaznici/.test(s)), false);

  const jiny = smazaniZakaznika([{ zakaznik_id: 7, faktura_cislo: '2026004' }, { zakaznik_id: 8, faktura_cislo: null }]);
  const res2 = vytvoritRes();
  await jiny.handler({ params: { id: '8' } }, res2);
  assert.equal(res2.statusCode, 200, 'zákazník bez faktury jde smazat jako dřív');
});

test('smazání neexistující objednávky vrátí 404', async () => {
  const stav = pocatecniStav();
  const handler = pripravitHandler(stav);

  const res = await zavolatHandler(handler, 999);

  assert.equal(res.statusCode, 404);
});
