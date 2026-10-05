// B2.2 - potvrzení vratky zákazníkovi i upozornění majitelce ukazují zákaznické
// číslo objednávky (RRMMNN), ne interní DB id. Bez cisla (staré objednávky,
// starší přímá volání) se použije objednavka_id. Testuje se HTML předané Resendu.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';

async function odeslat(funkce, zadost) {
  const emailyPath = require.resolve('../routes/emaily.js');
  delete require.cache[emailyPath];
  const zachycene = [];
  const puvodniFetch = global.fetch;
  global.fetch = async (url, opts) => {
    zachycene.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ id: 'mock' }) };
  };
  try {
    await require(emailyPath)[funkce](zadost);
  } finally {
    global.fetch = puvodniFetch;
    delete require.cache[emailyPath];
  }
  assert.equal(zachycene.length, 1);
  return zachycene[0];
}

// Interní id 7 se schválně nevyskytuje v žádném jiném údaji e-mailu
const ZADOST = {
  objednavka_id: 7, cislo: '261012', jmeno: 'Jana', email: 'jana@example.com', telefon: '777 123 456',
  polozky: [{ produkt_id: 5, nazev: 'Bota A', velikost: 24, pocet: 1 }], duvod: 'nesedí velikost'
};

test('B2.2: potvrzení vratky zákazníkovi - předmět i tělo s #261012, bez interního id', async () => {
  const { subject, html } = await odeslat('odeslat_potvrzeni_vratky', ZADOST);
  assert.match(subject, /#261012/);
  assert.match(html, /#261012/);
  assert.doesNotMatch(subject, /#7\b/);
  assert.doesNotMatch(html, /#7\b/);
});

test('B2.2: upozornění majitelce - předmět i tělo s #261012', async () => {
  const { subject, html, to } = await odeslat('odeslat_upozorneni_vratky', ZADOST);
  assert.deepEqual(to, ['info@detskekrucky.cz']);
  assert.match(subject, /#261012/);
  assert.match(html, /#261012/);
  assert.doesNotMatch(subject, /#7\b/);
});

test('B2.2: bez cisla se v obou e-mailech použije objednavka_id (fallback)', async () => {
  const { cislo, ...bezCisla } = ZADOST;
  for (const funkce of ['odeslat_potvrzeni_vratky', 'odeslat_upozorneni_vratky']) {
    const { subject, html } = await odeslat(funkce, bezCisla);
    assert.match(subject, /#7\b/, `${funkce}: předmět bez fallbacku`);
    assert.match(html, /#7\b/, `${funkce}: tělo bez fallbacku`);
  }
});

// ═══ B3.3 - potvrzení obsahuje uložené prohlášení a čas přijetí ═══

const PROHLASENI = [
  'Oznamuji, že tímto odstupuji od smlouvy o koupi tohoto zboží.',
  'Objednávka č.: 261012',
  'Jméno: Jana Nováková',
  'E-mail pro potvrzení: jana@example.com',
  'Vracené zboží:',
  '- Bota A, vel. 24, 1 ks'
].join('\n');
// Letní čas: 10:00 UTC = 12:00 v Praze; zimní: 10:00 UTC = 11:00
const ZADOST_B33 = { ...ZADOST, jmeno: 'Jana Nováková', prohlaseni_text: PROHLASENI, vytvoreno: new Date('2026-10-05T10:00:00Z') };
const FORMAT_PRAHA = { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' };

test('B3.3: potvrzení obsahuje serverové jméno, číslo, čas přijetí (Europe/Prague) a přesný text prohlášení', async () => {
  const { html } = await odeslat('odeslat_potvrzeni_vratky', ZADOST_B33);
  assert.match(html, /Ahoj Jana Nováková,/);
  assert.match(html, /#261012/);
  const ocekavanyCas = ZADOST_B33.vytvoreno.toLocaleString('cs-CZ', FORMAT_PRAHA);
  assert.match(ocekavanyCas, /5\. ?10\. ?2026.*12:00/); // formát formatovatDatumCasObjednavky, pražský letní čas
  assert.ok(html.includes(`Datum a čas přijetí:</strong> ${ocekavanyCas}`), 'chybí datum a čas přijetí');
  assert.ok(html.includes(PROHLASENI), 'text prohlášení musí být přesně uložený text');
  assert.match(html, /white-space:pre-line/);
});

test('B3.3: zimní čas přijetí se převede na Europe/Prague (UTC+1)', async () => {
  const vytvoreno = new Date('2026-01-15T10:00:00Z');
  const { html } = await odeslat('odeslat_potvrzeni_vratky', { ...ZADOST_B33, vytvoreno });
  assert.match(html, /Datum a čas přijetí:<\/strong> 15\. ?1\. ?2026 11:00/);
});

test('B3.3: jméno i text prohlášení jsou v potvrzení HTML-escapované', async () => {
  const PAYLOAD = '<img src=x onerror=alert(1)>';
  const { html } = await odeslat('odeslat_potvrzeni_vratky', { ...ZADOST_B33, jmeno: PAYLOAD, prohlaseni_text: `Jméno: ${PAYLOAD}\nDůvod: <b>x</b>` });
  assert.equal(html.includes(PAYLOAD), false);
  assert.equal(html.includes('<b>x</b>'), false);
  assert.ok(html.includes('Jméno: &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('Ahoj &lt;img'));
});

test('B3.3: potvrzení ukazuje jen jméno ze zadost (podvržené jméno z requestu se tam nemá jak dostat)', async () => {
  const { html } = await odeslat('odeslat_potvrzeni_vratky', ZADOST_B33);
  assert.doesNotMatch(html, /Podvržený/);
  const { html: htmlMajitelka } = await odeslat('odeslat_upozorneni_vratky', ZADOST_B33);
  assert.match(htmlMajitelka, /Zákazník:<\/strong> Jana Nováková/);
});

test('B3.3: bez prohlaseni_text a vytvoreno (starší přímá volání) bez bloků a bez undefined/null', async () => {
  for (const [prohlaseni_text, vytvoreno] of [[undefined, undefined], [null, null], ['', 'neplatné datum']]) {
    const { html } = await odeslat('odeslat_potvrzeni_vratky', { ...ZADOST, prohlaseni_text, vytvoreno });
    assert.doesNotMatch(html, /undefined|null|Invalid Date/);
    assert.doesNotMatch(html, /Datum a čas přijetí/);
    assert.doesNotMatch(html, /Text vašeho prohlášení/);
  }
  const { html: bezJmena } = await odeslat('odeslat_potvrzeni_vratky', { ...ZADOST_B33, jmeno: null });
  assert.match(bezJmena, /Ahoj,/);
  assert.doesNotMatch(bezJmena, /undefined|null/);
});
