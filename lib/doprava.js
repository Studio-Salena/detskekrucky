// Způsoby dopravy a jejich ceny. Ceny a zapnutí spravuje majitelka v adminu
// (Nastavení -> Doprava, tabulka nastaveni klíč 'doprava'); tady jsou jen
// výchozí hodnoty = dosavadní ceny e-shopu. GLS je ve výchozím stavu vypnuté
// a BEZ ceny - zákazníkům se neukáže, dokud majitelka nezadá smluvní cenu.

const zasilkovna = require('./zasilkovna');

// Pevný seznam způsobů dopravy (kód = hodnota v objednavky.doprava).
// Měnit v adminu jde jen zapnutí a cenu, ne dopravce ani druh výdejního místa.
const METODY = {
  zasilkovna: { nazev: 'Zásilkovna', dopravce: 'zasilkovna', vydejniMisto: null },
  ceska_posta: { nazev: 'Česká pošta', dopravce: 'ceska_posta', vydejniMisto: null },
  osobni_odber: { nazev: 'Osobní odběr – prodejna Hulín', dopravce: 'osobni_odber', vydejniMisto: null, vzdyZdarma: true },
  gls_adresa: { nazev: 'GLS – doručení na adresu', dopravce: 'gls', vydejniMisto: null },
  gls_vydejni_misto: { nazev: 'GLS – doručení do výdejního místa', dopravce: 'gls', vydejniMisto: 'gls' }
};
const PORADI = ['zasilkovna', 'gls_adresa', 'gls_vydejni_misto', 'ceska_posta', 'osobni_odber'];

const VYCHOZI_NASTAVENI = {
  zdarmaOd: 2000,
  metody: {
    zasilkovna: { aktivni: true, cena: 79 },
    ceska_posta: { aktivni: true, cena: 89 },
    osobni_odber: { aktivni: true, cena: 0 },
    gls_adresa: { aktivni: false, cena: null },
    gls_vydejni_misto: { aktivni: false, cena: null }
  },
  // Příplatek za dobírku: dobírka se na e-shopu nabízí, jen když je vyplněný
  // (majitelka 2026-10-08: 40 Kč, nastavuje v adminu)
  priplatky: { dobirka: null }
};

const MAX_CENA = 10000;

// Uložené nastavení přes výchozí: nový způsob dopravy se objeví i u staršího uloženého nastavení
function sloucitNastaveni(ulozene) {
  const u = ulozene && typeof ulozene === 'object' ? ulozene : {};
  const metody = {};
  for (const kod of PORADI) {
    metody[kod] = { ...VYCHOZI_NASTAVENI.metody[kod], ...((u.metody || {})[kod] || {}) };
  }
  return {
    zdarmaOd: u.zdarmaOd === null || Number.isInteger(u.zdarmaOd) ? u.zdarmaOd : VYCHOZI_NASTAVENI.zdarmaOd,
    metody,
    priplatky: { ...VYCHOZI_NASTAVENI.priplatky, ...(u.priplatky || {}) }
  };
}

// Načte nastavení z DB. Když se čtení nepovede, platí výchozí (= dosavadní) ceny,
// ať výpadek nastavení nezastaví objednávky; chyba se zaloguje.
async function nacistNastaveniDopravy(db) {
  try {
    const r = await db.query("SELECT hodnota FROM nastaveni WHERE klic = 'doprava'");
    return sloucitNastaveni(r.rows.length ? r.rows[0].hodnota : null);
  } catch (e) {
    console.error('Nastavení dopravy se nepodařilo načíst, platí výchozí:', e.message);
    return sloucitNastaveni(null);
  }
}

const jeCena = v => v === null || (Number.isInteger(v) && v >= 0 && v <= MAX_CENA);

