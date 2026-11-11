// Výměna zboží v prodejně (Prodejna → Vratky → Výměna).
//
// Zákazník vrátí zboží z dřívějšího nákupu a vezme si jiné. Účetně se do tržeb
// počítá jen to, co se opravdu zaplatilo nebo vrátilo:
//   - nový prodej: celkem = doplatek, vymena_castka = zápočet vráceného zboží
//   - vratka:      castka = peníze vrácené zákazníkovi (rozdíl, často 0),
//                  hodnota_zbozi = hodnota vráceného zboží
// Součty uzávěrek (prodeje.celkem − vratky.castka) tak bez dalších úprav sedí
// na skutečně přijaté peníze a hotovost v pokladně odpovídá.

const PLATBY = ['hotovost', 'karta', 'qr', 'prevod'];
const kc = n => Math.round(Number(n) * 100) / 100;

// zapocet = hodnota vráceného zboží (kolik zákazník původně zaplatil),
// nove = cena nového zboží. Vrací { kredit, doplatek, vraceno }.
function spocitatVymenu(zapocet, nove) {
  const z = kc(zapocet), n = kc(nove);
  const kredit = Math.min(z, n);
  return { kredit, doplatek: kc(n - kredit), vraceno: kc(z - kredit) };
}

function chybaPolozek(polozky, popis) {
  if (!Array.isArray(polozky) || !polozky.length) return `Chybí ${popis}.`;
  if (polozky.length > 50) return `Příliš mnoho položek (${popis}).`;
  for (const p of polozky) {
    if (!p || !Number.isInteger(p.produkt_id) || p.velikost === undefined || p.velikost === null || String(p.velikost).trim() === '') {
      return `Každá položka (${popis}) musí mít vybraný produkt a velikost.`;
    }
    if (!Number.isInteger(p.pocet) || p.pocet <= 0 || p.pocet > 100) return `Neplatný počet kusů (${popis}).`;
    const cena = Number(p.cena);
    if (!Number.isFinite(cena) || cena < 0 || cena > 1000000) return `Neplatná cena (${popis}).`;
  }
  return null;
}

const soucet = polozky => kc(polozky.reduce((s, p) => s + Number(p.pocet) * Number(p.cena), 0));

// Kontrola požadavku na výměnu bez databáze. Vrací { chyba } nebo spočítané částky.
function pripravitVymenu({ prodej_id, vracene, nove, zapocet, platba }) {
  if (!Number.isInteger(prodej_id) || prodej_id <= 0) return { chyba: 'Vyberte původní účtenku, ze které zákazník zboží vrací.' };
  const e1 = chybaPolozek(vracene, 'vrácené zboží'); if (e1) return { chyba: e1 };
  const e2 = chybaPolozek(nove, 'nové zboží'); if (e2) return { chyba: e2 };
  const z = Number(zapocet);
  if (!Number.isFinite(z) || z < 0) return { chyba: 'Neplatná hodnota vráceného zboží.' };
  const cenikVracene = soucet(vracene);
  if (kc(z) > cenikVracene) return { chyba: `Hodnota vráceného zboží (${kc(z)} Kč) nemůže být vyšší než jeho cena (${cenikVracene} Kč).` };
  const castky = spocitatVymenu(z, soucet(nove));
  if ((castky.doplatek > 0 || castky.vraceno > 0) && !PLATBY.includes(platba)) {
    return { chyba: castky.doplatek > 0 ? 'Vyberte, jak zákazník doplácí.' : 'Vyberte, jak jsme zákazníkovi vrátili rozdíl.' };
  }
  return { ...castky, zapocet: kc(z), noveCelkem: soucet(nove) };
}

// Dodatečný převod: vratka (peníze „vrácené“ na papíře) + nový prodej, který byl
// ve skutečnosti výměnou. Částky se přepočítají, celkový čistý příjem se nemění.
function prevodNaVymenu(vratka, prodej) {
  if (vratka.vymena_prodej_id) return { chyba: `Vratka #${vratka.id} už je výměnou.` };
  if (Number(prodej.vymena_castka) > 0) return { chyba: `Účtenka #${prodej.id} už je výměnou.` };
  if (Number(prodej.poukaz_castka) > 0) return { chyba: `Účtenka #${prodej.id} byla zčásti placená poukazem – výměnu u ní nejde zapsat dodatečně.` };
  if (prodej.platba === 'poukaz') return { chyba: `Účtenka #${prodej.id} byla placená poukazem – výměnu u ní nejde zapsat dodatečně.` };
  if (vratka.prodej_id && Number(vratka.prodej_id) === Number(prodej.id)) return { chyba: 'Vratka je ze stejné účtenky – vyberte účtenku nového nákupu.' };
  const den = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
  if (den(prodej.datum) < den(vratka.vytvoreno)) {
    return { chyba: `Účtenka #${prodej.id} je starší než vratka #${vratka.id} – nový nákup výměny musí být ze dne vratky nebo pozdější.` };
  }
  const castky = spocitatVymenu(Number(vratka.castka), Number(prodej.celkem));
  return {
    ...castky,
    prodejCelkem: castky.doplatek,
    vratkaCastka: castky.vraceno,
    zpusobVraceni: castky.vraceno > 0 ? (PLATBY.includes(prodej.platba) ? prodej.platba : null) : 'vymena'
  };
}

module.exports = { PLATBY, spocitatVymenu, pripravitVymenu, prevodNaVymenu, soucet };
