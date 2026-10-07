// Krok 4a/4b - košík a objednávka ve krocích: součty, souhrn, potvrzení s VS,
// beze změny právních textů. Funkce se vytahují ze skutečného eshop.html
// (stejný vzor jako test/eshop-katalog.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ESHOP_HTML = fs.readFileSync(path.join(__dirname, '..', 'eshop.html'), 'utf8');

function vytahnout(nazev) {
  const start = ESHOP_HTML.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, `Funkce ${nazev} nebyla v eshop.html nalezena`);
  let hloubka = 0;
  // Tělo až za parametry - parametry můžou mít destrukturování ({ cislo, ... })
  for (let i = ESHOP_HTML.indexOf(') {', start) + 2; i < ESHOP_HTML.length; i++) {
    if (ESHOP_HTML[i] === '{') hloubka++;
    else if (ESHOP_HTML[i] === '}' && --hloubka === 0) return ESHOP_HTML.slice(start, i + 1);
  }
  throw new Error(`Konec funkce ${nazev} nenalezen`);
}
const konstanta = nazev => ESHOP_HTML.match(new RegExp(`const ${nazev} = [^;]+;`))[0];

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  ...['DOPRAVA_CENY', 'DOPRAVA_ZDARMA_OD', 'DOPRAVA_NAZVY', 'PLATBA_NAZVY', 'UCET_IBAN'].map(konstanta),
  ...['vypocitatDopravu', 'escHtml', 'escAttr', 'spocitatObjednavku', 'souhrnObjednavkyHtml', 'qrPlatbaUrl', 'potvrzeniObjednavkyHtml', 'shrnutiUdajuHtml'].map(vytahnout)
].join('\n'), sandbox);
const zavolat = (fn, ...args) => {
  const v = vm.runInContext(`${fn}(...${JSON.stringify(args)})`, sandbox);
  return v !== null && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
};

const POLOZKY = [{ nazev: 'Bota A', velikost: 24, pocet: 2, cena: 800 }, { nazev: 'Bota B', velikost: 25, pocet: 1, cena: 500 }];

test('součty: doprava zdarma od 2 000 Kč počítáno po slevě poukazu (stejně jako server)', () => {
  assert.deepEqual(zavolat('spocitatObjednavku', POLOZKY, null, 'zasilkovna'), { mezisoucet: 2100, sleva: 0, dopravaCena: 0, celkem: 2100 });
  assert.deepEqual(zavolat('spocitatObjednavku', POLOZKY, { zustatek: 500 }, 'ceska_posta'), { mezisoucet: 2100, sleva: 500, dopravaCena: 89, celkem: 1689 });
  assert.deepEqual(zavolat('spocitatObjednavku', POLOZKY, { zustatek: 5000 }, 'zasilkovna'), { mezisoucet: 2100, sleva: 2100, dopravaCena: 79, celkem: 79 });
  assert.equal(zavolat('spocitatObjednavku', [POLOZKY[1]], null, 'osobni_odber').celkem, 500);
});

test('souhrn: položky, poukaz, doprava, celkem; názvy a kód poukazu escapované', () => {
  const h = zavolat('souhrnObjednavkyHtml', [{ ...POLOZKY[1], nazev: '<img src=x onerror=alert(1)>' }], { zustatek: 100, kod: '"><b>K</b>' }, 'zasilkovna');
  assert.equal(h.includes('<img src=x'), false);
  assert.equal(h.includes('<b>K</b>'), false);
  assert.match(h, /vel\. 25 × 1<\/span><span>500 Kč/);
  assert.match(h, /−100 Kč/);
  assert.match(h, /Doprava \(Zásilkovna\)<\/span><span>79 Kč/);
  assert.match(h, /Celkem<\/span><span>479 Kč/);
});

test('QR platba: variabilní symbol jen z čísla objednávky, jinak bez VS', () => {
  const s = u => decodeURIComponent(u.split('data=')[1]);
  assert.equal(s(zavolat('qrPlatbaUrl', 1079, 'Eshop Detske krucky', '261012')), 'SPD*1.0*ACC:CZ4620100000002003533776*AM:1079.00*CC:CZK*X-VS:261012*MSG:Eshop Detske krucky');
  assert.doesNotMatch(s(zavolat('qrPlatbaUrl', 10, 'x', 'A1*X-KS:9')), /X-VS|X-KS/);
  assert.doesNotMatch(s(zavolat('qrPlatbaUrl', 10, 'x')), /X-VS/);
});

