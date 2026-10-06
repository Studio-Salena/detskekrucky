// Startovní migrace (CREATE/ALTER TABLE) se spouští při načtení rout. Server
// začne přijímat požadavky až po jejich doběhnutí - jinak se první požadavky
// po restartu můžou s ALTER TABLE zablokovat (deadlock) a vrátit chybu.
// Na Renderu mezitím obsluhuje zákazníky ještě předchozí verze.

const cekajici = [];

// Zaregistruje startovní úlohu; chyba se neprojeví (každá migrace si ji loguje sama)
function pripravit(uloha) {
  cekajici.push(Promise.resolve(uloha).catch(() => {}));
  return uloha;
}

// Počká na všechny zaregistrované úlohy, nejdéle limitMs (zaseknutá DB nesmí
// zablokovat start serveru navždy). Vrací true, když vše doběhlo včas.
function vsePripraveno(limitMs = 30000) {
  let casovac;
  const limit = new Promise(r => { casovac = setTimeout(() => r(false), limitMs); });
  return Promise.race([Promise.all(cekajici).then(() => true), limit]).finally(() => clearTimeout(casovac));
}

module.exports = { pripravit, vsePripraveno };
