// Události EET (krok 3): co, kdy a v jaké výši se eviduje. Odesílání: lib/eetFronta.js.
//
// Tři vrstvy (nezaměňovat):
//   finanční operace  = prodej, vratka, výměna, úhrada… → řádky `platby` + `kredit_pohyby`
//   událost EET       = jedna evidovaná tržba (`eet_udalosti`) s NEMĚNNÝMI podklady:
//                       EIČ, provozovna, pokladna, pořadové číslo, datum tržby, částky.
//                       Vazba na řádky operace v `eet_udalosti_radky` (každý řádek nejvýš jednou).
//   pokus o odeslání  = `eet_pokusy` (nové UUID zprávy, první/opakované zaslání, výsledek)
//
// Jedna operace = jedna datová zpráva (popis položek kap. 12: platba více způsoby
// současně = jedna zpráva), NE zpráva za každý řádek tabulky platby:
//   celk_trzba        = kontaktní peníze (+ příjem, − vrácení evidované tržby)
//                       + čerpání zaplaceného kreditu u pultu (kap. 12 a 14)
//   urceno_cerp_zuct  = část kontaktní platby nabíjející poukaz (kap. 13), − při vrácení peněz za poukaz
//   cerp_zuct         = čerpání zaplaceného kreditu u pultu (kap. 14), − při vrácení zboží na poukaz
// Darovaný / nedoložený / neurčený kredit se NEpřičítá ani tiše nevynechává: vznikne zvláštní
// událost ve stavu 'rozhodnuti', která se neodešle, dokud o ní majitelka nerozhodne.
// Záporně se eviduje jen vrácení evidované tržby vrácené u pultu (kap. 4 storno/oprava).
// Nekontaktní platby (převod, dobírka, e-shop) se neevidují.
//
// Stavy události: ceka → potvrzeno (konečný) | chyba (trvalá chyba, po opravě znovu ceka);
// rozhodnuti → ceka (evidovat) | neevidovano (konečný, s odůvodněním). Hlídá trigger.
'use strict';
const { castka, casEet } = require('./eetZprava');
const konfigurace = require('./eetKonfigurace');

const kc = n => Math.round(Number(n) * 100) / 100;
const LHUTA_HODIN = 48; // po výpadku nejpozději do 48 h od uskutečnění tržby (popis rozhraní kap. 4)
const NEMENNE = ['prostredi', 'typ', 'eic', 'id_provoz', 'id_pokl', 'porad_cis', 'dat_trzby', 'celk_trzba', 'urceno_cerp_zuct', 'cerp_zuct', 'lhuta_do', 'podklady', 'volna_platba_id'];
// Prostředí, která tato verze smí používat. Produkce je vypnutá i v databázi (CHECK).
const NEPRODUKCNI = ['playground', 'test'];
const KONECNE_SLOUPCE = ['stav', 'pok', 'pok_test', 'potvrzeno_at', 'rozhodnuti_volba', 'rozhodnuti_poznamka', 'rozhodnuto_at'];

// ─── Konfigurace (načte se jednou z env; testy ji nastaví samy) ───
let konfig = null, chybaKonfigurace = null, nactena = false;
function aktualniKonfigurace() {
  if (!nactena) {
    nactena = true;
    try { konfig = konfigurace.nacist(process.env); } catch (e) { konfig = null; chybaKonfigurace = e.message; }
  }
  return konfig;
}
function nastavitKonfiguraci(k, chyba = null) { konfig = k; chybaKonfigurace = chyba; nactena = true; }
const stavKonfigurace = () => ({ konfig: aktualniKonfigurace(), chyba: chybaKonfigurace });

