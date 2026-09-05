// Ochrana registrace proti hromadnému zakládání účtů - stejný vzor jako
// middleware/rezervaceLimiter.js/objednavkyLimiter.js (počítá se každý pokus
// o registraci, ne jen neúspěšné, protože i "úspěšné" registrace lze zneužít ke spamu).

const MAX_REGISTRACI = 8;
const OKNO_MS = 15 * 60 * 1000;
const BLOKACE_MS = 15 * 60 * 1000;

const pokusy = new Map(); // ip -> { pocet, od, blokovanoDo }

function vycistitStare() {
  const ted = Date.now();
  for (const [ip, data] of pokusy.entries()) {
    if (data.blokovanoDo < ted && ted - data.od > OKNO_MS) {
      pokusy.delete(ip);
    }
  }
}

function jeZablokovana(ip) {
  vycistitStare();
  const data = pokusy.get(ip);
  if (data && data.blokovanoDo > Date.now()) {
    return Math.ceil((data.blokovanoDo - Date.now()) / 1000);
  }
  return 0;
}

function zaznamenatRegistraci(ip) {
  const ted = Date.now();
  let data = pokusy.get(ip);
  if (!data || ted - data.od > OKNO_MS) {
    data = { pocet: 0, od: ted, blokovanoDo: 0 };
  }
  data.pocet++;
  if (data.pocet >= MAX_REGISTRACI) {
    data.blokovanoDo = ted + BLOKACE_MS;
  }
  pokusy.set(ip, data);
}

module.exports = { jeZablokovana, zaznamenatRegistraci };
