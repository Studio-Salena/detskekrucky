// Registrace / přihlášení zákazníka a ověření e-mailu (bezpečnostní oprava
// převzetí host záznamu). Testuje skutečný routes/auth.js se stavovou mock DB
// a zachycenými e-maily (žádné skutečné odesílání).
//
// P1.4 - login bez hesla nesmí spadnout do 500.
// P1.5 - login/registrace mají rate limit proti hádání hesla / spamu účtů.
// J1   - host záznam (objednávka bez účtu) ani neověřený účet nejde převzít
//        jen znalostí e-mailu; objednávky/adresu vidí až ověřený majitel.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let dalsiIp = 1;
// Každý test dostane vlastní IP - limitery mají modulovou (sdílenou) paměť,
// takže bez izolace by pokusy z jednoho testu ovlivňovaly limit v jiném.
function novaIp() { return `10.0.0.${dalsiIp++}`; }

function vytvoritStav({ zakaznici = [], objednavky = [] } = {}) {
  return { zakaznici, objednavky, overeni: [], emaily: [] };
}

// Stavová mock DB - rozpoznává přesně ty dotazy, které routes/auth.js posílá.
function vytvoritMockPool(stav) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      const najitZakaznika = id => stav.zakaznici.find(z => z.id === Number(id));

      if (s.startsWith('SELECT 1 FROM information_schema')) return { rows: [{}] };
      if (s.startsWith('ALTER TABLE') || s.startsWith('CREATE TABLE')) return {};

      if (s.startsWith('SELECT id, jmeno, email, heslo, email_overen_at FROM zakaznici WHERE email')) {
        return { rows: stav.zakaznici.filter(z => z.email === params[0]).map(z => ({ ...z })) };
      }
      if (s.startsWith('SELECT * FROM zakaznici WHERE email')) {
        return { rows: stav.zakaznici.filter(z => z.email === params[0]).map(z => ({ ...z })) };
      }
      if (s.startsWith('SELECT id, jmeno, email, telefon, ulice, mesto, psc, email_overen_at, heslo_zmeneno_at FROM zakaznici WHERE id')) {
        const z = najitZakaznika(params[0]);
        return { rows: z ? [{ ...z }] : [] };
      }
      if (s.startsWith('INSERT INTO zakaznici')) {
        const [jmeno, email, heslo, telefon, ulice, mesto, psc] = params;
        const id = stav.zakaznici.length + 1;
        stav.zakaznici.push({ id, jmeno, email, heslo, telefon, ulice, mesto, psc, email_overen_at: null, heslo_zmeneno_at: null });
        return { rows: [{ id }] };
      }
      if (s.startsWith('DELETE FROM overeni_emailu')) return {};
      if (s.startsWith('INSERT INTO overeni_emailu')) {
        const [token_hash, zakaznik_id, heslo_hash, jmeno] = params;
        stav.overeni.push({ token_hash, zakaznik_id, heslo_hash, jmeno, expirace: Date.now() + 24 * 3600 * 1000, pouzito_at: null });
        return {};
      }
      if (s.startsWith('SELECT o.heslo_hash, z.heslo AS heslo_uctu FROM overeni_emailu o JOIN zakaznici z')) {
        const o = stav.overeni.find(o => o.token_hash === params[0] && !o.pouzito_at && o.expirace > Date.now());
        const z = o && najitZakaznika(o.zakaznik_id);
        return { rows: o && z ? [{ heslo_hash: o.heslo_hash, heslo_uctu: z.heslo }] : [] };
      }
      if (s.startsWith('UPDATE overeni_emailu SET pouzito_at = NOW() WHERE token_hash')) {
        const o = stav.overeni.find(o => o.token_hash === params[0] && !o.pouzito_at && o.expirace > Date.now());
        if (!o) return { rows: [] };
        o.pouzito_at = new Date();
        return { rows: [{ zakaznik_id: o.zakaznik_id, heslo_hash: o.heslo_hash, jmeno: o.jmeno }] };
      }
      if (s.startsWith('UPDATE overeni_emailu SET pouzito_at = NOW() WHERE zakaznik_id')) {
        stav.overeni.filter(o => o.zakaznik_id === params[0] && !o.pouzito_at).forEach(o => { o.pouzito_at = new Date(); });
        return {};
      }
      if (s.startsWith('UPDATE zakaznici SET heslo = $1')) {
        const [heslo, jmeno, id, zmeneno] = params;
        const z = najitZakaznika(id);
        if (!z || z.email_overen_at) return { rows: [] };
        Object.assign(z, { heslo, jmeno: jmeno ?? z.jmeno, email_overen_at: new Date(), heslo_zmeneno_at: zmeneno });
        return { rows: [{ id: z.id, jmeno: z.jmeno, email: z.email }] };
      }
      if (s.startsWith('UPDATE zakaznici SET email_overen_at')) {
        const z = najitZakaznika(params[0]);
        if (!z) return { rows: [] };
        z.email_overen_at = z.email_overen_at || new Date();
        return { rows: [{ id: z.id, jmeno: z.jmeno, email: z.email }] };
      }
      if (s.startsWith('SELECT o.id, o.cislo, o.stav, o.celkem, o.vytvoreno, o.doprava FROM objednavky o WHERE o.zakaznik_id')) {
        return { rows: stav.objednavky.filter(o => o.zakaznik_id === Number(params[0])) };
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistAuth(stav) {
  const routePath = require.resolve('../routes/auth.js');
  const poolPath = require.resolve('../db/pool');
  const emailyPath = require.resolve('../routes/emaily');
  for (const p of [routePath, poolPath, emailyPath]) delete require.cache[p];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: vytvoritMockPool(stav) };
  require.cache[emailyPath] = {
    id: emailyPath, filename: emailyPath, loaded: true,
    exports: { odeslat_overeni_emailu: async (e) => { stav.emaily.push(e); } }
  };
  const router = require(routePath);
  for (const p of [routePath, poolPath, emailyPath]) delete require.cache[p];
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

// Pomocníci pro volání endpointů
async function zavolat(router, method, cesta, req) {
  const res = vytvoritRes();
  await najitHandler(router, method, cesta)({ ip: novaIp(), headers: {}, body: {}, ...req }, res);
  return res;
}
const sTokenem = token => ({ headers: { authorization: 'Bearer ' + token } });
const tokenZOdkazu = email => new URL(email.odkaz).searchParams.get('overeni');
async function pockat() { await new Promise(r => setTimeout(r, 0)); } // fire-and-forget odeslání e-mailu

// Host zákazník z objednávky bez účtu (heslo NULL) s adresou a objednávkou
function stavSHostem() {
  return vytvoritStav({
    zakaznici: [{ id: 1, jmeno: 'Jana Host', email: 'jana@example.com', heslo: null, telefon: '777123456', ulice: 'Lipová 1', mesto: 'Hulín', psc: '76824', email_overen_at: null, heslo_zmeneno_at: null }],
    objednavky: [{ id: 10, cislo: '260901', stav: 'nova', celkem: 1500, vytvoreno: new Date(), doprava: 'zasilkovna', zakaznik_id: 1 }]
  });
}

// ─── TEST 1 – nový zákazník ─────────────────────────────────────────────
test('TEST 1: nový e-mail - registrace přihlásí, po ověření účet plně funguje', async () => {
  const stav = vytvoritStav();
  const router = nacistAuth(stav);

  const reg = await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Eva Nová', email: 'eva@example.com', heslo: 'tajneheslo' } });
  assert.equal(reg.statusCode, 200);
  assert.ok(reg.body.token, 'nový zákazník je hned přihlášený (současné chování)');
  assert.equal(reg.body.email_overen, false);
  await pockat();
  assert.equal(stav.emaily.length, 1, 'odešel ověřovací e-mail');

  // před ověřením: objednávky nejsou vidět
  const pred = await zavolat(router, 'get', '/moje-objednavky', sTokenem(reg.body.token));
  assert.equal(pred.statusCode, 403);
  assert.equal(pred.body.overeni_potreba, true);

  const over = await zavolat(router, 'post', '/overit-email', { body: { token: tokenZOdkazu(stav.emaily[0]), heslo: 'tajneheslo' } });
  assert.equal(over.statusCode, 200);
  assert.equal(over.body.email_overen, true);

  const login = await zavolat(router, 'post', '/prihlaseni', { body: { email: 'eva@example.com', heslo: 'tajneheslo' } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.email_overen, true);
  const po = await zavolat(router, 'get', '/moje-objednavky', sTokenem(login.body.token));
  assert.equal(po.statusCode, 200);
  assert.deepEqual(po.body, []);
});

// ─── TEST 2 – existující host zákazník ─────────────────────────────────
test('TEST 2: registrace na e-mail host zákazníka nic nepropojí a nevydá přístup', async () => {
  const stav = stavSHostem();
  const router = nacistAuth(stav);

  const reg = await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Útočník', email: 'jana@example.com', heslo: 'utocnikheslo' } });
  assert.equal(reg.statusCode, 200);
  assert.equal(reg.body.overeni_odeslano, true);
  assert.equal(reg.body.token, undefined, 'žádný JWT před ověřením');
  assert.equal(stav.zakaznici[0].heslo, null, 'host záznam zůstal bez hesla');
  assert.equal(stav.zakaznici[0].jmeno, 'Jana Host', 'údaje host záznamu se nezměnily');
  assert.equal(stav.emaily[0].email, 'jana@example.com', 'odkaz jde jen do schránky majitele e-mailu');
});

// ─── TEST 3 – bez přístupu k e-mailu ───────────────────────────────────
test('TEST 3: bez kliknutí na odkaz se nejde přihlásit ani vidět objednávky/adresu', async () => {
  const stav = stavSHostem();
  const router = nacistAuth(stav);
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Útočník', email: 'jana@example.com', heslo: 'utocnikheslo' } });

  const login = await zavolat(router, 'post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'utocnikheslo' } });
  assert.equal(login.statusCode, 400, 'čekající heslo nejde použít k přihlášení');
  assert.equal(login.body.token, undefined);

  // ani podvržený token s id host záznamu (bez znalosti JWT_SECRET nejde) nic neukáže
  const falesny = jwt.sign({ id: 1, email: 'jana@example.com' }, 'jiny-secret');
  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(falesny))).statusCode, 401);
  assert.equal((await zavolat(router, 'get', '/profil', sTokenem(falesny))).statusCode, 401);
});

