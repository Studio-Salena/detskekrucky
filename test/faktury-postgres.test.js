// Neměnné faktury proti SKUTEČNÉMU PostgreSQL (triggery, souběh, atomicita,
// migrace) - mock to věrně neověří. Jen s TEST_PG_URL (dočasná testovací DB,
// nikdy produkce); každý běh ve vlastním schématu, které na konci smaže.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrovatFaktury, vystavitFakturu, otisk } = require('../lib/vystaveniFaktury');

const URL_DB = process.env.TEST_PG_URL;
const preskocit = URL_DB ? false : 'TEST_PG_URL není nastavená - test proti PostgreSQL se přeskakuje';
const TED = new Date('2026-10-27T10:00:00+01:00');

// Tvar tabulek odvozený jen z toho, co repozitář o produkci ví (migrace v
// routes/*.js, lib/objednavkySnapshot.js) - definice objednávek v repozitáři není.
async function pripravitSchema() {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'fakturytest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 4 });
  await pool.query(`
    CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
    CREATE TABLE darkove_poukazy (id SERIAL PRIMARY KEY, kod TEXT);
    CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, znacka TEXT, cena INTEGER);
    CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER REFERENCES zakaznici(id), cislo TEXT, stav TEXT DEFAULT 'nova',
      celkem NUMERIC, doprava TEXT, platba TEXT, poukaz_id INTEGER, sleva NUMERIC NOT NULL DEFAULT 0, doprava_cena NUMERIC, platba_priplatek NUMERIC,
      vydejni_misto_id TEXT, vydejni_misto_nazev TEXT, vydejni_misto_ulice TEXT, vydejni_misto_mesto TEXT, vydejni_misto_psc TEXT,
      faktura_cislo TEXT UNIQUE, faktura_datum TIMESTAMPTZ, faktura_odeslano TIMESTAMPTZ,
      zaplaceno_at TIMESTAMPTZ, expedovano_at TIMESTAMPTZ, dodano_at TIMESTAMPTZ, zruseno_at TIMESTAMPTZ,
      obj_jmeno TEXT, obj_email TEXT, obj_telefon TEXT, obj_ulice TEXT, obj_mesto TEXT, obj_psc TEXT,
      vytvoreno TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER REFERENCES objednavky(id), produkt_id INTEGER REFERENCES produkty(id), velikost INTEGER, pocet INTEGER, cena INTEGER);
    CREATE TABLE faktury_cislovani (rok INTEGER PRIMARY KEY, posledni_cislo INTEGER NOT NULL DEFAULT 0);
    INSERT INTO zakaznici (jmeno, email) VALUES ('Jana', 'jana@example.com');
    INSERT INTO produkty (nazev, znacka, cena) VALUES ('LENO denim', 'Pegres', 1679), ('Froddo Barefoot', 'Froddo', 1290);
    -- historická objednávka s fakturou z doby před ukládáním faktur (jako 2026004)
    INSERT INTO objednavky (zakaznik_id, cislo, stav, celkem, doprava, platba, sleva, doprava_cena, faktura_cislo, faktura_datum, obj_jmeno, obj_email, obj_telefon, obj_ulice, obj_mesto, obj_psc)
      VALUES (1, '261004', 'odeslana', 1179, 'osobni_odber', 'na_prodejne', 500, 0, '2026004', '2026-10-20T10:00:00Z', 'Jana', 'jana@example.com', '777', 'A 1', 'Hulín', '76824');
    INSERT INTO objednavky_polozky (objednavka_id, produkt_id, velikost, pocet, cena) VALUES (1, 1, 27, 1, 1679);
    INSERT INTO faktury_cislovani (rok, posledni_cislo) VALUES (2026, 4);
  `);
  const novaObjednavka = async () => {
    const id = (await pool.query(`INSERT INTO objednavky (zakaznik_id, cislo, stav, celkem, doprava, platba, doprava_cena, platba_priplatek, obj_jmeno, obj_email, obj_telefon, obj_ulice, obj_mesto, obj_psc)
      VALUES (1, '2610' || (100 + (SELECT COUNT(*) FROM objednavky)), 'zaplacena', 1369, 'zasilkovna', 'prevod', 79, 0, 'Jana', 'jana@example.com', '777', 'A 1', 'Hulín', '76824') RETURNING id`)).rows[0].id;
    await pool.query('INSERT INTO objednavky_polozky (objednavka_id, produkt_id, velikost, pocet, cena) VALUES ($1, 2, 26, 1, 1290)', [id]);
    return id;
  };
  const pocitadlo = async () => (await pool.query('SELECT posledni_cislo FROM faktury_cislovani WHERE rok = 2026')).rows[0].posledni_cislo;
  return {
    pool, novaObjednavka, pocitadlo,
    uklid: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  };
}

