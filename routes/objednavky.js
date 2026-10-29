const { odeslat_potvrzeni, odeslat_upozorneni_objednavky, odeslat_email_zmena_stavu, odeslat_fakturu, odeslat_storno } = require('./emaily');
const { fakturaHtml } = require('../lib/faktura');
const { migrovatFaktury, vystavitFakturu, vystavitStorno, overitUlozenou, HISTORICKA_UPOZORNENI, NAZEV_BEZ_PRODUKTU } = require('../lib/vystaveniFaktury');
const { poukazPoPlatnosti } = require('../lib/poukazPlatnost');

// Stavy, u kterých se zákazníkovi posílá informační e-mail o změně stavu
// (viz STAV_OBJEDNAVKY_EMAIL v routes/emaily.js).
const STAVY_S_EMAILEM = ['vyrizuje', 'zaplacena', 'odeslana', 'dorucena', 'zrusena'];
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { pripravit } = require('../lib/startServeru');
const vyzadovatAdmina = require('../middleware/adminAuth');
const { jeZablokovana, zaznamenatObjednavku } = require('../middleware/objednavkyLimiter');
const { migrovatSnapshoty, SQL_UDAJE_OBJEDNAVKY } = require('../lib/objednavkySnapshot');
const { METODY, nacistNastaveniDopravy, jeDostupna, vypocitatCenuDopravy, typVydejnihoMista, dobirkaDostupna, priplatekPlatby } = require('../lib/doprava');
const { overitVydejniMisto } = require('../lib/glsVydejniMista');
const zasilkovna = require('../lib/zasilkovna');
const zasilkovnaApi = require('../lib/zasilkovnaApi');
const gls = require('../lib/gls');