// ─── TEST 4 – po ověření ───────────────────────────────────────────────
test('TEST 4: po kliknutí na platný odkaz se účet propojí a vidí jen své objednávky', async () => {
  const stav = stavSHostem();
  stav.zakaznici.push({ id: 2, jmeno: 'Jiný', email: 'jiny@example.com', heslo: null, email_overen_at: null, heslo_zmeneno_at: null });
  stav.objednavky.push({ id: 11, cislo: '260902', stav: 'nova', celkem: 900, vytvoreno: new Date(), doprava: 'zasilkovna', zakaznik_id: 2 });
  const router = nacistAuth(stav);

  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Jana Nová', email: 'jana@example.com', heslo: 'janinoheslo' } });
  const over = await zavolat(router, 'post', '/overit-email', { body: { token: tokenZOdkazu(stav.emaily[0]), heslo: 'janinoheslo' } });
  assert.equal(over.statusCode, 200);
  assert.ok(over.body.token);
  assert.equal(over.body.jmeno, 'Jana Nová');
  assert.ok(await bcrypt.compare('janinoheslo', stav.zakaznici[0].heslo), 'heslo nastavené až teď');

  const obj = await zavolat(router, 'get', '/moje-objednavky', sTokenem(over.body.token));
  assert.equal(obj.statusCode, 200);
  assert.deepEqual(obj.body.map(o => o.cislo), ['260901'], 'jen vlastní objednávka, ne cizí');

  const profil = await zavolat(router, 'get', '/profil', sTokenem(over.body.token));
  assert.equal(profil.body.ulice, 'Lipová 1', 'adresa z dřívější objednávky zůstala (patří ověřenému majiteli)');
  assert.equal(profil.body.telefon, '777123456');

  const login = await zavolat(router, 'post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'janinoheslo' } });
  assert.equal(login.statusCode, 200);
});

// ─── TEST 5 – změněný token ────────────────────────────────────────────
test('TEST 5: upravený token je odmítnut', async () => {
  const stav = stavSHostem();
  const router = nacistAuth(stav);
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Jana', email: 'jana@example.com', heslo: 'janinoheslo' } });
  const token = tokenZOdkazu(stav.emaily[0]);
  const upraveny = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);

  const res = await zavolat(router, 'post', '/overit-email', { body: { token: upraveny, heslo: 'janinoheslo' } });
  assert.equal(res.statusCode, 400);
  assert.equal(stav.zakaznici[0].heslo, null);
  assert.equal((await zavolat(router, 'post', '/overit-email', { body: {} })).statusCode, 400);
});

