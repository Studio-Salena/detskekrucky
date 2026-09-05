// Ochrana přihlášení zákazníků proti hádání hesla - stejný vzor jako
// middleware/loginLimiter.js (pro admina), ale s vlastním počítadlem. Sdílet
// jedno počítadlo mezi admin loginem a zákaznickým loginem by znamenalo, že
// útok na jeden dokáže zablokovat i ten druhý ze stejné IP (např. sdílená
// firemní/NAT adresa).

const MAX_POKUSU = 10;
const OKNO_MS = 15 * 60 * 1000; // 15 minut, po které se počítadlo samo vynuluje
const BLOKACE_MS = 15 * 60 * 1000; // jak dlouho je IP po překročení limitu blokovaná

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

function zaznamenatNeuspech(ip) {
  const ted = Date.now();
  let data = pokusy.get(ip);
  if (!data || ted - data.od > OKNO_MS) {
    data = { pocet: 0, od: ted, blokovanoDo: 0 };
  }
  data.pocet++;
  if (data.pocet >= MAX_POKUSU) {
    data.blokovanoDo = ted + BLOKACE_MS;
  }
  pokusy.set(ip, data);
}

function resetovat(ip) {
  pokusy.delete(ip);
}

module.exports = { jeZablokovana, zaznamenatNeuspech, resetovat };
