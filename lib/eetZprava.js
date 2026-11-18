// EET 2.0 – datová zpráva evidované tržby (SOAP 1.1 + WS-Security 1.1) a zpracování odpovědi.
// Podklady (docs/eet-krok3.md): Popis datového rozhraní v1.2 (25. 8. 2026) kap. 3 a 5,
// XSD EETXMLSchema v4.1, WSDL EETServiceSOAP v4.1, popis položek datové zprávy v1.0.
//
// Podpis: podepisuje se právě jeden element <soap:Body> s e-tržbou, Exclusive C14N,
// SHA-256, RSA-SHA256, certifikát poplatníka v wsse:BinarySecurityToken (X509v3),
// odkaz z ds:KeyInfo přes wsse:SecurityTokenReference. Žádné další hlavičky.
// Odpověď: potvrzení musí být podepsané certifikátem FS (ověří se řetězec k důvěryhodné
// CA a jméno podepisujícího), UUID odpovědi = UUID odeslané zprávy, příznak test musí
// odpovídat prostředí. Podepsaný musí být právě ten Body, ze kterého se čte odpověď.
'use strict';
const crypto = require('node:crypto');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');

const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  eet: 'http://fs.gov.cz/eet/schema/v4',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  ds: 'http://www.w3.org/2000/09/xmldsig#'
};
const X509V3 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const BASE64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
const ALG = {
  c14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
};

class ChybaZpravy extends Error {}
class ChybaOdpovedi extends Error {}

