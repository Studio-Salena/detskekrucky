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
      // Nastavení dopravy (lib/doprava.js) - bez uloženého platí výchozí ceny
      if (s === "SELECT hodnota FROM nastaveni WHERE klic = 'doprava'") {
        return { rows: stav.nastaveniDopravy ? [{ hodnota: stav.nastaveniDopravy }] : [] };
      }
      if (s.startsWith('BEGIN')) return {};
      if (s.startsWith('COMMIT')) { this.committed = true; return {}; }
      if (s.startsWith('ROLLBACK')) { this.rolledBack = true; return {}; }

      if (s === 'SELECT id FROM zakaznici WHERE email = $1') {
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
      // Úprava zákazníka adminem (routes/auth.js PUT /zakaznici/:id) - mock ji
      // SKUTEČNĚ provede (dřív tu byl tichý no-op, takže žádný test nemohl
      // odhalit, že objednávka přepisuje zákazníka). Jakýkoli jiný UPDATE
      // zakaznici (např. vrácený přepis profilu z objednávky) skončí chybou.
      if (s.startsWith('UPDATE zakaznici SET jmeno=$1, email=$2, telefon=$3, ulice=$4, mesto=$5, psc=$6 WHERE id=$7')) {
        const [jmeno, email, telefon, ulice, mesto, psc, id] = params;
        const z = stav.zakaznici.find(z => z.id === Number(id));
        if (!z) return { rows: [] };
        Object.assign(z, { jmeno, email, telefon, ulice, mesto, psc });
        return { rows: [{ ...z }] };
      }
      // Registrace a ověření e-mailu (routes/auth.js) - stejné chování jako mock v test/auth.test.js
      if (s.startsWith('SELECT id, jmeno, email, heslo, email_overen_at FROM zakaznici WHERE email')
        || s.startsWith('SELECT * FROM zakaznici WHERE email')) {
        return { rows: stav.zakaznici.filter(z => z.email === params[0]).map(z => ({ heslo: null, email_overen_at: null, ...z })) };
      }
      if (s.startsWith('DELETE FROM overeni_emailu')) return {};
      if (s.startsWith('INSERT INTO overeni_emailu')) {
        const [token_hash, zakaznik_id, heslo_hash, jmeno] = params;
        (stav.overeni = stav.overeni || []).push({ token_hash, zakaznik_id, heslo_hash, jmeno, expirace: Date.now() + 864e5, pouzito_at: null });
        return {};
      }
      if (s.startsWith('SELECT o.heslo_hash, z.heslo AS heslo_uctu FROM overeni_emailu o JOIN zakaznici z')) {
        const o = (stav.overeni || []).find(o => o.token_hash === params[0] && !o.pouzito_at && o.expirace > Date.now());
        const z = o && stav.zakaznici.find(z => z.id === o.zakaznik_id);
        return { rows: o && z ? [{ heslo_hash: o.heslo_hash, heslo_uctu: z.heslo || null }] : [] };
      }
      if (s.startsWith('UPDATE overeni_emailu SET pouzito_at = NOW() WHERE token_hash')) {
        const o = (stav.overeni || []).find(o => o.token_hash === params[0] && !o.pouzito_at && o.expirace > Date.now());
        if (!o) return { rows: [] };
        o.pouzito_at = new Date();
        return { rows: [{ zakaznik_id: o.zakaznik_id, heslo_hash: o.heslo_hash, jmeno: o.jmeno }] };
      }
      if (s.startsWith('UPDATE overeni_emailu SET pouzito_at = NOW() WHERE zakaznik_id')) {
        (stav.overeni || []).filter(o => o.zakaznik_id === params[0] && !o.pouzito_at).forEach(o => { o.pouzito_at = new Date(); });
        return {};
      }
      if (s.startsWith('UPDATE zakaznici SET heslo = $1')) {
        const [heslo, jmeno, id, zmeneno] = params;
        const z = stav.zakaznici.find(z => z.id === Number(id));
        if (!z || z.email_overen_at) return { rows: [] };
        Object.assign(z, { heslo, jmeno: jmeno ?? z.jmeno, email_overen_at: new Date(), heslo_zmeneno_at: zmeneno });
        return { rows: [{ id: z.id, jmeno: z.jmeno, email: z.email }] };
      }
      if (s.startsWith('SELECT o.id, o.cislo, o.stav, o.celkem, o.vytvoreno, o.doprava FROM objednavky o WHERE o.zakaznik_id')) {
        return { rows: stav.objednavky.filter(o => o.zakaznik_id === Number(params[0])).map(o => ({ id: o.id, cislo: o.cislo, stav: o.stav, celkem: o.celkem, vytvoreno: o.vytvoreno, doprava: o.doprava })) };
      }
      // Dřívější přepis profilu objednávkou (C1) - mock ho provede jako skutečná DB,
      // ať případný návrat chyby testy odhalí podle změněných údajů, ne podle pádu.
      if (s.startsWith('UPDATE zakaznici SET jmeno=$1, telefon=$2, ulice=$3, mesto=$4, psc=$5 WHERE id=$6')) {
        const [jmeno, telefon, ulice, mesto, psc, id] = params;
        const z = stav.zakaznici.find(z => z.id === Number(id));
        if (z) Object.assign(z, { jmeno, telefon, ulice, mesto, psc });
        stav.zakazaneUpdatyZakazniku = (stav.zakazaneUpdatyZakazniku || 0) + 1;
        return {};
      }
      if (s.startsWith('UPDATE zakaznici SET')) {
        throw new Error('Neočekávaný UPDATE zakaznici: ' + s);
      }
      if (s.startsWith('SELECT id FROM zakaznici WHERE email = $1 AND id <> $2')) {
        const [email, id] = params;
        return { rows: stav.zakaznici.filter(z => z.email === email && z.id !== Number(id)).map(z => ({ id: z.id })) };
      }
      // routes/auth.js - inicializace a načtení přihlášeného zákazníka
      if (s.startsWith('SELECT 1 FROM information_schema')) return { rows: [{}] };
      if (s.startsWith('CREATE TABLE')) return {};
      if (s.startsWith('SELECT id, jmeno, email, telefon, ulice, mesto, psc, email_overen_at, heslo_zmeneno_at FROM zakaznici WHERE id')) {
        const z = stav.zakaznici.find(z => z.id === Number(params[0]));
        return { rows: z ? [{ email_overen_at: null, heslo_zmeneno_at: null, ...z }] : [] };
      }

      if (s.includes('FROM sklad s JOIN produkty p')) {
        const [produkt_id, velikost] = params;
        const radek = stav.sklad.find(r => r.produkt_id === produkt_id && r.velikost === velikost);
        // na_eshopu má v DB výchozí hodnotu true - stejně tady, pokud test neřekne jinak
        return { rows: radek ? [{ pocet_kusu: radek.pocet_kusu, dostupnost: radek.dostupnost, cena: radek.cena, nazev: radek.nazev, na_eshopu: radek.na_eshopu !== false }] : [] };
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
        const [zakaznik_id, doprava, platba, celkem, poznamka, poukaz_id, sleva,
          obj_jmeno, obj_email, obj_telefon, obj_ulice, obj_mesto, obj_psc,
          doprava_cena, dopravce, vydejni_misto_id, vydejni_misto_nazev,
          vydejni_misto_ulice, vydejni_misto_mesto, vydejni_misto_psc, vydejni_misto_stat] = params;
        stav.objednavky.push({ id, zakaznik_id, doprava, platba, celkem, poznamka, poukaz_id, sleva, stav: 'nova',
          obj_jmeno, obj_email, obj_telefon, obj_ulice, obj_mesto, obj_psc, udaje_doplneny_zpetne: false,
          doprava_cena, dopravce, vydejni_misto_id, vydejni_misto_nazev,
          vydejni_misto_ulice, vydejni_misto_mesto, vydejni_misto_psc, vydejni_misto_stat });
        return { rows: [{ id }] };
      }
      // Migrace snímků při načtení routeru (lib/objednavkySnapshot.js) - samotné
      // doplnění testuje proti skutečnému PostgreSQL test/c1-migrace-postgres.test.js.
      if (s.startsWith('SELECT id, cislo, zakaznik_id FROM objednavky WHERE obj_email IS NULL')) {
        return { rows: stav.objednavky.filter(o => o.obj_email == null).map(o => ({ id: o.id, cislo: o.cislo || null, zakaznik_id: o.zakaznik_id })) };
      }
      // Čtení údajů objednávky jako SQL_UDAJE_OBJEDNAVKY: o zdroji se rozhoduje jednou
      // za objednávku (snímek = obj_email není NULL), prázdné pole snímku zůstane prázdné.
      const udajeObjednavky = (o) => {
        const z = stav.zakaznici.find(z => z.id === o.zakaznik_id) || {};
        const pole = ['jmeno', 'email', 'telefon', 'ulice', 'mesto', 'psc'];
        const maSnimek = o.obj_email != null;
        return Object.fromEntries(pole.map(p => [p, (maSnimek ? o['obj_' + p] : z[p]) ?? null]));
      };
      if (s.startsWith('SELECT o.id, o.cislo, o.stav, o.doprava, o.platba, o.celkem, o.vytvoreno, o.vydejni_misto_nazev, CASE WHEN o.obj_email IS NOT NULL THEN o.obj_jmeno ELSE z.jmeno END AS jmeno')) {
        return { rows: stav.objednavky.map(o => ({ id: o.id, cislo: o.cislo, stav: o.stav, doprava: o.doprava, platba: o.platba, celkem: o.celkem, vytvoreno: o.vytvoreno, vydejni_misto_nazev: o.vydejni_misto_nazev ?? null, ...udajeObjednavky(o) })) };
      }
      if (s.startsWith('SELECT o.*, CASE WHEN o.obj_email IS NOT NULL THEN o.obj_jmeno ELSE z.jmeno END AS jmeno')) {
        const o = stav.objednavky.find(o => o.id === Number(params[0]));
        return { rows: o ? [{ ...o, ...udajeObjednavky(o), poukaz_kod: null }] : [] };
      }
      if (s.startsWith('SELECT op.*, p.nazev, p.znacka FROM objednavky_polozky op')) {
        return { rows: stav.objednavkyPolozky.filter(p => String(p.objednavka_id) === String(params[0])) };
      }

      if (s.startsWith('INSERT INTO objednavky_cislovani')) {
        const [rok] = params;
        if (!stav.objednavkyCislovani.find(f => f.rok === rok)) stav.objednavkyCislovani.push({ rok, posledni_cislo: 0 });
        return {};
      }
      if (s.startsWith('UPDATE objednavky_cislovani SET posledni_cislo')) {
        const [rok] = params;
        const f = stav.objednavkyCislovani.find(f => f.rok === rok);
        f.posledni_cislo++;
        return { rows: [{ posledni_cislo: f.posledni_cislo }] };
      }
      if (s.startsWith('UPDATE objednavky SET cislo=')) {
        const [cislo, id] = params;
        const o = stav.objednavky.find(o => o.id === Number(id));
        if (o) o.cislo = cislo;
        return {};
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
      if (s.startsWith('SELECT o.cislo, CASE WHEN o.obj_email IS NOT NULL THEN o.obj_jmeno ELSE z.jmeno END AS jmeno')) {
        const [id] = params;
        const o = stav.objednavky.find(o => o.id === Number(id));
        const z = o && stav.zakaznici.find(z => z.id === o.zakaznik_id);
        return { rows: z ? [{ cislo: o.cislo || null, ...udajeObjednavky(o) }] : [] };
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
    vratky: [], fakturyCislovani: [], objednavkyCislovani: []
  };
}

module.exports = { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav };
