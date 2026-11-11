// Slevový kód akce (lib/promo.js) - KRUCKY2026 od stromečku: 10 % ze zboží,
// nákup od 500 Kč, max. 50 uplatnění v e-shopu a prodejně dohromady, platnost
// od 29. 11. 2026 do konce roku, nesčítá se se zbožím ve slevě.
const test = require('node:test');
const assert = require('node:assert/strict');
const promo = require('../lib/promo');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');
const { chybaCastek } = require('../lib/vystaveniFaktury');
const { sestavitSnimek, sestavitStorno, vykreslitObsah } = require('../lib/faktura');

const AKCE = {
  kod: 'KRUCKY2026', nazev: 'Vánoční sleva od stromečku', sleva_procenta: 10, min_nakup: '500', max_pouziti: 50,
  platnost_od: new Date('2026-11-28T23:00:00Z'), platnost_do: new Date('2026-12-31T23:00:00Z'), eshop: true, prodejna: true
};
const BEHEM = new Date('2026-12-10T10:00:00Z');

// ─── pravidla bez databáze ───

test('kód: diakritika, mezery a malá písmena nevadí', () => {
  assert.equal(promo.normalizovatKod(' krůčky 2026 '), 'KRUCKY2026');
  assert.equal(promo.normalizovatKod('KRŮČKY2026'), 'KRUCKY2026');
  assert.equal(promo.normalizovatKod(null), '');
});

test('sleva se zaokrouhlí na celé koruny', () => {
  assert.equal(promo.vypocitatSlevu(1290, 10), 129);
  assert.equal(promo.vypocitatSlevu(1295, 10), 130);
  assert.equal(promo.vypocitatSlevu(500, 10), 50);
});

test('pravidla akce: začátek, konec, strop, minimum, zboží ve slevě, kanál', () => {
  const ch = (prepis, akce = AKCE) => promo.chybaAkce(akce, { zaklad: 1000, kanal: 'eshop', ted: BEHEM, pouzito: 0, ...prepis });
  assert.equal(ch({}), null);
  assert.match(ch({ ted: new Date('2026-11-28T22:59:59Z') }), /platí od 29\. 11\. 2026/);
  assert.equal(ch({ ted: new Date('2026-11-28T23:00:00Z') }), null, 'od půlnoci 29. 11. českého času platí');
  assert.equal(ch({ ted: new Date('2026-12-31T22:59:59Z') }), null, 'celý 31. 12. ještě platí');
  assert.match(ch({ ted: new Date('2026-12-31T23:00:00Z') }), /skončila/);
  assert.equal(ch({ pouzito: 49 }), null);
  assert.match(ch({ pouzito: 50 }), /všech 50 zákazníků/);
  assert.equal(ch({ zaklad: 500 }), null, 'přesně 500 Kč stačí');
  assert.match(ch({ zaklad: 499 }), /od 500 Kč.*Chybí vám ještě 1 Kč/);
  assert.match(ch({ zaklad: 0 }), /ve slevě/);
  assert.match(ch({}, null), /neexistuje/);
  assert.match(ch({ kanal: 'prodejna' }, { ...AKCE, prodejna: false }), /jen v e-shopu/);
  assert.match(ch({}, { ...AKCE, eshop: false }), /jen v prodejně/);
});

test('vypínač PROMO_AKTIVNI=false akci zastaví', () => {
  process.env.PROMO_AKTIVNI = 'false';
  try {
    assert.match(promo.chybaAkce(AKCE, { zaklad: 1000, kanal: 'eshop', ted: BEHEM, pouzito: 0 }), /neprobíhá/);
  } finally {
    delete process.env.PROMO_AKTIVNI;
  }
});

// ─── objednávka v e-shopu (skutečný route handler, paměťová DB) ───

const emailyMock = { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {} };