test('migrace: zachová existující objednávky i číslování, nic zpětně nevytvoří, jde spustit opakovaně', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    const pred = JSON.stringify((await db.pool.query('SELECT * FROM objednavky ORDER BY id')).rows);
    await migrovatFaktury(db.pool);
    await migrovatFaktury(db.pool);
    assert.equal(JSON.stringify((await db.pool.query('SELECT * FROM objednavky ORDER BY id')).rows), pred);
    assert.equal(await db.pocitadlo(), 4);
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM faktury')).rows[0].n, 0, 'historické faktury se zpětně nevytvářejí');
    const triggery = (await db.pool.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('faktury_nemenne', 'objednavky_faktura_nemenna') ORDER BY tgname")).rows.map(r => r.tgname);
    assert.deepEqual(triggery, ['faktury_nemenne', 'objednavky_faktura_nemenna']);
  } finally { await db.uklid(); }
});

test('vystavení: uloží doklad atomicky; uloženou fakturu ani číslo u objednávky nejde změnit ani smazat', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    await migrovatFaktury(db.pool);
    const id = await db.novaObjednavka();
    const v = await vystavitFakturu(db.pool, id, { ted: TED });
    assert.equal(v.stav, 'vystavena');
    assert.equal(v.faktura.cislo, '2026005');
    assert.equal(v.faktura.html_sha256, otisk(v.faktura.html));
    assert.equal(v.faktura.data.polozky[0].nazev, 'Froddo Barefoot');
    const o = (await db.pool.query('SELECT faktura_cislo, faktura_datum FROM objednavky WHERE id = $1', [id])).rows[0];
    assert.equal(o.faktura_cislo, '2026005');

    await assert.rejects(db.pool.query("UPDATE faktury SET html = 'x' WHERE id = $1", [v.faktura.id]), /nelze měnit ani mazat/);
    await assert.rejects(db.pool.query('DELETE FROM faktury WHERE id = $1', [v.faktura.id]), /nelze měnit ani mazat/);
    await assert.rejects(db.pool.query("UPDATE objednavky SET faktura_cislo = '2026999' WHERE id = $1", [id]), /nelze změnit/);
    await assert.rejects(db.pool.query('UPDATE objednavky SET faktura_datum = NOW() WHERE id = $1', [id]), /nelze změnit/);
    await assert.rejects(db.pool.query("UPDATE objednavky SET faktura_cislo = NULL WHERE id = 1"), /nelze změnit/, 'ani historické číslo');
    await db.pool.query("UPDATE objednavky SET stav = 'zrusena', zruseno_at = NOW() WHERE id = $1", [id]);
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM faktury WHERE objednavka_id = $1', [id])).rows[0].n, 1, 'storno doklad nemaže');

    // přejmenování produktu a změna ceny po vystavení doklad nezmění
    await db.pool.query("UPDATE produkty SET nazev = 'Přejmenováno', cena = 9999 WHERE id = 2");
    const znovu = await vystavitFakturu(db.pool, id, { ted: new Date() });
    assert.equal(znovu.stav, 'ulozena');
    assert.equal(znovu.faktura.html, v.faktura.html);
    assert.equal(await db.pocitadlo(), 5);
  } finally { await db.uklid(); }
});

test('souběh: dva současné požadavky na stejnou objednávku vytvoří jednu fakturu a spotřebují jedno číslo', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    await migrovatFaktury(db.pool);
    const id = await db.novaObjednavka();
    const vysledky = await Promise.all([vystavitFakturu(db.pool, id, { ted: TED }), vystavitFakturu(db.pool, id, { ted: TED }), vystavitFakturu(db.pool, id, { ted: TED })]);
    assert.deepEqual(vysledky.map(v => v.stav).sort(), ['ulozena', 'ulozena', 'vystavena']);
    assert.equal(new Set(vysledky.map(v => v.faktura.cislo)).size, 1);
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM faktury')).rows[0].n, 1);
    assert.equal(await db.pocitadlo(), 5);
  } finally { await db.uklid(); }
});

