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
    modelyVybrane: new Set(vybrane)
  };
  vm.createContext(sandbox);
  const funkce = ['escH', 'escAttr', 'modelBezVlastnosti', 'vyberAnoNe', 'vyberJedna', 'vyberVice', 'vyberKategorie', 'vykreslitModely'];
  vm.runInContext(funkce.map(vytahnoutFunkci).join('\n') + '\nvykreslitModely();', sandbox);
  return prvky;
}

const MODEL = {
  id: 1, znacka: 'Froddo', nazev: 'Autumn', kategorie: 'celorocky', velikosti: [22, 26], kusu: 4, ma_fotku: true, na_eshopu: true,
  barefoot: true, sirka: ['siroka'], nart: [], dominantni_palec: null, zapinani: ['suchy_zip'], membrana: false, material: 'kuze', pohlavi: null,
  vyplneno: true, kategorie_ke_kontrole: false
};

test('admin: v menu je „Modely bot“ a showPage načítá modely', () => {
  assert.match(ADMIN_HTML, /showPage\('modely',this\)/);
  assert.match(ADMIN_HTML, /id="page-modely"/);
  assert.match(ADMIN_HTML, /if \(name==='modely'\) loadModely\(\);/);
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
  assert.match(jeden, /data-vyber-vse aria-label="Vybrat všechny zobrazené">/);
  const vse = vykreslit({ modely: [MODEL, druhy], vybrane: [1, 2] }).modelyTable.innerHTML;
  assert.match(vse, /data-vyber-vse aria-label="Vybrat všechny zobrazené" checked/);
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
