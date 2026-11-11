# Dětské krůčky – e-shop a web

Web a e-shop pro obchod s barefoot obuví pro děti (majitelka: Monika Škarpichová, Hulín). Živě na https://www.detskekrucky.cz.

## Stack

- **Backend:** Node.js / Express, entry point `index.js`, na Renderu – `detskekrucky1.onrender.com` (deploy automaticky po pushi do `main`)
- **Frontend:** statické stránky `index.html` (web), `eshop.html` (e-shop), `admin.html` (administrace), právní stránky (`obchodni-podminky.html`, `odstoupeni-od-smlouvy.html`, `reklamacni-rad.html`); GitHub Pages z repa `Studio-Salena/detskekrucky`, doména u Forpsi
- **Databáze:** vlastní PostgreSQL na Forpsi VPS (env `DATABASE_URL`, `db/pool.js`). Už to NENÍ Supabase. Tabulky a sloupce zakládají idempotentní migrace při startu serveru (`lib/startServeru.js`, `pripravit()` v routách) – musí jít spustit opakovaně.
- **Storage:** Cloudinary (`lib/cloudinary.js`, klíče v env na Renderu) – fotky produktů (`routes/produktyImages.js`, tabulka `product_images`), obrázky dlaždic kategorií (`routes/kategorie.js`, sloupce `obrazek_url`/`obrazek_key`) a dlaždice Dárkové poukazy (`routes/poukazDlazdice.js`, `nastaveni.poukazDlazdice`, výchozí `poukaz-dlazdice.png`). Kontrola nahrávaných souborů je sdílená v `lib/overeniObrazku.js`. Legacy produkty mají externí URL v `produkty.emoji`.
- **E-maily:** Resend (`routes/emaily.js`) – potvrzení objednávky (obsahuje i VOP a poučení o odstoupení), změny stavu, rezervace, poradna
- **Lokální cesta:** `C:\projekty\detskekrucky\`
- **Prostředí:** Windows, VS Code, PowerShell – git příkazy se zadávají jednotlivě, ne řetězené

## Struktura / klíčové soubory

- `index.js` – hlavní backend entry point (registrace rout `/api/...`)
- `routes/objednavky.js` – objednávky z e-shopu (sklad se odečítá při objednání, vrací se při zrušení; smazat jde jen zrušenou), podání do Zásilkovny a štítek
- `routes/prodejna.js` (pokladna, vratky), `lib/vymena.js` – **výměna zboží** (Prodejna → Vratky → 🔄 Výměna, `POST /api/prodejna/vymeny`): v jedné transakci vratka z původní účtenky + nový prodej se zápočtem (`prodejna_prodeje.vymena_castka`, `celkem` = jen doplatek, platba `vymena` když se nedoplácí). `vratky.castka` = peníze opravdu vrácené zákazníkovi (u výměny rozdíl, často 0), `vratky.zpusob_vraceni` (hotovost/karta/qr/prevod/vymena, NULL = starší vratka bez údaje), `hodnota_zbozi`, `vymena_prodej_id`. Díky tomu sedí součty uzávěrek i účetnictví (prodeje.celkem − vratky.castka) bez dalších úprav; denní a měsíční uzávěrka navíc odečte hotově vrácené peníze („Hotovost v pokladně podle systému“). Dřív zadanou výměnu (vratka + běžný prodej) jde dodatečně převést tlačítkem „🔄 Byla to výměna“ (`POST /api/prodejna/vymeny/prevest`), původní hodnoty se uloží do `prodejna_opravy`. Účtenku výměny nejde smazat
- `routes/sklad.js` – sklad po variantách (EAN, velikost, kusy, min. stav, pohyby)
- `routes/modely.js`, `lib/modely.js` – modely bot (`modely`, `produkty.model_id`): katalog, vlastnosti, filtry
- `routes/doprava.js`, `lib/doprava.js` – způsoby dopravy a ceny (`nastaveni.doprava`, admin Nastavení → Doprava); cenu vždy počítá server
- `lib/zasilkovna.js` – výběr výdejního místa (widget Packeta, env `ZASILKOVNA_API_KLIC` – veřejný klíč, 16 znaků)
- `lib/zasilkovnaApi.js` – podání zásilky + štítek PDF (XML API, env `ZASILKOVNA_API_HESLO` – tajné, 32 znaků; jen na klik v adminu)
- `lib/gls.js`, `lib/glsVydejniMista.js` – GLS: smlouva podepsaná, zákazníkům se nabízí, MyGLS API v ostrém prostředí (env `GLS_*` na Renderu, spojení ověřené 31. 10. 2026); podání a štítek na klik v detailu objednávky
- `lib/nakupniFaktury.js`, `routes/nakupniFaktury.js` – nákupní faktury v Účetnictví
- `lib/faktura.js` (šablona), `lib/vystaveniFaktury.js` – faktury k objednávkám: tabulka `faktury` (snímek + HTML + otisk, trigger zakazuje změnu i smazání), řada RRRRNNN; zrušení objednávky s fakturou vystaví ve stejné transakci opravný doklad (`druh = 'storno'`, řada ODRRRRNNN). Objednávku ani zákazníka s fakturou nejde smazat. Faktury z doby před ukládáním (např. 2026004) jsou „historické“ – tisk jen jako označená rekonstrukce
- `lib/poukazPlatnost.js` – platnost dárkového poukazu (celý poslední den včetně, český čas), e-shop i prodejna
- `lib/poukazKarty.js`, `routes/poukazoveKarty.js` (`/api/poukazove-karty`) – **plastové dárkové karty** (admin Dárkové poukazy → Plastové karty): znovupoužitelný nosič poukazu. Tabulky `poukazove_karty` (číslo K0001, EAN-13 s prefixem 23 nebo vlastní kód výrobce, `aktualni_poukaz_id`, `zablokovana`), `poukazove_karty_udalosti` (historie), `darkove_poukazy.karta_id`; migrace v `routes/poukazy.js`. Nabití = `POST /api/poukazy` s `karta_ean` (libovolná částka 100–50 000 Kč, jinak stejné jako vydání poukazu včetně prodeje do tržeb). Stav karty se neukládá, odvozuje se z poukazu (`stavKarty`): prázdná / nabitá / vyčerpaná, po platnosti, zrušená (= zablokovaná, dokud ji majitelka neodblokuje tlačítkem → zase prázdná) / ručně zablokovaná (ztráta – nejde použít ani kód jejího poukazu; zůstatek jde převést na jinou kartu). Poukaz se všude hledá přes `najitPoukaz()` (kód, EAN poukazu i EAN karty) – pokladna, doplatek, e-shop. Mocky v testech musí znát dotaz `SELECT * FROM poukazove_karty`
- `lib/promo.js`, `routes/promo.js` – slevové kódy akcí (vánoční **KRUCKY2026**: 10 % ze zboží, nákup od 500 Kč, max. 50 uplatnění v e-shopu a prodejně dohromady, platí 29. 11. – 31. 12. 2026, opakované použití stejným zákazníkem povoleno). Pravidla v tabulce `promo_akce` (migrace ji založí jen jednou, úpravy v DB nepřepisuje), použití v `promo_pouziti` (zrušení objednávky / smazání prodeje použití uvolní, řádek zůstává). Strop hlídá zámek řádku akce v transakci nákupu. Sleva jen ze zboží, které není ve slevě (`produkty.cena_pred_slevou`). U objednávky sloupce `promo_kod`, `promo_sleva` – odděleně od dárkového poukazu (`sleva` = způsob platby); celkem = zboží − promo_sleva − poukaz + doprava + příplatek (faktura, e-maily, kontrola částek). Pokladna: volba „Slevový kód“, prodej se kódem ukládá server před odečtem skladu; nejde kombinovat s doplatkem k poukazu. Vypínač: env `PROMO_AKTIVNI=false` na Renderu (vypne všechny akce). Správa v adminu **E-shop → Slevové akce** (`/api/promo/akce`, za heslem): počet použití, nákupy s kódem, prodloužení (počet slev, poslední den včetně), vypnutí akce (`promo_akce.aktivni`), historie změn v `promo_zmeny`. Stránka stromečku bere „platí do“ a počet slev z veřejného `GET /api/promo/info/:kod`
- `stromecek/index.html` – stránka z QR kódu u vánočního stromečku na náměstí (kód KRUCKY2026, hlasování v soutěži). Do 29. 11. 2026 se sama skrývá („Brzy tu bude překvapení“), náhled přes `#nahled`
- `navstevnost.js` (na veřejných stránkách), `lib/navstevnost.js`, `routes/navstevnost.js` – návštěvnost bez cookies (admin Reporty → Návštěvnost): tabulka `navstevy` bez IP, návštěvník = otisk se solí platnou jeden den (`navstevnost_sul`), roboti a prohlížeč přihlášené majitelky (localStorage `dkNepocitatNavstevy`) se nepočítají
- `admin.html` – administrace (heslo v env `ADMIN_HESLO` na Renderu, není v repozitáři); stránky přes `showPage(stranka, el, pohled)`, záložky přes `data-pohled`
- Tabulka `nastaveni` (JSONB) – editovatelné texty webu (`textyWebu`, `procBarefoot`, `vyberteSi`), doprava, katalog
- `rezervace_sloty`, `rezervace` – rezervační systém
- `zasilky` – zásilky u dopravců (vazba na objednávku s ON DELETE CASCADE)

