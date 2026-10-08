// Doprava z nastavení a příprava GLS (2026-10): ceny z adminu, GLS vypnuté bez ceny,
// výdejní místo jen ověřené proti seznamu GLS, API GLS bez údajů vypnuté.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const doprava = require('../lib/doprava');
const glsMista = require('../lib/glsVydejniMista');
const gls = require('../lib/gls');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

const XML = `<?xml version="1.0" encoding="UTF-8"?><DropoffData><Data>
${Array.from({ length: 120 }, (_, i) => `<DropoffPoint ID="CZ00000-TEST${i}" Name="Místo ${i}" Address="Ulice ${i}" CtrCode="CZ" ZipCode="10000" CityName="Praha" IsCODHandler="1" IsParcelLocker="0"><Openings/></DropoffPoint>`).join('\n')}
<DropoffPoint ID="39301-ELPESRO" Name="Elpe s.r.o. &amp; spol. &quot;elektro&quot;" Address="Myslotínská 2449" CtrCode="CZ" ZipCode="39301" CityName="Pelhřimov" IsCODHandler="1" IsParcelLocker="0"><Openings><Openings Day="Monday" OpenHours="8-17"/></Openings></DropoffPoint>
<DropoffPoint ID="CZ58601-PARCELLOCK01" Name="GLS BOX" Address="S. K. Neumanna 590/22" CtrCode="CZ" ZipCode="58601" CityName="Jihlava" IsCODHandler="1" IsParcelLocker="1"/>
<DropoffPoint ID="bad id&lt;script&gt;" Name="x"/>
</Data></DropoffData>`;

function fetchOk(xml = XML) {
  const f = async () => { f.volani++; return { ok: true, status: 200, text: async () => xml }; };
  f.volani = 0;
  return f;
}
const fetchChyba = async () => { throw new Error('síť nedostupná'); };

// ---------- lib/doprava.js ----------

test('výchozí nastavení: dosavadní ceny, zdarma od 2 000 Kč, GLS vypnuté a bez ceny', () => {
  const n = doprava.sloucitNastaveni(null);
  assert.equal(n.zdarmaOd, 2000);
  assert.deepEqual(n.metody.zasilkovna, { aktivni: true, cena: 79 });
  assert.deepEqual(n.metody.ceska_posta, { aktivni: true, cena: 89 });
  assert.deepEqual(n.metody.gls_adresa, { aktivni: false, cena: null });
  assert.deepEqual(n.metody.gls_vydejni_misto, { aktivni: false, cena: null });
  assert.deepEqual(doprava.verejneNastaveni(n).metody.map(m => m.kod), ['zasilkovna', 'ceska_posta', 'osobni_odber']);
});

test('výpočet ceny: zdarma od (po slevě), osobní odběr vždy zdarma, nenabízený způsob vyhodí chybu', () => {
  const n = doprava.sloucitNastaveni({ metody: { gls_vydejni_misto: { aktivni: true, cena: 69 } } });
  assert.equal(doprava.vypocitatCenuDopravy(n, 'gls_vydejni_misto', 1999), 69);
  assert.equal(doprava.vypocitatCenuDopravy(n, 'gls_vydejni_misto', 2000), 0);
  assert.equal(doprava.vypocitatCenuDopravy(n, 'osobni_odber', 10), 0);
  assert.throws(() => doprava.vypocitatCenuDopravy(n, 'gls_adresa', 10), /Nedostupný/);
  assert.throws(() => doprava.vypocitatCenuDopravy(n, '__proto__', 10), /Nedostupný/);
  const nikdy = doprava.sloucitNastaveni({ zdarmaOd: null });
  assert.equal(doprava.vypocitatCenuDopravy(nikdy, 'zasilkovna', 100000), 79);
});

test('uložené nastavení přes výchozí: chybějící způsob se doplní, nesmyslné zdarmaOd se nepoužije', () => {
  const n = doprava.sloucitNastaveni({ zdarmaOd: 'hodně', metody: { zasilkovna: { aktivni: false, cena: 79 } } });
  assert.equal(n.zdarmaOd, 2000);
  assert.equal(n.metody.zasilkovna.aktivni, false);
  assert.deepEqual(n.metody.gls_adresa, { aktivni: false, cena: null });
});

