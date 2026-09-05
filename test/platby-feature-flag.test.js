// Rozhodnutí "STRIPE" - routes/platby.js zůstává v kódu, ale je řízené
// feature flagem STRIPE_ENABLED s fail-closed výchozí hodnotou. Bez
// STRIPE_ENABLED=true (nebo bez STRIPE_KEY i když je flag zapnutý) musí
// všechny tři routy vracet 503 a nikdy nevolat skutečné Stripe API.
const test = require('node:test');
const assert = require('node:assert/strict');

function vytvoritMockPool() {
  return { async query() { throw new Error('pool.query by se nemělo volat, když je Stripe vypnutý'); } };
}

function nacistPlatbySEnv(env) {
  const routePath = require.resolve('../routes/platby.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: vytvoritMockPool() };

  const puvodni = { STRIPE_ENABLED: process.env.STRIPE_ENABLED, STRIPE_KEY: process.env.STRIPE_KEY };
  if (env.STRIPE_ENABLED === undefined) delete process.env.STRIPE_ENABLED; else process.env.STRIPE_ENABLED = env.STRIPE_ENABLED;
  if (env.STRIPE_KEY === undefined) delete process.env.STRIPE_KEY; else process.env.STRIPE_KEY = env.STRIPE_KEY;

  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];

  if (puvodni.STRIPE_ENABLED === undefined) delete process.env.STRIPE_ENABLED; else process.env.STRIPE_ENABLED = puvodni.STRIPE_ENABLED;
  if (puvodni.STRIPE_KEY === undefined) delete process.env.STRIPE_KEY; else process.env.STRIPE_KEY = puvodni.STRIPE_KEY;

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

test('STRIPE_ENABLED chybí (výchozí stav) - POST /vytvorit vrací 503', async () => {
  const router = nacistPlatbySEnv({});
  const handler = najitHandler(router, 'post', '/vytvorit');
  const res = vytvoritRes();
  await handler({ body: { objednavka_id: 1 } }, res);
  assert.equal(res.statusCode, 503);
});

test('STRIPE_ENABLED=false - GET /stav/:id vrací 503', async () => {
  const router = nacistPlatbySEnv({ STRIPE_ENABLED: 'false', STRIPE_KEY: 'sk_test_x' });
  const handler = najitHandler(router, 'get', '/stav/:session_id');
  const res = vytvoritRes();
  await handler({ params: { session_id: 'cs_test_1' } }, res);
  assert.equal(res.statusCode, 503);
});

test('STRIPE_ENABLED=true ale bez STRIPE_KEY - fail closed, 503', async () => {
  const router = nacistPlatbySEnv({ STRIPE_ENABLED: 'true' });
  const handler = najitHandler(router, 'post', '/vytvorit');
  const res = vytvoritRes();
  await handler({ body: { objednavka_id: 1 } }, res);
  assert.equal(res.statusCode, 503);
});

test('webhook je taky vypnutý, když Stripe není zapnutý (nezpracuje se bez ověření podpisu)', async () => {
  const router = nacistPlatbySEnv({});
  const handler = najitHandler(router, 'post', '/webhook');
  const res = vytvoritRes();
  await handler({ headers: {}, body: Buffer.from('{}') }, res);
  assert.equal(res.statusCode, 503);
});

test('nikde se nevrací STRIPE_KEY ani jiná secret hodnota v chybové odpovědi', async () => {
  const router = nacistPlatbySEnv({});
  const handler = najitHandler(router, 'post', '/vytvorit');
  const res = vytvoritRes();
  await handler({ body: { objednavka_id: 1 } }, res);
  assert.equal(JSON.stringify(res.body).toLowerCase().includes('sk_'), false);
});
