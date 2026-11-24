#!/usr/bin/env node
// Sestaví balíček pro GitHub Pages: čistý adresář jen s výslovně povolenými soubory
// (scripts/web/verejne-soubory.js) a před publikováním ho zkontroluje.
//
//   node scripts/web/sestavit-web.js [vystup] [--prepsat]
//
// vystup   výchozí _site (v kořeni repozitáře); existující adresář se smaže jen když
//          se jmenuje _site, nebo s --prepsat
//
// Kontroly (jakákoli chyba = nenulový kód, workflow nic nepublikuje):
//   1. každý povolený soubor v repozitáři existuje a je v gitu (v CI se publikuje jen to, co je v gitu),
//   2. v balíčku není nic mimo seznam ani nic ze zakázaných cest,
//   3. žádný publikovaný soubor neobsahuje tajný údaj (klíč, heslo k DB…),
//   4. každý místní odkaz ze stránek, skriptů, robots.txt, sitemap.xml a odkazy na web
//      z e-mailů a faktur (lib/, routes/) vedou na soubor, který v balíčku je.
//
// Používá jen vestavěné moduly Node - workflow nepotřebuje npm install.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { SOUBORY, OVEROVACI_VZORY, ZAKAZANE_VZORY, ZAKAZANY_OBSAH, NE_ODKAZY } = require('./verejne-soubory');

