// Napojení na GLS (MyGLS API, REST/JSON) podle dokumentace „MyGLS API for
// system integration“ (ver. 25.12.11). Volá se JEN na výslovný klik v adminu:
//   - overitSpojeni(): čtecí GetParcelList, nic nezakládá (tlačítko „Vyzkoušet spojení s GLS“)
//   - vytvoritZasilku(): PrintLabels = založí zásilku a vrátí štítek PDF
//   - stitekPdf(): GetPrintedLabels pro už založenou zásilku
//
// Přístupové údaje jsou JEN v proměnných prostředí na Renderu:
//   GLS_CLIENT_NUMBER, GLS_USERNAME, GLS_PASSWORD, GLS_API_URL,
//   GLS_WEBSHOP_ENGINE (nepovinné), GLS_ENABLED ('true' = ostrý provoz povolen).
// Nikdy je neposílat do prohlížeče, neukládat do objednávek ani nelogovat.
// Heslo jde do GLS jen jako otisk SHA-512 (tak to MyGLS vyžaduje).
//
// Bezpečnostní pojistky:
//   - adresa API jen testovací nebo ostrá adresa MyGLS pro Česko (heslo nikam jinam),
//   - testovací prostředí (api.test.mygls.cz) jde zkoušet hned,
//   - ostré prostředí zakládá zásilky, jen když je navíc GLS_ENABLED=true.

const crypto = require('crypto');

const POVINNE = ['GLS_CLIENT_NUMBER', 'GLS_USERNAME', 'GLS_PASSWORD', 'GLS_API_URL'];
const ADRESY = { 'https://api.test.mygls.cz': 'test', 'https://api.mygls.cz': 'ostre' };
const LIMIT_MS = 30000;
const TYP_TISKARNY = 'A4_2x2';

// Odesílatel = prodejna (adresa, kde kurýr zásilku vyzvedne)
const ODESILATEL = {
  Name: 'Dětské krůčky – Monika Škarpichová',
  Street: 'Holešovská',
  HouseNumber: '752',
  City: 'Hulín',
  ZipCode: '76824',
  CountryIsoCode: 'CZ',
  ContactName: 'Monika Škarpichová',
  ContactPhone: '+420773517733',
  ContactEmail: 'info@detskekrucky.cz'
};

function nacistKonfiguraci(env = process.env) {
  const chybi = POVINNE.filter(k => !env[k] || !String(env[k]).trim());
  const apiUrl = env.GLS_API_URL ? String(env.GLS_API_URL).trim().replace(/\/+$/, '') : '';
  const prostredi = ADRESY[apiUrl] || null;
  const cislo = Number(String(env.GLS_CLIENT_NUMBER || '').trim());
  return {
    chybi,
    zapnuto: env.GLS_ENABLED === 'true',
    prostredi,
    // hodnoty se drží jen tady v paměti serveru; ven jde jen stav()
    udaje: chybi.length || !prostredi || !Number.isInteger(cislo) || cislo <= 0 ? null : {
      clientNumber: cislo,
      username: String(env.GLS_USERNAME).trim(),
      password: String(env.GLS_PASSWORD),
      apiUrl,
      webshopEngine: env.GLS_WEBSHOP_ENGINE ? String(env.GLS_WEBSHOP_ENGINE).trim().slice(0, 50) : 'Custom'
    }
  };
}

// Stav pro admin: jen ano/ne, prostředí a NÁZVY chybějících proměnných, nikdy hodnoty
function stav(env = process.env) {
  const k = nacistKonfiguraci(env);
  let problem = null;
  if (k.chybi.length) problem = 'Na Renderu chybí: ' + k.chybi.join(', ') + '.';
  else if (!k.prostredi) problem = 'GLS_API_URL musí být https://api.test.mygls.cz/ (test) nebo https://api.mygls.cz/ (ostrý provoz).';
  else if (!k.udaje) problem = 'GLS_CLIENT_NUMBER musí být číslo zákazníka GLS.';
  const podani = !problem && (k.prostredi === 'test' || k.zapnuto);
  if (!problem && !podani) problem = 'Ostrá adresa GLS je nastavená, ale podávání zásilek ještě není povolené (GLS_ENABLED).';
  return {
    nakonfigurovano: !k.chybi.length,
    zapnuto: k.zapnuto,
    chybejiciPromenne: k.chybi,
    prostredi: k.prostredi,
    spojeni: !!k.udaje,
    podani,
    problem,
    apiImplementovano: true
  };
}

