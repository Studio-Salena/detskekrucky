// Zásilkovna (Packeta): výběr výdejního místa přes oficiální widget Zásilkovny.
// API KLÍČ (ZASILKOVNA_API_KLIC, 16 znaků) je podle Zásilkovny veřejný - widget
// běží v prohlížeči zákazníka, proto se klíč posílá e-shopu přes /api/doprava.
// API HESLO (ZASILKOVNA_API_HESLO, 32 znaků) je tajné: zatím se nepoužívá
// a nikdy se nesmí dostat do odpovědí API, HTML ani logů.
//
// Zásilkovna nemá dotaz na jedno místo a celý seznam míst je pro server příliš
// velký, takže údaje z widgetu jen přísně kontrolujeme: číselné ID, jen
// výdejní místa a Z-BOXy Zásilkovny v ČR, texty očištěné a zkrácené. Zásilku
// stejně určuje ID místa - to při podání ověří Zásilkovna.

const KLIC_RE = /^[A-Za-z0-9]{16}$/;
const ID_RE = /^\d{1,10}$/;

// Klíč jen ve správném tvaru. 32 znaků je API heslo, to se do e-shopu poslat nesmí.
function apiKlic(env = process.env) {
  const k = String(env.ZASILKOVNA_API_KLIC || '').trim();
  return KLIC_RE.test(k) ? k : null;
}

// Pro admin: jen ano/ne a popis problému, nikdy hodnota klíče
function stav(env = process.env) {
  const surovy = String(env.ZASILKOVNA_API_KLIC || '').trim();
  let problem = null;
  if (!surovy) problem = 'Na Renderu chybí proměnná ZASILKOVNA_API_KLIC.';
  else if (!KLIC_RE.test(surovy)) problem = 'ZASILKOVNA_API_KLIC nemá tvar API klíče (16 znaků) – nevložilo se tam API heslo?';
  return { mapa: !problem, problem };
}

function text(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Vstup = údaje z widgetu, jak je poslal e-shop. Vrátí { id, nazev, ulice, mesto, psc, stat, box } nebo null.
function overitVydejniMisto(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const id = text(m.id, 20);
  if (!ID_RE.test(id)) return null;
  if (text(m.stat, 2).toLowerCase() !== 'cz') return null;
  // místa jiných dopravců (pickupPointType 'external') do objednávky nepatří
  if (m.typ !== undefined && text(m.typ, 20).toLowerCase() !== 'internal') return null;
  const nazev = text(m.nazev, 150);
  const mesto = text(m.mesto, 80);
  if (!nazev || !mesto) return null;
  return {
    id,
    nazev,
    ulice: text(m.ulice, 120),
    mesto,
    psc: text(m.psc, 10),
    stat: 'CZ',
    box: m.box === true
  };
}

module.exports = { apiKlic, stav, overitVydejniMisto, KLIC_RE, ID_RE };
