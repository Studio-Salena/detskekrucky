// Doplatek k dárkovému poukazu na pokladně: poukaz nepokryje celý nákup, zbytek
// zákazník doplatí. Prodej se uloží s celkem = doplatek (jen ten jde do tržeb),
// poukaz se vyčerpá a uplatnění se zapíše - vše v jedné transakci.
const test = require('node:test');
const assert = require('node:assert/strict');

function vytvoritStav(poukaz) {
  return {
    poukazy: [{ id: 1, kod: 'DK-AAAA-BBBB', ean: '2200000000001', stav: 'aktivni', zustatek: 1000, platnost_do: '2099-01-01', ...poukaz }],
    prodeje: [], pouziti: [], log: []
  };
}

function vytvoritMockClient(stav) {
  return {
    release() {},
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      stav.log.push(s.split(' ')[0]);
      if (/^(BEGIN|COMMIT|ROLLBACK|CREATE|ALTER)/.test(s)) return {};
      if (s.startsWith('SELECT * FROM darkove_poukazy')) {
        return { rows: stav.poukazy.filter(p => p.kod === params[0] || p.ean === params[0]).map(p => ({ ...p })) };
      }
      if (s.startsWith('INSERT INTO prodejna_prodeje')) {
        const [zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, hotovost_vraceno, poukaz_castka, poukaz_kod] = params;
        const prodej = { id: 50, zakaznik, platba, celkem, mezisoucet, hotovost_prijato, hotovost_vraceno, poukaz_castka, poukaz_kod };
        stav.prodeje.push(prodej);
        return { rows: [prodej] };
      }
      if (s.startsWith('UPDATE darkove_poukazy SET zustatek = 0')) {
        Object.assign(stav.poukazy.find(p => p.id === params[0]), { zustatek: 0, stav: 'pouzity' });
        return {};
      }
      if (s.startsWith('INSERT INTO poukazy_pouziti')) {
        stav.pouziti.push({ poukaz_id: params[0], castka: params[1], prodej_id: params[2] });
        return {};
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistRouter(stav) {
  const routePath = require.resolve('../routes/prodejna.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  const pool = { async connect() { return vytvoritMockClient(stav); }, async query(sql, p) { return vytvoritMockClient(stav).query(sql, p); } };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  const layer = router.stack.find(l => l.route && l.route.path === '/' && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function vytvoritRes() {
  const res = { statusCode: 200, body: null };
  res.status = kod => { res.statusCode = kod; return res; };
  res.json = telo => { res.body = telo; return res; };
  return res;
}

const PRODEJ = { polozky: [{ produkt_id: 1, velikost: 25, pocet: 1, cena: 1600 }], celkem: 1600, mezisoucet: 1600, sleva: 0 };

test('poukaz 1000 Kč na nákup 1600 Kč: doplatek 600 Kč kartou, poukaz vyčerpaný', async () => {
  const stav = vytvoritStav();
  const res = vytvoritRes();
  await nacistRouter(stav)({ body: { ...PRODEJ, platba: 'poukaz', poukaz_kod: 'dk-aaaa-bbbb', doplatek_platba: 'karta' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual({ ...stav.prodeje[0], id: undefined, zakaznik: undefined }, {
    id: undefined, zakaznik: undefined, platba: 'karta', celkem: 600, mezisoucet: 1600,
    hotovost_prijato: null, hotovost_vraceno: null, poukaz_castka: 1000, poukaz_kod: 'DK-AAAA-BBBB'
  });
  assert.equal(stav.poukazy[0].zustatek, 0);
  assert.equal(stav.poukazy[0].stav, 'pouzity');
  assert.deepEqual(stav.pouziti, [{ poukaz_id: 1, castka: 1000, prodej_id: 50 }]);
  assert.equal(stav.log.at(-1), 'COMMIT');
});

test('doplatek hotově: přijato a vráceno se počítá z doplatku, poukaz jde zadat i EANem', async () => {
  const stav = vytvoritStav();
  const res = vytvoritRes();
  await nacistRouter(stav)({ body: { ...PRODEJ, poukaz_kod: '2200000000001', doplatek_platba: 'hotovost', hotovost_prijato: 1000 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(stav.prodeje[0].hotovost_prijato, 1000);
  assert.equal(stav.prodeje[0].hotovost_vraceno, 400);
});

test('odmítne: poukaz pokryje celý nákup, neaktivní, prošlý, neznámý, bez způsobu doplatku', async () => {
  const pripady = [
    [{ zustatek: 2000 }, 'karta', /pokryje celý nákup/],
    [{ stav: 'pouzity' }, 'karta', /není aktivní/],
    [{ platnost_do: '2020-01-01' }, 'karta', /vypršela/],
    [{ kod: 'JINY', ean: 'JINY' }, 'karta', /nebyl nalezen/],
    [{}, 'poukaz', /doplatí zbytek/]
  ];
  for (const [poukaz, doplatek_platba, chyba] of pripady) {
    const stav = vytvoritStav(poukaz);
    const res = vytvoritRes();
    await nacistRouter(stav)({ body: { ...PRODEJ, poukaz_kod: 'DK-AAAA-BBBB', doplatek_platba } }, res);
    assert.equal(res.statusCode, 400, String(chyba));
    assert.match(res.body.chyba, chyba);
    assert.equal(stav.prodeje.length, 0, 'nic se neuloží');
    assert.equal(stav.pouziti.length, 0);
  }
});

test('tržby: prodej s doplatkem se z tržeb nevyřazuje (počítá se jen doplatek)', () => {
  const zdroj = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'poukazy.js'), 'utf8');
  assert.match(zdroj, /AND COALESCE\(pr\.poukaz_castka, 0\) = 0\) AS zapocitano_pri_vydani/);
  assert.match(zdroj, /LEFT JOIN prodejna_prodeje pr ON pr\.id = pp\.prodej_id/);
});
