// Kredit poukazu po jednotlivých VKLADECH (krok 2 přípravy na EET).
//
// Vklad = jedno nabití (zaplacené / darované), připsání vráceného zboží
// (vrácený) nebo převod z jiného poukazu (převedený), případně počáteční stav
// poukazu z doby před evidencí. Každé čerpání se rozdělí na části z vkladů,
// takže je u něj dohledatelné, kolik bylo zaplaceného, darovaného, vráceného
// a převedeného kreditu.
//
// POŘADÍ ČERPÁNÍ (jednoznačné, zdokumentované v docs/navrh-krok2-evidence-plateb.md):
//   1. zaplacený  2. vrácený  3. převedený  4. darovaný
//   v rámci stejného původu od nejstaršího vkladu (vytvoreno, pak id).
//   Peníze zákazníka se čerpají dřív než dar - darovaný kredit, jehož pravidlo
//   pro EET zatím není doložené, zůstává co nejdéle nečerpaný.
//
// STORNO ČERPÁNÍ vrací přesně ty části, které čerpání odebralo (stejné vklady,
// stejné částky). Storno nabití je možné jen u nečerpaného vkladu (odebere ho celý).
// Převod poukazu mezi plastovými kartami mění jen nosič - vklady i jejich
// původ zůstávají u poukazu beze změny.
//
// Vše volat v transakci, se zamčeným řádkem poukazu (FOR UPDATE).

const evidence = require('./evidencePlateb');
const { ChybaEvidence, kc } = evidence;

const PORADI_PUVODU = ['zaplaceny', 'vraceny', 'prevedeny', 'darovany'];

// Základ vkladu pro pravidlo EET: zaplacený / darovaný přímo, vrácený a převedený podle eet_zaklad
const zakladVkladu = v => (v.puvod === 'zaplaceny' || v.puvod === 'darovany' ? v.puvod : v.eet_zaklad);

// Pravidlo EET jedné části čerpání. Darovaný (i neurčený) kredit zůstává
// výslovně nevyřešený, dokud se nedoloží metodika.
function pravidloCasti(vklad, kontaktni) {
  if (kontaktni === false) return 'neeviduje';
  if (kontaktni == null) return 'nevyreseno';
  return zakladVkladu(vklad) === 'zaplaceny' ? 'cerp_zuct' : 'nevyreseno';
}
// Pravidlo celého pohybu: cerp_zuct jen když jsou tak všechny části
function pravidloPohybu(casti, kontaktni) {
  if (kontaktni === false) return 'neeviduje';
  return casti.length && casti.every(c => c.eet_pravidlo === 'cerp_zuct') ? 'cerp_zuct' : 'nevyreseno';
}
const puvodPohybu = casti => (new Set(casti.map(c => c.puvod)).size === 1 ? casti[0].puvod : 'smiseny');

// Vklady poukazu se zůstatkem, v pořadí čerpání
async function vkladyPoukazu(client, poukazId) {
  return (await client.query(`
    SELECT v.*, v.castka
      - COALESCE((SELECT SUM(c.castka) FROM kredit_casti c WHERE c.vklad_id = v.id AND c.smer = 'odber'), 0)
      + COALESCE((SELECT SUM(c.castka) FROM kredit_casti c WHERE c.vklad_id = v.id AND c.smer = 'vraceni'), 0) AS zbyva
    FROM kredit_vklady v WHERE v.poukaz_id = $1
    ORDER BY array_position($2::text[], v.puvod), v.vytvoreno, v.id`, [poukazId, PORADI_PUVODU])).rows
    .map(v => ({ ...v, zbyva: kc(v.zbyva) }));
}

// Poukaz z doby před evidencí kreditu nemá vklady: jeho AKTUÁLNÍ zůstatek se
// zapíše jako počáteční stav (původ podle druhu poukazu, ověření
// 'pocatecni_stav'). Nic se nedopočítává zpětně a nevzniká žádná platba.
async function zajistitPocatecniStav(client, poukaz) {
  if (poukaz.stav === 'ceka_na_platbu') throw new ChybaEvidence(409, 'Poukaz čeká na platbu – kredit vznikne až po jejím zapsání.');
  const ma = (await client.query('SELECT 1 FROM kredit_vklady WHERE poukaz_id = $1 LIMIT 1', [poukaz.id])).rows.length;
  if (ma) return null;
  const zustatek = kc(poukaz.zustatek);
  if (!(zustatek > 0)) return null;
  const puvod = evidence.puvodPoukazu(poukaz);
  const pohyb = await evidence.zapsatKredit(client, { klic: `poukaz:${poukaz.id}:pocatecni-stav`, poukaz_id: poukaz.id, typ: 'pocatecni_stav',
    castka: zustatek, puvod, kontaktni: null, zdroj_typ: 'poukaz', zdroj_id: poukaz.id, eet_pravidlo: 'neeviduje',
    poznamka: 'Zůstatek poukazu z doby před evidencí kreditu (počáteční stav, bez platby v evidenci)' });
  return zalozitVklad(client, { klic: `vklad:${pohyb.klic}`, poukaz_id: poukaz.id, puvod, castka: zustatek,
    eet_zaklad: puvod, overeni: 'pocatecni_stav', kredit_pohyb_id: pohyb.id });
}

