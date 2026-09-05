const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db/pool');
const vyzadovatAdmina = require('../middleware/adminAuth');
const cloudinaryLib = require('../lib/cloudinary');

// Idempotentní migrace - stejný vzor jako zbytek projektu (routes/prodejna.js,
// routes/sklad.js). Jeden produkt může mít nejvýš jednu hlavní fotku - řeší
// unique partial index, ne aplikační kontrola (ta by mohla mít race condition).
async function initProductImagesTabulka() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_images (
        id SERIAL PRIMARY KEY,
        produkt_id INTEGER NOT NULL REFERENCES produkty(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        storage_key TEXT,
        alt TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        is_primary BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS product_images_produkt_position_idx ON product_images (produkt_id, position);
      CREATE UNIQUE INDEX IF NOT EXISTS product_images_jedna_primarni_idx ON product_images (produkt_id) WHERE is_primary = true;
    `);
    console.log('Product images tabulka OK');
  } catch (e) {
    console.log('Product images tabulka chyba:', e.message);
  }
}
initProductImagesTabulka();

const MAX_MB = 10;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const POVOLENE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES }
});

// Ověří skutečný obsah souboru podle magických bajtů na začátku - nespoléhá
// jen na Content-Type/příponu, kterou klient (i omylem přejmenovaný soubor
// z telefonu) může poslat špatně nebo záměrně zfalšovat.
function zjistitSkutecnyTypObrazku(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  if (buffer.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  // HEIC/HEIF (iPhone) - ISO base media file format, "ftyp" box na offsetu 4.
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') return 'heic';
  return null;
}

// Vše v tomto souboru je admin-only - správa fotografií produktů není veřejná funkce.
router.use(vyzadovatAdmina);

// GET /:id/images - seznam fotografií produktu (pro admin galerii)
router.get('/:id/images', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, produkt_id, url, storage_key, alt, position, is_primary, created_at FROM product_images WHERE produkt_id=$1 ORDER BY position ASC, id ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /:id/images - nahrání jedné nebo víc fotografií (multipart/form-data, pole "fotky")
router.post('/:id/images', (req, res, next) => {
  upload.array('fotky', 10)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ chyba: `Soubor je příliš velký (max ${MAX_MB} MB na fotografii).` });
      }
      return res.status(400).json({ chyba: 'Nahrání souboru selhalo.' });
    }
    next();
  });
}, async (req, res) => {
  const produktId = req.params.id;
  const soubory = req.files || [];

  if (!soubory.length) {
    return res.status(400).json({ chyba: 'Chybí soubor(y) k nahrání.' });
  }
  // Každý soubor se validuje sám o sobě před jakýmkoliv uploadem - jeden
  // špatný soubor v dávce zamítne celý request, ať nevznikají "napůl"
  // nahrané dávky.
  for (const soubor of soubory) {
    if (soubor.size > MAX_BYTES) {
      return res.status(400).json({ chyba: `Soubor je příliš velký (max ${MAX_MB} MB na fotografii).` });
    }
    if (!POVOLENE_MIME.has(soubor.mimetype)) {
      return res.status(400).json({ chyba: 'Nepovolený typ souboru. Nahrajte prosím fotografii (JPEG/PNG/WEBP/HEIC).' });
    }
    if (!zjistitSkutecnyTypObrazku(soubor.buffer)) {
      return res.status(400).json({ chyba: 'Soubor nevypadá jako platný obrázek.' });
    }
  }

  if (!cloudinaryLib.jeNakonfigurovano()) {
    return res.status(503).json({ chyba: 'Nahrávání fotografií není momentálně nakonfigurováno.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE na produktu serializuje souběžné operace s jeho fotkami
    // (upload/delete/změna hlavní fotky) - stejný vzor jako zamykání
    // objednávky před vratkou/zrušením jinde v projektu.
    const produkt = await client.query('SELECT id, nazev FROM produkty WHERE id=$1 FOR UPDATE', [produktId]);
    if (!produkt.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ chyba: 'Produkt nenalezen.' });
    }
    const nazevProduktu = produkt.rows[0].nazev;

    const stav = await client.query(
      'SELECT COUNT(*)::int AS pocet, COALESCE(MAX(position), -1)::int AS max_pozice FROM product_images WHERE produkt_id=$1',
      [produktId]
    );
    let pozice = stav.rows[0].max_pozice + 1;
    let jizMaPrimarni = stav.rows[0].pocet > 0;

    const vlozene = [];
    for (const soubor of soubory) {
      let vysledek;
      try {
        vysledek = await cloudinaryLib.nahratObrazek(soubor.buffer, { folder: `detskekrucky/products/${produktId}` });
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(502).json({ chyba: 'Nahrání do úložiště fotografií selhalo.' });
      }
      const jePrimarni = !jizMaPrimarni;
      const alt = pozice === 0 ? nazevProduktu : `${nazevProduktu} – fotografie ${pozice + 1}`;
      const vlozeny = await client.query(
        `INSERT INTO product_images (produkt_id, url, storage_key, alt, position, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [produktId, vysledek.secure_url, vysledek.public_id, alt, pozice, jePrimarni]
      );
      vlozene.push(vlozeny.rows[0]);
      if (jePrimarni) jizMaPrimarni = true;
      pozice++;
    }

    await client.query('COMMIT');
    res.json(vlozene);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// DELETE /:id/images/:imageId - smazání fotografie. Vlastnictví (fotka
// skutečně patří k produktu z URL) se ověřuje vždy, ať nejde smazat cizí
// fotku jen uhodnutím/změnou imageId v URL.
router.delete('/:id/images/:imageId', async (req, res) => {
  const { id: produktId, imageId } = req.params;
  const client = await pool.connect();
  let smazana = null;
  let novaPrimarniId = null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM produkty WHERE id=$1 FOR UPDATE', [produktId]);
    const obrazek = await client.query('SELECT * FROM product_images WHERE id=$1', [imageId]);
    if (!obrazek.rows.length || String(obrazek.rows[0].produkt_id) !== String(produktId)) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ chyba: 'Fotografie nenalezena.' });
    }
    smazana = obrazek.rows[0];
    await client.query('DELETE FROM product_images WHERE id=$1', [imageId]);

    if (smazana.is_primary) {
      const dalsi = await client.query(
        'SELECT id FROM product_images WHERE produkt_id=$1 ORDER BY position ASC, id ASC LIMIT 1',
        [produktId]
      );
      if (dalsi.rows.length) {
        await client.query('UPDATE product_images SET is_primary=true WHERE id=$1', [dalsi.rows[0].id]);
        novaPrimarniId = dalsi.rows[0].id;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    return res.status(500).json({ chyba: err.message });
  }
  client.release();

  // Cloudinary cleanup - best-effort a AŽ PO commitu, ať se transakce (a
  // zámek na produktu) nedrží po dobu dlouhého externího requestu. DB je
  // konzistentní bez ohledu na výsledek - při chybě se jen zaloguje
  // storage_key pro případný ruční úklid.
  if (smazana.storage_key) {
    try {
      const vysledek = await cloudinaryLib.smazatObrazek(smazana.storage_key);
      if (!vysledek || vysledek.ok === false) {
        console.error('Cloudinary cleanup se nepovedl, storage_key pro ruční úklid:', smazana.storage_key);
      }
    } catch (e) {
      console.error('Cloudinary cleanup se nepovedl, storage_key pro ruční úklid:', smazana.storage_key, e.message);
    }
  }

  res.json({ ok: true, nova_primarni_id: novaPrimarniId });
});

