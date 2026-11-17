// Jednotná evidence plateb (krok 2 přípravy na EET, návrh docs/navrh-krok2-evidence-plateb.md).
//
// Tři vrstvy:
//   obchodní doklad  – prodejna_prodeje, objednavky, vratky, darkove_poukazy (beze změny)
//   platba           – `platby`: jen SKUTEČNÉ peníze (příjem, vrácení, storno)
//   kredit poukazu   – `kredit_pohyby`: nabití, čerpání, připsání (s původem kreditu)
//   (událost EET     – až v kroku 3; tady se jen ukládá pravidlo `eet_pravidlo`)
//
// Zásady:
//   - zápis vždy ve STEJNÉ transakci jako související operace (volající má BEGIN)
//   - každý řádek má unikátní `klic` - opakovaný zápis téže operace nic nezdvojí
//   - řádky jsou neměnné (trigger zakáže UPDATE i DELETE); oprava = nový řádek
//     typu storno_* s `opravuje_id`
//   - historie se automaticky nedoplňuje; řádky vznikají jen z nových operací
//   - účetní součty (uzávěrky, Účetnictví, reporty) dál čtou jen obchodní doklady,
//     tyto tabulky se do nich nepřičítají (nemůže dojít k dvojímu započtení)

const crypto = require('node:crypto');

const ZPUSOBY = ['hotovost', 'karta', 'qr', 'prevod', 'dobirka'];
const OKOLNOSTI = ['prodejna', 'osobni_odber', 'eshop', 'dopravce'];
const PUVODY_KREDITU = ['zaplaceny', 'darovany', 'vraceny', 'prevedeny'];

const kc = n => Math.round(Number(n) * 100) / 100;

class ChybaEvidence extends Error {
  constructor(status, chyba, data) { super(chyba); this.status = status; this.chyba = chyba; this.data = data || {}; }
}

