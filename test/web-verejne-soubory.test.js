// SEO krok 2.0: na GitHub Pages jde jen výslovně povolený obsah (scripts/web/).
// Testy sestaví balíček do dočasné složky a ověří, že kontroly opravdu zastaví
// sestavení při chybějícím souboru, zakázaném obsahu, tajném údaji a rozbitém odkazu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sestavit, zkontrolovat, pripravitVystup, prevestOdkaz } = require('../scripts/web/sestavit-web');
const { SOUBORY } = require('../scripts/web/verejne-soubory');

const KOREN = path.join(__dirname, '..');

function sestavitDoTmp() {
  const vystup = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-web-'));
  const chyby = sestavit({ vystup });
  return { vystup, chyby };
}
const uklid = d => fs.rmSync(d, { recursive: true, force: true });
const zapsat = (vystup, soubor, text) => {
  fs.mkdirSync(path.dirname(path.join(vystup, soubor)), { recursive: true });
  fs.writeFileSync(path.join(vystup, soubor), text);
};

test('balíček obsahuje přesně povolené soubory a všechny kontroly projdou', () => {
  const { vystup, chyby } = sestavitDoTmp();
  try {
    assert.deepEqual(chyby, []);
    const vysledek = zkontrolovat(vystup);
    assert.deepEqual(vysledek.chyby, []);
    assert.deepEqual(vysledek.soubory, [...SOUBORY].sort());
    assert.ok(vysledek.pocetOdkazu > 100, 'kontrola odkazů opravdu něco prošla');
  } finally { uklid(vystup); }
});

