// Krok 1 - katalog e-shopu: stav ⇄ adresa, filtry, hledání, řazení, počty u
// filtrů a karta produktu. Skutečné funkce se vytáhnou z eshop.html a spustí
// ve vm sandboxu (stejný vzor jako test/eshop-xss.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ESHOP_HTML = fs.readFileSync(path.join(__dirname, '..', 'eshop.html'), 'utf8');

function vytahnout(nazev) {
  const start = ESHOP_HTML.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, `Funkce ${nazev} nebyla v eshop.html nalezena`);
  let hloubka = 0;
  for (let i = ESHOP_HTML.indexOf('{', start); i < ESHOP_HTML.length; i++) {
    if (ESHOP_HTML[i] === '{') hloubka++;
    else if (ESHOP_HTML[i] === '}' && --hloubka === 0) return ESHOP_HTML.slice(start, i + 1);
  }
  throw new Error(`Konec funkce ${nazev} nenalezen`);
}
function vytahnoutKonstantu(nazev) {
  const m = ESHOP_HTML.match(new RegExp(`const ${nazev} = [^;]+;`));
  assert.ok(m, `Konstanta ${nazev} nenalezena`);
  return m[0];
}

const sandbox = { URL, URLSearchParams };
vm.createContext(sandbox);
vm.runInContext([
  ...['KATALOG_RAZENI', 'KATALOG_SIRKA', 'KATALOG_ZAPINANI'].map(vytahnoutKonstantu),
  ...['escHtml', 'escAttr', 'jeBezpecnaHttpUrl', 'obrazekProduktuHtml', 'prazdnyStavKatalogu', 'bezDiakritiky', 'slugText',
    'stavZUrl', 'urlZeStavu', 'hledaniOdpovida', 'jeSkladem', 'produktOdpovida', 'filtrovatProdukty', 'seraditProdukty',
    'spocitatMoznosti', 'pocetProduktuText', 'kartaProduktuHtml', 'drobeckyHtml'].map(vytahnout),
  // ziskatPozadiKategorie potřebuje globální kategorie - v testu stačí neutrální pozadí
  'function ziskatPozadiKategorie() { return { trida: "product-img-default", styl: "" }; }'
].join('\n'), sandbox);
// Pole a objekty ze sandboxu mají jiný prototyp (jiný realm) - přes JSON na běžné hodnoty
const run = (kod) => {
  const v = vm.runInContext(kod, sandbox);
  return v !== null && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
};
const zavolat = (fn, ...args) => run(`${fn}(...${JSON.stringify(args)})`);

const vel = (velikost, dostupnost = 'skladem') => ({ velikost, dostupnost });
const PRODUKTY = [
  { klic: 'm:a', slug: 'froddo-autumn', znacka: 'Froddo', nazev: 'Autumn Black+', kategorie: 'celorocky', cena: 1490, maxId: 10,
    velikosti: [vel(22), vel(24), vel(25)], vyprodane: [23], barefoot: true, sirkaNohy: ['siroka'], zapinani: ['suchy_zip'], membrana: false, primaryImageUrl: 'https://img/a.jpg' },
  { klic: 'm:b', slug: 'beda-zuzi', znacka: 'Beda', nazev: 'Zuzi Žlutá', kategorie: 'papuce', cena: 690, maxId: 30,
    velikosti: [vel(20), vel(21, 'dodavatel')], vyprodane: [], barefoot: false, sirkaNohy: ['normalni', 'siroka'], zapinani: ['nazouvaci'], membrana: null },
  { klic: 'm:c', slug: 'protetika-tery', znacka: 'Protetika', nazev: 'Tery', kategorie: 'celorocky', cena: 1090, maxId: 20,
    velikosti: [vel(26, 'dodavatel'), vel(31)], vyprodane: [], barefoot: null, sirkaNohy: [], zapinani: [], membrana: true }
];
const CTX = {
  vekoveSkupiny: [{ nazev: 'První krůčky', od: 17, do: 21 }, { nazev: 'Batolata', od: 22, do: 25 }, { nazev: 'Školáci', od: 31, do: 42 }],
  nazvyKategorii: { celorocky: 'Celoročky', papuce: 'Papuče' }
};
const stav = (zmena = {}) => ({ ...run('prazdnyStavKatalogu()'), ...zmena });
const najit = (zmena) => run(`filtrovatProdukty(${JSON.stringify(PRODUKTY)}, ${JSON.stringify(stav(zmena))}, ${JSON.stringify(CTX)})`).map(p => p.slug);

