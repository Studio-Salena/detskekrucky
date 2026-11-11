#!/usr/bin/env node
// Založí testovací zásilku v PPL (CPL API) a uloží etiketu do PDF – pro schválení u podpory PPL.
//
// Spuštění (PowerShell), přístupové údaje jen v proměnných prostředí, ne v kódu:
//   $env:PPL_API_URL = 'https://api-dev.dhl.com/ecs/ppl/myapi2'
//   $env:PPL_CLIENT_ID = '...'
//   $env:PPL_CLIENT_SECRET = '...'
//   node scripts/ppl-testovaci-etiketa.js [soubor.pdf] [--a4 | --termo] [--dobirka]
//
// Na ostré adrese (api.dhl.com) skript odmítne běžet – založil by skutečnou zásilku.

const fs = require('fs');
const path = require('path');
const { vytvoritKlienta, stav } = require('../lib/ppl');

async function main() {
  const argy = process.argv.slice(2);
  const soubor = path.resolve(argy.find(a => !a.startsWith('--')) || 'etiketa.pdf');
  const format = argy.includes('--termo') ? 'Default' : 'A4';

  const s = stav();
  if (s.problem) throw new Error(s.problem);
  if (s.prostredi !== 'test') throw new Error('Skript je jen pro testovací prostředí PPL (api-dev.dhl.com).');

  const ppl = vytvoritKlienta();
  console.log('Získávám token…');
  await ppl.ziskatToken();
  console.log('Token OK. Zakládám testovací zásilku…');

  const vysledek = await ppl.zasilkaSEtiketou({
    referenceId: 'TEST-' + new Date().toISOString().slice(0, 19).replace(/\D/g, ''),
    produkt: argy.includes('--dobirka') ? 'PRID' : 'PRIV',
    format,
    poznamka: 'Testovaci zasilka Detske krucky',
    dobirka: argy.includes('--dobirka') ? { castka: 1290 } : null,
    prijemce: {
      name: 'Jana Testovací',
      street: 'Václavské náměstí 1',
      city: 'Praha',
      zipCode: '110 00',
      country: 'CZ',
      phone: '+420777123456',
      email: 'test@example.com'
    }
  });

  fs.writeFileSync(soubor, vysledek.pdf);
  console.log('batchId:', vysledek.batchId);
  console.log('Čísla zásilek:', vysledek.cislaZasilek.join(', ') || '(neuvedena)');
  console.log('Etiketa uložena:', soubor, `(${vysledek.pdf.length} B)`);
}

main().catch(e => {
  console.error('Chyba:', e.message);
  process.exit(1);
});
