// Slevové kódy (akce) – např. vánoční KRUCKY2026 od stromečku na náměstí.
//
// Pravidla akce jsou v tabulce promo_akce (sleva v %, minimální nákup, strop
// použití, platnost od–do, kde platí). Kód je veřejný: vzít si ho může kdokoli,
// uplatnit ho jde jen max_pouziti-krát celkem – e-shop a prodejna dohromady.
//
// Uplatnění se počítá při NÁKUPU (objednávka / prodej v pokladně), ne při
// zobrazení kódu. Strop hlídá zámek řádku akce (FOR UPDATE) v transakci nákupu,
// takže ho nepřekročí ani dva nákupy ve stejné vteřině. Zrušení objednávky nebo
// smazání prodeje použití uvolní (řádek se nemaže, dostane čas uvolnění) a místo
// ve stropu se vrátí.
//
// Sleva se počítá jen ze zboží, které NENÍ ve slevě (produkty.cena_pred_slevou) –
// akce se se slevou zboží nesčítá. Z téhož zboží se počítá i minimální nákup.
// Dárkový poukaz je způsob platby, ne sleva – s kódem jde použít.
//
// Vypínač: PROMO_AKTIVNI=false na Renderu akce okamžitě vypne (výchozí = zapnuto,
// datum začátku a konce hlídá databáze).

const ZACATEK_KRUCKY = '2026-11-29 00:00:00 Europe/Prague';
const KONEC_KRUCKY = '2027-01-01 00:00:00 Europe/Prague'; // včetně celého 31. 12. 2026