// ─── Formáty položek (XSD EETXMLSchema v4.1) ───
const RE = {
  string20: /^[0-9a-zA-Z.,:;/#\-_ ]{1,20}$/,
  string25: /^[0-9a-zA-Z.,:;/#\-_ ]{1,25}$/,
  dateTime: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/,
  castka: /^((0|-?[1-9]\d{0,7})\.\d\d|-0\.(0[1-9]|[1-9]\d))$/,
  idJednotky: /^[1-9][0-9]{0,8}$/,
  uuid4: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
  eic: /^CZ[0-9]{8,10}$/,
  pok: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-[0-9a-fA-F]{2}$/
};

// Částka na dvě desetinná místa (XSD CastkaType); haléře přes celá čísla, ne float
function castka(n) {
  const halere = Math.round(Number(n) * 100);
  if (!Number.isFinite(halere)) throw new ChybaZpravy('Neplatná částka: ' + n);
  const znam = halere < 0 ? '-' : '';
  const a = Math.abs(halere);
  const s = `${znam}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
  return s === '-0.00' ? '0.00' : s;
}

// Čas ve tvaru XSD s časovou zónou Europe/Prague (+01:00 / +02:00), bez milisekund
function casEet(datum) {
  const d = new Date(datum);
  if (Number.isNaN(d.getTime())) throw new ChybaZpravy('Neplatný čas: ' + datum);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  const mistni = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second);
  const posun = Math.round((mistni - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const z = posun >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(posun) / 60)).padStart(2, '0'), mm = String(Math.abs(posun) % 60).padStart(2, '0');
  return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}:${f.second}${z}${hh}:${mm}`;
}

// Kontrola datové zprávy podle XSD (struktura i formáty) - vrací seznam chyb
function overitData({ hlavicka, data }) {
  const ch = [];
  const pole = (nazev, hodnota, re, povinne = true) => {
    if (hodnota == null || hodnota === '') { if (povinne) ch.push(`${nazev}: chybí`); return; }
    if (!re.test(String(hodnota))) ch.push(`${nazev}: neplatný formát (${hodnota})`);
  };
  pole('uuid_zpravy', hlavicka.uuid, RE.uuid4);
  pole('dat_odesl', hlavicka.datOdesl, RE.dateTime);
  if (typeof hlavicka.prvni !== 'boolean') ch.push('prvni_zaslani: musí být true/false');
  if (hlavicka.overeni != null && typeof hlavicka.overeni !== 'boolean') ch.push('overeni: musí být true/false');
  pole('eic_popl', data.eic, RE.eic);
  pole('id_jednotky', data.idJednotky, RE.idJednotky);
  pole('id_pokl', data.idPokl, RE.string20);
  pole('porad_cis', data.poradCis, RE.string25);
  pole('dat_trzby', data.datTrzby, RE.dateTime);
  pole('celk_trzba', data.celk, RE.castka);
  pole('urceno_cerp_zuct', data.urceno, RE.castka, false);
  pole('cerp_zuct', data.cerp, RE.castka, false);
  for (const [n, v] of [['celk_trzba', data.celk], ['urceno_cerp_zuct', data.urceno], ['cerp_zuct', data.cerp]]) {
    if (v != null && (Number(v) <= -100000000 || Number(v) >= 100000000)) ch.push(`${n}: mimo rozsah`);
  }
  return ch;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const nahodneId = p => p + '-' + crypto.randomBytes(16).toString('hex').toUpperCase();
const pemNaBase64 = pem => String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

// Podepsaná SOAP obálka datové zprávy evidované tržby
function sestavitObalku({ hlavicka, data, certPem, klicPem }) {
  const chyby = overitData({ hlavicka, data });
  if (chyby.length) throw new ChybaZpravy('Datová zpráva neodpovídá XSD: ' + chyby.join('; '));
  const idTokenu = nahodneId('X509'), idBody = nahodneId('id');
  // nepovinné položky se uvádějí, jen když jsou relevantní (ne s nulovou hodnotou)
  const atrHlavicka = [['dat_odesl', hlavicka.datOdesl], ['overeni', hlavicka.overeni == null ? null : String(hlavicka.overeni)],
    ['prvni_zaslani', String(hlavicka.prvni)], ['uuid_zpravy', hlavicka.uuid]];
  const atrData = [['celk_trzba', data.celk], ['cerp_zuct', data.cerp], ['dat_trzby', data.datTrzby], ['eic_popl', data.eic],
    ['id_jednotky', data.idJednotky], ['id_pokl', data.idPokl], ['porad_cis', data.poradCis], ['urceno_cerp_zuct', data.urceno]];
  const atr = seznam => seznam.filter(([, v]) => v != null && v !== '').map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const xml = `<soap:Envelope xmlns:soap="${NS.soap}" xmlns:eet="${NS.eet}">`
    + `<soap:Header><wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">`
    + `<wsse:BinarySecurityToken EncodingType="${BASE64}" ValueType="${X509V3}" wsu:Id="${idTokenu}">${pemNaBase64(certPem)}</wsse:BinarySecurityToken>`
    + `</wsse:Security></soap:Header>`
    + `<soap:Body xmlns:wsu="${NS.wsu}" wsu:Id="${idBody}"><eet:Trzba>`
    + `<eet:Hlavicka${atr(atrHlavicka)}/><eet:Data${atr(atrData)}/>`
    + `</eet:Trzba></soap:Body></soap:Envelope>`;
  const sig = new SignedXml({
    privateKey: klicPem, publicCert: certPem, signatureAlgorithm: ALG.rsaSha256, canonicalizationAlgorithm: ALG.c14n,
    idMode: 'wssecurity',
    getKeyInfoContent: () => `<wsse:SecurityTokenReference wsu:Id="${nahodneId('STR')}"><wsse:Reference URI="#${idTokenu}" ValueType="${X509V3}"/></wsse:SecurityTokenReference>`
  });
  sig.addReference({ xpath: `//*[local-name(.)='Body' and namespace-uri(.)='${NS.soap}']`, transforms: [ALG.c14n], digestAlgorithm: ALG.sha256 });
  sig.computeSignature(xml, { prefix: 'ds', attrs: { Id: nahodneId('SIG') },
    location: { reference: `//*[local-name(.)='Security' and namespace-uri(.)='${NS.wsse}']`, action: 'append' } });
  return { xml: sig.getSignedXml(), idBody };
}

// ─── Odpověď ───

function prvniPotomek(el, ns, jmeno) {
  for (let n = el && el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.namespaceURI === ns && n.localName === jmeno) return n;
  return null;
}
function vsechnyPrvky(doc, ns, jmeno) { return Array.from(doc.getElementsByTagNameNS(ns, jmeno)); }

// Řetězec certifikátu podepisujícího k důvěryhodné CA (mezilehlé certifikáty z důvěryhodného svazku)
function overitRetezec(cert, duveryhodne, ted = new Date()) {
  const platny = c => new Date(c.validFrom) <= ted && ted <= new Date(c.validTo);
  if (!platny(cert)) return 'certifikát podepisujícího není platný';
  let aktualni = cert;
  for (let hloubka = 0; hloubka < 5; hloubka++) {
    const vydavatel = duveryhodne.find(ca => aktualni.checkIssued(ca) && aktualni.verify(ca.publicKey));
    if (!vydavatel) return 'certifikát podepisujícího nepochází z důvěryhodné certifikační autority';
    if (!platny(vydavatel)) return 'certifikát certifikační autority není platný';
    if (vydavatel.subject === vydavatel.issuer && vydavatel.verify(vydavatel.publicKey)) return null; // kořen
    aktualni = vydavatel;
  }
  return 'řetězec certifikátů je příliš dlouhý';
}
const cnZ = subject => (String(subject).split(/\n|, /).find(x => x.startsWith('CN=')) || '').slice(3);

// Zpracuje odpověď FS. Vrací { druh: 'potvrzeni'|'chyba', ... }; neplatná/podvržená
// odpověď vyhodí ChybaOdpovedi (výsledek odeslání je pak NEZNÁMÝ - zpráva se zopakuje).
function zpracovatOdpoved(xml, { uuid, testovaci, duveryhodneCa = [], podpisCn = null, ted = new Date() }) {
  let doc;
  const chybyParseru = [];
  try {
    doc = new DOMParser({ onError: (u, m) => { if (u !== 'warning') chybyParseru.push(m); } }).parseFromString(String(xml), 'text/xml');
  } catch (e) { throw new ChybaOdpovedi('Odpověď není platné XML: ' + e.message); }
  if (chybyParseru.length || !doc || !doc.documentElement) throw new ChybaOdpovedi('Odpověď není platné XML.');
  const env = doc.documentElement;
  if (env.namespaceURI !== NS.soap || env.localName !== 'Envelope') throw new ChybaOdpovedi('Odpověď není SOAP obálka.');
  const bodies = vsechnyPrvky(doc, NS.soap, 'Body');
  if (bodies.length !== 1 || bodies[0].parentNode !== env) throw new ChybaOdpovedi('Odpověď musí mít právě jeden soap:Body.');
  const body = bodies[0];
  const fault = prvniPotomek(body, NS.soap, 'Fault');
  if (fault) throw new ChybaOdpovedi('SOAP Fault: ' + String(fault.textContent || '').trim().slice(0, 200));
  const odpovedi = vsechnyPrvky(doc, NS.eet, 'Odpoved');
  if (odpovedi.length !== 1 || odpovedi[0].parentNode !== body) throw new ChybaOdpovedi('Odpověď musí obsahovat právě jeden element Odpoved přímo v soap:Body.');
  const odpoved = odpovedi[0];
  const hl = prvniPotomek(odpoved, NS.eet, 'Hlavicka');
  const potvrzeni = prvniPotomek(odpoved, NS.eet, 'Potvrzeni');
  const chyba = prvniPotomek(odpoved, NS.eet, 'Chyba');
  if (!hl || (!potvrzeni === !chyba)) throw new ChybaOdpovedi('Odpověď neodpovídá XSD (Hlavicka + Potvrzeni nebo Chyba).');
  const varovani = vsechnyPrvky(doc, NS.eet, 'Varovani').filter(v => v.parentNode === odpoved)
    .map(v => ({ kod: Number(v.getAttribute('kod_varov')), text: String(v.textContent || '').trim() }));
  const uuidOdpovedi = hl.getAttribute('uuid_zpravy') || null;
  const testAtr = (potvrzeni || chyba).getAttribute('test');
  const test = testAtr === 'true' || testAtr === '1';

  // Podpis: povinný u potvrzení; u chyby se ověří, je-li přítomen
  const podpis = overitPodpis(doc, xml, body, { duveryhodneCa, podpisCn, ted });
  if (potvrzeni) {
    if (!podpis.ok) throw new ChybaOdpovedi('Potvrzení nemá platný podpis FS: ' + podpis.duvod);
    if (uuidOdpovedi !== uuid) throw new ChybaOdpovedi(`UUID potvrzení (${uuidOdpovedi}) neodpovídá odeslané zprávě (${uuid}).`);
    if (test !== testovaci) throw new ChybaOdpovedi(testovaci ? 'Potvrzení z Playgroundu nemá příznak test.' : 'Potvrzení má příznak test – nejde o produkční evidenci.');
    const pok = potvrzeni.getAttribute('pok');
    if (!RE.pok.test(pok || '')) throw new ChybaOdpovedi('POK neodpovídá formátu XSD.');
    // neprodukční POK končí „-ff“ (popis rozhraní 3.4.2.3) – testovací potvrzení nikdy
    // nesmí projít jako produkční a naopak
    const fiktivni = /-ff$/i.test(pok);
    if (testovaci && !fiktivni) throw new ChybaOdpovedi('Potvrzení z neprodukčního prostředí nemá fiktivní POK (-ff).');
    if (!testovaci && fiktivni) throw new ChybaOdpovedi('Potvrzení má fiktivní POK (-ff) – nejde o produkční evidenci.');
    return { druh: 'potvrzeni', pok, test, uuid: uuidOdpovedi, datPrij: hl.getAttribute('dat_prij'), varovani, podpis };
  }
  if (uuidOdpovedi && uuidOdpovedi !== uuid) throw new ChybaOdpovedi(`UUID chybové odpovědi (${uuidOdpovedi}) neodpovídá odeslané zprávě.`);
  if (test !== testovaci && podpis.ok) throw new ChybaOdpovedi('Příznak test v odpovědi neodpovídá prostředí.');
  return { druh: 'chyba', kod: Number(chyba.getAttribute('kod')), text: String(chyba.textContent || '').trim(), test,
    uuid: uuidOdpovedi, datOdmit: hl.getAttribute('dat_odmit'), varovani, podpis };
}

function overitPodpis(doc, xml, body, { duveryhodneCa, podpisCn, ted }) {
  const podpisy = vsechnyPrvky(doc, NS.ds, 'Signature');
  if (!podpisy.length) return { ok: false, duvod: 'odpověď není podepsaná' };
  if (podpisy.length !== 1) return { ok: false, duvod: 'odpověď obsahuje více podpisů' };
  const bodyId = body.getAttributeNS(NS.wsu, 'Id') || body.getAttribute('Id');
  if (!bodyId) return { ok: false, duvod: 'soap:Body nemá identifikátor pro podpis' };
  // certifikát podepisujícího: BinarySecurityToken z hlavičky Security
  const tokeny = vsechnyPrvky(doc, NS.wsse, 'BinarySecurityToken');
  if (tokeny.length !== 1) return { ok: false, duvod: 'chybí (právě jeden) certifikát podepisujícího' };
  let cert;
  try {
    const b64 = String(tokeny[0].textContent).replace(/\s+/g, '');
    cert = new crypto.X509Certificate(Buffer.from(b64, 'base64'));
  } catch { return { ok: false, duvod: 'certifikát podepisujícího nejde načíst' }; }
  const sx = new SignedXml({ publicCert: cert.toString() });
  try {
    sx.loadSignature(podpisy[0]);
    const refs = sx.getReferences();
    if (refs.length !== 1 || refs[0].uri !== '#' + bodyId) return { ok: false, duvod: 'podpis se nevztahuje právě k soap:Body odpovědi' };
    if (sx.signatureAlgorithm !== ALG.rsaSha256) return { ok: false, duvod: 'neočekávaný algoritmus podpisu' };
    if (!sx.checkSignature(String(xml))) return { ok: false, duvod: 'podpis nesedí s obsahem odpovědi' };
  } catch (e) { return { ok: false, duvod: 'podpis nejde ověřit: ' + e.message }; }
  const retezec = overitRetezec(cert, duveryhodneCa, ted);
  if (retezec) return { ok: false, duvod: retezec, podepsal: cert.subject };
  if (podpisCn && cnZ(cert.subject) !== podpisCn) return { ok: false, duvod: `podepsal „${cnZ(cert.subject)}“, očekáván „${podpisCn}“`, podepsal: cert.subject };
  return { ok: true, podepsal: cnZ(cert.subject), otisk: cert.fingerprint256 };
}

module.exports = { NS, RE, ALG, castka, casEet, overitData, sestavitObalku, zpracovatOdpoved, overitRetezec, ChybaZpravy, ChybaOdpovedi };
