# Krok 2 – jednotná evidence plateb

Stav: **implementováno ve větvi `fix/pokladna-atomicky-prodej`, nenasazeno.** Odesílání do EET
(krok 3) není součástí. Pravidla vycházejí z oficiálních podkladů Finanční správy (odkazy
na konci). Ověření migrace na kopii produkce: [postup-overeni-migrace.md](postup-overeni-migrace.md).

## Rozhodnutí (2026-11-17)

1. Osobní odběr nejde nově označit jako zaplacený ani vyzvednutý bez záznamu platby nebo
   přiřazené existující úhrady. Prodej ani odečet skladu nevznikne podruhé.
2. Skutečné peníze a kredit se vedou odděleně. Kredit se sleduje **po jednotlivých vkladech**
   s původem zaplacený / darovaný / vrácený / převedený. Každé čerpání má dohledatelné rozdělení.
3. Pravidlo EET pro darovaný kredit zůstává **výslovně nevyřešené** (`nevyreseno`), dokud se
   nedoloží metodika. Za zaplacený se nikdy automaticky nezamění. Interní evidenci to neblokuje.
4. Zápis vždy ve stejné transakci jako operace a s ochranou proti opakování.
5. Historie se automaticky nedoplňuje. Dosavadní poukazy jsou výslovně označené jako
   `historicky`: použitelné jako dřív a bez vymyšlené platby. Import historie zatím není.
6. Dobírka: úhrada zákazníka (příjem, jednou) ≠ pohledávka za dopravcem ≠ poplatek ≠ čisté
   vyúčtování.
7. Opravy navázanými záznamy (storno). Účetní součty beze změny.

## Vrstvy a tabulky

| Vrstva | Tabulky |
|---|---|
| Obchodní doklad (beze změny tvaru, čtou ho součty) | `prodejna_prodeje`, `objednavky`, `vratky`, `darkove_poukazy` (+ `platba_stav`), `poukazy_pouziti` |
| Skutečné peníze | `platby` (příjem / vrácení / storno), `platby_prirazeni` (volná platba → objednávka nebo poukaz) |
| Kredit | `kredit_pohyby` (nabití, počáteční stav, čerpání, připsání, storna), `kredit_vklady`, `kredit_casti` |
| Dobírka | `dobirky` (pohledávka, 1 na objednávku), `dobirky_vyuctovani` (brutto − poplatek = netto) |
| Ochrana proti opakování | `prodejna_klice` (pokladna), `operace_klice` (ostatní operace), unikátní `klic` u řádků |

Neměnnost:
- Triggery zakazují `UPDATE`/`DELETE` u `platby`, `platby_prirazeni`, `kredit_pohyby`,
  `kredit_vklady`, `kredit_casti` a `dobirky_vyuctovani`. U `dobirky` jde jen jednou
  doplnit vyúčtování.
- Unikátní indexy `platby_opravuje_uq` a `kredit_pohyby_opravuje_uq` zajistí, že každý řádek
  jde stornovat **nejvýš jednou**, i při souběhu dvou různých operací (druhá dostane 409).

## Kredit po vkladech

- **Vklad** vzniká:
  - nabitím: prodej poukazu, nabití karty, aktivace po platbě, dar,
  - připsáním vráceného zboží: původ `vraceny`,
  - převodem z jiného poukazu: původ `prevedeny`, připraveno, žádný tok ho zatím nevytváří,
  - **počátečním stavem**: poukaz z doby před evidencí dostane při prvním použití vklad
    ve výši *aktuálního* zůstatku. Původ je podle druhu poukazu, ověření `pocatecni_stav`.
    Nic se nedopočítává a nevzniká žádná platba.
- **Pořadí čerpání (jednoznačné):** 1. zaplacený, 2. vrácený, 3. převedený, 4. darovaný.
  V rámci stejného původu od nejstaršího vkladu (`vytvoreno`, pak `id`). Peníze zákazníka
  se čerpají dřív než dar, takže darovaný kredit s nevyřešeným pravidlem EET zůstává co
  nejdéle nečerpaný.
- **Čerpání** se zapíše jako pohyb a části (`kredit_casti`, směr `odber`) s pravidlem EET pro
  každou část. Pohyb má původ `smiseny`, když čerpá z více původů, a pravidlo `cerp_zuct`
  jen tehdy, když jsou tak všechny části.
