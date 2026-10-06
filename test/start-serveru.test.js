// Server přijímá požadavky až po doběhnutí startovních migrací (lib/startServeru.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function cerstvyModul() {
  const p = require.resolve('../lib/startServeru');
  delete require.cache[p];
  return require(p);
}

test('čeká na všechny úlohy; chyba úlohy start nezablokuje', async () => {
  const { pripravit, vsePripraveno } = cerstvyModul();
  const poradi = [];
  pripravit(new Promise(r => setTimeout(() => { poradi.push('pomala'); r(); }, 40)));
  pripravit(Promise.reject(new Error('migrace selhala')));
  pripravit(Promise.resolve().then(() => poradi.push('rychla')));
  assert.equal(await vsePripraveno(1000), true);
  assert.deepEqual(poradi, ['rychla', 'pomala']);
});

test('zaseknutá úloha: po limitu se startuje i tak', async () => {
  const { pripravit, vsePripraveno } = cerstvyModul();
  pripravit(new Promise(() => {}));
  const start = Date.now();
  assert.equal(await vsePripraveno(50), false);
  assert.ok(Date.now() - start < 1000);
});

test('pripravit vrací původní promise (volající může dál čekat na výsledek)', async () => {
  const { pripravit } = cerstvyModul();
  const p = Promise.resolve(42);
  assert.equal(pripravit(p), p);
});

test('všechny startovní migrace jsou zaregistrované a server naslouchá až po nich', () => {
  const koren = path.join(__dirname, '..');
  const soubory = ['index.js', ...fs.readdirSync(path.join(koren, 'routes')).map(f => path.join('routes', f))];
  for (const f of soubory) {
    const kod = fs.readFileSync(path.join(koren, f), 'utf8');
    const nechranene = kod.match(/^(init[A-Za-z]*|nacist[A-Za-z]*ZDB)\(\);/gm);
    assert.equal(nechranene, null, `${f}: startovní úloha mimo pripravit(): ${nechranene}`);
  }
  const index = fs.readFileSync(path.join(koren, 'index.js'), 'utf8');
  assert.match(index, /vsePripraveno\(\)\.then\([\s\S]*app\.listen\(/);
  assert.equal((index.match(/app\.listen\(/g) || []).length, 1);
});
