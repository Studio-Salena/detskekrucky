// Krok 0 - API modelů bot (routes/modely.js) a přiřazení modelu při
// založení/úpravě produktu (routes/sklad.js). Mock pool, bez skutečné DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { klicModelu } = require('../lib/modely');

process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'test-heslo';

function vytvoritStav() {
  return {
    dotazy: [],
    modely: [
      { id: 1, klic: klicModelu('Froddo', 'Autumn'), slug: 'froddo-autumn', znacka: 'Froddo', nazev: 'Autumn', kategorie: 'celorocky',
        barefoot: null, sirka: [], nart: [], dominantni_palec: null, zapinani: [], membrana: null, material: null, pohlavi: null, proc_jsme_vybrali: [] },
      { id: 2, klic: klicModelu('Beda', 'Zuzi'), slug: 'beda-zuzi', znacka: 'Beda', nazev: 'Zuzi', kategorie: 'papuce',
        barefoot: null, sirka: [], nart: [], dominantni_palec: null, zapinani: [], membrana: null, material: null, pohlavi: null, proc_jsme_vybrali: [] }
    ],
    kategorie: ['celorocky', 'papuce', 'doplnky'],
    nastaveni: null
  };
}

function vytvoritMockDb(stav) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      stav.dotazy.push({ sql: s, params });
      if (s.startsWith('CREATE TABLE') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(s)) return { rows: [] };
      if (s.startsWith('SELECT id, znacka, nazev, kategorie FROM produkty WHERE model_id IS NULL')) return { rows: [] };
      if (s.startsWith("SELECT hodnota FROM nastaveni WHERE klic = 'katalog'")) return { rows: stav.nastaveni ? [{ hodnota: stav.nastaveni }] : [] };
      if (s.startsWith("INSERT INTO nastaveni (klic, hodnota) VALUES ('katalog'")) { stav.nastaveni = params[0]; return { rows: [] }; }
      if (s.startsWith('SELECT * FROM modely WHERE id = $1 FOR UPDATE')) return { rows: stav.modely.filter(m => m.id === params[0]).map(m => ({ ...m })) };
      if (s.startsWith('SELECT 1 FROM kategorie WHERE slug')) return { rows: stav.kategorie.includes(params[0]) ? [{}] : [] };
      if (s.startsWith('SELECT id FROM modely WHERE klic = $1 AND id <> $2')) return { rows: stav.modely.filter(m => m.klic === params[0] && m.id !== params[1]) };
      if (s.startsWith('UPDATE modely SET') && !s.includes('= ANY(')) {
        const sloupce = s.slice('UPDATE modely SET '.length, s.indexOf(', upraveno')).split(', ').map(x => x.split(' = ')[0]);
        const id = params[params.length - 1];
        const m = stav.modely.find(x => x.id === id);
        sloupce.forEach((k, i) => { m[k] = params[i]; });
        return { rows: [{ ...m }] };
      }
      if (s.startsWith('UPDATE modely SET') && s.includes('= ANY(')) {
        const sloupce = s.slice('UPDATE modely SET '.length, s.indexOf(', upraveno')).split(', ').map(x => x.split(' = ')[0]);
        const ids = params[params.length - 1];
        const zasazene = stav.modely.filter(m => ids.includes(m.id));
        zasazene.forEach(m => sloupce.forEach((k, i) => { m[k] = params[i]; }));
        return { rows: zasazene.map(m => ({ id: m.id })) };
      }
      if (s.startsWith('UPDATE produkty SET')) return { rows: [] };
      if (s.startsWith('SELECT m.*')) {
        return { rows: stav.modely.map(m => ({ ...m, pocet_produktu: 2, kusu: 3, velikosti: [25, 22], kategorie_produktu: m.id === 2 ? ['papuce', 'pantofle'] : [m.kategorie], na_eshopu: true, ma_fotku: false })) };
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistRouter(stav) {
  const routePath = require.resolve('../routes/modely.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  const db = vytvoritMockDb(stav);
  db.connect = async () => ({ ...vytvoritMockDb(stav), release() { stav.uvolneno = (stav.uvolneno || 0) + 1; } });
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: db };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  return router;
}

async function spustit(stav, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/modely', nacistRouter(stav));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/modely`;
  const volat = async (cesta, { method = 'GET', body, admin = true } = {}) => {
    const res = await fetch(base + cesta, {
      method,
      headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-heslo': process.env.ADMIN_HESLO } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(volat); } finally { await new Promise(r => server.close(r)); }
}

test('bez admin hesla: seznam, úprava i uložení nastavení vrátí 403; veřejné nastavení katalogu jde číst', async () => {
  const stav = vytvoritStav();
  await spustit(stav, async (volat) => {
    assert.equal((await volat('/', { admin: false })).status, 403);
    assert.equal((await volat('/1', { method: 'PATCH', body: { barefoot: true }, admin: false })).status, 403);
    assert.equal((await volat('/nastaveni-katalogu', { method: 'PUT', body: {}, admin: false })).status, 403);
    const verejne = await volat('/nastaveni-katalogu', { admin: false });
    assert.equal(verejne.status, 200);
    assert.equal(verejne.body.vekoveSkupiny.length, 4, 'bez uloženého nastavení vrací výchozí');
  });
  assert.equal(stav.modely[0].barefoot, null);
});

test('seznam modelů: bez interního klíče, seřazené velikosti, stav vyplnění a kontrola kategorie', async () => {
  await spustit(vytvoritStav(), async (volat) => {
    const { status, body } = await volat('/');
    assert.equal(status, 200);
    assert.ok(body.volby.sirka.siroka);
    assert.deepEqual(body.kategorieBezVlastnosti, ['doplnky', 'pece-o-obuv']);
    assert.equal(body.modely.length, 2);
    for (const m of body.modely) assert.equal('klic' in m, false);
    assert.deepEqual(body.modely[0].velikosti, [22, 25]);
    assert.equal(body.modely[0].vyplneno, false);
    assert.equal(body.modely[0].kategorie_ke_kontrole, false);
    assert.equal(body.modely[1].kategorie_ke_kontrole, true);
  });
});

test('úprava vlastností: uloží se v transakci, produkty se nemění, vrátí stav vyplnění', async () => {
  const stav = vytvoritStav();
  await spustit(stav, async (volat) => {
    const { status, body } = await volat('/1', { method: 'PATCH', body: { barefoot: true, sirka: ['siroka', 'normalni'], zapinani: ['suchy_zip'], membrana: false, material: 'kuze' } });
    assert.equal(status, 200);
    assert.equal(body.vyplneno, true);
    assert.equal('klic' in body, false);
  });
  assert.deepEqual(stav.modely[0].sirka, ['normalni', 'siroka']);
  const sql = stav.dotazy.map(d => d.sql);
  assert.ok(sql.indexOf('BEGIN') < sql.findIndex(x => x.startsWith('UPDATE modely')));
  assert.ok(sql.includes('COMMIT'));
  assert.equal(sql.some(x => x.startsWith('UPDATE produkty')), false);
  assert.equal(stav.uvolneno, 1);
});

test('změna kategorie, značky a názvu se propíše do všech velikostí modelu', async () => {
  const stav = vytvoritStav();
  await spustit(stav, async (volat) => {
    assert.equal((await volat('/2', { method: 'PATCH', body: { kategorie: 'celorocky', znacka: 'BEDA ', nazev: 'Zuzi Nová' } })).status, 200);
  });
  const produkty = stav.dotazy.filter(d => d.sql.startsWith('UPDATE produkty'));
  assert.deepEqual(produkty.map(d => d.params), [['celorocky', 2], ['BEDA', 'Zuzi Nová', 2]]);
  assert.equal(stav.modely[1].klic, klicModelu('Beda', 'Zuzi Nová'));
  assert.equal(stav.modely[1].slug, 'beda-zuzi', 'adresa se přejmenováním nemění');
});

test('neplatná data: 400 bez zásahu do DB; neznámá kategorie 400; kolize názvu 409; neexistující model 404', async () => {
  const stav = vytvoritStav();
  await spustit(stav, async (volat) => {
    const pred = stav.dotazy.length;
    assert.equal((await volat('/1', { method: 'PATCH', body: { sirka: ['obri'] } })).status, 400);
    assert.equal((await volat('/abc', { method: 'PATCH', body: { barefoot: true } })).status, 400);
    assert.equal(stav.dotazy.length, pred, 'neplatná data se k DB nedostanou');

    const kat = await volat('/1', { method: 'PATCH', body: { kategorie: 'neexistuje' } });
    assert.equal(kat.status, 400);
    const kolize = await volat('/1', { method: 'PATCH', body: { znacka: 'beda', nazev: 'ZUZI' } });
    assert.equal(kolize.status, 409);
    assert.equal((await volat('/99', { method: 'PATCH', body: { barefoot: true } })).status, 404);
  });
  assert.equal(stav.modely[0].kategorie, 'celorocky');
  assert.equal(stav.modely[0].znacka, 'Froddo');
  assert.equal(stav.dotazy.filter(d => d.sql === 'ROLLBACK').length, 3);
  assert.equal(stav.dotazy.some(d => d.sql.startsWith('UPDATE')), false);
});

test('nastavení katalogu: uloží platné, odmítne neplatné', async () => {
  const stav = vytvoritStav();
  await spustit(stav, async (volat) => {
    assert.equal((await volat('/nastaveni-katalogu', { method: 'PUT', body: { vekoveSkupiny: [{ nazev: 'x', od: 30, do: 20 }], pohlavi: false } })).status, 400);
    assert.equal(stav.nastaveni, null);
    const ok = await volat('/nastaveni-katalogu', { method: 'PUT', body: { vekoveSkupiny: [{ nazev: ' Mimi ', od: 16, do: 20 }], pohlavi: true } });
    assert.equal(ok.status, 200);
    assert.deepEqual(stav.nastaveni, { vekoveSkupiny: [{ nazev: 'Mimi', od: 16, do: 20 }], pohlavi: true });
    assert.deepEqual((await volat('/nastaveni-katalogu', { admin: false })).body, stav.nastaveni);
  });
});

// ═══ hromadná změna ═══

test('hromadná změna kategorie: všechny vybrané modely i jejich velikosti v jedné transakci', async () => {
  const stav = vytvoritStav();
  await spustit(stav, async (volat) => {
    const r = await volat('/hromadne', { method: 'POST', body: { ids: [1, 2], zmeny: { kategorie: 'papuce' } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { upraveno: 2 });
  });
  assert.deepEqual(stav.modely.map(m => m.kategorie), ['papuce', 'papuce']);
  const produkty = stav.dotazy.filter(d => d.sql.startsWith('UPDATE produkty'));
  assert.deepEqual(produkty.map(d => d.params), [['papuce', [1, 2]]]);
  const sql = stav.dotazy.map(d => d.sql);
  assert.ok(sql.indexOf('BEGIN') < sql.findIndex(x => x.startsWith('UPDATE modely')));
  assert.ok(sql.indexOf('COMMIT') > sql.findIndex(x => x.startsWith('UPDATE produkty')));
});

test('hromadná změna vlastnosti nesahá na produkty; vymazání hodnoty přes null', async () => {
  const stav = vytvoritStav();
  stav.modely[0].material = 'kuze';
  await spustit(stav, async (volat) => {
    assert.equal((await volat('/hromadne', { method: 'POST', body: { ids: [1, 2], zmeny: { barefoot: true } } })).status, 200);
    assert.equal((await volat('/hromadne', { method: 'POST', body: { ids: [1], zmeny: { material: null } } })).status, 200);
  });
  assert.deepEqual(stav.modely.map(m => m.barefoot), [true, true]);
  assert.equal(stav.modely[0].material, null);
  assert.equal(stav.dotazy.some(d => d.sql.startsWith('UPDATE produkty')), false);
});

test('hromadná změna: bez hesla 403, neplatná data 400 bez DB, neznámá kategorie 400, neexistující model 404 a nic se nezmění', async () => {
  const stav = vytvoritStav();
  await spustit(stav, async (volat) => {
    assert.equal((await volat('/hromadne', { method: 'POST', body: { ids: [1], zmeny: { barefoot: true } }, admin: false })).status, 403);
    const pred = stav.dotazy.length;
    assert.equal((await volat('/hromadne', { method: 'POST', body: { ids: [1], zmeny: { znacka: 'X' } } })).status, 400);
    assert.equal((await volat('/hromadne', { method: 'POST', body: { ids: [], zmeny: { barefoot: true } } })).status, 400);
    assert.equal(stav.dotazy.length, pred);
    assert.equal((await volat('/hromadne', { method: 'POST', body: { ids: [1], zmeny: { kategorie: 'neexistuje' } } })).status, 400);
    const chybi = await volat('/hromadne', { method: 'POST', body: { ids: [1, 99], zmeny: { kategorie: 'papuce' } } });
    assert.equal(chybi.status, 404);
  });
  // Mock UPDATE sice model 1 změnil, ale route musela transakci vrátit
  const sql = stav.dotazy.map(d => d.sql);
  assert.equal(sql.filter(x => x === 'ROLLBACK').length, 2);
  assert.equal(sql.includes('COMMIT'), false);
  assert.equal(stav.dotazy.some(d => d.sql.startsWith('UPDATE produkty')), false);
});

// ═══ routes/sklad.js - přiřazení modelu ═══

function nacistSklad(dotazy, { selhaniModelu = false } = {}) {
  const routePath = require.resolve('../routes/sklad.js');
  const poolPath = require.resolve('../db/pool');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  const db = {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      dotazy.push({ sql: s, params });
      if (s.startsWith('ALTER TABLE')) return { rows: [] };
      if (s.startsWith('INSERT INTO produkty')) return { rows: [{ id: 50, nazev: params[0], znacka: params[1] }] };
      if (s.startsWith('UPDATE produkty SET nazev')) return { rows: [{ id: Number(params[8]), nazev: params[0], znacka: params[1] }] };
      if (s.startsWith('SELECT id, znacka, nazev, kategorie FROM produkty WHERE id')) {
        if (selhaniModelu) throw new Error('tabulka modely zatím neexistuje');
        return { rows: [{ id: params[0], znacka: 'Froddo', nazev: 'Autumn', kategorie: 'celorocky' }] };
      }
      if (s.startsWith('SELECT id FROM modely WHERE klic')) return { rows: [{ id: 7 }] };
      if (s.startsWith('UPDATE produkty SET model_id')) return { rows: [] };
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(s)) return { rows: [] };
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
  db.connect = async () => ({ query: db.query, release() {} });
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: db };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  return router;
}

function handler(router, method, cesta) {
  const layer = router.stack.find(l => l.route && l.route.path === cesta && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function res() {
  const r = { statusCode: 200, body: null };
  r.status = k => { r.statusCode = k; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}

test('založení i úprava produktu ho přiřadí k modelu podle značky a názvu', async () => {
  const dotazy = [];
  const router = nacistSklad(dotazy);
  const r1 = res();
  await handler(router, 'post', '/produkty')({ body: { nazev: 'Autumn', znacka: 'Froddo', kategorie: 'celorocky', cena: 1490 } }, r1);
  assert.equal(r1.statusCode, 200);
  const r2 = res();
  await handler(router, 'patch', '/produkty/:id')({ params: { id: '51' }, body: { nazev: 'Autumn', znacka: 'Froddo', cena: 1490, kategorie: 'celorocky' } }, r2);
  assert.equal(r2.statusCode, 200);
  const prirazeni = dotazy.filter(d => d.sql.startsWith('UPDATE produkty SET model_id')).map(d => d.params);
  assert.deepEqual(prirazeni, [[7, 50], [7, 51]]);
  // Přiřazení až po COMMIT založení produktu
  const sql = dotazy.map(d => d.sql);
  assert.ok(sql.indexOf('COMMIT') < sql.findIndex(x => x.startsWith('UPDATE produkty SET model_id')));
});

test('chyba přiřazení modelu neshodí uložení produktu', async () => {
  const dotazy = [];
  const router = nacistSklad(dotazy, { selhaniModelu: true });
  const puvodniError = console.error;
  console.error = () => {};
  try {
    const r = res();
    await handler(router, 'post', '/produkty')({ body: { nazev: 'Autumn', znacka: 'Froddo', kategorie: 'celorocky', cena: 1490 } }, r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.id, 50);
  } finally {
    console.error = puvodniError;
  }
});
