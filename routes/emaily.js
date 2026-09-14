// Odesílání e-mailů přes Resend (HTTP API) – Render blokuje odchozí SMTP,
// proto se neposílá přes nodemailer/SMTP, ale přes https://api.resend.com.
// Na Renderu musí být proměnná RESEND_API_KEY. Odesílatel = info@detskekrucky.cz
// (doména musí být v Resendu ověřená přes DNS záznamy u Forpsi).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ODESILATEL = 'Dětské krůčky <info@detskekrucky.cz>';
const MAJITELKA_EMAIL = 'info@detskekrucky.cz';

if (!RESEND_API_KEY) {
  console.error('CHYBA: RESEND_API_KEY neni nastaven v promennych prostredi! Odesilani emailu nebude fungovat.');
}

// E-mailové šablony skládají HTML z dat, která zadal zákazník (jméno, adresa,
// poznámka...) - bez escapování by šlo do e-mailu (zákaznického i majitelčina)
// propašovat HTML/odkazy. Stejný princip jako escH() v admin.html.
function escH(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function odeslatEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY není nastaven na serveru.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: ODESILATEL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Resend ${res.status}: ${txt}`);
  }
  return res.json();
}

// Stejný formát (SPD) a stejný účet jako QR kód v checkoutu (eshop.html,
// qrPlatbaUrl/UCET_IBAN) - na rozdíl od checkoutu (kde objednávka ještě
// neexistuje) tady navíc jde přidat X-VS (variabilní symbol), protože
// objednavka_id už v tuhle chvíli známe.
const UCET_IBAN = 'CZ4620100000002003533776';
function qrPlatbaUrl(castka, variabilniSymbol, zprava) {
  const spd = `SPD*1.0*ACC:${UCET_IBAN}*AM:${Number(castka).toFixed(2)}*CC:CZK*X-VS:${variabilniSymbol}*MSG:${zprava}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(spd)}`;
}

const DOPRAVA_LABELY = { zasilkovna: 'Zásilkovna', ceska_posta: 'Česká pošta', osobni_odber: 'Osobní odběr' };
const PLATBA_LABELY = { dobirka: 'Dobírka', prevod: 'Bankovní převod' };

// Barvy podle skutečné palety webu (eshop.html :root) - ne odhadnuté, ať
// e-mail opravdu vizuálně ladí s e-shopem.
const BARVA_ZNACKA = '#AE6965';       // --brown
const BARVA_ZNACKA_TMAVA = '#8a4a46'; // --brown-dark
const BARVA_POZADI_BOX = '#FAF6F1';   // světlý odstín --cream
const BARVA_RAMECEK = '#E6DFD6';
const BARVA_TEXT_TLUMENY = '#6B5E5B';

// Společná "obálka" pro zákaznické e-maily v brandu e-shopu (logo, barevný
// pruh s nadpisem, patička) - používá potvrzení objednávky i e-maily o
// změně stavu, ať vypadají jednotně (viz požadavek zákaznice).
function obalitBrandovanyEmail({ nadpis, obsahHtml }) {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2D2422;background:#F4F1EA;padding:30px 16px">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid ${BARVA_RAMECEK};overflow:hidden">
      <div style="text-align:center;padding:20px 0 0 0">
        <img src="https://www.detskekrucky.cz/logo.jpg" alt="Dětské krůčky" width="64" height="64" style="border-radius:50%">
      </div>
      <div style="background:${BARVA_ZNACKA};color:#fff;padding:20px 30px 28px 30px;margin-top:16px">
        <div style="font-size:13px;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Dětské krůčky</div>
        <h1 style="font-size:22px;margin:4px 0 0 0;font-weight:600">${nadpis}</h1>
      </div>
      <div style="padding:30px">
        ${obsahHtml}
      </div>
      <div style="text-align:center;font-size:12px;color:${BARVA_TEXT_TLUMENY};padding:18px 30px;background:${BARVA_POZADI_BOX};border-top:1px solid ${BARVA_RAMECEK}">
        Dětské krůčky | 773 517 733 | <a href="https://www.detskekrucky.cz" style="color:${BARVA_ZNACKA};text-decoration:none">www.detskekrucky.cz</a>
      </div>
    </div>
    </div>`;
}