// ─── TEST 6 – expirovaný token ─────────────────────────────────────────
test('TEST 6: expirovaný token je odmítnut', async () => {
  const stav = stavSHostem();
  const router = nacistAuth(stav);
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Jana', email: 'jana@example.com', heslo: 'janinoheslo' } });
  stav.overeni[0].expirace = Date.now() - 1000;

  const res = await zavolat(router, 'post', '/overit-email', { body: { token: tokenZOdkazu(stav.emaily[0]), heslo: 'janinoheslo' } });
  assert.equal(res.statusCode, 400);
  assert.equal(stav.zakaznici[0].heslo, null);
  assert.equal(stav.zakaznici[0].email_overen_at, null);
});

// ─── TEST 7 – opakované použití ────────────────────────────────────────
test('TEST 7: token po použití nefunguje podruhé; starší čekající odkazy se zneplatní', async () => {
  const stav = stavSHostem();
  const router = nacistAuth(stav);
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Útočník', email: 'jana@example.com', heslo: 'utocnikheslo' } });
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Jana', email: 'jana@example.com', heslo: 'janinoheslo' } });
  const [odkazUtocnika, odkazJany] = stav.emaily.map(tokenZOdkazu);

  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: odkazJany, heslo: 'janinoheslo' } })).statusCode, 200);
  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: odkazJany, heslo: 'janinoheslo' } })).statusCode, 400, 'podruhé ne');
  // starší čekající odkaz útočníka už nesmí heslo přepsat - ani se správným heslem útočníka
  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: odkazUtocnika, heslo: 'utocnikheslo' } })).statusCode, 400);
  assert.ok(await bcrypt.compare('janinoheslo', stav.zakaznici[0].heslo));
});

