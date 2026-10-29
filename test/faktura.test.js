// Faktura k objednávce: šablona (lib/faktura.js), uložená neměnná podoba
// (lib/vystaveniFaktury.js), e-mail s fakturou, tisk a tlačítka v adminu
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakturaHtml, fakturaObsahHtml, obsahDokumentu } = require('../lib/faktura');
const { otisk } = require('../lib/vystaveniFaktury');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const FAKTURA = { faktura_cislo: '2026007', faktura_datum: new Date('2026-10-27T10:00:00Z') };
const OBJ = {
  id: 41, cislo: '261012', stav: 'odeslana', jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456',
  ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24', doprava: 'zasilkovna', platba: 'dobirka',
  doprava_cena: 79, platba_priplatek: 40, sleva: 100, poukaz_kod: 'DK-AAAA-BBBB', celkem: 1309,
  vydejni_misto_id: '123', vydejni_misto_nazev: 'Hulín, Trávník 1', vydejni_misto_ulice: 'Trávník 1', vydejni_misto_mesto: 'Hulín', vydejni_misto_psc: '76824',
  vytvoreno: new Date('2026-10-26T10:00:00Z'),
  polozky: [{ nazev: 'Froddo Barefoot', velikost: 26, pocet: 1, cena: 1290 }]
};
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('šablona: dodavatel, odběratel, číslo a datum, položky, doprava, dobírka, poukaz, celkem', () => {
  const t = text(fakturaObsahHtml(OBJ, FAKTURA));
  for (const s of ['Faktura 2026007', 'Objednávka #261012', 'Datum vystavení: 27. 10. 2026', 'Monika Škarpichová', 'IČO: 24354635',
    'Jana Nováková', 'Hlavní 1, Hulín 768 24', 'Froddo Barefoot', '1 290 Kč', 'Zásilkovna (doprava) 79 Kč', 'Dobírka (příplatek) 40 Kč',
    'Dárkový poukaz DK-AAAA-BBBB −100 Kč', 'CELKEM 1 309 Kč', 'Výdejní místo: Hulín, Trávník 1, Trávník 1, 76824 Hulín', 'Platba: Dobírka']) {
    assert.ok(t.includes(s), `chybí: ${s}`);
  }
  assert.match(fakturaHtml(OBJ, FAKTURA), /^<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><title>Faktura 2026007<\/title>/);
});

test('prodávající: sídlo (místo podnikání) a provozovna rozlišené, IČO, zápis v živnostenském rejstříku, neplátce DPH', () => {
  const t = text(fakturaObsahHtml(OBJ, FAKTURA));
  const dodavatel = t.slice(t.indexOf('Dodavatel'), t.indexOf('Odběratel'));
  assert.ok(dodavatel.includes('Monika Škarpichová'));
  assert.ok(dodavatel.includes('Sídlo: Včelín 1164, 768 24 Hulín'), 'sídlo = místo podnikání podle ARES');
  assert.ok(dodavatel.includes('Provozovna: Holešovská 752, 768 24 Hulín'));
  assert.ok(dodavatel.includes('IČO: 24354635'));
  assert.ok(dodavatel.includes('Fyzická osoba zapsaná v živnostenském rejstříku vedeném Městským úřadem Kroměříž.'));
  assert.ok(dodavatel.includes('Neplátce DPH'));
  assert.doesNotMatch(dodavatel, /DIČ|obchodním rejstříku/, 'žádné neexistující údaje');
  assert.doesNotMatch(t, /DPH \d|sazba|základ daně/i, 'neplátce DPH nevyčísluje');
});

test('prodávající: stejné sídlo a IČO jako obchodní podmínky (jediný zdroj pro zákazníka)', () => {
  const vop = fs.readFileSync(path.join(__dirname, '..', 'obchodni-podminky.html'), 'utf8');
  const { PRODAVAJICI } = require('../lib/faktura');
  assert.ok(vop.includes(`Adresa sídla: ${PRODAVAJICI.sidlo}`));
  assert.ok(vop.includes(`Adresa prodejny: ${PRODAVAJICI.provozovna}`));
  assert.ok(vop.includes(`IČO: ${PRODAVAJICI.ico}`));
});

