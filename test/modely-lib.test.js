// Krok 0 - modely bot: slug, klíč modelu, validace vlastností a nastavení katalogu (lib/modely.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  klicModelu, vytvoritSlug, nejcastejsiKategorie, overitUpravuModelu, jeVyplneno,
  overitNastaveniKatalogu, zajistitModel, VYCHOZI_NASTAVENI_KATALOGU
} = require('../lib/modely');

test('klíč modelu nerozlišuje velká písmena ani okrajové mezery', () => {
  assert.equal(klicModelu('BEDA', ' Barefoot Zuzi '), klicModelu('Beda', 'barefoot zuzi'));
  assert.equal(klicModelu('Čáp', 'Žlutá'), klicModelu('čÁP', 'žLUTÁ'));
  assert.notEqual(klicModelu('Froddo', 'A'), klicModelu('Froddo', 'B'));
  assert.equal(klicModelu(null, 'X'), klicModelu('', 'x'));
});

test('slug: bez diakritiky, malá písmena, pomlčky, + jako plus', () => {
  assert.equal(vytvoritSlug('Froddo', 'AUTUMN BLACK+'), 'froddo-autumn-black-plus');
  assert.equal(vytvoritSlug('Beda', 'Žluťoučký kůň – zimní / 2026'), 'beda-zlutoucky-kun-zimni-2026');
  assert.equal(vytvoritSlug('', '  ***  '), 'model');
  assert.equal(vytvoritSlug('Dr. Grepl', 'Kids & Co'), 'dr-grepl-kids-a-co');
  const dlouhy = vytvoritSlug('X', 'a '.repeat(100));
  assert.ok(dlouhy.length <= 80);
  assert.doesNotMatch(dlouhy, /-$/);
});

test('nejčastější kategorie, při shodě abecedně první', () => {
  assert.equal(nejcastejsiKategorie(['papuce', 'celorocky', 'celorocky', null]), 'celorocky');
  assert.equal(nejcastejsiKategorie(['papuce', 'celorocky']), 'celorocky');
  assert.equal(nejcastejsiKategorie([null, '']), null);
});

test('validace: platné vlastnosti projdou, vícenásobné bez duplicit v pevném pořadí', () => {
  const { chyba, hodnoty } = overitUpravuModelu({
    kategorie: 'celorocky', barefoot: true, membrana: null,
    sirka: ['siroka', 'normalni', 'siroka'], nart: [], zapinani: ['suchy_zip'],
    dominantni_palec: 'vhodna', material: 'kuze', pohlavi: null,
    proc_jsme_vybrali: [' měkká podrážka ', '', 'široká špička']
  });
  assert.equal(chyba, undefined);
  assert.deepEqual(hodnoty.sirka, ['normalni', 'siroka']);
  assert.deepEqual(hodnoty.nart, []);
  assert.deepEqual(hodnoty.proc_jsme_vybrali, ['měkká podrážka', 'široká špička']);
  assert.equal(hodnoty.membrana, null);
  assert.equal('znacka' in hodnoty, false, 'neposlaná pole se nemění');
});

test('validace odmítne neznámé hodnoty, špatné typy a příliš mnoho bodů', () => {
  const spatne = [
    { sirka: ['extra_siroka'] },
    { sirka: 'siroka' },
    { zapinani: [{ a: 1 }] },
    { material: 'zlato' },
    { material: 'toString' },
    { barefoot: 'ano' },
    { pohlavi: 'jine' },
    { kategorie: '' },
    { nazev: '   ' },
    { znacka: 5 },
    { proc_jsme_vybrali: ['a', 'b', 'c', 'd'] },
    { proc_jsme_vybrali: ['x'.repeat(121)] },
    {},
    null
  ];
  for (const telo of spatne) {
    assert.ok(overitUpravuModelu(telo).chyba, `mělo selhat: ${JSON.stringify(telo)}`);
  }
});

