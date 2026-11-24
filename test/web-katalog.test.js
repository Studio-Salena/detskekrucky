// SEO krok 2: export katalogu (lib/katalogExport.js), generátor stránek (scripts/web/katalog.js)
// a jeho napojení na omezené sestavení webu (scripts/web/sestavit-web.js).
// Bez databáze a bez sítě ven: export se skládá z řádků jako z DB, API simuluje místní server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { sestavitExport } = require('../lib/katalogExport');
const katalog = require('../scripts/web/katalog');
const { main } = require('../scripts/web/sestavit-web');

// --- data jako z databáze ------------------------------------------------------------
function radkyDb() {
  return {
    kategorie: [
      { slug: 'celorocni-boticky', nazev: 'Celoroční botičky', popis: 'Na celý rok.', poradi: 1, obrazek_url: null },
      { slug: 'capacky', nazev: 'Capáčky', popis: '', poradi: 2, obrazek_url: null },
      { slug: 'prazdna', nazev: 'Prázdná', popis: '', poradi: 3, obrazek_url: null }
    ],
    modely: [
      { id: 1, slug: 'froddo-autumn', znacka: 'Froddo', nazev: 'Autumn Black', kategorie: 'celorocni-boticky', barefoot: true, sirka: ['normalni'], nart: [], zapinani: ['suchy_zip'], membrana: false, material: 'kuze', proc_jsme_vybrali: ['Ohebná podrážka'] },
      { id: 2, slug: 'beda-zuzi', znacka: 'Beda', nazev: 'Zuzi', kategorie: 'celorocni-boticky', barefoot: true, sirka: [], nart: [], zapinani: [], proc_jsme_vybrali: [] },
      { id: 3, slug: 'vyprodana-bota', znacka: 'Koel', nazev: 'Vyprodaná', kategorie: 'celorocni-boticky', sirka: [], nart: [], zapinani: [], proc_jsme_vybrali: [] },
      { id: 4, slug: 'capacky-mini', znacka: 'Mini', nazev: 'Capáčky <b>mini</b>', kategorie: 'capacky', sirka: [], nart: [], zapinani: [], proc_jsme_vybrali: [] },
      { id: 5, slug: 'stazena-bota', znacka: 'X', nazev: 'Stažená', kategorie: 'capacky', sirka: [], nart: [], zapinani: [], proc_jsme_vybrali: [] }
    ],
    // jen produkty na e-shopu (stažený model 5 tu nemá žádný řádek - tak ho export vrací)
    produkty: [
      { produkt_id: 10, model_id: 1, kategorie: 'celorocni-boticky', cena: 1490, cena_puvodni: null, popis: 'Celoroční bota.', velikost: 24, pocet_kusu: 2, dostupnost: 'skladem' },
      { produkt_id: 11, model_id: 1, kategorie: 'celorocni-boticky', cena: 1590, cena_puvodni: null, popis: '', velikost: 30, pocet_kusu: 0, dostupnost: 'skladem' },
      { produkt_id: 12, model_id: 1, kategorie: 'celorocni-boticky', cena: 1590, cena_puvodni: null, popis: '', velikost: 29, pocet_kusu: 0, dostupnost: 'dodavatel' },
      { produkt_id: 20, model_id: 2, kategorie: 'celorocni-boticky', cena: 990, cena_puvodni: 1290, popis: '', velikost: 25, pocet_kusu: 0, dostupnost: 'dodavatel' },
      { produkt_id: 30, model_id: 3, kategorie: 'celorocni-boticky', cena: 1190, cena_puvodni: null, popis: '', velikost: 26, pocet_kusu: 0, dostupnost: 'skladem' },
      { produkt_id: 40, model_id: 4, kategorie: 'capacky', cena: 590, cena_puvodni: null, popis: '', velikost: 12, pocet_kusu: 1, dostupnost: 'skladem' }
    ],
    fotky: [
      { id: 1, produkt_id: 10, url: 'https://res.cloudinary.com/x/image/upload/a.jpg', alt: 'Froddo', is_primary: true, position: 0 },
      { id: 2, produkt_id: 11, url: 'https://res.cloudinary.com/x/image/upload/b.jpg', alt: '', is_primary: false, position: 1 }
    ],
    presmerovani: [
      { stary_slug: 'froddo-autumn-stary', novy_slug: 'froddo-autumn' },
      { stary_slug: 'na-stazeny', novy_slug: 'stazena-bota' } // cíl není na e-shopu -> vynechat
    ]
  };
}
const exportZ = (upravit = d => d) => ({ ...sestavitExport(upravit(radkyDb())), vygenerovano: '2026-11-24T12:00:00.000Z' });
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const uklid = d => fs.rmSync(d, { recursive: true, force: true });
const precist = (d, s) => fs.readFileSync(path.join(d, s), 'utf8');
const jsonLd = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));