test('adresa ⇄ stav: tam a zpět beze ztráty, výchozí hodnoty se do adresy nepíšou', () => {
  const s = stav({ kategorie: 'celorocky', velikost: 25, znacka: ['Froddo', 'Beda'], vek: ['batolata'], barefoot: true,
    sirka: ['siroka'], zapinani: ['suchy_zip'], membrana: true, skladem: true, cenaOd: 500, cenaDo: 1500, hledat: 'žlutá 25', razeni: 'nejlevnejsi', produkt: 'beda-zuzi' });
  const url = zavolat('urlZeStavu', s);
  assert.match(url, /^\?kategorie=celorocky&velikost=25&znacka=Froddo%2CBeda/);
  assert.deepEqual(zavolat('stavZUrl', url), s);
  assert.equal(zavolat('urlZeStavu', stav()), '');
  assert.equal(zavolat('urlZeStavu', stav({ razeni: 'doporucene' })), '');
});

test('adresa: neplatné a podvržené hodnoty se zahodí', () => {
  const s = zavolat('stavZUrl', '?velikost=abc&cena_od=-5&cena_do=1.5&razeni=hack&sirka=obri,siroka&zapinani=toString&barefoot=1&produkt=' + 'x'.repeat(300));
  assert.equal(s.velikost, null);
  assert.equal(s.cenaOd, null);
  assert.equal(s.cenaDo, null);
  assert.equal(s.razeni, 'doporucene');
  assert.deepEqual(s.sirka, ['siroka']);
  assert.deepEqual(s.zapinani, []);
  assert.equal(s.barefoot, false);
  assert.equal(s.produkt.length, 120);
  assert.equal(zavolat('stavZUrl', '?velikost=0').velikost, null);
  assert.equal(zavolat('stavZUrl', '?velikost=61').velikost, null);
  assert.deepEqual(zavolat('stavZUrl', '?znacka=Beda,,Beda, Froddo').znacka, ['Beda', 'Froddo']);
});

test('filtry: kategorie, velikost, značka, věk, vlastnosti, cena a jen skladem', () => {
  assert.deepEqual(najit({}), ['froddo-autumn', 'beda-zuzi', 'protetika-tery']);
  assert.deepEqual(najit({ kategorie: 'celorocky' }), ['froddo-autumn', 'protetika-tery']);
  assert.deepEqual(najit({ velikost: 23 }), [], 'vyprodaná velikost se nenabízí');
  assert.deepEqual(najit({ velikost: 21 }), ['beda-zuzi']);
  assert.deepEqual(najit({ velikost: 21, skladem: true }), [], 'u dodavatele není skladem');
  assert.deepEqual(najit({ skladem: true }), ['froddo-autumn', 'beda-zuzi', 'protetika-tery']);
  assert.deepEqual(najit({ znacka: ['Beda', 'Protetika'] }), ['beda-zuzi', 'protetika-tery']);
  assert.deepEqual(najit({ vek: ['prvni-krucky'] }), ['beda-zuzi']);
  assert.deepEqual(najit({ vek: ['prvni-krucky', 'skolaci'] }), ['beda-zuzi', 'protetika-tery']);
  assert.deepEqual(najit({ barefoot: true }), ['froddo-autumn']);
  assert.deepEqual(najit({ membrana: true }), ['protetika-tery']);
  assert.deepEqual(najit({ sirka: ['normalni'] }), ['beda-zuzi']);
  assert.deepEqual(najit({ sirka: ['siroka'], zapinani: ['suchy_zip'] }), ['froddo-autumn']);
  assert.deepEqual(najit({ cenaOd: 700, cenaDo: 1200 }), ['protetika-tery']);
});

test('hledání: víc slov, číslo jako velikost, bez diakritiky, i název kategorie', () => {
  assert.deepEqual(najit({ hledat: 'Froddo 25' }), ['froddo-autumn']);
  assert.deepEqual(najit({ hledat: 'froddo 23' }), [], 'vyprodaná velikost hledání neprojde');
  assert.deepEqual(najit({ hledat: 'zluta' }), ['beda-zuzi']);
  assert.deepEqual(najit({ hledat: 'PAPUČE' }), ['beda-zuzi']);
  assert.deepEqual(najit({ hledat: '  ' }).length, 3);
});