async function migrovat(db) {
  await db.query(`
    CREATE SEQUENCE IF NOT EXISTS eet_porad_seq;
    ALTER TABLE eet_udalosti ALTER COLUMN stav SET DEFAULT 'ceka';
    ${['prostredi', 'typ', 'eic', 'id_provoz', 'id_pokl', 'porad_cis', 'dat_trzby', 'rozhodnuti_duvod', 'rozhodnuti_volba', 'rozhodnuti_poznamka',
       'pok', 'zamek_token', 'posledni_vysledek', 'posledni_chyba'].map(c => `ALTER TABLE eet_udalosti ADD COLUMN IF NOT EXISTS ${c} TEXT;`).join('\n    ')}
    ${['celk_trzba', 'urceno_cerp_zuct', 'cerp_zuct'].map(c => `ALTER TABLE eet_udalosti ADD COLUMN IF NOT EXISTS ${c} NUMERIC(12,2);`).join('\n    ')}
    ${['lhuta_do', 'rozhodnuto_at', 'potvrzeno_at', 'dalsi_pokus_at', 'zamek_do', 'posledni_pokus_at'].map(c => `ALTER TABLE eet_udalosti ADD COLUMN IF NOT EXISTS ${c} TIMESTAMPTZ;`).join('\n    ')}
    ALTER TABLE eet_udalosti ADD COLUMN IF NOT EXISTS podklady JSONB;
    ALTER TABLE eet_udalosti ADD COLUMN IF NOT EXISTS varovani JSONB;
    ALTER TABLE eet_udalosti ADD COLUMN IF NOT EXISTS pok_test BOOLEAN;
    ALTER TABLE eet_udalosti ADD COLUMN IF NOT EXISTS pocet_pokusu INTEGER NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX IF NOT EXISTS eet_udalosti_identita_uq ON eet_udalosti (eic, id_provoz, id_pokl, porad_cis) WHERE porad_cis IS NOT NULL;
    CREATE INDEX IF NOT EXISTS eet_udalosti_fronta_idx ON eet_udalosti (stav, dalsi_pokus_at);
    -- volná platba u pultu (bez dokladu): původní tržba i opravy při změně účelu se na ni vážou
    ALTER TABLE eet_udalosti ADD COLUMN IF NOT EXISTS volna_platba_id INTEGER REFERENCES platby(id);
    CREATE INDEX IF NOT EXISTS eet_udalosti_volna_idx ON eet_udalosti (volna_platba_id) WHERE volna_platba_id IS NOT NULL;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'eet_udalosti'::regclass AND conname = 'eet_udalosti_zdroj_typ_check'
                     AND pg_get_constraintdef(oid) LIKE '%volna%') THEN
        ALTER TABLE eet_udalosti DROP CONSTRAINT IF EXISTS eet_udalosti_zdroj_typ_check;
        ALTER TABLE eet_udalosti ADD CONSTRAINT eet_udalosti_zdroj_typ_check CHECK (zdroj_typ IN ('prodej', 'vratka', 'poukaz', 'objednavka', 'volna'));
      END IF;
      -- produkční evidence v této verzi není povolená ani přímým zápisem do databáze
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'eet_udalosti'::regclass AND conname = 'eet_udalosti_jen_neprodukce') THEN
        ALTER TABLE eet_udalosti ADD CONSTRAINT eet_udalosti_jen_neprodukce CHECK (prostredi IS NULL OR prostredi IN (${NEPRODUKCNI.map(p => `'${p}'`).join(', ')}));
      END IF;
    END $$;
    -- od kdy je EET v daném prostředí zapnuté (kontrola řádků bez události)
    CREATE TABLE IF NOT EXISTS eet_provoz (prostredi TEXT PRIMARY KEY, zapnuto_od TIMESTAMPTZ NOT NULL DEFAULT NOW());

    -- Které řádky operace událost pokrývá (každý řádek nejvýš v jedné události)
    CREATE TABLE IF NOT EXISTS eet_udalosti_radky (
      id SERIAL PRIMARY KEY,
      udalost_id INTEGER NOT NULL REFERENCES eet_udalosti(id),
      platba_id INTEGER UNIQUE REFERENCES platby(id),
      kredit_pohyb_id INTEGER UNIQUE REFERENCES kredit_pohyby(id),
      CHECK ((platba_id IS NULL) <> (kredit_pohyb_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS eet_udalosti_radky_udalost_idx ON eet_udalosti_radky (udalost_id);

    CREATE TABLE IF NOT EXISTS eet_pokusy (
      id SERIAL PRIMARY KEY,
      udalost_id INTEGER REFERENCES eet_udalosti(id),
      uuid_zpravy TEXT NOT NULL UNIQUE,
      prvni_zaslani BOOLEAN NOT NULL,
      overeni BOOLEAN NOT NULL DEFAULT false,
      dat_odesl TEXT NOT NULL,
      prostredi TEXT NOT NULL,
      otisk_pozadavku TEXT,
      zahajeno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dokonceno TIMESTAMPTZ,
      vysledek TEXT CHECK (vysledek IN ('potvrzeno', 'chyba', 'overeno', 'timeout', 'sit', 'neplatna_odpoved', 'nedokonceno')),
      http_status INTEGER,
      kod_chyby INTEGER,
      text_chyby TEXT,
      pok TEXT,
      varovani JSONB,
      transakce_fs TEXT,
      odpoved TEXT,
      CHECK (overeni OR udalost_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS eet_pokusy_udalost_idx ON eet_pokusy (udalost_id);

    CREATE OR REPLACE FUNCTION eet_udalost_nemenna() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR NEW.zdroj_typ IS DISTINCT FROM OLD.zdroj_typ OR NEW.zdroj_id IS DISTINCT FROM OLD.zdroj_id OR NEW.klic IS DISTINCT FROM OLD.klic THEN
        RAISE EXCEPTION 'Událost EET nejde smazat ani přesměrovat na jiný doklad.';
      END IF;
      IF OLD.porad_cis IS NOT NULL AND ROW(${NEMENNE.map(c => 'OLD.' + c).join(', ')}) IS DISTINCT FROM ROW(${NEMENNE.map(c => 'NEW.' + c).join(', ')}) THEN
        RAISE EXCEPTION 'Podklady události EET (identita tržby a částky) jsou neměnné – opravte je novou událostí.';
      END IF;
      IF OLD.stav IN ('potvrzeno', 'neevidovano') AND ROW(${KONECNE_SLOUPCE.map(c => 'OLD.' + c).join(', ')}) IS DISTINCT FROM ROW(${KONECNE_SLOUPCE.map(c => 'NEW.' + c).join(', ')}) THEN
        RAISE EXCEPTION 'Událost EET ve stavu % je uzavřená a nejde ji změnit.', OLD.stav;
      END IF;
      IF NEW.stav = 'potvrzeno' AND (NEW.pok IS NULL OR NEW.pok_test IS NULL) THEN
        RAISE EXCEPTION 'Potvrzená událost EET musí mít POK a příznak prostředí.';
      END IF;
      -- testovací potvrzení nesmí vypadat jako produkční evidence
      IF NEW.stav = 'potvrzeno' AND NEW.prostredi IN (${NEPRODUKCNI.map(p => `'${p}'`).join(', ')}) AND (NEW.pok_test IS NOT TRUE OR NEW.pok !~* '-ff$') THEN
        RAISE EXCEPTION 'Potvrzení z neprodukčního prostředí musí být označené jako test (POK končí -ff).';
      END IF;
      IF NEW.stav IS DISTINCT FROM OLD.stav AND NOT (
           (OLD.stav = 'ceka' AND NEW.stav IN ('potvrzeno', 'chyba'))
        OR (OLD.stav = 'chyba' AND NEW.stav IN ('ceka', 'potvrzeno'))
        OR (OLD.stav = 'rozhodnuti' AND NEW.stav IN ('ceka', 'neevidovano'))
        OR (OLD.stav = 'vytvorena')) THEN
        RAISE EXCEPTION 'Nepovolená změna stavu události EET: % → %.', OLD.stav, NEW.stav;
      END IF;
      IF NEW.stav = 'neevidovano' AND COALESCE(TRIM(NEW.rozhodnuti_poznamka), '') = '' THEN
        RAISE EXCEPTION 'Rozhodnutí „neevidovat“ musí mít odůvodnění.';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS eet_udalosti_radky_nemenna ON eet_udalosti_radky;
    CREATE TRIGGER eet_udalosti_radky_nemenna BEFORE UPDATE OR DELETE ON eet_udalosti_radky FOR EACH ROW EXECUTE FUNCTION evidence_plateb_nemenna();

    -- Doklad je chráněný, i když jeho řádky pokrývá událost jiného dokladu (výměna)
    CREATE OR REPLACE FUNCTION eet_chranit_doklad() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM eet_udalosti WHERE zdroj_typ = TG_ARGV[0] AND zdroj_id = OLD.id)
         OR EXISTS (SELECT 1 FROM eet_udalosti_radky r JOIN platby p ON p.id = r.platba_id WHERE p.zdroj_typ = TG_ARGV[0] AND p.zdroj_id = OLD.id)
         OR EXISTS (SELECT 1 FROM eet_udalosti_radky r JOIN kredit_pohyby k ON k.id = r.kredit_pohyb_id WHERE k.zdroj_typ = TG_ARGV[0] AND k.zdroj_id = OLD.id) THEN
        RAISE EXCEPTION 'Doklad má vytvořenou událost EET – nejde ho smazat ani změnit. Opravte ho navázaným záznamem (vratka, storno).' USING ERRCODE = 'P0001';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    -- pokus je po dokončení neměnný (výsledek jde zapsat jen jednou)
    CREATE OR REPLACE FUNCTION eet_pokus_jednou() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pokus o odeslání EET nejde smazat.'; END IF;
      IF OLD.vysledek IS NOT NULL OR NEW.uuid_zpravy IS DISTINCT FROM OLD.uuid_zpravy OR NEW.udalost_id IS DISTINCT FROM OLD.udalost_id
         OR NEW.prvni_zaslani IS DISTINCT FROM OLD.prvni_zaslani OR NEW.dat_odesl IS DISTINCT FROM OLD.dat_odesl OR NEW.otisk_pozadavku IS DISTINCT FROM OLD.otisk_pozadavku THEN
        RAISE EXCEPTION 'Dokončený pokus o odeslání EET je neměnný.';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS eet_pokusy_jednou ON eet_pokusy;
    CREATE TRIGGER eet_pokusy_jednou BEFORE UPDATE OR DELETE ON eet_pokusy FOR EACH ROW EXECUTE FUNCTION eet_pokus_jednou();
  `);
}

