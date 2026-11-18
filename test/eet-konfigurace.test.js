// Konfigurace EET: vypnuto bez proměnných, produkce jen při úplném a výslovném nastavení,
// oddělená prostředí (adresa, vydavatel certifikátu, podepisující FS, důvěryhodné CA),
// certifikát a klíč se ověří předem a nikam se nevypisují. Bez sítě a bez databáze.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { nacist, popis, ChybaKonfigurace, PROSTREDI, nacistDuveryhodneCa } = require('../lib/eetKonfigurace');
const { Fronta } = require('../lib/eetFronta');
const { konfigTest } = require('../test-helpers/eetFs');

const FIX = n => path.join(__dirname, 'fixtures', 'eet', n);
const zaklad = { EET_PROSTREDI: 'playground', EET_EIC: 'CZ00000019', EET_ID_PROVOZ: '11', EET_ID_POKL: 'POKL-1',
  EET_CERT_PEM: FIX('test-pokl.pem'), EET_KLIC_PEM: FIX('test-pokl-klic.pem') };
// testovací certifikát s vydavatelem ve tvaru produkční CA EET („EETv2 NCA SubCA RSA …“, neplatný)
const produkce = { EET_PROSTREDI: 'produkce', EET_PRODUKCE_POVOLENA: 'ano', EET_PRODUKCE_OD: '2027-01-01T00:00:00+01:00',
  EET_EIC: 'CZ00000019', EET_ID_PROVOZ: '11', EET_ID_POKL: 'POKL-1', EET_CERT_PEM: FIX('test-prod-pokl.pem'), EET_KLIC_PEM: FIX('test-prod-pokl-klic.pem') };
const TED = new Date('2026-12-01T10:00:00+01:00');

test('výchozí stav: bez EET_PROSTREDI je EET vypnuté (i když jsou ostatní proměnné nastavené)', () => {
  assert.equal(nacist({}), null);
  assert.equal(nacist({ ...produkce, EET_PROSTREDI: '' }), null);
  assert.equal(nacist({ ...produkce, EET_PROSTREDI: '   ' }), null);
  assert.deepEqual(popis(null), { zapnuto: false });
});

test('produkce se nezapne bez výslovného povolení a počátku evidence', () => {
  assert.throws(() => nacist({ ...produkce, EET_PRODUKCE_POVOLENA: undefined }, TED), /EET_PRODUKCE_POVOLENA=ano/);
  for (const spatne of ['1', 'true', 'ANO', 'ano ', 'yes']) {
    assert.throws(() => nacist({ ...produkce, EET_PRODUKCE_POVOLENA: spatne }, TED), /EET_PRODUKCE_POVOLENA=ano/, spatne);
  }
  assert.throws(() => nacist({ ...produkce, EET_PRODUKCE_OD: undefined }, TED), /EET_PRODUKCE_OD/);
  assert.throws(() => nacist({ ...produkce, EET_PRODUKCE_OD: '2027-01-01' }, TED), /časovou zónou/, 'bez zóny ne');
  assert.throws(() => nacist({ ...produkce, EET_PRODUKCE_OD: 'zítra' }, TED), /EET_PRODUKCE_OD/);
  assert.throws(() => nacist({ ...produkce, EET_PRODUKCE_OD: '2026-10-31T23:00:00+01:00' }, TED), /minimálním datem/);
  assert.throws(() => nacist({ ...produkce, EET_PROSTREDI: 'ostre' }, TED), ChybaKonfigurace);
  assert.throws(() => nacist({ ...produkce, EET_PROSTREDI: 'production' }, TED), /Neznámé prostředí/);
  // produkční přepínače u Playgroundu = zmatené nastavení → nic
  assert.throws(() => nacist({ ...zaklad, EET_PRODUKCE_POVOLENA: 'ano' }, TED), /patří jen k EET_PROSTREDI=produkce/);
});