function nacistObjednavky(stav) {
  return nacistRouterSMocky('../routes/objednavky.js', { '../db/pool': vytvoritMockPool(stav), './emaily': emailyMock });
}

// Akce platná teď (testy nesmí záviset na dnešním datu)
function stavSAkci(prepisAkce = {}) {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 5, dostupnost: 'skladem', cena: 500, nazev: 'Botky' });
  stav.sklad.push({ produkt_id: 2, velikost: 25, pocet_kusu: 5, dostupnost: 'skladem', cena: 400, nazev: 'Papučky' });
  stav.sklad.push({ produkt_id: 3, velikost: 26, pocet_kusu: 5, dostupnost: 'skladem', cena: 600, nazev: 'Ve slevě', cena_pred_slevou: 800 });
  stav.promoAkce = [{ ...AKCE, platnost_od: new Date(Date.now() - 86400000), platnost_do: new Date(Date.now() + 86400000), ...prepisAkce }];
  stav.promoPouziti = [];
  return stav;
}

const pozadavek = (prepis = {}) => ({
  jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456',
  ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24', doprava: 'osobni_odber', platba: 'prevod',
  polozky: [{ produkt_id: 1, velikost: 24, pocet: 2 }], promo_kod: 'krucky2026', ...prepis
});

async function objednat(stav, body) {
  const handler = najitHandler(nacistObjednavky(stav), 'post', '/');
  const res = vytvoritRes();
  await handler({ body, ip: '10.0.0.' + Math.floor(Math.random() * 250) }, res);
  return res;
}

test('objednávka s kódem: 10 % ze zboží, zapíše se použití a faktura sedí', async () => {
  const stav = stavSAkci();
  const res = await objednat(stav, pozadavek());
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.celkem, 900);
  assert.equal(res.body.promo_sleva, 100);
  const o = stav.objednavky[0];
  assert.equal(o.promo_kod, 'KRUCKY2026');
  assert.equal(o.promo_sleva, 100);
  assert.deepEqual(stav.promoPouziti.map(p => [p.kod, p.kanal, p.objednavka_id, p.sleva]), [['KRUCKY2026', 'eshop', o.id, 100]]);
  // Kontrola částek před vystavením faktury: položky − sleva kódem + doprava = celkem
  assert.equal(chybaCastek(o, stav.objednavkyPolozky), null);
});

