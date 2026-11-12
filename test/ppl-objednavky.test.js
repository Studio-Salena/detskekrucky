// PPL v detailu objednávky: převod objednávky na zásilku, podání a štítek (bez sítě a DB)
const test = require('node:test');
const assert = require('node:assert');
const { teloZasilky, zasilkaZObjednavky, sledovaniUrl } = require('../lib/ppl');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');

const BATCH = '11111111-2222-3333-4444-555555555555';
const PDF = Buffer.from('%PDF-1.4 ppl');
const OBJ = { id: 7, cislo: '2026042', doprava: 'ceska_posta', platba: 'prevod', celkem: 1290,
  obj_jmeno: 'Jana Nováková', obj_ulice: 'Dlouhá 5', obj_mesto: 'Brno', obj_psc: '602 00', obj_telefon: '777 123 456', obj_email: 'jana@example.com' };

test('objednávka na adresu -> PPL: PRIV, adresa a kontakt z objednávky, telefon +420', () => {
  const p = zasilkaZObjednavky(OBJ, 2);
  assert.strictEqual(p.produkt, 'PRIV');
  assert.strictEqual(p.referenceId, '2026042');
  assert.strictEqual(p.pocetKusu, 2);
  assert.strictEqual(p.dobirka, null);
  assert.deepStrictEqual(p.prijemce, { name: 'Jana Nováková', street: 'Dlouhá 5', city: 'Brno', zipCode: '60200', country: 'CZ', contact: 'Jana Nováková', phone: '+420777123456', email: 'jana@example.com' });
  const t = teloZasilky(p).shipments[0];
  assert.strictEqual(t.recipient.name, 'Jana Novakova');
  assert.deepStrictEqual(t.shipmentSet, { numberOfShipments: 2 });
});

test('dobírka -> PRID s celkovou částkou a VS = číslo objednávky', () => {
  const p = zasilkaZObjednavky({ ...OBJ, doprava: 'gls_adresa', platba: 'dobirka' });
  assert.strictEqual(p.produkt, 'PRID');
  assert.deepStrictEqual(p.dobirka, { castka: 1290, vs: '2026042' });
});

test('PPL jen u doručení na adresu, s úplnou adresou a 1–10 balíky', () => {
  for (const doprava of ['zasilkovna', 'gls_vydejni_misto', 'osobni_odber']) {
    assert.throws(() => zasilkaZObjednavky({ ...OBJ, doprava }), /na adresu/);
  }
  assert.throws(() => zasilkaZObjednavky({ ...OBJ, obj_psc: '123' }), /adresa/);
  assert.throws(() => zasilkaZObjednavky({ ...OBJ, obj_ulice: '' }), /adresa/);
  assert.throws(() => zasilkaZObjednavky(OBJ, 0), /1–10/);
  assert.throws(() => zasilkaZObjednavky(OBJ, 11), /1–10/);
});

test('sledování zásilky na ppl.cz jen s číslicemi', () => {
  assert.strictEqual(sledovaniUrl('41252421813'), 'https://www.ppl.cz/vyhledat-zasilku?shipmentId=41252421813');
  assert.strictEqual(sledovaniUrl('4125"><x'), 'https://www.ppl.cz/vyhledat-zasilku?shipmentId=4125');
});

// ---------- PPL jako způsob dopravy v e-shopu ----------
const doprava = require('../lib/doprava');

test('doprava PPL na adresu: výchozí vypnutá bez ceny, zákazníkům se neukáže', () => {
  const n = doprava.sloucitNastaveni(null);
  assert.deepStrictEqual(n.metody.ppl_adresa, { aktivni: false, cena: null });
  assert.ok(!doprava.verejneNastaveni(n, {}).metody.some(m => m.kod === 'ppl_adresa'));
  // starší uložené nastavení bez PPL: doplní se vypnuté, ostatní ceny zůstanou
  const stare = doprava.sloucitNastaveni({ zdarmaOd: 2000, metody: { zasilkovna: { aktivni: true, cena: 85 } } });
  assert.deepStrictEqual(stare.metody.ppl_adresa, { aktivni: false, cena: null });
  assert.strictEqual(stare.metody.zasilkovna.cena, 85);
});

