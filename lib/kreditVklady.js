// Kredit poukazu po jednotlivých VKLADECH (krok 2 přípravy na EET).
//
// Vklad = jedno nabití (zaplacené / darované), připsání vráceného zboží
// (vrácený), převod z jiného poukazu (převedený - tok zatím není) nebo počáteční
// stav poukazu z doby před evidencí. Každé čerpání se rozdělí na části z vkladů.
//
// POŘADÍ ČERPÁNÍ (jednoznačné, docs/navrh-krok2-evidence-plateb.md):
//   1. zaplacený  2. vrácený  3. převedený  4. nedoložený  5. darovaný
//   v rámci stejného původu od nejstaršího vkladu (vytvoreno, pak id).
//
// PŮVOD HISTORICKÉHO ZŮSTATKU: poukaz z doby před evidencí dostane při prvním
// použití vklad „počáteční stav“ = aktuální zůstatek. Původ: darovaný (druh dar),
// zaplacený jen když k poukazu existuje doklad prodeje (vydano_prodej_id), jinak
// NEDOLOŽENÝ - nikdy se automaticky nepovažuje za zaplacený.
//
// VRÁCENÝ KREDIT (připsání k vratce) se rozdělí na části čerpání, které se vracejí
// (v opačném pořadí, než se čerpalo), a pro každý zdrojový vklad vznikne vlastní
// vrácený vklad s vazbou (kredit_vklady_zdroje) a se základem pro EET zdroje -
// zaplacený zůstává zaplacený, darovaný a nedoložený zůstávají nevyřešené.
//
// STORNO ČERPÁNÍ vrací přesně odebrané části. Storno nabití jen u nečerpaného vkladu.
// Převod mezi kartami mění jen nosič, vklady i původ zůstávají.
//
// Vše volat v transakci, se zamčeným řádkem poukazu (FOR UPDATE).

const evidence = require('./evidencePlateb');
const { ChybaEvidence, kc } = evidence;

const PORADI_PUVODU = ['zaplaceny', 'vraceny', 'prevedeny', 'nedolozeny', 'darovany'];

// Základ vkladu pro EET: zaplacený / darovaný přímo, nedoložený = neurčený,
// vrácený a převedený podle zdroje (eet_zaklad)
function zakladVkladu(v) {
  if (v.puvod === 'zaplaceny' || v.puvod === 'darovany') return v.puvod;
  if (v.puvod === 'nedolozeny') return 'neurceny';
  return v.eet_zaklad;
}

// Pravidlo EET jedné části. Darovaný, nedoložený i neurčený kredit zůstává výslovně
// nevyřešený, dokud se nedoloží metodika.
function pravidloCasti(vklad, kontaktni) {
  if (kontaktni === false) return 'neeviduje';
  if (kontaktni == null) return 'nevyreseno';
  return zakladVkladu(vklad) === 'zaplaceny' ? 'cerp_zuct' : 'nevyreseno';
}
function pravidloPohybu(casti, kontaktni) {
  if (kontaktni === false) return 'neeviduje';
  return casti.length && casti.every(c => c.eet_pravidlo === 'cerp_zuct') ? 'cerp_zuct' : 'nevyreseno';
}
const puvodPohybu = casti => (new Set(casti.map(c => c.puvod)).size === 1 ? casti[0].puvod : 'smiseny');

async function vkladyPoukazu(client, poukazId) {
  return (await client.query(`
    SELECT v.*, v.castka
      - COALESCE((SELECT SUM(c.castka) FROM kredit_casti c WHERE c.vklad_id = v.id AND c.smer = 'odber'), 0)
      + COALESCE((SELECT SUM(c.castka) FROM kredit_casti c WHERE c.vklad_id = v.id AND c.smer = 'vraceni'), 0) AS zbyva
    FROM kredit_vklady v WHERE v.poukaz_id = $1
    ORDER BY array_position($2::text[], v.puvod), v.vytvoreno, v.id`, [poukazId, PORADI_PUVODU])).rows
    .map(v => ({ ...v, zbyva: kc(v.zbyva) }));
}