test('kontrola nastavení z adminu: bez ceny nejde zapnout, ceny jen celá čísla, aspoň jeden způsob', () => {
  const zaklad = () => JSON.parse(JSON.stringify({ zdarmaOd: 2000, metody: doprava.VYCHOZI_NASTAVENI.metody, priplatky: { dobirka: null } }));
  assert.ok(doprava.overitNastaveniDopravy(zaklad()).hodnoty);
  const t1 = zaklad(); t1.metody.gls_vydejni_misto = { aktivni: true, cena: null };
  assert.match(doprava.overitNastaveniDopravy(t1).chyba, /bez ceny nejde zapnout/);
  const t2 = zaklad(); t2.metody.gls_adresa = { aktivni: false, cena: 12.5 };
  assert.match(doprava.overitNastaveniDopravy(t2).chyba, /celé číslo/);
  const t3 = zaklad(); t3.metody.gls_adresa = { aktivni: false, cena: -1 };
  assert.match(doprava.overitNastaveniDopravy(t3).chyba, /celé číslo/);
  const t4 = zaklad(); t4.metody.ppl = { aktivni: true, cena: 1 };
  assert.match(doprava.overitNastaveniDopravy(t4).chyba, /Neznámý způsob/);
  const t5 = zaklad(); for (const k of Object.keys(t5.metody)) t5.metody[k].aktivni = false;
  assert.match(doprava.overitNastaveniDopravy(t5).chyba, /Aspoň jeden/);
  const t6 = zaklad(); t6.zdarmaOd = '2000';
  assert.match(doprava.overitNastaveniDopravy(t6).chyba, /zdarma od/);
  const t7 = zaklad(); t7.metody.osobni_odber = { aktivni: true, cena: 50 };
  assert.equal(doprava.overitNastaveniDopravy(t7).hodnoty.metody.osobni_odber.cena, 0, 'osobní odběr zůstává zdarma');
  const t8 = zaklad(); t8.metody.gls_vydejni_misto = { aktivni: true, cena: 69 }; t8.priplatky.dobirka = 30; t8.zdarmaOd = null;
  const ok = doprava.overitNastaveniDopravy(t8).hodnoty;
  assert.deepEqual(ok.metody.gls_vydejni_misto, { aktivni: true, cena: 69 });
  assert.equal(ok.priplatky.dobirka, 30);
  assert.equal(ok.zdarmaOd, null);
});

test('načtení nastavení: chyba DB = výchozí ceny (objednávky se nezastaví)', async () => {
  const puvodni = console.error; console.error = () => {};
  try {
    const n = await doprava.nacistNastaveniDopravy({ query: async () => { throw new Error('DB down'); } });
    assert.equal(n.metody.zasilkovna.cena, 79);
    assert.equal(n.metody.gls_vydejni_misto.aktivni, false);
  } finally { console.error = puvodni; }
});

// ---------- lib/glsVydejniMista.js ----------

test('seznam GLS: atributy se dekódují, nevalidní ID se přeskočí, box/dobírka podle příznaků', () => {
  const m = glsMista.rozebratSeznam(XML);
  assert.equal(m.size, 122);
  assert.deepEqual(m.get('39301-ELPESRO'), { id: '39301-ELPESRO', nazev: 'Elpe s.r.o. & spol. "elektro"', ulice: 'Myslotínská 2449', mesto: 'Pelhřimov', psc: '39301', stat: 'CZ', box: false, dobirka: true });
  assert.equal(m.get('CZ58601-PARCELLOCK01').box, true);
});

test('ověření ID: existující místo vrátí údaje GLS, neexistující null, nevalidní ID se ani nehledá', async () => {
  glsMista._resetovatCache();
  const f = fetchOk();
  assert.equal((await glsMista.overitVydejniMisto('39301-elpesro', { fetchFn: f })).nazev, 'Elpe s.r.o. & spol. "elektro"');
  assert.equal(await glsMista.overitVydejniMisto('NEEXISTUJE-1', { fetchFn: f }), null);
  assert.equal(await glsMista.overitVydejniMisto('<script>', { fetchFn: f }), null);
  assert.equal(await glsMista.overitVydejniMisto({ id: 1 }, { fetchFn: f }), null);
  assert.equal(await glsMista.overitVydejniMisto('x'.repeat(41), { fetchFn: f }), null);
  assert.equal(f.volani, 1, 'seznam se stáhne jednou a drží se v paměti');
});

test('seznam GLS: po 24 h se stáhne znovu; když GLS neodpovídá, použije se starý seznam', async () => {
  glsMista._resetovatCache();
  const puvodni = console.error; console.error = () => {};
  try {
    await glsMista.overitVydejniMisto('39301-ELPESRO', { fetchFn: fetchOk(), ted: Date.now() });
    const pozdeji = Date.now() + 25 * 3600 * 1000;
    const m = await glsMista.overitVydejniMisto('39301-ELPESRO', { fetchFn: fetchChyba, ted: pozdeji });
    assert.equal(m.id, '39301-ELPESRO');
  } finally { console.error = puvodni; }
});