test('potvrzení: číslo objednávky, e-mail; u převodu účet, VS a částka ze serveru; u dobírky bez platebních údajů', () => {
  const prevod = zavolat('potvrzeniObjednavkyHtml', { cislo: '261012', celkem: 1079, email: 'jana@example.com', platba: 'prevod' });
  assert.match(prevod, /Číslo objednávky: <strong>261012<\/strong>/);
  assert.match(prevod, /Variabilní symbol: <strong>261012<\/strong>/);
  assert.match(prevod, /Částka: <strong>1079 Kč<\/strong>/);
  assert.match(prevod, /2003533776\/2010/);
  assert.match(prevod, /X-VS%3A261012/);
  // Vlastní text netvrdí přijetí (akceptaci) objednávky ani uzavření smlouvy - jen že ji máme
  assert.match(prevod, /Objednávku jsme obdrželi/);
  assert.doesNotMatch(prevod, /přijat|uzavřen/i);
  const dobirka = zavolat('potvrzeniObjednavkyHtml', { cislo: '261012', celkem: 1079, email: '<b>x</b>@a.cz', platba: 'dobirka' });
  assert.doesNotMatch(dobirka, /Variabilní symbol|QR/);
  assert.equal(dobirka.includes('<b>x</b>'), false);
  assert.doesNotMatch(zavolat('potvrzeniObjednavkyHtml', { cislo: 'x"1', celkem: 1, email: 'a@b.cz', platba: 'prevod' }), /Variabilní symbol/);
});

test('shrnutí údajů: osobní odběr ukáže prodejnu, jinak adresu; vše escapované', () => {
  const u = { jmeno: 'Jana <b>N</b>', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24', doprava: 'osobni_odber', platba: 'dobirka' };
  const odber = zavolat('shrnutiUdajuHtml', u);
  assert.match(odber, /Vyzvednutí na prodejně: Holešovská 752/);
  assert.match(odber, /Platba:<\/strong> Dobírka/);
  assert.equal(odber.includes('<b>N</b>'), false);
  assert.match(zavolat('shrnutiUdajuHtml', { ...u, doprava: 'zasilkovna' }), /Hlavní 1, 768 24 Hulín/);
});

test('právní texty formuláře beze změny: souhlas, odkaz na VOP, tlačítko až v posledním kroku', () => {
  assert.match(ESHOP_HTML, /Souhlasím s <a href="obchodni-podminky.html" target="_blank" style="color:var\(--brown\);font-weight:700">obchodními podmínkami<\/a> a zpracováním osobních údajů pro účely vyřízení objednávky\./);
  const krok3 = ESHOP_HTML.slice(ESHOP_HTML.indexOf('data-krok="3" aria-label="Shrnutí"'), ESHOP_HTML.indexOf('data-krok="4"'));
  assert.match(krok3, /id="submitBtn"/);
  assert.match(krok3, /id="chSouhlas"/);
  assert.match(krok3, /id="orderSummary"/);
  assert.equal(ESHOP_HTML.includes('id="chPrevodQr"'), false, 'QR bez variabilního symbolu před objednávkou už není');
});

test('potvrzení: platba na prodejně bez platebních údajů, s informací o placení při vyzvednutí', () => {
  const h = zavolat('potvrzeniObjednavkyHtml', { cislo: '261012', celkem: 690, email: 'jana@example.com', platba: 'na_prodejne' });
  assert.match(h, /Zaplatíte při vyzvednutí na prodejně \(hotově, kartou nebo QR kódem\)/);
  assert.doesNotMatch(h, /Variabilní symbol|2003533776/);
  assert.match(zavolat('shrnutiUdajuHtml', { jmeno: 'Jana N', email: 'a@b.cz', telefon: '777 123 456', ulice: 'A 1', mesto: 'B', psc: '768 24', doprava: 'osobni_odber', platba: 'na_prodejne' }), /Platba:<\/strong> Na prodejně při vyzvednutí/);
});
