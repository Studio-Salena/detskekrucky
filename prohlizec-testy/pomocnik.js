// Společné pro prohlížečové testy (prohlizec-testy/README.md).
const path = require('node:path');

const KOREN = path.join(__dirname, '..');
const BASE = 'http://localhost:' + (process.env.PORT || 47123);

// playwright-core není závislost projektu: hledá se v PLAYWRIGHT_DIR, pak v node_modules projektu
function nacistPlaywright() {
  const kde = [process.env.PLAYWRIGHT_DIR, path.join(KOREN, 'node_modules')].filter(Boolean);
  for (const k of kde) {
    try { return require(require.resolve('playwright-core', { paths: [k] })); } catch { /* další */ }
  }
  console.error('Chybí playwright-core. Nainstalujte mimo projekt (npm install --prefix <složka> playwright-core@1.49.1)\n'
    + 'a nastavte PLAYWRIGHT_DIR=<složka>/node_modules, nebo jednorázově: npm install --no-save playwright-core@1.49.1');
  process.exit(2);
}

// DB klient do dočasného schématu testovacího serveru
function dbKlient() {
  const { Client } = require(path.join(KOREN, 'node_modules', 'pg'));
  return new Client({ connectionString: process.env.TEST_PG_URL, options: `-c search_path=${process.env.E2E_SCHEMA}` });
}

module.exports = { chromium: nacistPlaywright().chromium, dbKlient, BASE, KOREN };