// ─── TEST 8 – cizí účet ────────────────────────────────────────────────
test('TEST 8: útočník předregistruje cizí e-mail - majitel ho převezme a útočníkův token přestane platit', async () => {
  const stav = vytvoritStav();
  const router = nacistAuth(stav);

  // útočník si založí účet na cizí (zatím nepoužitý) e-mail a je přihlášen, ale neověřen
  const utocnik = await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Útočník', email: 'jana@example.com', heslo: 'utocnikheslo' } });
  assert.ok(utocnik.body.token);
  // skutečná majitelka pak nakoupí bez účtu - objednávka se přiřadí k záznamu podle e-mailu
  Object.assign(stav.zakaznici[0], { telefon: '777123456', ulice: 'Lipová 1', mesto: 'Hulín', psc: '76824' });
  stav.objednavky.push({ id: 10, cislo: '260901', stav: 'nova', celkem: 1500, vytvoreno: new Date(), doprava: 'zasilkovna', zakaznik_id: 1 });

  const objUtocnika = await zavolat(router, 'get', '/moje-objednavky', sTokenem(utocnik.body.token));
  assert.equal(objUtocnika.statusCode, 403, 'neověřený účet cizí objednávky nevidí');
  const profilUtocnika = await zavolat(router, 'get', '/profil', sTokenem(utocnik.body.token));
  assert.equal(profilUtocnika.body.ulice, undefined, 'ani adresu');
  assert.equal(profilUtocnika.body.telefon, undefined, 'ani telefon');

  // majitelka se zaregistruje (e-mail "existuje") - dostane odkaz, ne chybu "už má účet"
  const reg = await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Jana', email: 'jana@example.com', heslo: 'janinoheslo' } });
  assert.equal(reg.body.overeni_odeslano, true);
  const over = await zavolat(router, 'post', '/overit-email', { body: { token: tokenZOdkazu(stav.emaily.at(-1)), heslo: 'janinoheslo' } });
  assert.equal(over.statusCode, 200);

  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(utocnik.body.token))).statusCode, 401, 'starý token útočníka neplatí');
  assert.equal((await zavolat(router, 'get', '/profil', sTokenem(utocnik.body.token))).statusCode, 401);
  assert.equal((await zavolat(router, 'post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'utocnikheslo' } })).statusCode, 400, 'staré heslo útočníka neplatí');
  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(over.body.token))).body.length, 1, 'majitelka svou objednávku vidí');
});

