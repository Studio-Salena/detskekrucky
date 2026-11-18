# Nasazení EET – podmínky a návrat

Nasazují se dvě věci, **každá zvlášť a na samostatný pokyn**:

- **A – aplikace s vypnutým EET.** Nový kód běží, EET tabulky se založí prázdné, nic se neeviduje
  ani neodesílá. Bez rizika pro evidenci tržeb.
- **B – zapnutí produkční evidence.** Pozdější krok jen přes proměnné na serveru, nové nasazení
  kódu není potřeba. Od zapnutí platí zákonná povinnost evidovat, takže návrat je omezený (níže).

Stav k 18. 11. 2026: nic z toho neproběhlo. **Ověření migrace na skutečné kopii produkce
PROŠLO** (záloha 18. 11. 2026 12:44 UTC, výsledek níže a v `docs/postup-overeni-migrace.md`).

**V produkci běží `98593ee`** (`origin/main`), tedy verze ještě **před krokem 2**: bez evidence
plateb, bez atomického prodeje v pokladně a bez EET. Nasazení přinese 9 commitů (kroky 2, 3, 3b).
**Návrat na `98593ee` po prvním zápisu nové verze se NEPROVÁDÍ** (oddíl A3). Při problému se
zastaví dotčené operace a opraví se nová verze.

---

## A. Nasazení aplikace s vypnutým EET

### A1. Podmínky (všechny musí platit)
1. `node --test` zelené (s `TEST_PG_URL`) a prohlížečové testy `node prohlizec-testy/spustit.js` zelené.
2. Ověření migrace na kopii produkce PROŠLO – **splněno 18. 11. 2026**. Pokud mezi ověřením a
   nasazením přibude nový kód, ověření se opakuje.
3. Těsně před nasazením nová záloha produkce (`pg_dump`, `docs/postup-overeni-migrace.md`, krok 1).
   Uložit její SHA-256 a čas. **Tato záloha se po nasazení NEMAŽE**: uchovat ji šifrovaně mimo
   repozitář a mimo vývojový počítač aspoň na dvou místech, nejméně do další ověřené zálohy po
   uzavření měsíce. Samotný otisk (SHA-256) databázi neobnoví – jen ověří, že soubor zálohy
   je ten pravý. Záloha z ověření 18. 11. 2026 posloužila jen k ověření obnovy a je smazaná.
4. Na Renderu **není** nastavené `EET_PROSTREDI` ani `EET_PRODUKCE_*`.
5. Nasazení mimo otevírací dobu prodejny. Po nasazení v prodejně Ctrl+F5: staré okno pokladny
   nový server odmítne („obnovte stránku“) a nic nezapíše.
6. Pokyn „nasaď“.

### A2. Kontrola po nasazení
- Účetnictví → EET: „EET je vypnuté“, 0 událostí.
- Účetnictví → 🔎 Kontrola plateb: v rozsahu 0 rozdílů. Účetní součty se rovnají hodnotám
  z ověření (e-shop 1179, prodejna 382 650, vratky 3647 Kč – stav k 18. 11. 2026, mezitím přibudou
  nové prodeje).
- Zkušební prodej v pokladně: uloží se a v odpovědi není údaj `eet`.
- Log Renderu: žádné „EET fronta“ ani „EET dohled“.

### A3. Návrat – proč se neprovádí a co místo něj

Ověřeno 18. 11. 2026 na klonu kopie produkce (migrované kódem `ae46cf3`). Postup:
1. Nový kód s vypnutým EET zapsal prodej, prodej poukazu, čerpání, doplatek, vratku, poukaz
   z e-shopu (čekající i zaplacený), volnou platbu a platbu osobního odběru.
2. Nad touto databází se spustila stará verze `98593ee` (síť zablokovaná) a provedla vlastní
   prodej, čerpání poukazu, vratku a smazání účtenky.
3. Nový kód se znovu nasadil a vše se zkontrolovalo.

| Co | Výsledek |
|---|---|
| Stará verze nastartuje nad novým schématem | ✔ bez chyb migrací |
| Stará verze čte nové řádky (účtenky, poukazy, vratky) a prodává | ✔ |
| Poukaz „čeká na platbu“ ve staré verzi | ⚠ při ověření se ukáže jako platný (500 Kč), použít ho ale stará pokladna ani e-shop nedovolí (`stav ≠ aktivni`) |
| Prodej / vratka staré verze | ⚠ doklad **bez záznamu v evidenci plateb**; vratku vestavěná Kontrola plateb **nezachytí** |
| Čerpání poukazu starou verzí | ✖ zůstatek poukazu ≠ kredit v evidenci (300 × 500 Kč) |
| Smazání účtenky nového kódu starou verzí | ✖ pohyb kreditu zůstane bez dokladu; Kontrola plateb to **nezachytí** |
| Nový kód po zpětném nasazení nad takovým poukazem | ✖ poukaz je „použitý“ se zůstatkem 0, ale **vrácení peněz za poukaz vyplatilo 200 Kč** podle zbylého kreditu. **Opraveno**: vrácení peněz je jen odstoupení od nákupu nepoužitého poukazu v e-shopu a před výplatou se ověřuje soulad zůstatku, vkladů, úhrady a dřívějších vrácení (`lib/souladPoukazu.js`, test `test/vraceni-poukazu-postgres.test.js`) |
| Produkční konfigurace EET ve staré verzi | stará verze kód EET vůbec nemá – `EET_*` ignoruje, události nezakládá, frontu neodesílá |