async function zalozitVklad(client, v) {
  const r = await client.query(
    `INSERT INTO kredit_vklady (klic, poukaz_id, puvod, castka, eet_zaklad, overeni, kredit_pohyb_id, prevedeno_z_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (klic) DO NOTHING RETURNING *`,
    [v.klic, v.poukaz_id, v.puvod, kc(v.castka), v.eet_zaklad, v.overeni, v.kredit_pohyb_id, v.prevedeno_z_id || null]);
  return r.rows[0] || (await client.query('SELECT * FROM kredit_vklady WHERE klic = $1', [v.klic])).rows[0];
}

// Nabití (prodej poukazu, nabití karty, dar, aktivace po platbě): pohyb + vklad
async function nabit(client, { poukaz, castka, puvod, platba, klic, zdroj_typ = 'poukaz', zdroj_id, poznamka }) {
  const pohyb = await evidence.zapsatKredit(client, { klic, poukaz_id: poukaz.id, typ: 'nabiti', castka, puvod,
    kontaktni: platba ? platba.kontaktni : null, platba_id: platba ? platba.id : null, zdroj_typ, zdroj_id: zdroj_id ?? poukaz.id, poznamka });
  const vklad = await zalozitVklad(client, { klic: `vklad:${klic}`, poukaz_id: poukaz.id, puvod, castka,
    eet_zaklad: puvod === 'darovany' ? 'darovany' : 'zaplaceny', overeni: puvod === 'darovany' || platba ? 'doklad' : 'bez_dokladu', kredit_pohyb_id: pohyb.id });
  return { pohyb, vklad };
}

// Čerpání: rozdělí částku na vklady v pevném pořadí. Když vklady nepokryjí
// částku, evidence nesedí se zůstatkem poukazu - operace se odmítne (nic se neuloží).
async function cerpat(client, { poukaz, castka, klic, zdroj_typ, zdroj_id, kontaktni }) {
  castka = kc(castka);
  const drivejsi = (await client.query('SELECT * FROM kredit_pohyby WHERE klic = $1', [klic])).rows[0];
  if (drivejsi) return drivejsi; // stejná operace podruhé
  await zajistitPocatecniStav(client, poukaz);
  const vklady = await vkladyPoukazu(client, poukaz.id);
  const casti = [];
  let zbyva = castka;
  for (const v of vklady) {
    if (zbyva <= 0) break;
    if (v.zbyva <= 0) continue;
    const c = kc(Math.min(v.zbyva, zbyva));
    casti.push({ vklad: v, castka: c, puvod: v.puvod, eet_pravidlo: pravidloCasti(v, kontaktni) });
    zbyva = kc(zbyva - c);
  }
  if (zbyva > 0) throw new ChybaEvidence(409, `Evidence kreditu poukazu nesedí se zůstatkem (chybí ${zbyva} Kč). Operace se neuložila – zkontrolujte poukaz v Kontrole plateb.`);
  const pohyb = await evidence.zapsatKredit(client, { klic, poukaz_id: poukaz.id, typ: 'cerpani', castka, puvod: puvodPohybu(casti),
    kontaktni, zdroj_typ, zdroj_id, eet_pravidlo: pravidloPohybu(casti, kontaktni) });
  for (const c of casti) {
    await client.query('INSERT INTO kredit_casti (kredit_pohyb_id, vklad_id, smer, castka, eet_pravidlo) VALUES ($1,$2,$3,$4,$5)',
      [pohyb.id, c.vklad.id, 'odber', c.castka, c.eet_pravidlo]);
  }
  return pohyb;
}

