// Zásilkovna API (XML přes HTTPS POST): podání zásilky a štítek PDF.
// Používá se JEN na výslovný klik v adminu (detail objednávky -> Podat do Zásilkovny).
//
// Proměnné prostředí (jen na Renderu, nikdy ve frontendu, DB ani v logu):
//   ZASILKOVNA_API_HESLO  - API heslo (32 znaků) z klientské sekce Zásilkovny; bez něj je podání vypnuté
//   ZASILKOVNA_ODESILATEL - nepovinné: označení odesílatele (eshop), pokud jich je v účtu víc
//
// Heslo jde jen v těle požadavku na API Zásilkovny. Do chyb a logů se dávají
// jen hlášky z odpovědi Zásilkovny, nikdy požadavek.

const API_URL = 'https://www.zasilkovna.cz/api/rest';
const HESLO_RE = /^[A-Za-z0-9]{32}$/;
const LIMIT_MS = 20000;
const FORMATY_STITKU = ['A6 on A6', 'A6 on A4', 'A7 on A7', 'A7 on A4', 'A8 on A8'];

function nacistKonfiguraci(env = process.env) {
  const heslo = String(env.ZASILKOVNA_API_HESLO || '').trim();
  const odesilatel = String(env.ZASILKOVNA_ODESILATEL || '').trim().slice(0, 64);
  return { heslo: HESLO_RE.test(heslo) ? heslo : null, hesloVyplneno: !!heslo, odesilatel: odesilatel || null };
}