**Závěr: bezpečný návrat kódu po prvním zápisu nové verze NELZE doložit, proto se
`98593ee` nad databází, do které nová verze už zapsala, NEPROVOZUJE – ani nouzově.**
Návrat kódu připadá v úvahu jen tehdy, když nová verze ještě nic nezapsala (např. selže hned
start), tedy když tento dotaz vrátí 0:

```sql
SELECT (SELECT COUNT(*) FROM platby) + (SELECT COUNT(*) FROM kredit_pohyby) + (SELECT COUNT(*) FROM prodejna_klice)
     + (SELECT COUNT(*) FROM darkove_poukazy WHERE stav = 'ceka_na_platbu') AS zapsano_novou_verzi;
```

**Postup při problému po nasazení (jediný postup po prvním zápisu):**
1. **Zastavit prodej, kterého se problém týká.** V prodejně přestat používat administraci a
   účtovat na papírové účtenky s číslem, časem, položkami a způsobem platby (EET je vypnuté,
   ruční doklad je přípustný). Do opravy se neprodávají ani neuplatňují dárkové poukazy
   a nevracejí peníze za poukazy. Když se problém týká e-shopu, pozastavit službu na Renderu
   (Suspend) – statický web na GitHub Pages zůstane.
2. Zjistit rozsah: 🔎 Kontrola plateb, na čerstvé kopii `node scripts/overeni-migrace.js`
   (postup v `docs/postup-overeni-migrace.md`) a kontrolní dotazy `scripts/sladeni-po-navratu.sql`
   (jen čtou; najdou doklady bez evidence a nesoulad poukazů, ať vznikl jakkoli).
3. **Oprava vpřed:** opravný commit na novou verzi, testy, ověření na kopii, pokyn „nasaď“.
4. Papírové doklady zadat do opravené verze (běžný prodej / vratka), sklad podle nich zkontrolovat.

**Nouzový návrat na `98593ee` se neprovádí.** Tato verze nezná evidenci plateb ani kredit
poukazů: její prodeje, vratky, čerpání a mazání účtenek by vytvořily doklady bez evidence a
nesoulad poukazů, který se nedá spolehlivě sladit (ověřeno, viz tabulka). Když nová verze
nejde provozovat vůbec, zůstává prodejna na papírových dokladech a e-shop pozastavený, dokud
se nenasadí oprava. Návrat kódu by navíc nic neopravil: data zůstávají (nové tabulky, platby,
kredit, události ani potvrzení se nemažou).

### A4. Obnova zálohy databáze
**Export tabulek EET sám nestačí.** Obnova zálohy vrátí celou databázi do stavu v okamžiku zálohy.
Tím se ztratí všechny novější prodeje, vratky, výměny, objednávky, platby, pohyby kreditu,
poukazy, pohyby skladu, faktury, rezervace i události a potvrzení EET. Obnova je proto jen
poslední možnost při poškození dat:
1. zastavit všechny zápisy (Render Suspend, prodejna na papírových dokladech),
2. **před obnovou zálohovat aktuální stav** (`pg_dump`) – nic se nesmí přepsat bez zálohy,
3. obnovit do **nové** databáze, ne přes produkční,
4. porovnat obě databáze a **zachovat a sladit všechny operace novější než obnovená záloha** –
   obchodní (prodeje, vratky, výměny, objednávky, poukazy), finanční (platby, kredit, faktury,
   dobírky) i skladové (sklad, pohyby skladu) – a teprve potom přepnout `DATABASE_URL`,
5. sklad fyzicky zkontrolovat proti výsledku.

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
- **Návrat kódu:** jen na verzi, která obsahuje EET frontu (commit `97ff558` nebo novější). Na `98593ee` (bez EET) je po zapnutí B návrat zakázaný.
  Starší verze neodeslané události neodešle a povinnost by zůstala nesplněná. Návrat kódu nemaže
  události, potvrzení ani frontu – migrace nic nemažou a databáze mazání událostí a pokusů
  zakazuje (triggery).
- **Obnova zálohy databáze** po zapnutí B: platí oddíl A4. Export tabulek EET sám nestačí,
  zachovat a sladit se musí všechny novější obchodní, finanční i skladové operace.
  Události a POK nesmí zmizet, jinak by tržby byly evidované bez dokladu v systému.
- Testovací události z jiného prostředí se nikdy nepřenesou. Prostředí a identita události jsou
  neměnné a fronta posílá jen vlastní. Admin je ukazuje jako „z jiného prostředí – neodešlou se“.
