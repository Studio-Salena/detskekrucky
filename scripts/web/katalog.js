// SEO krok 2: samostatné stránky /kategorie/<slug>/ a /produkt/<slug>/ z veřejného
// exportu katalogu (GET /api/katalog/export). Volá ho scripts/web/sestavit-web.js.
//
// Bezpečnost sestavení: export se načte s opakováním, zkontroluje (tvar dat, pokles
// proti minulému nasazení) a teprve pak se generují stránky. Jakákoli chyba = sestavení
// skončí chybou a workflow nic nenasadí - na webu zůstane poslední funkční verze.
//
// Dostupnost a cena přesně podle e-shopu (lib/katalogExport.js). Stránka si navíc po
// načtení dočte aktuální stav (GET /api/katalog/model/<slug>) a ukáže ho. Závazná
// cena a dostupnost se vždy ověří na serveru při objednávce.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { VOLBY, KATEGORIE_BEZ_VLASTNOSTI } = require('../../lib/modely');
const { SLUG } = require('../../lib/katalogExport');

const WEB = 'https://www.detskekrucky.cz';
const API = 'https://detskekrucky1.onrender.com/api';
const VERZE_FORMATU = 1;
const KATEGORIE_V_MESICICH = ['capacky']; // stejně jako e-shop (KATALOG_MESICE)
const MAX_POKLES = 0.2; // modelů v nabídce smí ubýt nejvýš 20 % proti minulému nasazení
const MAX_UBYTEK_KATEGORII = 2;
// Zkušební provoz (docs/nasazeni-webu.md, krok 3): stránky mají noindex a nejsou v sitemap.
// Zapnutí pro vyhledávače = změna na true spolu s odkazy z webu a canonical v e-shopu.
const INDEXOVAT = false;

// ---------------------------------------------------------------- načtení

const cekat = ms => new Promise(r => setTimeout(r, ms));

