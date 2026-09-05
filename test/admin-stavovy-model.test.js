// Rozhodnutí "STAVY OBJEDNÁVEK" - admin.html musí po změně stavu kontrolovat
// response.ok a nesmí používat legacy hodnoty (odeslano/doruceno/zruseno)
// místo kanonických (odeslana/dorucena/zrusena). Statická kontrola zdroje,
// protože admin.html běží v prohlížeči a netestujeme ho přes DOM/jsdom.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

test('zmenitStav() kontroluje res.ok a nepředstírá úspěch při chybě', () => {
  const shoda = ADMIN_HTML.match(/async function zmenitStav\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(shoda, 'funkce zmenitStav nebyla nalezena');
  const telo = shoda[0];
  assert.match(telo, /res\.ok/, 'musí kontrolovat res.ok');
  assert.match(telo, /alert\(/, 'při chybě musí zobrazit chybu, ne mlčet');
});

test('admin.html už nepoužívá legacy hodnoty stavu objednávky (odeslano/doruceno/zruseno)', () => {
  assert.equal(/[^-]\bodeslano\b/.test(ADMIN_HTML), false, 'legacy "odeslano" by nemělo zůstat jako hodnota stavu (jen CSS třída badge-odeslano je OK)');
  assert.equal(/[^-]\bdoruceno\b/.test(ADMIN_HTML), false, 'legacy "doruceno" by nemělo zůstat jako hodnota stavu (jen CSS třída badge-doruceno je OK)');
  assert.equal(ADMIN_HTML.includes("'zruseno'"), false, 'legacy "zruseno" by se už nemělo posílat');
});

test('select pro stav objednávky nabízí přesně kanonické hodnoty', () => {
  const canonical = ['nova', 'vyrizuje', 'zaplacena', 'odeslana', 'dorucena', 'zrusena'];
  for (const stav of canonical) {
    assert.match(ADMIN_HTML, new RegExp(`value="${stav}"`), `chybí <option value="${stav}">`);
  }
});