async function odeslat_potvrzeni(objednavka) {
  // Zákaznicky viditelné "číslo objednávky" - cislo (RRMMNN, přidělené hned
  // při vzniku). Fallback na interní objednavka_id jen pro jistotu, kdyby ho
  // volající nedodal (nemělo by nastat, cislo se přiděluje vždy).
  const cisloZobrazit = objednavka.cislo || objednavka.objednavka_id;
  // dopravaCena není v objektu zvlášť (jen celkem) - dopočítá se, ať jde
  // zobrazit doprava jako vlastní řádek v tabulce se správným součtem.
  const mezisoucet = objednavka.polozky.reduce((s, p) => s + p.cena * p.pocet, 0);
  const dopravaCena = objednavka.celkem - mezisoucet + Number(objednavka.sleva || 0);
  const dopravaLabel = DOPRAVA_LABELY[objednavka.doprava] || objednavka.doprava || '—';
  const platbaLabel = PLATBA_LABELY[objednavka.platba] || objednavka.platba || '—';

  const polozky_html = objednavka.polozky.map(p => `
    <tr>
      <td style="padding:12px 8px;border-bottom:1px solid ${BARVA_RAMECEK};font-size:14px">${escH(p.nazev || ('produkt #' + p.produkt_id))}</td>
      <td style="padding:12px 8px;border-bottom:1px solid ${BARVA_RAMECEK};font-size:14px;text-align:right">${escH(p.velikost)}</td>
      <td style="padding:12px 8px;border-bottom:1px solid ${BARVA_RAMECEK};font-size:14px;text-align:right">${p.pocet}</td>
      <td style="padding:12px 8px;border-bottom:1px solid ${BARVA_RAMECEK};font-size:14px;text-align:right">${p.cena * p.pocet} Kč</td>
    </tr>
  `).join('');

  const adresa = [objednavka.ulice, [objednavka.psc, objednavka.mesto].filter(Boolean).join(' ')].filter(Boolean).map(escH).join(', ');

  const platebniBox = objednavka.platba === 'prevod' ? `
    <table role="presentation" style="width:100%;background:#FFF9F5;border-left:4px solid ${BARVA_ZNACKA};border-radius:0 8px 8px 0;margin-bottom:24px">
      <tr>
        <td style="padding:16px 20px;vertical-align:top">
          <h3 style="margin:0 0 8px 0;font-size:13px;color:${BARVA_ZNACKA};text-transform:uppercase;letter-spacing:0.05em">Pokyny k platbě</h3>
          <p style="margin:0 0 4px 0;font-size:14px">Číslo účtu: <strong>2003533776/2010</strong></p>
          <p style="margin:0 0 4px 0;font-size:14px">Variabilní symbol: <strong>${escH(cisloZobrazit)}</strong></p>
          <p style="margin:0;font-size:14px">Částka: <strong>${objednavka.celkem} Kč</strong></p>
        </td>
        <td style="padding:16px 20px 16px 0;text-align:right;vertical-align:top">
          <img src="${qrPlatbaUrl(objednavka.celkem, cisloZobrazit, 'Eshop Detske krucky')}" width="120" height="120" alt="QR platba" style="border-radius:6px">
        </td>
      </tr>
    </table>` : '';

  const obsahHtml = `
    <p style="margin:0 0 4px 0;font-size:15px">Ahoj ${escH(objednavka.jmeno)},</p>
    <p style="margin:0 0 24px 0;font-size:14px;color:${BARVA_TEXT_TLUMENY}">děkujeme za objednávku, brzy ji zpracujeme. Níže posíláme její přehled.</p>

    <table role="presentation" style="width:100%;background:${BARVA_POZADI_BOX};border:1px solid ${BARVA_RAMECEK};border-radius:8px;margin-bottom:24px">
      <tr>
        <td style="padding:20px;width:50%;vertical-align:top">
          <h3 style="margin:0 0 8px 0;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${BARVA_TEXT_TLUMENY}">Zákazník</h3>
          <p style="margin:0 0 4px 0;font-size:14px"><strong>${escH(objednavka.jmeno)}</strong></p>
          ${adresa ? `<p style="margin:0 0 4px 0;font-size:14px">${adresa}</p>` : ''}
          <p style="margin:0;font-size:14px;color:${BARVA_TEXT_TLUMENY}">${escH(objednavka.email)}</p>
          ${objednavka.telefon ? `<p style="margin:0;font-size:14px;color:${BARVA_TEXT_TLUMENY}">${escH(objednavka.telefon)}</p>` : ''}
        </td>
        <td style="padding:20px;width:50%;vertical-align:top">
          <h3 style="margin:0 0 8px 0;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${BARVA_TEXT_TLUMENY}">Doprava a platba</h3>
          <p style="margin:0 0 4px 0;font-size:14px"><strong>Doprava:</strong> ${escH(dopravaLabel)}</p>
          <p style="margin:0;font-size:14px"><strong>Platba:</strong> ${escH(platbaLabel)}</p>
        </td>
      </tr>
    </table>

    ${platebniBox}

    <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
      <thead>
        <tr>
          <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${BARVA_TEXT_TLUMENY};border-bottom:2px solid ${BARVA_RAMECEK};padding:10px 8px">Produkt</th>
          <th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${BARVA_TEXT_TLUMENY};border-bottom:2px solid ${BARVA_RAMECEK};padding:10px 8px">Vel.</th>
          <th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${BARVA_TEXT_TLUMENY};border-bottom:2px solid ${BARVA_RAMECEK};padding:10px 8px">Ks</th>
          <th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${BARVA_TEXT_TLUMENY};border-bottom:2px solid ${BARVA_RAMECEK};padding:10px 8px">Celkem</th>
        </tr>
      </thead>
      <tbody>
        ${polozky_html}
        ${objednavka.sleva > 0 ? `<tr><td colspan="3" style="padding:10px 8px;font-size:14px">Poukaz (sleva)</td><td style="padding:10px 8px;font-size:14px;text-align:right;color:#5a8a5a">−${objednavka.sleva} Kč</td></tr>` : ''}
        <tr><td colspan="3" style="padding:10px 8px;font-size:14px">${escH(dopravaLabel)} (doprava)</td><td style="padding:10px 8px;font-size:14px;text-align:right">${dopravaCena === 0 ? 'Zdarma' : dopravaCena + ' Kč'}</td></tr>
        <tr><td colspan="3" style="padding:14px 8px 0 8px;font-size:15px;font-weight:bold;color:${BARVA_ZNACKA};border-top:2px solid ${BARVA_ZNACKA_TMAVA}">CELKEM K ÚHRADĚ</td><td style="padding:14px 8px 0 8px;font-size:15px;font-weight:bold;color:${BARVA_ZNACKA};text-align:right;border-top:2px solid ${BARVA_ZNACKA_TMAVA}">${objednavka.celkem} Kč</td></tr>
      </tbody>
    </table>`;

  await odeslatEmail({
    to: objednavka.email,
    subject: `Potvrzení objednávky #${cisloZobrazit}`,
    html: obalitBrandovanyEmail({ nadpis: `Objednávka #${escH(cisloZobrazit)}`, obsahHtml })
  });
  console.log('Email odoslan na:', objednavka.email);
}

