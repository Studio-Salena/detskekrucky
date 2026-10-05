// P2.8 - žádost o vrácení (POST /api/vratky-zadosti) se musí ověřit proti
// skutečným položkám objednávky, ne jen uložit, co pošle klient.
const test = require('node:test');
const assert = require('node:assert/strict');

let dalsiIp = 300;
function novaIp() { return `10.0.2.${dalsiIp++}`; }

// Objednávka #1, e-mail jana@example.com, objednala 2x bota vel.24 (produkt 5) a 1x bota vel.25 (produkt 6).
const SKUTECNE_POLOZKY = [
  { produkt_id: 5, velikost: 24, pocet: 2, cena: 500, nazev: 'Bota A' },
  { produkt_id: 6, velikost: 25, pocet: 1, cena: 700, nazev: 'Bota B' }
];

// dotazy: volitelný log všech SQL (B3.1 - inicializace tabulky, evidence potvrzení)
function vytvoritMockPool(vlozeneZadosti, dotazy = []) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      dotazy.push({ sql: s, params });
      if (s.startsWith('CREATE TABLE')) return {};
      // Objednávku lze dohledat interním id (1) i zákaznickým číslem (261012) - jako WHERE o.cislo = $1 OR o.id::text = $1
      if (s.startsWith('SELECT o.id, o.cislo, z.email FROM objednavky')) {
        const [id] = params;
        if (id !== '1' && id !== '261012') return { rows: [] };
        return { rows: [{ id: 1, cislo: '261012', email: 'jana@example.com' }] };
      }
      if (s.startsWith('SELECT op.produkt_id, op.velikost, op.pocet, op.cena, p.nazev')) {
        return { rows: SKUTECNE_POLOZKY };
      }
      if (s.startsWith('INSERT INTO vratky_zadosti')) {
        const [objednavka_id, jmeno, email, telefon, polozkyJson, duvod, prohlaseni_text, objednavka_cislo] = params;
        // Řádek jako z RETURNING * - včetně interních sloupců B3.1
        const zaznam = { id: vlozeneZadosti.length + 1, objednavka_id, jmeno, email, telefon, polozky: JSON.parse(polozkyJson), duvod,
          stav: 'nova', vytvoreno: new Date('2026-10-05T10:00:00Z'), prohlaseni_text, objednavka_cislo, potvrzeni_odeslano: null, potvrzeni_chyba: null };
        vlozeneZadosti.push(zaznam);
        return { rows: [zaznam] };
      }
      if (s.startsWith('UPDATE vratky_zadosti SET potvrzeni_')) {
        return { rows: [] };
      }
      throw new Error('Mock nezná dotaz: ' + s);
    }
  };
}

function nacistSMockPoolem(vlozeneZadosti, odeslaneEmaily = [], { dotazy = [], selhaniPotvrzeni = null } = {}) {
  const routePath = require.resolve('../routes/vratkyZadosti.js');
  const poolPath = require.resolve('../db/pool');
  const emailyPath = require.resolve('../routes/emaily');
  delete require.cache[routePath];
  delete require.cache[poolPath];
  delete require.cache[emailyPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: vytvoritMockPool(vlozeneZadosti, dotazy) };
  require.cache[emailyPath] = { id: emailyPath, filename: emailyPath, loaded: true, exports: {
    odeslat_potvrzeni_vratky: async (zadost) => {
      odeslaneEmaily.push({ typ: 'potvrzeni', zadost });
      if (selhaniPotvrzeni) throw new Error(selhaniPotvrzeni);
    },
    odeslat_upozorneni_vratky: async (zadost) => { odeslaneEmaily.push({ typ: 'upozorneni', zadost }); }
  } };
  const router = require(routePath);
  delete require.cache[poolPath];
  delete require.cache[routePath];
  delete require.cache[emailyPath];
  return router;
}

function najitHandler(router, method, urlPath) {
  const layer = router.stack.find(l => l.route && l.route.path === urlPath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function vytvoritRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (kod) { res.statusCode = kod; return res; };
  res.json = function (telo) { res.body = telo; return res; };
  return res;
}

test('žádost o vrácení skutečně objednaných kusů projde a uloží ověřený název/cenu', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }], duvod: 'nesedí velikost' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(vlozene.length, 1);
  assert.equal(vlozene[0].polozky[0].nazev, 'Bota A'); // z DB, ne z requestu
  assert.equal(vlozene[0].polozky[0].cena, 500);
});

test('položka, která v objednávce vůbec nebyla, je odmítnuta', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 999, velikost: 24, pocet: 1 }] } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(vlozene.length, 0);
});

test('vrácení víc kusů, než bylo objednáno, je odmítnuto', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 5 }] } }, res); // objednáno jen 2

  assert.equal(res.statusCode, 400);
  assert.equal(vlozene.length, 0);
});

