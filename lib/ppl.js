// Napojení na PPL (CPL API, REST/JSON) podle dokumentace https://ppl-cpl-api.apidog.io/
//
//   ziskatToken()      OAuth2 client_credentials, token platí 30 min → drží se v paměti
//   vytvoritZasilku()  POST /shipment/batch → batchId (z hlavičky Location)
//   cekatNaDavku()     GET /shipment/batch/{batchId}, dokud importState není Complete/Error
//   stahnoutEtiketu()  GET /shipment/batch/{batchId}/label → PDF (Buffer)
//   zasilkaSEtiketou() všechno dohromady
//
// Přístupové údaje JEN v proměnných prostředí (na Renderu, lokálně v shellu):
//   PPL_CLIENT_ID, PPL_CLIENT_SECRET, PPL_API_URL (testovací nebo ostrá adresa),
//   PPL_CUSTOMER_ID (nepovinné – API ho nepotřebuje, zákazník se pozná podle client_id).
// Nikdy je neposílat do prohlížeče, neukládat do objednávek ani nelogovat.
//
// Pojistky:
//   - adresa API jen testovací nebo ostrá adresa PPL (secret ani token nikam jinam),
//   - URL etikety skládáme sami z batchId, token se neposílá na adresy z odpovědi.

const ADRESY = {
  'https://api-dev.dhl.com/ecs/ppl/myapi2': 'test',
  'https://api.dhl.com/ecs/ppl/myapi2': 'ostre'
};
const LIMIT_MS = 30000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Odesílatel = prodejna
const ODESILATEL = {
  name: 'Detske krucky',
  name2: 'Monika Skarpichova',
  street: 'Holesovska 752',
  city: 'Hulin',
  zipCode: '76824',
  country: 'CZ',
  contact: 'Monika Skarpichova',
  phone: '+420773517733',
  email: 'info@detskekrucky.cz'
};

function nacistKonfiguraci(env = process.env) {
  const chybi = ['PPL_CLIENT_ID', 'PPL_CLIENT_SECRET', 'PPL_API_URL']
    .filter(k => !env[k] || !String(env[k]).trim());
  const apiUrl = env.PPL_API_URL ? String(env.PPL_API_URL).trim().replace(/\/+$/, '') : '';
  const prostredi = ADRESY[apiUrl] || null;
  return {
    chybi,
    prostredi,
    udaje: chybi.length || !prostredi ? null : {
      clientId: String(env.PPL_CLIENT_ID).trim(),
      clientSecret: String(env.PPL_CLIENT_SECRET).trim(),
      apiUrl,
      tokenUrl: apiUrl + '/login/getAccessToken'
    }
  };
}

// Stav pro admin: jen ano/ne, prostředí a NÁZVY chybějících proměnných, nikdy hodnoty
function stav(env = process.env) {
  const k = nacistKonfiguraci(env);
  let problem = null;
  if (k.chybi.length) problem = 'Chybí proměnné prostředí: ' + k.chybi.join(', ') + '.';
  else if (!k.prostredi) problem = 'PPL_API_URL musí být ' + Object.keys(ADRESY).join(' nebo ') + '.';
  return { nakonfigurovano: !k.chybi.length, prostredi: k.prostredi, spojeni: !!k.udaje, problem };
}

// CPL přijímá jen latinku bez diakritiky
function bezDiakritiky(text, max) {
  if (text === undefined || text === null) return text;
  const t = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  return max ? t.slice(0, max) : t;
}

const DELKY = { name: 50, name2: 50, street: 60, city: 50, zipCode: 10, country: 2, contact: 50, phone: 30, email: 100 };
function adresa(a) {
  const out = {};
  for (const [k, max] of Object.entries(DELKY)) {
    if (a[k] !== undefined && a[k] !== null && a[k] !== '') out[k] = bezDiakritiky(a[k], max);
  }
  if (out.zipCode) out.zipCode = out.zipCode.replace(/\s/g, '');
  return out;
}

// Tělo POST /shipment/batch pro jednu zásilku
function teloZasilky({ referenceId, prijemce, produkt = 'PRIV', pocetKusu = 1, poznamka, dobirka, format = 'A4' }) {
  if (!referenceId) throw new Error('Chybí referenceId (číslo objednávky).');
  if (!prijemce || !prijemce.zipCode) throw new Error('Chybí adresa příjemce.');
  const zasilka = {
    referenceId: bezDiakritiky(referenceId, 40),
    productType: produkt,
    sender: adresa(ODESILATEL),
    recipient: adresa({ country: 'CZ', ...prijemce }),
    externalNumbers: [{ code: 'CUST', externalNumber: bezDiakritiky(referenceId, 40) }]
  };
  if (poznamka) zasilka.note = bezDiakritiky(poznamka, 300);
  if (pocetKusu > 1) zasilka.shipmentSet = { numberOfShipments: pocetKusu };
  if (dobirka) {
    zasilka.cashOnDelivery = {
      codCurrency: 'CZK',
      codPrice: Number(dobirka.castka),
      codVarSym: bezDiakritiky(dobirka.vs || referenceId, 10)
    };
  }
  return {
    labelSettings: {
      format: 'Pdf',
      dpi: 300,
      completeLabelSettings: format === 'A4'
        ? { isCompleteLabelRequested: true, pageSize: 'A4', position: 1 }
        : { isCompleteLabelRequested: true, pageSize: 'Default' }
    },
    shipments: [zasilka]
  };
}

