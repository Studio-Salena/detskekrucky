// === NEWSLETTER ENDPOINT ===
// Přidej tento kód do svého Express serveru (vedle ostatních app.post('/api/...'))
// Předpokládá, že už máš nastavený Supabase klient jako `supabase`.

app.post('/api/newsletter', async (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ chyba: 'Zadejte prosím platný e-mail.' });
  }

  try {
    const { error } = await supabase
      .from('newsletter')
      .insert([{ email: email.toLowerCase().trim() }]);

    if (error) {
      // 23505 = unique constraint violation (e-mail už existuje)
      if (error.code === '23505') {
        return res.status(400).json({ chyba: 'Tento e-mail je již přihlášený k odběru.' });
      }
      console.error('Chyba při ukládání newsletteru:', error);
      return res.status(500).json({ chyba: 'Nepodařilo se uložit e-mail, zkuste to prosím znovu.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Chyba serveru (newsletter):', err);
    return res.status(500).json({ chyba: 'Chyba serveru, zkuste to prosím znovu.' });
  }
});