async function zajistitPocatecniStav(client, poukaz) {
  if (poukaz.stav === 'ceka_na_platbu') throw new ChybaEvidence(409, 'Poukaz čeká na platbu – kredit vznikne až po jejím zapsání.');
  const ma = (await client.query('SELECT 1 FROM kredit_vklady WHERE poukaz_id = $1 LIMIT 1', [poukaz.id])).rows.length;
  if (ma) return null;
  const zustatek = kc(poukaz.zustatek);
  if (!(zustatek > 0)) return null;
  // původ jen tam, kde je doložený: dar podle druhu, zaplacený jen s dokladem prodeje
  const puvod = poukaz.druh === 'dar' ? 'darovany' : (poukaz.vydano_prodej_id ? 'zaplaceny' : 'nedolozeny');
  const pohyb = await evidence.zapsatKredit(client, { klic: `poukaz:${poukaz.id}:pocatecni-stav`, poukaz_id: poukaz.id, typ: 'pocatecni_stav',
    castka: zustatek, puvod, kontaktni: null, zdroj_typ: 'poukaz', zdroj_id: poukaz.id, eet_pravidlo: 'neeviduje',
    poznamka: puvod === 'nedolozeny' ? 'Zůstatek poukazu z doby před evidencí – původ nedoložený (bez platby v evidenci)'
      : 'Zůstatek poukazu z doby před evidencí kreditu (počáteční stav, bez platby v evidenci)' });
  return zalozitVklad(client, { klic: `vklad:${pohyb.klic}`, poukaz_id: poukaz.id, puvod, castka: zustatek,
    eet_zaklad: puvod === 'nedolozeny' ? 'neurceny' : puvod, overeni: 'pocatecni_stav', kredit_pohyb_id: pohyb.id });
}

async function zalozitVklad(client, v) {
  const r = await client.query(
    `INSERT INTO kredit_vklady (klic, poukaz_id, puvod, castka, eet_zaklad, overeni, kredit_pohyb_id, prevedeno_z_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (klic) DO NOTHING RETURNING *`,
    [v.klic, v.poukaz_id, v.puvod, kc(v.castka), v.eet_zaklad, v.overeni, v.kredit_pohyb_id, v.prevedeno_z_id || null]);
  return r.rows[0] || (await client.query('SELECT * FROM kredit_vklady WHERE klic = $1', [v.klic])).rows[0];
}

async function nabit(client, { poukaz, castka, puvod, platba, klic, zdroj_typ = 'poukaz', zdroj_id, poznamka }) {
  const pohyb = await evidence.zapsatKredit(client, { klic, poukaz_id: poukaz.id, typ: 'nabiti', castka, puvod,
    kontaktni: platba ? platba.kontaktni : null, platba_id: platba ? platba.id : null, zdroj_typ, zdroj_id: zdroj_id ?? poukaz.id, poznamka });
  const vklad = await zalozitVklad(client, { klic: `vklad:${klic}`, poukaz_id: poukaz.id, puvod, castka,
    eet_zaklad: puvod === 'darovany' ? 'darovany' : 'zaplaceny', overeni: puvod === 'darovany' || platba ? 'doklad' : 'bez_dokladu', kredit_pohyb_id: pohyb.id });
  return { pohyb, vklad };
}

async function vlozitCast(client, pohybId, vkladId, smer, castka, eet) {
  return (await client.query('INSERT INTO kredit_casti (kredit_pohyb_id, vklad_id, smer, castka, eet_pravidlo) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
    [pohybId, vkladId, smer, castka, eet])).rows[0];
}

// Odběr z vkladů v pevném pořadí (filtr omezí, ze kterých vkladů)
async function rozdelit(client, poukazId, castka, filtr = () => true) {
  const casti = [];
  let zbyva = kc(castka);
  for (const v of await vkladyPoukazu(client, poukazId)) {
    if (zbyva <= 0) break;
    if (v.zbyva <= 0 || !filtr(v)) continue;
    const c = kc(Math.min(v.zbyva, zbyva));
    casti.push({ vklad: v, castka: c, puvod: v.puvod });
    zbyva = kc(zbyva - c);
  }
  return { casti, chybi: zbyva };
}

