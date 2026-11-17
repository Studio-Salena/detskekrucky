#!/usr/bin/env node
// Spustí prohlížečové testy hlavních scénářů pokladny a evidence plateb (README.md).
//   TEST_PG_URL=postgres://uzivatel@localhost:5432/dk_test node prohlizec-testy/spustit.js [pokladna odber ucetnictvi stary-admin]
// Každý test dostane vlastní testovací server a vlastní dočasné schéma (po testu se smaže).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const KOREN = path.join(__dirname, '..');
const URL_DB = process.env.TEST_PG_URL;
function stop(z) { console.error('STOP: ' + z); process.exit(2); }
if (!URL_DB) stop('Nastavte TEST_PG_URL (lokální testovací databáze, nikdy produkce).');
const cil = new URL(URL_DB);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(cil.hostname)) stop('TEST_PG_URL musí být lokální databáze.');
if (!/test|e2e/i.test(cil.pathname)) stop('Název databáze v TEST_PG_URL musí obsahovat „test“ nebo „e2e“.');

const VSECHNY = ['pokladna', 'odber', 'ucetnictvi', 'stary-admin'];
const vybrane = process.argv.slice(2).length ? process.argv.slice(2) : VSECHNY;
const { Client } = require(path.join(KOREN, 'node_modules', 'pg'));

// staré okno administrace (před atomickým prodejem) pro test stary-admin
function staryAdmin() {
  const soubor = path.join(os.tmpdir(), 'dk-admin-stary-98593ee.html');
  if (!fs.existsSync(soubor)) fs.writeFileSync(soubor, execFileSync('git', ['show', '98593ee:admin.html'], { cwd: KOREN }));
  return soubor;
}

function spustitProces(soubor, env, cekatNa) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [soubor], { env: { ...process.env, ...env }, cwd: KOREN });
    let vystup = '';
    p.stdout.on('data', d => { vystup += d; if (cekatNa && vystup.includes(cekatNa)) resolve({ p, vystup }); if (!cekatNa) process.stdout.write(d); });
    p.stderr.on('data', d => { vystup += d; if (!cekatNa) process.stderr.write(d); });
    p.on('exit', kod => resolve({ p, vystup, kod }));
  });
}

(async () => {
  const admin = new Client({ connectionString: URL_DB });
  await admin.connect();
  const vysledky = [];
  let port = 47300;
  for (const nazev of vybrane) {
    if (!VSECHNY.includes(nazev)) stop('Neznámý test: ' + nazev);
    const schema = `e2e_${nazev.replace(/-/g, '_')}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const env = { E2E_SCHEMA: schema, PORT: String(++port), STARY_ADMIN: nazev === 'stary-admin' ? staryAdmin() : '' };
    const server = await spustitProces(path.join(__dirname, 'server.js'), env, 'PRIPRAVEN');
    if (server.kod != null) { vysledky.push([nazev, 'server nenaběhl']); console.error(server.vystup); continue; }
    console.log(`\n== ${nazev}`);
    const t = await spustitProces(path.join(__dirname, nazev + '.js'), env, null);
    server.p.kill();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    vysledky.push([nazev, t.kod === 0 ? 'OK' : 'SELHALO']);
  }
  await admin.end();
  console.log('\nVýsledek:');
  for (const [n, v] of vysledky) console.log(`  ${v === 'OK' ? '✔' : '✖'} ${n}: ${v}`);
  process.exit(vysledky.every(([, v]) => v === 'OK') ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
