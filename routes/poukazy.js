const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { jeZablokovana: jeZadostZablokovana, zaznamenatZadost } = require('../middleware/poukazyZadostLimiter');
const { odeslat_upozorneni_zadost_poukaz, odeslat_poukaz_zakaznikovi } = require('./emaily');
const { poukazPoPlatnosti, datumPlatnosti, chybaProdlouzeni, platnostNovehoPoukazu } = require('../lib/poukazPlatnost');
const { najitPoukaz, normalizovatCisloKarty } = require('../lib/poukazKarty');
const evidence = require('../lib/evidencePlateb');
const eetUdalosti = require('../lib/eetUdalosti');
const eetFronta = require('../lib/eetFronta');
const kredit = require('../lib/kreditVklady');
const eetZamek = require('../lib/eetZamek');

const POVOLENE_HODNOTY = [500, 1000, 1500];
// Na plastovou kartu jde nahrát libovolná částka v celých korunách
const KARTA_MIN = 100, KARTA_MAX = 50000;
// Vzhled tištěného poukazu - volí se při vydání, ať jde i později vytisknout stejně
const POVOLENE_VZHLEDY = ['klasicky', 'vanocni'];
// Druh poukazu: prodej (zaplacený), dar (daný zdarma - nepočítá se do tržeb ani
// při vydání, ani při uplatnění). Druh je vidět i z EAN: 21… prodej, 22… dar
// (starší poukazy mají 20…).
const PREFIX_EAN = { prodej: '21', dar: '22' };
const POVOLENE_DRUHY = Object.keys(PREFIX_EAN);

