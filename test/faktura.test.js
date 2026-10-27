// Faktura k objednávce: šablona (lib/faktura.js), e-mail s fakturou a přílohou,
// endpoint "Poslat fakturu" a tlačítko v adminu
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakturaHtml, fakturaObsahHtml } = require('../lib/faktura');
const { nacistRouterSMocky, najitHandler, vytvoritRes } = require('../test-helpers/_pomocnik');

const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const FAKTURA = { faktura_cislo: '2026007', faktura_datum: new Date('2026-10-27T10:00:00Z') };
const OBJ = {
  id: 41, cislo: '261012', stav: 'odeslana', jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456',
  ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24', doprava: 'zasilkovna', platba: 'dobirka',
  doprava_cena: 79, platba_priplatek: 40, sleva: 100, poukaz_kod: 'DK-AAAA-BBBB', celkem: 1309,
  vydejni_misto_id: '123', vydejni_misto_nazev: 'Hulín, Trávník 1', vydejni_misto_ulice: 'Trávník 1', vydejni_misto_mesto: 'Hulín', vydejni_misto_psc: '76824',
  vytvoreno: new Date('2026-10-26T10:00:00Z'),
  polozky: [{ nazev: 'Froddo Barefoot', velikost: 26, pocet: 1, cena: 1290 }]
};
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('šablona: dodavatel, odběratel, číslo a datum, položky, doprava, dobírka, poukaz, celkem', () => {
  const t = text(fakturaObsahHtml(OBJ, FAKTURA));
  for (const s of ['Faktura 2026007', 'Objednávka #261012', 'Datum vystavení: 27. 10. 2026', 'Monika Škarpichová', 'IČO: 24354635',
    'Jana Nováková', 'Hlavní 1, Hulín 768 24', 'Froddo Barefoot', '1 290 Kč', 'Zásilkovna (doprava) 79 Kč', 'Dobírka (příplatek) 40 Kč',
    'Dárkový poukaz DK-AAAA-BBBB −100 Kč', 'CELKEM 1 309 Kč', 'Výdejní místo: Hulín, Trávník 1, Trávník 1, 76824 Hulín', 'Platba: Dobírka']) {
    assert.ok(t.includes(s), `chybí: ${s}`);
  }
  assert.match(fakturaHtml(OBJ, FAKTURA), /^<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><title>Faktura 2026007<\/title>/);
});

test('šablona: údaje zákazníka a produktu escapované, doprava zdarma', () => {
  const h = fakturaObsahHtml({ ...OBJ, jmeno: '<img src=x onerror=alert(1)>', polozky: [{ nazev: '<b>X</b>', velikost: 25, pocet: 2, cena: 500 }], doprava_cena: 0, sleva: 0, platba_priplatek: 0, vydejni_misto_id: null }, FAKTURA);
  assert.equal(h.includes('<img src=x'), false);
  assert.equal(h.includes('<b>X</b>'), false);
  assert.match(text(h), /Zásilkovna \(doprava\) Zdarma/);
  assert.doesNotMatch(text(h), /Poukaz|Výdejní místo/);
});

test('e-mail: faktura v těle i jako příloha HTML, předmět s číslem faktury a objednávky', async () => {
  const emailyPath = require.resolve('../routes/emaily.js');
  delete require.cache[emailyPath];
  const puvodniFetch = global.fetch, puvodniKlic = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test';
  const zachycene = [];
  global.fetch = async (url, opts) => { zachycene.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ id: 'mock' }) }; };
  try {
    await require(emailyPath).odeslat_fakturu(OBJ, FAKTURA);
  } finally {
    global.fetch = puvodniFetch;
    if (puvodniKlic === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = puvodniKlic;
    delete require.cache[emailyPath];
  }
  assert.equal(zachycene.length, 1);
  const e = zachycene[0];
  assert.deepEqual(e.to, ['jana@example.com']);
  assert.equal(e.subject, 'Faktura 2026007 k objednávce #261012 – Dětské krůčky');
  assert.match(text(e.html), /CELKEM 1 309 Kč/);
  assert.equal(e.attachments.length, 1);
  assert.equal(e.attachments[0].filename, 'faktura-2026007.html');
  assert.match(Buffer.from(e.attachments[0].content, 'base64').toString('utf8'), /<title>Faktura 2026007<\/title>/);
});

