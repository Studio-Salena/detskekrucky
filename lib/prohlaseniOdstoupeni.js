// Text prohlášení o odstoupení od smlouvy (§ 1830a obč. zák.) - snapshot toho,
// co spotřebitel přes online formulář odeslal. Ukládá se do
// vratky_zadosti.prohlaseni_text jako důkaz obsahu prohlášení (§ 1839).
//
// Prostý text, ne HTML (při zobrazení se musí escapovat). Obsahuje jen údaje,
// které spotřebitel opravdu poslal (jméno, e-mail, důvod), a položky ověřené
// proti DB - nic se nedoplňuje z profilu ani odjinud. Čas sem nepatří, je
// v vratky_zadosti.vytvoreno (serverový čas přijetí).

// Jen neprázdný řetězec - cokoli jiného (undefined, null, objekt z podvrženého
// JSONu) se bere jako "nevyplněno", ať se do textu nedostane "undefined"/"[object Object]".
function vyplneno(hodnota) {
  return typeof hodnota === 'string' && hodnota.trim() !== '' ? hodnota.trim() : null;
}

function sestavitProhlaseniOdstoupeni({ cislo, objednavkaId, jmeno, email, polozky, duvod }) {
  const radky = ['Oznamuji, že tímto odstupuji od smlouvy o koupi tohoto zboží.'];
  // Zákaznické číslo (RRMMNN); staré objednávky bez čísla mají jen interní id
  radky.push(`Objednávka č.: ${vyplneno(cislo) || objednavkaId}`);
  const jmenoText = vyplneno(jmeno);
  if (jmenoText) radky.push(`Jméno: ${jmenoText}`);
  radky.push(`E-mail pro potvrzení: ${vyplneno(email) || ''}`.trimEnd());
  radky.push('Vracené zboží:');
  for (const p of polozky) {
    radky.push(`- ${p.nazev}, vel. ${p.velikost}, ${p.pocet} ks`);
  }
  const duvodText = vyplneno(duvod);
  if (duvodText) radky.push(`Důvod (nepovinný): ${duvodText}`);
  return radky.join('\n');
}

module.exports = { sestavitProhlaseniOdstoupeni };
