// Ověření výdejního místa GLS proti oficiálnímu veřejnému seznamu GLS.
// Z prohlížeče bereme jen ID místa; název a adresu do objednávky bereme
// odsud, ne z údajů, které poslal klient.
// Seznam (~5,5 MB XML) se stahuje nejvýš jednou za 24 h a drží v paměti;
// když GLS zrovna neodpovídá, použije se poslední stažený seznam.

const SEZNAM_URL = 'https://ps-maps.gls-czech.com/getDropoffPoints.php?ctrcode=CZ';
const PLATNOST_MS = 24 * 60 * 60 * 1000;
const NOVY_POKUS_MS = 5 * 60 * 1000;
const LIMIT_STAHOVANI_MS = 20000;
const ID_REGEX = /^[A-Za-z0-9_-]{3,40}$/;

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function dekodovat(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] !== '#') return ENTITY[e];
    const kod = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return kod > 0 && kod <= 0x10ffff ? String.fromCodePoint(kod) : '';
  });
}

// Z XML vybere atributy značek <DropoffPoint ...>; vnořené Openings/Images nepotřebujeme
function rozebratSeznam(xml) {
  const mista = new Map();
  const znacka = /<DropoffPoint\s([^>]*?)\/?>/g;
  const atribut = /([A-Za-z]+)="([^"]*)"/g;
  let m;
  while ((m = znacka.exec(xml))) {
    const a = {};
    let at;
    atribut.lastIndex = 0;
    while ((at = atribut.exec(m[1]))) a[at[1]] = dekodovat(at[2]).trim();
    if (!a.ID || !ID_REGEX.test(a.ID)) continue;
    mista.set(a.ID.toUpperCase(), {
      id: a.ID,
      nazev: a.Name || '',
      ulice: a.Address || '',
      mesto: a.CityName || '',
      psc: a.ZipCode || '',
      stat: a.CtrCode || 'CZ',
      box: a.IsParcelLocker === '1',
      dobirka: a.IsCODHandler === '1'
    });
  }
  return mista;
}

let cache = null;          // { mista: Map, stazeno: ms }
let probihajici = null;    // sdílené stahování pro souběžné požadavky
let posledniNeuspech = 0;

async function stahnoutSeznam(fetchFn) {
  const odp = await fetchFn(SEZNAM_URL, { signal: AbortSignal.timeout(LIMIT_STAHOVANI_MS) });
  if (!odp.ok) throw new Error('GLS seznam výdejních míst: HTTP ' + odp.status);
  const mista = rozebratSeznam(await odp.text());
  if (mista.size < 100) throw new Error('GLS seznam výdejních míst: podezřele málo míst (' + mista.size + ')');
  return mista;
}

async function nacistMista({ fetchFn = fetch, ted = Date.now() } = {}) {
  if (cache && ted - cache.stazeno < PLATNOST_MS) return cache.mista;
  // po neúspěchu nezkoušet GLS při každé objednávce znovu; starý seznam stačí
  if (cache && ted - posledniNeuspech < NOVY_POKUS_MS) return cache.mista;
  if (!probihajici) {
    probihajici = stahnoutSeznam(fetchFn)
      .then(mista => { cache = { mista, stazeno: Date.now() }; return mista; })
      .finally(() => { probihajici = null; });
  }
  try {
    return await probihajici;
  } catch (e) {
    posledniNeuspech = ted;
    console.error('Seznam výdejních míst GLS se nepodařilo stáhnout:', e.message);
    if (cache) return cache.mista;
    throw new Error('GLS_NEDOSTUPNE');
  }
}

// Vrátí ověřené místo { id, nazev, ulice, mesto, psc, stat, box, dobirka }, nebo null, když neexistuje.
// Když seznam nejde stáhnout a nemáme ani starý, vyhodí chybu 'GLS_NEDOSTUPNE'.
async function overitVydejniMisto(id, moznosti) {
  if (typeof id !== 'string' || !ID_REGEX.test(id.trim())) return null;
  const mista = await nacistMista(moznosti);
  return mista.get(id.trim().toUpperCase()) || null;
}

function _resetovatCache() { cache = null; probihajici = null; posledniNeuspech = 0; }

module.exports = { overitVydejniMisto, rozebratSeznam, ID_REGEX, SEZNAM_URL, _resetovatCache };
