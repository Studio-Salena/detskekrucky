// Jednoduchá ochrana proti spamu objednávek - sleduje počet odeslaných
// objednávek podle IP adresy v paměti serveru (stejný vzor jako loginLimiter.js,
// jen tady se počítá KAŽDÁ odeslaná objednávka, ne jen neúspěšné pokusy).

const MAX_OBJEDNAVEK = 5;
const OKNO_MS = 10 * 60 * 1000; // 10 minut, po kterých se počítadlo samo vynuluje
const BLOKACE_MS = 10 * 60 * 1000; // jak dlouho je IP po překročení limitu blokovaná

const pokusy = new Map(); // ip -> { pocet, od, blokovanoDo }

function vycistitStare() {
  const ted = Date.now();
  for (const [ip, data] of pokusy.entries()) {
    if (data.blokovanoDo < ted && ted - data.od > OKNO_MS) {
      pokusy.delete(ip);
    }
  }
}

// Vrátí počet zbývajících sekund blokace, nebo 0 pokud IP zablokovaná není
function jeZablokovana(ip) {
  vycistitStare();
  const data = pokusy.get(ip);
  if (data && data.blokovanoDo > Date.now()) {
    return Math.ceil((data.blokovanoDo - Date.now()) / 1000);
  }
  return 0;
}

function zaznamenatObjednavku(ip) {
  const ted = Date.now();
  let data = pokusy.get(ip);
  if (!data || ted - data.od > OKNO_MS) {
    data = { pocet: 0, od: ted, blokovanoDo: 0 };
  }
  data.pocet++;
  if (data.pocet >= MAX_OBJEDNAVEK) {
    data.blokovanoDo = ted + BLOKACE_MS;
  }
  pokusy.set(ip, data);
}

module.exports = { jeZablokovana, zaznamenatObjednavku };