async function cerpat(client, { poukaz, castka, klic, zdroj_typ, zdroj_id, kontaktni }) {
  castka = kc(castka);
  const drivejsi = (await client.query('SELECT * FROM kredit_pohyby WHERE klic = $1', [klic])).rows[0];
  if (drivejsi) return drivejsi;
  await zajistitPocatecniStav(client, poukaz);
  const { casti, chybi } = await rozdelit(client, poukaz.id, castka);
  if (chybi > 0) throw new ChybaEvidence(409, `Evidence kreditu poukazu nesedí se zůstatkem (chybí ${chybi} Kč). Operace se neuložila – zkontrolujte poukaz v Kontrole plateb.`);
  for (const c of casti) c.eet_pravidlo = pravidloCasti(c.vklad, kontaktni);
  const pohyb = await evidence.zapsatKredit(client, { klic, poukaz_id: poukaz.id, typ: 'cerpani', castka, puvod: puvodPohybu(casti),
    kontaktni, zdroj_typ, zdroj_id, eet_pravidlo: pravidloPohybu(casti, kontaktni) });
  for (const c of casti) await vlozitCast(client, pohyb.id, c.vklad.id, 'odber', c.castka, c.eet_pravidlo);
  return pohyb;
}

async function stornovat(client, pohyb, { klic, zdroj_typ, zdroj_id, poznamka }) {
  if (pohyb.typ === 'cerpani') {
    const casti = (await client.query("SELECT * FROM kredit_casti WHERE kredit_pohyb_id = $1 AND smer = 'odber' ORDER BY id", [pohyb.id])).rows;
    // část, kterou už vrátilo připsání k vratce, se stornem znovu nevrací
    const vraceno = (await client.query(`SELECT COALESCE(SUM(z.castka), 0) s FROM kredit_vklady_zdroje z JOIN kredit_casti c ON c.id = z.zdroj_cast_id WHERE c.kredit_pohyb_id = $1`, [pohyb.id])).rows[0].s;
    if (Number(vraceno) > 0) throw new ChybaEvidence(409, 'Část tohoto čerpání už byla vrácena připsáním k vratce – čerpání nejde celé stornovat.');
    const storno = await evidence.zapsatKredit(client, { klic, poukaz_id: pohyb.poukaz_id, typ: 'storno_cerpani', castka: pohyb.castka,
      puvod: pohyb.puvod, kontaktni: pohyb.kontaktni, zdroj_typ, zdroj_id, opravuje_id: pohyb.id, eet_pravidlo: pohyb.eet_pravidlo, poznamka });
    for (const c of casti) await vlozitCast(client, storno.id, c.vklad_id, 'vraceni', c.castka, c.eet_pravidlo);
    return storno;
  }
  if (pohyb.typ === 'nabiti') {
    const vklad = (await vkladyPoukazu(client, pohyb.poukaz_id)).find(v => v.kredit_pohyb_id === pohyb.id);
    if (!vklad || vklad.zbyva !== kc(vklad.castka)) throw new ChybaEvidence(409, 'Kredit z tohoto nabití už byl čerpán – nabití nejde stornovat. Použijte vratku nebo připsání.');
    const storno = await evidence.zapsatKredit(client, { klic, poukaz_id: pohyb.poukaz_id, typ: 'storno_nabiti', castka: pohyb.castka,
      puvod: pohyb.puvod, kontaktni: pohyb.kontaktni, zdroj_typ, zdroj_id, opravuje_id: pohyb.id, eet_pravidlo: pohyb.eet_pravidlo, poznamka });
    await vlozitCast(client, storno.id, vklad.id, 'odber', vklad.castka, 'neeviduje');
    return storno;
  }
  throw new Error('Storno pohybu typu ' + pohyb.typ + ' není podporované.');
}

async function stornovatDoklad(client, { zdroj_typ, zdroj_id, typy, klicPrefix, poznamka }) {
  const pohyby = (await client.query(
    `SELECT k.* FROM kredit_pohyby k WHERE k.zdroj_typ = $1 AND k.zdroj_id = $2 AND k.typ = ANY($3::text[])
       AND NOT EXISTS (SELECT 1 FROM kredit_pohyby s WHERE s.opravuje_id = k.id) ORDER BY k.id`, [zdroj_typ, zdroj_id, typy])).rows;
  const storna = [];
  for (const p of pohyby) storna.push(await stornovat(client, p, { klic: `${klicPrefix}:storno:${p.id}`, zdroj_typ, zdroj_id, poznamka }));
  return storna;
}

