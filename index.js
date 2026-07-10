const express = require('express');
const cors = require('cors');
const pool = require('./db/pool');
const skladRoutes = require('./routes/sklad');
const objednavkyRoutes = require('./routes/objednavky');
const authRoutes = require('./routes/auth');
const platbyRoutes = require('./routes/platby');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const supabase = createClient(
  'https://ipzkriwfcghlqfaqenaj.supabase.co',
  'sb_publishable_OtUgL2vcvU17-s4FsdbrqQ_QWD98Xz8'
);
const app = express();
app.use(cors());
app.use(express.json());
const path = require('path');
app.use(express.static(path.join(__dirname)));
const kategorieRoutes = require('./routes/kategorie');
const newsletterRoutes = require('./routes/newsletter');
const mobilniSkenRoutes = require('./routes/mobilnisken');
const prodejnaRoutes = require('./routes/prodejna');
const vyzadovatAdmina = require('./middleware/adminAuth');

// Přihlášení do admin panelu – heslo se ověřuje tady na serveru,
// nikdy není součástí kódu na frontendu.
app.post('/api/admin-prihlaseni', (req, res) => {
  const { heslo } = req.body;
  if (!process.env.ADMIN_HESLO) {
    console.error('ADMIN_HESLO není nastaveno v proměnných prostředí!');
    return res.status(500).json({ chyba: 'Server není správně nakonfigurován.' });
  }
  if (heslo && heslo === process.env.ADMIN_HESLO) {
    return res.json({ ok: true });
  }
  res.status(401).json({ chyba: 'Nesprávné heslo.' });
});

app.get('/', (req, res) => {
  res.json({ zprava: 'DÄ›tskĂ© krĹŻÄŤky API funguje!' });
});

app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT 1 as ok');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, chyba: err.message });
  }
});

app.use('/api/sklad', skladRoutes);
app.use('/api/objednavky', objednavkyRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/platby', platbyRoutes);

app.use('/api/produkty', skladRoutes);
app.use('/api/kategorie', kategorieRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.use('/api/mobilni-sken', mobilniSkenRoutes);
app.use('/api/prodejna', prodejnaRoutes);

// Texty webu (výchozí hodnoty, přepíšou se z DB)
let textyWebu = {
  procBarefoot: [
    { ikona: '👣', nadpis: 'Přirozený vývoj', text: 'Tenká podrážka umožňuje nožičkám vnímat terén a posilovat svaly tak, jak to příroda zamýšlela. Žádné zbytečné tuhé vložky.' },
    { ikona: '🌿', nadpis: 'Přírodní materiály', text: 'Používáme pouze certifikovanou kůži, bavlnu a přírodní gumy. Žádná škodlivá barviva, žádné plasty v kontaktu s pokožkou.' },
    { ikona: '💨', nadpis: 'Dýchatelnost', text: 'Nožičky se v naší obuvi nepotí. Vzdušné materiály zajistí pohodu celý den – při hře venku i v mateřské škole.' }
  ],
  vyberteSi: [
    { nadpis: 'Papučky', text: 'Lehké a vzdušné papučky pro první krůčky. Ideální do školky. Máme značky Beda,' },
    { nadpis: 'Celoroční boty', text: 'Odolné a pohodlné boty pro aktivní dětský dobrodružný den venku i ve městě. Máme značky Froddo, Protetika,' },
    { nadpis: 'Zimní botičky', text: '' },
    { nadpis: 'Gumáky', text: '' }
  ]
};

// Otevírací doba
let oteviracka = {};

async function nacistOtevirackaZDB() {
  try {
    const result = await pool.query("SELECT hodnota FROM nastaveni WHERE klic = 'oteviracka'");
    if (result.rows.length > 0) {
      oteviracka = result.rows[0].hodnota;
    }
  } catch(e) {
    console.log('Oteviracka z DB nenactena:', e.message);
  }
}
nacistOtevirackaZDB();

app.get('/api/nastaveni/oteviraci-doba', (req, res) => {
  res.json(oteviracka);
});

app.post('/api/nastaveni/oteviraci-doba', vyzadovatAdmina, async (req, res) => {
  oteviracka = req.body;
  try {
    await pool.query(
      "INSERT INTO nastaveni (klic, hodnota) VALUES ('oteviracka', $1) ON CONFLICT (klic) DO UPDATE SET hodnota = $1",
      [JSON.stringify(oteviracka)]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ chyba: e.message });
  }
});

// Texty webu
async function nacistTextyZDB() {
  try {
    const result = await pool.query("SELECT hodnota FROM nastaveni WHERE klic = 'texty'");
    if (result.rows.length > 0) {
      textyWebu = result.rows[0].hodnota;
    }
  } catch(e) {
    console.log('Texty z DB nenacteny:', e.message);
  }
}
nacistTextyZDB();

app.get('/api/nastaveni/texty', (req, res) => {
  res.json(textyWebu);
});

app.post('/api/nastaveni/texty', vyzadovatAdmina, async (req, res) => {
  textyWebu = req.body;
  try {
    await pool.query(
      "INSERT INTO nastaveni (klic, hodnota) VALUES ('texty', $1) ON CONFLICT (klic) DO UPDATE SET hodnota = $1",
      [JSON.stringify(textyWebu)]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ chyba: e.message });
  }
});

