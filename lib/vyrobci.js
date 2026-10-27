// Údaje o výrobci podle značky (nařízení GPSR, EU 2023/988, čl. 19): u výrobku
// nabízeného online musí být název a poštovní a elektronická adresa výrobce,
// u výrobce mimo EU i odpovědná osoba v EU, a případná upozornění.
// Zadává se jednou pro značku (admin Produkty -> Výrobci), e-shop je ukáže
// v detailu každé boty té značky.

// Klíč značky: bez diakritiky, malými písmeny, jedna mezera ("FRODDO " = "Froddo")
function klicZnacky(znacka) {
  return String(znacka || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const POLE = [
  { kod: 'vyrobce', nazev: 'Výrobce', max: 150 },
  { kod: 'adresa', nazev: 'Adresa výrobce', max: 300 },
  { kod: 'kontakt', nazev: 'E-mail nebo web výrobce', max: 200 },
  { kod: 'osoba_eu', nazev: 'Odpovědná osoba v EU', max: 400 },
  { kod: 'upozorneni', nazev: 'Upozornění', max: 1000 }
];

// Vše prázdné = smazat údaje značky. Jinak povinný výrobce, adresa a kontakt.
function overitVyrobce(telo) {
  const d = telo && typeof telo === 'object' ? telo : {};
  const znacka = typeof d.znacka === 'string' ? d.znacka.replace(/\s+/g, ' ').trim() : '';
  const klic = klicZnacky(znacka);
  if (!klic || znacka.length > 100) return { chyba: 'Chybí značka.' };
  const hodnoty = { klic, znacka };
  for (const p of POLE) {
    const v = d[p.kod] == null ? '' : d[p.kod];
    if (typeof v !== 'string') return { chyba: `${p.nazev}: neplatná hodnota.` };
    const t = v.trim();
    if (t.length > p.max) return { chyba: `${p.nazev}: nejvýš ${p.max} znaků.` };
    hodnoty[p.kod] = t || null;
  }
  const prazdne = POLE.every(p => !hodnoty[p.kod]);
  if (!prazdne && (!hodnoty.vyrobce || !hodnoty.adresa || !hodnoty.kontakt)) {
    return { chyba: 'Vyplňte výrobce, jeho adresu a e-mail nebo web (vyžaduje nařízení o bezpečnosti výrobků).' };
  }
  return { hodnoty, prazdne };
}

module.exports = { klicZnacky, overitVyrobce, POLE };
