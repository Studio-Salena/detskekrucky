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
- `routes/sklad.js` – sklad po variantách (EAN, velikost, kusy, min. stav, pohyby)
- `routes/modely.js`, `lib/modely.js` – modely bot (`modely`, `produkty.model_id`): katalog, vlastnosti, filtry
- `routes/doprava.js`, `lib/doprava.js` – způsoby dopravy a ceny (`nastaveni.doprava`, admin Nastavení → Doprava); cenu vždy počítá server
- `lib/zasilkovna.js` – výběr výdejního místa (widget Packeta, env `ZASILKOVNA_API_KLIC` – veřejný klíč, 16 znaků)
- `lib/zasilkovnaApi.js` – podání zásilky + štítek PDF (XML API, env `ZASILKOVNA_API_HESLO` – tajné, 32 znaků; jen na klik v adminu)
- `lib/gls.js`, `lib/glsVydejniMista.js` – GLS připravené, ale VYPNUTÉ (bez ceny se zákazníkům nenabízí, MyGLS API se nevolá)
- `lib/nakupniFaktury.js`, `routes/nakupniFaktury.js` – nákupní faktury v Účetnictví
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
- Průvodce velikostí: na stránce boty doporučení podle délky nožičky (vnitřní délka ≥ nožička + rezerva, výchozí 12 mm v nastavení katalogu `rezervaMm`), filtr `?noha=` v katalogu (rezerva až +10 mm); rozměry velikostí se zadávají v adminu v detailu produktu (PUT /api/modely/:id/rozmery)

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
- GLS: až bude smluvní ceník a přístupy k MyGLS
