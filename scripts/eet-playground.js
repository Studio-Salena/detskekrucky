// Skutečný integrační test EET proti oficiálnímu PLAYGROUNDU (neprodukční prostředí FS).
// Žádný mock: zprávy jdou přes HTTPS s ověřením TLS na pg.trzbyeet.gov.cz, odpovědi se
// ověří (podpis FS, řetězec I.CA, UUID, příznak test, fiktivní POK „-ff“). Potvrzení
// z Playgroundu NEJSOU evidencí tržeb. Databáze je dočasné schéma v lokální testovací DB
// (nikdy produkce). Není to soubor pro `node --test` – spouští se ručně.
//
// Použití (PowerShell, cesty k certifikátu a klíči jen v proměnných relace, soubory mimo git):
//   $env:EET_PROSTREDI = "playground"; $env:EET_EIC = "CZ00000019"
//   $env:EET_ID_PROVOZ = "11"; $env:EET_ID_POKL = "POKLADNA-TEST"
//   $env:EET_CERT_PEM = "C:\mimo-git\pg-CZ00000019-cert.pem"; $env:EET_KLIC_PEM = "C:\mimo-git\pg-CZ00000019-klic.pem"
//   $env:TEST_PG_URL = "postgres://…@localhost/…test…"
//   node scripts/eet-playground.js [zprava.json]
// Návratový kód 0 = všechny kroky prošly, 1 = některý selhal, 2 = test NEPROVEDEN
// (chybí konfigurace nebo spojení s Playgroundem – mock ho nenahrazuje).
'use strict';
const fs = require('node:fs');

