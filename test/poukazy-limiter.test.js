// P1.5 - veřejná žádost o poukaz (POST /api/poukazy/zadost) má rate limit.
const test = require('node:test');
const assert = require('node:assert/strict');

let dalsiIp = 200;
function novaIp() { return `10.0.1.${dalsiIp++}`; }

function vytvoritMockPool() {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('CREATE TABLE')) return {};
      if (s.startsWith('INSERT INTO poukazy_zadosti')) {
        return { rows: [{ id: 1, hodnota: params[0], kupujici_jmeno: params[1] }] };
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistPoukazySMockPoolem() {
  const routePath = require.resolve('../routes/poukazy.js');
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

test('normální žádost o poukaz projde', async () => {
  const router = nacistPoukazySMockPoolem();
  const handler = najitHandler(router, 'post', '/zadost');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { hodnota: 500, kupujici_jmeno: 'Jana', kupujici_email: 'jana@example.com' } }, res);
  assert.equal(res.statusCode, 200);
});

test('opakované žádosti ze stejné IP jsou po pár pokusech zablokované (429)', async () => {
  const router = nacistPoukazySMockPoolem();
  const handler = najitHandler(router, 'post', '/zadost');
  const ip = novaIp();

  let posledni;
  for (let i = 0; i < 6; i++) {
    posledni = vytvoritRes();
    await handler({ ip, body: { hodnota: 500, kupujici_jmeno: 'Test', kupujici_email: `spam${i}@example.com` } }, posledni);
  }

  assert.equal(posledni.statusCode, 429);
});