test('řazení: doporučené dá boty s fotkou napřed, ostatní podle ceny a novosti', () => {
  const seradit = r => run(`seraditProdukty(${JSON.stringify(PRODUKTY)}, '${r}')`).map(p => p.slug);
  assert.deepEqual(seradit('doporucene'), ['froddo-autumn', 'beda-zuzi', 'protetika-tery']);
  assert.deepEqual(seradit('nejlevnejsi'), ['beda-zuzi', 'protetika-tery', 'froddo-autumn']);
  assert.deepEqual(seradit('nejdrazsi'), ['froddo-autumn', 'protetika-tery', 'beda-zuzi']);
  assert.deepEqual(seradit('nejnovejsi'), ['beda-zuzi', 'protetika-tery', 'froddo-autumn']);
});

test('počty u filtrů: vlastní skupina se nepočítá, ostatní filtry ano', () => {
  const pocty = run(`spocitatMoznosti(${JSON.stringify(PRODUKTY)}, ${JSON.stringify(stav({ kategorie: 'celorocky', znacka: ['Froddo'] }))}, ${JSON.stringify(CTX)})`);
  assert.deepEqual(pocty.znacka, { Froddo: 1, Protetika: 1 }, 'u značek se ukáže, kolik by přibylo');
  assert.deepEqual(pocty.kategorie, { celorocky: 1 }, 'kategorie respektuje vybranou značku');
  assert.deepEqual(pocty.velikost, { 22: 1, 24: 1, 25: 1 });
  assert.equal(pocty.barefoot, 1);
  assert.deepEqual(pocty.vek, { batolata: 1 });
});

test('počet produktů česky', () => {
  assert.deepEqual([0, 1, 2, 4, 5, 22].map(n => zavolat('pocetProduktuText', n)),
    ['0 produktů', '1 produkt', '2 produkty', '4 produkty', '5 produktů', '22 produktů']);
});

test('karta: velikosti skladem, vyprodané šedě, hledaná zvýrazněná, stav skladu, barefoot', () => {
  const h = run(`kartaProduktuHtml(${JSON.stringify(PRODUKTY[0])}, ${JSON.stringify(stav({ velikost: 24 }))})`);
  assert.match(h, /<span title="Skladem">22<\/span><span class="vyprodano" title="Vyprodáno">23<\/span><span class="hledana" title="Skladem">24<\/span>/);
  assert.match(h, /Skladem/);
  assert.match(h, /product-badge barefoot/);
  assert.match(h, /data-klic="m:a"/);
  const dodavatel = run(`kartaProduktuHtml(${JSON.stringify({ ...PRODUKTY[1], velikosti: [vel(21, 'dodavatel')] })}, ${JSON.stringify(stav())})`);
  assert.match(dodavatel, /U dodavatele/);
  assert.doesNotMatch(dodavatel, /barefoot/);
});

test('karta a drobečky: XSS ve značce, názvu i klíči je escapované', () => {
  const PAYLOAD = '<img src=x onerror=alert(1)>';
  const h = run(`kartaProduktuHtml(${JSON.stringify({ ...PRODUKTY[0], znacka: PAYLOAD, nazev: '"><script>alert(2)</script>', klic: `x"' onmouseover=alert(3)` })}, ${JSON.stringify(stav())})`);
  assert.equal(h.includes(PAYLOAD), false);
  assert.equal(h.includes('<script>'), false);
  assert.ok(h.includes('data-klic="x&quot;&#39; onmouseover=alert(3)"'));
  const d = run(`drobeckyHtml(${JSON.stringify([{ text: 'Úvod', href: 'index.html' }, { text: PAYLOAD, href: 'eshop.html?kategorie="x', stav: { kategorie: '"><b>' } }, { text: PAYLOAD }])})`);
  assert.equal(d.includes(PAYLOAD), false);
  assert.equal(d.includes('<b>'), false);
  assert.match(d, /<span aria-current="page">&lt;img/);
  assert.match(d, /<a href="index.html">Úvod<\/a>/);
});

test('eshop.html: starý filtr a neescapovaná karta jsou pryč, dlaždice kategorií escapují název', () => {
  for (const stare of ['function zobrazitProdukty(', 'function aplikovatFiltry(', 'function filterByVelikost(', 'id="filterVelikost"', 'aktivniKategorieChip']) {
    assert.equal(ESHOP_HTML.includes(stare), false, stare);
  }
  assert.match(vytahnout('vykreslitKategorieGrid'), /\$\{escHtml\(k\.nazev\)\}/);
  assert.match(vytahnout('vykreslitKategorieGrid'), /data-slug="\$\{escAttr\(k\.slug\)\}"/);
});
