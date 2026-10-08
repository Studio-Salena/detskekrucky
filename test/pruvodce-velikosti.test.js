// Průvodce velikostí (2026-10): doporučení velikosti podle délky nožičky na
// stránce boty a filtr „Délka nožičky“ v katalogu. Funkce se vytahují ze
// skutečného eshop.html (stejný vzor jako test/eshop-katalog.test.js).
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
  for (let i = ESHOP_HTML.indexOf(') {', start) + 2; i < ESHOP_HTML.length; i++) {
    if (ESHOP_HTML[i] === '{') hloubka++;
    else if (ESHOP_HTML[i] === '}' && --hloubka === 0) return ESHOP_HTML.slice(start, i + 1);
  }
  throw new Error(`Konec funkce ${nazev} nenalezen`);
}
const konstanta = nazev => ESHOP_HTML.match(new RegExp(`const ${nazev} = [^;]+;`))[0];

const sandbox = { URLSearchParams };
vm.createContext(sandbox);
vm.runInContext([
  'const NOHA_MIN = 70, NOHA_MAX = 300, NOHA_ROZPETI = 10;',
  ...['KATALOG_SIRKA', 'KATALOG_ZAPINANI', 'KATALOG_RAZENI', 'KATALOG_PRO'].map(konstanta),
  'var nastaveniKatalogu = { rezervaMm: 12 };',
  ...['escHtml', 'rezervaPruvodce', 'platnaNoha', 'velikostSediNaNohu', 'doporucitVelikost', 'vysledekPruvodceHtml',
    'prazdnyStavKatalogu', 'bezDiakritiky', 'slugText', 'stavZUrl', 'urlZeStavu', 'hledaniOdpovida', 'jeSkladem', 'produktOdpovida'].map(vytahnout)
].join('\n'), sandbox);
const run = kod => { const v = vm.runInContext(kod, sandbox); return v !== null && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; };
const zavolat = (fn, ...args) => run(`${fn}(...${JSON.stringify(args)})`);

test('konstanty průvodce v e-shopu odpovídají testu', () => {
  assert.match(ESHOP_HTML, /const NOHA_MIN = 70, NOHA_MAX = 300, NOHA_ROZPETI = 10;/);
});

const VELIKOSTI = [
  { velikost: 23, delka_mm: 150, sirka_mm: 62, dostupnost: 'skladem' },
  { velikost: 24, delka_mm: 156, sirka_mm: 64, dostupnost: 'skladem' },
  { velikost: 25, delka_mm: null, dostupnost: 'skladem' },
  { velikost: 26, delka_mm: 170, sirka_mm: 67, dostupnost: 'dodavatel' }
];

test('doporučení: nejmenší velikost s rezervou aspoň 12 mm', () => {
  assert.deepEqual(zavolat('doporucitVelikost', VELIKOSTI, 140, null, 12),
    { typ: 'ok', velikost: 24, delka_mm: 156, sirka_mm: 64, rezerva: 16, velka: false, uzka: false, dodavatel: false });
  assert.equal(zavolat('doporucitVelikost', VELIKOSTI, 138, null, 12).velikost, 23, 'přesně 12 mm rezervy stačí');
  assert.equal(zavolat('doporucitVelikost', VELIKOSTI, 139, null, 12).velikost, 24);
  const d = zavolat('doporucitVelikost', VELIKOSTI, 150, 70, 12);
  assert.equal(d.velikost, 26, 'velikost bez rozměrů se přeskočí');
  assert.equal(d.dodavatel, true);
  assert.equal(d.uzka, true, 'vnitřní šířka 67 < nožička 70');
  assert.equal(zavolat('doporucitVelikost', VELIKOSTI, 100, null, 12).velka, true, 'rezerva 50 mm = bota vychází velká');
  assert.equal(zavolat('doporucitVelikost', VELIKOSTI, 140, null, 15).velikost, 24, 'jiná rezerva z nastavení');
});