// --- export: pravidla jako e-shop ---------------------------------------------------
test('export: dostupnost a cena přesně podle e-shopu', () => {
  const d = exportZ();
  const froddo = d.modely.find(m => m.slug === 'froddo-autumn');
  assert.deepEqual(froddo.velikosti.map(v => [v.velikost, v.stav]), [[24, 'skladem'], [29, 'dodavatel'], [30, 'vyprodano']]);
  assert.equal(froddo.dostupnost, 'skladem');
  assert.equal(froddo.cena, 1490);
  assert.equal(froddo.cena_od, true); // 1490 a 1590 v nabídce
  assert.equal(froddo.popis, 'Celoroční bota.');
  assert.equal(froddo.fotky[0].alt, 'Froddo'); // hlavní fotka první
  const zuzi = d.modely.find(m => m.slug === 'beda-zuzi');
  assert.equal(zuzi.dostupnost, 'dodavatel');
  assert.equal(zuzi.cena_puvodni, 1290);
  assert.equal(d.modely.find(m => m.slug === 'vyprodana-bota').dostupnost, 'vyprodano');
});

test('export: stažený model (bez produktu na e-shopu) chybí, přesměrování jen na model v nabídce', () => {
  const d = exportZ();
  assert.ok(!d.modely.some(m => m.slug === 'stazena-bota'));
  assert.deepEqual(d.presmerovani, [{ stary_slug: 'froddo-autumn-stary', novy_slug: 'froddo-autumn' }]);
});

test('export: neven žádné počty kusů ani interní údaje', () => {
  const text = JSON.stringify(exportZ());
  assert.doesNotMatch(text, /pocet_kusu|produkt_id|"klic"|obrazek_key|"ean"/);
});

test('export: adresa, kterou nejde bezpečně publikovat, se vynechá', () => {
  const d = exportZ(r => { r.modely[1].slug = '../zle'; return r; });
  assert.ok(!d.modely.some(m => m.slug === '../zle'));
});

// --- stránky ---------------------------------------------------------------------------
function vygenerovat(data, moznosti = {}) {
  const vystup = tmp('dk-katalog-');
  const vysledek = katalog.generovat(data, vystup, { statickySitemap: fs.readFileSync(path.join(__dirname, '..', 'sitemap.xml'), 'utf8'), ...moznosti });
  return { vystup, vysledek };
}

test('produkt skladem: text, nákup a strukturovaná data říkají totéž (InStock, AggregateOffer)', () => {
  const { vystup } = vygenerovat(exportZ());
  try {
    const html = precist(vystup, 'produkt/froddo-autumn/index.html');
    assert.match(html, /<h1>Autumn Black<\/h1>/);
    assert.match(html, /data-cena>od 1 490 Kč</);
    assert.match(html, /data-dostupnost>Skladem</);
    assert.match(html, /href="\/eshop\.html\?produkt=froddo-autumn">Vybrat velikost a koupit/);
    assert.match(html, /<div data-nakup>/); // nákup viditelný
    assert.match(html, /<li class="vyprodano"[^>]*>30</);
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.detskekrucky\.cz\/produkt\/froddo-autumn\/">/);
    const [produkt, drobecky] = jsonLd(html);
    assert.equal(produkt['@type'], 'Product');
    assert.equal(produkt.offers['@type'], 'AggregateOffer');
    assert.equal(produkt.offers.lowPrice, 1490);
    assert.equal(produkt.offers.highPrice, 1590);
    assert.equal(produkt.offers.availability, 'https://schema.org/InStock');
    assert.equal(produkt.brand.name, 'Froddo');
    assert.deepEqual(drobecky.itemListElement.map(i => i.name), ['Úvod', 'E-shop', 'Celoroční botičky', 'Froddo Autumn Black']);
  } finally { uklid(vystup); }
});

