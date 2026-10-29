// Faktura k objednávce z e-shopu - šablona pro tisk v adminu i pro e-mail
// zákazníkovi (styly jsou inline, ať vypadá stejně i v e-mailovém klientu).
//
// Faktura se vykresluje ze SNÍMKU (sestavitSnimek): všechny údaje dokladu
// zmrazené v okamžiku vystavení - prodávající, odběratel, položky, ceny, sleva,
// doprava, celkem a data. Snímek i hotové HTML se při prvním vystavení uloží
// (lib/vystaveniFaktury.js, tabulka faktury) a dál se tiskne/posílá jen uložená
// podoba. Změna produktu, adresy prodávající nebo téhle šablony tak už vystavenou
// fakturu nezmění.

// Verze šablony - ukládá se k faktuře, ať je dohledatelné, čím byla vykreslena
const SABLONA_VERZE = '2026-10-27';

// Identifikace prodávající (§ 435 občanského zákoníku: jméno, sídlo, IČO a zápis
// v jiné evidenci). Sídlo = místo podnikání a živnostenský úřad ověřené v ARES
// (registr živnostenského podnikání, IČO 24354635, 27. 10. 2026); provozovna =
// prodejna podle obchodních podmínek (adresu provozovny ARES nezveřejňuje).
const PRODAVAJICI = {
  jmeno: 'Monika Škarpichová',
  sidlo: 'Včelín 1164, 768 24 Hulín',
  provozovna: 'Holešovská 752, 768 24 Hulín',
  ico: '24354635',
  zapis: 'Fyzická osoba zapsaná v živnostenském rejstříku vedeném Městským úřadem Kroměříž.',
  dph: 'Neplátce DPH'
};

const DOPRAVA = { zasilkovna: 'Zásilkovna', ceska_posta: 'Česká pošta', osobni_odber: 'Osobní odběr', gls_adresa: 'GLS – doručení na adresu', gls_vydejni_misto: 'GLS – výdejní místo' };
const PLATBA = { dobirka: 'Dobírka', prevod: 'Bankovní převod', na_prodejne: 'Na prodejně při vyzvednutí' };

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const kc = n => `${Number(n).toLocaleString('cs-CZ')} Kč`;
const datum = d => new Date(d).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' });
const iso = d => (d == null || d === '' || Number.isNaN(new Date(d).getTime())) ? null : new Date(d).toISOString();
const text = v => (v == null ? null : String(v));

const S = {
  box: 'max-width:700px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#334155;line-height:1.5',
  h3: 'font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin:0 0 8px 0',
  p: 'margin:0;font-size:14px',
  sede: 'background:#f8fafc;border-radius:8px;padding:16px 20px;vertical-align:top',
  th: 'font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:2px solid #e2e8f0;padding:10px 8px',
  td: 'padding:12px 8px;border-bottom:1px solid #e2e8f0;font-size:14px'
};