// Kontrola nastavení z adminu. Zapnout jde jen způsob s vyplněnou cenou.
function overitNastaveniDopravy(telo) {
  if (!telo || typeof telo !== 'object' || !telo.metody || typeof telo.metody !== 'object') return { chyba: 'Chybí nastavení dopravy.' };
  const nezname = Object.keys(telo.metody).filter(k => !Object.hasOwn(METODY, k));
  if (nezname.length) return { chyba: 'Neznámý způsob dopravy: ' + nezname.join(', ') };
  const metody = {};
  for (const kod of PORADI) {
    const m = telo.metody[kod];
    if (!m) { metody[kod] = { ...VYCHOZI_NASTAVENI.metody[kod] }; continue; }
    if (typeof m.aktivni !== 'boolean') return { chyba: `${METODY[kod].nazev}: chybí zapnuto/vypnuto.` };
    if (!jeCena(m.cena)) return { chyba: `${METODY[kod].nazev}: cena musí být celé číslo 0–${MAX_CENA} Kč, nebo prázdná.` };
    if (m.aktivni && m.cena === null) return { chyba: `${METODY[kod].nazev}: bez ceny nejde zapnout.` };
    metody[kod] = { aktivni: m.aktivni, cena: METODY[kod].vzdyZdarma ? 0 : m.cena };
  }
  if (!metody.zasilkovna.aktivni && !metody.gls_adresa.aktivni && !metody.gls_vydejni_misto.aktivni && !metody.ceska_posta.aktivni && !metody.osobni_odber.aktivni) {
    return { chyba: 'Aspoň jeden způsob dopravy musí zůstat zapnutý.' };
  }
  const zdarmaOd = telo.zdarmaOd;
  if (!(zdarmaOd === null || (Number.isInteger(zdarmaOd) && zdarmaOd >= 0 && zdarmaOd <= 1000000))) {
    return { chyba: 'Doprava zdarma od: celé číslo v Kč, nebo prázdné (nikdy zdarma).' };
  }
  const priplatky = { dobirka: null };
  const dobirka = telo.priplatky ? telo.priplatky.dobirka : null;
  if (!jeCena(dobirka === undefined ? null : dobirka)) return { chyba: 'Příplatek za dobírku: celé číslo v Kč, nebo prázdný.' };
  priplatky.dobirka = dobirka === undefined ? null : dobirka;
  return { hodnoty: { zdarmaOd, metody, priplatky } };
}

// Nabízený způsob = zapnutý a s cenou
function jeDostupna(nastaveni, kod) {
  const m = Object.hasOwn(METODY, kod) ? nastaveni.metody[kod] : null;
  return !!(m && m.aktivni && m.cena !== null);
}

// Cena dopravy podle nastavení (po slevě z poukazu); osobní odběr vždy zdarma
function vypocitatCenuDopravy(nastaveni, kod, mezisoucetPoSleve) {
  if (!jeDostupna(nastaveni, kod)) throw new Error('Nedostupný způsob dopravy: ' + kod);
  if (METODY[kod].vzdyZdarma) return 0;
  if (nastaveni.zdarmaOd !== null && mezisoucetPoSleve >= nastaveni.zdarmaOd) return 0;
  return nastaveni.metody[kod].cena;
}

// Druh výdejního místa u způsobu dopravy: 'gls', 'zasilkovna' (jen když je
// na Renderu API klíč Zásilkovny pro mapu míst), jinak null
function typVydejnihoMista(kod, env = process.env) {
  if (!Object.hasOwn(METODY, kod)) return null;
  if (kod === 'zasilkovna') return zasilkovna.apiKlic(env) ? 'zasilkovna' : null;
  return METODY[kod].vydejniMisto;
}

// Pro e-shop: jen nabízené způsoby, bez interních údajů. Klíč Zásilkovny je
// veřejný (potřebuje ho mapa míst v prohlížeči); API heslo se sem nikdy nedává.
function verejneNastaveni(nastaveni, env = process.env) {
  const metody = PORADI.filter(kod => jeDostupna(nastaveni, kod)).map(kod => ({
    kod, nazev: METODY[kod].nazev, cena: nastaveni.metody[kod].cena,
    vydejniMisto: typVydejnihoMista(kod, env), vzdyZdarma: !!METODY[kod].vzdyZdarma
  }));
  const vysledek = { zdarmaOd: nastaveni.zdarmaOd, metody, dobirka: nastaveni.priplatky.dobirka ?? null };
  if (metody.some(m => m.vydejniMisto === 'zasilkovna')) vysledek.zasilkovnaKlic = zasilkovna.apiKlic(env);
  return vysledek;
}

// Dobírka: jen když má příplatek a není to osobní odběr (tam se platí na prodejně)
function dobirkaDostupna(nastaveni, kod) {
  return nastaveni.priplatky.dobirka !== null && nastaveni.priplatky.dobirka !== undefined
    && jeDostupna(nastaveni, kod) && !METODY[kod].vzdyZdarma;
}
function priplatekPlatby(nastaveni, kod, platba) {
  return platba === 'dobirka' && dobirkaDostupna(nastaveni, kod) ? nastaveni.priplatky.dobirka : 0;
}

function nazevDopravy(kod) {
  return Object.hasOwn(METODY, kod) ? METODY[kod].nazev : kod;
}

module.exports = {
  METODY, PORADI, VYCHOZI_NASTAVENI, sloucitNastaveni, nacistNastaveniDopravy, overitNastaveniDopravy,
  jeDostupna, vypocitatCenuDopravy, verejneNastaveni, nazevDopravy, typVydejnihoMista, dobirkaDostupna, priplatekPlatby
};
