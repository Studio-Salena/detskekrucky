// Žádost o poukaz musí upozornit majitelku a vydaný poukaz musí (pokud máme
// e-mail) dojít zákazníkovi s kódem - dřív se v obou případech neposílalo nic.
const test = require('node:test');
const assert = require('node:assert/strict');

async function mockQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('CREATE TABLE') || s.startsWith('ALTER TABLE') || s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return {};
  if (s.startsWith('INSERT INTO poukazy_zadosti')) {
    return { rows: [{ id: 1, hodnota: params[0], kupujici_jmeno: params[1], kupujici_email: params[2] }] };
  }
  if (s.startsWith('SELECT id FROM darkove_poukazy WHERE kod')) {
    return { rows: [] }; // kód/EAN vždy "volný" - test netestuje kolize
  }
  if (s.startsWith('INSERT INTO darkove_poukazy')) {
    const [kod, ean, hodnota, platnostDo, zakoupenoKde, kupujiciJmeno, kupujiciEmail] = params;
    return { rows: [{ id: 1, kod, ean, hodnota, zustatek: hodnota, platnost_do: platnostDo, stav: 'aktivni', zakoupeno_kde: zakoupenoKde, kupujici_jmeno: kupujiciJmeno, kupujici_email: kupujiciEmail }] };
  }
  throw new Error('Mock nezná dotaz: ' + s);
}

function vytvoritMockPool() {
  return {
    query: mockQuery,
    async connect() {
      return { query: mockQuery, release() {} };
    }
  };
}

function nacistPoukazySMocky(zachyceneEmaily) {
  const routePath = require.resolve('../routes/poukazy.js');
  const poolPath = require.resolve('../db/pool');
  const emailyPath = require.resolve('../routes/emaily');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  delete require.cache[emailyPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: vytvoritMockPool() };
  require.cache[emailyPath] = {
    id: emailyPath, filename: emailyPath, loaded: true,
    exports: {
      odeslat_upozorneni_zadost_poukaz: async (zadost) => { zachyceneEmaily.push({ typ: 'upozorneni_zadost', zadost }); },
      odeslat_poukaz_zakaznikovi: async (poukaz) => { zachyceneEmaily.push({ typ: 'poukaz_zakaznikovi', poukaz }); }
    }
  };
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

let dalsiIp = 400;
function novaIp() { return `10.0.3.${dalsiIp++}`; }

async function pockatNaFireAndForget() {
  await new Promise(r => setTimeout(r, 0));
}

test('nová žádost o poukaz pošle upozornění majitelce', async () => {
  const zachycene = [];
  const router = nacistPoukazySMocky(zachycene);
  const handler = najitHandler(router, 'post', '/zadost');
  const res = vytvoritRes();

  await handler({ ip: novaIp(), body: { hodnota: 500, kupujici_jmeno: 'Jana', kupujici_email: 'jana@example.com' } }, res);
  await pockatNaFireAndForget();

  assert.equal(res.statusCode, 200);
  assert.equal(zachycene.length, 1);
  assert.equal(zachycene[0].typ, 'upozorneni_zadost');
});

test('vydání poukazu s e-mailem kupujícího pošle kód zákazníkovi', async () => {
  const zachycene = [];
  const router = nacistPoukazySMocky(zachycene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();

  await handler({ body: { hodnota: 500, zakoupeno_kde: 'eshop', kupujici_jmeno: 'Jana', kupujici_email: 'jana@example.com' } }, res);
  await pockatNaFireAndForget();

  assert.equal(res.statusCode, 200);
  assert.equal(zachycene.length, 1);
  assert.equal(zachycene[0].typ, 'poukaz_zakaznikovi');
});

test('vydání poukazu bez e-mailu (prodejna) nepošle nic', async () => {
  const zachycene = [];
  const router = nacistPoukazySMocky(zachycene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();

  await handler({ body: { hodnota: 500, zakoupeno_kde: 'prodejna' } }, res);
  await pockatNaFireAndForget();

  assert.equal(res.statusCode, 200);
  assert.equal(zachycene.length, 0);
});
