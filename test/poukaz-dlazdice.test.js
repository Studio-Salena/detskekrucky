// Obrázek dlaždice "Dárkové poukazy" - skutečný route handler
// routes/poukazDlazdice.js s mockovanou DB (tabulka nastaveni) a Cloudinary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');

const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0]);

function vytvoritMockPool(stav) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT hodnota FROM nastaveni WHERE klic')) {
        return { rows: stav.nastaveni[params[0]] ? [{ hodnota: stav.nastaveni[params[0]] }] : [] };
      }
      if (s.startsWith('INSERT INTO nastaveni')) {
        stav.nastaveni[params[0]] = JSON.parse(params[1]);
        return {};
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function vytvoritCloudinaryMock() {
  const mock = {
    volaniUpload: [], volaniDelete: [],
    jeNakonfigurovano: () => true,
    async nahratObrazek(buffer, opts) {
      mock.volaniUpload.push(opts);
      return { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${opts.folder}/novy.jpg`, public_id: `${opts.folder}/novy` };
    },
    async smazatObrazek(publicId) { mock.volaniDelete.push(publicId); return { ok: true }; },
    ziskatOptimalizovanouUrl: (url, w) => url + `?w=${w}`
  };
  return mock;
}

function nacist(stav, cloudinary) {
  return nacistRouterSMocky('../routes/poukazDlazdice.js', {
    '../db/pool': vytvoritMockPool(stav),
    '../lib/cloudinary': cloudinary
  });
}

test('bez nahraného obrázku vrací null (e-shop použije výchozí náhled)', async () => {
  const handler = najitHandler(nacist({ nastaveni: {} }, vytvoritCloudinaryMock()), 'get', '/');
  const res = vytvoritRes();
  await handler({}, res);
  assert.deepEqual(res.body, { obrazek_url: null, vanocni: { zobrazit: true, obrazek_url: null } });
});

test('nahrání uloží obrázek a starý smaže z úložiště', async () => {
  const stav = { nastaveni: { poukazDlazdice: { url: 'https://res.cloudinary.com/x/stary.jpg', key: 'stary' } } };
  const cloudinary = vytvoritCloudinaryMock();
  const router = nacist(stav, cloudinary);
  const res = vytvoritRes();
  await najitHandler(router, 'post', '/obrazek')({ file: { buffer: JPEG, size: JPEG.length, mimetype: 'image/jpeg' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(stav.nastaveni.poukazDlazdice.key, 'detskekrucky/poukaz-dlazdice/novy');
  assert.deepEqual(cloudinary.volaniDelete, ['stary']);

  const resGet = vytvoritRes();
  await najitHandler(router, 'get', '/')({}, resGet);
  assert.match(resGet.body.obrazek_url, /novy\.jpg\?w=400$/);
});

test('soubor, který není obrázek, se odmítne', async () => {
  const stav = { nastaveni: {} };
  const cloudinary = vytvoritCloudinaryMock();
  const res = vytvoritRes();
  const text = Buffer.from('tohle neni obrazek, jen text');
  await najitHandler(nacist(stav, cloudinary), 'post', '/obrazek')({ file: { buffer: text, size: text.length, mimetype: 'image/png' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(cloudinary.volaniUpload.length, 0);
});

test('odebrání vrátí dlaždici k výchozímu náhledu a smaže soubor', async () => {
  const stav = { nastaveni: { poukazDlazdice: { url: 'https://res.cloudinary.com/x/a.jpg', key: 'klic-a' } } };
  const cloudinary = vytvoritCloudinaryMock();
  const res = vytvoritRes();
  await najitHandler(nacist(stav, cloudinary), 'delete', '/obrazek')({}, res);

  assert.deepEqual(stav.nastaveni.poukazDlazdice, {});
  assert.deepEqual(cloudinary.volaniDelete, ['klic-a']);
});

test('vánoční poukaz: vlastní obrázek a vypínač bez vlivu na klasický poukaz', async () => {
  const stav = { nastaveni: { poukazDlazdice: { url: 'https://res.cloudinary.com/x/klasik.jpg', key: 'klasik' } } };
  const cloudinary = vytvoritCloudinaryMock();
  const router = nacist(stav, cloudinary);
  let res = vytvoritRes();
  await najitHandler(router, 'post', '/obrazek')({ query: { typ: 'vanocni' }, file: { buffer: JPEG, size: JPEG.length, mimetype: 'image/jpeg' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(stav.nastaveni.poukazDlazdice, { url: 'https://res.cloudinary.com/x/klasik.jpg', key: 'klasik',
    vanocni: { url: 'https://res.cloudinary.com/demo/image/upload/v1/detskekrucky/poukaz-dlazdice/novy.jpg', key: 'detskekrucky/poukaz-dlazdice/novy' } });
  assert.deepEqual(cloudinary.volaniDelete, [], 'klasický obrázek zůstal');
  res = vytvoritRes();
  await najitHandler(router, 'put', '/vanocni')({ body: { zobrazit: false } }, res);
  assert.equal(res.statusCode, 200);
  res = vytvoritRes();
  await najitHandler(router, 'put', '/vanocni')({ body: { zobrazit: 'ne' } }, res);
  assert.equal(res.statusCode, 400);
  res = vytvoritRes();
  await najitHandler(router, 'get', '/')({}, res);
  assert.equal(res.body.vanocni.zobrazit, false);
  assert.match(res.body.vanocni.obrazek_url, /novy\.jpg\?w=400$/);
  assert.match(res.body.obrazek_url, /klasik\.jpg/);
  // odebrání vánočního obrázku nechá klasický i vypínač
  res = vytvoritRes();
  await najitHandler(router, 'delete', '/obrazek')({ query: { typ: 'vanocni' } }, res);
  assert.deepEqual(stav.nastaveni.poukazDlazdice, { url: 'https://res.cloudinary.com/x/klasik.jpg', key: 'klasik', vanocni: { zobrazit: false } });
  assert.deepEqual(cloudinary.volaniDelete, ['detskekrucky/poukaz-dlazdice/novy']);
});