test('doprava PPL na adresu: bez ceny nejde zapnout; s cenou se nabízí, zdarma od limitu, dobírka jde', () => {
  const zaklad = doprava.sloucitNastaveni(null);
  const telo = m => ({ zdarmaOd: 2000, priplatky: { dobirka: 40 }, metody: { ...zaklad.metody, ppl_adresa: m } });
  assert.match(doprava.overitNastaveniDopravy(telo({ aktivni: true, cena: null })).chyba, /PPL.*bez ceny/);
  const { hodnoty } = doprava.overitNastaveniDopravy(telo({ aktivni: true, cena: 99 }));
  const v = doprava.verejneNastaveni(hodnoty, {}).metody.find(m => m.kod === 'ppl_adresa');
  assert.deepStrictEqual(v, { kod: 'ppl_adresa', nazev: 'PPL – doručení na adresu', cena: 99, vydejniMisto: null, vzdyZdarma: false });
  assert.strictEqual(doprava.vypocitatCenuDopravy(hodnoty, 'ppl_adresa', 1500), 99);
  assert.strictEqual(doprava.vypocitatCenuDopravy(hodnoty, 'ppl_adresa', 2000), 0);
  assert.strictEqual(doprava.priplatekPlatby(hodnoty, 'ppl_adresa', 'dobirka'), 40);
  assert.strictEqual(doprava.METODY.ppl_adresa.dopravce, 'ppl');
});

test('aspoň jeden způsob dopravy: stačí zapnuté PPL', () => {
  const vse = Object.fromEntries(doprava.PORADI.map(k => [k, { aktivni: false, cena: 50 }]));
  assert.match(doprava.overitNastaveniDopravy({ zdarmaOd: null, metody: vse }).chyba, /Aspoň jeden/);
  assert.ok(doprava.overitNastaveniDopravy({ zdarmaOd: null, metody: { ...vse, ppl_adresa: { aktivni: true, cena: 99 } } }).hodnoty);
});

test('objednávku s dopravou PPL jde podat do PPL', () => {
  assert.strictEqual(zasilkaZObjednavky({ ...OBJ, doprava: 'ppl_adresa' }).produkt, 'PRIV');
});

test('název dopravy PPL v e-shopu, adminu, faktuře i e-mailech', () => {
  for (const f of ['eshop.html', 'admin.html', 'lib/faktura.js', 'routes/emaily.js']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /ppl_adresa: 'PPL – /, f);
  }
});

// ---------- výdejní místo / box PPL ----------
const ppl = require('../lib/ppl');
const AP = { accessPointCode: 'KM10676824', accessPointType: 'ParcelBox', name: 'PBOX HUN Sadová (COOP HB)', street: 'Sadová 1008', city: 'Hulín', country: 'CZ', zipCode: '76824', pickupEnabled: true, accessPointNote: 'Vedle prodejny COOP', gps: { latitude: 49.3 } };

test('výdejní místo PPL: dotaz = PSČ (5 číslic) nebo obec, jinak chyba', () => {
  assert.deepStrictEqual(ppl.rozpoznatDotaz('768 24'), { psc: '76824' });
  assert.deepStrictEqual(ppl.rozpoznatDotaz(' Hulín '), { mesto: 'Hulín' });
  assert.deepStrictEqual(ppl.rozpoznatDotaz('Frenštát pod Radhoštěm'), { mesto: 'Frenštát pod Radhoštěm' });
  for (const spatne of ['', '768', '<script>', 'Praha 1', 'a'.repeat(80)]) assert.strictEqual(ppl.rozpoznatDotaz(spatne), null, spatne);
});