// Upozornění majitelce o nové objednávce z e-shopu
async function odeslat_upozorneni_objednavky(objednavka) {
  const cisloZobrazit = objednavka.cislo || objednavka.objednavka_id;
  const polozky_html = objednavka.polozky.map(p => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.nazev ? escH(p.nazev) : ('produkt #' + p.produkt_id)} - vel. ${escH(p.velikost)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.pocet} ks</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.cena * p.pocet} Kč</td>
    </tr>
  `).join('');

  await odeslatEmail({
    to: MAJITELKA_EMAIL,
    subject: `🛒 Nová objednávka #${cisloZobrazit} – ${objednavka.jmeno}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#FF6B35">🛒 Nová objednávka #${escH(cisloZobrazit)}</h2>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px;text-align:left">Produkt</th>
              <th style="padding:8px;text-align:left">Počet</th>
              <th style="padding:8px;text-align:left">Cena</th>
            </tr>
          </thead>
          <tbody>${polozky_html}</tbody>
        </table>
        ${objednavka.sleva > 0 ? `<p style="color:#27ae60">🎁 Uplatněný dárkový poukaz: −${objednavka.sleva} Kč</p>` : ''}
        <p style="font-size:18px;font-weight:bold;margin-top:16px">Celkem: ${objednavka.celkem} Kč</p>
        <p><strong>Doprava:</strong> ${escH(objednavka.doprava)} &nbsp; <strong>Platba:</strong> ${escH(objednavka.platba)}</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-top:12px">
          <p style="margin:0 0 6px 0"><strong>Zákazník:</strong> ${escH(objednavka.jmeno)}</p>
          <p style="margin:0 0 6px 0"><strong>E-mail:</strong> ${escH(objednavka.email)}</p>
          <p style="margin:0 0 6px 0"><strong>Telefon:</strong> ${escH(objednavka.telefon)}</p>
          <p style="margin:0">${escH(objednavka.ulice)}, ${escH(objednavka.psc)} ${escH(objednavka.mesto)}</p>
        </div>
        <hr>
        <p style="color:#666;font-size:13px">Detail objednávky je v adminu.</p>
      </div>
    `
  });
  console.log('Upozorneni na objednavku odeslano majitelce, #', objednavka.objednavka_id);
}

async function odeslat_potvrzeni_rezervace(rezervace, slot) {
  const datum = new Date(slot.datum).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });
  const cas = `${slot.cas_od.slice(0,5)} – ${slot.cas_do.slice(0,5)}`;
  const zrusitUrl = `https://detskekrucky1.onrender.com/rezervace/zrusit/${rezervace.zrusovaci_token}`;

  await odeslatEmail({
    to: rezervace.email,
    subject: 'Rezervace přijata – čeká na potvrzení – Dětské krůčky',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h1 style="color:#FF6B35">Rezervace přijata!</h1>
        <p>Ahoj ${escH(rezervace.jmeno)},</p>
        <p>Vaši rezervaci na vyzkoušení bot jsme přijali a zapsali. Vyčkejte prosím na e-mail s potvrzením termínu, ozveme se vám co nejdřív.</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-top:12px">
          <p style="margin:0 0 6px 0"><strong>Termín:</strong> ${datum}, ${cas}</p>
          <p style="margin:0">Prodejna: Holešovská 752, Hulín 768 24</p>
        </div>
        <p style="margin-top:16px">V případě zrušení rezervace, klikněte na odkaz a rezervace se zruší.</p>
        <p><a href="${zrusitUrl}" style="color:#FF6B35">Zrušit rezervaci</a></p>
        <hr>
        <p style="color:#666;font-size:13px">
          Dětské krůčky | 773 517 733 | info@detskekrucky.cz
        </p>
      </div>
    `
  });
  console.log('Email o rezervaci odeslan na:', rezervace.email);
}

async function odeslat_potvrzeni_terminu(rezervace, slot) {
  const datum = new Date(slot.datum).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });
  const cas = `${slot.cas_od.slice(0,5)} – ${slot.cas_do.slice(0,5)}`;
  const zrusitUrl = `https://detskekrucky1.onrender.com/rezervace/zrusit/${rezervace.zrusovaci_token}`;

  await odeslatEmail({
    to: rezervace.email,
    subject: 'Rezervace potvrzena – Dětské krůčky',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h1 style="color:#FF6B35">✅ Rezervace potvrzena!</h1>
        <p>Ahoj ${escH(rezervace.jmeno)},</p>
        <p>Váš termín je potvrzený. Těšíme se na vás!</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-top:12px">
          <p style="margin:0 0 6px 0"><strong>Termín:</strong> ${datum}, ${cas}</p>
          <p style="margin:0">Prodejna: Holešovská 752, Hulín 768 24</p>
        </div>
        <p style="margin-top:16px">V případě zrušení rezervace, klikněte na odkaz a rezervace se zruší.</p>
        <p><a href="${zrusitUrl}" style="color:#FF6B35">Zrušit rezervaci</a></p>
        <hr>
        <p style="color:#666;font-size:13px">
          Dětské krůčky | 773 517 733 | info@detskekrucky.cz
        </p>
      </div>
    `
  });
  console.log('Email o potvrzeni terminu odeslan na:', rezervace.email);
}

// Obsah e-mailu zákazníkovi při změně stavu objednávky - pro každý stav
// kromě "nova" (ta má svůj vlastní potvrzovací e-mail hned při objednání).
const STAV_OBJEDNAVKY_EMAIL = {
  vyrizuje: {
    predmet: cislo => `Objednávka #${cislo} se zpracovává`,
    nadpis: 'Vaše objednávka se zpracovává',
    text: 'Začali jsme zpracovávat vaši objednávku. Jakmile bude na cestě, dáme vám vědět.'
  },
  zaplacena: {
    predmet: cislo => `Platba k objednávce #${cislo} přijata`,
    nadpis: 'Platbu jsme přijali',
    text: 'Vaši platbu jsme úspěšně přijali. Objednávku teď připravíme k odeslání.'
  },
  odeslana: {
    predmet: cislo => `Objednávka #${cislo} byla odeslána`,
    nadpis: 'Objednávka je na cestě!',
    text: 'Vaše objednávka byla právě odeslána a brzy dorazí.'
  },
  dorucena: {
    predmet: cislo => `Objednávka #${cislo} byla doručena`,
    nadpis: 'Objednávka doručena!',
    text: 'Vaše objednávka byla doručena. Děkujeme za nákup a budeme se těšit zase příště!'
  },
  zrusena: {
    predmet: cislo => `Objednávka #${cislo} byla zrušena`,
    nadpis: 'Objednávka zrušena',
    text: 'Vaše objednávka byla zrušena. Pokud jste za ni již zaplatili, částku vám v nejbližší době vrátíme. V případě dotazů nás neváhejte kontaktovat.'
  }
};

// Informace zákazníkovi o změně stavu objednávky - stejný branding jako
// potvrzení objednávky (viz obalitBrandovanyEmail). Pro stavy mimo
// STAV_OBJEDNAVKY_EMAIL se nic neposílá - volající (routes/objednavky.js)
// tuhle funkci pro ně vůbec nevolá.
async function odeslat_email_zmena_stavu(objednavka, stav) {
  const obsah = STAV_OBJEDNAVKY_EMAIL[stav];
  if (!obsah) return;
  const cisloZobrazit = objednavka.cislo || objednavka.objednavka_id;

  await odeslatEmail({
    to: objednavka.email,
    subject: obsah.predmet(cisloZobrazit),
    html: obalitBrandovanyEmail({
      nadpis: obsah.nadpis,
      obsahHtml: `
        <p style="margin:0 0 4px 0;font-size:15px">Ahoj ${escH(objednavka.jmeno)},</p>
        <p style="margin:0 0 20px 0;font-size:14px;color:${BARVA_TEXT_TLUMENY}">${obsah.text}</p>
        <table role="presentation" style="width:100%;background:${BARVA_POZADI_BOX};border:1px solid ${BARVA_RAMECEK};border-radius:8px">
          <tr><td style="padding:16px 20px;font-size:14px">Objednávka <strong>#${escH(cisloZobrazit)}</strong></td></tr>
        </table>
      `
    })
  });
  console.log('Email o zmene stavu objednavky odeslan:', stav, '#', objednavka.objednavka_id);
}

// Upozornění majitelce, že si někdo udělal (nebo sám zrušil) rezervaci
async function odeslat_upozorneni_rezervace(rezervace, slot, typ = 'nova') {
  const datum = new Date(slot.datum).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });
  const cas = `${slot.cas_od.slice(0,5)} – ${slot.cas_do.slice(0,5)}`;
  const jeZruseni = typ === 'zrusena';

  await odeslatEmail({
    to: MAJITELKA_EMAIL,
    subject: jeZruseni ? `Rezervace zrušena – ${rezervace.jmeno}` : `Nová rezervace – ${rezervace.jmeno}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#FF6B35">${jeZruseni ? '❌ Zákazník zrušil rezervaci' : '📅 Nová rezervace'}</h2>
        <p><strong>Termín:</strong> ${datum}, ${cas}</p>
        <p><strong>Jméno:</strong> ${escH(rezervace.jmeno)}</p>
        <p><strong>Telefon:</strong> ${escH(rezervace.telefon)}</p>
        <p><strong>E-mail:</strong> ${escH(rezervace.email)}</p>
        ${rezervace.vek_dite ? `<p><strong>Věk dítěte:</strong> ${escH(rezervace.vek_dite)}</p>` : ''}
        ${rezervace.poznamka ? `<p><strong>Poznámka:</strong> ${escH(rezervace.poznamka)}</p>` : ''}
        <hr>
        <p style="color:#666;font-size:13px">Přehled rezervací je v adminu.</p>
      </div>
    `
  });
  console.log('Upozorneni na rezervaci odeslano majitelce, typ:', typ);
}