test('selhání při ukládání: žádný částečný doklad, číslo se nespotřebuje, objednávka beze změny', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    await migrovatFaktury(db.pool);
    const id = await db.novaObjednavka();
    await db.pool.query(`
      CREATE FUNCTION test_selhani() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulované selhání zápisu'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_selhani BEFORE INSERT ON faktury FOR EACH ROW EXECUTE FUNCTION test_selhani();`);
    await assert.rejects(vystavitFakturu(db.pool, id, { ted: TED }), /simulované selhání/);
    assert.equal(await db.pocitadlo(), 4, 'číslo se vrátilo');
    assert.equal((await db.pool.query('SELECT faktura_cislo FROM objednavky WHERE id = $1', [id])).rows[0].faktura_cislo, null);
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM faktury')).rows[0].n, 0);
    await db.pool.query('DROP TRIGGER test_selhani ON faktury');
    const v = await vystavitFakturu(db.pool, id, { ted: TED });
    assert.equal(v.faktura.cislo, '2026005', 'po opravě navazuje řada bez díry');
  } finally { await db.uklid(); }
});

test('historická faktura: vrátí se jako historická, nic se neuloží ani nepřečísluje', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    await migrovatFaktury(db.pool);
    const v = await vystavitFakturu(db.pool, 1, { ted: TED });
    assert.equal(v.stav, 'historicka');
    assert.equal(v.faktura_cislo, '2026004');
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM faktury')).rows[0].n, 0);
    assert.equal(await db.pocitadlo(), 4);
    assert.equal((await vystavitFakturu(db.pool, 999, { ted: TED })).stav, 'nenalezena');
  } finally { await db.uklid(); }
});

// --- Etapa 2.2 ---
const pocetTriggeru = async pool => (await pool.query("SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('faktury_nemenne', 'objednavky_faktura_nemenna') AND NOT tgisinternal ORDER BY tgname")).rows;

test('S4: opakovaná i souběžná migrace triggery neruší ani nezdvojí, ochrana funguje; vypnutý trigger znovu zapne', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    await migrovatFaktury(db.pool);
    const oidPred = (await db.pool.query("SELECT oid FROM pg_trigger WHERE tgname = 'faktury_nemenne'")).rows[0].oid;
    await Promise.all([migrovatFaktury(db.pool), migrovatFaktury(db.pool), migrovatFaktury(db.pool)]);
    assert.deepEqual(await pocetTriggeru(db.pool), [{ tgname: 'faktury_nemenne', tgenabled: 'O' }, { tgname: 'objednavky_faktura_nemenna', tgenabled: 'O' }]);
    assert.equal((await db.pool.query("SELECT oid FROM pg_trigger WHERE tgname = 'faktury_nemenne'")).rows[0].oid, oidPred, 'existující trigger se nezrušil a nevytvořil znovu');

    const id = await db.novaObjednavka();
    const v = await vystavitFakturu(db.pool, id, { ted: TED });
    await assert.rejects(db.pool.query('DELETE FROM faktury WHERE id = $1', [v.faktura.id]), /nelze měnit ani mazat/);

    // někdo trigger vypne -> další start ho zapne
    await db.pool.query('ALTER TABLE faktury DISABLE TRIGGER faktury_nemenne; ALTER TABLE objednavky DISABLE TRIGGER objednavky_faktura_nemenna');
    await migrovatFaktury(db.pool);
    assert.deepEqual((await pocetTriggeru(db.pool)).map(t => t.tgenabled), ['O', 'O']);
    await assert.rejects(db.pool.query("UPDATE faktury SET html = 'x' WHERE id = $1", [v.faktura.id]), /nelze měnit ani mazat/);
    await assert.rejects(db.pool.query("UPDATE objednavky SET faktura_cislo = '2026999' WHERE id = $1", [id]), /nelze změnit/);
  } finally { await db.uklid(); }
});

test('S4: migrace neobsahuje DROP TRIGGER a používá zámek proti souběhu', () => {
  const kod = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'vystaveniFaktury.js'), 'utf8');
  const migrace = kod.slice(kod.indexOf('async function migrovatFaktury'), kod.indexOf('// Ověří, že uložený doklad'));
  assert.doesNotMatch(migrace, /DROP TRIGGER/);
  assert.match(migrace, /pg_advisory_xact_lock/);
});

