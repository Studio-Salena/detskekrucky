// Krok B1 - potvrzení objednávky musí v textové podobě obsahovat údaje
// o prodávajícím, poučení o odstoupení, vzorový formulář, reklamace, ADR a VOP
// (§ 1824a, § 1827 odst. 2 obč. zák.), převzaté z veřejných stránek webu
// (lib/pravniTexty.js). Testuje se skutečné HTML předané Resendu (mock fetch).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';

const KOREN = path.join(__dirname, '..');
const VOP_HTML = fs.readFileSync(path.join(KOREN, 'obchodni-podminky.html'), 'utf8');
const ODSTOUPENI_HTML = fs.readFileSync(path.join(KOREN, 'odstoupeni-od-smlouvy.html'), 'utf8');

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

const OBJEDNAVKA = {
  objednavka_id: 41, cislo: '261001', celkem: 1369, jmeno: 'Jana Nováková', email: 'jana@example.com',
  telefon: '777 123 456', ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
  doprava: 'zasilkovna', platba: 'prevod', sleva: 0,
  polozky: [{ produkt_id: 1, nazev: 'Beda Trucks BF', velikost: 26, pocet: 1, cena: 1290 }],
  // 1. 10. 2026 15:58 UTC = 17:58 v Praze (letní čas)
  vytvoreno: new Date('2026-10-01T15:58:00Z')
};

async function vyrenderovatPotvrzeni(objednavka = OBJEDNAVKA) {
  const { emaily, zachycene, obnovitFetch } = nacistEmailySZachycenymFetch();
  try {
    await emaily.odeslat_potvrzeni(objednavka);
  } finally { obnovitFetch(); }
  assert.equal(zachycene.length, 1);
  return zachycene[0];
}

