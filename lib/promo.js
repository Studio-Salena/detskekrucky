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
  if (akceVypnuta()) return 'Slevová akce momentálně neprobíhá.';
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

module.exports = {
  migrovat, normalizovatKod, vypocitatSlevu, popisSlevy, chybaAkce, overit, zapsatPouziti, uvolnit,
  ZACATEK_KRUCKY, KONEC_KRUCKY
};
