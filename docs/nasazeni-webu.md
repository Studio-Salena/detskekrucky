# Nasazení webu (GitHub Pages) a návrat

Platí od commitu `cd5e75e` (SEO 2.0). Na web jde jen čistý `_site/` z výslovného seznamu
`scripts/web/verejne-soubory.js`, sestavený a zkontrolovaný skriptem
`scripts/web/sestavit-web.js` ve workflow `.github/workflows/static.yml`.

**Zásada:** omezený publikační workflow se nikdy nevrací. Opravuje se dopředu, nebo se vrací
jen veřejný obsah. Zakázané kroky (oba by znovu publikovaly celý repozitář včetně `CLAUDE.md`,
`docs/`, `lib/`, `deploy/`):

- **Re-run** běhu workflow z doby před `cd5e75e`. Re-run spouští starou verzi workflow.
- `git revert cd5e75e` nebo jakékoli vrácení `static.yml` na `path: '.'`.

## Push do `main` restartuje i backend

Render nasazuje backend automaticky po každém pushi do `main`, i když se backend nezměnil.
Nasazení znamená restart:

- server je asi 1–3 minuty nedostupný a při startu znovu proběhnou idempotentní migrace
  (`lib/startServeru.js`),
- e-shop během restartu nenačte katalog a neodešle objednávku,
- pokladna neuloží prodej. Odeslaný prodej bez odpovědi zůstane v prohlížeči (`dkNedokoncenyProdej`)
  a pokladna po obnovení nabídne „Dokončit uložení“ se stejným klíčem.

Proto pushovat **mimo otevírací dobu prodejny** (po zavření, večer) a po pushi ověřit backend
(níže). Jestli má Render nastavené filtry, které by restart u čistě webových změn přeskočily,
není ověřené. Počítejte s restartem.

## Nasazení (příkazy po jednom, PowerShell)

1. Ověřit vzdálený `main`:
   - `git fetch origin`
   - `git rev-parse origin/main` = očekávaný commit, ze kterého větev vychází.
     Je-li jiný, **nepushovat**: projít nové commity (`git log --oneline <větev>..origin/main`)
     a větev připravit znovu (nová větev z `origin/main` a commity na ni přenést).
   - `git log --oneline origin/main..<větev>` = jen commity, které se mají nasadit.
2. Na větvi pustit kontroly:
   - `node --test`
   - `node scripts/web/sestavit-web.js` (musí skončit „✔ Kontroly prošly“), pak smazat `_site`.
3. Push jako fast-forward, bez force: `git push origin <větev>:main`.
   Git odmítne cokoli jiného než fast-forward. Pak se `--force` nepoužívá a postupuje se podle bodu 1.
4. Kontrola po nasazení:
   - **GitHub → Actions:** běh „Deploy static content to Pages“ je zelený. Když skončí chybou,
     web zůstal beze změny. Chyba v logu říká, který soubor chybí nebo je navíc.
   - **Web:** `/CLAUDE.md`, `/lib/evidencePlateb.js`, `/package.json` a `/docs/eet-krok3.md`
     vracejí 404. Úvod, e-shop, `/admin.html` (přihlašovací obrazovka), `/stromecek/#nahled`,
     `/sitemap.xml` a `/robots.txt` fungují.
   - **Render:** služba je „Live“ a v logu migrace bez chyby, `GET /api/promo/info/KRUCKY2026`
     vrací 200, e-shop načte katalog. V adminu Účetnictví → Kontrola plateb ukazuje stejný
     stav jako před pushem.

## Návrat

| Situace | Postup | Celý repozitář na web? |
| --- | --- | --- |
| Chyba v obsahu stránky (text, obrázek, skript) | `git revert <commit s obsahem>` a push. Workflow zůstává omezený | ne |
| Rychlý návrat veřejného obsahu bez změny gitu | GitHub → Actions → „Deploy static content to Pages“ → **Run workflow** → `obsah_z` = commit nebo tag posledního dobrého obsahu. Obsah se vezme z něj, ale sestaví se dnešním seznamem a dnešními kontrolami | ne |
| Sestavení selhává (chybí soubor v seznamu, nový obrázek) | Nic nespěchá, web zůstal na poslední verzi. Opravit seznam v `scripts/web/verejne-soubory.js` a pushnout | ne |
| Re-run běhu z doby po `cd5e75e` | Povolený, spouští omezený workflow | ne |

