// Návštěvnost webu bez cookies (admin Reporty -> Návštěvnost). Stránky posílají
// při načtení krátký záznam (navstevnost.js), server ho uloží bez IP adresy.
// Návštěvník se rozlišuje jen otiskem z IP + prohlížeče se solí, která platí
// jeden den a pak se smaže - unikátní návštěvníky jde spočítat po dnech, ale
// nikoho nejde sledovat dlouhodobě ani zpětně dohledat (nejsou to osobní údaje,
// není potřeba souhlas z cookie lišty).

const crypto = require('crypto');

// Stránky webu; cokoli jiného se uloží jako "jina" (spam nezahltí přehled)
const STRANKY = {
  '/': '/',
  '/index.html': '/',
  '/eshop.html': '/eshop.html',
  '/eshop': '/eshop.html',
  '/obchodni-podminky.html': '/obchodni-podminky.html',
  '/odstoupeni-od-smlouvy.html': '/odstoupeni-od-smlouvy.html',
  '/reklamacni-rad.html': '/reklamacni-rad.html',
  '/404.html': '/404.html'
};

const NAZVY_STRANEK = {
  '/': 'Úvodní stránka',
  '/eshop.html': 'E-shop',
  '/obchodni-podminky.html': 'Obchodní podmínky',
  '/odstoupeni-od-smlouvy.html': 'Odstoupení od smlouvy',
  '/reklamacni-rad.html': 'Reklamační řád',
  '/404.html': 'Stránka nenalezena (404)',
  jina: 'Jiná adresa'
};

function normalizovatStranku(cesta) {
  if (typeof cesta !== 'string') return 'jina';
  return STRANKY[cesta.trim().toLowerCase()] || 'jina';
}

// Adresa boty v e-shopu (?produkt=slug), jinak null
function normalizovatProdukt(slug) {
  if (typeof slug !== 'string') return null;
  const s = slug.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,119}$/.test(s) ? s : null;
}

// Vyhledávače, náhledy odkazů, měřicí nástroje a skripty - nepočítají se
const ROBOT = /bot|crawl|spider|slurp|scrap|preview|fetch|monitor|lighthouse|headless|phantom|selenium|puppeteer|playwright|facebookexternalhit|embedly|whatsapp|telegram|python|curl|wget|java\/|go-http|axios|node-fetch|okhttp|httpclient|libwww/i;

function jeRobot(ua) {
  return typeof ua !== 'string' || ua.trim().length < 10 || ROBOT.test(ua);
}

function zarizeni(ua) {
  const u = String(ua || '');
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(u)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(u)) return 'mobil';
  return 'pocitac';
}

const ZNAME_ZDROJE = [
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)seznam\.cz$|(^|\.)szn\.cz$/, 'Seznam'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)(heureka\.cz|heureka\.sk)$/, 'Heureka'],
  [/(^|\.)zbozi\.cz$/, 'Zboží.cz'],
  [/(^|\.)mapy\.(cz|com)$/, 'Mapy.cz'],
  [/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/, 'ChatGPT']
];
const VLASTNI_DOMENY = /(^|\.)detskekrucky\.cz$|(^|\.)detskekrucky1\.onrender\.com$|^localhost$|^127\.0\.0\.1$/;

function hezkyZdroj(nazev) {
  const n = String(nazev).trim().toLowerCase().replace(/^www\./, '');
  // i název z kampaně bez domény ("facebook", "seznam")
  for (const [vzor, jmeno] of ZNAME_ZDROJE) if ([n, n + '.com', n + '.cz'].some(x => vzor.test(x))) return jmeno;
  return n.slice(0, 100) || null;
}

// Odkud návštěvník přišel. null = přechod mezi vlastními stránkami (nepočítá
// se jako příchod), "Přímo" = bez odkazu (záložka, napsaná adresa, aplikace).
// kampan = utm_source / fbclid / gclid z adresy, má přednost před odkazem.
function zdrojNavstevy(odkaz, kampan) {
  if (typeof kampan === 'string' && /^[\w.\- ]{1,60}$/.test(kampan.trim())) return hezkyZdroj(kampan);
  if (typeof odkaz !== 'string' || !odkaz.trim()) return 'Přímo';
  let host;
  try {
    host = new URL(odkaz).hostname.toLowerCase();
  } catch {
    return 'Přímo';
  }
  if (!host) return 'Přímo';
  if (VLASTNI_DOMENY.test(host)) return null;
  return hezkyZdroj(host);
}

// Otisk návštěvníka pro jeden den (sůl se po dni maže)
function otiskNavstevnika(sul, ip, ua) {
  return crypto.createHash('sha256').update(`${sul}|${ip || ''}|${ua || ''}`).digest('hex').slice(0, 16);
}

// Období přehledu: YYYY-MM-DD, od <= do, nejvýš ~2 roky
const MAX_DNU = 800;
function overitObdobi(od, doDne) {
  const vzor = /^\d{4}-\d{2}-\d{2}$/;
  if (!vzor.test(od || '') || !vzor.test(doDne || '')) return { chyba: 'Neplatné období.' };
  const a = Date.parse(od + 'T00:00:00Z');
  const b = Date.parse(doDne + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || new Date(a).toISOString().slice(0, 10) !== od || new Date(b).toISOString().slice(0, 10) !== doDne) {
    return { chyba: 'Neplatné období.' };
  }
  if (a > b) return { chyba: 'Začátek období je po jeho konci.' };
  if ((b - a) / 86400000 > MAX_DNU) return { chyba: 'Období je příliš dlouhé.' };
  return { od, do: doDne };
}

module.exports = {
  NAZVY_STRANEK, normalizovatStranku, normalizovatProdukt, jeRobot, zarizeni,
  zdrojNavstevy, otiskNavstevnika, overitObdobi
};