// Části čerpání účtenky z poukazu, které jde ještě vrátit (bez stornovaných
// čerpání a bez už vrácených částí), v OPAČNÉM pořadí, než se čerpalo
async function vratitelneCasti(client, poukazId, prodejId) {
  const r = (await client.query(`
    SELECT c.id, c.vklad_id, c.castka - COALESCE((SELECT SUM(z.castka) FROM kredit_vklady_zdroje z WHERE z.zdroj_cast_id = c.id), 0) AS volno,
      v.puvod, v.eet_zaklad
    FROM kredit_casti c JOIN kredit_pohyby k ON k.id = c.kredit_pohyb_id JOIN kredit_vklady v ON v.id = c.vklad_id
    WHERE k.poukaz_id = $1 AND k.zdroj_typ = 'prodej' AND k.zdroj_id = $2 AND k.typ = 'cerpani' AND c.smer = 'odber'
      AND NOT EXISTS (SELECT 1 FROM kredit_pohyby s WHERE s.opravuje_id = k.id)
    ORDER BY array_position($3::text[], v.puvod) DESC, c.id DESC`, [poukazId, prodejId, PORADI_PUVODU])).rows;
  return r.map(x => ({ ...x, volno: kc(x.volno) })).filter(x => x.volno > 0);
}

// Připsání (vrácení zboží na poukaz). S vratkou navázanou na účtenku s evidencí
// kreditu: rozdělení na vracené části, pro každý zdrojový vklad vlastní vrácený
// vklad s vazbou a základem pro EET zdroje. Bez vazby: jeden vklad se základem
// 'neurceny' (nevyřešeno).
async function pripsat(client, { poukaz, castka, klic, vratkaId }) {
  castka = kc(castka);
  await zajistitPocatecniStav(client, poukaz);
  let prodejId = null;
  if (vratkaId) prodejId = (await client.query('SELECT prodej_id FROM vratky WHERE id = $1', [vratkaId])).rows[0]?.prodej_id || null;
  const zdroje = prodejId ? await vratitelneCasti(client, poukaz.id, prodejId) : [];
  const rozdeleni = [];
  if (zdroje.length) {
    let zbyva = castka;
    for (const z of zdroje) {
      if (zbyva <= 0) break;
      const c = kc(Math.min(z.volno, zbyva));
      rozdeleni.push({ zdroj: z, castka: c, zaklad: zakladVkladu(z) });
      zbyva = kc(zbyva - c);
    }
    if (zbyva > 0) throw new ChybaEvidence(400, `K této vratce jde na poukaz připsat nejvýš ${kc(castka - zbyva)} Kč (tolik se z poukazu na účtenku čerpalo a ještě nevrátilo).`);
  }
  const vsechnyZaplacene = rozdeleni.length && rozdeleni.every(r => r.zaklad === 'zaplaceny');
  const pohyb = await evidence.zapsatKredit(client, { klic, poukaz_id: poukaz.id, typ: 'pripsani', castka, puvod: 'vraceny',
    kontaktni: true, zdroj_typ: vratkaId ? 'vratka' : 'poukaz', zdroj_id: vratkaId || poukaz.id,
    eet_pravidlo: vsechnyZaplacene ? 'cerp_zuct' : 'nevyreseno' });
  const vklady = [];
  if (!rozdeleni.length) {
    vklady.push(await zalozitVklad(client, { klic: `vklad:${klic}`, poukaz_id: poukaz.id, puvod: 'vraceny', castka,
      eet_zaklad: 'neurceny', overeni: 'doklad', kredit_pohyb_id: pohyb.id }));
  } else {
    // jeden vrácený vklad na zdrojový vklad (seskupeno), vazby na jednotlivé části
    const podleVkladu = new Map();
    for (const r of rozdeleni) {
      const k = r.zdroj.vklad_id;
      if (!podleVkladu.has(k)) podleVkladu.set(k, { zaklad: r.zaklad, castka: 0, casti: [] });
      const g = podleVkladu.get(k);
      g.castka = kc(g.castka + r.castka); g.casti.push(r);
    }
    for (const [zdrojVklad, g] of podleVkladu) {
      const v = await zalozitVklad(client, { klic: `vklad:${klic}:${zdrojVklad}`, poukaz_id: poukaz.id, puvod: 'vraceny', castka: g.castka,
        eet_zaklad: g.zaklad, overeni: 'doklad', kredit_pohyb_id: pohyb.id });
      for (const r of g.casti) {
        await client.query('INSERT INTO kredit_vklady_zdroje (vklad_id, zdroj_cast_id, castka) VALUES ($1,$2,$3)', [v.id, r.zdroj.id, r.castka]);
      }
      vklady.push(v);
    }
  }
  return { pohyb, vklady };
}

