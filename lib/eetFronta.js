// Trvalá fronta odesílání EET (krok 3). Události vznikají v transakci operace
// (lib/eetUdalosti.js); tady se odesílají a ukládá se výsledek.
//
// Spolehlivost:
//   - Restart: fronta je v databázi (stav 'ceka' + dalsi_pokus_at); po startu se hned projde.
//   - Více zpracovatelů: událost si zpracovatel zamkne pronájmem (FOR UPDATE SKIP LOCKED +
//     zamek_token + zamek_do). Výsledek zapíše jen držitel platného pronájmu; potvrzenou
//     událost nikdo znovu neodešle (trigger navíc zakáže změnu potvrzené události).
//   - První odeslání bez prodlevy: NOTIFY z transakce operace se doručí po COMMIT a
//     zpracovatel poslouchá (LISTEN); záložně se fronta projde každých `intervalMs`.
//   - Výpadek / ztracená odpověď / pád po přijetí zprávy FS: pokus zůstane bez výsledku
//     (nebo s výsledkem timeout/sit), událost zůstane 'ceka' a zopakuje se s NOVÝM UUID,
//     prvni_zaslani=false a STEJNÝMI údaji tržby (dat_trzby i pořadové číslo jsou v události).
//   - Trvalá chyba (XSD, podpis, struktura EIČ, velikost) = stav 'chyba', neopakuje se samo.
'use strict';
const https = require('node:https');
const crypto = require('node:crypto');
const zprava = require('./eetZprava');
const udalosti = require('./eetUdalosti');

const SOAP_ACTION = 'http://fs.gov.cz/eet/OdeslaniTrzby';
const MAX_ODPOVED = 1024 * 1024;
const TRVALE_KODY = new Set([2, 3, 4, 5, 6, 7]); // kódování, XSD, podpis, (rezerva), EIČ, velikost
const DOCASNE_KODY = new Set([-1, 8]);           // dočasná technická chyba; technická/datová chyba na straně FS

// Odeslání přes HTTPS s ověřením TLS (výchozí CA Node.js, TLS 1.2+). Ověření se NIKDY nevypíná.
function odeslatHttps({ url, xml, timeout }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(Object.assign(new Error('EET jen přes HTTPS.'), { druh: 'sit' }));
    const telo = Buffer.from(xml, 'utf8');
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', minVersion: 'TLSv1.2',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': telo.length, SOAPAction: SOAP_ACTION } }, res => {
      const casti = []; let delka = 0;
      res.on('data', c => { delka += c.length; if (delka > MAX_ODPOVED) req.destroy(Object.assign(new Error('Odpověď je příliš velká.'), { druh: 'neplatna' })); else casti.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(casti).toString('utf8'), transakce: res.headers['x-global-transaction-id'] || null }));
      res.on('error', e => reject(Object.assign(e, { druh: e.druh || 'sit' })));
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error(`Bez odpovědi do ${timeout} ms.`), { druh: 'timeout' })));
    req.on('error', e => reject(Object.assign(e, { druh: e.druh || 'sit' })));
    req.end(telo);
  });
}

// Prodleva před dalším pokusem: rychle po výpadku, nejvýš 10 minut (lhůta 48 h)
const prodleva = pocet => Math.min(10 * 60e3, 15e3 * 2 ** Math.max(0, pocet - 1));
const otisk = s => crypto.createHash('sha256').update(s).digest('hex');

class Fronta {
  // transport: jen pro lokální testy (konfigurace s prostredi 'test'); jinde se odmítne
  constructor({ db, konfig, transport = null, log = console, zamekMs = null, intervalMs = 30000, ted = () => new Date() }) {
    if (!db) throw new Error('Fronta EET potřebuje databázi.');
    if (!konfig) throw new Error('Fronta EET bez konfigurace (EET vypnuté).');
    if (transport && konfig.prostredi !== 'test') throw new Error('Náhradní transport je povolený jen v lokálních testech.');
    if (!transport && konfig.prostredi === 'test') throw new Error('Testovací konfigurace nesmí odesílat po síti.');
    this.db = db; this.konfig = konfig; this.transport = transport || odeslatHttps; this.log = log;
    this.zamekMs = zamekMs || konfig.timeout * 2 + 15000; this.intervalMs = intervalMs; this.ted = ted;
    this.id = crypto.randomUUID();
    this.bezi = null; this.znovu = false; this.casovac = null; this.posluchac = null; this.zastaveno = true;
    this.posledniBeh = null; this.posledniChybaBehu = null;
  }

