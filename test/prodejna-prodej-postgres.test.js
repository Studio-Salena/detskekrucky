// Prodej v pokladně proti SKUTEČNÉMU PostgreSQL (lib/prodejPokladna.js):
// skutečné migrace (2×), souběžné požadavky a ROLLBACK uprostřed zápisu.
//   - stejný klíč odeslaný 5× najednou (výpadek / dvojklik) = 1 prodej
//   - poslední kus na skladě a jeden poukaz pod souběhem = žádný přeprodej
//   - chyba po zápisu účtenky vrátí všechno (sklad, poukaz, kód, účtenka)
//   - slevový kód + celý nákup poukazem v jedné transakci
//   - vratka k nové účtence a účetní součty, ochrana mazání
//
// Spouští se jen s TEST_PG_URL (dočasná testová databáze, NIKDY produkce).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
const { vsePripraveno } = require('../lib/startServeru');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';

test('PostgreSQL pokladna: jedna transakce, ochrana před dvojím prodejem, souběh, vratka', { skip: preskocit }, async (t) => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'pokladna_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 12 });
  const puvodniLog = console.log; console.log = () => {};
  try {
    await pool.query(`
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT);
      CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, cena NUMERIC, cena_pred_slevou INTEGER);
      CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost TEXT, pocet_kusu INTEGER, UNIQUE (produkt_id, velikost));
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, datum TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, stav TEXT DEFAULT 'nova');
      CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER, produkt_id INTEGER, velikost TEXT, pocet INTEGER);
      CREATE TABLE poukazove_karty (id SERIAL PRIMARY KEY, cislo TEXT, ean TEXT, zablokovana BOOLEAN DEFAULT false, aktualni_poukaz_id INTEGER);
      CREATE TABLE darkove_poukazy (id SERIAL PRIMARY KEY, kod TEXT, ean TEXT, hodnota NUMERIC, zustatek NUMERIC, stav TEXT, platnost_do DATE, karta_id INTEGER);
      CREATE TABLE poukazy_pouziti (id SERIAL PRIMARY KEY, poukaz_id INTEGER, castka NUMERIC, objednavka_id INTEGER, prodej_id INTEGER);
      CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
      INSERT INTO produkty (nazev, cena) VALUES ('Zimní bota', 1200), ('Sandál', 800), ('Poslední kus', 1000);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 10), (2, '24.5', 10), (3, '30', 1);
      INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, stav, platnost_do) VALUES
        ('DK-AAAA-0001', '2200000000001', 1000, 1000, 'aktivni', '2099-12-31'),
        ('DK-AAAA-0002', '2200000000002', 5000, 5000, 'aktivni', '2099-12-31'),
        ('DK-AAAA-0003', '2200000000003', 3000, 3000, 'aktivni', '2099-12-31');
    `);
    // migrace dvakrát (musí jít spustit opakovaně)
    nacistRouterSMocky('../routes/prodejna.js', { '../db/pool': pool });
    const prodejna = nacistRouterSMocky('../routes/prodejna.js', { '../db/pool': pool });
    nacistRouterSMocky('../routes/promo.js', { '../db/pool': pool });
    assert.equal(await vsePripraveno(20000), true);
    await require('../lib/evidencePlateb').migrovat(pool); // evidence plateb (routes/evidencePlateb.js)

    const zavolat = async (metoda, cesta, req) => { const res = vytvoritRes(); await najitHandler(prodejna, metoda, cesta)({ params: {}, ...req }, res); return res; };
    const prodat = body => zavolat('post', '/', { body });
    const kusu = async (id, vel) => (await pool.query('SELECT pocet_kusu FROM sklad WHERE produkt_id = $1 AND velikost = $2', [id, vel])).rows[0].pocet_kusu;
    const pocet = async (tab, kde = 'TRUE') => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${tab} WHERE ${kde}`)).rows[0].n;
    const poukaz = async kod => (await pool.query('SELECT zustatek, stav FROM darkove_poukazy WHERE kod = $1', [kod])).rows[0];
    const bota = (pocetKusu = 1) => [{ produkt_id: 1, nazev: 'Zimní bota', velikost: 24, pocet: pocetKusu, cena: 1200 }];

    // 1) stejný klíč 5× souběžně (dvojklik / opakování po výpadku) = jeden prodej
    const body = { klic: 'souběh-klic-1'.replace(/[^\w-]/g, ''), platba: 'hotovost', hotovost_prijato: 2000, celkem: 1200, polozky: bota() };
    const vysledky = await Promise.all([1, 2, 3, 4, 5].map(() => prodat(body)));
    assert.deepEqual(vysledky.map(r => r.statusCode), [200, 200, 200, 200, 200], JSON.stringify(vysledky.map(r => r.body)));
    assert.equal(new Set(vysledky.map(r => r.body.id)).size, 1, 'všechny odpovědi = stejná účtenka');
    assert.equal(vysledky.filter(r => r.body.opakovane).length, 4);
    assert.equal(await pocet('prodejna_prodeje'), 1);
    assert.equal(await kusu(1, '24'), 9, 'sklad odečtený jednou');
    assert.equal(await pocet('pohyby_skladu'), 1);
    const prvni = vysledky[0].body;
    assert.deepEqual([Number(prvni.celkem), Number(prvni.hotovost_prijato), Number(prvni.hotovost_vraceno), prvni.platba], [1200, 2000, 800, 'hotovost']);

    // 2) poslední kus: 5 různých prodejů souběžně, projde jen jeden, sklad nejde do minusu
    const posledni = await Promise.all([1, 2, 3, 4, 5].map(i => prodat({ klic: 'posledni-kus-' + i, potvrdit_duplicitu: true, platba: 'karta', polozky: [{ produkt_id: 3, nazev: 'Poslední kus', velikost: '30', pocet: 1, cena: 1000 }] })));
    assert.equal(posledni.filter(r => r.statusCode === 200).length, 1);
    assert.equal(posledni.filter(r => r.statusCode === 400).length, 4);
    assert.equal(await kusu(3, '30'), 0);

    // 3) jeden poukaz 1000 Kč, tři souběžné nákupy po 600 Kč celým poukazem: projde jen jeden
    const sandal = [{ produkt_id: 2, nazev: 'Sandál', velikost: '24.5', pocet: 1, cena: 600 }];
    const poukazem = await Promise.all([1, 2, 3].map(i => prodat({ klic: 'poukaz-soubeh-' + i, potvrdit_duplicitu: true, platba: 'poukaz', poukaz_kod: 'DK-AAAA-0001', celkem: 600, polozky: sandal })));
    assert.equal(poukazem.filter(r => r.statusCode === 200).length, 1, JSON.stringify(poukazem.map(r => r.body)));
    assert.deepEqual(await poukaz('DK-AAAA-0001'), { zustatek: '400', stav: 'aktivni' });
    assert.equal(Number((await pool.query('SELECT SUM(castka) AS s FROM poukazy_pouziti WHERE poukaz_id = 1')).rows[0].s), 600);
    assert.equal(await kusu(2, '24.5'), 9, 'velikost 24.5 jako text, odečteno jen za úspěšný prodej');

    // 4) chyba až po zápisu účtenky (trigger na pohybech skladu): ROLLBACK vrátí všechno
    await pool.query(`CREATE FUNCTION selhat() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulovaný výpadek'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER selhat BEFORE INSERT ON pohyby_skladu FOR EACH ROW WHEN (NEW.produkt_id = 1) EXECUTE FUNCTION selhat();`);
    const prodejuPred = await pocet('prodejna_prodeje');
    const vypadek = await prodat({ klic: 'vypadek-1', platba: 'poukaz', poukaz_kod: 'DK-AAAA-0002', celkem: 2400, polozky: bota(2) });
    assert.equal(vypadek.statusCode, 500);
    assert.equal(await pocet('prodejna_prodeje'), prodejuPred, 'účtenka se neuložila');
    assert.equal(await kusu(1, '24'), 9, 'sklad beze změny');
    assert.deepEqual(await poukaz('DK-AAAA-0002'), { zustatek: '5000', stav: 'aktivni' }, 'poukaz nečerpán');
    await pool.query('DROP TRIGGER selhat ON pohyby_skladu');
    // po obnovení spojení: stejný klíč projde a prodej vznikne jednou
    const znovu = await prodat({ klic: 'vypadek-1', platba: 'poukaz', poukaz_kod: 'DK-AAAA-0002', celkem: 2400, polozky: bota(2) });
    assert.equal(znovu.statusCode, 200, JSON.stringify(znovu.body));
    assert.equal(znovu.body.opakovane, undefined);
    assert.deepEqual(await poukaz('DK-AAAA-0002'), { zustatek: '2600', stav: 'aktivni' });

    // 5) slevový kód + celý nákup poukazem v jedné transakci (akce KRUCKY2026, 1. 12. 2026)
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-01T10:00:00Z') });
    const sKodem = await prodat({ klic: 'kod-poukaz-1', platba: 'poukaz', poukaz_kod: '2200000000003', promo_kod: 'KRUCKY2026', celkem: 1080, polozky: bota() });
    assert.equal(sKodem.statusCode, 200, JSON.stringify(sKodem.body));
    assert.deepEqual([Number(sKodem.body.mezisoucet), Number(sKodem.body.sleva), Number(sKodem.body.celkem), sKodem.body.platba], [1200, 120, 1080, 'poukaz']);
    assert.deepEqual(await poukaz('DK-AAAA-0003'), { zustatek: '1920', stav: 'aktivni' });
    assert.equal(await pocet('promo_pouziti', `prodej_id = ${sKodem.body.id} AND uvolneno IS NULL`), 1);
    // kód + doplatek nejde - a nic z toho se nezapíše
    const kodDoplatek = await prodat({ klic: 'kod-doplatek-1', platba: 'poukaz', poukaz_kod: '2200000000003', doplatek_platba: 'karta', promo_kod: 'KRUCKY2026', celkem: 2160, polozky: bota(2) });
    assert.equal(kodDoplatek.statusCode, 400);
    assert.deepEqual(await poukaz('DK-AAAA-0003'), { zustatek: '1920', stav: 'aktivni' });
    assert.equal(await pocet('promo_pouziti'), 1);
    t.mock.timers.reset();

    // 6) vratka k nové účtence (velikost uložená jako text) a účetní součty
    let res = await zavolat('post', '/vratky', { body: { prodej_id: prvni.id, polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }], castka: 1200, zpusob_vraceni: 'hotovost' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    res = await zavolat('post', '/vratky', { body: { prodej_id: prvni.id, polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }], castka: 1200, zpusob_vraceni: 'hotovost' } });
    assert.equal(res.statusCode, 400, 'druhá vratka stejného kusu neprojde');
    const soucty = (await pool.query(`SELECT
      (SELECT SUM(celkem) FROM prodejna_prodeje) AS prodeje,
      (SELECT SUM(celkem) FROM prodejna_prodeje WHERE platba = 'poukaz') AS poukazem,
      (SELECT SUM(castka) FROM vratky) AS vratky`)).rows[0];
    // prodeje: 1200 hotově + 1000 kartou + 600 + 2400 + 1080 poukazem; čistý příjem = celkem − poukazem − vratky
    assert.deepEqual([Number(soucty.prodeje), Number(soucty.poukazem), Number(soucty.vratky)], [6280, 4080, 1200]);
    assert.equal(Number(soucty.prodeje) - Number(soucty.poukazem) - Number(soucty.vratky), 1000);

    // 7) mazání: účtenka s vratkou ani placená poukazem nejde; běžná ano a uvolní kód
    assert.equal((await zavolat('delete', '/:id', { params: { id: String(prvni.id) } })).statusCode, 409);
    assert.equal((await zavolat('delete', '/:id', { params: { id: String(sKodem.body.id) } })).statusCode, 409);
    const karta = posledni.find(r => r.statusCode === 200).body;
    assert.equal((await zavolat('delete', '/:id', { params: { id: String(karta.id) } })).statusCode, 200);
    assert.equal(await pocet('prodejna_prodeje', `id = ${karta.id}`), 0);

    // 8) staré okno administrace (admin.html před opravou): přesná posloupnost
    //    jeho požadavků - odečet skladu po položkách s poznámkou „Prodej
    //    v prodejně“, pak POST prodeje bez klíče. Nic z toho nesmí nic zapsat.
    const sklad = nacistRouterSMocky('../routes/sklad.js', { '../db/pool': pool });
    assert.equal(await vsePripraveno(20000), true);
    const snimek = async () => (await pool.query(`SELECT
      (SELECT json_agg(s ORDER BY id) FROM (SELECT id, pocet_kusu FROM sklad) s) AS sklad,
      (SELECT COUNT(*) FROM pohyby_skladu) AS pohyby, (SELECT COUNT(*) FROM prodejna_prodeje) AS prodeje,
      (SELECT json_agg(p ORDER BY id) FROM (SELECT id, zustatek FROM darkove_poukazy) p) AS poukazy,
      (SELECT COUNT(*) FROM poukazy_pouziti) AS pouziti`)).rows[0];
    const pred = await snimek();
    const stare = [];
    for (const p of [{ produkt_id: 1, velikost: 24, pocet: 1 }, { produkt_id: 2, velikost: 24, pocet: 1 }]) {
      const r = vytvoritRes();
      await najitHandler(sklad, 'post', '/odecist')({ params: {}, body: { ...p, poznamka: 'Prodej v prodejně' } }, r);
      stare.push(r.statusCode);
    }
    res = await prodat({ zakaznik: '', platba: 'hotovost', poznamka: '', celkem: 2000, mezisoucet: 2000, sleva: 0,
      polozky: [{ produkt_id: 1, nazev: 'Zimní bota', velikost: 24, pocet: 1, cena: 1200 }, { produkt_id: 2, nazev: 'Sandál', velikost: 24, pocet: 1, cena: 800 }] });
    stare.push(res.statusCode);
    assert.deepEqual(stare, [409, 409, 409], 'starý odečet i starý prodej odmítnuté');
    assert.deepEqual(await snimek(), pred, 'po starém postupu nezůstal žádný odečet skladu, prodej ani čerpání');

    // 8b) „Zahodit“ souběžně s pozdě doručeným původním požadavkem: vždy právě jeden výsledek
    for (let i = 0; i < 6; i++) {
      const body = { klic: 'zahodit-soubeh-' + i, potvrdit_duplicitu: true, platba: 'karta', polozky: [{ produkt_id: 2, nazev: 'Sandál', velikost: '24.5', pocet: 1, cena: 600 }] };
      const [p, z] = await Promise.all([prodat(body), zavolat('post', '/nedokonceny/:klic/zahodit', { params: { klic: body.klic } })]);
      const ulozeno = await pocet('prodejna_prodeje', `klic = '${body.klic}'`);
      if (z.body.stav === 'ulozeny') {
        assert.deepEqual([p.statusCode, ulozeno, z.body.prodej.id], [200, 1, p.body.id], 'uloženo → Zahodit vrátí tutéž účtenku');
      } else {
        assert.equal(z.body.stav, 'zahozeny');
        assert.deepEqual([p.statusCode, p.body.zahozeno, ulozeno], [409, true, 0], 'zahozeno → pozdní požadavek nic neuloží');
      }
    }
    // 8c) ztracená odpověď → Zahodit (prodej se uložil) → stejný nákup zadaný znovu: druhý prodej nevznikne
    const nakup = { klic: 'ztracena-odpoved-1', platba: 'karta', polozky: [{ produkt_id: 1, nazev: 'Zimní bota', velikost: '24', pocet: 1, cena: 999 }] };
    assert.equal((await prodat(nakup)).statusCode, 200);
    const zahodit = await zavolat('post', '/nedokonceny/:klic/zahodit', { params: { klic: nakup.klic } });
    assert.equal(zahodit.body.stav, 'ulozeny');
    const znovuZadany = await prodat({ ...nakup, klic: 'ztracena-odpoved-2' });
    assert.deepEqual([znovuZadany.statusCode, znovuZadany.body.mozna_duplicita, znovuZadany.body.ulozeny_prodej_id], [409, true, zahodit.body.prodej.id]);
    assert.equal(await pocet('prodejna_prodeje', 'celkem = 999'), 1, 'jediný prodej');

    // 9) unikátní index klíče drží i mimo aplikační zámek
    await assert.rejects(pool.query("INSERT INTO prodejna_prodeje (polozky, celkem, klic) VALUES ('[]', 0, 'vypadek-1')"), /prodejna_prodeje_klic_uq/);
  } finally {
    console.log = puvodniLog;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
