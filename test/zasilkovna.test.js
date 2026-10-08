// Zásilkovna: veřejný API klíč pro mapu výdejních míst, kontrola místa z widgetu,
// a že se do e-shopu ani adminu nikdy nedostane API heslo.
const test = require('node:test');
const assert = require('node:assert/strict');
const zasilkovna = require('../lib/zasilkovna');
const doprava = require('../lib/doprava');

const KLIC = 'abcdef0123456789';
const HESLO = '0123456789abcdef0123456789abcdef';

test('API klíč: jen 16 znaků; API heslo (32 znaků) se jako klíč nepoužije', () => {
  assert.equal(zasilkovna.apiKlic({ ZASILKOVNA_API_KLIC: ` ${KLIC} ` }), KLIC);
  assert.equal(zasilkovna.apiKlic({}), null);
  assert.equal(zasilkovna.apiKlic({ ZASILKOVNA_API_KLIC: HESLO }), null);
  assert.equal(zasilkovna.apiKlic({ ZASILKOVNA_API_KLIC: 'abc<script>12345' }), null);
});

test('stav pro admin: ano/ne a popis, nikdy hodnota klíče ani hesla', () => {
  assert.deepEqual(zasilkovna.stav({ ZASILKOVNA_API_KLIC: KLIC }), { mapa: true, problem: null });
  assert.match(zasilkovna.stav({}).problem, /chybí proměnná ZASILKOVNA_API_KLIC/);
  const s = zasilkovna.stav({ ZASILKOVNA_API_KLIC: HESLO, ZASILKOVNA_API_HESLO: HESLO });
  assert.equal(s.mapa, false);
  assert.ok(!JSON.stringify(s).includes(HESLO));
});

test('veřejné nastavení dopravy: klíč jen s mapou Zásilkovny, heslo nikdy', () => {
  const n = doprava.sloucitNastaveni(null);
  const bez = doprava.verejneNastaveni(n, {});
  assert.equal(bez.zasilkovnaKlic, undefined);
  assert.equal(bez.metody.find(m => m.kod === 'zasilkovna').vydejniMisto, null);
  const s = doprava.verejneNastaveni(n, { ZASILKOVNA_API_KLIC: KLIC, ZASILKOVNA_API_HESLO: HESLO });
  assert.equal(s.zasilkovnaKlic, KLIC);
  assert.equal(s.metody.find(m => m.kod === 'zasilkovna').vydejniMisto, 'zasilkovna');
  assert.ok(!JSON.stringify(s).includes(HESLO));
  // vypnutá Zásilkovna = žádný klíč
  const vyp = doprava.sloucitNastaveni({ metody: { zasilkovna: { aktivni: false, cena: 79 } } });
  assert.equal(doprava.verejneNastaveni(vyp, { ZASILKOVNA_API_KLIC: KLIC }).zasilkovnaKlic, undefined);
  // GLS výdejní místo se nemění
  assert.equal(doprava.typVydejnihoMista('gls_vydejni_misto', {}), 'gls');
  assert.equal(doprava.typVydejnihoMista('ceska_posta', { ZASILKOVNA_API_KLIC: KLIC }), null);
});

test('výdejní místo z widgetu: přísná kontrola a očištění', () => {
  const ok = { id: '12345', nazev: 'Zlín, Kvítková 1', ulice: 'Kvítková 1', mesto: 'Zlín', psc: '76001', stat: 'cz', typ: 'internal' };
  assert.deepEqual(zasilkovna.overitVydejniMisto(ok), { id: '12345', nazev: 'Zlín, Kvítková 1', ulice: 'Kvítková 1', mesto: 'Zlín', psc: '76001', stat: 'CZ', box: false });
  assert.equal(zasilkovna.overitVydejniMisto({ ...ok, typ: undefined }).id, '12345');
  for (const spatne of [null, 'x', [], { ...ok, id: 'abc' }, { ...ok, id: '12345678901' }, { ...ok, id: '1; DROP' },
    { ...ok, stat: 'sk' }, { ...ok, typ: 'external' }, { ...ok, nazev: '' }, { ...ok, mesto: '   ' }]) {
    assert.equal(zasilkovna.overitVydejniMisto(spatne), null, JSON.stringify(spatne));
  }
  const m = zasilkovna.overitVydejniMisto({ ...ok, nazev: '<img src=x onerror=alert(1)>\n' + 'a'.repeat(300) });
  assert.ok(!/[<>\n]/.test(m.nazev) && m.nazev.length <= 150);
});
