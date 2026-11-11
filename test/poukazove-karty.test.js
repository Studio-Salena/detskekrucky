// Plastové dárkové karty: stav karty, vyhledání poukazu přes EAN karty, nahrání,
// čerpání po částech, automatická blokace po vyčerpání, uvolnění, ruční blokace,
// převod zůstatku. Unit testy bez DB + celý životní cyklus proti PostgreSQL (TEST_PG_URL).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jePlatnyEan13, vygenerovatEanKarty, cisloKarty, normalizovatCisloKarty, stavKarty } = require('../lib/poukazKarty');
const RR = require('../lib/poukazPlatnost').dnesVPraze().slice(2, 4);

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
process.env.ADMIN_HESLO = process.env.ADMIN_HESLO || 'test-heslo';

test('EAN karty: prefix 23, platná kontrolní číslice; číslo karty DK-26-00481', () => {
  for (let i = 0; i < 200; i++) {
    const ean = vygenerovatEanKarty();
    assert.match(ean, /^23\d{11}$/);
    assert.ok(jePlatnyEan13(ean), ean);
  }
  assert.ok(jePlatnyEan13('4006381333931'));
  assert.ok(!jePlatnyEan13('4006381333932'));
  assert.ok(!jePlatnyEan13('12345'));
  assert.equal(cisloKarty(7), `DK-${RR}-00007`);
  assert.equal(cisloKarty(7, new Date('2026-11-11T10:00:00Z')), 'DK-26-00007');
  assert.equal(cisloKarty(481, new Date('2026-12-31T23:30:00Z')), 'DK-27-00481');
  assert.equal(normalizovatCisloKarty('dk2600481'), 'DK-26-00481');
  assert.equal(normalizovatCisloKarty(' DK-26-481 '), 'DK-26-00481');
  assert.equal(normalizovatCisloKarty('2300000000017'), '2300000000017');
});

test('stav karty se odvozuje z jejího poukazu', () => {
  const k = { aktualni_poukaz_id: 1, zablokovana: false };
  const p = { stav: 'aktivni', zustatek: 300, platnost_do: '2099-12-31' };
  assert.equal(stavKarty({ aktualni_poukaz_id: null, zablokovana: false }, null), 'prazdna');
  assert.equal(stavKarty(k, p), 'nabita');
  assert.equal(stavKarty(k, { ...p, stav: 'pouzity', zustatek: 0 }), 'vycerpana');
  assert.equal(stavKarty(k, { ...p, zustatek: 0 }), 'vycerpana');
  assert.equal(stavKarty(k, { ...p, platnost_do: '2020-01-01' }), 'prosla');
  assert.equal(stavKarty(k, { ...p, stav: 'zruseny' }), 'zrusena');
  assert.equal(stavKarty({ ...k, zablokovana: true }, p), 'zablokovana');
});