test('certifikát a klíč se kontrolují předem; testovací certifikát nepatří do produkce a naopak', () => {
  // vlastní testovací CA neprojde jako Playground ani jako produkce (jiný vydavatel)
  assert.throws(() => nacist(zaklad, TED), /jiný vydavatel/);
  assert.throws(() => nacist({ ...produkce, EET_CERT_PEM: FIX('test-pokl.pem'), EET_KLIC_PEM: FIX('test-pokl-klic.pem') }, TED), /jiný vydavatel/);
  // „produkční“ certifikát nejde použít v Playgroundu
  assert.throws(() => nacist({ ...zaklad, EET_CERT_PEM: FIX('test-prod-pokl.pem'), EET_KLIC_PEM: FIX('test-prod-pokl-klic.pem') }, TED), /jiný vydavatel/);
  assert.throws(() => nacist({ ...produkce, EET_KLIC_PEM: FIX('test-fs-klic.pem') }, TED), /nepatří k certifikátu/);
  assert.throws(() => nacist({ ...produkce, EET_EIC: 'CZ1212121218' }, TED), /neshoduje/);
  assert.throws(() => nacist({ ...produkce, EET_CERT_PEM: FIX('neexistuje.pem') }, TED), /nejde načíst/);
  assert.throws(() => nacist({ ...produkce, EET_ID_PROVOZ: 'abc' }, TED), /EET_ID_PROVOZ/);
  assert.throws(() => nacist({ ...produkce, EET_EIC: 'CZ1' }, TED), /EET_EIC/);
  assert.throws(() => nacist(produkce, new Date('2099-01-01T00:00:00Z')), /už není platný/);
  try { nacist({ ...produkce, EET_KLIC_PEM: FIX('test-fs-klic.pem') }, TED); } catch (e) { assert.doesNotMatch(e.message, /PRIVATE KEY|MII/); }
});

test('úplná produkční konfigurace: produkční adresa, podepisující, vlastní CA a počátek evidence', () => {
  const k = nacist(produkce, TED);
  assert.equal(k.prostredi, 'produkce');
  assert.equal(k.testovaci, false);
  assert.equal(k.url, 'https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4');
  assert.equal(k.podpisCn, 'Spolecne technicke zarizeni spravce dane EET');
  assert.equal(k.produkceOd.toISOString(), '2026-12-31T23:00:00.000Z');
  assert.ok(Object.isFrozen(k));
  assert.notEqual(PROSTREDI.produkce.url, PROSTREDI.playground.url);
  assert.notEqual(PROSTREDI.produkce.podpisCn, PROSTREDI.playground.podpisCn);
  const p = popis(k);
  assert.equal(p.produkce_od, '2026-12-31T23:00:00.000Z');
  assert.equal(JSON.stringify(p).includes('BEGIN'), false);
});

test('popis konfigurace pro admin neobsahuje klíč ani certifikát', () => {
  const p = popis(konfigTest());
  assert.equal(JSON.stringify(p).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(p).includes('BEGIN'), false);
  assert.equal(p.prostredi, 'test');
});

test('důvěryhodné CA se načítají odděleně podle prostředí', () => {
  for (const pr of ['playground', 'produkce']) {
    const ca = nacistDuveryhodneCa(pr);
    assert.ok(ca.some(c => c.subject === c.issuer && c.fingerprint256.replace(/:/g, '').toLowerCase() === 'd279c01a12e8dd9a6230e459faa447ceb336998477338c2ee4135c96737418eb'), pr);
  }
  assert.throws(() => nacistDuveryhodneCa('test2'), /Neznámé prostředí/);
});

test('náhradní transport jen v lokálních testech; testovací konfigurace nesmí po síti', () => {
  const db = { query() {} };
  assert.throws(() => new Fronta({ db, konfig: { ...konfigTest(), prostredi: 'playground' }, transport: async () => ({}) }), /jen v lokálních testech/);
  assert.throws(() => new Fronta({ db, konfig: { ...konfigTest(), prostredi: 'produkce' }, transport: async () => ({}) }), /jen v lokálních testech/);
  assert.throws(() => new Fronta({ db, konfig: konfigTest() }), /nesmí odesílat po síti/);
  assert.throws(() => new Fronta({ db, konfig: null }), /vypnuté/);
});

test('certifikát s „Bag Attributes“ (výstup openssl pkcs12) se do zprávy dostane jen jako čistý PEM', () => {
  const fs = require('node:fs'), os = require('node:os');
  const necisty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eet-pem-')), 'cert.pem');
  fs.writeFileSync(necisty, 'Bag Attributes\n    localKeyID: AF BD C4 30\nsubject=CN=CZ00000019\n' + fs.readFileSync(FIX('test-prod-pokl.pem'), 'utf8'));
  const k = nacist({ ...produkce, EET_CERT_PEM: necisty }, TED);
  assert.match(k.certPem, /^-----BEGIN CERTIFICATE-----\n/);
  assert.doesNotMatch(k.certPem, /Bag Attributes|localKeyID|subject=/);
});
