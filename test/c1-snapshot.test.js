// C1 - objednávka bez přihlášení nesmí přepsat údaje zákazníka a objednávka
// nesmí být zpětně ovlivněna změnou zákaznického profilu (snímek obj_*).
// Testují se skutečné routy routes/objednavky.js a routes/auth.js nad
// sdílenou mock DB (test-helpers/_pomocnik.js). Migraci starých objednávek
// testuje proti skutečnému PostgreSQL test/c1-migrace-postgres.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const ADRESA_A = { jmeno: 'Jana Nováková', telefon: '777 111 111', ulice: 'Lipová 1', mesto: 'Hulín', psc: '768 24' };
const ADRESA_B = { jmeno: 'Petr Útočník', telefon: '666 999 999', ulice: 'Cizí 99', mesto: 'Brno', psc: '602 00' };
const POLE = ['jmeno', 'telefon', 'ulice', 'mesto', 'psc'];

let dalsiIp = 1;
const novaIp = () => `10.9.0.${dalsiIp++}`; // objednávky i registrace mají limit na IP

function pripravit(stav) {
  const emaily = [];
  const emailyMock = {
    odeslat_potvrzeni: async (o) => { emaily.push({ typ: 'potvrzeni', o }); },
    odeslat_upozorneni_objednavky: async () => {},
    odeslat_email_zmena_stavu: async (o, s) => { emaily.push({ typ: 'zmena_stavu', o, s }); },
    odeslat_overeni_emailu: async (e) => { emaily.push({ typ: 'overeni', ...e }); }
  };
  const pool = vytvoritMockPool(stav);
  const objednavky = nacistRouterSMocky('../routes/objednavky.js', { '../db/pool': pool, './emaily': emailyMock });
  const auth = nacistRouterSMocky('../routes/auth.js', { '../db/pool': pool, './emaily': emailyMock });
  const zavolat = async (router, method, cesta, req = {}) => {
    const res = vytvoritRes();
    await najitHandler(router, method, cesta)({ ip: novaIp(), headers: {}, params: {}, body: {}, ...req }, res);
    await new Promise(r => setTimeout(r, 0)); // fire-and-forget e-maily
    return res;
  };
  return {
    emaily,
    objednat: (email, udaje) => zavolat(objednavky, 'post', '/', { body: {
      ...udaje, email, doprava: 'zasilkovna', platba: 'prevod', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }]
    } }),
    detail: (id) => zavolat(objednavky, 'get', '/:id', { params: { id: String(id) } }),
    seznam: () => zavolat(objednavky, 'get', '/'),
    zmenitStav: (id, s) => zavolat(objednavky, 'patch', '/:id/stav', { params: { id: String(id) }, body: { stav: s } }),
    upravitZakaznika: (id, udaje) => zavolat(auth, 'put', '/zakaznici/:id', { params: { id: String(id) }, body: udaje }),
    auth: (method, cesta, req) => zavolat(auth, method, cesta, req)
  };
}

function stavSeSkladem() {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 100, dostupnost: 'skladem', cena: 500 });
  return stav;
}
function pridatZakaznika(stav, { overen = false, heslo = null } = {}) {
  const z = { id: stav.dalsiZakaznikId++, email: 'jana@example.com', ...ADRESA_A, heslo, email_overen_at: overen ? new Date('2026-08-01') : null, heslo_zmeneno_at: null };
  stav.zakaznici.push(z);
  return z;
}
const udajeZakaznika = z => Object.fromEntries(POLE.map(p => [p, z[p]]));
const snimek = o => Object.fromEntries(POLE.map(p => [p, o['obj_' + p]]));

async function overitUtokNaZakaznika(stav, z) {
  const t = pripravit(stav);
  const res = await t.objednat('jana@example.com', ADRESA_B);
  assert.equal(res.statusCode, 200, 'objednávka vznikne');
  const objednavka = stav.objednavky.at(-1);
  assert.equal(objednavka.zakaznik_id, z.id, 'objednávka je přiřazená k zákazníkovi podle e-mailu');
  assert.deepEqual(udajeZakaznika(z), ADRESA_A, 'zákazník zůstal beze změny');
  assert.deepEqual(snimek(objednavka), ADRESA_B, 'objednávka má snímek zadaných údajů');
  assert.equal(objednavka.obj_email, 'jana@example.com');
  assert.ok(!stav.zakazaneUpdatyZakazniku, 'objednávka neposlala žádný UPDATE zakaznici');
}