test('produkt jen u dodavatele: BackOrder, text s dodací lhůtou, nákup povolený', () => {
  const { vystup } = vygenerovat(exportZ());
  try {
    const html = precist(vystup, 'produkt/beda-zuzi/index.html');
    assert.match(html, /U dodavatele – odešleme do 7–14 dnů/);
    assert.match(html, /<div data-nakup>/);
    const [produkt] = jsonLd(html);
    assert.equal(produkt.offers['@type'], 'Offer');
    assert.equal(produkt.offers.price, 990);
    assert.equal(produkt.offers.availability, 'https://schema.org/BackOrder');
    assert.match(html, /<s class="puvodni" data-puvodni>1 290 Kč<\/s>/);
  } finally { uklid(vystup); }
});

test('vyprodaný produkt: stránka zůstává s pravdivým stavem, bez nákupu, s dotazem a kategorií (OutOfStock)', () => {
  const { vystup } = vygenerovat(exportZ());
  try {
    const html = precist(vystup, 'produkt/vyprodana-bota/index.html');
    assert.match(html, /data-dostupnost>Momentálně vyprodáno</);
    assert.match(html, /<div data-nakup hidden>/);
    assert.match(html, /<div data-dotaz>/);
    assert.match(html, /href="\/kategorie\/celorocni-boticky\/"/);
    assert.equal(jsonLd(html)[0].offers.availability, 'https://schema.org/OutOfStock');
  } finally { uklid(vystup); }
});

test('stažený nebo odstraněný produkt: stránka se nevygeneruje (adresa vrátí 404), sloučený přesměruje', () => {
  const { vystup } = vygenerovat(exportZ());
  try {
    assert.ok(!fs.existsSync(path.join(vystup, 'produkt/stazena-bota')));
    const stub = precist(vystup, 'produkt/froddo-autumn-stary/index.html');
    assert.match(stub, /<meta http-equiv="refresh" content="0; url=\/produkt\/froddo-autumn\/">/);
    assert.match(stub, /<link rel="canonical" href="https:\/\/www\.detskekrucky\.cz\/produkt\/froddo-autumn\/">/);
    assert.match(stub, /noindex/);
  } finally { uklid(vystup); }
});

test('escapování: HTML v názvu se nevykoná ani v textu, ani v JSON-LD', () => {
  const { vystup } = vygenerovat(exportZ(r => { r.modely[3].nazev = 'Mini </script><script>alert(1)</script>'; return r; }));
  try {
    const html = precist(vystup, 'produkt/capacky-mini/index.html');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;\/script&gt;/);
    assert.equal(jsonLd(html)[0].name, 'Mini Mini </script><script>alert(1)</script>');
  } finally { uklid(vystup); }
});

test('capáčky: velikost v měsících jako v e-shopu', () => {
  const { vystup } = vygenerovat(exportZ());
  try { assert.match(precist(vystup, 'produkt/capacky-mini/index.html'), /<li class="skladem"[^>]*>6–12 měsíců</); } finally { uklid(vystup); }
});

test('kategorie: modely v nabídce první, vyprodané na konci, prázdná kategorie bez indexování', () => {
  const { vystup } = vygenerovat(exportZ(), { indexovat: true });
  try {
    const html = precist(vystup, 'kategorie/celorocni-boticky/index.html');
    const poradi = [...html.matchAll(/href="\/produkt\/([a-z0-9-]+)\/"/g)].map(m => m[1]);
    assert.deepEqual(poradi, ['froddo-autumn', 'beda-zuzi', 'vyprodana-bota']);
    assert.match(html, /V nabídce máme 2 modely\./);
    assert.match(html, /href="\/eshop\.html\?kategorie=celorocni-boticky"/);
    assert.equal(jsonLd(html)[0].mainEntity.numberOfItems, 3);
    assert.match(precist(vystup, 'kategorie/prazdna/index.html'), /<meta name="robots" content="noindex">/);
  } finally { uklid(vystup); }
});