test('vrácení přes víc řádků se stejnou položkou se sčítá proti objednanému množství', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  // 2x po 1 ks = 2 ks celkem, což je přesně objednané množství - musí projít.
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }, { produkt_id: 5, velikost: 24, pocet: 1 }] } }, res);
  assert.equal(res.statusCode, 200);

  const vlozene2 = [];
  const router2 = nacistSMockPoolem(vlozene2);
  const handler2 = najitHandler(router2, 'post', '/');
  const res2 = vytvoritRes();
  // 2x po 2 ks = 4 ks celkem, což je víc než objednané 2 ks - musí selhat.
  await handler2({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 2 }, { produkt_id: 5, velikost: 24, pocet: 2 }] } }, res2);
  assert.equal(res2.statusCode, 400);
});

test('podvržený název položky se do DB neuloží (uloží se jen ověřený z objednávky)', async () => {
  const vlozene = [];
  const router = nacistSMockPoolem(vlozene);
  const handler = najitHandler(router, 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1, nazev: '<img src=x onerror=alert(1)>', cena: 1 }] } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(vlozene[0].polozky[0].nazev, 'Bota A');
  assert.equal(vlozene[0].polozky[0].cena, 500);
});

// B2.2 - e-maily k vratce dostanou zákaznické číslo objednávky (cislo, RRMMNN)
// z DB; objednavka_id z requestu zůstává beze změny a interní logika (INSERT)
// dál používá skutečné interní id.
test('B2.2: e-maily dostanou cislo z DB, objednavka_id zůstane, INSERT používá interní id', async () => {
  // Jak to posílá e-shop: interní id z /overit
  const vlozene = [];
  const emaily = [];
  const handler = najitHandler(nacistSMockPoolem(vlozene, emaily), 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }] } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(emaily.map(e => e.typ).sort(), ['potvrzeni', 'upozorneni']);
  for (const { zadost } of emaily) {
    assert.equal(zadost.cislo, '261012'); // z DB
    assert.equal(zadost.objednavka_id, 1); // beze změny, jak přišlo
  }
  assert.equal(vlozene[0].objednavka_id, 1); // INSERT se skutecneId

  // Přijme se i zákaznické číslo - INSERT pořád s interním id
  const vlozene2 = [];
  const emaily2 = [];
  const handler2 = najitHandler(nacistSMockPoolem(vlozene2, emaily2), 'post', '/');
  const res2 = vytvoritRes();
  await handler2({ ip: novaIp(), body: { objednavka_id: '261012', email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }] } }, res2);

  assert.equal(res2.statusCode, 200);
  assert.equal(vlozene2[0].objednavka_id, 1);
  assert.equal(emaily2.length, 2);
  assert.equal(emaily2[0].zadost.cislo, '261012');
});

// ═══ B3.1 - evidence online odstoupení (§ 1830a) ═══

// Fire-and-forget evidence potvrzení běží až po res.json - počkat, než doběhne
async function pockatNaAsynchronniPrace() {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

test('B3.1 A: inicializace tabulky přidá idempotentně sloupce evidence', async () => {
  const dotazy = [];
  nacistSMockPoolem([], [], { dotazy });
  await pockatNaAsynchronniPrace();
  const init = dotazy.find(d => d.sql.startsWith('CREATE TABLE IF NOT EXISTS vratky_zadosti'));
  assert.ok(init, 'chybí inicializace tabulky');
  for (const sloupec of ['prohlaseni_text TEXT', 'objednavka_cislo TEXT', 'potvrzeni_odeslano TIMESTAMPTZ', 'potvrzeni_chyba TEXT']) {
    assert.ok(init.sql.includes(`ALTER TABLE vratky_zadosti ADD COLUMN IF NOT EXISTS ${sloupec};`), `chybí ALTER pro ${sloupec}`);
  }
});

test('B3.1 B + C: INSERT uloží prohlášení a číslo objednávky z DB, objednavka_id zůstává interní', async () => {
  for (const vstup of [1, '261012']) {
    const vlozene = [];
    const handler = najitHandler(nacistSMockPoolem(vlozene), 'post', '/');
    const res = vytvoritRes();
    await handler({ ip: novaIp(), body: { objednavka_id: vstup, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }], duvod: 'nesedí velikost' } }, res);

    assert.equal(res.statusCode, 200);
    const z = vlozene[0];
    assert.equal(z.objednavka_id, 1); // skutecneId
    assert.equal(z.objednavka_cislo, '261012'); // z DB, ne z requestu
    const t = z.prohlaseni_text;
    assert.match(t, /^Oznamuji, že tímto odstupuji od smlouvy o koupi tohoto zboží\./);
    assert.match(t, /Objednávka č\.: 261012/);
    assert.match(t, /E-mail pro potvrzení: jana@example\.com/);
    assert.match(t, /- Bota A, vel\. 24, 1 ks/);
    assert.match(t, /Důvod \(nepovinný\): nesedí velikost/);
    assert.doesNotMatch(t, /undefined|null|Jméno:/); // jméno v requestu nepřišlo
    assert.doesNotMatch(t, /</); // prostý text, ne HTML
  }
});

