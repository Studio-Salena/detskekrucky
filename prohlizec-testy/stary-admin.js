// Staré okno administrace (admin.html z 98593ee, před opravou) proti NOVÉMU serveru:
// skutečná posloupnost požadavků staré pokladny a důkaz, že po odmítnutí
// nezůstane samostatný odečet skladu, čerpání poukazu ani prodej.
const { chromium, dbKlient, BASE } = require('./pomocnik');
const assert = require('node:assert/strict');

const db = dbKlient();
const q = async (sql) => (await db.query(sql)).rows;
const snimek = async () => ({
  sklad: await q('SELECT produkt_id, velikost, pocet_kusu FROM sklad ORDER BY 1, 2'),
  pohyby: (await q('SELECT COUNT(*)::int n FROM pohyby_skladu'))[0].n,
  prodeje: (await q('SELECT COUNT(*)::int n FROM prodejna_prodeje'))[0].n,
  poukazy: await q('SELECT kod, zustatek::text, stav FROM darkove_poukazy ORDER BY kod'),
  pouziti: (await q('SELECT COUNT(*)::int n FROM poukazy_pouziti'))[0].n
});

(async () => {
  await db.connect();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  await context.route('**/*', r => {
    const u = r.request().url();
    return u.startsWith(BASE) || /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//.test(u) ? r.continue() : r.abort();
  });
  const page = await context.newPage();
  await page.addInitScript(() => { window.__uctenky = []; window.open = () => { let h = ''; return { document: { write: x => { h += x; }, close: () => window.__uctenky.push(h) }, focus() {}, close() {}, print() {} }; }; });
  page.on('dialog', d => d.accept());
  let zaznam = [];
  page.on('response', async r => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') || r.request().method() === 'GET') return;
    let telo = ''; try { telo = (await r.json()).chyba || 'ok'; } catch { telo = '?'; }
    zaznam.push(`${r.request().method()} ${u.pathname} → ${r.status()} ${telo}`);
  });

  await page.goto(BASE + '/admin-stary.html');
  await page.fill('#passwordInput', 'test-heslo-e2e');
  await page.evaluate(() => login());
  await page.waitForFunction(() => typeof otevritNovyProdejProdejna === 'function');
  await page.evaluate(() => showPage('prodejna', document.querySelector('[onclick*="prodejna"]')));

  async function prodejStarym(nazev, polozky, n = {}) {
    zaznam = [];
    const pred = await snimek();
    await page.evaluate(() => otevritNovyProdejProdejna());
    await page.waitForFunction(() => prodejnaSkladData.length > 0);
    // pokladna po otevření (150 ms) přesune kurzor do pole EAN - vyplňovat až potom,
    // jinak by text skončil v poli EAN místo v cílovém poli
    await page.waitForTimeout(250); // časovač 150 ms z otevření musí proběhnout (kurzor v EAN může být z minula)
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'eanInput', null, { timeout: 2000 }).catch(() => {});
    for (const [produkt, velikost, pocet] of polozky) {
      await page.evaluate(() => pridatPolozku());
      const r = page.locator('.polozka-row').last();
      await r.locator('.prod-select').selectOption(String(produkt));
      await r.locator('.vel-select').selectOption(String(velikost));
      await r.locator('.pocet-input').fill(String(pocet));
      await page.evaluate(() => prepocitatCelkem());
    }
    await page.selectOption('#prodejnaPlatba', n.platba);
    if (n.poukaz) {
      await page.fill('#prodejnaPoukazKod', n.poukaz);
      await page.evaluate(() => overitPoukazProdejna());
      await page.waitForFunction(() => document.getElementById('poukazProdejnaMsg').textContent.length > 0);
    }
    if (n.doplatek) await page.selectOption('#prodejnaDoplatekPlatba', n.doplatek);
    // staré ukládání (včetně čekání na všechny jeho požadavky)
    await page.evaluate(() => ulozitProdejnaProdat());
    await page.waitForTimeout(500);
    const po = await snimek();
    console.log(`\n${nazev} – posloupnost požadavků staré pokladny:`);
    for (const z of zaznam) console.log('   ' + z);
    console.log(`   hláška: ${(await page.locator('#prodejnaMsg').innerText().catch(() => '')) || '(žádná)'}; účtenek otevřeno: ${await page.evaluate(() => window.__uctenky.length)}`);
    assert.deepEqual(po, pred, nazev + ': databáze se nesmí změnit');
    console.log('   ✔ sklad, pohyby skladu, prodeje, poukazy i jejich čerpání beze změny');
    await page.evaluate(() => { closeModal('modalProdejnaProdat'); document.getElementById('prodejnaPolozky').innerHTML = ''; });
    return zaznam;
  }

  let z = await prodejStarym('A) běžný prodej hotově (2 kusy, 2 varianty)', [[1, '24', 1], [2, '24.5', 1]], { platba: 'hotovost' });
  assert.equal(z.filter(x => x.startsWith('POST /api/sklad/odecist → 409')).length, 2, 'oba staré odečty odmítnuté');
  assert.ok(z.some(x => x.startsWith('POST /api/prodejna → 409')));
  z = await prodejStarym('B) celý nákup poukazem', [[2, '24.5', 1]], { platba: 'poukaz', poukaz: 'DK-TEST-0001' });
  assert.ok(!z.some(x => x.includes('/api/poukazy/pouzit')), 'stará pokladna nečerpá poukaz, když prodej nemá číslo');
  await prodejStarym('C) poukaz 1000 Kč + doplatek kartou', [[1, '24', 2]], { platba: 'poukaz', poukaz: 'DK-TEST-0002', doplatek: 'karta' });

  await browser.close(); await db.end();
  console.log('\nVÝSLEDEK: staré okno nic nezapsalo');
})().catch(e => { console.error('✖', e); process.exit(1); });
