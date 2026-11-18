# Prohlížečové testy (pokladna a evidence plateb)

Skutečná administrace (`admin.html`) v Chromu proti lokálnímu testovacímu serveru se skutečnými
routami a dočasným schématem testovací databáze. Žádné e-maily ani externí služby. API
produkce se v testu nepoužívá: server servíruje admin s API přesměrovaným na sebe a ostatní
externí adresy jsou zablokované.

Složka se záměrně nejmenuje `test` a soubory nemají koncovku `.test.js`, takže je
`node --test` nespouští (potřebují prohlížeč).

## Spuštění

Předpoklady: Google Chrome, lokální PostgreSQL s testovací databází (název obsahuje `test`
nebo `e2e`) a `playwright-core`. Ten není závislostí projektu:

```powershell
npm install --prefix C:\nastroje\pw playwright-core@1.49.1
$env:PLAYWRIGHT_DIR = "C:\nastroje\pw\node_modules"
$env:TEST_PG_URL = "postgres://postgres@localhost:5432/dk_test"
node prohlizec-testy/spustit.js                 # všechny
node prohlizec-testy/spustit.js pokladna odber  # vybrané
```

Každý test dostane vlastní server a schéma `e2e_…`, které se po testu smaže.

## Scénáře

| Soubor | Co ověřuje |
|---|---|
| `pokladna.js` | běžný prodej, poukaz, poukaz + doplatek, dvojklik, ztracená odpověď, obnovení stránky, požadavek ztracený cestou, **Zahodit** po ztracené odpovědi (uložený prodej se nezahodí, opakované zadání bez potvrzení nic neuloží) |
| `odber.js` | osobní odběr: bez platby nejde Zaplaceno; platba po ztracené odpovědi zapsaná jednou, bez prodeje v pokladně |
| `ucetnictvi.js` | Účetnictví → Platby a dobírky: volná platba, přiřazení k objednávce (ztracená odpověď), k poukazu jen celou hodnotou, vyúčtování dobírky; detail poukazu: zápis platby a **vrácení peněz** s vazbou na původní platbu |
| `stary-admin.js` | staré okno administrace (z `98593ee`) proti novému serveru: odečet skladu i prodej odmítnuté, v databázi se nic nezmění |
| `eet.js` | EET se zapnutou testovací konfigurací a **lokálním** falešným FS (nic po síti): prodej hned potvrzený (POK označený TEST), výpadek EET = prodej uložen jednou a pokladna nevybízí k novému zadání, darovaný kredit „vyžaduje rozhodnutí“, Účetnictví → EET (počty, stáří, detail pokusů, ruční odeslání, rozhodnutí), volná hotovost s povinným účelem |
