// Plastové dárkové karty – správa v adminu (Dárkové poukazy → Plastové karty).
// Tabulky zakládá migrace v routes/poukazy.js, logika stavů je v lib/poukazKarty.js.
// Nahrání poukazu na kartu = POST /api/poukazy s karta_ean (vznikne poukaz i prodej).
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { poukazPoPlatnosti } = require('../lib/poukazPlatnost');
const { jePlatnyEan13, vygenerovatEanKarty, cisloKarty, normalizovatCisloKarty, stavKarty, STAVY_K_UVOLNENI } = require('../lib/poukazKarty');

router.use(vyzadovatAdmina);

const MAX_DAVKA = 500;

const SELECT_KARTY = `
  SELECT k.*, dp.kod AS poukaz_kod, dp.hodnota AS poukaz_hodnota, dp.zustatek AS poukaz_zustatek,
         dp.platnost_do AS poukaz_platnost_do, dp.stav AS poukaz_stav, dp.druh AS poukaz_druh,
         dp.kupujici_jmeno AS poukaz_kupujici, dp.vytvoreno AS poukaz_vytvoreno,
         (SELECT COUNT(*)::int FROM darkove_poukazy x WHERE x.karta_id = k.id) AS pocet_nahrani
  FROM poukazove_karty k
  LEFT JOIN darkove_poukazy dp ON dp.id = k.aktualni_poukaz_id`;

function sestavitKartu(r) {
  const poukaz = r.aktualni_poukaz_id ? {
    id: r.aktualni_poukaz_id, kod: r.poukaz_kod, hodnota: Number(r.poukaz_hodnota), zustatek: Number(r.poukaz_zustatek),
    platnost_do: r.poukaz_platnost_do, stav: r.poukaz_stav, druh: r.poukaz_druh, kupujici_jmeno: r.poukaz_kupujici,
    vytvoreno: r.poukaz_vytvoreno
  } : null;
  return {
    id: r.id, cislo: r.cislo, ean: r.ean, zablokovana: r.zablokovana, duvod_blokace: r.duvod_blokace,
    poznamka: r.poznamka, vytvoreno: r.vytvoreno, pocet_nahrani: r.pocet_nahrani,
    poukaz, stav: stavKarty(r, poukaz && { ...poukaz })
  };
}

async function zalogovat(db, kartaId, akce, poukazId, poznamka) {
  await db.query('INSERT INTO poukazove_karty_udalosti (karta_id, akce, poukaz_id, poznamka) VALUES ($1,$2,$3,$4)',
    [kartaId, akce, poukazId || null, poznamka || null]);
}

// Další volné pořadí karty (poslední skupina číslic v DK-26-00481). Pořadí běží
// dál i v novém roce, takže je samo o sobě jedinečné. Volat v transakci po zámku tabulky.
async function dalsiPoradi(db) {
  const r = await db.query(`SELECT COALESCE(MAX(substring(cislo from '(\\d+)$')::int), 0) AS max FROM poukazove_karty`);
  return Number(r.rows[0].max) + 1;
}

async function eanJeVolny(db, ean) {
  const r = await db.query(
    `SELECT 1 FROM poukazove_karty WHERE ean = $1 UNION ALL SELECT 1 FROM darkove_poukazy WHERE ean = $1 OR UPPER(kod) = $1`, [ean]);
  return r.rows.length === 0;
}

// Načte kartu podle id se zámkem řádku
async function kartaProZmenu(client, id) {
  return (await client.query('SELECT * FROM poukazove_karty WHERE id = $1 FOR UPDATE', [id])).rows[0];
}

async function vTransakci(res, prace) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vysledek = await prace(client);
    if (vysledek && vysledek.chyba) {
      await client.query('ROLLBACK');
      return res.status(vysledek.status || 400).json({ chyba: vysledek.chyba });
    }
    await client.query('COMMIT');
    res.json(vysledek);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
}