test('B3.1 C: bez důvodu se řádek s důvodem vynechá, jméno se přidá jen když přijde', async () => {
  const vlozene = [];
  const handler = najitHandler(nacistSMockPoolem(vlozene), 'post', '/');
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', jmeno: 'Jana Nováková', polozky: [{ produkt_id: 6, velikost: 25, pocet: 1 }] } }, vytvoritRes());
  const t = vlozene[0].prohlaseni_text;
  assert.match(t, /Jméno: Jana Nováková/);
  assert.match(t, /- Bota B, vel\. 25, 1 ks/);
  assert.doesNotMatch(t, /Důvod|undefined|null/);
});

test('B3.1 D: podvržený název ani cena z requestu se do prohlášení nedostanou', async () => {
  const vlozene = [];
  const handler = najitHandler(nacistSMockPoolem(vlozene), 'post', '/');
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1, nazev: 'Podvržená bota <b>', cena: 1 }] } }, vytvoritRes());
  const t = vlozene[0].prohlaseni_text;
  assert.match(t, /- Bota A, vel\. 24, 1 ks/);
  assert.doesNotMatch(t, /Podvržená|<b>/);
});

test('B3.1 E: po úspěšném potvrzení se zapíše potvrzeni_odeslano a vynuluje chyba', async () => {
  const vlozene = [];
  const dotazy = [];
  const emaily = [];
  const handler = najitHandler(nacistSMockPoolem(vlozene, emaily, { dotazy }), 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }] } }, res);
  await pockatNaAsynchronniPrace();

  assert.equal(res.statusCode, 200);
  const update = dotazy.filter(d => d.sql.startsWith('UPDATE vratky_zadosti'));
  assert.equal(update.length, 1);
  assert.equal(update[0].sql, 'UPDATE vratky_zadosti SET potvrzeni_odeslano = NOW(), potvrzeni_chyba = NULL WHERE id = $1');
  assert.deepEqual(update[0].params, [vlozene[0].id]);
  assert.equal(emaily.filter(e => e.typ === 'upozorneni').length, 1); // upozornění majitelce dál chodí, ale neeviduje se
});

test('B3.1 F: chyba potvrzení se uloží do potvrzeni_chyba (max 500 znaků), odpověď zůstane 200', async () => {
  const vlozene = [];
  const dotazy = [];
  const dlouhaChyba = 'Resend 500: ' + 'x'.repeat(600);
  const handler = najitHandler(nacistSMockPoolem(vlozene, [], { dotazy, selhaniPotvrzeni: dlouhaChyba }), 'post', '/');
  const res = vytvoritRes();
  const puvodniError = console.error;
  console.error = () => {}; // očekávaná chyba - nezahlcovat výstup testů
  try {
    await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }] } }, res);
    await pockatNaAsynchronniPrace();
  } finally { console.error = puvodniError; }

  assert.equal(res.statusCode, 200);
  const update = dotazy.filter(d => d.sql.startsWith('UPDATE vratky_zadosti'));
  assert.equal(update.length, 1);
  assert.equal(update[0].sql, 'UPDATE vratky_zadosti SET potvrzeni_chyba = $1 WHERE id = $2');
  assert.equal(update[0].params[0], dlouhaChyba.slice(0, 500));
  assert.equal(update[0].params[1], vlozene[0].id);
  assert.equal(dotazy.some(d => d.sql.includes('potvrzeni_odeslano = NOW()')), false);
});

test('B3.1 G: veřejná odpověď má jen dosavadní pole, bez interní evidence', async () => {
  const handler = najitHandler(nacistSMockPoolem([]), 'post', '/');
  const res = vytvoritRes();
  await handler({ ip: novaIp(), body: { objednavka_id: 1, email: 'jana@example.com', telefon: '777 123 456', polozky: [{ produkt_id: 5, velikost: 24, pocet: 1 }], duvod: 'x' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['duvod', 'email', 'id', 'jmeno', 'objednavka_id', 'polozky', 'stav', 'telefon', 'vytvoreno']);
  for (const interni of ['prohlaseni_text', 'objednavka_cislo', 'potvrzeni_odeslano', 'potvrzeni_chyba']) {
    assert.equal(interni in res.body, false, `${interni} nesmí být ve veřejné odpovědi`);
  }
});