async function cisloTrzby(client, rok) {
  const n = (await client.query("SELECT nextval('eet_porad_seq') AS n")).rows[0].n;
  return `${rok}-${String(n).padStart(6, '0')}`;
}

// Peníze a kredit operace → částky EET (nic nezapisuje)
//   příjem u pultu              +celk (+urceno, je-li určen k nabití poukazu)
//   vrácení evidované tržby     −celk (−urceno u peněz za poukaz = storno nabití)
//   storno příjmu / vrácení     opačné znaménko než opravovaný řádek, jen byl-li evidovaný
//   čerpání zaplaceného kreditu +celk +cerp; vrácení zboží na poukaz −celk −cerp
//   darovaný / nedoložený kredit → nevyreseno (zvláštní událost k rozhodnutí)
async function spocitat(client, platby, pohyby) {
  const s = { celk: 0, urceno: 0, cerp: 0, nevyreseno: 0, podklady: { platby: [], kredit: [] } };
  // původní platba: byla evidovaná? kolik z ní bylo určeno k čerpání (u volné platby podle jejích událostí)?
  const puvodni = async (id, predId) => (await client.query(`SELECT o.id, o.typ, o.kontaktni, o.vraci_id,
      CASE WHEN o.zdroj_typ = 'volna'
           THEN (SELECT COALESCE(SUM(u.urceno_cerp_zuct), 0) FROM eet_udalosti u WHERE u.volna_platba_id = o.id AND u.stav <> 'neevidovano')
           ELSE COALESCE(o.urceno_k_cerpani, 0) END AS zaklad_urceno,
      EXISTS (SELECT 1 FROM eet_udalosti_radky r JOIN eet_udalosti u ON u.id = r.udalost_id
              WHERE r.platba_id = o.id AND u.stav <> 'neevidovano') AS evidovana,
      (SELECT COALESCE(SUM(v.castka), 0) FROM platby v WHERE v.vraci_id = o.id AND v.typ = 'vraceni' AND v.id < $2) AS drive_vraceno
    FROM platby o WHERE o.id = $1`, [id, predId])).rows[0];
  for (const p of platby) {
    const c = Number(p.castka);
    let eviduje = false;
    if (p.typ === 'prijem' && p.kontaktni) {
      s.celk += c; eviduje = true;
      if (p.urceno_k_cerpani) s.urceno += Number(p.urceno_k_cerpani);
    } else if (p.typ === 'vraceni' && p.kontaktni && p.vraci_id) {
      // vrací se tržba, která byla evidovaná (původní platba je v události, o níž nebylo rozhodnuto „neevidovat“)
      const o = await puvodni(p.vraci_id, p.id);
      if (o && o.kontaktni && o.evidovana) {
        s.celk -= c; eviduje = true;
        // u vrácení peněz za poukaz se vrací i část určená k čerpání (storno nabití)
        s.urceno -= Math.max(0, Math.min(c, Number(o.zaklad_urceno) - Number(o.drive_vraceno)));
      }
    } else if (p.typ === 'storno_prijmu' && p.opravuje_id) {
      // oprava omylem zapsaného příjmu: záporně jen to, co bylo evidováno
      const o = await puvodni(p.opravuje_id, p.id);
      if (o && o.kontaktni && o.evidovana) {
        s.celk -= c; eviduje = true;
        s.urceno -= Math.min(c, Number(o.zaklad_urceno));
      }
    } else if (p.typ === 'storno_vraceni' && p.opravuje_id) {
      // oprava omylem zapsaného vrácení: kladně, jen bylo-li vrácení evidováno
      const o = await puvodni(p.opravuje_id, p.id);
      if (o && o.kontaktni && o.evidovana) {
        s.celk += c; eviduje = true;
        const zdroj = o.vraci_id ? await puvodni(o.vraci_id, o.id) : null;
        if (zdroj) s.urceno += Math.max(0, Math.min(c, Number(zdroj.zaklad_urceno) - Number(zdroj.drive_vraceno)));
      }
    }
    s.podklady.platby.push({ id: p.id, typ: p.typ, castka: c, zpusob: p.zpusob, kontaktni: p.kontaktni, eviduje });
  }
  for (const k of pohyby) {
    const zaznam = { id: k.id, typ: k.typ, castka: Number(k.castka), kontaktni: k.kontaktni, casti: [] };
    if (k.typ === 'cerpani' && k.kontaktni) {
      for (const c of (await client.query("SELECT castka, eet_pravidlo FROM kredit_casti WHERE kredit_pohyb_id = $1 AND smer = 'odber' ORDER BY id", [k.id])).rows) {
        if (c.eet_pravidlo === 'cerp_zuct') s.cerp += Number(c.castka);
        else if (c.eet_pravidlo === 'nevyreseno') s.nevyreseno += Number(c.castka);
        zaznam.casti.push({ castka: Number(c.castka), eet: c.eet_pravidlo });
      }
    } else if (k.typ === 'pripsani' && k.kontaktni) {
      // vrácení zboží na poukaz = storno čerpání (popis položek kap. 14, příklad 3): záporné cerp_zuct u zaplaceného základu
      for (const v of (await client.query('SELECT castka, eet_zaklad FROM kredit_vklady WHERE kredit_pohyb_id = $1 ORDER BY id', [k.id])).rows) {
        const eet = v.eet_zaklad === 'zaplaceny' ? 'cerp_zuct' : 'nevyreseno';
        if (eet === 'cerp_zuct') s.cerp -= Number(v.castka); else s.nevyreseno -= Number(v.castka);
        zaznam.casti.push({ castka: -Number(v.castka), eet });
      }
    }
    // nabití se eviduje přes platbu (urceno_k_cerpani), výplata přes vrácení platby;
    // zrušení zbytku, počáteční stav ani storna kreditu nejsou tržba
    s.podklady.kredit.push(zaznam);
  }
  s.cerp = kc(s.cerp); s.celk = kc(s.celk + s.cerp); s.urceno = kc(s.urceno); s.nevyreseno = kc(s.nevyreseno);
  return s;
}