Návrat přes `obsah_z` sestaví obsah staršího commitu jen tehdy, když v něm jsou všechny dnes
povolené soubory a jeho odkazy vedou na existující soubory. Jinak běh skončí chybou a web
zůstane, jak je. Vyzkoušeno nanečisto 24. 11. 2026 s obsahem `767ceae`: 27 souborů, kontroly prošly.

Pozor: `obsah_z` vrací **jen web**. Backend na Renderu nevrací. Ten běží z `main` a vrací se
revertem a pushem (u verzí kolem EET platí omezení v `docs/nasazeni-eet.md`).

## Pozdější začlenění dohledu záloh (lokální `main`, commity e305b34, 82eff41, a962449)

Lokální `main` obsahuje tři nepushnuté commity: `e305b34` (dohled záloh), `82eff41` (jeho
sloučení) a `a962449` (dokumentace stavu nasazení). Začleňují se **až po nasazení SEO 2.0**.
Jinak by se `deploy/zalohy/` dostaly na web starým workflow. Explicitně, bez `git pull`:

1. `git fetch origin`
2. `git rev-parse origin/main`: musí to být poslední nasazený commit SEO 2.0.
3. `git switch main`
4. `git log --oneline origin/main..main`: přesně `a962449`, `82eff41`, `e305b34`. Je-li tam něco
   jiného, zastavit.
5. `git merge --no-ff origin/main -m "Merge origin/main (SEO 2.0) into main with backup monitoring"`
   (předem spočítáno 24. 11. 2026 přes `git merge-tree`: bez konfliktu, `CLAUDE.md` se sloučí
   automaticky. Při konfliktu `git merge --abort` a řešit zvlášť)
6. `git diff --stat origin/main main`: jen `deploy/zalohy/`, `docs/zalohy-serveru.md`,
   `docs/nasazeni-eet.md`, `test/zalohy-dohled.test.js`, `.gitattributes`, `CLAUDE.md`.
7. `node --test` a `node scripts/web/sestavit-web.js`: v `_site/` nesmí být `deploy/`
   (kontrola by sestavení zastavila). Pak smazat `_site`.
8. Push na pokyn „nasaď“, mimo otevírací dobu: `git push origin main`. Je to fast-forward, protože
   `main` obsahuje `origin/main`. Render se znovu restartuje. Ověření jako v bodě 4 nasazení.

## Stránky katalogu (SEO krok 2)

Sestavení generuje `/kategorie/<slug>/` a `/produkt/<slug>/` z veřejného exportu
`GET /api/katalog/export` (`routes/katalog.js`, pravidla v `lib/katalogExport.js`, generátor
`scripts/web/katalog.js`). Export vrací jen veřejné údaje: žádné počty kusů, EAN ani klíče
úložiště. Sestavení nepotřebuje žádný tajný údaj.

- **Aktualizace:** workflow běží každou hodinu (`cron: '23 * * * *'`) a ručně (Run workflow).
  Nepushuje do repozitáře a nerestartuje backend. Nasadí jen tehdy, když se obsah webu změnil
  (otisk v `/katalog-verze.json`). Změna ceny, skladu nebo kategorie v adminu se tak na stránky
  dostane nejpozději do hodiny.
- **Stránka produktu po načtení** si dočte aktuální stav (`GET /api/katalog/model/<slug>`)
  a ukáže ho. Nákup probíhá v `eshop.html` z aktuálních dat. Server při objednávce porovná cenu
  a dostupnost, které zákazník viděl. Když se liší, objednávku nezaloží (409) a e-shop košík
  aktualizuje.