// Heslo jako SHA-512 v poli bajtů (formát MyGLS)
function hesloHash(heslo) {
  return [...crypto.createHash('sha512').update(String(heslo), 'utf8').digest()];
}

// .NET datum pro MyGLS: "\/Date(ms)\/" - lomítka musí být v JSON escapovaná
const datum = ms => `/Date(${Math.round(ms)})/`;
const doJson = telo => JSON.stringify(telo).replace(/"\/Date\((\d+)\)\/"/g, '"\\/Date($1)\\/"');

function cistyText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function telefonMezinarodni(t) {
  const c = String(t || '').replace(/[^\d+]/g, '');
  if (/^\+\d{9,15}$/.test(c)) return c;
  if (/^00\d{9,15}$/.test(c)) return '+' + c.slice(2);
  if (/^\d{9}$/.test(c)) return '+420' + c;
  return c;
}
// "Hlavní 123/4a" -> ulice "Hlavní", číslo "123", doplněk "/4a"
function rozdelitUlici(ulice) {
  const u = cistyText(ulice, 100);
  const m = u.match(/^(.*\D)\s+(\d+)([\s/\-]*[\w/\-]*)$/);
  if (!m) return { Street: u, HouseNumber: '', HouseNumberInfo: '' };
  return { Street: m[1].replace(/[,\s]+$/, ''), HouseNumber: m[2], HouseNumberInfo: m[3].trim() };
}

// Objednávka -> Parcel (MyGLS). Doručení na adresu zákazníka; u výdejního místa navíc
// služba PSD s ID místa (GLS pak vyžaduje jméno, telefon a e-mail příjemce).
function sestavitZasilku(o, clientNumber = 0, pocetBaliku = 1) {
  if (!o || o.dopravce !== 'gls') throw new Error('Objednávka není doprava GLS.');
  const doVydejnihoMista = o.doprava === 'gls_vydejni_misto';
  if (doVydejnihoMista && !o.vydejni_misto_id) throw new Error('Objednávka nemá výdejní místo GLS.');
  const pocet = Number(pocetBaliku);
  if (!Number.isInteger(pocet) || pocet < 1 || pocet > 10) throw new Error('Počet balíků musí být 1–10.');
  const jmeno = cistyText(o.obj_jmeno || o.jmeno, 60);
  const email = cistyText(o.obj_email || o.email, 100);
  const telefon = telefonMezinarodni(o.obj_telefon || o.telefon);
  if (!jmeno || !email || !telefon) throw new Error('U objednávky chybí jméno, e-mail nebo telefon příjemce.');
  const reference = String(o.cislo || o.id);
  const parcel = {
    ClientNumber: clientNumber,
    ClientReference: reference,
    Count: pocet,
    Content: `Objednávka ${reference}`,
    PickupAddress: { ...ODESILATEL },
    DeliveryAddress: {
      Name: jmeno,
      ...rozdelitUlici(o.obj_ulice || o.ulice),
      City: cistyText(o.obj_mesto || o.mesto, 60),
      ZipCode: String(o.obj_psc || o.psc || '').replace(/\s+/g, ''),
      CountryIsoCode: 'CZ',
      ContactName: jmeno,
      ContactPhone: telefon,
      ContactEmail: email
    },
    ServiceList: doVydejnihoMista ? [{ Code: 'PSD', PSDParameter: { StringValue: String(o.vydejni_misto_id) } }] : []
  };
  if (o.platba === 'dobirka') {
    parcel.CODAmount = Number(o.celkem);
    parcel.CODReference = reference;
    parcel.CODCurrency = 'CZK';
  }
  return parcel;
}

const POPISY_CHYB = {
  13: 'GLS odmítlo údaje zásilky',
  14: 'uživatel MyGLS neexistuje – zkontrolujte GLS_USERNAME',
  27: 'uživatel nemá přístup k tomuto číslu zákazníka – zkontrolujte GLS_CLIENT_NUMBER',
  31: 'stejný požadavek byl poslán víckrát za sebou, počkejte 5 minut'
};
function textChyb(seznam) {
  return (seznam || []).map(e => {
    const kod = Number(e && e.ErrorCode);
    return `${POPISY_CHYB[kod] ? POPISY_CHYB[kod] + ': ' : ''}${cistyText(e && e.ErrorDescription, 300)}${kod ? ` (kód ${kod})` : ''}`;
  }).join('; ').slice(0, 800);
}

