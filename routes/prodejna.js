const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { poukazPoPlatnosti } = require('../lib/poukazPlatnost');
const { najitPoukaz } = require('../lib/poukazKarty');
const promo = require('../lib/promo');
const vymena = require('../lib/vymena');

// Jak byly peníze z vratky vráceny (hotově se odečítá z hotovosti v uzávěrce)
const ZPUSOBY_VRACENI = vymena.PLATBY;

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
      -- Výměna zboží (2026-11-11): vrácené boty se započtou do nového nákupu.
      -- Prodej: vymena_castka = zápočet vráceného zboží, celkem = jen doplatek
      -- (do tržeb jde jen to, co zákazník opravdu zaplatil - jako u poukazu).
      ALTER TABLE prodejna_prodeje ADD COLUMN IF NOT EXISTS vymena_castka NUMERIC;
      -- Vratka: castka = peníze opravdu vrácené zákazníkovi (u výměny jen rozdíl,
      -- často 0), zpusob_vraceni = jak (hotovost/karta/qr/prevod, u výměny bez
      -- vrácení peněz 'vymena'; NULL = starší vratka bez údaje), hodnota_zbozi =
      -- hodnota vráceného zboží u výměny, vymena_prodej_id = nový nákup výměny.
      ALTER TABLE vratky ADD COLUMN IF NOT EXISTS zpusob_vraceni TEXT;
      ALTER TABLE vratky ADD COLUMN IF NOT EXISTS hodnota_zbozi NUMERIC;
      ALTER TABLE vratky ADD COLUMN IF NOT EXISTS vymena_prodej_id INTEGER REFERENCES prodejna_prodeje(id) ON DELETE RESTRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS vratky_vymena_prodej_uq ON vratky (vymena_prodej_id) WHERE vymena_prodej_id IS NOT NULL;
      -- Opravy dokladů (např. dodatečný převod vratky + prodeje na výměnu):
      -- co se změnilo a původní hodnoty, kvůli účetnictví nic beze stopy
      CREATE TABLE IF NOT EXISTS prodejna_opravy (
        id SERIAL PRIMARY KEY,
        prodej_id INTEGER,
        vratka_id INTEGER,
        popis TEXT NOT NULL,
        puvodni JSONB,
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

// ═══════════════════════════════
// SLEVOVÝ KÓD AKCE (lib/promo.js) – stejný kód a strop jako v e-shopu
// ═══════════════════════════════

// Mezisoučet a základ slevy z položek prodeje. Ceny jsou z pokladny (prodavačka
// je může upravit), zboží ve slevě (produkty.cena_pred_slevou) se do základu
// nepočítá - stejně jako v e-shopu.
async function zakladProdeje(db, polozky) {
  let mezisoucet = 0;
  const ids = [];
  for (const p of polozky) {
    const pocet = Number(p && p.pocet), cena = Number(p && p.cena);
    if (!Number.isFinite(pocet) || !Number.isFinite(cena) || pocet <= 0 || cena < 0) return null;
    mezisoucet += pocet * cena;
    if (Number.isInteger(p.produkt_id)) ids.push(p.produkt_id);
  }
  const veSleve = new Set(ids.length
    ? (await db.query('SELECT id FROM produkty WHERE id = ANY($1::int[]) AND cena_pred_slevou IS NOT NULL', [ids])).rows.map(r => r.id)
    : []);
  const zaklad = polozky.reduce((s, p) => s + (veSleve.has(p.produkt_id) ? 0 : Number(p.pocet) * Number(p.cena)), 0);
  return { mezisoucet, zaklad };
}

const popisProdejna = v => `kód ${v.kod} – ${v.procenta} %`;

// POST /api/prodejna/promo/overit { kod, polozky } – náhled slevy v pokladně
router.post('/promo/overit', async (req, res) => {
  const { kod, polozky } = req.body || {};
  if (!Array.isArray(polozky) || !polozky.length) return res.status(400).json({ chyba: 'Nejdřív přidejte zboží.' });
  try {
    const z = await zakladProdeje(pool, polozky);
    if (!z) return res.status(400).json({ chyba: 'Neplatná položka prodeje.' });
    const v = await promo.overit(pool, kod, { zaklad: z.zaklad, kanal: 'prodejna' });
    if (!v.ok) return res.status(400).json({ chyba: v.chyba });
    res.json({ kod: v.kod, procenta: v.procenta, sleva: v.sleva, popis: popisProdejna(v), zaklad: z.zaklad });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Prodej se slevovým kódem: v jedné transakci zámek akce, kontrola stropu,
// uložení prodeje se slevou spočítanou serverem a zápis použití kódu.
async function prodejSKodem(req, res) {
  const { zakaznik, platba, poznamka, polozky, hotovost_prijato, promo_kod } = req.body;
  if (req.body.poukaz_kod) return res.status(400).json({ chyba: 'Slevový kód a doplatek k dárkovému poukazu nejde v pokladně kombinovat. Zaplaťte poukazem celý nákup, nebo bez poukazu.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const z = await zakladProdeje(client, polozky);
    if (!z) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'Neplatná položka prodeje.' }); }
    const v = await promo.overit(client, promo_kod, { zaklad: z.zaklad, kanal: 'prodejna', zamknout: true });
    if (!v.ok) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: v.chyba }); }
    const celkem = z.mezisoucet - v.sleva;
    const prijato = platba === 'hotovost' && Number(hotovost_prijato) > 0 ? Number(hotovost_prijato) : null;
    const prodej = (await client.query(
      'INSERT INTO prodejna_prodeje (zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, hotovost_vraceno) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [zakaznik || null, platba || null, poznamka || null, JSON.stringify(polozky), celkem, z.mezisoucet, v.sleva, popisProdejna(v),
       prijato, prijato != null ? Math.max(0, prijato - celkem) : null]
    )).rows[0];
    await promo.zapsatPouziti(client, { kod: v.kod, kanal: 'prodejna', prodejId: prodej.id, zaklad: z.zaklad, sleva: v.sleva });
    await client.query('COMMIT');
    res.json(prodej);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
}

