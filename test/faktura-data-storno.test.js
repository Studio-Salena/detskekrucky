// Data v životě objednávky (úhrada, expedice, dodání, zrušení) se evidují zvlášť
// a nezaměňují se; storno ani vratka nevymaže vystavenou fakturu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');
const { sestavitSnimek, vykreslitObsah } = require('../lib/faktura');

const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function pripravit(prepis = {}) {
  const stav = pocatecniStav();
  stav.objednavky.push({
    id: 7, cislo: '261020', stav: 'nova', zakaznik_id: 1, doprava: 'zasilkovna', platba: 'prevod', doprava_cena: 79, platba_priplatek: 0,
    sleva: 0, celkem: 579, vytvoreno: new Date('2026-10-20T10:00:00Z'), poukaz_id: null,
    obj_jmeno: 'Jana Nováková', obj_email: 'jana@example.com', obj_telefon: '777 123 456', obj_ulice: 'Hlavní 1', obj_mesto: 'Hulín', obj_psc: '768 24',
    ...prepis
  });
  stav.objednavkyPolozky.push({ objednavka_id: 7, produkt_id: 5, velikost: 26, pocet: 1, cena: 500, nazev: 'Bota' });
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': vytvoritMockPool(stav),
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {}, odeslat_fakturu: async () => {} }
  });
  const volat = async (method, cesta, body = {}) => { const res = vytvoritRes(); await najitHandler(router, method, cesta)({ params: { id: '7' }, body }, res); return res; };
  return {
    stav,
    o: () => stav.objednavky[0],
    zmenitStav: s => volat('patch', '/:id/stav', { stav: s }),
    tisk: () => volat('post', '/:id/faktura-html'),
    smazat: () => volat('delete', '/:id')
  };
}

test('data: odeslání zapíše jen expedici - ne úhradu ani dodání', async () => {
  const t = pripravit();
  await t.zmenitStav('odeslana');
  assert.ok(t.o().expedovano_at instanceof Date);
  assert.equal(t.o().zaplaceno_at, undefined, 'odesláno neznamená zaplaceno');
  assert.equal(t.o().dodano_at, undefined, 'odesláno neznamená doručeno');
});

test('data: doručení má vlastní datum, dřívější expedice se nepřepíše ani opakovaným uložením stavu', async () => {
  const t = pripravit();
  await t.zmenitStav('odeslana');
  const expedice = new Date('2026-10-21T08:00:00Z');
  t.o().expedovano_at = expedice;
  await t.zmenitStav('dorucena');
  assert.ok(t.o().dodano_at instanceof Date);
  assert.notEqual(t.o().dodano_at, expedice);
  await t.zmenitStav('odeslana');
  assert.equal(t.o().expedovano_at, expedice, 'první okamžik zůstává');
  assert.equal(t.o().zaplaceno_at, undefined);
});

test('data: zaplaceno má vlastní datum; uložení stejného stavu znovu nic nezapíše', async () => {
  const t = pripravit({ stav: 'zaplacena' });
  await t.zmenitStav('zaplacena');
  assert.equal(t.o().zaplaceno_at, undefined, 'bez skutečné změny stavu se nic nedoplňuje');
  const t2 = pripravit();
  await t2.zmenitStav('zaplacena');
  assert.ok(t2.o().zaplaceno_at instanceof Date);
});

