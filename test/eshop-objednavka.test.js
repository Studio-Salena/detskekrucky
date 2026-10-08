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
  ...['DOPRAVA_VYCHOZI', 'DOPRAVA_NAZVY', 'PLATBA_NAZVY', 'UCET_IBAN', 'CHYBA_BEZ_VYDEJNIHO_MISTA', 'CHYBA_BEZ_MISTA_ZASILKOVNY'].map(konstanta),
  'var nastaveniDopravy = DOPRAVA_VYCHOZI; var glsVydejniMisto = null; var zasVydejniMisto = null;',
  ...['vypocitatDopravu', 'escHtml', 'escAttr', 'spocitatObjednavku', 'souhrnObjednavkyHtml', 'qrPlatbaUrl', 'potvrzeniObjednavkyHtml', 'shrnutiUdajuHtml',
    'jeVydejniMistoGls', 'jeVydejniMistoZasilkovny', 'chybaVydejnihoMista', 'vybraneVydejniMisto', 'adresaVydejnihoMista', 'platneNastaveniDopravy'].map(vytahnout)
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

test('právní texty formuláře: souhlas jen s VOP (varianta A), informace o osobních údajích bez zaškrtávání, dodací lhůta, tlačítko až v posledním kroku', () => {
  assert.match(ESHOP_HTML, /Seznámil\(a\) jsem se s <a href="obchodni-podminky.html" target="_blank" style="color:var\(--brown\);font-weight:700">obchodními podmínkami<\/a> a souhlasím s nimi\./);
  assert.match(ESHOP_HTML, /<p class="osobni-udaje-info">Osobní údaje zpracováváme za účelem vyřízení objednávky\. Podrobnosti najdete v bodě 7 <a href="obchodni-podminky.html#gdpr" target="_blank">obchodních podmínek<\/a> \(Ochrana osobních údajů\)\.<\/p>/);
  assert.doesNotMatch(ESHOP_HTML, /zpracováním osobních údajů pro účely vyřízení objednávky/);
  assert.match(ESHOP_HTML, /Zboží skladem odešleme do 2&nbsp;pracovních dnů od připsání platby/);
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

// --- Doprava z nastavení a výdejní místo GLS (2026-10) ---
const nastavitDopravu = d => vm.runInContext(`nastaveniDopravy = ${JSON.stringify(d)}; glsVydejniMisto = null; zasVydejniMisto = null;`, sandbox);
const SE_GLS = {
  zdarmaOd: 2000,
  metody: [
    { kod: 'zasilkovna', nazev: 'Zásilkovna', cena: 85, vydejniMisto: null, vzdyZdarma: false },
    { kod: 'gls_vydejni_misto', nazev: 'GLS – doručení do výdejního místa', cena: 69, vydejniMisto: 'gls', vzdyZdarma: false },
    { kod: 'osobni_odber', nazev: 'Osobní odběr – prodejna Hulín', cena: 0, vydejniMisto: null, vzdyZdarma: true }
  ]
};

test('doprava: výchozí ceny = dosavadní (79/89/0, zdarma od 2 000 Kč), GLS ve výchozí nabídce není', () => {
  nastavitDopravu(JSON.parse(JSON.stringify(vm.runInContext('DOPRAVA_VYCHOZI', sandbox))));
  assert.equal(zavolat('vypocitatDopravu', 'zasilkovna', 1999), 79);
  assert.equal(zavolat('vypocitatDopravu', 'ceska_posta', 100), 89);
  assert.equal(zavolat('vypocitatDopravu', 'zasilkovna', 2000), 0);
  assert.equal(zavolat('vypocitatDopravu', 'osobni_odber', 100), 0);
  assert.equal(zavolat('jeVydejniMistoGls', 'gls_vydejni_misto'), false);
});

test('doprava: ceny z nastavení serveru, zdarma od podle nastavení, prázdné = nikdy zdarma', () => {
  nastavitDopravu(SE_GLS);
  assert.equal(zavolat('vypocitatDopravu', 'zasilkovna', 500), 85);
  assert.equal(zavolat('vypocitatDopravu', 'gls_vydejni_misto', 500), 69);
  assert.equal(zavolat('vypocitatDopravu', 'gls_vydejni_misto', 2500), 0);
  nastavitDopravu({ ...SE_GLS, zdarmaOd: null });
  assert.equal(zavolat('vypocitatDopravu', 'gls_vydejni_misto', 99999), 69);
  assert.equal(zavolat('vypocitatDopravu', 'osobni_odber', 10), 0);
});

test('doprava: nevalidní odpověď serveru se nepoužije (zůstanou výchozí ceny)', () => {
  assert.equal(zavolat('platneNastaveniDopravy', SE_GLS), true);
  assert.equal(zavolat('platneNastaveniDopravy', { zdarmaOd: 2000, metody: [] }), false);
  assert.equal(zavolat('platneNastaveniDopravy', { zdarmaOd: 2000, metody: [{ kod: 'gls_adresa', nazev: 'GLS', cena: null }] }), false);
  assert.equal(zavolat('platneNastaveniDopravy', null), false);
});

test('výdejní místo GLS: bez vybraného místa přesná chybová hláška, u jiné dopravy se nevyžaduje', () => {
  nastavitDopravu(SE_GLS);
  assert.equal(zavolat('chybaVydejnihoMista', 'gls_vydejni_misto'), 'Pro doručení do výdejního místa GLS nejprve vyberte výdejní místo.');
  assert.equal(zavolat('chybaVydejnihoMista', 'zasilkovna'), null);
  vm.runInContext(`glsVydejniMisto = { id: '39301-ELPESRO', nazev: 'Elpe', ulice: 'Myslotínská 2449', mesto: 'Pelhřimov', psc: '39301' };`, sandbox);
  assert.equal(zavolat('chybaVydejnihoMista', 'gls_vydejni_misto'), null);
});

test('výdejní místo Zásilkovny: povinné jen s mapou (klíč ze serveru), jinak Zásilkovna jako dřív', () => {
  nastavitDopravu(SE_GLS);
  assert.equal(zavolat('chybaVydejnihoMista', 'zasilkovna'), null);
  const sMapou = { ...SE_GLS, zasilkovnaKlic: 'abcdef0123456789', metody: SE_GLS.metody.map(m => m.kod === 'zasilkovna' ? { ...m, vydejniMisto: 'zasilkovna' } : m) };
  nastavitDopravu(sMapou);
  assert.equal(zavolat('platneNastaveniDopravy', sMapou), true);
  assert.equal(zavolat('chybaVydejnihoMista', 'zasilkovna'), 'Pro doručení Zásilkovnou nejprve vyberte výdejní místo.');
  assert.equal(zavolat('chybaVydejnihoMista', 'gls_vydejni_misto'), 'Pro doručení do výdejního místa GLS nejprve vyberte výdejní místo.');
  vm.runInContext(`zasVydejniMisto = { id: '12345', nazev: 'Zlín, Kvítková 1', ulice: 'Kvítková 1', mesto: 'Zlín', psc: '76001' };`, sandbox);
  assert.equal(zavolat('chybaVydejnihoMista', 'zasilkovna'), null);
  assert.equal(zavolat('vybraneVydejniMisto', 'zasilkovna').id, '12345');
  assert.equal(zavolat('vybraneVydejniMisto', 'ceska_posta'), null);
  // bez klíče (např. špatné nastavení) se mapa nevyžaduje
  nastavitDopravu({ ...sMapou, zasilkovnaKlic: null });
  assert.equal(zavolat('chybaVydejnihoMista', 'zasilkovna'), null);
  assert.equal(zavolat('platneNastaveniDopravy', { ...sMapou, zasilkovnaKlic: 5 }), false);
});

test('widget Zásilkovny: knihovna z widget.packeta.com, místo jen jako text, jen ČR a místa Zásilkovny', () => {
  assert.match(ESHOP_HTML, /const ZASILKOVNA_KNIHOVNA = 'https:\/\/widget\.packeta\.com\/v6\/www\/js\/library\.js';/);
  const prevzit = vytahnout('prevzitMistoZasilkovny');
  assert.match(prevzit, /misto\.stat !== 'cz'/);
  assert.match(prevzit, /misto\.typ !== 'internal'/);
  assert.doesNotMatch(vytahnout('vykreslitVydejniMistoZasilkovny'), /innerHTML/);
});

test('shrnutí: výdejní místo GLS místo doručovací adresy, adresa zákazníka zvlášť; vše escapované', () => {
  nastavitDopravu(SE_GLS);
  const u = { jmeno: 'Jana N', email: 'a@b.cz', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24', doprava: 'gls_vydejni_misto', platba: 'prevod',
    vydejniMisto: { id: 'X1-ABC', nazev: '<img src=x onerror=alert(1)>', ulice: 'A&B 1', mesto: 'Brno', psc: '60200' } };
  const h = zavolat('shrnutiUdajuHtml', u);
  assert.match(h, /Doprava:<\/strong> GLS – doručení do výdejního místa/);
  assert.match(h, /Výdejní místo: &lt;img src=x onerror=alert\(1\)&gt;, A&amp;B 1, 60200 Brno/);
  assert.equal(h.includes('<img'), false);
  assert.match(h, /Hlavní 1, 768 24 Hulín/);
  // přepnutí zpět na adresu: údaje výdejního místa se nepoužijí
  assert.doesNotMatch(zavolat('shrnutiUdajuHtml', { ...u, doprava: 'zasilkovna', vydejniMisto: null }), /Výdejní místo/);
});

test('mapa GLS: zprávy jen z našeho iframe a domény GLS, údaje místa jen jako text, ID se ověřuje na serveru', () => {
  const zpracovani = vytahnout('zpracovatZpravuMapyGls');
  assert.match(zpracovani, /e\.source !== glsMapaIframe\.contentWindow\) return;/);
  assert.match(zpracovani, /if \(!GLS_MAPA_ORIGINY\.includes\(e\.origin\)\) return;/);
  assert.match(zpracovani, /GLS_ID_RE\.test\(id\)/);
  assert.match(zpracovani, /overitVydejniMistoGls\(id\)/);
  assert.doesNotMatch(zpracovani, /innerHTML|detail\.name|detail\.address/);
  assert.match(konstanta('GLS_MAPA_ORIGINY'), /\['https:\/\/ps-maps\.gls-czech\.cz', 'https:\/\/ps-maps\.gls-czech\.com'\]/);
  assert.doesNotMatch(vytahnout('vykreslitVydejniMistoGls'), /innerHTML/);
  assert.match(vytahnout('overitVydejniMistoGls'), /API \+ '\/doprava\/gls-misto\/' \+ encodeURIComponent\(id\)/);
  assert.equal(/gls_psd_widget\.js/.test(ESHOP_HTML), false, 'skript widgetu GLS se nevkládá');
  assert.equal(/GLS_(PASSWORD|USERNAME|CLIENT_NUMBER)/.test(ESHOP_HTML), false);
});

test('objednávka posílá ID výdejního místa jen u dopravy do výdejního místa', () => {
  const odeslani = vytahnout('odeslatObjednavku');
  assert.match(odeslani, /vydejni_misto_id: jeVydejniMistoGls\(doprava\) && glsVydejniMisto \? glsVydejniMisto\.id : undefined/);
  assert.match(odeslani, /chybaVydejnihoMista\(doprava\)/);
});
