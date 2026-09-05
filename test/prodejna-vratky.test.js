// P2.9 (rozšířeno) - POST /api/prodejna/vratky je admin-only, ale i tak
// "frontend není autorita": položky navázané na konkrétní prodej/objednávku
// se musí ověřit proti tomu, co v nich skutečně bylo, včetně toho, co už
// bylo vráceno dřív (opakované částečné vratky).
const test = require('node:test');
const assert = require('node:assert/strict');

function vytvoritStav() {
  return {
    prodejnaProdeje: [{ id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: 3 }, { produkt_id: 2, velikost: 25, pocet: 1 }] }],
    objednavky: [{ id: 20, stav: 'nova' }],
    objednavkyPolozky: [{ objednavka_id: 20, produkt_id: 5, velikost: 26, pocet: 2 }],
    vratky: [],
    dalsiVratkaId: 1,
    sklad: new Map(), // "produkt_id_velikost" -> pocet_kusu
    callLog: []
  };
}

function vytvoritMockClient(stav) {
  return {
    release() {},
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (stav.callLog) stav.callLog.push({ sql: s, params });
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return {};
      if (s.startsWith('CREATE TABLE') || s.startsWith('ALTER TABLE')) return {};

      if (s.startsWith('SELECT id, polozky FROM prodejna_prodeje WHERE id')) {
        const [id] = params;
        const p = stav.prodejnaProdeje.find(p => p.id === id);
        return { rows: p ? [{ id: p.id, polozky: p.polozky }] : [] };
      }
      if (s.startsWith('SELECT id, stav FROM objednavky WHERE id')) {
        const [id] = params;
        const o = stav.objednavky.find(o => o.id === id);
        return { rows: o ? [{ id: o.id, stav: o.stav }] : [] };
      }
      if (s.startsWith('SELECT id FROM vratky WHERE id')) {
        const [id] = params;
        const v = stav.vratky.find(v => v.id === Number(id));
        return { rows: v ? [{ id: v.id }] : [] };
      }
      if (s.startsWith('SELECT produkt_id, velikost, pocet FROM objednavky_polozky WHERE objednavka_id')) {
        const [id] = params;
        return { rows: stav.objednavkyPolozky.filter(p => p.objednavka_id === id) };
      }
      if (s.startsWith('SELECT polozky FROM vratky WHERE')) {
        const [id] = params;
        const klic = s.includes('prodej_id') ? 'prodej_id' : 'objednavka_id';
        return { rows: stav.vratky.filter(v => v[klic] === id).map(v => ({ polozky: v.polozky })) };
      }
      if (s.startsWith('INSERT INTO vratky')) {
        const [prodej_id, objednavka_id, polozkyJson, castka, duvod, vraceno_na_sklad] = params;
        const zaznam = { id: stav.dalsiVratkaId++, prodej_id, objednavka_id, polozky: JSON.parse(polozkyJson), castka, duvod, vraceno_na_sklad };
        stav.vratky.push(zaznam);
        return { rows: [zaznam] };
      }
      if (s.startsWith('INSERT INTO sklad')) {
        const [produkt_id, velikost, pocet] = params;
        const klic = `${produkt_id}_${velikost}`;
        stav.sklad.set(klic, (stav.sklad.get(klic) || 0) + pocet);
        return {};
      }
      if (s.startsWith('INSERT INTO pohyby_skladu')) return {};

      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistProdejnaSMockPoolem(stav) {
  const routePath = require.resolve('../routes/prodejna.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  const pool = {
    async connect() { return vytvoritMockClient(stav); },
    async query(sql, params) { return vytvoritMockClient(stav).query(sql, params); }
  };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  return router;
}

function najitHandler(router, method, urlPath) {
  const layer = router.stack.find(l => l.route && l.route.path === urlPath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function vytvoritRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (kod) { res.statusCode = kod; return res; };
  res.json = function (telo) { res.body = telo; return res; };
  return res;
}

test('vratka navázaná na prodej se skutečně prodanými kusy projde', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { prodej_id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: 2 }], castka: 1000 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(stav.sklad.get('1_24'), 2);
});

test('položka, která v navázaném prodeji nebyla, je odmítnuta', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { prodej_id: 10, polozky: [{ produkt_id: 999, velikost: 24, pocet: 1 }], castka: 500 } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(stav.vratky.length, 0);
});

test('vrácení víc kusů, než bylo v prodeji, je odmítnuto', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { prodej_id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: 10 }], castka: 5000 } }, res); // prodáno jen 3

  assert.equal(res.statusCode, 400);
  assert.equal(stav.vratky.length, 0);
});

test('opakovaná vratka zohledňuje už dřív vrácené množství', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');

  // Poprvé vrátit 2 z 3 ks - má projít.
  const res1 = vytvoritRes();
  await handler({ body: { prodej_id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: 2 }], castka: 1000 } }, res1);
  assert.equal(res1.statusCode, 200);

  // Podruhé zkusit vrátit dalšího 2 ks - zbývá jen 1, musí selhat.
  const res2 = vytvoritRes();
  await handler({ body: { prodej_id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: 2 }], castka: 1000 } }, res2);
  assert.equal(res2.statusCode, 400);

  // Podruhé zkusit vrátit přesně zbývající 1 ks - musí projít.
  const res3 = vytvoritRes();
  await handler({ body: { prodej_id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }], castka: 500 } }, res3);
  assert.equal(res3.statusCode, 200);
});

