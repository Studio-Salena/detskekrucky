// Kredit po vkladech, poukazy z e-shopu, „Zahodit“ přes tabulku klíčů, opravné operace
// a kontrola rozsahu - proti SKUTEČNÉMU PostgreSQL.
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

test('PostgreSQL kredit po vkladech, poukazy z e-shopu, Zahodit, opravy, zámek EET, kontrola rozsahu', { skip: preskocit }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'vklady_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 15 });
  const puvodniLog = console.log; console.log = () => {};
  const puvodniZamek = process.env.EET_ZAMEK_OD;
  delete process.env.EET_ZAMEK_OD;
  try {
    await pool.query(`
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
      CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, znacka TEXT, cena NUMERIC, na_eshopu BOOLEAN DEFAULT true, cena_pred_slevou INTEGER);
      CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost TEXT, pocet_kusu INTEGER, dostupnost TEXT DEFAULT 'skladem', UNIQUE (produkt_id, velikost));
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER REFERENCES zakaznici(id), stav TEXT DEFAULT 'nova',
        celkem NUMERIC, doprava TEXT, platba TEXT, poznamka TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER REFERENCES objednavky(id), produkt_id INTEGER, velikost TEXT, pocet INTEGER, cena NUMERIC);
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, datum TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Bota', 'Značka', 1000);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 100);
    `);
    const mocky = { '../db/pool': pool, './emaily': new Proxy({}, { get: () => async () => {} }) };
    const prodejna = nacistRouterSMocky('../routes/prodejna.js', mocky); assert.equal(await vsePripraveno(20000), true);
    // „historické“ poukazy a staré doklady vzniklé PŘED evidencí (bez platba_stav, bez vkladů)
    await pool.query(`ALTER TABLE prodejna_prodeje ALTER COLUMN datum SET DEFAULT NOW()`);
    const poukazy = nacistRouterSMocky('../routes/poukazy.js', mocky); assert.equal(await vsePripraveno(20000), true);
    await pool.query(`ALTER TABLE darkove_poukazy ALTER COLUMN platba_stav DROP DEFAULT`).catch(() => {});
    await pool.query(`INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, druh, vytvoreno, platba_stav)
      VALUES ('DK-HIST-0001', '2100000000011', 1000, 600, '2099-12-31', 'aktivni', 'eshop', 'prodej', '2026-01-10', NULL),
             ('DK-HIST-0002', '2200000000012', 500, 500, '2099-12-31', 'aktivni', 'prodejna', 'dar', '2026-01-10', NULL)`);
    await pool.query(`INSERT INTO prodejna_prodeje (platba, polozky, celkem, datum, vytvoreno) VALUES ('hotovost', '[]', 300, '2026-01-10', '2026-01-10')`);
    // migrace znovu (restart): historické poukazy se výslovně označí, NEzablokují se
    nacistRouterSMocky('../routes/poukazy.js', mocky); assert.equal(await vsePripraveno(20000), true);
    const objednavky = nacistRouterSMocky('../routes/objednavky.js', mocky); assert.equal(await vsePripraveno(20000), true);
    const karty = nacistRouterSMocky('../routes/poukazoveKarty.js', mocky); assert.equal(await vsePripraveno(20000), true);
    nacistRouterSMocky('../routes/promo.js', mocky); assert.equal(await vsePripraveno(20000), true);
    const evRouter = nacistRouterSMocky('../routes/evidencePlateb.js', mocky); assert.equal(await vsePripraveno(20000), true);
    nacistRouterSMocky('../routes/evidencePlateb.js', mocky); assert.equal(await vsePripraveno(20000), true); // 2×

    const zavolat = async (router, metoda, cesta, req = {}) => {
      const res = vytvoritRes();
      await najitHandler(router, metoda, cesta)({ params: {}, query: {}, ip: '10.3.3.' + Math.floor(Math.random() * 250), ...req }, res);
      return res;
    };
    const q = async (sql, p) => (await pool.query(sql, p)).rows;
    const kredit = require('../lib/kreditVklady');
    const ev = require('../lib/evidencePlateb');
    const poukazPodleKodu = async kod => (await q('SELECT * FROM darkove_poukazy WHERE kod = $1', [kod]))[0];
    const casti = async pohybId => (await q(`SELECT c.smer, c.castka::int, v.puvod, c.eet_pravidlo FROM kredit_casti c JOIN kredit_vklady v ON v.id = c.vklad_id
      WHERE c.kredit_pohyb_id = $1 ORDER BY c.id`, [pohybId]));
    const vklady = async poukazId => (await kredit.vkladyPoukazu(pool, poukazId)).map(v => [v.puvod, Number(v.castka), v.zbyva, v.overeni]);
    const prodat = body => zavolat(prodejna, 'post', '/', { body: { potvrdit_duplicitu: true, ...body } });
    const bota = (cena = 1000) => [{ produkt_id: 1, nazev: 'Bota', velikost: '24', pocet: 1, cena }];

    assert.deepEqual((await q("SELECT kod, stav, platba_stav FROM darkove_poukazy WHERE kod LIKE 'DK-HIST%' ORDER BY kod")).map(r => [r.kod, r.stav, r.platba_stav]),
      [['DK-HIST-0001', 'aktivni', 'historicky'], ['DK-HIST-0002', 'aktivni', 'historicky']]);

    // ── 1) smíšený kredit: pořadí čerpání, rozdělení, storno přesně stejných částí ──
    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const p = (await client.query(`INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, druh, platba_stav)
          VALUES ('DK-MIX-0001', '2100000000099', 1500, 1500, '2099-12-31', 'aktivni', 'prodejna', 'prodej', 'zaplaceno') RETURNING *`)).rows[0];
        // vklady v „náhodném“ pořadí vzniku: darovaný, zaplacený, vrácený, zaplacený
        await kredit.nabit(client, { poukaz: p, castka: 300, puvod: 'darovany', platba: null, klic: 'mix:dar' });
        await kredit.nabit(client, { poukaz: p, castka: 500, puvod: 'zaplaceny', platba: { id: null, kontaktni: true }, klic: 'mix:zapl-1' });
        await client.query(`INSERT INTO kredit_pohyby (klic, poukaz_id, typ, castka, puvod, kontaktni, zdroj_typ, zdroj_id, eet_pravidlo) VALUES ('mix:vr', $1, 'pripsani', 200, 'vraceny', true, 'poukaz', $1, 'cerp_zuct')`, [p.id]);
        const pv = (await client.query("SELECT id FROM kredit_pohyby WHERE klic = 'mix:vr'")).rows[0];
        await client.query(`INSERT INTO kredit_vklady (klic, poukaz_id, puvod, castka, eet_zaklad, overeni, kredit_pohyb_id) VALUES ('vklad:mix:vr', $1, 'vraceny', 200, 'zaplaceny', 'doklad', $2)`, [p.id, pv.id]);
        await kredit.nabit(client, { poukaz: p, castka: 500, puvod: 'zaplaceny', platba: { id: null, kontaktni: true }, klic: 'mix:zapl-2' });
        assert.deepEqual((await kredit.vkladyPoukazu(client, p.id)).map(v => v.puvod + ':' + Number(v.castka)),
          ['zaplaceny:500', 'zaplaceny:500', 'vraceny:200', 'darovany:300'], 'pořadí: zaplacený (od nejstaršího) → vrácený → převedený → darovaný');
        // čerpání 1250 = 500 + 500 + 200 + 50 z daru
        const c1 = await kredit.cerpat(client, { poukaz: p, castka: 1250, klic: 'mix:cerpani-1', zdroj_typ: 'prodej', zdroj_id: null, kontaktni: true });
        assert.deepEqual(await (async () => (await client.query(`SELECT c.smer, c.castka::int, v.puvod, c.eet_pravidlo FROM kredit_casti c JOIN kredit_vklady v ON v.id = c.vklad_id WHERE c.kredit_pohyb_id = $1 ORDER BY c.id`, [c1.id])).rows)(),
          [{ smer: 'odber', castka: 500, puvod: 'zaplaceny', eet_pravidlo: 'cerp_zuct' }, { smer: 'odber', castka: 500, puvod: 'zaplaceny', eet_pravidlo: 'cerp_zuct' },
           { smer: 'odber', castka: 200, puvod: 'vraceny', eet_pravidlo: 'cerp_zuct' }, { smer: 'odber', castka: 50, puvod: 'darovany', eet_pravidlo: 'nevyreseno' }]);
        assert.deepEqual([c1.puvod, c1.eet_pravidlo], ['smiseny', 'nevyreseno'], 'smíšené čerpání s darem: celek nevyřešený, části dohledatelné');
        // stejný klíč podruhé = nic nového
        assert.equal((await kredit.cerpat(client, { poukaz: p, castka: 1250, klic: 'mix:cerpani-1', zdroj_typ: 'prodej', zdroj_id: null, kontaktni: true })).id, c1.id);
        // storno vrátí přesně stejné části
        const s1 = await kredit.stornovat(client, c1, { klic: 'mix:storno-1', zdroj_typ: 'prodej', zdroj_id: null });
        assert.deepEqual((await client.query(`SELECT c.smer, c.castka::int, v.puvod FROM kredit_casti c JOIN kredit_vklady v ON v.id = c.vklad_id WHERE c.kredit_pohyb_id = $1 ORDER BY c.id`, [s1.id])).rows.map(r => r.smer + ':' + r.castka + ':' + r.puvod),
          ['vraceni:500:zaplaceny', 'vraceni:500:zaplaceny', 'vraceni:200:vraceny', 'vraceni:50:darovany']);
        assert.deepEqual((await kredit.vkladyPoukazu(client, p.id)).map(v => v.zbyva), [500, 500, 200, 300], 'zůstatky vkladů jako před čerpáním');
        // druhé storno téhož čerpání nejde (unikátní index → 409)
        await client.query('SAVEPOINT s');
        await assert.rejects(kredit.stornovat(client, c1, { klic: 'mix:storno-2', zdroj_typ: 'prodej', zdroj_id: null }), e => e.status === 409);
        await client.query('ROLLBACK TO SAVEPOINT s');
        // čerpání víc, než pokrývají vklady → odmítnuto (evidence nesedí)
        await client.query('SAVEPOINT s2');
        await assert.rejects(kredit.cerpat(client, { poukaz: p, castka: 1600, klic: 'mix:moc', zdroj_typ: 'prodej', zdroj_id: null, kontaktni: true }), e => e.status === 409);
        await client.query('ROLLBACK TO SAVEPOINT s2');
        // storno nabití: jen nečerpaný vklad
        const dar = (await client.query("SELECT * FROM kredit_pohyby WHERE klic = 'mix:dar'")).rows[0];
        await kredit.stornovat(client, dar, { klic: 'mix:storno-dar', zdroj_typ: 'poukaz', zdroj_id: p.id });
        // zůstatek poukazu podle scénáře (500 + 500 + 200; dar stornován)
        await client.query('UPDATE darkove_poukazy SET zustatek = 1200 WHERE id = $1', [p.id]);
        await client.query('COMMIT');
      } finally { client.release(); }
    }

    // ── 1b) souběžné storno téhož čerpání ze dvou spojení: projde právě jedno ──
    {
      const p = (await q(`INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, druh, platba_stav)
        VALUES ('DK-SOUBEH-01', '2100000000098', 400, 400, '2099-12-31', 'aktivni', 'prodejna', 'prodej', 'zaplaceno') RETURNING *`))[0];
      const c = await pool.connect();
      await c.query('BEGIN');
      await kredit.nabit(c, { poukaz: p, castka: 400, puvod: 'zaplaceny', platba: null, klic: 'soubeh:nabiti' });
      const cer = await kredit.cerpat(c, { poukaz: p, castka: 300, klic: 'soubeh:cerpani', zdroj_typ: 'prodej', zdroj_id: null, kontaktni: true });
      await c.query('COMMIT'); c.release();
      const zkusit = async i => {
        const k = await pool.connect();
        try { await k.query('BEGIN'); await kredit.stornovat(k, cer, { klic: 'soubeh:storno-' + i, zdroj_typ: 'prodej', zdroj_id: null }); await k.query('COMMIT'); return 'ok'; }
        catch (e) { await k.query('ROLLBACK'); return e.status || e.message; } finally { k.release(); }
      };
      const vysl = await Promise.all([1, 2, 3].map(zkusit));
      assert.equal(vysl.filter(x => x === 'ok').length, 1, JSON.stringify(vysl));
      assert.ok(vysl.filter(x => x !== 'ok').every(x => x === 409), JSON.stringify(vysl));
      assert.deepEqual((await kredit.vkladyPoukazu(pool, p.id)).map(v => v.zbyva), [400]);
    }

    // ── 2) převod poukazu mezi kartami nemění původ ani vklady ──
    await q(`INSERT INTO poukazove_karty (cislo, ean) VALUES ('DK-26-00001', '2300000000017'), ('DK-26-00002', '2300000000024')`);
    let res = await zavolat(poukazy, 'post', '/', { body: { klic: 'karta-nabiti-1', karta_ean: '2300000000017', hodnota: 800, platba: 'hotovost', zakoupeno_kde: 'prodejna' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const naKarte = res.body;
    const pred = await vklady(naKarte.id);
    const karta1 = (await q("SELECT id FROM poukazove_karty WHERE cislo = 'DK-26-00001'"))[0].id;
    res = await zavolat(karty, 'post', '/:id/prevest', { params: { id: String(karta1) }, body: { na: '2300000000024' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(await vklady(naKarte.id), pred, 'vklady a původ beze změny');
    res = await prodat({ klic: 'po-prevodu-1', platba: 'poukaz', poukaz_kod: '2300000000024', polozky: bota(300) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const cerKarta = (await q("SELECT id FROM kredit_pohyby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1 AND typ = 'cerpani'", [res.body.id]))[0];
    assert.deepEqual(await casti(cerKarta.id), [{ smer: 'odber', castka: 300, puvod: 'zaplaceny', eet_pravidlo: 'cerp_zuct' }]);

    // ── 3) historický poukaz: použitelný, počáteční stav bez vymyšlené platby ──
    const platebPred = Number((await q('SELECT COUNT(*) n FROM platby'))[0].n);
    res = await prodat({ klic: 'historicky-1', platba: 'poukaz', poukaz_kod: 'DK-HIST-0001', polozky: bota(200) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const hist = await poukazPodleKodu('DK-HIST-0001');
    assert.deepEqual(await vklady(hist.id), [['zaplaceny', 600, 400, 'pocatecni_stav']], 'počáteční stav = zůstatek 600, ne hodnota 1000');
    assert.equal(Number((await q('SELECT COUNT(*) n FROM platby'))[0].n), platebPred, 'žádná vymyšlená platba');
    res = await prodat({ klic: 'historicky-dar', platba: 'poukaz', poukaz_kod: 'DK-HIST-0002', polozky: bota(100) });
    const cerDar = (await q("SELECT eet_pravidlo FROM kredit_pohyby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1 AND typ = 'cerpani'", [res.body.id]))[0];
    assert.equal(cerDar.eet_pravidlo, 'nevyreseno', 'darovaný kredit zůstává výslovně nevyřešený');

    // ── 4) poukaz z e-shopu: žádost → platba → aktivace ──
    res = await zavolat(poukazy, 'post', '/', { body: { klic: 'eshop-poukaz-1', hodnota: 500, zakoupeno_kde: 'eshop', kupujici_email: 'jana@example.com' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const eshopP = res.body;
    assert.deepEqual([eshopP.stav, eshopP.platba_stav], ['ceka_na_platbu', 'ceka']);
    assert.equal(Number((await q('SELECT COUNT(*) n FROM kredit_vklady WHERE poukaz_id = $1', [eshopP.id]))[0].n), 0, 'bez platby žádný kredit');
    assert.equal((await zavolat(poukazy, 'get', '/overit/:kod', { params: { kod: eshopP.kod } })).statusCode, 400);
    res = await prodat({ klic: 'nezaplaceny-poukaz', platba: 'poukaz', poukaz_kod: eshopP.kod, polozky: bota(100) });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /není zaplacený/);
    assert.equal((await zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(eshopP.id) }, body: { castka: 100 } })).statusCode, 409);
    assert.equal((await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(eshopP.id) }, body: { klic: 'ep-castecne', zpusob: 'prevod', castka: 200 } })).statusCode, 400, 'částečná úhrada odmítnuta');
    // volná platba (převod 800 Kč): 3× stejný klíč souběžně = jedno přiřazení
    const volna = (await zavolat(evRouter, 'post', '/volna', { body: { klic: 'volna-800', zpusob: 'prevod', castka: 800 } })).body;
    const tri = await Promise.all([1, 2, 3].map(() => zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(eshopP.id) }, body: { klic: 'ep-prirazeni-1', platba_id: volna.id } })));
    assert.ok(tri.every(r => r.statusCode === 200), JSON.stringify(tri.map(r => r.body)));
    assert.equal(Number((await q('SELECT COUNT(*) n FROM platby_prirazeni WHERE poukaz_id = $1', [eshopP.id]))[0].n), 1);
    const aktivni = await poukazPodleKodu(eshopP.kod);
    assert.deepEqual([aktivni.stav, aktivni.platba_stav], ['aktivni', 'zaplaceno']);
    assert.deepEqual(await vklady(eshopP.id), [['zaplaceny', 500, 500, 'doklad']]);
    assert.equal((await q("SELECT eet_pravidlo FROM kredit_pohyby WHERE poukaz_id = $1 AND typ = 'nabiti'", [eshopP.id]))[0].eet_pravidlo, 'neeviduje', 'převodem = nekontaktní');
    assert.equal(Number((await q("SELECT COUNT(*) n FROM platby WHERE typ = 'prijem' AND zdroj_typ IN ('poukaz', 'volna')"))[0].n), 1, 'příjem jen jednou (volná platba)');
    // druhá platba za stejný poukaz nejde; zbytek volné platby (300) nepokryje poukaz 500
    assert.equal((await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(eshopP.id) }, body: { klic: 'ep-znovu', zpusob: 'hotovost' } })).statusCode, 409);
    const eshop2 = (await zavolat(poukazy, 'post', '/', { body: { klic: 'eshop-poukaz-2', hodnota: 500, zakoupeno_kde: 'eshop' } })).body;
    res = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(eshop2.id) }, body: { klic: 'ep-zbytek', platba_id: volna.id } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.chyba, /zbývá k přiřazení jen 300/);
    res = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(eshop2.id) }, body: { klic: 'ep-hotove', zpusob: 'hotovost' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal((await q("SELECT eet_pravidlo FROM kredit_pohyby WHERE poukaz_id = $1 AND typ = 'nabiti'", [eshop2.id]))[0].eet_pravidlo, 'urceno_cerp_zuct');
    // zaplacený e-shopový poukaz nejde přeznačit na dar ani smazat (jen zrušit)
    assert.equal((await zavolat(poukazy, 'patch', '/:id/dar', { params: { id: String(eshop2.id) } })).statusCode, 409);
    res = await zavolat(poukazy, 'delete', '/:id', { params: { id: String(eshop2.id) } });
    assert.deepEqual([res.statusCode, res.body.smazano], [200, false]);

    // ── 5) Zahodit: tabulka klíčů platí i po „restartu“ (nová instance routy) a bez časového okna ──
    res = await zavolat(prodejna, 'post', '/nedokonceny/:klic/zahodit', { params: { klic: 'zahozeny-klic-1' } });
    assert.equal(res.body.stav, 'zahozeny');
    const prodejna2 = nacistRouterSMocky('../routes/prodejna.js', mocky); assert.equal(await vsePripraveno(20000), true);
    res = await zavolat(prodejna2, 'post', '/', { body: { klic: 'zahozeny-klic-1', platba: 'karta', polozky: bota(111), potvrdit_duplicitu: true } });
    assert.deepEqual([res.statusCode, res.body.zahozeno], [409, true], 'pozdní uložení po restartu odmítnuto');
    await q("UPDATE prodejna_prodeje SET datum = datum - interval '2 days' WHERE id IN (SELECT prodej_id FROM prodejna_klice)");
    res = await zavolat(prodejna2, 'post', '/', { body: { klic: 'po-prevodu-1', platba: 'poukaz', poukaz_kod: '2300000000024', polozky: bota(300), potvrdit_duplicitu: true } });
    assert.deepEqual([res.statusCode, res.body.opakovane], [200, true], 'uložený prodej se pozná i po dnech (mimo 30min okno)');
    res = await prodat({ klic: 'smazat-klic-1', platba: 'karta', polozky: bota(222) });
    { const d = await zavolat(prodejna, 'delete', '/:id', { params: { id: String(res.body.id) } }); assert.equal(d.statusCode, 200, JSON.stringify(d.body)); }
    res = await prodat({ klic: 'smazat-klic-1', platba: 'karta', polozky: bota(222) });
    assert.equal(res.statusCode, 409, 'smazaný prodej se pod stejným klíčem znovu neuloží');
    assert.equal((await zavolat(prodejna, 'post', '/nedokonceny/:klic/zahodit', { params: { klic: 'smazat-klic-1' } })).body.stav, 'smazany');

    // ── 6) opravné operace: peníze ani kredit nejde vrátit dvakrát ──
    res = await prodat({ klic: 'vratka-cap-1', platba: 'karta', polozky: [{ produkt_id: 1, nazev: 'Bota', velikost: '24', pocet: 2, cena: 500 }] });
    const capProdej = res.body;
    const vratit = (klic, castka) => zavolat(prodejna, 'post', '/vratky', { body: { klic, prodej_id: capProdej.id, polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }], castka, zpusob_vraceni: 'karta' } });
    const souběh = await Promise.all([vratit('vratka-cap-a', 700), vratit('vratka-cap-b', 700)]);
    assert.deepEqual(souběh.map(r => r.statusCode).sort(), [200, 400], 'souběžné vratky nepřekročí přijaté peníze: ' + JSON.stringify(souběh.map(r => r.body)));
    assert.equal((await vratit('vratka-cap-c', 400)).statusCode, 400, 'zbývá jen 300');
    assert.equal((await vratit('vratka-cap-d', 300)).statusCode, 200);
    // účtenka placená jen poukazem: penězi nic, připsat na poukaz jen do čerpané částky
    res = await prodat({ klic: 'jen-poukaz-1', platba: 'poukaz', poukaz_kod: '2300000000024', polozky: bota(200) });
    const poukazemProdej = res.body;
    res = await zavolat(prodejna, 'post', '/vratky', { body: { klic: 'vratka-pk-penize', prodej_id: poukazemProdej.id, polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }], castka: 200, zpusob_vraceni: 'hotovost' } });
    assert.equal(res.statusCode, 400);
    res = await zavolat(prodejna, 'post', '/vratky', { body: { klic: 'vratka-pk-vymena', prodej_id: poukazemProdej.id, polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }], castka: 0 } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const vratkaPk = res.body.id;
    assert.equal((await zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(naKarte.id) }, body: { klic: 'pripsat-moc', castka: 250, vratka_id: vratkaPk } })).statusCode, 400);
    res = await zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(naKarte.id) }, body: { klic: 'pripsat-ok1', castka: 200, vratka_id: vratkaPk } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal((await zavolat(poukazy, 'post', '/:id/pripsat', { params: { id: String(naKarte.id) }, body: { klic: 'pripsat-znovu', castka: 1, vratka_id: vratkaPk } })).statusCode, 400, 'k vratce už nic');
    assert.deepEqual((await q("SELECT puvod, eet_zaklad FROM kredit_vklady WHERE poukaz_id = $1 AND puvod = 'vraceny'", [naKarte.id])), [{ puvod: 'vraceny', eet_zaklad: 'zaplaceny' }]);
    // souběžné storno příjmu dvěma různými operacemi (změna platby × smazání): jen jedno
    res = await prodat({ klic: 'storno-soubeh-1', platba: 'hotovost', polozky: bota(333) });
    const sp = res.body;
    const ops = await Promise.all([
      zavolat(prodejna, 'put', '/:id', { params: { id: String(sp.id) }, body: { platba: 'karta' } }),
      zavolat(prodejna, 'delete', '/:id', { params: { id: String(sp.id) } })]);
    const storna = Number((await q("SELECT COUNT(*) n FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1 AND typ = 'storno_prijmu'", [sp.id]))[0].n);
    const prijmy = Number((await q("SELECT COUNT(*) n FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = $1 AND typ = 'prijem'", [sp.id]))[0].n);
    assert.ok(ops.some(r => r.statusCode === 200), JSON.stringify(ops.map(r => r.body)));
    assert.equal(storna, prijmy - (await q('SELECT 1 FROM prodejna_prodeje WHERE id = $1', [sp.id])).length, 'každý příjem nejvýš jedno storno, žádný zůstatek navíc');

    // ── 7) příprava zámku EET: destruktivní změny dokladů od data zámku odmítnuty ──
    res = await prodat({ klic: 'zamek-prodej-1', platba: 'hotovost', polozky: bota(150) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const zamceny = res.body;
    process.env.EET_ZAMEK_OD = '2026-01-01';
    try {
      assert.equal((await zavolat(prodejna, 'delete', '/:id', { params: { id: String(zamceny.id) } })).statusCode, 409);
      assert.equal((await zavolat(prodejna, 'put', '/:id', { params: { id: String(zamceny.id) }, body: { platba: 'karta' } })).statusCode, 409);
      assert.equal((await zavolat(prodejna, 'put', '/:id', { params: { id: String(zamceny.id) }, body: { platba: 'hotovost', poznamka: 'jen poznámka' } })).statusCode, 200, 'nefinanční údaje jde upravit');
      const pz = (await zavolat(poukazy, 'post', '/', { body: { klic: 'zamek-poukaz', hodnota: 500, platba: 'karta', zakoupeno_kde: 'prodejna' } })).body;
      assert.equal((await zavolat(poukazy, 'patch', '/:id/dar', { params: { id: String(pz.id) } })).statusCode, 409);
      assert.equal((await zavolat(poukazy, 'delete', '/:id', { params: { id: String(pz.id) } })).statusCode, 409);
    } finally { delete process.env.EET_ZAMEK_OD; }

    // ── 8) kontrola: v rozsahu bez rozdílů, starší doklady MIMO ROZSAH (ne spárované) ──
    const k = await zavolat(evRouter, 'get', '/kontrola');
    assert.equal(k.statusCode, 200);
    assert.deepEqual(k.body.rozdily, [], JSON.stringify(k.body.rozdily));
    assert.equal(k.body.mimo_rozsah.prodeje, 1, 'starý prodej z ledna mimo rozsah');
    assert.equal(k.body.mimo_rozsah.poukazy, 0, 'historické poukazy po použití mají počáteční stav → v rozsahu');
    assert.ok(k.body.v_rozsahu.poukazy >= 6);
    assert.equal(k.body.ceka_na_platbu, 0);
    // umělý rozdíl ve vkladech se najde
    const pk = await poukazPodleKodu('DK-HIST-0002');
    await q('UPDATE darkove_poukazy SET zustatek = zustatek + 5 WHERE id = $1', [pk.id]);
    const k2 = await zavolat(evRouter, 'get', '/kontrola');
    assert.ok(k2.body.rozdily.some(r => r.doklad === 'poukaz DK-HIST-0002' && /vkladům/.test(r.co)), JSON.stringify(k2.body.rozdily));
    await q('UPDATE darkove_poukazy SET zustatek = zustatek - 5 WHERE id = $1', [pk.id]);
    assert.ok(ev);
  } finally {
    console.log = puvodniLog;
    if (puvodniZamek !== undefined) process.env.EET_ZAMEK_OD = puvodniZamek;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
