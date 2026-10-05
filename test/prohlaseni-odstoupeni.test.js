// B3.1 - helper pro text prohlášení o odstoupení (lib/prohlaseniOdstoupeni.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { sestavitProhlaseniOdstoupeni } = require('../lib/prohlaseniOdstoupeni');

const POLOZKY = [
  { produkt_id: 5, velikost: 24, pocet: 2, nazev: 'Bota A', cena: 500 },
  { produkt_id: 6, velikost: 25, pocet: 1, nazev: 'Bota B', cena: 700 }
];

test('helper: plný text se všemi údaji v pevném pořadí', () => {
  const t = sestavitProhlaseniOdstoupeni({ cislo: '261012', objednavkaId: 1, jmeno: ' Jana Nováková ', email: 'jana@example.com', polozky: POLOZKY, duvod: ' nesedí velikost ' });
  assert.equal(t, [
    'Oznamuji, že tímto odstupuji od smlouvy o koupi tohoto zboží.',
    'Objednávka č.: 261012',
    'Jméno: Jana Nováková',
    'E-mail pro potvrzení: jana@example.com',
    'Vracené zboží:',
    '- Bota A, vel. 24, 2 ks',
    '- Bota B, vel. 25, 1 ks',
    'Důvod (nepovinný): nesedí velikost'
  ].join('\n'));
});

test('helper: bez jména a důvodu (undefined, null, prázdné, ne-řetězec) nevzniká undefined ani null', () => {
  for (const prazdne of [undefined, null, '', '   ', { a: 1 }, 42]) {
    const t = sestavitProhlaseniOdstoupeni({ cislo: '261012', objednavkaId: 1, jmeno: prazdne, email: 'jana@example.com', polozky: POLOZKY, duvod: prazdne });
    assert.doesNotMatch(t, /undefined|null|\[object Object\]|Jméno:|Důvod/);
    assert.match(t, /odstupuji od smlouvy/);
  }
});

test('helper: objednávka bez zákaznického čísla použije interní id', () => {
  const t = sestavitProhlaseniOdstoupeni({ cislo: null, objednavkaId: 7, email: 'jana@example.com', polozky: POLOZKY });
  assert.match(t, /Objednávka č\.: 7\n/);
  assert.doesNotMatch(t, /null|undefined/);
});
