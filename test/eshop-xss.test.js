// Stored XSS regresní test pro renderování obrázků produktů v eshop.html.
// Stejný vzor jako test/xss-escapovani.test.js pro admin.html: nekopíruje
// escHtml/escAttr/jeBezpecnaHttpUrl/obrazekProduktuHtml do testu (to by
// mohlo časem zdriftovat od skutečné implementace) - vytáhne jejich skutečný
// zdrojový kód přímo z eshop.html a spustí ho ve vm sandboxu. Na rozdíl od
// admin.html mají tyhle funkce vnořené složené závorky (if/try uvnitř
// funkce), takže se na rozdíl od jednoduchého regexu v xss-escapovani.test.js
// používá počítání závorek, aby se vytáhla celá funkce, ne jen po první "}".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ESHOP_HTML = fs.readFileSync(path.join(__dirname, '..', 'eshop.html'), 'utf8');

function vytahnoutFunkci(nazev) {
  const start = ESHOP_HTML.indexOf(`function ${nazev}(`);
  assert.ok(start !== -1, `Funkce ${nazev} nebyla v eshop.html nalezena`);
  const zavorkaStart = ESHOP_HTML.indexOf('{', start);
  let hloubka = 0;
  let konec = -1;
  for (let i = zavorkaStart; i < ESHOP_HTML.length; i++) {
    if (ESHOP_HTML[i] === '{') hloubka++;
    else if (ESHOP_HTML[i] === '}') {
      hloubka--;
      if (hloubka === 0) { konec = i + 1; break; }
    }
  }
  assert.ok(konec !== -1, `Nepodařilo se najít konec funkce ${nazev}`);
  return ESHOP_HTML.slice(start, konec);
}

// Bare vm kontext nemá globální URL (na rozdíl od hlavního Node kontextu) -
// bez tohohle by jeBezpecnaHttpUrl() vždycky vyhodila ReferenceError (chyceno
// jejím vlastním try/catch) a vrátila false, což by test tiše zfalšovalo.
const sandbox = { URL };
vm.createContext(sandbox);
vm.runInContext(vytahnoutFunkci('escHtml'), sandbox);
vm.runInContext(vytahnoutFunkci('escAttr'), sandbox);
vm.runInContext(vytahnoutFunkci('jeBezpecnaHttpUrl'), sandbox);
vm.runInContext(vytahnoutFunkci('obrazekProduktuHtml'), sandbox);

function obrazek(p) {
  return vm.runInContext(`obrazekProduktuHtml(${JSON.stringify(p)}, 220)`, sandbox);
}
function volatEsc(fn, hodnota) {
  return vm.runInContext(`${fn}(${JSON.stringify(hodnota)})`, sandbox);
}

test('escHtml() neutralizuje < a > (žádné syrové znaky ve výstupu)', () => {
  const vysledek = volatEsc('escHtml', '<svg onload=alert(1)>');
  assert.equal(vysledek.includes('<'), false);
  assert.equal(vysledek.includes('>'), false);
  assert.equal(vysledek, '&lt;svg onload=alert(1)&gt;');
});

test('escAttr() escapuje & < > " i \' (únik z HTML atributu)', () => {
  const vysledek = volatEsc('escAttr', `x" onerror="alert(1)" data-y='z<&`);
  assert.equal(vysledek.includes('"'), false);
  assert.equal(vysledek.includes("'"), false);
  assert.equal(vysledek.includes('<'), false);
  assert.equal(vysledek.includes('&amp;') || !vysledek.includes('&z'), true);
});

test('jeBezpecnaHttpUrl() uzná jen http:/https:, ne javascript:/data: ani nesmyslné řetězce', () => {
  assert.equal(volatEsc('jeBezpecnaHttpUrl', 'https://res.cloudinary.com/x.jpg'), true);
  assert.equal(volatEsc('jeBezpecnaHttpUrl', 'http://example.com/x.jpg'), true);
  assert.equal(volatEsc('jeBezpecnaHttpUrl', 'javascript:alert(1)'), false);
  assert.equal(volatEsc('jeBezpecnaHttpUrl', 'data:text/html,<script>alert(1)</script>'), false);
  assert.equal(volatEsc('jeBezpecnaHttpUrl', 'httpXss'), false); // startsWith('http') by tohle špatně pustilo
  assert.equal(volatEsc('jeBezpecnaHttpUrl', '👟'), false);
  assert.equal(volatEsc('jeBezpecnaHttpUrl', ''), false);
  assert.equal(volatEsc('jeBezpecnaHttpUrl', null), false);
});

test('malicious primary ALT text ("><svg onload=alert(1)>) se v <img alt> escapuje, ne vloží syrově', () => {
  const html = obrazek({
    primaryImageUrl: 'https://res.cloudinary.com/demo/image/upload/f_auto/x.jpg',
    primaryImageAlt: '"><svg onload=alert(1)>',
    nazev: 'Bota', emoji: '👟'
  });
  assert.equal(html.includes('<svg'), false);
  assert.equal(html.includes('onload=alert(1)>"'), false);
  assert.ok(html.includes('&lt;svg'));
});

test('malicious název produktu jako ALT fallback (bez primaryImageAlt) se escapuje', () => {
  const html = obrazek({
    primaryImageUrl: 'https://res.cloudinary.com/demo/image/upload/f_auto/x.jpg',
    primaryImageAlt: '', nazev: '"><img src=x onerror=alert(1)>', emoji: '👟'
  });
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;img'));
});

test('malicious legacy URL s uvozovkou (produkty.emoji) se escapuje v src atributu', () => {
  const html = obrazek({
    primaryImageUrl: null, nazev: 'Bota',
    emoji: 'http://evil.example.com/x.jpg" onerror="alert(1)'
  });
  assert.equal(html.includes('" onerror="alert(1)'), false);
  assert.ok(html.includes('src="'));
  assert.ok(html.includes('&quot;'));
});

test('malicious emoji/text fallback (bez URL) se escapuje jako text, ne HTML', () => {
  const html = obrazek({ primaryImageUrl: null, nazev: 'Bota', emoji: '<img src=x onerror=alert(1)>' });
  assert.equal(html.includes('<img src=x onerror'), false);
  assert.equal(html, '<span>&lt;img src=x onerror=alert(1)&gt;</span>');
});

test('nevalidní primaryImageUrl (javascript:) se nepoužije jako src - kaskáduje na emoji fallback', () => {
  const html = obrazek({ primaryImageUrl: 'javascript:alert(1)', primaryImageAlt: 'x', nazev: 'Bota', emoji: '👟' });
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html, '<span>👟</span>');
});
