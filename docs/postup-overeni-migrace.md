# Ověření migrace na kopii produkční databáze (před nasazením kroku 2)

Cíl: obnovitelná záloha produkce a zkušební migrace na izolované kopii. Bez produkčních
e-mailů a externích operací a s porovnáním účetních součtů před a po.

> **Stav:** postup je připravený a celý vyzkoušený na simulované „staré produkci“ (databáze
> vytvořená kódem z `7248d04` a naplněná jeho API). **Na skutečné kopii produkce zatím
> neproveden** – vyžaduje přístup k produkční databázi, který vývojové prostředí nemá.

## 0. Předpoklady

- PostgreSQL klient stejné nebo novější verze, než má server na Forpsi (`pg_dump --version`).
- Lokální PostgreSQL (nebo jiný izolovaný stroj) pro kopii. Kopie **nesmí** být dostupná
  aplikaci na Renderu ani nikomu dalšímu.
- Produkční URL zadávejte jen do proměnné v aktuální relaci terminálu, nikdy do souboru
  v repozitáři. Záloha obsahuje osobní údaje zákazníků: ukládejte ji jen na šifrovaný disk
  a po ověření ji smažte.

## 1. Záloha produkce (jen čtení)

PowerShell:

```powershell
$env:PROD_DB_URL = "postgres://…"          # z Renderu, jen pro tuto relaci
$datum = Get-Date -Format yyyyMMdd
pg_dump --format=custom --no-owner --no-privileges --file "zaloha-prod-$datum.dump" $env:PROD_DB_URL
pg_restore --list "zaloha-prod-$datum.dump" | Select-String "TABLE DATA" | Measure-Object   # kontrola obsahu
Remove-Item Env:PROD_DB_URL
```

`pg_dump` jen čte (jedna konzistentní transakce) a produkci nemění. Zálohu si ponechte jako
návratový bod pro nasazení (krok 5).

## 2. Obnova do izolované kopie

```powershell
createdb -h localhost -U postgres "dk_kopie_$datum"
pg_restore -h localhost -U postgres --no-owner --no-privileges --exit-on-error -d "dk_kopie_$datum" "zaloha-prod-$datum.dump"
```

Název databáze musí obsahovat `kopie`. Ověřovací skript jinou databázi odmítne.

## 3. Zkušební migrace a porovnání

```powershell
node scripts/overeni-migrace.js "postgres://postgres@localhost:5432/dk_kopie_$datum" "zprava-$datum.json"
```

Co skript dělá:
- spustí jen proti lokální databázi s „kopie/test/sim“ v názvu a jinou než `DATABASE_URL`,
- smaže proměnné Resend, Cloudinary, dopravců a Stripe a podstrčí modul e-mailů,
  takže nic neodejde (počet pokusů o e-mail je ve zprávě a musí být 0),
- udělá snímek: otisk obsahu **dosavadních** sloupců finančních tabulek a součty jako
  v Účetnictví a uzávěrkách,
- spustí všechny startovní migrace aplikace dvakrát (jako dva restarty) a snímek zopakuje,
- vypíše kontrolu evidence: doklady **mimo rozsah** (starší bez evidence) zvlášť. Nejsou
  tím spárované, jen se nekontrolují a nic se jim nedopočítává.

**Verdikt je první řádek výstupu** a určuje návratový kód:
- `OVĚŘENÍ PROŠLO` = kód 0,
- `OVĚŘENÍ SELHALO` = kód 1. Selže to při každé z těchto chyb a ty se vypíšou pod verdiktem:
  - chybí povinná tabulka (`prodejna_prodeje`, `vratky`, `objednavky`, `objednavky_polozky`, `darkove_poukazy`, `poukazy_pouziti`, `sklad`, `pohyby_skladu`),
  - po migraci chybí tabulka evidence,
  - chyba dotazu nebo migrace,
  - rozdíl v datech nebo součtech,
  - pokus o e-mail,
  - doplněné platby,
  - rozdíl v kontrole evidence.

Volitelné tabulky (`faktury`, `promo_pouziti`, `poukazove_karty`, `nakupni_faktury`) se porovnají, jen když existují.

Očekávaný výsledek:
- `zmeny: []` a `soucty_shodne: true`,
- `nove_tabulky_radky.platby = 0`, `kredit_vklady = 0` (historie se nedoplňuje),
  `prodejna_klice` = počet prodejů s klíčem,
- `poukazy_podle_stavu_platby`: všechny dosavadní poukazy `historicky`, stav beze změny
  (nejsou zablokované),
- `kontrola_evidence.v_rozsahu` všude 0 a `mimo_rozsah` = počty dosavadních dokladů,
- `odeslane_emaily: []`,
- `migrace[].chyby` prázdné. Na úplné kopii produkce tam nesmí být nic. V simulaci se objevily
  jen chyby tabulek, které simulace neměla (`kategorie`, `zakaznici.heslo`).

## 4. Úklid kopie

```powershell
dropdb -h localhost -U postgres "dk_kopie_$datum"
```

Zálohu `zaloha-prod-*.dump` nechte do úspěšného nasazení, potom ji bezpečně smažte.

## 5. Nasazení a návrat

1. Těsně před nasazením nová záloha (krok 1).
2. Nasazení (push do `main` → Render). Migrace jsou idempotentní a doklady nemění.
3. Hned po nasazení: v prodejně obnovit administraci (Ctrl+F5), v Účetnictví spustit
   🔎 Kontrola plateb (v rozsahu 0 rozdílů) a porovnat součty Účetnictví s hodnotami z kroku 3.
4. **Návrat kódu:** předchozí verze nové tabulky ignoruje a doklady mají původní tvar.
   Stačí nasadit předchozí commit. Poukazy, které mezitím čekaly na platbu
   (`stav = 'ceka_na_platbu'`), by stará verze zobrazila, ale nepoužila. Před návratem je
   zaplaťte, nebo zrušte.
5. **Návrat dat** (jen při poškození): obnovit zálohu z bodu 1 do nové databáze a přepnout
   `DATABASE_URL`. Ztratí se tím vše zapsané po záloze, proto jen jako poslední možnost.

## Výsledek simulace (2026-11-17)

Lokální PostgreSQL 18, databáze naplněná kódem z `7248d04`. Obsahovala 5 prodejů (hotově,
kartou, poukazem s doplatkem, výměnu), 3 poukazy (prodaný, darovaný, z e-shopu bez platby),
2 objednávky osobního odběru (jednu označenou postaru jako zaplacenou) a 2 vratky.
Záloha `pg_dump -Fc` → obnova do `dk_kopie_sim_obnova` → `overeni-migrace.js`:

- obsah dosavadních sloupců beze změny, účetní součty shodné
  (e-shop 2000, prodejna 4400, vratky 800),
- 0 plateb, 0 vkladů kreditu, 3 klíče pokladny převedené,
- všechny 3 poukazy `historicky` a stav beze změny (poukaz z e-shopu bez platby
  zůstal použitelný),
- kontrola: v rozsahu 0, mimo rozsah 5 prodejů, 2 vratky, 3 poukazy, rozdíly žádné,
- e-maily 0,
- chyby migrace jen kvůli neúplnému schématu simulace (viz výše).
