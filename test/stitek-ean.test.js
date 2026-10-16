// Štítek s EAN pro tiskárnu Fichero (2026-10): volba typu čárového kódu podle
// EAN ve skladu. Funkce se vytahuje ze skutečného admin.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function vytahnout(nazev) {
  const start = ADMIN_HTML.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, `Funkce ${nazev} nebyla v admin.html nalezena`);
  let hloubka = 0;
  for (let i = ADMIN_HTML.indexOf(') {', start) + 2; i < ADMIN_HTML.length; i++) {
    if (ADMIN_HTML[i] === '{') hloubka++;
    else if (ADMIN_HTML[i] === '}' && --hloubka === 0) return ADMIN_HTML.slice(start, i + 1);
  }
  throw new Error(`Konec funkce ${nazev} nenalezen`);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(vytahnout('formatCaroveKodu'), sandbox);
const format = kod => vm.runInContext(`formatCaroveKodu(${JSON.stringify(kod)})`, sandbox);

test('platný EAN-13 a EAN-8 se tisknou jako EAN', () => {
  assert.equal(format('4006381333931'), 'EAN13');
  assert.equal(format(' 4006381333931 '), 'EAN13', 'mezery okolo nevadí');
  assert.equal(format('96385074'), 'EAN8');
});

test('EAN se špatnou kontrolní číslicí nebo jiný kód jde jako Code 128 (čte se přesně uložený text)', () => {
  assert.equal(format('4006381333932'), 'CODE128', 'špatná kontrolní číslice');
  assert.equal(format('400638133393'), 'CODE128', '12 číslic by EAN-13 doplnil o číslici navíc');
  assert.equal(format('96385075'), 'CODE128');
  assert.equal(format('DK-123'), 'CODE128');
});

test('prázdný, příliš dlouhý nebo s diakritikou: štítek nejde', () => {
  for (const k of ['', '   ', null, 'x'.repeat(21), 'Žluťoučký']) assert.equal(format(k), null, String(k));
});