async function main() {
  const zprava = { zacatek: new Date().toISOString(), prostredi: null, kroky: [], vysledek: null };
  const krok = (nazev, ok, data = {}) => { zprava.kroky.push({ nazev, ok, ...data }); console.log(`${ok ? 'OK  ' : 'CHYBA'} ${nazev}${data.info ? ' – ' + data.info : ''}`); return ok; };
  const konec = kod => {
    zprava.konec = new Date().toISOString();
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(zprava, null, 2));
    process.exit(kod);
  };
  const neprovedeno = duvod => { zprava.vysledek = 'NEPROVEDENO: ' + duvod; console.log('TEST NEPROVEDEN: ' + duvod); konec(2); };

  const konfigurace = require('../lib/eetKonfigurace');
  let konfig;
  try { konfig = konfigurace.nacist(process.env); } catch (e) { return neprovedeno('konfigurace: ' + e.message); }
  if (!konfig) return neprovedeno('EET_PROSTREDI není nastavené.');
  if (konfig.prostredi !== 'playground' || !konfig.testovaci) return neprovedeno('Skript běží jen proti Playgroundu.');
  zprava.prostredi = konfigurace.popis(konfig);
  const url = process.env.TEST_PG_URL;
  if (!url || !/localhost|127\.0\.0\.1/.test(url) || !/test|kopie|sim/i.test(url)) return neprovedeno('TEST_PG_URL musí být lokální testovací databáze.');

  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const schema = 'eet_pg_' + Date.now();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
  const puvodniLog = console.log;
  let selhalo = false;
  const fronty = [];
  const eetFronta = require('../lib/eetFronta');
  try {
    const udalosti = require('../lib/eetUdalosti');
    const { Fronta, odeslatHttps } = eetFronta;
    udalosti.nastavitKonfiguraci(konfig);
    await pool.query(`
      CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, znacka TEXT, cena NUMERIC, na_eshopu BOOLEAN DEFAULT true, cena_pred_slevou INTEGER);
      CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost TEXT, pocet_kusu INTEGER, dostupnost TEXT DEFAULT 'skladem', UNIQUE (produkt_id, velikost));
      CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
      CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER, stav TEXT DEFAULT 'nova', celkem NUMERIC, doprava TEXT, platba TEXT, poznamka TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER, produkt_id INTEGER, velikost TEXT, pocet INTEGER, cena NUMERIC);
      CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, datum TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
      INSERT INTO produkty (nazev, znacka, cena) VALUES ('Testovací bota', 'Test', 1000);
      INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES (1, '24', 50);`);
    console.log = () => {};
    const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');
    const { vsePripraveno } = require('../lib/startServeru');
    const mocky = { '../db/pool': pool, './emaily': new Proxy({}, { get: () => async () => {} }) };
    const nacist = r => nacistRouterSMocky('../routes/' + r + '.js', mocky);
    const prodejna = nacist('prodejna'); const poukazy = nacist('poukazy'); nacist('promo'); nacist('poukazoveKarty');
    const evRouter = nacist('evidencePlateb');
    await vsePripraveno(30000);
    console.log = puvodniLog;
    const zavolat = async (router, metoda, cesta, req = {}) => { const res = vytvoritRes(); await najitHandler(router, metoda, cesta)({ params: {}, query: {}, ip: '127.0.0.1', ...req }, res); return res; };
    const q = async (sql, p) => (await pool.query(sql, p)).rows;
    const log = { log() {}, warn: m => puvodniLog('  pozn.:', m), error: (...m) => puvodniLog('  chyba:', ...m) };
    const t = Date.now();

    // 0) spojení: ověřovací mód (nic se neeviduje, kód 0, bez POK)
    const fronta = new Fronta({ db: pool, konfig, log });
    const ov = await fronta.overitSpojeni();
    if (ov.vysledek === 'sit' || ov.vysledek === 'timeout') return neprovedeno('Playground není dostupný: ' + ov.text);
    krok('ověřovací mód (kód 0, bez POK, nic se neeviduje)', ov.ok && ov.kod === 0, { info: `kód ${ov.kod}, transakce ${ov.transakce}`, odpoved: ov });

    // 1) operace aplikace → události v DB (bez běžící fronty – odešlou se v dalších krocích)
    const pol = (cena, pocet = 1) => ({ produkt_id: 1, nazev: 'Testovací bota', velikost: '24', pocet, cena });
    const prodej = (await zavolat(prodejna, 'post', '/', { body: { klic: 'pg-hotove-' + t, platba: 'hotovost', polozky: [pol(1000)], potvrdit_duplicitu: true } })).body;
    const pk = (await zavolat(poukazy, 'post', '/', { body: { klic: 'pg-poukaz-' + t, hodnota: 1000, platba: 'karta', zakoupeno_kde: 'prodejna' } })).body;
    await zavolat(prodejna, 'post', '/', { body: { klic: 'pg-doplatek-' + t, platba: 'poukaz', poukaz_kod: pk.kod, doplatek_platba: 'karta', polozky: [pol(1500)], potvrdit_duplicitu: true } });
    await zavolat(prodejna, 'post', '/vratky', { body: { klic: 'pg-vratka-' + t, prodej_id: prodej.id, polozky: [{ produkt_id: 1, velikost: '24', pocet: 1 }], castka: 1000, zpusob_vraceni: 'hotovost' } });
    const dar = (await zavolat(poukazy, 'post', '/', { body: { klic: 'pg-dar-' + t, hodnota: 500, druh: 'dar', zakoupeno_kde: 'prodejna' } })).body;
    await zavolat(prodejna, 'post', '/', { body: { klic: 'pg-dar-prodej-' + t, platba: 'poukaz', poukaz_kod: dar.kod, polozky: [pol(500)], potvrdit_duplicitu: true } });
    // volná hotovost „za zboží“ přiřazená poukazu z e-shopu → původní tržba + opravná dvojice (−500 | +500 z toho 500 k čerpání)
    const volna = (await zavolat(evRouter, 'post', '/volna', { body: { klic: 'pg-volna-' + t, zpusob: 'hotovost', castka: 500, ucel: 'zbozi' } })).body;
    const ep = (await zavolat(poukazy, 'post', '/', { body: { klic: 'pg-eshop-' + t, hodnota: 500, zakoupeno_kde: 'eshop' } })).body;
    const prirazeni = await zavolat(poukazy, 'post', '/:id/platba', { params: { id: String(ep.id) }, body: { klic: 'pg-prirazeni-' + t, platba_id: volna.id } });
    const vsechny = await q('SELECT id, zdroj_typ, zdroj_id, stav, typ, porad_cis, dat_trzby, celk_trzba, urceno_cerp_zuct, cerp_zuct FROM eet_udalosti ORDER BY id');
    const popsat = u => `${u.stav} ${u.celk_trzba}/${u.urceno_cerp_zuct || '-'}/${u.cerp_zuct || '-'}`;
    const ocekavano = ['ceka 1000.00/-/-', 'ceka 1000.00/1000.00/-', 'ceka 1500.00/-/1000.00', 'ceka -1000.00/-/-', 'rozhodnuti 500.00/-/500.00',
      'ceka 500.00/-/-', 'ceka -500.00/-/-', 'ceka 500.00/500.00/-'];
    krok('události vznikly v transakcích operací (prodej, poukaz, doplatek, vratka, darovaný kredit, volná platba + oprava)',
      prirazeni.statusCode === 200 && JSON.stringify(vsechny.map(popsat)) === JSON.stringify(ocekavano), { info: vsechny.map(popsat).join('; ') });

    // 2) ztracená odpověď u první události: FS zprávu dostane, odpověď zahodíme → opakování
    const prvni = vsechny[0];
    let zahodit = true;
    const fZtracena = new Fronta({ db: pool, konfig, log });
    fZtracena.transport = async a => {
      const r = await odeslatHttps(a);
      if (zahodit) { zahodit = false; throw Object.assign(new Error('Odpověď úmyslně zahozena (simulace ztracené odpovědi).'), { druh: 'sit' }); }
      return r;
    };
    await q("UPDATE eet_udalosti SET dalsi_pokus_at = now() + interval '1 hour' WHERE id <> $1 AND stav = 'ceka'", [prvni.id]);
    await fZtracena.zpracovat({ limit: 1 });
    await q('UPDATE eet_udalosti SET dalsi_pokus_at = now() WHERE id = $1', [prvni.id]);
    await fZtracena.zpracovat({ limit: 1 });
    await q("UPDATE eet_udalosti SET dalsi_pokus_at = now() WHERE id <> $1 AND stav = 'ceka'", [prvni.id]);
    const poZtrate = (await q('SELECT stav, pok, pok_test FROM eet_udalosti WHERE id = $1', [prvni.id]))[0];
    const pokusy1 = await q('SELECT uuid_zpravy, prvni_zaslani, vysledek, pok, transakce_fs FROM eet_pokusy WHERE udalost_id = $1 ORDER BY id', [prvni.id]);
    const okZtrata = poZtrate.stav === 'potvrzeno' && poZtrate.pok_test === true && /-ff$/.test(poZtrate.pok) && pokusy1.length === 2
      && pokusy1[0].prvni_zaslani === true && pokusy1[1].prvni_zaslani === false && pokusy1[0].uuid_zpravy !== pokusy1[1].uuid_zpravy;
    krok('ztracená odpověď → opakování (nové UUID, prvni_zaslani=false, stejná tržba) → POK (test, -ff)', okZtrata, { info: `POK ${poZtrate.pok}`, pokusy: pokusy1 });

    // 3) ostatní události: první odeslání
    await fronta.zpracovat({ limit: 20 });
    const po = await q('SELECT id, stav, pok, pok_test, varovani, porad_cis, celk_trzba, urceno_cerp_zuct, cerp_zuct, posledni_chyba FROM eet_udalosti ORDER BY id');
    for (const u of po) {
      const pk2 = await q('SELECT prvni_zaslani, vysledek, transakce_fs, kod_chyby, text_chyby FROM eet_pokusy WHERE udalost_id = $1 ORDER BY id', [u.id]);
      if (u.stav === 'rozhodnuti') { krok(`událost ${u.id}: darovaný kredit čeká na rozhodnutí, NEodeslána`, pk2.length === 0, { info: `${u.celk_trzba} Kč` }); continue; }
      const ok = u.stav === 'potvrzeno' && u.pok_test === true && /-ff$/.test(u.pok);
      krok(`událost ${u.id} (${u.porad_cis}, celk ${u.celk_trzba}, urceno ${u.urceno_cerp_zuct || '-'}, cerp ${u.cerp_zuct || '-'})`, ok,
        { info: ok ? `POK ${u.pok} (test)` + (u.varovani ? ` varování ${JSON.stringify(u.varovani)}` : '') : u.posledni_chyba, pokusy: pk2 });
    }
    // 4) potvrzené se znovu neodesílají
    const znovu = await fronta.zpracovat({ limit: 20 });
    krok('potvrzené události se znovu neodesílají', znovu.zpracovano === 0);

    // 5) okamžité odeslání přímo z požadavku pokladny (fronta běží, posluchač NOTIFY souběžně):
    //    odpověď prodeje nese POK z Playgroundu označený jako test, zpráva odešla právě jednou
    const fHlavni = new Fronta({ db: pool, konfig, log, intervalMs: 3600e3 });
    fronty.push(fHlavni);
    await fHlavni.spustit();
    eetFronta.nastavitHlavni(fHlavni);
    const zac = Date.now();
    const ihned = await zavolat(prodejna, 'post', '/', { body: { klic: 'pg-ihned-' + t, platba: 'karta', polozky: [pol(1000)], potvrdit_duplicitu: true } });
    const trvalo = Date.now() - zac;
    const e0 = ihned.body.eet && ihned.body.eet[0];
    const pokusyIhned = e0 ? await q('SELECT prvni_zaslani, vysledek FROM eet_pokusy WHERE udalost_id = $1', [e0.id]) : [];
    krok('okamžité odeslání z požadavku: prodej uložen a odpověď nese POK (test)', ihned.statusCode === 200 && e0 && e0.stav === 'potvrzeno'
      && e0.pok_test === true && e0.testovaci === true && pokusyIhned.length === 1 && pokusyIhned[0].prvni_zaslani === true,
    { info: e0 ? `${e0.stav}, POK ${e0.pok}, ${trvalo} ms, pokusů ${pokusyIhned.length}` : JSON.stringify(ihned.body).slice(0, 200) });
  } catch (e) {
    console.log = puvodniLog;
    krok('běh testu', false, { info: e.message });
    selhalo = true;
  } finally {
    console.log = puvodniLog;
    for (const f of fronty) await f.zastavit().catch(() => {});
    eetFronta.nastavitHlavni(null);
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
  selhalo = selhalo || zprava.kroky.some(k => !k.ok); // každý krok se vyhodnotí a zapíše, i po dřívějším selhání
  zprava.vysledek = selhalo ? 'SELHALO' : 'PROŠLO';
  console.log(`\nVýsledek proti Playgroundu: ${zprava.vysledek} (potvrzení z Playgroundu nejsou evidence tržeb)`);
  konec(selhalo ? 1 : 0);
}

main().catch(e => { console.error('Test nejde spustit:', e.message); process.exit(2); });