async function zavolat(k, metoda, telo, fetchFn) {
  let odp;
  try {
    odp = await fetchFn(`${k.apiUrl}/ParcelService.svc/json/${metoda}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
      body: doJson({ Username: k.username, Password: hesloHash(k.password), ClientNumberList: [k.clientNumber], WebshopEngine: k.webshopEngine, ...telo }),
      signal: AbortSignal.timeout(LIMIT_MS)
    });
  } catch (e) {
    throw new Error('GLS neodpovídá. Zkuste to prosím za chvíli.');
  }
  if (odp.status === 401) throw new Error('Přihlášení do MyGLS se nepovedlo – zkontrolujte GLS_USERNAME a GLS_PASSWORD na Renderu.');
  if (!odp.ok) throw new Error(`GLS vrátilo chybu HTTP ${odp.status}.`);
  try { return await odp.json(); } catch (e) { throw new Error('Neočekávaná odpověď GLS.'); }
}

function konfiguraceProVolani(env, proPodani) {
  const k = nacistKonfiguraci(env);
  const s = stav(env);
  if (!k.udaje) throw new Error('GLS API není nastavené. ' + (s.problem || ''));
  if (proPodani && !s.podani) throw new Error(s.problem);
  return k.udaje;
}

// Zkouška spojení: čtecí dotaz na zásilky za poslední den (nic nezakládá)
async function overitSpojeni({ env = process.env, fetchFn = fetch, ted = Date.now() } = {}) {
  const k = konfiguraceProVolani(env, false);
  const odp = await zavolat(k, 'GetParcelList', { PrintDateFrom: datum(ted - 24 * 3600 * 1000), PrintDateTo: datum(ted) }, fetchFn);
  const chyby = (odp && odp.GetParcelListErrors) || [];
  if (chyby.length) throw new Error(textChyb(chyby));
  return { prostredi: nacistKonfiguraci(env).prostredi, pocetZasilek: Array.isArray(odp.PrintDataInfoList) ? odp.PrintDataInfoList.length : 0 };
}

function pdfZOdpovedi(labels) {
  if (!labels) return null;
  const pdf = typeof labels === 'string' ? Buffer.from(labels, 'base64') : Buffer.from(labels);
  return pdf.subarray(0, 4).toString() === '%PDF' ? pdf : null;
}

// Založí zásilku. Vrací { parcelId, parcelNumber, pdf, prostredi }.
async function vytvoritZasilku(objednavka, { env = process.env, fetchFn = fetch, pocetBaliku = 1 } = {}) {
  const k = konfiguraceProVolani(env, true);
  const parcel = sestavitZasilku(objednavka, k.clientNumber, pocetBaliku);
  const odp = await zavolat(k, 'PrintLabels', { ParcelList: [parcel], TypeOfPrinter: TYP_TISKARNY, PrintPosition: 1, ShowPrintDialog: false }, fetchFn);
  const chyby = (odp && odp.PrintLabelsErrorList) || [];
  if (chyby.length) throw new Error(textChyb(chyby));
  const info = ((odp && odp.PrintLabelsInfoList) || [])[0];
  if (!info || !Number.isInteger(info.ParcelId) || !info.ParcelNumber) throw new Error('GLS nevrátilo číslo zásilky.');
  return { parcelId: info.ParcelId, parcelNumber: String(info.ParcelNumber), pdf: pdfZOdpovedi(odp.Labels), prostredi: nacistKonfiguraci(env).prostredi };
}

// Štítek k už založené zásilce
async function stitekPdf(parcelId, { env = process.env, fetchFn = fetch } = {}) {
  if (!Number.isInteger(Number(parcelId)) || Number(parcelId) <= 0) throw new Error('Neplatné číslo zásilky GLS.');
  const k = konfiguraceProVolani(env, false);
  const odp = await zavolat(k, 'GetPrintedLabels', { ParcelIdList: [Number(parcelId)], TypeOfPrinter: TYP_TISKARNY, PrintPosition: 1, ShowPrintDialog: false }, fetchFn);
  const chyby = (odp && odp.GetPrintedLabelsErrorList) || [];
  if (chyby.length) throw new Error(textChyb(chyby));
  const pdf = pdfZOdpovedi(odp && odp.Labels);
  if (!pdf) throw new Error('GLS nevrátilo PDF štítku.');
  return pdf;
}

const sledovaniUrl = cisloZasilky => 'https://gls-group.com/CZ/cs/sledovani-zasilek?match=' + encodeURIComponent(String(cisloZasilky));

module.exports = { stav, sestavitZasilku, vytvoritZasilku, stitekPdf, overitSpojeni, nacistKonfiguraci, hesloHash, rozdelitUlici, telefonMezinarodni, sledovaniUrl, doJson, ODESILATEL };