test('v balíčku není serverový kód, testy, dokumentace, zálohy ani pracovní soubory', () => {
  const { vystup } = sestavitDoTmp();
  try {
    const soubory = zkontrolovat(vystup).soubory;
    for (const s of soubory) {
      assert.doesNotMatch(s, /^(lib|routes|db|middleware|scripts|test|test-helpers|prohlizec-testy|docs|deploy|node_modules|\.github)\//, s);
      assert.doesNotMatch(s, /(^|\/)\./, s);
      assert.doesNotMatch(s, /\.(md|pem|p12|pfx|sh|dump|sql|env)$/, s);
    }
    for (const s of ['index.js', 'package.json', 'package-lock.json', 'CLAUDE.md', 'detské krucky', '.gitignore', '.gitattributes']) {
      assert.ok(!soubory.includes(s), `${s} nesmí být na webu`);
    }
    // stránky, které web, e-shop a administrace potřebují
    for (const s of ['index.html', 'eshop.html', 'admin.html', 'mobilni-sken.html', 'stromecek/index.html', 'CNAME', 'robots.txt', 'sitemap.xml', 'navstevnost.js', 'fonts/DejaVuSans-bold.js']) {
      assert.ok(soubory.includes(s), `${s} musí být na webu`);
    }
  } finally { uklid(vystup); }
});

test('chybějící potřebný soubor zastaví sestavení', () => {
  const { vystup } = sestavitDoTmp();
  try {
    fs.rmSync(path.join(vystup, 'logo.jpg'));
    const { chyby } = zkontrolovat(vystup);
    assert.ok(chyby.some(c => c.includes('chybí potřebný soubor: logo.jpg')), chyby.join('\n'));
    // logo používají stránky i e-maily - kontrola odkazů to hlásí taky
    assert.ok(chyby.some(c => c.includes('Odkaz na chybějící soubor logo.jpg')), chyby.join('\n'));
  } finally { uklid(vystup); }
});

test('soubor v seznamu, který v repozitáři není, zastaví sestavení', () => {
  const kopie = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-repo-'));
  const vystup = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-web-'));
  try {
    for (const s of SOUBORY.filter(x => x !== 'robots.txt')) {
      fs.mkdirSync(path.dirname(path.join(kopie, s)), { recursive: true });
      fs.copyFileSync(path.join(KOREN, s), path.join(kopie, s));
    }
    const chyby = sestavit({ koren: kopie, vystup });
    assert.ok(chyby.some(c => c.includes('Chybí povolený soubor robots.txt')), chyby.join('\n'));
  } finally { uklid(kopie); uklid(vystup); }
});

test('zakázaný obsah v balíčku zastaví sestavení (serverový kód, .env, dokumentace, certifikát)', () => {
  const { vystup } = sestavitDoTmp();
  try {
    zapsat(vystup, 'lib/evidencePlateb.js', '// server');
    zapsat(vystup, '.env', 'X=1');
    zapsat(vystup, 'CLAUDE.md', '# poznámky');
    zapsat(vystup, 'stromecek/klic.pem', 'x');
    zapsat(vystup, 'deploy/zalohy/zaloha.sh', '#!/bin/bash');
    const { chyby } = zkontrolovat(vystup);
    for (const s of ['lib/evidencePlateb.js', '.env', 'CLAUDE.md', 'stromecek/klic.pem', 'deploy/zalohy/zaloha.sh']) {
      assert.ok(chyby.some(c => c.includes(`mimo seznam: ${s}`)), `${s}: ${chyby.join('\n')}`);
      assert.ok(chyby.some(c => c.includes(`Zakázaný obsah v balíčku: ${s}`)), `${s}: ${chyby.join('\n')}`);
    }
  } finally { uklid(vystup); }
});

test('tajný údaj v publikovaném souboru zastaví sestavení', () => {
  const pripady = [
    ['-----BEGIN PRIVATE KEY-----\nMIIE', 'soukromý klíč'],
    ['const db = "postgres://uzivatel:tajneheslo@194.0.0.1:5432/dk";', 'přístup k databázi s heslem'],
    ['DATABASE_URL=postgres://x', 'nastavení proměnné s tajným údajem']
  ];
  for (const [obsah, duvod] of pripady) {
    const { vystup } = sestavitDoTmp();
    try {
      fs.appendFileSync(path.join(vystup, 'navstevnost.js'), `\n${obsah}\n`);
      const { chyby } = zkontrolovat(vystup);
      assert.ok(chyby.some(c => c.includes('navstevnost.js') && c.includes(duvod)), `${duvod}: ${chyby.join('\n')}`);
    } finally { uklid(vystup); }
  }
});

test('odkaz na chybějící místní soubor zastaví sestavení', () => {
  const { vystup } = sestavitDoTmp();
  try {
    fs.appendFileSync(path.join(vystup, '404.html'), '<img src="/chybejici-obrazek.png"><a href="neni.html">x</a>');
    const { chyby } = zkontrolovat(vystup);
    assert.ok(chyby.some(c => c.includes('chybejici-obrazek.png')), chyby.join('\n'));
    assert.ok(chyby.some(c => c.includes('neni.html')), chyby.join('\n'));
  } finally { uklid(vystup); }
});

test('převod odkazů: místní, adresa webu, cizí weby a šablony', () => {
  assert.deepEqual(prevestOdkaz('/logo.jpg', 'index.html'), { cesta: 'logo.jpg' });
  assert.deepEqual(prevestOdkaz('../logo.jpg', 'stromecek/index.html'), { cesta: 'logo.jpg' });
  assert.deepEqual(prevestOdkaz('eshop.html?produkt=x#detail', 'index.html'), { cesta: 'eshop.html' });
  assert.deepEqual(prevestOdkaz('https://www.detskekrucky.cz/', ''), { cesta: 'index.html' });
  assert.deepEqual(prevestOdkaz('https://www.detskekrucky.cz/obchodni-podminky.html', ''), { cesta: 'obchodni-podminky.html' });
  assert.equal(prevestOdkaz('https://detskekrucky1.onrender.com/api/sklad', 'eshop.html'), null);
  assert.equal(prevestOdkaz('mailto:info@example.cz', 'index.html'), null);
  assert.equal(prevestOdkaz('${escAttr(url)}', 'eshop.html'), null);
  assert.equal(prevestOdkaz('#prodejna', 'index.html'), null);
  // ../ nad kořen webu prohlížeč vyřeší jako kořen - pak se kontroluje jako běžný chybějící soubor
  assert.deepEqual(prevestOdkaz('../../tajne.txt', 'stromecek/index.html'), { cesta: 'tajne.txt' });
});

test('výstup nesmí být repozitář ani adresář nad ním; cizí existující adresář se nesmaže bez --prepsat', () => {
  assert.throws(() => pripravitVystup(KOREN, { prepsat: true }), /repozitář/);
  assert.throws(() => pripravitVystup(path.dirname(KOREN), { prepsat: true }), /repozitář/);
  const cizi = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-cizi-'));
  try {
    fs.writeFileSync(path.join(cizi, 'dulezite.txt'), 'nemazat');
    assert.throws(() => pripravitVystup(cizi, { prepsat: false }), /už existuje/);
    assert.ok(fs.existsSync(path.join(cizi, 'dulezite.txt')));
  } finally { uklid(cizi); }
});

test('workflow Pages publikuje jen sestavený _site, ne celý repozitář, a nejdřív kontroluje', () => {
  const wf = fs.readFileSync(path.join(KOREN, '.github', 'workflows', 'static.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(wf, /node scripts\/web\/sestavit-web\.js _site/);
  assert.match(wf, /path: _site/);
  assert.doesNotMatch(wf, /path:\s*['"]?\.['"]?\s*$/m, 'nesmí nahrávat celý repozitář');
  // sestavení a kontrola musí běžet před nahráním balíčku
  assert.ok(wf.indexOf('sestavit-web.js') < wf.indexOf('upload-pages-artifact'));
  // workflow nesmí dostat tajné údaje
  assert.doesNotMatch(wf, /secrets\./);
});