// Výplata peněz z kreditu (vrácení zaplaceného poukazu): odebere jen kredit se
// základem 'zaplaceny' (zaplacené a vrácené-ze-zaplaceného vklady), v pořadí čerpání
async function vyplatit(client, { poukaz, castka, klic, kontaktni, zdroj_typ, zdroj_id }) {
  castka = kc(castka);
  const { casti, chybi } = await rozdelit(client, poukaz.id, castka, v => zakladVkladu(v) === 'zaplaceny' && v.overeni !== 'pocatecni_stav');
  if (chybi > 0) throw new ChybaEvidence(400, `Zaplaceného kreditu na poukazu zbývá jen ${kc(castka - chybi)} Kč.`);
  const pohyb = await evidence.zapsatKredit(client, { klic, poukaz_id: poukaz.id, typ: 'vyplaceni', castka, puvod: puvodPohybu(casti),
    kontaktni, zdroj_typ, zdroj_id, eet_pravidlo: kontaktni ? 'urceno_cerp_zuct' : 'neeviduje', poznamka: 'Vrácení peněz za poukaz' });
  for (const c of casti) await vlozitCast(client, pohyb.id, c.vklad.id, 'odber', c.castka, 'neeviduje');
  return pohyb;
}

// Zrušení zbylého kreditu (poukaz zrušený po vrácení peněz) - bez peněz
async function zrusitZbytek(client, { poukaz, klic }) {
  const vklady = (await vkladyPoukazu(client, poukaz.id)).filter(v => v.zbyva > 0);
  const castka = kc(vklady.reduce((s, v) => s + v.zbyva, 0));
  if (!(castka > 0)) return null;
  const pohyb = await evidence.zapsatKredit(client, { klic, poukaz_id: poukaz.id, typ: 'zruseni', castka,
    puvod: new Set(vklady.map(v => v.puvod)).size === 1 ? vklady[0].puvod : 'smiseny', kontaktni: null,
    zdroj_typ: 'poukaz', zdroj_id: poukaz.id, eet_pravidlo: 'neeviduje', poznamka: 'Zrušení zbylého kreditu poukazu' });
  for (const v of vklady) await vlozitCast(client, pohyb.id, v.id, 'odber', v.zbyva, 'neeviduje');
  return pohyb;
}

// Kolik zaplaceného kreditu je na poukazu (pro vrácení peněz)
async function zaplacenyZbytek(client, poukazId) {
  return kc((await vkladyPoukazu(client, poukazId)).filter(v => zakladVkladu(v) === 'zaplaceny' && v.overeni !== 'pocatecni_stav')
    .reduce((s, v) => s + Math.max(0, v.zbyva), 0));
}

async function castiPohybu(db, pohybId) {
  return (await db.query(`SELECT c.*, v.puvod, v.eet_zaklad, v.overeni FROM kredit_casti c JOIN kredit_vklady v ON v.id = c.vklad_id
    WHERE c.kredit_pohyb_id = $1 ORDER BY c.id`, [pohybId])).rows;
}

module.exports = { PORADI_PUVODU, pravidloCasti, vkladyPoukazu, zajistitPocatecniStav, nabit, cerpat, stornovat, stornovatDoklad,
  pripsat, vyplatit, zrusitZbytek, zaplacenyZbytek, castiPohybu, zakladVkladu };