// Storno pohybu (čerpání: vrátí přesně odebrané části; nabití: odebere celý
// nečerpaný vklad). Jeden pohyb jde stornovat jen jednou (unikátní index).
async function stornovat(client, pohyb, { klic, zdroj_typ, zdroj_id, poznamka }) {
  if (pohyb.typ === 'cerpani') {
    const casti = (await client.query("SELECT * FROM kredit_casti WHERE kredit_pohyb_id = $1 AND smer = 'odber' ORDER BY id", [pohyb.id])).rows;
    const storno = await evidence.zapsatKredit(client, { klic, poukaz_id: pohyb.poukaz_id, typ: 'storno_cerpani', castka: pohyb.castka,
      puvod: pohyb.puvod, kontaktni: pohyb.kontaktni, zdroj_typ, zdroj_id, opravuje_id: pohyb.id, eet_pravidlo: pohyb.eet_pravidlo, poznamka });
    for (const c of casti) {
      await client.query('INSERT INTO kredit_casti (kredit_pohyb_id, vklad_id, smer, castka, eet_pravidlo) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [storno.id, c.vklad_id, 'vraceni', c.castka, c.eet_pravidlo]);
    }
    return storno;
  }
  if (pohyb.typ === 'nabiti') {
    const vklad = (await vkladyPoukazu(client, pohyb.poukaz_id)).find(v => v.kredit_pohyb_id === pohyb.id);
    if (!vklad || vklad.zbyva !== kc(vklad.castka)) throw new ChybaEvidence(409, 'Kredit z tohoto nabití už byl čerpán – nabití nejde stornovat. Použijte vratku nebo připsání.');
    const storno = await evidence.zapsatKredit(client, { klic, poukaz_id: pohyb.poukaz_id, typ: 'storno_nabiti', castka: pohyb.castka,
      puvod: pohyb.puvod, kontaktni: pohyb.kontaktni, zdroj_typ, zdroj_id, opravuje_id: pohyb.id, eet_pravidlo: pohyb.eet_pravidlo, poznamka });
    await client.query('INSERT INTO kredit_casti (kredit_pohyb_id, vklad_id, smer, castka, eet_pravidlo) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [storno.id, vklad.id, 'odber', vklad.castka, 'neeviduje']);
    return storno;
  }
  throw new Error('Storno pohybu typu ' + pohyb.typ + ' není podporované.');
}

// Storno všech nestornovaných pohybů daného typu z dokladu
async function stornovatDoklad(client, { zdroj_typ, zdroj_id, typy, klicPrefix, poznamka }) {
  const pohyby = (await client.query(
    `SELECT k.* FROM kredit_pohyby k WHERE k.zdroj_typ = $1 AND k.zdroj_id = $2 AND k.typ = ANY($3::text[])
       AND NOT EXISTS (SELECT 1 FROM kredit_pohyby s WHERE s.opravuje_id = k.id) ORDER BY k.id`, [zdroj_typ, zdroj_id, typy])).rows;
  const storna = [];
  for (const p of pohyby) storna.push(await stornovat(client, p, { klic: `${klicPrefix}:storno:${p.id}`, zdroj_typ, zdroj_id, poznamka }));
  return storna;
}

// Připsání (vrácení zboží na poukaz): nový vklad 'vraceny'. Jeho základ pro EET
// se odvodí z čerpání, které se vrací (vratka → účtenka → části), jinak
// z vkladů poukazu; smíšený nebo neznámý základ = 'neurceny' (nevyřešeno).
async function pripsat(client, { poukaz, castka, klic, vratkaId }) {
  await zajistitPocatecniStav(client, poukaz);
  let zaklady;
  if (vratkaId) {
    zaklady = (await client.query(`
      SELECT DISTINCT CASE WHEN v.puvod IN ('zaplaceny','darovany') THEN v.puvod ELSE v.eet_zaklad END AS z
        FROM vratky r JOIN kredit_pohyby k ON k.zdroj_typ = 'prodej' AND k.zdroj_id = r.prodej_id AND k.typ = 'cerpani' AND k.poukaz_id = $2
        JOIN kredit_casti c ON c.kredit_pohyb_id = k.id AND c.smer = 'odber' JOIN kredit_vklady v ON v.id = c.vklad_id
       WHERE r.id = $1`, [vratkaId, poukaz.id])).rows.map(r => r.z);
  }
  if (!zaklady || !zaklady.length) {
    zaklady = [...new Set((await client.query('SELECT puvod, eet_zaklad FROM kredit_vklady WHERE poukaz_id = $1', [poukaz.id])).rows.map(zakladVkladu))];
  }
  const eetZaklad = zaklady.length === 1 && zaklady[0] !== 'neurceny' ? zaklady[0] : 'neurceny';
  const pohyb = await evidence.zapsatKredit(client, { klic, poukaz_id: poukaz.id, typ: 'pripsani', castka, puvod: 'vraceny',
    kontaktni: true, zdroj_typ: vratkaId ? 'vratka' : 'poukaz', zdroj_id: vratkaId || poukaz.id,
    eet_pravidlo: eetZaklad === 'zaplaceny' ? 'cerp_zuct' : 'nevyreseno' });
  const vklad = await zalozitVklad(client, { klic: `vklad:${klic}`, poukaz_id: poukaz.id, puvod: 'vraceny', castka,
    eet_zaklad: eetZaklad, overeni: 'doklad', kredit_pohyb_id: pohyb.id });
  return { pohyb, vklad };
}

// Rozdělení pohybu na vklady (pro detail poukazu a kontrolu)
async function castiPohybu(db, pohybId) {
  return (await db.query(`SELECT c.*, v.puvod, v.eet_zaklad, v.overeni FROM kredit_casti c JOIN kredit_vklady v ON v.id = c.vklad_id
    WHERE c.kredit_pohyb_id = $1 ORDER BY c.id`, [pohybId])).rows;
}

module.exports = { PORADI_PUVODU, pravidloCasti, vkladyPoukazu, zajistitPocatecniStav, nabit, cerpat, stornovat, stornovatDoklad, pripsat, castiPohybu, zakladVkladu };
