# Dětské krůčky – e-shop a web

Web a e-shop pro obchod s barefoot obuví pro děti (majitelka: Monika Škarpichová, Hulín).

## Stack

- **Backend:** Node.js / Express, entry point `index.js`
- **Frontend:** statický web (`index.html`), GitHub Pages (`hasalovaalena-glitch/detskekrucky`)
- **Databáze:** self-hosted PostgreSQL na Forpsi VPS (produkční DB není Supabase)
- **Hosting backendu:** Render – `detskekrucky1.onrender.com`
- **Storage:** Supabase Storage bucket `produkty` (obrázky produktů)
- **Lokální cesta:** `C:\projekty\detskekrucky\`
- **Prostředí:** Windows, VS Code, PowerShell – git příkazy se zadávají jednotlivě, ne řetězené

## Struktura / klíčové soubory

- `index.js` – hlavní backend entry point
- `routes/sklad.js` – správa skladu/produktů
- `admin.html` – admin panel (heslo je v proměnné prostředí `ADMIN_HESLO` na Renderu, není v repozitáři)
- `index.html` – veřejný web, dynamický obsah se načítá přes fetch
- Tabulka `nastaveni` (JSONB) – ukládá editovatelné texty webu (`textyWebu`, sekce `procBarefoot`, `vyberteSi`)
- `rezervace_sloty`, `rezervace` – rezervační systém (sloty + rezervace, admin přehled)

## Hotové funkce

- Správa produktů a skladu
- Editovatelné textové sekce webu s persistencí v Supabase
- Dynamické načítání obsahu na `index.html`
- Upload obrázků do Supabase Storage
- Rezervační systém pro zákazníky se správou slotů
- Emailové potvrzení rezervace zákazníkovi (přes Resend, `routes/emaily.js` → `odeslat_potvrzeni_rezervace`)

## Známé problémy a jejich řešení

- Datum se mezi frontend/backend liší formátem (ISO vs. `YYYY-MM-DD`) → řešeno pomocí `.slice(0, 10)`
- Historicky opraveny: SyntaxError v `routes/sklad.js`, duplicitní deklarace v `index.js`

## Konvence

- Ája (vývojářka) je uvedená v patičce webu jako tvůrce stránek – neodstraňovat
- Git příkazy zadávat jednotlivě (uživatel je na PowerShellu, preferuje krokovat postupně)
- Při práci s Supabase pozor na RLS politiky – dřív způsobily problém s oprávněními po `DROP SCHEMA public CASCADE` (řešeno explicitními granty)

## Co dál (typické priority)

Doplň sem aktuální prioritu, na které pracuješ, ať to Claude Code hned vidí na začátku session.
