const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');

const POVOLENE_HODNOTY = [500, 1000, 1500];

async function initTabulky() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS darkove_poukazy (
        id SERIAL PRIMARY KEY,
        kod TEXT UNIQUE NOT NULL,
        ean TEXT UNIQUE NOT NULL,
        hodnota NUMERIC NOT NULL,
        zustatek NUMERIC NOT NULL,
        platnost_do DATE NOT NULL,
        stav TEXT NOT NULL DEFAULT 'aktivni',
        zakoupeno_kde TEXT NOT NULL,
        kupujici_jmeno TEXT,
        kupujici_email TEXT,
        poznamka TEXT,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS poukazy_pouziti (
        id SERIAL PRIMARY KEY,
        poukaz_id INTEGER REFERENCES darkove_poukazy(id) ON DELETE CASCADE,
        castka NUMERIC NOT NULL,
        prodej_id INTEGER,
        objednavka_id INTEGER,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS poukazy_zadosti (
        id SERIAL PRIMARY KEY,
        hodnota NUMERIC NOT NULL,
        kupujici_jmeno TEXT NOT NULL,
        kupujici_email TEXT NOT NULL,
        kupujici_telefon TEXT,
        pro_koho TEXT,
        vzkaz TEXT,
        stav TEXT NOT NULL DEFAULT 'nova',
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Poukazy tabulky OK');
  } catch (e) {
    console.log('Poukazy tabulky chyba:', e.message);
  }
}
initTabulky();

function vygenerovatKod() {
  const znaky = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez matoucích znaků (0/O, 1/I)
  let c1 = '', c2 = '';
  for (let i = 0; i < 4; i++) c1 += znaky[Math.floor(Math.random() * znaky.length)];
  for (let i = 0; i < 4; i++) c2 += znaky[Math.floor(Math.random() * znaky.length)];
  return `DK-${c1}-${c2}`;
}

// Vygeneruje platný EAN-13 kód (prefix 20 = interní/vlastní použití dle GS1)
function vygenerovatEan() {
  let zaklad = '20';
  for (let i = 0; i < 10; i++) zaklad += Math.floor(Math.random() * 10);
  let soucet = 0;
  for (let i = 0; i < 12; i++) {
    soucet += Number(zaklad[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const kontrolni = (10 - (soucet % 10)) % 10;
  return zaklad + kontrolni;
}

// ═══════════════════════════════
// VEŘEJNÉ – ověření poukazu (volá prodejna i e-shop, bez přihlášení)
// ═══════════════════════════════
router.get('/overit/:kod', async (req, res) => {
  const hledany = req.params.kod.trim().toUpperCase();
  try {
    const result = await pool.query(
      'SELECT * FROM darkove_poukazy WHERE UPPER(kod) = $1 OR ean = $1',
      [hledany]
    );
    if (result.rows.length === 0) return res.status(404).json({ chyba: 'Poukaz nebyl nalezen.' });
    const poukaz = result.rows[0];
    if (poukaz.stav === 'zruseny') return res.status(400).json({ chyba: 'Tento poukaz byl zrušen.' });
    if (poukaz.stav === 'pouzity' || Number(poukaz.zustatek) <= 0) return res.status(400).json({ chyba: 'Tento poukaz je již plně vyčerpaný.' });
    if (new Date(poukaz.platnost_do) < new Date()) return res.status(400).json({ chyba: 'Platnost poukazu vypršela.' });
    res.json({ id: poukaz.id, kod: poukaz.kod, ean: poukaz.ean, hodnota: Number(poukaz.hodnota), zustatek: Number(poukaz.zustatek), platnost_do: poukaz.platnost_do });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/poukazy/zadost – zákazník na e-shopu žádá o koupi poukazu (veřejné)
router.post('/zadost', async (req, res) => {
  const { hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz } = req.body;
  const hodnotaCislo = Number(hodnota);
  if (!POVOLENE_HODNOTY.includes(hodnotaCislo)) {
    return res.status(400).json({ chyba: `Hodnota poukazu musí být jedna z: ${POVOLENE_HODNOTY.join(', ')} Kč.` });
  }
  if (!kupujici_jmeno || !kupujici_email) {
    return res.status(400).json({ chyba: 'Vyplňte prosím jméno a e-mail.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO poukazy_zadosti (hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [hodnotaCislo, kupujici_jmeno, kupujici_email, kupujici_telefon || null, pro_koho || null, vzkaz || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// ═══════════════════════════════
// ADMIN – vydávání a správa poukazů
// ═══════════════════════════════

// POST /api/poukazy – vydat nový poukaz (přímý prodej na prodejně, nebo po potvrzení žádosti z e-shopu)
router.post('/', vyzadovatAdmina, async (req, res) => {
  const { hodnota, zakoupeno_kde, kupujici_jmeno, kupujici_email, poznamka } = req.body;
  const hodnotaCislo = Number(hodnota);
  if (!POVOLENE_HODNOTY.includes(hodnotaCislo)) {
    return res.status(400).json({ chyba: `Hodnota poukazu musí být jedna z: ${POVOLENE_HODNOTY.join(', ')} Kč.` });
  }
  try {
    let kod, ean, pokus = 0;
    while (true) {
      kod = vygenerovatKod();
      ean = vygenerovatEan();
      const existuje = await pool.query('SELECT id FROM darkove_poukazy WHERE kod = $1 OR ean = $2', [kod, ean]);
      if (existuje.rows.length === 0) break;
      if (++pokus > 10) return res.status(500).json({ chyba: 'Nepodařilo se vygenerovat unikátní kód, zkuste to znovu.' });
    }
    const platnostDo = new Date();
    platnostDo.setFullYear(platnostDo.getFullYear() + 1);

    const result = await pool.query(
      `INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, kupujici_jmeno, kupujici_email, poznamka)
       VALUES ($1,$2,$3,$3,$4,'aktivni',$5,$6,$7,$8) RETURNING *`,
      [kod, ean, hodnotaCislo, platnostDo.toISOString().slice(0,10), zakoupeno_kde || 'prodejna', kupujici_jmeno || null, kupujici_email || null, poznamka || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/poukazy – seznam všech vydaných poukazů
router.get('/', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM darkove_poukazy ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/poukazy/pouzit – uplatnit poukaz na prodejně (odečíst zůstatek)
router.post('/pouzit', vyzadovatAdmina, async (req, res) => {
  const { kod, castka, prodej_id } = req.body;
  if (!kod || !castka || castka <= 0) return res.status(400).json({ chyba: 'Chybí kód nebo částka.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM darkove_poukazy WHERE UPPER(kod) = $1 OR ean = $1 FOR UPDATE', [kod.trim().toUpperCase()]);
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Poukaz nebyl nalezen.' }); }
    const poukaz = result.rows[0];
    if (poukaz.stav !== 'aktivni') { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'Poukaz už není aktivní.' }); }
    if (Number(poukaz.zustatek) < castka) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: `Na poukazu zbývá jen ${poukaz.zustatek} Kč.` }); }

    const novyZustatek = Number(poukaz.zustatek) - Number(castka);
    const novyStav = novyZustatek <= 0 ? 'pouzity' : 'aktivni';
    await client.query('UPDATE darkove_poukazy SET zustatek=$1, stav=$2 WHERE id=$3', [novyZustatek, novyStav, poukaz.id]);
    await client.query('INSERT INTO poukazy_pouziti (poukaz_id, castka, prodej_id) VALUES ($1,$2,$3)', [poukaz.id, castka, prodej_id || null]);

    await client.query('COMMIT');
    res.json({ ok: true, zustatek: novyZustatek });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/poukazy/:id – zrušit poukaz (zůstává v evidenci pro účetnictví, jen se znepřístupní)
router.delete('/:id', vyzadovatAdmina, async (req, res) => {
  try {
    await pool.query("UPDATE darkove_poukazy SET stav='zruseny' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// ═══════════════════════════════
// ADMIN – žádosti o koupi poukazu z e-shopu
// ═══════════════════════════════

router.get('/zadosti/vse', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM poukazy_zadosti ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.patch('/zadosti/:id/stav', vyzadovatAdmina, async (req, res) => {
  const { stav } = req.body;
  if (!['nova','vyrizena','zamitnuta'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  try {
    const result = await pool.query('UPDATE poukazy_zadosti SET stav=$1 WHERE id=$2 RETURNING *', [stav, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/poukazy/pouziti/vse – historie uplatnění poukazů (pro účetnictví)
router.get('/pouziti/vse', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM poukazy_pouziti ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
