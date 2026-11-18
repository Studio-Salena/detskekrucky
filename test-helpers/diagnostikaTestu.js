// Diagnostika testů proti PostgreSQL: při neúspěchu vypíše úplnou chybu, poslední volání API,
// serverový log (console.*) a databázové chyby – BEZ hesel a osobních údajů. Nic neopakuje:
// první neúspěch se nikdy neskryje, test selže stejně, jen s podklady k rozboru.
//
// Použití:
//   const diag = zalozitDiagnostiku('opravy', pool);
//   try { … diag.volani(metoda, cesta, req, res) … } catch (e) { await diag.vypsat(e); throw e; } finally { diag.konec(); }

const MAX = 400;

// odstraní přístupové údaje a e-maily (testová data jsou smyšlená, ale pro jistotu)
function ocistit(text) {
  return String(text)
    .replace(/(postgres(?:ql)?:\/\/)[^@\s/]*@/gi, '$1***@')
    .replace(/(password|heslo|secret|token|api[_-]?key)(["'\s:=]+)[^"'\s,}]+/gi, '$1$2***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***');
}

// aplikace = application_name poolu (podle něj se dohledají procesy v pg_stat_activity a v logu serveru)
function zalozitDiagnostiku(nazev, pool, aplikace = null) {
  const zaznam = [];
  const pridat = (druh, text) => { zaznam.push(`${new Date().toISOString().slice(11, 23)} ${druh} ${ocistit(text)}`); if (zaznam.length > MAX) zaznam.shift(); };
  const puvodni = { log: console.log, warn: console.warn, error: console.error };
  const formatovat = args => args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log = (...a) => pridat('LOG ', formatovat(a));
  console.warn = (...a) => pridat('WARN', formatovat(a));
  console.error = (...a) => pridat('ERR ', formatovat(a));
  pool.on('error', e => pridat('POOL', e.message));
  // databázové chyby z dotazů pool.query (kód, zpráva, místo) – dotazy přes klienta z pool.connect()
  // vrací aplikace v těle odpovědi (500 { chyba }), ty zachytí volani()
  const puvodniQuery = pool.query.bind(pool);
  pool.query = (...args) => {
    const p = puvodniQuery(...args);
    if (p && typeof p.catch === 'function') p.catch(e => pridat('DB  ', `${e.code || ''} ${e.message}${e.where ? ' | ' + e.where : ''}`));
    return p;
  };
  return {
    volani(metoda, cesta, req, res) {
      const telo = res.body && typeof res.body === 'object'
        ? JSON.stringify(res.body.chyba ? { chyba: res.body.chyba } : Object.fromEntries(Object.entries(res.body).filter(([k]) => ['id', 'stav', 'opakovane', 'vraceno'].includes(k))))
        : '';
      pridat('API ', `${metoda.toUpperCase()} ${cesta} klic=${(req.body && req.body.klic) || '-'} → ${res.statusCode} ${telo}`);
    },
    poznamka: text => pridat('KROK', text),
    async vypsat(chyba) {
      let pidy = [];
      if (aplikace) {
        try { pidy = (await pool.query('SELECT pid FROM pg_stat_activity WHERE application_name = $1 ORDER BY pid', [aplikace])).rows.map(x => x.pid); } catch (e) { pidy = ['nezjištěno: ' + e.message]; }
      }
      const radky = [
        `===== DIAGNOSTIKA TESTU „${nazev}“ (bez hesel a osobních údajů) =====`,
        'CHYBA: ' + ocistit(chyba && (chyba.stack || chyba.message) || chyba),
        chyba && chyba.actual !== undefined ? 'actual: ' + ocistit(JSON.stringify(chyba.actual)) : '',
        chyba && chyba.expected !== undefined ? 'expected: ' + ocistit(JSON.stringify(chyba.expected)) : '',
        `PID připojení k PostgreSQL (pro dohledání v logu serveru): ${pidy.join(', ') || '-'} (application_name ${aplikace || '-'})`,
        `----- posledních ${zaznam.length} záznamů (API, server, DB) -----`,
        ...zaznam,
        '===== KONEC DIAGNOSTIKY ====='
      ].filter(Boolean);
      process.stderr.write(radky.join('\n') + '\n');
    },
    konec() { Object.assign(console, puvodni); }
  };
}

module.exports = { zalozitDiagnostiku, ocistit };