## Hotové funkce

- E-shop: katalog podle modelů s filtry, detail produktu, košík, objednávka ve 3 krocích, platba převodem s QR (VS = číslo objednávky), osobní odběr s platbou na prodejně, dárkové poukazy
- Doprava: Zásilkovna s výběrem výdejního místa (79 Kč), GLS výdejní místo 69 Kč / na adresu 119 Kč (zapíná majitelka v adminu), Česká pošta (89 Kč, nechat, i když se nepoužívá), osobní odběr; zdarma od 2 000 Kč
- Platba: převod s QR, dobírka s příplatkem z nastavení dopravy (40 Kč, ne u osobního odběru, sloupec `objednavky.platba_priplatek`), na prodejně jen u osobního odběru
- Administrace (hnědá, barvy webu): Přehled, E-shop (objednávky, zákazníci, vrácení, poukazy), Prodejna (pokladna/POS), Sklad, Sortiment (katalog), Rezervace, Reporty a Účetnictví, Web (texty), Nastavení (otevírací doba, doprava, systém)
- Rezervační systém se správou slotů a e-mailovým potvrzením
- Průvodce velikostí: na stránce boty doporučení podle délky nožičky – nadměrek = vnitřní délka − nožička, musí být aspoň nadměrek z nastavení (výchozí 12 mm v nastavení katalogu `rezervaMm`, model může mít vlastní `modely.nadmerek_mm`); doporučí nejmenší velikost s tímto nadměrkem, menší jsou „malá“. Filtr `?noha=` v katalogu bere nadměrek až o 10 mm větší (`NOHA_ROZPETI`); rozměry velikostí se zadávají v adminu v detailu produktu (PUT /api/modely/:id/rozmery)