test('admin: stránka poukazů má sekci Plastové karty a volá API karet', () => {
  const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.match(ADMIN, /id="kartyNacist"/);
  assert.match(ADMIN, /API \+ '\/poukazove-karty/);
  assert.match(ADMIN, /karta_ean:/);
});

test('API proti PostgreSQL: celý životní cyklus plastové karty', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'kartytest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const poolPath = require.resolve('../db/pool');
  const cesty = ['../routes/prodejna.js', '../routes/poukazy.js', '../routes/poukazoveKarty.js', '../lib/promo.js'].map(p => require.resolve(p));
  try {
    await pool.query('CREATE TABLE objednavky (id SERIAL PRIMARY KEY)');
    cesty.forEach(p => delete require.cache[p]);
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
    const prodejna = require('../routes/prodejna.js');
    await require('../lib/startServeru').vsePripraveno();
    const poukazy = require('../routes/poukazy.js');
    await require('../lib/startServeru').vsePripraveno();
    // migrace musí jít spustit znovu (restart serveru)
    delete require.cache[require.resolve('../routes/poukazy.js')];
    require('../routes/poukazy.js');
    await require('../lib/startServeru').vsePripraveno();
    const karty = require('../routes/poukazoveKarty.js');

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/prodejna', prodejna);
    app.use('/api/poukazy', poukazy);
    app.use('/api/poukazove-karty', karty);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const H = { 'Content-Type': 'application/json', 'x-admin-heslo': process.env.ADMIN_HESLO };
    const zavolat = async (metoda, url, telo, h = H) => {
      const r = await fetch(base + url, { method: metoda, headers: h, body: telo ? JSON.stringify(telo) : undefined });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    try {
      // bez hesla nic
      assert.equal((await zavolat('GET', '/poukazove-karty', null, {})).status, 403);

      // dávka karet pro výrobce + zaevidování karty s vlastním kódem
      let r = await zavolat('POST', '/poukazove-karty/davka', { pocet: 3 });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.karty.map(k => k.cislo), [`DK-${RR}-00001`, `DK-${RR}-00002`, `DK-${RR}-00003`]);
      const [k1, k2, k3] = r.data.karty;
      assert.equal((await zavolat('POST', '/poukazove-karty/davka', { pocet: 0 })).status, 400);
      r = await zavolat('POST', '/poukazove-karty', { ean: '4006381333931' });
      assert.equal(r.status, 200);
      assert.equal(r.data.cislo, `DK-${RR}-00004`);
      assert.equal(r.data.stav, 'prazdna');
      assert.equal((await zavolat('POST', '/poukazove-karty', { ean: '4006381333931' })).status, 400, 'duplicitní kód');
      assert.equal((await zavolat('POST', '/poukazove-karty', { ean: '4006381333932' })).status, 400, 'špatná kontrolní číslice');

      // prázdná karta v pokladně neprojde
      r = await zavolat('GET', '/poukazy/overit/' + k1.ean);
      assert.equal(r.status, 400);
      assert.match(r.data.chyba, /není nahraný/);

      // nahrání 1 200 Kč na kartu = poukaz + prodej v tržbách
      assert.equal((await zavolat('POST', '/poukazy', { karta_ean: k1.ean, hodnota: 50, platba: 'hotovost' })).status, 400, 'pod minimem');
      assert.equal((await zavolat('POST', '/poukazy', { karta_ean: '2399999999990', hodnota: 1200, platba: 'hotovost' })).status, 400, 'neznámá karta');
      r = await zavolat('POST', '/poukazy', { karta_ean: k1.ean, hodnota: 1200, platba: 'hotovost', kupujici_jmeno: 'Jana' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(Number(r.data.zustatek), 1200);
      assert.equal(r.data.karta.cislo, `DK-${RR}-00001`);
      assert.equal(Number(r.data.prodej.celkem), 1200);
      assert.match(r.data.prodej.polozky[0].nazev, new RegExp(`Dárková karta DK-${RR}-00001`));
      const poukazKod = r.data.kod;
      // podruhé na plnou kartu nejde
      r = await zavolat('POST', '/poukazy', { karta_ean: k1.ean, hodnota: 500 });
      assert.equal(r.status, 400);
      assert.match(r.data.chyba, /už poukaz je/);

      // ověření a čerpání po částech přes EAN karty
      r = await zavolat('GET', '/poukazy/overit/' + k1.ean);
      assert.equal(r.status, 200);
      assert.equal(r.data.zustatek, 1200);
      assert.equal(r.data.karta, `DK-${RR}-00001`);
      r = await zavolat('POST', '/poukazy/pouzit', { kod: k1.ean, castka: 900 });
      assert.equal(r.data.zustatek, 300);

      // pokladna: doplatek – karta pokryje 300 Kč z nákupu za 1 000 Kč
      r = await zavolat('POST', '/prodejna', {
        polozky: [{ nazev: 'Boty', pocet: 1, cena: 1000 }], celkem: 1000, poukaz_kod: k1.ean, doplatek_platba: 'karta'
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(Number(r.data.celkem), 700);
      assert.equal(Number(r.data.poukaz_castka), 300);
      assert.equal(r.data.poukaz_kod, poukazKod);

      // vyčerpaná karta je zablokovaná, dokud ji majitelka neuvolní
      r = await zavolat('GET', '/poukazove-karty/najit/' + k1.ean);
      assert.equal(r.data.stav, 'vycerpana');
      assert.equal(r.data.pouziti.length, 2);
      assert.equal((await zavolat('GET', '/poukazy/overit/' + k1.ean)).status, 400);
      r = await zavolat('POST', '/poukazy', { karta_ean: k1.ean, hodnota: 500 });
      assert.equal(r.status, 400, 'na vyčerpanou neuvolněnou kartu nic nenahraje');

      // vrácení zboží: připsání oživí poukaz i kartu
      const poukazId = (await pool.query('SELECT id FROM darkove_poukazy WHERE kod = $1', [poukazKod])).rows[0].id;
      r = await zavolat('POST', `/poukazy/${poukazId}/pripsat`, { castka: 100 });
      assert.equal(r.status, 200);
      assert.equal((await zavolat('GET', `/poukazove-karty/najit/DK-${RR}-00001`)).data.stav, 'nabita');
      assert.equal((await zavolat('POST', `/poukazove-karty/${k1.id}/uvolnit`)).status, 400, 'se zůstatkem uvolnit nejde');
      await zavolat('POST', '/poukazy/pouzit', { kod: k1.ean, castka: 100 });

      // uvolnění → prázdná → nové nahrání; historie zůstává
      r = await zavolat('POST', `/poukazove-karty/${k1.id}/uvolnit`);
      assert.equal(r.status, 200);
      assert.equal(r.data.stav, 'prazdna');
      r = await zavolat('POST', '/poukazy', { karta_ean: `dk${RR}1`, hodnota: 700, druh: 'dar' });
      assert.equal(r.status, 200, 'karta jde najít i podle čísla');
      assert.equal(r.data.prodej, null, 'dar nevytváří prodej');
      r = await zavolat('GET', '/poukazove-karty/najit/' + k1.ean);
      assert.equal(r.data.stav, 'nabita');
      assert.equal(r.data.poukazy.length, 2);
      assert.deepEqual(r.data.udalosti.map(u => u.akce), ['nahrani', 'uvolneni', 'nahrani', 'pridani']);
      // starý kód poukazu už nic nemá
      assert.equal((await zavolat('GET', '/poukazy/overit/' + poukazKod)).status, 400);

      // ztráta: ruční blokace zastaví kartu i kód jejího poukazu, pak převod na druhou kartu
      const kodNaKarte = (await zavolat('GET', `/poukazove-karty/najit/DK-${RR}-00001`)).data.poukaz.kod;
      r = await zavolat('POST', `/poukazove-karty/${k1.id}/zablokovat`, { duvod: 'ztráta' });
      assert.equal(r.data.stav, 'zablokovana');
      assert.match((await zavolat('GET', '/poukazy/overit/' + k1.ean)).data.chyba, /zablokovaná/);
      assert.match((await zavolat('GET', '/poukazy/overit/' + kodNaKarte)).data.chyba, /zablokovaná/);
      assert.equal((await zavolat('POST', '/poukazy/pouzit', { kod: k1.ean, castka: 10 })).status, 400);
      assert.equal((await zavolat('POST', `/poukazove-karty/${k1.id}/prevest`, { na: k1.ean })).status, 400);
      r = await zavolat('POST', `/poukazove-karty/${k1.id}/prevest`, { na: k2.ean });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.cislo, `DK-${RR}-00002`);
      assert.equal(r.data.poukaz.zustatek, 700);
      assert.equal((await zavolat('GET', '/poukazy/overit/' + k2.ean)).data.zustatek, 700);
      r = await zavolat('GET', `/poukazove-karty/najit/DK-${RR}-00001`);
      assert.equal(r.data.stav, 'zablokovana');
      assert.equal(r.data.poukaz, null);
      // zrušení blokace staré karty → prázdná
      r = await zavolat('POST', `/poukazove-karty/${k1.id}/odblokovat`);
      assert.equal(r.data.stav, 'prazdna');

      // smazání nikdy nepoužitého poukazu kartu uvolní (FK)
      r = await zavolat('POST', '/poukazy', { karta_ean: k3.ean, hodnota: 300 });
      await zavolat('DELETE', '/poukazy/' + r.data.id);
      assert.equal((await zavolat('GET', '/poukazove-karty/najit/' + k3.ean)).data.stav, 'prazdna');

      // mazat jde jen kartu bez historie
      assert.equal((await zavolat('DELETE', `/poukazove-karty/${k1.id}`)).status, 400);
      const k4 = (await zavolat('GET', `/poukazove-karty/najit/DK-${RR}-00004`)).data;
      assert.equal((await zavolat('DELETE', `/poukazove-karty/${k4.id}`)).status, 200);

      // přehled karet
      r = await zavolat('GET', '/poukazove-karty');
      assert.deepEqual(r.data.map(k => [k.cislo, k.stav]), [[`DK-${RR}-00001`, 'prazdna'], [`DK-${RR}-00002`, 'nabita'], [`DK-${RR}-00003`, 'prazdna']]);
      // seznam poukazů ukáže číslo karty
      r = await zavolat('GET', '/poukazy');
      assert.ok(r.data.some(p => p.karta_cislo === `DK-${RR}-00002`));
    } finally {
      server.close();
    }
  } finally {
    delete require.cache[poolPath];
    cesty.forEach(p => delete require.cache[p]);
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