// Idempotentní migrace - vazba objednávky na uplatněný dárkový poukaz, číslo
// objednávky a číslo/datum vystavení faktury.
//
// Dvě NEZÁVISLÁ číslování, záměrně oddělená (viz konverzace se zákaznicí):
//   - cislo (RRMMNN, např. 261001) - "hezké" zákaznicko-účetní číslo
//     objednávky. Přiděluje se HNED při vzniku objednávky (viditelné okamžitě
//     všude - admin, e-maily, "Moje objednávky"), RR/MM je rok/měsíc vzniku,
//     NN je pořadí v rámci CELÉHO ROKU (nerestartuje se každý měsíc).
//     objednavky_cislovani drží poslední použité pořadí PER ROK.
//   - faktura_cislo (RRRRNNN, např. 2026001) - čistě účetní číslo faktury,
//     přiděluje se AŽ při prvním vytištění (ne při vzniku objednávky), ať
//     testovací/zrušené objednávky nezpůsobí díry v účetní řadě. Nezávislé
//     počítadlo faktury_cislovani, RESETUJE se každý rok na 1.
async function initObjednavkySloupce() {
  try {
    await pool.query(`
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS poukaz_id INTEGER;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS sleva NUMERIC NOT NULL DEFAULT 0;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS cislo TEXT UNIQUE;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS faktura_cislo TEXT UNIQUE;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS faktura_datum TIMESTAMPTZ;
      -- Kdy admin naposledy poslal fakturu zákazníkovi e-mailem (2026-10)
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS faktura_odeslano TIMESTAMPTZ;
      -- Kdy admin naposledy poslal opravný doklad (storno faktury) e-mailem
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS storno_odeslano TIMESTAMPTZ;
      -- Okamžiky v životě objednávky (2026-10), každý zvlášť a nezaměňují se:
      -- úhrada, expedice (odeslání) a dodání se zapíšou při PRVNÍ změně stavu na
      -- zaplacena / odeslana / dorucena v adminu, zrušení při zrušení. Dodání
      -- = majitelka v adminu označila jako doručené (dopravce ho zatím nepotvrzuje).
      -- Starší objednávky zůstávají NULL - nic se zpětně nedoplňuje.
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS zaplaceno_at TIMESTAMPTZ;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS expedovano_at TIMESTAMPTZ;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS dodano_at TIMESTAMPTZ;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS zruseno_at TIMESTAMPTZ;
      -- Doprava (2026-10): skutečná cena dopravy v době objednávky, dopravce a
      -- výdejní místo (obecně, ne jen GLS - později i Zásilkovna). Údaje místa se
      -- berou z ověřeného seznamu dopravce, ne z prohlížeče. Starší objednávky
      -- zůstávají NULL (cena dopravy se u nich dopočítá jako dřív).
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS doprava_cena NUMERIC;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS dopravce TEXT;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS vydejni_misto_id TEXT;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS vydejni_misto_nazev TEXT;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS vydejni_misto_ulice TEXT;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS vydejni_misto_mesto TEXT;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS vydejni_misto_psc TEXT;
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS vydejni_misto_stat TEXT;
      -- Příplatek za způsob platby (dobírka) v době objednávky; jinak 0 / NULL
      ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS platba_priplatek NUMERIC;
      CREATE TABLE IF NOT EXISTS objednavky_cislovani (
        rok INTEGER PRIMARY KEY,
        posledni_cislo INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS faktury_cislovani (
        rok INTEGER PRIMARY KEY,
        posledni_cislo INTEGER NOT NULL DEFAULT 0
      );
    `);
    console.log('Objednavky sloupce OK');
  } catch (e) {
    console.log('Objednavky sloupce chyba:', e.message);
  }
  // Zvlášť: víc příkazů v jednom dotazu běží jako jedna transakce, takže chyba
  // u zásilek by jinak vrátila i nové sloupce objednávek, na kterých stojí ukládání objednávek.
  // Zásilky u dopravců (připraveno pro MyGLS API, zatím se nic nevytváří).
  // Přístupové údaje k API sem nepatří - jsou jen v proměnných prostředí.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS zasilky (
        id SERIAL PRIMARY KEY,
        objednavka_id INTEGER NOT NULL REFERENCES objednavky(id) ON DELETE CASCADE,
        dopravce TEXT NOT NULL,
        stav TEXT NOT NULL DEFAULT 'pripravena',
        cislo_zasilky TEXT,
        tracking_url TEXT,
        data JSONB,
        chyba TEXT,
        vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        aktualizovano TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS zasilky_objednavka_idx ON zasilky (objednavka_id);
      -- štítek PDF, který GLS vrátí při založení zásilky
      ALTER TABLE zasilky ADD COLUMN IF NOT EXISTS stitek_pdf BYTEA;
    `);
    console.log('Zasilky OK');
  } catch (e) {
    console.log('Zasilky chyba:', e.message);
  }
  // Neměnné faktury (tabulka faktury + ochrana čísla faktury) - zvlášť, až po
  // sloupcích faktura_cislo/faktura_datum výše, na kterých trigger stojí.
  try {
    await migrovatFaktury(pool);
    console.log('Faktury OK');
  } catch (e) {
    console.log('Faktury chyba:', e.message);
  }
  try {
    const bezSnimku = await migrovatSnapshoty(pool);
    if (bezSnimku.length) {
      // Nemělo by nastat (každá objednávka má zákazníka) - jen nahlásit, nic nevymýšlet.
      console.log('Objednavky bez snimku udaju (zustava fallback na zakaznika):', bezSnimku.map(o => o.cislo || o.id).join(', '));
    } else {
      console.log('Snimky udaju objednavek OK');
    }
  } catch (e) {
    console.log('Snimky udaju objednavek chyba:', e.message);
  }
}
pripravit(initObjednavkySloupce());

// Přidělí "hezké" číslo objednávky (RRMMNN) - volá se uvnitř JIŽ OTEVŘENÉ
// transakce hned po INSERT INTO objednavky (viz POST / níže), ne lazy jako
// faktura_cislo. RR/MM je rok/měsíc PRÁVĚ TEĎ (vznik objednávky), NN je
// pořadové číslo v rámci roku (points to objednavky_cislovani, klíčované
// 4místným rokem - i když zobrazený tvar má rok jen 2místný).
async function pridelitCisloObjednavky(client, objednavkaId) {
  const ted = new Date();
  const rok4 = ted.getFullYear();
  const rok2 = String(rok4).slice(-2);
  const mesic2 = String(ted.getMonth() + 1).padStart(2, '0');
  await client.query('INSERT INTO objednavky_cislovani (rok, posledni_cislo) VALUES ($1, 0) ON CONFLICT (rok) DO NOTHING', [rok4]);
  const pocitadlo = await client.query('UPDATE objednavky_cislovani SET posledni_cislo = posledni_cislo + 1 WHERE rok=$1 RETURNING posledni_cislo', [rok4]);
  const cislo = `${rok2}${mesic2}${String(pocitadlo.rows[0].posledni_cislo).padStart(2, '0')}`;
  await client.query('UPDATE objednavky SET cislo=$1 WHERE id=$2', [cislo, objednavkaId]);
  return cislo;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFON_RE = /^(\+420\s?)?\d{3}\s?\d{3}\s?\d{3}$/;
const PSC_RE = /^\d{3}\s?\d{2}$/;

// Doprava a platba jen z nabídky e-shopu - dřív se uložil jakýkoli text
// (do adminu i e-mailu) a neznámá doprava se účtovala jako Zásilkovna.
// Nabízené způsoby a ceny jsou v nastavení dopravy (admin -> Nastavení -> Doprava).
// Na e-shopu převod (QR kód); při osobním odběru i platba na prodejně (hotově,
// kartou, QR) - majitelka 2026-10-07. Dobírka znovu od 2026-10-08 s příplatkem
// z nastavení dopravy (ne u osobního odběru).
const POVOLENE_PLATBY = ['prevod', 'na_prodejne', 'dobirka'];
function validovatDopravuAPlatbu({ doprava, platba }, nastaveniDopravy) {
  if (typeof doprava !== 'string' || !jeDostupna(nastaveniDopravy, doprava)) return 'Vyberte prosím způsob dopravy.';
  if (!POVOLENE_PLATBY.includes(platba)) return 'Vyberte prosím způsob platby.';
  if (platba === 'na_prodejne' && doprava !== 'osobni_odber') return 'Platba na prodejně je možná jen při osobním odběru.';
  if (platba === 'dobirka' && !dobirkaDostupna(nastaveniDopravy, doprava)) return 'Dobírka u tohoto způsobu dopravy není možná.';
  return null;
}

function validovatObjednavku({ jmeno, email, telefon, ulice, mesto, psc }) {
  if (!jmeno || jmeno.trim().split(/\s+/).length < 2) return 'Zadejte prosím jméno a příjmení.';
  if (!email || !EMAIL_RE.test(email.trim())) return 'Zadejte prosím platnou e-mailovou adresu.';
  if (!telefon || !TELEFON_RE.test(telefon.trim())) return 'Zadejte prosím platné telefonní číslo (např. 777 123 456).';
  if (!ulice || ulice.trim().length < 3) return 'Zadejte prosím ulici a číslo popisné.';
  if (!mesto || mesto.trim().length < 2) return 'Zadejte prosím město.';
  if (!psc || !PSC_RE.test(psc.trim())) return 'Zadejte prosím platné PSČ (např. 768 24).';
  return null;
}

// Vytvorit novou objednavku
router.post('/', async (req, res) => {
  const { jmeno, email, telefon, ulice, mesto, psc, doprava, platba, poznamka, polozky, webova_stranka, poukaz_kod, vydejni_misto_id, vydejni_misto_zasilkovna } = req.body;

  // Honeypot - skryté pole, které reální uživatelé nikdy nevyplní, ale
  // formulářoví boti ano. Předstíráme úspěch, aby se bot nenaučil rozpoznat blokaci.
  if (webova_stranka) {
    return res.json({ zprava: 'Objednavka uspesne vytvorena', objednavka_id: 0, celkem: 0 });
  }

  const zbyvaSekund = jeZablokovana(req.ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho objednávek z tohoto místa. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }

  if (!Array.isArray(polozky) || !polozky.length) {
    return res.status(400).json({ chyba: 'Košík je prázdný.' });
  }

  // Každý vstupní řádek musí projít plnou validací tvaru SÁM O SOBĚ, ještě
  // před agregací duplicitních SKU - jinak by např. jeden záporný a jeden
  // kladný řádek stejného SKU mohly projít jen proto, že jejich součet vyjde
  // kladně (a validní). Server nesmí věřit ničemu cenovému/skladovému, co
  // pošle klient - z každé položky se dál používá jen produkt_id/velikost
  // (k dohledání v DB) a pocet. Cena se vždy dopočítá z produkty.cena níže.
  for (const p of polozky) {
    if (!p || typeof p !== 'object') {
      return res.status(400).json({ chyba: 'Neplatná položka v košíku.' });
    }
    if (!Number.isInteger(p.produkt_id) || p.velikost === undefined || p.velikost === null) {
      return res.status(400).json({ chyba: 'Neplatná položka v košíku.' });
    }
    if (!Number.isInteger(p.pocet) || p.pocet <= 0 || p.pocet > 1000) {
      return res.status(400).json({ chyba: 'Neplatný počet kusů (musí být celé kladné číslo).' });
    }
  }

  // Až TEĎ, po ověření každého jednotlivého řádku, agregovat položky se
  // stejným SKU (produkt_id + velikost) - před zamykáním a kontrolou skladu.
  // Bez agregace by dva řádky se stejným SKU v jednom requestu mohly při
  // kontrole níže vidět stejný (ještě neodečtený) stav skladu a dohromady
  // odečíst víc, než sklad má - FOR UPDATE řeší souběh MEZI požadavky, ne
  // duplicitu UVNITŘ jednoho požadavku.
  const agregovanaMapa = new Map(); // "produkt_id_velikost" -> agregovaná položka
  for (const p of polozky) {
    const klic = `${p.produkt_id}_${p.velikost}`;
    const existujici = agregovanaMapa.get(klic);
    if (existujici) {
      existujici.pocet += p.pocet;
    } else {
      agregovanaMapa.set(klic, { produkt_id: p.produkt_id, velikost: p.velikost, pocet: p.pocet });
    }
  }
  const polozkyAgregovane = [...agregovanaMapa.values()];

  // Znovu ověřit agregovaný počet proti hornímu limitu - jednotlivé řádky
  // mohly být v limitu, ale součet stejného SKU rozdělený do víc řádků ho
  // mohl překročit.
  for (const p of polozkyAgregovane) {
    if (p.pocet > 1000) {
      return res.status(400).json({ chyba: 'Neplatný počet kusů (musí být celé kladné číslo).' });
    }
  }
  const nastaveniDopravy = await nacistNastaveniDopravy(pool);
  const chybaValidace = validovatObjednavku({ jmeno, email, telefon, ulice, mesto, psc }) || validovatDopravuAPlatbu({ doprava, platba }, nastaveniDopravy);
  if (chybaValidace) {
    return res.status(400).json({ chyba: chybaValidace });
  }

  // Výdejní místo: z prohlížeče se bere JEN jeho ID a ověří se proti oficiálnímu
  // seznamu dopravce; název a adresa se ukládají z ověřených dat. U ostatních
  // způsobů dopravy se případně poslané výdejní místo ignoruje.
  let vydejniMisto = null;
  const druhMista = typVydejnihoMista(doprava);
  if (druhMista === 'zasilkovna') {
    // Zásilkovna: údaje z jejího widgetu, přísně zkontrolované (viz lib/zasilkovna.js)
    vydejniMisto = zasilkovna.overitVydejniMisto(vydejni_misto_zasilkovna);
    if (!vydejniMisto) {
      return res.status(400).json({ chyba: 'Pro doručení Zásilkovnou nejprve vyberte výdejní místo.' });
    }
  } else if (druhMista === 'gls') {
    if (!vydejni_misto_id || typeof vydejni_misto_id !== 'string') {
      return res.status(400).json({ chyba: 'Pro doručení do výdejního místa GLS nejprve vyberte výdejní místo.' });
    }
    try {
      vydejniMisto = await overitVydejniMisto(vydejni_misto_id);
    } catch (e) {
      console.error('Ověření výdejního místa GLS selhalo:', e.message);
      return res.status(503).json({ chyba: 'Výdejní místo GLS se teď nepodařilo ověřit. Zkuste to prosím za chvíli, nebo zvolte jiný způsob dopravy.' });
    }
    if (!vydejniMisto) {
      return res.status(400).json({ chyba: 'Vybrané výdejní místo GLS se nepodařilo najít. Vyberte prosím výdejní místo znovu.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Najít nebo vytvořit zákazníka. Existujícímu se údaje NEMĚNÍ - objednávka
    // bez přihlášení nesmí přepsat profil (stačila by znalost cizího e-mailu).
    // Údaje zadané teď patří jen této objednávce (snímek obj_* níže); vazba
    // přes zakaznik_id zůstává, ať je po ověření e-mailu uvidí v účtu.
    let zakaznik = await client.query(
      'SELECT id FROM zakaznici WHERE email = $1', [email]
    );
    let zakaznik_id;
    if (zakaznik.rows.length === 0) {
      const novy = await client.query(
        'INSERT INTO zakaznici (jmeno, email, telefon, ulice, mesto, psc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [jmeno, email, telefon, ulice, mesto, psc]
      );
      zakaznik_id = novy.rows[0].id;
    } else {
      zakaznik_id = zakaznik.rows[0].id;
    }

    // Zkontrolovat sklad (FOR UPDATE - zamkne řádky do konce transakce, aby dvě
    // souběžné objednávky na poslední kus nemohly obě projít kontrolou) a spocitat celkem.
    // Položky "u dodavatele" nemají reálnou sledovanou zásobu - projdou bez ohledu
    // na pocet_kusu a při expedici se ze skladu neodečítají (viz níže).
    let celkem = 0;
    const dostupnostMap = new Map(); // "produkt_id_velikost" -> 'skladem' | 'dodavatel'
    const cenaMap = new Map(); // "produkt_id_velikost" -> aktuální cena z DB (autoritativní, klientovi se nevěří)
    const nazevMap = new Map(); // "produkt_id_velikost" -> název produktu (pro e-maily s potvrzením)
    // Zamyká se v pevném pořadí (produkt_id, velikost), ne v pořadí, v jakém
    // je poslal klient - jinak by dvě souběžné objednávky se stejnými dvěma
    // položkami v opačném pořadí mohly skončit v deadlocku.
    const polozkyKZamceni = [...polozkyAgregovane].sort((a, b) =>
      a.produkt_id - b.produkt_id || a.velikost - b.velikost
    );
    for (const p of polozkyKZamceni) {
      const sklad = await client.query(
        'SELECT s.pocet_kusu, s.dostupnost, p.cena, p.nazev, p.na_eshopu FROM sklad s JOIN produkty p ON p.id = s.produkt_id WHERE s.produkt_id = $1 AND s.velikost = $2 FOR UPDATE',
        [p.produkt_id, p.velikost]
      );
      if (sklad.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: `Nedostatek zbozi na sklade: produkt ${p.produkt_id} velikost ${p.velikost}` });
      }
      const radek = sklad.rows[0];
      // Produkt skrytý v adminu (jen pro prodejnu) - mohl zůstat zákazníkovi
      // v košíku z dřívějška, objednat ho přes e-shop ale nejde.
      if (!radek.na_eshopu) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: `Produkt "${radek.nazev}" už není v nabídce e-shopu. Odeberte ho prosím z košíku.` });
      }
      const jeUDodavatele = radek.dostupnost === 'dodavatel';
      if (!jeUDodavatele && radek.pocet_kusu < p.pocet) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: `Nedostatek zbozi na sklade: produkt ${p.produkt_id} velikost ${p.velikost}` });
      }
      const klic = `${p.produkt_id}_${p.velikost}`;
      const cenaSkutecna = Number(radek.cena);
      dostupnostMap.set(klic, radek.dostupnost);
      cenaMap.set(klic, cenaSkutecna);
      nazevMap.set(klic, radek.nazev);
      celkem += cenaSkutecna * p.pocet;
    }

    const mezisoucet = celkem;

    // Uplatnit dárkový poukaz (pokud je zadaný) - stejná transakce jako sklad,
    // ať se poukaz odečte, jen když se objednávka opravdu založí (a naopak).
    // FOR UPDATE zamkne řádek poukazu, aby ho nešlo dvakrát souběžně přečerpat.
    let poukaz_id = null, sleva = 0, poukazZustatek = 0, poukazZbyva = null;
    if (poukaz_kod) {
      const kodNorm = String(poukaz_kod).trim().toUpperCase();
      const poukazRes = await client.query(
        'SELECT * FROM darkove_poukazy WHERE (UPPER(kod) = $1 OR ean = $1) FOR UPDATE',
        [kodNorm]
      );
      if (poukazRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Poukaz nebyl nalezen.' });
      }
      const poukaz = poukazRes.rows[0];
      if (poukaz.stav !== 'aktivni' || Number(poukaz.zustatek) <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Tento poukaz je již plně vyčerpaný nebo zrušený.' });
      }
      if (poukazPoPlatnosti(poukaz.platnost_do)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ chyba: 'Platnost poukazu vypršela.' });
      }
      poukaz_id = poukaz.id;
      poukazZustatek = Number(poukaz.zustatek);
      poukazZbyva = { platnost_do: poukaz.platnost_do };
    }

    // Doprava - podle zvoleného způsobu, osobní odběr je vždy zdarma. Hranice
    // dopravy zdarma se počítá ze zboží po odečtení poukazu.
    const dopravaCena = vypocitatCenuDopravy(nastaveniDopravy, doprava, mezisoucet - Math.min(poukazZustatek, mezisoucet));
    // Příplatek za dobírku se platí vždy (i při dopravě zdarma)
    const platbaPriplatek = priplatekPlatby(nastaveniDopravy, doprava, platba);
    // Poukaz platí i dopravu a příplatek; co z něj zbude, zůstává na poukazu
    sleva = Math.min(poukazZustatek, mezisoucet + dopravaCena + platbaPriplatek);
    celkem = mezisoucet - sleva + dopravaCena + platbaPriplatek;
    if (poukaz_id && celkem === 0 && platba === 'dobirka') {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: 'Objednávku celou uhradí poukaz – dobírka tu nedává smysl. Zvolte prosím jinou platbu.' });
    }
    if (poukazZbyva) poukazZbyva.zustatek = poukazZustatek - sleva;

    // Vytvorit objednavku
    const objednavka = await client.query(
      `INSERT INTO objednavky (zakaznik_id, doprava, platba, celkem, poznamka, poukaz_id, sleva,
                               obj_jmeno, obj_email, obj_telefon, obj_ulice, obj_mesto, obj_psc,
                               doprava_cena, dopravce, vydejni_misto_id, vydejni_misto_nazev,
                               vydejni_misto_ulice, vydejni_misto_mesto, vydejni_misto_psc, vydejni_misto_stat, platba_priplatek)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id, vytvoreno`,
      [zakaznik_id, doprava, platba, celkem, poznamka, poukaz_id, sleva, jmeno, email, telefon, ulice, mesto, psc,
        dopravaCena, METODY[doprava].dopravce,
        vydejniMisto ? vydejniMisto.id : null, vydejniMisto ? vydejniMisto.nazev : null,
        vydejniMisto ? vydejniMisto.ulice : null, vydejniMisto ? vydejniMisto.mesto : null,
        vydejniMisto ? vydejniMisto.psc : null, vydejniMisto ? vydejniMisto.stat : null, platbaPriplatek]
    );
    const objednavka_id = objednavka.rows[0].id;
    const cislo = await pridelitCisloObjednavky(client, objednavka_id);

    // Pokud byl uplatněn poukaz, teď skutečně odečíst zůstatek
    if (poukaz_id) {
      await client.query(
        'UPDATE darkove_poukazy SET zustatek = zustatek - $1, stav = CASE WHEN zustatek - $1 <= 0 THEN \'pouzity\' ELSE stav END WHERE id = $2',
        [sleva, poukaz_id]
      );
      await client.query(
        'INSERT INTO poukazy_pouziti (poukaz_id, castka, objednavka_id) VALUES ($1,$2,$3)',
        [poukaz_id, sleva, objednavka_id]
      );
    }

    // Vlozit polozky (agregované - jeden řádek na SKU) a odecist ze skladu
    // (u položek "u dodavatele" se sklad neodečítá - pocet_kusu tam
    // nereprezentuje reálnou fyzickou zásobu)
    for (const p of polozkyAgregovane) {
      const klic = `${p.produkt_id}_${p.velikost}`;
      await client.query(
        'INSERT INTO objednavky_polozky (objednavka_id, produkt_id, velikost, pocet, cena) VALUES ($1,$2,$3,$4,$5)',
        [objednavka_id, p.produkt_id, p.velikost, p.pocet, cenaMap.get(klic)]
      );
      if (dostupnostMap.get(klic) !== 'dodavatel') {
        await client.query(
          'UPDATE sklad SET pocet_kusu = pocet_kusu - $3 WHERE produkt_id = $1 AND velikost = $2',
          [p.produkt_id, p.velikost, p.pocet]
        );
        await client.query(
          'INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES ($1,$2,$3,$4,$5)',
          [p.produkt_id, p.velikost, 'prodej', p.pocet, `Objednavka #${objednavka_id}`]
        );
      }
    }

    await client.query('COMMIT');
    zaznamenatObjednavku(req.ip);

    // Do emailu jde vždy jen skutečná (DB) cena, ne to, co poslal klient.
    const polozkySkutecne = polozkyAgregovane.map(p => ({
      ...p,
      cena: cenaMap.get(`${p.produkt_id}_${p.velikost}`),
      nazev: nazevMap.get(`${p.produkt_id}_${p.velikost}`)
    }));

    // Odeslat potvrzovaci email
