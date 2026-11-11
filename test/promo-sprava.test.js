// Správa slevové akce v adminu (E-shop → Slevové akce): přehled použití,
// prodloužení (počet slev, datum konce), vypnutí, historie změn, veřejné podmínky
// pro stránku stromečku.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const promo = require('../lib/promo');

const AKCE = { kod: 'KRUCKY2026', max_pouziti: 50, od_den: '2026-11-29', do_den: '2026-12-31', aktivni: true };
const TED = new Date('2026-12-10T10:00:00Z');

// ─── pravidla úpravy bez databáze ───

test('prodloužení: víc slev a pozdější konec, popis změn do historie', () => {
  const u = promo.pripravitUpravu(AKCE, { max_pouziti: 100, do_den: '2027-01-15', aktivni: true }, { pouzito: 50, ted: TED });
  assert.deepEqual(u.sady, { max_pouziti: 100, do_den: '2027-01-15' });
  assert.deepEqual(u.popisy, ['Počet slev 50 → 100', 'Platí do 31. 12. 2026 → 15. 1. 2027']);
});

test('beze změny se nic nezapisuje', () => {
  const u = promo.pripravitUpravu(AKCE, { max_pouziti: 50, do_den: '2026-12-31', aktivni: true }, { pouzito: 3, ted: TED });
  assert.deepEqual(u.popisy, []);
});

test('počet slev nejde pod počet použití ani mimo rozsah', () => {
  assert.match(promo.pripravitUpravu(AKCE, { max_pouziti: 10 }, { pouzito: 12, ted: TED }).chyba, /použit 12×/);
  assert.ok(promo.pripravitUpravu(AKCE, { max_pouziti: 12 }, { pouzito: 12, ted: TED }).sady);
  for (const spatne of [0, -5, 2.5, 'abc', 10001]) {
    assert.match(promo.pripravitUpravu(AKCE, { max_pouziti: spatne }, { pouzito: 0, ted: TED }).chyba, /celé číslo/);
  }
});

test('datum konce: platné, ne před začátkem, ne do minulosti, nejvýš rok dopředu', () => {
  const chyba = d => promo.pripravitUpravu(AKCE, { do_den: d }, { pouzito: 0, ted: TED }).chyba;
  assert.match(chyba('2026-02-30'), /Neplatné/);
  assert.match(chyba('31.12.2026'), /Neplatné/);
  assert.match(chyba('2026-11-20'), /dřív, než začne/);
  assert.match(chyba('2026-12-05'), /do minulosti/);
  assert.match(chyba('2028-01-01'), /nejvýš o rok/);
  assert.equal(chyba('2026-12-10'), undefined); // dnešek jde (akce skončí dnes večer)
});

test('vypnutí a zapnutí akce; vypnutá akce kód nepustí', () => {
  assert.deepEqual(promo.pripravitUpravu(AKCE, { aktivni: false }, { pouzito: 0, ted: TED }).popisy, ['Akce vypnuta']);
  assert.match(promo.pripravitUpravu(AKCE, { aktivni: 'ne' }, { pouzito: 0, ted: TED }).chyba, /Neplatná/);
  const db = {
    platnost_od: new Date('2026-11-28T23:00:00Z'), platnost_do: new Date('2026-12-31T23:00:00Z'),
    kod: 'KRUCKY2026', sleva_procenta: 10, min_nakup: 500, max_pouziti: 50, eshop: true, prodejna: true
  };
  assert.equal(promo.chybaAkce({ ...db, aktivni: true }, { zaklad: 1000, kanal: 'eshop', ted: TED, pouzito: 0 }), null);
  assert.match(promo.chybaAkce({ ...db, aktivni: false }, { zaklad: 1000, kanal: 'eshop', ted: TED, pouzito: 0 }), /neprobíhá/);
});

// ─── API a stránky ───