- **Storno čerpání** vrátí přesně stejné části (stejné vklady, stejné částky, směr `vraceni`).
  **Storno nabití** jde jen u nečerpaného vkladu (odebere ho celý). Jinak 409 a oprava se
  dělá vratkou nebo připsáním.
- **Vrácený vklad** si nese `eet_zaklad`: zaplacený nebo darovaný podle čerpání, které se vrací
  (vratka → účtenka → části), jinak podle vkladů poukazu. Smíšený nebo neznámý základ je
  `neurceny` (nevyřešeno).
- **Převod mezi kartami** mění jen nosič (`karta_id`). Vklady i původ zůstávají u poukazu,
  ověřeno testem.

| Pohyb / část | Podmínka | `eet_pravidlo` |
|---|---|---|
| nabití | zaplacené kontaktně / převodem / bez platby / dar | `urceno_cerp_zuct` / `neeviduje` / `nevyreseno` / `neeviduje` |
| počáteční stav | – | `neeviduje` (jen otevření zůstatku) |
| část čerpání / připsání | u pultu, základ zaplacený | `cerp_zuct` |
| část čerpání / připsání | u pultu, základ darovaný nebo neurčený | **`nevyreseno`** |
| část čerpání | online (e-shop) | `neeviduje` |

## Poukazy z e-shopu: žádost → platba → aktivace

- Prodaný poukaz bez platby (žádost z e-shopu, v pokladně „Zaplatí později“) vznikne ve stavu
  `ceka_na_platbu` (`platba_stav = 'ceka'`). **Nejde použít ani ověřit** (`najitPoukaz`), nejde
  na něj připsat, nemá kredit a zákazník zatím nedostane e-mail s kódem.
- `POST /api/poukazy/:id/platba`: zápis platby (hotově, kartou, QR, převodem), nebo
  **přiřazení existující volné platby** (`platba_id`), takže příjem se nezapočítá dvakrát.
  Pak aktivace (platnost běží od úhrady), zaplacený vklad a e-mail s kódem.
- **Částečná úhrada poukazu není podporovaná** a odmítne se (částka musí být rovna hodnotě,
  volná platba musí pokrýt celou hodnotu).
- Kartu jde nabít jen s platbou. Zaplacený e-shopový poukaz nejde přeznačit na dar ani
  smazat, jen zrušit.
- Dosavadní poukazy: migrace jim jednou nastaví `platba_stav = 'historicky'`, stav se nemění.

## Objednávky, osobní odběr, dobírka

- Osobní odběr s platbou na prodejně: do stavu `zaplacena`/`dorucena` se nově přejde jen při
  přijato ≥ celkem. Přijetí platby ani přiřazení nevytváří prodej a neodečítá sklad.
- **Částečné úhrady objednávky jsou podporované:** několik plateb, nebo část volné platby.
  Hlídá se zbývající částka (přeplatek se odmítne), volná část platby (advisory lock na platbu)
  a zámek objednávky. Po úplném zaplacení se objednávka označí jako zaplacená.
- Zrušení objednávky s přijatými penězi jde až po zápisu vrácení. Peníze vrácené vratkou
  k objednávce se od přijatých odečtou, takže je nejde vrátit podruhé.
- Dobírka: `POST /api/objednavky/:id/dobirka` zapíše příjem (nekontaktní) a pohledávku
  za dopravcem, jednou na objednávku. Vyúčtování od dopravce zapíše brutto (součet vybraných
  dobírek), poplatek a netto. Nový příjem nevzniká. Dobírka jde vyúčtovat jen jednou a celá,
  **částečné vyúčtování jedné dobírky není podporované**.

## Pokladna, „Zahodit“

- Hlavní ochrana je tabulka **`prodejna_klice`** (primární klíč = klíč prodeje, stav
  `ulozeny`/`zahozeny`). Uložení i „Zahodit“ zapisují do stejného řádku: kdo je první, ten
  rozhodne. Platí natrvalo, i po restartu serveru, obnovení prohlížeče a mimo jakékoli časové
  okno. Smazaný prodej se pod svým klíčem znovu neuloží.
- Upozornění na stejný nákup do 30 minut (`potvrdit_duplicitu`) je jen pomůcka pro obsluhu.
- Klíč nedokončeného prodeje drží prohlížeč v `localStorage`. Bez spojení zahodit nejde.

## Opravy a vrácení – nic dvakrát