// Pro admin: jen ano/ne, nikdy heslo
function stav(env = process.env) {
  const k = nacistKonfiguraci(env);
  let problem = null;
  if (!k.hesloVyplneno) problem = 'Na Renderu chybí proměnná ZASILKOVNA_API_HESLO.';
  else if (!k.heslo) problem = 'ZASILKOVNA_API_HESLO nemá tvar API hesla (32 znaků).';
  return { podani: !problem, problem };
}

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = v => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c => XML_ESC[c]);
const prvky = obj => Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<${k}>${xml(v)}</${k}>`).join('');

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const dekodovat = s => String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e) => {
  if (e[0] !== '#') return ENTITY[e];
  const kod = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return kod > 0 && kod <= 0x10ffff ? String.fromCodePoint(kod) : '';
});
const znacka = (x, nazev) => { const m = x.match(new RegExp(`<${nazev}>([\\s\\S]*?)</${nazev}>`)); return m ? dekodovat(m[1]).trim() : null; };

// Odpověď API: { ok: true, result } nebo { ok: false, chyba }
function rozebratOdpoved(telo) {
  const x = String(telo || '');
  const status = znacka(x, 'status');
  if (status === 'ok') return { ok: true, result: x.match(/<result>([\s\S]*?)<\/result>/) ? x.match(/<result>([\s\S]*?)<\/result>/)[1] : '' };
  if (status !== 'fault') return { ok: false, chyba: 'Neočekávaná odpověď Zásilkovny.' };
  const detaily = [...x.matchAll(/<fault>\s*<name>([\s\S]*?)<\/name>\s*<fault>([\s\S]*?)<\/fault>\s*<\/fault>/g)]
    .map(m => `${dekodovat(m[1]).trim()}: ${dekodovat(m[2]).trim()}`);
  const text = znacka(x, 'string') || znacka(x, 'fault') || 'Chyba Zásilkovny';
  return { ok: false, chyba: (text + (detaily.length ? ' (' + detaily.join('; ') + ')' : '')).slice(0, 500) };
}

async function zavolat(telo, fetchFn) {
  let odp;
  try {
    odp = await fetchFn(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/xml; charset=utf-8' }, body: telo, signal: AbortSignal.timeout(LIMIT_MS) });
  } catch (e) {
    throw new Error('Zásilkovna neodpovídá. Zkuste to prosím za chvíli.');
  }
  const r = rozebratOdpoved(await odp.text());
  if (!r.ok) throw new Error(r.chyba);
  return r.result;
}

// Objednávka -> atributy zásilky. Jen objednávky Zásilkovnou s výdejním místem.
function sestavitZasilku(o, vahaKg, odesilatel = null) {
  if (!o || o.dopravce !== 'zasilkovna') throw new Error('Objednávka není doprava Zásilkovnou.');
  if (!o.vydejni_misto_id || !/^\d{1,10}$/.test(String(o.vydejni_misto_id))) throw new Error('Objednávka nemá výdejní místo Zásilkovny.');
  const vaha = Number(vahaKg);
  if (!(vaha > 0 && vaha <= 30)) throw new Error('Váha zásilky musí být 0,1–30 kg.');
  const jmeno = String(o.obj_jmeno || o.jmeno || '').trim().replace(/\s+/g, ' ');
  const mezera = jmeno.lastIndexOf(' ');
  const email = String(o.obj_email || o.email || '').trim();
  const telefon = String(o.obj_telefon || o.telefon || '').replace(/[^\d+]/g, '');
  if (!jmeno || (!email && !telefon)) throw new Error('U objednávky chybí jméno nebo kontakt příjemce.');
  return {
    number: String(o.cislo || o.id),
    name: mezera > 0 ? jmeno.slice(0, mezera) : jmeno,
    surname: mezera > 0 ? jmeno.slice(mezera + 1) : jmeno,
    email,
    phone: telefon,
    addressId: String(o.vydejni_misto_id),
    // e-shop dobírku nenabízí: platba převodem nebo na prodejně
    cod: o.platba === 'dobirka' ? Number(o.celkem) : 0,
    value: Number(o.celkem),
    weight: Math.round(vaha * 1000) / 1000,
    eshop: odesilatel
  };
}

// Založí zásilku. Vrací { packetId, barcode, barcodeText }.
async function vytvoritZasilku(objednavka, vahaKg, { env = process.env, fetchFn = fetch } = {}) {
  const k = nacistKonfiguraci(env);
  if (!k.heslo) throw new Error('Podání do Zásilkovny není zapnuté (chybí API heslo na Renderu).');
  const atributy = sestavitZasilku(objednavka, vahaKg, k.odesilatel);
  const vysledek = await zavolat(`<createPacket><apiPassword>${xml(k.heslo)}</apiPassword><packetAttributes>${prvky(atributy)}</packetAttributes></createPacket>`, fetchFn);
  const packetId = znacka(vysledek, 'id');
  if (!packetId || !/^\d{1,12}$/.test(packetId)) throw new Error('Zásilkovna nevrátila číslo zásilky.');
  return { packetId, barcode: znacka(vysledek, 'barcode') || 'Z' + packetId, barcodeText: znacka(vysledek, 'barcodeText') || null };
}

// Štítek k zásilce jako PDF (Buffer)
async function stitekPdf(packetId, format = 'A6 on A4', { env = process.env, fetchFn = fetch } = {}) {
  const k = nacistKonfiguraci(env);
  if (!k.heslo) throw new Error('Podání do Zásilkovny není zapnuté (chybí API heslo na Renderu).');
  if (!/^\d{1,12}$/.test(String(packetId))) throw new Error('Neplatné číslo zásilky.');
  if (!FORMATY_STITKU.includes(format)) throw new Error('Neplatný formát štítku.');
  const vysledek = await zavolat(`<packetLabelPdf><apiPassword>${xml(k.heslo)}</apiPassword>${prvky({ packetId, format, offset: 0 })}</packetLabelPdf>`, fetchFn);
  const pdf = Buffer.from(vysledek.trim(), 'base64');
  if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('Zásilkovna nevrátila PDF štítku.');
  return pdf;
}

const sledovaniUrl = barcode => 'https://tracking.packeta.com/cs/?id=' + encodeURIComponent(String(barcode));

module.exports = { stav, nacistKonfiguraci, sestavitZasilku, vytvoritZasilku, stitekPdf, rozebratOdpoved, sledovaniUrl, FORMATY_STITKU, API_URL };
