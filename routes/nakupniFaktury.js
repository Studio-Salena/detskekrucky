// Nákupní faktury (Účetnictví -> Nákupní faktury): evidence faktur za nakoupené
// zboží a jejich úhrad. Jen pro admina. Částky v Kč a DPH počítá lib/nakupniFaktury.js.
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { overitFakturu, platneDatum } = require('../lib/nakupniFaktury');

async function initNakupniFaktury() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nakupni_faktury (
        id SERIAL PRIMARY KEY,
        dodavatel TEXT NOT NULL,
        zeme TEXT NOT NULL DEFAULT 'CZ',
        cislo_faktury TEXT NOT NULL,
        datum_vystaveni DATE NOT NULL,
        datum_splatnosti DATE,
        datum_uhrady DATE,
        mena TEXT NOT NULL DEFAULT 'CZK',
        castka NUMERIC(14,2) NOT NULL,
        kurz NUMERIC(12,4) NOT NULL DEFAULT 1,
        castka_czk NUMERIC(14,2) NOT NULL,
        rezim_dph TEXT NOT NULL,
        sazba_dph NUMERIC(5,2) NOT NULL DEFAULT 21,
        zaklad_czk NUMERIC(14,2) NOT NULL,
        dph_czk NUMERIC(14,2) NOT NULL DEFAULT 0,
        poznamka TEXT,
        vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        upraveno TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS nakupni_faktury_dodavatel_cislo_idx ON nakupni_faktury (LOWER(dodavatel), cislo_faktury);
    `);
    console.log('Nakupni faktury OK');
  } catch (e) {
    console.log('Nakupni faktury chyba:', e.message);
  }
}
pripravit(initNakupniFaktury());

router.use(vyzadovatAdmina);

const SLOUPCE = ['dodavatel', 'zeme', 'cislo_faktury', 'datum_vystaveni', 'datum_splatnosti', 'datum_uhrady', 'mena', 'castka', 'kurz',
  'castka_czk', 'rezim_dph', 'sazba_dph', 'zaklad_czk', 'dph_czk', 'poznamka'];
// DATE vracet jako text YYYY-MM-DD (bez posunu časového pásma)
const SELECT = `SELECT id, dodavatel, zeme, cislo_faktury,
  TO_CHAR(datum_vystaveni, 'YYYY-MM-DD') AS datum_vystaveni, TO_CHAR(datum_splatnosti, 'YYYY-MM-DD') AS datum_splatnosti,
  TO_CHAR(datum_uhrady, 'YYYY-MM-DD') AS datum_uhrady, mena, castka::float AS castka, kurz::float AS kurz, castka_czk::float AS castka_czk,
  rezim_dph, sazba_dph::float AS sazba_dph, zaklad_czk::float AS zaklad_czk, dph_czk::float AS dph_czk, poznamka, vytvoreno
  FROM nakupni_faktury`;

const DUPLICITA = 'Faktura s tímto číslem od stejného dodavatele už je zapsaná.';

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`${SELECT} ORDER BY datum_vystaveni DESC, id DESC`);
    res.json(r.rows);
  } catch (e) {
    console.error('Nákupní faktury - načtení selhalo:', e.message);
    res.status(500).json({ chyba: 'Faktury se nepodařilo načíst.' });
  }
});

router.post('/', async (req, res) => {
  const { chyba, hodnoty } = overitFakturu(req.body);
  if (chyba) return res.status(400).json({ chyba });
  try {
    const r = await pool.query(
      `INSERT INTO nakupni_faktury (${SLOUPCE.join(', ')}) VALUES (${SLOUPCE.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
      SLOUPCE.map(k => hodnoty[k])
    );
    res.status(201).json({ id: r.rows[0].id, ...hodnoty });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ chyba: DUPLICITA });
    console.error('Nákupní faktury - uložení selhalo:', e.message);
    res.status(500).json({ chyba: 'Fakturu se nepodařilo uložit.' });
  }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ chyba: 'Neplatné id faktury.' });
  const { chyba, hodnoty } = overitFakturu(req.body);
  if (chyba) return res.status(400).json({ chyba });
  try {
    const r = await pool.query(
      `UPDATE nakupni_faktury SET ${SLOUPCE.map((k, i) => `${k} = $${i + 1}`).join(', ')}, upraveno = NOW() WHERE id = $${SLOUPCE.length + 1} RETURNING id`,
      [...SLOUPCE.map(k => hodnoty[k]), id]
    );
    if (!r.rows.length) return res.status(404).json({ chyba: 'Faktura nebyla nalezena.' });
    res.json({ id, ...hodnoty });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ chyba: DUPLICITA });
    console.error('Nákupní faktury - úprava selhala:', e.message);
    res.status(500).json({ chyba: 'Fakturu se nepodařilo uložit.' });
  }
});

// Rychlé označení úhrady (nebo zrušení úhrady: datum_uhrady null)
router.patch('/:id/uhrada', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ chyba: 'Neplatné id faktury.' });
  const datum = req.body && req.body.datum_uhrady;
  if (datum !== null && !platneDatum(datum)) return res.status(400).json({ chyba: 'Neplatné datum úhrady.' });
  try {
    const r = await pool.query('UPDATE nakupni_faktury SET datum_uhrady = $1, upraveno = NOW() WHERE id = $2 RETURNING id', [datum, id]);
    if (!r.rows.length) return res.status(404).json({ chyba: 'Faktura nebyla nalezena.' });
    res.json({ id, datum_uhrady: datum });
  } catch (e) {
    console.error('Nákupní faktury - úhrada selhala:', e.message);
    res.status(500).json({ chyba: 'Úhradu se nepodařilo uložit.' });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ chyba: 'Neplatné id faktury.' });
  try {
    const r = await pool.query('DELETE FROM nakupni_faktury WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ chyba: 'Faktura nebyla nalezena.' });
    res.json({ zprava: 'Faktura smazána' });
  } catch (e) {
    console.error('Nákupní faktury - smazání selhalo:', e.message);
    res.status(500).json({ chyba: 'Fakturu se nepodařilo smazat.' });
  }
});

module.exports = router;
