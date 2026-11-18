-- Kontrolní dotazy: doklady bez evidence plateb a nesoulad poukazů (jen čte, bez osobních údajů).
-- Slouží ke zjištění rozsahu problému po nasazení (docs/nasazeni-eet.md, oddíl A3). Provoz
-- verze 98593ee nad databází po prvním zápisu nové verze NENÍ povolený – dotazy nejsou
-- „sladěním“, které by takový provoz umožnilo. Každý nález řešit s účetní.
-- Ověřeno 18. 11. 2026 na kopii produkce: najde prodej, čerpání poukazu, vratku i smazanou
-- účtenku z období staré verze; bez návratu hlásí jen poukazy čekající na platbu.
--   psql "$KOPIE_NEBO_PROD_URL" -X -A -F' | ' -f scripts/sladeni-po-navratu.sql
WITH od AS (SELECT MIN(vytvoreno) AS t FROM platby)
SELECT 'ucetenka_bez_platby_ani_kreditu' AS nalez, p.id::text AS doklad, p.celkem::text AS castka, p.vytvoreno
  FROM prodejna_prodeje p, od WHERE p.vytvoreno >= od.t AND COALESCE(p.celkem, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM platby x WHERE x.zdroj_typ = 'prodej' AND x.zdroj_id = p.id)
   AND NOT EXISTS (SELECT 1 FROM kredit_pohyby x WHERE x.zdroj_typ = 'prodej' AND x.zdroj_id = p.id)
UNION ALL
SELECT 'vratka_bez_zaznamu_vraceni', v.id::text, v.castka::text, v.vytvoreno
  FROM vratky v, od WHERE v.vytvoreno >= od.t AND COALESCE(v.castka, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM platby x WHERE x.zdroj_typ = 'vratka' AND x.zdroj_id = v.id)
   AND NOT EXISTS (SELECT 1 FROM kredit_pohyby x WHERE x.zdroj_typ = 'vratka' AND x.zdroj_id = v.id)
UNION ALL
SELECT 'platba_ke_smazanemu_dokladu', x.id::text, x.castka::text, x.vytvoreno FROM platby x
  WHERE (x.zdroj_typ = 'prodej' AND NOT EXISTS (SELECT 1 FROM prodejna_prodeje d WHERE d.id = x.zdroj_id))
     OR (x.zdroj_typ = 'vratka' AND NOT EXISTS (SELECT 1 FROM vratky d WHERE d.id = x.zdroj_id))
     OR (x.zdroj_typ = 'objednavka' AND NOT EXISTS (SELECT 1 FROM objednavky d WHERE d.id = x.zdroj_id))
     OR (x.zdroj_typ = 'poukaz' AND NOT EXISTS (SELECT 1 FROM darkove_poukazy d WHERE d.id = x.zdroj_id))
UNION ALL
SELECT 'kredit_ke_smazanemu_dokladu', x.id::text, x.castka::text, x.vytvoreno FROM kredit_pohyby x
  WHERE (x.zdroj_typ = 'prodej' AND NOT EXISTS (SELECT 1 FROM prodejna_prodeje d WHERE d.id = x.zdroj_id))
     OR (x.zdroj_typ = 'vratka' AND NOT EXISTS (SELECT 1 FROM vratky d WHERE d.id = x.zdroj_id))
UNION ALL
SELECT 'zustatek_poukazu_nesedi_s_kreditem', d.id::text, d.zustatek::text || ' × ' || k.s::text, NULL
  FROM darkove_poukazy d JOIN LATERAL (SELECT COALESCE(SUM(CASE WHEN typ IN ('nabiti','pocatecni_stav','pripsani','storno_cerpani') THEN castka ELSE -castka END), 0) AS s
    FROM kredit_pohyby WHERE poukaz_id = d.id) k ON true
  WHERE EXISTS (SELECT 1 FROM kredit_vklady v WHERE v.poukaz_id = d.id) AND d.zustatek <> k.s
UNION ALL
SELECT 'cerpani_poukazu_bez_kreditu', u.id::text, u.castka::text, u.vytvoreno
  FROM poukazy_pouziti u, od WHERE u.vytvoreno >= od.t AND u.castka > 0
   AND NOT EXISTS (SELECT 1 FROM kredit_pohyby x WHERE x.poukaz_id = u.poukaz_id AND x.typ = 'cerpani' AND x.castka = u.castka AND x.vytvoreno BETWEEN u.vytvoreno - interval '1 minute' AND u.vytvoreno + interval '1 minute')
UNION ALL
SELECT 'poukaz_ceka_na_platbu (stará verze ho zobrazí jako platný)', d.id::text, d.hodnota::text, NULL FROM darkove_poukazy d WHERE d.stav = 'ceka_na_platbu'
ORDER BY 1, 2;