async function migrovat(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS promo_akce (
      kod TEXT PRIMARY KEY,
      nazev TEXT NOT NULL,
      sleva_procenta INTEGER NOT NULL CHECK (sleva_procenta BETWEEN 1 AND 90),
      min_nakup NUMERIC NOT NULL DEFAULT 0,
      max_pouziti INTEGER NOT NULL CHECK (max_pouziti > 0),
      platnost_od TIMESTAMPTZ,
      platnost_do TIMESTAMPTZ NOT NULL,
      eshop BOOLEAN NOT NULL DEFAULT TRUE,
      prodejna BOOLEAN NOT NULL DEFAULT TRUE,
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_pouziti (
      id SERIAL PRIMARY KEY,
      kod TEXT NOT NULL REFERENCES promo_akce(kod),
      kanal TEXT NOT NULL CHECK (kanal IN ('eshop', 'prodejna')),
      objednavka_id INTEGER,
      prodej_id INTEGER,
      mezisoucet NUMERIC NOT NULL,
      sleva NUMERIC NOT NULL,
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      uvolneno TIMESTAMPTZ,
      duvod_uvolneni TEXT
    );
    CREATE INDEX IF NOT EXISTS promo_pouziti_aktivni_idx ON promo_pouziti (kod) WHERE uvolneno IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS promo_pouziti_objednavka_uq ON promo_pouziti (objednavka_id) WHERE uvolneno IS NULL AND objednavka_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS promo_pouziti_prodej_uq ON promo_pouziti (prodej_id) WHERE uvolneno IS NULL AND prodej_id IS NOT NULL;
    -- Správa akce v adminu (2026-11-11): vypínač a historie změn (strop, konec, zapnutí)
    ALTER TABLE promo_akce ADD COLUMN IF NOT EXISTS aktivni BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS promo_zmeny (
      id SERIAL PRIMARY KEY,
      kod TEXT NOT NULL REFERENCES promo_akce(kod),
      popis TEXT NOT NULL,
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Výchozí akce – jen když ještě neexistuje (úpravy v databázi se nepřepíšou)
  await db.query(
    `INSERT INTO promo_akce (kod, nazev, sleva_procenta, min_nakup, max_pouziti, platnost_od, platnost_do)
     VALUES ('KRUCKY2026', 'Vánoční sleva od stromečku', 10, 500, 50, $1::timestamptz, $2::timestamptz)
     ON CONFLICT (kod) DO NOTHING`,
    [ZACATEK_KRUCKY, KONEC_KRUCKY]
  );
}

// "krůčky 2026", "Krucky2026 " → "KRUCKY2026"
function normalizovatKod(vstup) {
  return String(vstup == null ? '' : vstup)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .slice(0, 40);
}

const akceVypnuta = () => process.env.PROMO_AKTIVNI === 'false';

// Sleva na celé koruny
const vypocitatSlevu = (zaklad, procenta) => Math.round(Number(zaklad) * Number(procenta) / 100);

const datumCesky = d => new Date(d).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' });
const popisSlevy = (kod, procenta) => `Sleva ${procenta} % (kód ${kod})`;

// Kontrola pravidel bez databáze – vrací text chyby pro zákazníka, nebo null.
// zaklad = cena zboží, ze kterého se sleva počítá (bez zboží ve slevě a bez dopravy)
function chybaAkce(akce, { zaklad, kanal, ted, pouzito }) {
  if (!akce) return 'Tento slevový kód neexistuje. Zkontrolujte prosím, že je napsaný správně.';
  if (akceVypnuta() || akce.aktivni === false) return 'Slevová akce momentálně neprobíhá.';
  if (kanal === 'eshop' && !akce.eshop) return 'Tento slevový kód platí jen v prodejně.';
  if (kanal === 'prodejna' && !akce.prodejna) return 'Tento slevový kód platí jen v e-shopu.';
  const cas = ted.getTime();
  if (akce.platnost_od && cas < new Date(akce.platnost_od).getTime()) return `Slevový kód ${akce.kod} platí od ${datumCesky(akce.platnost_od)}.`;
  if (cas >= new Date(akce.platnost_do).getTime()) return 'Platnost slevového kódu už skončila.';
  if (pouzito >= Number(akce.max_pouziti)) return `Slevu už využilo všech ${akce.max_pouziti} zákazníků. Děkujeme za zájem!`;
  if (!(Number(zaklad) > 0)) return 'Slevový kód nejde použít na zboží, které už je ve slevě.';
  if (Number(zaklad) < Number(akce.min_nakup)) {
    return `Slevový kód platí při nákupu zboží od ${Number(akce.min_nakup)} Kč (bez dopravy a zboží ve slevě). Chybí vám ještě ${Math.ceil(Number(akce.min_nakup) - Number(zaklad))} Kč.`;
  }
  return null;
}

async function nacistAkci(db, kod, zamknout) {
  const akce = (await db.query(`SELECT * FROM promo_akce WHERE kod = $1${zamknout ? ' FOR UPDATE' : ''}`, [kod])).rows[0] || null;
  if (!akce) return { akce: null, pouzito: 0 };
  const pocet = await db.query('SELECT COUNT(*)::int AS pocet FROM promo_pouziti WHERE kod = $1 AND uvolneno IS NULL', [kod]);
  return { akce, pouzito: Number(pocet.rows[0].pocet) };
}

// Ověření kódu. zamknout = true uvnitř transakce nákupu (zámek drží do COMMIT,
// takže strop mezi ověřením a zápisem použití nikdo nepředběhne).
// Vrací { ok: true, kod, procenta, sleva, popis } nebo { ok: false, chyba }.
async function overit(db, vstupniKod, { zaklad, kanal, ted = new Date(), zamknout = false }) {
  const kod = normalizovatKod(vstupniKod);
  if (!kod) return { ok: false, chyba: 'Zadejte slevový kód.' };
  const { akce, pouzito } = await nacistAkci(db, kod, zamknout);
  const chyba = chybaAkce(akce, { zaklad, kanal, ted, pouzito });
  if (chyba) return { ok: false, chyba };
  const procenta = Number(akce.sleva_procenta);
  return { ok: true, kod: akce.kod, procenta, sleva: vypocitatSlevu(zaklad, procenta), popis: popisSlevy(akce.kod, procenta) };
}

// Zápis použití – volat ve stejné transakci po overit(..., { zamknout: true })
async function zapsatPouziti(client, { kod, kanal, objednavkaId = null, prodejId = null, zaklad, sleva }) {
  await client.query(
    'INSERT INTO promo_pouziti (kod, kanal, objednavka_id, prodej_id, mezisoucet, sleva) VALUES ($1,$2,$3,$4,$5,$6)',
    [kod, kanal, objednavkaId, prodejId, zaklad, sleva]
  );
}

// Uvolnění použití (zrušená objednávka, smazaný prodej) – vrací počet uvolněných
async function uvolnit(client, { objednavkaId = null, prodejId = null }, duvod) {
  const sloupec = objednavkaId != null ? 'objednavka_id' : 'prodej_id';
  const r = await client.query(
    `UPDATE promo_pouziti SET uvolneno = NOW(), duvod_uvolneni = $2 WHERE ${sloupec} = $1 AND uvolneno IS NULL`,
    [objednavkaId != null ? objednavkaId : prodejId, duvod || null]
  );
  return r.rowCount || 0;
}

// ═══════════════════════════════
// SPRÁVA AKCE V ADMINU – přehled, nákupy s kódem, prodloužení
// ═══════════════════════════════
// Konec akce je v DB uložený jako okamžik (půlnoc po posledním dni, český čas).
// Admin pracuje s „posledním dnem včetně“ (YYYY-MM-DD), převod dělá databáze.
const SQL_DNY = `
  to_char(a.platnost_od AT TIME ZONE 'Europe/Prague', 'YYYY-MM-DD') AS od_den,
  to_char((a.platnost_do AT TIME ZONE 'Europe/Prague') - interval '1 second', 'YYYY-MM-DD') AS do_den`;

const MAX_STROP = 10000;

async function prehledAkci(db) {
  const r = await db.query(`
    SELECT a.kod, a.nazev, a.sleva_procenta, a.min_nakup, a.max_pouziti, a.platnost_od, a.platnost_do,
      a.eshop, a.prodejna, a.aktivni, ${SQL_DNY},
      COUNT(p.id) FILTER (WHERE p.uvolneno IS NULL)::int AS pouzito,
      COUNT(p.id) FILTER (WHERE p.uvolneno IS NULL AND p.kanal = 'eshop')::int AS pouzito_eshop,
      COUNT(p.id) FILTER (WHERE p.uvolneno IS NULL AND p.kanal = 'prodejna')::int AS pouzito_prodejna,
      COALESCE(SUM(p.sleva) FILTER (WHERE p.uvolneno IS NULL), 0)::float AS sleva_celkem,
      COALESCE(SUM(p.mezisoucet) FILTER (WHERE p.uvolneno IS NULL), 0)::float AS zbozi_celkem
    FROM promo_akce a LEFT JOIN promo_pouziti p ON p.kod = a.kod
    GROUP BY a.kod ORDER BY a.vytvoreno DESC`);
  return r.rows;
}

// Nákupy s kódem včetně uvolněných (zrušená objednávka / smazaný prodej)
async function pouzitiAkce(db, kod) {
  const r = await db.query(`
    SELECT p.id, p.kanal, p.objednavka_id, p.prodej_id, p.mezisoucet::float AS mezisoucet, p.sleva::float AS sleva,
      p.vytvoreno, p.uvolneno, p.duvod_uvolneni, o.cislo AS objednavka_cislo,
      CASE WHEN o.obj_email IS NOT NULL THEN o.obj_jmeno ELSE z.jmeno END AS objednavka_jmeno,
      pr.zakaznik AS prodej_zakaznik
    FROM promo_pouziti p
    LEFT JOIN objednavky o ON o.id = p.objednavka_id
    LEFT JOIN zakaznici z ON z.id = o.zakaznik_id
    LEFT JOIN prodejna_prodeje pr ON pr.id = p.prodej_id
    WHERE p.kod = $1 ORDER BY p.vytvoreno DESC, p.id DESC LIMIT 1000`, [kod]);
  return r.rows;
}

async function zmenyAkce(db, kod) {
  return (await db.query('SELECT popis, vytvoreno FROM promo_zmeny WHERE kod = $1 ORDER BY vytvoreno DESC, id DESC LIMIT 100', [kod])).rows;
}

const jeDen = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z'))
  && new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;
const denCesky = s => { const [r, m, d] = s.split('-'); return `${Number(d)}. ${Number(m)}. ${r}`; };
const dnesPraha = (ted = new Date()) => ted.toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });

// Kontrola úpravy bez databáze. akce = řádek s od_den/do_den, zmeny = co přišlo
// z adminu. Vrací { chyba } nebo { sady: {...}, popisy: [...] } (jen skutečné změny).
function pripravitUpravu(akce, zmeny, { pouzito, ted = new Date() }) {
  const sady = {}, popisy = [];
  if (zmeny.max_pouziti !== undefined) {
    const n = Number(zmeny.max_pouziti);
    if (!Number.isInteger(n) || n < 1 || n > MAX_STROP) return { chyba: `Počet slev musí být celé číslo 1–${MAX_STROP}.` };
    if (n < pouzito) return { chyba: `Kód už byl použit ${pouzito}×, počet slev nejde snížit pod tuto hodnotu.` };
    if (n !== Number(akce.max_pouziti)) { sady.max_pouziti = n; popisy.push(`Počet slev ${akce.max_pouziti} → ${n}`); }
  }
  if (zmeny.do_den !== undefined) {
    const d = zmeny.do_den;
    if (!jeDen(d)) return { chyba: 'Neplatné datum konce akce.' };
    if (akce.od_den && d < akce.od_den) return { chyba: `Akce nemůže skončit dřív, než začne (${denCesky(akce.od_den)}).` };
    if (d !== akce.do_den && d < dnesPraha(ted)) return { chyba: 'Konec akce nejde nastavit do minulosti. Pro okamžité ukončení akci vypněte.' };
    const max = new Date(ted.getTime() + 366 * 864e5).toISOString().slice(0, 10);
    if (d > max) return { chyba: 'Akci jde prodloužit nejvýš o rok dopředu.' };
    if (d !== akce.do_den) { sady.do_den = d; popisy.push(`Platí do ${denCesky(akce.do_den)} → ${denCesky(d)}`); }
  }
  if (zmeny.aktivni !== undefined) {
    if (typeof zmeny.aktivni !== 'boolean') return { chyba: 'Neplatná hodnota zapnutí akce.' };
    if (zmeny.aktivni !== (akce.aktivni !== false)) { sady.aktivni = zmeny.aktivni; popisy.push(zmeny.aktivni ? 'Akce zapnuta' : 'Akce vypnuta'); }
  }
  return { sady, popisy };
}

