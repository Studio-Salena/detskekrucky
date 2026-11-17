// Prodej v pokladně (POST /api/prodejna) – vše v JEDNÉ transakci na serveru:
// odečet skladu, slevový kód akce, čerpání dárkového poukazu (celý nákup nebo
// s doplatkem) a uložení účtenky. Buď se uloží všechno, nebo nic.
//
// Dřív pokladna v prohlížeči volala zvlášť /sklad/odecist (chyby ignorovala),
// pak /prodejna a nakonec /poukazy/pouzit - při výpadku spojení mohl vzniknout
// prodej bez odečtu skladu, odečet bez prodeje, nebo platba poukazem bez
// vyčerpání poukazu. Opakované kliknutí uložilo prodej dvakrát.
//
// Ochrana proti dvojímu uložení: pokladna pro každý prodej vygeneruje klíč
// (`klic`, náhodné UUID) a při opakovaném odeslání (výpadek, druhé kliknutí)
// posílá stejný. Server klíč zamkne (advisory lock), a když prodej s ním už
// existuje, nic dalšího neudělá a vrátí uložený prodej (`opakovane: true`).
// Jiný obsah se stejným klíčem = chyba 409 (nejde omylem přepsat jiný nákup).
//
// Tvar uloženého záznamu zůstává stejný jako dřív, aby seděly uzávěrky,
// reporty i účetnictví:
//   - celý nákup poukazem: platba 'poukaz', celkem = cena zboží (uzávěrka ho
//     odečítá jako „Z toho poukazem“), poukaz_castka NULL, nově i poukaz_kod
//   - poukaz + doplatek: platba = způsob doplatku, celkem = doplatek,
//     poukaz_castka = část z poukazu, poukaz_kod
//   - slevový kód: sleva a sleva_popis spočítá server, zápis do promo_pouziti

const crypto = require('node:crypto');
const { poukazPoPlatnosti } = require('./poukazPlatnost');
const { najitPoukaz } = require('./poukazKarty');
const promo = require('./promo');
const evidence = require('./evidencePlateb');

const PLATBY = ['hotovost', 'karta', 'qr', 'poukaz'];
const PLATBY_DOPLATKU = ['hotovost', 'karta', 'qr'];
const MAX_POLOZEK = 100;

const kc = n => Math.round(Number(n) * 100) / 100;
const shoda = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

class ChybaProdeje extends Error {
  constructor(status, chyba, data) { super(chyba); this.status = status; this.chyba = chyba; this.data = data || {}; }
}

