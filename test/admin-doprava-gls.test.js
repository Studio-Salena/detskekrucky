// Admin (2026-10): výdejní místo v detailu objednávky (escapované, ID ke
// zkopírování), štítky dopravy, karta Nastavení -> Doprava bez přístupových údajů GLS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
function vytahnout(nazev) {
  const start = ADMIN.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, nazev);
  let hloubka = 0;
  for (let i = ADMIN.indexOf(') {', start) + 2; i < ADMIN.length; i++) {
    if (ADMIN[i] === '{') hloubka++;
    else if (ADMIN[i] === '}' && --hloubka === 0) return ADMIN.slice(start, i + 1);
  }
  throw new Error(nazev);
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(['escH', 'escAttr', 'vydejniMistoAdresa', 'vydejniMistoDetailHtml', 'glsDetailHtml', 'zasilkovnaDetailHtml'].map(vytahnout).join('\n'), sandbox);
const detail = d => vm.runInContext(`vydejniMistoDetailHtml(${JSON.stringify(d)})`, sandbox);

test('detail: výdejní místo GLS s adresou a ID, vše escapované (i v data-id)', () => {
  const h = detail({ dopravce: 'gls', vydejni_misto_id: 'X1"><img src=x>', vydejni_misto_nazev: '<script>a</script>', vydejni_misto_ulice: 'U 1', vydejni_misto_mesto: 'Brno', vydejni_misto_psc: '60200' });
  assert.equal(h.includes('<script>'), false);
  assert.equal(h.includes('<img'), false);
  assert.match(h, /data-id="X1&quot;&gt;&lt;img src=x&gt;"/);
  assert.match(h, /U 1, 60200 Brno/);
  assert.match(h, /Podání do GLS z administrace zatím není zapnuté – zásilku založte ručně v MyGLS/);
});

test('detail: objednávka bez výdejního místa a mimo GLS nic navíc neukáže', () => {
  assert.equal(detail({ dopravce: 'zasilkovna', vydejni_misto_id: null }), '');
  assert.equal(detail({ dopravce: null }), '', 'starší objednávky bez dopravce');
  assert.match(detail({ dopravce: 'gls', vydejni_misto_id: null }), /zásilku založte ručně v MyGLS\./);
});

test('štítky dopravy obsahují GLS; seznam, detail i tisk je používají', () => {
  assert.match(ADMIN, /gls_adresa: 'GLS – na adresu', gls_vydejni_misto: 'GLS – výdejní místo'/);
  assert.match(ADMIN, /escH\(DOPRAVA_LABELY\[o\.doprava\]\|\|o\.doprava\)/);
  assert.match(ADMIN, /escH\(DOPRAVA_LABELY\[data\.doprava\]\|\|data\.doprava\)/);
  assert.match(ADMIN, /data\.doprava_cena != null \? Number\(data\.doprava_cena\)/);
});

test('Nastavení -> Doprava: ukládá přes PUT /doprava, stav GLS jen jako text, žádné přístupové údaje', () => {
  const ulozit = vytahnout('ulozitDopravu');
  assert.match(ulozit, /API \+ '\/doprava', \{ method: 'PUT'/);
  assert.match(ulozit, /msg\.textContent = /);
  const nacist = vytahnout('loadDopravu');
  assert.match(nacist, /getElementById\('glsApiStav'\)\.textContent = /);
  assert.equal(/GLS_PASSWORD|GLS_USERNAME|GLS_CLIENT_NUMBER/.test(ADMIN), false);
});

test('detail GLS: s nastaveným API tlačítko Podat do GLS (testovací prostředí označené), po podání číslo, štítek a sledování', () => {
  const zaklad = { id: 7, dopravce: 'gls', doprava: 'gls_adresa', stav: 'nova', platba: 'dobirka', vydejni_misto_id: null };
  const h = detail({ ...zaklad, gls_podani: true, gls_prostredi: 'test' });
  assert.match(h, /podatDoGls\(7, this\)/);
  assert.match(h, /TEST/);
  assert.match(h, /nic se skutečně neodešle/);
  assert.match(h, /dobírka/);
  assert.equal(detail({ ...zaklad, gls_podani: true, gls_prostredi: 'ostre' }).includes('TEST'), false);
  assert.equal(detail({ ...zaklad, gls_podani: true, stav: 'zrusena' }), '', 'zrušenou nejde podat');
  const podano = detail({ ...zaklad, gls_podani: true, zasilky: [{ dopravce: 'gls', cislo_zasilky: '12345678<b>', prostredi: 'ostre', vytvoreno: '2026-10-08T10:00:00Z', tracking_url: 'https://gls-group.com/CZ/cs/sledovani-zasilek?match=12345678' }] });
  assert.match(podano, /12345678&lt;b&gt;/);
  assert.match(podano, /stahnoutStitekGls\(7, this\)/);
  assert.match(podano, /Sledování zásilky/);
  assert.equal(podano.includes('podatDoGls'), false, 'podruhé už se nepodává');
  assert.equal(detail({ ...zaklad, zasilky: [{ dopravce: 'gls', cislo_zasilky: '1', prostredi: 'ostre', vytvoreno: '2026-10-08', tracking_url: 'javascript:alert(1)' }] }).includes('javascript:'), false);
});