// Potvrzení přijetí žádosti o vrácení/odstoupení od smlouvy zákazníkovi.
// Zákon (§1824a odst. 2 obč. zák.) vyžaduje, aby prodávající přijetí odstoupení
// od smlouvy bez zbytečného odkladu potvrdil v textové podobě.
async function odeslat_potvrzeni_vratky(zadost) {
  const polozky_html = zadost.polozky.map(p => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.nazev ? escH(p.nazev) : ('produkt #' + p.produkt_id)} - vel. ${escH(p.velikost)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.pocet} ks</td>
    </tr>
  `).join('');

  await odeslatEmail({
    to: zadost.email,
    subject: `Přijali jsme vaši žádost o vrácení – objednávka #${zadost.objednavka_id}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h1 style="color:#FF6B35">Žádost o vrácení přijata</h1>
        <p>Ahoj${zadost.jmeno ? ' ' + escH(zadost.jmeno) : ''},</p>
        <p>potvrzujeme, že jsme přijali vaši žádost o vrácení zboží / odstoupení od smlouvy k objednávce <strong>#${zadost.objednavka_id}</strong>. Ozveme se vám co nejdřív s dalším postupem.</p>
        <h3>Položky k vrácení</h3>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#f5f5f5"><th style="padding:8px;text-align:left">Produkt</th><th style="padding:8px;text-align:left">Počet</th></tr></thead>
          <tbody>${polozky_html}</tbody>
        </table>
        ${zadost.duvod ? `<p style="margin-top:12px"><strong>Uvedený důvod:</strong> ${escH(zadost.duvod)}</p>` : ''}
        <p style="margin-top:16px">Zboží prosím zašlete nepoužité, nepoškozené a pokud možno v původním obalu na adresu prodejny (Holešovská 752, 768 24 Hulín).</p>
        <hr>
        <p style="color:#666;font-size:13px">
          Dětské krůčky | 773 517 733 | info@detskekrucky.cz
        </p>
      </div>
    `
  });
  console.log('Potvrzeni zadosti o vratku odeslano na:', zadost.email);
}

// Upozornění majitelce o nové žádosti o vrácení/odstoupení
async function odeslat_upozorneni_vratky(zadost) {
  const polozky_html = zadost.polozky.map(p => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.nazev ? escH(p.nazev) : ('produkt #' + p.produkt_id)} - vel. ${escH(p.velikost)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.pocet} ks</td>
    </tr>
  `).join('');

  await odeslatEmail({
    to: MAJITELKA_EMAIL,
    subject: `↩️ Žádost o vrácení – objednávka #${zadost.objednavka_id}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#FF6B35">↩️ Nová žádost o vrácení / odstoupení</h2>
        <p><strong>Objednávka:</strong> #${zadost.objednavka_id}</p>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#f5f5f5"><th style="padding:8px;text-align:left">Produkt</th><th style="padding:8px;text-align:left">Počet</th></tr></thead>
          <tbody>${polozky_html}</tbody>
        </table>
        ${zadost.duvod ? `<p style="margin-top:12px"><strong>Důvod:</strong> ${escH(zadost.duvod)}</p>` : ''}
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-top:12px">
          <p style="margin:0 0 6px 0"><strong>Zákazník:</strong> ${zadost.jmeno ? escH(zadost.jmeno) : '—'}</p>
          <p style="margin:0 0 6px 0"><strong>E-mail:</strong> ${escH(zadost.email)}</p>
          <p style="margin:0"><strong>Telefon:</strong> ${zadost.telefon ? escH(zadost.telefon) : '—'}</p>
        </div>
        <hr>
        <p style="color:#666;font-size:13px">Přehled žádostí o vrácení je v adminu.</p>
      </div>
    `
  });
  console.log('Upozorneni na zadost o vratku odeslano majitelce, objednavka #', zadost.objednavka_id);
}