test('admin adresy akcí jsou za heslem, veřejné jsou jen ověření a podmínky', () => {
  const router = require('../routes/promo');
  const vrstva = router.stack.map(l => ({ cesta: l.route.path, metoda: Object.keys(l.route.methods)[0], pocet: l.route.stack.length, prvni: l.route.stack[0].name }));
  const admin = vrstva.filter(v => v.cesta.startsWith('/akce'));
  assert.deepEqual(admin.map(v => v.metoda + ' ' + v.cesta).sort(), ['get /akce', 'get /akce/:kod/pouziti', 'patch /akce/:kod']);
  for (const v of admin) assert.ok(v.pocet >= 2, v.cesta + ' musí mít ochranu adminem');
  const verejne = vrstva.filter(v => !v.cesta.startsWith('/akce')).map(v => v.metoda + ' ' + v.cesta).sort();
  assert.deepEqual(verejne, ['get /info/:kod', 'post /overit']);
});

test('admin: stránka Slevové akce v menu E-shop, načítá akce, onclick escapuje kód', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.match(html, /onclick="showPage\('promo',this\)"><span class="nav-text">Slevové akce<\/span>/);
  assert.match(html, /id="page-promo"/);
  assert.match(html, /if \(name==='promo'\) loadPromo\(\);/);
  const blok = html.slice(html.indexOf('function promoKarta('), html.indexOf('function pridatPromoStrop'));
  assert.ok(!/\('\$\{id\}'/.test(blok), 'onclick musí používat idJs (escAttr(escJs()))');
  assert.match(blok, /escAttr\(escJs\(a\.kod\)\)/);
});

test('stromeček: datum konce a počet slev se berou z /api/promo/info, výchozí text zůstává', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'stromecek', 'index.html'), 'utf8');
  assert.match(html, /do <span id="promo-do">31\.&nbsp;12\.&nbsp;2026<\/span>/);
  assert.match(html, /prvních <span id="promo-pocet">50<\/span> nákupů/);
  assert.match(html, /\/api\/promo\/info\/KRUCKY2026/);
  assert.match(html, /\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$/);
});

// ─── proti PostgreSQL ───

const URL_DB = process.env.TEST_PG_URL;