test('šablona: údaje zákazníka a produktu escapované, doprava zdarma', () => {
  const h = fakturaObsahHtml({ ...OBJ, jmeno: '<img src=x onerror=alert(1)>', polozky: [{ nazev: '<b>X</b>', velikost: 25, pocet: 2, cena: 500 }], doprava_cena: 0, sleva: 0, platba_priplatek: 0, vydejni_misto_id: null }, FAKTURA);
  assert.equal(h.includes('<img src=x'), false);
  assert.equal(h.includes('<b>X</b>'), false);
  assert.match(text(h), /Zásilkovna \(doprava\) Zdarma/);
  assert.doesNotMatch(text(h), /Poukaz|Výdejní místo/);
});

test('e-mail: posílá přesně uloženou fakturu - obsah v těle, celý dokument v příloze', async () => {
  const emailyPath = require.resolve('../routes/emaily.js');
  delete require.cache[emailyPath];
  const puvodniFetch = global.fetch, puvodniKlic = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test';
  const zachycene = [];
  global.fetch = async (url, opts) => { zachycene.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ id: 'mock' }) }; };
  const ulozeneHtml = fakturaHtml(OBJ, FAKTURA);
  try {
    await require(emailyPath).odeslat_fakturu({ email: 'jana@example.com', jmeno: 'Jana <b>N</b>', cislo_objednavky: '261012', faktura_cislo: '2026007', html: ulozeneHtml });
  } finally {
    global.fetch = puvodniFetch;
    if (puvodniKlic === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = puvodniKlic;
    delete require.cache[emailyPath];
  }
  assert.equal(zachycene.length, 1);
  const e = zachycene[0];
  assert.deepEqual(e.to, ['jana@example.com']);
  assert.equal(e.subject, 'Faktura 2026007 k objednávce #261012 – Dětské krůčky');
  assert.ok(e.html.includes(obsahDokumentu(ulozeneHtml)), 'tělo obsahuje uložený obsah beze změny');
  assert.equal(e.html.includes('<b>N</b>'), false);
  assert.equal(e.attachments[0].filename, 'faktura-2026007.html');
  assert.equal(Buffer.from(e.attachments[0].content, 'base64').toString('utf8'), ulozeneHtml, 'příloha = uložený dokument beze změny');
});

// --- Routy nad paměťovou DB (test-helpers) ---
function stavSObjednavkou(prepis = {}) {
  const stav = pocatecniStav();
  stav.objednavky.push({
    id: 41, cislo: '261012', stav: 'odeslana', zakaznik_id: 1, doprava: 'zasilkovna', platba: 'prevod', doprava_cena: 79, platba_priplatek: 0,
    sleva: 0, celkem: 1369, vytvoreno: new Date('2026-10-26T10:00:00Z'),
    obj_jmeno: 'Jana Nováková', obj_email: 'jana@example.com', obj_telefon: '777 123 456', obj_ulice: 'Hlavní 1', obj_mesto: 'Hulín', obj_psc: '768 24',
    ...prepis
  });
  // paměťová DB vrací název produktu přímo s položkou (jako JOIN na produkty)
  stav.objednavkyPolozky.push({ objednavka_id: 41, produkt_id: 5, velikost: 26, pocet: 1, cena: 1290, nazev: 'Froddo Barefoot', znacka: 'Froddo' });
  return stav;
}
function routyFaktury(stav, odeslat = async () => {}) {
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': vytvoritMockPool(stav),
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {}, odeslat_fakturu: odeslat }
  });
  const zavolat = async (cesta, method = 'post', id = '41') => { const res = vytvoritRes(); await najitHandler(router, method, cesta)({ params: { id }, body: {} }, res); return res; };
  return { html: () => zavolat('/:id/faktura-html'), email: () => zavolat('/:id/faktura-email'), detail: () => zavolat('/:id', 'get') };
}

