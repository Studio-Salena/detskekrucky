// Testovací server pro prohlížečové testy: skutečné routy aplikace nad DOČASNÝM schématem
// testovací databáze (TEST_PG_URL, E2E_SCHEMA). Žádné e-maily ani externí služby.
const path = require('node:path');
const fs = require('node:fs');
const KOREN = path.join(__dirname, '..');
const express = require(path.join(KOREN, 'node_modules', 'express'));
const { Pool } = require(path.join(KOREN, 'node_modules', 'pg'));
const { nacistRouterSMocky } = require(path.join(KOREN, 'test-helpers', '_pomocnik'));
const { vsePripraveno } = require(path.join(KOREN, 'lib', 'startServeru'));

const PORT = Number(process.env.PORT || 47123);
const SCHEMA = process.env.E2E_SCHEMA;
process.env.ADMIN_HESLO = 'test-heslo-e2e';
for (const k of Object.keys(process.env)) if (/^(RESEND|CLOUDINARY|ZASILKOVNA|GLS|PPL|STRIPE)/.test(k)) delete process.env[k];

async function main() {
  if (!/^e2e_[a-z0-9_]+$/.test(SCHEMA || '')) throw new Error('E2E_SCHEMA musí být e2e_…');
  const pool = new Pool({ connectionString: process.env.TEST_PG_URL, options: `-c search_path=${SCHEMA}` });
  await pool.query(`
    CREATE TABLE zakaznici (id SERIAL PRIMARY KEY, jmeno TEXT, email TEXT, telefon TEXT, ulice TEXT, mesto TEXT, psc TEXT);
    CREATE TABLE produkty (id SERIAL PRIMARY KEY, nazev TEXT, znacka TEXT, emoji TEXT, kategorie TEXT, cena NUMERIC, cena_puvodni NUMERIC,
      typ_nohy TEXT, popis TEXT, na_eshopu BOOLEAN DEFAULT true, cena_pred_slevou INTEGER);
    CREATE TABLE sklad (id SERIAL PRIMARY KEY, produkt_id INTEGER REFERENCES produkty(id), velikost TEXT, ean TEXT, pocet_kusu INTEGER,
      min_pocet INTEGER DEFAULT 0, delka_mm INTEGER, sirka_mm INTEGER, dostupnost TEXT DEFAULT 'skladem', UNIQUE (produkt_id, velikost));
    CREATE TABLE pohyby_skladu (id SERIAL PRIMARY KEY, produkt_id INTEGER, velikost TEXT, typ TEXT, pocet INTEGER, poznamka TEXT, datum TIMESTAMPTZ DEFAULT NOW(), vytvoreno TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE objednavky (id SERIAL PRIMARY KEY, zakaznik_id INTEGER REFERENCES zakaznici(id), stav TEXT DEFAULT 'nova', celkem NUMERIC, doprava TEXT, platba TEXT, poznamka TEXT, vytvoreno TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE objednavky_polozky (id SERIAL PRIMARY KEY, objednavka_id INTEGER, produkt_id INTEGER, velikost TEXT, pocet INTEGER);
    CREATE TABLE nastaveni (klic TEXT PRIMARY KEY, hodnota JSONB);
    INSERT INTO produkty (nazev, znacka, cena) VALUES ('Zimní bota', 'Testovací', 1200), ('Sandál', 'Testovací', 800);
    INSERT INTO sklad (produkt_id, velikost, ean, pocet_kusu) VALUES (1, '24', '8590000000011', 10), (2, '24.5', '8590000000028', 10);
  `);
  const mocky = { '../db/pool': pool, './emaily': new Proxy({}, { get: () => async () => {} }) };
  const routa = r => nacistRouterSMocky(path.join(KOREN, 'routes', r + '.js'), mocky);
  const app = express();
  app.use(express.json());
  app.post('/api/admin-prihlaseni', (req, res) => req.body.heslo === process.env.ADMIN_HESLO ? res.json({ ok: true }) : res.status(403).json({ chyba: 'Špatné heslo' }));
  // EET (jen scénář eet): testovací konfigurace a LOKÁLNÍ falešný FS (test-helpers/eetFs.js) – nic po síti
  let falesny = null;
  if (process.env.E2E_EET === '1') {
    const { konfigTest, falesnyFs } = require(path.join(KOREN, 'test-helpers', 'eetFs'));
    require(path.join(KOREN, 'lib', 'eetUdalosti')).nastavitKonfiguraci(konfigTest());
    falesny = falesnyFs();
    app.post('/__e2e/eet-scenare', (req, res) => { falesny.scenare.push(...req.body.scenare); res.json({ ok: true }); });
  }
  for (const [cesta, r] of [['prodejna', 'prodejna'], ['sklad', 'sklad'], ['poukazy', 'poukazy'], ['promo', 'promo'], ['objednavky', 'objednavky'], ['evidence-plateb', 'evidencePlateb'], ['eet', 'eet']]) {
    app.use('/api/' + cesta, routa(r));
  }
  app.use('/api', (req, res) => res.status(404).json([]));
  // admin.html s API na tento server (soubor v repozitáři se nemění)
  const sApi = html => html.replace("const API = 'https://detskekrucky1.onrender.com/api';", "const API = '/api';");
  app.get('/admin.html', (req, res) => res.type('html').send(sApi(fs.readFileSync(path.join(KOREN, 'admin.html'), 'utf8'))));
  app.get('/admin-stary.html', (req, res) => res.type('html').send(sApi(fs.readFileSync(process.env.STARY_ADMIN, 'utf8'))));
  app.use(express.static(KOREN));
  if (!(await vsePripraveno(30000))) throw new Error('migrace nedoběhly');
  // data až po migracích (tabulky poukazů a objednávek zakládají routy)
  await pool.query(`INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, stav, platnost_do, zakoupeno_kde, platba_stav)
    VALUES ('DK-TEST-0001', '2200000000019', 5000, 5000, 'aktivni', '2099-12-31', 'prodejna', 'historicky'),
           ('DK-TEST-0002', '2200000000026', 1000, 1000, 'aktivni', '2099-12-31', 'prodejna', 'historicky')`);
  await pool.query(`INSERT INTO zakaznici (jmeno, email) VALUES ('Jana Test', 'jana@example.com');
    INSERT INTO objednavky (zakaznik_id, stav, celkem, doprava, platba, cislo) VALUES (1, 'nova', 1200, 'osobni_odber', 'na_prodejne', 'E2E-1');
    INSERT INTO objednavky (zakaznik_id, stav, celkem, doprava, platba, cislo, obj_jmeno) VALUES (1, 'nova', 900, 'zasilkovna', 'prevod', 'E2E-2', 'Petr Prevod');
    INSERT INTO objednavky (zakaznik_id, stav, celkem, doprava, platba, cislo, dopravce, obj_jmeno) VALUES (1, 'odeslana', 1079, 'zasilkovna', 'dobirka', 'E2E-3', 'zasilkovna', 'Dana Dobirka');
    INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, druh, platba_stav, kupujici_jmeno)
      VALUES ('DK-CEKA-0001', '2100000000301', 500, 500, '2099-12-31', 'ceka_na_platbu', 'eshop', 'prodej', 'ceka', 'Eva Eshop'),
             ('DK-CEKA-0002', '2100000000318', 300, 300, '2099-12-31', 'ceka_na_platbu', 'eshop', 'prodej', 'ceka', 'Ota Eshop')`);
  if (falesny) {
    const eetFronta = require(path.join(KOREN, 'lib', 'eetFronta'));
    const { konfig } = require(path.join(KOREN, 'lib', 'eetUdalosti')).stavKonfigurace();
    const f = new eetFronta.Fronta({ db: pool, konfig, transport: falesny.transport, log: { log() {}, warn() {}, error() {} }, intervalMs: 3600e3 });
    await f.spustit();
    eetFronta.nastavitHlavni(f);
  }
  app.listen(PORT, () => console.log('PRIPRAVEN ' + PORT));
}
main().catch(e => { console.error('CHYBA', e); process.exit(1); });
