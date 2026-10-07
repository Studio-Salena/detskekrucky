// Příprava napojení na GLS (MyGLS API). Skutečné volání API ZATÍM NENÍ
// implementované: doplní se až podle aktuální dokumentace MyGLS a se
// skutečnými údaji od GLS. Do té doby vytvoreniZasilky() vždy odmítne.
//
// Přístupové údaje jsou JEN v proměnných prostředí na Renderu:
//   GLS_CLIENT_NUMBER, GLS_USERNAME, GLS_PASSWORD, GLS_API_URL,
//   GLS_WEBSHOP_ENGINE (nepovinné), GLS_ENABLED ('true' = zapnuto).
// Nikdy je neposílat do prohlížeče, neukládat do objednávek ani nelogovat.

const POVINNE = ['GLS_CLIENT_NUMBER', 'GLS_USERNAME', 'GLS_PASSWORD', 'GLS_API_URL'];

function nacistKonfiguraci(env = process.env) {
  const chybi = POVINNE.filter(k => !env[k] || !String(env[k]).trim());
  return {
    chybi,
    zapnuto: env.GLS_ENABLED === 'true',
    // hodnoty se drží jen tady v paměti serveru; ven jde jen stav()
    udaje: chybi.length ? null : {
      clientNumber: String(env.GLS_CLIENT_NUMBER).trim(),
      username: String(env.GLS_USERNAME).trim(),
      password: String(env.GLS_PASSWORD),
      apiUrl: String(env.GLS_API_URL).trim(),
      webshopEngine: env.GLS_WEBSHOP_ENGINE ? String(env.GLS_WEBSHOP_ENGINE).trim() : null
    }
  };
}

// Stav pro admin: jen ano/ne a NÁZVY chybějících proměnných, nikdy hodnoty
function stav(env = process.env) {
  const k = nacistKonfiguraci(env);
  return {
    nakonfigurovano: k.chybi.length === 0,
    zapnuto: k.zapnuto,
    chybejiciPromenne: k.chybi,
    apiImplementovano: false
  };
}

// Převod objednávky na data zásilky (pracovní tvar, nezávislý na API).
// Až bude dokumentace MyGLS, namapuje se na jejich formát v jednom místě.
function sestavitZasilku(objednavka) {
  if (!objednavka || objednavka.dopravce !== 'gls') throw new Error('Objednávka není doprava GLS.');
  const doVydejnihoMista = objednavka.doprava === 'gls_vydejni_misto';
  if (doVydejnihoMista && !objednavka.vydejni_misto_id) throw new Error('Objednávka nemá výdejní místo GLS.');
  const dobirka = objednavka.platba === 'dobirka' ? Number(objednavka.celkem) : 0;
  return {
    reference: objednavka.cislo || String(objednavka.id),
    prijemce: {
      jmeno: objednavka.obj_jmeno || '',
      email: objednavka.obj_email || '',
      telefon: objednavka.obj_telefon || '',
      ulice: objednavka.obj_ulice || '',
      mesto: objednavka.obj_mesto || '',
      psc: objednavka.obj_psc || '',
      stat: 'CZ'
    },
    // služba PSD = doručení do výdejního místa (ParcelShop/box), parametr = ID místa
    sluzby: doVydejnihoMista ? [{ kod: 'PSD', vydejniMistoId: objednavka.vydejni_misto_id }] : [],
    dobirka: { castka: dobirka, variabilniSymbol: dobirka ? (objednavka.cislo || '') : '' },
    pocetBaliku: 1
  };
}

// Vytvoření zásilky v MyGLS - zatím záměrně neimplementováno.
async function vytvoritZasilku(objednavka, env = process.env) {
  const k = nacistKonfiguraci(env);
  if (!k.zapnuto) throw new Error('GLS API je vypnuté (GLS_ENABLED).');
  if (k.chybi.length) throw new Error('GLS API není nastavené, chybí: ' + k.chybi.join(', '));
  sestavitZasilku(objednavka);
  throw new Error('GLS API zatím není implementované.');
}

module.exports = { stav, sestavitZasilku, vytvoritZasilku, nacistKonfiguraci };
