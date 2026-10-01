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
