// Návštěvnost webu bez cookies: pravidla (lib/navstevnost.js), API (routes/navstevnost.js)
// proti skutečnému PostgreSQL (jen s TEST_PG_URL), skript na stránkách a záložka v adminu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  normalizovatStranku, normalizovatProdukt, jeRobot, zarizeni, zdrojNavstevy, otiskNavstevnika, overitObdobi
} = require('../lib/navstevnost');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'test-heslo';

const KOREN = path.join(__dirname, '..');
const cist = f => fs.readFileSync(path.join(KOREN, f), 'utf8');
const ADMIN = cist('admin.html');
const ESHOP = cist('eshop.html');
const PAYLOAD = '<img src=x onerror=alert(1)>';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function vytahnout(html, nazev) {
  const start = html.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, nazev);
  let hloubka = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') hloubka++;
    else if (html[i] === '}' && --hloubka === 0) return (html.slice(start - 6, start) === 'async ' ? 'async ' : '') + html.slice(start, i + 1);
  }
  throw new Error('konec ' + nazev);
}

test('stránky a boty: jen známé stránky webu, jinak "jina"; slug boty ověřený', () => {
  assert.equal(normalizovatStranku('/'), '/');
  assert.equal(normalizovatStranku('/index.html'), '/');
  assert.equal(normalizovatStranku('/eshop'), '/eshop.html');
  assert.equal(normalizovatStranku('/Eshop.html'), '/eshop.html');
  assert.equal(normalizovatStranku('/reklamacni-rad.html'), '/reklamacni-rad.html');
  assert.equal(normalizovatStranku('/admin.html'), 'jina');
  assert.equal(normalizovatStranku(PAYLOAD), 'jina');
  assert.equal(normalizovatStranku(null), 'jina');
  assert.equal(normalizovatProdukt('froddo-classic-2'), 'froddo-classic-2');
  assert.equal(normalizovatProdukt(PAYLOAD), null);
  assert.equal(normalizovatProdukt('x'.repeat(121)), null);
  assert.equal(normalizovatProdukt(['a']), null);
});

test('roboti se nepočítají, zařízení podle prohlížeče', () => {
  assert.equal(jeRobot(CHROME), false);
  assert.equal(jeRobot(IPHONE), false);
  for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; SeznamBot/4.0)',
    'facebookexternalhit/1.1', 'curl/8.4.0', 'python-requests/2.31', 'Mozilla/5.0 HeadlessChrome/120', '', undefined]) {
    assert.equal(jeRobot(ua), true, String(ua));
  }
  assert.equal(zarizeni(CHROME), 'pocitac');
  assert.equal(zarizeni(IPHONE), 'mobil');
  assert.equal(zarizeni('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36'), 'mobil');
  assert.equal(zarizeni('Mozilla/5.0 (Linux; Android 13; SM-X200) Safari/537.36'), 'tablet');
  assert.equal(zarizeni('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'tablet');
});

test('zdroj: známé weby hezky, vlastní web = přechod uvnitř (null), bez odkazu = Přímo, kampaň má přednost', () => {
  assert.equal(zdrojNavstevy('https://www.google.cz/'), 'Google');
  assert.equal(zdrojNavstevy('https://www.google.com/search?q=boty'), 'Google');
  assert.equal(zdrojNavstevy('https://search.seznam.cz/?q=barefoot'), 'Seznam');
  assert.equal(zdrojNavstevy('https://l.facebook.com/'), 'Facebook');
  assert.equal(zdrojNavstevy('https://www.instagram.com/'), 'Instagram');
  assert.equal(zdrojNavstevy('https://www.nejakyblog.cz/clanek'), 'nejakyblog.cz');
  assert.equal(zdrojNavstevy('https://www.detskekrucky.cz/'), null);
  assert.equal(zdrojNavstevy('https://detskekrucky.cz/eshop.html'), null);
  assert.equal(zdrojNavstevy(''), 'Přímo');
  assert.equal(zdrojNavstevy(undefined), 'Přímo');
  assert.equal(zdrojNavstevy('nesmysl'), 'Přímo');
  assert.equal(zdrojNavstevy('https://www.detskekrucky.cz/', 'facebook'), 'Facebook');
  assert.equal(zdrojNavstevy('', 'seznam'), 'Seznam');
  assert.equal(zdrojNavstevy('', 'newsletter'), 'newsletter');
  assert.equal(zdrojNavstevy('', PAYLOAD), 'Přímo');
});