test('seznam GLS nedostupný a žádný starý: chyba GLS_NEDOSTUPNE; podezřele krátký seznam se nepřijme', async () => {
  const puvodni = console.error; console.error = () => {};
  try {
    glsMista._resetovatCache();
    await assert.rejects(glsMista.overitVydejniMisto('39301-ELPESRO', { fetchFn: fetchChyba }), /GLS_NEDOSTUPNE/);
    glsMista._resetovatCache();
    await assert.rejects(glsMista.overitVydejniMisto('39301-ELPESRO', { fetchFn: fetchOk('<Data></Data>') }), /GLS_NEDOSTUPNE/);
    glsMista._resetovatCache();
    await assert.rejects(glsMista.overitVydejniMisto('39301-ELPESRO', { fetchFn: async () => ({ ok: false, status: 500 }) }), /GLS_NEDOSTUPNE/);
  } finally { console.error = puvodni; glsMista._resetovatCache(); }
});

test('seznam GLS se stahuje jen z pevné adresy GLS', () => {
  assert.equal(glsMista.SEZNAM_URL, 'https://ps-maps.gls-czech.com/getDropoffPoints.php?ctrcode=CZ');
});

// ---------- lib/gls.js ----------

const ENV_PLNE = { GLS_CLIENT_NUMBER: '123456', GLS_USERNAME: 'uzivatel@example.com', GLS_PASSWORD: 'tajne-heslo', GLS_API_URL: 'https://api.test.mygls.cz' };

const ENV_TEST = { ...ENV_PLNE, GLS_CLIENT_NUMBER: '53018135', GLS_API_URL: 'https://api.test.mygls.cz/' };
const ENV_OSTRE = { ...ENV_TEST, GLS_API_URL: 'https://api.mygls.cz' };
const OBJ_GLS = { id: 7, cislo: '261012', dopravce: 'gls', doprava: 'gls_vydejni_misto', platba: 'prevod', celkem: '1079',
  obj_jmeno: 'Jana Nováková', obj_email: 'jana@example.com', obj_telefon: '777 123 456', obj_ulice: 'Hlavní 12/3a', obj_mesto: 'Hulín', obj_psc: '768 24',
  vydejni_misto_id: '39301-ELPESRO' };
const PDF = Buffer.from('%PDF-1.4 gls');
function falesnyFetch(odpoved, status = 200) {
  const volani = [];
  const fetchFn = async (url, o) => { volani.push({ url, ...o }); return { status, ok: status >= 200 && status < 300, json: async () => odpoved }; };
  return { fetchFn, volani };
}

test('GLS API bez údajů: nenakonfigurované, podání ani spojení nejde, nic se nevolá', async () => {
  const s = gls.stav({});
  assert.equal(s.nakonfigurovano, false);
  assert.equal(s.podani, false);
  assert.deepEqual(s.chybejiciPromenne, ['GLS_CLIENT_NUMBER', 'GLS_USERNAME', 'GLS_PASSWORD', 'GLS_API_URL']);
  const { fetchFn, volani } = falesnyFetch({});
  await assert.rejects(gls.vytvoritZasilku(OBJ_GLS, { env: {}, fetchFn }), /není nastavené/);
  await assert.rejects(gls.overitSpojeni({ env: {}, fetchFn }), /není nastavené/);
  assert.equal(volani.length, 0);
});

test('GLS adresa API: jen testovací nebo ostrá MyGLS pro Česko, jinam heslo nejde', async () => {
  assert.equal(gls.stav(ENV_TEST).prostredi, 'test');
  assert.equal(gls.stav(ENV_OSTRE).prostredi, 'ostre');
  for (const url of ['https://api.mygls.hu', 'https://utocnik.example/api.mygls.cz', 'http://api.mygls.cz', 'https://api.mygls.cz.evil.com']) {
    const s = gls.stav({ ...ENV_TEST, GLS_API_URL: url });
    assert.equal(s.spojeni, false, url);
    assert.match(s.problem, /GLS_API_URL musí být/);
    const { fetchFn, volani } = falesnyFetch({});
    await assert.rejects(gls.overitSpojeni({ env: { ...ENV_TEST, GLS_API_URL: url }, fetchFn }));
    assert.equal(volani.length, 0, url);
  }
});

