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
    'spocitatMoznosti', 'pocetProduktuText', 'stitkyKartyHtml', 'kartaProduktuHtml', 'drobeckyHtml'].map(vytahnout),
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
  assert.match(h, /<span title="Skladem">22<\/span><span class="vyprodano" title="Není skladem">23<\/span><span class="hledana" title="Skladem">24<\/span>/);
  assert.match(h, /Skladem/);
  assert.match(h, /<div class="karta-stitky"><span class="stitek stitek-barefoot">Barefoot<\/span><\/div>/, 'štítek pod fotkou');
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

// ═══ Krok 2 - stránka produktu ═══

const detail = new vm.Script([
  ...['DETAIL_NART', 'DETAIL_MATERIAL', 'DETAIL_PALEC'].map(vytahnoutKonstantu),
  ...['popisVolby', 'cm', 'velikostiDetailuHtml', 'nozickaHtml', 'parametryHtml', 'podobneProdukty', 'fotkyProduktu'].map(vytahnout)
].join('\n'));
detail.runInContext(sandbox);

const BOTA = {
  ...PRODUKTY[0], typ_nohy: 'Na vyšší <nárt>', nart: ['stredni', 'vysoky'], dominantniPalec: 'vhodna', material: 'kuze',
  velikosti: [{ velikost: 24, dostupnost: 'skladem', delka_mm: 165, sirka_mm: 65 }, { velikost: 25, dostupnost: 'dodavatel', delka_mm: 172 }],
  vyprodane: [23]
};

test('detail: tabulka velikostí s vyprodanou (nejde vybrat), u dodavatele a vnitřními rozměry v cm', () => {
  const h = run(`velikostiDetailuHtml(${JSON.stringify(BOTA)})`);
  const radky = h.split('</button>').filter(x => x.trim());
  assert.equal(radky.length, 3);
  assert.match(radky[0], /data-velikost="23" disabled/);
  assert.match(radky[0], /Není skladem/);
  assert.doesNotMatch(radky[0], /onclick/);
  assert.match(radky[1], /onclick="vybrVelikost\(24,this\)" aria-pressed="false"/);
  assert.match(radky[1], /Skladem<\/span><span class="mm">vnitřní 16,5 × 6,5 cm/);
  assert.match(radky[2], /U dodavatele \(7–14 dní\)/);
  assert.match(radky[2], /vnitřní délka 17,2 cm/);
});

test('detail: Pro jakou nožičku a parametry z vlastností modelu, text escapovaný', () => {
  const n = run(`nozickaHtml(${JSON.stringify(BOTA)})`);
  assert.match(n, /<dt>Typ<\/dt><dd>barefoot<\/dd>/);
  assert.match(n, /<dt>Šířka<\/dt><dd>široká<\/dd>/);
  assert.match(n, /<dt>Nárt<\/dt><dd>střední \/ vysoký<\/dd>/);
  assert.match(n, /<dt>Dominantní palec<\/dt><dd>vhodná<\/dd>/);
  assert.match(n, /Na vyšší &lt;nárt&gt;/);
  assert.match(n, /poraditKProduktu\(\)/);
  const bez = run(`nozickaHtml(${JSON.stringify({ ...PRODUKTY[2], typ_nohy: '' })})`);
  assert.doesNotMatch(bez, /<dl>/, 'bez vyplněných vlastností jen výzva k poradě');
  assert.match(bez, /Poradíme vám/);

  const p = run(`parametryHtml(${JSON.stringify(BOTA)}, 'Celoročky')`);
  assert.match(p, /Značka<\/th><td>Froddo/);
  assert.match(p, /Kategorie<\/th><td>Celoročky/);
  assert.match(p, /Barefoot<\/th><td>ano/);
  assert.match(p, /Materiál<\/th><td>kůže/);
  assert.match(p, /Zapínání<\/th><td>suchý zip/);
  assert.match(p, /Membrána<\/th><td>ne/);
  const xss = run(`parametryHtml(${JSON.stringify({ ...BOTA, znacka: '<img src=x onerror=alert(1)>' })}, '<b>')`);
  assert.equal(xss.includes('<img'), false);
  assert.equal(xss.includes('<b>'), false);
});

