const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

if (!process.env.STRIPE_KEY) {
  console.error('CHYBA: STRIPE_KEY není nastaven v proměnných prostředí! Platby nebudou fungovat.');
}
const stripe = require('stripe')(process.env.STRIPE_KEY);

router.post('/vytvorit', async (req, res) => {
  const { objednavka_id } = req.body;
  try {
    const objednavka = await pool.query(`
      SELECT o.*, z.email, z.jmeno
      FROM objednavky o
      JOIN zakaznici z ON o.zakaznik_id = z.id
      WHERE o.id = $1
    `, [objednavka_id]);

    if (objednavka.rows.length === 0) {
      return res.status(404).json({ chyba: 'Objednavka nenalezena' });
    }

    const o = objednavka.rows[0];

    const polozky = await pool.query(`
      SELECT op.*, p.nazev
      FROM objednavky_polozky op
      JOIN produkty p ON op.produkt_id = p.id
      WHERE op.objednavka_id = $1
    `, [objednavka_id]);

    const line_items = polozky.rows.map(p => ({
      price_data: {
        currency: 'czk',
        product_data: { name: `${p.nazev} - vel. ${p.velikost}` },
        unit_amount: p.cena * 100
      },
      quantity: p.pocet
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      customer_email: o.email,
      success_url: 'https://detskekrucky1.onrender.com/platba-uspesna?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://detskekrucky1.onrender.com/platba-zrusena',
      metadata: { objednavka_id: objednavka_id.toString() }
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ chyba: err.message });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const objednavka_id = session.metadata.objednavka_id;
    await pool.query('UPDATE objednavky SET stav = $1 WHERE id = $2', ['zaplacena', objednavka_id]);
  }

  res.json({ prijato: true });
});

router.get('/stav/:session_id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.session_id);
    res.json({
      stav: session.payment_status,
      zaplaceno: session.payment_status === 'paid'
    });
  } catch (err) {
    res.status(500).json({ chyba: err.message });
  }
});

module.exports = router;
