// Každý vložený <script> v HTML stránkách musí jít zkompilovat. Jediná syntaktická
// chyba (např. dvakrát deklarovaná konstanta) jinak shodí celý skript stránky.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const soubor of ['admin.html', 'eshop.html', 'index.html', 'stromecek/index.html']) {
  test(`${soubor}: všechny vložené skripty jsou syntakticky v pořádku`, () => {
    // Chybějící </script> slije dva skripty do jednoho a prohlížeč nespustí ani jeden
    // (stromeček do 24. 11. 2026: nefungovalo kopírování kódu) - kompilace níž to odhalí,
    // protože druhé <script> je pak uvnitř kódu.
    const html = fs.readFileSync(path.join(__dirname, '..', soubor), 'utf8');
    const bloky = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
    // strukturovaná data pro vyhledávače (JSON-LD) nejsou JavaScript - musí to být platný JSON
    bloky.filter(m => /application\/ld\+json/.test(m[1]))
      .forEach(m => assert.doesNotThrow(() => JSON.parse(m[2]), `JSON-LD v ${soubor}`));
    const skripty = bloky.filter(m => !/type=/.test(m[1]) || /type="(text\/javascript|module)"/.test(m[1])).map(m => m[2]);
    assert.ok(skripty.length > 0);
    skripty.forEach((kod, i) => {
      assert.doesNotThrow(() => new Function(kod), `skript č. ${i + 1} v ${soubor}`);
    });
  });
}