## Testy

- `node --test` (unit testy v `test/`); testy proti PostgreSQL běží jen s `TEST_PG_URL` (dočasná testovací DB, nikdy produkce)
- `test/skripty-syntaxe.test.js` hlídá, že všechny vložené skripty v HTML jdou zkompilovat

## Známé problémy a jejich řešení

- Datum se mezi frontend/backend liší formátem (ISO vs. `YYYY-MM-DD`) → řešeno pomocí `.slice(0, 10)`
- Historicky opraveny: SyntaxError v `routes/sklad.js`, duplicitní deklarace v `index.js`

## Konvence

- Ája (vývojářka) je uvedená v patičce webu jako tvůrce stránek – neodstraňovat
- Git příkazy zadávat jednotlivě (uživatel je na PowerShellu, preferuje krokovat postupně)
- Postup: implementace → testy → ukázat → commit → nasadit (push) až na pokyn „nasaď“
- Přístupové údaje k dopravcům jen v env na Renderu – nikdy do frontendu, HTML, DB objednávek ani logů. GLS neaktivovat bez pokynu.
- „Neplátce DPH“ na fakturách a účtenkách zatím neměnit
- Změny právních textů (formulář objednávky, VOP, e-maily) dělat najednou, aby si odpovídaly

## Co dál (typické priority)

- Doplnit rozměry (mm) u modelů, které je nemají – bez nich průvodce nabízí poradnu
- GLS: ověřit podání zásilky a štítek na první skutečné GLS objednávce
- **E-shop je spuštěný od 31. 10. 2026** (zámek a noindex odstraněny, `eshop-brzy.html` jen přesměrovává na `eshop.html`)