try {
  await odeslat_potvrzeni({
    objednavka_id,
    cislo,
    celkem,
    jmeno,
    email,
    telefon,
    ulice,
    mesto,
    psc,
    doprava,
    platba,
    polozky: polozkySkutecne,
    sleva,
    poukaz_zbyva: poukazZbyva,
    doprava_cena: dopravaCena,
    platba_priplatek: platbaPriplatek,
    vydejni_misto: vydejniMisto,
    // Datum a čas objednávky do potvrzení (ne datum uzavření smlouvy)
    vytvoreno: objednavka.rows[0].vytvoreno
  });
} catch (emailErr) {
  console.error('Chyba pri odesilani emailu:', emailErr.message);
}

res.json({ zprava: 'Objednavka uspesne vytvorena', objednavka_id, cislo, celkem, poukaz_zbyva: poukazZbyva });

// Upozornění majitelce se posílá až po odpovědi zákazníkovi, ať prodleva/chyba
// s odesláním objednávku nezablokuje (stejný vzor jako u rezervací).
odeslat_upozorneni_objednavky({
  objednavka_id, cislo, celkem, jmeno, email, telefon, ulice, mesto, psc, doprava, platba, polozky: polozkySkutecne, sleva,
  doprava_cena: dopravaCena, platba_priplatek: platbaPriplatek, vydejni_misto: vydejniMisto
}).catch(e => console.error('Upozorneni majitelce o objednavce se nepodarilo odeslat:', e.message));

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// Ziskat vsechny objednavky (jen pro admin – obsahuje osobní údaje zákazníků)
router.get('/', vyzadovatAdmina, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.id, o.cislo, o.stav, o.doprava, o.platba, o.celkem, o.vytvoreno, o.vydejni_misto_nazev, o.zakaznik_id,
             ${SQL_UDAJE_OBJEDNAVKY}
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      ORDER BY o.vytvoreno DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Objednávka s položkami (detail v adminu, faktura)
async function nacistObjednavku(id) {
  const objednavka = await pool.query(`
      SELECT o.*, ${SQL_UDAJE_OBJEDNAVKY}, dp.kod AS poukaz_kod
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      LEFT JOIN darkove_poukazy dp ON o.poukaz_id = dp.id
      WHERE o.id = $1
    `, [id]);
  if (!objednavka.rows.length) return null;
  // LEFT JOIN: produkt smazaný z katalogu položku nevypustí (cena a počet jsou
  // uložené u položky). Název z položky, pokud ho schéma má, jinak z katalogu,
  // jinak náhradní text - stejně jako při vystavení faktury.
  const polozky = await pool.query(`
      SELECT op.*, p.nazev AS produkt_nazev, p.znacka AS produkt_znacka
      FROM objednavky_polozky op
      LEFT JOIN produkty p ON op.produkt_id = p.id
      WHERE op.objednavka_id = $1
    `, [id]);
  return { ...objednavka.rows[0], polozky: polozky.rows.map(({ produkt_nazev, produkt_znacka, ...p }) => ({
    ...p, nazev: p.nazev || produkt_nazev || NAZEV_BEZ_PRODUKTU, znacka: p.znacka || produkt_znacka || null
  })) };
}

// Detail objednavky (jen pro admin)
router.get('/:id', vyzadovatAdmina, async (req, res) => {
  try {
    const o = await nacistObjednavku(req.params.id);
    if (!o) return res.status(404).json({ chyba: 'Objednávka nenalezena.' });

    // Zásilky u dopravců (bez interních dat odpovědi API)
    let zasilky = [];
    try {
      zasilky = (await pool.query(
        "SELECT id, dopravce, stav, cislo_zasilky, tracking_url, vytvoreno, data->>'prostredi' AS prostredi FROM zasilky WHERE objednavka_id = $1 ORDER BY id", [req.params.id]
      )).rows;
    } catch (e) { /* tabulka zásilek není povinná pro zobrazení objednávky */ }

    // Uložená faktura (bez HTML) - u čísla faktury bez uloženého dokladu jde o historickou
    let fakturaUlozena = null, storno = null;
    try {
      fakturaUlozena = (await pool.query("SELECT cislo, datum_vystaveni, sablona_verze FROM faktury WHERE objednavka_id = $1 AND druh = 'faktura'", [req.params.id])).rows[0] || null;
      storno = (await pool.query("SELECT cislo, datum_vystaveni FROM faktury WHERE objednavka_id = $1 AND druh = 'storno'", [req.params.id])).rows[0] || null;
    } catch (e) { /* bez tabulky faktur se detail ukáže i tak */ }

    res.json({ ...o, zasilky, faktura_ulozena: fakturaUlozena, storno,zasilkovna_podani: zasilkovnaApi.stav().podani, gls_podani: gls.stav().podani, gls_prostredi: gls.stav().prostredi });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Podání zásilky do Zásilkovny (jen admin, jen na výslovný klik). Objednávka se
// po dobu volání zamkne, aby dvojklik nezaložil dvě zásilky.
router.post('/:id/zasilkovna', vyzadovatAdmina, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ chyba: 'Neplatná objednávka.' });
  if (!zasilkovnaApi.stav().podani) return res.status(503).json({ chyba: 'Podání do Zásilkovny není zapnuté (chybí API heslo na Renderu).' });
  const vaha = Number(req.body && req.body.vaha);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(`SELECT o.*, ${SQL_UDAJE_OBJEDNAVKY} FROM objednavky o JOIN zakaznici z ON o.zakaznik_id = z.id WHERE o.id = $1 FOR UPDATE OF o`, [id])).rows[0];
    if (!o) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Objednávka nenalezena.' }); }
    if (o.stav === 'zrusena') { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'Zrušenou objednávku nejde podat.' }); }
    const existujici = (await client.query("SELECT cislo_zasilky FROM zasilky WHERE objednavka_id = $1 AND dopravce = 'zasilkovna' AND cislo_zasilky IS NOT NULL", [id])).rows[0];
    if (existujici) { await client.query('ROLLBACK'); return res.status(409).json({ chyba: `Zásilka už je podaná (${existujici.cislo_zasilky}).` }); }
    let atributy;
    try { atributy = zasilkovnaApi.sestavitZasilku(o, vaha); }
    catch (e) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: e.message }); }
    let vysledek;
    try {
      vysledek = await zasilkovnaApi.vytvoritZasilku(o, vaha);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Podání do Zásilkovny selhalo (objednávka ' + id + '):', e.message);
      return res.status(502).json({ chyba: 'Zásilkovna zásilku nepřijala: ' + e.message });
    }
    const zasilka = (await client.query(
      `INSERT INTO zasilky (objednavka_id, dopravce, stav, cislo_zasilky, tracking_url, data)
       VALUES ($1, 'zasilkovna', 'podana', $2, $3, $4) RETURNING id, dopravce, stav, cislo_zasilky, tracking_url, vytvoreno`,
      [id, vysledek.barcode, zasilkovnaApi.sledovaniUrl(vysledek.barcode),
        JSON.stringify({ packetId: vysledek.packetId, barcodeText: vysledek.barcodeText, vaha: atributy.weight, hodnota: atributy.value, vydejniMisto: atributy.addressId })]
    )).rows[0];
    await client.query('COMMIT');
    res.json({ zprava: 'Zásilka podána do Zásilkovny', zasilka });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Podání do Zásilkovny - chyba:', err.message);
    res.status(500).json({ chyba: 'Zásilku se nepodařilo uložit.' });
  } finally {
    client.release();
  }
});

