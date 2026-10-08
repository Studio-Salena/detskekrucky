// Doprava a GLS (2026-10) proti SKUTEČNÉMU PostgreSQL: migrace sloupců
// objednávek a tabulky zasilky (i opakovaně), uložení nastavení dopravy,
// skutečný POST /api/objednavky s ověřeným výdejním místem a převod na zásilku.
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce),
// jinak se přeskočí. Každý běh má vlastní dočasné schéma, které na konci smaže.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');
const gls = require('../lib/gls');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

const MISTO = { id: '39301-ELPESRO', nazev: 'Elpe s.r.o.', ulice: 'Myslotínská 2449', mesto: 'Pelhřimov', psc: '39301', stat: 'CZ', box: false, dobirka: true };

function nacistObjednavky(pool) {
  return nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {} },
    '../lib/glsVydejniMista': { overitVydejniMisto: async id => (id === MISTO.id ? { ...MISTO } : null) }
  });
}

test('PostgreSQL: migrace, nastavení dopravy, objednávka GLS do výdejního místa a převod na zásilku', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'glstest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const puvodniLog = console.log; console.log = () => {};
  try {
    // Tvar tabulek jako na produkci PŘED touto změnou
    await pool.query(`
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
      CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, znacka TEXT, cena NUMERIC, na_eshopu BOOLEAN DEFAULT true);
      CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost TEXT, pocet_kusu INTEGER, dostupnost TEXT DEFAULT 'skladem');
      CREATE TABLE darkove_poukazy (id SERIAL PRIMARY KEY, kod TEXT, ean TEXT, zustatek NUMERIC, stav TEXT, platnost_do DATE);
      CREATE TABLE poukazy_pouziti (id SERIAL PRIMARY KEY, poukaz_id INTEGER, castka NUMERIC, objednavka_id INTEGER);
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER REFERENCES zakaznici(id), stav TEXT DEFAULT 'nova',
        celkem NUMERIC, doprava TEXT, platba TEXT, poznamka TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER REFERENCES objednavky(id), produkt_id INTEGER, velikost TEXT, pocet INTEGER, cena NUMERIC);
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, datum TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
      INSERT INTO zakaznici (jmeno, email, telefon, ulice, mesto, psc) VALUES ('Stará Objednávka', 'stara@example.com', '111', 'A 1', 'Hulín', '76824');
      INSERT INTO objednavky (zakaznik_id, celkem, doprava, platba) VALUES (1, 579, 'zasilkovna', 'prevod');
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Bota', 'Značka', 500);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 3);
    `);

    // Migrace 2x (idempotence) - stejně jako při dvou restartech serveru
    nacistObjednavky(pool);
    assert.equal(await vsePripraveno(20000), true);
    const router = nacistObjednavky(pool);
    assert.equal(await vsePripraveno(20000), true);

    const sloupce = (await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objednavky' AND (column_name LIKE 'vydejni_misto%' OR column_name IN ('doprava_cena', 'dopravce', 'platba_priplatek'))`, [schema])).rows;
    assert.deepEqual(Object.fromEntries(sloupce.map(s => [s.column_name, s.data_type])), {
      doprava_cena: 'numeric', dopravce: 'text', vydejni_misto_id: 'text', vydejni_misto_nazev: 'text', vydejni_misto_ulice: 'text',
      vydejni_misto_mesto: 'text', vydejni_misto_psc: 'text', vydejni_misto_stat: 'text', platba_priplatek: 'numeric'
    });
    const stara = (await pool.query('SELECT doprava, doprava_cena, dopravce, vydejni_misto_id FROM objednavky WHERE id = 1')).rows[0];
    assert.deepEqual(stara, { doprava: 'zasilkovna', doprava_cena: null, dopravce: null, vydejni_misto_id: null }, 'stará objednávka beze změny');

    // Nastavení dopravy přes skutečný PUT /api/doprava: GLS výdejní místo za 69 Kč
    const dopravaRouter = nacistRouterSMocky('../routes/doprava.js', { '../db/pool': pool });
    const { VYCHOZI_NASTAVENI } = require('../lib/doprava');
    let res = vytvoritRes();
    await najitHandler(dopravaRouter, 'put', '/')({ body: { zdarmaOd: 2000, metody: { ...VYCHOZI_NASTAVENI.metody, gls_vydejni_misto: { aktivni: true, cena: 69 } }, priplatky: { dobirka: null } } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    res = vytvoritRes();
    await najitHandler(dopravaRouter, 'get', '/')({}, res);
    assert.ok(res.body.metody.some(m => m.kod === 'gls_vydejni_misto' && m.cena === 69));

    // Skutečný POST /api/objednavky
    const post = najitHandler(router, 'post', '/');
    res = vytvoritRes();
    await post({ ip: '10.9.9.9', body: { jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
      doprava: 'gls_vydejni_misto', platba: 'prevod', poznamka: '', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }],
      vydejni_misto_id: MISTO.id, vydejni_misto_nazev: 'PODVRH' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.celkem, 569);
    const nova = (await pool.query('SELECT * FROM objednavky WHERE id = $1', [res.body.objednavka_id])).rows[0];
    assert.equal(Number(nova.doprava_cena), 69);
    assert.equal(nova.dopravce, 'gls');
    assert.equal(nova.vydejni_misto_id, '39301-ELPESRO');
    assert.equal(nova.vydejni_misto_nazev, 'Elpe s.r.o.');
    assert.equal(nova.vydejni_misto_psc, '39301');
    assert.equal(nova.obj_jmeno, 'Jana Nováková');

    // Bez výdejního místa: odmítnuto, nic nového v DB
    res = vytvoritRes();
    await post({ ip: '10.9.9.8', body: { jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
      doprava: 'gls_vydejni_misto', platba: 'prevod', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }] } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM objednavky')).rows[0].n, 2);

    // Detail pro admin (GET /:id, o.*) obsahuje nové sloupce
    res = vytvoritRes();
    await najitHandler(router, 'get', '/:id')({ params: { id: String(nova.id) } }, res);
    assert.equal(res.body.vydejni_misto_nazev, 'Elpe s.r.o.');
    res = vytvoritRes();
    await najitHandler(router, 'get', '/')({}, res);
    assert.equal(res.body.find(o => o.id === nova.id).vydejni_misto_nazev, 'Elpe s.r.o.');

    // Zásilkovna bez API klíče: jako dřív, bez výdejního místa
    const objednavkaZas = (ip, extra = {}) => ({ ip, body: { jmeno: 'Petr Malý', email: 'petr@example.com', telefon: '777 000 111', ulice: 'Dlouhá 2', mesto: 'Zlín', psc: '760 01',
      doprava: 'zasilkovna', platba: 'prevod', polozky: [{ produkt_id: 1, velikost: 24, pocet: 1 }], ...extra } });
    const puvodniKlic = process.env.ZASILKOVNA_API_KLIC;
    delete process.env.ZASILKOVNA_API_KLIC;
    try {
      res = vytvoritRes();
      await post(objednavkaZas('10.9.9.7'), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const bezMista = (await pool.query('SELECT dopravce, vydejni_misto_id FROM objednavky WHERE id = $1', [res.body.objednavka_id])).rows[0];
      assert.deepEqual(bezMista, { dopravce: 'zasilkovna', vydejni_misto_id: null });

      // S API klíčem: e-shop dostane klíč a výdejní místo je povinné
      process.env.ZASILKOVNA_API_KLIC = 'abcdef0123456789';
      res = vytvoritRes();
      await najitHandler(dopravaRouter, 'get', '/')({}, res);
      assert.equal(res.body.zasilkovnaKlic, 'abcdef0123456789');
      assert.equal(res.body.metody.find(m => m.kod === 'zasilkovna').vydejniMisto, 'zasilkovna');
      res = vytvoritRes();
      await post(objednavkaZas('10.9.9.6'), res);
      assert.equal(res.statusCode, 400);
      res = vytvoritRes();
      await post(objednavkaZas('10.9.9.5', { vydejni_misto_zasilkovna: { id: '12345', nazev: 'Zlín, Kvítková 1 <b>', ulice: 'Kvítková 1', mesto: 'Zlín', psc: '76001', stat: 'cz', typ: 'internal', zlo: 'x' } }), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const sMistem = (await pool.query('SELECT dopravce, vydejni_misto_id, vydejni_misto_nazev, vydejni_misto_mesto, vydejni_misto_stat FROM objednavky WHERE id = $1', [res.body.objednavka_id])).rows[0];
      assert.deepEqual(sMistem, { dopravce: 'zasilkovna', vydejni_misto_id: '12345', vydejni_misto_nazev: 'Zlín, Kvítková 1 b', vydejni_misto_mesto: 'Zlín', vydejni_misto_stat: 'CZ' });
      // Krok 2: podání do Zásilkovny a štítek (API Zásilkovny podstrčené, nic se neodesílá)
      const zasObjId = res.body.objednavka_id;
      const podat = najitHandler(router, 'post', '/:id/zasilkovna');
      res = vytvoritRes();
      await podat({ params: { id: String(zasObjId) }, body: { vaha: 1 } }, res);
      assert.equal(res.statusCode, 503, 'bez API hesla je podání vypnuté');
      const puvodniFetch = global.fetch, puvodniHeslo = process.env.ZASILKOVNA_API_HESLO;
      const volani = [];
      process.env.ZASILKOVNA_API_HESLO = 'x'.repeat(32);
      global.fetch = async (url, o) => {
        volani.push(o.body);
        if (o.body.startsWith('<createPacket>')) return { text: async () => '<response><status>ok</status><result><id>987654</id><barcode>Z987654</barcode><barcodeText>Z 987 654</barcodeText></result></response>' };
        return { text: async () => `<response><status>ok</status><result>${Buffer.from('%PDF-1.4 stitek').toString('base64')}</result></response>` };
      };
      try {
        res = vytvoritRes();
        await podat({ params: { id: String(zasObjId) }, body: { vaha: 0.7 } }, res);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.zasilka.cislo_zasilky, 'Z987654');
        assert.match(volani[0], /<number>\d{6}<\/number><name>Petr<\/name><surname>Malý<\/surname>.*<addressId>12345<\/addressId><cod>0<\/cod><value>579<\/value><weight>0.7<\/weight>/);
        const ulozena = (await pool.query("SELECT stav, cislo_zasilky, tracking_url, data FROM zasilky WHERE objednavka_id = $1", [zasObjId])).rows;
        assert.equal(ulozena.length, 1);
        assert.deepEqual({ ...ulozena[0], data: ulozena[0].data.packetId }, { stav: 'podana', cislo_zasilky: 'Z987654', tracking_url: 'https://tracking.packeta.com/cs/?id=Z987654', data: '987654' });
        assert.ok(!JSON.stringify(ulozena).includes('x'.repeat(32)), 'heslo se neukládá');
        // podruhé už ne
        res = vytvoritRes();
        await podat({ params: { id: String(zasObjId) }, body: { vaha: 1 } }, res);
        assert.equal(res.statusCode, 409);
        assert.equal(volani.length, 1);
        // detail objednávky ukazuje zásilku
        res = vytvoritRes();
        await najitHandler(router, 'get', '/:id')({ params: { id: String(zasObjId) } }, res);
        assert.equal(res.body.zasilky[0].cislo_zasilky, 'Z987654');
        assert.equal(res.body.zasilky[0].data, undefined);
        assert.equal(res.body.zasilkovna_podani, true);
        // štítek
        res = vytvoritRes();
        const hlavicky = {};
        res.setHeader = (k, v) => { hlavicky[k] = v; };
        res.send = b => { res.body = b; return res; };
        await najitHandler(router, 'get', '/:id/zasilkovna/stitek')({ params: { id: String(zasObjId) }, query: {} }, res);
        assert.equal(res.statusCode, 200, String(res.body && res.body.chyba));
        assert.equal(hlavicky['Content-Type'], 'application/pdf');
        assert.equal(res.body.toString(), '%PDF-1.4 stitek');
        assert.match(volani[1], /<packetId>987654<\/packetId><format>A6 on A4<\/format>/);
        // GLS objednávku do Zásilkovny podat nejde
        res = vytvoritRes();
        await podat({ params: { id: String(nova.id) }, body: { vaha: 1 } }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(volani.length, 2);
      } finally {
        global.fetch = puvodniFetch;
        if (puvodniHeslo === undefined) delete process.env.ZASILKOVNA_API_HESLO; else process.env.ZASILKOVNA_API_HESLO = puvodniHeslo;
      }

      // GLS ID místo Zásilkovny ani místo jiného dopravce neprojde
      res = vytvoritRes();
      await post(objednavkaZas('10.9.9.4', { vydejni_misto_id: '12345' }), res);
      assert.equal(res.statusCode, 400);
      res = vytvoritRes();
      await post(objednavkaZas('10.9.9.3', { vydejni_misto_zasilkovna: { id: '999', nazev: 'Cizí', mesto: 'Wien', stat: 'at', typ: 'internal' } }), res);
      assert.equal(res.statusCode, 400);
    } finally {
      if (puvodniKlic === undefined) delete process.env.ZASILKOVNA_API_KLIC; else process.env.ZASILKOVNA_API_KLIC = puvodniKlic;
    }

    // Podání do GLS přes POST /:id/gls (MyGLS podstrčené, testovací adresa)
    {
      const podatGls = najitHandler(router, 'post', '/:id/gls');
      const puvodniFetch = global.fetch;
      const puvodniEnv = { ...process.env };
      const volani = [];
      res = vytvoritRes();
      for (const k of ['GLS_CLIENT_NUMBER', 'GLS_USERNAME', 'GLS_PASSWORD', 'GLS_API_URL', 'GLS_ENABLED']) delete process.env[k];
      await podatGls({ params: { id: String(nova.id) }, body: {} }, res);
      assert.equal(res.statusCode, 503, 'bez údajů na Renderu je podání vypnuté');
      Object.assign(process.env, { GLS_CLIENT_NUMBER: '53018135', GLS_USERNAME: 'test@example.com', GLS_PASSWORD: 'x', GLS_API_URL: 'https://api.test.mygls.cz/' });
      global.fetch = async (url, o) => {
        volani.push({ url, body: o.body });
        return { status: 200, ok: true, json: async () => ({ Labels: [...Buffer.from('%PDF-1.4 gls')], PrintLabelsErrorList: [], PrintLabelsInfoList: [{ ParcelId: 777, ParcelNumber: 98765432101 }] }) };
      };
      try {
        res = vytvoritRes();
        await podatGls({ params: { id: String(nova.id) }, body: { pocet: 1 } }, res);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.zasilka.cislo_zasilky, '98765432101');
        assert.equal(res.body.zasilka.prostredi, 'test');
        assert.match(volani[0].url, /^https:\/\/api\.test\.mygls\.cz\/ParcelService\.svc\/json\/PrintLabels$/);
        assert.match(volani[0].body, /"StringValue":"39301-ELPESRO"/);
        const z = (await pool.query("SELECT stav, data, stitek_pdf FROM zasilky WHERE objednavka_id = $1 AND dopravce = 'gls'", [nova.id])).rows[0];
        assert.equal(z.stav, 'podana');
        assert.equal(z.data.parcelId, 777);
        assert.equal(z.stitek_pdf.toString(), '%PDF-1.4 gls');
        res = vytvoritRes();
        await podatGls({ params: { id: String(nova.id) }, body: {} }, res);
        assert.equal(res.statusCode, 409, 'podruhé už ne');
        assert.equal(volani.length, 1);
        // štítek z uloženého PDF, bez dalšího volání GLS
        res = vytvoritRes();
        res.setHeader = () => {}; res.send = b => { res.body = b; return res; };
        await najitHandler(router, 'get', '/:id/gls/stitek')({ params: { id: String(nova.id) } }, res);
        assert.equal(res.body.toString(), '%PDF-1.4 gls');
        assert.equal(volani.length, 1);
      } finally {
        global.fetch = puvodniFetch;
        for (const k of ['GLS_CLIENT_NUMBER', 'GLS_USERNAME', 'GLS_PASSWORD', 'GLS_API_URL', 'GLS_ENABLED']) {
          if (puvodniEnv[k] === undefined) delete process.env[k]; else process.env[k] = puvodniEnv[k];
        }
      }
    }

    // Převod objednávky na zásilku a uložení do tabulky zasilky (bez volání API)
    const data = gls.sestavitZasilku(nova, 53018135);
    assert.deepEqual(data.ServiceList, [{ Code: 'PSD', PSDParameter: { StringValue: '39301-ELPESRO' } }]);
    await pool.query('INSERT INTO zasilky (objednavka_id, dopravce, data) VALUES ($1, $2, $3)', [nova.id, 'gls', JSON.stringify(data)]);
    const zasilka = (await pool.query("SELECT stav, cislo_zasilky, data FROM zasilky WHERE objednavka_id = $1 AND stav = 'pripravena'", [nova.id])).rows[0];
    assert.equal(zasilka.stav, 'pripravena');
    assert.equal(zasilka.cislo_zasilky, null);
    assert.equal(zasilka.data.ClientReference, nova.cislo);
    // smazání objednávky smaže i její zásilky
    await pool.query('DELETE FROM objednavky_polozky WHERE objednavka_id = $1', [nova.id]);
    await pool.query('DELETE FROM objednavky WHERE id = $1', [nova.id]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM zasilky WHERE objednavka_id = $1', [nova.id])).rows[0].n, 0);
  } finally {
    console.log = puvodniLog;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('PostgreSQL: když tabulka zasilky nejde vytvořit, sloupce objednávek přesto vzniknou', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'glstest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}` });
  const logy = [];
  const puvodniLog = console.log; console.log = (...a) => logy.push(a.join(' '));
  try {
    // objednavky.id bez PRIMARY KEY -> cizí klíč ze zasilky nejde vytvořit
    await pool.query(`
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
      CREATE TABLE darkove_poukazy (id SERIAL PRIMARY KEY, kod TEXT);
      CREATE TABLE objednavky (id INTEGER, zakaznik_id INTEGER, celkem NUMERIC, doprava TEXT, platba TEXT, cislo TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
    `);
    nacistObjednavky(pool);
    assert.equal(await vsePripraveno(20000), true);
    const sloupce = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objednavky' AND column_name IN ('doprava_cena', 'dopravce', 'vydejni_misto_id')`, [schema])).rows;
    assert.equal(sloupce.length, 3);
    assert.ok(logy.some(l => l.startsWith('Zasilky chyba:')), 'chyba zásilek je zalogovaná');
    assert.ok(logy.includes('Objednavky sloupce OK'));
  } finally {
    console.log = puvodniLog;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
