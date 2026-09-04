// P2.8 - žádost o vrácení (POST /api/vratky-zadosti) se musí ověřit proti
// skutečným položkám objednávky, ne jen uložit, co pošle klient.
const test = require('node:test');
const assert = require('node:assert/strict');

let dalsiIp = 300;
function novaIp() { return `10.0.2.${dalsiIp++}`; }

// Objednávka #1, e-mail jana@example.com, objednala 2x bota vel.24 (produkt 5) a 1x bota vel.25 (produkt 6).
const SKUTECNE_POLOZKY = [
  { produkt_id: 5, velikost: 24, pocet: 2, cena: 500, nazev: 'Bota A' },
  { produkt_id: 6, velikost: 25, pocet: 1, cena: 700, nazev: 'Bota B' }
];

function vytvoritMockPool(vlozeneZadosti) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('CREATE TABLE')) return {};
      if (s.startsWith('SELECT o.id, z.email FROM objednavky')) {
        const [id] = params;
        if (Number(id) !== 1) return { rows: [] };
        return { rows: [{ id: 1, email: 'jana@example.com' }] };
      }
      if (s.startsWith('SELECT op.produkt_id, op.velikost, op.pocet, op.cena, p.nazev')) {
        return { rows: SKUTECNE_POLOZKY };
      }
      if (s.startsWith('INSERT INTO vratky_zadosti')) {
        const [objednavka_id, jmeno, email, telefon, polozkyJson, duvod] = params;
        const zaznam = { id: vlozeneZadosti.length + 1, objednavka_id, jmeno, email, telefon, polozky: JSON.parse(polozkyJson), duvod };
        vlozeneZadosti.push(zaznam);
        return { rows: [zaznam] };
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistSMockPoolem(vlozeneZadosti) {
  const routePath = require.resolve('../routes/vratkyZadosti.js');
  const poolPath = require.resolve('../db/pool');
  const emailyPath = require.resolve('../routes/emaily');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  delete require.cache[emailyPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: vytvoritMockPool(vlozeneZadosti) };
  require.cache[emailyPath] = { id: emailyPath, filename: emailyPath, loaded: true, exports: { odeslat_potvrzeni_vratky: async () => {}, odeslat_upozorneni_vratky: async () => {} } };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  delete require.cache[emailyPath];
  return router;
}

function najitHandler(router, method, urlPath) {
  const layer = router.stack.find(l => l.route && l.route.path === urlPath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function vytvoritRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (kod) { res.statusCode = kod; return res; };
  res.json = function (telo) { res.body = telo; return res; };
  return res;
}

test('žádost o vrácení skutečně objednaných kusů projde a uloží ověřený název/cenu', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }], duvod: 'nesedí velikost' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(vlozene.length, 1);
  assert.equal(vlozene[0].polozky[0].nazev, 'Bota A'); // z DB, ne z requestu
  assert.equal(vlozene[0].polozky[0].cena, 500);
});

test('položka, která v objednávce vůbec nebyla, je odmítnuta', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 999, velikost: 24, pocet: 1 }] } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(vlozene.length, 0);
});

test('vrácení víc kusů, než bylo objednáno, je odmítnuto', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 5 }] } }, res); // objednáno jen 2

  assert.equal(res.statusCode, 400);
  assert.equal(vlozene.length, 0);
});

test('vrácení přes víc řádků se stejnou položkou se sčítá proti objednanému množství', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  // 2x po 1 ks = 2 ks celkem, což je přesně objednané množství - musí projít.
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }, { produkt_id: 5, velikost: 24, pocet: 1 }] } }, res);
  assert.equal(res.statusCode, 200);

  const vlozene2 = [];
  const router2 = nacistSMockPoolem(vlozene2);
  const handler2 = najitHandler(router2, 'post', '/');
  const res2 = vytvoritRes();
  // 2x po 2 ks = 4 ks celkem, což je víc než objednané 2 ks - musí selhat.
  await handler2({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 2 }, { produkt_id: 5, velikost: 24, pocet: 2 }] } }, res2);
  assert.equal(res2.statusCode, 400);
});

test('podvržený název položky se do DB neuloží (uloží se jen ověřený z objednávky)', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1, nazev: '<img src=x onerror=alert(1)>', cena: 1 }] } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(vlozene[0].polozky[0].nazev, 'Bota A');
  assert.equal(vlozene[0].polozky[0].cena, 500);
});