// Úprava akce v transakci: zámek řádku akce (stejný jako při nákupu), takže se
// strop nesníží pod počet použití ani souběžně s nákupem. Vrací { ok, akce } / { chyba, status }.
async function upravitAkci(pool, vstupniKod, zmeny, { ted = new Date() } = {}) {
  const kod = normalizovatKod(vstupniKod);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const akce = (await client.query(`SELECT a.*, ${SQL_DNY} FROM promo_akce a WHERE a.kod = $1 FOR UPDATE`, [kod])).rows[0];
    if (!akce) { await client.query('ROLLBACK'); return { chyba: 'Akce nebyla nalezena.', status: 404 }; }
    const pouzito = Number((await client.query('SELECT COUNT(*)::int AS pocet FROM promo_pouziti WHERE kod = $1 AND uvolneno IS NULL', [kod])).rows[0].pocet);
    const u = pripravitUpravu(akce, zmeny || {}, { pouzito, ted });
    if (u.chyba) { await client.query('ROLLBACK'); return { chyba: u.chyba, status: 400 }; }
    if (u.popisy.length) {
      await client.query(
        `UPDATE promo_akce SET
           max_pouziti = COALESCE($2, max_pouziti),
           platnost_do = COALESCE((($3::date + 1)::timestamp AT TIME ZONE 'Europe/Prague'), platnost_do),
           aktivni = COALESCE($4, aktivni)
         WHERE kod = $1`,
        [kod, u.sady.max_pouziti ?? null, u.sady.do_den ?? null, u.sady.aktivni ?? null]
      );
      await client.query('INSERT INTO promo_zmeny (kod, popis) VALUES ($1, $2)', [kod, u.popisy.join(', ')]);
    }
    await client.query('COMMIT');
    return { ok: true, zmeneno: u.popisy };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Veřejné údaje pro stránku akce (stromeček) – bez nákupů a částek
async function verejneInfo(db, vstupniKod) {
  const kod = normalizovatKod(vstupniKod);
  const r = await db.query(`SELECT a.kod, a.sleva_procenta, a.min_nakup::float AS min_nakup, a.max_pouziti, a.aktivni, ${SQL_DNY}
    FROM promo_akce a WHERE a.kod = $1`, [kod]);
  return r.rows[0] || null;
}

module.exports = {
  migrovat, normalizovatKod, vypocitatSlevu, popisSlevy, chybaAkce, overit, zapsatPouziti, uvolnit,
  prehledAkci, pouzitiAkce, zmenyAkce, pripravitUpravu, upravitAkci, verejneInfo, akceVypnuta,
  ZACATEK_KRUCKY, KONEC_KRUCKY, MAX_STROP
};
