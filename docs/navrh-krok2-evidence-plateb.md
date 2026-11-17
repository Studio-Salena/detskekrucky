# Krok 2 – jednotná evidence plateb (návrh k odsouhlasení)

Stav: **návrh, nic z toho není implementované.** Odesílání do EET (krok 3) tento krok neobsahuje,
připravuje pro něj jen data. Vychází z kódu větve `fix/pokladna-atomicky-prodej` (commit `1e55088`)
a z oficiálních podkladů Finanční správy (odkazy na konci).

## 1. Tři vrstvy

| Vrstva | Co to je | Kde | Mění se? |
|---|---|---|---|
| **Obchodní doklad** | co se prodalo / vrátilo / vydalo | stávající `prodejna_prodeje`, `objednavky`, `vratky`, `darkove_poukazy` | zůstává, jak je |
| **Platba** | skutečný pohyb peněz nebo kreditu poukazu: kolik, kdy, čím, za jakých okolností, k jakému dokladu | nová tabulka `platby` | jen přibývají řádky; oprava = nový navázaný řádek |
| **Událost EET** | jedna evidovaná tržba pro datovou zprávu (může spojit víc plateb téhož okamžiku, např. poukaz + karta) | nová tabulka `eet_udalosti` (v kroku 2 jen výpočet „kandidátů“, žádné odesílání) | v kroku 3 |

Stávající účetní součty (uzávěrky, Účetnictví, reporty) **dál čtou jen obchodní doklady**. Tabulka
`platby` se do nich nepřičítá, takže nemůže dojít k dvojímu započtení. Slouží jako samostatná kniha
plateb a ke kontrole, že obě strany sedí (část 6).

## 2. Schéma

### `platby` (kniha plateb, neměnná)

| Sloupec | Typ | Význam |
|---|---|---|
| `id` | serial PK | |
| `klic` | text UNIQUE NOT NULL | proti duplicitám (z pokladny UUID pokusu; u migrace `mig:<zdroj>:<id>:<typ>`) |
| `typ` | text NOT NULL | `prijem` (nové peníze od zákazníka), `vraceni` (peníze vrácené zákazníkovi), `cerpani` (kredit poukazu použitý k úhradě), `pripsani` (kredit vrácený na poukaz) |
| `castka` | numeric(12,2) NOT NULL, > 0 | vždy kladná, směr určuje `typ` |
| `mena` | char(3) NOT NULL DEFAULT `CZK` | |
| `urceno_k_cerpani` | numeric(12,2) NULL | část příjmu, která nabíjí kredit (prodej poukazu, nabití karty); jinak NULL |
| `prijato_at` | timestamptz NULL | okamžik přijetí / vrácení peněz; NULL = neznámý (jen historie) |
| `zpusob` | text NOT NULL | `hotovost`, `karta`, `qr`, `prevod`, `dobirka`, `poukaz`, `neznamy` |
| `okolnosti` | text NOT NULL | `prodejna` (u pultu), `osobni_odber` (vyzvednutí e-shopové objednávky), `eshop` (online, bez kontaktu), `dopravce` (dobírka), `neznamo` |
| `kontaktni` | boolean NULL | platba při osobním kontaktu; NULL = neznámo. Ukládá se, ne odvozuje, aby šlo zpětně doložit, z čeho se vycházelo |
| `zdroj_typ`, `zdroj_id` | text, int NOT NULL | `prodej`, `objednavka`, `vratka`, `poukaz` + id dokladu |
| `poukaz_id` | int NULL | u `cerpani`, `pripsani` a nabití |
| `opravuje_id` | int NULL → `platby.id` | oprava / storno navázané na původní platbu |
| `puvod` | text NOT NULL | `pokladna`, `admin`, `migrace` |
| `uplnost` | text NOT NULL DEFAULT `uplne` | `uplne` / `neuplne` (chybí způsob, čas nebo okolnosti; jen historie) |
| `poznamka` | text NULL | |
| `vytvoreno` | timestamptz DEFAULT now() | |

- Trigger zakáže `UPDATE` i `DELETE` (stejně jako u `faktury`). Oprava = nový řádek s `opravuje_id`
  a opačným typem (např. `vraceni` proti `prijem`).
- `CHECK`: `cerpani`/`pripsani` ⇒ `zpusob = 'poukaz'` a `poukaz_id NOT NULL`; `urceno_k_cerpani <= castka`.
- Index `(zdroj_typ, zdroj_id)`, `(prijato_at)`.

### `poukazy_pouziti` (stávající)

Zůstává jako kniha kreditu poukazu (zůstatek). Každý nový řádek dostane `platba_id` → `platby.id`,
aby se čerpání v knize plateb a v historii poukazu nedalo rozpojit.