// Potvrzení přijetí krátkého dotazu z "Poradny velikostí" zákaznici
async function odeslat_potvrzeni_poradna(zadost) {
  await odeslatEmail({
    to: zadost.email,
    subject: 'Přijali jsme váš dotaz na velikost – Dětské krůčky',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h1 style="color:#FF6B35">Děkujeme za dotaz! 👣</h1>
        <p>Ahoj,</p>
        <p>přijali jsme váš dotaz z poradny velikostí a brzy se vám ozveme s doporučením.</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-top:12px">
          ${zadost.vek_dite ? `<p style="margin:0 0 6px 0"><strong>Věk dítěte:</strong> ${escH(zadost.vek_dite)}</p>` : ''}
          ${zadost.delka_mm ? `<p style="margin:0 0 6px 0"><strong>Naměřená délka nožičky:</strong> ${escH(zadost.delka_mm)} mm</p>` : ''}
          ${zadost.sirka_mm ? `<p style="margin:0 0 6px 0"><strong>Naměřená šířka nožičky:</strong> ${escH(zadost.sirka_mm)} mm</p>` : ''}
          ${zadost.poznamka ? `<p style="margin:0"><strong>Poznámka:</strong> ${escH(zadost.poznamka)}</p>` : ''}
        </div>
        <hr>
        <p style="color:#666;font-size:13px">
          Dětské krůčky | 773 517 733 | info@detskekrucky.cz
        </p>
      </div>
    `
  });
  console.log('Potvrzeni dotazu na poradnu odeslano na:', zadost.email);
}

// Upozornění majitelce o novém dotazu z "Poradny velikostí"
async function odeslat_upozorneni_poradna(zadost) {
  await odeslatEmail({
    to: MAJITELKA_EMAIL,
    subject: '👣 Nový dotaz z poradny velikostí',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#FF6B35">👣 Nový dotaz na velikost</h2>
        ${zadost.vek_dite ? `<p><strong>Věk dítěte:</strong> ${escH(zadost.vek_dite)}</p>` : ''}
        ${zadost.delka_mm ? `<p><strong>Naměřená délka nožičky:</strong> ${escH(zadost.delka_mm)} mm</p>` : ''}
        ${zadost.sirka_mm ? `<p><strong>Naměřená šířka nožičky:</strong> ${escH(zadost.sirka_mm)} mm</p>` : ''}
        ${zadost.poznamka ? `<p><strong>Poznámka k nožičce:</strong> ${escH(zadost.poznamka)}</p>` : ''}
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-top:12px">
          <p style="margin:0 0 6px 0"><strong>E-mail:</strong> ${zadost.email ? escH(zadost.email) : '—'}</p>
          <p style="margin:0"><strong>Telefon:</strong> ${zadost.telefon ? escH(zadost.telefon) : '—'}</p>
        </div>
        <hr>
        <p style="color:#666;font-size:13px">Přehled dotazů je v adminu.</p>
      </div>
    `
  });
  console.log('Upozorneni na dotaz z poradny odeslano majitelce, #', zadost.id);
}

// Zkušební e-mail – pro ověření, že server umí odesílat (RESEND_API_KEY + ověřená doména)
async function odeslat_test(komu) {
  await odeslatEmail({
    to: komu,
    subject: 'Zkušební e-mail z webu Dětské krůčky',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#7A816C">✅ Odesílání e-mailů funguje!</h2>
        <p>Toto je zkušební e-mail z administrace Dětských krůčků.</p>
        <p>Pokud jsi ho dostala, server je správně nastavený a umí odesílat e-maily.</p>
        <hr>
        <p style="color:#666;font-size:13px">Dětské krůčky | www.detskekrucky.cz</p>
      </div>
    `
  });
}

module.exports = { odeslat_potvrzeni, odeslat_upozorneni_objednavky, odeslat_email_zmena_stavu, odeslat_potvrzeni_rezervace, odeslat_potvrzeni_terminu, odeslat_upozorneni_rezervace, odeslat_potvrzeni_vratky, odeslat_upozorneni_vratky, odeslat_potvrzeni_poradna, odeslat_upozorneni_poradna, odeslat_test, escH };
