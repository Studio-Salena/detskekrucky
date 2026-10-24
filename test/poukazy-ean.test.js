// EAN dárkových poukazů podle druhu (21 prodej, 22 dar) a darované
// poukazy mimo tržby. Funkce se vytahuje ze skutečného routes/poukazy.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ZDROJ = fs.readFileSync(path.join(__dirname, '..', 'routes', 'poukazy.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function vytahnout(nazev) {
  const start = ZDROJ.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, `Funkce ${nazev} nenalezena`);
  let hloubka = 0;
  for (let i = ZDROJ.indexOf('{', start); i < ZDROJ.length; i++) {
    if (ZDROJ[i] === '{') hloubka++;
    else if (ZDROJ[i] === '}' && --hloubka === 0) return ZDROJ.slice(start, i + 1);
  }
  throw new Error(`Konec funkce ${nazev} nenalezen`);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([ZDROJ.match(/const PREFIX_EAN = [^;]+;/)[0], vytahnout('vygenerovatEan'), 'this.vygenerovatEan = vygenerovatEan;'].join('\n'), sandbox);

function kontrolaSedi(ean) {
  const soucet = [...ean.slice(0, 12)].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return (10 - soucet % 10) % 10 === Number(ean[12]);
}

test('EAN poukazu: prefix podle druhu, 13 číslic, platná kontrolní číslice', () => {
  for (const [druh, prefix] of [['prodej', '21'], ['dar', '22']]) {
    for (let i = 0; i < 50; i++) {
      const ean = sandbox.vygenerovatEan(druh);
      assert.match(ean, /^\d{13}$/);
      assert.equal(ean.slice(0, 2), prefix, druh);
      assert.ok(kontrolaSedi(ean), ean);
    }
  }
  assert.equal(sandbox.vygenerovatEan().slice(0, 2), '21', 'bez druhu = prodej');
});

test('darovaný poukaz: bez platby a jeho útrata se nepočítá do tržeb', () => {
  assert.match(ZDROJ, /druh === 'dar' && platba/);
  assert.match(ZDROJ, /\(dp\.vydano_prodej_id IS NOT NULL OR dp\.druh = 'dar'\) AND COALESCE\(pr\.poukaz_castka, 0\) = 0\) AS zapocitano_pri_vydani/);
  assert.match(ZDROJ, /ADD COLUMN IF NOT EXISTS druh TEXT NOT NULL DEFAULT 'prodej'/);
  assert.match(ADMIN, /<select id="pkDruh"/);
});

test('druh akce už neexistuje', () => {
  assert.deepEqual(Object.keys(vm.runInContext('PREFIX_EAN', sandbox)), ['prodej', 'dar'], 'server jiný druh odmítne (POVOLENE_DRUHY)');
  assert.doesNotMatch(ADMIN, /value="akce"/);
});
