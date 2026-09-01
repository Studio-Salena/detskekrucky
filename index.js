const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const pool = require('./db/pool');
const skladRoutes = require('./routes/sklad');
const objednavkyRoutes = require('./routes/objednavky');
const authRoutes = require('./routes/auth');
const platbyRoutes = require('./routes/platby');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());
const path = require('path');
app.use(express.static(path.join(__dirname)));
const kategorieRoutes = require('./routes/kategorie');
const newsletterRoutes = require('./routes/newsletter');
const mobilniSkenRoutes = require('./routes/mobilnisken');
const prodejnaRoutes = require('./routes/prodejna');
const vratkyZadostiRoutes = require('./routes/vratkyZadosti');
const poukazyRoutes = require('./routes/poukazy');
const vyzadovatAdmina = require('./middleware/adminAuth');
const { jeZablokovana, zaznamenatNeuspech, resetovat } = require('./middleware/loginLimiter');
const { jeZablokovana: jeZablokovanaRezervace, zaznamenatRezervaci } = require('./middleware/rezervaceLimiter');
const { odeslat_test, odeslat_potvrzeni_rezervace, odeslat_potvrzeni_terminu, odeslat_upozorneni_rezervace } = require('./routes/emaily');

// Render běží za proxy - bez tohohle by req.ip byla vždy IP proxy, ne
// skutečného klienta, a ochrana proti hádání hesla by nefungovala správně.
app.set('trust proxy', 1);

// Přihlášení do admin panelu – heslo se ověřuje tady na serveru,
// nikdy není součástí kódu na frontendu.
app.post('/api/admin-prihlaseni', (req, res) => {
  const { heslo } = req.body;
  if (!process.env.ADMIN_HESLO) {
    console.error('ADMIN_HESLO není nastaveno v proměnných prostředí!');
    return res.status(500).json({ chyba: 'Server není správně nakonfigurován.' });
  }
  const zbyvaSekund = jeZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho neúspěšných pokusů. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }
  if (heslo && heslo === process.env.ADMIN_HESLO) {
    resetovat(req.ip);
    return res.json({ ok: true });
  }
  zaznamenatNeuspech(req.ip);
  res.status(401).json({ chyba: 'Nesprávné heslo.' });
});

