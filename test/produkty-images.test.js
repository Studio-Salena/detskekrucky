// Fotografie produktů (Cloudinary) - testuje se skutečný route handler
// routes/produktyImages.js s mockovanou DB a mockovaným Cloudinary klientem
// (žádné skutečné síťové volání na Cloudinary v testech).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');

function pocatecniStav() {
  return {
    produkty: [{ id: 1, nazev: 'Botička X' }],
    productImages: [],
    dalsiImageId: 1,
    callLog: [],
    // Sdílená chronologická časová osa SQL dotazů I Cloudinary volání (viz
    // vytvoritMockClient a vytvoritCloudinaryMock) - jen tady jde spolehlivě
    // ověřit relativní POŘADÍ mezi DB prací a externími Cloudinary requesty
    // (např. "Cloudinary upload proběhl PŘED BEGIN").
    udalosti: [],
    insertSelzeNaPokusu: null // pořadové číslo INSERTu do product_images, které má vyhodit chybu (simulace DB failure PO úspěšném Cloudinary uploadu)
  };
}

// DŮLEŽITÉ: musí se skutečně chovat transakčně (ne jen no-op BEGIN/COMMIT/
// ROLLBACK), jinak by testy na "DB rollback po částečném selhání" neuměly
// odhalit chybu, kdy by první úspěšně vložený řádek zůstal viset i po
// ROLLBACKu. Mimo transakci (pool.query přímo, autocommit) se píše rovnou
// do sdíleného stav.productImages; uvnitř transakce se pracuje na lokální
// kopii, která se do sdíleného stavu propíše až při COMMITu a při ROLLBACKu
// se zahodí beze stopy.
function vytvoritMockClient(stav) {
  let vTransakci = false;
  let obrazkyStaged = null;

  function ziskatPole() { return vTransakci ? obrazkyStaged : stav.productImages; }
  function nastavitPole(nove) { if (vTransakci) obrazkyStaged = nove; else stav.productImages = nove; }

  return {
    release() {},
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      stav.callLog.push({ sql: s, params });
      stav.udalosti.push({ typ: 'sql', sql: s });

      if (s.startsWith('BEGIN')) {
        vTransakci = true;
        obrazkyStaged = stav.productImages.map(i => ({ ...i }));
        return {};
      }
      if (s.startsWith('COMMIT')) {
        if (vTransakci) stav.productImages = obrazkyStaged;
        vTransakci = false;
        obrazkyStaged = null;
        return {};
      }
      if (s.startsWith('ROLLBACK')) {
        vTransakci = false;
        obrazkyStaged = null; // zahodit staged změny - NIC z nich se nepropíše do stav.productImages
        return {};
      }
      if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX') || s.startsWith('CREATE UNIQUE INDEX')) return {};

      if (s.startsWith('SELECT id, nazev FROM produkty WHERE id')) {
        const [id] = params;
        const p = stav.produkty.find(p => String(p.id) === String(id));
        return { rows: p ? [{ id: p.id, nazev: p.nazev }] : [] };
      }
      if (s.startsWith('SELECT id FROM produkty WHERE id')) {
        const [id] = params;
        const p = stav.produkty.find(p => String(p.id) === String(id));
        return { rows: p ? [{ id: p.id }] : [] };
      }
      if (s.startsWith('SELECT COUNT(*)::int AS pocet')) {
        const [produktId] = params;
        const obr = ziskatPole().filter(i => String(i.produkt_id) === String(produktId));
        const maxPoz = obr.length ? Math.max(...obr.map(i => i.position)) : -1;
        return { rows: [{ pocet: obr.length, max_pozice: maxPoz }] };
      }
      if (s.startsWith('INSERT INTO product_images')) {
        stav.pocetInsertu = (stav.pocetInsertu || 0) + 1;
        if (stav.insertSelzeNaPokusu === stav.pocetInsertu) {
          throw new Error(`DB insert failed (mock, pokus #${stav.pocetInsertu})`);
        }
        const [produkt_id, url, storage_key, alt, position, is_primary] = params;
        const zaznam = { id: stav.dalsiImageId++, produkt_id, url, storage_key, alt, position, is_primary, created_at: new Date().toISOString() };
        nastavitPole([...ziskatPole(), zaznam]);
        return { rows: [zaznam] };
      }
      if (s.startsWith('SELECT id, produkt_id, url, storage_key, alt, position, is_primary, created_at FROM product_images WHERE produkt_id')) {
        const [produktId] = params;
        const radky = ziskatPole().filter(i => String(i.produkt_id) === String(produktId)).sort((a, b) => a.position - b.position || a.id - b.id);
        return { rows: radky };
      }
      if (s.startsWith('SELECT * FROM product_images WHERE id')) {
        const [id] = params;
        const img = ziskatPole().find(i => i.id === Number(id));
        return { rows: img ? [img] : [] };
      }
      if (s.startsWith('DELETE FROM product_images WHERE id')) {
        const [id] = params;
        nastavitPole(ziskatPole().filter(i => i.id !== Number(id)));
        return {};
      }
      if (s.startsWith('SELECT id FROM product_images WHERE produkt_id') && s.includes('ORDER BY position')) {
        const [produktId] = params;
        const radky = ziskatPole().filter(i => String(i.produkt_id) === String(produktId)).sort((a, b) => a.position - b.position || a.id - b.id);
        return { rows: radky.length ? [{ id: radky[0].id }] : [] };
      }
      if (s.startsWith('UPDATE product_images SET is_primary=true WHERE id')) {
        const [id] = params;
        nastavitPole(ziskatPole().map(i => i.id === Number(id) ? { ...i, is_primary: true } : i));
        return {};
      }
      if (s.startsWith('UPDATE product_images SET is_primary=false WHERE produkt_id')) {
        const [produktId] = params;
        nastavitPole(ziskatPole().map(i => String(i.produkt_id) === String(produktId) ? { ...i, is_primary: false } : i));
        return {};
      }
      if (s.startsWith('SELECT id, produkt_id FROM product_images WHERE id')) {
        const [id] = params;
        const img = ziskatPole().find(i => i.id === Number(id));
        return { rows: img ? [{ id: img.id, produkt_id: img.produkt_id }] : [] };
      }
      if (s.startsWith('SELECT produkt_id FROM product_images WHERE id')) {
        const [id] = params;
        const img = ziskatPole().find(i => i.id === Number(id));
        return { rows: img ? [{ produkt_id: img.produkt_id }] : [] };
      }
      if (s.startsWith('UPDATE product_images SET')) {
        const id = Number(params[params.length - 1]);
        const pole = ziskatPole();
        const idx = pole.findIndex(i => i.id === id);
        if (idx === -1) return { rows: [] };
        const setCast = s.slice(s.indexOf('SET') + 3, s.indexOf('WHERE')).trim();
        const atributy = setCast.split(',').map(x => x.trim().split('=')[0].trim());
        const novy = { ...pole[idx] };
        atributy.forEach((atrib, i2) => { novy[atrib] = params[i2]; });
        const novePole = [...pole];
        novePole[idx] = novy;
        nastavitPole(novePole);
        return { rows: [novy] };
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function vytvoritMockPool(stav) {
  return {
    async connect() { return vytvoritMockClient(stav); },
    async query(sql, params) { return vytvoritMockClient(stav).query(sql, params); }
  };
}

// uploadSelzeNaPokusu: pořadové číslo volání nahratObrazek (1 = první), které
// má selhat (throw) - umožňuje simulovat "N-tý soubor v dávce selže po tom,
// co předchozí už uspěly", bez ohledu na to, kolikátý je to test.
// smazatProduktPoUploadu: id produktu, který se z stav.produkty "za běhu"
// odstraní hned po prvním úspěšném uploadu - simuluje race, kdy produkt mezi
// pre-checkem (krok 2) a autoritativní FOR UPDATE kontrolou (krok 4) zmizí.
function vytvoritCloudinaryMock(stav, { nakonfigurovano = true, uploadSelzeNaPokusu = null, deleteSelze = false, smazatProduktPoUploadu = null } = {}) {
  const volaniUpload = [];
  const volaniDelete = [];
  let citac = 0;
  return {
    volaniUpload, volaniDelete,
    jeNakonfigurovano: () => nakonfigurovano,
    async nahratObrazek(buffer, opts) {
      citac++;
      volaniUpload.push({ opts, poradi: citac });
      stav.udalosti.push({ typ: 'cloudinary-upload', poradi: citac });
      if (uploadSelzeNaPokusu === citac) {
        throw new Error(`cloudinary upload failed (mock, pokus #${citac})`);
      }
      if (smazatProduktPoUploadu != null && citac === 1) {
        stav.produkty = stav.produkty.filter(p => String(p.id) !== String(smazatProduktPoUploadu));
      }
      return { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${opts.folder}/mock${citac}.jpg`, public_id: `${opts.folder}/mock${citac}` };
    },
    async smazatObrazek(publicId) {
      volaniDelete.push(publicId);
      stav.udalosti.push({ typ: 'cloudinary-destroy', publicId });
      if (deleteSelze) return { ok: false, chyba: 'mock delete failed' };
      return { ok: true };
    }
  };
}

function pripravitRouter(stav, cloud) {
  return nacistRouterSMocky('../routes/produktyImages.js', {
    '../db/pool': vytvoritMockPool(stav),
    '../lib/cloudinary': cloud
  });
}

function jpegBuffer() {
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
}
function jpegSoubor(nazev) {
  const buf = jpegBuffer();
  return { buffer: buf, mimetype: 'image/jpeg', size: buf.length, originalname: nazev };
}

// Volá celý router (včetně router.use(vyzadovatAdmina)) jako middleware -
// na rozdíl od najitHandler, který kvůli testování byznys logiky bez auth
// bere jen poslední handler v route stacku.
function volatRouterJakoMiddleware(router, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: null,
      status(kod) { this.statusCode = kod; return this; },
      json(telo) { this.body = telo; resolve(this); return this; }
    };
    router(req, res, (err) => { if (err) return reject(err); resolve(res); });
  });
}

test('upload první fotografie produktu ji nastaví jako primary, position 0', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg')] }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].is_primary, true);
  assert.equal(res.body[0].position, 0);
  assert.equal(res.body[0].alt, 'Botička X');
  assert.equal(cloud.volaniUpload.length, 1);
});

test('upload druhé fotografie NENÍ primary a má position 1 a odlišený ALT', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');

  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg')] }, vytvoritRes());
  const res2 = vytvoritRes();
  await handler({ params: { id: '1' }, files: [jpegSoubor('b.jpg')] }, res2);

  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body[0].is_primary, false);
  assert.equal(res2.body[0].position, 1);
  assert.equal(res2.body[0].alt, 'Botička X – fotografie 2');
  assert.equal(stav.productImages.filter(i => i.is_primary).length, 1); // pořád jen jedna primární
});

test('multi-upload: druhý Cloudinary upload selže -> žádná fotka se neuloží a první úspěšně nahraný asset se best-effort smaže', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav, { uploadSelzeNaPokusu: 2 }); // 1. soubor projde, 2. selže
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, res);

  assert.equal(res.statusCode, 502);
  assert.equal(stav.productImages.length, 0); // do DB se nevložilo vůbec nic
  assert.equal(cloud.volaniUpload.length, 2); // první prošel, druhý selhal
  assert.equal(cloud.volaniDelete.length, 1); // první (úspěšně nahraný) asset se uklidil
  assert.equal(cloud.volaniDelete[0], cloud.volaniUpload[0].opts.folder + '/mock1');
});

test('multi-upload: všechny Cloudinary uploady projdou, ale DB insert selže -> rollback a best-effort úklid VŠECH nahraných assetů', async () => {
  const stav = pocatecniStav();
  stav.insertSelzeNaPokusu = 2; // první INSERT projde, druhý (v rámci stejné dávky) selže
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(stav.productImages.length, 0); // DB rollback - žádný řádek nezůstal
  assert.equal(cloud.volaniUpload.length, 2); // oba uploady do Cloudinary proběhly úspěšně
  assert.equal(cloud.volaniDelete.length, 2); // oba osiřelé assety se best-effort uklidily
});

test('cleanup failure po neúspěšném uploadu se jen zaloguje, request stále vrátí chybu z původního selhání', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav, { uploadSelzeNaPokusu: 2, deleteSelze: true });
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, res);

  assert.equal(res.statusCode, 502); // pořád původní chyba, ne chyba z cleanupu
  assert.equal(cloud.volaniDelete.length, 1); // o cleanup se pokusilo, i když selhal
});

test('CONCURRENCY/POŘADÍ: Cloudinary upload proběhne PŘED BEGIN/FOR UPDATE, a FOR UPDATE proběhne PŘED MAX(position)/primary i před INSERTem', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg')] }, vytvoritRes());

  // Sdílená chronologická časová osa (stav.udalosti) obsahuje SQL dotazy I
  // Cloudinary volání v pořadí, jak skutečně proběhly - jen tak jde dokázat,
  // že Cloudinary upload NENÍ zavřený mezi BEGIN a COMMIT/ROLLBACK.
  const uploadIdx = stav.udalosti.findIndex(u => u.typ === 'cloudinary-upload');
  const beginIdx = stav.udalosti.findIndex(u => u.typ === 'sql' && u.sql.startsWith('BEGIN'));
  const lockIdx = stav.udalosti.findIndex(u => u.typ === 'sql' && u.sql.startsWith('SELECT id, nazev FROM produkty WHERE id') && u.sql.includes('FOR UPDATE'));
  const maxPoziceIdx = stav.udalosti.findIndex(u => u.typ === 'sql' && u.sql.startsWith('SELECT COUNT(*)::int AS pocet'));
  const insertIdx = stav.udalosti.findIndex(u => u.typ === 'sql' && u.sql.startsWith('INSERT INTO product_images'));

  assert.notEqual(uploadIdx, -1);
  assert.notEqual(beginIdx, -1);
  assert.notEqual(lockIdx, -1);
  assert.notEqual(maxPoziceIdx, -1);
  assert.notEqual(insertIdx, -1);
  assert.ok(uploadIdx < beginIdx, 'Cloudinary upload musí proběhnout PŘED otevřením DB transakce (BEGIN)');
  assert.ok(beginIdx < lockIdx, 'BEGIN musí předcházet FOR UPDATE (je to první dotaz uvnitř transakce)');
  assert.ok(lockIdx < maxPoziceIdx, 'zámek produktu musí proběhnout před výpočtem MAX(position)/primary');
  assert.ok(maxPoziceIdx < insertIdx, 'MAX(position)/primary se musí spočítat před INSERTem');
});

test('POŘADÍ při selhání uploadu: v callLogu není žádný BEGIN ani FOR UPDATE, orphan Cloudinary asset se přesto uklidí', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav, { uploadSelzeNaPokusu: 2 });
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, res);

  assert.equal(res.statusCode, 502);
  // Selhání druhého uploadu nastane DŘÍV, než se vůbec otevře DB transakce -
  // takže v CELÉM callLogu nesmí být žádný BEGIN ani FOR UPDATE (jen ten
  // úvodní neautoritativní pre-check bez FOR UPDATE).
  assert.equal(stav.callLog.some(c => c.sql.startsWith('BEGIN')), false);
  assert.equal(stav.callLog.some(c => c.sql.includes('FOR UPDATE')), false);
  assert.equal(cloud.volaniDelete.length, 1); // orphan (první úspěšný upload) se přesto uklidil
});

test('RACE: produkt zmizí MEZI pre-checkem a autoritativní DB finalizací - žádný řádek nevznikne, Cloudinary asset se uklidí', async () => {
  const stav = pocatecniStav();
  // Produkt "1" existuje při pre-checku, ale zmizí hned po prvním Cloudinary
  // uploadu - simuluje souběžné smazání produktu, které proběhne v mezičase
  // (během síťového uploadu), PŘED tím, než se stihne otevřít DB transakce.
  const cloud = vytvoritCloudinaryMock(stav, { smazatProduktPoUploadu: 1 });
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg')] }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(stav.productImages.length, 0); // žádný DB řádek nevznikl
  assert.equal(cloud.volaniUpload.length, 1); // upload proběhl (pre-check produkt ještě našel)
  assert.equal(cloud.volaniDelete.length, 1); // ale asset se pak best-effort uklidil
  assert.equal(cloud.volaniDelete[0], cloud.volaniUpload[0].opts.folder + '/mock1');
  // Autoritativní FOR UPDATE musí v tomhle requestu skutečně proběhnout
  // (a najít produkt už smazaný) - jinak by test neověřoval to podstatné.
  assert.ok(stav.callLog.some(c => c.sql.startsWith('SELECT id, nazev FROM produkty WHERE id') && c.sql.includes('FOR UPDATE')));
});

test('POŘADÍ při DB insert failure: ROLLBACK a release proběhnou PŘED Cloudinary cleanupem', async () => {
  const stav = pocatecniStav();
  stav.insertSelzeNaPokusu = 2;
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, res);

  assert.equal(res.statusCode, 500);
  const rollbackIdx = stav.udalosti.findIndex(u => u.typ === 'sql' && u.sql.startsWith('ROLLBACK'));
  const prvniDestroyIdx = stav.udalosti.findIndex(u => u.typ === 'cloudinary-destroy');
  assert.notEqual(rollbackIdx, -1);
  assert.notEqual(prvniDestroyIdx, -1);
  assert.ok(rollbackIdx < prvniDestroyIdx, 'ROLLBACK musí proběhnout před Cloudinary cleanupem, ne uvnitř otevřené transakce');
});

test('upload na neexistující produkt vrací 404 a NEVOLÁ Cloudinary', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '999999' }, files: [jpegSoubor('a.jpg')] }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(cloud.volaniUpload.length, 0); // produkt se ověří dřív, než se cokoliv pošle do Cloudinary
  assert.equal(stav.productImages.length, 0);
});

test('PRIMARY INVARIANT: přesně 0 primary při 0 fotkách, přesně 1 primary při >=1 fotce, napříč celým životním cyklem', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const uploadHandler = najitHandler(router, 'post', '/:id/images');
  const deleteHandler = najitHandler(router, 'delete', '/:id/images/:imageId');
  const primaryHandler = najitHandler(router, 'patch', '/:id/images/:imageId/primary');

  function pocetPrimary() { return stav.productImages.filter(i => i.is_primary).length; }

  assert.equal(pocetPrimary(), 0); // start: 0 fotek, 0 primary

  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('a.jpg')] }, vytvoritRes());
  assert.equal(stav.productImages.length, 1);
  assert.equal(pocetPrimary(), 1); // po prvním uploadu přesně 1 primary

  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('b.jpg')] }, vytvoritRes());
  assert.equal(stav.productImages.length, 2);
  assert.equal(pocetPrimary(), 1); // po druhém uploadu pořád přesně 1 primary

  const druha = stav.productImages.find(i => !i.is_primary);
  await primaryHandler({ params: { id: '1', imageId: String(druha.id) } }, vytvoritRes());
  assert.equal(pocetPrimary(), 1); // po změně primary pořád přesně 1

  const nynejsiPrimarni = stav.productImages.find(i => i.is_primary);
  await deleteHandler({ params: { id: '1', imageId: String(nynejsiPrimarni.id) } }, vytvoritRes());
  assert.equal(stav.productImages.length, 1);
  assert.equal(pocetPrimary(), 1); // smazání primary automaticky přeneslo primary na zbylou fotku

  const posledni = stav.productImages[0];
  await deleteHandler({ params: { id: '1', imageId: String(posledni.id) } }, vytvoritRes());
  assert.equal(stav.productImages.length, 0);
  assert.equal(pocetPrimary(), 0); // 0 fotek -> 0 primary
});

test('PATCH běžné fotografie nedovolí změnit is_primary přes tělo requestu - jen dedicated endpoint /primary to smí', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const uploadHandler = najitHandler(router, 'post', '/:id/images');
  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, vytvoritRes());
  const nehlavni = stav.productImages.find(i => !i.is_primary);

  const patchHandler = najitHandler(router, 'patch', '/:id/images/:imageId');
  const res = vytvoritRes();
  await patchHandler({ params: { id: '1', imageId: String(nehlavni.id) }, body: { is_primary: true, alt: 'pokus o obejití' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(stav.productImages.find(i => i.id === nehlavni.id).is_primary, false); // is_primary se NEZMĚNILO
  assert.equal(stav.productImages.find(i => i.id === nehlavni.id).alt, 'pokus o obejití'); // alt se změnit smí
});

test('PATCH position: záporná, neceločíselná i přehnaně vysoká hodnota jsou odmítnuty (400)', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const uploadHandler = najitHandler(router, 'post', '/:id/images');
  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('a.jpg')] }, vytvoritRes());
  const fotka = stav.productImages[0];
  const patchHandler = najitHandler(router, 'patch', '/:id/images/:imageId');

  for (const spatnaPozice of [-1, 1.5, 100000, 'x']) {
    const res = vytvoritRes();
    await patchHandler({ params: { id: '1', imageId: String(fotka.id) }, body: { position: spatnaPozice } }, res);
    assert.equal(res.statusCode, 400, `pozice ${JSON.stringify(spatnaPozice)} měla být odmítnuta`);
  }

  const resOk = vytvoritRes();
  await patchHandler({ params: { id: '1', imageId: String(fotka.id) }, body: { position: 5 } }, resOk);
  assert.equal(resOk.statusCode, 200);
  assert.equal(stav.productImages[0].position, 5);
});

test('seznam fotografií i výběr nové primary po smazání jsou řazené ORDER BY position, id (deterministicky i při shodné position)', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const uploadHandler = najitHandler(router, 'post', '/:id/images');
  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, vytvoritRes());

  // Simulace nekonzistentního stavu (např. napůl dokončené přeuspořádání) -
  // obě fotky se stejnou position - řazení se pak musí spolehnout na id.
  stav.productImages.forEach(i => { i.position = 0; });

  const getHandler = najitHandler(router, 'get', '/:id/images');
  const res = vytvoritRes();
  await getHandler({ params: { id: '1' } }, res);
  assert.equal(res.body[0].id, stav.productImages.map(i => i.id).sort((a, b) => a - b)[0]);

  const prvni = stav.productImages.find(i => i.is_primary);
  const deleteHandler = najitHandler(router, 'delete', '/:id/images/:imageId');
  const resDelete = vytvoritRes();
  await deleteHandler({ params: { id: '1', imageId: String(prvni.id) } }, resDelete);
  // Zbylá fotka (jediná) se stane primary bez ohledu na shodnou position.
  assert.equal(resDelete.body.nova_primarni_id, stav.productImages[0].id);
});

test('změna hlavní fotografie je transakční - stará přestane být primary, zvolená se stane primary', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const uploadHandler = najitHandler(router, 'post', '/:id/images');
  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, vytvoritRes());

  const druha = stav.productImages.find(i => i.position === 1);
  const primaryHandler = najitHandler(router, 'patch', '/:id/images/:imageId/primary');
  const res = vytvoritRes();
  await primaryHandler({ params: { id: '1', imageId: String(druha.id) } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(stav.productImages.find(i => i.position === 0).is_primary, false);
  assert.equal(stav.productImages.find(i => i.id === druha.id).is_primary, true);
  assert.equal(stav.productImages.filter(i => i.is_primary).length, 1);
});

test('smazání nehlavní fotografie neovlivní hlavní fotku a zavolá Cloudinary cleanup', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const uploadHandler = najitHandler(router, 'post', '/:id/images');
  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, vytvoritRes());
  const druha = stav.productImages.find(i => i.position === 1);

  const deleteHandler = najitHandler(router, 'delete', '/:id/images/:imageId');
  const res = vytvoritRes();
  await deleteHandler({ params: { id: '1', imageId: String(druha.id) } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(stav.productImages.length, 1);
  assert.equal(stav.productImages[0].is_primary, true);
  assert.equal(cloud.volaniDelete.length, 1);
  assert.equal(cloud.volaniDelete[0], druha.storage_key);
});

test('smazání hlavní fotografie automaticky nastaví další (nejnižší position) jako hlavní', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const uploadHandler = najitHandler(router, 'post', '/:id/images');
  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('a.jpg'), jpegSoubor('b.jpg')] }, vytvoritRes());
  const prvni = stav.productImages.find(i => i.position === 0);
  const druha = stav.productImages.find(i => i.position === 1);

  const deleteHandler = najitHandler(router, 'delete', '/:id/images/:imageId');
  const res = vytvoritRes();
  await deleteHandler({ params: { id: '1', imageId: String(prvni.id) } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.nova_primarni_id, druha.id);
  assert.equal(stav.productImages.find(i => i.id === druha.id).is_primary, true);
});

test('pokus smazat fotografii jiného produktu (podvržené produkt_id v URL) je odmítnut', async () => {
  const stav = pocatecniStav();
  stav.produkty.push({ id: 2, nazev: 'Jiný produkt' });
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const uploadHandler = najitHandler(router, 'post', '/:id/images');
  await uploadHandler({ params: { id: '1' }, files: [jpegSoubor('a.jpg')] }, vytvoritRes());
  const fotka = stav.productImages[0];

  const deleteHandler = najitHandler(router, 'delete', '/:id/images/:imageId');
  const res = vytvoritRes();
  await deleteHandler({ params: { id: '2', imageId: String(fotka.id) } }, res); // fotka patří produktu 1, ne 2

  assert.equal(res.statusCode, 404);
  assert.equal(stav.productImages.length, 1); // nic se nesmazalo
  assert.equal(cloud.volaniDelete.length, 0);
});

test('neplatný MIME typ (např. PDF) je odmítnut', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [{ buffer: jpegBuffer(), mimetype: 'application/pdf', size: 12, originalname: 'x.pdf' }] }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(stav.productImages.length, 0);
  assert.equal(cloud.volaniUpload.length, 0);
});

test('příliš velký soubor (>10 MB) je odmítnut', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [{ buffer: jpegBuffer(), mimetype: 'image/jpeg', size: 11 * 1024 * 1024, originalname: 'velky.jpg' }] }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(stav.productImages.length, 0);
  assert.equal(cloud.volaniUpload.length, 0);
});

test('soubor s podvrženým Content-Type (image/jpeg), ale bez platné signatury, je odmítnut', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [{ buffer: Buffer.from('tohle vubec neni obrazek soubor'), mimetype: 'image/jpeg', size: 30, originalname: 'x.jpg' }] }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(cloud.volaniUpload.length, 0); // odmítnuto ještě před uploadem do Cloudinary
});

test('všechny image endpointy vyžadují admin heslo (admin-only)', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock(stav);
  const router = pripravitRouter(stav, cloud);
  const puvodni = process.env.ADMIN_HESLO;
  process.env.ADMIN_HESLO = 'tajne-heslo-pro-test';
  try {
    const res = await volatRouterJakoMiddleware(router, {
      method: 'GET', url: '/1/images', headers: {}, params: {}, query: {}, ip: '127.0.0.2'
    });
    assert.equal(res.statusCode, 403);
  } finally {
    if (puvodni === undefined) delete process.env.ADMIN_HESLO;
    else process.env.ADMIN_HESLO = puvodni;
  }
});