// ─── TEST 9 – existující účet ──────────────────────────────────────────
test('TEST 9: stávající (ověřený) účet funguje dál a registrací ho nejde převzít', async () => {
  const stav = vytvoritStav({
    zakaznici: [{ id: 1, jmeno: 'Petra', email: 'petra@example.com', heslo: await bcrypt.hash('petrinoheslo', 10), telefon: '777000111', ulice: 'Dlouhá 5', mesto: 'Kroměříž', psc: '76701', email_overen_at: new Date('2026-08-01'), heslo_zmeneno_at: null }],
    objednavky: [{ id: 10, cislo: '260801', stav: 'dorucena', celkem: 2000, vytvoreno: new Date(), doprava: 'ceska_posta', zakaznik_id: 1 }]
  });
  const router = nacistAuth(stav);

  const login = await zavolat(router, 'post', '/prihlaseni', { body: { email: 'petra@example.com', heslo: 'petrinoheslo' } });
  assert.equal(login.statusCode, 200);
  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(login.body.token))).body.length, 1);
  assert.equal((await zavolat(router, 'get', '/profil', sTokenem(login.body.token))).body.ulice, 'Dlouhá 5');

  const reg = await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Útočník', email: 'petra@example.com', heslo: 'utocnikheslo' } });
  assert.equal(reg.statusCode, 400);
  assert.match(reg.body.chyba, /už má účet/);
  assert.equal(stav.overeni.length, 0, 'žádný čekající odkaz k ověřenému účtu');
  assert.equal(stav.emaily.length, 0);
});

test('token vydaný před zavedením "vydano" (jen iat) u účtu bez změny hesla dál platí', async () => {
  const stav = vytvoritStav({
    zakaznici: [{ id: 1, jmeno: 'Petra', email: 'petra@example.com', heslo: 'x', email_overen_at: new Date('2026-08-01'), heslo_zmeneno_at: null }]
  });
  const router = nacistAuth(stav);
  const staryToken = jwt.sign({ id: 1, email: 'petra@example.com' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(staryToken))).statusCode, 200);
});

test('znovu odeslání ověření jde jen přihlášenému neověřenému účtu', async () => {
  const stav = vytvoritStav();
  const router = nacistAuth(stav);
  const reg = await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Eva', email: 'eva@example.com', heslo: 'tajneheslo' } });
  await pockat();
  assert.equal((await zavolat(router, 'post', '/overeni-znovu', {})).statusCode, 401);
  assert.equal((await zavolat(router, 'post', '/overeni-znovu', sTokenem(reg.body.token))).statusCode, 200);
  assert.equal(stav.emaily.length, 2);
});