test('objednávka s kódem a dárkovým poukazem: poukaz platí, co zbude po slevě', async () => {
  const stav = stavSAkci();
  stav.poukazy.push({ id: 7, kod: 'DP1', ean: null, zustatek: 2000, stav: 'aktivni', platnost_do: '2099-12-31' });
  const res = await objednat(stav, pozadavek({ poukaz_kod: 'DP1' }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.celkem, 0);
  const o = stav.objednavky[0];
  assert.equal(o.promo_sleva, 100);
  assert.equal(o.sleva, 900, 'poukaz pokryje 900 Kč, ne 1000');
  assert.equal(chybaCastek(o, stav.objednavkyPolozky), null);
});

test('zboží ve slevě se do kódu nepočítá (ani do minima 500 Kč)', async () => {
  const stav = stavSAkci();
  // 600 Kč ve slevě + 500 Kč běžné → sleva jen z 500 Kč
  let res = await objednat(stav, pozadavek({ polozky: [{ produkt_id: 3, velikost: 26, pocet: 1 }, { produkt_id: 1, velikost: 24, pocet: 1 }] }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.promo_sleva, 50);
  assert.equal(res.body.celkem, 1050);
  // jen zboží ve slevě → kód neprojde, objednávka nevznikne
  res = await objednat(stav, pozadavek({ polozky: [{ produkt_id: 3, velikost: 26, pocet: 2 }] }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /ve slevě/);
  assert.equal(stav.objednavky.length, 1);
});

test('nákup pod 500 Kč: kód neprojde a objednávka nevznikne (sklad se nesníží)', async () => {
  const stav = stavSAkci();
  const res = await objednat(stav, pozadavek({ polozky: [{ produkt_id: 2, velikost: 25, pocet: 1 }] }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /od 500 Kč.*Chybí vám ještě 100 Kč/);
  assert.equal(stav.objednavky.length, 0);
  assert.equal(stav.sklad.find(r => r.produkt_id === 2).pocet_kusu, 5);
});

test('vyčerpaný strop 50: 51. objednávka s kódem neprojde', async () => {
  const stav = stavSAkci();
  for (let i = 0; i < 50; i++) stav.promoPouziti.push({ kod: 'KRUCKY2026', kanal: i % 2 ? 'prodejna' : 'eshop', uvolneno: null });
  const res = await objednat(stav, pozadavek());
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /všech 50/);
  assert.equal(stav.objednavky.length, 0);
});

test('kód před začátkem akce neprojde', async () => {
  const stav = stavSAkci({ platnost_od: new Date(Date.now() + 86400000), platnost_do: new Date(Date.now() + 5 * 86400000) });
  const res = await objednat(stav, pozadavek());
  assert.equal(res.statusCode, 400);
  assert.match(res.body.chyba, /platí od/);
});

test('jeden zákazník může kód použít víckrát (limit na telefon není)', async () => {
  const stav = stavSAkci();
  assert.equal((await objednat(stav, pozadavek())).statusCode, 200);
  assert.equal((await objednat(stav, pozadavek())).statusCode, 200);
  assert.equal(stav.promoPouziti.length, 2);
});

test('objednávka bez kódu funguje jako dřív a nic nezapisuje', async () => {
  const stav = stavSAkci();
  const res = await objednat(stav, pozadavek({ promo_kod: undefined }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.celkem, 1000);
  assert.equal(stav.promoPouziti.length, 0);
});

test('zrušení objednávky kód uvolní - místo ve stropu se vrátí', async () => {
  const stav = stavSAkci();
  await objednat(stav, pozadavek());
  const router = nacistObjednavky(stav);
  const zmenitStav = najitHandler(router, 'patch', '/:id/stav');
  const res = vytvoritRes();
  await zmenitStav({ params: { id: String(stav.objednavky[0].id) }, body: { stav: 'zrusena' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(stav.promoPouziti[0].uvolneno, 'použití je uvolněné');
  assert.equal(stav.promoPouziti[0].duvod_uvolneni, 'Zrušení objednávky');
});

// ─── faktura a opravný doklad ───

test('faktura ukáže řádek slevového kódu, opravný doklad ho vrátí', () => {
  const o = {
    id: 5, cislo: '261105', stav: 'zaplacena', jmeno: 'Jana', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24', email: 'j@e.cz',
    doprava: 'osobni_odber', platba: 'prevod', doprava_cena: 0, platba_priplatek: 0, sleva: 0, celkem: 900,
    promo_kod: 'KRUCKY2026', promo_sleva: 100, vytvoreno: '2026-12-01T10:00:00Z',
    polozky: [{ produkt_id: 1, nazev: 'Botky', velikost: 24, pocet: 2, cena: 500 }]
  };
  const snimek = sestavitSnimek(o, { faktura_cislo: '2026010', faktura_datum: '2026-12-02T10:00:00Z' });
  assert.deepEqual(snimek.promo, { kod: 'KRUCKY2026', sleva: 100 });
  const html = vykreslitObsah(snimek);
  assert.match(html, /Sleva – slevový kód KRUCKY2026<\/td><td[^>]*>−100 Kč/);
  const storno = sestavitStorno(snimek, { cislo: 'OD2026001', datum_vystaveni: '2026-12-03T10:00:00Z', duvod: 'Zrušení objednávky' });
  assert.equal(storno.promo.sleva, -100);
  assert.match(vykreslitObsah(storno), /Sleva – slevový kód KRUCKY2026<\/td><td[^>]*>100 Kč/);
  // faktura bez kódu má snímek beze změny (žádný klíč promo)
  assert.equal('promo' in sestavitSnimek({ ...o, promo_kod: null, promo_sleva: 0, celkem: 1000 }, { faktura_cislo: '1', faktura_datum: new Date() }), false);
});

// ─── pokladna v prodejně ───

function mockPoolProdejna(stav) {
  const client = {
    release() {},
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s) || s.startsWith('CREATE') || s.startsWith('ALTER')) return {};
      if (s.startsWith('SELECT id FROM produkty WHERE id = ANY($1::int[]) AND cena_pred_slevou IS NOT NULL')) {
        return { rows: params[0].filter(id => (stav.veSleve || []).includes(id)).map(id => ({ id })) };
      }
      if (s.startsWith('SELECT * FROM promo_akce WHERE kod = $1')) {
        const a = stav.promoAkce.find(a => a.kod === params[0]);
        return { rows: a ? [a] : [] };
      }
      if (s.startsWith('SELECT COUNT(*)::int AS pocet FROM promo_pouziti')) {
        return { rows: [{ pocet: stav.promoPouziti.filter(p => p.kod === params[0] && !p.uvolneno).length }] };
      }
      if (s.startsWith('INSERT INTO prodejna_prodeje')) {
        const prodej = { id: stav.prodeje.length + 1, celkem: params[4], mezisoucet: params[5], sleva: params[6], sleva_popis: params[7] };
        stav.prodeje.push(prodej);
        return { rows: [prodej] };
      }
      if (s.startsWith('INSERT INTO promo_pouziti')) {
        stav.promoPouziti.push({ kod: params[0], kanal: params[1], prodej_id: params[3], sleva: params[5], uvolneno: null });
        return {};
      }
      if (s.startsWith('SELECT id FROM vratky WHERE vymena_prodej_id')) return { rows: [] };
      if (s.startsWith('DELETE FROM prodejna_prodeje')) return {};
      if (s.startsWith('UPDATE promo_pouziti SET uvolneno')) {
        let n = 0;
        for (const p of stav.promoPouziti) if (p.prodej_id === params[0] && !p.uvolneno) { p.uvolneno = new Date(); n++; }
        return { rowCount: n };
      }
      throw new Error('Mock pokladny nezná dotaz: ' + s);
    }
  };
  return { connect: async () => client, query: (sql, params) => client.query(sql, params) };
}

function nacistProdejnu(stav) {
  return nacistRouterSMocky('../routes/prodejna.js', { '../db/pool': mockPoolProdejna(stav) });
}

test('pokladna: prodej s kódem - slevu spočítá server, zapíše se do společného stropu', async () => {
  const stav = { prodeje: [], veSleve: [9], promoPouziti: [{ kod: 'KRUCKY2026', kanal: 'eshop', uvolneno: null }], promoAkce: stavSAkci().promoAkce };
  const router = nacistProdejnu(stav);
  const res = vytvoritRes();
  await najitHandler(router, 'post', '/')({ body: {
    platba: 'hotovost', hotovost_prijato: 1000, promo_kod: 'KRUCKY2026',
    // klient posílá vlastní slevu/celkem - server je přepočítá
    sleva: 999, celkem: 1,
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 700 }, { produkt_id: 9, velikost: 30, pocet: 1, cena: 300 }]
  } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.mezisoucet, 1000);
  assert.equal(res.body.sleva, 70, 'jen ze zboží, které není ve slevě');
  assert.equal(res.body.celkem, 930);
  assert.equal(res.body.sleva_popis, 'kód KRUCKY2026 – 10 %');
  assert.deepEqual(stav.promoPouziti.map(p => p.kanal), ['eshop', 'prodejna']);
});

test('pokladna: smazání prodeje kód uvolní', async () => {
  const stav = { prodeje: [], promoPouziti: [{ kod: 'KRUCKY2026', kanal: 'prodejna', prodej_id: 4, uvolneno: null }], promoAkce: [] };
  const res = vytvoritRes();
  await najitHandler(nacistProdejnu(stav), 'delete', '/:id')({ params: { id: '4' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(stav.promoPouziti[0].uvolneno);
});

test('pokladna: kód nejde kombinovat s doplatkem k poukazu', async () => {
  const stav = { prodeje: [], promoPouziti: [], promoAkce: stavSAkci().promoAkce };
  const res = vytvoritRes();
  await najitHandler(nacistProdejnu(stav), 'post', '/')({ body: {
    platba: 'karta', promo_kod: 'KRUCKY2026', poukaz_kod: 'DP1', doplatek_platba: 'karta',
    polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 700 }]
  } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(stav.prodeje.length, 0);
});

// ─── skutečný PostgreSQL: strop pod souběhem ───

const URL_DB = process.env.TEST_PG_URL;

test('PostgreSQL: migrace jde spustit opakovaně, strop vydrží souběžné nákupy, uvolnění vrátí místo', { skip: !URL_DB && 'bez TEST_PG_URL' }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const schema = 'promotest_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, options: `-c search_path=${schema}`, max: 10 });
  try {
    await promo.migrovat(pool);
    await promo.migrovat(pool);
    const akce = (await pool.query('SELECT * FROM promo_akce')).rows;
    assert.equal(akce.length, 1);
    assert.equal(akce[0].kod, 'KRUCKY2026');
    assert.equal(akce[0].max_pouziti, 50);
    assert.equal(new Date(akce[0].platnost_od).toISOString(), '2026-11-28T23:00:00.000Z');
    assert.equal(new Date(akce[0].platnost_do).toISOString(), '2026-12-31T23:00:00.000Z');

    // Úprava v databázi se další migrací nepřepíše
    await pool.query('UPDATE promo_akce SET max_pouziti = 2');
    await promo.migrovat(pool);
    assert.equal((await pool.query('SELECT max_pouziti FROM promo_akce')).rows[0].max_pouziti, 2);

    // 6 souběžných nákupů na strop 2 → projdou přesně 2
    const nakup = async (i) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const v = await promo.overit(c, 'krůčky2026', { zaklad: 1000, kanal: i % 2 ? 'prodejna' : 'eshop', ted: BEHEM, zamknout: true });
        if (!v.ok) { await c.query('ROLLBACK'); return v.chyba; }
        await new Promise(r => setTimeout(r, 20)); // zámek drží i během "práce" na objednávce
        await promo.zapsatPouziti(c, { kod: v.kod, kanal: i % 2 ? 'prodejna' : 'eshop', objednavkaId: i % 2 ? null : 100 + i, prodejId: i % 2 ? 200 + i : null, zaklad: 1000, sleva: v.sleva });
        await c.query('COMMIT');
        return 'ok';
      } finally { c.release(); }
    };
    const vysledky = await Promise.all([0, 1, 2, 3, 4, 5].map(nakup));
    assert.equal(vysledky.filter(v => v === 'ok').length, 2, vysledky.join(' | '));
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM promo_pouziti WHERE uvolneno IS NULL')).rows[0].n, 2);

    // Uvolnění (zrušená objednávka) vrátí místo
    const ok = (await pool.query('SELECT objednavka_id, prodej_id FROM promo_pouziti ORDER BY id LIMIT 1')).rows[0];
    const n = await promo.uvolnit(pool, ok.objednavka_id != null ? { objednavkaId: ok.objednavka_id } : { prodejId: ok.prodej_id }, 'test');
    assert.equal(n, 1);
    assert.equal((await promo.overit(pool, 'KRUCKY2026', { zaklad: 1000, kanal: 'eshop', ted: BEHEM })).ok, true);
    // a historie zůstává
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM promo_pouziti')).rows[0].n, 2);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