test('výdejní místo PPL: převod jen na veřejné údaje, nevalidní kód se zahodí', () => {
  assert.deepStrictEqual(ppl.prevestMisto(AP), { id: 'KM10676824', nazev: 'PBOX HUN Sadová (COOP HB)', ulice: 'Sadová 1008', mesto: 'Hulín', psc: '76824', stat: 'CZ', typ: 'ParcelBox', poznamka: 'Vedle prodejny COOP' });
  assert.strictEqual(ppl.prevestMisto({ ...AP, accessPointCode: 'X"><' }), null);
  assert.strictEqual(ppl.prevestMisto({ ...AP, accessPointType: 'Neco' }).typ, 'ParcelShop');
});

test('hledání míst: parametry pro PPL, vyřazení nedostupných, mezipaměť', async () => {
  const volani = [];
  const klient = { vydejniMista: async p => { volani.push(p); return [AP, { ...AP, accessPointCode: 'KM2', pickupEnabled: false }]; } };
  const m = await ppl.hledatVydejniMista('76825', klient, 1000);
  assert.deepStrictEqual(m.map(x => x.id), ['KM10676824']);
  await ppl.hledatVydejniMista('768 25', klient, 2000);
  assert.deepStrictEqual(volani, [{ psc: '76825' }], 'druhé hledání z mezipaměti');
  await assert.rejects(ppl.hledatVydejniMista('12', klient), e => e.kod === 'DOTAZ');
});

test('ověření místa při objednávce: jen přesná shoda kódu u PPL', async () => {
  const klient = { vydejniMista: async p => (p.kod === 'KM10676824' ? [AP] : []) };
  assert.strictEqual((await ppl.overitVydejniMisto('KM10676824', klient)).nazev, 'PBOX HUN Sadová (COOP HB)');
  assert.strictEqual(await ppl.overitVydejniMisto('KM99999999', klient), null);
  assert.strictEqual(await ppl.overitVydejniMisto('../x', { vydejniMista: async () => { throw new Error('nevolat'); } }), null);
});

test('klient: GET /accessPoint s CountryCode=CZ a kódem / PSČ / obcí', async () => {
  const urls = [];
  const fetchFn = async url => {
    urls.push(url);
    if (url.endsWith('getAccessToken')) return { ok: true, status: 200, json: async () => ({ access_token: 'T', expires_in: 1800 }) };
    return { ok: true, status: 200, json: async () => [AP] };
  };
  const k = ppl.vytvoritKlienta({ env: { PPL_API_URL: 'https://api-dev.dhl.com/ecs/ppl/myapi2', PPL_CLIENT_ID: 'a', PPL_CLIENT_SECRET: 'b' }, fetchFn });
  await k.vydejniMista({ mesto: 'Hulín' });
  await k.vydejniMista({ kod: 'KM10676824', limit: 5 });
  assert.match(urls[1], /\/accessPoint\?CountryCode=CZ&Limit=50&Offset=0&City=Hul%C3%ADn$/);
  assert.match(urls[2], /AccessPointCode=KM10676824/);
});

test('zásilka do výdejního místa PPL: SMAR / SMAD s kódem místa, telefon a e-mail povinné', () => {
  const o = { ...OBJ, doprava: 'ppl_vydejni_misto', vydejni_misto_id: 'KM10676824' };
  const p = zasilkaZObjednavky(o);
  assert.strictEqual(p.produkt, 'SMAR');
  assert.deepStrictEqual(teloZasilky(p).shipments[0].specificDelivery, { parcelShopCode: 'KM10676824' });
  assert.strictEqual(zasilkaZObjednavky({ ...o, platba: 'dobirka' }).produkt, 'SMAD');
  assert.throws(() => zasilkaZObjednavky({ ...o, vydejni_misto_id: null }), /výdejní místo PPL/);
  assert.throws(() => zasilkaZObjednavky({ ...o, obj_email: '' }), /telefon a e-mail/);
  assert.strictEqual(teloZasilky(zasilkaZObjednavky(OBJ)).shipments[0].specificDelivery, undefined, 'na adresu bez místa');
});

