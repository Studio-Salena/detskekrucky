# Krok 3 – napojení EET 2.0 (Playground)

Stav k 18. 11. 2026: **implementováno a ověřeno pro lokální testy a oficiální Playground; produkční
konfigurace je připravená, ale výchozím nastavením VYPNUTÁ.** Produkce se zapne jen při úplném a
výslovném nastavení (EET_PROSTREDI=produkce + EET_PRODUKCE_POVOLENA=ano + EET_PRODUKCE_OD +
certifikát produkční CA EET) – viz `docs/nasazeni-eet.md`. Nic není nasazené a do produkčního EET
se nic neposlalo.

## 1. Podklady (přesné zdroje, verze, otisky)

Zdrojová stránka: **https://eet.gov.cz/cs/o-eet/dokumenty-k-eet-2-0** (sekce pro vývojáře).
Znovu staženo **18. 11. 2026 10:46:47 UTC** (curl, HTTPS s ověřením TLS); předtím 17. 11. 2026.
„Last-Modified“ je hlavička HTTP odpovědi serveru.

| Dokument | Verze | URL | SHA-256 | Last-Modified | Porovnání s použitým |
|---|---|---|---|---|---|
| Formát a struktura údajů o evidované tržbě a popis datového rozhraní | 1.2 (25. 8. 2026) | [`EET_popis_rozhrani_v1.2.pdf`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_rozhrani_v1.2.pdf) | `c986e85686927e1e153aee0f33090fd6fda80d09b44e564d8b344dde729b1a1e` | Tue, 25 Aug 2026 14:15:30 GMT | shodný s použitým |
| Popis položek datové zprávy s příklady jejich vyplnění | 1.0 (5. 10. 2026) | [`EET_popis_polozek_datove_zpravy.pdf`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_popis_polozek_datove_zpravy.pdf) | `de09d084688e871c639b2813ed30ba77e838667f16ec94604b6a3f4df2c3576f` | Mon, 12 Oct 2026 11:53:36 GMT | shodný s použitým |
| XML schéma (namespace `http://fs.gov.cz/eet/schema/v4`) | 4.1 | [`EETXMLSchema.xsd`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EETXMLSchema.xsd) | `83597d08520cbfab7e51145df9a765d5ca22e2f9a38644a468d695657c7a032a` | Mon, 22 Jun 2026 12:25:10 GMT | shodný s `test/fixtures/eet/EETXMLSchema.xsd` |
| WSDL (SOAPAction `http://fs.gov.cz/eet/OdeslaniTrzby`) | 4.1 | [`EETServiceSOAP.wsdl`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EETServiceSOAP.wsdl) | `df149c0bef4ac18c2a6e82116b6eb9bb17d29c055cb0821ac6d3885ec90faeb4` | Mon, 22 Jun 2026 12:25:10 GMT | shodný s `test/fixtures/eet/EETServiceSOAP.wsdl` |
| Playground – přístupové a provozní informace (CZ, **TLP:AMBER**) | 1.2 (11. 11. 2026) | [`EET_pristupove_provozni_informace_playgr-4.pdf`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_pristupove_provozni_informace_playgr-4.pdf) | `2a5deacd6440a6550f0719c595f3638b3a8f7044c741578b84da2e9a42708f3e` | Mon, 16 Nov 2026 14:15:52 GMT | shodný s použitým (dříve uložen jako playground.pdf) |
| Playground – access and operational information (EN, TLP:AMBER) | 1.2 (11. 11. 2026) | [`EET_pristupove_provozni_informace_playgr-5.pdf`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_pristupove_provozni_informace_playgr-5.pdf) | `4331231982ea65e7425db5d402978eee45b3b32bee3588634942665bcc66b297` | Mon, 16 Nov 2026 14:35:16 GMT | nový soubor – anglický překlad téže verze 1.2, obsahově bez rozdílu |
| Produkce – přístupové a provozní informace (CZ, bez označení TLP) | 1.2 (11. 11. 2026) | [`EET_pristupove_provozni_informace_Produk-4.pdf`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_pristupove_provozni_informace_Produk-4.pdf) | `41c0b5e27770acdc355d5454d6ba9348cc4a3e32646f689d94d57d7a6e1aae99` | Mon, 16 Nov 2026 14:02:32 GMT | nový pro krok 3b – zdroj produkční konfigurace |
| Produkce – access and operational information (EN, TLP:AMBER) | 1.2 (11. 11. 2026) | [`EET_pristupove_provozni_informace_produk-5.pdf`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/EET_pristupove_provozni_informace_produk-5.pdf) | `fac294546b96979ad2dbbff5d9da123a6f44f44907edaeb2f6bae607d599aae4` | Mon, 16 Nov 2026 14:06:32 GMT | nový – anglický překlad téže verze 1.2 (stejné URL, podepisující, data) |
| Testovací certifikáty Playgroundu (CZ00000019, CZ683555118, CZ8551015704) | 2026 v1 | [`CAEET_Playground_2026_v1.zip`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/CAEET_Playground_2026_v1.zip) | `711ca591e2e58e906212befab55ea72cbc5d960af49e444765b0428751002491` | Mon, 22 Jun 2026 12:25:10 GMT | shodný s použitým; mimo git (`scripts/eet-playground-certifikaty.js`) |
| Certifikační politika CA EET | v1 | [`CAEET_certifikacni_politika_v1.pdf`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/CAEET_certifikacni_politika_v1.pdf) | `33534831a31007dc727d5b93790ae9541450f3a1c8828b95cd41d4a5d5b458d7` | Mon, 22 Jun 2026 12:25:10 GMT | nový – kontext k produkčním certifikátům |
| Postupy instalace certifikátu CA EET | v1 | [`CAEET_postupy_instalace_certifikatu_v1.pdf`](https://eet.gov.cz/assets/cs/cmsmedia/pro-vyvojare/CAEET_postupy_instalace_certifikatu_v1.pdf) | `bdd39c4df95bdf8a6bc88682d14c9783a5c6497d13cea50c960a55a3044ad9d5` | Mon, 22 Jun 2026 12:25:10 GMT | nový – kontext k převodu PKCS#12 |

**Výsledek porovnání:** všechny soubory použité v kroku 3 mají při novém stažení **stejný SHA-256** –
rozdíl není. Nové na webu jsou anglické verze provozních informací (téže verze 1.2, obsahově bez
rozdílu) a produkční provozní informace, ze kterých vychází produkční konfigurace (kap. 2.1 URL,
3.1 vydavatel pokladních certifikátů „EETv2 NCA SubCA RSA“, OID politiky PROD 1.2.203.19122063.10.1.102.x.y,
3.3 podepisující „Spolecne technicke zarizeni spravce dane EET“ vydaný I.CA Public CA/RSA 06/2022,
4.1 minimální datum tržby 1. 1. 2027, přechodný režim od 1. 11. 2026). Dokumenty označené
TLP:AMBER se do repozitáře nekopírují, převzaty jsou jen technické hodnoty potřebné pro konfiguraci.

Certifikáty I.CA pro ověření podpisu odpovědí jsou zvlášť pro každé prostředí v `lib/eet-ca/playground/`
a `lib/eet-ca/produkce/` (Root CA/RSA 05/2022 a Public CA/RSA 06/2022; otisky ověřené proti
www.ica.cz – test `eet-konfigurace` / `eet-zprava`).

Testovací certifikáty mimo git, reprodukovatelně:
```powershell
node scripts/eet-playground-certifikaty.js C:\mimo-git\eet-playground CZ00000019
```
(stáhne ZIP z URL výše, ověří SHA-256, převede PKCS#12 → čisté PEM přes `openssl pkcs12 -legacy`
– soubory jsou šifrované RC2-40, ověří vydavatele a vypíše proměnné pro `scripts/eet-playground.js`).

Klíčová pravidla, ze kterých implementace vychází:
- popis rozhraní kap. 2.2 (mody, prostředí, tabulka odpovědí), 3.3–3.5 (položky, odpověď, chyby),
  4 (jednoznačný kód tržby), 5 (SOAP 1.1, WS-Security, Exclusive C14N, SHA-256, RSA-SHA256,
  podepsaný jen `soap:Body`, certifikát v `BinarySecurityToken`, TLS 1.2+ s ověřením serveru);
- popis položek kap. 1 (UUID nové při každém zaslání, `prvni_zaslani`, první pokus nejpozději
  při uskutečnění tržby, žádné dávkové shromažďování), 12–14 (celková částka, `urceno_cerp_zuct`,
  `cerp_zuct`, platba více způsoby = jedna zpráva, každé čerpání zvlášť), 4 (storno a oprava =
  záporná tržba s vlastním pořadovým číslem a datem vrácení), 6 (mezní doba odezvy ≥ 2 s,
  po výpadku bezodkladně, nejpozději do 48 h, povinnost trvá i po lhůtě);
- Playground: URL `https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4`, pokladní
  certifikáty vydává „playground EETv2 NCA SubCA“, potvrzení podepisuje
  „NEOSTRE - playground prostredi EET“ (I.CA Public CA/RSA 06/2022), POK končí `-ff`,
  minimální datum tržby 1. 7. 2026, servisní okno čtvrtek 20:00–6:00.

Dárkové poukazy obchodu jsou hodnotové (na libovolné zboží) → podle kap. 13 jde o prostředek
pro platbu v omezené síti („voucher na nákup blíže nespecifikovaného zboží“): prodej/nabití =
`urceno_cerp_zuct`, uplatnění = `cerp_zuct`. *Toto zařazení je výklad, který má před produkcí
potvrdit účetní.*

## 2. Tři vrstvy (nezaměňovat)

| Vrstva | Tabulka | Co je to |
|---|---|---|
| finanční operace | `platby`, `kredit_pohyby` (krok 2) | prodej, vratka, výměna, úhrada… – skutečné peníze a kredit |
| událost EET | `eet_udalosti` (+ `eet_udalosti_radky`) | **jedna evidovaná tržba** s neměnnými podklady: EIČ, evidenční jednotka, pokladna, pořadové číslo, datum tržby, částky |
| pokus o odeslání | `eet_pokusy` | jedno odeslání: nové UUID, `prvni_zaslani`, `dat_odesl`, výsledek, POK / chyba, transakce FS |

Jedna operace = jedna zpráva (ne zpráva za řádek plateb): např. poukaz + doplatek kartou =
`celk_trzba` 1000, `cerp_zuct` 700. Událost vzniká **ve stejné transakci** jako operace
(`eetUdalosti.zaznamenat`); vazba v `eet_udalosti_radky` (každý řádek nejvýš jednou) brání
zdvojení i při opakovaném požadavku. Pořadové číslo `RRRR-NNNNNN` z `eet_porad_seq` (logická
nespojitá řada – nevznikne u operací bez tržby). Trigger zakazuje změnu podkladů i smazání,
potvrzenou/neevidovanou událost uzavírá a hlídá povolené přechody stavů.

## 3. Mapování operací → částky EET

| Operace | celk_trzba | urceno_cerp_zuct | cerp_zuct |
|---|---|---|---|
| prodej hotově / kartou / QR | +cena | – | – |
| prodej poukazu, nabití karty (kontaktně) | +hodnota | +hodnota | – |
| úhrada poukazu z e-shopu u pultu | +hodnota | +hodnota | – |
| celý nákup zaplaceným poukazem | +čerpání | – | +čerpání |
| poukaz + doplatek | +čerpání +doplatek | – | +čerpání |
| platba osobního odběru u pultu | +platba | – | – |
| vratka penězi u pultu (k evidované tržbě) | −vráceno | – | – |
| vrácení zboží zpět na poukaz | −připsáno | – | −připsáno |
| vrácení peněz za poukaz (storno nabití) | −vráceno | −vráceno (do výše určené části) | – |
| výměna s doplatkem / s vráceným rozdílem | +doplatek / −rozdíl | – | – |
| storno omylem zapsaného příjmu / vrácení | −/+ původní (jen byl-li evidován) | dtto | – |
| převod, dobírka, e-shop | neeviduje se | | |
| **darovaný / nedoložený kredit** | zvláštní událost `rozhodnuti` – neodešle se | | |

Ověřeno na konkrétních příkladech v `test/eet-postgres.test.js` (A1–A16) a skutečně odesláno na
Playground (viz 8).

## 4. Odesílání, restart, souběh, ztracená odpověď

- **První odeslání bez odkladu:** route po COMMIT zavolá `eetFronta.stavPoUlozeni` → fronta
  událost hned odešle (`Fronta.odeslatIhned`) a pokladna dostane POK nebo stav „čeká“ nejvýš po
  mezní době odezvy (`EET_TIMEOUT_MS`, výchozí 5 s, minimum 2 s). Záložně NOTIFY po COMMIT +
  procházení fronty každých 30 s.
- **Trvalá fronta:** stav v DB (`ceka`, `dalsi_pokus_at`), přežije restart. Opakování 15 s → max. 10 min.
- **Více zpracovatelů:** pronájem události (`FOR UPDATE SKIP LOCKED` + `zamek_token`/`zamek_do`);
  výsledek zapíše jen držitel platného pronájmu; potvrzenou nic nepřepíše ani znovu neodešle.
  Zastavená fronta odebere své posluchače NOTIFY (spojení se vrací do poolu).
- **Ztracená odpověď / timeout / podvržená odpověď:** výsledek neznámý → nový pokus s novým
  UUID, `prvni_zaslani=false` a **stejnými** údaji tržby (FS ji podle kódu tržby pozná jako tutéž).
- **Pád po přijetí zprávy FS, před uložením potvrzení:** pokus zůstane bez výsledku; další
  zpracovatel ho uzavře jako `nedokonceno` a pošle opakované zaslání (stejná tržba).
- **Trvalá chyba** (kódy 2–7, neplatná zpráva) = stav `chyba`, sama se neopakuje; po opravě
  „Odeslat“ v adminu. Kód −1 a 8 = dočasné, opakuje se.

## 5. Zpráva, podpis, ověření odpovědi (`lib/eetZprava.js`)

SOAP 1.1, WS-Security: podepsaný právě `soap:Body` (Exclusive C14N, SHA-256, RSA-SHA256),
certifikát v `BinarySecurityToken`, odkaz přes `SecurityTokenReference`, žádné další hlavičky.
Před odesláním kontrola položek podle XSD; testy validují celou zprávu proti oficiálnímu XSD.
Odpověď se přijme jen když: je to SOAP s právě jedním Body a jedním `Odpoved`, potvrzení je
podepsané certifikátem z řetězce k důvěryhodné I.CA se jménem podepisujícího pro dané prostředí,
podpis se vztahuje právě k Body, ze kterého se čte, UUID = odeslané UUID, příznak `test` a
fiktivní POK `-ff` odpovídají prostředí. Jinak je výsledek neznámý a zpráva se zopakuje.
TLS se nikdy nevypíná (výchozí CA Node.js, TLS 1.2+). Ověřovací mód (`overeni=true`, kód 0)
nikdy neoznačí událost jako potvrzenou; testovací potvrzení nejde uložit bez příznaku test
a POK `-ff` (trigger).

## 6. Volná platba u pultu (rozhodnutí)

Kontaktní platba bez dokladu je tržba v okamžiku přijetí. **Účel se zadává při přijetí**
(`ucel`: `zbozi` = zboží/objednávka, `poukaz` = nabití poukazu → `urceno_cerp_zuct`), událost
vzniká hned a datum tržby = okamžik zápisu (zpětné datum se zapnutým EET nejde).
Pozdější přiřazení: když odpovídá účelu, nic nového nevzniká. Když účel změní (např. „zboží“
přiřazené poukazu), původní zpráva se nepřepisuje a druhá tržba nevzniká – ve stejné transakci
vzniknou dvě opravné události: záporná s dosavadním rozdělením a kladná se správným (celková
tržba se nemění, popis položek kap. 14, příklad 3 – „storno + nabití“). Totéž při stornu
přiřazení. Cíl rozdělení = přiřazeno poukazům + nepřiřazený zbytek podle účelu z přijetí
(`eetUdalosti.srovnatVolnou`). *Datum opravných událostí = okamžik opravy – potvrdit s účetní.*

## 7. Nevyřešené případy (produkční připravenost NEUZAVŘENA)

- **Darovaný a nedoložený kredit** (`kredit_casti.eet_pravidlo = nevyreseno`): zvláštní událost
  `rozhodnuti`, neodešle se. Majitelka rozhodne v adminu („evidovat“ / „neevidovat“) s povinným
  odůvodněním; rozhodnutí je konečné a viditelné. Pravidlo není v podkladech doložené.
- **Řádky bez události:** `nepokryteRadky` hlídá kontaktní platby a čerpání od zapnutí EET
  (`eet_provoz`), které žádná událost nepokrývá – admin je ukáže k rozhodnutí, nic se
  nedoplňuje potichu.
- Historie před zapnutím EET se nedoplňuje.

## 8. Výsledky ověření

- Lokální testy: `node --test` (635 testů, z toho PG s `TEST_PG_URL`), prohlížečové testy
  `node prohlizec-testy/spustit.js` (pokladna, odber, ucetnictvi, stary-admin, eet).
- **Skutečný test proti Playgroundu** (`scripts/eet-playground.js`, 18. 11. 2026, EIČ
  CZ00000019, oficiální testovací certifikát): PROŠLO – ověřovací mód kód 0; 8 událostí
  (prodej, prodej poukazu s `urceno`, poukaz + doplatek s `cerp`, vratka −1000, volná platba
  + opravná dvojice) potvrzeno s POK `…-ff`; ztracená odpověď → opakované zaslání
  (`prvni_zaslani=false`, nové UUID) potvrzeno; darovaný kredit neodeslán; potvrzené se znovu
  neodesílají; okamžité odeslání z pokladny potvrzeno za 90 ms. **Potvrzení z Playgroundu
  nejsou evidencí tržeb.**
- **Ověření migrace na skutečné kopii produkce: NEPROVEDENO** (`scripts/overeni-migrace.js`,
  `docs/postup-overeni-migrace.md`).

## 9. Nastavení (jen server, nikdy git ani logy)

Produkční zapnutí a dohled: `docs/nasazeni-eet.md`. Výchozí stav = vypnuto (bez `EET_PROSTREDI`).

| Proměnná | Význam |
|---|---|
| `EET_PROSTREDI` | prázdné = vypnuto (výchozí); `playground`; `produkce` jen s dalšími dvěma proměnnými |
| `EET_PRODUKCE_POVOLENA` | jen přesně `ano` povolí produkci (jiná hodnota = odmítnuto); u Playgroundu nesmí být |
| `EET_PRODUKCE_OD` | počátek produkční evidence s časovou zónou; po prvním startu neměnný v DB (`eet_provoz`) |
| `EET_DOHLED_EMAIL` a další `EET_DOHLED_*` | upozornění mimo admin (`lib/eetDohled.js`); bez příjemce jen log serveru |
| `EET_EIC` | EIČ (musí sedět s CN certifikátu) |
| `EET_ID_PROVOZ` | číslo evidenční jednotky z DIS+ |
| `EET_ID_POKL` | označení pokladního zařízení (1–20 znaků) |
| `EET_CERT_PEM`, `EET_KLIC_PEM` | cesty k PEM certifikátu a klíči na serveru (`EET_KLIC_HESLO` je-li šifrovaný) |
| `EET_TIMEOUT_MS` | mezní doba odezvy (výchozí 5000, min. 2000) |

Certifikát ani klíč se neukládají do DB a nelogují; admin vidí jen EIČ, jednotku, pokladnu a
platnost certifikátu. Pro Playground se použije oficiální testovací identita (PKCS#12 z balíčku
převedený na PEM mimo repozitář).

## 10. Zbývající podmínky produkčního spuštění

Aktuální seznam: `docs/nasazeni-eet.md` a rozhodnutí `docs/eet-rozhodnuti.md`. Původní seznam z kroku 3:

1. Produkční certifikát poplatníka (DIS+), skutečné číslo evidenční jednotky, označení pokladny;
   uložení klíče na serveru (Render: secret file) a postup jeho obnovy.
2. Produkční URL a podpisový certifikát FS (jméno podepisujícího, CA) z produkčních provozních
   informací; doplnit `PROSTREDI.produkce` a povolit ho v konfiguraci i v CHECK databáze.
3. Rozhodnout pravidla pro darovaný a nedoložený kredit a potvrdit s účetní zařazení dárkových
   poukazů (omezená síť) a datování opravných událostí volné platby.
4. Zda a jak tisknout POK na účtenku (podklady kroku 3 to neřeší – doplnit podle zákona).
5. Ověření migrace na skutečné kopii produkční databáze (zatím neprovedeno).
6. Monitoring: upozornění mimo admin (např. e-mail) při neodeslané události blízko lhůty 48 h.
7. Rozhodnout, zda je pokladnou jedno zařízení (`EET_ID_POKL`) i pro admin mimo prodejnu.