async function migrovat(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS platby (
      id SERIAL PRIMARY KEY,
      klic TEXT NOT NULL UNIQUE,
      typ TEXT NOT NULL CHECK (typ IN ('prijem', 'vraceni', 'storno_prijmu', 'storno_vraceni')),
      castka NUMERIC(12,2) NOT NULL CHECK (castka > 0),
      mena CHAR(3) NOT NULL DEFAULT 'CZK',
      zpusob TEXT NOT NULL CHECK (zpusob IN ('hotovost', 'karta', 'qr', 'prevod', 'dobirka')),
      okolnosti TEXT NOT NULL CHECK (okolnosti IN ('prodejna', 'osobni_odber', 'eshop', 'dopravce')),
      kontaktni BOOLEAN NOT NULL,
      prijato_at TIMESTAMPTZ NOT NULL,
      zdroj_typ TEXT NOT NULL CHECK (zdroj_typ IN ('prodej', 'objednavka', 'vratka', 'poukaz', 'volna')),
      zdroj_id INTEGER,
      urceno_k_cerpani NUMERIC(12,2) CHECK (urceno_k_cerpani IS NULL OR (urceno_k_cerpani > 0 AND urceno_k_cerpani <= castka)),
      vraci_id INTEGER REFERENCES platby(id),
      opravuje_id INTEGER REFERENCES platby(id),
      puvod TEXT NOT NULL DEFAULT 'provoz' CHECK (puvod = 'provoz'),
      poznamka TEXT,
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((typ IN ('storno_prijmu', 'storno_vraceni')) = (opravuje_id IS NOT NULL)),
      CHECK (vraci_id IS NULL OR typ = 'vraceni')
    );
    CREATE INDEX IF NOT EXISTS platby_zdroj_idx ON platby (zdroj_typ, zdroj_id);
    CREATE UNIQUE INDEX IF NOT EXISTS platby_opravuje_uq ON platby (opravuje_id) WHERE opravuje_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS platby_prijato_idx ON platby (prijato_at);

    -- Přiřazení existující (volné) platby k objednávce, např. převod, který přišel dřív
    CREATE TABLE IF NOT EXISTS platby_prirazeni (
      id SERIAL PRIMARY KEY,
      klic TEXT NOT NULL UNIQUE,
      platba_id INTEGER NOT NULL REFERENCES platby(id),
      objednavka_id INTEGER,
      poukaz_id INTEGER,
      castka NUMERIC(12,2) NOT NULL CHECK (castka > 0),
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((objednavka_id IS NULL) <> (poukaz_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS platby_prirazeni_obj_idx ON platby_prirazeni (objednavka_id);
    CREATE UNIQUE INDEX IF NOT EXISTS platby_prirazeni_poukaz_uq ON platby_prirazeni (poukaz_id) WHERE poukaz_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS kredit_pohyby (
      id SERIAL PRIMARY KEY,
      klic TEXT NOT NULL UNIQUE,
      poukaz_id INTEGER NOT NULL,
      typ TEXT NOT NULL CHECK (typ IN ('nabiti', 'pocatecni_stav', 'cerpani', 'pripsani', 'storno_nabiti', 'storno_cerpani', 'storno_pripsani')),
      castka NUMERIC(12,2) NOT NULL CHECK (castka > 0),
      puvod TEXT NOT NULL CHECK (puvod IN ('zaplaceny', 'darovany', 'vraceny', 'prevedeny', 'smiseny')),
      kontaktni BOOLEAN,
      platba_id INTEGER REFERENCES platby(id),
      zdroj_typ TEXT NOT NULL CHECK (zdroj_typ IN ('prodej', 'objednavka', 'vratka', 'poukaz')),
      zdroj_id INTEGER,
      opravuje_id INTEGER REFERENCES kredit_pohyby(id),
      eet_pravidlo TEXT NOT NULL CHECK (eet_pravidlo IN ('urceno_cerp_zuct', 'cerp_zuct', 'neeviduje', 'nevyreseno')),
      poznamka TEXT,
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((typ LIKE 'storno_%') = (opravuje_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS kredit_pohyby_poukaz_idx ON kredit_pohyby (poukaz_id);
    CREATE UNIQUE INDEX IF NOT EXISTS kredit_pohyby_opravuje_uq ON kredit_pohyby (opravuje_id) WHERE opravuje_id IS NOT NULL;

    -- Vklady kreditu: každé nabití / připsání / počáteční stav je samostatný vklad
    -- se svým původem. Zůstatek vkladu = částka − odběry + vrácení (kredit_casti).
    CREATE TABLE IF NOT EXISTS kredit_vklady (
      id SERIAL PRIMARY KEY,
      klic TEXT NOT NULL UNIQUE,
      poukaz_id INTEGER NOT NULL,
      puvod TEXT NOT NULL CHECK (puvod IN ('zaplaceny', 'darovany', 'vraceny', 'prevedeny')),
      castka NUMERIC(12,2) NOT NULL CHECK (castka > 0),
      -- z čeho vklad pochází, když je vrácený / převedený (pro pravidlo EET)
      eet_zaklad TEXT NOT NULL CHECK (eet_zaklad IN ('zaplaceny', 'darovany', 'neurceny')),
      -- doklad = platba v evidenci; pocatecni_stav = zůstatek poukazu z doby před evidencí
      overeni TEXT NOT NULL CHECK (overeni IN ('doklad', 'pocatecni_stav', 'bez_dokladu')),
      kredit_pohyb_id INTEGER NOT NULL REFERENCES kredit_pohyby(id),
      prevedeno_z_id INTEGER REFERENCES kredit_vklady(id),
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS kredit_vklady_poukaz_idx ON kredit_vklady (poukaz_id);
    -- Rozdělení pohybu na vklady: čerpání = odběr z vkladů (v pevném pořadí),
    -- storno čerpání = vrácení PŘESNĚ stejných částí, storno nabití = odběr celého vkladu
    CREATE TABLE IF NOT EXISTS kredit_casti (
      id SERIAL PRIMARY KEY,
      kredit_pohyb_id INTEGER NOT NULL REFERENCES kredit_pohyby(id),
      vklad_id INTEGER NOT NULL REFERENCES kredit_vklady(id),
      smer TEXT NOT NULL CHECK (smer IN ('odber', 'vraceni')),
      castka NUMERIC(12,2) NOT NULL CHECK (castka > 0),
      eet_pravidlo TEXT NOT NULL CHECK (eet_pravidlo IN ('cerp_zuct', 'neeviduje', 'nevyreseno')),
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (kredit_pohyb_id, vklad_id)
    );
    CREATE INDEX IF NOT EXISTS kredit_casti_vklad_idx ON kredit_casti (vklad_id);
    CREATE INDEX IF NOT EXISTS kredit_pohyby_zdroj_idx ON kredit_pohyby (zdroj_typ, zdroj_id);

    -- Dobírka: úhrada zákazníka dopravci = pohledávka za dopravcem (ne peníze
    -- v pokladně); vyúčtování od dopravce = brutto − poplatek = čistá výplata.
    CREATE TABLE IF NOT EXISTS dobirky_vyuctovani (
      id SERIAL PRIMARY KEY,
      klic TEXT NOT NULL UNIQUE,
      dopravce TEXT NOT NULL,
      vyplaceno_at TIMESTAMPTZ NOT NULL,
      brutto NUMERIC(12,2) NOT NULL CHECK (brutto > 0),
      poplatek NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (poplatek >= 0),
      netto NUMERIC(12,2) NOT NULL CHECK (netto >= 0),
      poznamka TEXT,
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (netto = brutto - poplatek)
    );
    CREATE TABLE IF NOT EXISTS dobirky (
      id SERIAL PRIMARY KEY,
      klic TEXT NOT NULL UNIQUE,
      objednavka_id INTEGER NOT NULL UNIQUE,
      platba_id INTEGER NOT NULL REFERENCES platby(id),
      castka NUMERIC(12,2) NOT NULL CHECK (castka > 0),
      dopravce TEXT,
      vyuctovani_id INTEGER REFERENCES dobirky_vyuctovani(id),
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Ochrana proti opakování u operací bez vlastního klíče v dokladu
    CREATE TABLE IF NOT EXISTS operace_klice (
      oblast TEXT NOT NULL,
      klic TEXT NOT NULL,
      otisk TEXT NOT NULL,
      vysledek JSONB NOT NULL,
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (oblast, klic)
    );

    CREATE OR REPLACE FUNCTION evidence_plateb_nemenna() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Záznam v % je neměnný – opravte ho navázaným záznamem (storno).', TG_TABLE_NAME;
    END $$ LANGUAGE plpgsql;
  `);
  for (const tabulka of ['platby', 'platby_prirazeni', 'kredit_pohyby', 'dobirky_vyuctovani', 'kredit_vklady', 'kredit_casti']) {
    await db.query(`DROP TRIGGER IF EXISTS ${tabulka}_nemenna ON ${tabulka};
      CREATE TRIGGER ${tabulka}_nemenna BEFORE UPDATE OR DELETE ON ${tabulka} FOR EACH ROW EXECUTE FUNCTION evidence_plateb_nemenna();`);
  }
  // dobírka: jediná povolená změna je doplnění vazby na vyúčtování (jednou)
  await db.query(`
    CREATE OR REPLACE FUNCTION dobirky_jen_vyuctovani() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Záznam dobírky je neměnný.'; END IF;
      IF OLD.vyuctovani_id IS NOT NULL OR NEW.vyuctovani_id IS NULL
         OR (to_jsonb(NEW) - 'vyuctovani_id') <> (to_jsonb(OLD) - 'vyuctovani_id') THEN
        RAISE EXCEPTION 'U dobírky jde jen jednou doplnit vyúčtování.';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS dobirky_nemenna ON dobirky;
    CREATE TRIGGER dobirky_nemenna BEFORE UPDATE OR DELETE ON dobirky FOR EACH ROW EXECUTE FUNCTION dobirky_jen_vyuctovani();
  `);
}

// ─── Pravidla ───

// Původ kreditu poukazu: prodaný = zaplacený, darovaný = darovaný
const puvodPoukazu = poukaz => (poukaz && poukaz.druh === 'dar' ? 'darovany' : 'zaplaceny');

// Pravidlo pro budoucí datovou zprávu EET (popis položek datové zprávy, kap. 13–14).
// Darovaný kredit je VÝSLOVNĚ nevyřešený, dokud se nedoloží metodika - nesmí
// se automaticky počítat jako zaplacený.
function pravidloEet({ typ, puvod, kontaktni, zaplaceno }) {
  const zaklad = typ.replace(/^storno_/, '');
  if (zaklad === 'nabiti') {
    if (puvod === 'darovany') return 'neeviduje';           // nic se neplatilo
    if (!zaplaceno || kontaktni == null) return 'nevyreseno'; // platba nezapsaná
    return kontaktni ? 'urceno_cerp_zuct' : 'neeviduje';
  }
  // čerpání / připsání (= storno čerpání při vrácení zboží na poukaz)
  if (kontaktni === false) return 'neeviduje';
  if (kontaktni == null) return 'nevyreseno';
  return puvod === 'zaplaceny' ? 'cerp_zuct' : 'nevyreseno';
}

// ─── Zápisy (volat v transakci) ───

// Druhé storno téhož záznamu zastaví unikátní index (platby_opravuje_uq,
// kredit_pohyby_opravuje_uq) - souběžná i opakovaná oprava nevrátí nic dvakrát
async function dvojiStorno(fn) {
  try { return await fn(); } catch (e) {
    if (e && e.code === '23505' && /opravuje_uq/.test(e.constraint || e.message)) throw new ChybaEvidence(409, 'Tento záznam už byl opraven (stornován) jinou operací.');
    throw e;
  }
}

function overitPlatbu(p) {
  if (!['prijem', 'vraceni', 'storno_prijmu', 'storno_vraceni'].includes(p.typ)) throw new Error('Neplatný typ platby: ' + p.typ);
  if (!ZPUSOBY.includes(p.zpusob)) throw new Error('Neplatný způsob platby: ' + p.zpusob);
  if (!OKOLNOSTI.includes(p.okolnosti)) throw new Error('Neplatné okolnosti platby: ' + p.okolnosti);
  if (!(kc(p.castka) > 0)) throw new Error('Částka platby musí být kladná.');
  if (typeof p.kontaktni !== 'boolean') throw new Error('U platby chybí, zda šlo o osobní kontakt.');
}

// Zapíše platbu; stejný `klic` = vrátí už zapsanou (nic nezdvojí)
async function zapsatPlatbu(client, p) {
  overitPlatbu(p);
  const r = await dvojiStorno(() => client.query(
    `INSERT INTO platby (klic, typ, castka, zpusob, okolnosti, kontaktni, prijato_at, zdroj_typ, zdroj_id, urceno_k_cerpani, vraci_id, opravuje_id, poznamka)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, NOW()),$8,$9,$10,$11,$12,$13)
     ON CONFLICT (klic) DO NOTHING RETURNING *`,
    [p.klic, p.typ, kc(p.castka), p.zpusob, p.okolnosti, p.kontaktni, p.prijato_at || null, p.zdroj_typ, p.zdroj_id ?? null,
     p.urceno_k_cerpani ? kc(p.urceno_k_cerpani) : null, p.vraci_id || null, p.opravuje_id || null, p.poznamka || null]
  ));
  return r.rows[0] || (await client.query('SELECT * FROM platby WHERE klic = $1', [p.klic])).rows[0];
}

async function zapsatKredit(client, k) {
  const smisenyPovolen = k.puvod === 'smiseny' && ['cerpani', 'storno_cerpani'].includes(k.typ); // čerpání z více vkladů
  if (!PUVODY_KREDITU.includes(k.puvod) && !smisenyPovolen) throw new Error('Neplatný původ kreditu: ' + k.puvod);
  if (!(kc(k.castka) > 0)) throw new Error('Částka kreditu musí být kladná.');
  const eet = k.eet_pravidlo || pravidloEet({ typ: k.typ, puvod: k.puvod_zakladni || k.puvod, kontaktni: k.kontaktni, zaplaceno: !!k.platba_id });
  const r = await dvojiStorno(() => client.query(
    `INSERT INTO kredit_pohyby (klic, poukaz_id, typ, castka, puvod, kontaktni, platba_id, zdroj_typ, zdroj_id, opravuje_id, eet_pravidlo, poznamka)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (klic) DO NOTHING RETURNING *`,
    [k.klic, k.poukaz_id, k.typ, kc(k.castka), k.puvod, k.kontaktni ?? null, k.platba_id || null, k.zdroj_typ, k.zdroj_id ?? null,
     k.opravuje_id || null, eet, k.poznamka || null]
  ));
  return r.rows[0] || (await client.query('SELECT * FROM kredit_pohyby WHERE klic = $1', [k.klic])).rows[0];
}

// Storno všech dosud nestornovaných příjmů dokladu (např. smazaný prodej,
// poukaz označený jako dar). Peníze se tím nevracejí - na to je `vraceni`.
async function stornovatPrijmy(client, { zdroj_typ, zdroj_id, klicPrefix, poznamka }) {
  const prijmy = (await client.query(
    `SELECT p.* FROM platby p WHERE p.zdroj_typ = $1 AND p.zdroj_id = $2 AND p.typ = 'prijem'
       AND NOT EXISTS (SELECT 1 FROM platby s WHERE s.opravuje_id = p.id) ORDER BY p.id`, [zdroj_typ, zdroj_id])).rows;
  const storna = [];
  for (const p of prijmy) {
    storna.push(await zapsatPlatbu(client, { klic: `${klicPrefix}:storno:${p.id}`, typ: 'storno_prijmu', castka: p.castka, zpusob: p.zpusob,
      okolnosti: p.okolnosti, kontaktni: p.kontaktni, zdroj_typ, zdroj_id, opravuje_id: p.id, poznamka }));
  }
  return storna;
}

async function stornovatKredit(client, { zdroj_typ, zdroj_id, typy, klicPrefix, poznamka }) {
  const pohyby = (await client.query(
    `SELECT k.* FROM kredit_pohyby k WHERE k.zdroj_typ = $1 AND k.zdroj_id = $2 AND k.typ = ANY($3::text[])
       AND NOT EXISTS (SELECT 1 FROM kredit_pohyby s WHERE s.opravuje_id = k.id) ORDER BY k.id`, [zdroj_typ, zdroj_id, typy])).rows;
  const storna = [];
  for (const k of pohyby) {
    storna.push(await zapsatKredit(client, { klic: `${klicPrefix}:storno:${k.id}`, poukaz_id: k.poukaz_id, typ: 'storno_' + k.typ,
      castka: k.castka, puvod: k.puvod, kontaktni: k.kontaktni, zdroj_typ, zdroj_id, opravuje_id: k.id, eet_pravidlo: k.eet_pravidlo, poznamka }));
  }
  return storna;
}

// Kolik peněz je na objednávce opravdu přijato (vlastní platby + přiřazené)
async function prijatoNaObjednavku(db, objednavkaId) {
  const r = (await db.query(`
    SELECT COALESCE(SUM(CASE typ WHEN 'prijem' THEN castka WHEN 'storno_vraceni' THEN castka ELSE -castka END), 0) AS vlastni
      FROM platby WHERE zdroj_typ = 'objednavka' AND zdroj_id = $1`, [objednavkaId])).rows[0];
  const prirazeno = (await db.query('SELECT COALESCE(SUM(castka), 0) AS s FROM platby_prirazeni WHERE objednavka_id = $1', [objednavkaId])).rows[0];
  const prijato = kc(Number(r.vlastni) + Number(prirazeno.s));
  // Peníze vrácené vratkou k objednávce se odečtou (jinak by šly vrátit podruhé);
  // objednávka bez přijaté platby v evidenci zůstává na nule (mimo rozsah evidence)
  if (prijato <= 0) return Math.max(0, prijato);
  return Math.max(0, kc(prijato - await vracenoVratkamiObjednavky(db, objednavkaId)));
}

// Peníze vrácené vratkami navázanými na objednávku (vrácení − storna)
async function vracenoVratkamiObjednavky(db, objednavkaId) {
  const r = (await db.query(`SELECT COALESCE(SUM(CASE p.typ WHEN 'vraceni' THEN p.castka ELSE -p.castka END), 0) AS s
    FROM platby p JOIN vratky v ON v.id = p.zdroj_id
    WHERE p.zdroj_typ = 'vratka' AND p.typ IN ('vraceni', 'storno_vraceni') AND v.objednavka_id = $1`, [objednavkaId])).rows[0];
  return kc(r.s);
}

// Volná část platby (zdroj 'volna'), kterou jde ještě přiřadit
async function volnaCastPlatby(db, platbaId) {
  const p = (await db.query('SELECT * FROM platby WHERE id = $1', [platbaId])).rows[0];
  if (!p) return { platba: null, volno: 0 };
  const stornovano = (await db.query("SELECT COALESCE(SUM(castka),0) s FROM platby WHERE opravuje_id = $1 AND typ = 'storno_prijmu'", [platbaId])).rows[0].s;
  const prirazeno = (await db.query('SELECT COALESCE(SUM(castka),0) s FROM platby_prirazeni WHERE platba_id = $1', [platbaId])).rows[0].s;
  return { platba: p, volno: kc(Number(p.castka) - Number(stornovano) - Number(prirazeno)) };
}

// ─── Ochrana proti opakování operací ───

const otisk = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

// Spustí operaci jen jednou pro (oblast, klic). Opakování se stejným obsahem
// vrátí původní výsledek, jiný obsah se stejným klíčem = 409. Volat v transakci.
async function jednou(client, oblast, klic, data, fn) {
  if (!klic) return { vysledek: await fn(), opakovane: false };
  if (!/^[A-Za-z0-9_:-]{8,120}$/.test(String(klic))) throw new ChybaEvidence(400, 'Neplatný identifikátor operace.');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [oblast + ':' + klic]);
  const o = otisk(data);
  const drivejsi = (await client.query('SELECT otisk, vysledek FROM operace_klice WHERE oblast = $1 AND klic = $2', [oblast, klic])).rows[0];
  if (drivejsi) {
    if (drivejsi.otisk !== o) throw new ChybaEvidence(409, 'Pod tímto identifikátorem už proběhla jiná operace. Obnovte stránku a zadejte ji znovu.');
    return { vysledek: drivejsi.vysledek, opakovane: true };
  }
  const vysledek = await fn();
  await client.query('INSERT INTO operace_klice (oblast, klic, otisk, vysledek) VALUES ($1,$2,$3,$4)', [oblast, klic, o, JSON.stringify(vysledek ?? null)]);
  return { vysledek, opakovane: false };
}

module.exports = {
  ZPUSOBY, OKOLNOSTI, PUVODY_KREDITU, ChybaEvidence, kc,
  migrovat, puvodPoukazu, pravidloEet, zapsatPlatbu, zapsatKredit, stornovatPrijmy, stornovatKredit,
  prijatoNaObjednavku, vracenoVratkamiObjednavky, volnaCastPlatby, jednou, otisk
};