test('GLS ostrý provoz: bez GLS_ENABLED=true se zásilky nezakládají (test prostředí ano)', async () => {
  assert.equal(gls.stav(ENV_TEST).podani, true);
  assert.equal(gls.stav(ENV_OSTRE).podani, false);
  assert.match(gls.stav(ENV_OSTRE).problem, /GLS_ENABLED/);
  assert.equal(gls.stav({ ...ENV_OSTRE, GLS_ENABLED: 'true' }).podani, true);
  const { fetchFn, volani } = falesnyFetch({});
  await assert.rejects(gls.vytvoritZasilku(OBJ_GLS, { env: ENV_OSTRE, fetchFn }), /GLS_ENABLED/);
  assert.equal(volani.length, 0);
});

test('stav GLS API nikdy neobsahuje hodnoty přístupových údajů', () => {
  const text = JSON.stringify(gls.stav({ ...ENV_TEST, GLS_ENABLED: 'true' }));
  for (const hodnota of ['53018135', 'uzivatel@example.com', 'tajne-heslo']) assert.equal(text.includes(hodnota), false, hodnota);
});

test('převod objednávky na zásilku MyGLS: adresa, kontakt, výdejní místo jako PSD, dobírka jen u dobírky', () => {
  const z = gls.sestavitZasilku(OBJ_GLS, 53018135);
  assert.equal(z.ClientNumber, 53018135);
  assert.equal(z.ClientReference, '261012');
  assert.equal(z.Count, 1);
  assert.deepEqual(z.ServiceList, [{ Code: 'PSD', PSDParameter: { StringValue: '39301-ELPESRO' } }]);
  assert.deepEqual(z.DeliveryAddress, { Name: 'Jana Nováková', Street: 'Hlavní', HouseNumber: '12', HouseNumberInfo: '/3a', City: 'Hulín', ZipCode: '76824', CountryIsoCode: 'CZ',
    ContactName: 'Jana Nováková', ContactPhone: '+420777123456', ContactEmail: 'jana@example.com' });
  assert.equal(z.PickupAddress.City, 'Hulín');
  assert.equal('CODAmount' in z, false);
  const d = gls.sestavitZasilku({ ...OBJ_GLS, platba: 'dobirka' }, 1);
  assert.deepEqual([d.CODAmount, d.CODReference, d.CODCurrency], [1079, '261012', 'CZK']);
  assert.deepEqual(gls.sestavitZasilku({ ...OBJ_GLS, doprava: 'gls_adresa', vydejni_misto_id: null }, 1).ServiceList, []);
  assert.equal(gls.sestavitZasilku(OBJ_GLS, 1, 3).Count, 3);
  assert.throws(() => gls.sestavitZasilku(OBJ_GLS, 1, 0), /Počet balíků/);
  assert.throws(() => gls.sestavitZasilku({ ...OBJ_GLS, vydejni_misto_id: null }, 1), /nemá výdejní místo/);
  assert.throws(() => gls.sestavitZasilku({ ...OBJ_GLS, dopravce: 'zasilkovna' }, 1), /není doprava GLS/);
  assert.throws(() => gls.sestavitZasilku({ ...OBJ_GLS, obj_email: '' }, 1), /e-mail/);
  assert.deepEqual(gls.rozdelitUlici('Holešovská 752'), { Street: 'Holešovská', HouseNumber: '752', HouseNumberInfo: '' });
  assert.deepEqual(gls.rozdelitUlici('Náměstí Míru'), { Street: 'Náměstí Míru', HouseNumber: '', HouseNumberInfo: '' });
  assert.equal(gls.telefonMezinarodni('00421 905 123 456'), '+421905123456');
});

test('MyGLS požadavek: heslo jen jako SHA-512 bajty, datum ve formátu \\/Date()\\/, správná adresa metody', async () => {
  const { fetchFn, volani } = falesnyFetch({ GetParcelListErrors: [], PrintDataInfoList: [{}, {}] });
  const v = await gls.overitSpojeni({ env: ENV_TEST, fetchFn, ted: 1700000000000 });
  assert.deepEqual(v, { prostredi: 'test', pocetZasilek: 2 });
  assert.equal(volani[0].url, 'https://api.test.mygls.cz/ParcelService.svc/json/GetParcelList');
  assert.equal(volani[0].method, 'POST');
  const telo = volani[0].body;
  assert.equal(telo.includes('tajne-heslo'), false, 'heslo se neposílá čitelně');
  const json = JSON.parse(telo);
  assert.deepEqual(json.Password, [...require('crypto').createHash('sha512').update('tajne-heslo').digest()]);
  assert.equal(json.Password.length, 64);
  assert.equal(json.Username, 'uzivatel@example.com');
  assert.deepEqual(json.ClientNumberList, [53018135]);
  assert.match(telo, /"PrintDateTo":"\\\/Date\(1700000000000\)\\\/"/);
  assert.equal(json.PrintDateFrom, '/Date(1699913600000)/');
});

