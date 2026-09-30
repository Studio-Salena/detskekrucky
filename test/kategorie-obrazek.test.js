// Obrázek dlaždice kategorie (Cloudinary) - skutečný route handler
// routes/kategorie.js s mockovanou DB a mockovaným Cloudinary klientem.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');

const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0]);

function vytvoritMockPool(stav) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('ALTER TABLE')) return {};
      if (s.startsWith('SELECT * FROM kategorie ORDER BY poradi')) {
        return { rows: stav.kategorie.map(k => ({ ...k })) };
      }
      if (s.startsWith('SELECT obrazek_key FROM kategorie WHERE id')) {
        const k = stav.kategorie.find(k => String(k.id) === String(params[0]));
        return { rows: k ? [{ obrazek_key: k.obrazek_key }] : [] };
      }
      if (s.startsWith('UPDATE kategorie SET obrazek_url=$1')) {
        const [url, key, id] = params;
        const k = stav.kategorie.find(k => String(k.id) === String(id));
        if (!k) return { rows: [] };
        Object.assign(k, { obrazek_url: url, obrazek_key: key });
        return { rows: [{ ...k }] };
      }
      if (s.startsWith('UPDATE kategorie SET obrazek_url=NULL')) {
        const k = stav.kategorie.find(k => String(k.id) === String(params[0]));
        if (!k) return { rows: [] };
        Object.assign(k, { obrazek_url: null, obrazek_key: null });
        return { rows: [{ ...k }] };
      }
      if (s.startsWith('DELETE FROM kategorie WHERE id')) {
        const k = stav.kategorie.find(k => String(k.id) === String(params[0]));
        stav.kategorie = stav.kategorie.filter(x => x !== k);
        return { rows: k ? [{ obrazek_key: k.obrazek_key }] : [] };
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function vytvoritCloudinaryMock({ nakonfigurovano = true } = {}) {
  let citac = 0;
  const mock = {
    volaniUpload: [], volaniDelete: [],
    jeNakonfigurovano: () => nakonfigurovano,
    async nahratObrazek(buffer, opts) {
      citac++;
      mock.volaniUpload.push(opts);
      return { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${opts.folder}/mock${citac}.jpg`, public_id: `${opts.folder}/mock${citac}` };
    },
    async smazatObrazek(publicId) { mock.volaniDelete.push(publicId); return { ok: true }; },
    ziskatOptimalizovanouUrl: (url, w) => url + `?w=${w}`
  };
  return mock;
}

function nacist(stav, cloudinary) {
  return nacistRouterSMocky('../routes/kategorie.js', {
    '../db/pool': vytvoritMockPool(stav),
    '../lib/cloudinary': cloudinary
  });
}

test('nahrání obrázku uloží URL ke kategorii', async () => {
  const stav = { kategorie: [{ id: 1, nazev: 'Holínky', obrazek_url: null, obrazek_key: null }] };
  const cloudinary = vytvoritCloudinaryMock();
  const handler = najitHandler(nacist(stav, cloudinary), 'post', '/:id/obrazek');
  const res = vytvoritRes();
  await handler({ params: { id: '1' }, file: { buffer: JPEG, size: JPEG.length, mimetype: 'image/jpeg' } }, res);

  assert.equal(res.statusCode, 200);
  assert.match(stav.kategorie[0].obrazek_url, /^https:\/\/res\.cloudinary\.com\//);
  assert.equal(cloudinary.volaniUpload[0].folder, 'detskekrucky/kategorie/1');
});

test('nový obrázek nahradí starý a starý se smaže z úložiště', async () => {
  const stav = { kategorie: [{ id: 1, nazev: 'Holínky', obrazek_url: 'https://res.cloudinary.com/x/stary.jpg', obrazek_key: 'stary' }] };
  const cloudinary = vytvoritCloudinaryMock();
  const handler = najitHandler(nacist(stav, cloudinary), 'post', '/:id/obrazek');
  await handler({ params: { id: '1' }, file: { buffer: JPEG, size: JPEG.length, mimetype: 'image/jpeg' } }, vytvoritRes());

  assert.deepEqual(cloudinary.volaniDelete, ['stary']);
  assert.notEqual(stav.kategorie[0].obrazek_key, 'stary');
});

test('soubor, který není obrázek, se odmítne a nic se nenahraje', async () => {
  const stav = { kategorie: [{ id: 1, nazev: 'Holínky' }] };
  const cloudinary = vytvoritCloudinaryMock();
  const handler = najitHandler(nacist(stav, cloudinary), 'post', '/:id/obrazek');
  const res = vytvoritRes();
  const text = Buffer.from('tohle neni obrazek, jen text');
  await handler({ params: { id: '1' }, file: { buffer: text, size: text.length, mimetype: 'image/jpeg' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(cloudinary.volaniUpload.length, 0);
});

test('nahrání k neexistující kategorii vrátí 404 bez uploadu', async () => {
  const stav = { kategorie: [] };
  const cloudinary = vytvoritCloudinaryMock();
  const handler = najitHandler(nacist(stav, cloudinary), 'post', '/:id/obrazek');
  const res = vytvoritRes();
  await handler({ params: { id: '99' }, file: { buffer: JPEG, size: JPEG.length, mimetype: 'image/jpeg' } }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(cloudinary.volaniUpload.length, 0);
});

test('odebrání obrázku vymaže URL a smaže soubor z úložiště', async () => {
  const stav = { kategorie: [{ id: 1, nazev: 'Holínky', obrazek_url: 'https://res.cloudinary.com/x/a.jpg', obrazek_key: 'klic-a' }] };
  const cloudinary = vytvoritCloudinaryMock();
  const handler = najitHandler(nacist(stav, cloudinary), 'delete', '/:id/obrazek');
  const res = vytvoritRes();
  await handler({ params: { id: '1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(stav.kategorie[0].obrazek_url, null);
  assert.deepEqual(cloudinary.volaniDelete, ['klic-a']);
});

test('smazání kategorie smaže i její obrázek z úložiště', async () => {
  const stav = { kategorie: [{ id: 1, nazev: 'Holínky', obrazek_key: 'klic-a' }] };
  const cloudinary = vytvoritCloudinaryMock();
  const handler = najitHandler(nacist(stav, cloudinary), 'delete', '/:id');
  await handler({ params: { id: '1' } }, vytvoritRes());

  assert.deepEqual(cloudinary.volaniDelete, ['klic-a']);
});

test('veřejný seznam kategorií posílá zmenšený obrázek a neprozrazuje storage klíč', async () => {
  const stav = { kategorie: [{ id: 1, nazev: 'Holínky', obrazek_url: 'https://res.cloudinary.com/x/a.jpg', obrazek_key: 'klic-a' }] };
  const handler = najitHandler(nacist(stav, vytvoritCloudinaryMock()), 'get', '/');
  const res = vytvoritRes();
  await handler({}, res);

  assert.equal(res.body[0].obrazek_url, 'https://res.cloudinary.com/x/a.jpg?w=240');
  assert.equal('obrazek_key' in res.body[0], false);
});
