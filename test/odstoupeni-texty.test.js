// Krok B2.1 - texty o odstoupení musí být všude stejné jako ve VOP čl. 5
// a na stránce odstoupení: stav zboží (nepoužité/nepoškozené/obal) není
// podmínkou odstoupení, spotřebitel odpovídá jen za snížení hodnoty
// (§ 1833, vzor NV 29/2023 pokyn [6] c) a peníze lze zadržet do vrácení
// zboží NEBO prokázání jeho odeslání (§ 1832 odst. 4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';

const KOREN = path.join(__dirname, '..');
const SNIZENI_HODNOTY = 'Odpovídáte pouze za snížení hodnoty zboží, které vzniklo v důsledku nakládání s tímto zbožím jinak, než je nutné k obeznámení se s povahou, vlastnostmi a funkčností zboží.';
const ZADRZENI = 'Přijaté peníze můžeme vrátit až po obdržení vráceného zboží nebo až prokážete, že jste zboží odeslal(a) zpět, podle toho, co nastane dříve.';

function nacist(soubor) {
  return fs.readFileSync(path.join(KOREN, soubor), 'utf8');
}
function text(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

// Jen čl. 2 reklamačního řádu (odstoupení) - čl. 3 a dál jsou o reklamaci vad
function clanek2ReklamacnihoRadu() {
  const html = nacist('reklamacni-rad.html');
  const od = html.indexOf('<h3>2. ');
  const po = html.indexOf('<h3>3. ');
  assert.ok(od !== -1 && po > od, 'reklamační řád: nenalezen čl. 2');
  return text(html.slice(od, po));
}

test('B2.1: reklamační řád čl. 2 nestanoví stav zboží jako podmínku odstoupení a obsahuje odpovědnost za snížení hodnoty', () => {
  const cl2 = clanek2ReklamacnihoRadu();
  assert.doesNotMatch(cl2, /nepoškozen/);
  assert.doesNotMatch(cl2, /nepoužit/);
  assert.doesNotMatch(cl2, /bez známek nošení/);
  assert.doesNotMatch(cl2, /původním obalu/);
  assert.ok(cl2.includes(SNIZENI_HODNOTY), 'chybí věta o snížení hodnoty');
});

test('B2.1: reklamační řád čl. 2 - vrácení peněz do 14 dnů od odstoupení s alternativou prokázání odeslání', () => {
  const cl2 = clanek2ReklamacnihoRadu();
  assert.match(cl2, /do 14 dnů od odstoupení od smlouvy\./);
  assert.ok(cl2.includes(ZADRZENI), 'chybí možnost zadržení do vrácení zboží nebo prokázání odeslání');
  assert.doesNotMatch(cl2, /nejdříve však po obdržení vráceného zboží/);
});

test('B2.1: věta o snížení hodnoty i o zadržení peněz je stejná ve VOP, na stránce odstoupení i v reklamačním řádu', () => {
  for (const soubor of ['obchodni-podminky.html', 'odstoupeni-od-smlouvy.html', 'reklamacni-rad.html']) {
    const t = text(nacist(soubor));
    assert.ok(t.includes(SNIZENI_HODNOTY), `${soubor}: chybí věta o snížení hodnoty`);
    assert.ok(t.includes(ZADRZENI), `${soubor}: chybí věta o zadržení peněz`);
  }
});

async function vyrenderovatPotvrzeniVratky() {
  const emailyPath = require.resolve('../routes/emaily.js');
  delete require.cache[emailyPath];
  const zachycene = [];
  const puvodniFetch = global.fetch;
  global.fetch = async (url, opts) => {
    zachycene.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ id: 'mock' }) };
  };
  try {
    const emaily = require(emailyPath);
    await emaily.odeslat_potvrzeni_vratky({
      objednavka_id: 41, jmeno: 'Jana', email: 'jana@example.com', telefon: '',
      polozky: [{ produkt_id: 1, nazev: 'Beda Trucks BF', velikost: 26, pocet: 1 }], duvod: 'nesedí velikost'
    });
  } finally {
    global.fetch = puvodniFetch;
    delete require.cache[emailyPath];
  }
  assert.equal(zachycene.length, 1);
  return zachycene[0];
}

test('B2.1: potvrzení přijetí vratky nežádá nepoužité zboží v původním obalu a obsahuje větu o snížení hodnoty', async () => {
  const { html, to } = await vyrenderovatPotvrzeniVratky();
  const t = text(html);
  assert.deepEqual(to, ['jana@example.com']);
  assert.doesNotMatch(t, /nepoužit/);
  assert.doesNotMatch(t, /nepoškozen/);
  assert.doesNotMatch(t, /původním obalu/);
  assert.ok(t.includes(SNIZENI_HODNOTY), 'chybí věta o snížení hodnoty');
  assert.ok(t.includes('Holešovská 752, 768 24 Hulín'), 'chybí adresa pro zaslání zboží');
});

test('B2.1: placeholdery čísla objednávky ukazují skutečný formát RRMMNN', () => {
  const odst = nacist('odstoupeni-od-smlouvy.html');
  const eshop = nacist('eshop.html');
  const polePopis = odst.match(/<label>Číslo objednávky<\/label><input[^>]*placeholder="([^"]*)"/);
  const poleEshop = eshop.match(/id="vratkyObjCislo" placeholder="([^"]*)"/);
  assert.ok(polePopis && poleEshop, 'pole čísla objednávky nenalezena');
  for (const p of [polePopis[1], poleEshop[1]]) {
    assert.match(p, /^např\. \d{6}$/, `placeholder "${p}" neodpovídá formátu RRMMNN`);
  }
  assert.equal(polePopis[1], poleEshop[1], 'oba formuláře mají mít stejný příklad');
});