// Založí jednu událost s neměnnými podklady (identita tržby se určí teď a už nikdy znovu)
async function zalozitUdalost(client, k, { klic, zdroj_typ, zdroj_id, stav, castky, datTrzby, podklady, duvod = null, volnaPlatbaId = null }) {
  const lhuta = new Date(new Date(datTrzby).getTime() + LHUTA_HODIN * 3600e3);
  const dat = casEet(datTrzby);
  return (await client.query(
    `INSERT INTO eet_udalosti (klic, zdroj_typ, zdroj_id, stav, prostredi, typ, eic, id_provoz, id_pokl, porad_cis, dat_trzby,
       celk_trzba, urceno_cerp_zuct, cerp_zuct, lhuta_do, podklady, rozhodnuti_duvod, dalsi_pokus_at, volna_platba_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(), $18) RETURNING *`,
    [klic, zdroj_typ, zdroj_id, stav, k.prostredi, castky.celk < 0 ? 'oprava' : 'trzba',
     k.eic, k.idProvoz, k.idPokl, await cisloTrzby(client, dat.slice(0, 4)), dat, castky.celk, castky.urceno || null, castky.cerp || null,
     lhuta, JSON.stringify(podklady), duvod, volnaPlatbaId])).rows[0];
}

const poznamenatProvoz = (db, k) => db.query('INSERT INTO eet_provoz (prostredi) VALUES ($1) ON CONFLICT (prostredi) DO NOTHING', [k.prostredi]);