// ─── původní testy (validace, login, rate limit) ───────────────────────
test('přihlášení na účet bez hesla vrátí 400, ne 500', async () => {
  const router = nacistAuth(stavSHostem());
  const res = await zavolat(router, 'post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'cokoliv' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /Neplatny email nebo heslo/);
});

test('opakované špatné heslo ze stejné IP je po pár pokusech zablokováno (429)', async () => {
  const stav = vytvoritStav({ zakaznici: [{ id: 1, email: 'jana@example.com', heslo: await bcrypt.hash('spravneheslo', 10), email_overen_at: new Date() }] });
  const handler = najitHandler(nacistAuth(stav), 'post', '/prihlaseni');
  const ip = novaIp();
  let posledni;
  for (let i = 0; i < 11; i++) {
    posledni = vytvoritRes();
    await handler({ ip, body: { email: 'jana@example.com', heslo: 'spatne' } }, posledni);
  }
  assert.equal(posledni.statusCode, 429);
});

test('rate limit blokuje jen útočníkovu IP, ne ostatní zákazníky', async () => {
  const stav = vytvoritStav({ zakaznici: [{ id: 1, email: 'jana@example.com', heslo: await bcrypt.hash('spravneheslo', 10), email_overen_at: new Date() }] });
  const handler = najitHandler(nacistAuth(stav), 'post', '/prihlaseni');
  const utocnikIp = novaIp();
  for (let i = 0; i < 11; i++) {
    await handler({ ip: utocnikIp, body: { email: 'jana@example.com', heslo: 'spatne' } }, vytvoritRes());
  }
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { email: 'jana@example.com', heslo: 'spravneheslo' } }, res);
  assert.equal(res.statusCode, 200);
});

test('opakovaná registrace ze stejné IP je po pár pokusech zablokována (429)', async () => {
  const handler = najitHandler(nacistAuth(vytvoritStav()), 'post', '/registrace');
  const ip = novaIp();
  let posledni;
  for (let i = 0; i < 9; i++) {
    posledni = vytvoritRes();
    await handler({ ip, body: { jmeno: 'Test Uživatel', email: `spam${i}@example.com`, heslo: 'heslo12345' } }, posledni);
  }
  assert.equal(posledni.statusCode, 429);
});

