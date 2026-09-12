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
const MAX_POZICE = 1000;
const MAX_ALT_DELKA = 300;
const POVOLENE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES }
});

// Skutečné HEIC/HEIF major brandy (ISO-BMFF "ftyp" box, 4 ASCII znaky hned
// po něm). Nestačí kontrolovat jen přítomnost "ftyp" - ten box má naprosto
// každý ISO-BMFF soubor (i MP4/MOV video, i audio) - musí sedět konkrétní
// brand, jinak by jako "HEIC obrázek" prošlo libovolné video přejmenované
// na .jpg s podvrženým Content-Type.
const HEIC_BRANDY = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

// Ověří skutečný obsah souboru podle magických bajtů na začátku - nespoléhá
// jen na Content-Type/příponu, kterou klient (i omylem přejmenovaný soubor
// z telefonu) může poslat špatně nebo záměrně zfalšovat.
function zjistitSkutecnyTypObrazku(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  if (buffer.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    return HEIC_BRANDY.has(brand) ? 'heic' : null;
  }
  return null;
}

// Který skutečně detekovaný typ smí přijít s jakým deklarovaným Content-Type
// - nestačí, že MIME je z povolené množiny A buffer vypadá jako "nějaký"
// obrázek; deklarovaný MIME musí sedět na detekovaný typ (mimetype=image/jpeg
// s GIF obsahem se odmítne).
const TYP_NA_POVOLENE_MIME = {
  jpeg: new Set(['image/jpeg']),
  png: new Set(['image/png']),
  gif: new Set(['image/gif']),
  webp: new Set(['image/webp']),
  heic: new Set(['image/heic', 'image/heif'])
};

