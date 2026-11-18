// Dohled nad EET mimo administraci: pravidelná kontrola a upozornění (e-mail přes Resend,
// bez příjemce jen záznam v logu serveru). Hlídá:
//   konfigurace   – EET_PROSTREDI je nastavené, ale konfigurace je odmítnutá (EET neběží)
//   fronta        – EET je zapnuté, ale fronta odesílání neběží
//   chyby         – události s trvalou chybou odeslání
//   neodeslane    – události, které čekají déle než EET_DOHLED_STARI_MIN
//   lhuta         – neodeslané události blízko lhůty 48 h od tržby (nebo po ní)
//   rozhodnuti    – darovaný / nedoložený kredit čeká na rozhodnutí
//   nepokryte     – kontaktní platby bez události EET
//   jine_prostredi– neodeslané události jiného prostředí / identity (neodešlou se)
//   certifikat    – blíží se konec platnosti certifikátu poplatníka
//
// Nastavení (env, vše volitelné):
//   EET_DOHLED_EMAIL       příjemci oddělení čárkou; PRÁZDNÉ = nikoho nekontaktuje, jen log
//   EET_DOHLED_INTERVAL_MIN  jak často kontrolovat (výchozí 15)
//   EET_DOHLED_STARI_MIN   od jakého stáří je neodeslaná událost problém (výchozí 15)
//   EET_DOHLED_LHUTA_H     kolik hodin před koncem lhůty 48 h upozornit (výchozí 12)
//   EET_DOHLED_CERT_DNI    kolik dní před koncem platnosti certifikátu upozornit (výchozí 30)
//   EET_DOHLED_OPAKOVAT_H  po kolika hodinách připomenout trvající problém (výchozí 12)
// Stejné upozornění se neposílá znovu, dokud se nezmění nebo neuplyne EET_DOHLED_OPAKOVAT_H
// (tabulka eet_dohled, zámek proti souběhu více instancí). Vyřešený problém se oznámí jednou.
'use strict';
const udalosti = require('./eetUdalosti');