test('zkušební provoz (INDEXOVAT=false): stránky mají noindex a nejsou v sitemap', () => {
  assert.equal(katalog.INDEXOVAT, false);
  const { vystup } = vygenerovat(exportZ(), { indexovat: false });
  try {
    assert.match(precist(vystup, 'produkt/froddo-autumn/index.html'), /<meta name="robots" content="noindex">/);
    const sm = precist(vystup, 'sitemap.xml');
    assert.doesNotMatch(sm, /\/produkt\/|\/kategorie\//);
    assert.match(sm, /https:\/\/www\.detskekrucky\.cz\/eshop\.html/); // statické adresy zůstávají
  } finally { uklid(vystup); }
});

test('zapnuté indexování: sitemap obsahuje kategorie s obsahem a produkty, ne přesměrování ani prázdnou kategorii', () => {
  const { vystup } = vygenerovat(exportZ(), { indexovat: true });
  try {
    const sm = precist(vystup, 'sitemap.xml');
    assert.match(sm, /\/produkt\/froddo-autumn\//);
    assert.match(sm, /\/produkt\/vyprodana-bota\//);
    assert.match(sm, /\/kategorie\/celorocni-boticky\//);
    assert.doesNotMatch(sm, /froddo-autumn-stary|\/kategorie\/prazdna\//);
    assert.doesNotMatch(precist(vystup, 'produkt/froddo-autumn/index.html'), /noindex/);
  } finally { uklid(vystup); }
});

test('změna ceny a dostupnosti v adminu: stránka, JSON-LD i lastmod se změní, ostatní stránky ne', () => {
  const prvni = vygenerovat(exportZ(), { indexovat: true, predchozi: null });
  const predchozi = { verze_formatu: 1, pocty: prvni.vysledek.pocty, stranky: Object.fromEntries(Object.entries(prvni.vysledek.stranky).map(([k, v]) => [k, { ...v, lastmod: '2026-11-01' }])) };
  const druhy = vygenerovat(exportZ(r => {
    r.produkty.find(p => p.produkt_id === 10).cena = 1390;             // zlevnění
    Object.assign(r.produkty.find(p => p.produkt_id === 40), { pocet_kusu: 0, dostupnost: 'dodavatel' }); // capáčky jen u dodavatele
    return r;
  }), { indexovat: true, predchozi });
  try {
    const froddo = precist(druhy.vystup, 'produkt/froddo-autumn/index.html');
    assert.match(froddo, /data-cena>od 1 390 Kč</);
    assert.equal(jsonLd(froddo)[0].offers.lowPrice, 1390);
    const capacky = precist(druhy.vystup, 'produkt/capacky-mini/index.html');
    assert.match(capacky, /U dodavatele – odešleme do 7–14 dnů/);
    assert.equal(jsonLd(capacky)[0].offers.availability, 'https://schema.org/BackOrder');
    const st = druhy.vysledek.stranky;
    assert.notEqual(st['/produkt/froddo-autumn/'].lastmod, '2026-11-01');
    // stránka, které se změna netýká, si nechá původní datum (vyprodaná bota se změnila taky -
    // v „Mohlo by se vám líbit“ ukazuje zlevněný model)
    assert.equal(st['/kategorie/prazdna/'].lastmod, '2026-11-01');
    assert.notEqual(st['/produkt/vyprodana-bota/'].lastmod, '2026-11-01');
  } finally { uklid(prvni.vystup); uklid(druhy.vystup); }
});

test('vyprodání a stažení produktu mezi dvěma sestaveními', () => {
  const pred = exportZ();
  const po = exportZ(r => {
    r.produkty = r.produkty.filter(p => p.model_id !== 2);                          // Zuzi stažená z e-shopu
    Object.assign(r.produkty.find(p => p.produkt_id === 40), { pocet_kusu: 0 });   // capáčky vyprodané
    return r;
  });
  assert.ok(pred.modely.some(m => m.slug === 'beda-zuzi'));
  const { vystup } = vygenerovat(po);
  try {
    assert.ok(!fs.existsSync(path.join(vystup, 'produkt/beda-zuzi')));
    assert.match(precist(vystup, 'produkt/capacky-mini/index.html'), /Momentálně vyprodáno/);
    assert.doesNotMatch(precist(vystup, 'kategorie/celorocni-boticky/index.html'), /beda-zuzi/);
  } finally { uklid(vystup); }
});

test('živé dočtení: skript na stránce volá veřejný endpoint modelu a při 404 skryje nákup', () => {
  const { vystup } = vygenerovat(exportZ());
  try {
    const html = precist(vystup, 'produkt/froddo-autumn/index.html');
    assert.match(html, /"https:\/\/detskekrucky1\.onrender\.com\/api\/katalog\/model\/" \+ "froddo-autumn"/);
    assert.match(html, /r\.status === 404/);
    assert.match(html, /nakup\.hidden = true/);
  } finally { uklid(vystup); }
});

// --- kontrola exportu ----------------------------------------------------------------
test('kontrola exportu: pokles, neúplný export, neznámá verze, duplicitní adresa', () => {
  const d = exportZ();
  assert.deepEqual(katalog.overitExport(d, null, { minModelu: 1 }).chyby, []);
  assert.match(katalog.overitExport(d, null, { minModelu: 50 }).chyby.join(), /Jen 3 modelů v nabídce/);
  const predchozi = { verze_formatu: 1, pocty: { modely_v_nabidce: 10, kategorie: 3 } };
  assert.match(katalog.overitExport(d, predchozi, { minModelu: 1 }).chyby.join(), /ubylo z 10 na 3/);
  assert.deepEqual(katalog.overitExport(d, predchozi, { minModelu: 1, povolitPokles: true }).chyby, []);
  assert.match(katalog.overitExport({ ...d, verze_formatu: 2 }, null, { minModelu: 1 }).chyby.join(), /Neznámá verze/);
  assert.match(katalog.overitExport({ ...d, modely: [...d.modely, d.modely[0]] }, null, { minModelu: 1 }).chyby.join(), /dvakrát/);
  assert.match(katalog.overitExport({ ...d, modely: [{ ...d.modely[0], slug: 'Zle Slug' }] }, null, { minModelu: 1 }).chyby.join(), /neplatná adresa/);
  assert.match(katalog.overitExport({ ...d, kategorie: [] }, null, { minModelu: 1 }).chyby.join(), /žádnou kategorii/);
});

// --- celé sestavení: úspěch a selhání ---------------------------------------------------
function api(obsluha) {
  return new Promise(r => { const s = http.createServer(obsluha).listen(0, '127.0.0.1', () => r(s)); });
}
async function sestavitS(argv, env = {}) {
  const obal = tmp('dk-sestaveni-');
  const vystup = path.join(obal, '_site');
  const githubOutput = path.join(obal, 'output.txt');
  fs.writeFileSync(githubOutput, '');
  const chyby = [];
  const kod = await main([vystup, ...argv], { log: () => {}, chyba: t => chyby.push(t), env: { GITHUB_OUTPUT: githubOutput, ...env }, nacitani: { pokusy: 2, prodleva: 10, casovyLimit: 800 } });
  return { kod, vystup, obal, chyby: chyby.join('\n'), output: fs.readFileSync(githubOutput, 'utf8') };
}

test('sestavení s katalogem: stránky projdou omezeným seznamem i kontrolou odkazů a nasadí se', async () => {
  const obal = tmp('dk-export-');
  const soubor = path.join(obal, 'export.json');
  fs.writeFileSync(soubor, JSON.stringify(exportZ()));
  const r = await sestavitS(['--katalog', soubor, '--min-modelu', '1']);
  try {
    assert.equal(r.kod, 0, r.chyby);
    assert.equal(r.output, 'nasadit=true\n');
    assert.ok(fs.existsSync(path.join(r.vystup, 'produkt/froddo-autumn/index.html')));
    assert.ok(fs.existsSync(path.join(r.vystup, 'kategorie/capacky/index.html')));
    const manifest = JSON.parse(precist(r.vystup, 'katalog-verze.json'));
    assert.equal(manifest.pocty.modely_v_nabidce, 3);
    assert.match(manifest.otisk, /^[0-9a-f]{64}$/);
    assert.ok(!fs.existsSync(path.join(r.vystup, 'lib')));
  } finally { uklid(obal); uklid(r.obal); }
});

test('hodinový běh beze změny obsahu nenasazuje, po změně ceny nasadí', async () => {
  const obal = tmp('dk-export-');
  const soubor = path.join(obal, 'export.json');
  fs.writeFileSync(soubor, JSON.stringify(exportZ()));
  const prvni = await sestavitS(['--katalog', soubor, '--min-modelu', '1']);
  const manifest = path.join(obal, 'minule.json');
  fs.copyFileSync(path.join(prvni.vystup, 'katalog-verze.json'), manifest);
  const stejny = await sestavitS(['--katalog', soubor, '--min-modelu', '1', '--predchozi', manifest], { JEN_PRI_ZMENE: 'true' });
  fs.writeFileSync(soubor, JSON.stringify(exportZ(r => { r.produkty[0].cena = 1390; return r; })));
  const zmena = await sestavitS(['--katalog', soubor, '--min-modelu', '1', '--predchozi', manifest], { JEN_PRI_ZMENE: 'true' });
  try {
    assert.equal(stejny.kod, 0, stejny.chyby);
    assert.equal(stejny.output, 'nasadit=false\n');
    assert.equal(zmena.kod, 0, zmena.chyby);
    assert.equal(zmena.output, 'nasadit=true\n');
  } finally { [obal, prvni.obal, stejny.obal, zmena.obal].forEach(uklid); }
});

test('selhání API (HTTP 500, vypršení času, neplatný JSON, 404): sestavení skončí chybou a nic se nenasadí', async () => {
  const pripady = {
    '/500': (req, res) => { res.writeHead(500); res.end('{"chyba":"x"}'); },
    '/cas': () => { /* nikdy neodpoví */ },
    '/json': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('<html>Render se probouzí</html>'); },
    '/nic': (req, res) => { res.writeHead(404); res.end(); }
  };
  const server = await api((req, res) => (pripady[req.url] || pripady['/nic'])(req, res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [cesta, popis] of [['/500', 'HTTP 500'], ['/cas', 'vypršel čas'], ['/json', 'platný JSON'], ['/nic', 'HTTP 404']]) {
      const r = await sestavitS(['--katalog', base + cesta, '--min-modelu', '1']);
      try {
        assert.equal(r.kod, 1, cesta);
        assert.match(r.chyby, new RegExp(popis), cesta);
        assert.match(r.chyby, /na webu zůstává poslední nasazená verze/);
        assert.equal(r.output, '', `${cesta}: nesmí zapsat nasadit`);
      } finally { uklid(r.obal); }
    }
  } finally { server.closeAllConnections(); server.close(); }
});

test('neúspěšná kontrola (prázdný export, velký pokles, nebezpečná adresa): nic se nenasadí', async () => {
  const obal = tmp('dk-export-');
  const soubor = path.join(obal, 'export.json');
  const minule = path.join(obal, 'minule.json');
  fs.writeFileSync(minule, JSON.stringify({ verze_formatu: 1, otisk: 'x', pocty: { modely_v_nabidce: 100, kategorie: 3 }, stranky: {} }));
  try {
    fs.writeFileSync(soubor, JSON.stringify({ ...exportZ(), modely: [] }));
    let r = await sestavitS(['--katalog', soubor]);
    assert.equal(r.kod, 1); assert.match(r.chyby, /Jen 0 modelů v nabídce/); assert.equal(r.output, ''); uklid(r.obal);

    fs.writeFileSync(soubor, JSON.stringify(exportZ()));
    r = await sestavitS(['--katalog', soubor, '--min-modelu', '1', '--predchozi', minule]);
    assert.equal(r.kod, 1); assert.match(r.chyby, /ubylo ze? 100 na 3/); assert.equal(r.output, ''); uklid(r.obal);
    // ruční povolení velkého poklesu
    r = await sestavitS(['--katalog', soubor, '--min-modelu', '1', '--predchozi', minule], { POVOLIT_POKLES: 'true' });
    assert.equal(r.kod, 0, r.chyby); uklid(r.obal);

    const d = exportZ(); d.modely[0].slug = '../../lib';
    fs.writeFileSync(soubor, JSON.stringify(d));
    r = await sestavitS(['--katalog', soubor, '--min-modelu', '1']);
    assert.equal(r.kod, 1); assert.match(r.chyby, /neplatná adresa/); uklid(r.obal);
  } finally { uklid(obal); }
});

test('workflow: hodinový plán, nasazení jen při změně, katalog z veřejného API bez tajných údajů', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'static.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(wf, /schedule:\n\s+- cron: '23 \* \* \* \*'/);
  assert.match(wf, /--katalog https:\/\/detskekrucky1\.onrender\.com\/api\/katalog\/export/);
  assert.match(wf, /--predchozi https:\/\/www\.detskekrucky\.cz\/katalog-verze\.json/);
  assert.match(wf, /JEN_PRI_ZMENE: \$\{\{ github\.event_name == 'schedule' \}\}/);
  for (const krok of ['Setup Pages', 'Upload artifact', 'Deploy to GitHub Pages']) {
    assert.match(wf, new RegExp(`- name: ${krok}\\n\\s+if: steps\\.sestaveni\\.outputs\\.nasadit == 'true'`), krok);
  }
  assert.doesNotMatch(wf, /secrets\./);
  assert.match(wf, /permissions:\n\s+contents: read\n\s+pages: write\n\s+id-token: write/); // bez zápisu do repozitáře
});

test('workflow: opakování nasazení jen když první pokus nasazení nevytvořil, nejvýš jednou, jinak viditelná chyba', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'static.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(wf, /id: deployment\n(\s+#.*\n)*\s+continue-on-error: true\n\s+uses: actions\/deploy-pages@v5/);
  assert.match(wf, /- name: Check failed deploy before retry\n(\s+#.*\n)*\s+if: steps\.sestaveni\.outputs\.nasadit == 'true' && steps\.deployment\.outcome == 'failure'\n\s+id: po_chybe\n\s+env:\n\s+PAGE_URL: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  // opakování jen s výstupem kontroly, bez continue-on-error: když selže i podruhé, běh skončí chybou
  assert.match(wf, /- name: Deploy to GitHub Pages \(retry\)\n(\s+#.*\n)*\s+if: steps\.po_chybe\.outputs\.opakovat == 'true'\n\s+id: deployment_opakovani\n\s+uses: actions\/deploy-pages@v5\s*$/);
  assert.equal((wf.match(/uses: actions\/deploy-pages@v5/g) || []).length, 2, 'nejvýš jeden další pokus');
  assert.equal((wf.match(/continue-on-error: true/g) || []).length, 1, 'chybu smí potlačit jen první pokus');
  assert.match(wf, /url: \$\{\{ steps\.deployment\.outputs\.page_url \|\| steps\.deployment_opakovani\.outputs\.page_url \}\}/);
});

test('workflow: kontrola po chybě – s page_url (nasazení vzniklo) běh selže bez opakování, bez page_url počká a povolí jeden pokus', () => {
  const { spawnSync } = require('node:child_process');
  const bash = spawnSync('bash', ['--version']);
  if (bash.error || bash.status !== 0) return; // bez bash (jen Windows bez Git Bash) se přeskočí
  const y = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'static.yml'), 'utf8').replace(/\r\n/g, '\n');
  const m = y.match(/id: po_chybe\n[\s\S]*?run: \|\n((?: {10}.*\n)+)/);
  assert.ok(m, 'skript kontroly nenalezen');
  const skript = m[1].split('\n').map(r => r.slice(10)).join('\n').replace('sleep 30', 'sleep 0');
  const obal = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-po-chybe-'));
  try {
    const spustit = pageUrl => {
      const out = path.join(obal, 'out-' + (pageUrl ? 'url' : 'bez'));
      fs.writeFileSync(out, '');
      const r = spawnSync('bash', ['-c', skript], { env: { ...process.env, PAGE_URL: pageUrl, GITHUB_OUTPUT: out }, encoding: 'utf8' });
      return { kod: r.status, vystup: r.stdout + r.stderr, output: fs.readFileSync(out, 'utf8') };
    };
    const vzniklo = spustit('https://www.detskekrucky.cz/');
    assert.equal(vzniklo.kod, 1);
    assert.match(vzniklo.vystup, /::error::Nasazení bylo vytvořeno a selhalo/);
    assert.equal(vzniklo.output, '');
    const nevzniklo = spustit('');
    assert.equal(nevzniklo.kod, 0, nevzniklo.vystup);
    assert.equal(nevzniklo.output, 'opakovat=true\n');
  } finally { fs.rmSync(obal, { recursive: true, force: true }); }
});
