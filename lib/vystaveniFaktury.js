// Vystavení faktury a její neměnná uložená podoba.
//
// Tabulka faktury (jen přibývá, nikdy se nemění ani nemaže):
//   - data  = strukturovaný snímek dokladu (JSON) - prodávající, odběratel,
//             položky, ceny, sleva, doprava, celkem a data k okamžiku vystavení
//   - html  = přesně ten dokument, který se tiskne a posílá zákazníkovi
//   - html_sha256 = otisk HTML; při každém čtení se ověřuje (poškozený/podvržený
//             záznam se nevydá)
// Úpravu a smazání řádku zablokuje trigger v databázi, takže doklad nejde změnit
// ani omylem z jiného místa kódu. objednavky.faktura_cislo/faktura_datum zůstávají
// (zpětná kompatibilita, přehledy) a po vystavení je také nejde změnit.
//
// Historické faktury (číslo vystavené před zavedením této tabulky) uložený
// originál nemají. Zpětně se NEvytvářejí - viz HISTORICKA_UPOZORNENI.
//
// Opravný doklad (druh = 'storno', číslo OD2026001…) se ukládá do stejné tabulky
// se stejnou ochranou - viz vystavitStorno.

const crypto = require('crypto');
const { SQL_UDAJE_OBJEDNAVKY } = require('./objednavkySnapshot');
const { sestavitSnimek, sestavitStorno, vykreslitDokument, SABLONA_VERZE } = require('./faktura');

const HISTORICKA_UPOZORNENI = 'Faktura byla vystavena před zavedením ukládání faktur a její originál není v systému uložen. Toto je rekonstrukce z aktuálních údajů systému – nemusí se přesně shodovat s původně vydaným dokladem.';

const otisk = html => crypto.createHash('sha256').update(html, 'utf8').digest('hex');

// Migrace - idempotentní, bez cizího klíče na objednavky (struktura té tabulky
// není v repozitáři; doklad má přežít i případné smazání objednávky).
// Jeden dotaz o více příkazech = jedna transakce. Advisory zámek (uvolní se sám
// koncem transakce) serializuje souběžný start více instancí. Triggery se
// zakládají jen když chybějí - existující se neruší (žádný okamžik bez ochrany,
// žádný zbytečný zámek tabulky objednávek při každém startu); vypnutý trigger
// se znovu zapne.
const ZAMEK_MIGRACE_FAKTUR = 72430001;
async function migrovatFaktury(db) {
  await db.query(`
    SELECT pg_advisory_xact_lock(${ZAMEK_MIGRACE_FAKTUR});
    CREATE TABLE IF NOT EXISTS faktury (
      id SERIAL PRIMARY KEY,
      objednavka_id INTEGER NOT NULL,
      druh TEXT NOT NULL DEFAULT 'faktura',
      cislo TEXT NOT NULL UNIQUE,
      datum_vystaveni TIMESTAMPTZ NOT NULL,
      data JSONB NOT NULL,
      html TEXT NOT NULL,
      html_sha256 TEXT NOT NULL,
      sablona_verze TEXT NOT NULL,
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- jedna faktura a nejvýš jeden opravný doklad (storno) na objednávku
    CREATE UNIQUE INDEX IF NOT EXISTS faktury_objednavka_faktura_uniq ON faktury (objednavka_id) WHERE druh = 'faktura';
    CREATE UNIQUE INDEX IF NOT EXISTS faktury_objednavka_storno_uniq ON faktury (objednavka_id) WHERE druh = 'storno';
    -- opravné doklady mají vlastní číselnou řadu (OD + rok + pořadí), také po letech
    CREATE TABLE IF NOT EXISTS opravne_doklady_cislovani (rok INTEGER PRIMARY KEY, posledni_cislo INTEGER NOT NULL DEFAULT 0);
    CREATE OR REPLACE FUNCTION faktury_nemenne() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Vystavenou fakturu % nelze měnit ani mazat.', OLD.cislo;
    END
    $$ LANGUAGE plpgsql;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('faktury') AND tgname = 'faktury_nemenne' AND NOT tgisinternal) THEN
        CREATE TRIGGER faktury_nemenne BEFORE UPDATE OR DELETE ON faktury
          FOR EACH ROW EXECUTE FUNCTION faktury_nemenne();
      ELSIF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('faktury') AND tgname = 'faktury_nemenne' AND tgenabled = 'D') THEN
        ALTER TABLE faktury ENABLE TRIGGER faktury_nemenne;
      END IF;
    END
    $$;
    -- už přidělené číslo a datum faktury u objednávky nejde přepsat ani vymazat
    CREATE OR REPLACE FUNCTION objednavky_faktura_nemenna() RETURNS trigger AS $$
    BEGIN
      IF OLD.faktura_cislo IS NOT NULL AND (NEW.faktura_cislo IS DISTINCT FROM OLD.faktura_cislo OR NEW.faktura_datum IS DISTINCT FROM OLD.faktura_datum) THEN
        RAISE EXCEPTION 'Číslo a datum vystavené faktury % nelze změnit.', OLD.faktura_cislo;
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('objednavky') AND tgname = 'objednavky_faktura_nemenna' AND NOT tgisinternal) THEN
        CREATE TRIGGER objednavky_faktura_nemenna BEFORE UPDATE OF faktura_cislo, faktura_datum ON objednavky
          FOR EACH ROW EXECUTE FUNCTION objednavky_faktura_nemenna();
      ELSIF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('objednavky') AND tgname = 'objednavky_faktura_nemenna' AND tgenabled = 'D') THEN
        ALTER TABLE objednavky ENABLE TRIGGER objednavky_faktura_nemenna;
      END IF;
    END
    $$;
  `);
}