test('doprava PPL výdejní místo: vypnutá bez ceny; nabídne se jen s přístupovými údaji PPL na serveru', () => {
  const zaklad = doprava.sloucitNastaveni(null);
  assert.deepStrictEqual(zaklad.metody.ppl_vydejni_misto, { aktivni: false, cena: null });
  const zapnuto = { ...zaklad, metody: { ...zaklad.metody, ppl_vydejni_misto: { aktivni: true, cena: 69 } } };
  const ENV_PPL = { PPL_API_URL: 'https://api.dhl.com/ecs/ppl/myapi2', PPL_CLIENT_ID: 'a', PPL_CLIENT_SECRET: 'b' };
  const v = doprava.verejneNastaveni(zapnuto, ENV_PPL).metody.find(m => m.kod === 'ppl_vydejni_misto');
  assert.deepStrictEqual(v, { kod: 'ppl_vydejni_misto', nazev: 'PPL – výdejní místo nebo box', cena: 69, vydejniMisto: 'ppl', vzdyZdarma: false });
  assert.ok(!doprava.verejneNastaveni(zapnuto, {}).metody.some(m => m.kod === 'ppl_vydejni_misto'), 'bez PPL_* se nenabízí');
  assert.strictEqual(doprava.jeDostupna(zapnuto, 'ppl_vydejni_misto', {}), false);
  assert.ok(!JSON.stringify(doprava.verejneNastaveni(zapnuto, ENV_PPL)).includes('PPL_'));
});

// ---------- panel PPL v detailu objednávky (admin.html) ----------
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
function vytahnout(nazev) {
  const start = ADMIN.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, nazev);
  let hloubka = 0;
  for (let i = ADMIN.indexOf(') {', start) + 2; i < ADMIN.length; i++) {
    if (ADMIN[i] === '{') hloubka++;
    else if (ADMIN[i] === '}' && --hloubka === 0) return ADMIN.slice(start, i + 1);
  }
  throw new Error(nazev);
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(['escH', 'escAttr', 'pplDetailHtml'].map(vytahnout).join('\n'), sandbox);
const panel = d => vm.runInContext(`pplDetailHtml(${JSON.stringify(d)})`, sandbox);

test('admin: tlačítko Podat do PPL jen když to server povolí; po podání číslo, štítek a sledování', () => {
  assert.equal(panel({ id: 7, ppl_podani: false, zasilky: [] }), '');
  assert.equal(panel({ id: 7, ppl_podani: true, stav: 'zrusena', zasilky: [] }), '');
  assert.equal(panel({ id: 7, ppl_podani: true, zasilky: [{ dopravce: 'gls', stav: 'podana', cislo_zasilky: '1' }] }), '');
  const h = panel({ id: 7, ppl_podani: true, ppl_prostredi: 'ostre', platba: 'dobirka', celkem: 1290, zasilky: [] });
  assert.match(h, /podatDoPpl\(7, this\)/);
  assert.match(h, /dobírka 1\s?290 Kč/);
  assert.doesNotMatch(h, /TEST/);
  const po = panel({ id: 7, zasilky: [{ dopravce: 'ppl', stav: 'podana', cislo_zasilky: '41252421813<x>', tracking_url: 'https://www.ppl.cz/vyhledat-zasilku?shipmentId=41252421813', vytvoreno: '2026-11-12T10:00:00Z' }] });
  assert.match(po, /41252421813&lt;x&gt;/);
  assert.match(po, /stahnoutStitekPpl\(7, this, true\)/);
  assert.match(po, /Sledování zásilky/);
  const nedok = panel({ id: 7, zasilky: [{ dopravce: 'ppl', stav: 'nedokoncena', vytvoreno: '2026-11-12T10:00:00Z' }] });
  assert.match(nedok, /ještě zpracovává/);
  assert.match(nedok, /stahnoutStitekPpl\(7, this, false\)/);
});

