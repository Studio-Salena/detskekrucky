// E-shop je od 31. 10. 2026 spuštěný: žádný zámek ani noindex, tlačítko na webu
// vede do e-shopu, e-shop je v sitemap a stará stránka „E-shop brzy“ přesměruje.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cist = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ESHOP = cist('eshop.html');

test('spuštěno: eshop.html nemá zámek ani noindex', () => {
  assert.doesNotMatch(ESHOP, /eshop-brzy\.html/);
  assert.doesNotMatch(ESHOP, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(ESHOP, /eshopNahled/);
});

test('spuštěno: tlačítko Eshop na webu vede do e-shopu', () => {
  const index = cist('index.html');
  assert.match(index, /<a href="eshop\.html">🛒 Eshop<\/a>/);
  assert.doesNotMatch(index, /href="eshop-brzy\.html"/);
});

test('spuštěno: e-shop je v sitemap.xml', () => {
  assert.match(cist('sitemap.xml'), /<loc>https:\/\/www\.detskekrucky\.cz\/eshop\.html<\/loc>/);
});

test('spuštěno: stará adresa eshop-brzy.html přesměruje do e-shopu', () => {
  assert.match(cist('eshop-brzy.html'), /<meta http-equiv="refresh" content="0; url=eshop\.html">/);
});