// Podání zásilky do GLS (jen admin, jen na výslovný klik). Testovací prostředí
// MyGLS jde zkoušet hned, ostré jen s GLS_ENABLED (viz lib/gls.js).
router.post('/:id/gls', vyzadovatAdmina, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ chyba: 'Neplatná objednávka.' });
  const stavGls = gls.stav();
  if (!stavGls.podani) return res.status(503).json({ chyba: 'Podání do GLS není zapnuté. ' + (stavGls.problem || '') });
  const pocetBaliku = req.body && req.body.pocet !== undefined ? Number(req.body.pocet) : 1;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(`SELECT o.*, ${SQL_UDAJE_OBJEDNAVKY} FROM objednavky o JOIN zakaznici z ON o.zakaznik_id = z.id WHERE o.id = $1 FOR UPDATE OF o`, [id])).rows[0];
    if (!o) { await client.query('ROLLBACK'); return res.status(404).json({ chyba: 'Objednávka nenalezena.' }); }
    if (o.stav === 'zrusena') { await client.query('ROLLBACK'); return res.status(400).json({ chyba: 'Zrušenou objednávku nejde podat.' }); }
    const existujici = (await client.query("SELECT cislo_zasilky FROM zasilky WHERE objednavka_id = $1 AND dopravce = 'gls' AND cislo_zasilky IS NOT NULL AND stav = 'podana'", [id])).rows[0];
    if (existujici) { await client.query('ROLLBACK'); return res.status(409).json({ chyba: `Zásilka už je podaná (${existujici.cislo_zasilky}).` }); }
    try { gls.sestavitZasilku(o, 1, pocetBaliku); }
    catch (e) { await client.query('ROLLBACK'); return res.status(400).json({ chyba: e.message }); }
    let vysledek;
    try {
      vysledek = await gls.vytvoritZasilku(o, { pocetBaliku });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Podání do GLS selhalo (objednávka ' + id + '):', e.message);
      return res.status(502).json({ chyba: 'GLS zásilku nepřijalo: ' + e.message });
    }
    const zasilka = (await client.query(
      `INSERT INTO zasilky (objednavka_id, dopravce, stav, cislo_zasilky, tracking_url, data, stitek_pdf)
       VALUES ($1, 'gls', 'podana', $2, $3, $4, $5) RETURNING id, dopravce, stav, cislo_zasilky, tracking_url, vytvoreno, data`,
      [id, vysledek.parcelNumber, gls.sledovaniUrl(vysledek.parcelNumber),
        JSON.stringify({ parcelId: vysledek.parcelId, prostredi: vysledek.prostredi, pocetBaliku, vydejniMisto: o.vydejni_misto_id || null }), vysledek.pdf]
    )).rows[0];
    await client.query('COMMIT');
    const { data, ...bezDat } = zasilka;
    res.json({ zprava: 'Zásilka podána do GLS', zasilka: { ...bezDat, prostredi: data.prostredi } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Podání do GLS - chyba:', err.message);
    res.status(500).json({ chyba: 'Zásilku se nepodařilo uložit.' });
  } finally {
    client.release();
  }
});

