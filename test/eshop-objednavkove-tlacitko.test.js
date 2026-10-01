// § 1826a odst. 2 obč. zák. - finální tlačítko objednávky musí jednoznačně
// říkat, že objednávka zavazuje k platbě (jinak je smlouva neplatná, ledaže se
// jí spotřebitel dovolá). Statická kontrola eshop.html - stejný přístup jako
// test/eshop-xss.test.js (čte skutečný zdroják, nic nekopíruje).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ESHOP_HTML = fs.readFileSync(path.join(__dirname, '..', 'eshop.html'), 'utf8');
const TEXT = 'Objednávka zavazující k platbě';

function vytahnoutFunkci(nazev) {
  const start = ESHOP_HTML.indexOf(`async function ${nazev}(`);
  assert.ok(start !== -1, `Funkce ${nazev} nebyla v eshop.html nalezena`);
  const zavorkaStart = ESHOP_HTML.indexOf('{', start);
  let hloubka = 0;
  for (let i = zavorkaStart; i < ESHOP_HTML.length; i++) {
    if (ESHOP_HTML[i] === '{') hloubka++;
    else if (ESHOP_HTML[i] === '}' && --hloubka === 0) return ESHOP_HTML.slice(start, i + 1);
  }
  assert.fail(`Nepodařilo se najít konec funkce ${nazev}`);
}

test('finální tlačítko objednávky má text podle § 1826a a stále volá odeslatObjednavku()', () => {
  const tlacitka = ESHOP_HTML.match(/<button[^>]*id="submitBtn"[^>]*>[^<]*<\/button>/g) || [];
  assert.equal(tlacitka.length, 1, 'v eshop.html má být právě jedno #submitBtn');
  assert.match(tlacitka[0], /onclick="odeslatObjednavku\(\)"/);
  assert.match(tlacitka[0], new RegExp(`>${TEXT}</button>$`));
});

test('JS po chybě/úspěchu vrací tlačítku stejný text a starý text se nikde nevrací', () => {
  const funkce = vytahnoutFunkci('odeslatObjednavku');
  const obnoveni = funkce.match(/btn\.textContent = '[^']*';/g).filter(s => !/Odesílám|Hotovo/.test(s));
  assert.equal(obnoveni.length, 3);
  obnoveni.forEach(s => assert.equal(s, `btn.textContent = '${TEXT}';`));
  assert.equal(ESHOP_HTML.includes('Odeslat objednávku'), false);
});

test('objednávka se dál odesílá stejným endpointem POST /objednavky', () => {
  const funkce = vytahnoutFunkci('odeslatObjednavku');
  assert.match(funkce, /fetch\(API \+ '\/objednavky', \{\s*method: 'POST'/);
});
