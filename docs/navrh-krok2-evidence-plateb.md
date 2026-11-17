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
  - převodem z jiného poukazu: původ `prevedeny`, ve schématu s vazbou `prevedeno_z_id`;
    tok zatím není a rozšiřovat se nemá,
  - **počátečním stavem**: poukaz z doby před evidencí dostane při prvním použití vklad
    ve výši *aktuálního* zůstatku (ověření `pocatecni_stav`, bez platby). Původ:
    - `darovany`, když je poukaz druhu dar,
    - `zaplaceny` **jen tehdy**, když k poukazu existuje doklad prodeje (`vydano_prodej_id`),
    - jinak **`nedolozeny`**: nikdy se automaticky nepovažuje za zaplacený, EET nevyřešeno.
- **Pořadí čerpání (jednoznačné):** 1. zaplacený, 2. vrácený, 3. převedený, 4. nedoložený,
  5. darovaný. V rámci stejného původu od nejstaršího vkladu (`vytvoreno`, pak `id`).
- **Čerpání** = pohyb + části (`kredit_casti`, směr `odber`) s pravidlem EET pro každou část.
  Pohyb má původ `smiseny`, když čerpá z více původů, a `cerp_zuct` jen tehdy, když jsou
  tak všechny části.
- **Storno čerpání** vrátí přesně stejné části. Nejde, pokud už část vrátilo připsání
  k vratce (409). **Storno nabití** jde jen u nečerpaného vkladu.
- **Vrácený kredit drží vazbu na zdroj** (`kredit_vklady_zdroje`):
  - Připsání k vratce se rozdělí na vracené části čerpání její účtenky, a to **v opačném
    pořadí, než se čerpalo** (nejdřív darovaná část).
  - Pro každý zdrojový vklad vznikne vlastní vrácený vklad se základem zdroje: zaplacený
    zůstává zaplacený, darovaný a nedoložený zůstávají nevyřešené.
  - Připsat jde nejvýš to, co se čerpalo a ještě nevrátilo.
  - Připsání bez vazby na vratku vytvoří vklad se základem `neurceny` (nevyřešeno).
  - Nové čerpání takového kreditu pravidlo zdroje zachová, ověřeno testem.
- **Převod mezi kartami** mění jen nosič (`karta_id`). Vklady, původ i vazby zůstávají.
- **Výplata** (vrácení peněz za poukaz) odebírá jen kredit se základem zaplacený s dokladem
  (`vyplaceni`). Zrušení zbytku odebere ostatní vklady bez peněz (`zruseni`).

| Pohyb / část | Podmínka | `eet_pravidlo` |
|---|---|---|
| nabití | zaplacené kontaktně / převodem / bez platby / dar | `urceno_cerp_zuct` / `neeviduje` / `nevyreseno` / `neeviduje` |
| počáteční stav, zrušení zbytku | – | `neeviduje` |
| výplata peněz za poukaz | původní platba kontaktní / na dálku | `urceno_cerp_zuct` (storno nabití) / `neeviduje` |
| část čerpání / připsání | u pultu, základ zaplacený | `cerp_zuct` |
| část čerpání / připsání | u pultu, základ darovaný, nedoložený nebo neurčený | **`nevyreseno`** |
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
- **Vratka:** penězi jde vrátit nejvýš to, co na účtence nebo objednávce opravdu přišlo, minus
  dřívější vrácení (vratky i výměny):
  - Doklady s evidencí: podle plateb v evidenci.
  - **Starší účtenky bez evidence: podle dokladu** (peníze = `celkem`, jen když se platilo
    penězi; u platby poukazem 0). I tam tedy nejde vyplatit hodnotu zaplacenou poukazem.
  - Zdrojový doklad je zamčený, souběžné vratky se řadí.
- **Výměna (pravidlo):** rozdíl ve prospěch zákazníka jde vyplatit penězi jen do výše peněz
  z původní účtenky, minus dřívější vratky a výměny. Hodnotu zaplacenou poukazem nebo
  darovaným kreditem penězi vyplatit nejde, vrací se připsáním na poukaz. Souběžné výměny
  téže účtenky se řadí (zámek účtenky); ověřeno smíšenou úhradou poukaz + karta, darem,
  historickou účtenkou a souběhem.
