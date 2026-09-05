// P2.7 - veřejné GET /api/sklad nesmí vracet interní údaje (min_pocet,
// z něj odvozené nizky_stav, EAN) - ty smí vidět jen admin přes GET /api/sklad/admin.
const test = require('node:test');
const assert = require('node:assert/strict');

const RADEK = { id: 1, nazev: 'Bota', velikost: 24, pocet_kusu: 3, min_pocet: 2, ean: '123', dostupnost: 'skladem', cena: 500, nizky_stav: true };

function vytvoritMockPool() {
  return {
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT p.id, p.nazev')) {
        // Mock vrátí "všechno" - skutečnou filtraci sloupců dělá SQL v
        // routes/sklad.js, tady jen ověřujeme, že veřejná route o tato pole
        // v SQL vůbec nepožádá.
        if (s.includes('min_pocet')) return { rows: [RADEK] }; // admin dotaz
        const { min_pocet, nizky_stav, ean, ...verejny } = RADEK;
        return { rows: [s.includes('s.ean') ? { ...verejny, ean } : verejny] };
      }
      if (s.startsWith('ALTER TABLE') || s.startsWith('CREATE TABLE')) return {};
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistSkladSMockPoolem() {
  const routePath = require.resolve('../routes/sklad.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: vytvoritMockPool() };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
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

test('veřejné GET /api/sklad neobsahuje min_pocet, nizky_stav ani ean', async () => {
  const router = nacistSkladSMockPoolem();
  const handler = najitHandler(router, 'get', '/');
  const res = vytvoritRes();
  await handler({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal('min_pocet' in res.body[0], false);
  assert.equal('nizky_stav' in res.body[0], false);
  assert.equal('ean' in res.body[0], false);
});

test('GET /api/sklad/admin obsahuje min_pocet, nizky_stav i ean (pro admin sklad)', async () => {
  const router = nacistSkladSMockPoolem();
  const handler = najitHandler(router, 'get', '/admin');
  const res = vytvoritRes();
  await handler({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal('min_pocet' in res.body[0], true);
  assert.equal('nizky_stav' in res.body[0], true);
  assert.equal('ean' in res.body[0], true);
});
