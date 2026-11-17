// Osobní odběr v detailu objednávky: bez platby nejde Zaplaceno, „Přijmout platbu“ zapíše jednu platbu
const { chromium, dbKlient, BASE } = require('./pomocnik');
const assert = require('node:assert/strict');
(async () => {
  const db = dbKlient(); await db.connect();
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const c = await b.newContext();
  let zahodit = 0;
  await c.route('**/*', async r => {
    const u = r.request().url();
    if (u.includes('/api/objednavky/1/platby') && r.request().method() === 'POST' && zahodit > 0) { zahodit--; await r.fetch(); return r.abort('failed'); }
    return u.startsWith(BASE) || /cdn\.jsdelivr\.net|fonts\.g/.test(u) ? r.continue() : r.abort();
  });
  const page = await c.newPage();
  const alerty = []; page.on('dialog', d => { alerty.push(d.message()); d.accept(); });
  const chyby = []; page.on('pageerror', e => chyby.push(e.message));
  await page.goto(BASE + '/admin.html');
  await page.fill('#passwordInput', 'test-heslo-e2e'); await page.evaluate(() => login());
  await page.waitForFunction(() => typeof detailObjednavky === 'function');
  // bez platby: změna stavu na Zaplaceno odmítnuta
  await page.evaluate(() => zmenitStav(1, 'zaplacena'));
  await page.waitForTimeout(400);
  assert.match(alerty.at(-1) || '', /není zaplacená/);
  await page.evaluate(() => detailObjednavky(1));
  await page.waitForSelector('#objPlatbaBtn');
  assert.match(await page.locator('#detailObjPlatby').innerText(), /zbývá uhradit\s+1\s?200 Kč/);
  await page.selectOption('#objPlatbaZpusob', 'hotovost');
  await page.fill('#objPlatbaPrijato', '1500');
  zahodit = 1;                                    // první odpověď se ztratí (server platbu zapíše)
  await page.click('#objPlatbaBtn'); await page.waitForTimeout(500);
  assert.match(await page.locator('#objPlatbaMsg').innerText(), /nezapíše dvakrát/);
  await page.click('#objPlatbaBtn'); await page.waitForTimeout(500);   // opakování se stejným klíčem
  assert.match(await page.locator('#detailObjPlatby').innerText(), /zaplaceno/);
  const platby = (await db.query("SELECT typ, castka::int, zpusob, okolnosti FROM platby WHERE zdroj_typ = 'objednavka' AND zdroj_id = 1")).rows;
  assert.deepEqual(platby, [{ typ: 'prijem', castka: 1200, zpusob: 'hotovost', okolnosti: 'osobni_odber' }]);
  assert.equal((await db.query('SELECT stav FROM objednavky WHERE id = 1')).rows[0].stav, 'zaplacena');
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM prodejna_prodeje')).rows[0].n, 0, 'žádný prodej v pokladně');
  console.log('✔ osobní odběr v adminu: bez platby nejde Zaplaceno; platba po ztracené odpovědi zapsaná jednou, stav zaplacená, žádný prodej');
  console.log('Chyby JS na stránce:', chyby.length ? chyby : 'žádné');
  await b.close(); await db.end();
})().catch(e => { console.error('✖', e.message); process.exit(1); });