test('zkouška spojení: kód 26 (žádné zásilky v období) = přihlášení prošlo, spojení OK; kód -1 = nepřijaté přihlášení', async () => {
  const v = await gls.overitSpojeni({ env: ENV_OSTRE, fetchFn: falesnyFetch({ GetParcelListErrors: [{ ErrorCode: 26, ErrorDescription: 'Parcel not found with current settings' }], PrintDataInfoList: null }).fetchFn });
  assert.deepEqual(v, { prostredi: 'ostre', pocetZasilek: 0 });
  await assert.rejects(gls.overitSpojeni({ env: ENV_TEST, fetchFn: falesnyFetch({ GetParcelListErrors: [{ ErrorCode: -1, ErrorDescription: 'Unauthorized.' }] }).fetchFn }), /GLS nepřijalo přihlášení.*testovací prostředí má od GLS vlastní přístupové údaje: Unauthorized\. \(kód -1\)/);
});

test('MyGLS chyby: přihlášení, chybový seznam, výpadek - srozumitelně a bez hesla', async () => {
  await assert.rejects(gls.overitSpojeni({ env: ENV_TEST, fetchFn: falesnyFetch({}, 401).fetchFn }), /Přihlášení do MyGLS se nepovedlo/);
  await assert.rejects(gls.overitSpojeni({ env: ENV_TEST, fetchFn: falesnyFetch({ GetParcelListErrors: [{ ErrorCode: 27, ErrorDescription: 'User is not authorized' }] }).fetchFn }),
    e => /zkontrolujte GLS_CLIENT_NUMBER/.test(e.message) && /kód 27/.test(e.message) && !e.message.includes('tajne-heslo'));
  await assert.rejects(gls.overitSpojeni({ env: ENV_TEST, fetchFn: async () => { throw new Error('ECONNRESET tajne-heslo'); } }), e => /GLS neodpovídá/.test(e.message) && !e.message.includes('tajne-heslo'));
  await assert.rejects(gls.overitSpojeni({ env: ENV_TEST, fetchFn: falesnyFetch({}, 500).fetchFn }), /HTTP 500/);
});

test('podání zásilky: PrintLabels, číslo zásilky a štítek PDF (bajty i base64)', async () => {
  const { fetchFn, volani } = falesnyFetch({ Labels: [...PDF], PrintLabelsErrorList: [], PrintLabelsInfoList: [{ ClientReference: '261012', ParcelId: 555, ParcelNumber: 12345678901 }] });
  const v = await gls.vytvoritZasilku({ ...OBJ_GLS, platba: 'dobirka' }, { env: ENV_TEST, fetchFn, pocetBaliku: 2 });
  assert.deepEqual({ ...v, pdf: v.pdf.toString() }, { parcelId: 555, parcelNumber: '12345678901', pdf: '%PDF-1.4 gls', prostredi: 'test' });
  assert.equal(volani[0].url, 'https://api.test.mygls.cz/ParcelService.svc/json/PrintLabels');
  const json = JSON.parse(volani[0].body);
  assert.equal(json.WebshopEngine, 'Custom');
  assert.equal(json.TypeOfPrinter, 'A4_2x2');
  assert.equal(json.ParcelList[0].Count, 2);
  assert.equal(json.ParcelList[0].CODAmount, 1079);
  const b64 = await gls.vytvoritZasilku(OBJ_GLS, { env: ENV_TEST, fetchFn: falesnyFetch({ Labels: PDF.toString('base64'), PrintLabelsInfoList: [{ ParcelId: 1, ParcelNumber: 2 }] }).fetchFn });
  assert.equal(b64.pdf.toString(), '%PDF-1.4 gls');
  await assert.rejects(gls.vytvoritZasilku(OBJ_GLS, { env: ENV_TEST, fetchFn: falesnyFetch({ PrintLabelsErrorList: [{ ErrorCode: 13, ErrorDescription: 'Invalid zip' }] }).fetchFn }), /GLS odmítlo údaje zásilky: Invalid zip \(kód 13\)/);
  await assert.rejects(gls.vytvoritZasilku(OBJ_GLS, { env: ENV_TEST, fetchFn: falesnyFetch({ PrintLabelsInfoList: [] }).fetchFn }), /nevrátilo číslo zásilky/);
});