### `eet_udalosti` (jen struktura; plnění v kroku 3)

`id`, `porad_cis` (unikátní, pevné), `id_pokl`, `id_jednotky`, `dat_trzby`, `celk_trzba`,
`urceno_cerp_zuct`, `cerp_zuct`, `stav` (`ceka`/`potvrzeno`/`chyba`/`neeviduje`), `pok`,
`lhuta_do` (= `dat_trzby` + 48 h) + vazební tabulka `eet_udalosti_platby` a tabulka pokusů
`eet_pokusy` (`uuid_zpravy` nový pro každý pokus, `dat_odesl`, `prvni_zaslani`, výsledek, kód chyby).
Hodnoty, které tvoří jednoznačný kód tržby (`eic|id_jednotky|id_pokl|porad_cis|dat_trzby|celk_trzba`),
se při opakování **nesmí změnit**; mění se jen UUID a `prvni_zaslani=false`.

## 3. Které toky vytvoří jaké platby

Kontaktní = při osobním kontaktu (podléhá EET). „EET kandidát“ = jak by vypadala datová zpráva podle
oficiálního popisu položek; v kroku 2 se jen počítá a ukazuje, neodesílá se.

| Tok (endpoint) | Řádky v `platby` | EET kandidát |
|---|---|---|
| Prodej v pokladně hotově / kartou / QR (`POST /api/prodejna`) | `prijem` (částka = `celkem`) | `celk_trzba` = částka |
| Celý nákup poukazem | `cerpani` (poukaz) | `celk_trzba` = `cerp_zuct` = čerpaná částka |
| Poukaz + doplatek (1 200 = 1 000 poukaz + 200 karta) | `cerpani` 1 000 + `prijem` 200, stejný `prijato_at` | **jedna** zpráva: `celk_trzba` 1 200, `cerp_zuct` 1 000 |
| Prodej poukazu / nabití karty (`POST /api/poukazy`) | `prijem` s `urceno_k_cerpani` = hodnota | `celk_trzba` = `urceno_cerp_zuct` = hodnota (je-li platba kontaktní) |
| Darovaný poukaz (`druh = dar`) | žádná (peníze nepřišly) | žádná; **čerpání daru – otázka pro účetní (část 8)** |
| Osobní odběr, platba na prodejně (nové – část 4) | `prijem`, `okolnosti = osobni_odber`, kontaktní | `celk_trzba` = přijatá částka (bez části zaplacené poukazem online) |
| Objednávka převodem / online poukazem | `prijem` `prevod` / `cerpani`, `okolnosti = eshop`, nekontaktní | neeviduje se |
| Dobírka | `prijem` `dobirka`, `okolnosti = dopravce`, nekontaktní | neeviduje se |
| Vratka – peníze zpět (`POST /api/prodejna/vratky`) | `vraceni` se `zpusob_vraceni` | záporná `celk_trzba`, pokud byla původní tržba evidovaná |
| Vratka – částka zpět na poukaz (`POST /api/poukazy/:id/pripsat`) | `pripsani` navázané na vratku | `celk_trzba` = `cerp_zuct` = −částka |
| Výměna (`POST /api/prodejna/vymeny`) | jen skutečný rozdíl: `prijem` (doplatek) nebo `vraceni` (přeplatek), nic při 0 | jen doplatek / vrácený rozdíl |
| Převod na výměnu (`POST /vymeny/prevest`) | opravné řádky k původní platbě vratky a prodeje (`opravuje_id`), původní zůstanou | v kroku 3 zakázat pro už evidované tržby |

## 4. Osobní odběr – zaznamenání skutečné úhrady

Dnes se platba na prodejně zapíše jen změnou stavu objednávky na `zaplacena`. Chybí částka, způsob
i čas. Návrh:

- V detailu objednávky (jen `doprava = osobni_odber`, `platba = na_prodejne`, ne zrušená) přibude
  tlačítko **„Přijmout platbu“**: způsob hotovost / karta / QR, přijatá hotovost, částka předvyplněná
  = zbývá uhradit (`celkem` minus už přijaté platby).
- `POST /api/objednavky/:id/platby { klic, zpusob, castka, hotovost_prijato }` v jedné transakci:
  zámek objednávky, kontrola, že nejde o přeplatek ani o zrušenou objednávku, zápis do `platby`,
  stav `zaplacena` + `zaplaceno_at`. **Nevzniká prodej v pokladně a sklad se neodečítá** (už se
  odečetl při objednání).