// Text e-mailu bez tagů (pro hledání vět, které se v HTML lámou styly/entitami)
function text(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

test('B1 test 1: potvrzení obsahuje objednávku, datum a čas objednávky, prodávajícího, VOP, poučení, formulář, reklamace a ADR', async () => {
  const { html, subject, to } = await vyrenderovatPotvrzeni();
  const t = text(html);
  assert.deepEqual(to, ['jana@example.com']);
  assert.match(subject, /#261001/);
  // současný obsah objednávky zůstal
  for (const s of ['Jana Nováková', 'Hlavní 1', '768 24 Hulín', 'jana@example.com', '777 123 456', 'Beda Trucks BF',
    'Zásilkovna', 'Bankovní převod', 'CELKEM K ÚHRADĚ', '1369 Kč', '2003533776/2010', 'QR platba']) {
    assert.ok(html.includes(s), `chybí: ${s}`);
  }
  assert.match(t, /Datum a čas objednávky: 1\. 10\. 2026 17:58/);
  // prodávající (z rámečku VOP čl. 1)
  for (const s of ['Monika Škarpichová', 'IČO: 24354635', 'Adresa sídla: Včelín 1164, 768 24 Hulín',
    'Adresa prodejny: Holešovská 752, 768 24 Hulín', 'Telefon: 773 517 733', 'E-mail: info@detskekrucky.cz']) {
    assert.ok(t.includes(s), `chybí údaj prodávajícího: ${s}`);
  }
  // sekce právních informací
  for (const s of ['Poučení o odstoupení od smlouvy', 'Vzorový formulář pro odstoupení od smlouvy',
    'Reklamace a práva z vadného plnění', 'Mimosoudní řešení sporů', 'Obchodní podmínky']) {
    assert.ok(t.includes(s), `chybí sekce: ${s}`);
  }
  assert.ok(t.includes('Lhůta pro odstoupení od smlouvy je 14 dnů od převzetí zboží'));
  assert.ok(t.includes('Náklady na vrácení zboží nese kupující'));
  assert.ok(t.includes('Oznamuji/oznamujeme*, že tímto odstupuji/odstupujeme* od smlouvy'));
  assert.ok(t.includes('Jméno a příjmení spotřebitele/spotřebitelů: ____'));
  assert.ok(t.includes('doba pro uplatnění práv z vadného plnění'));
  assert.ok(t.includes('Česká obchodní inspekce'));
  assert.ok(t.includes('9. Závěrečná ustanovení')); // VOP celé až do konce
  // odkazy jsou jen doplněk
  assert.ok(html.includes('https://www.detskekrucky.cz/obchodni-podminky.html'));
  assert.ok(html.includes('https://www.detskekrucky.cz/eshop.html?vratky=1'));
});

test('B1 test 1b: z HTML stránek nejde do e-mailu žádný skript, formulářový prvek ani tlačítko', async () => {
  const { html } = await vyrenderovatPotvrzeni();
  assert.doesNotMatch(html, /<script|<input|<textarea|<button|onclick|window\.print/i);
  assert.doesNotMatch(text(html), /Vytisknout formulář|Vyplnit online rovnou/);
});

test('B1 test 2: vlastní text e-mailu netvrdí okamžik uzavření smlouvy (citované VOP se nepočítá)', async () => {
  const { html } = await vyrenderovatPotvrzeni();
  const start = html.indexOf('<!--VOP-START-->');
  const konec = html.indexOf('<!--VOP-END-->');
  assert.ok(start !== -1 && konec > start, 'VOP musí být jasně ohraničené');
  const mimoVop = text(html.slice(0, start) + html.slice(konec));
  assert.doesNotMatch(mimoVop, /smlouv\w* (je|byla|bude) uzavřen/i);
  assert.doesNotMatch(mimoVop, /datum uzavření smlouvy/i);
  assert.doesNotMatch(mimoVop, /smlouva vznikla/i);
  assert.doesNotMatch(mimoVop, /uzavření smlouvy:/i);
});

test('B1 test 3: e-mail obsahuje opravené znění o vrácení peněz (od odstoupení, s možností zadržet)', async () => {
  const t = text((await vyrenderovatPotvrzeni()).html);
  assert.ok(t.includes('Peníze vrátíme do 14 dnů od odstoupení od smlouvy'));
  assert.ok(t.includes('můžeme vrátit až po obdržení vráceného zboží nebo až prokážete, že jste zboží odeslal(a) zpět, podle toho, co nastane dříve'));
  assert.doesNotMatch(t, /do 14 dnů od obdržení vráceného zboží/);
});

test('B1 test 4: VOP už neobsahují starou lhůtu "do 14 dnů od obdržení vráceného zboží"', () => {
  assert.doesNotMatch(VOP_HTML, /do 14 dnů od obdržení vráceného zboží/);
  assert.match(VOP_HTML, /Peníze vrátíme do 14 dnů od odstoupení od smlouvy/);
});

test('B1 test 5: stránka odstoupení už neobsahuje starou lhůtu', () => {
  assert.doesNotMatch(ODSTOUPENI_HTML, /do 14 dnů od obdržení vráceného zboží/);
  assert.match(ODSTOUPENI_HTML, /Peníze vrátíme do 14 dnů od odstoupení od smlouvy/);
});

test('B1: bez vytvoreno se řádek s datem vynechá, nic nespadne', async () => {
  const { vytvoreno, ...bezData } = OBJEDNAVKA;
  const { html } = await vyrenderovatPotvrzeni(bezData);
  assert.doesNotMatch(html, /Datum a čas objednávky/);
  assert.ok(html.includes('Poučení o odstoupení od smlouvy'));
});

// Testy 6 + 7: skutečný POST /api/objednavky - potvrzení se dál posílá
// a dostává údaje TÉTO objednávky (snímek obj_*), ne uložený profil zákazníka.
function pripravitObjednavku(zachyceneArgumenty) {
  const stav = pocatecniStav();
  stav.sklad.push({ produkt_id: 1, velikost: 24, pocet_kusu: 3, dostupnost: 'skladem', cena: 500, nazev: 'Bota' });
  // Existující profil se STEJNÝM e-mailem, ale jinými údaji - nesmí se dostat do e-mailu
  stav.zakaznici.push({ id: 900, jmeno: 'Cizí Profil', email: 'jana@example.com', telefon: '600 000 000', ulice: 'Jiná 9', mesto: 'Brno', psc: '60200' });
  const pool = vytvoritMockPool(stav);
  const VYTVORENO = new Date('2026-10-01T08:30:00Z');
  // Sdílený mock vrací z INSERT INTO objednavky jen id - tady doplníme
  // vytvoreno, jak ho vrátí skutečná DB (RETURNING id, vytvoreno).
  function sVytvorenym(query) {
    return async (sql, params) => {
      const r = await query(sql, params);
      return /^\s*INSERT INTO objednavky \(/.test(sql) ? { rows: r.rows.map(x => ({ ...x, vytvoreno: VYTVORENO })) } : r;
    };
  }
  const puvodniConnect = pool.connect.bind(pool);
  pool.connect = async () => { const c = await puvodniConnect(); c.query = sVytvorenym(c.query.bind(c)); return c; };
  pool.query = sVytvorenym(pool.query.bind(pool));
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': {
      odeslat_potvrzeni: async (o) => { zachyceneArgumenty.push(o); },
      odeslat_upozorneni_objednavky: async () => {},
      odeslat_email_zmena_stavu: async () => {}
    }
  });
  return { handler: najitHandler(router, 'post', '/'), stav, VYTVORENO };
}

