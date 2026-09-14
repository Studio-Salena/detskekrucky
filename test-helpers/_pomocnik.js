// Sdílené testovací pomůcky - žádná nová závislost (jen node:test + node:assert).
// Místo skutečné DB se do require cache podstrčí falešný "pool"/"emaily" modul,
// takže testujeme reálný route handler z routes/objednavky.js, ale bez sítě/DB.
// Soubor záměrně NENÍ ve složce test/, aby ho `node --test` nesebral jako testovací soubor.

function nacistRouterSMocky(routeRelPath, mocky) {
  const routePath = require.resolve(routeRelPath);
  const puvodni = {};
  for (const [relPath, exportsObj] of Object.entries(mocky)) {
    const absPath = require.resolve(relPath, { paths: [require.resolve(routeRelPath).replace(/[^/\\]+$/, '')] });
    puvodni[absPath] = require.cache[absPath];
    require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports: exportsObj };
  }
  delete require.cache[routePath];
  const router = require(routePath);
  for (const absPath of Object.keys(puvodni)) {
    delete require.cache[absPath];
  }
  delete require.cache[routePath];
  return router;
}

function najitHandler(router, method, urlPath) {
  const layer = router.stack.find(l => l.route && l.route.path === urlPath && l.route.methods[method]);
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${urlPath} nenalezena`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function vytvoritRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (kod) { res.statusCode = kod; return res; };
  res.json = function (telo) { res.body = telo; return res; };
  return res;
}

// Jednoduchá in-memory "DB" - stačí pokrýt dotazy, které routes/objednavky.js
// skutečně posílá. Rozpoznává se podle charakteristické podřetězce v SQL.
function vytvoritMockClient(stav) {
  return {
    rolledBack: false,
    committed: false,
    release() {},
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (stav.callLog) stav.callLog.push({ sql: s, params });

      if (s.startsWith('ALTER TABLE')) return {};
      if (s.startsWith('BEGIN')) return {};
      if (s.startsWith('COMMIT')) { this.committed = true; return {}; }
      if (s.startsWith('ROLLBACK')) { this.rolledBack = true; return {}; }

      if (s.startsWith('SELECT id FROM zakaznici')) {
        const [email] = params;
        const z = stav.zakaznici.find(z => z.email === email);
        return { rows: z ? [{ id: z.id }] : [] };
      }
      if (s.startsWith('INSERT INTO zakaznici')) {
        const [jmeno, email, telefon, ulice, mesto, psc] = params;
        const id = stav.dalsiZakaznikId++;
        stav.zakaznici.push({ id, jmeno, email, telefon, ulice, mesto, psc });
        return { rows: [{ id }] };
      }
      if (s.startsWith('UPDATE zakaznici SET')) {
        return {};
      }

      if (s.includes('FROM sklad s JOIN produkty p')) {
        const [produkt_id, velikost] = params;
        const radek = stav.sklad.find(r => r.produkt_id === produkt_id && r.velikost === velikost);
        return { rows: radek ? [{ pocet_kusu: radek.pocet_kusu, dostupnost: radek.dostupnost, cena: radek.cena }] : [] };
      }

      if (s.startsWith('SELECT * FROM darkove_poukazy')) {
        const [kod] = params;
        const p = stav.poukazy.find(p => p.kod.toUpperCase() === kod || p.ean === kod);
        return { rows: p ? [p] : [] };
      }
      if (s.startsWith('UPDATE darkove_poukazy SET zustatek = zustatek -')) {
        const [castka, id] = params;
        const p = stav.poukazy.find(p => p.id === id);
        p.zustatek = Number(p.zustatek) - Number(castka);
        if (p.zustatek <= 0) p.stav = 'pouzity';
        return {};
      }
      if (s.startsWith('UPDATE darkove_poukazy SET zustatek = zustatek +')) {
        const [castka, id] = params;
        const p = stav.poukazy.find(p => p.id === id);
        p.zustatek = Number(p.zustatek) + Number(castka);
        if (p.stav === 'pouzity') p.stav = 'aktivni';
        return {};
      }
      if (s.startsWith('INSERT INTO poukazy_pouziti')) {
        const [poukaz_id, castka, objednavka_id] = params;
        stav.poukazyPouziti.push({ poukaz_id, castka, objednavka_id });
        return {};
      }
      if (s.startsWith('DELETE FROM poukazy_pouziti')) {
        const [objednavka_id] = params;
        stav.poukazyPouziti = stav.poukazyPouziti.filter(p => p.objednavka_id !== objednavka_id);
        return {};
      }

      if (s.startsWith('INSERT INTO objednavky (')) {
        const id = stav.dalsiObjednavkaId++;
        const [zakaznik_id, doprava, platba, celkem, poznamka, poukaz_id, sleva] = params;
        stav.objednavky.push({ id, zakaznik_id, doprava, platba, celkem, poznamka, poukaz_id, sleva, stav: 'nova' });
        return { rows: [{ id }] };
      }

      if (s.startsWith('INSERT INTO objednavky_polozky')) {
        const [objednavka_id, produkt_id, velikost, pocet, cena] = params;
        stav.objednavkyPolozky.push({ objednavka_id, produkt_id, velikost, pocet, cena });
        return {};
      }
      if (s.startsWith('UPDATE sklad SET pocet_kusu = pocet_kusu -')) {
        const [produkt_id, velikost, pocet] = params;
        const radek = stav.sklad.find(r => r.produkt_id === produkt_id && r.velikost === velikost);
        radek.pocet_kusu -= pocet;
        return {};
      }
      if (s.startsWith('UPDATE sklad SET pocet_kusu = pocet_kusu +')) {
        const [produkt_id, velikost, pocet] = params;
        const radek = stav.sklad.find(r => r.produkt_id === produkt_id && r.velikost === velikost);
        radek.pocet_kusu += pocet;
        return {};
      }
      if (s.startsWith('SELECT 1 FROM sklad WHERE')) {
        return { rows: [{}] };
      }
      if (s.startsWith('INSERT INTO pohyby_skladu')) {
        const [produkt_id, velikost, typ, pocet, poznamka] = params;
        stav.pohybySkladu.push({ produkt_id, velikost, typ, pocet, poznamka });
        return {};
      }

      if (s.startsWith('SELECT 1 FROM vratky WHERE objednavka_id')) {
        const [objednavka_id] = params;
        const existuje = (stav.vratky || []).some(v => String(v.objednavka_id) === String(objednavka_id));
        return { rows: existuje ? [{}] : [] };
      }
      if (s.startsWith('SELECT stav, poukaz_id, sleva FROM objednavky WHERE')) {
        const [id] = params;
        const o = stav.objednavky.find(o => o.id === Number(id));
        return { rows: o ? [{ stav: o.stav, poukaz_id: o.poukaz_id, sleva: o.sleva }] : [] };
      }
      if (s.startsWith('SELECT produkt_id, velikost, pocet FROM pohyby_skladu')) {
        const [poznamka] = params;
        const rows = stav.pohybySkladu.filter(p => p.typ === 'prodej' && p.poznamka === poznamka)
          .map(p => ({ produkt_id: p.produkt_id, velikost: p.velikost, pocet: p.pocet }));
        return { rows };
      }
      if (s.startsWith('UPDATE objednavky SET stav')) {
        const [novyStav, id] = params;
        const o = stav.objednavky.find(o => o.id === Number(id));
        if (o) o.stav = novyStav;
        return {};
      }
      if (s.startsWith('SELECT stav FROM objednavky WHERE')) {
        const [id] = params;
        const o = stav.objednavky.find(o => o.id === Number(id));
        return { rows: o ? [{ stav: o.stav }] : [] };
      }
      if (s.startsWith('DELETE FROM objednavky_polozky WHERE')) {
        const [objednavka_id] = params;
        stav.objednavkyPolozky = stav.objednavkyPolozky.filter(p => String(p.objednavka_id) !== String(objednavka_id));
        return {};
      }
      if (s.startsWith('DELETE FROM objednavky WHERE id')) {
        const [id] = params;
        stav.objednavky = stav.objednavky.filter(o => o.id !== Number(id));
        return {};
      }
      if (s.startsWith('SELECT z.jmeno, z.email FROM objednavky o JOIN zakaznici z')) {
        const [id] = params;
        const o = stav.objednavky.find(o => o.id === Number(id));
        const z = o && stav.zakaznici.find(z => z.id === o.zakaznik_id);
        return { rows: z ? [{ jmeno: z.jmeno, email: z.email }] : [] };
      }
      if (s.startsWith('SELECT faktura_cislo, faktura_datum FROM objednavky WHERE')) {
        const [id] = params;
        const o = stav.objednavky.find(o => o.id === Number(id));
        return { rows: o ? [{ faktura_cislo: o.faktura_cislo || null, faktura_datum: o.faktura_datum || null }] : [] };
      }
      if (s.startsWith('INSERT INTO faktury_cislovani')) {
        const [rok] = params;
        if (!stav.fakturyCislovani.find(f => f.rok === rok)) stav.fakturyCislovani.push({ rok, posledni_cislo: 0 });
        return {};
      }
      if (s.startsWith('UPDATE faktury_cislovani SET posledni_cislo')) {
        const [rok] = params;
        const f = stav.fakturyCislovani.find(f => f.rok === rok);
        f.posledni_cislo++;
        return { rows: [{ posledni_cislo: f.posledni_cislo }] };
      }
      if (s.startsWith('UPDATE objednavky SET faktura_cislo')) {
        const [cislo, datum, id] = params;
        const o = stav.objednavky.find(o => o.id === Number(id));
        if (o) { o.faktura_cislo = cislo; o.faktura_datum = datum; }
        return {};
      }

      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function vytvoritMockPool(stav) {
  return {
    async connect() { return vytvoritMockClient(stav); },
    async query(sql, params) { return vytvoritMockClient(stav).query(sql, params); }
  };
}

function pocatecniStav() {
  return {
    zakaznici: [], dalsiZakaznikId: 1,
    sklad: [], poukazy: [],
    objednavky: [], dalsiObjednavkaId: 1,
    objednavkyPolozky: [], pohybySkladu: [], poukazyPouziti: [],
    vratky: [], fakturyCislovani: []
  };
}

module.exports = { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav };
