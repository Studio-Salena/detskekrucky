// Platnost dárkového poukazu - jedno pravidlo pro e-shop i prodejnu.
// Poukaz platí do data platnosti VČETNĚ (podmínky čl. 3 "do data platnosti
// uvedeného na poukazu", na poukazu "PLATNOST DO"), tedy celý poslední
// kalendářní den podle českého času; následující den už ne.
//
// darkove_poukazy.platnost_do je typ DATE. Knihovna pg ho bez vlastního parseru
// vrací jako Date o půlnoci v časovém pásmu serveru - kalendářní datum se proto
// čte místními gettery (ty vrátí přesně uložený den bez ohledu na pásmo serveru).
// Řetězec 'RRRR-MM-DD…' (např. z JSON) se bere tak, jak je.

const dvojmistne = n => String(n).padStart(2, '0');

function datumPlatnosti(platnostDo) {
  if (platnostDo instanceof Date) {
    if (Number.isNaN(platnostDo.getTime())) return null;
    return `${platnostDo.getFullYear()}-${dvojmistne(platnostDo.getMonth() + 1)}-${dvojmistne(platnostDo.getDate())}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(platnostDo == null ? '' : platnostDo));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Dnešní datum v Praze jako 'RRRR-MM-DD'
function dnesVPraze(ted = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ted);
}

// true = poukaz už neplatí. Neznámé nebo nečitelné datum se bere jako neplatné.
function poukazPoPlatnosti(platnostDo, ted = new Date()) {
  const posledniDen = datumPlatnosti(platnostDo);
  if (!posledniDen) return true;
  return dnesVPraze(ted) > posledniDen;
}

module.exports = { poukazPoPlatnosti, datumPlatnosti, dnesVPraze };
