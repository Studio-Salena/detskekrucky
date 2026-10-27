// Krok 0 - stránka „Modely bot“ v admin.html. Stejný vzor jako ostatní admin
// testy: skutečný zdrojový kód funkcí se vytáhne z admin.html a spustí ve vm
// sandboxu s mockovaným DOM - netestuje vlastní kopii.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function vytahnoutFunkci(nazev) {
  let start = ADMIN_HTML.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, `Funkce ${nazev} nebyla v admin.html nalezena`);
  if (ADMIN_HTML.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let hloubka = 0;
  for (let i = ADMIN_HTML.indexOf('{', start); i < ADMIN_HTML.length; i++) {
    if (ADMIN_HTML[i] === '{') hloubka++;
    else if (ADMIN_HTML[i] === '}' && --hloubka === 0) return ADMIN_HTML.slice(start, i + 1);
  }
  throw new Error(`Konec funkce ${nazev} nenalezen`);
}

const PAYLOAD = '<img src=x onerror=alert(1)>';
const VOLBY = {
  sirka: { uzka: 'úzká', normalni: 'normální', siroka: 'široká' },
  nart: { nizky: 'nízký' }, dominantni_palec: { vhodna: 'vhodná' },
  zapinani: { suchy_zip: 'suchý zip' }, material: { kuze: 'kůže' }, pohlavi: { holcicka: 'holčička' }
};

function vykreslit({ modely, filtr = {}, pohlavi = false, kategorie = [{ slug: 'celorocky', nazev: 'Celoročky' }], vybrane = [] }) {
  const prvky = {
    modelyTable: { innerHTML: '' },
    modelyPocet: { textContent: '' },
    modelyHledat: { value: filtr.hledat || '' },
    modelyFiltrKategorie: { value: filtr.kategorie || '' },
    modelyJenNevyplnene: { checked: !!filtr.jenNevyplnene }
  };
  const sandbox = {
    document: { getElementById: id => prvky[id] },
    modelyData: { volby: VOLBY, kategorieBezVlastnosti: ['doplnky'], modely },
    modelyKategorie: kategorie,
    nastaveniKatalogu: { vekoveSkupiny: [], pohlavi },
    modelyVybrane: new Set(vybrane),
    modelyRozbaleneZnacky: new Set(filtr.rozbalene || []),
    vykreslitSeznamProduktu: () => {},
    vykreslitCoChybi: () => {}
  };
  vm.createContext(sandbox);
  const funkce = ['normalizovat', 'pocetSlovy', 'escH', 'escAttr', 'modelBezVlastnosti', 'vyberAnoNe', 'vyberJedna', 'vyberVice', 'vyberKategorie', 'vykreslitModely'];
  vm.runInContext(funkce.map(vytahnoutFunkci).join('\n') + '\nvykreslitModely();', sandbox);
  return prvky;
}

const MODEL = {
  id: 1, znacka: 'Froddo', nazev: 'Autumn', kategorie: 'celorocky', velikosti: [22, 26], kusu: 4, ma_fotku: true, na_eshopu: true,
  barefoot: true, sirka: ['siroka'], nart: [], dominantni_palec: null, zapinani: ['suchy_zip'], membrana: false, material: 'kuze', pohlavi: null,
  vyplneno: true, kategorie_ke_kontrole: false
};

