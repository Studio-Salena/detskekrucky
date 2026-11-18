// Falešný finanční server EET pro LOKÁLNÍ testy (žádná síť). Podepisuje odpovědi
// testovacím certifikátem „TEST FS EET“ vydaným testovací CA z test/fixtures/eet
// (vygenerované jen pro testy, nikde neplatné). Ověří podpis přijaté zprávy jako FS.
// Nenahrazuje skutečný test proti Playgroundu (scripts/eet-playground.js).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { NS, ALG } = require('../lib/eetZprava');

const F = n => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'eet', n), 'utf8');
const PKI = {
  ca: F('test-ca.pem'),
  fsCert: F('test-fs.pem'), fsKlic: F('test-fs-klic.pem'),
  poklCert: F('test-pokl.pem'), poklKlic: F('test-pokl-klic.pem'),
  ciziCert: F('test-cizi.pem'), ciziKlic: F('test-cizi-klic.pem')
};

function konfigTest(extra = {}) {
  return { prostredi: 'test', testovaci: true, url: 'https://fs.test.invalid/eet', podpisCn: 'TEST FS EET', eic: 'CZ00000019',
    idProvoz: '11', idPokl: 'POKL-1', timeout: 2000, certPem: PKI.poklCert, klicPem: PKI.poklKlic,
    duveryhodneCa: [new crypto.X509Certificate(PKI.ca)], ...extra };
}

const X509V3 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const BASE64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
const b64 = pem => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const ted = () => require('../lib/eetZprava').casEet(new Date());

// Odpověď ve tvaru Playgroundu; podepsaná (potvrzení) nebo nepodepsaná (chyba)
function odpoved({ uuid, pok = null, kod = null, text = '', test = true, varovani = [], podepsat = true, cert = PKI.fsCert, klic = PKI.fsKlic, upravit = null }) {
  const idBody = 'Body-' + crypto.randomUUID(), idTok = 'SecurityToken-' + crypto.randomUUID();
  const vnitrek = pok
    ? `<eet:Hlavicka uuid_zpravy="${uuid}" dat_prij="${ted()}"/><eet:Potvrzeni pok="${pok}" test="${test}"/>`
    : `<eet:Hlavicka uuid_zpravy="${uuid}" dat_odmit="${ted()}"/><eet:Chyba kod="${kod}" test="${test}">${text}</eet:Chyba>`;
  const varov = varovani.map(v => `<eet:Varovani kod_varov="${v}">Varovani ${v}</eet:Varovani>`).join('');
  let xml = `<soapenv:Envelope xmlns:eet="${NS.eet}" xmlns:wsu="${NS.wsu}" xmlns:wsse="${NS.wsse}" xmlns:soapenv="${NS.soap}">`
    + (podepsat ? `<soapenv:Header><wsse:Security><wsse:BinarySecurityToken wsu:Id="${idTok}" EncodingType="${BASE64}" ValueType="${X509V3}">${b64(cert)}</wsse:BinarySecurityToken></wsse:Security></soapenv:Header>` : '<soapenv:Header/>')
    + `<soapenv:Body wsu:Id="${idBody}"><eet:Odpoved>${vnitrek}${varov}</eet:Odpoved></soapenv:Body></soapenv:Envelope>`;
  if (podepsat) {
    const sig = new SignedXml({ privateKey: klic, publicCert: cert, signatureAlgorithm: ALG.rsaSha256, canonicalizationAlgorithm: ALG.c14n,
      idMode: 'wssecurity', getKeyInfoContent: () => `<wsse:SecurityTokenReference><wsse:Reference URI="#${idTok}" ValueType="${X509V3}"/></wsse:SecurityTokenReference>` });
    sig.addReference({ xpath: `//*[local-name(.)='Body']`, transforms: [ALG.c14n], digestAlgorithm: ALG.sha256 });
    sig.computeSignature(xml, { prefix: 'ds', location: { reference: `//*[local-name(.)='Security']`, action: 'append' } });
    xml = sig.getSignedXml();
  }
  return upravit ? upravit(xml) : xml;
}

