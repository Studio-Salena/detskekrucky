// Vzhled plastové dárkové karty (přední a zadní strana) - routes/vzhledKarty.js
// s mockovanou DB (tabulka nastaveni) a Cloudinary; tisk karet v adminu.
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
    async nahratObrazek(buffer, opts) { return { secure_url: `https://res.cloudinary.com/demo/image/upload/${opts.folder}/novy.png`, public_id: `${opts.folder}/novy` }; },
    async smazatObrazek(id) { stav.smazano.push(id); return { ok: true }; },
    ziskatOptimalizovanouUrl: (url, sirka) => url + '?w=' + sirka
  };
  return nacistRouterSMocky('../routes/vzhledKarty.js', { '../db/pool': pool, '../lib/cloudinary': cloudinary });
}

test('bez nastavení: výchozí vzhled (bez obrázků, kód vpravo dole)', async () => {
  const res = vytvoritRes();
  await najitHandler(nacist({ nastaveni: {} }), 'get', '/')({}, res);
  assert.deepEqual(res.body, { predni: null, zadni: null, poziceKodu: 'vpravo-dole' });
});

test('nahrání zadní strany: uloží se, starý obrázek se smaže, přední zůstane; tisková URL ve vysokém rozlišení', async () => {
  const stav = { nastaveni: { vzhledKarty: { predni: { url: 'https://p', key: 'p' }, zadni: { url: 'https://z', key: 'stara' } } } };
  const res = vytvoritRes();
  await najitHandler(nacist(stav), 'post', '/:strana')({ params: { strana: 'zadni' }, file: { buffer: JPEG, size: JPEG.length, mimetype: 'image/jpeg' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(stav.nastaveni.vzhledKarty.zadni.key, 'detskekrucky/vzhled-karty/novy');
  assert.equal(stav.nastaveni.vzhledKarty.predni.key, 'p');
  assert.deepEqual(stav.smazano, ['stara']);
  assert.match(res.body.zadni.tisk_url, /\?w=1800$/);
  assert.match(res.body.zadni.nahled_url, /\?w=500$/);
});

test('pozice kódu: uloží známou, odmítne neznámou', async () => {
  const stav = { nastaveni: {} };
  const handler = najitHandler(nacist(stav), 'put', '/pozice');
  let res = vytvoritRes();
  await handler({ body: { poziceKodu: 'vlevo-nahore' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(stav.nastaveni.vzhledKarty.poziceKodu, 'vlevo-nahore');
  res = vytvoritRes();
  await handler({ body: { poziceKodu: 'nekde' } }, res);
  assert.equal(res.statusCode, 400);
});

test('vrácení výchozího smaže jen danou stranu', async () => {
  const stav = { nastaveni: { vzhledKarty: { predni: { url: 'https://p', key: 'p' }, zadni: { url: 'https://z', key: 'z' }, poziceKodu: 'vlevo-dole' } } };
  const res = vytvoritRes();
  await najitHandler(nacist(stav), 'delete', '/:strana')({ params: { strana: 'predni' } }, res);
  assert.deepEqual(stav.nastaveni.vzhledKarty, { zadni: { url: 'https://z', key: 'z' }, poziceKodu: 'vlevo-dole' });
  assert.deepEqual(stav.smazano, ['p']);
  assert.equal(res.body.predni, null);
});

test('admin: vzhled karty, tisk karet (zadní strany zrcadlově), registrace v index.js', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(index, /app\.use\('\/api\/vzhled-karty', vzhledKartyRoutes\)/);
  assert.match(admin, /onclick="prepnoutVzhledKarty\(\)"/);
  assert.match(admin, /onclick="otevritTiskKaret\(\)"/);
  assert.match(admin, /id="modalTiskKaret"/);
  assert.match(admin, /if \(strana === 'zadni'\) radek\.reverse\(\);/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'karta-jezek.jpg')), 'výchozí přední strana');
  // formát čárového kódu: EAN-13 jen s platnou kontrolní číslicí, jinak CODE128
  const a = admin.indexOf('function formatKoduKarty(');
  const fn = new Function(admin.slice(a, admin.indexOf('\n}\n', a) + 2) + '; return formatKoduKarty;')();
  assert.equal(fn('2300000000016'), 'EAN13');
  assert.equal(fn('2300000000017'), 'CODE128');
  assert.equal(fn('ABC-12345'), 'CODE128');
});
