// P2.9 - e-mailové šablony (routes/emaily.js) musí escapovat zákaznická
// data (jméno, adresa, poznámka...), jinak jde HTML propašovat do e-mailu.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';

function nacistEmailySZachycenymFetch() {
  const emailyPath = require.resolve('../routes/emaily.js');
  delete require.cache[emailyPath];
  const zachycene = [];
  const puvodniFetch = global.fetch;
  global.fetch = async (url, opts) => {
    zachycene.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ id: 'mock' }) };
  };
  const emaily = require(emailyPath);
  delete require.cache[emailyPath];
  return { emaily, zachycene, obnovitFetch: () => { global.fetch = puvodniFetch; } };
}

const PAYLOAD = '<img src=x onerror=alert(1)>';

test('escH() z emaily.js neutralizuje XSS payload', () => {
  const { emaily, obnovitFetch } = nacistEmailySZachycenymFetch();
  try {
    const vysledek = emaily.escH(PAYLOAD);
    assert.equal(vysledek.includes('<'), false);
    assert.equal(vysledek.includes('>'), false);
  } finally { obnovitFetch(); }
});

test('potvrzení objednávky zákazníkovi escapuje jméno a poznámkové údaje', async () => {
  const { emaily, zachycene, obnovitFetch } = nacistEmailySZachycenymFetch();
  try {
    await emaily.odeslat_potvrzeni({
      objednavka_id: 1, celkem: 500, jmeno: PAYLOAD, email: 'jana@example.com',
      doprava: 'osobni_odber', platba: 'prevod', sleva: 0,
      polozky: [{ nazev: PAYLOAD, velikost: 24, pocet: 1, cena: 500 }]
    });
    const html = zachycene[0].html;
    assert.equal(html.includes(PAYLOAD), false, 'nesmí obsahovat syrový payload');
    assert.ok(html.includes('&lt;img'), 'musí obsahovat escapovanou verzi');
  } finally { obnovitFetch(); }
});

test('upozornění majitelce o objednávce escapuje adresu zákazníka', async () => {
  const { emaily, zachycene, obnovitFetch } = nacistEmailySZachycenymFetch();
  try {
    await emaily.odeslat_upozorneni_objednavky({
      objednavka_id: 1, celkem: 500, jmeno: 'Jana', email: 'jana@example.com',
      telefon: '777123456', ulice: PAYLOAD, mesto: 'Hulín', psc: '76824',
      doprava: 'osobni_odber', platba: 'prevod', sleva: 0, polozky: []
    });
    const html = zachycene[0].html;
    assert.equal(html.includes(PAYLOAD), false);
  } finally { obnovitFetch(); }
});

test('upozornění majitelce o rezervaci escapuje poznámku', async () => {
  const { emaily, zachycene, obnovitFetch } = nacistEmailySZachycenymFetch();
  try {
    await emaily.odeslat_upozorneni_rezervace(
      { jmeno: 'Jana', telefon: '777123456', email: 'jana@example.com', poznamka: PAYLOAD },
      { datum: '2026-01-01', cas_od: '10:00:00', cas_do: '10:30:00' },
      'nova'
    );
    const html = zachycene[0].html;
    assert.equal(html.includes(PAYLOAD), false);
  } finally { obnovitFetch(); }
});

test('upozornění majitelce o vrácení escapuje důvod', async () => {
  const { emaily, zachycene, obnovitFetch } = nacistEmailySZachycenymFetch();
  try {
    await emaily.odeslat_upozorneni_vratky({
      objednavka_id: 1, jmeno: 'Jana', email: 'jana@example.com', telefon: '777123456',
      duvod: PAYLOAD, polozky: [{ nazev: 'Bota', velikost: 24, pocet: 1 }]
    });
    const html = zachycene[0].html;
    assert.equal(html.includes(PAYLOAD), false);
  } finally { obnovitFetch(); }
});

test('upozornění majitelce z poradny escapuje poznámku', async () => {
  const { emaily, zachycene, obnovitFetch } = nacistEmailySZachycenymFetch();
  try {
    await emaily.odeslat_upozorneni_poradna({ email: 'jana@example.com', telefon: '777123456', poznamka: PAYLOAD });
    const html = zachycene[0].html;
    assert.equal(html.includes(PAYLOAD), false);
  } finally { obnovitFetch(); }
});