// Zapíše události EET operace ve STEJNÉ transakci jako operace (volající má BEGIN).
// Pokryje řádky platby a kredit_pohyby uvedených dokladů, které vznikly v této
// transakci (vytvoreno = now(), tj. čas začátku transakce) a ještě nejsou v žádné
// události. Opakování operace (stejný klíč → žádné nové řádky) tak nic nezdvojí.
// `platbaIds` = konkrétní řádky (volná platba nemá doklad). Bez konfigurace EET nic.
async function zaznamenat(client, { zdroj_typ, zdroj_id, klic, zdroje, platbaIds, volnaPlatbaId = null }) {
  const k = aktualniKonfigurace();
  const vysledek = { hlavni: null, rozhodnuti: null };
  if (!k || zdroj_id == null) return vysledek;
  await poznamenatProvoz(client, k);
  let platby, pohyby = [];
  if (platbaIds) {
    platby = (await client.query(`SELECT p.* FROM platby p WHERE p.id = ANY($1::int[])
      AND NOT EXISTS (SELECT 1 FROM eet_udalosti_radky r WHERE r.platba_id = p.id) ORDER BY p.id`, [platbaIds.map(Number)])).rows;
  } else {
    zdroje = (zdroje || [[zdroj_typ, zdroj_id]]).filter(([, id]) => id != null);
    const typy = zdroje.map(z => z[0]), idcka = zdroje.map(z => Number(z[1]));
    platby = (await client.query(`SELECT p.* FROM platby p JOIN unnest($1::text[], $2::int[]) z(t, i) ON p.zdroj_typ = z.t AND p.zdroj_id = z.i
      WHERE p.vytvoreno = now() AND NOT EXISTS (SELECT 1 FROM eet_udalosti_radky r WHERE r.platba_id = p.id) ORDER BY p.id`, [typy, idcka])).rows;
    pohyby = (await client.query(`SELECT k.* FROM kredit_pohyby k JOIN unnest($1::text[], $2::int[]) z(t, i) ON k.zdroj_typ = z.t AND k.zdroj_id = z.i
      WHERE k.vytvoreno = now() AND NOT EXISTS (SELECT 1 FROM eet_udalosti_radky r WHERE r.kredit_pohyb_id = k.id) ORDER BY k.id`, [typy, idcka])).rows;
  }
  if (!platby.length && !pohyby.length) return vysledek;
  const s = await spocitat(client, platby, pohyby);
  // datum tržby = okamžik operace (u volné platby okamžik přijetí); pevně při vzniku –
  // opakované odeslání nikdy nepočítá nové datum
  const datTrzby = volnaPlatbaId && platby[0] ? platby[0].prijato_at : (await client.query('SELECT now() AS t')).rows[0].t;
  const spolecne = { zdroj_typ, zdroj_id, datTrzby, podklady: s.podklady, volnaPlatbaId };
  const zaklad = `${zdroj_typ}:${zdroj_id}:${klic}`;
  if (s.celk !== 0 || s.urceno !== 0 || s.cerp !== 0) vysledek.hlavni = await zalozitUdalost(client, k, { ...spolecne, klic: zaklad, stav: 'ceka', castky: s });
  if (s.nevyreseno !== 0) {
    vysledek.rozhodnuti = await zalozitUdalost(client, k, { ...spolecne, klic: zaklad + ':rozhodnuti', stav: 'rozhodnuti',
      castky: { celk: s.nevyreseno, urceno: 0, cerp: s.nevyreseno },
      duvod: s.nevyreseno > 0
        ? `Čerpání darovaného nebo nedoloženého kreditu ${s.nevyreseno} Kč – pravidlo EET není doložené (návrh: evidovat jako cerp_zuct).`
        : `Vrácení darovaného nebo nedoloženého kreditu ${-s.nevyreseno} Kč na poukaz – pravidlo EET není doložené.` });
  }
  // řádky pokryje hlavní událost (nebo rozhodovací, když hlavní není); operace bez
  // evidované částky (převod, dobírka) žádnou událost nemá
  const vlastnik = vysledek.hlavni || vysledek.rozhodnuti;
  if (vlastnik) {
    for (const p of platby) await client.query('INSERT INTO eet_udalosti_radky (udalost_id, platba_id) VALUES ($1,$2)', [vlastnik.id, p.id]);
    for (const p of pohyby) await client.query('INSERT INTO eet_udalosti_radky (udalost_id, kredit_pohyb_id) VALUES ($1,$2)', [vlastnik.id, p.id]);
  }
  // NOTIFY se doručí až po COMMIT (při ROLLBACK vůbec) → první odeslání hned po uložení
  if (vysledek.hlavni) await client.query("SELECT pg_notify('eet_fronta', $1)", [String(vysledek.hlavni.id)]);
  return vysledek;
}

