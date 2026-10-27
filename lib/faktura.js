// Faktura k objednávce z e-shopu - jedna šablona pro tisk v adminu i pro e-mail
// zákazníkovi (styly jsou inline, ať vypadá stejně i v e-mailovém klientu).
// Číslo a datum vystavení přiděluje routes/objednavky.js (ziskatFakturuCislo).

const DOPRAVA = { zasilkovna: 'Zásilkovna', ceska_posta: 'Česká pošta', osobni_odber: 'Osobní odběr', gls_adresa: 'GLS – doručení na adresu', gls_vydejni_misto: 'GLS – výdejní místo' };
const PLATBA = { dobirka: 'Dobírka', prevod: 'Bankovní převod', na_prodejne: 'Na prodejně při vyzvednutí' };

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const kc = n => `${Number(n).toLocaleString('cs-CZ')} Kč`;
const datum = d => new Date(d).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' });

const S = {
  box: 'max-width:700px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#334155;line-height:1.5',
  h3: 'font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin:0 0 8px 0',
  p: 'margin:0;font-size:14px',
  sede: 'background:#f8fafc;border-radius:8px;padding:16px 20px;vertical-align:top',
  th: 'font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;border-bottom:2px solid #e2e8f0;padding:10px 8px',
  td: 'padding:12px 8px;border-bottom:1px solid #e2e8f0;font-size:14px'
};

// Vnitřek faktury (bez <html>) - vkládá se do e-mailu i do samostatné stránky
function fakturaObsahHtml(o, { faktura_cislo, faktura_datum }) {
  const polozky = o.polozky || [];
  const mezisoucet = polozky.reduce((s, p) => s + p.cena * p.pocet, 0);
  const priplatek = Number(o.platba_priplatek) || 0;
  const dopravaCena = o.doprava_cena != null ? Number(o.doprava_cena) : o.celkem - mezisoucet + Number(o.sleva || 0) - priplatek;
  const doprava = DOPRAVA[o.doprava] || o.doprava || '—';
  const r = 'text-align:right;';
  const misto = o.vydejni_misto_id
    ? `<p style="${S.p}"><strong>Výdejní místo:</strong> ${esc(o.vydejni_misto_nazev)}, ${esc([o.vydejni_misto_ulice, [o.vydejni_misto_psc, o.vydejni_misto_mesto].filter(Boolean).join(' ')].filter(Boolean).join(', '))}</p>` : '';
  return `
  <div style="${S.box}">
    <table role="presentation" style="width:100%;border-collapse:collapse;border-bottom:2px solid #e2e8f0;margin-bottom:20px">
      <tr>
        <td style="padding:0 0 16px 0;vertical-align:top">
          <img src="https://www.detskekrucky.cz/logo.jpg" alt="Dětské krůčky" height="48" style="height:48px;display:block;margin-bottom:8px">
          <h1 style="font-size:24px;color:#2c3e50;margin:0">Faktura ${esc(faktura_cislo)}</h1>
        </td>
        <td style="padding:0 0 16px 0;vertical-align:top;${r}font-size:14px;color:#64748b">
          Objednávka #${esc(o.cislo || o.id)}<br>
          Datum vystavení: ${esc(datum(faktura_datum))}<br>
          Datum objednávky: ${esc(datum(o.vytvoreno))}
        </td>
      </tr>
    </table>
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:0 10px;margin-bottom:10px">
      <tr>
        <td style="${S.sede};width:50%">
          <h3 style="${S.h3}">Dodavatel</h3>
          <p style="${S.p}"><strong>Monika Škarpichová</strong></p>
          <p style="${S.p}">Holešovská 752, Hulín 768 24</p>
          <p style="${S.p}">IČO: 24354635</p>
          <p style="${S.p};margin-top:8px;color:#64748b">Neplátce DPH</p>
        </td>
        <td style="width:12px"></td>
        <td style="${S.sede};width:50%">
          <h3 style="${S.h3}">Odběratel</h3>
          <p style="${S.p}"><strong>${esc(o.jmeno)}</strong></p>
          <p style="${S.p}">${esc(o.ulice)}, ${esc(o.mesto)} ${esc(o.psc)}</p>
          <p style="${S.p};margin-top:8px;color:#64748b">${esc(o.email)}</p>
          <p style="${S.p};color:#64748b">${esc(o.telefon) || '—'}</p>
        </td>
      </tr>
      <tr>
        <td colspan="3" style="${S.sede}">
          <h3 style="${S.h3}">Doprava a platba</h3>
          <p style="${S.p}"><strong>Doprava:</strong> ${esc(doprava)}</p>
          ${misto}
          <p style="${S.p}"><strong>Platba:</strong> ${esc(PLATBA[o.platba] || o.platba || '—')}</p>
        </td>
      </tr>
    </table>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <thead><tr><th style="${S.th};text-align:left">Produkt</th><th style="${S.th};${r}">Vel.</th><th style="${S.th};${r}">Ks</th><th style="${S.th};${r}">Cena</th><th style="${S.th};${r}">Celkem</th></tr></thead>
      <tbody>
        ${polozky.map(p => `<tr><td style="${S.td}">${esc(p.nazev) || 'Produkt'}</td><td style="${S.td};${r}">${esc(p.velikost)}</td><td style="${S.td};${r}">${esc(p.pocet)}</td><td style="${S.td};${r}">${kc(p.cena)}</td><td style="${S.td};${r}">${kc(p.cena * p.pocet)}</td></tr>`).join('')}
        <tr><td colspan="4" style="${S.td}">${esc(doprava)} (doprava)</td><td style="${S.td};${r}">${dopravaCena === 0 ? 'Zdarma' : kc(dopravaCena)}</td></tr>
        ${priplatek > 0 ? `<tr><td colspan="4" style="${S.td}">Dobírka (příplatek)</td><td style="${S.td};${r}">${kc(priplatek)}</td></tr>` : ''}
        ${Number(o.sleva) > 0 ? `<tr><td colspan="4" style="${S.td}">Dárkový poukaz${o.poukaz_kod ? ' ' + esc(o.poukaz_kod) : ''}</td><td style="${S.td};${r}">−${kc(o.sleva)}</td></tr>` : ''}
        <tr><td colspan="4" style="padding:14px 8px;font-weight:bold;font-size:16px;color:#2c3e50;border-top:2px solid #e2e8f0">CELKEM</td><td style="padding:14px 8px;font-weight:bold;font-size:16px;color:#2c3e50;border-top:2px solid #e2e8f0;${r}">${kc(o.celkem)}</td></tr>
      </tbody>
    </table>
    <p style="margin:0;font-size:12px;color:#94a3b8;${r}">www.detskekrucky.cz · info@detskekrucky.cz · 773 517 733</p>
  </div>`;
}

// Samostatná stránka (tisk v adminu, příloha e-mailu)
function fakturaHtml(o, faktura) {
  return `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><title>Faktura ${esc(faktura.faktura_cislo)}</title></head>
<body style="margin:0;padding:24px;background:#fff">${fakturaObsahHtml(o, faktura)}</body></html>`;
}

module.exports = { fakturaHtml, fakturaObsahHtml };
