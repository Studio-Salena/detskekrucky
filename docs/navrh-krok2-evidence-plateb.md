# Krok 2 – jednotná evidence plateb

Stav: **implementováno ve větvi `fix/pokladna-atomicky-prodej`, nenasazeno.** Odesílání do EET
(krok 3) není součástí; tento krok pro něj jen připravuje data. Pravidla vycházejí z oficiálních
podkladů Finanční správy (odkazy na konci).

## Rozhodnutí (zadání majitelky / vývojářky, 2026-11-17)

1. Osobní odběr nejde nově označit jako zaplacený bez záznamu platby nebo vazby na existující
   úhradu. Sklad ani prodej se nevytvoří podruhé.
2. Skutečné peníze a kredit poukazu se vedou odděleně. U kreditu se uchovává původ:
   zaplacený, darovaný, vrácený, převedený.
3. Pravidlo EET pro darovaný kredit zůstává **výslovně nevyřešené** (`eet_pravidlo =
   'nevyreseno'`), dokud se nedoloží metodika. Nesmí se automaticky zaměnit za zaplacený kredit.
4. Nové platby se zapisují ve stejné transakci jako související operace a s ochranou proti
   opakování.
5. Historie se automaticky nedoplňuje domnělými platbami. Případný import bude oddělený,
   s označeným původem a neúplnými údaji (zatím neimplementováno).
6. U dobírky se rozlišuje úhrada zákazníka, pohledávka za dopravcem, poplatek a čisté
   vyúčtování. Příjem se nezapočítá dvakrát.
7. Původní finanční záznamy se opravují navázanými záznamy. Současné účetní součty se nemění.

## Vrstvy

| Vrstva | Tabulky | Poznámka |
|---|---|---|
| Obchodní doklad | `prodejna_prodeje`, `objednavky`, `vratky`, `darkove_poukazy`, `poukazy_pouziti` | beze změny tvaru; uzávěrky, Účetnictví a reporty čtou jen tyto tabulky |
| Skutečné peníze | `platby`, `platby_prirazeni` | příjem, vrácení, storno příjmu, storno vrácení |
| Kredit poukazu | `kredit_pohyby` | nabití, čerpání, připsání (+ storna), s původem a pravidlem EET |
| Dobírka | `dobirky`, `dobirky_vyuctovani` | pohledávka za dopravcem a její vyúčtování |
| Opakování | `operace_klice`, `prodejna_klice_zahozene` | výsledek operace podle klíče, zneplatněné klíče pokladny |
| Událost EET | – | krok 3 (sloupec `eet_pravidlo` ukazuje, jak se kredit promítne) |

Kód: `lib/evidencePlateb.js` (schéma, pravidla, zápisy, `jednou()`), `routes/evidencePlateb.js`
(`/api/evidence-plateb`: přehled, volná platba, vyúčtování dobírek, kontrola), zápisy v
`lib/prodejPokladna.js`, `routes/prodejna.js`, `routes/poukazy.js`, `routes/objednavky.js`.

## Schéma (zkráceně)

- **`platby`**: `klic` UNIQUE, `typ` (`prijem`/`vraceni`/`storno_prijmu`/`storno_vraceni`),
  `castka` > 0, `mena` CZK, `zpusob` (`hotovost`/`karta`/`qr`/`prevod`/`dobirka`),
  `okolnosti` (`prodejna`/`osobni_odber`/`eshop`/`dopravce`), `kontaktni` (NOT NULL),
  `prijato_at`, `zdroj_typ`/`zdroj_id` (`prodej`/`objednavka`/`vratka`/`volna`),
  `urceno_k_cerpani` (část nabíjející kredit), `vraci_id` (vrácení → původní příjem),
  `opravuje_id` (storno → opravovaný řádek), `puvod = 'provoz'`.
- **`kredit_pohyby`**: `klic` UNIQUE, `poukaz_id`, `typ` (`nabiti`/`cerpani`/`pripsani` +
  `storno_*`), `castka`, `puvod` (`zaplaceny`/`darovany`/`vraceny`/`prevedeny`), `kontaktni`,
  `platba_id` (u zaplaceného nabití), `zdroj_typ`/`zdroj_id`, `opravuje_id`, `eet_pravidlo`
  (`urceno_cerp_zuct`/`cerp_zuct`/`neeviduje`/`nevyreseno`).