// ---------- routy POST /:id/ppl a GET /:id/ppl/stitek ----------

function routerPpl({ objednavka = { ...OBJ, stav: 'nova' }, zasilky = [], klient }) {
  const db = { zasilky: zasilky.map((z, i) => ({ id: i + 1, ...z })), commit: 0, rollback: 0 };
  const query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    // migrace při načtení routy
    if (/^(BEGIN|CREATE|ALTER|SELECT pg_advisory_xact_lock)/.test(s) || s.includes('WHERE obj_email IS NULL')) return { rows: [] };
    if (s === 'COMMIT') { db.commit++; return { rows: [] }; }
    if (s === 'ROLLBACK') { db.rollback++; return { rows: [] }; }
    if (s.includes('FROM objednavky o JOIN zakaznici')) return { rows: objednavka && params[0] === objednavka.id ? [objednavka] : [] };
    if (s.startsWith('SELECT dopravce, cislo_zasilky FROM zasilky')) return { rows: db.zasilky.filter(z => ['podana', 'nedokoncena'].includes(z.stav)) };
    if (s.startsWith('INSERT INTO zasilky')) {
      const z = s.includes("'nedokoncena'")
        ? { id: db.zasilky.length + 1, dopravce: 'ppl', stav: 'nedokoncena', data: JSON.parse(params[1]), chyba: params[2] }
        : { id: db.zasilky.length + 1, dopravce: 'ppl', stav: 'podana', cislo_zasilky: params[1], tracking_url: params[2], data: JSON.parse(params[3]), stitek_pdf: params[4], vytvoreno: new Date() };
      db.zasilky.push(z);
      return { rows: [z] };
    }
    if (s.startsWith('SELECT id, stav, data, cislo_zasilky, stitek_pdf FROM zasilky')) {
      return { rows: db.zasilky.filter(z => z.dopravce === 'ppl' && ['podana', 'nedokoncena'].includes(z.stav)).slice(-1) };
    }
    if (s.startsWith("UPDATE zasilky SET stav = 'podana'")) {
      Object.assign(db.zasilky.find(x => x.id === params[0]), { stav: 'podana', cislo_zasilky: params[1], tracking_url: params[2], stitek_pdf: params[4] });
      return { rows: [] };
    }
    throw new Error('Neočekávaný dotaz: ' + s);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const pplMock = { ...require('../lib/ppl'), stav: () => ({ spojeni: true, prostredi: 'ostre', problem: null }), vytvoritKlienta: () => klient };
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    '../lib/ppl': pplMock,
    '../middleware/adminAuth': (req, res, next) => next()
  });
  return { db, podat: najitHandler(router, 'post', '/:id/ppl'), stitek: najitHandler(router, 'get', '/:id/ppl/stitek') };
}
function resSPdf() {
  const res = vytvoritRes();
  res.hlavicky = {};
  res.setHeader = (k, v) => { res.hlavicky[k] = v; };
  res.send = b => { res.body = b; return res; };
  return res;
}