// ═══════════════════════════════════════════
// REZERVACE
// ═══════════════════════════════════════════

// Inicializace tabulek (spustí se při startu serveru)
async function initRezervaceTabulky() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rezervace_sloty (
        id SERIAL PRIMARY KEY,
        datum DATE NOT NULL,
        cas_od TIME NOT NULL,
        cas_do TIME NOT NULL,
        obsazeno BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS rezervace (
        id SERIAL PRIMARY KEY,
        slot_id INTEGER REFERENCES rezervace_sloty(id) ON DELETE CASCADE,
        jmeno TEXT NOT NULL,
        telefon TEXT NOT NULL,
        email TEXT NOT NULL,
        vek_dite TEXT,
        poznamka TEXT,
        stav TEXT DEFAULT 'cekajici',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Rezervace tabulky OK');
  } catch(e) {
    console.log('Rezervace tabulky chyba:', e.message);
  }
}
initRezervaceTabulky();

// GET /api/rezervace/sloty – všechny sloty (pro admin i frontend)
app.get('/api/rezervace/sloty', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rezervace_sloty ORDER BY datum, cas_od');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ chyba: e.message }); }
});

// POST /api/rezervace/sloty – přidat slot (admin)
app.post('/api/rezervace/sloty', vyzadovatAdmina, async (req, res) => {
  const { datum, cas_od, cas_do } = req.body;
  if (!datum || !cas_od || !cas_do) return res.status(400).json({ chyba: 'Chybí datum nebo časy' });
  try {
    const result = await pool.query(
      'INSERT INTO rezervace_sloty (datum, cas_od, cas_do) VALUES ($1, $2, $3) RETURNING *',
      [datum, cas_od, cas_do]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ chyba: e.message }); }
});

// DELETE /api/rezervace/sloty/:id – smazat slot (admin)
app.delete('/api/rezervace/sloty/:id', vyzadovatAdmina, async (req, res) => {
  try {
    await pool.query('DELETE FROM rezervace_sloty WHERE id=$1 AND obsazeno=FALSE', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ chyba: e.message }); }
});

// GET /api/rezervace – všechny rezervace (jen pro admin – obsahuje osobní údaje)
app.get('/api/rezervace', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rezervace ORDER BY created_at DESC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ chyba: e.message }); }
});

// POST /api/rezervace – zákazník vytvoří rezervaci
app.post('/api/rezervace', async (req, res) => {
  const { slot_id, jmeno, telefon, email, vek_dite, poznamka } = req.body;
  if (!slot_id || !jmeno || !telefon || !email) return res.status(400).json({ chyba: 'Chybí povinná pole' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Zkontroluj že slot je volný
    const slot = await client.query('SELECT * FROM rezervace_sloty WHERE id=$1 FOR UPDATE', [slot_id]);
    if (!slot.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Termín neexistuje' }); }
    if (slot.rows[0].obsazeno) { await client.query('ROLLBACK'); return res.status(409).json({ chyba: 'Termín je již obsazen' }); }
    // Vytvoř rezervaci
    const rez = await client.query(
      'INSERT INTO rezervace (slot_id, jmeno, telefon, email, vek_dite, poznamka) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [slot_id, jmeno, telefon, email, vek_dite||null, poznamka||null]
    );
    // Označ slot jako obsazený
    await client.query('UPDATE rezervace_sloty SET obsazeno=TRUE WHERE id=$1', [slot_id]);
    await client.query('COMMIT');
    res.json(rez.rows[0]);
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ chyba: e.message }); }
  finally { client.release(); }
});

// PATCH /api/rezervace/:id/stav – změnit stav (admin)
app.patch('/api/rezervace/:id/stav', vyzadovatAdmina, async (req, res) => {
  const { stav } = req.body;
  if (!['cekajici','potvrzena','zrusena'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rez = await client.query('SELECT * FROM rezervace WHERE id=$1', [req.params.id]);
    if (!rez.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Rezervace nenalezena' }); }
    await client.query('UPDATE rezervace SET stav=$1 WHERE id=$2', [stav, req.params.id]);
    // Pokud zrušíme, uvolníme slot
    if (stav === 'zrusena') {
      await client.query('UPDATE rezervace_sloty SET obsazeno=FALSE WHERE id=$1', [rez.rows[0].slot_id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ chyba: e.message }); }
  finally { client.release(); }
});
// Banner
let banner = {};
app.get('/api/nastaveni/banner', (req, res) => {
  res.json(banner);
});
app.post('/api/nastaveni/banner', vyzadovatAdmina, (req, res) => {
  banner = req.body;
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('Server bezi na http://127.0.0.1:3000');
});