async function nacistJson(zdroj, { casovyLimit = 60000 } = {}) {
  if (!/^https?:\/\//.test(zdroj)) return JSON.parse(fs.readFileSync(zdroj, 'utf8'));
  const ovladac = new AbortController();
  const casovac = setTimeout(() => ovladac.abort(), casovyLimit);
  try {
    const r = await fetch(zdroj, { signal: ovladac.signal, headers: { 'User-Agent': 'detskekrucky-sestaveni-webu' } });
    if (r.status === 404) return { nenalezeno: true };
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    try { return JSON.parse(text); } catch { throw new Error('odpověď není platný JSON'); }
  } finally {
    clearTimeout(casovac);
  }
}

// Render po nečinnosti spí - proto několik pokusů s rostoucí pauzou
async function nacistExport(zdroj, { pokusy = 5, prodleva = 5000, casovyLimit = 60000, log = console.log } = {}) {
  let posledni;
  for (let i = 1; i <= pokusy; i++) {
    try {
      const data = await nacistJson(zdroj, { casovyLimit });
      if (data && data.nenalezeno) throw new Error('HTTP 404');
      return data;
    } catch (e) {
      posledni = e;
      log(`  export katalogu: pokus ${i}/${pokusy} selhal (${e.name === 'AbortError' ? 'vypršel čas' : e.message})`);
      if (i < pokusy) await cekat(prodleva * i);
    }
  }
  throw new Error(`Export katalogu se nepodařilo načíst: ${posledni && (posledni.name === 'AbortError' ? 'vypršel čas' : posledni.message)}`);
}

// Manifest minulého nasazení (katalog-verze.json na webu). Nedostupný = první nasazení.
async function nacistPredchozi(zdroj) {
  if (!zdroj) return null;
  try {
    const m = await nacistJson(zdroj, { casovyLimit: 30000 });
    if (!m || m.nenalezeno || m.verze_formatu !== VERZE_FORMATU || !m.pocty) return null;
    return m;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- kontrola dat

function overitExport(data, predchozi, { minModelu = 50, povolitPokles = false } = {}) {
  const chyby = [];
  const varovani = [];
  if (!data || typeof data !== 'object') return { chyby: ['Export katalogu není objekt.'], varovani };
  if (data.verze_formatu !== VERZE_FORMATU) chyby.push(`Neznámá verze exportu: ${data.verze_formatu} (skript zná ${VERZE_FORMATU}).`);
  if (!Array.isArray(data.kategorie) || !Array.isArray(data.modely) || !Array.isArray(data.presmerovani)) {
    chyby.push('Export katalogu nemá seznamy kategorie / modely / presmerovani.');
    return { chyby, varovani };
  }
  const kategorie = new Set();
  for (const k of data.kategorie) {
    if (!SLUG.test(k.slug || '')) chyby.push(`Kategorie s neplatnou adresou: ${JSON.stringify(k.slug)}`);
    else if (kategorie.has(k.slug)) chyby.push(`Kategorie ${k.slug} je v exportu dvakrát.`);
    if (!k.nazev || typeof k.nazev !== 'string') chyby.push(`Kategorie ${k.slug} nemá název.`);
    kategorie.add(k.slug);
  }
  const slugy = new Set();
  for (const m of data.modely) {
    const kdo = `Model ${JSON.stringify(m.slug)}`;
    if (!SLUG.test(m.slug || '')) { chyby.push(`${kdo}: neplatná adresa.`); continue; }
    if (slugy.has(m.slug)) chyby.push(`${kdo} je v exportu dvakrát.`);
    slugy.add(m.slug);
    if (!m.nazev || typeof m.nazev !== 'string') chyby.push(`${kdo}: chybí název.`);
    if (!Array.isArray(m.velikosti) || !Array.isArray(m.fotky)) { chyby.push(`${kdo}: chybí velikosti nebo fotky.`); continue; }
    for (const v of m.velikosti) {
      if (!Number.isFinite(v.velikost) || !Number.isFinite(v.cena) || v.cena <= 0) chyby.push(`${kdo}: neplatná velikost nebo cena (${JSON.stringify(v)}).`);
      if (!['skladem', 'dodavatel', 'vyprodano'].includes(v.stav)) chyby.push(`${kdo}: neznámý stav velikosti ${JSON.stringify(v.stav)}.`);
    }
    if (!['skladem', 'dodavatel', 'vyprodano'].includes(m.dostupnost)) chyby.push(`${kdo}: neznámá dostupnost ${JSON.stringify(m.dostupnost)}.`);
    for (const f of m.fotky) if (!/^https:\/\//.test(f.url || '')) chyby.push(`${kdo}: fotka bez https adresy.`);
    if (m.kategorie && !kategorie.has(m.kategorie)) varovani.push(`${kdo}: kategorie ${m.kategorie} neexistuje, stránka bude bez kategorie.`);
  }
  for (const p of data.presmerovani) {
    if (!SLUG.test(p.stary_slug || '') || !slugy.has(p.novy_slug)) chyby.push(`Neplatné přesměrování ${JSON.stringify(p)}.`);
    if (slugy.has(p.stary_slug)) chyby.push(`Přesměrování ${p.stary_slug} koliduje s existujícím modelem.`);
  }

  const vNabidce = data.modely.filter(m => m.dostupnost !== 'vyprodano').length;
  if (vNabidce < minModelu) chyby.push(`Jen ${vNabidce} modelů v nabídce (minimum ${minModelu}) - export vypadá neúplně.`);
  if (predchozi) {
    const minule = Number(predchozi.pocty.modely_v_nabidce) || 0;
    if (minule && vNabidce < minule * (1 - MAX_POKLES)) {
      const zprava = `Modelů v nabídce ubylo z ${minule} na ${vNabidce} (víc než ${MAX_POKLES * 100} %).`;
      if (povolitPokles) varovani.push(zprava + ' Povoleno ručně.'); else chyby.push(zprava + ' Pokud je to záměr, spusťte workflow ručně s povolením velkého poklesu.');
    }
    const minuleKategorie = Number(predchozi.pocty.kategorie) || 0;
    if (minuleKategorie && data.kategorie.length < minuleKategorie - MAX_UBYTEK_KATEGORII) {
      const zprava = `Kategorií ubylo z ${minuleKategorie} na ${data.kategorie.length}.`;
      if (povolitPokles) varovani.push(zprava + ' Povoleno ručně.'); else chyby.push(zprava);
    }
  } else {
    varovani.push('Minulé nasazení katalogu nenalezeno - kontrola poklesu se přeskočila (první nasazení).');
  }
  if (!data.kategorie.length) chyby.push('Export nemá žádnou kategorii.');
  return { chyby, varovani };
}

// ---------------------------------------------------------------- pomocné

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// JSON do <script>: žádné "</script>" ani HTML komentáře z dat
const jsonDoSkriptu = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const cena = c => `${Number(c).toLocaleString('cs-CZ').replace(/\u00a0/g, ' ')} Kč`;
const plnyNazev = m => [m.znacka, m.nazev].filter(Boolean).join(' ');
const adresaProduktu = slug => `/produkt/${slug}/`;
const adresaKategorie = slug => `/kategorie/${slug}/`;

function textVelikosti(kategorie, v) {
  if (!KATEGORIE_V_MESICICH.includes(kategorie)) return String(v);
  const n = Number(v);
  return n > 0 && n % 6 === 0 ? `${n - 6}–${n} měsíců` : `${n} ${n >= 2 && n <= 4 ? 'měsíce' : n === 1 ? 'měsíc' : 'měsíců'}`;
}

const TEXT_DOSTUPNOSTI = {
  skladem: { text: 'Skladem', trida: 'skladem', schema: 'https://schema.org/InStock' },
  dodavatel: { text: 'U dodavatele – odešleme do 7–14 dnů', trida: 'dodavatel', schema: 'https://schema.org/BackOrder' },
  vyprodano: { text: 'Momentálně vyprodáno', trida: 'vyprodano', schema: 'https://schema.org/OutOfStock' }
};
const TEXT_VELIKOSTI = { skladem: 'skladem', dodavatel: 'u dodavatele (7–14 dnů)', vyprodano: 'vyprodáno' };

function cenaHtml(m) {
  if (m.cena == null) return '';
  const zaklad = `${m.cena_od ? 'od ' : ''}${cena(m.cena)}`;
  return `<span data-cena>${esc(zaklad)}</span>${m.cena_puvodni ? ` <s class="puvodni" data-puvodni>${esc(cena(m.cena_puvodni))}</s>` : ''}`;
}

function vlastnostiRadky(m) {
  const v = m.vlastnosti || {};
  const radky = [];
  const text = (pole, hodnota) => (VOLBY[pole] && VOLBY[pole][hodnota]) || hodnota;
  const seznam = (pole, hodnoty) => (hodnoty || []).map(h => text(pole, h)).join(', ');
  if (KATEGORIE_BEZ_VLASTNOSTI.includes(m.kategorie)) return radky;
  if (v.barefoot != null) radky.push(['Barefoot', v.barefoot ? 'ano' : 'ne']);
  if (v.sirka && v.sirka.length) radky.push(['Šířka nohy', seznam('sirka', v.sirka)]);
  if (v.nart && v.nart.length) radky.push(['Nárt', seznam('nart', v.nart)]);
  if (v.zapinani && v.zapinani.length) radky.push(['Zapínání', seznam('zapinani', v.zapinani)]);
  if (v.membrana != null) radky.push(['Membrána', v.membrana ? 'ano' : 'ne']);
  if (v.material) radky.push(['Materiál', text('material', v.material)]);
  if (v.opatek) radky.push(['Opatek', text('opatek', v.opatek)]);
  if (v.dominantni_palec) radky.push(['Dominantní palec', text('dominantni_palec', v.dominantni_palec)]);
  if (v.pohlavi) radky.push(['Pro koho', text('pohlavi', v.pohlavi)]);
  return radky;
}

function popisMeta(m, nazevKategorie) {
  if (m.popis) {
    const t = m.popis.replace(/\s+/g, ' ').trim();
    return t.length > 155 ? t.slice(0, 152).replace(/\s+\S*$/, '') + '…' : t;
  }
  const velikosti = m.velikosti.filter(v => v.stav !== 'vyprodano').map(v => v.velikost);
  const rozsah = velikosti.length ? ` Velikosti ${textVelikosti(m.kategorie, Math.min(...velikosti))}–${textVelikosti(m.kategorie, Math.max(...velikosti))}.` : '';
  const c = m.cena != null ? ` Cena ${m.cena_od ? 'od ' : ''}${cena(m.cena)}.` : '';
  return `${plnyNazev(m)}${nazevKategorie ? ` – ${nazevKategorie.toLowerCase()}` : ''} v e-shopu a prodejně Dětské krůčky v Hulíně.${rozsah}${c}`.slice(0, 160);
}

// ---------------------------------------------------------------- šablona stránky

const STYL = `:root{--cream:#E5DFD6;--brown:#AE6965;--brown-dark:#8a4a46;--tan-light:#d4c4b0;--sage-dark:#565c4c;--text:#3d2b1f;--text-light:#6b5548;--modra:#7d6650}
*{box-sizing:border-box}body{margin:0;background:#faf7f3;color:var(--text);font-family:'Nunito',system-ui,sans-serif;line-height:1.55}
a{color:var(--brown-dark)}img{max-width:100%;height:auto}
.hlavicka{background:#fff;border-bottom:1px solid var(--tan-light)}.hlavicka .obal{display:flex;align-items:center;gap:16px;justify-content:space-between}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text);font-family:'Dancing Script',cursive;font-size:1.6rem;font-weight:700}.logo img{width:44px;height:44px;border-radius:50%}
.menu{display:flex;gap:14px;align-items:center;font-weight:700}.menu a{text-decoration:none;color:var(--text)}.kosik{background:var(--brown);color:#fff!important;padding:6px 14px;border-radius:20px}
.obal{max-width:1100px;margin:0 auto;padding:14px 18px}
.drobecky{font-size:.9rem;color:var(--text-light);margin:6px 0 14px}.drobecky a{color:var(--text-light)}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 8px}
.produkt{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:28px}@media(max-width:760px){.produkt{grid-template-columns:1fr}.menu .skryt-mobil{display:none}}
.galerie{display:flex;flex-direction:column;gap:10px}.galerie .hlavni{background:#fff;border:1px solid var(--tan-light);border-radius:18px;aspect-ratio:4/3;object-fit:contain;width:100%}
.nahledy{display:flex;gap:8px;overflow-x:auto}.nahledy img{width:84px;height:64px;object-fit:contain;background:#fff;border:1px solid var(--tan-light);border-radius:10px}
.znacka{text-transform:uppercase;letter-spacing:.06em;font-size:.85rem;color:var(--text-light);font-weight:700}
.cena{font-size:1.6rem;font-weight:800;margin:6px 0}.cena .puvodni{font-size:1.1rem;color:var(--text-light);font-weight:400}
.dostupnost{font-weight:700;margin:4px 0 12px}.dostupnost.skladem{color:var(--sage-dark)}.dostupnost.dodavatel{color:var(--modra)}.dostupnost.vyprodano{color:var(--brown-dark)}
.velikosti{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 16px;padding:0;list-style:none}.velikosti li{border:1px solid var(--tan-light);background:#fff;border-radius:10px;padding:4px 10px;font-weight:700}
.velikosti li.dodavatel{border-style:dashed}.velikosti li.vyprodano{color:#aaa;text-decoration:line-through;background:#f3efea}
.tlacitko{display:inline-block;background:var(--brown);color:#fff;text-decoration:none;font-weight:800;padding:13px 26px;border-radius:26px}.tlacitko:hover{background:var(--brown-dark)}
.tlacitko.vedlejsi{background:#fff;color:var(--brown-dark);border:2px solid var(--brown)}
.poznamka{font-size:.88rem;color:var(--text-light);margin-top:10px}
dl.vlastnosti{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:18px 0}dl.vlastnosti dt{color:var(--text-light)}dl.vlastnosti dd{margin:0;font-weight:700}
.oddil{margin-top:28px}.oddil h2{font-family:'Dancing Script',cursive;font-size:1.7rem;margin:0 0 8px;color:var(--brown-dark)}
.mrizka{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}@media(min-width:760px){.mrizka{grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}}
.karta{background:#fff;border:1px solid var(--tan-light);border-radius:18px;padding:12px;text-decoration:none;color:var(--text);display:flex;flex-direction:column;gap:4px}
.karta img{aspect-ratio:4/3;object-fit:contain;width:100%}.karta .nazev{font-weight:800}.karta .stav{font-size:.85rem;font-weight:700}
.karta .stav.skladem{color:var(--sage-dark)}.karta .stav.dodavatel{color:var(--modra)}.karta .stav.vyprodano{color:var(--brown-dark)}
.upozorneni{background:#fff4e5;border:1px solid #f0c890;border-radius:12px;padding:10px 14px;margin:10px 0}
.paticka{margin-top:40px;background:#3d2b1f;color:#e9e1d7;font-size:.9rem}.paticka a{color:#fff}`;

function stranka({ titulek, popis, adresa, indexovat, obsah, jsonLd, obrazek, extraSkript = '', dkStranka }) {
  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titulek)}</title>
<meta name="description" content="${escAttr(popis)}">
${indexovat ? '' : '<meta name="robots" content="noindex">\n'}<link rel="canonical" href="${escAttr(WEB + adresa)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="cs_CZ">
<meta property="og:site_name" content="Dětské krůčky">
<meta property="og:title" content="${escAttr(titulek)}">
<meta property="og:description" content="${escAttr(popis)}">
<meta property="og:url" content="${escAttr(WEB + adresa)}">
${obrazek ? `<meta property="og:image" content="${escAttr(obrazek)}">\n` : ''}<meta name="dk-stranka" content="${escAttr(dkStranka)}">
<link rel="icon" href="/logo.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet">
<style>${STYL}</style>
${jsonLd.map(j => `<script type="application/ld+json">${jsonDoSkriptu(j)}</script>`).join('\n')}
</head>
<body>
<header class="hlavicka"><div class="obal">
  <a class="logo" href="/"><img src="/logo.jpg" alt="" width="44" height="44">Dětské krůčky</a>
  <nav class="menu" aria-label="Hlavní menu">
    <a href="/eshop.html">E-shop</a>
    <a class="skryt-mobil" href="/#prodejna">Prodejna v Hulíně</a>
    <a class="kosik" href="/eshop.html" aria-label="Košík">Košík <span data-kosik-pocet>0</span></a>
  </nav>
</div></header>
<main class="obal">
${obsah}
</main>
<footer class="paticka"><div class="obal">
  <p><strong>Dětské krůčky</strong> – barefoot obuv pro děti, Holešovská 752, 768 24 Hulín · <a href="tel:773517733">773 517 733</a> · <a href="mailto:info@detskekrucky.cz">info@detskekrucky.cz</a> · <a href="/#prodejna">Otevírací doba</a></p>
  <p><a href="/obchodni-podminky.html">Obchodní podmínky</a> · <a href="/reklamacni-rad.html">Reklamační řád</a> · <a href="/odstoupeni-od-smlouvy.html">Odstoupení od smlouvy</a></p>
  <p>© 2026 Dětské krůčky – Monika Škarpichová | IČO: 24354635 | Vytvořilo <a href="https://www.studiosalena.cz" target="_blank" rel="noopener">studio Salena</a></p>
</div></footer>
<script>
// Počet kusů v košíku (košík je společný s e-shopem, tady se jen čte)
try { var k = JSON.parse(localStorage.getItem('kosik') || '[]'); document.querySelector('[data-kosik-pocet]').textContent = k.reduce(function (s, i) { return s + (Number(i.pocet) || 0); }, 0); } catch (e) {}
</script>
${extraSkript}<script src="/navstevnost.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- produkt

function schemaProduktu(m, nazevKategorie) {
  const d = TEXT_DOSTUPNOSTI[m.dostupnost];
  const nabidka = m.velikosti.filter(v => v.stav !== 'vyprodano');
  const produkt = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: plnyNazev(m), url: WEB + adresaProduktu(m.slug),
    ...(m.znacka ? { brand: { '@type': 'Brand', name: m.znacka } } : {}),
    ...(m.fotky.length ? { image: m.fotky.slice(0, 6).map(f => f.url) } : {}),
    ...(m.popis ? { description: m.popis.slice(0, 5000) } : {}),
    ...(nazevKategorie ? { category: nazevKategorie } : {})
  };
  if (m.cena != null) {
    const prodejce = { '@type': 'Organization', name: 'Dětské krůčky', url: WEB + '/' };
    produkt.offers = m.cena_od
      ? { '@type': 'AggregateOffer', priceCurrency: 'CZK', lowPrice: m.cena, highPrice: m.cena_do, offerCount: nabidka.length || m.velikosti.length, availability: d.schema, url: WEB + adresaProduktu(m.slug), seller: prodejce }
      : { '@type': 'Offer', priceCurrency: 'CZK', price: m.cena, availability: d.schema, itemCondition: 'https://schema.org/NewCondition', url: WEB + adresaProduktu(m.slug), seller: prodejce };
  }
  return produkt;
}

function drobeckySchema(polozky) {
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: polozky.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.text, item: WEB + p.adresa })) };
}
function drobeckyHtml(polozky) {
  return `<nav class="drobecky" aria-label="Drobečková navigace">${polozky.map((p, i) => i === polozky.length - 1 ? `<span aria-current="page">${esc(p.text)}</span>` : `<a href="${escAttr(p.adresa)}">${esc(p.text)}</a>`).join(' › ')}</nav>`;
}

