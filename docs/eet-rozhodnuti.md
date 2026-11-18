# EET – otevřená rozhodnutí před produkční evidencí

Stav k 18. 11. 2026. Tato pravidla **nejsou uzavřená**. Aplikace je zatím řeší opatrně: nic
neeviduje potichu a nic nepředstírá. Úspěšné odeslání na Playground jen dokazuje, že zpráva
technicky prošla (formát, podpis, kritické kontroly). **Neříká nic o tom, zda je obchodní
pravidlo správné.** Playground nekontroluje, jestli má poukaz být `urceno_cerp_zuct`, ani jestli
se dar má evidovat.

Podklady: Popis položek datové zprávy v1.0 (kap. 4, 5.3, 12–14) a Popis datového rozhraní v1.2.
Zdroje a otisky jsou v `docs/eet-krok3.md`.

Kam s dotazy:
- daňová poradkyně / účetní (stanovisko pro poplatníka),
- Finanční správa: dotazy veřejnosti, kategorie EET (https://app.fs.gov.cz/dotazy-verejnosti/dotaz/kategorie/EET), nebo epodpora@fs.gov.cz.

---

## 1. Darovaný kredit (poukaz zdarma)

**Jak to funguje teď:** čerpání darovaného kreditu vytvoří samostatnou událost ve stavu
„vyžaduje rozhodnutí“. Ta se neodešle. Peníze zaplacené k nákupu navíc (doplatek) se evidují
normálně. Majitelka rozhodne v adminu („evidovat“ / „neevidovat“) s odůvodněním a rozhodnutí je
konečné.

**Konkrétní nejasnost:** Evidovanou tržbou je podle definice platba zakládající rozhodný příjem,
nebo „následné čerpání **té platby**, která zakládá rozhodný příjem“. U darovaného poukazu žádná
platba nebyla. Možnosti jsou dvě:
- (a) čerpání daru není evidovaná tržba, ekonomicky jde o slevu. Podle kap. 5.3 se eviduje jen
  skutečně přijatá částka, takže by se evidoval jen doplatek.
- (b) čerpání se eviduje jako `cerp_zuct`.

Podklady nerozhodují ani pro jednu možnost. U (b) navíc není jasné, jestli by takové čerpání
nezkreslilo `cerp_zuct` proti `urceno_cerp_zuct`, protože nabití nikdy neproběhlo.

**Co je potřeba k uzavření:**
1. Seznam situací, kdy darované poukazy vznikají: soutěž, kompenzace reklamace, reklama, dárek
   zaměstnanci. Každá může mít jiné daňové zacházení.
2. Jak se dar vede v účetnictví / daňové evidenci (sleva, reklamní náklad).
3. Písemné stanovisko poradkyně nebo odpověď FS na konkrétní příklad: „Darovaný poukaz 500 Kč,
   zákazník nakoupí za 800 Kč, 500 Kč z poukazu, 300 Kč kartou – co obsahuje datová zpráva?“
4. Podle odpovědi upravit pravidlo v `lib/evidencePlateb.js` (`pravidloEet`: darovaný → `nevyreseno`)
   na konečné pravidlo. Rozhodnutí přijatá v adminu do té doby zůstanou zaznamenaná.

## 2. Nedoložený kredit (historické poukazy bez dokladu prodeje)

**Jak to funguje teď:** zůstatek poukazu z doby před evidencí plateb dostane při prvním použití
vklad „počáteční stav“ s původem `nedolozeny`. Jeho čerpání vytvoří událost „vyžaduje rozhodnutí“
(stejně jako u daru).

**Konkrétní nejasnost:** Nevíme, jestli byl takový poukaz zaplacený a jak (hotově, převodem),
nebo jestli byl darovaný. Prodej proběhl před účinností EET 2.0, takže se tehdy neevidoval.
Otevřené otázky:
- Je čerpání zaplaceného, ale neevidovaného nabití evidovanou tržbou (`cerp_zuct`)? Kap. 13
  posuzuje nabití a čerpání samostatně, což ukazuje spíš na „ano“.
- Jak zacházet s poukazy, u kterých nejde doložit, že byly zaplacené?
- Řeší to přechodná ustanovení zákona č. 180/2026 Sb.?

**Co je potřeba k uzavření:**
1. Výpis historických poukazů se zůstatkem: kód, datum vydání, hodnota, zůstatek, kde byl prodán.
   Lze vzít z tabulky `darkove_poukazy`, kde `platba_stav = 'historicky'` a `zustatek > 0`.
2. Dohledání v účetnictví / pokladní knize, které z nich byly zaplacené. Zaplacené jde případně
   převést na zaplacený základ, ale jen podle dokladu – historie se nedoplňuje odhadem.
3. Stanovisko poradkyně k přechodným ustanovením (úplné znění zákona je na eet.gov.cz) a k čerpání
   kreditu nabitého před účinností.

## 3. Klasifikace dárkových poukazů (omezená síť ×, nebo poukaz na konkrétní zboží)

**Jak to funguje teď:**
- prodej a nabití poukazu (i plastové karty) se eviduje jako `celk_trzba` + `urceno_cerp_zuct`,
- uplatnění u pultu jako `celk_trzba` + `cerp_zuct`,
- vrácení zboží na poukaz jako záporné `cerp_zuct`,
- prodej v e-shopu převodem a čerpání v e-shopu se neevidují (nejde o kontaktní platbu).

**Konkrétní nejasnost:** Kap. 13 rozlišuje dva druhy poukazů:
- poukaz na **konkrétní zboží či službu**: eviduje se jen jeho nákup, uplatnění ne
  (příklad 4, masáž),
- **voucher na nákup blíže nespecifikovaného zboží** nebo nabíjecí nosič: jde o platbu v omezené
  síti, eviduje se nabití (`urceno_cerp_zuct`) i čerpání (`cerp_zuct`).

Poukazy obchodu jsou hodnotové (100–50 000 Kč), platí na libovolné zboží v prodejně i v e-shopu,
čerpají se postupně, platí 1 rok a karty jdou znovu nabít. To odpovídá druhé skupině. Jde ale
o výklad, ne o potvrzené pravidlo. Při opačném výkladu by se čerpání neevidovalo vůbec a
`urceno_cerp_zuct` by se neuvádělo.

**Co je potřeba k uzavření:**
1. Text podmínek poukazu a karty: co je na poukazu / kartě, VOP, platnost, převoditelnost,
   vrácení peněz.
2. Potvrzení poradkyně (nebo odpověď FS) na popis: „hodnotový poukaz / dobíjecí karta na libovolné
   zboží obchodu, postupné čerpání“.
3. Při opačném výkladu změnit mapování v `lib/eetUdalosti.js` (`spocitat`) a vyjasnit, co s už
   evidovanými zprávami (oprava novými událostmi, ne přepis).

## 4. Datum opravných zpráv u volné platby

**Jak to funguje teď:** účel volné platby u pultu se zadává při přijetí, tržba vzniká hned.
Když pozdější přiřazení účel změní, vzniknou dvě opravné zprávy, obě **s datem a časem opravy**:
- záporná s dosavadním rozdělením,
- kladná se správným rozdělením.

Celková tržba se nemění, posune se jen `urceno_cerp_zuct`.

**Konkrétní nejasnost:**
- Kap. 4 určuje datum jen u vrácení peněz (= okamžik vrácení). U opravy bez pohybu peněz říká
  jen „s ohledem na konkrétní okolnosti … bez zbytečného odkladu po zjištění“.
- Není jasné, jestli má kladná oprava nést spíš **původní** čas přijetí platby (popisuje původní
  platbu se správným rozdělením). Pak by šlo o zprávu s datem v minulosti.
- Není jasné ani to, jestli je oprava čistě v rozdělení (`urceno_cerp_zuct`) u FS žádoucí, nebo
  zda by stačilo nechat původní zprávu beze změny.

**Co je potřeba k uzavření:**
1. Odpověď FS nebo poradkyně na příklad: „1000 Kč hotově přijato 10:00 jako platba za zboží,
   ve 14:00 zjištěno, že jde o nabití poukazu. Jaké opravné zprávy a s jakým `dat_trzby`?“
2. Alternativa bez oprav: zakázat pozdější změnu účelu u kontaktních plateb (přiřadit jde jen
   v souladu s účelem z přijetí) a chybné zadání řešit jinak. To je provozní rozhodnutí majitelky.

## 5. Další otevřené body (provoz)

- **POK na účtence:** zatím se netiskne, POK je vidět jen v administraci (Účetnictví → EET
  a historie prodejů). Potřeba je zjistit, jestli zákon nebo vyhláška vyžaduje údaj z EET na
  účtence, a podle toho rozhodnout.
- **Produkční identita:**
  - EIČ majitelky (podle toho, zda má DIČ, jinak CZ + RČ nebo VČP z DIS+),
  - číslo evidenční jednotky provozovny v Hulíně z DIS+,
  - označení pokladny,
  - pokladní certifikát z CA EET (DIS+).
- **Platby zapsané mimo prodejnu:** kontaktní platba se smí zapisovat jen tam, kde skutečně
  proběhla (evidenční jednotka = provozovna). Je potřeba ověřit, že admin mimo prodejnu
  kontaktní platby nezapisuje.
