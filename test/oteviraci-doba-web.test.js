// Otevírací doba na úvodní stránce je na třech místech: patička (#oteviraci-tabulka), plovoucí box
// (#oh-table) a JSON-LD prodejny pro vyhledávače. Skript je po načtení přepíše daty z adminu, ale
// vyhledávač a pomalé připojení vidí statické hodnoty – musí si odpovídat (dřív byla v HTML sobota
// „Zavřeno“, i když prodejna měla otevřeno). Test hlídá shodu mezi sebou; shodu s adminem
// zajistí ruční úprava při změně otevírací doby (komentář u tabulky v index.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const DNY = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];
const DNY_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function tabulka(id) {
  const m = html.match(new RegExp(`<table id="${id}"[^>]*>([\\s\\S]*?)</table>`));
  assert.ok(m, `tabulka ${id} chybí`);
  const radky = [...m[1].matchAll(/<tr[^>]*>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<\/tr>/g)];
  return Object.fromEntries(radky.map(r => [r[1].trim(), r[2].trim()]));
}

// "9:00 - 11:30; 13:00 - 16:30" -> ["09:00-11:30", "13:00-16:30"]; jiný text (např. "dle rezervací") -> []
function intervaly(text) {
  const dvojice = [...text.matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g)];
  return dvojice.map(d => `${d[1].padStart(2, '0')}:${d[2]}-${d[3].padStart(2, '0')}:${d[4]}`);
}

function jsonLdProdejny() {
  const bloky = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(b => JSON.parse(b[1]));
  const prodejna = bloky.find(b => b['@type'] === 'ShoeStore');
  assert.ok(prodejna, 'JSON-LD ShoeStore chybí');
  return prodejna;
}

test('otevírací doba: patička, plovoucí box a JSON-LD si odpovídají', () => {
  const paticka = tabulka('oteviraci-tabulka');
  const box = tabulka('oh-table');
  assert.deepEqual(Object.keys(paticka), DNY);
  assert.deepEqual(box, paticka, 'plovoucí box se liší od patičky');
  for (const den of DNY) assert.notEqual(paticka[den], '—', `${den}: chybí čas (pomlčka)`);

  const ld = {};
  for (const s of jsonLdProdejny().openingHoursSpecification || []) {
    for (const den of [].concat(s.dayOfWeek)) (ld[den] = ld[den] || []).push(`${s.opens}-${s.closes}`);
  }
  DNY.forEach((den, i) => {
    assert.deepEqual((ld[DNY_EN[i]] || []).sort(), intervaly(paticka[den]).sort(), `${den}: JSON-LD nesedí s tabulkou`);
  });
});

test('úvodní stránka: jeden H1, title a description vyplněné', () => {
  const h1 = [...html.matchAll(/<h1[\s>]/g)];
  assert.equal(h1.length, 1, 'úvodní stránka má mít právě jeden H1');
  assert.match(html, /<title>[^<]{20,70}<\/title>/);
  const popis = html.match(/<meta name="description" content="([^"]+)"/);
  assert.ok(popis && popis[1].length >= 70 && popis[1].length <= 170, 'meta description 70–170 znaků');
});
