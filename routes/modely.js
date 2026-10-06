// Modely bot - správa vlastností pro filtry nového e-shopu (krok 0).
// Viz lib/modely.js. Model se zakládá automaticky ze značky a názvu produktů.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const {
  VOLBY, KATEGORIE_BEZ_VLASTNOSTI, VYCHOZI_NASTAVENI_KATALOGU,
  klicModelu, migrovatModely, overitUpravuModelu, jeVyplneno, overitNastaveniKatalogu,
  overitHromadnouZmenu
} = require('../lib/modely');

async function initModely() {
  try {
    const { zalozenoSkupin, prirazenoProduktu } = await migrovatModely(pool);
    console.log(`Modely OK (nově přiřazeno ${prirazenoProduktu} produktů do ${zalozenoSkupin} modelů)`);
  } catch (e) {
    console.log('Modely chyba:', e.message);
  }
}
initModely();

async function nacistNastaveniKatalogu() {
  const r = await pool.query("SELECT hodnota FROM nastaveni WHERE klic = 'katalog'");
  return r.rows.length && r.rows[0].hodnota ? r.rows[0].hodnota : VYCHOZI_NASTAVENI_KATALOGU;
}

// Veřejné - e-shop z toho bude počítat věkové skupiny z velikostí
router.get('/nastaveni-katalogu', async (req, res) => {
  try {
    res.json(await nacistNastaveniKatalogu());
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Vše pod touto řádkou vyžaduje administraci
router.use(vyzadovatAdmina);

router.put('/nastaveni-katalogu', async (req, res) => {
  const { chyba, hodnoty } = overitNastaveniKatalogu(req.body);
  if (chyba) return res.status(400).json({ chyba });
  try {
    await pool.query(
      "INSERT INTO nastaveni (klic, hodnota) VALUES ('katalog', $1) ON CONFLICT (klic) DO UPDATE SET hodnota = $1",
      [hodnoty]
    );
    res.json(hodnoty);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Seznam modelů se souhrnem velikostí, skladu a fotek. Modely bez produktů
// (všechny velikosti smazané nebo přejmenované jinam) se nezobrazují.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*,
             COUNT(DISTINCT p.id)::int AS pocet_produktu,
             COALESCE(SUM(s.pocet_kusu), 0)::int AS kusu,
             COALESCE(ARRAY_AGG(DISTINCT s.velikost) FILTER (WHERE s.velikost IS NOT NULL), '{}') AS velikosti,
             COALESCE(ARRAY_AGG(DISTINCT p.kategorie) FILTER (WHERE p.kategorie IS NOT NULL), '{}') AS kategorie_produktu,
             BOOL_OR(p.na_eshopu) AS na_eshopu,
             -- emoji může být NULL -> BOOL_OR vrátí NULL; COALESCE, ať je výsledek vždy true/false
             (COALESCE(BOOL_OR(p.emoji LIKE 'http%'), false) OR EXISTS (
               SELECT 1 FROM product_images pi JOIN produkty p2 ON p2.id = pi.produkt_id WHERE p2.model_id = m.id
             )) AS ma_fotku
      FROM modely m
      JOIN produkty p ON p.model_id = m.id
      LEFT JOIN sklad s ON s.produkt_id = p.id
      GROUP BY m.id
      ORDER BY LOWER(COALESCE(m.znacka, '')), LOWER(m.nazev)
    `);
    res.json({
      volby: VOLBY,
      kategorieBezVlastnosti: KATEGORIE_BEZ_VLASTNOSTI,
      modely: result.rows.map(m => {
        const { klic, ...verejne } = m;
        return {
          ...verejne,
          velikosti: [...m.velikosti].sort((a, b) => a - b),
          vyplneno: jeVyplneno(m),
          // Velikosti jednoho modelu jsou v různých kategoriích - po uložení
          // kategorie modelu se sjednotí
          kategorie_ke_kontrole: m.kategorie_produktu.length > 1
        };
      })
    });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

const SLOUPCE = ['znacka', 'nazev', 'kategorie', 'barefoot', 'sirka', 'nart', 'dominantni_palec', 'zapinani', 'membrana', 'material', 'pohlavi', 'proc_jsme_vybrali'];

// Úprava modelu. Kategorie, značka a název se propíšou do všech jeho
// produktů (velikostí) - e-shop i sklad je tak uvidí stejně.
router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ chyba: 'Neplatné id modelu.' });
  const { chyba, hodnoty } = overitUpravuModelu(req.body);
  if (chyba) return res.status(400).json({ chyba });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const puvodni = await client.query('SELECT * FROM modely WHERE id = $1 FOR UPDATE', [id]);
    if (!puvodni.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ chyba: 'Model nenalezen.' });
    }
    const model = puvodni.rows[0];

    if ('kategorie' in hodnoty) {
      const kat = await client.query('SELECT 1 FROM kategorie WHERE slug = $1', [hodnoty.kategorie]);
      if (!kat.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Taková kategorie neexistuje.' });
      }
    }

    const nastavit = { ...hodnoty };
    const znacka = 'znacka' in hodnoty ? hodnoty.znacka : model.znacka;
    const nazev = 'nazev' in hodnoty ? hodnoty.nazev : model.nazev;
    const novyKlic = klicModelu(znacka, nazev);
    if (novyKlic !== model.klic) {
      const kolize = await client.query('SELECT id FROM modely WHERE klic = $1 AND id <> $2', [novyKlic, id]);
      if (kolize.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ chyba: 'Model se stejnou značkou a názvem už existuje.' });
      }
      nastavit.klic = novyKlic;
    }

    const sloupce = Object.keys(nastavit).filter(k => SLOUPCE.includes(k) || k === 'klic');
    const sety = sloupce.map((k, i) => `${k} = $${i + 1}`);
    const result = await client.query(
      `UPDATE modely SET ${sety.join(', ')}, upraveno = NOW() WHERE id = $${sloupce.length + 1} RETURNING *`,
      [...sloupce.map(k => nastavit[k]), id]
    );

    if ('kategorie' in hodnoty) {
      await client.query('UPDATE produkty SET kategorie = $1 WHERE model_id = $2', [hodnoty.kategorie, id]);
    }
    if ('znacka' in hodnoty || 'nazev' in hodnoty) {
      await client.query('UPDATE produkty SET znacka = $1, nazev = $2 WHERE model_id = $3', [znacka, nazev, id]);
    }
    await client.query('COMMIT');

    const { klic, ...ulozeny } = result.rows[0];
    res.json({ ...ulozeny, vyplneno: jeVyplneno(ulozeny) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// Hromadná změna jedné vlastnosti nebo kategorie u vybraných modelů.
// Všechno, nebo nic: když některý model neexistuje, nezmění se žádný.
router.post('/hromadne', async (req, res) => {
  const { chyba, ids, hodnoty } = overitHromadnouZmenu(req.body);
  if (chyba) return res.status(400).json({ chyba });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if ('kategorie' in hodnoty) {
      const kat = await client.query('SELECT 1 FROM kategorie WHERE slug = $1', [hodnoty.kategorie]);
      if (!kat.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Taková kategorie neexistuje.' });
      }
    }
    const sloupce = Object.keys(hodnoty);
    const result = await client.query(
      `UPDATE modely SET ${sloupce.map((k, i) => `${k} = $${i + 1}`).join(', ')}, upraveno = NOW() WHERE id = ANY($${sloupce.length + 1}::int[]) RETURNING id`,
      [...sloupce.map(k => hodnoty[k]), ids]
    );
    if (result.rows.length !== ids.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ chyba: 'Některé vybrané modely už neexistují. Obnovte stránku a zkuste to znovu.' });
    }
    if ('kategorie' in hodnoty) {
      await client.query('UPDATE produkty SET kategorie = $1 WHERE model_id = ANY($2::int[])', [hodnoty.kategorie, ids]);
    }
    await client.query('COMMIT');
    res.json({ upraveno: ids.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