// POST /api/prodejna – vytvořit nový prodej
router.post('/', async (req, res) => {
  const { zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis, hotovost_prijato, hotovost_vraceno } = req.body;
  if (!Array.isArray(polozky) || !polozky.length) {
    return res.status(400).json({ chyba: 'Chybí položky prodeje.' });
  }
  if (req.body.promo_kod) return prodejSKodem(req, res);
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
    // Kód poukazu, jeho EAN nebo EAN plastové karty (lib/poukazKarty.js)
    const nalez = await najitPoukaz(client, poukaz_kod, { zamknout: true });
    const poukaz = nalez.poukaz;
    const chyba = nalez.chyba ? nalez.chyba
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
    const vymenaVratka = (await pool.query('SELECT id FROM vratky WHERE vymena_prodej_id = $1', [req.params.id])).rows[0];
    if (vymenaVratka) return res.status(409).json({ chyba: `Účtenka patří k výměně (vratka #${vymenaVratka.id}) a nejde smazat.` });
    await pool.query('DELETE FROM prodejna_prodeje WHERE id=$1', [req.params.id]);
    // Smazaný prodej uvolní slevový kód akce (místo ve stropu se vrátí)
    await promo.uvolnit(pool, { prodejId: Number(req.params.id) }, 'Smazání prodeje v pokladně');
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

// Kontrola vracených položek proti navázanému prodeji/objednávce (vratka i výměna).
// Volat uvnitř transakce: zamkne zdrojový řádek. Vrací null, nebo { status, chyba }.
async function overitVracenePolozky(client, { prodej_id, objednavka_id, polozky }) {
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
        return { status: 404, chyba: 'Navázaný prodej nenalezen.' };
      }
      zdrojovePolozky = prodej.rows[0].polozky;
    } else {
      const objednavka = await client.query('SELECT id, stav FROM objednavky WHERE id = $1 FOR UPDATE', [objednavka_id]);
      if (!objednavka.rows.length) {
        return { status: 404, chyba: 'Navázaná objednávka nenalezena.' };
      }
      // Symetrie se zrušením objednávky (routes/objednavky.js): kdo z obou
      // (vratka/zrušení) získá zámek na objednávce první, ten "vyhrává" -
      // druhý pak vidí už změněný stav a je odmítnut. Bez tohoto by šlo na
      // už zrušenou objednávku (sklad už vrácen zrušením) vytvořit vratku,
      // která by sklad vrátila podruhé.
      if (objednavka.rows[0].stav === 'zrusena') {
        return { status: 409, chyba: 'Na zrušenou objednávku nelze vytvořit vratku.' };
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
        return { status: 400, chyba: `Položka (produkt ${p.produkt_id}, vel. ${p.velikost}) nebyla součástí navázaného prodeje/objednávky.` };
      }
      const jizVracenoPocet = mapaJizVraceno.get(klic) || 0;
      const celkemNyni = (nyniPozadovano.get(klic) || 0) + p.pocet;
      if (jizVracenoPocet + celkemNyni > puvodniPocet) {
        return { status: 400, chyba: `Nelze vrátit víc kusů (produkt ${p.produkt_id}, vel. ${p.velikost}), než bylo prodáno/objednáno a ještě nevráceno.` };
      }
      nyniPozadovano.set(klic, celkemNyni);
    }
  }

  return null;
}