test('registrace odmítne e-mail bez zavináče', async () => {
  const stav = vytvoritStav();
  const res = await zavolat(nacistAuth(stav), 'post', '/registrace', { body: { jmeno: 'Jana Nová', email: 'jana.example.com', heslo: 'tajneheslo123' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /@/);
  assert.equal(stav.zakaznici.length, 0);
});

test('registrace odmítne heslo kratší než 5 znaků', async () => {
  const stav = vytvoritStav();
  const res = await zavolat(nacistAuth(stav), 'post', '/registrace', { body: { jmeno: 'Jana Nová', email: 'jana@example.com', heslo: '1234' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /alespoň 5 znaků/);
  assert.equal(stav.zakaznici.length, 0);
});

// ─── C2 / C3 (následný audit) ──────────────────────────────────────────
// Nákup bez účtu přesně jako routes/objednavky.js: zákazník se najde podle
// e-mailu (nebo vznikne) a objednávka mu PŘEPÍŠE jméno, telefon a adresu.
function nakupBezUctu(stav, email, { jmeno, telefon, ulice, mesto, psc }) {
  let z = stav.zakaznici.find(z => z.email === email);
  if (!z) {
    z = { id: stav.zakaznici.length + 1, email, heslo: null, email_overen_at: null, heslo_zmeneno_at: null };
    stav.zakaznici.push(z);
  }
  Object.assign(z, { jmeno, telefon, ulice, mesto, psc });
  const cislo = '2610' + String(stav.objednavky.length + 1).padStart(2, '0');
  stav.objednavky.push({ id: 100 + stav.objednavky.length, cislo, stav: 'nova', celkem: 1200, vytvoreno: new Date(), doprava: 'zasilkovna', zakaznik_id: z.id });
  return cislo;
}
const OBET = { jmeno: 'Jana Nováková', telefon: '777123456', ulice: 'Lipová 1', mesto: 'Hulín', psc: '76824' };

test('C2: předregistrovaný neověřený účet nedostane jméno oběti z nákupu (login ani profil)', async () => {
  const stav = vytvoritStav();
  const router = nacistAuth(stav);

  // A. útočník předregistruje cizí e-mail
  const reg = await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Útočník', email: 'jana@example.com', heslo: 'utocnikheslo' } });
  assert.equal(reg.body.jmeno, 'Útočník', 'registrace vrací jen jméno, které útočník sám zadal');
  // B. oběť nakoupí bez účtu se stejným e-mailem a jiným jménem
  nakupBezUctu(stav, 'jana@example.com', OBET);
  assert.equal(stav.zakaznici[0].jmeno, 'Jana Nováková', 'předpoklad: objednávka jméno v záznamu přepsala');

  // C. + D. login a profil útočníka jméno oběti nevrátí
  const login = await zavolat(router, 'post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'utocnikheslo' } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.jmeno, null);
  assert.equal(login.body.email_overen, false);
  const profil = await zavolat(router, 'get', '/profil', sTokenem(login.body.token));
  assert.equal(profil.body.jmeno, null);
  assert.equal(profil.body.email, 'jana@example.com', 'e-mail, který sám zadal, vidí dál');
  for (const pole of ['telefon', 'ulice', 'mesto', 'psc']) assert.equal(profil.body[pole], undefined, pole);
  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(login.body.token))).statusCode, 403);
  assert.ok(!JSON.stringify([login.body, profil.body]).includes('Nováková'), 'jméno oběti nikde v odpovědích');

  // E. po legitimním ověření (oběť převezme záznam) je jméno správně dostupné
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Jana Nováková', email: 'jana@example.com', heslo: 'janinoheslo' } });
  const over = await zavolat(router, 'post', '/overit-email', { body: { token: tokenZOdkazu(stav.emaily.at(-1)), heslo: 'janinoheslo' } });
  assert.equal(over.statusCode, 200);
  assert.equal(over.body.jmeno, 'Jana Nováková');
  const loginJany = await zavolat(router, 'post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'janinoheslo' } });
  assert.equal(loginJany.body.jmeno, 'Jana Nováková');
  const profilJany = await zavolat(router, 'get', '/profil', sTokenem(loginJany.body.token));
  assert.equal(profilJany.body.jmeno, 'Jana Nováková');
  assert.equal(profilJany.body.ulice, 'Lipová 1');
});

test('C2: legitimní nový zákazník po ověření vidí své jméno v loginu i profilu', async () => {
  const stav = vytvoritStav();
  const router = nacistAuth(stav);
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Eva Nová', email: 'eva@example.com', heslo: 'tajneheslo' } });
  await pockat();
  assert.equal((await zavolat(router, 'post', '/prihlaseni', { body: { email: 'eva@example.com', heslo: 'tajneheslo' } })).body.jmeno, null, 'před ověřením bez jména');

  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: tokenZOdkazu(stav.emaily[0]), heslo: 'tajneheslo' } })).statusCode, 200);
  const login = await zavolat(router, 'post', '/prihlaseni', { body: { email: 'eva@example.com', heslo: 'tajneheslo' } });
  assert.equal(login.body.jmeno, 'Eva Nová');
  assert.equal((await zavolat(router, 'get', '/profil', sTokenem(login.body.token))).body.jmeno, 'Eva Nová');
});