test('neměnnost: první vystavení uloží snímek i HTML s otiskem, opakovaný tisk vrátí přesně totéž', async () => {
  const stav = stavSObjednavkou();
  const r = routyFaktury(stav);
  const prvni = await r.html();
  assert.equal(prvni.statusCode, 200);
  assert.equal(stav.faktury.length, 1);
  const f = stav.faktury[0];
  assert.equal(f.cislo, prvni.body.faktura_cislo);
  assert.equal(f.html, prvni.body.html);
  assert.equal(f.html_sha256, otisk(f.html));
  assert.equal(f.data.polozky[0].nazev, 'Froddo Barefoot');
  assert.equal(f.data.prodavajici.sidlo, 'Včelín 1164, 768 24 Hulín');
  assert.equal(stav.objednavky[0].faktura_cislo, f.cislo, 'číslo i u objednávky (přehledy)');
  const druhy = await r.html();
  assert.equal(druhy.body.html, prvni.body.html);
  assert.equal(druhy.body.faktura_cislo, prvni.body.faktura_cislo);
  assert.equal(stav.faktury.length, 1, 'žádná druhá faktura');
  assert.equal((await r.detail()).body.faktura_ulozena.cislo, f.cislo);
});

test('neměnnost: přejmenování produktu, změna ceny, adresy prodávající ani šablony doklad nezmění', async () => {
  const stav = stavSObjednavkou();
  const r = routyFaktury(stav);
  const puvodni = (await r.html()).body.html;
  stav.objednavkyPolozky[0].nazev = 'Úplně jiný název';
  stav.objednavkyPolozky[0].cena = 9999;
  const { PRODAVAJICI } = require('../lib/faktura');
  const sidlo = PRODAVAJICI.sidlo;
  PRODAVAJICI.sidlo = 'Jinde 1, 100 00 Praha';
  try {
    const znovu = (await r.html()).body.html;
    assert.equal(znovu, puvodni);
    assert.ok(znovu.includes('Froddo Barefoot') && znovu.includes('Včelín 1164') && !znovu.includes('9 999'));
  } finally { PRODAVAJICI.sidlo = sidlo; }
});

test('neměnnost: opětovné odeslání posílá stejnou uloženou fakturu, nevystaví novou', async () => {
  const stav = stavSObjednavkou();
  const poslane = [];
  const r = routyFaktury(stav, async f => poslane.push(f));
  const vytisteno = (await r.html()).body.html;
  stav.objednavkyPolozky[0].nazev = 'Přejmenováno';
  assert.equal((await r.email()).statusCode, 200);
  assert.equal((await r.email()).statusCode, 200);
  assert.equal(poslane.length, 2);
  assert.ok(poslane.every(p => p.html === vytisteno && p.faktura_cislo === stav.faktury[0].cislo && p.email === 'jana@example.com'));
  assert.equal(stav.faktury.length, 1);
});

test('neměnnost: poškozený uložený doklad (nesedí otisk) se nevydá', async () => {
  const stav = stavSObjednavkou();
  const r = routyFaktury(stav);
  await r.html();
  stav.faktury[0].html = stav.faktury[0].html.replace('Froddo Barefoot', 'Jiné zboží');
  const res = await r.html();
  assert.equal(res.statusCode, 500);
  assert.match(res.body.chyba, /neodpovídá svému otisku/);
});

test('historická faktura (číslo bez uloženého originálu): žádný zpětný snímek, tisk jen jako označená rekonstrukce, e-mail ne', async () => {
  const stav = stavSObjednavkou({ faktura_cislo: '2026004', faktura_datum: new Date('2026-10-27T09:00:00Z') });
  const poslane = [];
  const r = routyFaktury(stav, async f => poslane.push(f));
  const tisk = await r.html();
  assert.equal(tisk.statusCode, 200);
  assert.equal(tisk.body.historicka, true);
  assert.equal(tisk.body.faktura_cislo, '2026004');
  assert.match(text(tisk.body.html), /originál není v systému uložen\. Toto je rekonstrukce/);
  assert.equal(stav.faktury.length, 0, 'zpětně se nic neukládá');
  assert.equal(stav.fakturyCislovani.length, 0, 'nové číslo se nespotřebuje');
  const email = await r.email();
  assert.equal(email.statusCode, 409);
  assert.match(email.body.chyba, /originál v systému není/);
  assert.equal(poslane.length, 0);
});

test('zrušená objednávka bez faktury: nová faktura se nevystaví ani tiskem, ani e-mailem', async () => {
  const stav = stavSObjednavkou({ stav: 'zrusena' });
  const r = routyFaktury(stav);
  assert.equal((await r.html()).statusCode, 400);
  assert.equal((await r.email()).statusCode, 400);
  assert.equal(stav.faktury.length, 0);
  assert.equal(stav.fakturyCislovani.length, 0);
});

