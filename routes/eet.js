// /api/eet – přehled událostí EET a jejich odesílání (krok 3, jen pro admina).
// Uložení prodeje a jeho evidence v EET jsou oddělené: výpadek EET nikdy nevede
// k opakovanému zadání prodeje – událost čeká ve frontě a odešle se sama.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const udalosti = require('../lib/eetUdalosti');
const fronta = require('../lib/eetFronta');
const { popis } = require('../lib/eetKonfigurace');

router.use(vyzadovatAdmina);

const UPOZORNIT_HODIN = 12; // upozornit, když do konce lhůty pro pozdní odeslání zbývá méně

// GET /api/eet/stav – prostředí, počty podle stavu, nejstarší neodeslaná, blížící se lhůta
router.get('/stav', async (req, res) => {
  try {
    const { konfig, chyba } = udalosti.stavKonfigurace();
    const pocty = Object.fromEntries((await pool.query('SELECT stav, COUNT(*)::int n FROM eet_udalosti GROUP BY stav')).rows.map(r => [r.stav, r.n]));
    const neodeslane = (await pool.query(`SELECT COUNT(*)::int n, MIN(vytvoreno) AS nejstarsi, MIN(lhuta_do) AS nejblizsi_lhuta,
        EXTRACT(EPOCH FROM (now() - MIN(vytvoreno)))::int AS stari_nejstarsi_s,
        COUNT(*) FILTER (WHERE lhuta_do < now())::int po_lhute,
        COUNT(*) FILTER (WHERE lhuta_do >= now() AND lhuta_do < now() + interval '${UPOZORNIT_HODIN} hours')::int blizi_se
      FROM eet_udalosti WHERE stav IN ('ceka', 'chyba', 'rozhodnuti')`)).rows[0];
    const posledniPokus = (await pool.query('SELECT zahajeno, dokonceno, vysledek, overeni, kod_chyby, text_chyby, prostredi, transakce_fs FROM eet_pokusy ORDER BY id DESC LIMIT 1')).rows[0] || null;
    const nepokryte = await udalosti.nepokryteRadky(pool);
    const f = fronta.hlavniFronta();
    const upozorneni = [];
    if (chyba) upozorneni.push('Konfigurace EET je odmítnutá: ' + chyba + ' Události nevznikají a nic se neodesílá.');
    if (konfig && konfig.testovaci) upozorneni.push('Testovací prostředí Playground – potvrzení (POK) NEJSOU evidencí tržeb.');
    if (neodeslane.po_lhute) upozorneni.push(`${neodeslane.po_lhute} neodeslaných událostí je po lhůtě 48 h od tržby.`);
    if (neodeslane.blizi_se) upozorneni.push(`${neodeslane.blizi_se} neodeslaným událostem do ${UPOZORNIT_HODIN} h končí lhůta 48 h od tržby.`);
    if ((pocty.rozhodnuti || 0) > 0) upozorneni.push(`${pocty.rozhodnuti} událostí čeká na rozhodnutí (darovaný nebo nedoložený kredit).`);
    if ((pocty.chyba || 0) > 0) upozorneni.push(`${pocty.chyba} událostí skončilo trvalou chybou – zkontrolujte a odešlete znovu.`);
    if (konfig && !f) upozorneni.push('Fronta odesílání neběží (server ji nespustil).');
    if (nepokryte.length) upozorneni.push(`${nepokryte.length} kontaktních plateb / čerpání kreditu od zapnutí EET je bez události EET – vyžaduje rozhodnutí (nic se nedoplnilo automaticky).`);
    res.json({
      konfigurace: popis(konfig), chyba_konfigurace: chyba, produkce_povolena: false,
      pocty: { ceka: pocty.ceka || 0, potvrzeno: pocty.potvrzeno || 0, chyba: pocty.chyba || 0, rozhodnuti: pocty.rozhodnuti || 0, neevidovano: pocty.neevidovano || 0 },
      neodeslane, posledni_pokus: posledniPokus, nepokryte, fronta: f ? f.stav() : null, upozorneni
    });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/eet/udalosti?stav=&zdroj_typ=&zdroj_id=&limit=
router.get('/udalosti', async (req, res) => {
  try {
    const { stav, zdroj_typ, zdroj_id } = req.query;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const r = (await pool.query(`SELECT u.id, u.klic, u.zdroj_typ, u.zdroj_id, u.stav, u.typ, u.prostredi, u.eic, u.id_provoz, u.id_pokl, u.porad_cis,
        u.dat_trzby, u.celk_trzba, u.urceno_cerp_zuct, u.cerp_zuct, u.lhuta_do, u.pok, u.pok_test, u.varovani, u.potvrzeno_at,
        u.pocet_pokusu, u.dalsi_pokus_at, u.posledni_pokus_at, u.posledni_vysledek, u.posledni_chyba, u.rozhodnuti_duvod,
        u.rozhodnuti_volba, u.rozhodnuti_poznamka, u.rozhodnuto_at, u.vytvoreno,
        EXTRACT(EPOCH FROM (now() - u.vytvoreno))::int AS stari_s, (u.lhuta_do < now()) AS po_lhute
      FROM eet_udalosti u
      WHERE ($1::text IS NULL OR u.stav = $1 OR ($1 = 'neodeslane' AND u.stav IN ('ceka', 'chyba'))) AND ($2::text IS NULL OR u.zdroj_typ = $2) AND ($3::int IS NULL OR u.zdroj_id = $3)
      ORDER BY u.id DESC LIMIT $4`, [stav || null, zdroj_typ || null, zdroj_id ? Number(zdroj_id) : null, limit])).rows;
    res.json(r);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/eet/udalosti/:id – detail včetně pokusů a pokrytých řádků
router.get('/udalosti/:id', async (req, res) => {
  try {
    const u = (await pool.query('SELECT * FROM eet_udalosti WHERE id = $1', [req.params.id])).rows[0];
    if (!u) return res.status(404).json({ chyba: 'Událost nenalezena.' });
    delete u.zamek_token;
    const pokusy = (await pool.query(`SELECT id, uuid_zpravy, prvni_zaslani, overeni, dat_odesl, zahajeno, dokonceno, vysledek, http_status,
      kod_chyby, text_chyby, pok, varovani, transakce_fs FROM eet_pokusy WHERE udalost_id = $1 ORDER BY id`, [u.id])).rows;
    const radky = (await pool.query(`SELECT r.platba_id, r.kredit_pohyb_id, p.typ AS platba_typ, p.castka AS platba_castka, p.zpusob,
        k.typ AS kredit_typ, k.castka AS kredit_castka
      FROM eet_udalosti_radky r LEFT JOIN platby p ON p.id = r.platba_id LEFT JOIN kredit_pohyby k ON k.id = r.kredit_pohyb_id
      WHERE r.udalost_id = $1 ORDER BY r.id`, [u.id])).rows;
    res.json({ ...u, kod_trzby: u.porad_cis ? udalosti.kodTrzby(u) : null, pokusy, radky });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/eet/udalosti/:id/odeslat – odeslat hned (čekající), nebo znovu po opravě trvalé chyby.
// Potvrzenou ani neevidovanou událost znovu odeslat nejde.
router.post('/udalosti/:id/odeslat', async (req, res) => {
  try {
    const u = (await pool.query(`UPDATE eet_udalosti SET stav = 'ceka', dalsi_pokus_at = now()
      WHERE id = $1 AND stav IN ('ceka', 'chyba') RETURNING id, stav`, [req.params.id])).rows[0];
    if (!u) return res.status(409).json({ chyba: 'Odeslat jde jen čekající událost nebo událost s chybou (potvrzená se znovu neodesílá).' });
    const f = fronta.hlavniFronta();
    if (f) f.probudit();
    res.json({ ok: true, id: u.id, fronta: !!f });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/eet/udalosti/:id/rozhodnuti { volba: 'evidovat'|'neevidovat', poznamka } – darovaný /
// nedoložený kredit. Rozhodnutí je konečné a musí mít odůvodnění. „Evidovat“ = událost se
// zařadí do fronty se svými (neměnnými) údaji; „neevidovat“ = zůstane viditelná jako neevidovaná.
router.post('/udalosti/:id/rozhodnuti', async (req, res) => {
  const b = req.body || {};
  const poznamka = String(b.poznamka || '').trim().slice(0, 500);
  if (!['evidovat', 'neevidovat'].includes(b.volba)) return res.status(400).json({ chyba: 'Vyberte „evidovat“ nebo „neevidovat“.' });
  if (poznamka.length < 5) return res.status(400).json({ chyba: 'Napište odůvodnění rozhodnutí (aspoň pár slov).' });
  try {
    const u = (await pool.query(`UPDATE eet_udalosti SET stav = $2, rozhodnuti_volba = $3, rozhodnuti_poznamka = $4, rozhodnuto_at = now(),
        dalsi_pokus_at = CASE WHEN $2 = 'ceka' THEN now() ELSE NULL END
      WHERE id = $1 AND stav = 'rozhodnuti' RETURNING id, stav`, [req.params.id, b.volba === 'evidovat' ? 'ceka' : 'neevidovano', b.volba, poznamka])).rows[0];
    if (!u) return res.status(409).json({ chyba: 'O této události už bylo rozhodnuto (nebo na rozhodnutí nečeká).' });
    const f = fronta.hlavniFronta();
    if (f && u.stav === 'ceka') f.probudit();
    res.json({ ok: true, ...u });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/eet/overit-spojeni – ověřovací mód (zpráva se neeviduje, nic se nepotvrdí)
router.post('/overit-spojeni', async (req, res) => {
  const f = fronta.hlavniFronta();
  if (!f) return res.status(409).json({ chyba: 'EET není zapnuté nebo fronta neběží.' });
  try {
    res.json(await f.overitSpojeni());
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