// Volná platba u pultu: účel (zboží / dárkový poukaz) se zadává PŘI PŘIJETÍ a tehdy vzniká
// tržba (u poukazu s urceno_cerp_zuct). Když pozdější přiřazení (nebo jeho storno) účel
// změní, odeslaná zpráva se nepřepisuje a druhá tržba nevzniká: ve stejné transakci
// vzniknou dvě opravné události – záporná s dosavadním rozdělením a kladná se správným
// (celková tržba se nemění, posune se jen část určená k čerpání; popis položek kap. 14,
// příklad 3 – postup „storno + nabití“). Cíl: přiřazeno k poukazu + nepřiřazený zbytek
// podle účelu zadaného při přijetí. Platba bez události (převod, doba před EET) se nedoplňuje.
async function srovnatVolnou(client, platbaId, klic) {
  const k = aktualniKonfigurace();
  if (!k) return [];
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['eet-volna:' + platbaId]);
  const ev = (await client.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(urceno_cerp_zuct), 0) AS urceno
    FROM eet_udalosti WHERE volna_platba_id = $1 AND stav <> 'neevidovano'`, [platbaId])).rows[0];
  if (!ev.n) return [];
  const p = (await client.query('SELECT * FROM platby WHERE id = $1', [platbaId])).rows[0];
  const pr = (await client.query(`SELECT COALESCE(SUM(castka) FILTER (WHERE poukaz_id IS NOT NULL), 0) AS poukazy,
      COALESCE(SUM(castka) FILTER (WHERE objednavka_id IS NOT NULL), 0) AS objednavky
    FROM platby_prirazeni pr WHERE platba_id = $1 AND NOT EXISTS (SELECT 1 FROM platby_prirazeni_storna st WHERE st.prirazeni_id = pr.id)`, [platbaId])).rows[0];
  const volno = Math.max(0, Number(p.castka) - Number(pr.poukazy) - Number(pr.objednavky));
  const cil = kc(Number(pr.poukazy) + (p.urceno_k_cerpani ? volno : 0));
  const d = kc(cil - Number(ev.urceno));
  if (d === 0) return [];
  const a = Math.abs(d);
  const ted = (await client.query('SELECT now() AS t')).rows[0].t;
  const podklady = { oprava_volne_platby: { platba_id: platbaId, evidovano_urceno: Number(ev.urceno), spravne_urceno: cil,
    prirazeno_poukazum: Number(pr.poukazy), prirazeno_objednavkam: Number(pr.objednavky), ucel_pri_prijeti: p.urceno_k_cerpani ? 'poukaz' : 'zbozi' } };
  const spolecne = { zdroj_typ: 'volna', zdroj_id: platbaId, datTrzby: ted, podklady, volnaPlatbaId: platbaId };
  const zaklad = `volna:${platbaId}:oprava:${klic}`;
  const vznikle = [
    await zalozitUdalost(client, k, { ...spolecne, klic: zaklad + ':1', stav: 'ceka', castky: d > 0 ? { celk: -a } : { celk: -a, urceno: -a } }),
    await zalozitUdalost(client, k, { ...spolecne, klic: zaklad + ':2', stav: 'ceka', castky: d > 0 ? { celk: a, urceno: a } : { celk: a } })
  ];
  for (const u of vznikle) await client.query("SELECT pg_notify('eet_fronta', $1)", [String(u.id)]);
  return vznikle;
}

// Kontaktní řádky peněz a kreditu od zapnutí EET, které nepokrývá žádná událost a podle
// pravidel by měly (pojistka proti cestě, která zapomene událost založit) – nic se
// nedopočítává potichu, admin je vidí jako „vyžaduje rozhodnutí“.
async function nepokryteRadky(db, limit = 50) {
  return (await db.query(`WITH od AS (SELECT MIN(zapnuto_od) AS t FROM eet_provoz),
    pokryte AS (SELECT r.platba_id, r.kredit_pohyb_id FROM eet_udalosti_radky r JOIN eet_udalosti u ON u.id = r.udalost_id)
    SELECT 'platba' AS druh, p.id, p.typ, p.castka, p.zpusob, p.zdroj_typ, p.zdroj_id, p.vytvoreno FROM platby p, od
    WHERE od.t IS NOT NULL AND p.vytvoreno >= od.t AND p.kontaktni
      AND NOT EXISTS (SELECT 1 FROM eet_udalosti_radky r WHERE r.platba_id = p.id)
      AND (p.typ = 'prijem'
        OR (p.typ = 'vraceni' AND p.vraci_id IN (SELECT platba_id FROM pokryte WHERE platba_id IS NOT NULL))
        OR (p.typ IN ('storno_prijmu', 'storno_vraceni') AND p.opravuje_id IN (SELECT platba_id FROM pokryte WHERE platba_id IS NOT NULL)))
    UNION ALL
    SELECT 'kredit', k.id, k.typ, k.castka, NULL, k.zdroj_typ, k.zdroj_id, k.vytvoreno FROM kredit_pohyby k, od
    WHERE od.t IS NOT NULL AND k.vytvoreno >= od.t AND k.kontaktni AND k.typ IN ('cerpani', 'pripsani')
      AND NOT EXISTS (SELECT 1 FROM eet_udalosti_radky r WHERE r.kredit_pohyb_id = k.id)
    ORDER BY vytvoreno DESC LIMIT $1`, [limit])).rows;
}

// Data pro datovou zprávu z neměnných podkladů události (nepovinné položky jen nenulové)
function datovaZprava(u) {
  const volitelna = v => (v != null && Number(v) !== 0 ? castka(v) : null);
  return { eic: u.eic, idJednotky: u.id_provoz, idPokl: u.id_pokl, poradCis: u.porad_cis, datTrzby: u.dat_trzby,
    celk: castka(u.celk_trzba), urceno: volitelna(u.urceno_cerp_zuct), cerp: volitelna(u.cerp_zuct) };
}

// Jednoznačný kód tržby (popis rozhraní kap. 4) – shodný pro všechny pokusy
const kodTrzby = u => [u.eic, u.id_provoz, u.id_pokl, u.porad_cis, u.dat_trzby, castka(u.celk_trzba)].join('|');

// Má doklad událost EET nebo jsou jeho řádky v události? (aplikace odmítne změnu srozumitelně)
async function dokladVUdalosti(db, zdrojTyp, zdrojId) {
  if (zdrojId == null) return false;
  return (await db.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM eet_udalosti WHERE zdroj_typ = $1 AND zdroj_id = $2)
    OR EXISTS (SELECT 1 FROM eet_udalosti_radky r JOIN platby p ON p.id = r.platba_id WHERE p.zdroj_typ = $1 AND p.zdroj_id = $2)
    OR EXISTS (SELECT 1 FROM eet_udalosti_radky r JOIN kredit_pohyby k ON k.id = r.kredit_pohyb_id WHERE k.zdroj_typ = $1 AND k.zdroj_id = $2)`,
  [zdrojTyp, zdrojId])).rows.length > 0;
}