- **`platby_prirazeni`**: přiřazení volné platby (bez dokladu, např. převod) k objednávce.
- **`dobirky`**: jedna na objednávku, vazba na platbu úhrady zákazníka a na vyúčtování.
  **`dobirky_vyuctovani`**: `brutto`, `poplatek`, `netto` (`CHECK netto = brutto − poplatek`).
- Triggery zakazují `UPDATE` a `DELETE` u `platby`, `platby_prirazeni`, `kredit_pohyby`,
  `dobirky_vyuctovani`. U `dobirky` jde jen jednou doplnit vyúčtování.

## Pravidlo EET pro kredit (`pravidloEet`)

| Pohyb | Původ / okolnosti | `eet_pravidlo` |
|---|---|---|
| nabití | zaplacené kontaktně | `urceno_cerp_zuct` |
| nabití | zaplacené převodem | `neeviduje` |
| nabití | prodaný poukaz bez zapsané platby | `nevyreseno` |
| nabití | darované | `neeviduje` (nic se neplatilo) |
| čerpání / připsání | u pultu, zaplacený kredit | `cerp_zuct` |
| čerpání / připsání | u pultu, **darovaný** kredit | **`nevyreseno`** |
| čerpání | online (e-shop) | `neeviduje` |

Připsání (vrácení zboží na poukaz) má původ `vraceny`, pravidlo se určuje podle původu poukazu.
Původ `prevedeny` je ve schématu připravený. Dnešní převod zůstatku mezi kartami jen mění
nosič stejného poukazu, kredit se nepřesouvá, a proto nevzniká žádný pohyb.

## Toky

| Operace | Peníze (`platby`) | Kredit (`kredit_pohyby`) | Opakování |
|---|---|---|---|
| prodej v pokladně | `prijem` (kromě celé platby poukazem) | `cerpani` | klíč prodeje |
| poukaz + doplatek | `prijem` doplatku | `cerpani` | klíč prodeje |
| prodej / nabití poukazu | `prijem` s `urceno_k_cerpani`, zdroj = účtenka | `nabiti` zaplacené | `klic` |
| darovaný poukaz | – | `nabiti` darované | `klic` |
| `/poukazy/pouzit` | – | `cerpani` | – (starý endpoint, pokladna ho nevolá) |
| připsání na poukaz | – | `pripsani` (zdroj vratka, je-li zadaná) | `klic` |
| vratka | `vraceni` (je-li částka a peněžní způsob), `vraci_id` | – | `klic` |
| výměna | `prijem` doplatku nebo `vraceni` rozdílu | – | `klic` |
| převod na výměnu | storno původních + skutečný doplatek/rozdíl | – | – |
| změna způsobu platby | `storno_prijmu` + nový `prijem` | – | – |
| smazání účtenky | `storno_prijmu` (doklad se smaže jako dřív) | – | – |
| poukaz → dar | `storno_prijmu` | `storno_nabiti` + `nabiti` darované | – |
| zrušení nepoužitého poukazu | `storno_prijmu` | `storno_nabiti` | – |
| objednávka s poukazem | – | `cerpani` online | (transakce objednávky) |
| zrušení objednávky | (musí být 0 Kč přijato) | `storno_cerpani`; v `poukazy_pouziti` záporný řádek místo smazání | – |
| osobní odběr – přijetí platby | `prijem` `osobni_odber`, kontaktní; stav zaplacená | – | `klic` |
| přiřazení volné platby | `platby_prirazeni` | – | `klic` |
| vrácení platby objednávky | `vraceni` | – | `klic` |
| dobírka vybrána | `prijem` `dobirka`, nekontaktní + `dobirky` (pohledávka) | – | `klic` + 1 na objednávku |
| vyúčtování dobírek | – (žádný nový příjem) | – | `klic`, dobírka jen jednou |

Pravidla stavů objednávky:
- U osobního odběru s platbou na prodejně se do stavu `zaplacena`/`dorucena` nově přejde,
  jen když přijato ≥ celkem.
- Zrušení objednávky s přijatými penězi je možné až po zápisu vrácení.

Pokladna, „Zahodit“:
- „Zahodit“ se pod zámkem klíče zeptá serveru. Uložený prodej se nezahodí a vrátí se
  (vytiskne se účtenka). Neuložený klíč se zneplatní, takže pozdní pokus nic neuloží.