function kartaHtml(m) {
  const d = TEXT_DOSTUPNOSTI[m.dostupnost];
  const foto = m.fotky[0];
  return `<a class="karta" href="${escAttr(adresaProduktu(m.slug))}">
  ${foto ? `<img src="${escAttr(foto.nahled)}" alt="${escAttr(foto.alt || plnyNazev(m))}" loading="lazy" width="400" height="300">` : ''}
  <span class="znacka">${esc(m.znacka)}</span><span class="nazev">${esc(m.nazev)}</span>
  ${m.cena != null ? `<span>${esc((m.cena_od ? 'od ' : '') + cena(m.cena))}</span>` : ''}
  <span class="stav ${d.trida}">${esc(m.dostupnost === 'dodavatel' ? 'U dodavatele (7–14 dnů)' : d.text)}</span>
</a>`;
}

// Dočtení aktuálního stavu po načtení stránky (bez API zůstane vygenerovaný obsah)
function skriptDocteni(slug, kategorie) {
  return `<script>
(function () {
  var MESICE = ${jsonDoSkriptu(KATEGORIE_V_MESICICH.includes(kategorie))};
  var TEXT = ${jsonDoSkriptu(Object.fromEntries(Object.entries(TEXT_DOSTUPNOSTI).map(([k, v]) => [k, v.text])))};
  var VEL = ${jsonDoSkriptu(TEXT_VELIKOSTI)};
  function kc(c) { return Number(c).toLocaleString('cs-CZ').replace(/\\u00a0/g, ' ') + ' Kč'; }
  function velText(v) { if (!MESICE) return String(v); var n = Number(v); return n > 0 && n % 6 === 0 ? (n - 6) + '–' + n + ' měsíců' : n + ' ' + (n >= 2 && n <= 4 ? 'měsíce' : n === 1 ? 'měsíc' : 'měsíců'); }
  fetch(${jsonDoSkriptu(API + '/katalog/model/')} + ${jsonDoSkriptu(slug)}, { credentials: 'omit' }).then(function (r) {
    // Stažený model = 404 s JSON odpovědí endpointu; jiná 404 (např. starší backend bez
    // endpointu vrátí HTML) nic nemění a zůstane vygenerovaný obsah
    if (r.status === 404) return r.json().then(function (d) { return { pryc: !!(d && d.chyba) }; }, function () { return {}; });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function (d) {
    var nakup = document.querySelector('[data-nakup]');
    if (d.pryc) {
      document.querySelector('[data-stav-modelu]').innerHTML = '<div class="upozorneni">Tento model už v e-shopu nenabízíme. <a href="/eshop.html">Prohlédnout ostatní botičky</a></div>';
      if (nakup) nakup.hidden = true;
      return;
    }
    var m = d.model; if (!m) return;
    var c = document.querySelector('[data-cena]');
    if (c && m.cena != null) c.textContent = (m.cena_od ? 'od ' : '') + kc(m.cena);
    var p = document.querySelector('[data-puvodni]');
    if (p) { if (m.cena_puvodni) p.textContent = kc(m.cena_puvodni); else p.remove(); }
    var dost = document.querySelector('[data-dostupnost]');
    if (dost) { dost.textContent = TEXT[m.dostupnost]; dost.className = 'dostupnost ' + m.dostupnost; }
    var ul = document.querySelector('[data-velikosti]');
    if (ul) {
      ul.innerHTML = '';
      m.velikosti.forEach(function (v) { var li = document.createElement('li'); li.className = v.stav; li.textContent = velText(v.velikost); li.title = VEL[v.stav]; ul.appendChild(li); });
    }
    var vyprodano = m.dostupnost === 'vyprodano';
    if (nakup) nakup.hidden = vyprodano;
    var dotaz = document.querySelector('[data-dotaz]');
    if (dotaz) dotaz.hidden = !vyprodano;
  }).catch(function () {});
})();
</script>
`;
}