  // Projde splatné události (opakovaně, dokud nějaké jsou). Souběžná volání se slučují.
  probudit() {
    if (this.bezi) { this.znovu = true; return this.bezi; }
    this.bezi = (async () => {
      try {
        do { this.znovu = false; while ((await this.zpracovat()).zpracovano > 0) { /* další dávka */ } } while (this.znovu);
        this.posledniChybaBehu = null;
      } catch (e) {
        this.posledniChybaBehu = e.message;
        this.log.error('EET fronta:', e.message);
      } finally { this.posledniBeh = new Date(); this.bezi = null; }
    })();
    return this.bezi;
  }

  // Vyzvedne (pronajme) splatné události a odešle je. Vrací souhrn.
  async zpracovat({ limit = 5 } = {}) {
    const token = crypto.randomUUID();
    const vyzvednute = (await this.db.query(`
      UPDATE eet_udalosti SET zamek_token = $1, zamek_do = now() + ($2 || ' milliseconds')::interval
      WHERE id IN (SELECT id FROM eet_udalosti
                   WHERE stav = 'ceka' AND porad_cis IS NOT NULL AND (dalsi_pokus_at IS NULL OR dalsi_pokus_at <= now())
                     AND (zamek_do IS NULL OR zamek_do < now()) AND prostredi = $3
                     AND eic = $5 AND id_provoz = $6 AND id_pokl = $7
                   ORDER BY dalsi_pokus_at NULLS FIRST, id FOR UPDATE SKIP LOCKED LIMIT $4)
      RETURNING *`, [token, String(this.zamekMs), this.konfig.prostredi, limit, this.konfig.eic, this.konfig.idProvoz, this.konfig.idPokl])).rows;
    const vysledky = [];
    for (const u of vyzvednute) vysledky.push(await this.odeslatUdalost(u, token));
    return { zpracovano: vyzvednute.length, vysledky };
  }