const KOREN = path.resolve(__dirname, '..', '..');
const DOMENA = /https?:\/\/(?:www\.)?detskekrucky\.cz(\/[^\s'"`<>)\\]*)?/g;
const PRIPONA_SOUBORU = 'png|jpe?g|gif|svg|webp|ico|js|mjs|css|html|pdf|json|xml|txt|woff2?|ttf|otf|mp4|webm';

// Cesta s lomítky (i na Windows)
const posix = p => p.split(path.sep).join('/');

function vsechnySoubory(adresar, zaklad = adresar) {
  const vysledek = [];
  for (const polozka of fs.readdirSync(adresar, { withFileTypes: true })) {
    const plna = path.join(adresar, polozka.name);
    if (polozka.isDirectory()) vysledek.push(...vsechnySoubory(plna, zaklad));
    else vysledek.push(posix(path.relative(zaklad, plna)));
  }
  return vysledek.sort();
}

function souboryVGitu(koren) {
  try {
    const vystup = execFileSync('git', ['ls-files', '-z'], { cwd: koren, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(vystup.split('\0').filter(Boolean));
  } catch {
    return null; // bez gitu (např. rozbalený archiv) se tahle kontrola přeskočí
  }
}

// Ověřovací soubory vyhledávačů, které v kořeni repozitáře opravdu jsou
function overovaciSoubory(koren) {
  return fs.readdirSync(koren, { withFileTypes: true })
    .filter(p => p.isFile() && OVEROVACI_VZORY.some(v => v.test(p.name)))
    .map(p => p.name);
}

function povoleneSoubory(koren) {
  return [...new Set([...SOUBORY, ...overovaciSoubory(koren)])].sort();
}

function pripravitVystup(vystup, { prepsat }) {
  const cil = path.resolve(vystup);
  const rel = path.relative(cil, KOREN);
  // Výstup nesmí být repozitář ani adresář nad ním (smazání by vzalo i zdroje)
  if (cil === KOREN || !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`Výstup ${cil} je repozitář nebo adresář nad ním - odmítnuto.`);
  }
  if (fs.existsSync(cil)) {
    if (path.basename(cil) !== '_site' && !prepsat) {
      throw new Error(`Výstup ${cil} už existuje. Smažu ho jen když se jmenuje _site, nebo s --prepsat.`);
    }
    fs.rmSync(cil, { recursive: true, force: true });
  }
  fs.mkdirSync(cil, { recursive: true });
  return cil;
}

function sestavit({ koren = KOREN, vystup }) {
  const chyby = [];
  const vGitu = souboryVGitu(koren);
  for (const soubor of povoleneSoubory(koren)) {
    const zdroj = path.join(koren, soubor);
    if (!fs.existsSync(zdroj) || !fs.statSync(zdroj).isFile()) {
      chyby.push(`Chybí povolený soubor ${soubor} (je v seznamu, ale v repozitáři není).`);
      continue;
    }
    if (vGitu && !vGitu.has(soubor)) {
      chyby.push(`Soubor ${soubor} není v gitu - na GitHubu by chyběl.`);
      continue;
    }
    const cil = path.join(vystup, soubor);
    fs.mkdirSync(path.dirname(cil), { recursive: true });
    fs.copyFileSync(zdroj, cil);
  }
  return chyby;
}

// --- Odkazy ---------------------------------------------------------------

function odkazyVTextu(text, { html }) {
  const nalezene = [];
  const pridat = (hodnota, druh) => nalezene.push({ hodnota: hodnota.trim(), druh });
  if (html) {
    for (const m of text.matchAll(/\b(?:src|href|poster|data-src|action)\s*=\s*(["'])(.*?)\1/gis)) pridat(m[2], 'atribut');
    for (const m of text.matchAll(/\bsrcset\s*=\s*(["'])(.*?)\1/gis)) {
      for (const cast of m[2].split(',')) pridat(cast.trim().split(/\s+/)[0] || '', 'srcset');
    }
    for (const m of text.matchAll(/http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url=([^"']+)["']/gi)) pridat(m[1], 'meta refresh');
  }
  for (const m of text.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/g)) pridat(m[2], 'css url()');
  // Řetězce ve skriptech, které jsou jménem místního souboru ('fonts/DejaVuSans-bold.js', 'logo.jpg')
  const literal = new RegExp(`(["'\`])((?:\\.{0,2}/)?[A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:${PRIPONA_SOUBORU}))\\1`, 'g');
  for (const m of text.matchAll(literal)) pridat(m[2], 'řetězec ve skriptu');
  for (const m of text.matchAll(DOMENA)) pridat(m[0], 'adresa webu');
  return nalezene;
}

// Odkaz → cesta v balíčku, nebo null, když nejde o místní soubor
function prevestOdkaz(hodnota, zeSouboru) {
  let h = hodnota;
  if (!h || h.startsWith('#') || h.includes('${') || h.includes('{{') || h.includes('+')) return null;
  const naWeb = h.match(/^https?:\/\/(?:www\.)?detskekrucky\.cz(\/.*)?$/i);
  if (naWeb) h = naWeb[1] || '/';
  else if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null; // jiný web, mailto:, tel:, data:, javascript:
  h = h.split('#')[0].split('?')[0];
  if (!h) return null;
  try { h = decodeURIComponent(h); } catch { /* ponechat */ }
  const zaklad = h.startsWith('/') ? '' : path.posix.dirname(zeSouboru);
  // jako prohlížeč: ../ nad kořen webu zůstane v kořeni
  let cesta = path.posix.normalize(path.posix.join('/', zaklad, h)).slice(1);
  if (cesta === '' || cesta.endsWith('/')) cesta += 'index.html';
  return { cesta };
}

// GitHub Pages vrací /eshop i pro eshop.html a /stromecek pro stromecek/index.html
function existujeNaWebu(cesta, mnozina) {
  return mnozina.has(cesta) || mnozina.has(cesta + '.html') || mnozina.has(cesta.replace(/\/?$/, '/index.html'));
}

function zkontrolovat(vystup, { koren = KOREN, povolene = povoleneSoubory(koren) } = {}) {
  const chyby = [];
  const vBalicku = vsechnySoubory(vystup);
  const mnozina = new Set(vBalicku);
  const povoleneMnozina = new Set(povolene);

  // 2. jen povolené cesty, nic zakázaného
  for (const soubor of vBalicku) {
    if (!povoleneMnozina.has(soubor)) chyby.push(`V balíčku je soubor mimo seznam: ${soubor}`);
    for (const { vzor, duvod } of ZAKAZANE_VZORY) {
      if (vzor.test(soubor)) chyby.push(`Zakázaný obsah v balíčku: ${soubor} (${duvod})`);
    }
  }
  for (const soubor of povolene) {
    if (!mnozina.has(soubor)) chyby.push(`V balíčku chybí potřebný soubor: ${soubor}`);
  }

  // 3. tajné údaje v obsahu
  const textove = vBalicku.filter(s => /\.(html|js|css|txt|xml|json|svg)$/i.test(s) || s === 'CNAME');
  const obsahy = new Map();
  for (const soubor of textove) {
    const text = fs.readFileSync(path.join(vystup, soubor), 'utf8');
    obsahy.set(soubor, text);
    for (const { vzor, duvod } of ZAKAZANY_OBSAH) {
      if (vzor.test(text)) chyby.push(`Soubor ${soubor} obsahuje zakázaný údaj: ${duvod}`);
    }
  }

  // 4. místní odkazy
  const chybejici = new Map(); // cesta -> [odkud]
  const zaznamenat = (cesta, odkud) => {
    if (!chybejici.has(cesta)) chybejici.set(cesta, []);
    chybejici.get(cesta).push(odkud);
  };
  let pocetOdkazu = 0;
  for (const [soubor, text] of obsahy) {
    if (!/\.(html|js|css)$/i.test(soubor)) continue;
    const vyjimky = NE_ODKAZY[soubor] || {};
    for (const { hodnota, druh } of odkazyVTextu(text, { html: soubor.endsWith('.html') })) {
      if (Object.hasOwn(vyjimky, hodnota)) continue;
      const odkaz = prevestOdkaz(hodnota, soubor);
      if (!odkaz) continue;
      pocetOdkazu++;
      if (!existujeNaWebu(odkaz.cesta, mnozina)) zaznamenat(odkaz.cesta, `${soubor} (${druh}: ${hodnota})`);
    }
  }
  // robots.txt a sitemap.xml
  for (const m of (obsahy.get('robots.txt') || '').matchAll(/^Sitemap:\s*(\S+)/gmi)) {
    const odkaz = prevestOdkaz(m[1], 'robots.txt');
    pocetOdkazu++;
    if (!odkaz || !existujeNaWebu(odkaz.cesta, mnozina)) zaznamenat(odkaz ? odkaz.cesta : m[1], 'robots.txt (Sitemap)');
  }
  for (const m of (obsahy.get('sitemap.xml') || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const odkaz = prevestOdkaz(m[1], 'sitemap.xml');
    pocetOdkazu++;
    if (!odkaz || !existujeNaWebu(odkaz.cesta, mnozina)) zaznamenat(odkaz ? odkaz.cesta : m[1], 'sitemap.xml (<loc>)');
  }
  // Odkazy na web z e-mailů, faktur a backendu (lib/, routes/, index.js) - tyhle soubory se
  // nepublikují, ale musí na webu najít, na co odkazují (logo v e-mailu, VOP…)
  for (const zdroj of ['lib', 'routes', 'index.js']) {
    const plna = path.join(koren, zdroj);
    if (!fs.existsSync(plna)) continue;
    const soubory = fs.statSync(plna).isDirectory() ? vsechnySoubory(plna).map(s => path.join(zdroj, s)) : [zdroj];
    for (const s of soubory.filter(x => x.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(koren, s), 'utf8');
      for (const m of text.matchAll(DOMENA)) {
        const odkaz = prevestOdkaz(m[0], '');
        if (!odkaz) continue;
        pocetOdkazu++;
        if (!existujeNaWebu(odkaz.cesta, mnozina)) zaznamenat(odkaz.cesta, `${posix(s)} (adresa webu: ${m[0]})`);
      }
    }
  }
  for (const [cesta, odkud] of chybejici) {
    chyby.push(`Odkaz na chybějící soubor ${cesta} – ${odkud.slice(0, 3).join('; ')}${odkud.length > 3 ? ` a ${odkud.length - 3} dalších` : ''}`);
  }

  return { chyby, soubory: vBalicku, pocetOdkazu };
}

function souhrn(vystup, soubory) {
  let celkem = 0;
  const radky = soubory.map(s => {
    const data = fs.readFileSync(path.join(vystup, s));
    celkem += data.length;
    const otisk = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
    return `  ${s.padEnd(34)} ${String(data.length).padStart(9)} B  ${otisk}`;
  });
  return { radky, celkem };
}

function main(argv) {
  const prepsat = argv.includes('--prepsat');
  const vystupArg = argv.find(a => !a.startsWith('--')) || path.join(KOREN, '_site');
  let vystup;
  try {
    vystup = pripravitVystup(vystupArg, { prepsat });
  } catch (e) {
    console.error(`✖ ${e.message}`);
    return 1;
  }
  const chybySestaveni = sestavit({ vystup });
  const { chyby, soubory, pocetOdkazu } = zkontrolovat(vystup);
  const vse = [...chybySestaveni, ...chyby];
  const { radky, celkem } = souhrn(vystup, soubory);
  console.log(`Balíček pro GitHub Pages: ${vystup}`);
  console.log(radky.join('\n'));
  console.log(`Souborů: ${soubory.length}, celkem ${(celkem / 1024 / 1024).toFixed(2)} MB, zkontrolovaných místních odkazů: ${pocetOdkazu}`);
  if (vse.length) {
    console.error(`\n✖ SESTAVENÍ ZASTAVENO – ${vse.length} chyb:`);
    for (const c of vse) console.error(`  - ${c}`);
    return 1;
  }
  console.log('✔ Kontroly prošly: jen povolené soubory, nic zakázaného, všechny místní odkazy existují.');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { sestavit, zkontrolovat, povoleneSoubory, odkazyVTextu, prevestOdkaz, pripravitVystup, main };
