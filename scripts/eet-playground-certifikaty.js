#!/usr/bin/env node
// Reprodukovatelné získání OFICIÁLNÍCH testovacích certifikátů Playgroundu EET 2.0 – MIMO git.
//
//   node scripts/eet-playground-certifikaty.js <cílová složka mimo repozitář> [EIČ]
//   např. node scripts/eet-playground-certifikaty.js C:\mimo-git\eet-playground CZ00000019
//
// Co dělá:
//   1. stáhne balíček z oficiální stránky Dokumenty k EET 2.0 (eet.gov.cz) přes HTTPS s ověřením TLS
//   2. ověří SHA-256 proti otisku zapsanému v docs/eet-krok3.md (jiný otisk = STOP, balíček se
//      změnil – zkontrolujte novou verzi provozních informací a otisk aktualizujte vědomě)
//   3. rozbalí ho do cílové složky a PKCS#12 pro zvolené EIČ převede na PEM (openssl pkcs12
//      -legacy: soubory jsou šifrované RC2-40, které OpenSSL 3 bez -legacy odmítne)
//   4. ověří, že klíč patří k certifikátu, CN = EIČ a vydavatel je „playground EETv2 NCA SubCA“
//   5. vypíše proměnné pro scripts/eet-playground.js (heslo ani klíč nevypisuje)
// Testovací certifikáty jsou sdílené pro všechny vývojáře a platí jen pro Playground.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const URL_BALICKU = 'https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/CAEET_Playground_2026_v1.zip';
const SHA256_BALICKU = '711ca591e2e58e906212befab55ea72cbc5d960af49e444765b0428751002491'; // staženo 17. a 18. 11. 2026
const KOREN = path.join(__dirname, '..');

function stop(z, kod = 2) { console.error('STOP: ' + z); process.exit(kod); }
const cil = process.argv[2] ? path.resolve(process.argv[2]) : null;
const eic = (process.argv[3] || 'CZ00000019').trim();
if (!cil) stop('Zadejte cílovou složku MIMO repozitář.');
if (cil === KOREN || cil.startsWith(KOREN + path.sep)) stop('Cílová složka je uvnitř repozitáře – certifikáty a klíče do gitu nepatří.');
if (!/^CZ[0-9]{8,10}$/.test(eic)) stop('Neplatné EIČ.');

function stahnout(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { minVersion: 'TLSv1.2', headers: { 'User-Agent': 'eet-playground-certifikaty' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const casti = []; res.on('data', c => casti.push(c)); res.on('end', () => resolve(Buffer.concat(casti))); res.on('error', reject);
    }).on('error', reject);
  });
}

// Minimální čtení ZIP (centrální adresář; metody 0 = uloženo, 8 = deflate)
function rozbalit(zip) {
  const konecAdr = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (konecAdr < 0) throw new Error('Neplatný ZIP.');
  const pocet = zip.readUInt16LE(konecAdr + 10);
  let pos = zip.readUInt32LE(konecAdr + 16);
  const soubory = [];
  for (let i = 0; i < pocet; i++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('Neplatný centrální adresář ZIP.');
    const metoda = zip.readUInt16LE(pos + 10), velikost = zip.readUInt32LE(pos + 20);
    const delkaJmena = zip.readUInt16LE(pos + 28), delkaExtra = zip.readUInt16LE(pos + 30), delkaKom = zip.readUInt16LE(pos + 32);
    const lokalni = zip.readUInt32LE(pos + 42);
    const jmeno = zip.slice(pos + 46, pos + 46 + delkaJmena).toString('utf8');
    pos += 46 + delkaJmena + delkaExtra + delkaKom;
    if (jmeno.endsWith('/')) continue;
    const zacatek = lokalni + 30 + zip.readUInt16LE(lokalni + 26) + zip.readUInt16LE(lokalni + 28);
    const data = zip.slice(zacatek, zacatek + velikost);
    const obsah = metoda === 0 ? data : metoda === 8 ? zlib.inflateRawSync(data) : null;
    if (!obsah) throw new Error('Nepodporovaná komprese v ZIP: ' + metoda);
    const bezpecne = path.basename(jmeno); // žádné cesty ze ZIPu
    soubory.push({ jmeno: bezpecne, obsah });
  }
  return soubory;
}

(async () => {
  console.log('Stahuji ' + URL_BALICKU);
  const zip = await stahnout(URL_BALICKU).catch(e => stop('Stažení selhalo: ' + e.message));
  const otisk = crypto.createHash('sha256').update(zip).digest('hex');
  console.log('SHA-256 ' + otisk);
  if (otisk !== SHA256_BALICKU) stop(`Otisk balíčku se liší od očekávaného (${SHA256_BALICKU}). Balíček se změnil – ověřte novou verzi na eet.gov.cz a otisk aktualizujte vědomě (docs/eet-krok3.md).`);
  fs.mkdirSync(cil, { recursive: true });
  const soubory = rozbalit(zip);
  for (const s of soubory) fs.writeFileSync(path.join(cil, s.jmeno), s.obsah, { mode: 0o600 });
  const p12 = path.join(cil, `CA_EET-Playground-${eic}.p12`);
  const heslo = path.join(cil, 'password_pokladni_cert_playground.txt');
  if (!fs.existsSync(p12)) stop(`Balíček neobsahuje certifikát pro ${eic} (obsahuje: ${soubory.map(s => s.jmeno).join(', ')}).`);
  const certPem = path.join(cil, `pg-${eic}-cert.pem`), klicPem = path.join(cil, `pg-${eic}-klic.pem`);
  const ossl = a => execFileSync('openssl', a, { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    ossl(['pkcs12', '-legacy', '-in', p12, '-clcerts', '-nokeys', '-passin', 'file:' + heslo, '-out', certPem]);
    ossl(['pkcs12', '-legacy', '-in', p12, '-nocerts', '-nodes', '-passin', 'file:' + heslo, '-out', klicPem]);
  } catch (e) { stop('openssl pkcs12 selhal (je nainstalovaný OpenSSL 3 s -legacy?): ' + String(e.stderr || e.message).split('\n')[0]); }
  // výstup openssl obsahuje „Bag Attributes“ – uložit čisté PEM (jen certifikát / jen klíč)
  const cert = new crypto.X509Certificate(fs.readFileSync(certPem));
  const klic = crypto.createPrivateKey(fs.readFileSync(klicPem));
  fs.writeFileSync(certPem, cert.toString());
  fs.writeFileSync(klicPem, klic.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(klicPem, 0o600);
  const cn = (cert.subject.split('\n').find(s => s.startsWith('CN=')) || '').slice(3);
  if (!cert.checkPrivateKey(klic)) stop('Klíč nepatří k certifikátu.', 1);
  if (cn !== eic) stop(`CN certifikátu ${cn} ≠ ${eic}.`, 1);
  if (!/CN=playground EETv2 NCA SubCA RSA /.test(cert.issuer)) stop('Vydavatel není playground EETv2 NCA SubCA.', 1);
  console.log(`OK: ${eic}, vydavatel ${cert.issuer.split('\n')[0]}, platí do ${cert.validTo}`);
  console.log('\nPro scripts/eet-playground.js (PowerShell):');
  console.log(`  $env:EET_PROSTREDI = "playground"; $env:EET_EIC = "${eic}"; $env:EET_ID_PROVOZ = "11"; $env:EET_ID_POKL = "POKLADNA-TEST"`);
  console.log(`  $env:EET_CERT_PEM = "${certPem}"; $env:EET_KLIC_PEM = "${klicPem}"`);
})();
