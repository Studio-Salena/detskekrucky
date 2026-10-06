// Které soubory z kořene repozitáře smí backend servírovat jako statické.
// Dřív šel ven celý adresář (express.static(__dirname)), takže kdokoli mohl
// stáhnout zdrojový kód serveru (routes/, lib/, index.js, package.json...).
// Povolené jsou jen soubory webu: stránky, obrázky, fonty a PDF fonty adminu.
// Admin a mobilní sken se dají otevřít i z Renderu, proto se úplně nevypíná.

const POVOLENE_PRIPONY = /\.(html|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|css)$/i;
const POVOLENE_CESTY = new Set(['/', '/robots.txt', '/sitemap.xml']);
// Fonty pro PDF v adminu (jsPDF) jsou .js soubory - povolené jen tyhle
const POVOLENE_JS = /^\/fonts\/[A-Za-z0-9_-]+\.js$/;
const ZAKAZANE_SLOZKY = /^\/(node_modules|routes|lib|db|middleware|test|test-helpers|\.git|\.github)(\/|$)/i;

function jePovolenyStatickySoubor(cesta) {
  if (typeof cesta !== 'string') return false;
  let dekodovana;
  try {
    dekodovana = decodeURIComponent(cesta);
  } catch {
    return false;
  }
  if (dekodovana.includes('\\') || dekodovana.includes('\0') || dekodovana.split('/').some(c => c === '..' || c.startsWith('.'))) return false;
  if (ZAKAZANE_SLOZKY.test(dekodovana)) return false;
  return POVOLENE_CESTY.has(dekodovana) || POVOLENE_JS.test(dekodovana) || POVOLENE_PRIPONY.test(dekodovana);
}

// Obal nad express.static: nepovolené cesty propustí dál (API, 404), jako by soubor neexistoval
function statickeSoubory(staticMiddleware) {
  return (req, res, next) => (jePovolenyStatickySoubor(req.path) ? staticMiddleware(req, res, next) : next());
}

module.exports = { jePovolenyStatickySoubor, statickeSoubory };