// Ověří, že uložený doklad nebyl změněn (otisk HTML sedí)
function overitUlozenou(f) {
  if (otisk(f.html) !== f.html_sha256) {
    throw new Error(`Uložená faktura ${f.cislo} neodpovídá svému otisku – doklad se nevydá. Kontaktujte správce.`);
  }
  return f;
}

// Náhradní název položky, jejíž produkt už v katalogu není
const NAZEV_BEZ_PRODUKTU = 'Produkt již není v katalogu';

// Kontrola částek před vystavením - stejné pravidlo, jakým objednávku spočítal
// server (routes/objednavky.js POST /): celkem = Σ(cena × počet) − sleva
// + doprava_cena + platba_priplatek. Počítá se v haléřích (bez chyb plovoucí
// čárky). Vrací text chyby, nebo null. Bez uložené ceny dopravy (starší
// objednávky) se součet ověřit nedá - šablona by ji jen dopočítala z celkem.
function chybaCastek(o, polozky) {
  const hal = v => Math.round(Number(v) * 100);
  if (!polozky.length) return 'Objednávka nemá žádné položky.';
  for (const p of polozky) {
    if (!Number.isInteger(Number(p.pocet)) || Number(p.pocet) <= 0 || !Number.isFinite(Number(p.cena)) || Number(p.cena) < 0) {
      return 'Položka objednávky nemá platný počet nebo cenu.';
    }
  }
  if (o.doprava_cena == null) return 'Objednávka nemá uloženou cenu dopravy, takže celkovou částku nejde ověřit.';
  for (const [nazev, v] of [['celkem', o.celkem], ['cena dopravy', o.doprava_cena], ['sleva', o.sleva == null ? 0 : o.sleva], ['příplatek', o.platba_priplatek == null ? 0 : o.platba_priplatek]]) {
    if (!Number.isFinite(Number(v))) return `Objednávka nemá platnou částku (${nazev}).`;
  }
  const soucet = polozky.reduce((s, p) => s + hal(p.cena) * Number(p.pocet), 0)
    - hal(o.sleva || 0) + hal(o.doprava_cena) + hal(o.platba_priplatek || 0);
  if (soucet !== hal(o.celkem)) {
    return `Částky objednávky nesouhlasí (položky, doprava, příplatek a sleva dávají ${soucet / 100} Kč, objednávka má ${Number(o.celkem)} Kč).`;
  }
  return null;
}