// POST /api/prodejna/vratky – vytvořit vratku
router.post('/vratky', async (req, res) => {
  const { prodej_id, objednavka_id, polozky, castka, duvod, vratit_na_sklad } = req.body;
  const zpusobVraceni = req.body.zpusob_vraceni || null;
  if (!Array.isArray(polozky) || !polozky.length) {
    return res.status(400).json({ chyba: 'Chybí vracené položky.' });
  }
  if (zpusobVraceni && !ZPUSOBY_VRACENI.includes(zpusobVraceni)) {
    return res.status(400).json({ chyba: 'Neplatný způsob vrácení peněz.' });
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
    const chybaPolozek = await overitVracenePolozky(client, { prodej_id, objednavka_id, polozky });
    if (chybaPolozek) { await client.query('ROLLBACK'); return res.status(chybaPolozek.status).json({ chyba: chybaPolozek.chyba }); }

    const vratka = await client.query(
      'INSERT INTO vratky (prodej_id, objednavka_id, polozky, castka, duvod, vraceno_na_sklad, zpusob_vraceni) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [prodej_id || null, objednavka_id || null, JSON.stringify(polozky), castka, duvod || null, vratit_na_sklad !== false, zpusobVraceni]
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

// ═══════════════════════════════
// VÝMĚNA ZBOŽÍ (lib/vymena.js)
// ═══════════════════════════════

// POST /api/prodejna/vymeny – výměna v jedné transakci: vrácené zboží na sklad
// (vratka navázaná na původní účtenku), nové zboží ze skladu (nový prodej se
// zápočtem), do tržeb jen doplatek / vrácený rozdíl.
// { prodej_id, vracene: [...], nove: [...], zapocet, platba, hotovost_prijato?, duvod?, zakaznik? }
router.post('/vymeny', async (req, res) => {
  const b = req.body || {};
  const prodejId = Number(b.prodej_id);
  const v = vymena.pripravitVymenu({ prodej_id: prodejId, vracene: b.vracene, nove: b.nove, zapocet: b.zapocet, platba: b.platba });
  if (v.chyba) return res.status(400).json({ chyba: v.chyba });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // původní účtenka: zamknout a ověřit, že vrácené kusy na ní byly a ještě nebyly vrácené
    const chybaVracenych = await overitVracenePolozky(client, { prodej_id: prodejId, polozky: b.vracene });
    if (chybaVracenych) { await client.query('ROLLBACK'); return res.status(chybaVracenych.status).json({ chyba: chybaVracenych.chyba }); }

    // nové zboží ze skladu (zámek řádku, ať ho souběžně neprodá pokladna)
    for (const p of b.nove) {
      const r = await client.query('SELECT pocet_kusu FROM sklad WHERE produkt_id = $1 AND velikost = $2 FOR UPDATE', [p.produkt_id, String(p.velikost)]);
      if (!r.rows.length || Number(r.rows[0].pocet_kusu) < p.pocet) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: `${p.nazev || 'Nové zboží'} vel. ${p.velikost} není skladem v potřebném počtu.` });
      }
    }

    const platbaProdeje = v.doplatek > 0 ? b.platba : 'vymena';
    const prijato = platbaProdeje === 'hotovost' && Number(b.hotovost_prijato) > 0 ? Number(b.hotovost_prijato) : null;
    const prodej = (await client.query(
      `INSERT INTO prodejna_prodeje (zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, hotovost_prijato, hotovost_vraceno, vymena_castka)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9) RETURNING *`,
      [b.zakaznik || null, platbaProdeje, `Výměna za zboží z účtenky #${prodejId}`, JSON.stringify(b.nove), v.doplatek, v.noveCelkem,
       prijato, prijato != null ? Math.max(0, prijato - v.doplatek) : null, v.kredit]
    )).rows[0];

    const vratka = (await client.query(
      `INSERT INTO vratky (prodej_id, polozky, castka, duvod, vraceno_na_sklad, zpusob_vraceni, hodnota_zbozi, vymena_prodej_id)
       VALUES ($1,$2,$3,$4,true,$5,$6,$7) RETURNING *`,
      [prodejId, JSON.stringify(b.vracene), v.vraceno, b.duvod ? String(b.duvod).slice(0, 300) : 'Výměna',
       v.vraceno > 0 ? b.platba : 'vymena', v.zapocet, prodej.id]
    )).rows[0];

    for (const p of b.vracene) {
      await client.query(`INSERT INTO sklad (produkt_id, velikost, pocet_kusu) VALUES ($1, $2, $3)
        ON CONFLICT (produkt_id, velikost) DO UPDATE SET pocet_kusu = sklad.pocet_kusu + $3`, [p.produkt_id, String(p.velikost), p.pocet]);
      await client.query(`INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES ($1, $2, 'vratka', $3, $4)`,
        [p.produkt_id, String(p.velikost), p.pocet, `Výměna – vratka #${vratka.id}`]);
    }
    for (const p of b.nove) {
      await client.query('UPDATE sklad SET pocet_kusu = pocet_kusu - $3 WHERE produkt_id = $1 AND velikost = $2', [p.produkt_id, String(p.velikost), p.pocet]);
      await client.query(`INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES ($1, $2, 'prodej', $3, $4)`,
        [p.produkt_id, String(p.velikost), p.pocet, `Výměna – účtenka #${prodej.id}`]);
    }

    await client.query('COMMIT');
    res.json({ prodej, vratka });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// POST /api/prodejna/vymeny/prevest { vratka_id, prodej_id } – dodatečně zapsat,
// že vratka a pozdější prodej byly jedna výměna (dřív se výměna jinak zadat
// nedala). Sklad se nemění (už proběhl), přepočítají se jen částky: prodej =
// doplatek, vratka = vrácený rozdíl. Původní hodnoty jdou do prodejna_opravy.
router.post('/vymeny/prevest', async (req, res) => {
  const vratkaId = Number(req.body && req.body.vratka_id);
  const prodejId = Number(req.body && req.body.prodej_id);
  if (!Number.isInteger(vratkaId) || !Number.isInteger(prodejId)) return res.status(400).json({ chyba: 'Zadejte číslo vratky a účtenky nového nákupu.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vratka = (await client.query('SELECT * FROM vratky WHERE id = $1 FOR UPDATE', [vratkaId])).rows[0];
    const prodej = (await client.query('SELECT * FROM prodejna_prodeje WHERE id = $1 FOR UPDATE', [prodejId])).rows[0];
    if (!vratka || !prodej) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: !vratka ? `Vratka #${vratkaId} neexistuje.` : `Účtenka #${prodejId} neexistuje.` }); }
    const jinaVymena = (await client.query('SELECT id FROM vratky WHERE vymena_prodej_id = $1', [prodejId])).rows[0];
    if (jinaVymena) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: `Účtenka #${prodejId} už patří k výměně (vratka #${jinaVymena.id}).` }); }
    const p = vymena.prevodNaVymenu(vratka, prodej);
    if (p.chyba) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: p.chyba }); }

    const novyProdej = (await client.query(
      `UPDATE prodejna_prodeje SET celkem = $2, vymena_castka = $3, hotovost_prijato = NULL, hotovost_vraceno = NULL,
         platba = CASE WHEN $2::numeric = 0 THEN 'vymena' ELSE platba END,
         poznamka = TRIM(BOTH ' ' FROM COALESCE(poznamka, '') || ' ' || $4)
       WHERE id = $1 RETURNING *`,
      [prodejId, p.prodejCelkem, p.kredit, `Výměna za zboží z vratky #${vratkaId}${vratka.prodej_id ? ' (účtenka #' + vratka.prodej_id + ')' : ''}.`]
    )).rows[0];
    const novaVratka = (await client.query(
      'UPDATE vratky SET castka = $2, hodnota_zbozi = $3, zpusob_vraceni = $4, vymena_prodej_id = $5 WHERE id = $1 RETURNING *',
      [vratkaId, p.vratkaCastka, Number(vratka.castka), p.zpusobVraceni, prodejId]
    )).rows[0];
    await client.query('INSERT INTO prodejna_opravy (prodej_id, vratka_id, popis, puvodni) VALUES ($1,$2,$3,$4)', [
      prodejId, vratkaId,
      `Převod na výměnu: účtenka #${prodejId} ${Number(prodej.celkem)} → ${p.prodejCelkem} Kč (zápočet ${p.kredit} Kč), vratka #${vratkaId} ${Number(vratka.castka)} → ${p.vratkaCastka} Kč`,
      JSON.stringify({
        prodej: { celkem: prodej.celkem, platba: prodej.platba, hotovost_prijato: prodej.hotovost_prijato, hotovost_vraceno: prodej.hotovost_vraceno, poznamka: prodej.poznamka },
        vratka: { castka: vratka.castka, zpusob_vraceni: vratka.zpusob_vraceni }
      })
    ]);
    await client.query('COMMIT');
    res.json({ prodej: novyProdej, vratka: novaVratka, ...p });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