test('Z1 (PostgreSQL): smazaný produkt nevypustí položku; nesoulad částek nic neuloží ani nespotřebuje číslo', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    await migrovatFaktury(db.pool);
    // produkt smazaný z katalogu (cizí klíč v testovacím schématu dočasně pryč -
    // na produkci není známo, jestli existuje)
    const id = await db.novaObjednavka();
    await db.pool.query('ALTER TABLE objednavky_polozky DROP CONSTRAINT objednavky_polozky_produkt_id_fkey');
    await db.pool.query('DELETE FROM produkty WHERE id = 2');
    const v = await vystavitFakturu(db.pool, id, { ted: TED });
    assert.equal(v.stav, 'vystavena');
    assert.deepEqual(v.faktura.data.polozky.map(p => [p.nazev, p.cena, p.pocet]), [['Produkt již není v katalogu', 1290, 1]]);
    assert.equal(v.faktura.data.celkem, 1369);

    // nesoulad: celkem neodpovídá položkám + dopravě
    const id2 = await db.novaObjednavka();
    await db.pool.query('UPDATE objednavky SET celkem = 1000 WHERE id = $1', [id2]);
    const pred = await db.pocitadlo();
    const n = await vystavitFakturu(db.pool, id2, { ted: TED });
    assert.equal(n.stav, 'nelze');
    assert.match(n.chyba, /nesouhlasí/);
    assert.equal(await db.pocitadlo(), pred, 'číslo se nespotřebovalo');
    assert.equal((await db.pool.query('SELECT faktura_cislo FROM objednavky WHERE id = $1', [id2])).rows[0].faktura_cislo, null);
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM faktury WHERE objednavka_id = $1', [id2])).rows[0].n, 0);
    // zámek objednávky se uvolnil (transakce skončila) - jde dál měnit
    await db.pool.query("UPDATE objednavky SET stav = 'vyrizuje' WHERE id = $1", [id2]);
  } finally { await db.uklid(); }
});

// --- Etapa 2.3 ---
test('N6 (PostgreSQL): detail objednávky i rekonstrukce historické faktury ukážou položku smazaného produktu', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    await migrovatFaktury(db.pool);
    const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
    // skutečná routa nad dočasnou DB; startovní migrace a e-maily vypnuté
    const router = nacistRouterSMocky('../routes/objednavky.js', {
      '../db/pool': db.pool,
      '../lib/startServeru': { pripravit: () => {} },
      './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {}, odeslat_fakturu: async () => { throw new Error('v testu se neposílá'); } }
    });
    const zavolat = async (method, cesta) => { const res = vytvoritRes(); await najitHandler(router, method, cesta)({ params: { id: '1' }, body: {} }, res); return res; };

    // historická objednávka 2026004 (produkt 1) - produkt z katalogu zmizí
    await db.pool.query('ALTER TABLE objednavky_polozky DROP CONSTRAINT objednavky_polozky_produkt_id_fkey');
    await db.pool.query('DELETE FROM produkty WHERE id = 1');

    const detail = await zavolat('get', '/:id');
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.body.polozky.map(p => [p.nazev, p.znacka, p.velikost, p.pocet, Number(p.cena)]), [['Produkt již není v katalogu', null, 27, 1, 1679]]);

    const tisk = await zavolat('post', '/:id/faktura-html');
    assert.equal(tisk.statusCode, 200);
    assert.equal(tisk.body.historicka, true);
    const t = tisk.body.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(t, /Produkt již není v katalogu 27 1 1 679 Kč 1 679 Kč/);
    // 1 679 − sleva 500 + doprava 0 = 1 179 = celkem objednávky
    assert.match(t, /CELKEM 1 179 Kč/);
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM faktury')).rows[0].n, 0, 'rekonstrukce se neukládá');
    assert.equal(await db.pocitadlo(), 4, 'číslo se nespotřebuje');
  } finally { await db.uklid(); }
});

