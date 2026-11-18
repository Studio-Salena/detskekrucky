// Nové obrazovky: Účetnictví → Platby a dobírky (volná platba, přiřazení k objednávce a poukazu,
// vyúčtování dobírky) a detail poukazu čekajícího na platbu.
const { chromium, dbKlient, BASE } = require('./pomocnik');
const assert = require('node:assert/strict');
const ok = t => console.log('✔ ' + t);
(async () => {
  const db = dbKlient(); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const idPoukazu = async kod => (await q('SELECT id FROM darkove_poukazy WHERE kod = $1', [kod]))[0].id;
  const P1 = await idPoukazu('DK-CEKA-0001'), P2 = await idPoukazu('DK-CEKA-0002');
  // dobírka vybraná (úhrada zákazníka dopravci) přes API, jako z detailu objednávky
  const r = await fetch(BASE + '/api/objednavky/3/dobirka', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-heslo': 'test-heslo-e2e' }, body: JSON.stringify({ klic: 'e2e-dobirka-3' }) });
  assert.equal(r.status, 200, await r.text());
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const c = await b.newContext();
  let ztratit = 0;
  await c.route('**/*', async rt => {
    const u = rt.request().url();
    if (ztratit > 0 && rt.request().method() === 'POST' && /\/api\/(objednavky\/\d+\/platby|poukazy\/\d+\/platba|evidence-plateb\/dobirky\/vyuctovani)$/.test(new URL(u).pathname)) { ztratit--; await rt.fetch(); return rt.abort('failed'); }
    return u.startsWith(BASE) || /cdn\.jsdelivr\.net|fonts\.g/.test(u) ? rt.continue() : rt.abort();
  });
  const page = await c.newPage();
  await page.addInitScript(() => { window.open = () => ({ document: { write() {}, close() {} }, focus() {}, close() {}, print() {} }); });
  // dotaz na den převzetí poukazu (doručení e-mailem není zapsané) = dnes, jinak navržená hodnota
  page.on('dialog', d => d.type() === 'prompt' ? d.accept(/převzal/.test(d.message()) ? new Date().toLocaleDateString('en-CA') : d.defaultValue()) : d.accept());
  const chyby = []; page.on('pageerror', e => chyby.push(e.message));
  await page.goto(BASE + '/admin.html');
  await page.fill('#passwordInput', 'test-heslo-e2e'); await page.evaluate(() => login());
  await page.waitForFunction(() => typeof nacistPlatbyADobirky === 'function');
  await page.evaluate(() => { showPage('ucetnictvi', document.querySelector('[onclick*="ucetnictvi"]')); prepnoutPohled('ucetnictvi', 'platby'); return nacistPlatbyADobirky(); });
  await page.waitForTimeout(500);
  const msg = () => page.locator('#platbyMsg').innerText();

  // 1) volná platba 1500 Kč převodem
  await page.selectOption('#vpZpusob', 'prevod'); await page.fill('#vpCastka', '1500'); await page.fill('#vpPoznamka', 'VS 2');
  await page.click('#vpBtn'); await page.waitForTimeout(600);
  const volna = (await q("SELECT id FROM platby WHERE zdroj_typ = 'volna'"))[0];
  assert.ok(volna, 'volná platba zapsaná');
  ok('volná platba zapsaná z obrazovky');

  // 2) přiřazení k objednávce převodem (900) – první odpověď se ztratí, opakování nezdvojí
  await page.selectOption('#vpCil' + volna.id, 'o:2');
  assert.equal(await page.inputValue('#vpCastka' + volna.id), '900');
  ztratit = 1; await page.click('#vpPriradit' + volna.id); await page.waitForTimeout(600);
  assert.match(await msg(), /nepřiřadí dvakrát/);
  await page.click('#vpPriradit' + volna.id); await page.waitForTimeout(800);
  assert.deepEqual(await q('SELECT objednavka_id, castka::int FROM platby_prirazeni WHERE objednavka_id IS NOT NULL'), [{ objednavka_id: 2, castka: 900 }]);
  assert.equal((await q('SELECT stav FROM objednavky WHERE id = 2'))[0].stav, 'zaplacena');
  ok('přiřazení k objednávce: po ztracené odpovědi jednou, objednávka zaplacená');

  // 3) přiřazení zbytku (600) k poukazu 500: jen celou hodnotou (pole jen pro čtení)
  await page.selectOption('#vpCil' + volna.id, 'p:' + P1);
  assert.equal(await page.inputValue('#vpCastka' + volna.id), '500');
  assert.notEqual(await page.getAttribute('#vpCastka' + volna.id, 'readonly'), null);
  await page.click('#vpPriradit' + volna.id); await page.waitForTimeout(800);
  assert.deepEqual(await q("SELECT stav, platba_stav FROM darkove_poukazy WHERE kod = 'DK-CEKA-0001'"), [{ stav: 'aktivni', platba_stav: 'zaplaceno' }]);
  assert.equal(Number((await q('SELECT COUNT(*) n FROM kredit_vklady WHERE poukaz_id = $1', [P1]))[0].n), 1);
  // zbývá 100 Kč – poukaz 300 už v nabídce není (nepokryje ho)
  assert.equal(await page.locator(`#vpCil${volna.id} option[value="p:${P2}"]`).count(), 0);
  // ručně vnucené přiřazení většího poukazu server odmítne
  const vnucene = await page.evaluate(async ([id, p2]) => { const r = await adminFetch(API + '/poukazy/' + p2 + '/platba', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ klic: 'e2e-vnucene-1', platba_id: id }) }); return [r.status, (await r.json()).chyba]; }, [volna.id, P2]);
  assert.equal(vnucene[0], 400); assert.match(vnucene[1], /zbývá k přiřazení jen 100/);
  ok('přiřazení k poukazu: celou hodnotou, aktivace + vklad; nepokrytý poukaz odmítnut');

  // 4) vyúčtování dobírky: 1079 − 25 = 1054
  await page.check('.dv-vyber'); await page.fill('#dvPoplatek', '25');
  await page.evaluate(() => prepocitatVyuctovani());
  assert.match(await page.locator('#dvSouhrn').innerText(), /1\s?079 Kč[\s\S]*25 Kč[\s\S]*1\s?054 Kč/);
  assert.equal(await page.inputValue('#dvDopravce'), 'zasilkovna');
  ztratit = 1; await page.click('#dvBtn'); await page.waitForTimeout(600);
  await page.click('#dvBtn'); await page.waitForTimeout(800);
  assert.deepEqual(await q('SELECT brutto::int, poplatek::int, netto::int FROM dobirky_vyuctovani'), [{ brutto: 1079, poplatek: 25, netto: 1054 }]);
  assert.equal(Number((await q("SELECT COUNT(*) n FROM platby WHERE zpusob = 'dobirka'"))[0].n), 1, 'příjem z dobírky jen jednou');
  assert.match(await page.locator('#vyuctovaniTab').innerText(), /1\s?054 Kč/);
  ok('vyúčtování dobírky: brutto/poplatek/netto, po ztracené odpovědi jednou, příjem nezdvojen');

  // 5) detail poukazu čekajícího na platbu: zapsat platbu hotově → aktivní
  await page.evaluate(id => zobrazitPoukazDetail(id), P2);
  await page.waitForSelector('#ppBtn');
  assert.match(await page.locator('#poukazPlatbaBox').innerText(), /čeká na platbu 300/i);
  await page.selectOption('#ppZpusob', 'hotovost');
  ztratit = 1; await page.click('#ppBtn'); await page.waitForTimeout(600);
  await page.click('#ppBtn'); await page.waitForTimeout(800);
  assert.deepEqual(await q("SELECT stav, platba_stav FROM darkove_poukazy WHERE kod = 'DK-CEKA-0002'"), [{ stav: 'aktivni', platba_stav: 'zaplaceno' }]);
  assert.equal(Number((await q("SELECT COUNT(*) n FROM platby WHERE zdroj_typ = 'poukaz' AND zdroj_id = " + P2))[0].n), 1);
  assert.match(await page.locator('#poukazPlatbaBox').innerText(), /Odstoupení od nákupu/, 'zaplacený e-shopový poukaz: místo zápisu platby nabídka odstoupení');
  ok('detail poukazu: platba zapsaná jednou, poukaz aktivní');

  // 6) odstoupení od nákupu e-shopového poukazu z detailu (prompty přijmou navržený den = dnes a způsob = původní platba)
  const puvodni = (await q("SELECT id FROM platby WHERE zdroj_typ = 'poukaz' AND zdroj_id = $1 AND typ = 'prijem'", [P2]))[0];
  await page.evaluate(id => zobrazitPoukazDetail(id), P2);
  await page.waitForTimeout(300);
  await page.evaluate(id => vratitPenizePoukazu(id), P2);
  await page.waitForTimeout(800);
  assert.deepEqual(await q('SELECT stav, zustatek::int FROM darkove_poukazy WHERE id = $1', [P2]), [{ stav: 'zruseny', zustatek: 0 }]);
  assert.deepEqual(await q("SELECT castka::int, vraci_id FROM platby WHERE typ = 'vraceni' AND zdroj_typ = 'poukaz' AND zdroj_id = $1", [P2]), [{ castka: 300, vraci_id: puvodni.id }]);
  assert.equal(Number((await q("SELECT COUNT(*) n FROM platby WHERE zdroj_typ = 'poukaz' AND zdroj_id = $1 AND typ = 'prijem'", [P2]))[0].n), 1, 'původní platba zůstala');
  ok('odstoupení od nákupu poukazu: celá hodnota, vazba na původní platbu, poukaz zrušený');

  console.log('Chyby JS na stránce:', chyby.length ? chyby : 'žádné');
  await b.close(); await db.end();
})().catch(e => { console.error('✖', e.message); process.exit(1); });
