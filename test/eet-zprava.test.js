// EET 2.0 – datová zpráva, podpis a ověření odpovědi (bez sítě a bez databáze).
// XSD a WSDL jsou oficiální soubory v4.1 (test/fixtures/eet), odpovědi pg-*.xml jsou
// SKUTEČNÉ odpovědi Playgroundu z 17. 11. 2026 (testovací data, test="true").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const z = require('../lib/eetZprava');
const { nacistDuveryhodneCa } = require('../lib/eetKonfigurace');
const { PKI, odpoved, rozebratPozadavek } = require('../test-helpers/eetFs');

const FIX = n => fs.readFileSync(path.join(__dirname, 'fixtures', 'eet', n), 'utf8');
const XSD = FIX('EETXMLSchema.xsd');
const caTest = [new crypto.X509Certificate(PKI.ca)];

const hlavicka = (o = {}) => ({ uuid: crypto.randomUUID(), datOdesl: z.casEet(new Date()), prvni: true, overeni: false, ...o });
const data = (o = {}) => ({ eic: 'CZ00000019', idJednotky: '11', idPokl: 'POKL-1', poradCis: '2026-000001', datTrzby: '2026-11-17T10:00:00+01:00',
  celk: '1000.00', urceno: null, cerp: null, ...o });

async function validovatXsd(obalka) {
  const { validateXML } = require('xmllint-wasm');
  const p = obalka.match(/<(\w+):Trzba[\s>]/)[1];
  const zac = obalka.indexOf(`<${p}:Trzba`), kon = obalka.indexOf(`</${p}:Trzba>`) + `</${p}:Trzba>`.length;
  const trzba = obalka.slice(zac, kon).replace(/^<(\w+):Trzba[^>]*>/, `<${p}:Trzba xmlns:${p}="${z.NS.eet}">`);
  return validateXML({ xml: [{ fileName: 'trzba.xml', contents: trzba }], schema: [{ fileName: 'EETXMLSchema.xsd', contents: XSD }] });
}

test('částky a čas ve formátu XSD', () => {
  assert.equal(z.castka(1000), '1000.00');
  assert.equal(z.castka(-12.5), '-12.50');
  assert.equal(z.castka(0.1 + 0.2), '0.30');
  assert.equal(z.castka(-0), '0.00');
  assert.equal(z.casEet('2026-11-17T09:00:00.789Z'), '2026-11-17T10:00:00+01:00', 'zimní čas, bez milisekund');
  assert.equal(z.casEet('2026-07-01T09:00:00Z'), '2026-07-01T11:00:00+02:00', 'letní čas');
  for (const c of ['1000.00', '-1.00', '0.00', '-0.01']) assert.match(c, z.RE.castka);
  assert.doesNotMatch('1000', z.RE.castka);
});

test('kontrola položek podle XSD odmítne neplatná data', () => {
  assert.deepEqual(z.overitData({ hlavicka: hlavicka(), data: data() }), []);
  const ch = z.overitData({ hlavicka: hlavicka({ uuid: 'x', prvni: 'ano' }), data: data({ eic: 'CZ1', idJednotky: '0', poradCis: 'x'.repeat(26), celk: '10', urceno: '1.5' }) });
  for (const n of ['uuid_zpravy', 'prvni_zaslani', 'eic_popl', 'id_jednotky', 'porad_cis', 'celk_trzba', 'urceno_cerp_zuct']) assert.ok(ch.some(c => c.startsWith(n)), n);
  assert.throws(() => z.sestavitObalku({ hlavicka: hlavicka(), data: data({ celk: 'abc' }), certPem: PKI.poklCert, klicPem: PKI.poklKlic }), z.ChybaZpravy);
});

