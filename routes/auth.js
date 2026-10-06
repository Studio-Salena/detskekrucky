const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { jeZablokovana: jeLoginZablokovana, zaznamenatNeuspech, resetovat: resetovatLogin } = require('../middleware/zakaznikLoginLimiter');
const { jeZablokovana: jeRegistraceZablokovana, zaznamenatRegistraci } = require('../middleware/registraceLimiter');
const { odeslat_overeni_emailu } = require('./emaily');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('CHYBA: JWT_SECRET není nastaven v proměnných prostředí! Přihlašování zákazníků nebude fungovat bezpečně.');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_DELKA_HESLA = 5;
const PLATNOST_OVERENI_HODIN = 24;
const ODKAZ_OVERENI = 'https://www.detskekrucky.cz/eshop.html?overeni=';

// Ověřování e-mailu zákazníka (bezpečnostní oprava převzetí účtu):
//
// Objednávka bez účtu páruje zákazníka jen podle e-mailu (routes/objednavky.js)
// a přepisuje mu adresu/telefon. Kdo by si mohl bez ověření nastavit heslo k
// cizímu e-mailu, viděl by cizí objednávky a osobní údaje. Proto:
//   - zakaznici.email_overen_at: účet bez ověřeného e-mailu neuvidí objednávky
//     ani adresu/telefon (jen to, co sám zadal: jméno a e-mail),
//   - host záznam (bez hesla) nebo neověřený účet se heslem "převezme" až po
//     kliknutí na jednorázový odkaz z e-mailu (tabulka overeni_emailu),
//   - zakaznici.heslo_zmeneno_at: JWT vydané dřív se po převzetí zneplatní
//     (jinak by útočníkovi zůstal 7denní přístup k už ověřenému účtu).
async function initOvereniEmailu() {
  try {
    const sloupec = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'zakaznici' AND column_name = 'email_overen_at'"
    );
    if (!sloupec.rows.length) {
      await pool.query('ALTER TABLE zakaznici ADD COLUMN IF NOT EXISTS email_overen_at TIMESTAMPTZ');
      // Jednorázově při zavedení: účty s heslem vzniklé před touto změnou se
      // berou jako ověřené, ať se stávajícím zákazníkům nic nerozbije.
      await pool.query('UPDATE zakaznici SET email_overen_at = NOW() WHERE heslo IS NOT NULL AND email_overen_at IS NULL');
    }
    await pool.query(`
      ALTER TABLE zakaznici ADD COLUMN IF NOT EXISTS heslo_zmeneno_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS overeni_emailu (
        id SERIAL PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        zakaznik_id INTEGER NOT NULL REFERENCES zakaznici(id) ON DELETE CASCADE,
        heslo_hash TEXT,
        jmeno TEXT,
        expirace TIMESTAMPTZ NOT NULL,
        pouzito_at TIMESTAMPTZ,
        vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('Overeni emailu OK');
  } catch (e) {
    console.log('Overeni emailu chyba:', e.message);
  }
}
pripravit(initOvereniEmailu());

function validovatRegistraci({ jmeno, email, heslo }) {
  if (!jmeno || !String(jmeno).trim()) return 'Vyplňte prosím jméno.';
  if (!email || !EMAIL_RE.test(String(email).trim())) return 'Zadejte prosím platný e-mail (musí obsahovat @).';
  if (!heslo || String(heslo).length < MIN_DELKA_HESLA) return `Heslo musí mít alespoň ${MIN_DELKA_HESLA} znaků.`;
  return null;
}

// V DB se drží jen SHA-256 hash tokenu - únik tabulky by nedal použitelné odkazy.
function hashTokenu(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Založí jednorázový token (256 bitů náhody) a pošle odkaz na e-mail zákazníka.
// heslo_hash/jmeno = čekající převzetí host/neověřeného záznamu (heslo se
// nastaví až po ověření); null = jen potvrzení e-mailu u nového účtu.
async function poslatOvereni(zakaznik, { hesloHash = null, jmeno = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM overeni_emailu WHERE expirace < NOW() - INTERVAL \'7 days\'');
  await pool.query(
    `INSERT INTO overeni_emailu (token_hash, zakaznik_id, heslo_hash, jmeno, expirace)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${PLATNOST_OVERENI_HODIN} hours')`,
    [hashTokenu(token), zakaznik.id, hesloHash, jmeno]
  );
  await odeslat_overeni_emailu({
    email: zakaznik.email,
    jmeno: jmeno || zakaznik.jmeno,
    odkaz: ODKAZ_OVERENI + token,
    platnostHodin: PLATNOST_OVERENI_HODIN
  });
}

