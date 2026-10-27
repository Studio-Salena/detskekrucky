// Stránka „E-shop brzy“: odpočet do spuštění e-shopu 1. 11. 2026 (půlnoc českého času)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'eshop-brzy.html'), 'utf8');
const skript = HTML.slice(HTML.indexOf('<script>') + 8, HTML.indexOf('</script>'));

function spustit(ted) {
  const prvky = {};
  const el = id => (prvky[id] = prvky[id] || { textContent: '', hidden: true });
  const intervaly = [];
  const sandbox = {
    document: { getElementById: el },
    Date: { parse: Date.parse, now: () => ted },
    setInterval: (fn) => { intervaly.push(fn); return 1; },
    clearInterval: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(skript, sandbox);
  return { prvky, intervaly };
}

test('odpočet: spuštění o půlnoci 1. 11. 2026 českého času (23:00 UTC 31. 10.)', () => {
  assert.equal(Date.parse('2026-10-31T23:00:00Z'), vm.runInNewContext(skript.split('\n// 1 den')[0] + '; SPUSTENI', { Date }));
});

test('odpočet: dny, hodiny, minuty, sekundy se správným tvarem slova', () => {
  const start = Date.parse('2026-10-31T23:00:00Z');
  const { prvky, intervaly } = spustit(start - ((4 * 24 + 1) * 3600 + 2 * 60 + 5) * 1000);
  assert.equal(prvky.odpocet.hidden, false);
  assert.equal(prvky.spusteno.hidden, true);
  assert.deepEqual(['odpDny', 'odpHodiny', 'odpMinuty', 'odpSekundy'].map(id => [prvky[id].textContent, prvky[id + 'Text'].textContent]),
    [[4, 'dny'], [1, 'hodina'], [2, 'minuty'], [5, 'sekund']]);
  assert.equal(intervaly.length, 1, 'odpočet běží každou sekundu');
  const pet = spustit(start - (5 * 86400 + 11) * 1000).prvky;
  assert.deepEqual([pet.odpDny.textContent, pet.odpDnyText.textContent, pet.odpHodinyText.textContent, pet.odpSekundyText.textContent], [5, 'dní', 'hodin', 'sekund']);
  assert.equal(spustit(start - 86400 * 1000).prvky.odpDnyText.textContent, 'den');
});

test('odpočet: po spuštění místo čísel hláška a časovač se nespouští', () => {
  const { prvky, intervaly } = spustit(Date.parse('2026-11-01T08:00:00+01:00'));
  assert.equal(prvky.odpocet.hidden, true);
  assert.equal(prvky.spusteno.hidden, false);
  assert.equal(intervaly.length, 0);
});

test('stránka: bez JavaScriptu odpočet skrytý, text spuštění zůstává', () => {
  assert.match(HTML, /<div class="odpocet" id="odpocet" role="timer"[^>]*hidden>/);
  assert.match(HTML, /<h1>E-shop spouštíme už 1\.&nbsp;11\.&nbsp;2026!<\/h1>/);
});
