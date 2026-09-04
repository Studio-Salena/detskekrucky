// P1.4 - registrace po host objednávce (heslo IS NULL) musí jít dokončit
// místo "email je již registrován", a login bez hesla nesmí spadnout do 500.
// P1.5 - login/registrace mají rate limit proti hádání hesla / spamu účtů.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let dalsiIp = 1;
// Každý test dostane vlastní IP - limitery mají modulovou (sdílenou) paměť,
// takže bez izolace by pokusy z jednoho testu ovlivňovaly limit v jiném.
function novaIp() { return `10.0.0.${dalsiIp++}`; }

function vytvoritMockPool(zakaznici) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('SELECT id, heslo FROM zakaznici WHERE email')) {
        const [email] = params;
        const z = zakaznici.find(z => z.email === email);
        return { rows: z ? [{ id: z.id, heslo: z.heslo }] : [] };
      }
      if (s.startsWith('SELECT * FROM zakaznici WHERE email')) {
        const [email] = params;
        const z = zakaznici.find(z => z.email === email);
        return { rows: z ? [z] : [] };
      }
      if (s.startsWith('UPDATE zakaznici SET heslo=')) {
        const [heslo, jmeno, telefon, ulice, mesto, psc, id] = params;
        const z = zakaznici.find(z => z.id === id);
        Object.assign(z, { heslo, jmeno, telefon, ulice, mesto, psc });
        return {};
      }
      if (s.startsWith('INSERT INTO zakaznici')) {
        const [jmeno, email, heslo, telefon, ulice, mesto, psc] = params;
        const id = zakaznici.length + 1;
        zakaznici.push({ id, jmeno, email, heslo, telefon, ulice, mesto, psc });
        return { rows: [{ id }] };
      }

      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistAuthSMockPoolem(zakaznici) {
  const routePath = require.resolve('../routes/auth.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: vytvoritMockPool(zakaznici) };
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

test('registrace na nový email vytvoří účet', async () => {
  const zakaznici = [];
  const router = nacistAuthSMockPoolem(zakaznici);
  const handler = najitHandler(router, 'post', '/registrace');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { jmeno: 'Jana Nová', email: 'jana@example.com', heslo: 'tajneheslo123', telefon: '777123456', ulice: 'A 1', mesto: 'Hulín', psc: '76824' } }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(zakaznici.length, 1);
  assert.ok(zakaznici[0].heslo); // heslo je nastavené (hash)
});

test('registrace se stejným emailem jako už dokončený účet je odmítnuta', async () => {
  const zakaznici = [{ id: 1, email: 'jana@example.com', heslo: '$2b$10$existujicihash' }];
  const router = nacistAuthSMockPoolem(zakaznici);
  const handler = najitHandler(router, 'post', '/registrace');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { jmeno: 'Jana Nová', email: 'jana@example.com', heslo: 'novaheslo123' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /jiz registrovan/);
});

test('registrace na email z host objednávky (heslo NULL) dokončí účet místo chyby', async () => {
  const zakaznici = [{ id: 1, jmeno: 'Jana Host', email: 'jana@example.com', heslo: null, telefon: null, ulice: null, mesto: null, psc: null }];
  const router = nacistAuthSMockPoolem(zakaznici);
  const handler = najitHandler(router, 'post', '/registrace');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { jmeno: 'Jana Nová', email: 'jana@example.com', heslo: 'tajneheslo123', telefon: '777123456', ulice: 'A 1', mesto: 'Hulín', psc: '76824' } }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token, 'registrace musí uspět, ne skončit chybou "email je již registrován"');
  assert.ok(zakaznici[0].heslo);
  assert.equal(zakaznici.length, 1); // pořád jen jeden řádek, ne duplicitní zákazník
});

test('přihlášení na účet bez hesla vrátí 400, ne 500', async () => {
  const zakaznici = [{ id: 1, jmeno: 'Jana Host', email: 'jana@example.com', heslo: null }];
  const router = nacistAuthSMockPoolem(zakaznici);
  const handler = najitHandler(router, 'post', '/prihlaseni');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { email: 'jana@example.com', heslo: 'cokoliv' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /Neplatny email nebo heslo/);
});

test('přihlášení se správným heslem po dokončení registrace funguje', async () => {
  const zakaznici = [];
  const router = nacistAuthSMockPoolem(zakaznici);
  const ip = novaIp();
  const registrace = najitHandler(router, 'post', '/registrace');
  await registrace({ ip, body: { jmeno: 'Jana Nová', email: 'jana@example.com', heslo: 'tajneheslo123' } }, vytvoritRes());

  const prihlaseni = najitHandler(router, 'post', '/prihlaseni');
  const res = vytvoritRes();
  await prihlaseni({ ip, body: { email: 'jana@example.com', heslo: 'tajneheslo123' } }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
});

test('opakované špatné heslo ze stejné IP je po pár pokusech zablokováno (429)', async () => {
  const zakaznici = [{ id: 1, email: 'jana@example.com', heslo: await require('bcrypt').hash('spravneheslo', 10) }];
  const router = nacistAuthSMockPoolem(zakaznici);
  const handler = najitHandler(router, 'post', '/prihlaseni');
  const ip = novaIp();

  let posledni;
  for (let i = 0; i < 11; i++) {
    posledni = vytvoritRes();
    await handler({ ip, body: { email: 'jana@example.com', heslo: 'spatne' } }, posledni);
  }

  assert.equal(posledni.statusCode, 429);
});

test('rate limit blokuje jen útočníkovu IP, ne ostatní zákazníky', async () => {
  const zakaznici = [{ id: 1, email: 'jana@example.com', heslo: await require('bcrypt').hash('spravneheslo', 10) }];
  const router = nacistAuthSMockPoolem(zakaznici);
  const handler = najitHandler(router, 'post', '/prihlaseni');
  const utocnikIp = novaIp();
  const normalniIp = novaIp();

  for (let i = 0; i < 11; i++) {
    await handler({ ip: utocnikIp, body: { email: 'jana@example.com', heslo: 'spatne' } }, vytvoritRes());
  }

  const res = vytvoritRes();
  await handler({ ip: normalniIp, body: { email: 'jana@example.com', heslo: 'spravneheslo' } }, res);
  assert.equal(res.statusCode, 200); // jiná IP se stejným (správným) heslem není blokovaná
});

test('opakovaná registrace ze stejné IP je po pár pokusech zablokována (429)', async () => {
  const zakaznici = [];
  const router = nacistAuthSMockPoolem(zakaznici);
  const handler = najitHandler(router, 'post', '/registrace');
  const ip = novaIp();

  let posledni;
  for (let i = 0; i < 9; i++) {
    posledni = vytvoritRes();
    await handler({ ip, body: { jmeno: 'Test Uživatel', email: `spam${i}@example.com`, heslo: 'heslo12345' } }, posledni);
  }

  assert.equal(posledni.statusCode, 429);
});