- Stejný `klic` = vrácení uloženého (stejná ochrana jako u pokladny, i po obnovení stránky).
- Volitelně doklad o přijetí platby (58 mm, stejná tiskárna jako účtenka).
- Ruční změna stavu na `zaplacena` u osobního odběru bez platby: upozornění „Platba není
  zaznamenaná“. Zákaz zatím ne, rozhodnutí je na majitelce.

## 5. Opravy stávajících toků (původní záznamy zachovat)

Tyhle akce dnes finanční záznam mažou nebo přepisují. Návrh je nahradit je navázaným záznamem:

| Dnes | Návrh |
|---|---|
| `PATCH /poukazy/:id/dar` smaže prodej poukazu | prodej zůstane, vznikne `vraceni` (peníze vráceny) nebo oprava „omylem zapsaný prodej“ s důvodem |
| `DELETE /poukazy/:id` u nepoužitého poukazu smaže poukaz i prodej | stav `zruseny` + opravná platba; mazat jen poukaz bez jakékoli platby |
| `PUT /prodejna/:id` mění `platba` | změna způsobu = oprava (`opravuje_id`) se starou i novou hodnotou; účtenka beze změny |
| `DELETE /prodejna/:id` | jen bez navázané platby; jinak storno (opravná platba) |
| `POST /poukazy` (prodej poukazu) | doplnit `klic` proti dvojímu vydání (dvojklik = dva poukazy) |

## 6. Účetní součty a kontrola

- **Uzávěrky, Účetnictví a reporty se nemění.** Čtou stejné tabulky jako dnes. Osobní odběr se dál
  počítá v e-shopu při objednání, platba ho jen doplní a do prodejny se nepřičítá.
- Nový přehled **Reporty → Kontrola plateb** (jen čtení), po dnech:
  - prodejna: Σ `prodejna_prodeje.celkem` (bez `platba = 'poukaz'`) proti Σ `prijem` z pokladny;
  - poukazem: Σ `celkem` s `platba = 'poukaz'` + Σ `poukaz_castka` proti Σ `cerpani`;
  - vratky: Σ `vratky.castka` proti Σ `vraceni`;
  - hotovost: hotovost z uzávěrky proti Σ hotovostních `prijem` − `vraceni`.
  - Každý rozdíl ukáže konkrétní doklad.

## 7. Migrace

1. **Záloha produkční DB** (`pg_dump` na Forpsi VPS) a zkušební běh na její kopii, nikdy rovnou
   na produkci.
2. Při startu serveru idempotentní `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`
   + trigger (opakovatelné jako ostatní migrace). Od nasazení zapisují nové toky do `platby`
   ve stejné transakci jako doklad.
3. **Doplnění historie** jako samostatný krok spouštěný ručně (`node scripts/platby-historie.js
   --nanecisto` → přehled, pak ostrý běh). Idempotentní díky `klic = mig:…`:
   - prodeje v pokladně: `zpusob` z uloženého `platba` (bylo zaznamenáno při prodeji),
     `prijato_at = datum`, `okolnosti = prodejna`, `kontaktni = true`; plná platba poukazem →
     `cerpani`, doplatek → `cerpani` + `prijem`;
   - prodej poukazu: `prijem` s `urceno_k_cerpani`, způsob z uloženého `platba`;
   - vratky: `zpusob_vraceni`; kde chybí (starší vratky) → `zpusob = neznamy`, `uplnost = neuplne`;
   - objednávky: způsob z objednávky (`prevod`/`dobirka`), čas = `zaplaceno_at`, pokud existuje,
     jinak NULL a `neuplne`; **osobní odběry z minulosti → `zpusob = neznamy`, `okolnosti =
     osobni_odber`, `kontaktni = NULL`** (způsob úhrady na prodejně se nikde nezapisoval);
   - nic se nedopočítává ani neodhaduje; neznámé zůstává neznámé a je vidět v přehledu.
4. Po migraci musí Kontrola plateb (část 6) vyjít bez rozdílu u všech úplných záznamů. Rozdíly
   u neúplných se jen vypíšou.
5. Návrat: nové tabulky jde odpojit vypínačem `PLATBY_ZAPIS=false` (toky pak jen nezapisují do
   `platby`), stávající data a součty nejsou dotčené.

## 8. Otevřené otázky (majitelka / účetní)

1. **Darovaný poukaz:** při vydání žádná platba. Má se čerpání daru evidovat jako `cerp_zuct`?
   Podle popisu položek podléhá evidenci čerpání kreditu, dar ale není předchozí platbou.
2. **EET OFF:** splňuje majitelka podmínky (první pásmo paušálního režimu, příjmy do 1 mil. Kč,
   přihláška do 10. dne období)? Na kroku 2 to nic nemění.
