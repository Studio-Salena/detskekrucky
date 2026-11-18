// Prohlížečový test EET (krok 3): pokladna a Účetnictví → EET proti LOKÁLNÍMU falešnému FS
// (test-helpers/eetFs.js, testovací konfigurace – nic po síti). Ověřuje, že uložení prodeje
// a jeho evidence jsou oddělené: výpadek EET pokladnu nevybízí k novému zadání prodeje.
const { chromium, dbKlient, BASE } = require('./pomocnik');
const assert = require('node:assert/strict');
const ok = t => console.log('✔ ' + t);

(async () => {
  const db = dbKlient(); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const api = (cesta, telo) => fetch(BASE + cesta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-heslo': 'test-heslo-e2e' }, body: JSON.stringify(telo) });
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const c = await b.newContext();
  await c.route('**/*', rt => { const u = rt.request().url(); return u.startsWith(BASE) || u.startsWith('about:') || /cdn\.jsdelivr\.net|fonts\.g/.test(u) ? rt.continue() : rt.abort(); });
  const page = await c.newPage();
  await page.addInitScript(() => { window.open = () => ({ document: { write() {}, close() {} }, focus() {}, close() {}, print() {} }); });
  const odpovediPromptu = [];
  page.on('dialog', d => d.type() === 'prompt' ? d.accept(odpovediPromptu.length ? odpovediPromptu.shift() : '') : d.accept());
  const chyby = []; page.on('pageerror', e => chyby.push(e.message));

  await page.goto(BASE + '/admin.html');
  await page.fill('#passwordInput', 'test-heslo-e2e'); await page.evaluate(() => login());
  await page.waitForFunction(() => typeof otevritNovyProdejProdejna === 'function');
  await page.evaluate(() => showPage('prodejna', document.querySelector('[onclick*="prodejna"]')));
  async function prodej(produkt, velikost, nastaveni = {}) {
    await page.evaluate(() => otevritNovyProdejProdejna());
    await page.waitForFunction(() => prodejnaSkladData.length > 0);
    await page.waitForTimeout(250);
    await page.evaluate(() => pridatPolozku());
    const radek = page.locator('.polozka-row').last();
    await radek.locator('.prod-select').selectOption(String(produkt));
    await radek.locator('.vel-select').selectOption(String(velikost));
    await page.evaluate(() => prepocitatCelkem());
    await page.selectOption('#prodejnaPlatba', nastaveni.platba || 'hotovost');
    if (nastaveni.poukaz) {
      await page.fill('#prodejnaPoukazKod', nastaveni.poukaz);
      await page.evaluate(() => overitPoukazProdejna());
      await page.waitForFunction(() => document.getElementById('poukazProdejnaMsg').textContent.length > 0);
    }
    await page.click('#prodejnaUlozitBtn');
    await page.waitForTimeout(100);
    await page.waitForFunction(() => !prodejUkladaSe, null, { timeout: 15000 });
    return (await q('SELECT * FROM prodejna_prodeje ORDER BY id DESC LIMIT 1'))[0];
  }
  const eetZprava = () => page.locator('#prodejnaEetMsg').innerText();
  const pocetProdeju = async () => (await q('SELECT COUNT(*)::int n FROM prodejna_prodeje'))[0].n;

  // 1) běžný prodej: EET potvrdí hned, pokladna ukáže POK označený jako TEST
  let p = await prodej(1, '24');
  let u = (await q("SELECT * FROM eet_udalosti WHERE zdroj_typ = 'prodej' AND zdroj_id = $1", [p.id]))[0];
  assert.equal(u.stav, 'potvrzeno');
  assert.match(u.pok, /-ff$/);
  let t = await eetZprava();
  assert.match(t, /EET potvrzeno/); assert.match(t, /TEST/); assert.ok(t.includes(u.pok));
  ok('prodej uložen a hned potvrzen v EET; POK je v pokladně označený jako TEST');

  // 2) výpadek EET: prodej uložený jednou, pokladna říká „uloženo – nic znovu nezadávejte“, EET čeká
  const predVypadkem = await pocetProdeju();
  assert.equal((await api('/__e2e/eet-scenare', { scenare: ['sit'] })).status, 200);
  p = await prodej(2, '24.5', { platba: 'karta' });
  assert.equal(await pocetProdeju(), predVypadkem + 1, 'prodej uložen právě jednou');
  t = await eetZprava();
  assert.match(t, /je uloženo/); assert.match(t, /nic znovu nezadávejte/); assert.match(t, /zatím nepotvrzeno/);
  assert.equal(await page.locator('#prodejnaMsg .error-msg').count(), 0, 'žádná chybová hláška o neuloženém prodeji');
  const vypadek = (await q("SELECT * FROM eet_udalosti WHERE zdroj_typ = 'prodej' AND zdroj_id = $1", [p.id]))[0];
  assert.equal(vypadek.stav, 'ceka');
  ok('výpadek EET: prodej uložen jednou, pokladna nevybízí k novému zadání, událost čeká ve frontě');

  // 3) celý nákup darovaným poukazem: neeviduje se potichu, čeká na rozhodnutí
  const dar = await (await api('/api/poukazy', { klic: 'e2e-dar-1', hodnota: 1000, druh: 'dar', zakoupeno_kde: 'prodejna' })).json();
  assert.ok(dar.kod, JSON.stringify(dar));
  p = await prodej(2, '24.5', { platba: 'poukaz', poukaz: dar.kod });
  t = await eetZprava();
  assert.match(t, /je uloženo/); assert.match(t, /čeká na rozhodnutí/);
  const rozh = (await q("SELECT * FROM eet_udalosti WHERE zdroj_typ = 'prodej' AND zdroj_id = $1", [p.id]))[0];
  assert.equal(rozh.stav, 'rozhodnuti');
  assert.equal((await q('SELECT COUNT(*)::int n FROM eet_pokusy WHERE udalost_id = $1', [rozh.id]))[0].n, 0, 'nerozhodnutá událost se neodeslala');
  ok('darovaný kredit: prodej uložen, v EET „vyžaduje rozhodnutí“ a nic se neodeslalo');

  // 4) Účetnictví → EET: počty, prostředí, rozhodnutí a ruční odeslání čekající události
  await page.evaluate(() => { showPage('ucetnictvi', document.querySelector('[onclick*="ucetnictvi"]'), 'eet'); return nacistEet(); });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#eetPocetCeka').innerText(), '1');
  assert.equal(await page.locator('#eetPocetRozhodnuti').innerText(), '1');
  assert.equal(await page.locator('#eetPocetPotvrzeno').innerText(), '1');
  assert.match(await page.locator('#eetProstredi').innerText(), /CZ00000019/);
  assert.match(await page.locator('#eetUpozorneni').innerText(), /čeká na rozhodnutí/);
  // neodeslaná: stáří a poslední chyba jsou vidět
  assert.match(await page.locator('#eetTabulka').innerText(), /zopakuje/);
  await page.click(`#eetRadek${vypadek.id} button:has-text("Detail")`);
  await page.waitForSelector('#eetDetail' + vypadek.id);
  assert.match(await page.locator('#eetDetail' + vypadek.id).innerText(), /ano/);
  await page.click(`#eetRadek${vypadek.id} button:has-text("Odeslat")`);
  await page.waitForFunction(id => document.querySelector('#eetMsg').innerText.includes('zařazena'), vypadek.id);
  for (let i = 0; i < 40 && (await q('SELECT stav FROM eet_udalosti WHERE id = $1', [vypadek.id]))[0].stav !== 'potvrzeno'; i++) await page.waitForTimeout(100);
  assert.equal((await q('SELECT stav FROM eet_udalosti WHERE id = $1', [vypadek.id]))[0].stav, 'potvrzeno');
  assert.deepEqual((await q('SELECT prvni_zaslani FROM eet_pokusy WHERE udalost_id = $1 ORDER BY id', [vypadek.id])).map(r => r.prvni_zaslani), [true, false]);
  ok('přehled EET: počty, prostředí, stáří a chyba; ruční odeslání → potvrzeno jako opakované zaslání');
  await page.evaluate(() => filtrovatEet('rozhodnuti'));
  await page.waitForSelector(`#eetRadek${rozh.id}`);
  odpovediPromptu.push('neevidovat', 'Rozhodla účetní: dar se neeviduje (test).');
  await page.click(`#eetRadek${rozh.id} button:has-text("Rozhodnout")`);
  await page.waitForFunction(() => document.querySelector('#eetMsg').innerText.includes('Rozhodnutí uloženo'));
  assert.deepEqual(await q('SELECT stav, rozhodnuti_volba, rozhodnuti_poznamka FROM eet_udalosti WHERE id = $1', [rozh.id]),
    [{ stav: 'neevidovano', rozhodnuti_volba: 'neevidovat', rozhodnuti_poznamka: 'Rozhodla účetní: dar se neeviduje (test).' }]);
  ok('rozhodnutí o darovaném kreditu s odůvodněním (zůstane viditelně neevidované)');

  // 5) volná platba u pultu: účel povinný, bez zpětného data, eviduje se hned
  await page.evaluate(() => { prepnoutPohled('ucetnictvi', 'platby'); return nacistPlatbyADobirky(); });
  await page.waitForTimeout(300);
  await page.selectOption('#vpZpusob', 'hotovost');
  assert.equal(await page.locator('#vpUcelPole').isVisible(), true);
  assert.equal(await page.locator('#vpDatumPole').isVisible(), false, 'se zapnutým EET bez zpětného data');
  await page.fill('#vpCastka', '700');
  await page.click('#vpBtn'); await page.waitForTimeout(300);
  assert.match(await page.locator('#platbyMsg').innerText(), /Vyberte, za co/);
  await page.selectOption('#vpUcel', 'poukaz');
  await page.click('#vpBtn'); await page.waitForTimeout(800);
  const volna = (await q("SELECT * FROM platby WHERE zdroj_typ = 'volna' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(Number(volna.urceno_k_cerpani), 700);
  const uv = (await q('SELECT stav, celk_trzba, urceno_cerp_zuct FROM eet_udalosti WHERE volna_platba_id = $1', [volna.id]));
  assert.deepEqual(uv.map(x => [x.stav, Number(x.celk_trzba), Number(x.urceno_cerp_zuct)]), [['potvrzeno', 700, 700]]);
  assert.match(await page.locator('#platbyMsg').innerText(), /EET potvrzeno/);
  ok('volná hotovost „na poukaz“: účel povinný, bez zpětného data, v EET hned s částkou určenou k čerpání');

  assert.deepEqual(chyby, [], 'žádné chyby JavaScriptu');
  await b.close(); await db.end();
  console.log('VÝSLEDEK: EET v administraci OK');
})().catch(e => { console.error('SELHALO:', e); process.exit(1); });
