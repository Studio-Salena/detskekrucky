// Backend nesmí servírovat zdrojový kód (routes/, lib/, index.js, package.json,
// .env...) - jen soubory webu. Test běží nad skutečným adresářem repozitáře
// se stejným express.static jako index.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { jePovolenyStatickySoubor, statickeSoubory } = require('../lib/statickeSoubory');

test('povolené: stránky, obrázky, PDF fonty adminu, robots a sitemap', () => {
  for (const cesta of ['/', '/admin.html', '/eshop.html', '/mobilni-sken.html', '/logo.jpg', '/poukaz-dlazdice.png',
    '/fonts/DejaVuSans-bold.js', '/robots.txt', '/sitemap.xml']) {
    assert.equal(jePovolenyStatickySoubor(cesta), true, cesta);
  }
});

test('zakázané: kód serveru, konfigurace, testy, závislosti, skryté soubory a obcházení', () => {
  for (const cesta of ['/index.js', '/package.json', '/package-lock.json', '/CLAUDE.md', '/.env', '/.gitignore', '/CNAME',
    '/routes/emaily.js', '/lib/modely.js', '/db/pool.js', '/db/schema.sql', '/middleware/adminAuth.js',
    '/test/auth.test.js', '/test-helpers/_pomocnik.js', '/node_modules/express/package.json',
    '/node_modules/foo/readme.html', '/routes/x.html', '/ROUTES/x.html', '/.git/config', '/.github/workflows/static.yml',
    '/fonts/../index.js', '/%2e%2e/index.js', '/fonts/%2e%2e/index.js', '/lib%2fmodely.js', '/a\\b.html', '/%E0%A4%A.html',
    '/fonts/DejaVuSans-bold.json', '/eshop.html/x.js', null]) {
    assert.equal(jePovolenyStatickySoubor(cesta), false, String(cesta));
  }
});

test('express: zdrojáky vrací 404, web 200, API dál projde', async () => {
  const app = express();
  app.use(statickeSoubory(express.static(path.join(__dirname, '..'))));
  app.get('/api/test', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const cesta of ['/routes/emaily.js', '/index.js', '/package.json', '/db/pool.js', '/lib/modely.js', '/CLAUDE.md', '/node_modules/express/package.json', '/.gitignore']) {
      assert.equal((await fetch(base + cesta)).status, 404, cesta);
    }
    for (const cesta of ['/', '/admin.html', '/logo.jpg', '/fonts/DejaVuSans-bold.js', '/robots.txt']) {
      assert.equal((await fetch(base + cesta)).status, 200, cesta);
    }
    assert.deepEqual(await (await fetch(base + '/api/test')).json(), { ok: true });
  } finally {
    await new Promise(r => server.close(r));
  }
});
