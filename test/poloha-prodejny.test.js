// Poloha prodejny ve strukturovaných datech úvodní stránky (JSON-LD ShoeStore).
//
// Zdroj souřadnic (ověřeno 24. 11. 2026): adresní místo RÚIAN pro Holešovská 752, 768 24 Hulín
// (kód adresního místa 26978415, leží uvnitř budovy č. p. 752, stavební objekt 26463962):
// 49.3159824, 17.4704108. Poloha profilu v Mapách Google (49.3159817, 17.4704191) se od něj liší
// asi o 0,6 m. Zapsáno na 5 desetinných míst = zápis asi na 1 m, skutečná přesnost je přesnost
// adresního místa (řádově metry). Vstup do prodejny tím OVĚŘENÝ NENÍ.
//
// hasMap = přímý odkaz na profil v Mapách Google (CID místa 0x56fdd830b79c7953, entita
// /g/11zf7gq575 - stejná jako odkaz od majitelky). Ověřeno v prohlížeči 24. 11. 2026: otevře
// profil „Dětské krůčky“, Holešovská 752, detskekrucky.cz, 773 517 733. Není to vyhledávací odkaz.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const prodejna = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map(b => JSON.parse(b[1])).find(b => b['@type'] === 'ShoeStore');

const RUIAN_752 = { lat: 49.3159824, lon: 17.4704108 }; // adresní místo 26978415
function vzdalenostM(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const x = r(b.lon - a.lon) * Math.cos(r((a.lat + b.lat) / 2)) * R, y = r(b.lat - a.lat) * R;
  return Math.hypot(x, y);
}

test('JSON-LD prodejny: souřadnice z adresního místa RÚIAN Holešovská 752 (do 2 m)', () => {
  assert.ok(prodejna, 'JSON-LD ShoeStore chybí');
  assert.equal(prodejna.geo['@type'], 'GeoCoordinates');
  assert.deepEqual([prodejna.geo.latitude, prodejna.geo.longitude], [49.31598, 17.47041]);
  const d = vzdalenostM({ lat: prodejna.geo.latitude, lon: prodejna.geo.longitude }, RUIAN_752);
  assert.ok(d < 2, `souřadnice jsou ${d.toFixed(1)} m od adresního místa RÚIAN`);
  // víc desetinných míst by předstíralo přesnost, kterou zdroj nemá
  assert.ok(String(prodejna.geo.latitude).split('.')[1].length <= 5 && String(prodejna.geo.longitude).split('.')[1].length <= 5);
});

test('JSON-LD prodejny: hasMap je přímý odkaz na profil v Mapách Google (CID), ne vyhledávání', () => {
  assert.equal(prodejna.hasMap, 'https://maps.google.com/?cid=6268403960120113491');
  assert.equal(BigInt('0x56fdd830b79c7953').toString(), '6268403960120113491'); // CID z adresy profilu
  assert.equal(prodejna.address.streetAddress, 'Holešovská 752');
  assert.equal(prodejna.address.addressLocality, 'Hulín');
});
