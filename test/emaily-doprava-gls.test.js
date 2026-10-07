// E-maily k objednávce s dopravou GLS do výdejního místa (2026-10): ověřené
// výdejní místo v potvrzení i v upozornění majitelce, escapované; cena dopravy
// z uložené hodnoty doprava_cena.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';

async function vyrenderovat(funkce, objednavka) {
  const emailyPath = require.resolve('../routes/emaily.js');
  delete require.cache[emailyPath];
  const zachycene = [];
  const puvodniFetch = global.fetch;
  global.fetch = async (url, opts) => { zachycene.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ id: 'mock' }) }; };
  try {
    const emaily = require(emailyPath);
    await emaily[funkce](objednavka);
  } finally { global.fetch = puvodniFetch; delete require.cache[emailyPath]; }
  assert.equal(zachycene.length, 1);
  return zachycene[0].html;
}

const OBJ = {
  objednavka_id: 5, cislo: '261020', celkem: 569, jmeno: 'Jana Nováková', email: 'jana@example.com',
  telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
  doprava: 'gls_vydejni_misto', platba: 'prevod', sleva: 0, doprava_cena: 69,
  polozky: [{ produkt_id: 1, nazev: 'Bota', velikost: 24, pocet: 1, cena: 500 }],
  vydejni_misto: { id: '39301-ELPESRO', nazev: 'Elpe <b>s.r.o.</b>', ulice: 'Myslotínská 2449', mesto: 'Pelhřimov', psc: '39301', stat: 'CZ' },
  vytvoreno: new Date('2026-10-07T10:00:00Z')
};

test('potvrzení zákazníkovi: GLS výdejní místo s adresou a ID, escapované; doprava 69 Kč', async () => {
  const html = await vyrenderovat('odeslat_potvrzeni', OBJ);
  assert.match(html, /GLS – výdejní místo/);
  assert.match(html, /Výdejní místo:<\/strong> Elpe &lt;b&gt;s\.r\.o\.&lt;\/b&gt;, Myslotínská 2449, 39301 Pelhřimov \(ID 39301-ELPESRO\)/);
  assert.equal(html.includes('<b>s.r.o.</b>'), false);
  assert.match(html, /GLS – výdejní místo \(doprava\)<\/td><td[^>]*>69 Kč/);
});

test('upozornění majitelce: názvy dopravy a platby, výdejní místo s ID', async () => {
  const html = await vyrenderovat('odeslat_upozorneni_objednavky', OBJ);
  assert.match(html, /<strong>Doprava:<\/strong> GLS – výdejní místo/);
  assert.match(html, /<strong>Platba:<\/strong> Bankovní převod/);
  assert.match(html, /\(ID 39301-ELPESRO\)/);
});

test('bez výdejního místa a bez doprava_cena: beze změny (cena se dopočítá jako dřív)', async () => {
  const html = await vyrenderovat('odeslat_potvrzeni', { ...OBJ, doprava: 'zasilkovna', doprava_cena: undefined, vydejni_misto: null, celkem: 579 });
  assert.doesNotMatch(html, /Výdejní místo/);
  assert.match(html, /Zásilkovna \(doprava\)<\/td><td[^>]*>79 Kč/);
});