// Kontrola a sjednocení vstupu z pokladny - bez databáze.
// Vrací { chyba, status } nebo připravený prodej.
function pripravitProdej(body) {
  const b = body || {};
  const klic = typeof b.klic === 'string' ? b.klic.trim() : '';
  if (!klic) return { status: 409, chyba: 'Pokladna v tomto okně je zastaralá. Obnovte stránku administrace (Ctrl+F5) a prodej zadejte znovu.' };
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(klic)) return { status: 400, chyba: 'Neplatný identifikátor prodeje.' };

  if (!Array.isArray(b.polozky) || !b.polozky.length) return { status: 400, chyba: 'Chybí položky prodeje.' };
  if (b.polozky.length > MAX_POLOZEK) return { status: 400, chyba: 'Příliš mnoho položek v jednom prodeji.' };
  const polozky = [];
  for (const p of b.polozky) {
    if (!p || typeof p !== 'object') return { status: 400, chyba: 'Neplatná položka prodeje.' };
    if (p.typ === 'poukaz') return { status: 400, chyba: 'Dárkový poukaz se prodává v sekci Dárkové poukazy, ne v pokladně.' };
    const pocet = Number(p.pocet), cena = Number(p.cena);
    if (!Number.isInteger(pocet) || pocet <= 0 || pocet > 1000) return { status: 400, chyba: 'Neplatný počet kusů.' };
    if (!Number.isFinite(cena) || cena < 0 || cena > 1e6) return { status: 400, chyba: 'Neplatná cena položky.' };
    const polozka = { nazev: String(p.nazev == null ? '' : p.nazev).slice(0, 200), pocet, cena: kc(cena) };
    // Položka bez produktu (ruční řádek) se jen zapíše, sklad se nemění
    if (p.produkt_id != null && p.produkt_id !== '') {
      const produktId = Number(p.produkt_id);
      const velikost = p.velikost == null ? '' : String(p.velikost).trim();
      if (!Number.isInteger(produktId) || produktId <= 0) return { status: 400, chyba: 'Neplatný produkt v položce prodeje.' };
      if (!velikost) return { status: 400, chyba: `U položky ${polozka.nazev || produktId} chybí velikost.` };
      Object.assign(polozka, { produkt_id: produktId, velikost });
    }
    polozky.push(polozka);
  }
  const mezisoucet = kc(polozky.reduce((s, p) => s + p.pocet * p.cena, 0));

  const platba = b.platba == null || b.platba === '' ? null : String(b.platba);
  if (!PLATBY.includes(platba)) return { status: 400, chyba: 'Vyberte způsob platby.' };

  const promoKod = b.promo_kod ? promo.normalizovatKod(b.promo_kod) : null;
  let slevaRucni = 0;
  if (!promoKod && b.sleva != null && b.sleva !== '') {
    slevaRucni = kc(b.sleva);
    if (!Number.isFinite(slevaRucni) || slevaRucni < 0 || slevaRucni > mezisoucet) return { status: 400, chyba: 'Neplatná sleva.' };
  }

  const poukazKod = platba === 'poukaz' ? String(b.poukaz_kod || '').trim() : '';
  if (platba === 'poukaz' && !poukazKod) return { status: 400, chyba: 'Zadejte kód poukazu.' };
  const doplatekPlatba = platba === 'poukaz' && b.doplatek_platba ? String(b.doplatek_platba) : null;
  if (doplatekPlatba && !PLATBY_DOPLATKU.includes(doplatekPlatba)) return { status: 400, chyba: 'Vyberte, jak zákazník doplatí zbytek.' };

  let hotovostPrijato = null;
  if (b.hotovost_prijato != null && b.hotovost_prijato !== '' && Number(b.hotovost_prijato) > 0) {
    hotovostPrijato = kc(b.hotovost_prijato);
    if (!Number.isFinite(hotovostPrijato) || hotovostPrijato > 1e7) return { status: 400, chyba: 'Neplatná přijatá hotovost.' };
  }
  // Částka, kterou pokladna ukázala zákazníkovi - server ji jen porovná
  const ocekavaneCelkem = b.celkem == null || b.celkem === '' ? null : Number(b.celkem);

  const vstup = {
    klic, polozky, mezisoucet, platba, promoKod, slevaRucni,
    slevaPopis: !promoKod && slevaRucni > 0 && b.sleva_popis ? String(b.sleva_popis).slice(0, 200) : null,
    poukazKod, doplatekPlatba, hotovostPrijato, ocekavaneCelkem,
    zakaznik: b.zakaznik ? String(b.zakaznik).slice(0, 200) : null,
    poznamka: b.poznamka ? String(b.poznamka).slice(0, 1000) : null
  };
  vstup.otisk = otiskProdeje(vstup);
  vstup.obsahOtisk = otiskObsahu(vstup);
  // „Ano, je to další nákup“ po upozornění na možnou duplicitu - není součástí otisku
  vstup.potvrditDuplicitu = b.potvrdit_duplicitu === true;
  return vstup;
}

// Otisk samotného nákupu (zboží, ceny, platba, poukaz, sleva) - bez klíče,
// hotovosti, jména a poznámky. Slouží k upozornění na stejný nákup zadaný znovu.
function otiskObsahu(v) {
  const data = JSON.stringify([
    v.polozky.map(p => [p.produkt_id || null, p.velikost || null, p.pocet, p.cena, p.produkt_id ? '' : p.nazev]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1),
    v.platba, v.promoKod, v.slevaRucni, v.poukazKod.toUpperCase(), v.doplatekPlatba
  ]);
  return crypto.createHash('sha256').update(data).digest('hex');
}