test('Poslat fakturu: chyba odeslání se vrátí adminu, čas odeslání se nezapíše, faktura zůstane', async () => {
  const stav = stavSObjednavkou();
  const r = routyFaktury(stav, async () => { throw new Error('Resend 500'); });
  const res = await r.email();
  assert.equal(res.statusCode, 502);
  assert.match(res.body.chyba, /Resend 500/);
  assert.equal(stav.objednavky[0].faktura_odeslano, undefined);
  assert.equal(stav.faktury.length, 1, 'vystavená faktura platí, i když se e-mail nepodařil');
});

test('admin: tlačítko Poslat fakturu skryté u zrušené a u historické faktury, tisk z uložené podoby', () => {
  assert.match(ADMIN, /id="btnPoslatFakturu" onclick="poslatFakturu\(\)">📧 Poslat fakturu</);
  assert.match(ADMIN, /btnF\.hidden = data\.stav === 'zrusena' \|\| !data\.email \|\| \(!!data\.faktura_cislo && !data\.faktura_ulozena\);/);
  assert.match(ADMIN, /API\+'\/objednavky\/'\+id\+'\/faktura-email', \{method:'POST'\}/);
  assert.match(ADMIN, /API\+'\/objednavky\/'\+id\+'\/faktura-html', \{method:'POST'\}/);
  assert.match(ADMIN, /historická<\/strong> – originál není uložený/);
  assert.match(ADMIN, /Stornována opravným dokladem/);
  assert.match(ADMIN, /API\+'\/objednavky\/'\+id\+'\/storno-html', \{method:'POST'\}/);
  assert.match(ADMIN, /API\+'\/objednavky\/'\+id\+'\/storno-email', \{method:'POST'\}/);
});

// --- Etapa 2.2: Z1 položky a částky, Z3 zrušená objednávka, S5 rekonstrukce ---
test('Z1: produkt odstraněný z katalogu položku z faktury nevypustí - zůstane s náhradním názvem a uloženou cenou', async () => {
  const stav = stavSObjednavkou();
  stav.objednavkyPolozky[0].produkt_smazan = true;
  const res = await routyFaktury(stav).html();
  assert.equal(res.statusCode, 200);
  const f = stav.faktury[0];
  assert.deepEqual(f.data.polozky.map(p => [p.nazev, p.cena, p.pocet]), [['Produkt již není v katalogu', 1290, 1]]);
  assert.match(text(res.body.html), /Produkt již není v katalogu 26 1 1 290 Kč/);
});

test('Z1: nesouhlasící částky - faktura nevznikne, číslo se nespotřebuje, objednávka beze změny', async () => {
  for (const [popis, prepis] of [['celkem o korunu víc', { celkem: 1370 }], ['chybí cena dopravy (starší objednávka)', { doprava_cena: null }], ['neplatná sleva', { sleva: 'x' }]]) {
    const stav = stavSObjednavkou(prepis);
    const r = routyFaktury(stav);
    const res = await r.html();
    assert.equal(res.statusCode, 422, popis);
    assert.match(res.body.chyba, /^Fakturu nelze vystavit: /, popis);
    assert.equal(stav.faktury.length, 0, popis);
    assert.equal(stav.fakturyCislovani.length, 0, popis + ': číslo se nespotřebuje');
    assert.equal(stav.objednavky[0].faktura_cislo, undefined, popis);
    assert.equal((await r.email()).statusCode, 422, popis + ': ani e-mailem');
  }
});

test('Z1: kontrola částek - stejné pravidlo jako objednávka (sleva, doprava, dobírka), v haléřích', () => {
  const { chybaCastek } = require('../lib/vystaveniFaktury');
  const pol = [{ cena: 1290, pocet: 1 }, { cena: '199.90', pocet: 2 }];
  assert.equal(chybaCastek({ celkem: '1708.80', doprava_cena: '79', platba_priplatek: '40', sleva: '100' }, pol), null);
  assert.match(chybaCastek({ celkem: 1708.79, doprava_cena: 79, platba_priplatek: 40, sleva: 100 }, pol), /nesouhlasí/);
  assert.equal(chybaCastek({ celkem: 1629, doprava_cena: 0, platba_priplatek: null, sleva: null }, [{ cena: 1629, pocet: 1 }]), null, 'chybějící příplatek a sleva = 0');
  assert.match(chybaCastek({ celkem: 0, doprava_cena: 0 }, []), /žádné položky/);
  assert.match(chybaCastek({ celkem: 500, doprava_cena: 0 }, [{ cena: 500, pocet: 0 }]), /platný počet/);
});