// Best-effort úklid Cloudinary assetů nahraných v RÁMCI JEDNOHO requestu,
// který nakonec neuspěl (další soubor v dávce selhal, nebo selhal následný
// DB zápis) - Cloudinary upload není součástí DB transakce, takže úspěšně
// nahraný soubor po DB rollbacku zůstane v Cloudinary osiřelý, pokud se
// aktivně nesmaže. Chyba mazání se jen zaloguje, nikdy nepadá dál.
async function ukliditNahraneAssety(publicIdy) {
  for (const publicId of publicIdy) {
    try {
      const vysledek = await cloudinaryLib.smazatObrazek(publicId);
      if (!vysledek || vysledek.ok === false) {
        console.error('Cloudinary cleanup po neúspěšném uploadu se nepovedl, storage_key pro ruční úklid:', publicId);
      }
    } catch (e) {
      console.error('Cloudinary cleanup po neúspěšném uploadu se nepovedl, storage_key pro ruční úklid:', publicId, e.message);
    }
  }
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

  // 1) VALIDACE REQUESTU - čistě lokální, žádná DB, žádná síť. Každý soubor
  // se validuje sám o sobě před jakýmkoliv uploadem - jeden špatný soubor v
  // dávce zamítne celý request, ať nevznikají "napůl" nahrané dávky.
  if (!soubory.length) {
    return res.status(400).json({ chyba: 'Chybí soubor(y) k nahrání.' });
  }
  for (const soubor of soubory) {
    if (soubor.size > MAX_BYTES) {
      return res.status(400).json({ chyba: `Soubor je příliš velký (max ${MAX_MB} MB na fotografii).` });
    }
    if (!POVOLENE_MIME.has(soubor.mimetype)) {
      return res.status(400).json({ chyba: 'Nepovolený typ souboru. Nahrajte prosím fotografii (JPEG/PNG/WEBP/HEIC).' });
    }
    const skutecnyTyp = zjistitSkutecnyTypObrazku(soubor.buffer);
    if (!skutecnyTyp) {
      return res.status(400).json({ chyba: 'Soubor nevypadá jako platný obrázek.' });
    }
    // Deklarovaný Content-Type musí odpovídat skutečně detekovanému typu -
    // "mimetype je povolený" A "buffer vypadá jako nějaký obrázek" nestačí,
    // obojí musí sedět na SEBE (mimetype=image/jpeg s GIF obsahem se odmítne).
    if (!TYP_NA_POVOLENE_MIME[skutecnyTyp].has(soubor.mimetype)) {
      return res.status(400).json({ chyba: 'Deklarovaný typ souboru neodpovídá jeho skutečnému obsahu.' });
    }
  }
  if (!cloudinaryLib.jeNakonfigurovano()) {
    return res.status(503).json({ chyba: 'Nahrávání fotografií není momentálně nakonfigurováno.' });
  }

  // 2) OVĚŘENÍ EXISTENCE PRODUKTU - obyčejný read, BEZ transakce a BEZ FOR
  // UPDATE. Je to jen rychlý pre-check, ať se do Cloudinary vůbec nezačíná
  // nahrávat, když produkt zjevně neexistuje - autoritativní je až druhý
  // SELECT ... FOR UPDATE níže (krok 4), protože produkt může mezi téhle
  // chvílí a koncem uploadu (klidně několik vteřin u víc/větších fotek)
  // ještě zmizet (smazání produktu je jinde v adminu běžná operace).
  const precheck = await pool.query('SELECT id FROM produkty WHERE id = $1', [produktId]);
  if (!precheck.rows.length) {
    return res.status(404).json({ chyba: 'Produkt nenalezen.' });
  }

  // 3) CLOUDINARY UPLOADY - ZÁMĚRNĚ BEZ otevřené DB transakce/zámku. Upload
  // víc/větších fotek je pomalý síťový přenos (klidně vteřiny) - po tu dobu
  // nesmí být obsazená DB connection ani FOR UPDATE na produktu, jinak by se
  // po celou dobu přenosu zbytečně serializovaly i souběžné operace
  // (upload/delete/změna primary) jiných požadavků nad TÍMTO produktem.
  // Souběžné uploady různých requestů tak mohou běžet paralelně - serializuje
  // se až krátká DB finalizace v kroku 4-5.
  const nahraneAssety = []; // { secure_url, public_id } - vše, co se v tomto requestu skutečně nahrálo
  for (const soubor of soubory) {
    let vysledek;
    try {
      vysledek = await cloudinaryLib.nahratObrazek(soubor.buffer, { folder: `detskekrucky/products/${produktId}` });
    } catch (e) {
      // Žádný ROLLBACK - DB transakce ještě vůbec nezačala. Jen uklidit, co
      // se případně stihlo nahrát před tímhle selháním.
      await ukliditNahraneAssety(nahraneAssety.map(a => a.public_id));
      return res.status(502).json({ chyba: 'Nahrání do úložiště fotografií selhalo.' });
    }
    nahraneAssety.push(vysledek);
  }

  // 4) TEPRVE TEĎ, PO úspěšném uploadu VŠECH souborů do Cloudinary, se
  // otevírá DB transakce a zamyká produkt. Tohle FOR UPDATE je autoritativní
  // (na rozdíl od pre-checku v kroku 2) - řeší jak souběh s jiným uploadem/
  // delete/změnou primary nad stejným produktem, tak race, kdy produkt mezi
  // krokem 2 a teď zmizel.
  //
  // Od tohohle bodu dál platí dva klíčové invarianty:
  //   1) DOKUD COMMIT ještě neproběhl: ať selže cokoliv v DB vrstvě - samotné
  //      pool.connect(), BEGIN, FOR UPDATE, INSERT, COMMIT, nebo i samotný
  //      ROLLBACK/release - Cloudinary assety nahrané výše se MUSÍ best-effort
  //      uklidit (nesmí zůstat osiřelé, když k nim není žádný DB řádek).
  //   2) JAKMILE COMMIT úspěšně proběhne: DB řádky jsou trvale uložené a
  //      odkazují na tyhle Cloudinary assety - ty se NIKDY nesmí smazat, ani
  //      kdyby cokoliv selhalo PO COMMITu (typicky jen client.release()).
  //      Cleanup po úspěšném commitu by byl datová nekonzistence (DB řádek
  //      ukazující na smazanou fotku), horší než mírně unikající DB připojení.
  // client se drží v proměnné VENKU try bloku (aby ho catch měl k dispozici,
  // i kdyby selhalo samotné pool.connect()); commitHotov rozlišuje, který
  // invariant právě platí.
  let client = null;
  let transakceOtevrena = false;
  let commitHotov = false;
  let vlozene = [];
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transakceOtevrena = true;

    const produkt = await client.query('SELECT id, nazev FROM produkty WHERE id=$1 FOR UPDATE', [produktId]);
    if (!produkt.rows.length) {
      throw Object.assign(new Error('Produkt mezitím zmizel - fotografie nebyly uloženy.'), { produktZmizel: true });
    }
    const nazevProduktu = produkt.rows[0].nazev;

    // 5) UVNITŘ TRANSAKCE, AŽ PO ZÍSKÁNÍ ZÁMKU: current primary,
    // MAX(position), INSERT jednoho řádku na každý už nahraný Cloudinary asset.
    const stav = await client.query(
      'SELECT COUNT(*)::int AS pocet, COALESCE(MAX(position), -1)::int AS max_pozice FROM product_images WHERE produkt_id=$1',
      [produktId]
    );
    let pozice = stav.rows[0].max_pozice + 1;
    let jizMaPrimarni = stav.rows[0].pocet > 0;

    for (const vysledek of nahraneAssety) {
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
    transakceOtevrena = false;
    commitHotov = true;
  } catch (err) {
    // 6) DB FAILURE (včetně samotného pool.connect(), proto je uvnitř try) -
    // rollback i release jsou best-effort, jejich případné selhání se jen
    // zaloguje a NIKDY nezablokuje krok níže.
    if (client && transakceOtevrena) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('ROLLBACK po neúspěšném uploadu fotografií selhal:', rollbackErr.message);
      }
      transakceOtevrena = false;
    }
    if (client) {
      try {
        client.release();
      } catch (releaseErr) {
        console.error('Uvolnění DB připojení po neúspěšném uploadu fotografií selhalo:', releaseErr.message);
      }
      client = null;
    }

    // Cleanup jen pokud COMMIT ještě neproběhl - viz invarianty výše. Pokud
    // se sem dostal request, kde COMMIT už úspěšně proběhl (výjimka nastala
    // až za ním - v praxi jen při chybě z předchozího client.release() volání
    // výše), commitHotov je true a assety se záměrně nechají být.
    if (!commitHotov) {
      await ukliditNahraneAssety(nahraneAssety.map(a => a.public_id));
    }

    if (err.produktZmizel) {
      return res.status(404).json({ chyba: err.message });
    }
    return res.status(500).json({ chyba: err.message });
  }

  // Sem se dostane VÝHRADNĚ po úspěšném COMMITu. Release je záměrně úplně
  // MIMO kompenzační try/catch výše - jeho případné selhání (spojení se
  // nepodaří vrátit do poolu) tak nemůže žádnou cestou spustit Cloudinary
  // cleanup, protože DB řádky už jsou v tuhle chvíli trvale uložené.
  if (client) {
    try {
      client.release();
    } catch (releaseErr) {
      console.error('Uvolnění DB připojení po úspěšném uploadu fotografií selhalo:', releaseErr.message);
    }
    client = null;
  }
  return res.json(vlozene);
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
    if (alt !== undefined) {
      if (typeof alt !== 'string' || alt.length > MAX_ALT_DELKA) {
        return res.status(400).json({ chyba: `Neplatný ALT text (musí být text, max ${MAX_ALT_DELKA} znaků).` });
      }
      sloupce.push(`alt=$${i++}`); hodnoty.push(alt);
    }
    if (position !== undefined) {
      if (!Number.isInteger(position) || position < 0 || position > MAX_POZICE) {
        return res.status(400).json({ chyba: `Neplatná pozice (musí být celé číslo 0 až ${MAX_POZICE}).` });
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