test('C1 test 1: útok na ověřený účet - profil zůstane A, objednávka má snímek B', async () => {
  const stav = stavSeSkladem();
  await overitUtokNaZakaznika(stav, pridatZakaznika(stav, { overen: true, heslo: 'x' }));
});

test('C1 test 2: útok na guest záznam (bez hesla) - záznam beze změny', async () => {
  const stav = stavSeSkladem();
  await overitUtokNaZakaznika(stav, pridatZakaznika(stav));
});

test('C1 test 3: útok na neověřený účet - záznam beze změny', async () => {
  const stav = stavSeSkladem();
  await overitUtokNaZakaznika(stav, pridatZakaznika(stav, { heslo: 'x' }));
});

test('C1 test 4: nový e-mail - vznikne zákazník a snímek odpovídá objednávce', async () => {
  const stav = stavSeSkladem();
  const t = pripravit(stav);
  assert.equal((await t.objednat('nova@example.com', ADRESA_A)).statusCode, 200);
  assert.equal(stav.zakaznici.length, 1);
  assert.deepEqual(udajeZakaznika(stav.zakaznici[0]), ADRESA_A);
  assert.deepEqual(snimek(stav.objednavky[0]), ADRESA_A);
  assert.equal(stav.objednavky[0].obj_email, 'nova@example.com');
  assert.equal(stav.objednavky[0].udaje_doplneny_zpetne, false);
});

test('C1 test 5: dvě objednávky na dvě adresy - první dál ukazuje A', async () => {
  const stav = stavSeSkladem();
  const t = pripravit(stav);
  await t.objednat('jana@example.com', ADRESA_A);
  await t.objednat('jana@example.com', ADRESA_B);
  const [o1, o2] = stav.objednavky;
  assert.deepEqual(udajeZakaznika((await t.detail(o1.id)).body), ADRESA_A);
  assert.deepEqual(udajeZakaznika((await t.detail(o2.id)).body), ADRESA_B);
});

test('C1 test 6: úprava zákazníka adminem nezmění existující objednávku', async () => {
  const stav = stavSeSkladem();
  const t = pripravit(stav);
  await t.objednat('jana@example.com', ADRESA_A);
  const z = stav.zakaznici[0];
  const upr = await t.upravitZakaznika(z.id, { ...ADRESA_B, email: 'jana@example.com' });
  assert.equal(upr.statusCode, 200);
  assert.deepEqual(udajeZakaznika(z), ADRESA_B, 'zákazník se změnil');
  const detail = (await t.detail(stav.objednavky[0].id)).body;
  assert.deepEqual(udajeZakaznika(detail), ADRESA_A, 'objednávka ukazuje údaje z doby nákupu');
});

test('C1 test 7: admin detail i seznam (CSV) čtou snímek, seznam vrací i ulici a PSČ', async () => {
  const stav = stavSeSkladem();
  const z = pridatZakaznika(stav, { overen: true, heslo: 'x' });
  const t = pripravit(stav);
  await t.objednat('jana@example.com', ADRESA_B);
  const id = stav.objednavky[0].id;
  // detail = zdroj pro tisk objednávky, expedici a fakturu v admin.html
  const detail = (await t.detail(id)).body;
  assert.deepEqual(udajeZakaznika(detail), ADRESA_B);
  assert.equal(detail.email, 'jana@example.com');
  assert.deepEqual(udajeZakaznika(z), ADRESA_A);
  const radek = (await t.seznam()).body.find(o => o.id === id);
  assert.equal(radek.ulice, ADRESA_B.ulice, 'CSV export dostane ulici');
  assert.equal(radek.psc, ADRESA_B.psc, 'CSV export dostane PSČ');
  assert.equal(radek.jmeno, ADRESA_B.jmeno);
});

