const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { jeZablokovana: jeZadostZablokovana, zaznamenatZadost } = require('../middleware/poukazyZadostLimiter');
const { odeslat_upozorneni_zadost_poukaz, odeslat_poukaz_zakaznikovi } = require('./emaily');

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
      ALTER TABLE darkove_poukazy ADD COLUMN IF NOT EXISTS vydano_prodej_id INTEGER REFERENCES prodejna_prodeje(id) ON DELETE SET NULL;
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
  const zbyvaSekund = jeZadostZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho žádostí z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }
  const { hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz } = req.body;
  const hodnotaCislo = Number(hodnota);
  if (!POVOLENE_HODNOTY.includes(hodnotaCislo)) {
    return res.status(400).json({ chyba: `Hodnota poukazu musí být jedna z: ${POVOLENE_HODNOTY.join(', ')} Kč.` });
  }
  if (!kupujici_jmeno || !kupujici_email) {
    return res.status(400).json({ chyba: 'Vyplňte prosím jméno a e-mail.' });
  }
  zaznamenatZadost(req.ip);
  try {
    const result = await pool.query(
      'INSERT INTO poukazy_zadosti (hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [hodnotaCislo, kupujici_jmeno, kupujici_email, kupujici_telefon || null, pro_koho || null, vzkaz || null]
    );
    res.json(result.rows[0]);

    // Až po odpovědi, ať prodleva/chyba s odesláním e-mailu žádost neblokuje
    // (stejný vzor jako u objednávek/rezervací).
    odeslat_upozorneni_zadost_poukaz(result.rows[0]).catch(e => console.error('Upozorneni majitelce o zadosti o poukaz se nepodarilo odeslat:', e.message));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// ═══════════════════════════════
// ADMIN – vydávání a správa poukazů
// ═══════════════════════════════

// POST /api/poukazy – vydat nový poukaz (přímý prodej na prodejně, nebo po potvrzení žádosti z e-shopu)
// Volitelné pole `platba` (hotovost/karta/qr/prevod) říká, že za poukaz teď skutečně přišly peníze –
// v tom případě vznikne i běžný záznam prodeje (prodejna_prodeje), ať jde vytisknout účtenka a peníze
// se započítají do tržeb. Bez `platba` (např. ruční oprava evidence) se prodej nevytváří jako dřív.
router.post('/', vyzadovatAdmina, async (req, res) => {
  const { hodnota, zakoupeno_kde, kupujici_jmeno, kupujici_email, poznamka, platba } = req.body;
  const hodnotaCislo = Number(hodnota);
  if (!POVOLENE_HODNOTY.includes(hodnotaCislo)) {
    return res.status(400).json({ chyba: `Hodnota poukazu musí být jedna z: ${POVOLENE_HODNOTY.join(', ')} Kč.` });
  }
  if (platba && !['hotovost', 'karta', 'qr', 'prevod'].includes(platba)) {
    return res.status(400).json({ chyba: 'Neplatný způsob platby.' });
  }

  const client = await pool.connect();
  try {
    let kod, ean, pokus = 0;
    while (true) {
      kod = vygenerovatKod();
      ean = vygenerovatEan();
      const existuje = await client.query('SELECT id FROM darkove_poukazy WHERE kod = $1 OR ean = $2', [kod, ean]);
      if (existuje.rows.length === 0) break;
      if (++pokus > 10) { client.release(); return res.status(500).json({ chyba: 'Nepodařilo se vygenerovat unikátní kód, zkuste to znovu.' }); }
    }
    const platnostDo = new Date();
    platnostDo.setFullYear(platnostDo.getFullYear() + 1);

    await client.query('BEGIN');

    let poukaz = (await client.query(
      `INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, kupujici_jmeno, kupujici_email, poznamka)
       VALUES ($1,$2,$3,$3,$4,'aktivni',$5,$6,$7,$8) RETURNING *`,
      [kod, ean, hodnotaCislo, platnostDo.toISOString().slice(0,10), zakoupeno_kde || 'prodejna', kupujici_jmeno || null, kupujici_email || null, poznamka || null]
    )).rows[0];

    let prodej = null;
    if (platba) {
      const polozky = [{ nazev: `Dárkový poukaz ${hodnotaCislo} Kč`, typ: 'poukaz', pocet: 1, cena: hodnotaCislo, poukaz_kod: kod }];
      prodej = (await client.query(
        `INSERT INTO prodejna_prodeje (zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva)
         VALUES ($1,$2,$3,$4,$5,$5,0) RETURNING *`,
        [kupujici_jmeno || null, platba, `Prodej dárkového poukazu ${kod}`, JSON.stringify(polozky), hodnotaCislo]
      )).rows[0];
      poukaz = (await client.query(
        'UPDATE darkove_poukazy SET vydano_prodej_id=$1 WHERE id=$2 RETURNING *',
        [prodej.id, poukaz.id]
      )).rows[0];
    }

    await client.query('COMMIT');
    res.json({ ...poukaz, prodej });

    // Kód pošleme zákazníkovi jen když máme e-mail (přímý prodej na prodejně
    // bez e-mailu ho prostě nedostane e-mailem - to je v pořádku, dostane ho
    // fyzicky/ústně). Až po odpovědi, ať prodleva/chyba neblokuje vydání.
    if (poukaz.kupujici_email) {
      odeslat_poukaz_zakaznikovi(poukaz).catch(e => console.error('Email s kodem poukazu se nepodarilo odeslat:', e.message));
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
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
  const client = await pool.connect();
  try {
    const poukaz = await client.query('SELECT * FROM darkove_poukazy WHERE id=$1', [req.params.id]);
    if (poukaz.rows.length === 0) { client.release(); return res.status(404).json({ chyba: 'Poukaz nenalezen.' }); }

    const nikdyNepouzity = Number(poukaz.rows[0].zustatek) === Number(poukaz.rows[0].hodnota);
    if (nikdyNepouzity) {
      // Nikdy nepoužitý poukaz jde bezpečně smazat celý. Pokud za něj byly zaevidované
      // peníze (vydano_prodej_id), smažeme i ten záznam prodeje – jinak by v Prodejně/
      // tržbách zůstala "duchová" platba bez poukazu, na který se váže.
      await client.query('BEGIN');
      await client.query('DELETE FROM darkove_poukazy WHERE id=$1', [req.params.id]);
      if (poukaz.rows[0].vydano_prodej_id) {
        await client.query('DELETE FROM prodejna_prodeje WHERE id=$1', [poukaz.rows[0].vydano_prodej_id]);
      }
      await client.query('COMMIT');
      return res.json({ ok: true, smazano: true });
    }
    // Už částečně/plně použitý poukaz jen zrušíme, ať zůstane účetní stopa
    // (i s případným vydano_prodej_id – peníze při prodeji poukazu skutečně přišly,
    // takže záznam prodeje musí zůstat).
    await client.query("UPDATE darkove_poukazy SET stav='zruseny' WHERE id=$1", [req.params.id]);
    res.json({ ok: true, smazano: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
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
// zapocitano_pri_vydani = true znamená, že peníze za tento poukaz už byly připsané do tržeb
// v okamžiku jeho prodeje (má vydano_prodej_id) – takže tahle jeho útrata se do tržeb podruhé
// nepočítá. U starších poukazů (vydaných před touto funkcí) je false a útrata se do tržeb počítá
// tady, jako dřív.
router.get('/pouziti/vse', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pp.*, (dp.vydano_prodej_id IS NOT NULL) AS zapocitano_pri_vydani
      FROM poukazy_pouziti pp
      JOIN darkove_poukazy dp ON dp.id = pp.poukaz_id
      ORDER BY pp.vytvoreno DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