function strankaProduktu(m, ctx) {
  const kat = ctx.kategorie.get(m.kategorie);
  const d = TEXT_DOSTUPNOSTI[m.dostupnost];
  const vyprodano = m.dostupnost === 'vyprodano';
  const drobecky = [{ text: 'Úvod', adresa: '/' }, { text: 'E-shop', adresa: '/eshop.html' }, ...(kat ? [{ text: kat.nazev, adresa: adresaKategorie(kat.slug) }] : []), { text: plnyNazev(m), adresa: adresaProduktu(m.slug) }];
  const vlastnosti = vlastnostiRadky(m);
  const podobne = ctx.modely.filter(x => x.kategorie === m.kategorie && x.slug !== m.slug && x.dostupnost !== 'vyprodano').slice(0, 4);
  const hlavni = m.fotky[0];
  const obsah = `${drobeckyHtml(drobecky)}
<article class="produkt">
  <div class="galerie">
    ${hlavni ? `<img class="hlavni" src="${escAttr(hlavni.url)}" alt="${escAttr(hlavni.alt || plnyNazev(m))}" width="1000" height="750" fetchpriority="high">` : ''}
    ${m.fotky.length > 1 ? `<div class="nahledy">${m.fotky.slice(1, 9).map(f => `<a href="${escAttr(f.url)}"><img src="${escAttr(f.nahled)}" alt="${escAttr(f.alt || plnyNazev(m))}" loading="lazy" width="84" height="64"></a>`).join('')}</div>` : ''}
  </div>
  <div>
    ${m.znacka ? `<div class="znacka">${esc(m.znacka)}</div>` : ''}
    <h1>${esc(m.nazev)}</h1>
    <div class="cena">${cenaHtml(m)}</div>
    <div data-stav-modelu><div class="dostupnost ${d.trida}" data-dostupnost>${esc(d.text)}</div></div>
    ${m.velikosti.length ? `<div>Velikosti:</div><ul class="velikosti" data-velikosti>${m.velikosti.map(v => `<li class="${v.stav}" title="${escAttr(TEXT_VELIKOSTI[v.stav])}">${esc(textVelikosti(m.kategorie, v.velikost))}</li>`).join('')}</ul>` : ''}
    <div data-nakup${vyprodano ? ' hidden' : ''}><a class="tlacitko" href="/eshop.html?produkt=${encodeURIComponent(m.slug)}">Vybrat velikost a koupit</a>
      <p class="poznamka">Aktuální cenu a dostupnost ověříme při odeslání objednávky. S velikostí rádi poradíme na <a href="tel:773517733">773 517 733</a>.</p></div>
    <div data-dotaz${vyprodano ? '' : ' hidden'}><p>Tuhle botičku teď nemáme. Zeptejte se, kdy bude znovu, nebo vyberte z podobných.</p>
      <a class="tlacitko vedlejsi" href="mailto:info@detskekrucky.cz?subject=${encodeURIComponent('Dotaz: ' + plnyNazev(m))}">Zeptat se e-mailem</a>${kat ? ` <a class="tlacitko vedlejsi" href="${escAttr(adresaKategorie(kat.slug))}">${esc(kat.nazev)}</a>` : ''}</div>
    ${vlastnosti.length ? `<dl class="vlastnosti">${vlastnosti.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
  </div>
</article>
${m.proc_jsme_vybrali.length ? `<section class="oddil"><h2>Proč jsme ji vybrali</h2><ul>${m.proc_jsme_vybrali.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}
${m.popis ? `<section class="oddil"><h2>Popis</h2>${m.popis.split(/\n{2,}/).map(o => `<p>${esc(o).replace(/\n/g, '<br>')}</p>`).join('')}</section>` : ''}
${podobne.length ? `<section class="oddil"><h2>Mohlo by se vám líbit</h2><div class="mrizka">${podobne.map(kartaHtml).join('')}</div></section>` : ''}`;
  return stranka({
    titulek: `${plnyNazev(m)}${kat ? ` – ${kat.nazev}` : ''} | Dětské krůčky`,
    popis: popisMeta(m, kat && kat.nazev),
    adresa: adresaProduktu(m.slug),
    indexovat: ctx.indexovat,
    obrazek: hlavni && hlavni.url,
    obsah,
    jsonLd: [schemaProduktu(m, kat && kat.nazev), drobeckySchema(drobecky)],
    extraSkript: skriptDocteni(m.slug, m.kategorie),
    dkStranka: '/produkt/'
  });
}

// ---------------------------------------------------------------- kategorie

function strankaKategorie(k, ctx) {
  const modely = ctx.modely.filter(m => m.kategorie === k.slug);
  const poradi = { skladem: 0, dodavatel: 1, vyprodano: 2 };
  modely.sort((a, b) => poradi[a.dostupnost] - poradi[b.dostupnost] || plnyNazev(a).localeCompare(plnyNazev(b), 'cs'));
  const vNabidce = modely.filter(m => m.dostupnost !== 'vyprodano').length;
  const drobecky = [{ text: 'Úvod', adresa: '/' }, { text: 'E-shop', adresa: '/eshop.html' }, { text: k.nazev, adresa: adresaKategorie(k.slug) }];
  const obsah = `${drobeckyHtml(drobecky)}
<h1>${esc(k.nazev)}</h1>
${k.popis ? `<p>${esc(k.popis)}</p>` : ''}
<p>${vNabidce ? `V nabídce máme ${vNabidce} ${vNabidce === 1 ? 'model' : vNabidce < 5 ? 'modely' : 'modelů'}.` : 'Momentálně tu nic nemáme skladem.'} <a href="/eshop.html?kategorie=${encodeURIComponent(k.slug)}">Vybrat podle velikosti v e-shopu</a></p>
${modely.length ? `<div class="mrizka">${modely.map(kartaHtml).join('')}</div>` : '<p><a class="tlacitko" href="/eshop.html">Prohlédnout celý e-shop</a></p>'}`;
  const schema = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: k.nazev, url: WEB + adresaKategorie(k.slug), ...(k.popis ? { description: k.popis } : {}),
      mainEntity: { '@type': 'ItemList', numberOfItems: modely.length, itemListElement: modely.map((m, i) => ({ '@type': 'ListItem', position: i + 1, url: WEB + adresaProduktu(m.slug), name: plnyNazev(m) })) } },
    drobeckySchema(drobecky)
  ];
  return {
    html: stranka({
      titulek: `${k.nazev} – dětská barefoot obuv | Dětské krůčky`,
      popis: (k.popis || `${k.nazev} pro děti v e-shopu a prodejně Dětské krůčky v Hulíně. Poradíme s velikostí podle délky nožičky.`).slice(0, 160),
      adresa: adresaKategorie(k.slug),
      indexovat: ctx.indexovat && modely.length > 0, // prázdná kategorie se neindexuje
      obrazek: k.obrazek,
      obsah,
      jsonLd: schema,
      dkStranka: '/kategorie/'
    }),
    indexovat: modely.length > 0
  };
}