function vytvoritKlienta({ env = process.env, fetchFn = globalThis.fetch, cekej = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const k = nacistKonfiguraci(env);
  let token = null; // { hodnota, platiDo }

  function udaje() {
    if (!k.udaje) throw new Error(stav(env).problem);
    return k.udaje;
  }

  async function volat(url, moznosti = {}) {
    const ctrl = new AbortController();
    const casovac = setTimeout(() => ctrl.abort(), LIMIT_MS);
    try {
      return await fetchFn(url, { ...moznosti, signal: ctrl.signal });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'PPL neodpovědělo do 30 s.' : 'Spojení s PPL selhalo: ' + e.message);
    } finally {
      clearTimeout(casovac);
    }
  }

  async function chybaOdpovedi(odp, co) {
    let detail = '';
    try { detail = (await odp.text()).slice(0, 1000); } catch { /* nic */ }
    return new Error(`${co}: HTTP ${odp.status}${detail ? ' – ' + detail : ''}`);
  }

  async function ziskatToken() {
    if (token && token.platiDo > Date.now()) return token.hodnota;
    const u = udaje();
    const odp = await volat(u.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: u.clientId,
        client_secret: u.clientSecret,
        scope: 'myapi2'
      }).toString()
    });
    if (!odp.ok) throw await chybaOdpovedi(odp, 'PPL nevydalo token');
    const data = await odp.json();
    if (!data.access_token) throw new Error('PPL nevrátilo access_token.');
    const platnostS = Number(data.expires_in) || 1800;
    token = { hodnota: data.access_token, platiDo: Date.now() + (platnostS - 60) * 1000 };
    return token.hodnota;
  }

  async function api(cesta, moznosti = {}) {
    const t = await ziskatToken();
    return volat(udaje().apiUrl + cesta, {
      ...moznosti,
      headers: { Authorization: 'Bearer ' + t, 'Accept-Language': 'cs-CZ', ...(moznosti.headers || {}) }
    });
  }

  async function vytvoritZasilku(telo) {
    const odp = await api('/shipment/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(telo)
    });
    if (odp.status !== 201 && !odp.ok) throw await chybaOdpovedi(odp, 'PPL odmítlo zásilku');
    const m = (odp.headers.get('location') || '').match(UUID);
    if (!m) throw new Error('PPL nevrátilo batchId v hlavičce Location.');
    return m[0];
  }

  async function stavDavky(batchId) {
    const odp = await api('/shipment/batch/' + encodeURIComponent(batchId), { headers: { Accept: 'application/json' } });
    if (!odp.ok) throw await chybaOdpovedi(odp, 'Stav dávky PPL');
    return odp.json();
  }

  // importState: Accepted → InProcess → Complete | Error
  async function cekatNaDavku(batchId, { pokusu = 30, intervalMs = 2000 } = {}) {
    for (let i = 0; i < pokusu; i++) {
      const data = await stavDavky(batchId);
      const polozky = data.items || [];
      const chyba = polozky.find(p => p.importState === 'Error');
      if (chyba) throw new Error('PPL zásilku nepřijalo: ' + (chyba.errorMessage || chyba.errorCode || 'neznámá chyba'));
      if (polozky.length && polozky.every(p => p.importState === 'Complete')) return data;
      await cekej(intervalMs);
    }
    throw new Error('PPL zásilku nezpracovalo v časovém limitu (batchId ' + batchId + ').');
  }

  async function stahnoutEtiketu(batchId, { format = 'A4' } = {}) {
    const q = new URLSearchParams({ pageSize: format === 'A4' ? 'A4' : 'Default', position: '1', limit: '200', offset: '0' });
    const odp = await api('/shipment/batch/' + encodeURIComponent(batchId) + '/label?' + q, { headers: { Accept: 'application/pdf' } });
    if (!odp.ok) throw await chybaOdpovedi(odp, 'Etiketa PPL');
    const pdf = Buffer.from(await odp.arrayBuffer());
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('PPL nevrátilo PDF.');
    return pdf;
  }

  async function zasilkaSEtiketou(parametry) {
    const telo = teloZasilky(parametry);
    const batchId = await vytvoritZasilku(telo);
    const data = await cekatNaDavku(batchId);
    const pdf = await stahnoutEtiketu(batchId, { format: parametry.format || 'A4' });
    const cisla = (data.items || []).flatMap(p => [p.shipmentNumber, ...(p.relatedItems || []).map(r => r.shipmentNumber)]).filter(Boolean);
    return { batchId, cislaZasilek: cisla, pdf };
  }

  return { ziskatToken, vytvoritZasilku, stavDavky, cekatNaDavku, stahnoutEtiketu, zasilkaSEtiketou };
}

module.exports = { vytvoritKlienta, teloZasilky, bezDiakritiky, nacistKonfiguraci, stav, ODESILATEL, ADRESY };
