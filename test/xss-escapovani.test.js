// P0.2 - regresní test proti stored XSS v admin.html. Nekopíruje escH/escAttr/escJs
// do testu (to by mohlo časem zdrift ovat od skutečné implementace) - vytáhne
// jejich skutečný zdrojový kód přímo z admin.html a spustí ho ve vm sandboxu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function vytahnoutFunkci(nazev) {
  const re = new RegExp(`function ${nazev}\\([^)]*\\)\\s*\\{[^}]*\\}`);
  const shoda = ADMIN_HTML.match(re);
  assert.ok(shoda, `Funkce ${nazev} nebyla v admin.html nalezena`);
  return shoda[0];
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(vytahnoutFunkci('escH'), sandbox);
vm.runInContext(vytahnoutFunkci('escAttr'), sandbox);
vm.runInContext(vytahnoutFunkci('escJs'), sandbox);

const PAYLOAD = '<img src=x onerror=alert(1)>';

test('escH() převede XSS payload na neškodný text (žádné < nebo >)', () => {
  const vysledek = vm.runInContext(`escH(${JSON.stringify(PAYLOAD)})`, sandbox);
  assert.equal(vysledek.includes('<'), false, 'výstup nesmí obsahovat syrové <');
  assert.equal(vysledek.includes('>'), false, 'výstup nesmí obsahovat syrové >');
  assert.equal(vysledek, '&lt;img src=x onerror=alert(1)&gt;');
});

test('escAttr() navíc escapuje uvozovky (ochrana proti úniku z HTML atributu)', () => {
  const payloadAtribut = `x" onmouseover="alert(1)`;
  const vysledek = vm.runInContext(`escAttr(${JSON.stringify(payloadAtribut)})`, sandbox);
  assert.equal(vysledek.includes('"'), false, 'výstup nesmí obsahovat syrovou uvozovku');
});

test('escJs() escapuje uvozovku a zpětné lomítko (ochrana proti úniku z JS řetězce)', () => {
  const payloadJs = `'; alert(1); //`;
  const vysledek = vm.runInContext(`escJs(${JSON.stringify(payloadJs)})`, sandbox);
  // Uvozovka smí zůstat, jen musí být vždy predchazena zpětným lomítkem (escapovaná) -
  // jinak by se dala vyjít z '${...}' řetězce ven a spustit libovolný JS.
  assert.equal(/(?<!\\)'/.test(vysledek), false, 'výstup nesmí obsahovat neescapovanou uvozovku');
  // Simulace skutečného použití: '${escJs(hodnota)}' - výsledný JS řetězec musí
  // po parsování dát zpátky přesně původní payload, ne o kus kratší/vykonaný kód.
  const zabaleny = `'${vysledek}'`;
  assert.equal(vm.runInContext(zabaleny, sandbox), payloadJs);
});

test('data z objednávky (poznámka) se v admin.html renderují přes escH', () => {
  // Sanity check, že klíčová místa (viz commit) opravdu volají escH/escAttr na
  // zákaznických polích - kdyby někdo escH omylem smazal, tenhle test spadne.
  assert.match(ADMIN_HTML, /data\.poznamka\s*\?\s*`<div class="info-box"[^`]*escH\(data\.poznamka\)/);
  assert.match(ADMIN_HTML, /escH\(z\.duvod\)/); // vratky-zadosti
  assert.match(ADMIN_HTML, /escH\(z\.vzkaz\)/); // poukazy-zadosti
});
