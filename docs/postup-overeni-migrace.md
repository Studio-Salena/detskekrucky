# Ověření migrace na kopii produkční databáze (před nasazením kroků 2 a 3)

Cíl: obnovitelná záloha produkce a zkušební migrace na izolované kopii. Bez produkčních
e-mailů a externích operací a s porovnáním účetních součtů před a po.

> **Stav (18. 11. 2026): PROVEDENO na skutečné kopii produkce – OVĚŘENÍ PROŠLO** (commit `ae46cf3`).
> Výsledek je v oddílu **„Výsledek na kopii produkce (2026-11-18)“** níže. Před nasazením se ověření
> opakuje, pokud přibude kód. Postup pro spuštění na jiném počítači je v oddílu
> „Co spustit a co předat“.

## 0. Předpoklady

- PostgreSQL klient stejné nebo novější verze, než má server na Forpsi (`pg_dump --version`).
- Lokální PostgreSQL (nebo jiný izolovaný stroj) pro kopii. Kopie **nesmí** být dostupná
  aplikaci na Renderu ani nikomu dalšímu.
- Produkční URL zadávejte jen do proměnné v aktuální relaci terminálu, nikdy do souboru
  v repozitáři. Záloha obsahuje osobní údaje zákazníků: ukládejte ji jen na šifrovaný disk.
  Záloha jen pro ověření se po ověření smaže; **záloha těsně před nasazením se uchovává** (krok 5).

## 1. Záloha produkce (jen čtení)

PowerShell:

```powershell
$env:PROD_DB_URL = "postgres://…"          # z Renderu, jen pro tuto relaci
$datum = Get-Date -Format yyyyMMdd
pg_dump --format=custom --no-owner --no-privileges --file "zaloha-prod-$datum.dump" $env:PROD_DB_URL
pg_restore --list "zaloha-prod-$datum.dump" | Select-String "TABLE DATA" | Measure-Object   # kontrola obsahu
Remove-Item Env:PROD_DB_URL
```

`pg_dump` jen čte (jedna konzistentní transakce) a produkci nemění. Zapište SHA-256
(`Get-FileHash -Algorithm SHA256`) a čas. Otisk jen ověřuje soubor – databázi obnoví jen
samotná záloha.

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
- smaže proměnné Resend, Cloudinary, dopravců, Stripe a **EET** a podstrčí modul e-mailů,
  takže nic neodejde (počet pokusů o e-mail je ve zprávě a musí být 0),
- zablokuje HTTP/HTTPS a `fetch`: každý pokus o síťové spojení se zapíše do `pokusy_o_sit`
  a ověření selže (k databázi se jde přímo přes lokální socket, ne přes HTTP),
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
- `eet_po_migraci`: všude 0 (`eet_udalosti`, `eet_udalosti_radky`, `eet_pokusy`, `eet_provoz`).
  Migrace EET nezapíná a historii zpětně neeviduje,
- `eet_triggery` obsahuje `eet_udalosti_nemenna`, `eet_udalosti_vznik`, `eet_provoz_nemenny`, `eet_pokusy_jednou`,
- `pokusy_o_sit: []`,
- `migrace[].chyby` prázdné. Na úplné kopii produkce tam nesmí být nic. V simulaci se objevily
  jen chyby tabulek, které simulace neměla (`kategorie`, `zakaznici.heslo`).

## 4. Úklid kopie

```powershell
dropdb -h localhost -U postgres "dk_kopie_$datum"
```

Zálohu pořízenou těsně před nasazením **nemažte ani po úspěšném nasazení** (krok 5).

## 5. Nasazení a návrat

1. Těsně před nasazením nová záloha (krok 1), SHA-256 a čas zapsat. Zálohu uchovat šifrovaně
   mimo repozitář a mimo vývojový počítač aspoň na dvou místech, nejméně do další ověřené zálohy
   po uzavření měsíce – i po úspěšném nasazení.
2. Nasazení (push do `main` → Render). Migrace jsou idempotentní a doklady nemění.
3. Hned po nasazení: v prodejně obnovit administraci (Ctrl+F5), v Účetnictví spustit
   🔎 Kontrola plateb (v rozsahu 0 rozdílů) a porovnat součty Účetnictví s hodnotami z kroku 3.
4. **Návrat kódu na `98593ee` se po prvním zápisu nové verze neprovádí** (ověřeno 18. 11. 2026,
   `docs/nasazeni-eet.md`, oddíl A3). Při problému zastavit dotčené operace a opravit novou verzi.
5. **Obnova zálohy** jen při poškození dat a jen podle `docs/nasazeni-eet.md`, oddíl A4. Export
   EET sám nestačí, zachovat a sladit se musí všechny novější operace.

## Výsledek na kopii produkce (2026-11-18)