test('doporučení: malé boty, bez rozměrů, neplatná délka', () => {
  assert.deepEqual(zavolat('doporucitVelikost', VELIKOSTI, 165, null, 12), { typ: 'mala', nejvetsi: 170 });
  assert.deepEqual(zavolat('doporucitVelikost', [{ velikost: 22, delka_mm: null }], 140, null, 12), { typ: 'bez-rozmeru' });
  for (const n of [null, 69, 301, 140.5]) assert.deepEqual(zavolat('doporucitVelikost', VELIKOSTI, n, null, 12), { typ: 'neplatne' }, String(n));
});

test('text doporučení: velikost, rezerva, upozornění; vše bez HTML z dat', () => {
  const ok = zavolat('vysledekPruvodceHtml', { typ: 'ok', velikost: '24<b>', delka_mm: 156, sirka_mm: 64, rezerva: 16, velka: false, uzka: true, dodavatel: true }, 140, 70, 12);
  assert.match(ok, /Doporučujeme velikost 24&lt;b&gt;/);
  assert.match(ok, /rezerva 16 mm/);
  assert.match(ok, /bota může být úzká/);
  assert.match(ok, /u dodavatele/);
  assert.match(zavolat('vysledekPruvodceHtml', { typ: 'mala', nejvetsi: 170 }, 165, null, 12), /všechny velikosti malé.*170 mm.*Poradíme vám/);
  assert.match(zavolat('vysledekPruvodceHtml', { typ: 'bez-rozmeru' }, 140, null, 12), /nemáme změřené.*Poradíme vám/);
});

test('rezerva z nastavení katalogu, při nesmyslu výchozích 12 mm', () => {
  assert.equal(run('rezervaPruvodce()'), 12);
  assert.equal(run('nastaveniKatalogu = { rezervaMm: 15 }; rezervaPruvodce()'), 15);
  assert.equal(run('nastaveniKatalogu = { rezervaMm: "x" }; rezervaPruvodce()'), 12);
  assert.equal(run('nastaveniKatalogu = {}; rezervaPruvodce()'), 12);
  run('nastaveniKatalogu = { rezervaMm: 12 }');
});

test('filtr Délka nožičky: adresa ?noha= a boty s rezervou 12–22 mm', () => {
  const stav = zavolat('stavZUrl', '?noha=140&velikost=24');
  assert.equal(stav.noha, 140);
  assert.equal(zavolat('urlZeStavu', stav), '?velikost=24&noha=140');
  assert.equal(zavolat('stavZUrl', '?noha=20').noha, null);
  assert.equal(zavolat('stavZUrl', '?noha=abc').noha, null);
  const ctx = { vekoveSkupiny: [], nazvyKategorii: {}, rezerva: 12 };
  const bota = d => ({ kategorie: 'x', znacka: 'Z', nazev: 'B', cena: 1000, velikosti: [{ velikost: 24, delka_mm: d, dostupnost: 'skladem' }] });
  const s = { ...zavolat('prazdnyStavKatalogu'), noha: 140 };
  const odpovida = d => zavolat('produktOdpovida', bota(d), s, ctx);
  assert.equal(odpovida(151), false, 'rezerva 11 mm je málo');
  assert.equal(odpovida(152), true);
  assert.equal(odpovida(162), true);
  assert.equal(odpovida(163), false, 'rezerva 23 mm je moc');
  assert.equal(odpovida(null), false, 'bez rozměrů se při filtru neukáže');
  assert.equal(zavolat('produktOdpovida', bota(null), { ...s, noha: null }, ctx), true, 'bez filtru se ukáže');
  // jen skladem: velikost u dodavatele nestačí
  const dodavatel = { ...bota(156), velikosti: [{ velikost: 24, delka_mm: 156, dostupnost: 'dodavatel' }] };
  assert.equal(zavolat('produktOdpovida', dodavatel, { ...s, skladem: true }, ctx), false);
});