// Snímek dokladu z objednávky (o = řádek objednávky s údaji odběratele a polozky).
// Jen data, žádné HTML - ukládá se jako JSON vedle vykresleného dokladu.
function sestavitSnimek(o, { faktura_cislo, faktura_datum }) {
  const polozky = (o.polozky || []).map(p => ({
    produkt_id: p.produkt_id == null ? null : Number(p.produkt_id),
    nazev: text(p.nazev),
    velikost: text(p.velikost),
    pocet: Number(p.pocet),
    cena: Number(p.cena),
    celkem: Number(p.cena) * Number(p.pocet)
  }));
  const mezisoucet = polozky.reduce((s, p) => s + p.celkem, 0);
  const priplatek = Number(o.platba_priplatek) || 0;
  // Cena dopravy uložená u objednávky; starší objednávky ji nemají - dopočítá se z celkem
  const dopravaCena = o.doprava_cena != null ? Number(o.doprava_cena) : Number(o.celkem) - mezisoucet + Number(o.sleva || 0) - priplatek;
  const vydejniMisto = o.vydejni_misto_id ? {
    id: text(o.vydejni_misto_id), nazev: text(o.vydejni_misto_nazev), ulice: text(o.vydejni_misto_ulice),
    mesto: text(o.vydejni_misto_mesto), psc: text(o.vydejni_misto_psc)
  } : null;
  // Místo určení (§ 16 odst. 2 zákona o ochraně spotřebitele) podle způsobu dopravy
  const mistoDodani = o.doprava === 'osobni_odber'
    ? `Osobní odběr na prodejně, ${PRODAVAJICI.provozovna}`
    : vydejniMisto
      ? `Výdejní místo ${[vydejniMisto.nazev, [vydejniMisto.ulice, [vydejniMisto.psc, vydejniMisto.mesto].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ')}`
      : [o.ulice, [o.psc, o.mesto].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
  return {
    sablona_verze: SABLONA_VERZE,
    cislo: text(faktura_cislo),
    datum_vystaveni: iso(faktura_datum),
    prodavajici: { ...PRODAVAJICI },
    odberatel: { jmeno: text(o.jmeno), ulice: text(o.ulice), mesto: text(o.mesto), psc: text(o.psc), email: text(o.email), telefon: text(o.telefon) },
    objednavka: { id: Number(o.id), cislo: text(o.cislo), stav: text(o.stav) },
    // Data se nezaměňují: objednávka, úhrada, expedice a dodání jsou samostatné
    // údaje; co v okamžiku vystavení není evidované, zůstane null.
    data: {
      objednavka: iso(o.vytvoreno),
      zaplaceno: iso(o.zaplaceno_at),
      expedovano: iso(o.expedovano_at),
      dodano: iso(o.dodano_at)
    },
    doprava: { kod: text(o.doprava), nazev: DOPRAVA[o.doprava] || text(o.doprava), cena: dopravaCena },
    platba: { kod: text(o.platba), nazev: PLATBA[o.platba] || text(o.platba), priplatek },
    vydejni_misto: vydejniMisto,
    misto_dodani: mistoDodani,
    polozky,
    sleva: Number(o.sleva) || 0,
    poukaz_kod: text(o.poukaz_kod),
    celkem: Number(o.celkem)
  };
}

// Opravný doklad (storno) ruší fakturu v plné výši: snímek původní faktury se
// všemi částkami s opačným znaménkem, vlastním číslem a odkazem na fakturu.
// historicka = původní faktura nemá uložený originál, údaje jsou z objednávky.
const opacne = n => (Number(n) === 0 ? 0 : -Number(n));
function sestavitStorno(f, { cislo, datum_vystaveni, duvod, historicka = false }) {
  return {
    ...f,
    druh: 'storno',
    sablona_verze: SABLONA_VERZE,
    cislo: text(cislo),
    datum_vystaveni: iso(datum_vystaveni),
    puvodni_doklad: { cislo: text(f.cislo), datum_vystaveni: iso(f.datum_vystaveni), historicka: !!historicka },
    duvod: text(duvod),
    objednavka: { ...f.objednavka, stav: 'zrusena' },
    polozky: f.polozky.map(p => ({ ...p, pocet: opacne(p.pocet), celkem: opacne(p.celkem) })),
    doprava: { ...f.doprava, cena: opacne(f.doprava.cena) },
    platba: { ...f.platba, priplatek: opacne(f.platba.priplatek) },
    sleva: opacne(f.sleva),
    celkem: opacne(f.celkem)
  };
}

// Vnitřek faktury (bez <html>) ze snímku. rekonstrukce = text vysvětlení u
// historické faktury bez uloženého originálu: dokument se pak jmenuje
// "REKONSTRUKCE FAKTURY …" a vysvětlení je nahoře i dole (ne jen v jednom rámečku).
function vykreslitObsah(s, { rekonstrukce } = {}) {
  const r = 'text-align:right;';
  const pr = s.prodavajici, od = s.odberatel, d = s.data;
  const storno = s.druh === 'storno';
  const pd = s.puvodni_doklad;
  // Sleva se na faktuře odečítá (−500 Kč), na opravném dokladu se vrací (500 Kč)
  const castkaSlevy = s.sleva > 0 ? `−${kc(s.sleva)}` : kc(-s.sleva);
  const misto = s.vydejni_misto
    ? `<p style="${S.p}"><strong>Výdejní místo:</strong> ${esc(s.vydejni_misto.nazev)}, ${esc([s.vydejni_misto.ulice, [s.vydejni_misto.psc, s.vydejni_misto.mesto].filter(Boolean).join(' ')].filter(Boolean).join(', '))}</p>` : '';
  const dodani = d.dodano
    ? esc(datum(d.dodano))
    // Bez evidovaného dodání se netvrdí, že dodáno nebylo - systém to jen neví.
    // Datum odeslání se uvede zvlášť a za datum dodání se nevydává.
    : `není v systému evidováno${d.expedovano ? ` (evidované datum odeslání: ${esc(datum(d.expedovano))})` : ''}`;
  const ramecek = `<p style="margin:0 0 16px 0;padding:10px 14px;border:2px solid #b45309;border-radius:8px;background:#fffbeb;color:#92400e;font-size:13px"><strong>REKONSTRUKCE – NEJDE O ORIGINÁL DOKLADU.</strong> ${esc(rekonstrukce)}</p>`;
  return `
  <div style="${S.box}">
    ${rekonstrukce ? ramecek : ''}
    <table role="presentation" style="width:100%;border-collapse:collapse;border-bottom:2px solid #e2e8f0;margin-bottom:20px">
      <tr>
        <td style="padding:0 0 16px 0;vertical-align:top">
          <img src="https://www.detskekrucky.cz/logo.jpg" alt="Dětské krůčky" height="48" style="height:48px;display:block;margin-bottom:8px">
          <h1 style="font-size:24px;color:${rekonstrukce ? '#92400e' : '#2c3e50'};margin:0">${rekonstrukce ? 'REKONSTRUKCE FAKTURY' : storno ? 'Opravný doklad' : 'Faktura'} ${esc(s.cislo)}</h1>
          ${storno ? `<p style="${S.p};margin-top:4px;color:#64748b">Storno faktury ${esc(pd.cislo)}</p>` : ''}
        </td>
        <td style="padding:0 0 16px 0;vertical-align:top;${r}font-size:14px;color:#64748b">
          Objednávka #${esc(s.objednavka.cislo || s.objednavka.id)}<br>
          Datum vystavení: ${esc(datum(s.datum_vystaveni))}<br>
          ${storno ? `K faktuře ${esc(pd.cislo)}${pd.datum_vystaveni ? ` ze dne ${esc(datum(pd.datum_vystaveni))}` : ''}<br>` : ''}
          Datum objednávky: ${esc(datum(d.objednavka))}
          ${d.zaplaceno && !storno ? `<br>Datum úhrady: ${esc(datum(d.zaplaceno))}` : ''}
        </td>
      </tr>
    </table>
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:0 10px;margin-bottom:10px">
      <tr>
        <td style="${S.sede};width:50%">
          <h3 style="${S.h3}">Dodavatel</h3>
          <p style="${S.p}"><strong>${esc(pr.jmeno)}</strong></p>
          <p style="${S.p}">Sídlo: ${esc(pr.sidlo)}</p>
          <p style="${S.p}">Provozovna: ${esc(pr.provozovna)}</p>
          <p style="${S.p}">IČO: ${esc(pr.ico)}</p>
          <p style="${S.p};margin-top:8px;font-size:12px;color:#64748b">${esc(pr.zapis)}</p>
          <p style="${S.p};color:#64748b">${esc(pr.dph)}</p>
        </td>
        <td style="width:12px"></td>
        <td style="${S.sede};width:50%">
          <h3 style="${S.h3}">Odběratel</h3>
          <p style="${S.p}"><strong>${esc(od.jmeno)}</strong></p>
          <p style="${S.p}">${esc(od.ulice)}, ${esc(od.mesto)} ${esc(od.psc)}</p>
          <p style="${S.p};margin-top:8px;color:#64748b">${esc(od.email)}</p>
          <p style="${S.p};color:#64748b">${esc(od.telefon) || '—'}</p>
        </td>
      </tr>
      <tr>
        <td colspan="3" style="${S.sede}">
          <h3 style="${S.h3}">Doprava, dodání a platba</h3>
          <p style="${S.p}"><strong>Doprava:</strong> ${esc(s.doprava.nazev || '—')}</p>
          ${misto}
          <p style="${S.p}"><strong>Místo dodání:</strong> ${esc(s.misto_dodani || '—')}</p>
          <p style="${S.p}"><strong>Datum dodání:</strong> ${dodani}</p>
          <p style="${S.p}"><strong>Platba:</strong> ${esc(s.platba.nazev || '—')}</p>
        </td>
      </tr>
    </table>
    ${storno ? `<p style="margin:0 0 16px 0;padding:10px 14px;border-radius:8px;background:#f8fafc;font-size:14px"><strong>Důvod opravy:</strong> ${esc(s.duvod)}. Tento doklad ruší fakturu ${esc(pd.cislo)} v plné výši.${pd.historicka ? ' Faktura byla vystavena před zavedením ukládání faktur – částky vycházejí z údajů objednávky.' : ''}</p>` : ''}
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <thead><tr><th style="${S.th};text-align:left">Produkt</th><th style="${S.th};${r}">Vel.</th><th style="${S.th};${r}">Ks</th><th style="${S.th};${r}">Cena</th><th style="${S.th};${r}">Celkem</th></tr></thead>
      <tbody>
        ${s.polozky.map(p => `<tr><td style="${S.td}">${esc(p.nazev) || 'Produkt'}</td><td style="${S.td};${r}">${esc(p.velikost)}</td><td style="${S.td};${r}">${esc(p.pocet)}</td><td style="${S.td};${r}">${kc(p.cena)}</td><td style="${S.td};${r}">${kc(p.celkem)}</td></tr>`).join('')}
        <tr><td colspan="4" style="${S.td}">${esc(s.doprava.nazev || '—')} (doprava)</td><td style="${S.td};${r}">${s.doprava.cena === 0 ? 'Zdarma' : kc(s.doprava.cena)}</td></tr>
        ${s.platba.priplatek !== 0 ? `<tr><td colspan="4" style="${S.td}">Dobírka (příplatek)</td><td style="${S.td};${r}">${kc(s.platba.priplatek)}</td></tr>` : ''}
        ${s.sleva !== 0 ? `<tr><td colspan="4" style="${S.td}">Dárkový poukaz${s.poukaz_kod ? ' ' + esc(s.poukaz_kod) : ''}</td><td style="${S.td};${r}">${castkaSlevy}</td></tr>` : ''}
        <tr><td colspan="4" style="padding:14px 8px;font-weight:bold;font-size:16px;color:#2c3e50;border-top:2px solid #e2e8f0">CELKEM</td><td style="padding:14px 8px;font-weight:bold;font-size:16px;color:#2c3e50;border-top:2px solid #e2e8f0;${r}">${kc(s.celkem)}</td></tr>
      </tbody>
    </table>
    ${rekonstrukce ? `<div style="margin-bottom:16px">${ramecek}</div>` : ''}
    <p style="margin:0;font-size:12px;color:#94a3b8;${r}">www.detskekrucky.cz · info@detskekrucky.cz · 773 517 733</p>
  </div>`;
}

// Samostatná stránka (tisk v adminu, příloha e-mailu, uložená podoba dokladu)
function vykreslitDokument(snimek, volby) {
  return `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><title>${volby && volby.rekonstrukce ? 'Rekonstrukce faktury' : snimek.druh === 'storno' ? 'Opravný doklad' : 'Faktura'} ${esc(snimek.cislo)}</title></head>
<body style="margin:0;padding:24px;background:#fff">${vykreslitObsah(snimek, volby)}</body></html>`;
}

// Vnitřek uloženého dokumentu (obsah <body>) - pro vložení do e-mailu beze změny
function obsahDokumentu(html) {
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return m ? m[1] : html;
}

// Zkratky: snímek + vykreslení rovnou z objednávky
const fakturaObsahHtml = (o, faktura, volby) => vykreslitObsah(sestavitSnimek(o, faktura), volby);
const fakturaHtml = (o, faktura, volby) => vykreslitDokument(sestavitSnimek(o, faktura), volby);

module.exports = { fakturaHtml, fakturaObsahHtml, sestavitSnimek, sestavitStorno, vykreslitObsah, vykreslitDokument, obsahDokumentu, PRODAVAJICI, SABLONA_VERZE };