test('podání do PPL: zásilka, číslo, sledování a štítek se uloží; druhé podání 409', async () => {
  const tela = [];
  const klient = {
    vytvoritZasilku: async t => { tela.push(t); return BATCH; },
    cekatNaDavku: async () => ({ items: [{ shipmentNumber: '41252421813', importState: 'Complete' }] }),
    stahnoutEtiketu: async () => PDF
  };
  const { db, podat, stitek } = routerPpl({ klient });
  const res = vytvoritRes();
  await podat({ params: { id: '7' }, body: { pocet: 1 } }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.zasilka.cislo_zasilky, '41252421813');
  assert.match(res.body.zasilka.tracking_url, /ppl\.cz.*41252421813/);
  assert.strictEqual(tela[0].shipments[0].referenceId, '2026042');
  assert.strictEqual(db.commit, 1);
  assert.strictEqual(db.zasilky[0].data.batchId, BATCH);

  const r2 = vytvoritRes();
  await podat({ params: { id: '7' }, body: {} }, r2);
  assert.strictEqual(r2.statusCode, 409);
  assert.strictEqual(tela.length, 1);

  const r3 = resSPdf();
  await stitek({ params: { id: '7' } }, r3);
  assert.strictEqual(r3.hlavicky['Content-Type'], 'application/pdf');
  assert.strictEqual(r3.body, PDF);
});

test('PPL odmítne zásilku: nic se neuloží a hláška od PPL se ukáže', async () => {
  const klient = {
    vytvoritZasilku: async () => BATCH,
    cekatNaDavku: async () => { throw new Error('PPL zásilku nepřijalo: Invalid zipCode'); },
    stahnoutEtiketu: async () => PDF
  };
  const { db, podat } = routerPpl({ klient });
  const res = vytvoritRes();
  await podat({ params: { id: '7' }, body: {} }, res);
  assert.strictEqual(res.statusCode, 502);
  assert.match(res.body.chyba, /Invalid zipCode/);
  assert.strictEqual(db.zasilky.length, 0);
  assert.strictEqual(db.rollback, 1);
});

test('PPL nestihne zpracovat: zásilka se uloží jako nedokončená, štítek ji pak dokončí', async () => {
  let hotovo = false;
  const klient = {
    vytvoritZasilku: async () => BATCH,
    cekatNaDavku: async () => {
      if (!hotovo) throw new Error('PPL zásilku nezpracovalo v časovém limitu');
      return { items: [{ shipmentNumber: '999', importState: 'Complete' }] };
    },
    stahnoutEtiketu: async () => PDF
  };
  const { db, podat, stitek } = routerPpl({ klient });
  const res = vytvoritRes();
  await podat({ params: { id: '7' }, body: {} }, res);
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(db.zasilky[0].stav, 'nedokoncena');
  assert.strictEqual(db.zasilky[0].data.batchId, BATCH);

  const r2 = vytvoritRes();
  await podat({ params: { id: '7' }, body: {} }, r2);
  assert.strictEqual(r2.statusCode, 409, 'nedokončená zásilka brání druhému založení');

  hotovo = true;
  const r3 = resSPdf();
  await stitek({ params: { id: '7' } }, r3);
  assert.strictEqual(r3.body, PDF);
  assert.strictEqual(db.zasilky[0].stav, 'podana');
  assert.strictEqual(db.zasilky[0].cislo_zasilky, '999');
});

test('PPL nejde u výdejního místa, zrušené objednávky ani když už je zásilka u jiného dopravce', async () => {
  const klient = { vytvoritZasilku: async () => { throw new Error('nemělo se volat'); } };
  let r = vytvoritRes();
  await routerPpl({ objednavka: { ...OBJ, stav: 'nova', doprava: 'zasilkovna' }, klient }).podat({ params: { id: '7' }, body: {} }, r);
  assert.strictEqual(r.statusCode, 400);
  r = vytvoritRes();
  await routerPpl({ objednavka: { ...OBJ, stav: 'zrusena' }, klient }).podat({ params: { id: '7' }, body: {} }, r);
  assert.strictEqual(r.statusCode, 400);
  r = vytvoritRes();
  await routerPpl({ objednavka: { ...OBJ, stav: 'nova', doprava: 'gls_adresa' }, zasilky: [{ dopravce: 'gls', stav: 'podana', cislo_zasilky: '123' }], klient })
    .podat({ params: { id: '7' }, body: {} }, r);
  assert.strictEqual(r.statusCode, 409);
});
