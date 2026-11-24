// Seznam souborů, které se smějí publikovat na GitHub Pages (www.detskekrucky.cz).
//
// Na web jde JEN to, co je tady výslovně uvedené (allowlist). Nový veřejný soubor
// (stránka, obrázek, skript) je potřeba sem dopsat, jinak se sestavení zastaví
// na kontrole odkazů nebo se soubor na web nedostane.
//
// Serverový kód, testy, dokumentace, zálohy, certifikáty a pracovní soubory sem
// nepatří - Render si backend bere přímo z repozitáře, web je potřebovat nesmí.

// Výslovně povolené soubory (cesta v repozitáři = cesta na webu)
const SOUBORY = [
  // Stránky
  'index.html',
  'eshop.html',
  'eshop-brzy.html', // stará adresa odpočtu, přesměrovává na eshop.html
  'admin.html',
  'mobilni-sken.html',
  'obchodni-podminky.html',
  'odstoupeni-od-smlouvy.html',
  'reklamacni-rad.html',
  '404.html',
  'stromecek/index.html',

  // Veřejné skripty a písma (DejaVu načítá admin pro PDF s diakritikou)
  'navstevnost.js',
  'fonts/DejaVuSans-normal.js',
  'fonts/DejaVuSans-bold.js',

  // Obrázky
  'logo.jpg',
  'jezek.png',
  'srnka.png',
  'karta-jezek.jpg',
  'poukaz-dlazdice.png',
  'vanocni-poukaz.png',
  'vanocni-poukaz-dlazdice.jpg',
  'prodejna-1.jpg',
  'prodejna-2.jpg',
  'prodejna-majitelka.jpg',
  'prodejna-venku.jpg',

  // Pro vyhledávače a doménu
  'robots.txt',
  'sitemap.xml',
  'CNAME'
];

// Ověřovací soubory vyhledávačů v kořeni webu - publikují se, jen pokud v repozitáři
// opravdu jsou (Search Console je teď ověřená přes DNS, žádný soubor není potřeba).
const OVEROVACI_VZORY = [
  /^google[0-9a-f]{16}\.html$/,
  /^BingSiteAuth\.xml$/,
  /^yandex_[0-9a-f]{16}\.html$/,
  /^seznam-wmt-[A-Za-z0-9_-]+\.txt$/
];

// Pojistka navíc: tyhle cesty nesmí být ve výsledném balíčku nikdy, ani omylem
// dopsané do seznamu výše. Kontroluje se každá cesta v balíčku.
const ZAKAZANE_VZORY = [
  { vzor: /^(lib|routes|db|middleware|scripts|test|test-helpers|prohlizec-testy|docs|deploy|node_modules|\.github|\.git|Claude outputs)\//, duvod: 'serverový kód, testy, dokumentace nebo zálohy' },
  { vzor: /(^|\/)\./, duvod: 'skrytý soubor (.env, .gitignore, .gitattributes…)' },
  { vzor: /^(index\.js|package\.json|package-lock\.json|CLAUDE\.md)$/, duvod: 'serverový nebo pracovní soubor' },
  { vzor: /\.(pem|p12|pfx|key|crt|cer|der|env|dump|sql|gz|aes|log|sh|bak|zip)$/i, duvod: 'certifikát, klíč, záloha nebo log' },
  { vzor: /\.md$/i, duvod: 'dokumentace' },
  { vzor: /(^|\/)(zprava-[^/]*\.json|etiketa[^/]*\.pdf|index-1\.html)$/, duvod: 'pracovní soubor' }
];

// Obsah, který se v publikovaném souboru nesmí objevit (únik tajného údaje)
const ZAKAZANY_OBSAH = [
  { vzor: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, duvod: 'soukromý klíč' },
  { vzor: /postgres(?:ql)?:\/\/[^\s'"`/:@]+:[^\s'"`@]+@/i, duvod: 'přístup k databázi s heslem' },
  { vzor: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/, duvod: 'klíč Resend' },
  { vzor: /\b(?:ADMIN_HESLO|DATABASE_URL|RESEND_API_KEY|CLOUDINARY_API_SECRET|ZASILKOVNA_API_HESLO|GLS_PASSWORD|PPL_CLIENT_SECRET)\s*=\s*\S/, duvod: 'nastavení proměnné s tajným údajem' }
];

// Řetězce ve skriptech, které vypadají jako místní soubor, ale soubor nejsou
// (kontrola odkazů je pak nehlásí jako chybějící). Každá výjimka s důvodem.
const NE_ODKAZY = {
  'admin.html': {
    'x.png': 'jméno zkušebního souboru pro navigator.canShare, nic se nenačítá',
    'DejaVuSans-normal.ttf': 'jméno písma ve virtuálním souborovém systému jsPDF (data jsou ve fonts/DejaVuSans-normal.js)',
    'DejaVuSans-Bold.ttf': 'jméno písma ve virtuálním souborovém systému jsPDF (data jsou ve fonts/DejaVuSans-bold.js)'
  }
};

module.exports = { SOUBORY, OVEROVACI_VZORY, ZAKAZANE_VZORY, ZAKAZANY_OBSAH, NE_ODKAZY };