test('Z3: zrušená objednávka s uloženou fakturou - e-mail server odmítne, tisk originálu zůstává', async () => {
  const stav = stavSObjednavkou();
  const poslane = [];
  const r = routyFaktury(stav, async f => poslane.push(f));
  const originál = (await r.html()).body.html;
  stav.objednavky[0].stav = 'zrusena';
  const email = await r.email();
  assert.equal(email.statusCode, 400);
  assert.match(email.body.chyba, /zrušené objednávky nelze posílat e-mailem/);
  assert.equal(poslane.length, 0);
  const tisk = await r.html();
  assert.equal(tisk.statusCode, 200);
  assert.equal(tisk.body.html, originál, 'tisk vrací původní uložený doklad');
  assert.equal(stav.faktury.length, 1);
});

test('Z3: kontrola zrušení i podle stavu pod zámkem (zrušení mezi kontrolou a vystavením)', () => {
  const kod = fs.readFileSync(path.join(__dirname, '..', 'routes', 'objednavky.js'), 'utf8');
  const email = kod.slice(kod.indexOf("router.post('/:id/faktura-email'"), kod.indexOf('// Stav objednávky -> sloupec'));
  assert.match(email, /if \(o\.stav === 'zrusena'\) return res\.status\(400\)/);
  assert.match(email, /if \(v\.stav_objednavky === 'zrusena'\) return res\.status\(400\)/);
  assert.ok(email.indexOf("v.stav_objednavky === 'zrusena'") < email.indexOf('await odeslat_fakturu'));
});

test('S5: rekonstrukce historické faktury má nadpis REKONSTRUKCE FAKTURY a vysvětlení nahoře i dole', async () => {
  const stav = stavSObjednavkou({ faktura_cislo: '2026004', faktura_datum: new Date('2026-10-27T09:00:00Z') });
  const res = await routyFaktury(stav).html();
  const h = res.body.html;
  assert.match(h, /<title>Rekonstrukce faktury 2026004<\/title>/);
  assert.match(h, /<h1[^>]*>REKONSTRUKCE FAKTURY 2026004<\/h1>/);
  assert.doesNotMatch(h, /<h1[^>]*>Faktura /);
  assert.equal(h.match(/REKONSTRUKCE – NEJDE O ORIGINÁL DOKLADU\./g).length, 2, 'nahoře i dole');
  assert.ok(text(h).includes('originál není v systému uložen. Toto je rekonstrukce'));
  assert.equal(stav.faktury.length, 0);
  assert.equal(stav.objednavky[0].faktura_cislo, '2026004');
  // běžná faktura označení nemá
  const bezna = fakturaHtml(OBJ, FAKTURA);
  assert.doesNotMatch(bezna, /REKONSTRUKCE/);
  assert.match(bezna, /<h1[^>]*>Faktura 2026007<\/h1>/);
});

// --- Etapa 2.3: N5 odeslání vs. evidence odeslání, N6 položky smazaných produktů ---
async function sZachycenymLogem(fn) {
  const logy = [];
  const puvodni = console.error;
  console.error = (...a) => logy.push(a.map(String).join(' '));
  try { return { vysledek: await fn(), logy }; } finally { console.error = puvodni; }
}

test('N5: e-mailová služba odeslání odmítne - 502 „nepodařilo odeslat“, čas odeslání se nezapíše, žádné varování', async () => {
  const stav = stavSObjednavkou();
  let pokusy = 0;
  const r = routyFaktury(stav, async () => { pokusy++; throw new Error('Resend 422: invalid'); });
  const { vysledek: res } = await sZachycenymLogem(() => r.email());
  assert.equal(res.statusCode, 502);
  assert.match(res.body.chyba, /^Fakturu se nepodařilo odeslat: Resend 422/);
  assert.equal(res.body.ok, undefined);
  assert.equal(stav.objednavky[0].faktura_odeslano, undefined);
  assert.equal(pokusy, 1, 'žádné automatické opakování');
});