test('vratka navázaná na e-shop objednávku se ověřuje proti objednavky_polozky', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');

  const ok = vytvoritRes();
  await handler({ body: { objednavka_id: 20, polozky: [{ produkt_id: 5, velikost: 26, pocet: 2 }], castka: 1000 } }, ok);
  assert.equal(ok.statusCode, 200);

  const stav2 = vytvoritStav();
  const router2 = nacistProdejnaSMockPoolem(stav2);
  const handler2 = najitHandler(router2, 'post', '/vratky');
  const spatne = vytvoritRes();
  await handler2({ body: { objednavka_id: 20, polozky: [{ produkt_id: 5, velikost: 26, pocet: 3 }], castka: 1500 } }, spatne); // objednáno jen 2
  assert.equal(spatne.statusCode, 400);
});

test('vratka bez vazby na prodej/objednávku (ruční oprava skladu) stále projde základní validací', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }], castka: 500, duvod: 'ruční oprava' } }, res);

  assert.equal(res.statusCode, 200);
});

test('vratka navázaná na objednávku zamyká objednávku (FOR UPDATE) PŘED čtením existujících vratek', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { objednavka_id: 20, polozky: [{ produkt_id: 5, velikost: 26, pocet: 1 }], castka: 500 } }, res);

  assert.equal(res.statusCode, 200);
  const lockIdx = stav.callLog.findIndex(c => c.sql.startsWith('SELECT id, stav FROM objednavky WHERE id') && c.sql.includes('FOR UPDATE'));
  const vratkyIdx = stav.callLog.findIndex(c => c.sql.startsWith('SELECT polozky FROM vratky WHERE'));
  assert.notEqual(lockIdx, -1);
  assert.notEqual(vratkyIdx, -1);
  assert.ok(lockIdx < vratkyIdx, 'zámek objednávky musí proběhnout před čtením existujících vratek');
});

test('vratka na neexistující objednávku vrací 404 a nevznikne', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { objednavka_id: 999, polozky: [{ produkt_id: 5, velikost: 26, pocet: 1 }], castka: 500 } }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(stav.vratky.length, 0);
});

test('zdrojový prodej se při vratce zamyká FOR UPDATE (serializace souběžných vratek stejného prodeje)', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { prodej_id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }], castka: 500 } }, res);

  assert.equal(res.statusCode, 200);
  const lockDotaz = stav.callLog.find(c => c.sql.startsWith('SELECT id, polozky FROM prodejna_prodeje WHERE id'));
  assert.ok(lockDotaz, 'zdrojový prodej musí být načten');
  assert.ok(lockDotaz.sql.includes('FOR UPDATE'), 'načtení zdrojového prodeje musí použít FOR UPDATE');
});

test('vratku na už zrušenou objednávku nelze vytvořit (409) - sklad by se vrátil podruhé', async () => {
  const stav = vytvoritStav();
  stav.objednavky[0].stav = 'zrusena'; // sklad už byl vrácen zrušením objednávky
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { objednavka_id: 20, polozky: [{ produkt_id: 5, velikost: 26, pocet: 1 }], castka: 500 } }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.chyba, /zrušenou objednávku/);
  assert.equal(stav.vratky.length, 0);
  assert.equal(stav.sklad.get('5_26'), undefined); // sklad nedotčen
  const pohybyVolani = stav.callLog.filter(c => c.sql.startsWith('INSERT INTO pohyby_skladu'));
  assert.equal(pohybyVolani.length, 0); // nevznikl žádný pohyb skladu

  // zámek objednávky (a kontrola stavu) musí proběhnout PŘED čtením
  // objednavky_polozky a existujících vratek
  const lockIdx = stav.callLog.findIndex(c => c.sql.startsWith('SELECT id, stav FROM objednavky WHERE id'));
  const polozkyIdx = stav.callLog.findIndex(c => c.sql.startsWith('SELECT produkt_id, velikost, pocet FROM objednavky_polozky'));
  const vratkyIdx = stav.callLog.findIndex(c => c.sql.startsWith('SELECT polozky FROM vratky WHERE'));
  assert.notEqual(lockIdx, -1);
  assert.equal(polozkyIdx, -1, 'objednavky_polozky se nemají číst, když je objednávka zrušená');
  assert.equal(vratkyIdx, -1, 'vratky se nemají číst, když je objednávka zrušená');
});

test('neplatný počet kusů (desetinný/záporný) je odmítnut i tady', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const handler = najitHandler(router, 'post', '/vratky');
  const res = vytvoritRes();
  await handler({ body: { prodej_id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: -1 }], castka: 500 } }, res);

  assert.equal(res.statusCode, 400);
});

test('DELETE /vratky/:id na existující vratku je zakázán (409) - vratka je immutable auditní stopa', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const vytvoritHandler = najitHandler(router, 'post', '/vratky');
  const vytvorRes = vytvoritRes();
  await vytvoritHandler({ body: { prodej_id: 10, polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }], castka: 500 } }, vytvorRes);
  assert.equal(vytvorRes.statusCode, 200);
  const skladPredMazanim = stav.sklad.get('1_24');

  const smazatHandler = najitHandler(router, 'delete', '/vratky/:id');
  const smazatRes = vytvoritRes();
  await smazatHandler({ params: { id: String(vytvorRes.body.id) } }, smazatRes);

  assert.equal(smazatRes.statusCode, 409);
  assert.match(smazatRes.body.chyba, /nelze smazat/);
  assert.equal(stav.vratky.length, 1); // vratka stále existuje
  assert.equal(stav.sklad.get('1_24'), skladPredMazanim); // sklad se nezměnil
});

test('DELETE /vratky/:id na neexistující vratku vrací 404', async () => {
  const stav = vytvoritStav();
  const router = nacistProdejnaSMockPoolem(stav);
  const smazatHandler = najitHandler(router, 'delete', '/vratky/:id');
  const res = vytvoritRes();
  await smazatHandler({ params: { id: '999' } }, res);

  assert.equal(res.statusCode, 404);
});