- **Dostupnost** se řídí stejnými pravidly jako e-shop: skladem = `InStock`; jen „u dodavatele“
  (objednat jde, dodání 7–14 dní, server objednávku přijme) = `BackOrder`; nic = `OutOfStock`.
- **Selhání:** výpadek API, neplatná odpověď nebo neúspěšná kontrola (neplatná adresa,
  neúplný export, úbytek modelů v nabídce o víc než 20 % nebo kategorií o víc než 2 proti
  minulému nasazení) = běh skončí chybou a **na webu zůstane poslední nasazená verze**. Úmyslný
  velký úbytek (hromadné stažení zboží) se nasadí ručním během se zaškrtnutým „Povolit velký úbytek“.
- **Push v době výpadku Renderu** se nenasadí hned. Nasadí ho první úspěšný hodinový běh,
  protože ten sestavuje aktuální `main`. Pro rychlejší nasazení stačí po obnovení API spustit
  workflow ručně.
- **První nasazení:** backend s `/api/katalog/export` a workflow, které ho volá, jdou stejným
  pushem. Render nasazuje několik minut, takže první běh Pages může skončit „HTTP 404“ (web
  zůstane beze změny). Po „Live“ na Renderu spustit workflow ručně.
- **Plánované běhy** GitHub ve veřejném repozitáři po 60 dnech bez commitu vypne. Pak je potřeba
  je v Actions znovu zapnout. Stáří posledního sestavení je v `/katalog-verze.json` (`sestaveno`).

### Staré adresy produktů a kategorií

| Situace | Adresa `/produkt/<slug>/` | Ve vyhledávání |
| --- | --- | --- |
| V nabídce (skladem nebo u dodavatele) | plná stránka, nákup | ano (po zapnutí indexování) |
| Vyprodaný, Monča ho nestáhla | stránka zůstává: „Momentálně vyprodáno“, bez nákupu, dotaz e-mailem, odkaz na kategorii, `OutOfStock` | ano, s pravdivým stavem |
| Stažený z e-shopu (`na_eshopu` vypnuté u všech velikostí) | stránka se při dalším sestavení odstraní → **HTTP 404**. Stránka 404 nabídne „Najít podobné boty“ (hledání podle slov z adresy) | vypadne |
| Odstraněný z databáze | jako stažený: 404 s nabídkou hledání | vypadne |
| Sloučený do jiného modelu | přesměrování na cílový model (okamžitý `meta refresh` + canonical, tabulka `modely_presmerovani`) | nahradí ho cílový model |
| Znovu zveřejněný | stejná adresa se vrátí (slug modelu se nemění) | znovu ano |
| Kategorie odstraněná | 404 s odkazem na e-shop | vypadne |

Staré adresy se **nepřesměrovávají hromadně na úvod e-shopu**. Skutečná 404 je pro vyhledávače
čistší než „soft 404“. Staré odkazy `eshop.html?produkt=…` a `?kategorie=…` fungují dál.

### Adresa kategorie

Slug kategorie je po založení zamčený. Přejmenování v adminu adresu nemění a server slug při
úpravě nikdy nepřepíše. Změna adresy je samostatný zásah, ne běžná úprava:

1. Přidat přesměrování ze staré adresy (stránka `/kategorie/<stary>/` s `meta refresh`, obdobně
   jako u modelů) a ve filtrech e-shopu převádět `?kategorie=<stary>`.
2. Ve stejné transakci změnit `kategorie.slug`, `modely.kategorie` a `produkty.kategorie`.
3. Nasadit a ověřit, že stará adresa vede na novou.

### Zkušební provoz a zapnutí

Zatím `INDEXOVAT = false` (`scripts/web/katalog.js`). Stránky mají `noindex`, nejsou v sitemap
a web na ně neodkazuje. Zapnutí je samostatný commit: `INDEXOVAT = true`, odkazy z karet e-shopu
a dlaždic na úvodu a canonical v e-shopu. Pak v Search Console znovu odeslat sitemap.