// Zkušební e-mail – ověří, že server umí odesílat (EMAIL_PASS + SMTP)
app.post('/api/test-email', vyzadovatAdmina, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ chyba: 'Chybí e-mailová adresa.' });
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ chyba: 'RESEND_API_KEY není nastaven v proměnných prostředí.' });
  }
  try {
    await odeslat_test(email);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ chyba: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({ zprava: 'DÄ›tskĂ© krĹŻÄŤky API funguje!' });
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
app.use('/api/vratky-zadosti', vratkyZadostiRoutes);
app.use('/api/poukazy', poukazyRoutes);

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
  ],
  trustBadges: [
    { ikona: '🌿', nadpis: 'Přírodní materiály', podnadpis: 'Kůže, bavlna, textil' },
    { ikona: '👣', nadpis: 'Zdravý vývoj', podnadpis: 'Barefoot filozofie' },
    { ikona: '🏅', nadpis: 'S láskou vybrané', podnadpis: '' },
    { ikona: '💛', nadpis: 'Spokojené děti', podnadpis: 'Stovky šťastných nožiček' }
  ],
  mereniKroky: [
    { nadpis: 'Připravte papír a tužku', text: 'Položte list papíru na pevnou rovnou podlahu. Dítě by mělo stát při měření.' },
    { nadpis: 'Obkreslete stopu', text: 'Nechte dítě stát na papíru a opatrně obkreslete celou nožičku tužkou.' },
    { nadpis: 'Změřte délku v mm', text: 'Odměřte vzdálenost od paty k nejdelšímu prstu. Přidejte 10–15 mm pro zdravý prostor.' },
    { nadpis: 'Vyberte správnou velikost', text: 'Porovnejte změřenou délku s velikostí uvedenou u každého produktu. V případě pochybností vyberte větší.' }
  ],
  typyChodidel: [
    { nadpis: 'EGYPTSKÝ TYP', podtitul: '(dominuje palec)', popis: 'Palec je nejdelší, ostatní prsty postupně kratší.', tipy: ['Potřebují botičky s dostatkem místa vpředu', 'Prsty by neměly být stlačené'] },
    { nadpis: 'ŘECKÝ TYP', podtitul: '(dominuje 2. prst)', popis: 'Druhý prst je delší než palec.', tipy: ['Důležitá je široká špička, ať mají prsty prostor', 'Nepřetlačovat'] },
    { nadpis: 'ŘÍMSKÝ TYP', podtitul: '(prsty přibližně stejné)', popis: 'Prsty jsou téměř stejně dlouhé.', tipy: ['Vyhledávejte modely kopírující přirozený tvar chodidla'] },
    { nadpis: 'ŠIROKÝ TYP', podtitul: '(širší chodidlo)', popis: 'Chodidlo je širší v přední části.', tipy: ['Potřebují botičky s extra prostorem vepředu'] },
    { nadpis: 'ÚZKÝ TYP', podtitul: '(užší chodidlo)', popis: 'Chodidlo je užší, s užší patou.', tipy: ['Hledejte botičky, které lépe drží úzkou patu a kotník'] }
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
      ALTER TABLE rezervace ADD COLUMN IF NOT EXISTS zrusovaci_token TEXT UNIQUE;
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
const REZ_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REZ_TELEFON_RE = /^(\+420\s?)?\d{3}\s?\d{3}\s?\d{3}$/;

app.post('/api/rezervace', async (req, res) => {
  const { slot_id, jmeno, telefon, email, vek_dite, poznamka, webova_stranka } = req.body;

  // Honeypot - skryté pole, které reální uživatelé nikdy nevyplní, ale
  // formulářoví boti ano. Předstíráme úspěch, aby se bot nenaučil rozpoznat blokaci.
  if (webova_stranka) {
    return res.json({ id: 0, slot_id, jmeno, telefon, email });
  }

  const zbyvaSekund = jeZablokovanaRezervace(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho rezervací z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }

  if (!slot_id || !jmeno || jmeno.trim().split(/\s+/).length < 2) {
    return res.status(400).json({ chyba: 'Zadejte prosím jméno a příjmení.' });
  }
  if (!telefon || !REZ_TELEFON_RE.test(telefon.trim())) {
    return res.status(400).json({ chyba: 'Zadejte prosím platné telefonní číslo (např. 777 123 456).' });
  }
  if (!email || !REZ_EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ chyba: 'Zadejte prosím platnou e-mailovou adresu.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Zkontroluj že slot je volný
    const slot = await client.query('SELECT * FROM rezervace_sloty WHERE id=$1 FOR UPDATE', [slot_id]);
    if (!slot.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Termín neexistuje' }); }
    if (slot.rows[0].obsazeno) { await client.query('ROLLBACK'); return res.status(409).json({ chyba: 'Termín je již obsazen' }); }
    // Vytvoř rezervaci
    const zrusovaciToken = crypto.randomUUID();
    const rez = await client.query(
      'INSERT INTO rezervace (slot_id, jmeno, telefon, email, vek_dite, poznamka, zrusovaci_token) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [slot_id, jmeno, telefon, email, vek_dite||null, poznamka||null, zrusovaciToken]
    );
    // Označ slot jako obsazený
    await client.query('UPDATE rezervace_sloty SET obsazeno=TRUE WHERE id=$1', [slot_id]);
    await client.query('COMMIT');
    zaznamenatRezervaci(req.ip);
    res.json(rez.rows[0]);
    // E-maily se posílají až po odpovědi zákazníkovi, ať prodleva/chyba s odesláním
    // rezervaci nezablokuje
    odeslat_potvrzeni_rezervace(rez.rows[0], slot.rows[0]).catch(e => console.error('Email o rezervaci se nepodařilo odeslat:', e.message));
    odeslat_upozorneni_rezervace(rez.rows[0], slot.rows[0], 'nova').catch(e => console.error('Upozorneni majitelce se nepodarilo odeslat:', e.message));
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ chyba: e.message }); }
  finally { client.release(); }
});

// GET /rezervace/zrusit/:token – veřejná stránka, zákazník potvrdí zrušení své rezervace
app.get('/rezervace/zrusit/:token', async (req, res) => {
  const styl = `body{font-family:'Nunito',sans-serif;background:#fff8f0;color:#3d2b1f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
    .box{background:#fff;border-radius:16px;padding:32px;max-width:420px;text-align:center;box-shadow:0 8px 40px rgba(139,69,19,0.12)}
    h1{color:#8B4513;font-size:1.3rem;margin-bottom:12px}
    p{color:#7a5c42;font-size:0.95rem;line-height:1.5}
    button{background:linear-gradient(135deg,#e74c3c,#c0392b);color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:16px;font-family:inherit}
    a{color:#8B4513}`;
  try {
    const result = await pool.query(
      `SELECT r.*, s.datum, s.cas_od, s.cas_do FROM rezervace r
       JOIN rezervace_sloty s ON r.slot_id = s.id
       WHERE r.zrusovaci_token = $1`,
      [req.params.token]
    );
    if (!result.rows.length) {
      return res.send(`<html><head><meta charset="UTF-8"><style>${styl}</style></head><body><div class="box"><h1>Odkaz nenalezen</h1><p>Tenhle odkaz na zrušení rezervace není platný.</p></div></body></html>`);
    }
    const rez = result.rows[0];
    if (rez.stav === 'zrusena') {
      return res.send(`<html><head><meta charset="UTF-8"><style>${styl}</style></head><body><div class="box"><h1>✅ Rezervace už je zrušená</h1><p>Tuhle rezervaci jste (nebo jsme) už dřív zrušili.</p></div></body></html>`);
    }
    const datum = new Date(rez.datum).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });
    res.send(`<html><head><meta charset="UTF-8"><style>${styl}</style></head><body><div class="box">
      <h1>Zrušit rezervaci?</h1>
      <p>${rez.jmeno}, termín <strong>${datum}, ${rez.cas_od.slice(0,5)}–${rez.cas_do.slice(0,5)}</strong>.</p>
      <form method="POST" action="/rezervace/zrusit/${req.params.token}">
        <button type="submit">Ano, zrušit rezervaci</button>
      </form>
      <p style="margin-top:16px"><a href="https://www.detskekrucky.cz">← Zpět na web</a></p>
    </div></body></html>`);
  } catch(e) { res.status(500).send('Chyba serveru.'); }
});