test('admin Sortiment: v menu jen Produkty a Kategorie; Modely jsou záložka Hromadná úprava v Produktech', () => {
  assert.doesNotMatch(ADMIN_HTML, /Modely bot<\/span>/, 'položka Modely bot v menu není');
  assert.match(ADMIN_HTML, /showPage\('produkty',this\)"><span class="nav-text">Produkty<\/span>/);
  assert.match(ADMIN_HTML, /showPage\('kategorie',this\)"><span class="nav-text">Kategorie<\/span>/);
  assert.doesNotMatch(ADMIN_HTML, /id="page-modely"/);
  const produkty = ADMIN_HTML.slice(ADMIN_HTML.indexOf('id="page-produkty"'), ADMIN_HTML.indexOf('<!-- PRODEJNA -->'));
  assert.match(produkty, /data-cil="seznam"[^>]*>Seznam<\/button>/);
  assert.match(produkty, /data-cil="hromadna"[^>]*>Hromadná úprava<\/button>/);
  const hromadna = produkty.slice(produkty.indexOf('data-pohled="hromadna"'));
  for (const id of ['modelyHledat', 'modelyFiltrKategorie', 'modelyJenNevyplnene', 'modelyHromadne', 'modelyTable']) {
    assert.match(hromadna, new RegExp(`id="${id}"`), id + ' je v Hromadné úpravě');
  }
  // staré odkazy showPage('modely') vedou do Hromadné úpravy, Produkty načtou modely
  assert.match(ADMIN_HTML, /if \(name === 'modely'\) \{ name = 'produkty'; kotva = kotva \|\| 'hromadna'; \}/);
  assert.match(ADMIN_HTML, /async function loadProdukty\(\) \{\s*await Promise\.all\(\[loadModely\(\), loadVyrobci\(\)\]\);/);
});

test('admin: řádek modelu ukazuje vybrané vlastnosti, velikosti a stav', () => {
  const { modelyTable, modelyPocet } = vykreslit({ modely: [MODEL] });
  const h = modelyTable.innerHTML;
  assert.match(h, /data-model-id="1"/);
  assert.match(h, /vel\. 22–26 · 4 ks · 📷 fotka/);
  assert.match(h, /<option value="true" selected>ano<\/option>/);
  assert.match(h, /data-pole="sirka" value="siroka" checked/);
  assert.match(h, /data-pole="sirka" value="uzka">/);
  assert.match(h, /<option value="kuze" selected>kůže<\/option>/);
  assert.match(h, /✓ vyplněno/);
  assert.doesNotMatch(h, /Pro koho/, 'bez zapnutého pohlaví není sloupec');
  assert.equal(modelyPocet.textContent, 'Modely (1) · vyplněno 1 z 1 bot');
});

test('admin: XSS ve značce, názvu i kategorii je escapované', () => {
  const zly = { ...MODEL, znacka: PAYLOAD, nazev: `"><script>alert(2)</script>`, kategorie: `x"><img src=y onerror=alert(3)>` };
  const h = vykreslit({ modely: [zly], kategorie: [{ slug: 'a"b', nazev: PAYLOAD }] }).modelyTable.innerHTML;
  assert.equal(h.includes(PAYLOAD), false);
  assert.equal(h.includes('<script>'), false);
  assert.equal(h.includes('onerror=alert(3)>'), false);
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(h.includes('value="a&quot;b"'));
});

test('admin: výběr pro hromadnou změnu se drží při překreslení, „vybrat vše“ odpovídá zobrazeným', () => {
  const druhy = { ...MODEL, id: 2, nazev: 'Zuzi' };
  const jeden = vykreslit({ modely: [MODEL, druhy], vybrane: [2] }).modelyTable.innerHTML;
  assert.match(jeden, /data-vyber value="2" aria-label="Vybrat model" checked/);
  assert.match(jeden, /data-vyber value="1" aria-label="Vybrat model">/);
  assert.match(jeden, /data-vyber-vse aria-label="Vybrat všechny modely odpovídající filtru">/);
  const vse = vykreslit({ modely: [MODEL, druhy], vybrane: [1, 2] }).modelyTable.innerHTML;
  assert.match(vse, /data-vyber-vse aria-label="Vybrat všechny modely odpovídající filtru" checked/);
});

test('admin: hromadná změna posílá vybraná id a správně převedenou hodnotu', async () => {
  const volani = [];
  const prvky = {
    hromadnePole: { value: 'barefoot', selectedOptions: [{ textContent: 'barefoot' }] },
    hromadneHodnota: { value: 'false', options: [1], selectedOptions: [{ textContent: 'ne' }] }
  };
  const sandbox = {
    document: { getElementById: id => prvky[id], querySelector: () => null },
    modelyVybrane: new Set([4, 9]),
    API: 'https://x/api',
    confirm: () => true,
    alert: (t) => { throw new Error('nečekaný alert: ' + t); },
    adminFetch: async (url, opts) => { volani.push({ url, telo: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ upraveno: 2 }) }; },
    loadModely: async () => {}, aktualizovatHromadnyPanel: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(vytahnoutFunkci('pouzitHromadnouZmenu'), sandbox);
  await vm.runInContext('pouzitHromadnouZmenu()', sandbox);
  assert.equal(volani.length, 1);
  assert.equal(volani[0].url, 'https://x/api/modely/hromadne');
  assert.deepEqual(volani[0].telo, { ids: [4, 9], zmeny: { barefoot: false } });
  assert.equal(sandbox.modelyVybrane.size, 0, 'po úspěchu se výběr vyprázdní');
});

test('admin: doplňky bez vlastností, filtr nevyplněných, sloupec pohlaví a varování kategorie', () => {
  const doplnek = { ...MODEL, id: 2, nazev: 'Ponožky', kategorie: 'doplnky', vyplneno: true, barefoot: null, sirka: [] };
  const nevyplneny = { ...MODEL, id: 3, nazev: 'Zuzi', vyplneno: false, kategorie_ke_kontrole: true };
  const vse = vykreslit({ modely: [MODEL, doplnek, nevyplneny], pohlavi: true });
  assert.match(vse.modelyTable.innerHTML, /Není bota, vlastnosti se nevyplňují/);
  assert.match(vse.modelyTable.innerHTML, /<th>Pro koho<\/th>/);
  assert.match(vse.modelyTable.innerHTML, /velikosti jsou ve více kategoriích/);
  assert.equal(vse.modelyPocet.textContent, 'Modely (3) · vyplněno 1 z 2 bot');

  const jen = vykreslit({ modely: [MODEL, doplnek, nevyplneny], filtr: { jenNevyplnene: true } }).modelyTable.innerHTML;
  assert.match(jen, /data-model-id="3"/);
  assert.doesNotMatch(jen, /data-model-id="1"/);
  assert.doesNotMatch(jen, /data-model-id="2"/);

  const hledani = vykreslit({ modely: [MODEL, nevyplneny], filtr: { hledat: 'zuz' } }).modelyTable.innerHTML;
  assert.match(hledani, /data-model-id="3"/);
  assert.doesNotMatch(hledani, /data-model-id="1"/);
});

test('admin Texty webu: pruhy e-shopu a webu se načtou (výchozí text, dokud není uložený) a uloží spolu s ostatními texty', async () => {
  const prvky = {};
  const el = id => (prvky[id] = prvky[id] || { value: '', innerHTML: '' });
  const odeslano = [];
  const sandbox = {
    document: { getElementById: el },
    API: 'https://x/api',
    adminFetch: async (url, opts) => {
      if (opts && opts.method === 'POST') { odeslano.push(JSON.parse(opts.body)); return { ok: true }; }
      return { json: async () => ({ procBarefoot: [], mereniKroky: [], typyChodidel: [], vyberteSi: [{ nadpis: 'X' }] }) };
    },
    setTimeout: () => {},
    clearTimeout: () => {}
  };
  vm.createContext(sandbox);
  const konst = ADMIN_HTML.match(/const VYCHOZI_ESHOP_PRUH = [^;]+;/)[0] + '\n' + ADMIN_HTML.match(/const VYCHOZI_WEB_PRUH = [^;]+;/)[0];
  vm.runInContext(`let textyWebuData = {}; const vychoziTrustBadges = []; ${konst}\n${vytahnoutFunkci('loadTexty')}\n${vytahnoutFunkci('ulozitTexty')}`, sandbox);
  await vm.runInContext('loadTexty()', sandbox);
  assert.match(prvky.txEshopPruh.value, /Dětské kroky s jistotou/);
  assert.match(prvky.txWebPruh.value, /Potřebujete botičky či papučky/);
  prvky.txEshopPruh.value = '  Akce týdne  ';
  prvky.txWebPruh.value = '';
  await vm.runInContext('ulozitTexty()', sandbox);
  assert.equal(odeslano[0].eshopPruh, 'Akce týdne');
  assert.equal(odeslano[0].webPruh, '', 'prázdný pruh se uloží (= skrytý)');
  assert.deepEqual(odeslano[0].vyberteSi, [{ nadpis: 'X' }], 'ostatní texty zůstanou');
  // potvrzení i u tlačítka (je na konci dlouhé stránky), tlačítko zase aktivní
  assert.match(prvky.textyMsgDole.innerHTML, /Texty uloženy/);
  assert.match(prvky.textyMsg.innerHTML, /Texty uloženy/);
  assert.equal(prvky.textyUlozitBtn.disabled, false);
  assert.match(ADMIN_HTML, /id="txEshopPruh"[^>]*maxlength="300"/);
  assert.match(ADMIN_HTML, /id="txWebPruh"[^>]*maxlength="300"/);
});

test('admin Modely: seskupení podle značky - sbalené skupiny, hledání bez diakritiky rozbalí, výběr celé značky', () => {
  const modely = [
    { ...MODEL, id: 1, znacka: 'Froddo', nazev: 'Autumn' },
    { ...MODEL, id: 2, znacka: 'froddo ', nazev: 'Paix', vyplneno: false },
    { ...MODEL, id: 3, znacka: 'Beda', nazev: 'Žabka' },
    { ...MODEL, id: 4, znacka: '', nazev: 'Bez značky model' }
  ];
  let h = vykreslit({ modely }).modelyTable.innerHTML;
  const skupiny = [...h.matchAll(/<tbody class="model-skupina" data-znacka="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(skupiny, ['beda', 'froddo', '~'], 'značky podle abecedy (bez ohledu na velikost písmen a mezery), bez značky na konci');
  assert.match(h, /<strong>Froddo<\/strong>[\s\S]*?2 modely · <span style="color:var\(--orange\)">1 k vyplnění/);
  assert.equal((h.match(/<tr data-model-id="\d+" hidden>/g) || []).length, 4, 've výchozím stavu sbalené');
  assert.match(h, /aria-expanded="false"/);
  h = vykreslit({ modely, filtr: { rozbalene: ['froddo'] } }).modelyTable.innerHTML;
  assert.equal((h.match(/<tr data-model-id="\d+" hidden>/g) || []).length, 2, 'rozbalená značka zůstane rozbalená');
  h = vykreslit({ modely, filtr: { hledat: 'zabka' } }).modelyTable.innerHTML;
  assert.match(h, /Žabka/, 'hledání bez háčků');
  assert.doesNotMatch(h, /Autumn/);
  assert.doesNotMatch(h, / hidden>/, 'při hledání je výsledek rozbalený');
  h = vykreslit({ modely, vybrane: [1, 2] }).modelyTable.innerHTML;
  assert.match(h, /data-znacka="froddo">\s*<tr class="skupina-hlavicka">\s*<td><input type="checkbox" data-vyber-znacka[^>]* checked>/, 'značka se všemi vybranými modely je zaškrtnutá');
  assert.match(vykreslit({ modely: [{ ...MODEL, znacka: '<img src=x>' }] }).modelyTable.innerHTML, /&lt;img src=x&gt;/);
});

// ═══ Co chybí ═══

function vykreslitChybi(modely, filtr = '') {
  const prvky = { chybiTable: { innerHTML: '' }, chybiFiltr: { innerHTML: '' } };
  const sandbox = {
    document: { getElementById: id => prvky[id] },
    modelyData: { volby: VOLBY, kategorieBezVlastnosti: ['doplnky'], modely },
    modelyKategorie: [{ slug: 'celorocky', nazev: 'Celoročky' }, { slug: 'doplnky', nazev: 'Doplňky' }]
  };
  vm.createContext(sandbox);
  const konst = ADMIN_HTML.match(/const CHYBI = \[[\s\S]*?\n\];/)[0];
  vm.runInContext([konst, 'let chybiFiltr = ' + JSON.stringify(filtr) + ';',
    ...['escH', 'escAttr', 'modelBezVlastnosti', 'nazevKategorie', 'coChybiModelu', 'vykreslitCoChybi'].map(vytahnoutFunkci), 'vykreslitCoChybi();'].join('\n'), sandbox);
  return prvky;
}

test('admin Co chybí: jen boty v nabídce, u každé co chybí, počty ve filtrech', () => {
  const uplny = { ...MODEL, id: 1, v_nabidce: true, ma_rozmery: true, ma_popis: true };
  const modely = [
    uplny,
    { ...uplny, id: 2, nazev: 'Bez fotky a mm', ma_fotku: false, ma_rozmery: false },
    { ...uplny, id: 3, nazev: 'Nevyplněná', vyplneno: false, ma_popis: false },
    { ...uplny, id: 4, nazev: 'Ke kontrole', kategorie_ke_kontrole: true },
    { ...uplny, id: 5, nazev: 'Vyprodaná', v_nabidce: false, ma_fotku: false },
    // doplňky: rozměry a vlastnosti se nehlídají, fotka a popis ano
    { ...uplny, id: 6, nazev: 'Ponožky', kategorie: 'doplnky', vyplneno: false, ma_rozmery: false, ma_popis: false },
    { ...uplny, id: 7, nazev: PAYLOAD, ma_fotku: false }
  ];
  const { chybiTable, chybiFiltr } = vykreslitChybi(modely);
  const h = chybiTable.innerHTML;
  const radky = [...h.matchAll(/data-chybi-model="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(radky, [2, 3, 4, 6, 7]);
  const radek = id => h.slice(h.indexOf(`data-chybi-model="${id}"`), h.indexOf('</tr>', h.indexOf(`data-chybi-model="${id}"`)));
  assert.match(radek(2), /Bez fotky.*Bez rozměrů/);
  assert.match(radek(3), /Bez vlastností.*Bez popisu/);
  assert.match(radek(4), /Bez vlastností/);
  assert.match(radek(6), /Bez popisu/);
  assert.doesNotMatch(radek(6), /Bez rozměrů|Bez vlastností/);
  assert.match(h, /onclick="otevritDetailModelu\(2\)"/);
  assert.ok(!h.includes(PAYLOAD), 'název se escapuje');
  assert.match(chybiFiltr.innerHTML, /Vše \(5\)/);
  assert.match(chybiFiltr.innerHTML, /Bez fotky \(2\)/);
  assert.match(chybiFiltr.innerHTML, /Bez rozměrů \(mm\) \(1\)/);
  assert.match(chybiFiltr.innerHTML, /Bez vlastností \(2\)/);
  assert.match(chybiFiltr.innerHTML, /Bez popisu \(2\)/);
});

test('admin Co chybí: filtr podle druhu, prázdný filtr se zruší, bez chyb hláška', () => {
  const uplny = { ...MODEL, v_nabidce: true, ma_rozmery: true, ma_popis: true };
  const modely = [{ ...uplny, id: 1, ma_fotku: false }, { ...uplny, id: 2, ma_popis: false }];
  const { chybiTable, chybiFiltr } = vykreslitChybi(modely, 'popis');
  assert.deepEqual([...chybiTable.innerHTML.matchAll(/data-chybi-model="(\d+)"/g)].map(m => Number(m[1])), [2]);
  assert.match(chybiFiltr.innerHTML, /class="pill active" onclick="filtrovatCoChybi\('popis'\)"/);
  // filtr, kterému nic neodpovídá, se vrátí na Vše
  const r = vykreslitChybi(modely, 'rozmery');
  assert.match(r.chybiFiltr.innerHTML, /class="pill active" onclick="filtrovatCoChybi\(''\)"/);
  assert.match(vykreslitChybi([uplny]).chybiTable.innerHTML, /nic nechybí/);
});

test('admin Co chybí: záložka v Produktech', () => {
  const produkty = ADMIN_HTML.slice(ADMIN_HTML.indexOf('id="page-produkty"'), ADMIN_HTML.indexOf('<!-- PRODEJNA -->'));
  assert.match(produkty, /data-cil="chybi"[^>]*>Co chybí<\/button>/);
  assert.match(produkty, /data-pohled="chybi"[\s\S]*id="chybiFiltr"[\s\S]*id="chybiTable"/);
});