3. **Ruční „zaplaceno“ u osobního odběru:** jen upozornit, nebo vyžadovat zápis platby?
4. **Historie:** doplnit celou, nebo jen od zvoleného data?
5. **Dobírka:** zapisovat příjem až podle výpisu od dopravce, nebo stačí stav `dorucena`?

## 9. Testovací scénáře (krok 2)

Unit + izolovaný PostgreSQL (`TEST_PG_URL`) + prohlížeč (stejný postup jako u kroku 1):

1. Každý tok z tabulky v části 3 vytvoří přesně očekávané řádky (typ, částka, způsob, okolnosti,
   kontaktní, zdroj, poukaz) ve stejné transakci jako doklad. Chyba uprostřed = nic.
2. Poukaz + doplatek: dva řádky se stejným `prijato_at`, kandidát EET = jedna zpráva 1 200 / 1 000.
3. Osobní odběr: platba se zapíše jednou (5× stejný klíč souběžně), nevznikne prodej, sklad se
   nezmění, přeplatek a zrušená objednávka se odmítnou, ztráta odpovědi + obnovení stránky.
4. Neměnnost: `UPDATE`/`DELETE` na `platby` selže (trigger), oprava vytvoří navázaný řádek.
5. Opravy z části 5: dar, zrušení poukazu, změna způsobu platby, smazání prodeje – původní řádky
   zůstanou, opravný řádek sedí.
6. Migrace dvakrát za sebou = stejný výsledek; historické osobní odběry jsou `neznamy`/`neuplne`,
   nic se nedopočítá.
7. Kontrola plateb: na datech po migraci nulové rozdíly u úplných záznamů; uměle vložený rozdíl
   se ukáže u správného dokladu.
8. Uzávěrky a Účetnictví: stejné součty před a po nasazení na stejných datech (snímek z kopie
   produkční DB).
9. Kandidáti EET: příklady z oficiálního popisu položek (stravenka + karta, nabití a čerpání,
   vratka na kartu, výměna s doplatkem) dávají stejné hodnoty polí.

## 10. Dotčené obrazovky a endpointy

| Obrazovka (admin.html) | Změna |
|---|---|
| Prodejna → pokladna | beze změny ovládání; zápis platby proběhne na serveru |
| E-shop → detail objednávky | tlačítko „Přijmout platbu“, seznam plateb objednávky, upozornění u ručního „zaplaceno“ |
| Prodejna → Vratky / Výměna | způsob vrácení povinný u nových vratek (už je), zápis platby |
| Dárkové poukazy (vydání, nabití, připsání, dar, zrušení) | zápis platby; dar a zrušení přes opravu místo mazání |
| Reporty → Kontrola plateb | nový přehled (jen čtení) |
| Detail prodeje / účtenky | seznam navázaných plateb a oprav |

| Endpoint | Změna |
|---|---|
| `POST /api/prodejna`, `/vratky`, `/vymeny`, `/vymeny/prevest`, `PUT`/`DELETE /api/prodejna/:id` | zápis / oprava v `platby` |
| `POST /api/poukazy`, `/pouzit`, `/:id/pripsat`, `PATCH /:id/dar`, `DELETE /:id` | zápis / oprava; `klic` u vydání |
| `POST /api/objednavky` (online poukaz), `PATCH /:id/stav` (zrušení vrací čerpání) | zápis / oprava |
| **nový** `POST /api/objednavky/:id/platby`, `GET /api/objednavky/:id/platby` | osobní odběr |
| **nový** `GET /api/platby?od&do&zdroj`, `GET /api/platby/kontrola?od&do` | přehled a kontrola (admin) |

## Zdroje (oficiální)

- Popis položek datové zprávy EET 2.0, verze 1.0 z 5. 10. 2026 – kap. 1 (UUID), 3 (první zaslání),
  10 (pořadové číslo), 12 (celková částka, doplatky), 13–14 (nabití a čerpání, příklady 1–4),
  4 Storno a oprava (příklady 1–3): <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_polozek_datove_zpravy.pdf>
- Popis datového rozhraní v1.2 z 25. 8. 2026 – kap. 2.2 (kritické a propustné kontroly),
  4 (jednoznačný kód tržby): <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_rozhrani_v1.2.pdf>
- XSD schéma v4.1: <https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EETXMLSchema.xsd>
- Chyby a jejich řešení (48 h po výpadku): <https://eet.gov.cz/cs/zacinam-s-eet/chyby-a-jejich-reseni>
- EET OFF: <https://eet.gov.cz/cs/eet-off/co-je-rezim-eet-off>
- Harmonogram: <https://eet.gov.cz/cs/o-eet/jaky-je-harmonogram-eet-2-0>