test('C1 test 8: e-mail o změně stavu použije snímek, ne aktuálního zákazníka', async () => {
  const stav = stavSeSkladem();
  const t = pripravit(stav);
  await t.objednat('jana@example.com', ADRESA_A);
  const z = stav.zakaznici[0];
  await t.upravitZakaznika(z.id, { ...ADRESA_B, email: 'jiny@example.com' });
  await t.zmenitStav(stav.objednavky[0].id, 'odeslana');
  const email = t.emaily.find(e => e.typ === 'zmena_stavu');
  assert.ok(email, 'e-mail odešel');
  assert.equal(email.o.jmeno, ADRESA_A.jmeno);
  assert.equal(email.o.email, 'jana@example.com', 'na e-mail z objednávky, ne na nově nastavený');
});

test('C1 test 9: stará objednávka bez snímku - detail spadne zpět na zákazníka (COALESCE)', async () => {
  const stav = stavSeSkladem();
  const z = pridatZakaznika(stav);
  stav.objednavky.push({ id: 50, zakaznik_id: z.id, celkem: 500, stav: 'nova', cislo: '260801' });
  const t = pripravit(stav);
  const detail = (await t.detail(50)).body;
  assert.deepEqual(udajeZakaznika(detail), ADRESA_A);
  assert.equal(detail.email, 'jana@example.com');
});

test('C1 test 11: nákup bez účtu -> registrace -> ověření: účet vidí objednávku, snímek zůstane A', async () => {
  const stav = stavSeSkladem();
  const t = pripravit(stav);
  await t.objednat('jana@example.com', ADRESA_A);
  const reg = await t.auth('post', '/registrace', { body: { jmeno: 'Jana Nová', email: 'jana@example.com', heslo: 'janinoheslo' } });
  assert.equal(reg.body.overeni_odeslano, true, 'host záznam - jen ověřovací odkaz (krok 0)');
  const odkaz = t.emaily.find(e => e.typ === 'overeni').odkaz;
  const over = await t.auth('post', '/overit-email', { body: { token: new URL(odkaz).searchParams.get('overeni'), heslo: 'janinoheslo' } });
  assert.equal(over.statusCode, 200);
  const moje = await t.auth('get', '/moje-objednavky', { headers: { authorization: 'Bearer ' + over.body.token } });
  assert.equal(moje.statusCode, 200);
  assert.equal(moje.body.length, 1, 'předchozí objednávka je v účtu');
  assert.ok(await bcrypt.compare('janinoheslo', stav.zakaznici[0].heslo));
  assert.deepEqual(snimek(stav.objednavky[0]), ADRESA_A);
});

test('C1 test 12: po útočné objednávce vrací profil ověřené zákaznice dál A (zdroj předvyplnění pokladny)', async () => {
  const stav = stavSeSkladem();
  const z = pridatZakaznika(stav, { overen: true, heslo: await bcrypt.hash('janinoheslo', 10) });
  const t = pripravit(stav);
  assert.equal((await t.objednat('jana@example.com', ADRESA_B)).statusCode, 200, 'útočná objednávka vznikla');
  const login = await t.auth('post', '/prihlaseni', { body: { email: 'jana@example.com', heslo: 'janinoheslo' } });
  assert.equal(login.statusCode, 200);
  const profil = (await t.auth('get', '/profil', { headers: { authorization: 'Bearer ' + login.body.token } })).body;
  assert.deepEqual(udajeZakaznika(profil), ADRESA_A);
  // zákaznice v pokladně ručně zadá jinou adresu -> uloží se jen do nové objednávky
  const ADRESA_C = { ...ADRESA_A, ulice: 'Nová 5', mesto: 'Zlín', psc: '760 01' };
  await t.objednat('jana@example.com', ADRESA_C);
  assert.deepEqual(snimek(stav.objednavky.at(-1)), ADRESA_C);
  assert.deepEqual(udajeZakaznika(z), ADRESA_A, 'profil se objednávkou nemění');
});
