// /api/evidence-plateb – kniha plateb a kreditu (lib/evidencePlateb.js), jen pro admina.
// Zápisy z běžných operací dělají jejich vlastní routy ve stejné transakci;
// tady je přehled, volná platba, vyúčtování dobírek a kontrola proti dokladům.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const ev = require('../lib/evidencePlateb');
const eetUdalosti = require('../lib/eetUdalosti');
const eetFronta = require('../lib/eetFronta');
const { souladPoukazu } = require('../lib/souladPoukazu');

router.use(vyzadovatAdmina);

pripravit(ev.migrovat(pool).then(() => console.log('Evidence plateb OK')).catch(e => console.log('Evidence plateb chyba:', e.message)));

const kc = ev.kc;

// poUlozeni(vysledek) běží PO COMMIT (stav EET) a nikdy nevyhazuje – operace je už uložená
async function vTransakci(res, fn, poUlozeni = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vysledek = await fn(client);
    await client.query('COMMIT');
    const navic = poUlozeni ? await poUlozeni(vysledek) : null;
    res.json(navic ? { ...vysledek, ...navic } : vysledek);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ev.ChybaEvidence) return res.status(err.status).json({ chyba: err.chyba, ...err.data });
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
}

// GET /api/evidence-plateb?od=RRRR-MM-DD&do=RRRR-MM-DD&zdroj_typ=&zdroj_id=
router.get('/', async (req, res) => {
  try {
    const { od, do: doDne, zdroj_typ, zdroj_id } = req.query;
    const p = (await pool.query(`SELECT * FROM platby
      WHERE ($1::date IS NULL OR prijato_at >= $1::date) AND ($2::date IS NULL OR prijato_at < $2::date + 1)
        AND ($3::text IS NULL OR zdroj_typ = $3) AND ($4::int IS NULL OR zdroj_id = $4) ORDER BY id DESC LIMIT 1000`,
      [od || null, doDne || null, zdroj_typ || null, zdroj_id ? Number(zdroj_id) : null])).rows;
    const k = (await pool.query(`SELECT * FROM kredit_pohyby
      WHERE ($1::date IS NULL OR vytvoreno >= $1::date) AND ($2::date IS NULL OR vytvoreno < $2::date + 1)
        AND ($3::text IS NULL OR zdroj_typ = $3) AND ($4::int IS NULL OR zdroj_id = $4) ORDER BY id DESC LIMIT 1000`,
      [od || null, doDne || null, zdroj_typ || null, zdroj_id ? Number(zdroj_id) : null])).rows;
    res.json({ platby: p, kredit: k });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/evidence-plateb/volna { klic, zpusob, castka, ucel?, prijato_at?, poznamka? } – platba,
// která ještě nemá doklad (např. převod, který přišel na účet); přiřadí se později k objednávce
// nebo k poukazu z e-shopu.
// EET: kontaktní platba (hotovost, karta, QR u pultu) je tržba v okamžiku přijetí. Účel se
// proto zadává HNED: ucel = 'zbozi' (zboží / objednávka) nebo 'poukaz' (nabití dárkového
// poukazu → urceno_cerp_zuct). Událost vznikne ve stejné transakci, datum tržby = okamžik
// zápisu (zpětné datum u pultu nejde – zpráva se odesílá nejpozději při přijetí). Když
// pozdější přiřazení účel změní, vzniknou opravné události (lib/eetUdalosti.srovnatVolnou).
router.post('/volna', (req, res) => { const od = new Date(); return vTransakci(res, async client => {
  const b = req.body || {};
  if (!b.klic) throw new ev.ChybaEvidence(400, 'Chybí identifikátor operace.');
  if (!['prevod', 'hotovost', 'karta', 'qr'].includes(b.zpusob)) throw new ev.ChybaEvidence(400, 'Neplatný způsob platby.');
  const castka = kc(b.castka);
  if (!(castka > 0) || castka > 1e7) throw new ev.ChybaEvidence(400, 'Neplatná částka.');
  const kontaktni = b.zpusob !== 'prevod';
  const eetZapnute = !!eetUdalosti.aktualniKonfigurace();
  const ucel = b.ucel == null || b.ucel === '' ? null : String(b.ucel);
  if (ucel && !['zbozi', 'poukaz'].includes(ucel)) throw new ev.ChybaEvidence(400, 'Účel platby: zboží / objednávka, nebo dárkový poukaz.');
  if (eetZapnute && kontaktni) {
    if (!ucel) throw new ev.ChybaEvidence(400, 'Platba u pultu se eviduje v EET hned při přijetí – vyberte, zda je za zboží / objednávku, nebo na dárkový poukaz.');
    if (b.prijato_at) throw new ev.ChybaEvidence(400, 'Platbu u pultu zapište v okamžiku přijetí (bez zpětného data) – datum a čas tržby se do EET posílá hned.');
  }
  const { vysledek } = await ev.jednou(client, 'volna', b.klic, { zpusob: b.zpusob, castka, ucel, prijato_at: b.prijato_at || null }, async () => {
    const platba = await ev.zapsatPlatbu(client, { klic: 'volna:' + b.klic, typ: 'prijem', castka, zpusob: b.zpusob,
      okolnosti: kontaktni ? 'prodejna' : 'eshop', kontaktni, urceno_k_cerpani: kontaktni && ucel === 'poukaz' ? castka : null,
      prijato_at: b.prijato_at || null, zdroj_typ: 'volna', zdroj_id: null, poznamka: b.poznamka ? String(b.poznamka).slice(0, 300) : null });
    if (kontaktni) await eetUdalosti.zaznamenat(client, { zdroj_typ: 'volna', zdroj_id: platba.id, klic: 'prijeti', platbaIds: [platba.id], volnaPlatbaId: platba.id });
    return platba;
  });
  return vysledek;
}, async v => {
  const eet = await eetFronta.stavPoUlozeni(pool, [['volna', v.id]], { od });
  return eet ? { eet } : null;
}); });

// POST /api/evidence-plateb/prirazeni/:id/storno { klic, duvod? } – zrušení přiřazení volné
// platby k objednávce (omyl). Přiřazení zůstane, storno se na něj naváže; platba je zase
// volná. Stav objednávky se srovná se součtem platných úhrad. Přiřazení k poukazu se
// takto neruší (poukaz už je aktivní - použijte vrácení poukazu), odeslanou nebo
// doručenou objednávku také ne.
router.post('/prirazeni/:id/storno', (req, res) => vTransakci(res, async client => {
  const b = req.body || {};
  if (!b.klic) throw new ev.ChybaEvidence(400, 'Chybí identifikátor operace.');
  const id = Number(req.params.id);
  const { vysledek, opakovane } = await ev.jednou(client, 'prirazeni-storno', b.klic, { id }, async () => {
    const pr = (await client.query('SELECT * FROM platby_prirazeni WHERE id = $1', [id])).rows[0];
    if (!pr) throw new ev.ChybaEvidence(404, 'Přiřazení nenalezeno.');
    if (pr.poukaz_id) throw new ev.ChybaEvidence(409, 'Přiřazení k poukazu nejde zrušit – poukaz je aktivní. Použijte vrácení peněz za poukaz.');
    const o = (await client.query('SELECT id, stav FROM objednavky WHERE id = $1 FOR UPDATE', [pr.objednavka_id])).rows[0];
    if (o && ['odeslana', 'dorucena'].includes(o.stav)) throw new ev.ChybaEvidence(409, 'Objednávka už je odeslaná nebo předaná – přiřazení nejde zrušit. Použijte vrácení peněz.');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['volna-platba:' + pr.platba_id]);
    const st = (await client.query('INSERT INTO platby_prirazeni_storna (klic, prirazeni_id, duvod) VALUES ($1,$2,$3) ON CONFLICT (prirazeni_id) DO NOTHING RETURNING *',
      ['prirazeni-storno:' + b.klic, id, b.duvod ? String(b.duvod).slice(0, 300) : null])).rows[0];
    if (!st) throw new ev.ChybaEvidence(409, 'Přiřazení už je zrušené.');
    // EET: tržba se nemění; byla-li platba přijata „na poukaz“, opraví se rozdělení podle zbylého účelu
    await eetUdalosti.srovnatVolnou(client, pr.platba_id, 'prirazeni-storno:' + b.klic);
    const stav = o ? await ev.srovnatStavObjednavky(client, o.id) : null;
    return { storno: st, objednavka_id: pr.objednavka_id, stav_objednavky: stav, prijato: o ? await ev.prijatoNaObjednavku(client, o.id) : 0 };
  });
  return opakovane ? { ...vysledek, opakovane: true } : vysledek;
}));

// GET /api/evidence-plateb/dobirky?nevyuctovane=1
router.get('/dobirky', async (req, res) => {
  try {
    const r = await pool.query(`SELECT d.*, o.cislo AS objednavka_cislo, p.prijato_at FROM dobirky d
      JOIN platby p ON p.id = d.platba_id LEFT JOIN objednavky o ON o.id = d.objednavka_id
      WHERE ($1::boolean IS NOT TRUE OR d.vyuctovani_id IS NULL) ORDER BY d.id DESC`, [req.query.nevyuctovane === '1']);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/evidence-plateb/dobirky/vyuctovani { klic, dopravce, vyplaceno_at, poplatek, dobirky: [id...] }
// Vyúčtování od dopravce: brutto = součet dobírek, netto = brutto − poplatek.
// Příjem od zákazníka už je zapsaný u dobírky - tady se znovu nepočítá.
router.post('/dobirky/vyuctovani', (req, res) => vTransakci(res, async client => {
  const b = req.body || {};
  if (!b.klic) throw new ev.ChybaEvidence(400, 'Chybí identifikátor operace.');
  const ids = Array.isArray(b.dobirky) ? [...new Set(b.dobirky.map(Number))].filter(Number.isInteger).sort((a, c) => a - c) : [];
  if (!ids.length) throw new ev.ChybaEvidence(400, 'Vyberte dobírky, které dopravce vyúčtoval.');
  const poplatek = kc(b.poplatek || 0);
  if (!(poplatek >= 0)) throw new ev.ChybaEvidence(400, 'Neplatný poplatek.');
  const { vysledek } = await ev.jednou(client, 'dobirky-vyuctovani', b.klic, { ids, poplatek, dopravce: b.dopravce || null, vyplaceno_at: b.vyplaceno_at || null }, async () => {
    const dobirky = (await client.query('SELECT * FROM dobirky WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids])).rows;
    if (dobirky.length !== ids.length) throw new ev.ChybaEvidence(404, 'Některá dobírka neexistuje.');
    const vyuctovana = dobirky.find(d => d.vyuctovani_id);
    if (vyuctovana) throw new ev.ChybaEvidence(409, `Dobírka objednávky #${vyuctovana.objednavka_id} už je vyúčtovaná.`);
    const dopravce = String(b.dopravce || dobirky[0].dopravce || '').slice(0, 50);
    if (!dopravce) throw new ev.ChybaEvidence(400, 'Zadejte dopravce.');
    if (dobirky.some(d => d.dopravce && d.dopravce !== dopravce)) throw new ev.ChybaEvidence(400, 'Vyúčtování musí být od jednoho dopravce.');
    const brutto = kc(dobirky.reduce((s, d) => s + Number(d.castka), 0));
    if (poplatek > brutto) throw new ev.ChybaEvidence(400, 'Poplatek je vyšší než vyúčtované dobírky.');
    const v = (await client.query(
      `INSERT INTO dobirky_vyuctovani (klic, dopravce, vyplaceno_at, brutto, poplatek, netto, poznamka)
       VALUES ($1,$2,COALESCE($3::timestamptz, NOW()),$4,$5,$6,$7) RETURNING *`,
      ['vyuct:' + b.klic, dopravce, b.vyplaceno_at || null, brutto, poplatek, kc(brutto - poplatek), b.poznamka ? String(b.poznamka).slice(0, 300) : null])).rows[0];
    await client.query('UPDATE dobirky SET vyuctovani_id = $1 WHERE id = ANY($2::int[])', [v.id, ids]);
    return v;
  });
  return vysledek;
}));

// GET /api/evidence-plateb/kontrola?od=RRRR-MM-DD – porovná doklady s knihou plateb a kreditu.
// Kontrolují se jen doklady od začátku evidence (první zápis), starší evidenci nemají
// a nic se jim nedopočítává.
router.get('/kontrola', async (req, res) => {
  try {
    res.json(await kontrola(pool, req.query.od || null));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

const PENIZE = ['hotovost', 'karta', 'qr', 'prevod'];

// GET /api/evidence-plateb/volne – volné platby (bez dokladu) se zbývající částkou k přiřazení
router.get('/volne', async (req, res) => {
  try {
    const r = await pool.query(`SELECT p.*,
        p.castka - COALESCE((SELECT SUM(s.castka) FROM platby s WHERE s.opravuje_id = p.id AND s.typ = 'storno_prijmu'), 0)
                 - COALESCE((SELECT SUM(pr.castka) FROM platby_prirazeni pr WHERE pr.platba_id = p.id
                     AND NOT EXISTS (SELECT 1 FROM platby_prirazeni_storna st WHERE st.prirazeni_id = pr.id)), 0) AS volno
      FROM platby p WHERE p.zdroj_typ = 'volna' AND p.typ = 'prijem' ORDER BY p.prijato_at DESC LIMIT 500`);
    res.json(r.rows.map(x => ({ ...x, volno: kc(x.volno) })));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/evidence-plateb/k-uhrade – kam jde přiřadit platbu: objednávky (nová / vyřizuje se,
// převodem nebo na prodejně) se zbývající částkou a poukazy čekající na platbu
router.get('/k-uhrade', async (req, res) => {
  try {
    const obj = (await pool.query(`SELECT o.id, o.cislo, o.celkem, o.platba, o.doprava, o.stav, o.vytvoreno, o.obj_jmeno
      FROM objednavky o WHERE o.stav IN ('nova', 'vyrizuje') AND o.platba IN ('prevod', 'na_prodejne') AND o.celkem > 0
      ORDER BY o.id DESC LIMIT 300`)).rows;
    const objednavky = [];
    for (const o of obj) {
      const prijato = await ev.prijatoNaObjednavku(pool, o.id);
      const zbyva = kc(Number(o.celkem) - prijato);
      if (zbyva > 0) objednavky.push({ ...o, prijato, zbyva });
    }
    const poukazy = (await pool.query(`SELECT id, kod, hodnota, kupujici_jmeno, kupujici_email, vytvoreno FROM darkove_poukazy
      WHERE stav = 'ceka_na_platbu' ORDER BY id DESC`)).rows;
    res.json({ objednavky, poukazy });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/evidence-plateb/dobirky/vyuctovani – provedená vyúčtování od dopravců
router.get('/dobirky/vyuctovani', async (req, res) => {
  try {
    const r = await pool.query(`SELECT v.*, (SELECT COUNT(*)::int FROM dobirky d WHERE d.vyuctovani_id = v.id) AS pocet
      FROM dobirky_vyuctovani v ORDER BY v.id DESC LIMIT 200`);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Kontrola dokladů proti evidenci. V rozsahu jsou doklady od prvního zápisu evidence
// (a poukazy s vklady kreditu); starší doklady bez evidence jsou MIMO ROZSAH - nejsou
// tím „bezchybně spárované“, jen se nekontrolují a nic se jim nedopočítává.
async function kontrola(db, od) {
  const zacatek = od || (await db.query(`SELECT LEAST((SELECT MIN(vytvoreno) FROM platby), (SELECT MIN(vytvoreno) FROM kredit_pohyby)) AS z`)).rows[0].z;
  const pocet = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);
  const mimo = {
    prodeje: await pocet('SELECT COUNT(*) n FROM prodejna_prodeje WHERE $1::timestamptz IS NULL OR vytvoreno < $1', [zacatek]),
    vratky: await pocet('SELECT COUNT(*) n FROM vratky WHERE $1::timestamptz IS NULL OR vytvoreno < $1', [zacatek]),
    poukazy: await pocet(`SELECT COUNT(*) n FROM darkove_poukazy d WHERE d.stav <> 'ceka_na_platbu'
      AND NOT EXISTS (SELECT 1 FROM kredit_vklady v WHERE v.poukaz_id = d.id)`)
  };
  const cekaNaPlatbu = await pocet("SELECT COUNT(*) n FROM darkove_poukazy WHERE stav = 'ceka_na_platbu'");
  if (!zacatek) return { od: null, v_rozsahu: { prodeje: 0, vratky: 0, poukazy: 0, objednavky: 0 }, mimo_rozsah: mimo, ceka_na_platbu: cekaNaPlatbu, rozdily: [] };

  const netto = (sloupce) => `COALESCE(SUM(CASE WHEN typ IN (${sloupce.plus}) THEN castka WHEN typ IN (${sloupce.minus}) THEN -castka ELSE 0 END), 0)`;
  const prodeje = (await db.query(`
    SELECT pr.id, pr.platba, pr.celkem, pr.poukaz_castka,
      (SELECT ${netto({ plus: "'prijem'", minus: "'storno_prijmu'" })} FROM platby WHERE zdroj_typ = 'prodej' AND zdroj_id = pr.id) AS prijato,
      (SELECT ${netto({ plus: "'cerpani'", minus: "'storno_cerpani'" })} FROM kredit_pohyby WHERE zdroj_typ = 'prodej' AND zdroj_id = pr.id) AS cerpano
    FROM prodejna_prodeje pr WHERE pr.vytvoreno >= $1 ORDER BY pr.id`, [zacatek])).rows;
  const vratky = (await db.query(`
    SELECT v.id, v.castka, v.zpusob_vraceni,
      (SELECT ${netto({ plus: "'vraceni'", minus: "'storno_vraceni'" })} FROM platby WHERE zdroj_typ = 'vratka' AND zdroj_id = v.id) AS vraceno
    FROM vratky v WHERE v.vytvoreno >= $1 ORDER BY v.id`, [zacatek])).rows;
  const poukazy = (await db.query(`
    SELECT d.id, d.kod, d.zustatek,
      (SELECT ${netto({ plus: "'nabiti','pocatecni_stav','pripsani','storno_cerpani'", minus: "'cerpani','storno_nabiti','storno_pripsani','vyplaceni','zruseni'" })} FROM kredit_pohyby WHERE poukaz_id = d.id) AS kredit,
      (SELECT COALESCE(SUM(v.castka), 0)
         - COALESCE((SELECT SUM(c.castka) FROM kredit_casti c JOIN kredit_vklady v2 ON v2.id = c.vklad_id WHERE v2.poukaz_id = d.id AND c.smer = 'odber'), 0)
         + COALESCE((SELECT SUM(c.castka) FROM kredit_casti c JOIN kredit_vklady v2 ON v2.id = c.vklad_id WHERE v2.poukaz_id = d.id AND c.smer = 'vraceni'), 0)
         FROM kredit_vklady v WHERE v.poukaz_id = d.id) AS vklady
    FROM darkove_poukazy d WHERE EXISTS (SELECT 1 FROM kredit_vklady v WHERE v.poukaz_id = d.id) ORDER BY d.id`)).rows;
  // Osobní odběr označený jako zaplacený / vyzvednutý musí mít přijatou platbu
  const odbery = (await db.query(`SELECT id, cislo, celkem FROM objednavky
    WHERE vytvoreno >= $1 AND doprava = 'osobni_odber' AND platba = 'na_prodejne' AND stav IN ('zaplacena', 'dorucena') AND celkem > 0`, [zacatek])).rows;

  const rozdily = [];
  for (const p of prodeje) {
    const ocekPrijem = PENIZE.includes(p.platba) ? kc(p.celkem) : 0;
    const ocekCerpani = p.platba === 'poukaz' ? kc(p.celkem) : kc(p.poukaz_castka || 0);
    if (kc(p.prijato) !== ocekPrijem) rozdily.push({ doklad: `účtenka #${p.id}`, co: 'příjem peněz', doklad_castka: ocekPrijem, evidence: kc(p.prijato) });
    if (kc(p.cerpano) !== ocekCerpani) rozdily.push({ doklad: `účtenka #${p.id}`, co: 'čerpání poukazu', doklad_castka: ocekCerpani, evidence: kc(p.cerpano) });
  }
  for (const v of vratky) {
    const oc = PENIZE.includes(v.zpusob_vraceni) ? kc(v.castka) : 0;
    if (kc(v.vraceno) !== oc) rozdily.push({ doklad: `vratka #${v.id}`, co: 'vrácené peníze', doklad_castka: oc, evidence: kc(v.vraceno) });
  }
  const BLOK = ' (vrácení peněz za poukaz zablokované)';
  for (const d of poukazy) {
    if (kc(d.kredit) !== kc(d.zustatek)) rozdily.push({ doklad: `poukaz ${d.kod}`, co: 'zůstatek proti pohybům kreditu' + BLOK, doklad_castka: kc(d.zustatek), evidence: kc(d.kredit) });
    if (kc(d.vklady) !== kc(d.zustatek)) rozdily.push({ doklad: `poukaz ${d.kod}`, co: 'zůstatek proti vkladům kreditu' + BLOK, doklad_castka: kc(d.zustatek), evidence: kc(d.vklady) });
    // ostatní podmínky souladu před vrácením peněz (lib/souladPoukazu.js)
    const s = await souladPoukazu(db, { id: d.id, zustatek: d.zustatek });
    for (const p of s.problemy.filter(x => x.druh !== 'kredit' && x.druh !== 'vklady')) {
      rozdily.push({ doklad: `poukaz ${d.kod}`, co: p.text + BLOK, doklad_castka: p.doklad_castka, evidence: p.evidence });
    }
  }
  for (const o of odbery) {
    const prijato = await ev.prijatoNaObjednavku(db, o.id);
    if (prijato < kc(o.celkem)) rozdily.push({ doklad: `objednávka ${o.cislo || '#' + o.id}`, co: 'osobní odběr zaplacený bez platby', doklad_castka: kc(o.celkem), evidence: prijato });
  }
  return { od: zacatek, v_rozsahu: { prodeje: prodeje.length, vratky: vratky.length, poukazy: poukazy.length, objednavky: odbery.length },
    mimo_rozsah: mimo, ceka_na_platbu: cekaNaPlatbu, rozdily };
}

module.exports = router;
module.exports.kontrola = kontrola;