test('B1 test 6 + 7: objednávka dál projde a potvrzení dostane údaje této objednávky včetně vytvoreno', async () => {
  const argumenty = [];
  const { handler, stav, VYTVORENO } = pripravitObjednavku(argumenty);
  const res = vytvoritRes();
  await handler({
    ip: '10.0.0.41',
    body: {
      jmeno: 'Jana Nováková', email: 'jana@example.com', telefon: '777 123 456',
      ulice: 'Hlavní 1', mesto: 'Hulín', psc: '768 24',
      doprava: 'osobni_odber', platba: 'prevod', poznamka: '',
      polozky: [{ produkt_id: 1, velikost: 24, pocet: 1, cena: 1 }]
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(argumenty.length, 1, 'potvrzení se musí odeslat právě jednou');
  const o = argumenty[0];
  assert.equal(o.jmeno, 'Jana Nováková');
  assert.equal(o.ulice, 'Hlavní 1');
  assert.equal(o.telefon, '777 123 456');
  assert.equal(o.celkem, 500); // cena z DB, ne z requestu
  assert.equal(o.vytvoreno, VYTVORENO);
  // shoda se snímkem uloženým u objednávky, profil zákazníka zůstal nedotčen
  const ulozena = stav.objednavky[0];
  assert.equal(ulozena.obj_jmeno, o.jmeno);
  assert.equal(ulozena.obj_ulice, o.ulice);
  assert.equal(stav.zakaznici.find(z => z.id === 900).jmeno, 'Cizí Profil');
  assert.notEqual(o.jmeno, 'Cizí Profil');
});

// Krok B1.1 - původní obal ani "nepoužité" nesmí být podmínkou odstoupení;
// zůstává jen zákonná odpovědnost za snížení hodnoty (§ 1833, vzor NV 29/2023 pokyn [6] c).
const SNIZENI_HODNOTY = 'Odpovídáte pouze za snížení hodnoty zboží, které vzniklo v důsledku nakládání s tímto zbožím jinak, než je nutné k obeznámení se s povahou, vlastnostmi a funkčností zboží.';

function textStranky(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

test('B1.1 test 1: VOP už nestanoví původní obal ani nepoužité zboží jako podmínku odstoupení', () => {
  const vop = textStranky(fs.readFileSync(path.join(KOREN, 'obchodni-podminky.html'), 'utf8'));
  assert.doesNotMatch(vop, /původním obalu/);
  assert.doesNotMatch(vop, /musí být vráceno/);
  assert.doesNotMatch(vop, /nepoužité/);
});

test('B1.1 test 2: stránka odstoupení už nežádá nepoužité zboží v původním obalu', () => {
  const odst = textStranky(fs.readFileSync(path.join(KOREN, 'odstoupeni-od-smlouvy.html'), 'utf8'));
  assert.doesNotMatch(odst, /původním obalu/);
  assert.doesNotMatch(odst, /nepoužité/);
});

test('B1.1 test 3 + 4: potvrzovací e-mail už formulaci o obalu nerozesílá a obsahuje odpovědnost za snížení hodnoty', async () => {
  const t = text((await vyrenderovatPotvrzeni()).html);
  assert.doesNotMatch(t, /původním obalu/);
  assert.doesNotMatch(t, /musí být vráceno/);
  assert.ok(t.includes(SNIZENI_HODNOTY), 'chybí informace o odpovědnosti za snížení hodnoty');
});

test('B1.1 test 4: odpovědnost za snížení hodnoty zůstala ve VOP i na stránce odstoupení', () => {
  for (const soubor of ['obchodni-podminky.html', 'odstoupeni-od-smlouvy.html']) {
    const t = textStranky(fs.readFileSync(path.join(KOREN, soubor), 'utf8'));
    assert.ok(t.includes(SNIZENI_HODNOTY), `${soubor}: chybí věta o snížení hodnoty`);
  }
});
