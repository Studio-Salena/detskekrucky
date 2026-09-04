const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');

// Idempotentní migrace - rozměry patří k velikosti (sklad), typ nohy k produktu.
// Stejný vzor jako routes/prodejna.js:initTabulky.
async function initSkladSloupce() {
  try {
    await pool.query(`
      ALTER TABLE sklad ADD COLUMN IF NOT EXISTS delka_mm INTEGER;
      ALTER TABLE sklad ADD COLUMN IF NOT EXISTS sirka_mm INTEGER;
      ALTER TABLE sklad ADD COLUMN IF NOT EXISTS dostupnost TEXT NOT NULL DEFAULT 'skladem';
      ALTER TABLE produkty ADD COLUMN IF NOT EXISTS typ_nohy TEXT;
    `);
    // Postgres nemá "ADD CONSTRAINT IF NOT EXISTS" - když constraint už existuje, chybu tiše ignorujeme.
    await pool.query(`ALTER TABLE sklad ADD CONSTRAINT sklad_pocet_kusu_nezaporny CHECK (pocet_kusu >= 0)`);
    console.log('Sklad/produkty sloupce OK');
  } catch (e) {
    if (e.code !== '42710') console.log('Sklad/produkty sloupce chyba:', e.message);
  }
}
initSkladSloupce();

// Veřejné - frontend (e-shop) nesmí dostat interní skladové údaje jako
// min_pocet (interní práh pro "nízký stav") nebo z něj odvozené nizky_stav,
// jen to, co potřebuje k zobrazení produktu a dostupnosti.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nazev, p.znacka, p.emoji, p.kategorie, p.cena, p.cena_puvodni, p.typ_nohy, p.popis,
             s.velikost, s.ean, s.pocet_kusu, s.delka_mm, s.sirka_mm, s.dostupnost
      FROM produkty p
      LEFT JOIN sklad s ON p.id = s.produkt_id
      ORDER BY p.nazev, s.velikost
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Vše pod touto řádkou vyžaduje přihlášení do administrace
// (veřejný e-shop potřebuje jen GET / výše, aby mohl zobrazit produkty)
router.use(vyzadovatAdmina);