- Storno řádku nejvýš jednou (unikátní indexy). Souběžná oprava dvou operací: jedna 409.
- Vratka: penězi jde vrátit nejvýš to, co na účtence nebo objednávce opravdu přišlo, minus
  dřívější vrácení. Platí jen pro doklady s evidencí, starší se nehlídají. Účtenka placená
  jen poukazem = penězi 0, vrací se připsáním. Zdrojový doklad je zamčený, souběžné vratky
  se řadí.
- Připsání k vratce: nejvýš kolik se z poukazu na její účtenku čerpalo, minus dřívější
  připsání.

## Příprava zámku EET (vypnutý)

- `EET_ZAMEK_OD=RRRR-MM-DD` (env) zablokuje u dokladů od toho data:
  - smazání účtenky,
  - změnu způsobu platby,
  - dodatečný převod na výměnu,
  - přeznačení prodaného poukazu na dar,
  - smazání prodaného poukazu.
- Oprava pak jde jen vratkou nebo stornem. Bez proměnné je vše jako dřív. Odesílání do EET
  to nezapíná.

## Administrace

- **Účetnictví → Platby a dobírky:**
  - zápis volné platby,
  - přiřazení k objednávce (část jde) nebo k poukazu (jen celou hodnotou; poukaz, který
    zbytek nepokryje, se v nabídce neukáže),
  - dobírky k vyúčtování (výběr, poplatek, živý výpočet brutto/netto, jen jeden dopravce),
  - seznam vyúčtování.
- **Detail poukazu** čekajícího na platbu: zápis platby a aktivace.
- **Detail objednávky:** platby, přijetí, vrácení, „Dobírka vybrána“.
- **Kontrola plateb:**
  - doklady v rozsahu (od prvního zápisu evidence, poukazy s vklady),
  - zvlášť **mimo rozsah** (starší bez evidence – nekontrolují se, nejsou spárované),
  - poukazy čekající na platbu,
  - osobní odběry zaplacené bez platby.
- Všechny operace posílají klíč a po výpadku spojení ho zopakují.

## Testy

- Proti PostgreSQL:
  - `test/kredit-vklady-postgres.test.js`: pořadí čerpání, rozdělení, storno přesně, souběžné
    storno, převod mezi kartami, historické poukazy, e-shop poukazy, Zahodit po restartu,
    stropy vrácení, souběžná oprava, zámek EET, kontrola rozsahu,
  - `test/evidence-plateb-postgres.test.js`, `test/prodejna-prodej-postgres.test.js` a další
    `*-postgres` testy.
- Bez databáze: unit testy s paměťovým mockem (`test-helpers/evidenceMock.js`) a statická
  kontrola obrazovek (`test/admin-platby.test.js`).
- Prohlížeč (Chrome, lokální server, dočasná DB): pokladna včetně Zahodit, osobní odběr,
  Platby a dobírky, detail poukazu. Testovací skripty jsou mimo repozitář
  (`playwright-core` není závislost projektu).

## Zbývající omezení a otevřené otázky

1. **Darovaný kredit v EET:** chybí doložená metodika.
2. **Vrácení peněz za zaplacený e-shopový poukaz** (zrušení po platbě): poukaz jde zrušit,
   ale vrácení peněz se zatím nezapisuje (chybí endpoint).
3. **Převedený kredit** (zůstatek na jiný poukaz) je ve schématu, tok zatím není.
4. **Import historie:** není a automaticky se nedoplňuje.
5. **Výměna** nemá strop vráceného rozdílu proti penězům původní účtenky (řídí se zápočtem).
6. **Volná platba přijatá v hotovosti** a přiřazená poukazu: pravidlo EET pro nabití se vezme
   z platby, ale samotná volná platba nemá `urceno_k_cerpani`. Dořešit v kroku 3.
7. **Ověření na skutečné kopii produkce neproběhlo.** Postup i skript jsou připravené
   a vyzkoušené na simulaci.

## Zdroje (oficiální)

- Popis položek datové zprávy EET 2.0 (5. 10. 2026), kap. 12–14 a 4 (storno):
  <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_polozek_datove_zpravy.pdf>
- Popis datového rozhraní v1.2 (25. 8. 2026):
  <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_rozhrani_v1.2.pdf>
- Chyby a jejich řešení (48 h): <https://eet.gov.cz/cs/zacinam-s-eet/chyby-a-jejich-reseni>