test('detail: podobné boty ze stejné kategorie, bez sebe sama, nejvýš 4, přednost společné velikosti', () => {
  const dalsi = [
    { klic: 'x1', kategorie: 'celorocky', znacka: 'Jonap', velikosti: [{ velikost: 30 }] },
    { klic: 'x2', kategorie: 'celorocky', znacka: 'Jonap', velikosti: [{ velikost: 24 }, { velikost: 25 }] },
    { klic: 'x3', kategorie: 'papuce', znacka: 'Froddo', velikosti: [{ velikost: 24 }] },
    { klic: 'x4', kategorie: 'celorocky', znacka: 'Froddo', velikosti: [{ velikost: 31 }] },
    { klic: 'x5', kategorie: 'celorocky', znacka: 'Beda', velikosti: [{ velikost: 22 }] },
    { klic: 'x6', kategorie: 'celorocky', znacka: 'Beda', velikosti: [{ velikost: 40 }] }
  ];
  const vysledek = run(`podobneProdukty(${JSON.stringify(PRODUKTY[0])}, ${JSON.stringify([PRODUKTY[0], ...dalsi])})`).map(p => p.klic);
  assert.deepEqual(vysledek, ['x2', 'x5', 'x4', 'x1']);
});

test('detail: fotky pro galerii - nahrané, jinak hlavní fotka, nebezpečné URL vynechané', () => {
  assert.deepEqual(run(`fotkyProduktu(${JSON.stringify({ images: [{ url: 'javascript:alert(1)' }, { url: 'https://a/1.jpg' }] })})`), [{ url: 'https://a/1.jpg' }]);
  assert.deepEqual(run(`fotkyProduktu(${JSON.stringify({ images: [], primaryImageUrl: 'https://a/h.jpg', primaryImageAlt: 'x' })})`), [{ url: 'https://a/h.jpg', alt: 'x' }]);
  assert.deepEqual(run(`fotkyProduktu(${JSON.stringify({ images: [], emoji: '👟' })})`), []);
});

// ═══ Krok 3 - navigace, hledání, výprodej ═══

new vm.Script(['sekceMenu', 'navrhyHledani', 'navrhyHtml'].map(vytahnout).join('\n')).runInContext(sandbox);
const SE_SLEVOU = PRODUKTY.map((p, i) => i === 1 ? { ...p, cena_puvodni: 890 } : p);
const KATEGORIE = [{ slug: 'celorocky', nazev: 'Celoročky' }, { slug: 'papuce', nazev: 'Papuče' }, { slug: 'holinky', nazev: 'Holínky' }];

test('výprodej: filtr sleva v adrese i ve výsledcích', () => {
  assert.equal(zavolat('urlZeStavu', stav({ sleva: true })), '?sleva=ano');
  assert.equal(zavolat('stavZUrl', '?sleva=ano').sleva, true);
  const ve = run(`filtrovatProdukty(${JSON.stringify(SE_SLEVOU)}, ${JSON.stringify(stav({ sleva: true }))}, ${JSON.stringify(CTX)})`).map(p => p.slug);
  assert.deepEqual(ve, ['beda-zuzi']);
});

test('menu: jen položky, pod kterými je aspoň jedna bota, s počty', () => {
  const sekce = run(`sekceMenu(${JSON.stringify(SE_SLEVOU)}, ${JSON.stringify(KATEGORIE)}, ${JSON.stringify(CTX)})`);
  const najit = n => sekce.find(s => s.nadpis === n);
  assert.deepEqual(najit('Podle typu').odkazy.map(o => [o.text, o.pocet]), [['Celoročky', 2], ['Papuče', 1]], 'prázdné Holínky v menu nejsou');
  assert.deepEqual(najit('Podle vlastností').odkazy.map(o => [o.text, o.pocet]),
    [['Barefoot', 1], ['Na širokou nožičku', 2], ['S membránou', 1], ['Ve slevě', 1]], 'bez úzké nožičky (nikdo ji nemá)');
  assert.deepEqual(najit('Podle věku').odkazy.map(o => o.text), ['První krůčky (17–21)', 'Batolata (22–25)', 'Školáci (31–42)']);
  assert.deepEqual(najit('Značky').odkazy.map(o => o.text), ['Beda', 'Froddo', 'Protetika']);
  assert.deepEqual(najit('Podle typu').odkazy[0].stav, stav({ kategorie: 'celorocky' }));
});