// Stav EET k dokladu (pro pokladnu a detail) – odděleně od uložení prodeje
async function stavDokladu(db, zdrojTyp, zdrojId) {
  return (await db.query(`SELECT DISTINCT u.id, u.stav, u.pok, u.pok_test, u.prostredi, u.celk_trzba, u.urceno_cerp_zuct, u.cerp_zuct, u.porad_cis, u.posledni_chyba, u.typ, u.vytvoreno
    FROM eet_udalosti u LEFT JOIN eet_udalosti_radky r ON r.udalost_id = u.id
    LEFT JOIN platby p ON p.id = r.platba_id LEFT JOIN kredit_pohyby k ON k.id = r.kredit_pohyb_id
    WHERE (u.zdroj_typ = $1 AND u.zdroj_id = $2) OR (p.zdroj_typ = $1 AND p.zdroj_id = $2) OR (k.zdroj_typ = $1 AND k.zdroj_id = $2)
    ORDER BY u.id`, [zdrojTyp, zdrojId])).rows;
}

module.exports = { migrovat, spocitat, zaznamenat, datovaZprava, kodTrzby, dokladVUdalosti, stavDokladu, LHUTA_HODIN, NEMENNE,
  aktualniKonfigurace, nastavitKonfiguraci, stavKonfigurace, srovnatVolnou, nepokryteRadky, poznamenatProvoz, NEPRODUKCNI };