test('otisk návštěvníka: stejný den a prohlížeč = stejný, jiná sůl (jiný den) = jiný; IP v něm není čitelná', () => {
  const a = otiskNavstevnika('sul1', '1.2.3.4', CHROME);
  assert.equal(a, otiskNavstevnika('sul1', '1.2.3.4', CHROME));
  assert.notEqual(a, otiskNavstevnika('sul2', '1.2.3.4', CHROME));
  assert.notEqual(a, otiskNavstevnika('sul1', '1.2.3.5', CHROME));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('období přehledu: formát, skutečné datum, pořadí a délka', () => {
  assert.deepEqual(overitObdobi('2026-10-01', '2026-10-31'), { od: '2026-10-01', do: '2026-10-31' });
  assert.match(overitObdobi('2026-10-31', '2026-10-01').chyba, /po jeho konci/);
  assert.match(overitObdobi('2026-02-30', '2026-03-01').chyba, /Neplatné/);
  assert.match(overitObdobi('2026-10-01', undefined).chyba, /Neplatné/);
  assert.match(overitObdobi("2026-10-01' OR 1=1", '2026-10-31').chyba, /Neplatné/);
  assert.match(overitObdobi('2020-01-01', '2026-10-31').chyba, /příliš dlouhé/);
});

test('web: skript na veřejných stránkách (ne v adminu), 404 se hlásí jako 404, e-shop hlásí detail boty', () => {
  for (const f of ['index.html', 'eshop.html', 'obchodni-podminky.html', 'odstoupeni-od-smlouvy.html', 'reklamacni-rad.html', '404.html']) {
    assert.match(cist(f), /<script src="\/navstevnost\.js" defer><\/script>/, f);
  }
  assert.doesNotMatch(ADMIN, /src="\/?navstevnost\.js"/);
  assert.match(cist('404.html'), /<meta name="dk-stranka" content="\/404\.html">/);
  const detail = ESHOP.slice(ESHOP.indexOf('function openDetail('), ESHOP.indexOf('// Bota má vlastní adresu'));
  assert.match(detail, /if \(p\.slug && window\.dkNavsteva\) window\.dkNavsteva\(p\.slug\);/);
});

test('navstevnost.js: pošle stránku, odkaz a kampaň; prohlížeč majitelky nepočítá; detail boty jako přechod uvnitř', () => {
  const kod = cist('navstevnost.js');
  function spustit({ hledani = '', odkaz = '', nepocitat = false, meta = null } = {}) {
    const odeslano = [];
    const sandbox = {
      location: { pathname: '/eshop.html', search: hledani, href: 'https://www.detskekrucky.cz/eshop.html' + hledani },
      document: { referrer: odkaz, querySelector: () => meta },
      localStorage: { getItem: k => (nepocitat && k === 'dkNepocitatNavstevy' ? '1' : null) },
      URLSearchParams,
      fetch: (url, o) => { odeslano.push({ url, o, data: JSON.parse(o.body) }); return Promise.resolve(); }
    };
    sandbox.window = sandbox;
    vm.runInNewContext(kod, sandbox);
    return { odeslano, sandbox };
  }
  let { odeslano, sandbox } = spustit({ hledani: '?fbclid=abc', odkaz: 'https://l.facebook.com/' });
  assert.equal(odeslano.length, 1);
  assert.equal(odeslano[0].url, 'https://detskekrucky1.onrender.com/api/navstevnost');
  assert.equal(odeslano[0].o.headers['Content-Type'], 'text/plain');
  assert.equal(odeslano[0].o.credentials, 'omit');
  assert.deepEqual(odeslano[0].data, { stranka: '/eshop.html', odkaz: 'https://l.facebook.com/', kampan: 'facebook' });
  sandbox.dkNavsteva('froddo-classic');
  assert.deepEqual(odeslano[1].data, { stranka: '/eshop.html', produkt: 'froddo-classic', odkaz: 'https://www.detskekrucky.cz/eshop.html?fbclid=abc' });
  assert.equal(spustit({ hledani: '?utm_source=newsletter' }).odeslano[0].data.kampan, 'newsletter');
  assert.equal(spustit({ meta: { content: '/404.html' } }).odeslano[0].data.stranka, '/404.html');
  ({ odeslano, sandbox } = spustit({ nepocitat: true }));
  sandbox.dkNavsteva('froddo-classic');
  assert.equal(odeslano.length, 0);
});

test('admin: záložka Návštěvnost v Reportech a v menu, přihlášení vypne počítání vlastních návštěv', () => {
  const reporty = ADMIN.slice(ADMIN.indexOf('id="page-reporty"'), ADMIN.indexOf('id="page-ucetnictvi"'));
  assert.match(reporty, /data-cil="navstevnost"[^>]*>Návštěvnost<\/button>/);
  assert.match(reporty, /data-pohled="navstevnost"[\s\S]*id="navGraf"[\s\S]*id="navProdukty"[\s\S]*id="navZdroje"/);
  assert.match(ADMIN, /showPage\('reporty',this,'navstevnost'\)"><span class="nav-text">Návštěvnost<\/span>/);
  assert.match(ADMIN, /async function loadReporty\(\) \{\s*loadNavstevnost\(\);/);
  assert.match(ADMIN, /sessionStorage\.setItem\('adminHeslo', zadaneHeslo\);\s*nepocitatMeVNavstevnosti\(\);/);
  assert.match(ADMIN, /if \(sessionStorage\.getItem\('adminHeslo'\)\) \{\s*nepocitatMeVNavstevnosti\(\);/);
  assert.match(vytahnout(ADMIN, 'nepocitatMeVNavstevnosti'), /localStorage\.setItem\('dkNepocitatNavstevy', '1'\)/);
});

test('admin: přehled vykreslí čísla, konverzi, graf s nulovými dny a escapované tabulky', async () => {
  const prvky = {};
  const sandbox = {
    API: 'https://api',
    MESICE_KRATCE: ['Led', 'Úno', 'Bře', 'Dub', 'Kvě', 'Čer', 'Čvc', 'Srp', 'Zář', 'Říj', 'Lis', 'Pro'],
    document: {
      getElementById: id => (prvky[id] = prvky[id] || { innerHTML: '', textContent: '' }),
      querySelectorAll: () => []
    },
    adminFetch: async url => {
      sandbox.volano = url;
      return { ok: true, json: async () => sandbox.odpoved };
    }
  };
  vm.createContext(sandbox);
  const konst = ADMIN.match(/const cisloCs = [^\n]*/)[0];
  vm.runInContext(['let navObdobi = "7"; let navPozadavek = 0;', konst, ...['escH', 'isoDatum', 'rozsahNavstevnosti', 'tabulkaNavstevnosti', 'loadNavstevnost'].map(n => vytahnout(ADMIN, n))].join('\n'), sandbox);
  const [od, doDne] = vm.runInContext('rozsahNavstevnosti("7")', sandbox);
  sandbox.odpoved = {
    souhrn: { zobrazeni: 1500, zobrazeni_bot: 40, navstevnici: 600, navstevnici_eshop: 200, objednavky: 5 },
    dny: [{ den: doDne, zobrazeni: 1500, navstevnici: 600 }],
    stranky: [{ stranka: '/', nazev: 'Úvodní stránka', zobrazeni: 900, navstevnici: 500 }],
    produkty: [{ produkt: 'froddo', znacka: 'Froddo', nazev: PAYLOAD, zobrazeni: 30, navstevnici: 20 }, { produkt: 'stara-bota', znacka: null, nazev: null, zobrazeni: 10, navstevnici: 5 }],
    zdroje: [{ zdroj: 'Přímo', navstevnici: 300 }, { zdroj: PAYLOAD, navstevnici: 1 }],
    zarizeni: [{ zarizeni: 'mobil', navstevnici: 450 }, { zarizeni: 'pocitac', navstevnici: 150 }]
  };
  await vm.runInContext('loadNavstevnost()', sandbox);
  assert.equal(sandbox.volano, `https://api/navstevnost/prehled?od=${od}&do=${doDne}`);
  const cisloCs = n => n.toLocaleString('cs-CZ');
  assert.equal(prvky.navStatNavstevnici.textContent, cisloCs(600));
  assert.equal(prvky.navStatZobrazeni.textContent, cisloCs(1500));
  assert.equal(prvky.navStatZobrazeniSub.textContent, `${(2.5).toLocaleString('cs-CZ')} na návštěvníka`);
  assert.equal(prvky.navStatKonverze.textContent, `${(2.5).toLocaleString('cs-CZ')} % z ${cisloCs(200)} návštěvníků e-shopu`);
  assert.equal((prvky.navGraf.innerHTML.match(/class="bar-item"/g) || []).length, 7);
  assert.match(prvky.navGraf.innerHTML, /600 návštěvníků/);
  assert.ok(!prvky.navProdukty.innerHTML.includes(PAYLOAD) && prvky.navProdukty.innerHTML.includes('&lt;img'));
  assert.match(prvky.navProdukty.innerHTML, /stara-bota <span[^>]*>\(už není v katalogu\)/);
  assert.ok(!prvky.navZdroje.innerHTML.includes(PAYLOAD));
  assert.match(prvky.navZdroje.innerHTML, /Přímo \(záložka/);
  assert.match(prvky.navZarizeni.innerHTML, /📱 Mobil[\s\S]*75 %/);
});

test('API proti PostgreSQL: záznam bez IP, roboti a spam pryč, přehled za období, admin ochrana', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'navstevnosttest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const routePath = require.resolve('../routes/navstevnost.js');
  const poolPath = require.resolve('../db/pool');
  try {
    await pool.query(`
      CREATE TABLE modely (id SERIAL PRIMARY KEY, slug TEXT, znacka TEXT, nazev TEXT);
      INSERT INTO modely (slug, znacka, nazev) VALUES ('froddo-classic', 'Froddo', 'Classic');
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, stav TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO objednavky (stav) VALUES ('nova'), ('zaplacena'), ('zrusena');
      INSERT INTO objednavky (stav, vytvoreno) VALUES ('nova', NOW() - INTERVAL '40 days');`);
    delete require.cache[routePath];
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
    const router = require(routePath);
    await require('../lib/startServeru').vsePripraveno();
    const express = require('express');
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/navstevnost', router);
    const server = app.listen(0);
    const url = `http://127.0.0.1:${server.address().port}/api/navstevnost`;
    const poslat = (data, ua = CHROME, ip = '10.0.0.1') => fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': ua, 'X-Forwarded-For': ip }, body: JSON.stringify(data) });
    try {
      let r = await poslat({ stranka: '/', odkaz: 'https://www.google.cz/' });
      assert.equal(r.status, 204);
      await poslat({ stranka: '/eshop.html', odkaz: 'https://www.detskekrucky.cz/' });
      await poslat({ stranka: '/eshop.html', produkt: 'froddo-classic', odkaz: 'https://www.detskekrucky.cz/eshop.html' });
      await poslat({ stranka: '/eshop.html', odkaz: '' }, IPHONE, '10.0.0.2');
      await poslat({ stranka: '/eshop.html', produkt: 'smazana-bota' }, IPHONE, '10.0.0.2');
      await poslat({ stranka: '/' }, 'Mozilla/5.0 (compatible; Googlebot/2.1)');
      await poslat({ stranka: PAYLOAD }, CHROME, '10.0.0.3');
      assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': CHROME }, body: 'nesmysl{' })).status, 204);
      // odpověď jde před zápisem - počkat, než se zápisy dokončí
      for (let i = 0; i < 50 && Number((await pool.query('SELECT COUNT(*) FROM navstevy')).rows[0].count) < 6; i++) await new Promise(res => setTimeout(res, 20));

      const ulozene = await pool.query('SELECT * FROM navstevy ORDER BY id');
      assert.equal(ulozene.rows.length, 6);
      assert.ok(ulozene.rows.every(z => /^[0-9a-f]{16}$/.test(z.navstevnik)));
      assert.ok(!JSON.stringify(ulozene.rows).includes('10.0.0'));
      // pořadí zápisů není zaručené (odpověď jde dřív než zápis)
      const radky = ulozene.rows.map(z => `${z.stranka}|${z.produkt || ''}|${z.zdroj}|${z.zarizeni}`).sort();
      assert.deepEqual(radky, [
        '/eshop.html||null|pocitac',
        '/eshop.html||Přímo|mobil',
        '/eshop.html|froddo-classic|null|pocitac',
        '/eshop.html|smazana-bota|Přímo|mobil',
        '/||Google|pocitac',
        'jina||Přímo|pocitac'
      ].sort());
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM navstevnost_sul')).rows[0].n, 1);

      const dnes = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
      const H = { 'x-admin-heslo': process.env.ADMIN_HESLO };
      assert.equal((await fetch(`${url}/prehled?od=${dnes}&do=${dnes}`)).status, 403);
      assert.equal((await fetch(`${url}/prehled?od=x&do=${dnes}`, { headers: H })).status, 400);
      r = await fetch(`${url}/prehled?od=${dnes}&do=${dnes}`, { headers: H });
      const d = await r.json();
      assert.deepEqual(d.souhrn, { zobrazeni: 4, zobrazeni_bot: 2, navstevnici: 3, navstevnici_eshop: 2, objednavky: 2 });
      assert.deepEqual(d.dny, [{ den: dnes, zobrazeni: 4, navstevnici: 3 }]);
      assert.deepEqual(d.produkty.map(p => [p.produkt, p.nazev]), [['froddo-classic', 'Classic'], ['smazana-bota', null]]);
      assert.equal(d.stranky.find(s => s.stranka === '/eshop.html').zobrazeni, 2);
      assert.equal(d.stranky.find(s => s.stranka === 'jina').nazev, 'Jiná adresa');
      assert.deepEqual(d.zdroje.map(z => [z.zdroj, z.navstevnici]), [['Přímo', 2], ['Google', 1]]);
      assert.deepEqual(d.zarizeni.map(z => [z.zarizeni, z.navstevnici]), [['pocitac', 2], ['mobil', 1]]);

      // limit z jedné IP: nad 120 záznamů za 10 minut se další zahodí
      for (let i = 0; i < 125; i++) await poslat({ stranka: '/' }, CHROME, '10.0.0.9');
      await new Promise(res => setTimeout(res, 300));
      const zIp = (await pool.query('SELECT COUNT(*)::int AS n FROM navstevy WHERE id > $1', [Math.max(...ulozene.rows.map(z => Number(z.id)))])).rows[0].n;
      assert.equal(zIp, 120);
    } finally {
      server.close();
    }
  } finally {
    delete require.cache[routePath];
    delete require.cache[poolPath];
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