- **Vrácení zaplaceného poukazu** (`GET`/`POST /api/poukazy/:id/vraceni`):
  - Vrátit jde nejvýš min(zaplacený kredit, který je ještě na poukazu, zaplacená částka minus
    dřívější vrácení). Vyčerpaný kredit a připsaný kredit bez vazby se nevyplácí.
  - Vrácení se váže na původní platbu (`vraci_id`), která zůstává. U poukazu prodaného na
    prodejně vznikne vratka k jeho účtence (sedí uzávěrky i Účetnictví), u e-shopového jen
    platba v evidenci a přiřazení původní platby zůstává.
  - V jedné transakci se zaznamená výplata kreditu, zrušení zbylého kreditu a poukaz se zruší.
  - Zámek poukazu a stejný klíč: opakování ani souběh nic nezdvojí.
  - Darovaný nebo historický poukaz bez platby v evidenci: vrátit nejde (s důvodem).
- **Přiřazení plateb:**
  - Součet přiřazení nepřekročí volnou část platby (zámek platby) ani zbývající dluh
    objednávky (zámek objednávky).
  - **Storno přiřazení** (`POST /api/evidence-plateb/prirazeni/:id/storno`) jde jednou.
    Platba je pak zase volná a objednávka se vrátí do „vyřizuje se“, když jí peníze přestanou
    stačit. U odeslané nebo doručené objednávky a u přiřazení k poukazu storno nejde.
  - Stav „zaplacená“ odpovídá součtu platných úhrad (srovná se i po vrácení peněz).

## Ochrana dokladů pro EET

- **Událost EET** (`eet_udalosti`; vytvářet ji bude krok 3) chrání doklad **databázovým
  triggerem**:
  - účtenku, vratku, poukaz i objednávku s událostí nejde smazat,
  - nejde měnit jejich finanční sloupce, u účtenky včetně data,
  - platí nezávisle na `EET_ZAMEK_OD`, na změně konfigurace i na zpětném datování a chrání
    i před přímým zásahem do databáze,
  - událost samu nejde smazat ani přesměrovat na jiný doklad (měnit jde jen její stav).
  - Aplikace u chráněného dokladu odmítne smazání, změnu způsobu platby, převod na výměnu,
    přeznačení na dar a smazání poukazu srozumitelnou chybou 409. Opravy vznikají
    navázanými záznamy (vratka, storno), ověřeno testem.
- **`EET_ZAMEK_OD=RRRR-MM-DD`** (env, vypnuté) je jen doplňková pojistka. Řídí se datem
  **vzniku** dokladu (`vytvoreno`, zpětně nejde změnit), ne datem prodeje.

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
  - `test/opravy-krok2-postgres.test.js`: vrácení poukazu (náhled, strop, 3× souběžně,
    smíšený kredit, dar), výměna (smíšená úhrada, dar, historická účtenka, souběh),
    přiřazení (souběh na platbu i objednávku, opakování, storno, stav = součet úhrad),
    původ vráceného kreditu a jeho pravidlo, historický poukaz s/bez dokladu, ochrana EET
    (aplikace, přímé SQL, zpětné datum, oprava vratkou),
  - `test/kredit-vklady-postgres.test.js`, `test/evidence-plateb-postgres.test.js`,
    `test/prodejna-prodej-postgres.test.js` a další `*-postgres`,
  - `test/overeni-migrace-postgres.test.js`: skript ověření (neúplná kopie, změna dat →
    selhání a nenulový kód, úplná kopie → prošlo, odmítnutí nelokálního cíle).
- Bez databáze: unit testy s paměťovým mockem a statická kontrola obrazovek.
- **Prohlížeč:** `prohlizec-testy/` (README) – pokladna včetně Zahodit, osobní odběr,
  Platby a dobírky, vrácení poukazu, staré okno administrace.
  `node prohlizec-testy/spustit.js` (potřebuje Chrome a `playwright-core` mimo závislosti).

## Zbývající omezení a otevřené otázky

1. **Darovaný a nedoložený kredit v EET:** chybí doložená metodika, pravidlo zůstává `nevyreseno`.
2. **Převod kreditu mezi poukazy a import historie:** záměrně nerozšířeno.
3. **Historický poukaz bez platby v evidenci:** peníze přes vrácení poukazu vrátit nejde.
4. **Volná platba přijatá v hotovosti** a přiřazená poukazu nemá `urceno_k_cerpani`.
   Dořešit při sestavení zprávy EET (krok 3).
5. **Ověření na skutečné kopii produkce neproběhlo** (bez přístupu k produkční databázi).
   Postup a skript jsou připravené a vyzkoušené.

## Zdroje (oficiální)

- Popis položek datové zprávy EET 2.0 (5. 10. 2026), kap. 12–14 a 4 (storno):
  <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_polozek_datove_zpravy.pdf>
- Popis datového rozhraní v1.2 (25. 8. 2026):
  <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_rozhrani_v1.2.pdf>
- Chyby a jejich řešení (48 h): <https://eet.gov.cz/cs/zacinam-s-eet/chyby-a-jejich-reseni>
