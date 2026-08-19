// Jednoduchá ochrana proti hádání admin hesla - sleduje neúspěšné pokusy
// podle IP adresy v paměti serveru (bez další závislosti nebo DB tabulky).
// Úspěšné přihlášení / správné heslo se nikdy nepočítá jako pokus, takže
// běžné používání admina (desítky requestů se správným heslem) tím není
// nijak omezené - blokuje se jen opakované posílání ŠPATNÉHO hesla.

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

// Vrátí počet zbývajících sekund blokace, nebo 0 pokud IP zablokovaná není
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
