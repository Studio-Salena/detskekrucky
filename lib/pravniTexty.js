// Právní texty pro potvrzení objednávky (§ 1824a, § 1827 odst. 2 obč. zák.:
// VOP, poučení o odstoupení, vzorový formulář, reklamace, ADR v textové podobě).
//
// Jediný zdroj pravdy jsou veřejné stránky webu (obchodni-podminky.html,
// odstoupeni-od-smlouvy.html, reklamacni-rad.html) - backend na Renderu běží
// ze stejného repozitáře, takže je čte přímo z disku. Žádná druhá ručně
// udržovaná kopie: oprava textu na webu se po deployi propíše i do e-mailu.
//
// Z HTML se vezme jen vymezená část (mezi pevnými značkami) a převede se na
// prostý text po blocích (nadpis / odstavec / odrážka). Do e-mailu jde až
// znovu escapovaný text - žádné původní tagy, odkazy, skripty ani formulářové
// prvky. Nenajde-li se některá značka (někdo stránku přestavěl), vyhodí se
// chyba - radši hlasitě (testy, log), než tiše poslat neúplné poučení.

const fs = require('fs');
const path = require('path');

const KOREN = path.join(__dirname, '..');
const WEB = 'https://www.detskekrucky.cz';

const ODKAZY = {
  vop: `${WEB}/obchodni-podminky.html`,
  odstoupeni: `${WEB}/odstoupeni-od-smlouvy.html`,
  vratitZbozi: `${WEB}/eshop.html?vratky=1`,
  reklamacniRad: `${WEB}/reklamacni-rad.html`
};

function nacist(soubor) {
  return fs.readFileSync(path.join(KOREN, soubor), 'utf8');
}

// Výřez mezi dvěma značkami (start včetně/bez sebe sama podle `vcetneStartu`).
function vyrez(html, soubor, start, konec, vcetneStartu = false) {
  const i = html.indexOf(start);
  if (i === -1) throw new Error(`Právní texty: v ${soubor} chybí značka začátku ${JSON.stringify(start)}`);
  const od = vcetneStartu ? i : i + start.length;
  const j = html.indexOf(konec, od);
  if (j === -1) throw new Error(`Právní texty: v ${soubor} chybí značka konce ${JSON.stringify(konec)}`);
  return html.slice(od, j);
}

const ENTITY = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', bdquo: '„', ldquo: '“', rdquo: '”' };
function dekodovatEntity(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITY ? ENTITY[n.toLowerCase()] : m));
}

// HTML výřez -> [{ typ: 'nadpis'|'odstavec'|'odrazka', text }]
function naBloky(html) {
  let s = html
    // Zalomení řádků ve zdrojovém HTML nejsou předěly bloků - ty určují až tagy níže
    .replace(/\s+/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|button)[\s\S]*?<\/\1>/gi, '')
    // Tlačítka/odkazy jen pro web ("Vyplnit online", "Vytisknout") - v e-mailu nedávají smysl
    .replace(/<div[^>]*class="[^"]*no-print[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    // Vyplňovací pole formuláře -> linka k vyplnění (zachová se popisek)
    .replace(/<\/label>\s*<(input|textarea)[^>]*>(\s*<\/textarea>)?/gi, ': ____________________</label>')
    .replace(/<(input|textarea|select)[^>]*>/gi, '')
    .replace(/<h[1-6][^>]*>/gi, '\n\u0001')
    .replace(/<li[^>]*>/gi, '\n\u0002')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|ul|ol|li|h[1-6]|footer|table|tr|label)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = dekodovatEntity(s);
  const bloky = [];
  for (const radek of s.split('\n')) {
    const znacka = radek.trimStart()[0];
    const text = radek.replace(/[\u0001\u0002]/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const typ = znacka === '\u0001' ? 'nadpis' : znacka === '\u0002' ? 'odrazka' : 'odstavec';
    bloky.push({ typ, text });
  }
  if (!bloky.length) throw new Error('Právní texty: výřez neobsahuje žádný text');
  return bloky;
}

function sestavit() {
  const vop = nacist('obchodni-podminky.html');
  const odst = nacist('odstoupeni-od-smlouvy.html');
  const rr = nacist('reklamacni-rad.html');
  return {
    // Identifikace prodávajícího = rámeček v čl. 1 VOP
    prodavajici: naBloky(vyrez(vop, 'obchodni-podminky.html', '<div class="info-box">', '</div>')),
    // Celé VOP od nadpisu po patičku stránky
    vop: naBloky(vyrez(vop, 'obchodni-podminky.html', '<h1>Obchodní podmínky</h1>', '<footer>', true)),
    // Poučení = stránka odstoupení od úvodu po vzorový formulář
    pouceni: naBloky(vyrez(odst, 'odstoupeni-od-smlouvy.html', '<h2 class="page-title">Odstoupení od smlouvy</h2>', '<h3 id="formular">')),
    // Vzorový formulář včetně pokynu, jak ho zaslat
    formular: naBloky(vyrez(odst, 'odstoupeni-od-smlouvy.html', '<h3 id="formular">', '<div style="text-align:center" class="no-print">', true)),
    // Práva z vadného plnění / reklamace = reklamační řád čl. 3-5
    reklamace: naBloky(vyrez(rr, 'reklamacni-rad.html', '<h3>3. ', '<h3>6. ', true)),
    // Mimosoudní řešení sporů = reklamační řád čl. 6
    adr: naBloky(vyrez(rr, 'reklamacni-rad.html', '<h3>6. ', '<h3>7. ', true))
  };
}

// Stránky se mění jen deployem (= restart procesu), takže stačí načíst jednou.
let cache = null;
function ziskatPravniTexty() {
  if (!cache) cache = sestavit();
  return cache;
}

module.exports = { ziskatPravniTexty, naBloky, ODKAZY };
