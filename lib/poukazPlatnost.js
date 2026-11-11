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

// Platnost nově vydaného poukazu (i nabití plastové karty): 1 rok od vydání
// podle českého data – vydání 11. 11. 2026 v 0:30 platí do 11. 11. 2027 včetně.
function platnostNovehoPoukazu(ted = new Date()) {
  const dnes = dnesVPraze(ted);
  return new Date(Date.UTC(+dnes.slice(0, 4) + 1, +dnes.slice(5, 7) - 1, +dnes.slice(8, 10))).toISOString().slice(0, 10);
}

// true = poukaz už neplatí. Neznámé nebo nečitelné datum se bere jako neplatné.
function poukazPoPlatnosti(platnostDo, ted = new Date()) {
  const posledniDen = datumPlatnosti(platnostDo);
  if (!posledniDen) return true;
  return dnesVPraze(ted) > posledniDen;
}

// Prodloužení platnosti správcem (admin Dárkové poukazy). novyDen = 'RRRR-MM-DD'
// = nový poslední den platnosti včetně. Jde i u poukazu, který už propadl
// (majitelka se rozhodne vyjít zákazníkovi vstříc), ne u zrušeného nebo
// vyčerpaného. Nejvýš 2 roky od dneška. Vrací text chyby, nebo null.
function chybaProdlouzeni(poukaz, novyDen, ted = new Date()) {
  if (!poukaz) return 'Poukaz nebyl nalezen.';
  if (poukaz.stav === 'zruseny') return 'Zrušený poukaz nejde prodloužit.';
  if (poukaz.stav === 'pouzity' || !(Number(poukaz.zustatek) > 0)) return 'Vyčerpaný poukaz nejde prodloužit – nemá žádný zůstatek.';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(novyDen == null ? '' : novyDen));
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.toISOString().slice(0, 10) !== novyDen) return 'Neplatné datum.';
  const dosud = datumPlatnosti(poukaz.platnost_do);
  const dnes = dnesVPraze(ted);
  if (dosud && novyDen <= dosud) return 'Nové datum musí být pozdější než dosavadní platnost.';
  if (novyDen < dnes) return 'Nové datum nemůže být v minulosti.';
  const max = new Date(Date.UTC(+dnes.slice(0, 4) + 2, +dnes.slice(5, 7) - 1, +dnes.slice(8, 10))).toISOString().slice(0, 10);
  if (novyDen > max) return 'Platnost jde prodloužit nejvýš o 2 roky od dneška.';
  return null;
}

module.exports = { poukazPoPlatnosti, datumPlatnosti, dnesVPraze, chybaProdlouzeni, platnostNovehoPoukazu };