// Rok číselné řady podle českého času (ne podle pásma serveru)
const rokVPraze = ted => Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric' }).format(ted));

// Vystaví fakturu k objednávce, nebo vrátí už vystavenou. Výsledek { stav, ... }:
//   'vystavena'   - právě vystavená (faktura = uložený řádek)
//   'ulozena'     - už existovala, vrací se beze změny
//   'historicka'  - číslo z doby před ukládáním faktur, originál není uložen
//   'zrusena'     - zrušená objednávka bez faktury, nová se nevystaví
//   'nelze'       - částky nejde ověřit nebo nesouhlasí (chyba = důvod), nic se neuloží
//   'nenalezena'
// stav_objednavky = stav objednávky zjištěný pod zámkem (pro rozhodnutí volajícího,
// např. zákaz odeslání e-mailem u zrušené objednávky).
// Vše v jedné transakci se zámkem řádku objednávky: číslo, snímek, HTML i zápis
// do objednavky se uloží buď celé, nebo vůbec (při chybě se číslo nespotřebuje).
// Objednávka s údaji odběratele pod zámkem řádku (uvnitř otevřené transakce)
async function nacistObjednavkuProDoklad(client, objednavkaId) {
  return (await client.query(`
      SELECT o.*, ${SQL_UDAJE_OBJEDNAVKY}, dp.kod AS poukaz_kod
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      LEFT JOIN darkove_poukazy dp ON o.poukaz_id = dp.id
      WHERE o.id = $1
      FOR UPDATE OF o
    `, [objednavkaId])).rows[0];
}

// LEFT JOIN: smazaný produkt nesmí položku z dokladu vypustit. Cena a počet
// jsou uložené u položky objednávky; název se k položce v repozitářovém
// schématu neukládá - bere se z katalogu (op.nazev, pokud by na produkci
// existoval, má přednost jako historický údaj).
async function nacistPolozkyProDoklad(client, objednavkaId) {
  return (await client.query(`
      SELECT op.*, p.nazev AS produkt_nazev, p.znacka AS produkt_znacka
      FROM objednavky_polozky op
      LEFT JOIN produkty p ON op.produkt_id = p.id
      WHERE op.objednavka_id = $1
    `, [objednavkaId])).rows.map(p => ({ ...p, nazev: p.nazev || p.produkt_nazev || NAZEV_BEZ_PRODUKTU }));
}

// Další číslo v roční řadě (tabulka je pevný název z kódu, ne vstup)
async function dalsiCislo(client, tabulka, rok) {
  await client.query(`INSERT INTO ${tabulka} (rok, posledni_cislo) VALUES ($1, 0) ON CONFLICT (rok) DO NOTHING`, [rok]);
  const r = await client.query(`UPDATE ${tabulka} SET posledni_cislo = posledni_cislo + 1 WHERE rok=$1 RETURNING posledni_cislo`, [rok]);
  return String(r.rows[0].posledni_cislo).padStart(3, '0');
}