async function initTabulky() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS darkove_poukazy (
        id SERIAL PRIMARY KEY,
        kod TEXT UNIQUE NOT NULL,
        ean TEXT UNIQUE NOT NULL,
        hodnota NUMERIC NOT NULL,
        zustatek NUMERIC NOT NULL,
        platnost_do DATE NOT NULL,
        stav TEXT NOT NULL DEFAULT 'aktivni',
        zakoupeno_kde TEXT NOT NULL,
        kupujici_jmeno TEXT,
        kupujici_email TEXT,
        poznamka TEXT,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE darkove_poukazy ADD COLUMN IF NOT EXISTS vydano_prodej_id INTEGER REFERENCES prodejna_prodeje(id) ON DELETE SET NULL;
      ALTER TABLE darkove_poukazy ADD COLUMN IF NOT EXISTS vzhled TEXT NOT NULL DEFAULT 'klasicky';
      ALTER TABLE darkove_poukazy ADD COLUMN IF NOT EXISTS druh TEXT NOT NULL DEFAULT 'prodej';
      -- Stav úhrady poukazu (2026-11-17): zaplaceno / ceka (poukaz z e-shopu čeká na
      -- platbu, stav 'ceka_na_platbu' - nejde použít) / dar / historicky (vydaný před
      -- evidencí plateb - použitelný jako dřív, platba se mu nevymýšlí). Nové poukazy
      -- dostávají hodnotu vždy z kódu, NULL mají jen ty historické.
      ALTER TABLE darkove_poukazy ADD COLUMN IF NOT EXISTS platba_stav TEXT;
      UPDATE darkove_poukazy SET platba_stav = 'historicky' WHERE platba_stav IS NULL;
      CREATE TABLE IF NOT EXISTS poukazy_pouziti (
        id SERIAL PRIMARY KEY,
        poukaz_id INTEGER REFERENCES darkove_poukazy(id) ON DELETE CASCADE,
        castka NUMERIC NOT NULL,
        prodej_id INTEGER,
        objednavka_id INTEGER,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS poukazy_zadosti (
        id SERIAL PRIMARY KEY,
        hodnota NUMERIC NOT NULL,
        kupujici_jmeno TEXT NOT NULL,
        kupujici_email TEXT NOT NULL,
        kupujici_telefon TEXT,
        pro_koho TEXT,
        vzkaz TEXT,
        stav TEXT NOT NULL DEFAULT 'nova',
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
      -- vzhled, který si zákazník vybral v e-shopu (2026-10-09)
      ALTER TABLE poukazy_zadosti ADD COLUMN IF NOT EXISTS vzhled TEXT NOT NULL DEFAULT 'klasicky';
      -- Plastové dárkové karty (2026-11-11): znovupoužitelný nosič poukazu, viz lib/poukazKarty.js
      CREATE TABLE IF NOT EXISTS poukazove_karty (
        id SERIAL PRIMARY KEY,
        cislo TEXT UNIQUE NOT NULL,
        ean TEXT UNIQUE NOT NULL,
        aktualni_poukaz_id INTEGER UNIQUE REFERENCES darkove_poukazy(id) ON DELETE SET NULL,
        zablokovana BOOLEAN NOT NULL DEFAULT false,
        duvod_blokace TEXT,
        poznamka TEXT,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE darkove_poukazy ADD COLUMN IF NOT EXISTS karta_id INTEGER REFERENCES poukazove_karty(id) ON DELETE SET NULL;
      -- Starší čísla karet K0001 → DK-RR-00001 (rok založení karty); proběhne jen jednou
      UPDATE poukazove_karty SET cislo = 'DK-' || to_char(vytvoreno AT TIME ZONE 'Europe/Prague', 'YY') || '-' || lpad(substring(cislo from 2), 5, '0')
        WHERE cislo ~ '^K[0-9]+$';
      -- Historie karty: nahrání, uvolnění, blokace, převod (kdo nic nemaže, jen přidává)
      CREATE TABLE IF NOT EXISTS poukazove_karty_udalosti (
        id SERIAL PRIMARY KEY,
        karta_id INTEGER NOT NULL REFERENCES poukazove_karty(id) ON DELETE CASCADE,
        akce TEXT NOT NULL,
        poukaz_id INTEGER,
        poznamka TEXT,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
      -- Ruční změny poukazu správcem (2026-11-11: prodloužení platnosti) - kvůli
      -- dohledatelnosti, co a kdy se měnilo
      CREATE TABLE IF NOT EXISTS poukazy_zmeny (
        id SERIAL PRIMARY KEY,
        poukaz_id INTEGER NOT NULL REFERENCES darkove_poukazy(id) ON DELETE CASCADE,
        popis TEXT NOT NULL,
        vytvoreno TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Poukazy tabulky OK');
  } catch (e) {
    console.log('Poukazy tabulky chyba:', e.message);
  }
}
pripravit(initTabulky());

function vygenerovatKod() {
  const znaky = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez matoucích znaků (0/O, 1/I)
  let c1 = '', c2 = '';
  for (let i = 0; i < 4; i++) c1 += znaky[Math.floor(Math.random() * znaky.length)];
  for (let i = 0; i < 4; i++) c2 += znaky[Math.floor(Math.random() * znaky.length)];
  return `DK-${c1}-${c2}`;
}

// Vygeneruje platný EAN-13 kód (prefix 2x = interní/vlastní použití dle GS1, druhá číslice = druh poukazu)
function vygenerovatEan(druh = 'prodej') {
  let zaklad = PREFIX_EAN[druh];
  for (let i = 0; i < 10; i++) zaklad += Math.floor(Math.random() * 10);
  let soucet = 0;
  for (let i = 0; i < 12; i++) {
    soucet += Number(zaklad[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const kontrolni = (10 - (soucet % 10)) % 10;
  return zaklad + kontrolni;
}

// ═══════════════════════════════
// VEŘEJNÉ – ověření poukazu (volá prodejna i e-shop, bez přihlášení)
// ═══════════════════════════════
router.get('/overit/:kod', async (req, res) => {
  try {
    const nalez = await najitPoukaz(pool, req.params.kod);
    if (nalez.chyba) return res.status(nalez.status).json({ chyba: nalez.chyba });
    const poukaz = nalez.poukaz;
    if (poukaz.stav === 'zruseny') return res.status(400).json({ chyba: 'Tento poukaz byl zrušen.' });
    if (poukaz.stav === 'pouzity' || Number(poukaz.zustatek) <= 0) return res.status(400).json({ chyba: 'Tento poukaz je již plně vyčerpaný.' });
    if (poukazPoPlatnosti(poukaz.platnost_do)) return res.status(400).json({ chyba: 'Platnost poukazu vypršela.' });
    res.json({ id: poukaz.id, kod: poukaz.kod, ean: poukaz.ean, hodnota: Number(poukaz.hodnota), zustatek: Number(poukaz.zustatek), platnost_do: poukaz.platnost_do, karta: nalez.karta ? nalez.karta.cislo : null });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/poukazy/zadost – zákazník na e-shopu žádá o koupi poukazu (veřejné)
router.post('/zadost', async (req, res) => {
  const zbyvaSekund = jeZadostZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho žádostí z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }
  const { hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz } = req.body;
  const vzhled = req.body.vzhled === undefined ? 'klasicky' : req.body.vzhled;
  if (!POVOLENE_VZHLEDY.includes(vzhled)) {
    return res.status(400).json({ chyba: 'Vyberte prosím vzhled poukazu.' });
  }
  const hodnotaCislo = Number(hodnota);
  if (!POVOLENE_HODNOTY.includes(hodnotaCislo)) {
    return res.status(400).json({ chyba: `Hodnota poukazu musí být jedna z: ${POVOLENE_HODNOTY.join(', ')} Kč.` });
  }
  if (!kupujici_jmeno || !kupujici_email) {
    return res.status(400).json({ chyba: 'Vyplňte prosím jméno a e-mail.' });
  }
  zaznamenatZadost(req.ip);
  try {
    const result = await pool.query(
      'INSERT INTO poukazy_zadosti (hodnota, kupujici_jmeno, kupujici_email, kupujici_telefon, pro_koho, vzkaz, vzhled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [hodnotaCislo, kupujici_jmeno, kupujici_email, kupujici_telefon || null, pro_koho || null, vzkaz || null, vzhled]
    );
    res.json(result.rows[0]);

    // Až po odpovědi, ať prodleva/chyba s odesláním e-mailu žádost neblokuje
    // (stejný vzor jako u objednávek/rezervací).
    odeslat_upozorneni_zadost_poukaz(result.rows[0]).catch(e => console.error('Upozorneni majitelce o zadosti o poukaz se nepodarilo odeslat:', e.message));
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// ═══════════════════════════════
// ADMIN – vydávání a správa poukazů
// ═══════════════════════════════

// POST /api/poukazy – vydat nový poukaz (přímý prodej na prodejně, nebo po potvrzení žádosti z e-shopu)
// Volitelné pole `platba` (hotovost/karta/qr/prevod) říká, že za poukaz teď skutečně přišly peníze –
// v tom případě vznikne i běžný záznam prodeje (prodejna_prodeje), ať jde vytisknout účtenka a peníze
// se započítají do tržeb. Bez `platba` (např. ruční oprava evidence) se prodej nevytváří jako dřív.
router.post('/', vyzadovatAdmina, async (req, res) => {
  const od = new Date();
  const { hodnota, zakoupeno_kde, kupujici_jmeno, kupujici_email, poznamka, platba } = req.body;
  const vzhled = req.body.vzhled || 'klasicky';
  const druh = req.body.druh || 'prodej';
  const hodnotaCislo = Number(hodnota);
  const kartaEan = req.body.karta_ean ? String(req.body.karta_ean).trim() : null;
  if (kartaEan) {
    if (!Number.isInteger(hodnotaCislo) || hodnotaCislo < KARTA_MIN || hodnotaCislo > KARTA_MAX) {
      return res.status(400).json({ chyba: `Na kartu jde nahrát ${KARTA_MIN}–${KARTA_MAX.toLocaleString('cs-CZ')} Kč v celých korunách.` });
    }
  } else if (!POVOLENE_HODNOTY.includes(hodnotaCislo)) {
    return res.status(400).json({ chyba: `Hodnota poukazu musí být jedna z: ${POVOLENE_HODNOTY.join(', ')} Kč.` });
  }
  if (platba && !['hotovost', 'karta', 'qr', 'prevod'].includes(platba)) {
    return res.status(400).json({ chyba: 'Neplatný způsob platby.' });
  }
  if (!POVOLENE_VZHLEDY.includes(vzhled)) {
    return res.status(400).json({ chyba: 'Neplatný vzhled poukazu.' });
  }
  if (!POVOLENE_DRUHY.includes(druh)) {
    return res.status(400).json({ chyba: 'Neplatný druh poukazu.' });
  }
  if (druh === 'dar' && platba) {
    return res.status(400).json({ chyba: 'Darovaný poukaz se neplatí – nevybírejte platbu.' });
  }
  if (kartaEan && druh !== 'dar' && !platba) {
    return res.status(400).json({ chyba: 'Kartu nabijte až s platbou (bez platby by kredit nebyl doložený).' });
  }
  // Prodaný poukaz bez platby (typicky žádost z e-shopu) čeká na platbu a nejde použít
  const cekaNaPlatbu = druh !== 'dar' && !platba;

  const client = await pool.connect();
  try {
    let kod, ean, pokus = 0;
    while (true) {
      kod = vygenerovatKod();
      ean = vygenerovatEan(druh);
      const existuje = await client.query('SELECT id FROM darkove_poukazy WHERE kod = $1 OR ean = $2', [kod, ean]);
      if (existuje.rows.length === 0) break;
      if (++pokus > 10) { client.release(); return res.status(500).json({ chyba: 'Nepodařilo se vygenerovat unikátní kód, zkuste to znovu.' }); }
    }
    const platnostDo = platnostNovehoPoukazu();

    await client.query('BEGIN');
    // Stejný klíč (dvojklik, opakování po výpadku) = jeden poukaz
    const { vysledek, opakovane } = await evidence.jednou(client, 'poukaz-vydani', req.body.klic,
      { hodnota: hodnotaCislo, druh, platba: platba || null, karta: kartaEan, zakoupeno_kde: zakoupeno_kde || null, kupujici_email: kupujici_email || null }, async () => {

    // Plastová karta: musí existovat, být prázdná a nezablokovaná. Zámek řádku
    // karty brání tomu, aby se na ni souběžně nahrály dva poukazy.
    let karta = null;
    if (kartaEan) {
      karta = (await client.query('SELECT * FROM poukazove_karty WHERE ean = $1 OR UPPER(cislo) = $2 FOR UPDATE', [kartaEan, normalizovatCisloKarty(kartaEan)])).rows[0];
      const chybaKarty = !karta ? 'Karta nebyla nalezena – nejdřív ji přidejte mezi karty.'
        : karta.zablokovana ? `Karta ${karta.cislo} je zablokovaná.`
        : karta.aktualni_poukaz_id ? `Na kartě ${karta.cislo} už poukaz je. Vyčerpanou kartu nejdřív uvolněte.`
        : null;
      if (chybaKarty) throw new evidence.ChybaEvidence(400, chybaKarty);
    }

    let poukaz = (await client.query(
      `INSERT INTO darkove_poukazy (kod, ean, hodnota, zustatek, platnost_do, stav, zakoupeno_kde, kupujici_jmeno, kupujici_email, poznamka, vzhled, druh, platba_stav)
       VALUES ($1,$2,$3,$3,$4,$11,$5,$6,$7,$8,$9,$10,$12) RETURNING *`,
      [kod, ean, hodnotaCislo, platnostDo, zakoupeno_kde || 'prodejna', kupujici_jmeno || null, kupujici_email || null, poznamka || null, vzhled, druh,
       cekaNaPlatbu ? 'ceka_na_platbu' : 'aktivni', druh === 'dar' ? 'dar' : (platba ? 'zaplaceno' : 'ceka')]
    )).rows[0];

    if (karta) {
      poukaz = (await client.query('UPDATE darkove_poukazy SET karta_id=$1 WHERE id=$2 RETURNING *', [karta.id, poukaz.id])).rows[0];
      await client.query('UPDATE poukazove_karty SET aktualni_poukaz_id=$1 WHERE id=$2', [poukaz.id, karta.id]);
      await client.query("INSERT INTO poukazove_karty_udalosti (karta_id, akce, poukaz_id, poznamka) VALUES ($1,'nahrani',$2,$3)",
        [karta.id, poukaz.id, `${hodnotaCislo} Kč${druh === 'dar' ? ' (dar)' : ''}`]);
    }

    let prodej = null;
    if (platba) {
      const nazev = karta ? `Dárková karta ${karta.cislo} – ${hodnotaCislo} Kč` : `Dárkový poukaz ${hodnotaCislo} Kč`;
      // platnost a karta i v položce účtenky - vytiskne se a zůstane při dotisku
      const polozky = [{ nazev, typ: 'poukaz', pocet: 1, cena: hodnotaCislo, poukaz_kod: kod,
        platnost_do: datumPlatnosti(poukaz.platnost_do), ...(karta ? { karta: karta.cislo } : {}) }];
      prodej = (await client.query(
        `INSERT INTO prodejna_prodeje (zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva)
         VALUES ($1,$2,$3,$4,$5,$5,0) RETURNING *`,
        [kupujici_jmeno || null, platba, karta ? `Nahrání dárkové karty ${karta.cislo} (poukaz ${kod})` : `Prodej dárkového poukazu ${kod}`, JSON.stringify(polozky), hodnotaCislo]
      )).rows[0];
      poukaz = (await client.query(
        'UPDATE darkove_poukazy SET vydano_prodej_id=$1 WHERE id=$2 RETURNING *',
        [prodej.id, poukaz.id]
      )).rows[0];
    }

    // Evidence: peníze za poukaz (s částí určenou k čerpání) a kredit s původem
    let platbaZaPoukaz = null;
    if (prodej) {
      const naDalku = platba === 'prevod';
      platbaZaPoukaz = await evidence.zapsatPlatbu(client, { klic: `poukaz:${poukaz.id}:prijem`, typ: 'prijem', castka: hodnotaCislo, zpusob: platba,
        okolnosti: naDalku ? 'eshop' : 'prodejna', kontaktni: !naDalku, prijato_at: prodej.datum, zdroj_typ: 'prodej', zdroj_id: prodej.id,
        urceno_k_cerpani: hodnotaCislo });
    }
    // Kredit (vklad) vzniká jen u zaplaceného nebo darovaného poukazu; čekající ho dostane až s platbou
    if (!cekaNaPlatbu) {
      await kredit.nabit(client, { poukaz, castka: hodnotaCislo, puvod: evidence.puvodPoukazu(poukaz), platba: platbaZaPoukaz, klic: `poukaz:${poukaz.id}:nabiti` });
    }
    // EET: prodej poukazu / nabití karty u pultu = tržba s částkou určenou k čerpání
    if (prodej) await eetUdalosti.zaznamenat(client, { zdroj_typ: 'prodej', zdroj_id: prodej.id, klic: 'poukaz' });

    return { ...poukaz, prodej, karta: karta ? { id: karta.id, cislo: karta.cislo, ean: karta.ean } : null };
    });

    await client.query('COMMIT');
    // prodej poukazu je uložený; hned první odeslání do EET (výsledek odděleně)
    const eet = vysledek.prodej ? await eetFronta.stavPoUlozeni(pool, [['prodej', vysledek.prodej.id]], { od }) : null;
    res.json({ ...vysledek, ...(opakovane ? { opakovane: true } : {}), ...(eet ? { eet } : {}) });
    const poukaz = vysledek;

    // Kód pošleme zákazníkovi jen když máme e-mail (přímý prodej na prodejně
    // bez e-mailu ho prostě nedostane e-mailem - to je v pořádku, dostane ho
    // fyzicky/ústně). Až po odpovědi, ať prodleva/chyba neblokuje vydání.
    if (!opakovane && poukaz.kupujici_email && poukaz.stav !== 'ceka_na_platbu') {
      odeslat_poukaz_zakaznikovi(poukaz).catch(e => console.error('Email s kodem poukazu se nepodarilo odeslat:', e.message));
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof evidence.ChybaEvidence) return res.status(err.status).json({ chyba: err.chyba });
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// GET /api/poukazy – seznam všech vydaných poukazů
router.get('/', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query(`SELECT dp.*, k.cislo AS karta_cislo FROM darkove_poukazy dp
      LEFT JOIN poukazove_karty k ON k.id = dp.karta_id ORDER BY dp.vytvoreno DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/poukazy/pouzit – uplatnit poukaz na prodejně (odečíst zůstatek)
router.post('/pouzit', vyzadovatAdmina, async (req, res) => {
  const { kod, castka, prodej_id } = req.body;
  if (!kod || !castka || castka <= 0) return res.status(400).json({ chyba: 'Chybí kód nebo částka.' });

  // Samostatné čerpání (starší okno pokladny) nemá vazbu na účtenku – se zapnutým EET by
  // vznikla tržba bez dokladu. Současná pokladna čerpá poukaz v rámci prodeje (/api/prodejna).
  if (eetUdalosti.aktualniKonfigurace()) return res.status(409).json({ chyba: 'Poukaz se uplatňuje přímo v pokladně. Obnovte stránku administrace (Ctrl+F5).' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nalez = await najitPoukaz(client, kod, { zamknout: true });
    if (nalez.chyba) { await client.query('ROLLBACK'); return res.status(nalez.status).json({ chyba: nalez.chyba }); }
    const poukaz = { ...nalez.poukaz }; // kopie před odečtem zůstatku
    if (poukaz.stav !== 'aktivni') { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'Poukaz už není aktivní.' }); }
    // Server platnost ověřuje sám - nespoléhá na to, že admin předtím volal /overit
    if (poukazPoPlatnosti(poukaz.platnost_do)) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'Platnost poukazu vypršela.' }); }
    if (Number(poukaz.zustatek) < castka) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: `Na poukazu zbývá jen ${poukaz.zustatek} Kč.` }); }

    const novyZustatek = Number(poukaz.zustatek) - Number(castka);
    const novyStav = novyZustatek <= 0 ? 'pouzity' : 'aktivni';
    await client.query('UPDATE darkove_poukazy SET zustatek=$1, stav=$2 WHERE id=$3', [novyZustatek, novyStav, poukaz.id]);
    const pouziti = (await client.query('INSERT INTO poukazy_pouziti (poukaz_id, castka, prodej_id) VALUES ($1,$2,$3) RETURNING id', [poukaz.id, castka, prodej_id || null])).rows[0];
    await kredit.cerpat(client, { poukaz, castka, klic: `pouziti:${pouziti.id}:cerpani`, zdroj_typ: 'prodej', zdroj_id: prodej_id || null, kontaktni: true });

    await client.query('COMMIT');
    res.json({ ok: true, zustatek: novyZustatek, karta: nalez.karta ? nalez.karta.cislo : null });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof evidence.ChybaEvidence) return res.status(err.status).json({ chyba: err.chyba });
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// POST /api/poukazy/:id/platba { klic, zpusob, castka? } nebo { klic, platba_id } – úhrada
// poukazu, který čeká na platbu (žádost z e-shopu, „zaplatí později“). Zapíše se
// platba (nebo přiřadí už zapsaná volná platba - bez dvojího příjmu), poukaz se
// aktivuje a vznikne zaplacený vklad kreditu. Částečná úhrada poukazu není podporovaná.
router.post('/:id/platba', vyzadovatAdmina, async (req, res) => {
  const b = req.body || {};
  const od = new Date();
  if (!b.klic) return res.status(400).json({ chyba: 'Chybí identifikátor operace – obnovte stránku administrace.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const data = { id: req.params.id, zpusob: b.zpusob || null, castka: b.castka != null ? Number(b.castka) : null, platba_id: b.platba_id ? Number(b.platba_id) : null };
    const { vysledek, opakovane } = await evidence.jednou(client, 'poukaz-platba', b.klic, data, async () => {
      const poukaz = (await client.query('SELECT * FROM darkove_poukazy WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!poukaz) throw new evidence.ChybaEvidence(404, 'Poukaz nenalezen.');
      if (poukaz.stav !== 'ceka_na_platbu') throw new evidence.ChybaEvidence(409, 'Poukaz na platbu nečeká (už je zaplacený, darovaný nebo zrušený).');
      const hodnota = Number(poukaz.hodnota);
      if (data.castka != null && data.castka !== hodnota) {
        throw new evidence.ChybaEvidence(400, `Částečná úhrada poukazu není podporovaná – zapište celou hodnotu ${hodnota} Kč.`);
      }
      let platba;
      if (data.platba_id) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['volna-platba:' + data.platba_id]);
        const { platba: volna, volno } = await evidence.volnaCastPlatby(client, data.platba_id);
        if (!volna || volna.zdroj_typ !== 'volna' || volna.typ !== 'prijem') throw new evidence.ChybaEvidence(400, 'Přiřadit jde jen volnou platbu (bez dokladu).');
        if (volno < hodnota) throw new evidence.ChybaEvidence(400, `Z platby zbývá k přiřazení jen ${volno} Kč – poukaz za ${hodnota} Kč jí uhradit nejde (částečná úhrada není podporovaná).`);
        await client.query('INSERT INTO platby_prirazeni (klic, platba_id, poukaz_id, castka) VALUES ($1,$2,$3,$4)', ['prirazeni-poukaz:' + b.klic, volna.id, poukaz.id, hodnota]);
        // EET: tržba vznikla už při přijetí; změnil-li se tím účel, vzniknou opravné události
        await eetUdalosti.srovnatVolnou(client, volna.id, 'prirazeni-poukaz:' + b.klic);
        platba = volna;
      } else {
        if (!['hotovost', 'karta', 'qr', 'prevod'].includes(data.zpusob)) throw new evidence.ChybaEvidence(400, 'Vyberte způsob platby.');
        const naDalku = data.zpusob === 'prevod';
        platba = await evidence.zapsatPlatbu(client, { klic: `poukaz:${poukaz.id}:platba`, typ: 'prijem', castka: hodnota, zpusob: data.zpusob,
          okolnosti: naDalku ? 'eshop' : 'prodejna', kontaktni: !naDalku, zdroj_typ: 'poukaz', zdroj_id: poukaz.id, urceno_k_cerpani: hodnota });
      }
      // platnost běží od úhrady (stejně jako u poukazu prodaného na prodejně)
      const aktivni = (await client.query(
        "UPDATE darkove_poukazy SET stav = 'aktivni', platba_stav = 'zaplaceno', platnost_do = $2 WHERE id = $1 RETURNING *",
        [poukaz.id, platnostNovehoPoukazu()])).rows[0];
      await kredit.nabit(client, { poukaz: aktivni, castka: hodnota, puvod: 'zaplaceny', platba, klic: `poukaz:${poukaz.id}:nabiti` });
      // EET: úhrada u pultu = tržba (určeno k čerpání); přiřazená volná platba novou tržbu netvoří
      await eetUdalosti.zaznamenat(client, { zdroj_typ: 'poukaz', zdroj_id: poukaz.id, klic: 'platba' });
      return aktivni;
    });
    await client.query('COMMIT');
    const eet = await eetFronta.stavPoUlozeni(pool, [['poukaz', vysledek.id], ...(b.platba_id ? [['volna', Number(b.platba_id)]] : [])], { od });
    res.json({ ...vysledek, ...(opakovane ? { opakovane: true } : {}), ...(eet ? { eet } : {}) });
    if (!opakovane && vysledek.kupujici_email) {
      odeslat_poukaz_zakaznikovi(vysledek).catch(e => console.error('Email s kodem poukazu se nepodarilo odeslat:', e.message));
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof evidence.ChybaEvidence) return res.status(err.status).json({ chyba: err.chyba });
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// ═══ Vrácení peněz za zaplacený poukaz ═══
// Původní platba zůstává; vrácení se na ni váže (vraci_id). Vrátit jde nejvýš
// zaplacený kredit, který je ještě na poukazu, a zároveň nejvýš zaplacenou částku
// minus dřívější vrácení. U poukazu prodaného na prodejně vznikne vratka k jeho
// účtence (sedí uzávěrky i Účetnictví), u e-shopového jen platba v evidenci.

// Platba, kterou byl poukaz zaplacen: účtenka prodeje poukazu, přímá platba, nebo přiřazená volná platba
async function platbaZaPoukaz(client, poukaz) {
  const nestorno = "AND NOT EXISTS (SELECT 1 FROM platby s WHERE s.opravuje_id = p.id)";
  if (poukaz.vydano_prodej_id) {
    const pl = (await client.query(`SELECT p.* FROM platby p WHERE p.zdroj_typ = 'prodej' AND p.zdroj_id = $1 AND p.typ = 'prijem' ${nestorno} ORDER BY p.id LIMIT 1`, [poukaz.vydano_prodej_id])).rows[0];
    if (pl) return { platba: pl, zaplaceno: Number(pl.castka), prodejId: poukaz.vydano_prodej_id };
  }
  const prima = (await client.query(`SELECT p.* FROM platby p WHERE p.zdroj_typ = 'poukaz' AND p.zdroj_id = $1 AND p.typ = 'prijem' ${nestorno} ORDER BY p.id LIMIT 1`, [poukaz.id])).rows[0];
  if (prima) return { platba: prima, zaplaceno: Number(prima.castka), prodejId: null };
  const pr = (await client.query(`SELECT pr.castka AS prirazeno, p.* FROM platby_prirazeni pr JOIN platby p ON p.id = pr.platba_id
    WHERE pr.poukaz_id = $1 AND NOT EXISTS (SELECT 1 FROM platby_prirazeni_storna st WHERE st.prirazeni_id = pr.id) LIMIT 1`, [poukaz.id])).rows[0];
  if (pr) return { platba: pr, zaplaceno: Number(pr.prirazeno), prodejId: null };
  return null;
}
async function vracenoZaPoukaz(client, poukaz, info) {
  const prime = (await client.query(`SELECT COALESCE(SUM(CASE typ WHEN 'vraceni' THEN castka ELSE -castka END), 0) AS s FROM platby
    WHERE zdroj_typ = 'poukaz' AND zdroj_id = $1 AND typ IN ('vraceni', 'storno_vraceni')`, [poukaz.id])).rows[0].s;
  let vratkami = 0;
  if (info && info.prodejId) {
    vratkami = (await client.query(`SELECT COALESCE(SUM(CASE p.typ WHEN 'vraceni' THEN p.castka ELSE -p.castka END), 0) AS s FROM platby p JOIN vratky v ON v.id = p.zdroj_id
      WHERE p.zdroj_typ = 'vratka' AND p.typ IN ('vraceni', 'storno_vraceni') AND v.prodej_id = $1`, [info.prodejId])).rows[0].s;
  }
  return evidence.kc(Number(prime) + Number(vratkami));
}
async function nahledVraceni(client, poukaz) {
  if (poukaz.stav === 'ceka_na_platbu') return { lze: 0, duvod: 'Poukaz ještě není zaplacený.' };
  if (poukaz.stav === 'zruseny') return { lze: 0, duvod: 'Poukaz je zrušený.' };
  const info = await platbaZaPoukaz(client, poukaz);
  if (!info) return { lze: 0, duvod: 'Za poukaz není v evidenci zapsaná platba (darovaný nebo historický poukaz) – peníze přes tuto funkci vrátit nejde.' };
  const vraceno = await vracenoZaPoukaz(client, poukaz, info);
  const zaplacenyKredit = await kredit.zaplacenyZbytek(client, poukaz.id);
  const lze = Math.max(0, evidence.kc(Math.min(zaplacenyKredit, info.zaplaceno - vraceno)));
  return { lze, zaplaceno: info.zaplaceno, vraceno, zaplaceny_kredit: zaplacenyKredit, info,
    duvod: lze > 0 ? null : (zaplacenyKredit <= 0 ? 'Zaplacený kredit už je vyčerpaný.' : 'Zaplacená částka už byla vrácena.') };
}

// GET /api/poukazy/:id/vraceni – kolik peněz jde vrátit a proč
router.get('/:id/vraceni', vyzadovatAdmina, async (req, res) => {
  try {
    const poukaz = (await pool.query('SELECT * FROM darkove_poukazy WHERE id = $1', [req.params.id])).rows[0];
    if (!poukaz) return res.status(404).json({ chyba: 'Poukaz nenalezen.' });
    const { info, ...n } = await nahledVraceni(pool, poukaz);
    res.json({ ...n, zpusob_puvodni: info ? info.platba.zpusob : null, zustatek: Number(poukaz.zustatek) });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// POST /api/poukazy/:id/vraceni { klic, zpusob, castka?, zrusit? (výchozí true) } – vrácení peněz;
// se zrušením poukazu se v téže transakci zruší i zbylý (nezaplacený) kredit
router.post('/:id/vraceni', vyzadovatAdmina, async (req, res) => {
  const b = req.body || {};
  if (!b.klic) return res.status(400).json({ chyba: 'Chybí identifikátor operace – obnovte stránku administrace.' });
  const zrusit = b.zrusit !== false;
  const od = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const data = { id: req.params.id, zpusob: b.zpusob || null, castka: b.castka != null ? Number(b.castka) : null, zrusit };
    const { vysledek, opakovane } = await evidence.jednou(client, 'poukaz-vraceni', b.klic, data, async () => {
      const poukaz = (await client.query('SELECT * FROM darkove_poukazy WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!poukaz) throw new evidence.ChybaEvidence(404, 'Poukaz nenalezen.');
      if (!['hotovost', 'karta', 'qr', 'prevod'].includes(data.zpusob)) throw new evidence.ChybaEvidence(400, 'Vyberte, jak se peníze vracejí.');
      const nahled = await nahledVraceni(client, poukaz);
      if (!(nahled.lze > 0)) throw new evidence.ChybaEvidence(409, nahled.duvod || 'Není co vrátit.');
      const castka = data.castka != null ? evidence.kc(data.castka) : nahled.lze;
      if (!(castka > 0)) throw new evidence.ChybaEvidence(400, 'Neplatná částka.');
      if (castka > nahled.lze) throw new evidence.ChybaEvidence(400, `Vrátit jde nejvýš ${nahled.lze} Kč (zaplaceno ${nahled.zaplaceno} Kč, už vráceno ${nahled.vraceno} Kč, zaplaceného kreditu na poukazu ${nahled.zaplaceny_kredit} Kč).`);
      const naDalku = data.zpusob === 'prevod';
      const platebniUdaje = { typ: 'vraceni', castka, zpusob: data.zpusob, okolnosti: naDalku ? 'eshop' : 'prodejna', kontaktni: !naDalku, vraci_id: nahled.info.platba.id };
      let vratka = null, platba;
      if (nahled.info.prodejId) {
        vratka = (await client.query(`INSERT INTO vratky (prodej_id, polozky, castka, duvod, vraceno_na_sklad, zpusob_vraceni)
          VALUES ($1, '[]', $2, $3, false, $4) RETURNING *`, [nahled.info.prodejId, castka, `Vrácení peněz za poukaz ${poukaz.kod}`, data.zpusob])).rows[0];
        platba = await evidence.zapsatPlatbu(client, { ...platebniUdaje, klic: `vratka:${vratka.id}:vraceni`, prijato_at: vratka.vytvoreno, zdroj_typ: 'vratka', zdroj_id: vratka.id });
      } else {
        platba = await evidence.zapsatPlatbu(client, { ...platebniUdaje, klic: `poukaz-vraceni:${b.klic}`, zdroj_typ: 'poukaz', zdroj_id: poukaz.id });
      }
      await kredit.vyplatit(client, { poukaz, castka, klic: `poukaz-vraceni:${b.klic}:kredit`, kontaktni: nahled.info.platba.kontaktni,
        zdroj_typ: vratka ? 'vratka' : 'poukaz', zdroj_id: vratka ? vratka.id : poukaz.id });
      let novyZustatek = evidence.kc(Number(poukaz.zustatek) - castka);
      if (zrusit && novyZustatek > 0) { await kredit.zrusitZbytek(client, { poukaz, klic: `poukaz-vraceni:${b.klic}:zruseni` }); novyZustatek = 0; }
      const upraveny = (await client.query(
        `UPDATE darkove_poukazy SET zustatek = $2, stav = CASE WHEN $3::boolean OR $2::numeric <= 0 THEN 'zruseny' ELSE stav END WHERE id = $1 RETURNING *`,
        [poukaz.id, novyZustatek, zrusit])).rows[0];
      if (upraveny.stav === 'zruseny') await client.query('INSERT INTO poukazy_zmeny (poukaz_id, popis) VALUES ($1, $2)', [poukaz.id, `Vráceno ${castka} Kč (${data.zpusob}), poukaz zrušen`]).catch(() => {});
      // EET: vrácení peněz za evidovaný poukaz u pultu = záporná tržba (storno nabití)
      await eetUdalosti.zaznamenat(client, { zdroj_typ: vratka ? 'vratka' : 'poukaz', zdroj_id: vratka ? vratka.id : poukaz.id, klic: 'vraceni-' + b.klic });
      return { poukaz: upraveny, vraceno: castka, platba, vratka };
    });
    await client.query('COMMIT');
    const eet = await eetFronta.stavPoUlozeni(pool, vysledek.vratka ? [['vratka', vysledek.vratka.id]] : [['poukaz', vysledek.poukaz.id]], { od });
    res.json({ ...vysledek, ...(opakovane ? { opakovane: true } : {}), ...(eet ? { eet } : {}) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof evidence.ChybaEvidence) return res.status(err.status).json({ chyba: err.chyba });
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// POST /api/poukazy/:id/pripsat – vrátit částku zpět na poukaz (odstoupení od smlouvy,
// vrácení zboží zaplaceného poukazem). Zapíše se jako záporné uplatnění, ať v reportu
// sedí "uplatněno". Víc, než je hodnota poukazu, připsat nejde (vrací se jen utracené).
router.post('/:id/pripsat', vyzadovatAdmina, async (req, res) => {
  const castka = Number(req.body && req.body.castka);
  if (!Number.isInteger(castka) || castka <= 0) return res.status(400).json({ chyba: 'Zadejte kladnou částku v celých korunách.' });
  const vratkaId = req.body && req.body.vratka_id && Number.isInteger(Number(req.body.vratka_id)) ? Number(req.body.vratka_id) : null;
  const od = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // opakované připsání se stejným klíčem nic nezdvojí
    const { vysledek, opakovane } = await evidence.jednou(client, 'poukaz-pripsani', req.body && req.body.klic, { id: req.params.id, castka, vratkaId },
      async () => pripsat(client, req.params.id, castka, vratkaId));
    await client.query('COMMIT');
    const eet = await eetFronta.stavPoUlozeni(pool, [vratkaId ? ['vratka', vratkaId] : ['poukaz', Number(req.params.id)]], { od });
    res.json({ ...vysledek, ...(opakovane ? { opakovane: true } : {}), ...(eet ? { eet } : {}) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof evidence.ChybaEvidence) return res.status(err.status).json({ chyba: err.chyba });
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

async function pripsat(client, id, castka, vratkaId) {
    const nalezeny = await client.query('SELECT * FROM darkove_poukazy WHERE id=$1 FOR UPDATE', [id]);
    if (!nalezeny.rows.length) throw new evidence.ChybaEvidence(404, 'Poukaz nenalezen.');
    const poukaz = nalezeny.rows[0];
    if (poukaz.stav === 'zruseny') throw new evidence.ChybaEvidence(400, 'Poukaz je zrušený.');
    if (poukaz.stav === 'ceka_na_platbu') throw new evidence.ChybaEvidence(409, 'Poukaz čeká na platbu – připsat na něj nejde.');
    if (vratkaId) {
      // Na vratku nejde připsat víc, než bylo z poukazu na její účtenku čerpáno
      // (minus dřívější připsání k vratkám téže účtenky). Účtenky bez evidence se nehlídají.
      const r = (await client.query(`
        SELECT r.prodej_id,
          (SELECT COALESCE(SUM(CASE k.typ WHEN 'cerpani' THEN k.castka ELSE -k.castka END), 0) FROM kredit_pohyby k
            WHERE k.poukaz_id = $2 AND k.zdroj_typ = 'prodej' AND k.zdroj_id = r.prodej_id AND k.typ IN ('cerpani', 'storno_cerpani')) AS cerpano,
          (SELECT COUNT(*) FROM kredit_pohyby k WHERE k.poukaz_id = $2 AND k.zdroj_typ = 'prodej' AND k.zdroj_id = r.prodej_id AND k.typ = 'cerpani') AS s_evidenci,
          (SELECT COALESCE(SUM(k.castka), 0) FROM kredit_pohyby k JOIN vratky r2 ON r2.id = k.zdroj_id
            WHERE k.typ = 'pripsani' AND k.zdroj_typ = 'vratka' AND k.poukaz_id = $2 AND r2.prodej_id = r.prodej_id) AS pripsano
        FROM vratky r WHERE r.id = $1`, [vratkaId, poukaz.id])).rows[0];
      if (!r) throw new evidence.ChybaEvidence(404, 'Vratka nenalezena.');
      if (Number(r.s_evidenci) > 0) {
        const lze = evidence.kc(Number(r.cerpano) - Number(r.pripsano));
        if (castka > lze) throw new evidence.ChybaEvidence(400, `K této vratce jde na poukaz připsat nejvýš ${lze} Kč (tolik se z něj na účtenku čerpalo).`);
      }
    }
    const novyZustatek = Number(poukaz.zustatek) + castka;
    if (novyZustatek > Number(poukaz.hodnota)) {
      throw new evidence.ChybaEvidence(400, `Připsat jde nejvýš ${Number(poukaz.hodnota) - Number(poukaz.zustatek)} Kč (zůstatek nesmí přesáhnout hodnotu poukazu).`);
    }
    const upraveny = (await client.query(
      "UPDATE darkove_poukazy SET zustatek=$1, stav='aktivni' WHERE id=$2 RETURNING *", [novyZustatek, poukaz.id]
    )).rows[0];
    const pouziti = (await client.query('INSERT INTO poukazy_pouziti (poukaz_id, castka) VALUES ($1,$2) RETURNING id', [poukaz.id, -castka])).rows[0];
    // Kredit vrácený na poukaz = nový vklad 'vraceny' (základ pro EET z vraceného čerpání)
    await kredit.pripsat(client, { poukaz, castka, klic: `pouziti:${pouziti.id}:pripsani`, vratkaId });
    // EET: vrácení zboží na poukaz = storno čerpání (záporné cerp_zuct), nevyřešený základ k rozhodnutí
    await eetUdalosti.zaznamenat(client, { zdroj_typ: vratkaId ? 'vratka' : 'poukaz', zdroj_id: vratkaId || poukaz.id, klic: 'pripsani-' + pouziti.id });
    return upraveny;
}

// PATCH /api/poukazy/:id/dar – dodatečně označit už vydaný poukaz jako dar. EAN zůstává
// (poukaz už může být vytištěný). Pokud k němu vznikl záznam prodeje, smaže se, ať
// se do tržeb nepočítá ani vydání; útrata se pak vyřadí přes druh 'dar' (pouziti/vse).
// POST /api/poukazy/:id/prodlouzit { platnost_do: 'RRRR-MM-DD' } – správce
// prodlouží platnost (i propadlého poukazu se zůstatkem). Zapíše se do
// poukazy_zmeny a u plastové karty i do její historie.
router.post('/:id/prodlouzit', vyzadovatAdmina, async (req, res) => {
  const novyDen = String((req.body && req.body.platnost_do) || '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const poukaz = (await client.query('SELECT * FROM darkove_poukazy WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    const chyba = chybaProdlouzeni(poukaz, novyDen);
    if (chyba) { await client.query('ROLLBACK'); return res.status(poukaz ? 400 : 404).json({ chyba }); }
    const dosud = datumPlatnosti(poukaz.platnost_do);
    const cesky = d => { const [r, m, dd] = d.split('-'); return `${Number(dd)}. ${Number(m)}. ${r}`; };
    const popis = `Platnost prodloužena z ${cesky(dosud)} na ${cesky(novyDen)}`;
    const upraveny = (await client.query('UPDATE darkove_poukazy SET platnost_do = $1 WHERE id = $2 RETURNING *', [novyDen, poukaz.id])).rows[0];
    await client.query('INSERT INTO poukazy_zmeny (poukaz_id, popis) VALUES ($1, $2)', [poukaz.id, popis]);
    if (poukaz.karta_id) {
      await client.query("INSERT INTO poukazove_karty_udalosti (karta_id, akce, poukaz_id, poznamka) VALUES ($1, 'prodlouzeni', $2, $3)",
        [poukaz.karta_id, poukaz.id, `z ${cesky(dosud)} na ${cesky(novyDen)}`]);
    }
    await client.query('COMMIT');
    res.json({ ...upraveny, zmena: popis });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

router.patch('/:id/dar', vyzadovatAdmina, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nalezeny = await client.query('SELECT * FROM darkove_poukazy WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!nalezeny.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Poukaz nenalezen.' }); }
    const prodejId = nalezeny.rows[0].vydano_prodej_id;
    const byl = nalezeny.rows[0];
    if (prodejId && byl.druh !== 'dar') {
      const prodej = (await client.query('SELECT vytvoreno FROM prodejna_prodeje WHERE id = $1', [prodejId])).rows[0];
      if ((prodej && eetZamek.jeZamceny(prodej.vytvoreno)) || await evidence.maUdalostEet(client, 'prodej', prodejId)) { await client.query('ROLLBACK'); return res.status(409).json({ chyba: eetZamek.CHYBA_ZAMKU }); }
    }
    // Platba za poukaz zapsaná přes e-shop (platba nebo přiřazení) - dar by ji nechal bez dokladu
    if (await evidence.maUdalostEet(client, 'poukaz', byl.id)) { await client.query('ROLLBACK'); return res.status(409).json({ chyba: eetZamek.CHYBA_ZAMKU }); }
    const eshopPlatba = (await client.query(`SELECT 1 FROM platby WHERE zdroj_typ = 'poukaz' AND zdroj_id = $1 AND typ = 'prijem'
      UNION ALL SELECT 1 FROM platby_prirazeni WHERE poukaz_id = $1 LIMIT 1`, [byl.id])).rows.length;
    if (eshopPlatba && byl.druh !== 'dar') { await client.query('ROLLBACK'); return res.status(409).json({ chyba: 'Za poukaz je zapsaná platba – na dar ho nejde přeznačit.' }); }
    const poukaz = (await client.query(
      "UPDATE darkove_poukazy SET druh='dar', vydano_prodej_id=NULL, platba_stav='dar', stav = CASE WHEN stav = 'ceka_na_platbu' THEN 'aktivni' ELSE stav END WHERE id=$1 RETURNING *", [req.params.id]
    )).rows[0];
    if (byl.druh !== 'dar') await opravitEvidenciNaDar(client, byl, prodejId, poukaz);
    if (prodejId) await client.query('DELETE FROM prodejna_prodeje WHERE id=$1', [prodejId]);
    await client.query('COMMIT');
    res.json({ ...poukaz, smazany_prodej_id: prodejId || null });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof evidence.ChybaEvidence) return res.status(err.status).json({ chyba: err.chyba });
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// Poukaz dodatečně označený jako dar: původní příjem i zaplacený kredit dostanou
// storno (zůstanou v evidenci), kredit se znovu zapíše jako darovaný.
async function opravitEvidenciNaDar(client, byl, prodejId, novy) {
  const klic = `dar:${byl.id}`;
  const poznamka = 'Poukaz dodatečně označený jako dar';
  if (prodejId) await evidence.stornovatPrijmy(client, { zdroj_typ: 'prodej', zdroj_id: prodejId, klicPrefix: klic, poznamka });
  // zaplacený vklad jde stornovat jen nečerpaný (jinak 409) - pak vznikne darovaný
  const storna = await kredit.stornovatDoklad(client, { zdroj_typ: 'poukaz', zdroj_id: byl.id, typy: ['nabiti'], klicPrefix: klic, poznamka });
  for (const st of storna) {
    await kredit.nabit(client, { poukaz: novy, castka: st.castka, puvod: 'darovany', platba: null, klic: `${klic}:nabiti:${st.opravuje_id}`, poznamka });
  }
  // čekající poukaz (bez vkladu) se stane aktivním darem
  if (byl.stav === 'ceka_na_platbu') {
    await kredit.nabit(client, { poukaz: novy, castka: byl.hodnota, puvod: 'darovany', platba: null, klic: `${klic}:nabiti-ceka`, poznamka });
  }
}

// DELETE /api/poukazy/:id – zrušit poukaz (zůstává v evidenci pro účetnictví, jen se znepřístupní)
router.delete('/:id', vyzadovatAdmina, async (req, res) => {
  const client = await pool.connect();
  try {
    const poukaz = await client.query('SELECT * FROM darkove_poukazy WHERE id=$1', [req.params.id]);
    if (poukaz.rows.length === 0) return res.status(404).json({ chyba: 'Poukaz nenalezen.' }); // spojení uvolní finally

    const nikdyNepouzity = Number(poukaz.rows[0].zustatek) === Number(poukaz.rows[0].hodnota);
    if (poukaz.rows[0].vydano_prodej_id) {
      const prodej = (await client.query('SELECT vytvoreno FROM prodejna_prodeje WHERE id = $1', [poukaz.rows[0].vydano_prodej_id])).rows[0];
      if ((prodej && eetZamek.jeZamceny(prodej.vytvoreno)) || await evidence.maUdalostEet(client, 'prodej', poukaz.rows[0].vydano_prodej_id)) return res.status(409).json({ chyba: eetZamek.CHYBA_ZAMKU });
    }
    if (await evidence.maUdalostEet(client, 'poukaz', poukaz.rows[0].id)) return res.status(409).json({ chyba: eetZamek.CHYBA_ZAMKU });
    // Zaplacený poukaz z e-shopu (platba / přiřazení) se nemaže - jen zruší, ať platba nezůstane bez dokladu
    const eshopPlatba = (await client.query(`SELECT 1 FROM platby WHERE zdroj_typ = 'poukaz' AND zdroj_id = $1 AND typ = 'prijem'
      UNION ALL SELECT 1 FROM platby_prirazeni WHERE poukaz_id = $1 LIMIT 1`, [poukaz.rows[0].id])).rows.length;
    if (nikdyNepouzity && !eshopPlatba) {
      // Nikdy nepoužitý poukaz jde bezpečně smazat celý. Pokud za něj byly zaevidované
      // peníze (vydano_prodej_id), smažeme i ten záznam prodeje – jinak by v Prodejně/
      // tržbách zůstala "duchová" platba bez poukazu, na který se váže.
      await client.query('BEGIN');
      // Doklady se mažou jako dřív (součty beze změny), evidence si nechá původní
      // příjem a nabití a dostane k nim storno
      const zrus = { klicPrefix: `zruseni-poukazu:${req.params.id}`, poznamka: 'Zrušení nepoužitého poukazu' };
      if (poukaz.rows[0].vydano_prodej_id) await evidence.stornovatPrijmy(client, { zdroj_typ: 'prodej', zdroj_id: poukaz.rows[0].vydano_prodej_id, ...zrus });
      await kredit.stornovatDoklad(client, { zdroj_typ: 'poukaz', zdroj_id: Number(req.params.id), typy: ['nabiti'], ...zrus });
      await client.query('DELETE FROM darkove_poukazy WHERE id=$1', [req.params.id]);
      if (poukaz.rows[0].vydano_prodej_id) {
        await client.query('DELETE FROM prodejna_prodeje WHERE id=$1', [poukaz.rows[0].vydano_prodej_id]);
      }
      await client.query('COMMIT');
      return res.json({ ok: true, smazano: true });
    }
    // Už částečně/plně použitý poukaz jen zrušíme, ať zůstane účetní stopa
    // (i s případným vydano_prodej_id – peníze při prodeji poukazu skutečně přišly,
    // takže záznam prodeje musí zůstat).
    await client.query("UPDATE darkove_poukazy SET stav='zruseny' WHERE id=$1", [req.params.id]);
    res.json({ ok: true, smazano: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════
// ADMIN – žádosti o koupi poukazu z e-shopu
// ═══════════════════════════════

router.get('/zadosti/vse', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM poukazy_zadosti ORDER BY vytvoreno DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.patch('/zadosti/:id/stav', vyzadovatAdmina, async (req, res) => {
  const { stav } = req.body;
  if (!['nova','vyrizena','zamitnuta'].includes(stav)) return res.status(400).json({ chyba: 'Neplatný stav.' });
  try {
    const result = await pool.query('UPDATE poukazy_zadosti SET stav=$1 WHERE id=$2 RETURNING *', [stav, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// GET /api/poukazy/pouziti/vse – historie uplatnění poukazů (pro účetnictví)
// zapocitano_pri_vydani = true znamená, že peníze za tento poukaz už byly připsané do tržeb
// v okamžiku jeho prodeje (má vydano_prodej_id) – takže tahle jeho útrata se do tržeb podruhé
// nepočítá. U starších poukazů (vydaných před touto funkcí) je false a útrata se do tržeb počítá
// tady, jako dřív. Darovaný poukaz (druh 'dar') se do tržeb nepočítá vůbec - jeho útrata
// se proto vyřadí stejně jako u poukazu započteného při prodeji (darem = true).
// Prodej s doplatkem (prodejna_prodeje.poukaz_castka) se nevyřazuje nikdy - jeho celkem
// je jen doplatek, který zákazník skutečně zaplatil.
router.get('/pouziti/vse', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pp.*, ((dp.vydano_prodej_id IS NOT NULL OR dp.druh = 'dar') AND COALESCE(pr.poukaz_castka, 0) = 0) AS zapocitano_pri_vydani, (dp.druh = 'dar') AS darem
      FROM poukazy_pouziti pp
      JOIN darkove_poukazy dp ON dp.id = pp.poukaz_id
      LEFT JOIN prodejna_prodeje pr ON pr.id = pp.prodej_id
      ORDER BY pp.vytvoreno DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
