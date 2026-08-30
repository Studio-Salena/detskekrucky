const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');

// Vše v tomto souboru je admin-only (prodejna i vratky jsou interní data)
router.use(vyzadovatAdmina);

async function initTabulky() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prodejna_prodeje (
        id SERIAL PRIMARY KEY,
        datum TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        zakaznik TEXT,
        platba TEXT,
        poznamka TEXT,
        polozky JSONB NOT NULL,
        celkem NUMERIC NOT NULL,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE prodejna_prodeje ADD COLUMN IF NOT EXISTS mezisoucet NUMERIC;
      ALTER TABLE prodejna_prodeje ADD COLUMN IF NOT EXISTS sleva NUMERIC DEFAULT 0;
      ALTER TABLE prodejna_prodeje ADD COLUMN IF NOT EXISTS sleva_popis TEXT;
      CREATE TABLE IF NOT EXISTS vratky (
        id SERIAL PRIMARY KEY,
        prodej_id INTEGER REFERENCES prodejna_prodeje(id) ON DELETE SET NULL,
        objednavka_id INTEGER REFERENCES objednavky(id) ON DELETE SET NULL,
        polozky JSONB NOT NULL,
        castka NUMERIC NOT NULL,
        duvod TEXT,
        vraceno_na_sklad BOOLEAN DEFAULT true,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Prodejna a vratky tabulky OK');
  } catch (e) {
    console.log('Prodejna/vratky tabulky chyba:', e.message);
  }
}
initTabulky();

// ═══════════════════════════════
// PRODEJE
// ═══════════════════════════════

// GET /api/prodejna – všechny prodeje v prodejně
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM prodejna_prodeje ORDER BY datum DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/prodejna – vytvořit nový prodej
router.post('/', async (req, res) => {
  const { zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis } = req.body;
  if (!Array.isArray(polozky) || !polozky.length) {
    return res.status(400).json({ chyba: 'Chybí položky prodeje.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO prodejna_prodeje (zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [zakaznik || null, platba || null, poznamka || null, JSON.stringify(polozky), celkem,
       mezisoucet != null ? mezisoucet : celkem, sleva || 0, sleva_popis || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// PUT /api/prodejna/:id – upravit záznam prodeje (např. špatně zvolená platba, překlep ve jméně)
router.put('/:id', async (req, res) => {
  const { zakaznik, platba, poznamka } = req.body;
  try {
    const result = await pool.query(
      'UPDATE prodejna_prodeje SET zakaznik=$1, platba=$2, poznamka=$3 WHERE id=$4 RETURNING *',
      [zakaznik || null, platba || null, poznamka || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ chyba: 'Prodej nenalezen.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// DELETE /api/prodejna/:id – smazat záznam prodeje (oprava chyby)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM prodejna_prodeje WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// ═══════════════════════════════
// VRATKY
// ═══════════════════════════════

// GET /api/prodejna/vratky/vse – všechny vratky
router.get('/vratky/vse', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vratky ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/prodejna/vratky – vytvořit vratku
router.post('/vratky', async (req, res) => {
  const { prodej_id, objednavka_id, polozky, castka, duvod, vratit_na_sklad } = req.body;
  if (!Array.isArray(polozky) || !polozky.length) {
    return res.status(400).json({ chyba: 'Chybí vracené položky.' });
  }
  if (castka == null || castka < 0) {
    return res.status(400).json({ chyba: 'Chybí částka k vrácení.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vratka = await client.query(
      'INSERT INTO vratky (prodej_id, objednavka_id, polozky, castka, duvod, vraceno_na_sklad) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [prodej_id || null, objednavka_id || null, JSON.stringify(polozky), castka, duvod || null, vratit_na_sklad !== false]
    );

    // Pokud se má zboží vrátit zpět na sklad, naskladníme ho
    if (vratit_na_sklad !== false) {
      for (const p of polozky) {
        await client.query(`
          INSERT INTO sklad (produkt_id, velikost, pocet_kusu)
          VALUES ($1, $2, $3)
          ON CONFLICT (produkt_id, velikost)
          DO UPDATE SET pocet_kusu = sklad.pocet_kusu + $3
        `, [p.produkt_id, p.velikost, p.pocet]);
        await client.query(`
          INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka)
          VALUES ($1, $2, 'vratka', $3, $4)
        `, [p.produkt_id, p.velikost, p.pocet, `Vratka #${vratka.rows[0].id}`]);
      }
    }

    await client.query('COMMIT');
    res.json(vratka.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/prodejna/vratky/:id – smazat záznam vratky (jen záznam, sklad se nemění)
router.delete('/vratky/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM vratky WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
