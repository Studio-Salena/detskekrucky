const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { jeZablokovana: jeLoginZablokovana, zaznamenatNeuspech, resetovat: resetovatLogin } = require('../middleware/zakaznikLoginLimiter');
const { jeZablokovana: jeRegistraceZablokovana, zaznamenatRegistraci } = require('../middleware/registraceLimiter');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('CHYBA: JWT_SECRET není nastaven v proměnných prostředí! Přihlašování zákazníků nebude fungovat bezpečně.');
}

// Registrace
router.post('/registrace', async (req, res) => {
  const zbyvaSekund = jeRegistraceZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho pokusů o registraci z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }
  zaznamenatRegistraci(req.ip);
  const { jmeno, email, heslo, telefon, ulice, mesto, psc } = req.body;
  try {
    const existuje = await pool.query('SELECT id, heslo FROM zakaznici WHERE email = $1', [email]);
    if (existuje.rows.length > 0) {
      if (existuje.rows[0].heslo) {
        // Skutečný, už dřív dokončený účet - klasické "email je zabraný".
        return res.status(400).json({ chyba: 'Email je jiz registrovan' });
      }
      // Zákazník vznikl jen z objednávky bez zadání hesla (host checkout) -
      // účet ještě nikdy nešel dokončit, takže mu teď heslo prostě doplníme
      // místo toho, abychom ho navěky blokovali hláškou "email už existuje".
      const hash = await bcrypt.hash(heslo, 10);
      const id = existuje.rows[0].id;
      await pool.query(
        'UPDATE zakaznici SET heslo=$1, jmeno=$2, telefon=$3, ulice=$4, mesto=$5, psc=$6 WHERE id=$7',
        [hash, jmeno, telefon, ulice, mesto, psc, id]
      );
      const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ zprava: 'Registrace uspesna', token });
    }
    const hash = await bcrypt.hash(heslo, 10);
    const result = await pool.query(
      'INSERT INTO zakaznici (jmeno, email, heslo, telefon, ulice, mesto, psc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [jmeno, email, hash, telefon, ulice, mesto, psc]
    );
    const token = jwt.sign({ id: result.rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ zprava: 'Registrace uspesna', token });
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
    const token = jwt.sign({ id: zakaznik.id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, jmeno: zakaznik.jmeno, email: zakaznik.email });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Profil zakaznika
router.get('/profil', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ chyba: 'Neprihlaseno' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT id, jmeno, email, telefon, ulice, mesto, psc FROM zakaznici WHERE id = $1',
      [decoded.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(401).json({ chyba: 'Neplatny token' });
  }
});

// Historie objednavek zakaznika
router.get('/moje-objednavky', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ chyba: 'Neprihlaseno' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(`
      SELECT o.id, o.stav, o.celkem, o.vytvoreno, o.doprava
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      WHERE z.id = $1
      ORDER BY o.vytvoreno DESC
    `, [decoded.id]);
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