test('štítek k založené zásilce: GetPrintedLabels', async () => {
  const { fetchFn, volani } = falesnyFetch({ Labels: [...PDF], GetPrintedLabelsErrorList: [] });
  assert.equal((await gls.stitekPdf(555, { env: ENV_TEST, fetchFn })).toString(), '%PDF-1.4 gls');
  assert.deepEqual(JSON.parse(volani[0].body).ParcelIdList, [555]);
  await assert.rejects(gls.stitekPdf('x', { env: ENV_TEST, fetchFn }), /Neplatné číslo/);
  await assert.rejects(gls.stitekPdf(1, { env: ENV_TEST, fetchFn: falesnyFetch({ Labels: [1, 2, 3] }).fetchFn }), /nevrátilo PDF/);
});

test('přístupové údaje GLS nejsou v kódu, frontendu ani v migraci objednávek', () => {
  const koren = path.join(__dirname, '..');
  for (const soubor of ['eshop.html', 'admin.html', 'index.html', 'routes/objednavky.js', 'routes/doprava.js', 'routes/emaily.js']) {
    const obsah = fs.readFileSync(path.join(koren, soubor), 'utf8');
    assert.equal(/GLS_PASSWORD|GLS_USERNAME|GLS_CLIENT_NUMBER/.test(obsah), false, soubor);
  }
  const libGls = fs.readFileSync(path.join(koren, 'lib/gls.js'), 'utf8');
  assert.equal(/console\.(log|error|warn)/.test(libGls), false, 'lib/gls.js nic neloguje');
});

// ---------- routes/doprava.js ----------

function poolNastaveni(stav) {
  return {
    async query(sql, params) {
      if (sql.startsWith("SELECT hodnota FROM nastaveni WHERE klic = 'doprava'")) return { rows: stav.ulozeno ? [{ hodnota: stav.ulozeno }] : [] };
      if (sql.startsWith('INSERT INTO nastaveni')) { assert.equal(params[0], 'doprava'); stav.ulozeno = JSON.parse(params[1]); return {}; }
      throw new Error('neznámý dotaz ' + sql);
    }
  };
}
function routerDoprava(stav, mistaMock) {
  return nacistRouterSMocky('../routes/doprava.js', {
    '../db/pool': poolNastaveni(stav),
    ...(mistaMock ? { '../lib/glsVydejniMista': mistaMock } : {})
  });
}

