// Konfigurace EET: vypnuto bez proměnných, produkce odmítnutá, certifikát a klíč se ověří
// předem a nikam se nevypisují. Bez sítě a bez databáze.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { nacist, popis, ChybaKonfigurace } = require('../lib/eetKonfigurace');
const { Fronta } = require('../lib/eetFronta');
const { konfigTest } = require('../test-helpers/eetFs');

const FIX = n => path.join(__dirname, 'fixtures', 'eet', n);
const zaklad = { EET_PROSTREDI: 'playground', EET_EIC: 'CZ00000019', EET_ID_PROVOZ: '11', EET_ID_POKL: 'POKL-1',
  EET_CERT_PEM: FIX('test-pokl.pem'), EET_KLIC_PEM: FIX('test-pokl-klic.pem') };

test('bez EET_PROSTREDI je EET vypnuté', () => {
  assert.equal(nacist({}), null);
  assert.deepEqual(popis(null), { zapnuto: false });
});

test('produkční odesílání je v této verzi odmítnuté', () => {
  assert.throws(() => nacist({ ...zaklad, EET_PROSTREDI: 'produkce' }), /Produkční odesílání EET není/);
  assert.throws(() => nacist({ ...zaklad, EET_PROSTREDI: 'ostre' }), ChybaKonfigurace);
});

test('certifikát a klíč se kontrolují předem', () => {
  // testovací certifikát z vlastní CA neprojde jako certifikát Playgroundu (jiný vydavatel)
  assert.throws(() => nacist(zaklad), /jiný vydavatel/);
  assert.throws(() => nacist({ ...zaklad, EET_KLIC_PEM: FIX('test-fs-klic.pem') }), /nepatří k certifikátu/);
  assert.throws(() => nacist({ ...zaklad, EET_EIC: 'CZ1212121218' }), /neshoduje/);
  assert.throws(() => nacist({ ...zaklad, EET_CERT_PEM: FIX('neexistuje.pem') }), /nejde načíst/);
  assert.throws(() => nacist({ ...zaklad, EET_ID_PROVOZ: 'abc' }), /EET_ID_PROVOZ/);
  assert.throws(() => nacist({ ...zaklad, EET_EIC: 'CZ1' }), /EET_EIC/);
  // chybové hlášky neobsahují obsah klíče
  try { nacist({ ...zaklad, EET_KLIC_PEM: FIX('test-fs-klic.pem') }); } catch (e) { assert.doesNotMatch(e.message, /PRIVATE KEY|MII/); }
});

test('popis konfigurace pro admin neobsahuje klíč ani certifikát', () => {
  const p = popis(konfigTest());
  assert.equal(JSON.stringify(p).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(p).includes('BEGIN'), false);
  assert.equal(p.prostredi, 'test');
});

test('náhradní transport jen v lokálních testech; testovací konfigurace nesmí po síti', () => {
  const db = { query() {} };
  assert.throws(() => new Fronta({ db, konfig: { ...konfigTest(), prostredi: 'playground' }, transport: async () => ({}) }), /jen v lokálních testech/);
  assert.throws(() => new Fronta({ db, konfig: konfigTest() }), /nesmí odesílat po síti/);
  assert.throws(() => new Fronta({ db, konfig: null }), /vypnuté/);
});
