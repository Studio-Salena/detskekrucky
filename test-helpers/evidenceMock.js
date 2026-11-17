// Paměťová obsluha dotazů evidence plateb (lib/evidencePlateb.js) pro mocky DB
// v unit testech. Zápisy si pamatuje (stav.evidence), čtení z nich počítá, takže
// testy můžou kontrolovat i obsah evidence. Skutečné chování (transakce, zámky,
// triggery) ověřují testy proti PostgreSQL. Vrací výsledek, nebo undefined,
// když dotaz nepatří evidenci.

function evidenceStav(stav) {
  if (!stav.evidence) stav.evidence = { platby: [], kredit_pohyby: [], platby_prirazeni: [], dobirky: [], operace: [], zahozene: [] };
  return stav.evidence;
}

const SLOUPCE = {
  platby: ['klic', 'typ', 'castka', 'zpusob', 'okolnosti', 'kontaktni', 'prijato_at', 'zdroj_typ', 'zdroj_id', 'urceno_k_cerpani', 'vraci_id', 'opravuje_id', 'poznamka'],
  kredit_pohyby: ['klic', 'poukaz_id', 'typ', 'castka', 'puvod', 'kontaktni', 'platba_id', 'zdroj_typ', 'zdroj_id', 'opravuje_id', 'eet_pravidlo', 'poznamka'],
  platby_prirazeni: ['klic', 'platba_id', 'objednavka_id', 'castka'],
  dobirky: ['klic', 'objednavka_id', 'platba_id', 'castka', 'dopravce']
};

function obsluhaEvidence(stav, s, params = []) {
  if (s.startsWith('SELECT pg_advisory_xact_lock')) return {};
  const e = evidenceStav(stav);

  // zahozené klíče a duplicita v pokladně
  if (s.startsWith('SELECT 1 FROM prodejna_klice_zahozene')) return { rows: e.zahozene.includes(params[0]) ? [{}] : [] };
  if (s.startsWith('INSERT INTO prodejna_klice_zahozene')) { if (!e.zahozene.includes(params[0])) e.zahozene.push(params[0]); return {}; }
  if (s.startsWith('SELECT id, datum FROM prodejna_prodeje WHERE obsah_otisk')) {
    const p = (stav.prodeje || []).filter(x => x.obsah_otisk === params[0]).slice(-1);
    return { rows: p.map(x => ({ id: x.id, datum: x.datum || new Date() })) };
  }

  // operace_klice
  if (s.startsWith('SELECT otisk, vysledek FROM operace_klice')) {
    const o = e.operace.find(x => x.oblast === params[0] && x.klic === params[1]);
    return { rows: o ? [o] : [] };
  }
  if (s.startsWith('INSERT INTO operace_klice')) { e.operace.push({ oblast: params[0], klic: params[1], otisk: params[2], vysledek: JSON.parse(params[3]) }); return {}; }

  // zápisy
  for (const tab of Object.keys(SLOUPCE)) {
    if (s.startsWith(`INSERT INTO ${tab} (`)) {
      const pole = e[tab === 'kredit_pohyby' ? 'kredit_pohyby' : tab];
      const klic = params[0];
      if (pole.some(r => r.klic === klic)) return { rows: [] };
      const row = { id: pole.length + 1, vytvoreno: new Date() };
      SLOUPCE[tab].forEach((k, i) => { row[k] = params[i] === undefined ? null : params[i]; });
      if (tab === 'platby' && !row.prijato_at) row.prijato_at = new Date();
      pole.push(row);
      return { rows: [row] };
    }
  }
  if (s.startsWith('SELECT * FROM platby WHERE klic')) return { rows: e.platby.filter(r => r.klic === params[0]) };
  if (s.startsWith('SELECT * FROM kredit_pohyby WHERE klic')) return { rows: e.kredit_pohyby.filter(r => r.klic === params[0]) };

  const nestornovane = (pole, r) => !pole.some(x => x.opravuje_id === r.id);
  if (s.startsWith('SELECT p.* FROM platby p WHERE p.zdroj_typ = $1 AND p.zdroj_id = $2 AND p.typ = \'prijem\'')) {
    return { rows: e.platby.filter(r => r.zdroj_typ === params[0] && Number(r.zdroj_id) === Number(params[1]) && r.typ === 'prijem' && nestornovane(e.platby, r)) };
  }
  if (s.startsWith("SELECT p.* FROM platby p WHERE p.zdroj_typ = 'prodej' AND p.zdroj_id = $1 AND p.typ = 'prijem'")) {
    return { rows: e.platby.filter(r => r.zdroj_typ === 'prodej' && Number(r.zdroj_id) === Number(params[0]) && r.typ === 'prijem' && nestornovane(e.platby, r)) };
  }
  if (s.startsWith("SELECT p.* FROM platby p WHERE p.zdroj_typ = 'vratka'")) {
    return { rows: e.platby.filter(r => r.zdroj_typ === 'vratka' && Number(r.zdroj_id) === Number(params[0]) && r.typ === 'vraceni' && nestornovane(e.platby, r)) };
  }
  if (s.startsWith('SELECT k.* FROM kredit_pohyby k')) {
    return { rows: e.kredit_pohyby.filter(r => r.zdroj_typ === params[0] && Number(r.zdroj_id) === Number(params[1]) && params[2].includes(r.typ) && nestornovane(e.kredit_pohyby, r)) };
  }
  if (s.startsWith('SELECT 1 FROM kredit_pohyby WHERE zdroj_typ')) {
    return { rows: e.kredit_pohyby.filter(r => r.zdroj_typ === 'prodej' && Number(r.zdroj_id) === Number(params[0])).slice(0, 1).map(() => ({})) };
  }
  const zdrojQ = /^SELECT id FROM platby WHERE zdroj_typ = '(\w+)' AND zdroj_id = \$1 AND typ = 'prijem'/.exec(s);
  if (zdrojQ) return { rows: e.platby.filter(r => r.zdroj_typ === zdrojQ[1] && Number(r.zdroj_id) === Number(params[0]) && r.typ === 'prijem').slice(0, 1) };
  if (s.startsWith('SELECT COUNT(*)::int n FROM platby WHERE zdroj_typ')) {
    return { rows: [{ n: e.platby.filter(r => r.zdroj_typ === 'prodej' && Number(r.zdroj_id) === Number(params[0])).length }] };
  }
  if (s.startsWith('SELECT COALESCE(SUM(CASE typ WHEN \'prijem\' THEN castka')) {
    const soucet = e.platby.filter(r => r.zdroj_typ === 'objednavka' && Number(r.zdroj_id) === Number(params[0]))
      .reduce((a, r) => a + (['prijem', 'storno_vraceni'].includes(r.typ) ? 1 : -1) * Number(r.castka), 0);
    return { rows: [{ vlastni: soucet, s: soucet }] };
  }
  if (s.startsWith('SELECT COALESCE(SUM(castka), 0) AS s FROM platby_prirazeni WHERE objednavka_id')) {
    return { rows: [{ s: e.platby_prirazeni.filter(r => Number(r.objednavka_id) === Number(params[0])).reduce((a, r) => a + Number(r.castka), 0) }] };
  }
  if (s.startsWith('SELECT 1 FROM dobirky WHERE objednavka_id')) return { rows: e.dobirky.filter(r => Number(r.objednavka_id) === Number(params[0])).map(() => ({})) };
  return undefined;
}

module.exports = { obsluhaEvidence, evidenceStav };