test('API dopravy: veřejně jen nabízené způsoby; admin uloží cenu GLS a zapne ho', async () => {
  const stav = {};
  const router = routerDoprava(stav);
  let res = vytvoritRes();
  await najitHandler(router, 'get', '/')({}, res);
  assert.deepEqual(res.body.metody.map(m => m.kod), ['zasilkovna', 'ceska_posta', 'osobni_odber']);

  const telo = { zdarmaOd: 2000, metody: { ...doprava.VYCHOZI_NASTAVENI.metody, gls_vydejni_misto: { aktivni: true, cena: 69 } }, priplatky: { dobirka: null } };
  res = vytvoritRes();
  await najitHandler(router, 'put', '/')({ body: telo }, res);
  assert.equal(res.statusCode, 200);
  res = vytvoritRes();
  await najitHandler(router, 'get', '/')({}, res);
  const glsMetoda = res.body.metody.find(m => m.kod === 'gls_vydejni_misto');
  assert.deepEqual(glsMetoda, { kod: 'gls_vydejni_misto', nazev: 'GLS – doručení do výdejního místa', cena: 69, vydejniMisto: 'gls', vzdyZdarma: false });

  res = vytvoritRes();
  await najitHandler(router, 'put', '/')({ body: { ...telo, metody: { ...telo.metody, gls_adresa: { aktivni: true, cena: null } } } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /bez ceny nejde zapnout/);
});

test('API dopravy: úprava a admin přehled jen s heslem admina; přehled bez hodnot přístupových údajů', async () => {
  const vyzadovatAdmina = require('../middleware/adminAuth');
  const router = routerDoprava({});
  for (const [metoda, cesta] of [['put', '/'], ['get', '/admin']]) {
    const layer = router.stack.find(l => l.route && l.route.path === cesta && l.route.methods[metoda]);
    assert.equal(layer.route.stack[0].handle, vyzadovatAdmina, `${metoda} ${cesta}`);
  }
  const puvodniEnv = { ...process.env };
  Object.assign(process.env, ENV_PLNE);
  try {
    const res = vytvoritRes();
    await najitHandler(router, 'get', '/admin')({}, res);
    const text = JSON.stringify(res.body);
    for (const hodnota of Object.values(ENV_PLNE)) assert.equal(text.includes(hodnota), false);
    assert.equal(res.body.glsApi.nakonfigurovano, true);
    assert.equal(res.body.glsApi.apiImplementovano, true);
  } finally {
    for (const k of Object.keys(ENV_PLNE)) if (!(k in puvodniEnv)) delete process.env[k]; else process.env[k] = puvodniEnv[k];
  }
});

test('API ověření místa: údaje ze seznamu GLS, neexistující 404, výpadek GLS 503 bez technických detailů', async () => {
  const puvodni = console.error; console.error = () => {};
  try {
    const router = routerDoprava({}, {
      overitVydejniMisto: async id => {
        if (id === 'VYPADEK') throw new Error('GLS_NEDOSTUPNE');
        return id === '39301-ELPESRO' ? { id, nazev: 'Elpe', ulice: 'U 1', mesto: 'Pelhřimov', psc: '39301', stat: 'CZ', box: false, dobirka: true } : null;
      }
    });
    const h = najitHandler(router, 'get', '/gls-misto/:id');
    let res = vytvoritRes();
    await h({ params: { id: '39301-ELPESRO' } }, res);
    assert.deepEqual(res.body, { id: '39301-ELPESRO', nazev: 'Elpe', ulice: 'U 1', mesto: 'Pelhřimov', psc: '39301', stat: 'CZ', box: false });
    res = vytvoritRes();
    await h({ params: { id: 'NIC' } }, res);
    assert.equal(res.statusCode, 404);
    res = vytvoritRes();
    await h({ params: { id: 'VYPADEK' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.chyba.includes('GLS_NEDOSTUPNE'), false);
  } finally { console.error = puvodni; }
});

// ---------- POST /api/objednavky s GLS ----------

const MISTO = { id: '39301-ELPESRO', nazev: 'Elpe s.r.o.', ulice: 'Myslotínská 2449', mesto: 'Pelhřimov', psc: '39301', stat: 'CZ', box: false, dobirka: true };
function handlerObjednavek(stav, { overit } = {}) {
  const emaily = { potvrzeni: [], upozorneni: [] };
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': vytvoritMockPool(stav),
    './emaily': {
      odeslat_potvrzeni: async o => { emaily.potvrzeni.push(o); },
      odeslat_upozorneni_objednavky: async o => { emaily.upozorneni.push(o); }
    },
    '../lib/glsVydejniMista': { overitVydejniMisto: overit || (async id => (id === MISTO.id ? { ...MISTO } : null)) }
  });
  return { handler: najitHandler(router, 'post', '/'), emaily };
}
function stavSGls({ glsAktivni = true } = {}) {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 3, dostupnost: 'skladem', cena: 500, nazev: 'Bota' });
  stav.nastaveniDopravy = { zdarmaOd: 2000, metody: { zasilkovna: { aktivni: true, cena: 85 }, gls_vydejni_misto: { aktivni: glsAktivni, cena: glsAktivni ? 69 : null }, gls_adresa: { aktivni: false, cena: null } } };
  return stav;
}
function pozadavek(prepis = {}) {
  return { body: { jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
    doprava: 'gls_vydejni_misto', platba: 'prevod', poznamka: '', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }], ...prepis }, ip: '10.0.0.' + Math.floor(Math.random() * 250) };
}

