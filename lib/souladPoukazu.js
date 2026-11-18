// Soulad poukazu před vrácením peněz (a v Kontrole plateb).
//
// Vrácení peněz za poukaz se smí provést jen tehdy, když spolu sedí VŠECHNY záznamy:
//   1. zůstatek poukazu = součet pohybů kreditu,
//   2. zůstatek poukazu = součet zbývajícího kreditu ve vkladech, žádný vklad není záporný,
//   3. každé dřívější vyplacení kreditu má stejně velké vrácení peněz v evidenci plateb
//      (a obráceně),
//   4. dřívější vrácení nepřesahují původní úhradu.
// Při nesouladu se výplata ODMÍTNE. Nic se automaticky neopravuje a nepoužije se ani
// „nižší ze dvou zůstatků“ – nesoulad znamená, že některá operace proběhla mimo
// evidenci (např. čerpání starou verzí aplikace bez zápisu kreditu) a peníze by mohly
// odejít za kredit, který už byl utracen.
//
// zamknout: true = uzamkne vklady kreditu a původní platbu (FOR UPDATE) – volat
// v transakci, kde je už zamčený řádek poukazu. Zámek vkladů blokuje souběžné čerpání
// (vložení části kreditu potřebuje KEY SHARE na vklad), zámek platby souběžné vrácení
// nebo storno k téže platbě.

const { kc } = require('./evidencePlateb');

const KREDIT_PLUS = ['nabiti', 'pocatecni_stav', 'pripsani', 'storno_cerpani', 'storno_vyplaceni', 'storno_zruseni'];
const KREDIT_MINUS = ['cerpani', 'storno_nabiti', 'storno_pripsani', 'vyplaceni', 'zruseni'];

async function souladPoukazu(db, poukaz, { platba = null, zaplaceno = null, vraceno = null, zamknout = false } = {}) {
  const problemy = [];
  const zustatek = kc(poukaz.zustatek);
  if (zamknout) {
    await db.query('SELECT id FROM kredit_vklady WHERE poukaz_id = $1 ORDER BY id FOR UPDATE', [poukaz.id]);
    if (platba) await db.query('SELECT id FROM platby WHERE id = $1 FOR UPDATE', [platba.id]);
  }
  const k = (await db.query(`SELECT
      COALESCE(SUM(CASE WHEN typ = ANY($2::text[]) THEN castka WHEN typ = ANY($3::text[]) THEN -castka ELSE 0 END), 0) AS kredit,
      COUNT(*) FILTER (WHERE NOT (typ = ANY($2::text[]) OR typ = ANY($3::text[])))::int AS nezname
    FROM kredit_pohyby WHERE poukaz_id = $1`, [poukaz.id, KREDIT_PLUS, KREDIT_MINUS])).rows[0];
  const kredit = kc(k.kredit);
  const vklady = (await db.query(`
    SELECT v.id, v.castka
      - COALESCE((SELECT SUM(c.castka) FROM kredit_casti c WHERE c.vklad_id = v.id AND c.smer = 'odber'), 0)
      + COALESCE((SELECT SUM(c.castka) FROM kredit_casti c WHERE c.vklad_id = v.id AND c.smer = 'vraceni'), 0) AS zbyva
    FROM kredit_vklady v WHERE v.poukaz_id = $1`, [poukaz.id])).rows.map(v => ({ id: v.id, zbyva: kc(v.zbyva) }));
  const veVkladech = kc(vklady.reduce((s, v) => s + v.zbyva, 0));

  if (k.nezname > 0) problemy.push({ druh: "typ", text: `${k.nezname} pohybů kreditu neznámého typu`, doklad_castka: 0, evidence: k.nezname });
  if (kredit !== zustatek) problemy.push({ druh: "kredit", text: `zůstatek poukazu ${zustatek} Kč nesedí s pohyby kreditu ${kredit} Kč`, doklad_castka: zustatek, evidence: kredit });
  if (veVkladech !== zustatek) problemy.push({ druh: "vklady", text: `zůstatek poukazu ${zustatek} Kč nesedí s kreditem ve vkladech ${veVkladech} Kč`, doklad_castka: zustatek, evidence: veVkladech });
  const zaporne = vklady.filter(v => v.zbyva < 0);
  if (zaporne.length) problemy.push({ druh: "zaporny_vklad", text: `záporný zbytek ve vkladech kreditu (${zaporne.map(v => '#' + v.id).join(', ')})`, doklad_castka: 0, evidence: kc(zaporne.reduce((a, v) => a + v.zbyva, 0)) });

  // dřívější vyplacení kreditu × vrácení peněz v evidenci, po dokladech (vratka / poukaz)
  const vyplaty = (await db.query(`
    WITH k AS (
      SELECT zdroj_typ, zdroj_id, SUM(CASE typ WHEN 'vyplaceni' THEN castka ELSE -castka END) AS kredit
        FROM kredit_pohyby WHERE poukaz_id = $1 AND typ IN ('vyplaceni', 'storno_vyplaceni') GROUP BY zdroj_typ, zdroj_id
      UNION SELECT 'poukaz', $1, 0
    )
    SELECT k.zdroj_typ, k.zdroj_id, SUM(k.kredit) AS kredit,
      (SELECT COALESCE(SUM(CASE p.typ WHEN 'vraceni' THEN p.castka ELSE -p.castka END), 0) FROM platby p
        WHERE p.zdroj_typ = k.zdroj_typ AND p.zdroj_id = k.zdroj_id AND p.typ IN ('vraceni', 'storno_vraceni')) AS penize
    FROM k GROUP BY k.zdroj_typ, k.zdroj_id`, [poukaz.id])).rows;
  for (const v of vyplaty) {
    if (kc(v.kredit) !== kc(v.penize)) {
      const doklad = v.zdroj_typ === 'vratka' ? `vratka #${v.zdroj_id}` : 'poukaz';
      problemy.push({ druh: "vyplaceni", text: `${doklad}: vyplacený kredit ${kc(v.kredit)} Kč nesedí s vrácenými penězi ${kc(v.penize)} Kč`, doklad_castka: kc(v.penize), evidence: kc(v.kredit) });
    }
  }
  if (zaplaceno != null && vraceno != null && kc(vraceno) > kc(zaplaceno)) {
    problemy.push({ druh: "uhrada", text: `dřívější vrácení ${kc(vraceno)} Kč převyšují původní úhradu ${kc(zaplaceno)} Kč`, doklad_castka: kc(zaplaceno), evidence: kc(vraceno) });
  }
  return { ok: problemy.length === 0, problemy, zustatek, kredit, ve_vkladech: veVkladech };
}

module.exports = { souladPoukazu };
