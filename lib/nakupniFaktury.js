// Nákupní faktury (faktury za nakoupené zboží): kontrola údajů z adminu a přepočet
// na Kč a DPH. Výpočet DPH je orientační přehled pro majitelku a účetní, ne podání.
//
// Režimy DPH:
//  - tuzemsko      dodavatel z ČR, částka faktury je včetně DPH -> základ a DPH se dopočítají
//  - eu_prenesena  dodavatel z EU, faktura bez DPH (přenesená daňová povinnost) ->
//                  DPH si odběratel sám vyměří ze základu (a případně nárokuje)
//  - dovoz         dodavatel mimo EU; DPH se platí při dovozu (celní řízení) -> ze základu
//  - bez_dph       bez DPH (např. dodavatel neplátce)

const REZIMY_DPH = {
  tuzemsko: 'Tuzemsko (cena s DPH)',
  eu_prenesena: 'EU – přenesená daňová povinnost',
  dovoz: 'Dovoz mimo EU',
  bez_dph: 'Bez DPH'
};
const MENY = ['CZK', 'EUR', 'USD', 'GBP', 'PLN', 'HUF', 'CHF'];
const SAZBY_DPH = [21, 12, 0];
const ZEME_EU = ['AT', 'BE', 'BG', 'CY', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const zaokrouhlit = n => Math.round(n * 100) / 100;
function platneDatum(s) {
  if (typeof s !== 'string' || !DATUM_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const text = (v, max) => (typeof v === 'string' ? v.trim() : '').slice(0, max);

// Výchozí režim podle země dodavatele
function vychoziRezim(zeme) {
  if (zeme === 'CZ') return 'tuzemsko';
  if (ZEME_EU.includes(zeme)) return 'eu_prenesena';
  return 'dovoz';
}

// Přepočet: částka v Kč a základ/DPH podle režimu
function spocitat({ castka, mena, kurz, rezim_dph, sazba_dph }) {
  const castkaCzk = zaokrouhlit(mena === 'CZK' ? castka : castka * kurz);
  if (rezim_dph === 'tuzemsko') {
    const zaklad = zaokrouhlit(castkaCzk / (1 + sazba_dph / 100));
    return { castka_czk: castkaCzk, zaklad_czk: zaklad, dph_czk: zaokrouhlit(castkaCzk - zaklad) };
  }
  if (rezim_dph === 'bez_dph') return { castka_czk: castkaCzk, zaklad_czk: castkaCzk, dph_czk: 0 };
  // přenesená povinnost / dovoz: faktura je bez DPH, DPH se počítá ze základu navíc
  return { castka_czk: castkaCzk, zaklad_czk: castkaCzk, dph_czk: zaokrouhlit(castkaCzk * sazba_dph / 100) };
}

function overitFakturu(telo) {
  if (!telo || typeof telo !== 'object') return { chyba: 'Chybí údaje faktury.' };
  const dodavatel = text(telo.dodavatel, 200);
  if (!dodavatel) return { chyba: 'Vyplňte dodavatele.' };
  const cislo = text(telo.cislo_faktury, 100);
  if (!cislo) return { chyba: 'Vyplňte číslo faktury.' };
  // kontrola celého textu (zkrácení "Chorvatsko" na "CH" by tiše znamenalo Švýcarsko)
  const zeme = (typeof telo.zeme === 'string' ? telo.zeme.trim() : '').toUpperCase() || 'CZ';
  if (!/^[A-Z]{2}$/.test(zeme)) return { chyba: 'Země dodavatele: dvoupísmenný kód (např. CZ, SK, HR).' };
  if (!platneDatum(telo.datum_vystaveni)) return { chyba: 'Vyplňte datum vystavení.' };
  for (const [pole, popis] of [['datum_splatnosti', 'Datum splatnosti'], ['datum_uhrady', 'Datum úhrady']]) {
    if (telo[pole] != null && telo[pole] !== '' && !platneDatum(telo[pole])) return { chyba: `${popis} není platné datum.` };
  }
  const mena = text(telo.mena, 3).toUpperCase() || 'CZK';
  if (!MENY.includes(mena)) return { chyba: 'Neznámá měna.' };
  const castka = Number(telo.castka);
  if (!Number.isFinite(castka) || castka <= 0 || castka > 100000000) return { chyba: 'Částka musí být kladné číslo.' };
  let kurz = 1;
  if (mena !== 'CZK') {
    kurz = Number(telo.kurz);
    if (!Number.isFinite(kurz) || kurz <= 0 || kurz > 10000) return { chyba: 'U cizí měny vyplňte kurz (kolik Kč za 1 ' + mena + ').' };
  }
  const rezim = telo.rezim_dph || vychoziRezim(zeme);
  if (!Object.hasOwn(REZIMY_DPH, rezim)) return { chyba: 'Neznámý režim DPH.' };
  const sazba = rezim === 'bez_dph' ? 0 : Number(telo.sazba_dph ?? 21);
  if (!SAZBY_DPH.includes(sazba)) return { chyba: 'Sazba DPH musí být 21, 12 nebo 0 %.' };
  const hodnoty = {
    dodavatel, zeme, cislo_faktury: cislo,
    datum_vystaveni: telo.datum_vystaveni,
    datum_splatnosti: telo.datum_splatnosti || null,
    datum_uhrady: telo.datum_uhrady || null,
    mena, castka: zaokrouhlit(castka), kurz, rezim_dph: rezim, sazba_dph: sazba,
    poznamka: text(telo.poznamka, 1000) || null
  };
  return { hodnoty: { ...hodnoty, ...spocitat(hodnoty) } };
}

module.exports = { REZIMY_DPH, MENY, SAZBY_DPH, ZEME_EU, vychoziRezim, spocitat, overitFakturu, platneDatum };