function strankaPresmerovani(stary, novy) {
  const cil = adresaProduktu(novy);
  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="robots" content="noindex">
<title>Přesměrování – Dětské krůčky</title>
<link rel="canonical" href="${escAttr(WEB + cil)}">
<meta http-equiv="refresh" content="0; url=${escAttr(cil)}">
</head>
<body>
<p>Tahle botička má novou adresu: <a href="${escAttr(cil)}">${escAttr(WEB + cil)}</a></p>
<script>location.replace(${jsonDoSkriptu(cil)} + location.hash);</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- sitemap a manifest

const otisk = text => crypto.createHash('sha256').update(text).digest('hex');
const dnesPraha = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date());

function sitemap(statickyXml, generovane) {
  const staticke = (statickyXml.match(/<url>[\s\S]*?<\/url>/g) || []).map(u => '  ' + u.trim());
  const nove = generovane.map(g => `  <url>\n    <loc>${esc(WEB + g.adresa)}</loc>\n${g.lastmod ? `    <lastmod>${g.lastmod}</lastmod>\n` : ''}    <changefreq>${g.changefreq}</changefreq>\n    <priority>${g.priority}</priority>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...staticke, ...nove].join('\n')}\n</urlset>\n`;
}

/**
 * Vygeneruje stránky do výstupu. Vrátí seznam souborů a podklady pro manifest.
 */
function generovat(data, vystup, { indexovat = false, predchozi = null, statickySitemap = '' } = {}) {
  const ctx = {
    indexovat,
    kategorie: new Map(data.kategorie.map(k => [k.slug, k])),
    modely: data.modely
  };
  const zapsat = (rel, text) => {
    const cil = path.join(vystup, rel);
    fs.mkdirSync(path.dirname(cil), { recursive: true });
    fs.writeFileSync(cil, text);
  };
  const stranky = {};
  const proSitemap = [];
  const dnes = dnesPraha();
  const zaznam = (adresa, html, doSitemap, changefreq, priority) => {
    const o = otisk(html);
    const minule = predchozi && predchozi.stranky && predchozi.stranky[adresa];
    // lastmod = den poslední změny obsahu; bez minulého manifestu se nevymýšlí
    const lastmod = minule && minule.otisk === o ? minule.lastmod : (predchozi ? dnes : null);
    stranky[adresa] = { otisk: o, lastmod };
    if (doSitemap) proSitemap.push({ adresa, lastmod, changefreq, priority });
  };

  for (const k of data.kategorie) {
    const { html, indexovat: maObsah } = strankaKategorie(k, ctx);
    zapsat(`kategorie/${k.slug}/index.html`, html);
    zaznam(adresaKategorie(k.slug), html, indexovat && maObsah, 'daily', '0.8');
  }
  for (const m of data.modely) {
    const html = strankaProduktu(m, ctx);
    zapsat(`produkt/${m.slug}/index.html`, html);
    zaznam(adresaProduktu(m.slug), html, indexovat, 'weekly', m.dostupnost === 'vyprodano' ? '0.4' : '0.7');
  }
  for (const p of data.presmerovani) zapsat(`produkt/${p.stary_slug}/index.html`, strankaPresmerovani(p.stary_slug, p.novy_slug));
  zapsat('sitemap.xml', sitemap(statickySitemap, proSitemap));

  return {
    stranky,
    pocty: {
      kategorie: data.kategorie.length,
      modely: data.modely.length,
      modely_v_nabidce: data.modely.filter(m => m.dostupnost !== 'vyprodano').length,
      vyprodane: data.modely.filter(m => m.dostupnost === 'vyprodano').length,
      presmerovani: data.presmerovani.length
    }
  };
}

module.exports = {
  VERZE_FORMATU, WEB, INDEXOVAT, nacistExport, nacistPredchozi, overitExport, generovat,
  strankaProduktu, strankaKategorie, schemaProduktu, textVelikosti, TEXT_DOSTUPNOSTI, esc, jsonDoSkriptu
};