async function nacistKartu(db, id) {
  const r = await db.query(SELECT_KARTY + ' WHERE k.id = $1', [id]);
  return r.rows[0] ? sestavitKartu(r.rows[0]) : null;
}

// GET /api/poukazove-karty – všechny karty s aktuálním stavem
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(SELECT_KARTY + ' ORDER BY k.cislo');
    res.json(r.rows.map(sestavitKartu));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/poukazove-karty/najit/:kod – karta podle EAN nebo čísla (DK-26-00481) i s historií
router.get('/najit/:kod', async (req, res) => {
  const kod = String(req.params.kod || '').trim().toUpperCase();
  try {
    const r = await pool.query(SELECT_KARTY + ' WHERE k.ean = $1 OR UPPER(k.cislo) = $2', [kod, normalizovatCisloKarty(kod)]);
    if (!r.rows.length) return res.status(404).json({ chyba: 'Taková karta v systému není.' });
    const karta = sestavitKartu(r.rows[0]);
    const poukazy = (await pool.query(
      'SELECT id, kod, hodnota, zustatek, platnost_do, stav, druh, kupujici_jmeno, vytvoreno FROM darkove_poukazy WHERE karta_id = $1 ORDER BY vytvoreno DESC', [karta.id])).rows;
    const pouziti = karta.poukaz ? (await pool.query(
      'SELECT castka, prodej_id, objednavka_id, vytvoreno FROM poukazy_pouziti WHERE poukaz_id = $1 ORDER BY vytvoreno DESC', [karta.poukaz.id])).rows : [];
    const udalosti = (await pool.query(
      'SELECT akce, poukaz_id, poznamka, vytvoreno FROM poukazove_karty_udalosti WHERE karta_id = $1 ORDER BY vytvoreno DESC, id DESC', [karta.id])).rows;
    res.json({ ...karta, poukazy, pouziti, udalosti });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/poukazove-karty – přidat jednu kartu. Bez `ean` systém vygeneruje
// EAN-13 s prefixem 23 (pro výrobu karet), s `ean` se zaeviduje karta, která už
// kód má (načtený čtečkou).
router.post('/', (req, res) => vTransakci(res, async client => {
  let ean = req.body && req.body.ean != null ? String(req.body.ean).trim().toUpperCase() : '';
  const poznamka = req.body && req.body.poznamka ? String(req.body.poznamka).slice(0, 200) : null;
  if (ean) {
    if (!/^[0-9A-Z-]{6,32}$/.test(ean)) return { chyba: 'Kód karty musí mít 6–32 znaků (číslice, písmena, pomlčka).' };
    if (/^\d{13}$/.test(ean) && !jePlatnyEan13(ean)) return { chyba: 'EAN-13 nemá správnou kontrolní číslici – zkuste kartu načíst znovu.' };
  }
  await client.query('LOCK TABLE poukazove_karty IN SHARE ROW EXCLUSIVE MODE');
  if (ean) {
    if (!(await eanJeVolny(client, ean))) return { chyba: 'Tento kód už v systému je (karta nebo poukaz).' };
  } else {
    do { ean = vygenerovatEanKarty(); } while (!(await eanJeVolny(client, ean)));
  }
  const cislo = cisloKarty(await dalsiPoradi(client));
  const karta = (await client.query(
    'INSERT INTO poukazove_karty (cislo, ean, poznamka) VALUES ($1,$2,$3) RETURNING *', [cislo, ean, poznamka])).rows[0];
  await zalogovat(client, karta.id, 'pridani', null, req.body && req.body.ean ? 'zaevidována načtením' : 'vygenerována');
  return nacistKartu(client, karta.id);
}));

// POST /api/poukazove-karty/davka – vygenerovat víc karet najednou (čísla a EAN pro výrobce)
router.post('/davka', (req, res) => vTransakci(res, async client => {
  const pocet = Number(req.body && req.body.pocet);
  if (!Number.isInteger(pocet) || pocet < 1 || pocet > MAX_DAVKA) return { chyba: `Počet karet musí být 1–${MAX_DAVKA}.` };
  await client.query('LOCK TABLE poukazove_karty IN SHARE ROW EXCLUSIVE MODE');
  let poradi = await dalsiPoradi(client);
  const nove = [];
  const pouzite = new Set();
  for (let i = 0; i < pocet; i++) {
    let ean;
    do { ean = vygenerovatEanKarty(); } while (pouzite.has(ean) || !(await eanJeVolny(client, ean)));
    pouzite.add(ean);
    const karta = (await client.query(
      'INSERT INTO poukazove_karty (cislo, ean) VALUES ($1,$2) RETURNING id, cislo, ean', [cisloKarty(poradi++), ean])).rows[0];
    await zalogovat(client, karta.id, 'pridani', null, 'vygenerována v dávce');
    nove.push(karta);
  }
  return { karty: nove };
}));

// POST /api/poukazove-karty/:id/uvolnit – vyčerpanou, prošlou nebo zrušenou kartu
// vrátit do oběhu jako prázdnou. Poukaz i jeho historie zůstávají v evidenci.
router.post('/:id/uvolnit', (req, res) => vTransakci(res, async client => {
  const karta = await kartaProZmenu(client, req.params.id);
  if (!karta) return { chyba: 'Karta nenalezena.', status: 404 };
  const poukaz = karta.aktualni_poukaz_id
    ? (await client.query('SELECT * FROM darkove_poukazy WHERE id = $1 FOR UPDATE', [karta.aktualni_poukaz_id])).rows[0]
    : null;
  const stav = stavKarty(karta, poukaz);
  if (stav === 'zablokovana') return { chyba: 'Karta je ručně zablokovaná – nejdřív zrušte blokaci.' };
  if (stav === 'prazdna') return { chyba: 'Karta už je prázdná a v oběhu.' };
  if (!STAVY_K_UVOLNENI.includes(stav)) {
    return { chyba: `Na kartě je ještě ${Number(poukaz.zustatek).toLocaleString('cs-CZ')} Kč. Uvolnit jde jen vyčerpanou, prošlou nebo zrušenou kartu.` };
  }
  await client.query('UPDATE poukazove_karty SET aktualni_poukaz_id = NULL WHERE id = $1', [karta.id]);
  const zbylo = Number(poukaz.zustatek);
  await zalogovat(client, karta.id, 'uvolneni', poukaz.id,
    stav === 'prosla' && zbylo > 0 ? `po platnosti, propadlo ${zbylo} Kč` : stav === 'zrusena' ? 'poukaz byl zrušený' : 'vyčerpaná');
  return nacistKartu(client, karta.id);
}));

// POST /api/poukazove-karty/:id/zablokovat – ruční blokace (ztráta, krádež)
router.post('/:id/zablokovat', (req, res) => vTransakci(res, async client => {
  const karta = await kartaProZmenu(client, req.params.id);
  if (!karta) return { chyba: 'Karta nenalezena.', status: 404 };
  if (karta.zablokovana) return { chyba: 'Karta už je zablokovaná.' };
  const duvod = req.body && req.body.duvod ? String(req.body.duvod).slice(0, 200) : null;
  await client.query('UPDATE poukazove_karty SET zablokovana = true, duvod_blokace = $1 WHERE id = $2', [duvod, karta.id]);
  await zalogovat(client, karta.id, 'blokace', karta.aktualni_poukaz_id, duvod);
  return nacistKartu(client, karta.id);
}));

// POST /api/poukazove-karty/:id/odblokovat – zrušit ruční blokaci
router.post('/:id/odblokovat', (req, res) => vTransakci(res, async client => {
  const karta = await kartaProZmenu(client, req.params.id);
  if (!karta) return { chyba: 'Karta nenalezena.', status: 404 };
  if (!karta.zablokovana) return { chyba: 'Karta není ručně zablokovaná.' };
  await client.query('UPDATE poukazove_karty SET zablokovana = false, duvod_blokace = NULL WHERE id = $1', [karta.id]);
  await zalogovat(client, karta.id, 'odblokovani', karta.aktualni_poukaz_id, null);
  return nacistKartu(client, karta.id);
}));

// POST /api/poukazove-karty/:id/prevest { na } – přenést poukaz (zůstatek) na jinou
// prázdnou kartu, např. když zákazník kartu ztratil. Stará karta zůstane zablokovaná.
router.post('/:id/prevest', (req, res) => vTransakci(res, async client => {
  const na = String((req.body && req.body.na) || '').trim().toUpperCase();
  if (!na) return { chyba: 'Načtěte kartu, na kterou se má zůstatek převést.' };
  const stara = await kartaProZmenu(client, req.params.id);
  if (!stara) return { chyba: 'Karta nenalezena.', status: 404 };
  if (!stara.aktualni_poukaz_id) return { chyba: 'Na kartě není žádný poukaz k převodu.' };
  const nova = (await client.query('SELECT * FROM poukazove_karty WHERE (ean = $1 OR UPPER(cislo) = $2) FOR UPDATE', [na, normalizovatCisloKarty(na)])).rows[0];
  if (!nova) return { chyba: 'Cílová karta v systému není.' };
  if (nova.id === stara.id) return { chyba: 'Vyberte jinou kartu.' };
  if (nova.zablokovana || nova.aktualni_poukaz_id) return { chyba: `Karta ${nova.cislo} není prázdná a volná.` };
  const poukaz = (await client.query('SELECT * FROM darkove_poukazy WHERE id = $1 FOR UPDATE', [stara.aktualni_poukaz_id])).rows[0];
  // Stará karta smí být ručně zablokovaná (typicky ztráta) – rozhoduje stav poukazu
  if (poukaz.stav !== 'aktivni' || Number(poukaz.zustatek) <= 0 || poukazPoPlatnosti(poukaz.platnost_do)) {
    return { chyba: 'Převést jde jen platný poukaz s kladným zůstatkem.' };
  }
  await client.query('UPDATE poukazove_karty SET aktualni_poukaz_id = NULL, zablokovana = true, duvod_blokace = COALESCE(duvod_blokace, $2) WHERE id = $1',
    [stara.id, `zůstatek převeden na ${nova.cislo}`]);
  await client.query('UPDATE poukazove_karty SET aktualni_poukaz_id = $1 WHERE id = $2', [poukaz.id, nova.id]);
  await client.query('UPDATE darkove_poukazy SET karta_id = $1 WHERE id = $2', [nova.id, poukaz.id]);
  await zalogovat(client, stara.id, 'prevod', poukaz.id, `na ${nova.cislo} (${Number(poukaz.zustatek)} Kč)`);
  await zalogovat(client, nova.id, 'prevod', poukaz.id, `z ${stara.cislo} (${Number(poukaz.zustatek)} Kč)`);
  return nacistKartu(client, nova.id);
}));

// DELETE /api/poukazove-karty/:id – smazat jen kartu, na které nikdy nebyl poukaz
// (překlep při evidenci). Karty s historií zůstávají kvůli účetnictví.
router.delete('/:id', (req, res) => vTransakci(res, async client => {
  const karta = await kartaProZmenu(client, req.params.id);
  if (!karta) return { chyba: 'Karta nenalezena.', status: 404 };
  const pouzita = await client.query('SELECT 1 FROM darkove_poukazy WHERE karta_id = $1 LIMIT 1', [karta.id]);
  if (karta.aktualni_poukaz_id || pouzita.rows.length) return { chyba: 'Kartu s historií poukazů nejde smazat – můžete ji zablokovat.' };
  await client.query('DELETE FROM poukazove_karty WHERE id = $1', [karta.id]);
  return { ok: true };
}));

module.exports = router;