test('našeptávač: boty, kategorie a značky; krátký dotaz nic', () => {
  const ctx = { ...CTX, nazvyKategorii: { celorocky: 'Celoročky', papuce: 'Papuče' } };
  const n = run(`navrhyHledani('froddo 25', ${JSON.stringify(PRODUKTY)}, ${JSON.stringify(KATEGORIE)}, ${JSON.stringify(ctx)})`);
  assert.deepEqual(n.produkty.map(p => p.slug), ['froddo-autumn']);
  assert.deepEqual(n.znacky, ['Froddo']);
  assert.equal(n.celkem, 1);
  const k = run(`navrhyHledani('papuce', ${JSON.stringify(PRODUKTY)}, ${JSON.stringify(KATEGORIE)}, ${JSON.stringify(ctx)})`);
  assert.deepEqual(k.kategorie.map(x => x.slug), ['papuce']);
  assert.deepEqual(k.produkty.map(p => p.slug), ['beda-zuzi'], 'bota z kategorie Papuče');
  assert.equal(run(`navrhyHledani('f', [], [], {})`), null);
});

test('našeptávač: HTML odkazy na botu, kategorii a značku, XSS escapované, prázdný výsledek s radou', () => {
  const PAYLOAD = '<img src=x onerror=alert(1)>';
  const navrhy = { produkty: [{ ...PRODUKTY[0], znacka: PAYLOAD, nazev: '"><b>x</b>' }], celkem: 7, kategorie: [{ slug: 'a"b', nazev: PAYLOAD }], znacky: [PAYLOAD] };
  const h = run(`navrhyHtml(${JSON.stringify(navrhy)}, 'x')`);
  assert.equal(h.includes(PAYLOAD), false);
  assert.equal(h.includes('<b>x</b>'), false);
  assert.match(h, /href="eshop.html\?produkt=froddo-autumn" data-klic="m:a"/);
  assert.match(h, /Zobrazit všechny výsledky \(7\)/);
  const prazdne = run(`navrhyHtml({ produkty: [], celkem: 0, kategorie: [], znacky: [] }, '<script>')`);
  assert.match(prazdne, /jsme nic nenašli/);
  assert.equal(prazdne.includes('<script>'), false);
});

test('eshop.html: logo vede na úvod, patička zachovává autora webu, 404 stránka existuje', () => {
  assert.match(ESHOP_HTML, /<a class="logo" href="index.html"/);
  assert.match(ESHOP_HTML, /Vytvořilo <a href="https:\/\/www.studiosalena.cz"/);
  const stranka404 = fs.readFileSync(path.join(__dirname, '..', '404.html'), 'utf8');
  assert.match(stranka404, /Jejda, tady botička není/);
  assert.match(stranka404, /href="\/eshop.html"/);
});

test('eshop.html: pruh „Dětské kroky s jistotou“ zůstává nad hlavičkou', () => {
  const pruh = ESHOP_HTML.indexOf('Dětské kroky s jistotou. Objevte kompletní sortiment');
  assert.ok(pruh > ESHOP_HTML.indexOf('class="horni-lista"') && pruh < ESHOP_HTML.indexOf('<header>'));
});

// ═══ Krok 6 - rychlý výběr nad katalogem ═══

new vm.Script([vytahnoutKonstantu('KATALOG_BEZ_BOT'),
  ...['jeBota', 'jeVychoziStav', 'oblibeneProdukty'].map(vytahnout)].join('\n')).runInContext(sandbox);

test('rychlý výběr: jen ve výchozím zobrazení (řazení a otevřená bota nevadí)', () => {
  assert.equal(run(`jeVychoziStav(${JSON.stringify(stav())})`), true);
  assert.equal(run(`jeVychoziStav(${JSON.stringify(stav({ razeni: 'nejlevnejsi', produkt: 'x' }))})`), true);
  for (const z of [{ kategorie: 'papuce' }, { velikost: 25 }, { hledat: 'a' }, { sleva: true }, { znacka: ['Beda'] }]) {
    assert.equal(run(`jeVychoziStav(${JSON.stringify(stav(z))})`), false, JSON.stringify(z));
  }
});

test('nejčastěji vybíráte: pořadí ze serveru, jen boty v nabídce, nejvýš 4', () => {
  const slugy = ['neni-skladem', 'protetika-tery', 'froddo-autumn', 'beda-zuzi', 'dalsi'];
  assert.deepEqual(run(`oblibeneProdukty(${JSON.stringify(slugy)}, ${JSON.stringify(PRODUKTY)})`).map(p => p.slug), ['protetika-tery', 'froddo-autumn', 'beda-zuzi']);
  assert.deepEqual(run(`oblibeneProdukty(${JSON.stringify(slugy)}, ${JSON.stringify(PRODUKTY)}, 2)`).map(p => p.slug), ['protetika-tery', 'froddo-autumn']);
  assert.deepEqual(run(`oblibeneProdukty(null, ${JSON.stringify(PRODUKTY)})`), []);
});