test('PostgreSQL: přehled, nákupy, prodloužení, ochrana stropu, vypnutí, historie, veřejné info', { skip: !URL_DB && 'bez TEST_PG_URL' }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'promosprava_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 5 });
  try {
    // minimální tabulky, na které přehled nákupů odkazuje
    await pool.query(`
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT);
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, cislo TEXT, zakaznik_id INTEGER, obj_email TEXT, obj_jmeno TEXT);
      CREATE TABLE prodejna_prodeje (id SERIAL PRIMARY KEY, zakaznik TEXT);
      INSERT INTO zakaznici (jmeno) VALUES ('Jana Stará');
      INSERT INTO objednavky (cislo, zakaznik_id, obj_email, obj_jmeno) VALUES ('2612001', 1, 'j@x.cz', 'Jana Nová');
      INSERT INTO prodejna_prodeje (zakaznik) VALUES ('Petr');
    `);
    await promo.migrovat(pool);
    await promo.migrovat(pool); // opakovaně bez chyby

    let [a] = await promo.prehledAkci(pool);
    assert.equal(a.od_den, '2026-11-29');
    assert.equal(a.do_den, '2026-12-31');
    assert.equal(a.aktivni, true);
    assert.equal(a.pouzito, 0);

    await promo.zapsatPouziti(pool, { kod: 'KRUCKY2026', kanal: 'eshop', objednavkaId: 1, zaklad: 1200, sleva: 120 });
    await promo.zapsatPouziti(pool, { kod: 'KRUCKY2026', kanal: 'prodejna', prodejId: 1, zaklad: 800, sleva: 80 });
    await promo.uvolnit(pool, { prodejId: 1 }, 'Smazání prodeje v pokladně');
    await promo.zapsatPouziti(pool, { kod: 'KRUCKY2026', kanal: 'prodejna', prodejId: 1, zaklad: 900, sleva: 90 });

    [a] = await promo.prehledAkci(pool);
    assert.deepEqual([a.pouzito, a.pouzito_eshop, a.pouzito_prodejna, a.sleva_celkem, a.zbozi_celkem], [2, 1, 1, 210, 2100]);
    const pouziti = await promo.pouzitiAkce(pool, 'KRUCKY2026');
    assert.equal(pouziti.length, 3); // i uvolněné
    const eshop = pouziti.find(p => p.kanal === 'eshop');
    assert.equal(eshop.objednavka_cislo, '2612001');
    assert.equal(eshop.objednavka_jmeno, 'Jana Nová'); // snímek objednávky, ne aktuální zákazník
    assert.equal(pouziti.filter(p => p.uvolneno).length, 1);
    assert.equal(pouziti.find(p => p.kanal === 'prodejna').prodej_zakaznik, 'Petr');

    // strop pod počet použití nejde
    const pod = await promo.upravitAkci(pool, 'KRUCKY2026', { max_pouziti: 1 }, { ted: new Date('2026-12-10T10:00:00Z') });
    assert.equal(pod.status, 400);

    // prodloužení: konec 15. 1. 2027 včetně = půlnoc 16. 1. českého času
    const v = await promo.upravitAkci(pool, 'krůčky 2026', { max_pouziti: 80, do_den: '2027-01-15', aktivni: true }, { ted: new Date('2026-12-10T10:00:00Z') });
    assert.deepEqual(v.zmeneno, ['Počet slev 50 → 80', 'Platí do 31. 12. 2026 → 15. 1. 2027']);
    const radek = (await pool.query('SELECT max_pouziti, platnost_do FROM promo_akce')).rows[0];
    assert.equal(radek.max_pouziti, 80);
    assert.equal(new Date(radek.platnost_do).toISOString(), '2027-01-15T23:00:00.000Z');
    assert.equal((await promo.overit(pool, 'KRUCKY2026', { zaklad: 1000, kanal: 'eshop', ted: new Date('2027-01-15T22:59:00Z') })).ok, true);
    assert.equal((await promo.overit(pool, 'KRUCKY2026', { zaklad: 1000, kanal: 'eshop', ted: new Date('2027-01-15T23:00:00Z') })).ok, false);

    // úprava další migrací se nepřepíše
    await promo.migrovat(pool);
    assert.equal((await pool.query('SELECT max_pouziti FROM promo_akce')).rows[0].max_pouziti, 80);

    // vypnutí
    await promo.upravitAkci(pool, 'KRUCKY2026', { aktivni: false }, { ted: new Date('2026-12-10T10:00:00Z') });
    const vypnuto = await promo.overit(pool, 'KRUCKY2026', { zaklad: 1000, kanal: 'eshop', ted: new Date('2026-12-10T10:00:00Z') });
    assert.match(vypnuto.chyba, /neprobíhá/);

    // uložení beze změny nezapíše historii
    const nic = await promo.upravitAkci(pool, 'KRUCKY2026', { max_pouziti: 80 }, { ted: new Date('2026-12-10T10:00:00Z') });
    assert.deepEqual(nic.zmeneno, []);
    const zmeny = await promo.zmenyAkce(pool, 'KRUCKY2026');
    assert.deepEqual(zmeny.map(z => z.popis), ['Akce vypnuta', 'Počet slev 50 → 80, Platí do 31. 12. 2026 → 15. 1. 2027']);

    assert.equal((await promo.upravitAkci(pool, 'NEEXISTUJE', { aktivni: true })).status, 404);

    const info = await promo.verejneInfo(pool, 'KRUCKY2026');
    assert.deepEqual(info, { kod: 'KRUCKY2026', sleva_procenta: 10, min_nakup: 500, max_pouziti: 80, aktivni: false, od_den: '2026-11-29', do_den: '2027-01-15' });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