- **Záloha:** `pg_dump --format=custom --serializable-deferrable` v relaci jen pro čtení
  (`default_transaction_read_only=on`). Server PostgreSQL 17.10 (primární). Čas 12:44:52–12:44:55 UTC,
  318 064 B, **SHA-256 `322aa1dc2219a05667889ee8d5786c51f01a6655c1553791fc5bb66786f45bc2`**.
  Produkční data se nezměnila.
- **Totožnost:** 1058 produktů na e-shopu = 1058 ve veřejném API. V produkci běží `98593ee`
  (před krokem 2 – tabulky evidence plateb a EET neexistovaly).
- **Obnova:** `pg_restore --exit-on-error` do místní izolované DB (PostgreSQL 18). 38 tabulek,
  38 položek TABLE DATA, **počty řádků všech 38 tabulek shodné s produkcí**.
- **Ověření** `node scripts/overeni-migrace.js` z commitu `ae46cf3` (čistý strom): **OVĚŘENÍ PROŠLO**, kód 0.
  - obsah dosavadních finančních sloupců beze změny (prodeje, vratky, objednávky, poukazy,
    použití poukazů, sklad, pohyby skladu, faktury, slevové kódy, karty),
  - **účetní součty shodné:** e-shop 1179, prodejna 382 650 (hotově 128 607 / kartou 136 376 /
    QR 117 667), vratky 3647 Kč, poukazem 0,
  - **zůstatky poukazů beze změny:** 6 poukazů, všechny `historicky`, aktivní 5 se zůstatkem
    3000 Kč, použitý 1, uplatněno 500 Kč,
  - 0 nových plateb, pohybů kreditu, vkladů a klíčů pokladny. Historie se nedoplnila,
  - **EET vypnuté:** `eet_udalosti`, `eet_udalosti_radky`, `eet_pokusy`, `eet_provoz` = 0,
    4 ochranné triggery založené,
  - e-maily 0, síťová spojení 0 (proměnné e-mailů, dopravců, Cloudinary a EET smazané,
    HTTP(S)/`fetch` zablokované), chyby migrací 0 (dvě kola),
  - kontrola evidence: v rozsahu 0. Mimo rozsah (starší doklady, nespárované) 303 prodejů,
    3 vratky, 6 poukazů.
- Zpráva JSON (bez osobních údajů) a záloha zůstaly jen v dočasné složce mimo repozitář a byly
  po ověření smazány. Záloha pro nasazení se dělá znovu těsně před ním.

## Co spustit a co předat (na jiném počítači)

Spouští majitelka nebo správce s přístupem k produkční DB, na vlastním počítači s lokálním
PostgreSQL (≥ verze serveru na Forpsi). Příkazy jednotlivě v PowerShellu, ve složce
`C:\projekty\detskekrucky`, na větvi s krokem 3 (`git log -1` = commit kroku 3b nebo novější).
Pokud produkční PostgreSQL na Forpsi nepřijímá spojení zvenku, spusťte `pg_dump` přímo na VPS
(přes SSH) a soubor `.dump` stáhněte (`scp`).

```powershell
$datum = Get-Date -Format yyyyMMdd
$env:PROD_DB_URL = "postgres://…"            # jen pro tuto relaci, nikam neukládat
pg_dump --format=custom --no-owner --no-privileges --file "zaloha-prod-$datum.dump" $env:PROD_DB_URL
Remove-Item Env:PROD_DB_URL
createdb -h localhost -U postgres "dk_kopie_$datum"
pg_restore -h localhost -U postgres --no-owner --no-privileges --exit-on-error -d "dk_kopie_$datum" "zaloha-prod-$datum.dump"
Get-ChildItem Env: | Where-Object { $_.Name -match '^(EET|RESEND|CLOUDINARY|ZASILKOVNA|GLS|PPL|STRIPE)' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
node scripts/overeni-migrace.js "postgres://postgres@localhost:5432/dk_kopie_$datum" "zprava-$datum.json"
```

(Předposlední řádek je pojistka navíc. Skript tyto proměnné maže sám a síť blokuje.)

**Předat:**
1. Celý výstup z terminálu posledního příkazu. První řádek je `OVĚŘENÍ PROŠLO` nebo `OVĚŘENÍ SELHALO`.
2. Soubor `zprava-$datum.json`. Obsahuje jen počty, součty a názvy tabulek, osobní údaje ne.
   Přesto ho posílejte jen napřímo.
3. Výstup `pg_restore --list "zaloha-prod-$datum.dump" | Select-String "TABLE DATA" | Measure-Object`
   (kontrola úplnosti zálohy).

Záloha `zaloha-prod-*.dump` obsahuje osobní údaje zákazníků. Nepředávat, uložit na šifrovaný disk.
Ověřovací zálohu po ověření smazat, zálohu před nasazením uchovat (krok 5). Kopii po ověření smazat (`dropdb -h localhost -U postgres "dk_kopie_$datum"`).

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
