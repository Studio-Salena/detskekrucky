const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { poukazPoPlatnosti } = require('../lib/poukazPlatnost');

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
      ALTER TABLE prodejna_prodeje ADD COLUMN IF NOT EXISTS hotovost_prijato NUMERIC;
      ALTER TABLE prodejna_prodeje ADD COLUMN IF NOT EXISTS hotovost_vraceno NUMERIC;
      -- Část nákupu zaplacená dárkovým poukazem, když zákazník zbytek doplácí (celkem = doplatek)
      ALTER TABLE prodejna_prodeje ADD COLUMN IF NOT EXISTS poukaz_castka NUMERIC;
      ALTER TABLE prodejna_prodeje ADD COLUMN IF NOT EXISTS poukaz_kod TEXT;
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
pripravit(initTabulky());

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
  const { zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, hotovost_vraceno } = req.body;
  if (!Array.isArray(polozky) || !polozky.length) {
    return res.status(400).json({ chyba: 'Chybí položky prodeje.' });
  }
  if (req.body.poukaz_kod) return prodejSDoplatkem(req, res);
  try {
    const result = await pool.query(
      'INSERT INTO prodejna_prodeje (zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, hotovost_vraceno) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [zakaznik || null, platba || null, poznamka || null, JSON.stringify(polozky), celkem,
       mezisoucet != null ? mezisoucet : celkem, sleva || 0, sleva_popis || null,
       hotovost_prijato != null ? hotovost_prijato : null, hotovost_vraceno != null ? hotovost_vraceno : null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Poukaz nepokryje celý nákup: zbytek zákazník doplatí hotově, kartou nebo QR.
// V jedné transakci se poukaz vyčerpá, uloží se prodej s celkem = doplatek
// (jen ten jde do tržeb - hodnota poukazu se počítá při jeho prodeji, dar nikdy)
// a zapíše se uplatnění poukazu. Když poukaz mezitím někdo použil, neuloží se nic.
async function prodejSDoplatkem(req, res) {
  const { zakaznik, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, poukaz_kod, doplatek_platba } = req.body;
  const zaZbozi = Number(celkem);
  if (!Number.isFinite(zaZbozi) || zaZbozi <= 0) return res.status(400).json({ chyba: 'Neplatná částka prodeje.' });
  if (!['hotovost', 'karta', 'qr'].includes(doplatek_platba)) return res.status(400).json({ chyba: 'Vyberte, jak zákazník doplatí zbytek.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nalezeny = await client.query('SELECT * FROM darkove_poukazy WHERE UPPER(kod) = $1 OR ean = $1 FOR UPDATE', [String(poukaz_kod).trim().toUpperCase()]);
    const poukaz = nalezeny.rows[0];
    const chyba = !poukaz ? 'Poukaz nebyl nalezen.'
      : poukaz.stav !== 'aktivni' || Number(poukaz.zustatek) <= 0 ? 'Poukaz už není aktivní.'
      : poukazPoPlatnosti(poukaz.platnost_do) ? 'Platnost poukazu vypršela.'
      : Number(poukaz.zustatek) >= zaZbozi ? 'Poukaz pokryje celý nákup – zvolte platbu jen dárkovým poukazem.'
      : null;
    if (chyba) { await client.query('ROLLBACK'); return res.status(400).json({ chyba }); }
    const zPoukazu = Number(poukaz.zustatek);
    const doplatek = zaZbozi - zPoukazu;
    const prijato = doplatek_platba === 'hotovost' && Number(hotovost_prijato) > 0 ? Number(hotovost_prijato) : null;
    const prodej = (await client.query(
      `INSERT INTO prodejna_prodeje (zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, hotovost_vraceno, poukaz_castka, poukaz_kod)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [zakaznik || null, doplatek_platba, poznamka || null, JSON.stringify(polozky), doplatek,
       mezisoucet != null ? mezisoucet : zaZbozi, sleva || 0, sleva_popis || null,
       prijato, prijato != null ? Math.max(0, prijato - doplatek) : null, zPoukazu, poukaz.kod]
    )).rows[0];
    await client.query("UPDATE darkove_poukazy SET zustatek = 0, stav = 'pouzity' WHERE id = $1", [poukaz.id]);
    await client.query('INSERT INTO poukazy_pouziti (poukaz_id, castka, prodej_id) VALUES ($1,$2,$3)', [poukaz.id, zPoukazu, prodej.id]);
    await client.query('COMMIT');
    res.json(prodej);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
}

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
  for (const p of polozky) {
    if (!p || !Number.isInteger(p.produkt_id) || p.velikost === undefined || p.velikost === null) {
      return res.status(400).json({ chyba: 'Neplatná položka k vrácení.' });
    }
    if (!Number.isInteger(p.pocet) || p.pocet <= 0) {
      return res.status(400).json({ chyba: 'Neplatný počet kusů k vrácení.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Admin frontend není autorita - když je vratka navázaná na konkrétní
    // prodej/objednávku, ověřit položky proti tomu, co v ní skutečně bylo,
    // a proti tomu, co už se přes ni vrátilo dřív (opakované částečné vratky).
    // Bez vazby (ruční/historická oprava skladu bez zdroje) se ověřit nedá -
    // tam zůstává jen základní validace tvaru výše.
    if (prodej_id || objednavka_id) {
      // FOR UPDATE na zdrojový řádek HNED po BEGIN a před čtením
      // existujících vratek - jinak by dvě souběžné vratky ke stejnému
      // prodeji/objednávce mohly obě vidět stejné "už vrácené množství" a
      // obě projít kontrolou (typický lost update). Objednávka se zamyká
      // stejným dotazem/pořadím jako při jejím zrušení (routes/objednavky.js),
      // takže vratka a zrušení téže objednávky se navzájem serializují místo
      // souběžné změny skladu.
      let zdrojovePolozky;
      if (prodej_id) {
        const prodej = await client.query('SELECT id, polozky FROM prodejna_prodeje WHERE id=$1 FOR UPDATE', [prodej_id]);
        if (!prodej.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ chyba: 'Navázaný prodej nenalezen.' });
        }
        zdrojovePolozky = prodej.rows[0].polozky;
      } else {
        const objednavka = await client.query('SELECT id, stav FROM objednavky WHERE id = $1 FOR UPDATE', [objednavka_id]);
        if (!objednavka.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ chyba: 'Navázaná objednávka nenalezena.' });
        }
        // Symetrie se zrušením objednávky (routes/objednavky.js): kdo z obou
        // (vratka/zrušení) získá zámek na objednávce první, ten "vyhrává" -
        // druhý pak vidí už změněný stav a je odmítnut. Bez tohoto by šlo na
        // už zrušenou objednávku (sklad už vrácen zrušením) vytvořit vratku,
        // která by sklad vrátila podruhé.
        if (objednavka.rows[0].stav === 'zrusena') {
          await client.query('ROLLBACK');
          return res.status(409).json({ chyba: 'Na zrušenou objednávku nelze vytvořit vratku.' });
        }
        const obj = await client.query('SELECT produkt_id, velikost, pocet FROM objednavky_polozky WHERE objednavka_id=$1', [objednavka_id]);
        zdrojovePolozky = obj.rows;
      }

      const mapaZdroj = new Map();
      for (const p of zdrojovePolozky) {
        const klic = `${p.produkt_id}_${p.velikost}`;
        mapaZdroj.set(klic, (mapaZdroj.get(klic) || 0) + Number(p.pocet));
      }

      const jizVracene = await client.query(
        `SELECT polozky FROM vratky WHERE ${prodej_id ? 'prodej_id = $1' : 'objednavka_id = $1'}`,
        [prodej_id || objednavka_id]
      );
      const mapaJizVraceno = new Map();
      for (const radek of jizVracene.rows) {
        for (const p of radek.polozky) {
          const klic = `${p.produkt_id}_${p.velikost}`;
          mapaJizVraceno.set(klic, (mapaJizVraceno.get(klic) || 0) + Number(p.pocet));
        }
      }

      const nyniPozadovano = new Map();
      for (const p of polozky) {
        const klic = `${p.produkt_id}_${p.velikost}`;
        const puvodniPocet = mapaZdroj.get(klic);
        if (!puvodniPocet) {
          await client.query('ROLLBACK');
          return res.status(400).json({ chyba: `Položka (produkt ${p.produkt_id}, vel. ${p.velikost}) nebyla součástí navázaného prodeje/objednávky.` });
        }
        const jizVracenoPocet = mapaJizVraceno.get(klic) || 0;
        const celkemNyni = (nyniPozadovano.get(klic) || 0) + p.pocet;
        if (jizVracenoPocet + celkemNyni > puvodniPocet) {
          await client.query('ROLLBACK');
          return res.status(400).json({ chyba: `Nelze vrátit víc kusů (produkt ${p.produkt_id}, vel. ${p.velikost}), než bylo prodáno/objednáno a ještě nevráceno.` });
        }
        nyniPozadovano.set(klic, celkemNyni);
      }
    }

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

// DELETE /api/prodejna/vratky/:id – HARD DELETE zakázán. Vratka je od vytvoření
// immutable auditní stopa - smazáním jen záznamu (bez odpovídající úpravy
// skladu) by šlo obejít kontrolu už vráceného množství při další vratce a
// zároveň "oslepit" kontrolu při zrušení objednávky (ta se dívá právě do
// téhle tabulky), takže by cancellation mohla sklad vrátit podruhé. Skutečné
// storno vratky (s korekcí skladu) je samostatný workflow pro pozdější etapu.
router.delete('/vratky/:id', async (req, res) => {
  try {
    const vratka = await pool.query('SELECT id FROM vratky WHERE id=$1', [req.params.id]);
    if (!vratka.rows.length) {
      return res.status(404).json({ chyba: 'Vratka nenalezena.' });
    }
    return res.status(409).json({ chyba: 'Provedenou vratku nelze smazat. Pro opravu je nutné použít storno vratky.' });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
