// Veřejný export katalogu pro samostatné stránky kategorií a produktů (SEO krok 2).
//
// Pravidla dostupnosti a ceny jsou PŘESNĚ stejná jako v e-shopu (eshop.html,
// nacistProdukty / jeSkladem / slevaProduktu), aby statická stránka, strukturovaná
// data i nákup říkaly totéž:
//   - velikost je v nabídce, když je skladem (pocet_kusu > 0) nebo "u dodavatele"
//     (server ji při objednávce přijme i bez zásoby, dodání 7–14 dní),
//   - stav velikosti: 'dodavatel', jinak 'skladem'; ostatní velikosti jsou vyprodané,
//   - cena = nejnižší cena velikostí v nabídce, "od" když se ceny liší,
//   - přeškrtnutá cena = cena_puvodni u nejlevnější zlevněné velikosti.
//
// Ven jde jen to, co už dnes vrací veřejné /api/sklad, a méně: žádné počty kusů,
// EAN, interní klíče ani úložiště fotek.

const VERZE_FORMATU = 1;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;

// Velikost v nabídce (stejně jako e-shop)
const vNabidce = r => r.velikost != null && (Number(r.pocet_kusu) > 0 || r.dostupnost === 'dodavatel');

function nejcastejsi(hodnoty) {
  const citac = new Map();
  for (const h of hodnoty) if (h) citac.set(h, (citac.get(h) || 0) + 1);
  return [...citac.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || null;
}

// Řádky jednoho modelu (produkty × sklad) -> velikosti, cena, dostupnost
function velikostiModelu(radky) {
  const podleVelikosti = new Map();
  for (const r of radky) {
    if (r.velikost == null) continue;
    const v = Number(r.velikost);
    if (!podleVelikosti.has(v)) podleVelikosti.set(v, []);
    podleVelikosti.get(v).push(r);
  }
  const velikosti = [];
  for (const [velikost, rr] of [...podleVelikosti.entries()].sort((a, b) => a[0] - b[0])) {
    const dostupne = rr.filter(vNabidce);
    // Duplicitní řádek stejné velikosti: jako e-shop ponechat ten s vyšší zásobou
    const vybrany = (dostupne.length ? dostupne : rr).slice().sort((a, b) => (Number(b.pocet_kusu) || 0) - (Number(a.pocet_kusu) || 0) || a.produkt_id - b.produkt_id)[0];
    velikosti.push({
      velikost,
      stav: dostupne.length ? (vybrany.dostupnost === 'dodavatel' ? 'dodavatel' : 'skladem') : 'vyprodano',
      cena: Number(vybrany.cena),
      cena_puvodni: vybrany.cena_puvodni != null && Number(vybrany.cena_puvodni) > Number(vybrany.cena) ? Number(vybrany.cena_puvodni) : null,
      delka_mm: vybrany.delka_mm != null ? Number(vybrany.delka_mm) : null
    });
  }
  return velikosti;
}

function cenaModelu(velikosti) {
  const nabidka = velikosti.filter(v => v.stav !== 'vyprodano');
  const zaklad = nabidka.length ? nabidka : velikosti;
  if (!zaklad.length) return { cena: null, cena_od: false, cena_puvodni: null, cena_do: null };
  const ceny = zaklad.map(v => v.cena);
  const nejnizsi = Math.min(...ceny);
  const puvodni = zaklad.filter(v => v.cena === nejnizsi && v.cena_puvodni).map(v => v.cena_puvodni);
  return {
    cena: nejnizsi,
    cena_do: Math.max(...ceny),
    cena_od: new Set(ceny).size > 1,
    cena_puvodni: puvodni.length ? Math.min(...puvodni) : null
  };
}

// Souhrnná dostupnost modelu - jediný zdroj pro text na stránce i schema.org
function dostupnostModelu(velikosti) {
  if (velikosti.some(v => v.stav === 'skladem')) return 'skladem';
  if (velikosti.some(v => v.stav === 'dodavatel')) return 'dodavatel';
  return 'vyprodano';
}

/**
 * Poskládá export z řádků databáze.
 * @param {object} d  { kategorie, modely, produkty (produkty × sklad), fotky, presmerovani, optimalizovat(url, px) }
 */
function sestavitExport(d) {
  const opt = d.optimalizovat || (u => u);
  const radkyPodleModelu = new Map();
  for (const r of d.produkty) {
    if (!radkyPodleModelu.has(r.model_id)) radkyPodleModelu.set(r.model_id, []);
    radkyPodleModelu.get(r.model_id).push(r);
  }
  const fotkyPodleProduktu = new Map();
  for (const f of d.fotky) {
    if (!fotkyPodleProduktu.has(f.produkt_id)) fotkyPodleProduktu.set(f.produkt_id, []);
    fotkyPodleProduktu.get(f.produkt_id).push(f);
  }

  const modely = [];
  for (const m of d.modely) {
    if (!SLUG.test(m.slug || '')) continue; // adresu, která nejde bezpečně publikovat, vynechat
    const radky = radkyPodleModelu.get(m.id) || [];
    if (!radky.length) continue; // model bez produktu na e-shopu = stažený
    const produktIds = [...new Set(radky.map(r => r.produkt_id))].sort((a, b) => a - b);
    const fotky = [];
    const videne = new Set();
    for (const pid of produktIds) {
      const ff = (fotkyPodleProduktu.get(pid) || []).slice().sort((a, b) => (b.is_primary === true) - (a.is_primary === true) || (a.position ?? 0) - (b.position ?? 0) || a.id - b.id);
      for (const f of ff) if (f.url && !videne.has(f.url)) { videne.add(f.url); fotky.push({ url: opt(f.url, 1000), nahled: opt(f.url, 400), alt: f.alt || '' }); }
    }
    if (!fotky.length) {
      // Starší produkty mají odkaz na fotku v poli emoji
      const stara = radky.map(r => r.emoji).find(e => typeof e === 'string' && /^https:\/\//.test(e));
      if (stara) fotky.push({ url: stara, nahled: stara, alt: '' });
    }
    const velikosti = velikostiModelu(radky);
    const popis = radky.slice().sort((a, b) => a.produkt_id - b.produkt_id).map(r => (r.popis || '').trim()).find(Boolean) || '';
    modely.push({
      slug: m.slug,
      znacka: m.znacka || '',
      nazev: m.nazev,
      kategorie: nejcastejsi(radky.map(r => r.kategorie)) || m.kategorie || null,
      popis,
      fotky,
      velikosti,
      dostupnost: dostupnostModelu(velikosti),
      ...cenaModelu(velikosti),
      vlastnosti: {
        barefoot: m.barefoot ?? null,
        sirka: m.sirka || [],
        nart: m.nart || [],
        dominantni_palec: m.dominantni_palec || null,
        zapinani: m.zapinani || [],
        membrana: m.membrana ?? null,
        material: m.material || null,
        opatek: m.opatek || null,
        pohlavi: m.pohlavi || null
      },
      proc_jsme_vybrali: (m.proc_jsme_vybrali || []).filter(Boolean)
    });
  }
  modely.sort((a, b) => a.slug.localeCompare(b.slug));

  const naWebu = new Set(modely.map(m => m.slug));
  const presmerovani = (d.presmerovani || [])
    .filter(p => SLUG.test(p.stary_slug || '') && naWebu.has(p.novy_slug) && !naWebu.has(p.stary_slug))
    .map(p => ({ stary_slug: p.stary_slug, novy_slug: p.novy_slug }))
    .sort((a, b) => a.stary_slug.localeCompare(b.stary_slug));

  return {
    verze_formatu: VERZE_FORMATU,
    kategorie: d.kategorie
      .filter(k => SLUG.test(k.slug || ''))
      .map(k => ({ slug: k.slug, nazev: k.nazev, popis: k.popis || '', poradi: Number(k.poradi) || 0, obrazek: k.obrazek_url ? opt(k.obrazek_url, 600) : null })),
    modely,
    presmerovani
  };
}

module.exports = { VERZE_FORMATU, SLUG, sestavitExport, velikostiModelu, cenaModelu, dostupnostModelu, vNabidce };