function routerSFakturou({ objednavka, odeslat }) {
  const dotazy = [];
  const pool = {
    query: async (sql, params) => {
      dotazy.push(sql);
      if (/FROM objednavky o\s+JOIN zakaznici/.test(sql)) return { rows: objednavka ? [objednavka] : [] };
      if (/FROM objednavky_polozky/.test(sql)) return { rows: OBJ.polozky };
      if (/SET faktura_odeslano = NOW\(\)/.test(sql)) return { rows: [{ faktura_odeslano: '2026-10-27T11:00:00Z' }] };
      return { rows: [] };
    },
    connect: async () => ({
      query: async sql => {
        if (/SELECT faktura_cislo, faktura_datum FROM objednavky/.test(sql)) return { rows: [{ faktura_cislo: '2026007', faktura_datum: FAKTURA.faktura_datum }] };
        return { rows: [] };
      },
      release() {}
    })
  };
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': { odeslat_potvrzeni: async () => {}, odeslat_upozorneni_objednavky: async () => {}, odeslat_email_zmena_stavu: async () => {}, odeslat_fakturu: odeslat }
  });
  return { email: najitHandler(router, 'post', '/:id/faktura-email'), html: najitHandler(router, 'post', '/:id/faktura-html'), dotazy };
}

test('Poslat fakturu: pošle, zapíše čas odeslání; zrušená a neexistující objednávka ne', async () => {
  const poslane = [];
  const { email } = routerSFakturou({ objednavka: OBJ, odeslat: async (o, f) => poslane.push([o.email, f.faktura_cislo]) });
  const res = vytvoritRes();
  await email({ params: { id: '41' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(poslane, [['jana@example.com', '2026007']]);
  assert.equal(res.body.faktura_odeslano, '2026-10-27T11:00:00Z');

  const zrusena = routerSFakturou({ objednavka: { ...OBJ, stav: 'zrusena' }, odeslat: async () => { throw new Error('nemělo se poslat'); } });
  const r2 = vytvoritRes();
  await zrusena.email({ params: { id: '41' } }, r2);
  assert.equal(r2.statusCode, 400);

  const zadna = routerSFakturou({ objednavka: null, odeslat: async () => { throw new Error('nemělo se poslat'); } });
  const r3 = vytvoritRes();
  await zadna.email({ params: { id: '99' } }, r3);
  assert.equal(r3.statusCode, 404);
});

test('Poslat fakturu: chyba odeslání se vrátí adminu a čas odeslání se nezapíše', async () => {
  const { email, dotazy } = routerSFakturou({ objednavka: OBJ, odeslat: async () => { throw new Error('Resend 500'); } });
  const res = vytvoritRes();
  await email({ params: { id: '41' } }, res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.chyba, /Resend 500/);
  assert.equal(dotazy.some(s => /faktura_odeslano = NOW/.test(s)), false);
});

test('tisk faktury v adminu: HTML ze serveru (stejná šablona jako v e-mailu)', async () => {
  const { html } = routerSFakturou({ objednavka: OBJ, odeslat: async () => {} });
  const res = vytvoritRes();
  await html({ params: { id: '41' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.faktura_cislo, '2026007');
  assert.equal(res.body.html, fakturaHtml(OBJ, FAKTURA));
});

test('admin: tlačítko Poslat fakturu v detailu objednávky, skryté u zrušené, s potvrzením', () => {
  assert.match(ADMIN, /id="btnPoslatFakturu" onclick="poslatFakturu\(\)">📧 Poslat fakturu</);
  assert.match(ADMIN, /btnF\.hidden = data\.stav === 'zrusena' \|\| !data\.email;/);
  assert.match(ADMIN, /API\+'\/objednavky\/'\+id\+'\/faktura-email', \{method:'POST'\}/);
  assert.match(ADMIN, /if \(!confirm\('Poslat fakturu na '/);
});
