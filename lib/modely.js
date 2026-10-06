// Modely bot (krok 0 nového e-shopu). Sklad se v adminu zakládá po
// jednotlivých velikostech/EAN, takže jeden model bot má v produkty víc řádků.
// Model je jedna položka pro celou botu: jedna adresa (slug), jedna kategorie
// a jedna sada vlastností pro filtry. Sklad, EAN, ceny a fotky zůstávají
// na produktech beze změny.

// Povolené hodnoty vlastností - filtry na e-shopu potřebují pevné hodnoty,
// ne volný text. Klíč = uložená hodnota, text = popisek v adminu/e-shopu.
const VOLBY = {
  sirka: { uzka: 'úzká', normalni: 'normální', siroka: 'široká' },
  nart: { nizky: 'nízký', stredni: 'střední', vysoky: 'vysoký' },
  dominantni_palec: { vhodna: 'vhodná', nevhodna: 'nevhodná' },
  zapinani: { suchy_zip: 'suchý zip', tkanicky: 'tkaničky', nazouvaci: 'nazouvací', zip: 'zip', prezka: 'přezka' },
  material: { kuze: 'kůže', textil: 'textil', syntetika: 'syntetika', kombinace: 'kombinace' },
  pohlavi: { holcicka: 'holčička', chlapecek: 'chlapeček', vse: 'pro všechny' }
};
const VICE_HODNOT = ['sirka', 'nart', 'zapinani'];
const JEDNA_HODNOTA = ['dominantni_palec', 'material', 'pohlavi'];
const ANO_NE = ['barefoot', 'membrana'];
const MAX_PROC = 3;
const MAX_PROC_ZNAKU = 120;

// Kategorie, u kterých se vlastnosti bot nevyplňují (nejsou to boty)
const KATEGORIE_BEZ_VLASTNOSTI = ['doplnky', 'pece-o-obuv'];

const VYCHOZI_NASTAVENI_KATALOGU = {
  vekoveSkupiny: [
    { nazev: 'První krůčky', od: 17, do: 21 },
    { nazev: 'Batolata', od: 22, do: 25 },
    { nazev: 'Předškoláci', od: 26, do: 30 },
    { nazev: 'Školáci', od: 31, do: 42 }
  ],
  pohlavi: false
};

// Klíč modelu = značka + název bez ohledu na velká písmena a okrajové mezery
// ("BEDA" a "Beda" je stejná bota). Počítá se jen tady v JS, ne v SQL -
// lower() v Postgresu závisí na locale databáze a s češtinou by se mohl lišit.
function klicModelu(znacka, nazev) {
  return String(znacka || '').trim().toLowerCase() + '||' + String(nazev || '').trim().toLowerCase();
}

// Část adresy: bez diakritiky, malá písmena, pomlčky ("AUTUMN BLACK+" -> "autumn-black-plus")
function vytvoritSlug(znacka, nazev) {
  const text = `${znacka || ''} ${nazev || ''}`
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' a ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return text || 'model';
}

async function volnySlug(db, zaklad) {
  for (let i = 1; ; i++) {
    const slug = i === 1 ? zaklad : `${zaklad}-${i}`;
    const obsazeno = await db.query('SELECT 1 FROM modely WHERE slug = $1', [slug]);
    if (!obsazeno.rows.length) return slug;
  }
}

// Vrátí id modelu pro danou značku a název, případně ho založí.
// Slug se tvoří jen při založení a potom se nemění (sdílené odkazy platí dál).
async function zajistitModel(db, { znacka, nazev, kategorie }) {
  const klic = klicModelu(znacka, nazev);
  const existujici = await db.query('SELECT id FROM modely WHERE klic = $1', [klic]);
  if (existujici.rows.length) return existujici.rows[0].id;
  const slug = await volnySlug(db, vytvoritSlug(znacka, nazev));
  const novy = await db.query(
    'INSERT INTO modely (klic, slug, znacka, nazev, kategorie) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (klic) DO NOTHING RETURNING id',
    [klic, slug, String(znacka || '').trim() || null, String(nazev || '').trim(), kategorie || null]
  );
  if (novy.rows.length) return novy.rows[0].id;
  return (await db.query('SELECT id FROM modely WHERE klic = $1', [klic])).rows[0].id;
}

// Přiřadí produkt k modelu podle jeho aktuální značky a názvu (po založení
// nebo přejmenování produktu v adminu).
async function priraditModel(db, produktId) {
  const p = await db.query('SELECT id, znacka, nazev, kategorie FROM produkty WHERE id = $1', [produktId]);
  if (!p.rows.length) return null;
  const modelId = await zajistitModel(db, p.rows[0]);
  await db.query('UPDATE produkty SET model_id = $1 WHERE id = $2', [modelId, produktId]);
  return modelId;
}