// Rozebere a ověří zprávu jako FS (podpis Body certifikátem z BinarySecurityToken)
function rozebratPozadavek(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const el = (ns, n) => doc.getElementsByTagNameNS(ns, n)[0];
  const h = el(NS.eet, 'Hlavicka'), d = el(NS.eet, 'Data');
  const token = el(NS.wsse, 'BinarySecurityToken');
  const cert = new crypto.X509Certificate(Buffer.from(token.textContent.replace(/\s+/g, ''), 'base64'));
  const sx = new SignedXml({ publicCert: cert.toString() });
  sx.loadSignature(doc.getElementsByTagNameNS(NS.ds, 'Signature')[0]);
  let podpisOk;
  try { podpisOk = sx.checkSignature(xml); } catch { podpisOk = false; } // xml-crypto při nesouladu vyhazuje
  const a = (e, n) => (e.hasAttribute(n) ? e.getAttribute(n) : null);
  return { podpisOk, uuid: a(h, 'uuid_zpravy'), prvni: a(h, 'prvni_zaslani'), overeni: a(h, 'overeni'), datOdesl: a(h, 'dat_odesl'),
    eic: a(d, 'eic_popl'), idJednotky: a(d, 'id_jednotky'), idPokl: a(d, 'id_pokl'), poradCis: a(d, 'porad_cis'), datTrzby: a(d, 'dat_trzby'),
    celk: a(d, 'celk_trzba'), urceno: a(d, 'urceno_cerp_zuct'), cerp: a(d, 'cerp_zuct'), velikost: Buffer.byteLength(xml) };
}

// Transport pro frontu: scénáře v pořadí volání ('ok' když dojdou). Každý přijatý požadavek
// se zaznamená do `prijate` (i když se odpověď „ztratí“) – jako by ho FS dostal.
function falesnyFs({ scenare = [], zpozdeni = 0 } = {}) {
  const prijate = [];
  const poky = new Map(); // stejná tržba (kód tržby) = stejný POK, jako u FS
  const transport = async ({ xml, timeout }) => {
    const z = rozebratPozadavek(xml);
    const sc = scenare.length ? scenare.shift() : 'ok';
    prijate.push({ ...z, scenar: sc });
    if (zpozdeni) await new Promise(r => setTimeout(r, zpozdeni));
    const kod = [z.eic, z.idJednotky, z.idPokl, z.poradCis, z.datTrzby, z.celk].join('|');
    if (!poky.has(kod)) poky.set(kod, crypto.randomUUID() + '-ff'); // neprodukční POK končí -ff
    const odp = body => ({ status: 200, body, transakce: 'test-' + prijate.length });
    if (!z.podpisOk) return odp(odpoved({ uuid: z.uuid, kod: 4, text: 'Neplatny podpis SOAP zpravy', podepsat: false }));
    if (z.overeni === 'true' && sc === 'ok') return odp(odpoved({ uuid: z.uuid, kod: 0, text: 'Overovaci mod OK', podepsat: false }));
    switch (sc) {
      case 'timeout': throw Object.assign(new Error(`Bez odpovědi do ${timeout} ms.`), { druh: 'timeout' }); // FS nedostal
      case 'ztracena': throw Object.assign(new Error('Spojení přerušeno po odeslání.'), { druh: 'sit' }); // FS dostal, odpověď nedorazila
      case 'sit': throw Object.assign(new Error('ECONNREFUSED'), { druh: 'sit' });
      case 'chyba-1': return odp(odpoved({ uuid: z.uuid, kod: -1, text: 'Docasna technicka chyba zpracovani', podepsat: false }));
      case 'chyba3': return odp(odpoved({ uuid: z.uuid, kod: 3, text: 'Datova zprava evidovane trzby nebyla zpracovana - XML zprava nevyhovela XML schematu', podepsat: false }));
      case 'podvrh': return odp(odpoved({ uuid: z.uuid, pok: poky.get(kod), cert: PKI.ciziCert, klic: PKI.ciziKlic }));
      case 'jiny-uuid': return odp(odpoved({ uuid: crypto.randomUUID(), pok: poky.get(kod) }));
      case 'bez-podpisu': return odp(odpoved({ uuid: z.uuid, pok: poky.get(kod), podepsat: false }));
      case 'fault': return { status: 500, body: `<soapenv:Envelope xmlns:soapenv="${NS.soap}"><soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode><faultstring>chyba</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`, transakce: null };
      case 'varovani': return odp(odpoved({ uuid: z.uuid, pok: poky.get(kod), varovani: [5] }));
      case 'overeni': return odp(odpoved({ uuid: z.uuid, kod: 0, text: 'Datovou zpravu evidovane trzby v overovacim modu se podarilo zpracovat', podepsat: false }));
      default: return odp(odpoved({ uuid: z.uuid, pok: poky.get(kod) }));
    }
  };
  return { transport, prijate, scenare };
}

module.exports = { PKI, konfigTest, odpoved, rozebratPozadavek, falesnyFs };