const cislo = (v, vychozi, min = 1) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : vychozi; };
function nacistNastaveni(env = process.env) {
  return {
    prijemci: String(env.EET_DOHLED_EMAIL || '').split(',').map(s => s.trim()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
    intervalMin: cislo(env.EET_DOHLED_INTERVAL_MIN, 15),
    stariMin: cislo(env.EET_DOHLED_STARI_MIN, 15),
    lhutaH: cislo(env.EET_DOHLED_LHUTA_H, 12),
    certDni: cislo(env.EET_DOHLED_CERT_DNI, 30),
    opakovatH: cislo(env.EET_DOHLED_OPAKOVAT_H, 12)
  };
}

async function migrovat(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS eet_dohled (
    klic TEXT PRIMARY KEY, zavaznost TEXT NOT NULL, text TEXT NOT NULL, aktivni BOOLEAN NOT NULL DEFAULT true,
    poprve_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), naposledy_videno_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    odeslano_at TIMESTAMPTZ, vyreseno_at TIMESTAMPTZ)`);
}

// Co je teď špatně (nic nezapisuje)
async function zjistit(db, { konfig, chybaKonfigurace, nastaveni, ted = new Date(), frontaBezi = true }) {
  const n = [];
  const pridat = (klic, zavaznost, text) => n.push({ klic, zavaznost, text });
  if (chybaKonfigurace) pridat('konfigurace', 'kriticke', `Konfigurace EET je odmítnutá, EET neběží: ${chybaKonfigurace}`);
  if (!konfig) return n;
  const pr = konfig.prostredi;
  const prostrediText = konfig.testovaci ? `${pr} (TEST – nejde o evidenci tržeb)` : pr;
  if (!frontaBezi) pridat('fronta', 'kriticke', `Fronta odesílání EET (${prostrediText}) neběží – události se neodesílají.`);
  const s = (await db.query(`SELECT
      COUNT(*) FILTER (WHERE stav = 'chyba')::int AS chyby,
      COUNT(*) FILTER (WHERE stav = 'ceka' AND vytvoreno < $2::timestamptz - ($3 || ' minutes')::interval)::int AS stare,
      MIN(vytvoreno) FILTER (WHERE stav = 'ceka') AS nejstarsi,
      COUNT(*) FILTER (WHERE stav IN ('ceka', 'chyba', 'rozhodnuti') AND lhuta_do < $2::timestamptz)::int AS po_lhute,
      COUNT(*) FILTER (WHERE stav IN ('ceka', 'chyba', 'rozhodnuti') AND lhuta_do >= $2::timestamptz AND lhuta_do < $2::timestamptz + ($4 || ' hours')::interval)::int AS blizi_se,
      COUNT(*) FILTER (WHERE stav = 'rozhodnuti')::int AS rozhodnuti
    FROM eet_udalosti WHERE prostredi = $1`, [pr, ted.toISOString(), String(nastaveni.stariMin), String(nastaveni.lhutaH)])).rows[0];
  if (s.chyby) pridat('chyby', 'kriticke', `${s.chyby} událostí EET skončilo chybou odeslání – zkontrolujte Účetnictví → EET a odešlete znovu.`);
  if (s.stare) pridat('neodeslane', 'varovani', `${s.stare} událostí EET čeká na odeslání déle než ${nastaveni.stariMin} min (nejstarší od ${new Date(s.nejstarsi).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' })}).`);
  if (s.po_lhute) pridat('lhuta', 'kriticke', `${s.po_lhute} neodeslaných událostí je PO lhůtě 48 h od tržby (povinnost odeslat trvá).`);
  else if (s.blizi_se) pridat('lhuta', 'kriticke', `${s.blizi_se} neodeslaným událostem do ${nastaveni.lhutaH} h končí lhůta 48 h od tržby.`);
  if (s.rozhodnuti) pridat('rozhodnuti', 'varovani', `${s.rozhodnuti} událostí čeká na rozhodnutí (darovaný nebo nedoložený kredit) – nic se neodeslalo.`);
  const nep = await udalosti.nepokryteRadky(db, pr);
  if (nep.length) pridat('nepokryte', 'varovani', `${nep.length} kontaktních plateb / čerpání od zapnutí EET je bez události EET – vyžaduje rozhodnutí.`);
  const jine = (await db.query(`SELECT COUNT(*)::int AS n FROM eet_udalosti WHERE stav IN ('ceka', 'chyba', 'rozhodnuti')
      AND (prostredi IS DISTINCT FROM $1 OR eic IS DISTINCT FROM $2 OR id_provoz IS DISTINCT FROM $3 OR id_pokl IS DISTINCT FROM $4)`,
  [pr, konfig.eic, konfig.idProvoz, konfig.idPokl])).rows[0].n;
  if (jine) pridat('jine_prostredi', 'varovani', `${jine} neodeslaných událostí patří jinému prostředí nebo pokladně – současným nastavením se neodešlou.`);
  if (konfig.certPlatnyDo) {
    const dni = Math.floor((new Date(konfig.certPlatnyDo) - ted) / 86400e3);
    if (dni <= nastaveni.certDni) pridat('certifikat', dni <= 7 ? 'kriticke' : 'varovani', `Certifikát EET (${konfig.eic}, ${pr}) platí už jen ${Math.max(0, dni)} dní (do ${new Date(konfig.certPlatnyDo).toLocaleDateString('cs-CZ')}). Požádejte o nový v DIS+.`);
  }
  return n;
}

// Výchozí odeslání: bez příjemce jen log (nikoho nekontaktuje), jinak e-mail přes Resend
function vychoziOdeslani(log) {
  return async ({ prijemci, predmet, text }) => {
    if (!prijemci.length) { log.warn(`[EET dohled] ${predmet}\n${text}`); return { kanal: 'log' }; }
    await require('../routes/emaily').odeslat_dohled_eet({ prijemci, predmet, text });
    return { kanal: 'email' };
  };
}

class Dohled {
  constructor({ db, nastaveni = nacistNastaveni(), odeslat = null, log = console, zdroj = null, ted = () => new Date() }) {
    this.db = db; this.nastaveni = nastaveni; this.log = log; this.ted = ted;
    this.odeslat = odeslat || vychoziOdeslani(log);
    // zdroj stavu EET (konfigurace, chyba konfigurace, běží fronta?) – výchozí z běžícího serveru
    this.zdroj = zdroj || (() => {
      const { konfig, chyba } = udalosti.stavKonfigurace();
      return { konfig, chybaKonfigurace: chyba, frontaBezi: !!require('./eetFronta').hlavniFronta() };
    });
    this.casovac = null; this.posledni = null; this.posledniChyba = null;
  }

  // Jedna kontrola: zjistí problémy, pošle nové / změněné / připomínky a vyřešené. Vrací souhrn.
  async kontrola() {
    const ted = this.ted();
    const zdroj = this.zdroj();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['eet-dohled']);
      const nalezy = await zjistit(client, { ...zdroj, nastaveni: this.nastaveni, ted });
      const dosud = new Map((await client.query('SELECT * FROM eet_dohled')).rows.map(r => [r.klic, r]));
      const opakovatMs = this.nastaveni.opakovatH * 3600e3;
      const poslat = nalezy.filter(x => {
        const d = dosud.get(x.klic);
        return !d || !d.aktivni || d.text !== x.text || !d.odeslano_at || ted - new Date(d.odeslano_at) >= opakovatMs;
      });
      const klice = new Set(nalezy.map(x => x.klic));
      const vyresene = [...dosud.values()].filter(d => d.aktivni && !klice.has(d.klic));
      let odeslano = null;
      if (poslat.length || vyresene.length) {
        const kriticke = poslat.some(x => x.zavaznost === 'kriticke');
        const predmet = `${kriticke ? '⚠️ ' : ''}EET – ${poslat.length ? `${poslat.length} upozornění` : 'vyřešeno'}${zdroj.konfig && zdroj.konfig.testovaci ? ' (Playground)' : ''}`;
        const text = [
          ...poslat.map(x => `${x.zavaznost === 'kriticke' ? '[KRITICKÉ]' : '[varování]'} ${x.text}`),
          ...(vyresene.length ? ['', 'Vyřešeno:', ...vyresene.map(d => `- ${d.text}`)] : []),
          '', 'Prodeje jsou uložené – nic znovu nezadávejte. Podrobnosti: administrace → Účetnictví → EET.'
        ].join('\n');
        odeslano = await this.odeslat({ prijemci: this.nastaveni.prijemci, predmet, text }); // chyba = rollback, zkusí se příště
      }
      for (const x of nalezy) {
        const sel = poslat.includes(x);
        await client.query(`INSERT INTO eet_dohled (klic, zavaznost, text, aktivni, naposledy_videno_at, odeslano_at, vyreseno_at)
            VALUES ($1, $2, $3, true, $4, CASE WHEN $5 THEN $4::timestamptz END, NULL)
          ON CONFLICT (klic) DO UPDATE SET zavaznost = EXCLUDED.zavaznost, text = EXCLUDED.text, aktivni = true, vyreseno_at = NULL,
            naposledy_videno_at = EXCLUDED.naposledy_videno_at,
            poprve_at = CASE WHEN eet_dohled.aktivni THEN eet_dohled.poprve_at ELSE EXCLUDED.naposledy_videno_at END,
            odeslano_at = CASE WHEN $5 THEN EXCLUDED.naposledy_videno_at ELSE eet_dohled.odeslano_at END`,
        [x.klic, x.zavaznost, x.text, ted.toISOString(), sel]);
      }
      for (const d of vyresene) await client.query('UPDATE eet_dohled SET aktivni = false, vyreseno_at = $2 WHERE klic = $1', [d.klic, ted.toISOString()]);
      await client.query('COMMIT');
      this.posledni = ted; this.posledniChyba = null;
      return { nalezy, odeslano_upozorneni: poslat.map(x => x.klic), vyreseno: vyresene.map(d => d.klic), kanal: odeslano && odeslano.kanal };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      this.posledniChyba = e.message;
      throw e;
    } finally { client.release(); }
  }

  spustit() {
    const beh = () => this.kontrola().catch(e => this.log.error('EET dohled:', e.message));
    beh();
    this.casovac = setInterval(beh, this.nastaveni.intervalMin * 60e3);
    if (this.casovac.unref) this.casovac.unref();
  }
  zastavit() { clearInterval(this.casovac); this.casovac = null; }
  stav() {
    return { bezi: !!this.casovac, prijemci: this.nastaveni.prijemci.length, jen_log: !this.nastaveni.prijemci.length,
      interval_min: this.nastaveni.intervalMin, posledni_kontrola: this.posledni, chyba: this.posledniChyba };
  }
}

// ─── Jeden dohled na proces (index.js) – běží, kdykoli je EET_PROSTREDI nastavené ───
let hlavni = null;
async function spustitHlavni(db, log = console) {
  if (!String(process.env.EET_PROSTREDI || '').trim()) return null; // EET vypnuté = není co hlídat
  await migrovat(db);
  hlavni = new Dohled({ db, log });
  hlavni.spustit();
  log.log(`EET dohled: běží (kontrola každých ${hlavni.nastaveni.intervalMin} min, ${hlavni.nastaveni.prijemci.length ? 'e-mail' : 'jen log serveru'}).`);
  return hlavni;
}
const stavHlavniho = () => (hlavni ? hlavni.stav() : null);

module.exports = { Dohled, zjistit, nacistNastaveni, migrovat, spustitHlavni, stavHlavniho };