- Stejný nákup (otisk obsahu) do 30 minut se uloží jen s výslovným potvrzením.

## Účetní součty

Nemění se. Kniha plateb se do nich nepřičítá a doklady mají stejný tvar.

Jediná změna v dokladech: zrušení objednávky s poukazem dřív mazalo řádek v `poukazy_pouziti`.
Nově zůstane a přidá se záporný řádek, takže součet čerpání zůstává stejný. Ověřeno testem.

Přehled **Účetnictví → 🔎 Kontrola plateb** (`GET /api/evidence-plateb/kontrola`) porovná doklady
od prvního zápisu evidence:
- příjem účtenky,
- čerpání poukazu,
- vrácené peníze z vratek,
- zůstatek poukazu proti kreditu.

## Migrace a návrat

- Tabulky a triggery zakládá idempotentně `routes/evidencePlateb.js` při startu (dvojí běh
  ověřen). Ostatní routy do nich jen zapisují.
- Historie se nedoplňuje. Kontrola plateb proto začíná prvním zápisem.
- Před nasazením: záloha produkční DB (`pg_dump`), zkušební start na její kopii, Kontrola plateb
  a porovnání součtů Účetnictví před a po.
- Návrat: předchozí verze kódu tabulky evidence ignoruje. Data dokladů zůstávají v původním
  tvaru, takže stará verze funguje dál.

## Testy

- `test/evidence-plateb-postgres.test.js`: migrace 2×, triggery neměnnosti, 5× stejný klíč
  souběžně (prodej, platba objednávky), rollback po chybě zápisu platby, poukazy (prodej 3×
  souběžně, dar, čerpání daru = `nevyreseno`, připsání 2×, dodatečný dar), osobní odběr (blokace
  zaplacení, platba bez prodeje a druhého odečtu skladu, přeplatek, zrušení až po vrácení,
  přiřazení volné platby), dobírka (3× souběžně, vyúčtování brutto/poplatek/netto, druhé
  vyúčtování odmítnuto, příjem jen jednou), opravy (změna způsobu, smazání), vratka a výměna 2×,
  kontrola (nula rozdílů, umělý rozdíl nalezen), účetní součty beze změny.
- `test/prodejna-prodej-postgres.test.js`: „Zahodit“ souběžně s pozdním požadavkem (6×), ztracená
  odpověď → Zahodit → nové zadání = žádný druhý prodej.
- `test/prodejna-doplatek.test.js`: totéž v paměti + evidence z pokladny + statická kontrola adminu.
- Prohlížeč (Chrome, lokální server, dočasná DB): pokladna 8 scénářů včetně Zahodit; osobní odběr
  v detailu objednávky (blokace Zaplaceno, platba po ztracené odpovědi jednou).

## Otevřené otázky

1. **Darovaný kredit v EET:** metodika ke čerpání daru (a připsání na darovaný poukaz).
2. **Prodaný poukaz bez zapsané platby** (žádost z e-shopu bez platby, dřívější postupy):
   `nevyreseno`. Dořešit, jak se platba za takový poukaz zapisuje.
3. **Import historie:** zda vůbec. Pokud ano, oddělená tabulka s `puvod = 'import'` a `uplnost`.
4. **Vyúčtování dobírek v adminu:** API hotové, obrazovka (výběr dobírek, poplatek) zatím ne.
   Totéž přiřazení volné platby (API ano, obrazovka jen v API).
5. **Mazání účtenek a převod na výměnu** po zapnutí EET zakázat. Evidovanou tržbu jde opravit
   jen záporným záznamem.
6. **Poukaz s kombinovaným původem** (darovaný poukaz s připsaným vráceným kreditem): čerpání se
   přiřazuje podle původu poukazu, ne podle jednotlivých vkladů.

## Zdroje (oficiální)

- Popis položek datové zprávy EET 2.0 (5. 10. 2026), kap. 12–14 a 4 (storno):
  <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_polozek_datove_zpravy.pdf>
- Popis datového rozhraní v1.2 (25. 8. 2026), kap. 2.2 a 4:
  <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_rozhrani_v1.2.pdf>
- Chyby a jejich řešení (48 h): <https://eet.gov.cz/cs/zacinam-s-eet/chyby-a-jejich-reseni>
- EET OFF: <https://eet.gov.cz/cs/eet-off/co-je-rezim-eet-off>