  // První odeslání hned po uložení operace (volá route po COMMIT): zpráva se odešle
  // nejpozději při uskutečnění tržby (popis položek kap. 6) a pokladna dostane POK nebo
  // stav „čeká“ nejvýš po mezní době odezvy. Událost, kterou už převzal jiný zpracovatel
  // (posluchač NOTIFY), se neodesílá podruhé – jen se počká na její výsledek.
  async odeslatIhned(ids, { cekatMs = null } = {}) {
    ids = [...new Set((ids || []).map(Number).filter(Boolean))];
    if (!ids.length) return { odeslano: 0 };
    const k = this.konfig;
    const konec = Date.now() + (cekatMs ?? k.timeout + 1000);
    let odeslano = 0;
    for (;;) {
      // převzít, co je splatné a nikdo to právě nezpracovává (po neúspěchu je další pokus
      // naplánovaný do budoucna → podruhé se hned neposílá)
      const token = crypto.randomUUID();
      const vyzvednute = (await this.db.query(`
        UPDATE eet_udalosti SET zamek_token = $1, zamek_do = now() + ($2 || ' milliseconds')::interval
        WHERE id IN (SELECT id FROM eet_udalosti
                     WHERE id = ANY($3::int[]) AND stav = 'ceka' AND porad_cis IS NOT NULL
                       AND (zamek_do IS NULL OR zamek_do < now()) AND (dalsi_pokus_at IS NULL OR dalsi_pokus_at <= now())
                       AND prostredi = $4 AND eic = $5 AND id_provoz = $6 AND id_pokl = $7
                     ORDER BY id FOR UPDATE SKIP LOCKED)
        RETURNING *`, [token, String(this.zamekMs), ids, k.prostredi, k.eic, k.idProvoz, k.idPokl])).rows;
      for (const u of vyzvednute) { await this.odeslatUdalost(u, token); odeslano++; }
      // čeká se jen na události, které někdo zpracovává, nebo které jiný zpracovatel právě
      // zamyká (SKIP LOCKED je přeskočil, ale jeho pronájem ještě není vidět)
      const zbyva = (await this.db.query(`SELECT 1 FROM eet_udalosti WHERE id = ANY($1::int[]) AND stav = 'ceka'
          AND prostredi = $2 AND eic = $3 AND id_provoz = $4 AND id_pokl = $5
          AND (zamek_do > now() OR dalsi_pokus_at IS NULL OR dalsi_pokus_at <= now()) LIMIT 1`,
      [ids, k.prostredi, k.eic, k.idProvoz, k.idPokl])).rows.length;
      if (!zbyva || Date.now() >= konec) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return { odeslano };
  }

  async odeslatUdalost(u, token) {
    const k = this.konfig;
    // pojistka: událost jiného prostředí nebo identity se nikdy neodešle (ani když ji výběr pustí)
    if (u.prostredi !== k.prostredi || u.eic !== k.eic || u.id_provoz !== k.idProvoz || u.id_pokl !== k.idPokl) {
      await this.db.query('UPDATE eet_udalosti SET zamek_token = NULL, zamek_do = NULL WHERE id = $1 AND zamek_token = $2', [u.id, token]);
      this.log.error(`EET: událost ${u.id} (prostředí ${u.prostredi}) nepatří této konfiguraci – neodesláno.`);
      return { id: u.id, vysledek: 'jine_prostredi' };
    }
    // pokus, který nedoběhl (pád procesu, ztracený pronájem), se uzavře jako nedokončený –
    // zpráva možná u FS je, proto další zaslání už není první
    await this.db.query("UPDATE eet_pokusy SET vysledek = 'nedokonceno', dokonceno = now() WHERE udalost_id = $1 AND vysledek IS NULL", [u.id]);
    const predchozi = Number((await this.db.query('SELECT COUNT(*) AS n FROM eet_pokusy WHERE udalost_id = $1', [u.id])).rows[0].n);
    const hlavicka = { uuid: crypto.randomUUID(), datOdesl: zprava.casEet(this.ted()), prvni: predchozi === 0, overeni: false };
    let obalka;
    try {
      obalka = zprava.sestavitObalku({ hlavicka, data: udalosti.datovaZprava(u), certPem: k.certPem, klicPem: k.klicPem });
    } catch (e) {
      // zpráva neodpovídá XSD – opakování nepomůže; nic se neodeslalo
      await this.zapsatVysledek(u, token, null, { vysledek: 'chyba', trvala: true, text: e.message });
      return { id: u.id, vysledek: 'chyba', text: e.message };
    }
    const pokus = (await this.db.query(
      `INSERT INTO eet_pokusy (udalost_id, uuid_zpravy, prvni_zaslani, overeni, dat_odesl, prostredi, otisk_pozadavku)
       VALUES ($1,$2,$3,false,$4,$5,$6) RETURNING id`,
      [u.id, hlavicka.uuid, hlavicka.prvni, hlavicka.datOdesl, k.prostredi, otisk(obalka.xml)])).rows[0];
    await this.db.query('UPDATE eet_udalosti SET pocet_pokusu = pocet_pokusu + 1, posledni_pokus_at = now() WHERE id = $1 AND zamek_token = $2', [u.id, token]);

    let odpoved, r;
    try {
      odpoved = await this.transport({ url: k.url, xml: obalka.xml, timeout: k.timeout });
    } catch (e) {
      r = { vysledek: e.druh === 'timeout' ? 'timeout' : 'sit', text: e.message };
    }
    if (!r) {
      try {
        const o = zprava.zpracovatOdpoved(odpoved.body, { uuid: hlavicka.uuid, testovaci: k.testovaci, duveryhodneCa: k.duveryhodneCa, podpisCn: k.podpisCn });
        if (o.druh === 'potvrzeni') r = { vysledek: 'potvrzeno', pok: o.pok, test: o.test, varovani: o.varovani };
        else r = { vysledek: 'chyba', kod: o.kod, text: o.text, varovani: o.varovani, trvala: !DOCASNE_KODY.has(o.kod) && (TRVALE_KODY.has(o.kod) || o.kod >= 0) };
      } catch (e) {
        // neplatná / podvržená / neúplná odpověď: výsledek NEZNÁMÝ → zopakovat
        r = { vysledek: 'neplatna_odpoved', text: e.message };
      }
      r.http = odpoved.status; r.transakce = odpoved.transakce; r.body = odpoved.body;
    }
    await this.zapsatVysledek(u, token, pokus.id, r);
    return { id: u.id, pokus: pokus.id, ...r, body: undefined };
  }

  async zapsatVysledek(u, token, pokusId, r) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      if (pokusId) {
        await client.query(`UPDATE eet_pokusy SET vysledek = $2, dokonceno = now(), http_status = $3, kod_chyby = $4, text_chyby = $5,
            pok = $6, varovani = $7, transakce_fs = $8, odpoved = $9 WHERE id = $1 AND vysledek IS NULL`,
        [pokusId, r.vysledek, r.http || null, r.kod ?? null, r.text ? String(r.text).slice(0, 1000) : null, r.pok || null,
         r.varovani ? JSON.stringify(r.varovani) : null, r.transakce || null, r.body ? String(r.body).slice(0, 20000) : null]);
      }
      // událost mění jen držitel pronájmu a jen dokud čeká (potvrzenou nic nepřepíše)
      const akt = (await client.query('SELECT stav, zamek_token FROM eet_udalosti WHERE id = $1 FOR UPDATE', [u.id])).rows[0];
      if (akt && akt.stav === 'ceka' && akt.zamek_token === token) {
        if (r.vysledek === 'potvrzeno') {
          await client.query(`UPDATE eet_udalosti SET stav = 'potvrzeno', pok = $2, pok_test = $3, varovani = $4, potvrzeno_at = now(),
              posledni_vysledek = 'potvrzeno', posledni_chyba = NULL, zamek_token = NULL, zamek_do = NULL, dalsi_pokus_at = NULL WHERE id = $1`,
          [u.id, r.pok, !!r.test, r.varovani && r.varovani.length ? JSON.stringify(r.varovani) : null]);
        } else if (r.trvala) {
          await client.query(`UPDATE eet_udalosti SET stav = 'chyba', posledni_vysledek = $2, posledni_chyba = $3, varovani = COALESCE($4, varovani),
              zamek_token = NULL, zamek_do = NULL, dalsi_pokus_at = NULL WHERE id = $1`,
          [u.id, r.vysledek, popisChyby(r), r.varovani && r.varovani.length ? JSON.stringify(r.varovani) : null]);
        } else {
          const n = Number((await client.query('SELECT pocet_pokusu FROM eet_udalosti WHERE id = $1', [u.id])).rows[0].pocet_pokusu);
          await client.query(`UPDATE eet_udalosti SET posledni_vysledek = $2, posledni_chyba = $3, zamek_token = NULL, zamek_do = NULL,
              dalsi_pokus_at = now() + ($4 || ' milliseconds')::interval WHERE id = $1`, [u.id, r.vysledek, popisChyby(r), String(prodleva(n))]);
        }
      } else if (r.vysledek === 'potvrzeno') {
        this.log.warn(`EET: potvrzení události ${u.id} přišlo po ztrátě pronájmu – POK uložen jen u pokusu ${pokusId}.`);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  // Ověřovací mód (overeni=true): FS zprávu zkontroluje, ale NEEVIDUJE – nevrací POK a nikdy
  // se tím neoznačí žádná událost jako potvrzená. Kód 0 = zpráva by prošla.
  async overitSpojeni() {
    const k = this.konfig;
    const ted = this.ted();
    const hlavicka = { uuid: crypto.randomUUID(), datOdesl: zprava.casEet(ted), prvni: true, overeni: true };
    const data = { eic: k.eic, idJednotky: k.idProvoz, idPokl: k.idPokl, poradCis: 'OVERENI-' + ted.getTime().toString(36).toUpperCase(),
      datTrzby: zprava.casEet(ted), celk: '1.00', urceno: null, cerp: null };
    const obalka = zprava.sestavitObalku({ hlavicka, data, certPem: k.certPem, klicPem: k.klicPem });
    const pokus = (await this.db.query(`INSERT INTO eet_pokusy (udalost_id, uuid_zpravy, prvni_zaslani, overeni, dat_odesl, prostredi, otisk_pozadavku)
      VALUES (NULL,$1,true,true,$2,$3,$4) RETURNING id`, [hlavicka.uuid, hlavicka.datOdesl, k.prostredi, otisk(obalka.xml)])).rows[0];
    let r;
    try {
      const odpoved = await this.transport({ url: k.url, xml: obalka.xml, timeout: k.timeout });
      try {
        const o = zprava.zpracovatOdpoved(odpoved.body, { uuid: hlavicka.uuid, testovaci: k.testovaci, duveryhodneCa: k.duveryhodneCa, podpisCn: k.podpisCn });
        r = o.druh === 'chyba' && o.kod === 0
          ? { vysledek: 'overeno', kod: 0, ok: true, text: o.text, varovani: o.varovani, test: o.test }
          : o.druh === 'chyba' ? { vysledek: 'chyba', kod: o.kod, ok: false, text: o.text, varovani: o.varovani }
            : { vysledek: 'neplatna_odpoved', ok: false, text: 'Na ověřovací zprávu přišlo potvrzení s POK – neočekávané, nic se neuložilo jako evidence.' };
      } catch (e) { r = { vysledek: 'neplatna_odpoved', ok: false, text: e.message }; }
      r.http = odpoved.status; r.transakce = odpoved.transakce; r.body = odpoved.body;
    } catch (e) { r = { vysledek: e.druh === 'timeout' ? 'timeout' : 'sit', ok: false, text: e.message }; }
    await this.db.query(`UPDATE eet_pokusy SET vysledek = $2, dokonceno = now(), http_status = $3, kod_chyby = $4, text_chyby = $5, varovani = $6,
        transakce_fs = $7, odpoved = $8 WHERE id = $1`,
    [pokus.id, r.vysledek, r.http || null, r.kod ?? null, r.text ? String(r.text).slice(0, 1000) : null,
     r.varovani ? JSON.stringify(r.varovani) : null, r.transakce || null, r.body ? String(r.body).slice(0, 20000) : null]);
    return { ok: r.ok, vysledek: r.vysledek, kod: r.kod ?? null, text: r.text || null, varovani: r.varovani || [], transakce: r.transakce || null,
      prostredi: k.prostredi, poznamka: 'Ověřovací mód – zpráva se neeviduje, nejde o evidenci tržby.' };
  }

  // Spustí zpracování: LISTEN (okamžité odeslání po COMMIT) + záložní procházení
  async spustit() {
    this.zastaveno = false;
    const smycka = () => {
      if (this.zastaveno) return;
      this.probudit().finally(() => { if (!this.zastaveno) this.casovac = setTimeout(smycka, this.intervalMs); });
    };
    try {
      const c = await this.db.connect();
      this.posluchac = c;
      // obsluhy se při zastavení odeberou – spojení se vrací do poolu a nesmí dál budit tuto frontu
      const kanal = udalosti.kanal(this.konfig.prostredi);
      this.kanal = kanal;
      this.naNotifikaci = n => { if (n.channel === kanal && !this.zastaveno) this.probudit(); };
      this.naChybu = e => { this.log.error('EET LISTEN:', e.message); this.odpojitPosluchace(c); this.posluchac = null; try { c.release(e); } catch { /* už uvolněno */ } };
      c.on('notification', this.naNotifikaci);
      c.on('error', this.naChybu);
      await c.query('LISTEN ' + kanal);
    } catch (e) {
      this.log.error('EET: LISTEN nejde spustit, fronta poběží jen po intervalech:', e.message);
      this.posluchac = null;
    }
    smycka();
  }

  async zastavit() {
    this.zastaveno = true;
    clearTimeout(this.casovac);
    if (this.posluchac) {
      const c = this.posluchac; this.posluchac = null;
      await c.query('UNLISTEN ' + this.kanal).catch(() => {});
      this.odpojitPosluchace(c);
      c.release();
    }
    if (this.bezi) await this.bezi.catch(() => {});
  }

  odpojitPosluchace(c) {
    if (this.naNotifikaci) c.removeListener('notification', this.naNotifikaci);
    if (this.naChybu) c.removeListener('error', this.naChybu);
    this.naNotifikaci = this.naChybu = null;
  }

  stav() {
    return { zpracovatel: this.id, posloucha: !!this.posluchac, bezi: !this.zastaveno, posledni_beh: this.posledniBeh, chyba_behu: this.posledniChybaBehu };
  }
}

function popisChyby(r) {
  if (r.vysledek === 'chyba') return r.kod != null ? `Chyba ${r.kod}: ${r.text || ''}`.trim() : r.text;
  if (r.vysledek === 'timeout') return 'Bez odpovědi FS (vypršel čas) – zpráva se zopakuje.';
  if (r.vysledek === 'sit') return 'Spojení s FS selhalo: ' + (r.text || '') + ' – zpráva se zopakuje.';
  if (r.vysledek === 'neplatna_odpoved') return 'Neplatná odpověď FS: ' + (r.text || '') + ' – zpráva se zopakuje.';
  return r.text || null;
}

// ─── Jedna fronta na proces (spouští index.js, když je EET nastavené) ───
let hlavni = null;
async function spustitHlavni(db, log = console) {
  const { konfig, chyba } = udalosti.stavKonfigurace();
  if (chyba) { log.error('EET: konfigurace odmítnuta –', chyba); return null; }
  if (!konfig) return null;
  // počátek provozu (u produkce výslovný a neměnný); nesoulad nebo chyba = EET zůstane vypnuté
  let chybaProvozu;
  try { chybaProvozu = await udalosti.poznamenatProvoz(db, konfig); } catch (e) { chybaProvozu = 'Začátek provozu EET nejde zapsat: ' + e.message; }
  if (chybaProvozu) {
    udalosti.nastavitKonfiguraci(null, chybaProvozu);
    log.error('EET: konfigurace odmítnuta –', chybaProvozu);
    return null;
  }
  hlavni = new Fronta({ db, konfig, log });
  await hlavni.spustit();
  log.log(`EET: fronta běží (prostředí ${konfig.prostredi}, ${konfig.url}).`);
  return hlavni;
}
const hlavniFronta = () => hlavni;
function nastavitHlavni(f) { hlavni = f; }

// Stav EET dokladů pro odpověď route PO COMMIT: nejdřív se čekající události hned
// odešlou (běží-li fronta), pak se vrátí jejich stav. Operace je v tu chvíli uložená –
// chyba EET (ani chyba tohoto kroku) se nesmí tvářit jako neuložená operace, proto
// funkce nikdy nevyhazuje. null = EET vypnuté. `od` = začátek požadavku: vrátí jen
// události vzniklé tímto požadavkem (opakovaný požadavek dostane všechny události dokladu).
async function stavPoUlozeni(db, zdroje, { od = null, cekatMs = null } = {}) {
  if (!udalosti.aktualniKonfigurace()) return null;
  const nacist = async () => {
    const vse = new Map();
    for (const [typ, id] of zdroje) {
      if (id == null) continue;
      for (const u of await udalosti.stavDokladu(db, typ, id)) vse.set(u.id, u);
    }
    const seznam = [...vse.values()];
    const nove = od ? seznam.filter(u => new Date(u.vytvoreno) >= new Date(od.getTime() - 1000)) : [];
    return nove.length ? nove : seznam;
  };
  try {
    let seznam = await nacist();
    const f = hlavni;
    const cekajici = seznam.filter(u => u.stav === 'ceka').map(u => u.id);
    if (f && cekajici.length) {
      try { await f.odeslatIhned(cekajici, { cekatMs }); } catch (e) { (f.log || console).error('EET: okamžité odeslání selhalo:', e.message); }
      seznam = await nacist();
    }
    return seznam.map(u => ({ id: u.id, stav: u.stav, typ: u.typ, prostredi: u.prostredi, testovaci: udalosti.NEPRODUKCNI.includes(u.prostredi),
      pok: u.pok, pok_test: u.pok_test, porad_cis: u.porad_cis, celk_trzba: u.celk_trzba, urceno_cerp_zuct: u.urceno_cerp_zuct,
      cerp_zuct: u.cerp_zuct, chyba: u.posledni_chyba }));
  } catch (e) {
    return [{ stav: 'nezjisteno', chyba: 'Stav EET nejde zjistit: ' + e.message }];
  }
}

module.exports = { Fronta, odeslatHttps, spustitHlavni, hlavniFronta, nastavitHlavni, stavPoUlozeni, prodleva, SOAP_ACTION };