// POST /rezervace/zrusit/:token – skutečně zruší rezervaci (potvrzeno kliknutím na tlačítko)
app.post('/rezervace/zrusit/:token', express.urlencoded({ extended: false }), async (req, res) => {
  const styl = `body{font-family:'Nunito',sans-serif;background:#fff8f0;color:#3d2b1f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
    .box{background:#fff;border-radius:16px;padding:32px;max-width:420px;text-align:center;box-shadow:0 8px 40px rgba(139,69,19,0.12)}
    h1{color:#8B4513;font-size:1.3rem;margin-bottom:12px}
    p{color:#7a5c42;font-size:0.95rem;line-height:1.5}
    a{color:#8B4513}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rez = await client.query(
      `SELECT r.*, s.datum, s.cas_od, s.cas_do FROM rezervace r
       JOIN rezervace_sloty s ON r.slot_id = s.id
       WHERE r.zrusovaci_token = $1 FOR UPDATE OF r`,
      [req.params.token]
    );
    if (!rez.rows.length) { await client.query('ROLLBACK'); return res.status(404).send('Odkaz nenalezen.'); }
    const jizZrusena = rez.rows[0].stav === 'zrusena';
    if (!jizZrusena) {
      await client.query('UPDATE rezervace SET stav=$1 WHERE id=$2', ['zrusena', rez.rows[0].id]);
      await client.query('UPDATE rezervace_sloty SET obsazeno=FALSE WHERE id=$1', [rez.rows[0].slot_id]);
    }
    await client.query('COMMIT');
    res.send(`<html><head><meta charset="UTF-8"><style>${styl}</style></head><body><div class="box"><h1>✅ Rezervace zrušena</h1><p>Vaše rezervace byla zrušena. Kdybyste si to rozmysleli, klidně si udělejte novou na webu.</p><p style="margin-top:16px"><a href="https://www.detskekrucky.cz">← Zpět na web</a></p></div></body></html>`);
    if (!jizZrusena) {
      odeslat_upozorneni_rezervace(rez.rows[0], rez.rows[0], 'zrusena').catch(e => console.error('Upozorneni majitelce se nepodarilo odeslat:', e.message));
    }
  } catch(e) { await client.query('ROLLBACK'); res.status(500).send('Chyba serveru.'); }
  finally { client.release(); }
});

// PATCH /api/rezervace/:id/stav – změnit stav (admin)
app.patch('/api/rezervace/:id/stav', vyzadovatAdmina, async (req, res) => {
  const { stav } = req.body;
  if (!['cekajici','potvrzena','zrusena'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rez = await client.query(
      `SELECT r.*, s.datum, s.cas_od, s.cas_do FROM rezervace r
       JOIN rezervace_sloty s ON r.slot_id = s.id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rez.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Rezervace nenalezena' }); }
    const puvodniStav = rez.rows[0].stav;
    await client.query('UPDATE rezervace SET stav=$1 WHERE id=$2', [stav, req.params.id]);
    // Pokud zrušíme, uvolníme slot
    if (stav === 'zrusena') {
      await client.query('UPDATE rezervace_sloty SET obsazeno=FALSE WHERE id=$1', [rez.rows[0].slot_id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
    // Zákazníkovi pošleme e-mail o potvrzení termínu, jen když se stav skutečně mění na potvrzena
    if (stav === 'potvrzena' && puvodniStav !== 'potvrzena') {
      odeslat_potvrzeni_terminu(rez.rows[0], rez.rows[0]).catch(e => console.error('Email o potvrzeni terminu se nepodarilo odeslat:', e.message));
    }
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