// Štítek PDF k zásilce GLS: uložený při podání, jinak se stáhne z MyGLS
router.get('/:id/gls/stitek', vyzadovatAdmina, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ chyba: 'Neplatná objednávka.' });
  try {
    const z = (await pool.query("SELECT data, cislo_zasilky, stitek_pdf FROM zasilky WHERE objednavka_id = $1 AND dopravce = 'gls' AND cislo_zasilky IS NOT NULL ORDER BY id DESC LIMIT 1", [id])).rows[0];
    if (!z || !z.data || !z.data.parcelId) return res.status(404).json({ chyba: 'Objednávka nemá podanou zásilku GLS.' });
    const pdf = z.stitek_pdf || await gls.stitekPdf(z.data.parcelId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="stitek-gls-${String(z.cislo_zasilky).replace(/[^0-9]/g, '')}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('Štítek GLS selhal (objednávka ' + id + '):', e.message);
    res.status(502).json({ chyba: 'Štítek se nepodařilo stáhnout: ' + e.message });
  }
});

// Štítek PDF k podané zásilce Zásilkovny
router.get('/:id/zasilkovna/stitek', vyzadovatAdmina, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ chyba: 'Neplatná objednávka.' });
  const format = zasilkovnaApi.FORMATY_STITKU.includes(req.query.format) ? req.query.format : 'A6 on A4';
  try {
    const z = (await pool.query("SELECT data, cislo_zasilky FROM zasilky WHERE objednavka_id = $1 AND dopravce = 'zasilkovna' AND cislo_zasilky IS NOT NULL ORDER BY id DESC LIMIT 1", [id])).rows[0];
    if (!z || !z.data || !z.data.packetId) return res.status(404).json({ chyba: 'Objednávka nemá podanou zásilku Zásilkovny.' });
    const pdf = await zasilkovnaApi.stitekPdf(z.data.packetId, format);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="stitek-${String(z.cislo_zasilky).replace(/[^A-Za-z0-9]/g, '')}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('Štítek Zásilkovny selhal (objednávka ' + id + '):', e.message);
    res.status(502).json({ chyba: 'Štítek se nepodařilo stáhnout: ' + e.message });
  }
});