// Nejčastější kategorie mezi velikostmi; při shodě abecedně první (deterministicky)
function nejcastejsiKategorie(kategorie) {
  const citac = {};
  kategorie.filter(Boolean).forEach(k => { citac[k] = (citac[k] || 0) + 1; });
  const serazene = Object.entries(citac).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return serazene.length ? serazene[0][0] : null;
}

// Idempotentní migrace: tabulka modely, produkty.model_id a založení modelů
// pro všechny produkty, které ještě model nemají. Druhé spuštění nic nemění.
async function migrovatModely(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS modely (
      id SERIAL PRIMARY KEY,
      klic TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      znacka TEXT,
      nazev TEXT NOT NULL,
      kategorie TEXT,
      barefoot BOOLEAN,
      sirka TEXT[] NOT NULL DEFAULT '{}',
      nart TEXT[] NOT NULL DEFAULT '{}',
      dominantni_palec TEXT,
      zapinani TEXT[] NOT NULL DEFAULT '{}',
      membrana BOOLEAN,
      material TEXT,
      pohlavi TEXT,
      proc_jsme_vybrali TEXT[] NOT NULL DEFAULT '{}',
      vytvoreno TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      upraveno TIMESTAMPTZ
    );
    ALTER TABLE produkty ADD COLUMN IF NOT EXISTS model_id INTEGER REFERENCES modely(id);
    CREATE INDEX IF NOT EXISTS produkty_model_id_idx ON produkty(model_id);
  `);

  const bezModelu = await db.query('SELECT id, znacka, nazev, kategorie FROM produkty WHERE model_id IS NULL ORDER BY id');
  const skupiny = new Map();
  for (const p of bezModelu.rows) {
    const klic = klicModelu(p.znacka, p.nazev);
    if (!skupiny.has(klic)) skupiny.set(klic, []);
    skupiny.get(klic).push(p);
  }
  for (const produkty of skupiny.values()) {
    const prvni = produkty[0];
    const modelId = await zajistitModel(db, {
      znacka: prvni.znacka, nazev: prvni.nazev, kategorie: nejcastejsiKategorie(produkty.map(p => p.kategorie))
    });
    await db.query('UPDATE produkty SET model_id = $1 WHERE id = ANY($2::int[])', [modelId, produkty.map(p => p.id)]);
  }
  return { zalozenoSkupin: skupiny.size, prirazenoProduktu: bezModelu.rows.length };
}

// Ověří úpravu modelu z adminu. Vrací { chyba } nebo { hodnoty } jen s poli,
// která v požadavku přišla (ostatní zůstanou beze změny).
function overitUpravuModelu(telo) {
  if (!telo || typeof telo !== 'object') return { chyba: 'Chybí údaje modelu.' };
  const hodnoty = {};

  for (const pole of ['znacka', 'nazev']) {
    if (!(pole in telo)) continue;
    if (typeof telo[pole] !== 'string') return { chyba: `Neplatná hodnota pole ${pole}.` };
    const text = telo[pole].trim();
    if (text.length > 255) return { chyba: `Pole ${pole} je příliš dlouhé.` };
    if (pole === 'nazev' && !text) return { chyba: 'Název modelu nesmí být prázdný.' };
    hodnoty[pole] = text || null;
  }

  if ('kategorie' in telo) {
    if (typeof telo.kategorie !== 'string' || !telo.kategorie.trim()) return { chyba: 'Vyberte kategorii.' };
    hodnoty.kategorie = telo.kategorie.trim();
  }

  for (const pole of ANO_NE) {
    if (!(pole in telo)) continue;
    if (telo[pole] !== null && typeof telo[pole] !== 'boolean') return { chyba: `Neplatná hodnota pole ${pole}.` };
    hodnoty[pole] = telo[pole];
  }

  for (const pole of JEDNA_HODNOTA) {
    if (!(pole in telo)) continue;
    const v = telo[pole];
    if (v !== null && !(typeof v === 'string' && Object.hasOwn(VOLBY[pole], v))) return { chyba: `Neplatná hodnota pole ${pole}.` };
    hodnoty[pole] = v;
  }

  for (const pole of VICE_HODNOT) {
    if (!(pole in telo)) continue;
    const v = telo[pole];
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && Object.hasOwn(VOLBY[pole], x))) {
      return { chyba: `Neplatná hodnota pole ${pole}.` };
    }
    // Bez duplicit a v pevném pořadí voleb (úzká, normální, široká...)
    hodnoty[pole] = Object.keys(VOLBY[pole]).filter(k => v.includes(k));
  }

  if ('proc_jsme_vybrali' in telo) {
    const v = telo.proc_jsme_vybrali;
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) return { chyba: 'Neplatná hodnota pole proc_jsme_vybrali.' };
    const body = v.map(x => x.trim()).filter(Boolean);
    if (body.length > MAX_PROC) return { chyba: `„Proč jsme ji vybrali“ může mít nejvýš ${MAX_PROC} body.` };
    if (body.some(x => x.length > MAX_PROC_ZNAKU)) return { chyba: `Jeden bod „Proč jsme ji vybrali“ může mít nejvýš ${MAX_PROC_ZNAKU} znaků.` };
    hodnoty.proc_jsme_vybrali = body;
  }

  if (!Object.keys(hodnoty).length) return { chyba: 'Nic ke změně.' };
  return { hodnoty };
}

// Hromadná změna v adminu: jedna hodnota pro víc modelů najednou. Značka a
// název hromadně ne (vznikly by stejné modely), vícenásobné volby taky ne
// (přepsaly by rozdílné hodnoty jednotlivých bot).
const HROMADNE_POLE = ['kategorie', 'barefoot', 'membrana', 'material', 'dominantni_palec', 'pohlavi'];
const MAX_HROMADNE = 500;

function overitHromadnouZmenu(telo) {
  if (!telo || typeof telo !== 'object') return { chyba: 'Chybí údaje.' };
  const { ids, zmeny } = telo;
  if (!Array.isArray(ids) || !ids.length) return { chyba: 'Vyberte aspoň jeden model.' };
  if (ids.length > MAX_HROMADNE) return { chyba: `Najednou jde upravit nejvýš ${MAX_HROMADNE} modelů.` };
  if (!ids.every(id => Number.isInteger(id) && id > 0)) return { chyba: 'Neplatné id modelu.' };
  if (!zmeny || typeof zmeny !== 'object' || Array.isArray(zmeny)) return { chyba: 'Chybí změna.' };
  const nepovolene = Object.keys(zmeny).filter(k => !HROMADNE_POLE.includes(k));
  if (nepovolene.length) return { chyba: `Hromadně nejde měnit: ${nepovolene.join(', ')}.` };
  const { chyba, hodnoty } = overitUpravuModelu(zmeny);
  if (chyba) return { chyba };
  return { ids: [...new Set(ids)], hodnoty };
}

// Jsou vyplněné vlastnosti potřebné pro filtry? (palec, nárt, pohlaví a
// "proč jsme ji vybrali" jsou nepovinné)
function jeVyplneno(model) {
  if (KATEGORIE_BEZ_VLASTNOSTI.includes(model.kategorie)) return true;
  return model.barefoot !== null && model.barefoot !== undefined
    && Array.isArray(model.sirka) && model.sirka.length > 0
    && Array.isArray(model.zapinani) && model.zapinani.length > 0
    && model.membrana !== null && model.membrana !== undefined
    && !!model.material;
}

function overitNastaveniKatalogu(telo) {
  if (!telo || typeof telo !== 'object') return { chyba: 'Chybí nastavení.' };
  const { vekoveSkupiny, pohlavi } = telo;
  if (typeof pohlavi !== 'boolean') return { chyba: 'Neplatná hodnota pohlavi.' };
  if (!Array.isArray(vekoveSkupiny) || vekoveSkupiny.length < 1 || vekoveSkupiny.length > 6) {
    return { chyba: 'Věkových skupin musí být 1 až 6.' };
  }
  const skupiny = [];
  for (const s of vekoveSkupiny) {
    const nazev = s && typeof s.nazev === 'string' ? s.nazev.trim() : '';
    if (!nazev || nazev.length > 40) return { chyba: 'Každá věková skupina potřebuje název (nejvýš 40 znaků).' };
    if (!Number.isInteger(s.od) || !Number.isInteger(s.do) || s.od < 1 || s.do > 50 || s.od > s.do) {
      return { chyba: `Skupina „${nazev}“: velikosti od–do musí být celá čísla 1–50 a „od“ nesmí být větší než „do“.` };
    }
    skupiny.push({ nazev, od: s.od, do: s.do });
  }
  return { hodnoty: { vekoveSkupiny: skupiny, pohlavi } };
}

module.exports = {
  VOLBY, KATEGORIE_BEZ_VLASTNOSTI, VYCHOZI_NASTAVENI_KATALOGU,
  klicModelu, vytvoritSlug, zajistitModel, priraditModel, nejcastejsiKategorie,
  migrovatModely, overitUpravuModelu, jeVyplneno, overitNastaveniKatalogu,
  HROMADNE_POLE, overitHromadnouZmenu
};