// "vydano" v milisekundách - iat má jen celé sekundy, takže token útočníka
// vydaný ve stejné sekundě jako převzetí účtu by jinak prošel dál.
function vydatToken(zakaznik) {
  return jwt.sign({ id: zakaznik.id, email: zakaznik.email, vydano: Date.now() }, JWT_SECRET, { expiresIn: '7d' });
}

// Ověří JWT a načte zákazníka. Token vydaný před posledním nastavením hesla
// (převzetí účtu po ověření e-mailu) už neplatí. Vrací null = nepřihlášeno.
async function nacistPrihlaseneho(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
  const result = await pool.query(
    'SELECT id, jmeno, email, telefon, ulice, mesto, psc, email_overen_at, heslo_zmeneno_at FROM zakaznici WHERE id = $1',
    [decoded.id]
  );
  const zakaznik = result.rows[0];
  if (!zakaznik) return null;
  // Starší tokeny (bez "vydano") se posuzují podle iat.
  const vydano = typeof decoded.vydano === 'number' ? decoded.vydano : decoded.iat * 1000;
  if (zakaznik.heslo_zmeneno_at && vydano < new Date(zakaznik.heslo_zmeneno_at).getTime()) {
    return null;
  }
  return zakaznik;
}

// Registrace
router.post('/registrace', async (req, res) => {
  const zbyvaSekund = jeRegistraceZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho pokusů o registraci z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }
  zaznamenatRegistraci(req.ip);
  const { jmeno, email, heslo, telefon, ulice, mesto, psc } = req.body;
  const chybaValidace = validovatRegistraci({ jmeno, email, heslo });
  if (chybaValidace) return res.status(400).json({ chyba: chybaValidace });
  try {
    const existuje = await pool.query('SELECT id, jmeno, email, heslo, email_overen_at FROM zakaznici WHERE email = $1', [email]);
    if (existuje.rows.length > 0) {
      const zakaznik = existuje.rows[0];
      if (zakaznik.heslo && zakaznik.email_overen_at) {
        return res.status(400).json({ chyba: 'Tento e-mail už má účet – přihlaste se prosím.' });
      }
      // Host záznam z objednávky bez účtu, nebo účet s dosud neověřeným
      // e-mailem: k záznamu se NIC nepřipojí ani nepřepíše, dokud registrující
      // neprokáže, že e-mail je jeho. Heslo čeká (jako hash) u tokenu.
      const hesloHash = await bcrypt.hash(heslo, 10);
      await poslatOvereni(zakaznik, { hesloHash, jmeno: String(jmeno).trim() });
      return res.json({
        overeni_odeslano: true,
        zprava: 'Na váš e-mail jsme poslali odkaz pro dokončení registrace. Po kliknutí na odkaz zadáte heslo, které jste právě zvolili, a účet bude aktivní.'
      });
    }
    const hash = await bcrypt.hash(heslo, 10);
    const result = await pool.query(
      'INSERT INTO zakaznici (jmeno, email, heslo, telefon, ulice, mesto, psc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [jmeno, email, hash, telefon, ulice, mesto, psc]
    );
    const zakaznik = { id: result.rows[0].id, jmeno, email };
    // Nový účet funguje hned (přihlášení), objednávky a adresu ale uvidí až
    // po potvrzení e-mailu - viz nacistPrihlaseneho/moje-objednavky.
    poslatOvereni(zakaznik).catch(e => console.error('Overovaci email se nepodarilo odeslat:', e.message));
    res.json({ zprava: 'Registrace uspesna', token: vydatToken(zakaznik), jmeno, email, email_overen: false });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Ověření e-mailu kliknutím na odkaz - token je jednorázový a časově omezený.
router.post('/overit-email', async (req, res) => {
  const zbyvaSekund = jeLoginZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho neúspěšných pokusů. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }
  const { token, heslo } = req.body || {};
  const neplatny = () => {
    zaznamenatNeuspech(req.ip);
    return res.status(400).json({ chyba: 'Odkaz je neplatný, už byl použit, nebo vypršel. Zkuste se zaregistrovat znovu.' });
  };
  if (!token || typeof token !== 'string' || token.length > 200) return neplatny();
  if (!heslo || typeof heslo !== 'string') {
    return res.status(400).json({ chyba: 'Zadejte prosím heslo, které jste zvolili při registraci.', heslo_potreba: true });
  }
  try {
    // Samotný odkaz nestačí: kdo registraci odeslal, zná heslo, a kdo vlastní
    // schránku, má odkaz. Bez obojího by šlo útočníkovi "ověřit" účet tím, že
    // oběť omylem klikne na odkaz z registrace, kterou založil útočník.
    // Ověřuje se proti čekajícímu heslu (převzetí host/neověřeného záznamu),
    // jinak proti heslu nově založeného účtu. Špatné heslo token nespotřebuje.
    const cekajici = await pool.query(
      `SELECT o.heslo_hash, z.heslo AS heslo_uctu
       FROM overeni_emailu o JOIN zakaznici z ON z.id = o.zakaznik_id
       WHERE o.token_hash = $1 AND o.pouzito_at IS NULL AND o.expirace > NOW()`,
      [hashTokenu(token)]
    );
    if (!cekajici.rows.length) return neplatny();
    const ocekavaneHeslo = cekajici.rows[0].heslo_hash || cekajici.rows[0].heslo_uctu;
    if (!ocekavaneHeslo || !(await bcrypt.compare(heslo, ocekavaneHeslo))) {
      zaznamenatNeuspech(req.ip);
      return res.status(400).json({ chyba: 'Nesprávné heslo. Zadejte heslo, které jste zvolili při registraci.', heslo_potreba: true });
    }

    // Atomické "spotřebování" tokenu - dva souběžné požadavky ho nepoužijí oba.
    const spotrebovany = await pool.query(
      `UPDATE overeni_emailu SET pouzito_at = NOW()
       WHERE token_hash = $1 AND pouzito_at IS NULL AND expirace > NOW()
       RETURNING zakaznik_id, heslo_hash, jmeno`,
      [hashTokenu(token)]
    );
    if (!spotrebovany.rows.length) return neplatny();
    const { zakaznik_id, heslo_hash, jmeno } = spotrebovany.rows[0];

    let result;
    if (heslo_hash) {
      // Převzetí host/neověřeného záznamu. Podmínka email_overen_at IS NULL:
      // už ověřený účet (a jeho heslo) nejde přepsat starším čekajícím odkazem.
      // Adresa a telefon zůstávají - patří ověřenému majiteli e-mailu.
      // Čas změny hesla z aplikace (ne NOW() databáze), ať ho jde přesně
      // porovnat s "vydano" v JWT - hodiny DB a serveru se můžou lišit.
      result = await pool.query(
        `UPDATE zakaznici SET heslo = $1, jmeno = COALESCE($2, jmeno), email_overen_at = NOW(), heslo_zmeneno_at = $4
         WHERE id = $3 AND email_overen_at IS NULL
         RETURNING id, jmeno, email`,
        [heslo_hash, jmeno, zakaznik_id, new Date()]
      );
    } else {
      result = await pool.query(
        'UPDATE zakaznici SET email_overen_at = COALESCE(email_overen_at, NOW()) WHERE id = $1 RETURNING id, jmeno, email',
        [zakaznik_id]
      );
    }
    if (!result.rows.length) return neplatny();
    const zakaznik = result.rows[0];
    // Ostatní čekající odkazy pro stejný záznam už nesmí nic měnit.
    await pool.query('UPDATE overeni_emailu SET pouzito_at = NOW() WHERE zakaznik_id = $1 AND pouzito_at IS NULL', [zakaznik.id]);
    res.json({ token: vydatToken(zakaznik), jmeno: zakaznik.jmeno, email: zakaznik.email, email_overen: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Znovu poslat ověřovací odkaz přihlášenému zákazníkovi s neověřeným e-mailem
router.post('/overeni-znovu', async (req, res) => {
  const zbyvaSekund = jeRegistraceZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho pokusů. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }
  try {
    const zakaznik = await nacistPrihlaseneho(req);
    if (!zakaznik) return res.status(401).json({ chyba: 'Neprihlaseno' });
    if (zakaznik.email_overen_at) return res.status(400).json({ chyba: 'E-mail už je ověřený.' });
    zaznamenatRegistraci(req.ip);
    await poslatOvereni(zakaznik);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Prihlaseni
router.post('/prihlaseni', async (req, res) => {
  const zbyvaSekund = jeLoginZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho neúspěšných pokusů. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }
  const { email, heslo } = req.body;
  try {
    const result = await pool.query('SELECT * FROM zakaznici WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      zaznamenatNeuspech(req.ip);
      return res.status(400).json({ chyba: 'Neplatny email nebo heslo' });
    }
    const zakaznik = result.rows[0];
    if (!zakaznik.heslo) {
      // Zákazník vznikl jen z host objednávky a heslo si ještě nikdy nenastavil -
      // bcrypt.compare(heslo, null) by shodilo request na 500. Stejná generická
      // hláška jako u špatného hesla, ať se nedá zjistit, které účty mají heslo.
      zaznamenatNeuspech(req.ip);
      return res.status(400).json({ chyba: 'Neplatny email nebo heslo' });
    }
    const shoda = await bcrypt.compare(heslo, zakaznik.heslo);
    if (!shoda) {
      zaznamenatNeuspech(req.ip);
      return res.status(400).json({ chyba: 'Neplatny email nebo heslo' });
    }
    resetovatLogin(req.ip);
    // Jméno v záznamu mohla mezitím přepsat objednávka bez účtu se stejným
    // e-mailem (routes/objednavky.js) - neověřenému účtu ho proto nevracíme.
    const overen = !!zakaznik.email_overen_at;
    res.json({ token: vydatToken(zakaznik), jmeno: overen ? zakaznik.jmeno : null, email: zakaznik.email, email_overen: overen });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Profil zakaznika - jméno, adresu a telefon vidí jen účet s ověřeným e-mailem
// (jinak by to mohly být údaje, které k e-mailu vyplnil někdo jiný při objednávce).
router.get('/profil', async (req, res) => {
  try {
    const zakaznik = await nacistPrihlaseneho(req);
    if (!zakaznik) return res.status(401).json({ chyba: 'Neplatny token' });
    const { id, jmeno, email, telefon, ulice, mesto, psc } = zakaznik;
    if (!zakaznik.email_overen_at) return res.json({ id, jmeno: null, email, email_overen: false });
    res.json({ id, jmeno, email, telefon, ulice, mesto, psc, email_overen: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Historie objednavek zakaznika - jen po ověření e-mailu (objednávky se k
// záznamu přiřazují podle e-mailu, takže neověřený účet by mohl vidět cizí).
router.get('/moje-objednavky', async (req, res) => {
  try {
    const zakaznik = await nacistPrihlaseneho(req);
    if (!zakaznik) return res.status(401).json({ chyba: 'Neprihlaseno' });
    if (!zakaznik.email_overen_at) {
      return res.status(403).json({ chyba: 'Pro zobrazení objednávek potvrďte svůj e-mail odkazem, který jsme vám poslali.', overeni_potreba: true });
    }
    const result = await pool.query(`
      SELECT o.id, o.cislo, o.stav, o.celkem, o.vytvoreno, o.doprava
      FROM objednavky o
      WHERE o.zakaznik_id = $1
      ORDER BY o.vytvoreno DESC
    `, [zakaznik.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Všichni zákazníci (jen pro admin – obsahuje osobní údaje)
router.get('/zakaznici', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, jmeno, email, telefon, ulice, mesto, psc, vytvoreno FROM zakaznici ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Přidat zákazníka ručně (jen pro admin / prodejna)
router.post('/zakaznici', vyzadovatAdmina, async (req, res) => {
  const { jmeno, email, telefon, ulice, mesto, psc, newsletter } = req.body;
  if (!jmeno || !email) return res.status(400).json({ chyba: 'Vyplňte prosím jméno a e-mail.' });
  try {
    const existuje = await pool.query('SELECT id FROM zakaznici WHERE email = $1', [email]);
    if (existuje.rows.length > 0) {
      return res.status(400).json({ chyba: 'Zákazník s tímto e-mailem už existuje.' });
    }

    // Vygenerovat náhodné heslo (zákazník přidaný na prodejně se zatím nepřihlašuje online)
    const nahodneHeslo = Math.random().toString(36).slice(-12);
    const hash = await bcrypt.hash(nahodneHeslo, 10);

    const result = await pool.query(
      'INSERT INTO zakaznici (jmeno, email, heslo, telefon, ulice, mesto, psc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, jmeno, email, telefon, ulice, mesto, psc, vytvoreno',
      [jmeno, email, hash, telefon || null, ulice || null, mesto || null, psc || null]
    );

    if (newsletter) {
      try {
        await pool.query('INSERT INTO newsletter (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
      } catch (e) { /* newsletter tabulka může chybět, ignorovat */ }
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Upravit zákazníka
router.put('/zakaznici/:id', vyzadovatAdmina, async (req, res) => {
  const { jmeno, email, telefon, ulice, mesto, psc, newsletter } = req.body;
  if (!jmeno || !email) return res.status(400).json({ chyba: 'Vyplňte prosím jméno a e-mail.' });
  try {
    const dup = await pool.query('SELECT id FROM zakaznici WHERE email = $1 AND id <> $2', [email, req.params.id]);
    if (dup.rows.length > 0) return res.status(400).json({ chyba: 'Jiný zákazník s tímto e-mailem už existuje.' });

    const result = await pool.query(
      'UPDATE zakaznici SET jmeno=$1, email=$2, telefon=$3, ulice=$4, mesto=$5, psc=$6 WHERE id=$7 RETURNING id, jmeno, email, telefon, ulice, mesto, psc, vytvoreno',
      [jmeno, email, telefon || null, ulice || null, mesto || null, psc || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ chyba: 'Zákazník nenalezen.' });

    // Newsletter – přihlásit / odhlásit podle checkboxu
    if (newsletter === true) {
      try { await pool.query('INSERT INTO newsletter (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]); } catch (e) {}
    } else if (newsletter === false) {
      try { await pool.query('DELETE FROM newsletter WHERE email = $1', [email]); } catch (e) {}
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Smazat zákazníka
router.delete('/zakaznici/:id', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM zakaznici WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ chyba: 'Zákazník nenalezen.' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ chyba: 'Zákazníka nelze smazat – má navázané objednávky (historii je potřeba zachovat).' });
    }
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;

