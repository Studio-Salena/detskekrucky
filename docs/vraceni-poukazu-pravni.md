# Vrácení peněz za dárkový poukaz – právní podklady a otevřené otázky

Stav: 18. 11. 2026. Nejde o právní stanovisko. Závěry označené **NEDOLOŽENO** nejsou opřené
o výslovné znění zákona ani o rozhodnutí soudu či výklad dozorového orgánu. Před ostrým
použitím je má posoudit advokát nebo spotřebitelská poradna.

## Pravidlo obchodu

> Poukaz nelze směnit za hotovost. Tím nejsou dotčena zákonná práva spotřebitele, zejména
> právo na odstoupení od smlouvy, jsou-li splněny zákonné podmínky.

Věta je stejně v obchodních podmínkách (čl. Dárkové poukazy), ve formuláři žádosti o poukaz
v e-shopu, v e-mailu s kódem poukazu a (zkráceně) na zadní straně plastové karty. Potvrzení
objednávky přebírá VOP z webu (jediný zdroj, `lib/pravniTexty.js`).

## Zdroje

| Zdroj | Adresa | Verze / staženo |
|---|---|---|
| Zákon č. 89/2012 Sb., občanský zákoník, § 1829, 1831, 1832, 1837 | https://www.zakonyprolidi.cz/cs/2012-89 | znění účinné 1. 1. 2026 – 31. 12. 2026, staženo 18. 11. 2026 |
| ČOI – Odstoupení od smlouvy do 14 dnů u zboží | https://coi.gov.cz/faq/6-odstoupeni-od-smlouvy-do-14-dnu-u-zbozi/ | staženo 18. 11. 2026 |
| ČOI – Odstoupení od smlouvy do 14 dnů u služeb | https://coi.gov.cz/faq/7-odstoupeni-od-smlouvy-do-14-dnu-u-sluzeb/ | staženo 18. 11. 2026 |

Citace zákona (aktuální znění):

- **§ 1829 odst. 1:** „Spotřebitel může odstoupit od smlouvy uzavřené distančním způsobem …
  ve lhůtě čtrnácti dnů. Není-li dále stanoveno jinak, končí lhůta uplynutím čtrnácti dnů ode
  dne uzavření smlouvy.“
- **§ 1829 odst. 2:** „Je-li předmětem závazku koupě zboží, končí lhůta uplynutím čtrnácti dnů
  ode dne, kdy spotřebitel nebo jím určená třetí osoba odlišná od dopravce převezme zboží …“
- **§ 1829 odst. 4:** „Nebyl-li spotřebitel poučen o právu odstoupit od smlouvy podle § 1820
  odst. 1 písm. i), může od smlouvy odstoupit do jednoho roku ode dne uplynutí lhůty podle
  odstavce 1, 2 nebo 3. V případě, že podnikatel poučil spotřebitele … do jednoho roku …,
  skončí lhůta pro odstoupení uplynutím čtrnácti dnů ode dne, kdy spotřebitel obdržel poučení.“
- **§ 1832 odst. 1:** podnikatel vrátí „všechny peněžní prostředky včetně nákladů na dodání,
  které od něho na základě smlouvy přijal, stejným způsobem“; jiným způsobem jen se souhlasem
  spotřebitele a bez dalších nákladů pro něj.
- **§ 1837:** výčet smluv, od kterých spotřebitel odstoupit nemůže (písm. a) až l)).

## Závěry použité v systému

### 1. Kdy jde peníze vrátit
Jen u poukazu koupeného přes e-shop (`zakoupeno_kde = 'eshop'`), tedy u smlouvy uzavřené na
dálku. Poukaz koupený osobně na prodejně právo na odstoupení podle § 1829 nemá. **Doloženo**
(§ 1829 odst. 1 se týká smluv uzavřených distančním způsobem nebo mimo obchodní prostory).

Pozor: systém se řídí jen údajem „zakoupeno kde“. Pokud byl poukaz domluvený na dálku (e-mail,
telefon), ale zapsaný jako „prodejna“, systém peníze nevrátí, i když právo na odstoupení může
existovat. To je třeba při vydání poukazu zapisovat správně.

### 2. Počátek lhůty – NEPŘEDPOKLÁDÁ se datum zaplacení
Zákon rozlišuje „koupi zboží“ (od převzetí, odst. 2) a ostatní smlouvy (od uzavření, odst. 1).
**NEDOLOŽENO:** zda je hodnotový poukaz „zboží“, zákon ani ČOI výslovně neuvádějí. Systém proto
počítá lhůtu od **pozdějšího** z obou okamžiků, takže ji v žádném z výkladů nezkrátí:

- **uzavření smlouvy** = vydání poukazu na žádost z e-shopu (`darkove_poukazy.vytvoreno`).
  **NEDOLOŽENO:** žádost zákazníka je návrh, smlouvu uzavírá až obchod (vydání poukazu a pokyny
  k platbě). Pozdější okamžik je pro zákazníka výhodnější, takže chyba výkladu lhůtu nezkrátí.