test('faktura: datum odeslání se nevydává za datum dodání; místo dodání podle dopravy', () => {
  const zaklad = { id: 7, cislo: '261020', jmeno: 'J', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24', doprava: 'zasilkovna', platba: 'prevod', doprava_cena: 79, sleva: 0, celkem: 579, vytvoreno: '2026-10-20T10:00:00Z', polozky: [] };
  const F = { faktura_cislo: '2026010', faktura_datum: '2026-10-22T10:00:00Z' };
  const odeslana = sestavitSnimek({ ...zaklad, expedovano_at: '2026-10-21T08:00:00Z' }, F);
  assert.equal(odeslana.data.expedovano, '2026-10-21T08:00:00.000Z');
  assert.equal(odeslana.data.dodano, null);
  const tOdeslana = text(vykreslitObsah(odeslana));
  assert.match(tOdeslana, /Datum dodání: není v systému evidováno \(evidované datum odeslání: 21\. 10\. 2026\)/);
  assert.doesNotMatch(tOdeslana, /nebylo dodáno|Datum dodání: 21\./, 'odeslání není dodání a nic se netvrdí');
  // bez jakéhokoli data: jen "neevidováno", žádné tvrzení o (ne)dodání
  const nic = text(vykreslitObsah(sestavitSnimek(zaklad, F)));
  assert.match(nic, /Datum dodání: není v systému evidováno Platba/);
  assert.doesNotMatch(nic, /odeslání|nebylo dodáno/);
  const dodana = sestavitSnimek({ ...zaklad, expedovano_at: '2026-10-21T08:00:00Z', dodano_at: '2026-10-23T12:00:00Z', zaplaceno_at: '2026-10-20T12:00:00Z' }, F);
  const t = text(vykreslitObsah(dodana));
  assert.match(t, /Datum dodání: 23\. 10\. 2026/);
  assert.match(t, /Datum úhrady: 20\. 10\. 2026/);
  assert.match(t, /Místo dodání: Hlavní 1, 768 24 Hulín/);
  // osobní odběr = prodejna, výdejní místo = výdejní místo
  assert.match(sestavitSnimek({ ...zaklad, doprava: 'osobni_odber' }, F).misto_dodani, /^Osobní odběr na prodejně, Holešovská 752/);
  assert.match(sestavitSnimek({ ...zaklad, vydejni_misto_id: 'Z1', vydejni_misto_nazev: 'Hulín, Trávník', vydejni_misto_ulice: 'Trávník 1', vydejni_misto_mesto: 'Hulín', vydejni_misto_psc: '76824' }, F).misto_dodani, /^Výdejní místo Hulín, Trávník, Trávník 1, 76824 Hulín/);
});

test('faktura: starší objednávka bez evidovaných dat nic nedomýšlí', () => {
  const s = sestavitSnimek({ id: 1, cislo: '260801', jmeno: 'J', doprava: 'ceska_posta', platba: 'prevod', celkem: 589, sleva: 0, vytvoreno: '2026-08-01T10:00:00Z', polozky: [{ nazev: 'X', velikost: 25, pocet: 1, cena: 500 }] }, { faktura_cislo: '2026011', faktura_datum: '2026-10-27T10:00:00Z' });
  assert.deepEqual(s.data, { objednavka: '2026-08-01T10:00:00.000Z', zaplaceno: null, expedovano: null, dodano: null });
  assert.doesNotMatch(text(vykreslitObsah(s)), /Datum úhrady/);
});

test('storno: zrušení objednávky s fakturou vystaví opravný doklad, faktura zůstane beze změny a objednávku nejde smazat', async () => {
  const t = pripravit({ stav: 'odeslana' });
  const tisk = await t.tisk();
  assert.equal(tisk.statusCode, 200);
  const puvodni = JSON.stringify(t.stav.faktury[0]);
  const zruseni = await t.zmenitStav('zrusena');
  assert.equal(zruseni.statusCode, 200);
  assert.equal(zruseni.body.storno_cislo, `OD${new Date().getFullYear()}001`);
  assert.ok(t.o().zruseno_at instanceof Date);
  assert.equal(JSON.stringify(t.stav.faktury[0]), puvodni, 'faktura beze změny');
  assert.equal(t.stav.faktury.length, 2);
  const storno = t.stav.faktury[1];
  assert.equal(storno.druh, 'storno');
  assert.equal(storno.objednavka_id, 7);
  assert.equal(storno.data.puvodni_doklad.cislo, t.stav.faktury[0].cislo);
  assert.equal(storno.data.puvodni_doklad.historicka, false);
  assert.equal(storno.data.celkem, -579);
  assert.equal(storno.data.polozky[0].pocet, -1);
  assert.equal(storno.data.polozky[0].celkem, -500);
  assert.equal(storno.data.doprava.cena, -79);
  assert.equal((await t.smazat()).statusCode, 400);
  assert.equal(t.stav.objednavky.length, 1);
  // tisk faktury po stornu vrátí stále původní doklad
  const poStornu = await t.tisk();
  assert.equal(poStornu.statusCode, 200);
  assert.equal(poStornu.body.html, tisk.body.html);
  // opakované uložení stavu "zrušena" druhé storno nevystaví
  await t.zmenitStav('zrusena');
  assert.equal(t.stav.faktury.length, 2);
});

test('storno: objednávka bez faktury žádný opravný doklad nedostane', async () => {
  const t = pripravit();
  const zruseni = await t.zmenitStav('zrusena');
  assert.equal(zruseni.statusCode, 200);
  assert.equal(zruseni.body.storno_cislo, null);
  assert.equal(t.stav.faktury.length, 0);
  assert.equal(t.stav.stornoCislovani.length, 0, 'číslo se nespotřebuje');
});

test('storno: historická faktura (bez uloženého originálu) dostane opravný doklad z údajů objednávky', async () => {
  const t = pripravit({ stav: 'odeslana', faktura_cislo: '2026004', faktura_datum: new Date('2026-10-20T10:00:00Z') });
  const zruseni = await t.zmenitStav('zrusena');
  assert.equal(zruseni.statusCode, 200);
  assert.equal(t.stav.faktury.length, 1);
  const d = t.stav.faktury[0];
  assert.equal(d.druh, 'storno');
  assert.deepEqual(d.data.puvodni_doklad, { cislo: '2026004', datum_vystaveni: '2026-10-20T10:00:00.000Z', historicka: true });
  assert.equal(d.data.celkem, -579);
  assert.match(text(d.html), /vystavena před zavedením ukládání faktur/);
});

test('storno: selhání zápisu dokladu zrušení odmítne (stav se nezmění, nic se neuloží)', async () => {
  const t = pripravit({ stav: 'odeslana', faktura_cislo: '2026004', faktura_datum: new Date('2026-10-20T10:00:00Z') });
  t.stav.selhatZapisDokladu = true;
  const zruseni = await t.zmenitStav('zrusena');
  assert.equal(zruseni.statusCode, 500);
  assert.equal(t.o().stav, 'odeslana');
  assert.equal(t.stav.faktury.length, 0);
});

test('storno: šablona - nadpis, odkaz na fakturu, důvod, částky s opačným znaménkem, poukaz se vrací', () => {
  const { sestavitStorno, vykreslitDokument } = require('../lib/faktura');
  const f = sestavitSnimek({ id: 7, cislo: '261020', jmeno: 'Jana', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24', doprava: 'zasilkovna', platba: 'dobirka',
    doprava_cena: 79, platba_priplatek: 40, sleva: 100, poukaz_kod: 'DK-1', celkem: 1309, vytvoreno: '2026-10-20T10:00:00Z', zaplaceno_at: '2026-10-21T10:00:00Z',
    polozky: [{ nazev: 'Froddo', velikost: 26, pocet: 1, cena: 1290 }] }, { faktura_cislo: '2026005', faktura_datum: '2026-10-22T10:00:00Z' });
  const s = sestavitStorno(f, { cislo: 'OD2026001', datum_vystaveni: '2026-10-29T10:00:00Z', duvod: 'Zrušení objednávky' });
  const h = vykreslitDokument(s);
  assert.match(h, /<title>Opravný doklad OD2026001<\/title>/);
  const tt = text(h);
  for (const v of ['Opravný doklad OD2026001', 'Storno faktury 2026005', 'K faktuře 2026005 ze dne 22. 10. 2026', 'Důvod opravy: Zrušení objednávky. Tento doklad ruší fakturu 2026005 v plné výši.',
    'Zásilkovna (doprava) -79 Kč', 'Dobírka (příplatek) -40 Kč', 'Dárkový poukaz DK-1 100 Kč', 'CELKEM -1 309 Kč', 'Neplátce DPH']) {
    assert.ok(tt.includes(v), 'chybí: ' + v);
  }
  assert.doesNotMatch(tt, /Datum úhrady/, 'storno netvrdí úhradu');
  // faktura sama se změnou šablony nemění
  assert.doesNotMatch(text(vykreslitDokument(f)), /Opravný doklad|Storno/);
  assert.equal(s.polozky[0].cena, 1290, 'jednotková cena zůstává, záporný je počet a celkem');
});

test('storno: tisk a e-mail opravného dokladu z uložené podoby; bez storna 404', async () => {
  const poslane = [];
  const stav = pocatecniStav();
  stav.objednavky.push({ id: 7, cislo: '261020', stav: 'odeslana', zakaznik_id: 1, doprava: 'zasilkovna', platba: 'prevod', doprava_cena: 79, platba_priplatek: 0, sleva: 0, celkem: 579,
    vytvoreno: new Date('2026-10-20T10:00:00Z'), poukaz_id: null, obj_jmeno: 'Jana', obj_email: 'jana@example.com', obj_telefon: '777', obj_ulice: 'A 1', obj_mesto: 'Hulín', obj_psc: '76824' });
  stav.objednavkyPolozky.push({ objednavka_id: 7, produkt_id: 5, velikost: 26, pocet: 1, cena: 500, nazev: 'Bota' });
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': vytvoritMockPool(stav),
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {}, odeslat_fakturu: async () => {}, odeslat_storno: async d => poslane.push(d) }
  });
  const volat = async (method, cesta, body = {}) => { const res = vytvoritRes(); await najitHandler(router, method, cesta)({ params: { id: '7' }, body }, res); return res; };
  assert.equal((await volat('post', '/:id/storno-html')).statusCode, 404);
  assert.equal((await volat('post', '/:id/storno-email')).statusCode, 404);
  await volat('post', '/:id/faktura');
  await volat('patch', '/:id/stav', { stav: 'zrusena' });
  const tisk = await volat('post', '/:id/storno-html');
  assert.equal(tisk.statusCode, 200);
  assert.equal(tisk.body.html, stav.faktury[1].html);
  const email = await volat('post', '/:id/storno-email');
  assert.equal(email.statusCode, 200);
  assert.equal(poslane.length, 1);
  assert.equal(poslane[0].html, stav.faktury[1].html);
  assert.equal(poslane[0].faktura_cislo, stav.faktury[0].cislo);
  assert.equal(poslane[0].email, 'jana@example.com');
  assert.ok(stav.objednavky[0].storno_odeslano instanceof Date);
  const detail = await volat('get', '/:id');
  assert.equal(detail.body.storno.cislo, stav.faktury[1].cislo);
  // poškozený uložený doklad se nevydá
  stav.faktury[1].html += 'x';
  assert.equal((await volat('post', '/:id/storno-html')).statusCode, 500);
});