// --- Opravný doklad (storno) při zrušení objednávky ---
test('storno (PostgreSQL): zrušení vystaví opravný doklad ve stejné transakci; doklad je neměnný, souběh a selhání nic nerozbijí', { skip: preskocit }, async () => {
  const db = await pripravitSchema();
  try {
    await migrovatFaktury(db.pool);
    await db.pool.query(`
      ALTER TABLE darkove_poukazy ADD COLUMN zustatek NUMERIC, ADD COLUMN stav TEXT;
      CREATE TABLE sklad (produkt_id INTEGER, velikost INTEGER, pocet_kusu INTEGER);
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost INTEGER, typ TEXT, pocet INTEGER, poznamka TEXT);
      CREATE TABLE vratky (id SERIAL PRIMARY KEY, objednavka_id INTEGER);
      CREATE TABLE poukazy_pouziti (id SERIAL PRIMARY KEY, objednavka_id INTEGER);
      INSERT INTO sklad VALUES (2, 26, 0);`);
    const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
    const router = nacistRouterSMocky('../routes/objednavky.js', {
      '../db/pool': db.pool,
      '../lib/startServeru': { pripravit: () => {} },
      './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {}, odeslat_fakturu: async () => {}, odeslat_storno: async () => {} }
    });
    const zrusit = async id => { const res = vytvoritRes(); await najitHandler(router, 'patch', '/:id/stav')({ params: { id: String(id) }, body: { stav: 'zrusena' } }, res); return res; };
    const stornoRadky = async id => (await db.pool.query("SELECT * FROM faktury WHERE objednavka_id = $1 AND druh = 'storno'", [id])).rows;
    const rok = new Date().getFullYear();

    // objednávka s uloženou fakturou, prodaný kus se zapsal do pohybů
    const id = await db.novaObjednavka();
    await db.pool.query("INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES (2, 26, 'prodej', 1, $1)", [`Objednavka #${id}`]);
    const f = await vystavitFakturu(db.pool, id, { ted: TED });

    // selhání zápisu storna -> zrušení se celé vrátí (stav, sklad, číslo)
    await db.pool.query(`
      CREATE FUNCTION test_selhani_storna() RETURNS trigger AS $$ BEGIN IF NEW.druh = 'storno' THEN RAISE EXCEPTION 'simulované selhání storna'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_selhani_storna BEFORE INSERT ON faktury FOR EACH ROW EXECUTE FUNCTION test_selhani_storna();`);
    assert.equal((await zrusit(id)).statusCode, 500);
    assert.equal((await db.pool.query('SELECT stav FROM objednavky WHERE id = $1', [id])).rows[0].stav, 'zaplacena');
    assert.equal((await db.pool.query('SELECT pocet_kusu FROM sklad WHERE produkt_id = 2')).rows[0].pocet_kusu, 0, 'sklad se nevrátil');
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM opravne_doklady_cislovani WHERE posledni_cislo > 0')).rows[0].n, 0, 'číslo se nespotřebovalo');
    await db.pool.query('DROP TRIGGER test_selhani_storna ON faktury');

    // souběžné zrušení -> jedno storno, sklad vrácen jednou
    const vysledky = await Promise.all([zrusit(id), zrusit(id), zrusit(id)]);
    assert.ok(vysledky.every(r => r.statusCode === 200));
    assert.deepEqual(vysledky.map(r => r.body.storno_cislo).filter(Boolean), [`OD${rok}001`]);
    const [storno] = await stornoRadky(id);
    assert.equal(storno.data.puvodni_doklad.cislo, f.faktura.cislo);
    assert.equal(storno.data.celkem, -1369);
    assert.equal(storno.html_sha256, otisk(storno.html));
    assert.equal((await db.pool.query('SELECT pocet_kusu FROM sklad WHERE produkt_id = 2')).rows[0].pocet_kusu, 1);
    await assert.rejects(db.pool.query("UPDATE faktury SET html = 'x' WHERE id = $1", [storno.id]), /nelze měnit ani mazat/);
    await assert.rejects(db.pool.query('DELETE FROM faktury WHERE id = $1', [storno.id]), /nelze měnit ani mazat/);
    await assert.rejects(db.pool.query("INSERT INTO faktury (objednavka_id, druh, cislo, datum_vystaveni, data, html, html_sha256, sablona_verze) VALUES ($1, 'storno', 'X1', NOW(), '{}', '', '', '')", [id]), /duplicate key/, 'druhé storno k objednávce nejde');

    // historická faktura 2026004 -> storno z údajů objednávky, další číslo řady
    assert.equal((await zrusit(1)).body.storno_cislo, `OD${rok}002`);
    const [hist] = await stornoRadky(1);
    assert.equal(hist.data.puvodni_doklad.historicka, true);
    assert.equal(hist.data.celkem, -1179);
    // řada faktur se stornem nemění
    assert.equal(await db.pocitadlo(), 5);
  } finally { await db.uklid(); }
});