- **převzetí poukazu** = odeslání e-mailu s kódem (`kod_odeslan_at`, zapisuje se od této verze
  po úspěšném odeslání), nebo den převzetí, který zadá správce podle korespondence (vytištěný
  poukaz, plastová karta, poukaz z doby před touto verzí). Bez jednoho z nich systém vrácení
  neprovede a den převzetí si vyžádá.
- **datum zaplacení se nepoužívá.** Zaplacení není převzetí ani uzavření smlouvy.

### 3. Poučení o odstoupení a prodloužená lhůta
E-mail s kódem poukazu koupeného přes e-shop od této verze obsahuje poučení o odstoupení,
vzorový formulář a obchodní podmínky. Za doložené poučení se bere jen zapsané odeslání tohoto
e-mailu. Jinak (všechny dosavadní poukazy, chyba e-mailu) systém lhůtu prodlouží o rok podle
§ 1829 odst. 4. **Doloženo** (znění zákona). Formulář žádosti o poukaz nově odkazuje na VOP
a poučení. **NEDOLOŽENO:** zda tím obchod splnil povinnost poučit **před** uzavřením smlouvy
(§ 1820 odst. 1 písm. i), protože formulář žádosti nemá souhlas s VOP jako objednávka zboží.

### 4. Vrací se skutečně přijatá částka
Podle § 1832 odst. 1 se vrací „všechny peněžní prostředky …, které od něho … přijal“. Při
nákupu se slevou tedy zaplacená částka, ne nominální hodnota. Zbytek kreditu nad zaplacenou
částku se zruší bez peněz. **Doloženo.** Poukazy se zasílají e-mailem bez poplatku za dodání.
**NEDOLOŽENO:** pokud by byl poukaz někdy zaslán poštou za poplatek, vracelo by se i poštovné
(nejlevnější nabízený způsob, § 1832 odst. 2). Systém takový poplatek nezná. Dnes systém slevu
na poukaz neumí; vrácení zaplacené částky je ověřené testem se simulovaným dokladem.

Peníze se mají vracet **stejným způsobem**, jakým byly přijaty (§ 1832 odst. 1). Administrace
proto nabízí původní způsob platby. Jiný způsob jen se souhlasem zákazníka.

### 5. Plastové karty koupené online
**Nevylučují se.** Žádné písmeno § 1837 se na nabitou kartu s volitelnou částkou nevztahuje.
Karta se nevyrábí podle požadavků zákazníka (písm. d), vzhled je jednotný. Právní důvod
k vyloučení se nenašel, a proto se karta koupená přes e-shop vrací jako poukaz: vratka
k účtence nabití, karta se zablokuje (zrušený poukaz). **NEDOLOŽENO:**
- zda by individuální vzhled nebo vzkaz na poukazu („pro koho“) mohl spadat pod písm. d) –
  systém to nepředpokládá,
- zda zákazník musí plastovou kartu vrátit (§ 1831, vrácení zboží) – systém to nevynucuje.

### 6. Použitý poukaz
Systém vrácení u (i částečně) použitého poukazu odmítne a nechá ho na individuálním posouzení.
**NEDOLOŽENO a otevřené:** zákon výslovně neříká, zda lze od smlouvy o poukazu odstoupit po jeho
částečném použití (a vrátit nevyčerpaný zbytek), ani zda použití poukazu právo na odstoupení
vylučuje (§ 1837 takový případ neuvádí). Pokud zákazník v takovém případě odstoupí, postupujte
po poradě s právníkem a peníze vraťte mimo tuto funkci.

## Případy mimo automatické zpracování
Systém žádný právní závěr o nároku zákazníka nedělá. Kde vrácení neprovede automaticky
(poukaz zapsaný jako koupený na prodejně, darovaný, historický bez platby, použitý, podle
zapsaných údajů po lhůtě, jiná než celá přijatá částka), administrace uvádí, že **automatické
zpracování není dostupné** a případ je třeba **posoudit individuálně**. Netvrdí, že zákazník
zákonné právo nemá. U poukazu zapsaného jako „prodejna“ výslovně upozorní, že byl-li ve
skutečnosti sjednaný na dálku, právo na odstoupení mít může. Další automatická právní
pravidla se do systému nepřidávají (rozhodnutí majitelky 18. 11. 2026).

## Kontroly v systému (zachované)
- Před výplatou se v jedné transakci zamkne poukaz, jeho vklady kreditu a původní platba.
  Ověří se soulad zůstatku, pohybů kreditu, vkladů, vyplaceného kreditu a vrácených peněz
  a dřívějších vrácení proti úhradě (`lib/souladPoukazu.js`). Nesoulad = odmítnutí a hlášení
  v Kontrole plateb, nic se neopravuje.
- Opakovaný požadavek se stejným klíčem vyplatí jen jednou, jiný klíč u zrušeného poukazu nic.
- Souběh čerpání a vrácení: vždy projde jen jedno.
- Testy: `test/vraceni-poukazu-postgres.test.js`.