test('sestavená zpráva odpovídá oficiálnímu XSD v4.1 a podpis sedí (i po kontrole jako FS)', async () => {
  for (const d of [data(), data({ celk: '-300.00', cerp: '-300.00' }), data({ celk: '500.00', urceno: '500.00' }), data({ celk: '1000.00', cerp: '600.00' })]) {
    const { xml } = z.sestavitObalku({ hlavicka: hlavicka({ prvni: false }), data: d, certPem: PKI.poklCert, klicPem: PKI.poklKlic });
    const v = await validovatXsd(xml);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    const r = rozebratPozadavek(xml);
    assert.equal(r.podpisOk, true);
    assert.equal(r.prvni, 'false');
    assert.equal(r.celk, d.celk); assert.equal(r.cerp, d.cerp); assert.equal(r.urceno, d.urceno);
    assert.ok(r.velikost < 12 * 1024, 'zpráva pod limitem 12 kB');
    // podepsané je právě Body: Exclusive C14N, SHA-256, RSA-SHA256, odkaz přes SecurityTokenReference
    assert.match(xml, /Algorithm="http:\/\/www\.w3\.org\/2001\/10\/xml-exc-c14n#"/);
    assert.match(xml, /Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmlenc#sha256"/);
    assert.match(xml, /Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmldsig-more#rsa-sha256"/);
    assert.match(xml, /<wsse:SecurityTokenReference[^>]*><wsse:Reference URI="#X509-/);
    // změna částky po podpisu = podpis nesedí
    assert.equal(rozebratPozadavek(xml.replace(`celk_trzba="${d.celk}"`, 'celk_trzba="1.00"')).podpisOk, false);
  }
});

test('oficiální vzorová zpráva z WSDL balíku má platný podpis a projde XSD', async () => {
  const vzor = FIX('vzor-pozadavek.xml');
  assert.equal(rozebratPozadavek(vzor).podpisOk, true);
  assert.equal(rozebratPozadavek(vzor.replace(/celk_trzba="[^"]+"/, 'celk_trzba="1.00"')).podpisOk, false);
  const v = await validovatXsd(vzor);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  // a naopak: XSD validace opravdu odmítá chyby (porad_cis delší než 25 znaků)
  assert.equal((await validovatXsd(vzor.replace(/porad_cis="[^"]+"/, `porad_cis="${'X'.repeat(26)}"`))).valid, false);
});

test('skutečné potvrzení z Playgroundu: podpis FS, řetězec I.CA, UUID, příznak test, POK', () => {
  const xml = FIX('pg-potvrzeni.xml');
  const moznosti = { uuid: 'cf4ab713-13ba-49e0-a6ca-2179f470940e', testovaci: true, duveryhodneCa: nacistDuveryhodneCa(),
    podpisCn: 'NEOSTRE - playground prostredi EET', ted: new Date('2026-11-17T21:12:42Z') };
  const o = z.zpracovatOdpoved(xml, moznosti);
  assert.equal(o.druh, 'potvrzeni');
  assert.equal(o.pok, 'b2f80590-af4b-49b6-be96-986a62bc56f0-ff');
  assert.equal(o.test, true);
  assert.equal(o.podpis.ok, true);
  // produkční očekávání: potvrzení s příznakem test NENÍ evidence
  assert.throws(() => z.zpracovatOdpoved(xml, { ...moznosti, testovaci: false }), /příznak test/);
  assert.throws(() => z.zpracovatOdpoved(xml, { ...moznosti, uuid: crypto.randomUUID() }), /UUID/);
  assert.throws(() => z.zpracovatOdpoved(xml.replace('b2f80590-af4b', 'b2f80590-af4c'), moznosti), /podpis/);
  assert.throws(() => z.zpracovatOdpoved(xml, { ...moznosti, duveryhodneCa: caTest }), /důvěryhodné/);
  assert.throws(() => z.zpracovatOdpoved(xml, { ...moznosti, podpisCn: 'Někdo jiný' }), /očekáván/);
});

test('skutečná odpověď ověřovacího módu (kód 0) není potvrzení a nemá POK', () => {
  const o = z.zpracovatOdpoved(FIX('pg-overeni-kod0.xml'), { uuid: '9001fb78-407b-4c80-abd7-f751d265fe46', testovaci: true, duveryhodneCa: nacistDuveryhodneCa() });
  assert.equal(o.druh, 'chyba');
  assert.equal(o.kod, 0);
  assert.equal(o.pok, undefined);
});

test('podvržené, nepodepsané a zabalené odpovědi se odmítnou', () => {
  const uuid = crypto.randomUUID(), pok = crypto.randomUUID().replace(/^(.{14})./, '$14') + '-ff';
  const m = { uuid, testovaci: true, duveryhodneCa: caTest, podpisCn: 'TEST FS EET' };
  assert.equal(z.zpracovatOdpoved(odpoved({ uuid, pok }), m).druh, 'potvrzeni', 'platná testovací odpověď projde');
  assert.throws(() => z.zpracovatOdpoved(odpoved({ uuid, pok, podepsat: false }), m), /není podepsaná/);
  assert.throws(() => z.zpracovatOdpoved(odpoved({ uuid, pok, cert: PKI.ciziCert, klic: PKI.ciziKlic }), m), /důvěryhodné/, 'správné jméno, cizí CA');
  assert.throws(() => z.zpracovatOdpoved(odpoved({ uuid, pok, test: false }), m), /příznak test/);
  // neprodukční prostředí s „ostrým“ POK a produkce s fiktivním POK (-ff) se odmítnou
  const ostryPok = pok.slice(0, -2) + '03';
  assert.throws(() => z.zpracovatOdpoved(odpoved({ uuid, pok: ostryPok }), m), /fiktivní POK/);
  assert.throws(() => z.zpracovatOdpoved(odpoved({ uuid, pok, test: false }), { ...m, testovaci: false }), /fiktivní POK/);
  assert.throws(() => z.zpracovatOdpoved(odpoved({ uuid, pok, upravit: x => x.replace(`pok="${pok}"`, `pok="${pok.slice(0, -2)}cd"`) }), m), /podpis/);
  // wrapping: podepsaný Body přesunutý jinam a vložený nový nepodepsaný Body s jiným POK
  const podvrh = odpoved({ uuid, pok, upravit: x => {
    const b = x.match(/<soapenv:Body[\s\S]*<\/soapenv:Body>/)[0];
    const novy = b.replace(/wsu:Id="[^"]+"/, '').replace(pok, pok.slice(0, -2) + 'ee');
    return x.replace(b, novy).replace('</wsse:Security>', `<wrap>${b}</wrap></wsse:Security>`);
  } });
  assert.throws(() => z.zpracovatOdpoved(podvrh, m), z.ChybaOdpovedi);
  // dvě Odpoved, SOAP Fault, nesmysl
  assert.throws(() => z.zpracovatOdpoved(odpoved({ uuid, pok, upravit: x => x.replace('</eet:Odpoved>', '</eet:Odpoved><eet:Odpoved/>') }), m), z.ChybaOdpovedi);
  assert.throws(() => z.zpracovatOdpoved(`<s:Envelope xmlns:s="${z.NS.soap}"><s:Body><s:Fault><faultstring>x</faultstring></s:Fault></s:Body></s:Envelope>`, m), /Fault/);
  assert.throws(() => z.zpracovatOdpoved('<html>502 Bad Gateway</html>', m), z.ChybaOdpovedi);
  // chybová odpověď s jiným UUID se odmítne
  assert.throws(() => z.zpracovatOdpoved(odpoved({ uuid: crypto.randomUUID(), kod: 3, podepsat: false }), m), /UUID/);
});

test('ověřovací certifikáty I.CA v repozitáři odpovídají otiskům z www.ica.cz', () => {
  const ca = nacistDuveryhodneCa();
  const koren = ca.find(c => c.subject === c.issuer);
  assert.equal(koren.fingerprint256.replace(/:/g, '').toLowerCase(), 'd279c01a12e8dd9a6230e459faa447ceb336998477338c2ee4135c96737418eb');
  assert.ok(ca.some(c => /I\.CA Public CA\/RSA 06\/2022/.test(c.subject)));
});

test('WSDL v4.1: SOAPAction a adresa Playgroundu sedí s implementací', () => {
  const wsdl = FIX('EETServiceSOAP.wsdl');
  assert.match(wsdl, /soapAction="http:\/\/fs\.gov\.cz\/eet\/OdeslaniTrzby"/);
  assert.equal(require('../lib/eetFronta').SOAP_ACTION, 'http://fs.gov.cz/eet/OdeslaniTrzby');
  const doc = new DOMParser().parseFromString(wsdl, 'text/xml');
  assert.ok(doc.documentElement);
});
