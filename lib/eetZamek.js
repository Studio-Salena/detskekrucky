// Příprava na EET: doklady vzniklé od data EET_ZAMEK_OD (env, RRRR-MM-DD, český čas)
// se nesmí destruktivně měnit (mazat, přepisovat částky ani způsob platby) - opravit
// je jde jen navázaným záznamem (vratka, storno). Bez nastavené proměnné je zámek
// vypnutý a vše funguje jako dosud. Samotné odesílání do EET to nezapíná.

function zamcenoOd() {
  const s = String(process.env.EET_ZAMEK_OD || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00+01:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

// true, když doklad s daným datem spadá pod zámek
function jeZamceny(datum) {
  const od = zamcenoOd();
  if (!od || !datum) return false;
  return new Date(datum).getTime() >= od.getTime();
}

const CHYBA_ZAMKU = 'Doklad je z doby evidence tržeb – nejde ho smazat ani přepsat. Opravte ho vratkou nebo stornem.';

module.exports = { zamcenoOd, jeZamceny, CHYBA_ZAMKU };
