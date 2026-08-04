const nodemailer = require('nodemailer');

if (!process.env.EMAIL_PASS) {
  console.error('CHYBA: EMAIL_PASS neni nastaven v promennych prostredi! Odesilani emailu nebude fungovat.');
}

const transporter = nodemailer.createTransport({
  host: 'smtp.forpsi.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL || 'info@detskekrucky.cz',
    pass: process.env.EMAIL_PASS
  }
});

async function odeslat_potvrzeni(objednavka) {
  const polozky_html = objednavka.polozky.map(p => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.nazev} - vel. ${p.velikost}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.pocet} ks</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${p.cena * p.pocet} Kc</td>
    </tr>
  `).join('');

  await transporter.sendMail({
    from: '"Detske krucky" <info@detskekrucky.cz>',
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

module.exports = { odeslat_potvrzeni };
