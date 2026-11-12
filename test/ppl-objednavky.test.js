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