test('N5: e-mail přijat, zápis času odeslání selže - odpověď nepředstírá neodeslání, nic se nezopakuje, log bez osobních údajů', async () => {
  const stav = stavSObjednavkou();
  stav.selhatZapisOdeslani = true;
  const poslane = [];
  const r = routyFaktury(stav, async f => poslane.push(f));
  const { vysledek: res, logy } = await sZachycenymLogem(() => r.email());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.faktura_cislo, stav.faktury[0].cislo);
  assert.equal(res.body.faktura_odeslano, null, 'nevymyšlený čas odeslání');
  assert.match(res.body.varovani, /předán k odeslání, ale čas odeslání se nepodařilo uložit/);
  assert.match(res.body.varovani, /znovu neposílejte/);
  assert.doesNotMatch(JSON.stringify(res.body), /doručen|nepodařilo odeslat/);
  assert.equal(poslane.length, 1, 'odesláno právě jednou, bez opakování');
  assert.equal(stav.objednavky[0].faktura_odeslano, undefined, 'žádný falešný stav odeslání');
  assert.equal(stav.faktury.length, 1);
  // dohledatelný záznam: číslo faktury a objednávky + chyba, ale bez e-mailu, jména a obsahu dokladu
  assert.equal(logy.length, 1);
  assert.match(logy[0], new RegExp('Faktura ' + stav.faktury[0].cislo + ' předána k odeslání.*objednávka 41.*spojení s databází přerušeno'));
  assert.doesNotMatch(logy[0], /jana@example\.com|Nováková|Froddo|<html|<table/i);
});

test('N5: běžné odeslání bez chyby - čas odeslání zapsaný, bez varování', async () => {
  const stav = stavSObjednavkou();
  const res = await routyFaktury(stav).email();
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.faktura_odeslano instanceof Date);
  assert.equal(res.body.varovani, undefined);
  assert.ok(stav.objednavky[0].faktura_odeslano instanceof Date);
});

test('N5 admin: hláška říká „předána k odeslání“ (ne doručena) a ukáže varování serveru', () => {
  assert.match(ADMIN, /' předána k odeslání na ' \+ data\.email \+ '\.' \+ \(data\.varovani \? '\\n\\n⚠️ ' \+ data\.varovani : ''\)/);
});

test('N6: produkt smazaný z katalogu - detail objednávky položku ukáže s náhradním názvem, uloženou cenou a počtem', async () => {
  const stav = stavSObjednavkou();
  stav.objednavkyPolozky.push({ objednavka_id: 41, produkt_id: 9, velikost: 24, pocet: 2, cena: 500, produkt_smazan: true });
  const res = await routyFaktury(stav).detail();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.polozky.map(p => [p.nazev, p.znacka, p.velikost, p.pocet, p.cena]),
    [['Froddo Barefoot', 'Froddo', 26, 1, 1290], ['Produkt již není v katalogu', null, 24, 2, 500]]);
  assert.ok(res.body.polozky.every(p => !('produkt_nazev' in p) && !('produkt_znacka' in p)));
});

test('N6: rekonstrukce historické faktury nevypustí položku smazaného produktu, součet položek sedí s CELKEM', async () => {
  const stav = stavSObjednavkou({ faktura_cislo: '2026004', faktura_datum: new Date('2026-10-27T09:00:00Z'), celkem: 2369 });
  stav.objednavkyPolozky.push({ objednavka_id: 41, produkt_id: 9, velikost: 24, pocet: 2, cena: 500, produkt_smazan: true });
  const res = await routyFaktury(stav).html();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.historicka, true);
  const t = text(res.body.html);
  assert.match(t, /Froddo Barefoot 26 1 1 290 Kč 1 290 Kč/);
  assert.match(t, /Produkt již není v katalogu 24 2 500 Kč 1 000 Kč/);
  assert.match(t, /REKONSTRUKCE FAKTURY 2026004/);
  // 1 290 + 1 000 + doprava 79 = 2 369 = celkem objednávky
  assert.match(t, /CELKEM 2 369 Kč/);
  assert.equal(stav.faktury.length, 0, 'rekonstrukce se neukládá');
});
