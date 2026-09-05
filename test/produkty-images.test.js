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
    callLog: []
  };
}

function vytvoritMockClient(stav) {
  return {
    release() {},
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      stav.callLog.push({ sql: s, params });

      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return {};
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
        const obr = stav.productImages.filter(i => String(i.produkt_id) === String(produktId));
        const maxPoz = obr.length ? Math.max(...obr.map(i => i.position)) : -1;
        return { rows: [{ pocet: obr.length, max_pozice: maxPoz }] };
      }
      if (s.startsWith('INSERT INTO product_images')) {
        const [produkt_id, url, storage_key, alt, position, is_primary] = params;
        const zaznam = { id: stav.dalsiImageId++, produkt_id, url, storage_key, alt, position, is_primary, created_at: new Date().toISOString() };
        stav.productImages.push(zaznam);
        return { rows: [zaznam] };
      }
      if (s.startsWith('SELECT id, produkt_id, url, storage_key, alt, position, is_primary, created_at FROM product_images WHERE produkt_id')) {
        const [produktId] = params;
        const radky = stav.productImages.filter(i => String(i.produkt_id) === String(produktId)).sort((a, b) => a.position - b.position || a.id - b.id);
        return { rows: radky };
      }
      if (s.startsWith('SELECT * FROM product_images WHERE id')) {
        const [id] = params;
        const img = stav.productImages.find(i => i.id === Number(id));
        return { rows: img ? [img] : [] };
      }
      if (s.startsWith('DELETE FROM product_images WHERE id')) {
        const [id] = params;
        stav.productImages = stav.productImages.filter(i => i.id !== Number(id));
        return {};
      }
      if (s.startsWith('SELECT id FROM product_images WHERE produkt_id') && s.includes('ORDER BY position')) {
        const [produktId] = params;
        const radky = stav.productImages.filter(i => String(i.produkt_id) === String(produktId)).sort((a, b) => a.position - b.position || a.id - b.id);
        return { rows: radky.length ? [{ id: radky[0].id }] : [] };
      }
      if (s.startsWith('UPDATE product_images SET is_primary=true WHERE id')) {
        const [id] = params;
        stav.productImages.forEach(i => { if (i.id === Number(id)) i.is_primary = true; });
        return {};
      }
      if (s.startsWith('UPDATE product_images SET is_primary=false WHERE produkt_id')) {
        const [produktId] = params;
        stav.productImages.forEach(i => { if (String(i.produkt_id) === String(produktId)) i.is_primary = false; });
        return {};
      }
      if (s.startsWith('SELECT id, produkt_id FROM product_images WHERE id')) {
        const [id] = params;
        const img = stav.productImages.find(i => i.id === Number(id));
        return { rows: img ? [{ id: img.id, produkt_id: img.produkt_id }] : [] };
      }
      if (s.startsWith('SELECT produkt_id FROM product_images WHERE id')) {
        const [id] = params;
        const img = stav.productImages.find(i => i.id === Number(id));
        return { rows: img ? [{ produkt_id: img.produkt_id }] : [] };
      }
      if (s.startsWith('UPDATE product_images SET')) {
        const id = Number(params[params.length - 1]);
        const img = stav.productImages.find(i => i.id === id);
        if (!img) return { rows: [] };
        const setCast = s.slice(s.indexOf('SET') + 3, s.indexOf('WHERE')).trim();
        const atributy = setCast.split(',').map(x => x.trim().split('=')[0].trim());
        atributy.forEach((atrib, idx) => { img[atrib] = params[idx]; });
        return { rows: [img] };
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

function vytvoritCloudinaryMock({ nakonfigurovano = true, uploadSelze = false, deleteSelze = false } = {}) {
  const volaniUpload = [];
  const volaniDelete = [];
  let citac = 0;
  return {
    volaniUpload, volaniDelete,
    jeNakonfigurovano: () => nakonfigurovano,
    async nahratObrazek(buffer, opts) {
      volaniUpload.push({ opts });
      if (uploadSelze) throw new Error('cloudinary upload failed (mock)');
      citac++;
      return { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${opts.folder}/mock${citac}.jpg`, public_id: `${opts.folder}/mock${citac}` };
    },
    async smazatObrazek(publicId) {
      volaniDelete.push(publicId);
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
  const cloud = vytvoritCloudinaryMock();
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
  const cloud = vytvoritCloudinaryMock();
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

test('změna hlavní fotografie je transakční - stará přestane být primary, zvolená se stane primary', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock();
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
  const cloud = vytvoritCloudinaryMock();
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
  const cloud = vytvoritCloudinaryMock();
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
  const cloud = vytvoritCloudinaryMock();
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
  const cloud = vytvoritCloudinaryMock();
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
  const cloud = vytvoritCloudinaryMock();
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
  const cloud = vytvoritCloudinaryMock();
  const router = pripravitRouter(stav, cloud);
  const handler = najitHandler(router, 'post', '/:id/images');
  const res = vytvoritRes();

  await handler({ params: { id: '1' }, files: [{ buffer: Buffer.from('tohle vubec neni obrazek soubor'), mimetype: 'image/jpeg', size: 30, originalname: 'x.jpg' }] }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(cloud.volaniUpload.length, 0); // odmítnuto ještě před uploadem do Cloudinary
});

test('všechny image endpointy vyžadují admin heslo (admin-only)', async () => {
  const stav = pocatecniStav();
  const cloud = vytvoritCloudinaryMock();
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
