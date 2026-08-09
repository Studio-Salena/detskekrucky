// Odesílání e-mailů přes Resend (HTTP API) – Render blokuje odchozí SMTP,
// proto se neposílá přes nodemailer/SMTP, ale přes https://api.resend.com.
// Na Renderu musí být proměnná RESEND_API_KEY. Odesílatel = info@detskekrucky.cz
// (doména musí být v Resendu ověřená přes DNS záznamy u Forpsi).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ODESILATEL = 'Dětské krůčky <info@detskekrucky.cz>';

if (!RESEND_API_KEY) {
  console.error('CHYBA: RESEND_API_KEY neni nastaven v promennych prostredi! Odesilani emailu nebude fungovat.');
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

async function odeslat_potvrzeni(objednavka) {
  const polozky_html = objednavka.polozky.map(p => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.nazev} - vel. ${p.velikost}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.pocet} ks</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.cena * p.pocet} Kc</td>
    </tr>
  `).join('');

  await odeslatEmail({
    to: objednavka.email,
    subject: `Potvrzeni objednavky #${objednavka.objednavka_id}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h1 style="color:#FF6B35">Dekujeme za objednavku!</h1>
        <p>Ahoj ${objednavka.jmeno},</p>
        <p>Vasi objednavku jsme prijali a brzy ji zpracujeme.</p>
        <h3>Souhrn objednavky #${objednavka.objednavka_id}</h3>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px;text-align:left">Produkt</th>
              <th style="padding:8px;text-align:left">Pocet</th>
              <th style="padding:8px;text-align:left">Cena</th>
            </tr>
          </thead>
          <tbody>${polozky_html}</tbody>
        </table>
        <p style="font-size:18px;font-weight:bold;margin-top:16px">
          Celkem: ${objednavka.celkem} Kc
        </p>
        <p>Doprava: ${objednavka.doprava}</p>
        <p>Platba: ${objednavka.platba}</p>
        ${objednavka.platba === 'prevod' ? `
        <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-top:12px">
          <p style="margin:0 0 6px 0"><strong>Udaje pro platbu prevodem:</strong></p>
          <p style="margin:0">Cislo uctu: <strong>2003533776/2010</strong></p>
          <p style="margin:0">Castka: <strong>${objednavka.celkem} Kc</strong></p>
          <p style="margin:0">Variabilni symbol: <strong>${objednavka.objednavka_id}</strong></p>
        </div>` : ''}
        <hr>
        <p style="color:#666;font-size:13px">
          Detske krucky | 773 517 733 | info@detskekrucky.cz
        </p>
      </div>
    `
  });
  console.log('Email odoslan na:', objednavka.email);
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

module.exports = { odeslat_potvrzeni, odeslat_test };