async function ulozitDoklad(client, { objednavkaId, druh, cislo, ted, snimek }) {
  const html = vykreslitDokument(snimek);
  return (await client.query(
    `INSERT INTO faktury (objednavka_id, druh, cislo, datum_vystaveni, data, html, html_sha256, sablona_verze)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [objednavkaId, druh, cislo, ted, JSON.stringify(snimek), html, otisk(html), SABLONA_VERZE]
  )).rows[0];
}

async function vystavitFakturu(pool, objednavkaId, { ted = new Date() } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await nacistObjednavkuProDoklad(client, objednavkaId);
    if (!o) { await client.query('ROLLBACK'); return { stav: 'nenalezena' }; }

    const ulozena = (await client.query(`SELECT * FROM faktury WHERE objednavka_id = $1 AND druh = 'faktura'`, [objednavkaId])).rows[0];
    if (ulozena) { await client.query('ROLLBACK'); return { stav: 'ulozena', faktura: overitUlozenou(ulozena), stav_objednavky: o.stav }; }
    if (o.faktura_cislo) { await client.query('ROLLBACK'); return { stav: 'historicka', faktura_cislo: o.faktura_cislo, faktura_datum: o.faktura_datum, stav_objednavky: o.stav }; }
    if (o.stav === 'zrusena') { await client.query('ROLLBACK'); return { stav: 'zrusena' }; }

    const polozky = await nacistPolozkyProDoklad(client, objednavkaId);

    // Nesouhlasící nebo neověřitelné částky = žádná faktura (před přidělením čísla)
    const chyba = chybaCastek(o, polozky);
    if (chyba) { await client.query('ROLLBACK'); return { stav: 'nelze', chyba }; }

    const rok = rokVPraze(ted);
    const cislo = `${rok}${await dalsiCislo(client, 'faktury_cislovani', rok)}`;
    const snimek = sestavitSnimek({ ...o, polozky }, { faktura_cislo: cislo, faktura_datum: ted });
    const faktura = await ulozitDoklad(client, { objednavkaId, druh: 'faktura', cislo, ted, snimek });
    await client.query('UPDATE objednavky SET faktura_cislo=$1, faktura_datum=$2 WHERE id=$3', [cislo, ted, objednavkaId]);
    await client.query('COMMIT');
    return { stav: 'vystavena', faktura, stav_objednavky: o.stav };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Opravný doklad (storno) při zrušení objednávky s fakturou. Volá se UVNITŘ
// transakce zrušení (client, řádek objednávky už zamčený), takže zrušení,
// vrácení skladu/poukazu a storno se uloží buď všechny, nebo žádné. Výsledek:
//   'vystaveno'    - právě vystavený doklad (doklad = uložený řádek)
//   'ulozeno'      - storno už existuje, vrací se beze změny
//   'bez_faktury'  - objednávka fakturu nemá, není co stornovat
// Storno vychází z uložené faktury; u historické faktury (bez originálu) ze
// současných údajů objednávky a je to na dokladu uvedeno.
async function vystavitStorno(client, objednavkaId, { ted = new Date(), duvod = 'Zrušení objednávky' } = {}) {
  const ulozene = (await client.query(`SELECT * FROM faktury WHERE objednavka_id = $1 AND druh = 'storno'`, [objednavkaId])).rows[0];
  if (ulozene) return { stav: 'ulozeno', doklad: overitUlozenou(ulozene) };

  let puvodni, historicka = false;
  const faktura = (await client.query(`SELECT * FROM faktury WHERE objednavka_id = $1 AND druh = 'faktura'`, [objednavkaId])).rows[0];
  if (faktura) {
    puvodni = overitUlozenou(faktura).data;
  } else {
    const o = await nacistObjednavkuProDoklad(client, objednavkaId);
    if (!o || !o.faktura_cislo) return { stav: 'bez_faktury' };
    const polozky = await nacistPolozkyProDoklad(client, objednavkaId);
    puvodni = sestavitSnimek({ ...o, polozky }, { faktura_cislo: o.faktura_cislo, faktura_datum: o.faktura_datum });
    historicka = true;
  }

  const rok = rokVPraze(ted);
  const cislo = `OD${rok}${await dalsiCislo(client, 'opravne_doklady_cislovani', rok)}`;
  const snimek = sestavitStorno(puvodni, { cislo, datum_vystaveni: ted, duvod, historicka });
  const doklad = await ulozitDoklad(client, { objednavkaId, druh: 'storno', cislo, ted, snimek });
  return { stav: 'vystaveno', doklad };
}

module.exports = { migrovatFaktury, vystavitFakturu, vystavitStorno, overitUlozenou, otisk, chybaCastek, HISTORICKA_UPOZORNENI, NAZEV_BEZ_PRODUKTU };
