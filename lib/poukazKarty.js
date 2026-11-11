// Plastové dárkové karty – znovupoužitelný nosič dárkového poukazu.
//
// Karta má natrvalo vytištěné číslo (DK-26-00481 = rok založení a pořadí,
// pořadí běží dál přes roky) a EAN-13 (prefix 23). Při prodeji
// se na ni "nahraje" nový poukaz (řádek v darkove_poukazy s karta_id), a od té
// chvíle načtení EAN karty znamená tento poukaz – v pokladně, při doplatku
// i v e-shopu. Zůstatek, čerpání po částech, platnost i tržby zůstávají
// u poukazu, takže se pro ně nic nemění.
//
// Stav karty se neukládá, odvozuje se z jejího aktuálního poukazu:
//   prazdna     – žádný poukaz, karta leží na pultu a jde prodat
//   nabita      – aktivní poukaz se zůstatkem a v platnosti
//   vycerpana   – poukaz je vyčerpaný  ┐ karta je zablokovaná, dokud ji
//   prosla      – poukaz po platnosti  │ majitelka ručně neuvolní
//   zrusena     – poukaz je zrušený    ┘ (pak je zase prazdna)
//   zablokovana – ručně zablokovaná (ztráta, krádež); poukaz na ní nejde použít

const { poukazPoPlatnosti, dnesVPraze } = require('./poukazPlatnost');

const PREFIX_EAN_KARTY = '23';
const STAVY_K_UVOLNENI = ['vycerpana', 'prosla', 'zrusena'];

function kontrolniCislice(zaklad12) {
  let soucet = 0;
  for (let i = 0; i < 12; i++) soucet += Number(zaklad12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (soucet % 10)) % 10);
}

function jePlatnyEan13(ean) {
  const s = String(ean == null ? '' : ean);
  return /^\d{13}$/.test(s) && kontrolniCislice(s.slice(0, 12)) === s[12];
}

function vygenerovatEanKarty() {
  let zaklad = PREFIX_EAN_KARTY;
  for (let i = 0; i < 10; i++) zaklad += Math.floor(Math.random() * 10);
  return zaklad + kontrolniCislice(zaklad);
}

// Číslo karty: DK-RR-NNNNN (RR = rok založení karty podle českého data)
function cisloKarty(poradi, ted = new Date()) {
  return 'DK-' + dnesVPraze(ted).slice(2, 4) + '-' + String(poradi).padStart(5, '0');
}

// Zadané číslo karty sjednotí do tvaru DK-RR-NNNNN: zvládne malá písmena,
// chybějící pomlčky i vynechané nuly (dk2600481, DK-26-481). Jiný text vrátí
// jen převedený na velká písmena (EAN, kód výrobce).
function normalizovatCisloKarty(text) {
  const s = String(text == null ? '' : text).trim().toUpperCase();
  const m = /^DK[-\s]?(\d{2})[-\s]?(\d{1,5})$/.exec(s);
  return m ? `DK-${m[1]}-${m[2].padStart(5, '0')}` : s;
}

function stavKarty(karta, poukaz, ted = new Date()) {
  if (karta.zablokovana) return 'zablokovana';
  if (!karta.aktualni_poukaz_id || !poukaz) return 'prazdna';
  if (poukaz.stav === 'zruseny') return 'zrusena';
  if (poukaz.stav === 'pouzity' || Number(poukaz.zustatek) <= 0) return 'vycerpana';
  if (poukazPoPlatnosti(poukaz.platnost_do, ted)) return 'prosla';
  return 'nabita';
}

// Najde poukaz podle kódu poukazu (DK-XXXX-XXXX), EAN poukazu nebo EAN karty.
// Vrací { poukaz, karta? } nebo { chyba, status }. S { zamknout: true } zamkne
// řádek poukazu (FOR UPDATE) – volat uvnitř transakce.
// Nejdřív se hledá poukaz stejným dotazem jako dřív, karta až když poukaz
// nenajde (EAN karet má jiný prefix, takže se nepletou).
async function najitPoukaz(db, zadanyKod, { zamknout = false } = {}) {
  const kod = String(zadanyKod == null ? '' : zadanyKod).trim().toUpperCase();
  if (!kod) return { chyba: 'Chybí kód poukazu.', status: 400 };
  const zamek = zamknout ? ' FOR UPDATE' : '';

  const poukaz = (await db.query('SELECT * FROM darkove_poukazy WHERE UPPER(kod) = $1 OR ean = $1' + zamek, [kod])).rows[0];
  if (poukaz) {
    if (poukaz.karta_id) {
      const karta = (await db.query('SELECT * FROM poukazove_karty WHERE id = $1', [poukaz.karta_id])).rows[0];
      if (karta && karta.zablokovana && karta.aktualni_poukaz_id === poukaz.id) {
        return { chyba: `Karta ${karta.cislo} s tímto poukazem je zablokovaná.`, status: 400, karta };
      }
    }
    return { poukaz };
  }

  const karta = (await db.query('SELECT * FROM poukazove_karty WHERE ean = $1', [kod])).rows[0];
  if (!karta) return { chyba: 'Poukaz nebyl nalezen.', status: 404 };
  if (karta.zablokovana) return { chyba: `Karta ${karta.cislo} je zablokovaná.`, status: 400, karta };
  if (!karta.aktualni_poukaz_id) return { chyba: `Na kartě ${karta.cislo} není nahraný žádný poukaz.`, status: 400, karta };
  const naKarte = (await db.query('SELECT * FROM darkove_poukazy WHERE id = $1' + zamek, [karta.aktualni_poukaz_id])).rows[0];
  if (!naKarte) return { chyba: 'Poukaz nebyl nalezen.', status: 404 };
  return { poukaz: naKarte, karta };
}

module.exports = {
  PREFIX_EAN_KARTY, STAVY_K_UVOLNENI,
  jePlatnyEan13, vygenerovatEanKarty, cisloKarty, normalizovatCisloKarty, stavKarty, najitPoukaz
};