test('vyplněno: povinné jsou barefoot, šířka, zapínání, membrána a materiál; doplňky se nepočítají', () => {
  const plny = { kategorie: 'celorocky', barefoot: false, sirka: ['normalni'], zapinani: ['tkanicky'], membrana: false, material: 'textil' };
  assert.equal(jeVyplneno(plny), true);
  assert.equal(jeVyplneno({ ...plny, barefoot: null }), false);
  assert.equal(jeVyplneno({ ...plny, sirka: [] }), false);
  assert.equal(jeVyplneno({ ...plny, material: null }), false);
  assert.equal(jeVyplneno({ kategorie: 'doplnky', barefoot: null, sirka: [] }), true);
  assert.equal(jeVyplneno({ kategorie: 'pece-o-obuv' }), true);
});

test('nastavení katalogu: výchozí hodnoty projdou validací, chybné se odmítnou', () => {
  assert.deepEqual(overitNastaveniKatalogu(VYCHOZI_NASTAVENI_KATALOGU).hodnoty, VYCHOZI_NASTAVENI_KATALOGU);
  const spatne = [
    { vekoveSkupiny: [], pohlavi: false },
    { vekoveSkupiny: Array(7).fill({ nazev: 'a', od: 1, do: 2 }), pohlavi: false },
    { vekoveSkupiny: [{ nazev: 'a', od: 25, do: 22 }], pohlavi: false },
    { vekoveSkupiny: [{ nazev: '', od: 1, do: 2 }], pohlavi: false },
    { vekoveSkupiny: [{ nazev: 'a', od: 0, do: 2 }], pohlavi: false },
    { vekoveSkupiny: [{ nazev: 'a', od: 1.5, do: 2 }], pohlavi: false },
    { vekoveSkupiny: [{ nazev: 'a', od: 1, do: 2 }], pohlavi: 'ano' }
  ];
  for (const telo of spatne) assert.ok(overitNastaveniKatalogu(telo).chyba, JSON.stringify(telo));
});

test('hromadná změna: povolená pole projdou, id bez duplicit; značka, název a vícenásobné volby ne', () => {
  const { overitHromadnouZmenu } = require('../lib/modely');
  const ok = overitHromadnouZmenu({ ids: [3, 1, 3], zmeny: { kategorie: 'prezuvky' } });
  assert.deepEqual(ok, { ids: [3, 1], hodnoty: { kategorie: 'prezuvky' } });
  assert.deepEqual(overitHromadnouZmenu({ ids: [1], zmeny: { barefoot: null } }).hodnoty, { barefoot: null });
  const spatne = [
    { ids: [], zmeny: { barefoot: true } },
    { ids: [1, 'x'], zmeny: { barefoot: true } },
    { ids: [0], zmeny: { barefoot: true } },
    { ids: Array.from({ length: 501 }, (_, i) => i + 1), zmeny: { barefoot: true } },
    { ids: [1], zmeny: { znacka: 'Beda' } },
    { ids: [1], zmeny: { nazev: 'X' } },
    { ids: [1], zmeny: { sirka: ['siroka'] } },
    { ids: [1], zmeny: { material: 'zlato' } },
    { ids: [1], zmeny: {} },
    { ids: [1], zmeny: [] },
    { ids: [1] },
    null
  ];
  for (const telo of spatne) assert.ok(overitHromadnouZmenu(telo).chyba, JSON.stringify(telo)?.slice(0, 80));
});

test('zajistitModel: existující klíč vrátí model, nový založí s volným slugem', async () => {
  const modely = [{ id: 1, klic: klicModelu('Froddo', 'A'), slug: 'froddo-a' }];
  const db = {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id FROM modely WHERE klic')) return { rows: modely.filter(m => m.klic === params[0]) };
      if (s.startsWith('SELECT 1 FROM modely WHERE slug')) return { rows: modely.filter(m => m.slug === params[0]) };
      if (s.startsWith('INSERT INTO modely')) {
        const m = { id: modely.length + 1, klic: params[0], slug: params[1], znacka: params[2], nazev: params[3], kategorie: params[4] };
        modely.push(m);
        return { rows: [m] };
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
  assert.equal(await zajistitModel(db, { znacka: 'FRODDO', nazev: ' a ' }), 1);
  // Jiný klíč, ale stejný slug ("froddo-a") -> přípona
  const id = await zajistitModel(db, { znacka: 'Froddo', nazev: 'Á', kategorie: 'celorocky' });
  assert.equal(id, 2);
  assert.equal(modely[1].slug, 'froddo-a-2');
  assert.equal(modely[1].kategorie, 'celorocky');
  assert.equal(modely[1].nazev, 'Á');
});
