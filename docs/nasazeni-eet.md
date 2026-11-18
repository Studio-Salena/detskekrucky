# Nasazení EET – podmínky a návrat

Nasazují se dvě věci, **každá zvlášť a na samostatný pokyn**:

- **A – aplikace s vypnutým EET.** Nový kód běží, EET tabulky se založí prázdné, nic se neeviduje
  ani neodesílá. Bez rizika pro evidenci tržeb.
- **B – zapnutí produkční evidence.** Pozdější krok jen přes proměnné na serveru, nové nasazení
  kódu není potřeba. Od zapnutí platí zákonná povinnost evidovat, takže návrat je omezený (níže).

Stav k 18. 11. 2026: nic z toho neproběhlo. Ověření migrace na kopii produkce je **NEPROVEDENO**
(`docs/postup-overeni-migrace.md`).

---

## A. Nasazení aplikace s vypnutým EET

### Podmínky (všechny musí platit)
1. `node --test` zelené (s `TEST_PG_URL`) a prohlížečové testy `node prohlizec-testy/spustit.js` zelené.
2. **Ověření migrace na kopii produkce PROŠLO.** Výstup `OVĚŘENÍ PROŠLO`, zpráva předaná
   a zkontrolovaná. Zatím neprovedeno.
3. Záloha produkce těsně před nasazením (`pg_dump`, postup v `docs/postup-overeni-migrace.md`, krok 1).
4. Na Renderu **není** nastavené `EET_PROSTREDI` ani žádné `EET_PRODUKCE_*`. Ostatní `EET_*` nevadí,
   bez `EET_PROSTREDI` se nic nespustí.
5. Pokyn „nasaď“ (push do `main` → Render nasadí automaticky).

### Kontrola po nasazení
- Administrace: Ctrl+F5. Účetnictví → EET ukazuje „EET je vypnuté“ a 0 událostí.
- Účetnictví → 🔎 Kontrola plateb: v rozsahu 0 rozdílů. Součty Účetnictví sedí s hodnotami z ověření migrace.
- Běžný prodej v pokladně funguje a v odpovědi není údaj `eet`. Volná platba hotově jde zapsat
  i bez účelu (povinný je jen se zapnutým EET).
- Log Renderu: žádné „EET fronta“ ani „EET dohled“ (bez `EET_PROSTREDI` se nespouštějí).

### Návrat A
- **Kód:** Render → Deploys → *Rollback* na předchozí nasazení (nebo push předchozího commitu do
  `main`). Starší verze nové tabulky `eet_*` ignoruje. Jsou prázdné, nic se nemaže ani nepřepisuje.
- **Data:** nic se nevrací, migrace jsou jen přidávací (nové tabulky a sloupce, triggery). Obnova
  zálohy jen při poškození dat – ztratí se vše zapsané po záloze.
- Nikdy nemazat tabulky `eet_*` ani triggery ručně.

---

## B. Zapnutí produkční evidence (později, samostatné rozhodnutí)

### Podmínky
1. Uzavřená rozhodnutí z `docs/eet-rozhodnuti.md`, minimálně body 1–3 (darovaný a nedoložený
   kredit, klasifikace poukazů). Pravidla v kódu upravená, otestovaná a nasazená fází A.
2. **Produkční identita:**
   - EIČ,
   - číslo evidenční jednotky z DIS+,
   - označení pokladny (1–20 znaků, unikátní v jednotce).
3. **Produkční pokladní certifikát** z CA EET (DIS+ → MOJE daně). PKCS#12 převést na PEM mimo
   repozitář (stejně jako `scripts/eet-playground-certifikaty.js`: `openssl pkcs12 -clcerts -nokeys`
   / `-nocerts -nodes`, případně `-legacy`). Na Render nahrát jako **Secret Files**
   (`/etc/secrets/eet-cert.pem`, `/etc/secrets/eet-klic.pem`). Nikdy do gitu, do proměnné
   s obsahem klíče ani do logu.
4. **Dohled:** `EET_DOHLED_EMAIL` = adresa majitelky. Bez ní jdou upozornění jen do logu serveru,
   kde je nikdo neuvidí.
5. Render nesmí uspávat instanci (placený plán, „always on“). Fronta i dohled běží v serveru.
   První odeslání je přímo v požadavku pokladny, opakování po výpadku ale potřebuje běžící server.
6. Na produkční databázi nikdy nespouštět Playground. Testovací události by se sice nikdy
   neodeslaly do produkce (oddělená prostředí), ale zbytečně by zůstaly v evidenci. Playground
   jen lokálně (`scripts/eet-playground.js`).

### Proměnné na Renderu (najednou, pak restart)
| Proměnná | Hodnota |
|---|---|
| `EET_PROSTREDI` | `produkce` |
| `EET_PRODUKCE_POVOLENA` | `ano` (přesně; jiná hodnota = EET zůstane vypnuté) |
| `EET_PRODUKCE_OD` | počátek evidence s časovou zónou, např. `2027-01-01T00:00:00+01:00` (nejdřív 1. 11. 2026); po prvním startu **neměnný** |
| `EET_EIC`, `EET_ID_PROVOZ`, `EET_ID_POKL` | produkční identita |
| `EET_CERT_PEM`, `EET_KLIC_PEM` (+ `EET_KLIC_HESLO`) | cesty k Secret Files |
| `EET_DOHLED_EMAIL` | příjemci upozornění |
| `EET_TIMEOUT_MS` | volitelně (výchozí 5000, minimum 2000) |

Chybějící nebo nesprávná hodnota znamená, že EET zůstane vypnuté. Admin i dohled pak hlásí důvod
(např. testovací certifikát, chybějící `ano`, jiný počátek než v databázi).

### Kontrola po zapnutí
1. Účetnictví → EET: prostředí `produkce`, EIČ, jednotka, pokladna, platnost certifikátu, počátek evidence.
2. „🔌 Ověřit spojení“ pošle ověřovací zprávu (kód 0) do produkčního EET. Nic se tím neeviduje.
3. První skutečný prodej po počátku evidence: pokladna ukáže POK **bez** „-ff“ a bez označení TEST.
4. První kontrola dohledu dorazí e-mailem jen při problému. Funkčnost příjmu lze ověřit dočasně
   krátkým `EET_DOHLED_CERT_DNI` (např. 400 dní – certifikát pak „brzy končí“) a pak vrátit.

### Vypnutí / návrat po zapnutí B
- **Zákonná povinnost evidovat trvá.** Vypnutí je jen nouzové řešení, ne návrat do stavu před EET.
- **Dočasné vypnutí:** odebrat `EET_PROSTREDI`. Nové události nevznikají. Už vzniklé neodeslané
  události zůstanou v databázi (`ceka`) a po opětovném zapnutí se **stejnou identitou** se odešlou.
  `EET_PRODUKCE_OD` neměnit.
- **Návrat kódu:** jen na verzi, která obsahuje EET frontu (commit `97ff558` nebo novější).
  Starší verze neodeslané události neodešle a povinnost by zůstala nesplněná. Návrat kódu nemaže
  události, potvrzení ani frontu – migrace nic nemažou a databáze mazání událostí a pokusů
  zakazuje (triggery).
- **Obnova zálohy databáze** po zapnutí B smaže události a POK vzniklé po záloze. Je zakázaná,
  pokud se před ní neexportují tabulky EET (`pg_dump -t 'eet_*' …`) a po obnově se znovu nenaimportují.
- Testovací události z jiného prostředí se nikdy nepřenesou. Prostředí a identita události jsou
  neměnné a fronta posílá jen vlastní. Admin je ukazuje jako „z jiného prostředí – neodešlou se“.