const OKNO_DUPLICITY_MIN = 30;

// Zámek klíče prodeje - stejný pro uložení i „Zahodit“
const zamknoutKlic = (client, klic) => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['prodejna:' + klic]);

// „Zahodit“ nepotvrzený prodej: když ho server pod klíčem uložil, nezahodí se
// (vrátí se uložený), jinak se klíč zneplatní. Volat v transakci.
async function zahoditKlic(client, klic) {
  await zamknoutKlic(client, klic);
  const prodej = (await client.query('SELECT * FROM prodejna_prodeje WHERE klic = $1', [klic])).rows[0];
  if (prodej) return { stav: 'ulozeny', prodej };
  await client.query('INSERT INTO prodejna_klice_zahozene (klic) VALUES ($1) ON CONFLICT (klic) DO NOTHING', [klic]);
  return { stav: 'zahozeny' };
}

// Otisk obsahu prodeje - stejný klíč s jiným obsahem se odmítne
function otiskProdeje(v) {
  const data = JSON.stringify([
    v.polozky.map(p => [p.produkt_id || null, p.velikost || null, p.pocet, p.cena, p.nazev]),
    v.platba, v.promoKod, v.slevaRucni, v.poukazKod.toUpperCase(), v.doplatekPlatba, v.hotovostPrijato
  ]);
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Sklad: jen položky s produktem, sečtené po variantách, zamykané v pevném
// pořadí (dva souběžné prodeje stejných bot se nezablokují navzájem)
function variantyKOdectu(polozky) {
  const mapa = new Map();
  for (const p of polozky) {
    if (!p.produkt_id) continue;
    const klic = p.produkt_id + '\u0000' + p.velikost;
    const v = mapa.get(klic) || { produkt_id: p.produkt_id, velikost: p.velikost, pocet: 0, nazev: p.nazev };
    v.pocet += p.pocet;
    mapa.set(klic, v);
  }
  return [...mapa.values()].sort((a, b) => a.produkt_id - b.produkt_id || (a.velikost < b.velikost ? -1 : a.velikost > b.velikost ? 1 : 0));
}

// Mezisoučet a základ slevového kódu (zboží, které není ve slevě - jako e-shop)
async function zakladPromo(db, polozky) {
  const ids = [...new Set(polozky.filter(p => p.produkt_id).map(p => p.produkt_id))];
  const veSleve = new Set(ids.length
    ? (await db.query('SELECT id FROM produkty WHERE id = ANY($1::int[]) AND cena_pred_slevou IS NOT NULL', [ids])).rows.map(r => r.id)
    : []);
  return kc(polozky.reduce((s, p) => s + (veSleve.has(p.produkt_id) ? 0 : p.pocet * p.cena), 0));
}

const popisPromo = v => `kód ${v.kod} – ${v.procenta} %`;

// Uložení prodeje. Volat uvnitř transakce (BEGIN už proběhl). Vrací
// { prodej, opakovane }. Při chybě vyhodí ChybaProdeje - volající dá ROLLBACK.
async function ulozitProdej(client, v) {
  // 1) Stejný klíč = stejný prodej: serializovat a případně vrátit uložený
  await zamknoutKlic(client, v.klic);
  const drivejsi = (await client.query('SELECT * FROM prodejna_prodeje WHERE klic = $1', [v.klic])).rows[0];
  if (drivejsi) {
    if (drivejsi.klic_otisk !== v.otisk) {
      throw new ChybaProdeje(409, `Předchozí pokus o prodej se uložil jako účtenka #${drivejsi.id} (s jiným obsahem). Zkontrolujte ji v seznamu prodejů.`, { ulozeny_prodej_id: drivejsi.id });
    }
    return { prodej: drivejsi, opakovane: true };
  }
  if ((await client.query('SELECT 1 FROM prodejna_klice_zahozene WHERE klic = $1', [v.klic])).rows.length) {
    throw new ChybaProdeje(409, 'Tento prodej byl v pokladně zahozen a už se neuloží. Pokud zákazník opravdu nakupuje, zadejte nákup znovu.', { zahozeno: true });
  }
  // Stejný nákup před chvílí (typicky po ztracené odpovědi a „Zahodit“) - jen s potvrzením
  if (!v.potvrditDuplicitu) {
    const stejny = (await client.query(
      `SELECT id, datum FROM prodejna_prodeje WHERE obsah_otisk = $1 AND datum > NOW() - make_interval(mins => $2) ORDER BY id DESC LIMIT 1`,
      [v.obsahOtisk, OKNO_DUPLICITY_MIN])).rows[0];
    if (stejny) {
      const min = Math.max(0, Math.round((Date.now() - new Date(stejny.datum).getTime()) / 60000));
      throw new ChybaProdeje(409, `Stejný nákup už je uložený jako účtenka #${stejny.id} (před ${min} min).`, { mozna_duplicita: true, ulozeny_prodej_id: stejny.id });
    }
  }

  // 2) Sklad - zamknout a ověřit (stejné pořadí zámků jako e-shop: sklad → akce → poukaz)
  const varianty = variantyKOdectu(v.polozky);
  for (const p of varianty) {
    const r = (await client.query('SELECT pocet_kusu FROM sklad WHERE produkt_id = $1 AND velikost = $2 FOR UPDATE', [p.produkt_id, p.velikost])).rows[0];
    if (!r || Number(r.pocet_kusu) < p.pocet) {
      const ma = r ? Number(r.pocet_kusu) : 0;
      throw new ChybaProdeje(400, `${p.nazev || 'Zboží'} vel. ${p.velikost}: na skladě ${ma} ks, prodává se ${p.pocet} ks. Zkontrolujte sklad, prodej se neuložil.`);
    }
  }

  // 3) Sleva: ruční z pokladny, nebo slevový kód (spočítá server pod zámkem akce)
  let sleva = v.slevaRucni, slevaPopis = v.slevaPopis, promoVysledek = null, zaklad = null;
  if (v.promoKod) {
    zaklad = await zakladPromo(client, v.polozky);
    promoVysledek = await promo.overit(client, v.promoKod, { zaklad, kanal: 'prodejna', zamknout: true });
    if (!promoVysledek.ok) throw new ChybaProdeje(400, promoVysledek.chyba);
    sleva = kc(promoVysledek.sleva);
    slevaPopis = popisPromo(promoVysledek);
  }
  const zaZbozi = kc(v.mezisoucet - sleva);
  if (v.ocekavaneCelkem != null && !shoda(v.ocekavaneCelkem, zaZbozi)) {
    throw new ChybaProdeje(409, `Částka se mezitím změnila: pokladna ukazuje ${v.ocekavaneCelkem} Kč, podle serveru je to ${zaZbozi} Kč. Zkontrolujte slevu a prodej uložte znovu.`);
  }

  // 4) Dárkový poukaz - celý nákup, nebo část s doplatkem
  let platba = v.platba, celkem = zaZbozi, poukaz = null, zPoukazu = 0, poukazCastka = null;
  if (v.platba === 'poukaz') {
    if (zaZbozi <= 0) throw new ChybaProdeje(400, 'Nákup je zdarma – poukaz se nečerpá. Zvolte jiný způsob platby.');
    const nalez = await najitPoukaz(client, v.poukazKod, { zamknout: true });
    if (nalez.chyba) throw new ChybaProdeje(nalez.status || 400, nalez.chyba);
    poukaz = nalez.poukaz;
    const zustatek = Number(poukaz.zustatek);
    if (poukaz.stav !== 'aktivni' || zustatek <= 0) throw new ChybaProdeje(400, 'Poukaz už není aktivní.');
    if (poukazPoPlatnosti(poukaz.platnost_do)) throw new ChybaProdeje(400, 'Platnost poukazu vypršela.');
    if (zustatek >= zaZbozi) {
      zPoukazu = zaZbozi; // celý nákup poukazem: tvar záznamu jako dřív (platba 'poukaz', celkem = cena)
    } else {
      if (!v.doplatekPlatba) throw new ChybaProdeje(400, `Na poukazu je jen ${zustatek} Kč – vyberte, jak zákazník doplatí zbytek ${kc(zaZbozi - zustatek)} Kč.`);
      if (promoVysledek) throw new ChybaProdeje(400, 'Slevový kód a doplatek k dárkovému poukazu nejde v pokladně kombinovat. Zaplaťte poukazem celý nákup, nebo bez poukazu.');
      zPoukazu = zustatek;
      poukazCastka = zustatek;
      platba = v.doplatekPlatba;
      celkem = kc(zaZbozi - zustatek);
    }
  }

  // 5) Hotovost: vrácení počítá server z částky, kterou zákazník opravdu platí
  const prijato = platba === 'hotovost' ? v.hotovostPrijato : null;
  if (prijato != null && prijato < celkem) throw new ChybaProdeje(400, `Přijatá hotovost ${prijato} Kč je menší než částka k zaplacení ${celkem} Kč.`);

  // 6) Zápisy
  const prodej = (await client.query(
    `INSERT INTO prodejna_prodeje (zakaznik, platba, poznamka, polozky, celkem, mezisoucet, sleva, sleva_popis,
       hotovost_prijato, hotovost_vraceno, poukaz_castka, poukaz_kod, klic, klic_otisk, obsah_otisk)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [v.zakaznik, platba, v.poznamka, JSON.stringify(v.polozky), celkem, v.mezisoucet, sleva, slevaPopis,
     prijato, prijato != null ? kc(prijato - celkem) : null, poukazCastka, poukaz ? poukaz.kod : null, v.klic, v.otisk, v.obsahOtisk]
  )).rows[0];

  for (const p of varianty) {
    await client.query('UPDATE sklad SET pocet_kusu = pocet_kusu - $3 WHERE produkt_id = $1 AND velikost = $2', [p.produkt_id, p.velikost, p.pocet]);
    await client.query(`INSERT INTO pohyby_skladu (produkt_id, velikost, typ, pocet, poznamka) VALUES ($1, $2, 'prodej', $3, $4)`,
      [p.produkt_id, p.velikost, p.pocet, `Prodej v prodejně – účtenka #${prodej.id}`]);
  }
  if (promoVysledek) {
    await promo.zapsatPouziti(client, { kod: promoVysledek.kod, kanal: 'prodejna', prodejId: prodej.id, zaklad, sleva });
  }
  if (poukaz) {
    const novyZustatek = kc(Number(poukaz.zustatek) - zPoukazu);
    await client.query('UPDATE darkove_poukazy SET zustatek = $1, stav = $2 WHERE id = $3', [novyZustatek, novyZustatek <= 0 ? 'pouzity' : 'aktivni', poukaz.id]);
    await client.query('INSERT INTO poukazy_pouziti (poukaz_id, castka, prodej_id) VALUES ($1,$2,$3)', [poukaz.id, zPoukazu, prodej.id]);
  }

  // Evidence plateb (lib/evidencePlateb.js): skutečné peníze a kredit odděleně,
  // ve stejné transakci; klíč odvozený z klíče prodeje = opakování nic nezdvojí
  if (celkem > 0 && platba !== 'poukaz') {
    await evidence.zapsatPlatbu(client, { klic: `prodej:${v.klic}:prijem`, typ: 'prijem', castka: celkem, zpusob: platba,
      okolnosti: 'prodejna', kontaktni: true, prijato_at: prodej.datum, zdroj_typ: 'prodej', zdroj_id: prodej.id });
  }
  if (poukaz) {
    await evidence.zapsatKredit(client, { klic: `prodej:${v.klic}:cerpani`, poukaz_id: poukaz.id, typ: 'cerpani', castka: zPoukazu,
      puvod: evidence.puvodPoukazu(poukaz), kontaktni: true, zdroj_typ: 'prodej', zdroj_id: prodej.id });
  }
  return { prodej, opakovane: false };
}

module.exports = { pripravitProdej, ulozitProdej, zahoditKlic, otiskProdeje, otiskObsahu, variantyKOdectu, ChybaProdeje, PLATBY, OKNO_DUPLICITY_MIN };
