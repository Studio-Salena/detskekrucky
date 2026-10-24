// Vzhled tištěného poukazu (klasický i vánoční) - routes/poukazVzhled.js
// s mockovanou DB (tabulka nastaveni) a Cloudinary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');

const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0]);

function nacist(stav) {
  const pool = {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT hodnota FROM nastaveni WHERE klic')) return { rows: stav.nastaveni[params[0]] ? [{ hodnota: stav.nastaveni[params[0]] }] : [] };
      if (s.startsWith('INSERT INTO nastaveni')) { stav.nastaveni[params[0]] = JSON.parse(params[1]); return {}; }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
  stav.smazano = [];
  const cloudinary = {
    jeNakonfigurovano: () => true,
    async nahratObrazek(buffer, opts) { return { secure_url: `https://res.cloudinary.com/demo/${opts.folder}/novy.png`, public_id: `${opts.folder}/novy` }; },
    async smazatObrazek(id) { stav.smazano.push(id); return { ok: true }; }
  };
  return nacistRouterSMocky('../routes/poukazVzhled.js', { '../db/pool': pool, '../lib/cloudinary': cloudinary });
}

test('bez nastavení: oba vzhledy bez obrázku a pozic', async () => {
  const res = vytvoritRes();
  await najitHandler(nacist({ nastaveni: {} }), 'get', '/')({}, res);
  assert.deepEqual(res.body, { klasicky: { obrazek_url: null, pozice: {} }, vanocni: { obrazek_url: null, pozice: {} } });
});

test('nahrání obrázku klasického poukazu, starý se smaže, vánoční zůstane', async () => {
  const stav = { nastaveni: { poukazVzhled: { klasicky: { url: 'x', key: 'stary', pozice: { proTop: 60 } }, vanocni: { url: 'v', key: 'vanocni' } } } };
  const router = nacist(stav);
  const res = vytvoritRes();
  await najitHandler(router, 'post', '/:typ/obrazek')({ params: { typ: 'klasicky' }, file: { buffer: JPEG, size: JPEG.length, mimetype: 'image/jpeg' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(stav.nastaveni.poukazVzhled.klasicky.key, 'detskekrucky/poukaz-vzhled/novy');
  assert.deepEqual(stav.nastaveni.poukazVzhled.klasicky.pozice, { proTop: 60 }, 'pozice zůstanou');
  assert.equal(stav.nastaveni.poukazVzhled.vanocni.key, 'vanocni');
  assert.deepEqual(stav.smazano, ['stary']);
});

test('pozice: uloží platná čísla, odmítne neznámé a mimo rozsah', async () => {
  const stav = { nastaveni: {} };
  const handler = najitHandler(nacist(stav), 'put', '/:typ/pozice');
  const res = vytvoritRes();
  await handler({ params: { typ: 'vanocni' }, body: { pozice: { proTop: 60.25, pismo: 120 } } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(stav.nastaveni.poukazVzhled.vanocni.pozice, { proTop: 60.3, pismo: 120 });
  for (const pozice of [{ jine: 5 }, { proTop: 120 }, { pismo: 10 }, { proTop: '50' }]) {
    const r = vytvoritRes();
    await handler({ params: { typ: 'vanocni' }, body: { pozice } }, r);
    assert.equal(r.statusCode, 400, JSON.stringify(pozice));
  }
});

test('vrácení výchozího smaže obrázek i pozice jen u daného typu', async () => {
  const stav = { nastaveni: { poukazVzhled: { klasicky: { url: 'x', key: 'k', pozice: { proTop: 60 } }, vanocni: { url: 'v', key: 'vk' } } } };
  const res = vytvoritRes();
  await najitHandler(nacist(stav), 'delete', '/:typ')({ params: { typ: 'klasicky' } }, res);
  assert.deepEqual(stav.nastaveni.poukazVzhled, { vanocni: { url: 'v', key: 'vk' } });
  assert.deepEqual(stav.smazano, ['k']);
});

test('admin: obrázkový poukaz bere obrázek a pozice z nastavení, je registrovaný v index.js', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(index, /app\.use\('\/api\/poukaz-vzhled', poukazVzhledRoutes\)/);
  assert.match(admin, /src="\$\{escAttr\(obrazekPoukazu\(typ\)\)\}"/);
  assert.doesNotMatch(admin, /p\.vzhled === 'vanocni'\) (return )?tisknoutVanocniPoukaz/, 'tisk se řídí jeObrazkovyPoukaz');
});