test('objednávka GLS do výdejního místa: uloží cenu dopravy, dopravce a OVĚŘENÉ údaje místa (ne údaje z prohlížeče)', async () => {
  const stav = stavSGls();
  const { handler, emaily } = handlerObjednavek(stav);
  const res = vytvoritRes();
  await handler(pozadavek({ vydejni_misto_id: '39301-ELPESRO', vydejni_misto_nazev: '<script>podvrh</script>', vydejni_misto_ulice: 'Podvržená 1' }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.celkem, 569);
  const o = stav.objednavky[0];
  assert.equal(o.doprava, 'gls_vydejni_misto');
  assert.equal(o.doprava_cena, 69);
  assert.equal(o.dopravce, 'gls');
  assert.equal(o.vydejni_misto_id, '39301-ELPESRO');
  assert.equal(o.vydejni_misto_nazev, 'Elpe s.r.o.');
  assert.equal(o.vydejni_misto_ulice, 'Myslotínská 2449');
  assert.equal(o.vydejni_misto_psc, '39301');
  assert.equal(o.vydejni_misto_stat, 'CZ');
  assert.equal(emaily.potvrzeni[0].vydejni_misto.nazev, 'Elpe s.r.o.');
  assert.equal(emaily.potvrzeni[0].doprava_cena, 69);
});

test('objednávka GLS bez výdejního místa: přesná hláška, nic se neuloží', async () => {
  const stav = stavSGls();
  const { handler } = handlerObjednavek(stav);
  for (const id of [undefined, '', 123, { id: 'x' }]) {
    const res = vytvoritRes();
    await handler(pozadavek({ vydejni_misto_id: id }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.chyba, 'Pro doručení do výdejního místa GLS nejprve vyberte výdejní místo.');
  }
  assert.equal(stav.objednavky.length, 0);
});

test('objednávka GLS s neexistujícím ID: odmítnuta; výpadek seznamu GLS: 503 s přátelskou hláškou', async () => {
  const stav = stavSGls();
  let res = vytvoritRes();
  await handlerObjednavek(stav).handler(pozadavek({ vydejni_misto_id: 'PODVRH-123' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /nepodařilo najít/);
  const puvodni = console.error; console.error = () => {};
  try {
    res = vytvoritRes();
    await handlerObjednavek(stav, { overit: async () => { throw new Error('GLS_NEDOSTUPNE'); } }).handler(pozadavek({ vydejni_misto_id: '39301-ELPESRO' }), res);
  } finally { console.error = puvodni; }
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.chyba.includes('GLS_NEDOSTUPNE'), false);
  assert.equal(stav.objednavky.length, 0);
});

test('GLS vypnuté v nastavení (výchozí stav): objednávka s GLS se odmítne', async () => {
  const stav = stavSGls({ glsAktivni: false });
  const res = vytvoritRes();
  await handlerObjednavek(stav).handler(pozadavek({ vydejni_misto_id: '39301-ELPESRO' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.chyba, 'Vyberte prosím způsob dopravy.');
  const bezNastaveni = pocatecniStav();
  bezNastaveni.sklad = stav.sklad;
  const res2 = vytvoritRes();
  await handlerObjednavek(bezNastaveni).handler(pozadavek({ doprava: 'gls_adresa' }), res2);
  assert.equal(res2.statusCode, 400);
});

test('jiná doprava než výdejní místo: poslané výdejní místo se ignoruje', async () => {
  const stav = stavSGls();
  let overovano = false;
  const { handler } = handlerObjednavek(stav, { overit: async () => { overovano = true; return MISTO; } });
  const res = vytvoritRes();
  await handler(pozadavek({ doprava: 'zasilkovna', vydejni_misto_id: '39301-ELPESRO' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(overovano, false);
  const o = stav.objednavky[0];
  assert.equal(o.vydejni_misto_id, null);
  assert.equal(o.vydejni_misto_nazev, null);
  assert.equal(o.doprava_cena, 85, 'cena ze nastavení, ne pevná 79');
  assert.equal(o.dopravce, 'zasilkovna');
});

test('stávající doprava beze změny: bez uloženého nastavení 79 / 89 / 0 Kč a zdarma od 2 000 Kč', async () => {
  for (const [kod, mnozstvi, cena] of [['zasilkovna', 1, 79], ['ceska_posta', 1, 89], ['osobni_odber', 1, 0], ['zasilkovna', 4, 0]]) {
    const stav = pocatecniStav();
    stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 5, dostupnost: 'skladem', cena: 500, nazev: 'Bota' });
    const res = vytvoritRes();
    await handlerObjednavek(stav).handler(pozadavek({ doprava: kod, platba: 'prevod', polozky: [{ produkt_id: 1, velikost: 24, pocet: mnozstvi }] }), res);
    assert.equal(res.statusCode, 200, kod);
    assert.equal(stav.objednavky[0].doprava_cena, cena, kod);
    assert.equal(res.body.celkem, 500 * mnozstvi + cena, kod);
  }
});

test('čistý deploy: GLS proměnné včetně GLS_ENABLED=true samy GLS nezapnou (rozhoduje jen nastavení v adminu)', async () => {
  const puvodniEnv = { ...process.env };
  Object.assign(process.env, ENV_PLNE, { GLS_ENABLED: 'true', GLS_WEBSHOP_ENGINE: 'x' });
  try {
    const res = vytvoritRes();
    await najitHandler(routerDoprava({}), 'get', '/')({}, res);
    assert.equal(res.body.metody.some(m => m.kod.startsWith('gls')), false);
    const stav = pocatecniStav();
    stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 3, dostupnost: 'skladem', cena: 500, nazev: 'Bota' });
    for (const kod of ['gls_vydejni_misto', 'gls_adresa']) {
      const r = vytvoritRes();
      await handlerObjednavek(stav).handler(pozadavek({ doprava: kod, vydejni_misto_id: '39301-ELPESRO' }), r);
      assert.equal(r.statusCode, 400, kod);
    }
    assert.equal(stav.objednavky.length, 0);
  } finally {
    for (const k of [...Object.keys(ENV_PLNE), 'GLS_ENABLED', 'GLS_WEBSHOP_ENGINE']) if (!(k in puvodniEnv)) delete process.env[k]; else process.env[k] = puvodniEnv[k];
  }
});
