// Pruh z adminu: [text](adresa) jako odkaz - stejná funkce na webu i v e-shopu,
// nebezpečné adresy (javascript:, http:, //cizi…) zůstanou textem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function vytahnout(html, nazev) {
  const start = html.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, `Funkce ${nazev} nenalezena`);
  let hloubka = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') hloubka++;
    else if (html[i] === '}' && --hloubka === 0) return html.slice(start, i + 1);
  }
  throw new Error(`Konec funkce ${nazev} nenalezen`);
}

for (const soubor of ['index.html', 'eshop.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', soubor), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(vytahnout(html, 'castiPruhu'), sandbox);
  const casti = (t) => JSON.parse(JSON.stringify(sandbox.castiPruhu(t)));

  test(`${soubor}: odkaz v pruhu`, () => {
    assert.deepEqual(casti('✨ Navštivte náš eshop [ZDE](eshop.html)🦔'), [
      { text: '✨ Navštivte náš eshop ' }, { text: 'ZDE', odkaz: 'eshop.html' }, { text: '🦔' }
    ]);
    assert.deepEqual(casti('bez odkazu'), [{ text: 'bez odkazu' }]);
    assert.deepEqual(casti('[web](https://www.detskekrucky.cz/eshop.html) a [volejte](tel:+420123)'), [
      { text: 'web', odkaz: 'https://www.detskekrucky.cz/eshop.html' }, { text: ' a ' }, { text: 'volejte', odkaz: 'tel:+420123' }
    ]);
  });

  test(`${soubor}: nebezpečné adresy zůstanou textem`, () => {
    for (const t of ['[x](javascript:alert(1))', '[x](JavaScript:alert)', '[x](data:text/html,1)', '[x](//zly.cz)', '[x](http://zly.cz)']) {
      assert.ok(casti(t).every(c => !c.odkaz), t);
      assert.equal(casti(t).map(c => c.text).join(''), t);
    }
  });
}