test('C3: oběť klikne na odkaz z útočníkovy registrace nového e-mailu - bez útočníkova hesla se nic neověří', async () => {
  const stav = vytvoritStav();
  const router = nacistAuth(stav);
  const utocnik = await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Útočník', email: 'jana@example.com', heslo: 'utocnikheslo' } });
  await pockat();
  const odkaz = tokenZOdkazu(stav.emaily[0]); // přišel do schránky oběti
  nakupBezUctu(stav, 'jana@example.com', OBET);

  // oběť jen klikne (bez hesla) / zadá své vlastní heslo
  const jenOdkaz = await zavolat(router, 'post', '/overit-email', { body: { token: odkaz } });
  assert.equal(jenOdkaz.statusCode, 400);
  assert.equal(jenOdkaz.body.heslo_potreba, true);
  const jejiHeslo = await zavolat(router, 'post', '/overit-email', { body: { token: odkaz, heslo: 'janinoheslo' } });
  assert.equal(jejiHeslo.statusCode, 400);
  assert.equal(jejiHeslo.body.token, undefined);

  assert.equal(stav.zakaznici[0].email_overen_at, null, 'účet útočníka zůstal neověřený');
  assert.equal(stav.overeni[0].pouzito_at, null, 'neúspěšný pokus token nespotřebuje');
  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(utocnik.body.token))).statusCode, 403);
  const profil = await zavolat(router, 'get', '/profil', sTokenem(utocnik.body.token));
  assert.equal(profil.body.ulice, undefined);
  assert.equal(profil.body.telefon, undefined);

  // oběť si založí účet sama -> převezme záznam svým heslem, útočník je odříznut
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Jana Nováková', email: 'jana@example.com', heslo: 'janinoheslo' } });
  const over = await zavolat(router, 'post', '/overit-email', { body: { token: tokenZOdkazu(stav.emaily.at(-1)), heslo: 'janinoheslo' } });
  assert.equal(over.statusCode, 200);
  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(over.body.token))).body.length, 1);
  assert.equal((await zavolat(router, 'get', '/moje-objednavky', sTokenem(utocnik.body.token))).statusCode, 401, 'starý token útočníka neplatí');
  assert.equal((await zavolat(router, 'post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'utocnikheslo' } })).statusCode, 400, 'heslo útočníka neplatí');
  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: odkaz, heslo: 'utocnikheslo' } })).statusCode, 400, 'původní odkaz už nic neověří');
});

test('C3: oběť klikne na odkaz z útočníkovy registrace na svůj host e-mail - heslo útočníka se nenastaví', async () => {
  const stav = stavSHostem();
  const router = nacistAuth(stav);
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Útočník', email: 'jana@example.com', heslo: 'utocnikheslo' } });
  const odkazUtocnika = tokenZOdkazu(stav.emaily[0]);

  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: odkazUtocnika } })).statusCode, 400);
  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: odkazUtocnika, heslo: 'janinoheslo' } })).statusCode, 400);
  assert.equal(stav.zakaznici[0].heslo, null, 'host záznam bez hesla');
  assert.equal(stav.zakaznici[0].email_overen_at, null);
  assert.equal((await zavolat(router, 'post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'utocnikheslo' } })).statusCode, 400);

  // bezpečná větev převzetí funguje dál: registrace oběti -> odkaz -> její heslo
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Jana', email: 'jana@example.com', heslo: 'janinoheslo' } });
  const over = await zavolat(router, 'post', '/overit-email', { body: { token: tokenZOdkazu(stav.emaily.at(-1)), heslo: 'janinoheslo' } });
  assert.equal(over.statusCode, 200);
  assert.ok(await bcrypt.compare('janinoheslo', stav.zakaznici[0].heslo));
  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: odkazUtocnika, heslo: 'utocnikheslo' } })).statusCode, 400, 'útočníkův odkaz ani s jeho heslem už nic nezmění');
});

test('C3: překlep v hesle token nespotřebuje, správné heslo pak ověření dokončí', async () => {
  const stav = vytvoritStav();
  const router = nacistAuth(stav);
  await zavolat(router, 'post', '/registrace', { body: { jmeno: 'Eva', email: 'eva@example.com', heslo: 'tajneheslo' } });
  await pockat();
  const odkaz = tokenZOdkazu(stav.emaily[0]);
  assert.equal((await zavolat(router, 'post', '/overit-email', { body: { token: odkaz, heslo: 'tajnehesl' } })).statusCode, 400);
  const ok = await zavolat(router, 'post', '/overit-email', { body: { token: odkaz, heslo: 'tajneheslo' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.email_overen, true);
});
