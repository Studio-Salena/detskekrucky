// Zámek e-shopu před spuštěním: bez náhledového klíče přesměrovat na eshop-brzy.html,
// s klíčem pustit i v prohlížeči, který nedovolí localStorage (Messenger, anonymní okno)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ESHOP = fs.readFileSync(path.join(__dirname, '..', 'eshop.html'), 'utf8');
const ZAMEK = ESHOP.slice(ESHOP.indexOf('<script>') + 8, ESHOP.indexOf('</script>'));

function spustit({ search = '', uloziste = true, cookie = '' } = {}) {
  const presmerovano = [];
  const mapa = () => {
    const m = new Map();
    if (!uloziste) return { getItem() { throw new Error('blokováno'); }, setItem() { throw new Error('blokováno'); } };
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
  };
  const ls = mapa(), ss = mapa();
  const doc = { cookie };
  vm.runInNewContext(ZAMEK, {
    location: { search, replace: u => presmerovano.push(u) },
    localStorage: ls, sessionStorage: ss, document: doc
  });
  return { presmerovano, ls, ss, doc };
}

test('zámek: blok je v hlavičce a stránka má noindex', () => {
  assert.match(ZAMEK, /location\.replace\('eshop-brzy\.html'\)/);
  assert.match(ESHOP, /<meta name="robots" content="noindex">/);
});

test('zámek: bez klíče nebo se špatným klíčem přesměruje na odpočet', () => {
  assert.deepEqual(spustit().presmerovano, ['eshop-brzy.html']);
  assert.deepEqual(spustit({ search: '?nahled=spatne' }).presmerovano, ['eshop-brzy.html']);
  assert.deepEqual(spustit({ uloziste: false }).presmerovano, ['eshop-brzy.html']);
});

test('zámek: s klíčem pustí a zapamatuje si ho (i s jinou velikostí písmen a mezerou na konci)', () => {
  const r = spustit({ search: '?nahled=VhnxYyqF' });
  assert.deepEqual(r.presmerovano, []);
  assert.equal(r.ls.getItem('eshopNahled'), '1');
  assert.equal(r.ss.getItem('eshopNahled'), '1');
  assert.match(r.doc.cookie, /^eshopNahled=1; path=\//);
  assert.deepEqual(spustit({ search: '?produkt=5&NAHLED=vhnxyyqf%20' }).presmerovano, []);
});

test('zámek: s klíčem pustí i když prohlížeč blokuje úložiště; zapamatování přes cookie stačí', () => {
  assert.deepEqual(spustit({ search: '?nahled=VhnxYyqF', uloziste: false }).presmerovano, []);
  assert.deepEqual(spustit({ uloziste: false, cookie: 'a=b; eshopNahled=1' }).presmerovano, []);
});

test('zámek: ověření účtu z e-mailu projde', () => {
  assert.deepEqual(spustit({ search: '?overeni=abc' }).presmerovano, []);
});
