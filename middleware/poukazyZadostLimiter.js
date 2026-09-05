// Ochrana veřejné žádosti o dárkový poukaz proti spamu - stejný vzor jako
// middleware/rezervaceLimiter.js, jen s vlastním počítadlem.

const MAX_ZADOSTI = 5;
const OKNO_MS = 10 * 60 * 1000;
const BLOKACE_MS = 10 * 60 * 1000;

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

function zaznamenatZadost(ip) {
  const ted = Date.now();
  let data = pokusy.get(ip);
  if (!data || ted - data.od > OKNO_MS) {
    data = { pocet: 0, od: ted, blokovanoDo: 0 };
  }
  data.pocet++;
  if (data.pocet >= MAX_ZADOSTI) {
    data.blokovanoDo = ted + BLOKACE_MS;
  }
  pokusy.set(ip, data);
}

module.exports = { jeZablokovana, zaznamenatZadost };