// PATCH /:id/images/:imageId - úprava ALT textu a/nebo pozice
router.patch('/:id/images/:imageId', async (req, res) => {
  const { id: produktId, imageId } = req.params;
  const { alt, position } = req.body;
  try {
    const obrazek = await pool.query('SELECT produkt_id FROM product_images WHERE id=$1', [imageId]);
    if (!obrazek.rows.length || String(obrazek.rows[0].produkt_id) !== String(produktId)) {
      return res.status(404).json({ chyba: 'Fotografie nenalezena.' });
    }
    const sloupce = [];
    const hodnoty = [];
    let i = 1;
    if (alt !== undefined) { sloupce.push(`alt=$${i++}`); hodnoty.push(alt); }
    if (position !== undefined) {
      if (!Number.isInteger(position) || position < 0) {
        return res.status(400).json({ chyba: 'Neplatná pozice.' });
      }
      sloupce.push(`position=$${i++}`); hodnoty.push(position);
    }
    if (!sloupce.length) {
      return res.status(400).json({ chyba: 'Nic k úpravě.' });
    }
    hodnoty.push(imageId);
    const result = await pool.query(`UPDATE product_images SET ${sloupce.join(', ')} WHERE id=$${i} RETURNING *`, hodnoty);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// PATCH /:id/images/:imageId/primary - nastavení hlavní fotky, transakčně
// (nejdřív všechny na false, pak zvolená na true) a se zámkem na produktu,
// ať souběžné volání nenarazí na unique partial index (jedna hlavní na produkt).
router.patch('/:id/images/:imageId/primary', async (req, res) => {
  const { id: produktId, imageId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM produkty WHERE id=$1 FOR UPDATE', [produktId]);
    const obrazek = await client.query('SELECT id, produkt_id FROM product_images WHERE id=$1', [imageId]);
    if (!obrazek.rows.length || String(obrazek.rows[0].produkt_id) !== String(produktId)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ chyba: 'Fotografie nenalezena.' });
    }
    await client.query('UPDATE product_images SET is_primary=false WHERE produkt_id=$1', [produktId]);
    await client.query('UPDATE product_images SET is_primary=true WHERE id=$1', [imageId]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