// Faktura: vystaví se jednou (číslo + uložená neměnná podoba, lib/vystaveniFaktury.js),
// každý další tisk i e-mail použije přesně uloženou podobu. Historická faktura
// (číslo z doby před ukládáním) originál nemá - tisk ukáže jasně označenou
// rekonstrukci, e-mailem se neposílá.
const CHYBY_FAKTURY = {
  nenalezena: [404, 'Objednávka nenalezena.'],
  zrusena: [400, 'Ke zrušené objednávce se faktura nevystavuje.']
};
// Odpoví chybou, když faktura nevznikla (true = odpovězeno). 'nelze' = částky
// nesouhlasí nebo nejdou ověřit - nic se neuložilo ani nespotřebovalo číslo.
function odpovedetChybouFaktury(res, v) {
  if (v.stav === 'nelze') { res.status(422).json({ chyba: 'Fakturu nelze vystavit: ' + v.chyba }); return true; }
  if (CHYBY_FAKTURY[v.stav]) { res.status(CHYBY_FAKTURY[v.stav][0]).json({ chyba: CHYBY_FAKTURY[v.stav][1] }); return true; }
  return false;
}

// Vystavit (nebo vrátit už vystavenou) fakturu - jen číslo a datum
router.post('/:id/faktura', vyzadovatAdmina, async (req, res) => {
  try {
    const v = await vystavitFakturu(pool, req.params.id);
    if (odpovedetChybouFaktury(res, v)) return;
    if (v.stav === 'historicka') return res.json({ faktura_cislo: v.faktura_cislo, faktura_datum: v.faktura_datum, historicka: true });
    res.json({ faktura_cislo: v.faktura.cislo, faktura_datum: v.faktura.datum_vystaveni });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Faktura jako hotová stránka (tisk v adminu) - uložená podoba dokladu
router.post('/:id/faktura-html', vyzadovatAdmina, async (req, res) => {
  try {
    const v = await vystavitFakturu(pool, req.params.id);
    if (odpovedetChybouFaktury(res, v)) return;
    if (v.stav === 'historicka') {
      const o = await nacistObjednavku(req.params.id);
      const faktura = { faktura_cislo: v.faktura_cislo, faktura_datum: v.faktura_datum };
      return res.json({ ...faktura, historicka: true, html: fakturaHtml(o, faktura, { rekonstrukce: HISTORICKA_UPOZORNENI }) });
    }
    res.json({ faktura_cislo: v.faktura.cislo, faktura_datum: v.faktura.datum_vystaveni, html: v.faktura.html });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Poslat fakturu zákazníkovi e-mailem (jen na klik v adminu) - uloženou podobu.
// Zrušená objednávka (i s už vystavenou fakturou) ani historická faktura bez
// originálu se neposílá. Tisk originálu zrušené objednávky zůstává povolený.
router.post('/:id/faktura-email', vyzadovatAdmina, async (req, res) => {
  try {
    const o = await nacistObjednavku(req.params.id);
    if (!o) return res.status(404).json({ chyba: 'Objednávka nenalezena.' });
    if (!o.email) return res.status(400).json({ chyba: 'Objednávka nemá e-mail zákazníka.' });
    const ZRUSENA = 'Fakturu zrušené objednávky nelze posílat e-mailem.';
    if (o.stav === 'zrusena') return res.status(400).json({ chyba: ZRUSENA });
    const v = await vystavitFakturu(pool, req.params.id);
    if (odpovedetChybouFaktury(res, v)) return;
    if (v.stav === 'historicka') {
      return res.status(409).json({ chyba: `Faktura ${v.faktura_cislo} byla vystavena před zavedením ukládání faktur a její originál v systému není – e-mailem se proto neposílá. Vytisknout jde jen jako označená rekonstrukce.` });
    }
    // Stav zjištěný pod zámkem objednávky - zrušení mezi kontrolou výše a vystavením
    if (v.stav_objednavky === 'zrusena') return res.status(400).json({ chyba: ZRUSENA });
    await odeslat_fakturu({ email: o.email, jmeno: o.jmeno, cislo_objednavky: o.cislo || o.id, faktura_cislo: v.faktura.cislo, html: v.faktura.html });
    // E-mailová služba odeslání přijala. Selhání následné evidence času nesmí
    // vypadat jako neodeslaný e-mail (admin by fakturu poslal znovu) - jen se
    // zaloguje (bez e-mailu a obsahu faktury) a admin dostane upozornění.
    const vysledek = { ok: true, email: o.email, faktura_cislo: v.faktura.cislo, faktura_datum: v.faktura.datum_vystaveni, faktura_odeslano: null };
    try {
      const odeslano = (await pool.query('UPDATE objednavky SET faktura_odeslano = NOW() WHERE id = $1 RETURNING faktura_odeslano', [req.params.id])).rows[0];
      if (odeslano) vysledek.faktura_odeslano = odeslano.faktura_odeslano;
    } catch (e) {
      console.error('Faktura ' + v.faktura.cislo + ' předána k odeslání, ale čas odeslání se nepodařilo uložit (objednávka ' + req.params.id + '):', e.message);
      vysledek.varovani = 'E-mail s fakturou byl předán k odeslání, ale čas odeslání se nepodařilo uložit. Fakturu znovu neposílejte – u objednávky se odeslání nemusí zobrazit.';
    }
    res.json(vysledek);
  } catch (err) {
    console.error('Fakturu se nepodařilo odeslat (objednávka ' + req.params.id + '):', err.message);
    res.status(502).json({ chyba: 'Fakturu se nepodařilo odeslat: ' + err.message });
  }
});

// Uložený opravný doklad (storno) objednávky - vzniká jen při zrušení, tady se jen čte
async function nacistStorno(id) {
  const d = (await pool.query("SELECT * FROM faktury WHERE objednavka_id = $1 AND druh = 'storno'", [id])).rows[0];
  return d ? overitUlozenou(d) : null;
}
const BEZ_STORNA = 'K objednávce není vystavený opravný doklad (vzniká při zrušení objednávky s fakturou).';

// Opravný doklad jako hotová stránka (tisk v adminu)
router.post('/:id/storno-html', vyzadovatAdmina, async (req, res) => {
  try {
    const d = await nacistStorno(req.params.id);
    if (!d) return res.status(404).json({ chyba: BEZ_STORNA });
    res.json({ storno_cislo: d.cislo, datum_vystaveni: d.datum_vystaveni, html: d.html });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

// Poslat opravný doklad zákazníkovi e-mailem (jen na klik v adminu)
router.post('/:id/storno-email', vyzadovatAdmina, async (req, res) => {
  try {
    const o = await nacistObjednavku(req.params.id);
    if (!o) return res.status(404).json({ chyba: 'Objednávka nenalezena.' });
    if (!o.email) return res.status(400).json({ chyba: 'Objednávka nemá e-mail zákazníka.' });
    const d = await nacistStorno(req.params.id);
    if (!d) return res.status(404).json({ chyba: BEZ_STORNA });
    await odeslat_storno({ email: o.email, jmeno: o.jmeno, cislo_objednavky: o.cislo || o.id, storno_cislo: d.cislo, faktura_cislo: d.data.puvodni_doklad.cislo, html: d.html });
    const vysledek = { ok: true, email: o.email, storno_cislo: d.cislo, storno_odeslano: null };
    try {
      const odeslano = (await pool.query('UPDATE objednavky SET storno_odeslano = NOW() WHERE id = $1 RETURNING storno_odeslano', [req.params.id])).rows[0];
      if (odeslano) vysledek.storno_odeslano = odeslano.storno_odeslano;
    } catch (e) {
      console.error('Opravný doklad ' + d.cislo + ' předán k odeslání, ale čas odeslání se nepodařilo uložit (objednávka ' + req.params.id + '):', e.message);
      vysledek.varovani = 'E-mail byl předán k odeslání, ale čas odeslání se nepodařilo uložit. Doklad znovu neposílejte – u objednávky se odeslání nemusí zobrazit.';
    }
    res.json(vysledek);
  } catch (err) {
    console.error('Opravný doklad se nepodařilo odeslat (objednávka ' + req.params.id + '):', err.message);
    res.status(502).json({ chyba: 'Opravný doklad se nepodařilo odeslat: ' + err.message });
  }
});

// Stav objednávky -> sloupec s okamžikem, kdy nastal (pevný seznam, žádný vstup od uživatele)
const CAS_STAVU = { zaplacena: 'zaplaceno_at', odeslana: 'expedovano_at', dorucena: 'dodano_at', zrusena: 'zruseno_at' };

// Zmenit stav objednavky (jen pro admin)
router.patch('/:id/stav', vyzadovatAdmina, async (req, res) => {
  const { stav } = req.body;
  // Canonical stavový model - musí přesně odpovídat tomu, co posílá admin.html
  // (viz stavBadge/select tam) a co zobrazuje "Moje objednávky" na eshop.html.
  const stavy = ['nova', 'vyrizuje', 'zaplacena', 'odeslana', 'dorucena', 'zrusena'];
  if (!stavy.includes(stav)) {
    return res.status(400).json({ chyba: 'Neplatny stav' });
  }
  const client = await pool.connect();
  let storno = null;
  try {
    await client.query('BEGIN');

    // FOR UPDATE zamkne řádek objednávky do konce transakce - dvě souběžná
    // zrušení téže objednávky se tak serializují a druhé z nich už uvidí
    // aktuální (zrušený) stav, takže vrácení skladu/poukazu níže neproběhne dvakrát.
    const soucasna = await client.query('SELECT stav, poukaz_id, sleva FROM objednavky WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (soucasna.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ chyba: 'Objednávka nenalezena.' });
    }
    const puvodniStav = soucasna.rows[0].stav;

    // Zrušenou objednávku už nejde "odrušit" zpátky do jiného stavu - sklad a
    // poukaz už byly vráceny a bez jasné obchodní logiky (nové navázání na
    // konkrétní pohyby skladu, případné znovu-strhnutí poukazu) by šlo o tichou
    // ztrátu konzistence mezi objednávkou a skladem/poukazem.
    if (puvodniStav === 'zrusena' && stav !== 'zrusena') {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: 'Zrušenou objednávku nelze vrátit do jiného stavu.' });
    }

    if (stav === 'zrusena' && puvodniStav !== 'zrusena') {
      // Pokud už na tuto objednávku existuje SKUTEČNĚ PROVEDENÁ vratka (tabulka
      // vratky - založená z prodejny/admin, ne pouhá zákaznická žádost v
      // vratky_zadosti), automatické zrušení zakázat. Jinak by se sklad, který
      // vratka už jednou vrátila, vrátil podruhé (jednou vratkou, podruhé
      // zrušením), a skončil by vyšší, než byl před objednávkou.
      const existujiciVratka = await client.query('SELECT 1 FROM vratky WHERE objednavka_id = $1 LIMIT 1', [req.params.id]);
      if (existujiciVratka.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ chyba: 'Objednávku s již provedenou vratkou nelze automaticky zrušit.' });
      }

      // Vrátit sklad přesně podle toho, co se při vytvoření objednávky skutečně
      // odečetlo (pohyby_skladu je autoritativní záznam - položky "u dodavatele"
      // v něm nejsou, takže se u nich sklad ani nevrací).
      const pohyby = await client.query(
        `SELECT produkt_id, velikost, pocet FROM pohyby_skladu
         WHERE typ = 'prodej' AND poznamka = $1 ORDER BY produkt_id, velikost`,
        [`Objednavka #${req.params.id}`]
      );
      for (const p of pohyby.rows) {
        await client.query('SELECT 1 FROM sklad WHERE produkt_id = $1 AND velikost = $2 FOR UPDATE', [p.produkt_id, p.velikost]);
        await client.query(
          'UPDATE sklad SET pocet_kusu = pocet_kusu + $3 WHERE produkt_id = $1 AND velikost = $2',
          [p.produkt_id, p.velikost, p.pocet]
        );
        await client.query(
          'INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES ($1,$2,$3,$4,$5)',
          [p.produkt_id, p.velikost, 'vratka', p.pocet, `Zruseni objednavky #${req.params.id}`]
        );
      }

      // Vrátit hodnotu uplatněného dárkového poukazu (pokud byl použit).
      const { poukaz_id, sleva } = soucasna.rows[0];
      if (poukaz_id && Number(sleva) > 0) {
        await client.query(
          `UPDATE darkove_poukazy SET zustatek = zustatek + $1,
                  stav = CASE WHEN stav = 'pouzity' THEN 'aktivni' ELSE stav END
           WHERE id = $2`,
          [sleva, poukaz_id]
        );
        await client.query('DELETE FROM poukazy_pouziti WHERE objednavka_id = $1', [req.params.id]);
      }

      // Faktura zůstává, zruší ji opravný doklad (storno) - ve stejné transakci,
      // takže zrušení bez storna (nebo storno bez zrušení) nevznikne.
      storno = await vystavitStorno(client, req.params.id);
    }

    await client.query('UPDATE objednavky SET stav = $1 WHERE id = $2', [stav, req.params.id]);
    // Okamžik úhrady / expedice / dodání / zrušení - jen poprvé, dřívější se nepřepíše
    // a z jednoho stavu se nic neodvozuje (doručeno neznamená zaplaceno apod.)
    const sloupecCasu = CAS_STAVU[stav];
    if (sloupecCasu && stav !== puvodniStav) {
      await client.query(`UPDATE objednavky SET ${sloupecCasu} = COALESCE(${sloupecCasu}, NOW()) WHERE id = $1`, [req.params.id]);
    }
    await client.query('COMMIT');
    res.json({ zprava: 'Stav aktualizovan', storno_cislo: storno && storno.doklad ? storno.doklad.cislo : null });

    // E-mail zákazníkovi o změně stavu - až po COMMITu, ať prodleva/chyba s
    // odesláním neblokuje odpověď adminovi (stejný vzor jako u potvrzení
    // objednávky/rezervace). Jen pro skutečnou změnu (ne když se uloží stejný
    // stav znovu) a jen pro stavy z STAVY_S_EMAILEM.
    if (STAVY_S_EMAILEM.includes(stav) && puvodniStav !== stav) {
      pool.query(
        `SELECT o.cislo, ${SQL_UDAJE_OBJEDNAVKY}
         FROM objednavky o JOIN zakaznici z ON o.zakaznik_id = z.id WHERE o.id = $1`,
        [req.params.id]
      ).then(r => {
        if (!r.rows.length) return;
        return odeslat_email_zmena_stavu({ objednavka_id: req.params.id, cislo: r.rows[0].cislo, jmeno: r.rows[0].jmeno, email: r.rows[0].email }, stav);
      }).catch(e => console.error('Email o zmene stavu objednavky se nepodarilo odeslat:', e.message));
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ chyba: err.message });
  } finally {
    client.release();
  }
});

// Trvale smazat objednávku (jen admin) - povoleno POUZE pro už zrušenou
// objednávku. Zrušení (PATCH .../stav) se už postaralo o vrácení skladu a
// případného dárkového poukazu - smazání samo žádný obchodní stav nemění,
// jen maže záznam z přehledu. objednavky_polozky nemá ON DELETE CASCADE
// (FK delete_rule = NO ACTION), takže se musí smazat ručně před řádkem
// objednávky, jinak by DELETE selhal na porušení cizího klíče.
// Objednávka s vystavenou fakturou se nemaže nikdy - faktura je doklad a v číselné
// řadě by po ní zůstala díra. FOR UPDATE se serializuje s vystavením čísla
// (vystavitFakturu zamyká stejný řádek), takže souběžný tisk ochranu neobejde.
router.delete('/:id', vyzadovatAdmina, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const objednavka = await client.query('SELECT stav, faktura_cislo FROM objednavky WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!objednavka.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ chyba: 'Objednávka nenalezena.' });
    }
    if (objednavka.rows[0].stav !== 'zrusena') {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: 'Smazat lze jen již zrušenou objednávku.' });
    }
    if (objednavka.rows[0].faktura_cislo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ chyba: `Objednávku nelze smazat – je k ní vystavená faktura ${objednavka.rows[0].faktura_cislo}. Faktura je účetní doklad a musí zůstat v evidenci.` });
    }
    await client.query('DELETE FROM objednavky_polozky WHERE objednavka_id=$1', [req.params.id]);
    await client.query('DELETE FROM poukazy_pouziti WHERE objednavka_id=$1', [req.params.id]);
    await client.query('DELETE FROM objednavky WHERE id=$1', [req.params.id]);
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