// Admin verze se všemi interními údaji (min_pocet, nizky_stav) pro sklad v adminu.
router.get('/admin', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nazev, p.znacka, p.emoji, p.kategorie, p.cena, p.cena_puvodni, p.typ_nohy, p.popis,
             s.velikost, s.ean, s.pocet_kusu, s.min_pocet, s.delka_mm, s.sirka_mm, s.dostupnost,
             CASE WHEN s.pocet_kusu <= s.min_pocet THEN true ELSE false END as nizky_stav
      FROM produkty p
      LEFT JOIN sklad s ON p.id = s.produkt_id
      ORDER BY p.nazev, s.velikost
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.post('/naskladnit', async (req, res) => {
  const { produkt_id, velikost, pocet, poznamka } = req.body;
  // EAN/rozměry se aktualizují jen pokud je klient v těle poslal, aby běžné
  // naskladnění bez těchto polí nepřepsalo už uložené hodnoty na null.
  const eanZadan = Object.prototype.hasOwnProperty.call(req.body, 'ean');
  const rozmeryZadany = Object.prototype.hasOwnProperty.call(req.body, 'delka_mm') || Object.prototype.hasOwnProperty.call(req.body, 'sirka_mm');
  const dostupnostZadana = Object.prototype.hasOwnProperty.call(req.body, 'dostupnost') && req.body.dostupnost;
  try {
    if (rozmeryZadany) {
      await pool.query(`
        INSERT INTO sklad (produkt_id, velikost, pocet_kusu, ean, delka_mm, sirka_mm)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (produkt_id, velikost)
        DO UPDATE SET pocet_kusu = sklad.pocet_kusu + $3, ean = $4, delka_mm = $5, sirka_mm = $6
      `, [produkt_id, velikost, pocet, req.body.ean || null, req.body.delka_mm || null, req.body.sirka_mm || null]);
    } else if (eanZadan) {
      await pool.query(`
        INSERT INTO sklad (produkt_id, velikost, pocet_kusu, ean)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (produkt_id, velikost)
        DO UPDATE SET pocet_kusu = sklad.pocet_kusu + $3, ean = $4
      `, [produkt_id, velikost, pocet, req.body.ean || null]);
    } else {
      await pool.query(`
        INSERT INTO sklad (produkt_id, velikost, pocet_kusu)
        VALUES ($1, $2, $3)
        ON CONFLICT (produkt_id, velikost)
        DO UPDATE SET pocet_kusu = sklad.pocet_kusu + $3
      `, [produkt_id, velikost, pocet]);
    }
    // Dostupnost (skladem / u dodavatele) se řeší samostatně, ať se nemusí
    // násobit výše uvedené větve - řádek už v tuhle chvíli vždycky existuje.
    if (dostupnostZadana) {
      await pool.query(
        'UPDATE sklad SET dostupnost = $1 WHERE produkt_id = $2 AND velikost = $3',
        [req.body.dostupnost, produkt_id, velikost]
      );
    }
    if (pocet > 0) {
      await pool.query(`
        INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka)
        VALUES ($1, $2, 'naskladneni', $3, $4)
      `, [produkt_id, velikost, pocet, poznamka]);
    }
    res.json({ zprava: 'Naskladneno uspesne' });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.post('/odecist', async (req, res) => {
  const { produkt_id, velikost, pocet, poznamka } = req.body;
  try {
    const check = await pool.query(`
      SELECT pocet_kusu FROM sklad
      WHERE produkt_id = $1 AND velikost = $2
    `, [produkt_id, velikost]);
    if (check.rows.length === 0 || check.rows[0].pocet_kusu < pocet) {
      return res.status(400).json({ chyba: 'Nedostatek zbozi na sklade' });
    }
    await pool.query(`
      UPDATE sklad SET pocet_kusu = pocet_kusu - $3
      WHERE produkt_id = $1 AND velikost = $2
    `, [produkt_id, velikost, pocet]);
    await pool.query(`
      INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka)
      VALUES ($1, $2, 'prodej', $3, $4)
    `, [produkt_id, velikost, pocet, poznamka]);
    res.json({ zprava: 'Odecteno uspesne' });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.get('/historie', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ph.*, p.nazev, p.znacka
      FROM pohyby_skladu ph
      JOIN produkty p ON ph.produkt_id = p.id
      ORDER BY ph.vytvoreno DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.get('/nizky-stav', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.nazev, p.znacka, s.velikost, s.pocet_kusu, s.min_pocet
      FROM sklad s
      JOIN produkty p ON s.produkt_id = p.id
      WHERE s.pocet_kusu <= s.min_pocet
      ORDER BY s.pocet_kusu ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});


// Přidat nový produkt (volitelně rovnou i s první variantou - velikost/počet/EAN)
router.post('/produkty', async (req, res) => {
  const { nazev, znacka, emoji, popis, kategorie, cena, cena_puvodni, typ_nohy, velikost, pocet, ean, delka_mm, sirka_mm, dostupnost } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'INSERT INTO produkty (nazev, znacka, emoji, popis, kategorie, cena, cena_puvodni, typ_nohy) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [nazev, znacka, emoji||'', popis||'', kategorie, cena, cena_puvodni||null, typ_nohy || null]
    );
    const produkt = result.rows[0];
    if (velikost) {
      const pocetKusu = pocet || 0;
      await client.query(
        'INSERT INTO sklad (produkt_id, velikost, pocet_kusu, ean, delka_mm, sirka_mm, dostupnost) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [produkt.id, velikost, pocetKusu, ean || null, delka_mm || null, sirka_mm || null, dostupnost || 'skladem']
      );
      if (pocetKusu > 0) {
        await client.query(
          `INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES ($1,$2,'naskladneni',$3,$4)`,
          [produkt.id, velikost, pocetKusu, 'Založení produktu']
        );
      }
    }
    await client.query('COMMIT');
    res.json(produkt);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// Upravit produkt
router.patch('/produkty/:id', async (req, res) => {
  const { nazev, znacka, emoji, cena, cena_puvodni, popis, kategorie, typ_nohy } = req.body;
  try {
    const result = await pool.query(
      'UPDATE produkty SET nazev=$1, znacka=$2, cena=$3, cena_puvodni=$4, popis=$5, kategorie=$6, emoji=$7, typ_nohy=$8 WHERE id=$9 RETURNING *',
      [nazev, znacka, cena, cena_puvodni||null, popis||'', kategorie, emoji||'', typ_nohy || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Získat všechny kategorie
// (POZNÁMKA: skutečně používané kategorie endpointy jsou v routes/kategorie.js,
// tyhle duplicitní byly nepoužívané a byly odstraněny kvůli přehlednosti a bezpečnosti)

// Upravit velikost a/nebo EAN/rozměry existující položky skladu
router.patch('/polozka/:produktId/:velikost', async (req, res) => {
  const { velikost_nova, ean, delka_mm, sirka_mm, dostupnost } = req.body;
  if (!velikost_nova) {
    return res.status(400).json({ chyba: 'Chybí nová velikost.' });
  }
  try {
    const result = await pool.query(
      'UPDATE sklad SET velikost=$1, ean=$2, delka_mm=$3, sirka_mm=$4, dostupnost=$5 WHERE produkt_id=$6 AND velikost=$7 RETURNING *',
      [velikost_nova, ean || null, delka_mm || null, sirka_mm || null, dostupnost || 'skladem', req.params.produktId, req.params.velikost]
    );
    if (!result.rows.length) {
      return res.status(404).json({ chyba: 'Položka skladu nenalezena.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ chyba: 'Tato velikost už u produktu existuje.' });
    }
    res.status(500).json({ chyba: err.message });
  }
});

// Smazat jednu položku skladu (konkrétní velikost produktu)
router.delete('/polozka/:produktId/:velikost', async (req, res) => {
  try {
    await pool.query('DELETE FROM sklad WHERE produkt_id=$1 AND velikost=$2', [req.params.produktId, req.params.velikost]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Smazat celý produkt (včetně jeho položek skladu a historie pohybů)
router.delete('/produkty/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM pohyby_skladu WHERE produkt_id=$1', [req.params.id]);
    await client.query('DELETE FROM sklad WHERE produkt_id=$1', [req.params.id]);
    await client.query('DELETE FROM produkty WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// Smazat záznam pohybu skladu (historie)
router.delete('/pohyby/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM pohyby_skladu WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;


