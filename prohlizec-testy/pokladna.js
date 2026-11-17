// Prohlížečový test pokladny (Chrome, playwright-core) proti lokálnímu testovacímu serveru.
const { chromium, dbKlient, BASE } = require('./pomocnik');
const assert = require('node:assert/strict');

const db = dbKlient();
const vysledky = [];
const ok = (nazev) => { vysledky.push('✔ ' + nazev); console.log('✔ ' + nazev); };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const kusu = async (id, vel) => (await q('SELECT pocet_kusu FROM sklad WHERE produkt_id=$1 AND velikost=$2', [id, vel]))[0].pocet_kusu;
const pocetProdeju = async () => (await q('SELECT COUNT(*)::int n FROM prodejna_prodeje'))[0].n;

(async () => {
  await db.connect();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const blokovano = new Set();
  const postyProdeje = [];   // těla POST /api/prodejna
  let ztratitOdpoved = 0;    // kolik dalších odpovědí na POST /api/prodejna zahodit (server ho zpracuje)
  let ztratitPozadavek = 0;  // kolik dalších POST zahodit dřív, než dojdou na server
  let uctenky = 0, uctenkyCelkem = 0;

  await context.route('**/*', async route => {
    const req = route.request(), url = req.url();
    if (url.startsWith(BASE + '/api/prodejna') && req.method() === 'POST' && new URL(url).pathname === '/api/prodejna') {
      postyProdeje.push(JSON.parse(req.postData()));
      if (ztratitPozadavek > 0) { ztratitPozadavek--; return route.abort('failed'); }
      if (ztratitOdpoved > 0) { ztratitOdpoved--; await route.fetch(); return route.abort('failed'); }
      return route.continue();
    }
    if (url.startsWith(BASE) || url.startsWith('about:') || /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//.test(url)) return route.continue();
    blokovano.add(new URL(url).host); return route.abort('blockedbyclient');
  });


  const page = await context.newPage(); global.__page = page;
  // účtenky: místo okna s window.print() zachytit HTML (tisk v headless blokuje i hlavní okno)
  await page.addInitScript(() => { window.__uctenky = []; window.open = () => { let h = ''; const doc = { write: x => { h += x; }, close: () => { window.__uctenky.push(h); } }; return { document: doc, focus() {}, close() {}, print() {} }; }; });
  const pocetUctenek = () => page.evaluate(() => window.__uctenky.length).catch(() => 0);
  let odmitnoutDuplicitu = false;
  page.on('dialog', d => (odmitnoutDuplicitu && d.message().includes('DALŠÍ nákup')) ? d.dismiss() : d.accept());
  const chybyStranky = [];
  page.on('pageerror', e => chybyStranky.push(e.message));

  async function prihlasit() {
    await page.goto(BASE + '/admin.html');
    if (await page.locator('#passwordInput').isVisible()) {
      await page.fill('#passwordInput', 'test-heslo-e2e');
      await page.evaluate(() => login());
    }
    await page.waitForFunction(() => typeof otevritNovyProdejProdejna === 'function');
    await page.evaluate(() => showPage('prodejna', document.querySelector('[onclick*="prodejna"]')));
  }
  async function novyProdej(polozky, nastaveni = {}) {
    await page.evaluate(() => otevritNovyProdejProdejna());
    await page.waitForFunction(() => prodejnaSkladData.length > 0);
    // pokladna po otevření (150 ms) přesune kurzor do pole EAN - vyplňovat až potom,
    // jinak by text skončil v poli EAN místo v cílovém poli
    await page.waitForTimeout(250); // časovač 150 ms z otevření musí proběhnout (kurzor v EAN může být z minula)
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'eanInput', null, { timeout: 2000 }).catch(() => {});
    for (const [produkt, velikost, pocet] of polozky) {
      await page.evaluate(() => pridatPolozku());
      const radek = page.locator('.polozka-row').last();
      await radek.locator('.prod-select').selectOption(String(produkt));
      await radek.locator('.vel-select').selectOption(String(velikost));
      await radek.locator('.pocet-input').fill(String(pocet));
      await page.evaluate(() => prepocitatCelkem());
    }
    await page.selectOption('#prodejnaPlatba', nastaveni.platba || 'hotovost');
    if (nastaveni.poukaz) {
      await page.fill('#prodejnaPoukazKod', nastaveni.poukaz);
      await page.evaluate(() => overitPoukazProdejna());
      await page.waitForFunction(() => document.getElementById('poukazProdejnaMsg').textContent.length > 0);
    }
    if (nastaveni.doplatek) await page.selectOption('#prodejnaDoplatekPlatba', nastaveni.doplatek);
    if (nastaveni.prijato) await page.fill('#prodejnaHotovostPrijato', String(nastaveni.prijato));
  }
  // počkat, až pokladna dokončí ukládání (odpověď serveru nebo chyba spojení)
  const ulozit = () => page.click('#prodejnaUlozitBtn');
  const pockat = async () => { await page.waitForTimeout(100); await page.waitForFunction(() => !prodejUkladaSe, null, { timeout: 15000 }); uctenky = uctenkyCelkem + await pocetUctenek(); };
  const zprava = () => page.locator('#prodejnaMsg').innerText();

  await prihlasit();

  // 1) běžný prodej hotově
  await novyProdej([[1, '24', 1]], { platba: 'hotovost', prijato: 2000 });
  await ulozit(); await pockat();
  let p = (await q('SELECT * FROM prodejna_prodeje ORDER BY id DESC LIMIT 1'))[0];
  assert.deepEqual([p.platba, Number(p.celkem), Number(p.hotovost_prijato), Number(p.hotovost_vraceno)], ['hotovost', 1200, 2000, 800]);
  assert.equal(await kusu(1, '24'), 9); assert.equal(uctenky, 1);
  ok('běžný prodej hotově: 1 účtenka, sklad −1, vráceno 800 Kč spočítal server');

  // 2) celý nákup poukazem (velikost 24.5)
  await novyProdej([[2, '24.5', 1]], { platba: 'poukaz', poukaz: 'DK-TEST-0001' });
  await ulozit(); await pockat();
  p = (await q('SELECT * FROM prodejna_prodeje ORDER BY id DESC LIMIT 1'))[0];
  assert.deepEqual([p.platba, Number(p.celkem), p.poukaz_kod, p.poukaz_castka], ['poukaz', 800, 'DK-TEST-0001', null]);
  assert.equal(Number((await q("SELECT zustatek FROM darkove_poukazy WHERE kod='DK-TEST-0001'"))[0].zustatek), 4200);
  assert.equal(await kusu(2, '24.5'), 9); assert.equal(uctenky, 2);
  ok('celý nákup poukazem: poukaz 5000 → 4200, velikost 24.5 odečtena, platba poukaz / celkem 800');

  // 3) poukaz 1000 Kč + doplatek kartou
  await novyProdej([[1, '24', 2]], { platba: 'poukaz', poukaz: 'DK-TEST-0002', doplatek: 'karta' });
  await ulozit(); await pockat();
  p = (await q('SELECT * FROM prodejna_prodeje ORDER BY id DESC LIMIT 1'))[0];
  assert.deepEqual([p.platba, Number(p.celkem), Number(p.mezisoucet), Number(p.poukaz_castka)], ['karta', 1400, 2400, 1000]);
  assert.deepEqual(await q("SELECT zustatek::int, stav FROM darkove_poukazy WHERE kod='DK-TEST-0002'"), [{ zustatek: 0, stav: 'pouzity' }]);
  assert.equal(await kusu(1, '24'), 7); assert.equal(uctenky, 3);
  ok('poukaz 1000 + doplatek 1400 kartou: poukaz vyčerpán, sklad −2');

  // 4) dvojklik
  let pred = await pocetProdeju(), postuPred = postyProdeje.length;
  await novyProdej([[1, '24', 1]], { platba: 'karta' });
  await page.dblclick('#prodejnaUlozitBtn'); await pockat();
  assert.equal(await pocetProdeju(), pred + 1);
  assert.equal(postyProdeje.length - postuPred, 1, 'odešel jen jeden požadavek');
  assert.equal(await kusu(1, '24'), 6); assert.equal(uctenky, 4);
  ok('dvojklik: jeden požadavek, jeden prodej, jedna účtenka');

  // 5) ztráta odpovědi (server prodej uložil, odpověď nedošla) a nové kliknutí
  pred = await pocetProdeju(); postuPred = postyProdeje.length;
  await novyProdej([[2, '24.5', 1]], { platba: 'qr' });
  ztratitOdpoved = 1; await ulozit(); await pockat();
  assert.match(await zprava(), /nevíme, jestli se prodej uložil/);
  assert.equal(await pocetProdeju(), pred + 1, 'server prodej uložil');
  assert.equal(uctenky, 4, 'bez potvrzení se účtenka netiskne');
  const cekajici = await page.evaluate(() => nacistNedokoncenyProdej());
  assert.equal(cekajici.prodej.klic, postyProdeje.at(-1).klic);
  await ulozit(); await pockat();
  assert.equal(postyProdeje.length - postuPred, 2);
  assert.equal(postyProdeje.at(-1).klic, postyProdeje.at(-2).klic, 'opakování nese původní klíč');
  assert.equal(await pocetProdeju(), pred + 1, 'žádný druhý prodej');
  assert.equal(await kusu(2, '24.5'), 8); assert.equal(uctenky, 5);
  assert.equal(await page.evaluate(() => nacistNedokoncenyProdej()), null);
  ok('ztráta odpovědi: opakování se stejným klíčem, 1 prodej, sklad −1, účtenka až po potvrzení');

  // 6) ztráta odpovědi + obnovení stránky → dokončení se stejným klíčem
  pred = await pocetProdeju(); postuPred = postyProdeje.length;
  await novyProdej([[1, '24', 1]], { platba: 'qr' });
  ztratitOdpoved = 1; await ulozit(); await pockat();
  const klic6 = postyProdeje.at(-1).klic;
  uctenkyCelkem += await pocetUctenek(); await page.reload(); await prihlasit();
  await novyProdej([[2, '24.5', 1]], { platba: 'karta' });
  assert.match(await page.locator('#prodejnaNedokonceny').innerText(), /Nedokončený prodej/);
  await ulozit(); await pockat();
  assert.match(await zprava(), /Nejdřív dokončete nebo zahoďte/);
  assert.equal(postyProdeje.length - postuPred, 1, 'nový prodej se neodeslal, dokud čeká nedokončený');
  await page.click('#prodejnaDokoncitBtn'); await pockat();
  assert.equal(postyProdeje.at(-1).klic, klic6, 'po obnovení stránky se posílá původní klíč');
  assert.equal(await pocetProdeju(), pred + 1);
  assert.equal(await kusu(1, '24'), 5); assert.equal(uctenky, 6);
  ok('obnovení stránky po ztrátě odpovědi: dokončení se stejným klíčem, prodej jen jednou, účtenka vytištěna');

  // 7) požadavek se na server vůbec nedostal + obnovení stránky → dokončení ho uloží poprvé
  pred = await pocetProdeju(); postuPred = postyProdeje.length;
  await page.evaluate(() => closeModal('modalProdejnaProdat'));
  await novyProdej([[2, '24.5', 2]], { platba: 'hotovost' });
  ztratitPozadavek = 1; await ulozit(); await pockat();
  assert.equal(await pocetProdeju(), pred, 'nic se neuložilo');
  const klic7 = postyProdeje.at(-1).klic;
  uctenkyCelkem += await pocetUctenek(); await page.reload(); await prihlasit();
  await page.evaluate(() => otevritNovyProdejProdejna());
  await page.click('#prodejnaDokoncitBtn'); await pockat();
  assert.equal(postyProdeje.at(-1).klic, klic7);
  assert.equal(await pocetProdeju(), pred + 1);
  assert.equal(await kusu(2, '24.5'), 6); assert.equal(uctenky, 7);
  ok('požadavek ztracený cestou + obnovení: dokončení uloží prodej poprvé a jednou');

  // 8) ztracená odpověď → obnovení stránky → Zahodit: prodej se uložil, takže se nezahodí,
  //    vytiskne se jeho účtenka; stejný nákup zadaný znovu se bez potvrzení neuloží
  pred = await pocetProdeju(); postuPred = postyProdeje.length;
  await novyProdej([[2, '24.5', 1]], { platba: 'karta' });
  ztratitOdpoved = 1; await ulozit(); await pockat();
  assert.equal(await pocetProdeju(), pred + 1, 'server prodej uložil');
  uctenkyCelkem += await pocetUctenek(); await page.reload(); await prihlasit();
  await page.evaluate(() => otevritNovyProdejProdejna());
  await page.click('#prodejnaNedokonceny button.btn-outline'); await pockat();
  assert.match(await zprava(), /uložil jako účtenka #[0-9]+ – nezadávejte ho znovu/);
  assert.equal(uctenky, 8, 'účtenka uloženého prodeje vytištěna');
  assert.equal(await page.evaluate(() => nacistNedokoncenyProdej()), null);
  odmitnoutDuplicitu = true;
  await novyProdej([[2, '24.5', 1]], { platba: 'karta' });
  await ulozit(); await pockat();
  odmitnoutDuplicitu = false;
  assert.match(await zprava(), /Neuloženo – nákup už je uložený jako účtenka/);
  assert.equal(await pocetProdeju(), pred + 1, 'druhý prodej nevznikl');
  ok('Zahodit po ztracené odpovědi: uložený prodej se nezahodí (účtenka vytištěna), opakované zadání bez potvrzení nic neuloží');

  // souhrn: každý klíč jen jednou, sklad = pohyby
  assert.equal((await q('SELECT COUNT(*)::int n FROM (SELECT klic FROM prodejna_prodeje GROUP BY klic HAVING COUNT(*) > 1) x'))[0].n, 0);
  const pohyby = await q("SELECT produkt_id, velikost, SUM(pocet)::int s FROM pohyby_skladu WHERE typ='prodej' GROUP BY 1,2 ORDER BY 1");
  assert.deepEqual(pohyby.map(r => [r.produkt_id, r.velikost, r.s]), [[1, '24', 5], [2, '24.5', 5]]);
  ok('kontrola: žádný klíč dvakrát, pohyby skladu odpovídají stavu (10−5, 10−5)');

  console.log('Chyby JS na stránce:', chybyStranky.length ? chybyStranky : 'žádné');
  console.log('Zablokované externí adresy:', [...blokovano].join(', ') || 'žádné');
  await browser.close(); await db.end();
})().catch(async e => {
  console.error('✖', e.message);
  try { console.error('STAV', JSON.stringify(await global.__page.evaluate(() => ({ msg: document.getElementById('prodejnaMsg').innerText, poukazMsg: document.getElementById('poukazProdejnaMsg').innerText, celkem: document.getElementById('prodejnaCelkem').innerText, platba: document.getElementById('prodejnaPlatba').value, zustatek: poukazProdejnaZustatek, ukladaSe: prodejUkladaSe, modal: document.getElementById('modalProdejnaProdat').className, radky: [...document.querySelectorAll('.polozka-row')].map(r => [r.querySelector('.prod-select').value, r.querySelector('.vel-select').value, r.querySelector('.pocet-input').value, r.querySelector('.cena-input').value]) })))); } catch (x) { console.error('stav nejde přečíst', x.message); }
  process.exit(1);
});