test('nejčastěji vybíráte: jen boty, ne doplňky ani péče o obuv', () => {
  const zbozi = [...PRODUKTY,
    { klic: 'p', slug: 'voxx-ponozky', kategorie: 'doplnky', velikosti: [{ velikost: 25 }] },
    { klic: 'c', slug: 'capiki', kategorie: 'capacky', velikosti: [{ velikost: 18 }] }];
  assert.deepEqual(run(`oblibeneProdukty(['voxx-ponozky', 'beda-zuzi', 'capiki'], ${JSON.stringify(zbozi)})`).map(p => p.slug), ['beda-zuzi', 'capiki']);
});

// ═══ Dívky / chlapci ═══

new vm.Script(vytahnoutKonstantu('KATALOG_PRO')).runInContext(sandbox);
const S_POHLAVIM = PRODUKTY.map((p, i) => ({ ...p, pohlavi: ['holcicka', 'chlapecek', 'vse'][i] }));

test('dívky / chlapci: filtr v adresě, bota pro všechny patří do obou, neplatná hodnota se zahodí', () => {
  assert.equal(zavolat('urlZeStavu', stav({ pro: 'divky' })), '?pro=divky');
  assert.equal(zavolat('stavZUrl', '?pro=chlapci').pro, 'chlapci');
  assert.equal(zavolat('stavZUrl', '?pro=toString').pro, '');
  const najitPro = pro => run(`filtrovatProdukty(${JSON.stringify(S_POHLAVIM)}, ${JSON.stringify(stav({ pro }))}, ${JSON.stringify(CTX)})`).map(p => p.slug);
  assert.deepEqual(najitPro('divky'), ['froddo-autumn', 'protetika-tery']);
  assert.deepEqual(najitPro('chlapci'), ['beda-zuzi', 'protetika-tery']);
  const pocty = run(`spocitatMoznosti(${JSON.stringify(S_POHLAVIM)}, ${JSON.stringify(stav({ kategorie: 'celorocky' }))}, ${JSON.stringify(CTX)})`);
  assert.deepEqual(pocty.pro, { divky: 2, chlapci: 1 });
  const bez = run(`spocitatMoznosti(${JSON.stringify(PRODUKTY)}, ${JSON.stringify(stav())}, ${JSON.stringify(CTX)})`);
  assert.deepEqual(bez.pro, {}, 'nevyplněné pohlaví nikam nepatří');
});

test('facelift: štítky pod fotkou, jednotný vzhled, nejvýš dva; fotka bez barevného pozadí kategorie', () => {
  const oba = run(`kartaProduktuHtml(${JSON.stringify({ ...PRODUKTY[0], cena_puvodni: 1990 })}, ${JSON.stringify(stav())})`);
  const foto = oba.slice(oba.indexOf('<div class="product-img"'), oba.indexOf('karta-stitky'));
  assert.doesNotMatch(foto, /stitek|product-badge/, 'přes fotku žádný štítek');
  assert.match(oba, /<div class="karta-stitky"><span class="stitek stitek-sleva">Sleva<\/span><span class="stitek stitek-barefoot">Barefoot<\/span><\/div>/);
  assert.match(oba, /<div class="product-img">/, 'bez tříd a stylu barevného pozadí kategorie');
  const zadny = run(`kartaProduktuHtml(${JSON.stringify(PRODUKTY[2])}, ${JSON.stringify(stav())})`);
  assert.doesNotMatch(zadny, /karta-stitky/);
});

test('facelift: Cormorant se nepoužívá, nadpis katalogu Nunito a podnadpis Dancing Script, řádek důvěry nad tlačítkem objednávky', () => {
  // Cormorant se zatím načítá (majitelka ho nechce mazat), ale nikde se nepoužívá
  assert.doesNotMatch(ESHOP_HTML, /font-family:\s*'Cormorant'/);
  // Hlavní nadpis katalogu čitelným písmem, „Nejčastěji vybíráte“ jako akcent v písmu značky
  assert.match(ESHOP_HTML, /\.katalog-nadpis\{font-family:var\(--font-text\)/);
  assert.match(ESHOP_HTML, /\.katalog-uvod h3\{font-family:var\(--font-brand\)/);
  const duvera = ESHOP_HTML.indexOf('<p class="duvera">Platba převodem nebo na prodejně · Vrácení do 14 dnů · Poradíme na 773 517 733</p>');
  assert.ok(duvera > 0 && duvera < ESHOP_HTML.indexOf('id="submitBtn"') && duvera > ESHOP_HTML.indexOf('id="chSouhlas"'));
});
