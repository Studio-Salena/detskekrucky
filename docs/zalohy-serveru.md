# Zálohy databáze – šifrování a obnova

Stav od 18. 11. 2026. Hesla v tomto dokumentu nejsou a nikdy sem nepatří.

## Denní záloha ze serveru (Forpsi VPS `web-srv-01`)

- **Skript:** `/root/zaloha-detskekrucky/zaloha.sh`, cron roota denně ve 3:00. Předchozí verze
  skriptu zůstávají vedle jako `zaloha.sh.puvodni-*`.
- **Postup:** `pg_dump | gzip | openssl enc -aes-256-cbc -pbkdf2 -iter 600000` →
  `zalohy/detskekrucky-RRRR-MM-DD.sql.gz.aes`. Nešifrovaný soubor nikde nevzniká. Skript má
  `pipefail`, takže chyba `pg_dump` zálohu nepropustí. Každou novou zálohu skript zkusí
  dešifrovat a ověří, že dump je kompletní, jinak skončí chybou.
- **Kopie:**
  - na serveru: 30 dní,
  - e-mailem přes Resend: jen šifrovaná příloha, heslo v e-mailu není,
  - Disk Google `Můj disk/Zalohy-server/detskekrucky`: 60 dní. Nahrává skript
    `/var/www/rezzum/deploy/db/zaloha-gdrive.sh` ve 4:00 (patří projektu Rezzum a kopíruje
    obsah složky `zalohy/`).
- **Heslo:**
  - na serveru `/root/zaloha-detskekrucky/.heslo-sifrovani` (600, root),
  - mimo server u majitelky (šifrovaná složka na počítači v prodejně a správce hesel).

  Bez kopie mimo server by při ztrátě serveru zálohy nešly otevřít.
- **Zkušební běh bez e-mailu:** `BEZ_EMAILU=1 /root/zaloha-detskekrucky/zaloha.sh`.

Nešifrované zálohy `detskekrucky-*.sql.gz` byly 18. 11. 2026 nahrazené šifrovanými (každá
ověřená dešifrováním na originál) a smazané ze serveru i z Disku Google.

**Zbývá ručně:**
- v cílové schránce smazat starší e-maily „Záloha databáze …“ s nešifrovanou přílohou,
- na Disku Google vysypat koš (smazané soubory tam Google ještě nějakou dobu drží).

## Dohled záloh a upozornění (připraveno 19. 11. 2026, zatím NENASAZENO)

Skripty jsou v repozitáři v `deploy/zalohy/`, test je `deploy/zalohy/test/test-zalohy.sh`
(spouští ho i `node --test`). Repozitář je veřejný, proto skripty neobsahují žádné údaje.
Příjemce a klíč Resend si berou ze serverového `/root/zaloha-detskekrucky/.env`
(`CIL_EMAIL`, `RESEND_API_KEY`), tedy od stejného příjemce jako denní záloha.

| Co hlídá | Kdo | Kdy |
|---|---|---|
| selhání vytvoření, zašifrování nebo kontroly zálohy (s názvem kroku) | `zaloha.sh` | hned při selhání (3:00) |
| e-mail s denní zálohou se neodeslal | `zaloha.sh` | hned |
| **záloha na serveru**: chybí, je starší než 26 h, je podezřele malá nebo nejde dešifrovat do konce dumpu | `kontrola-zaloh.sh` | každou hodinu v :20, **nezávisle** na zálohovací úloze |
| **kopie mimo server**: na Disku Google chybí soubor se stejným MD5 jako některá místní záloha mladší než 28 h, nebo Disk nejde ověřit | `kontrola-zaloh.sh` | každou hodinu v :20 |

- **Omezení opakování:** upozornění chodí jen při změně stavu, pak nejvýš jedna připomínka
  „trvá“ za 24 h. Po obnovení funkce přijde jedna zpráva „obnoveno“. Pokud se upozornění
  nepodaří odeslat, zkusí se znovu při dalším běhu.
- **Obsah zpráv:** jen vlastní věty, název souboru, stáří a velikost. Žádná hesla,
  přístupové údaje, výstup příkazů ani data zákazníků (ověřuje test).
- **Zachování kopií:** starší zálohy se mažou jen po úspěšné nové záloze. Kontrola nic nemaže.
- **Stav:** `stav/` (upozornění, poslední místní záloha, poslední kontrola), log
  `kontrola.log`. Logy se rotují měsíčně (`logrotate.d/detskekrucky-zalohy`).
- **Co dohled nepokryje:** úplný výpadek serveru nebo cronu (neběží ani kontrola) a výpadek
  Resendu (upozornění se pak jen zapíše do logu). Na to by byl potřeba vnější hlídač mimo
  server. Bez souhlasu se nezavádí.

### Nasazení dohledu (na pokyn)
1. **Záloha současného stavu na serveru:**
   `cp -p /root/zaloha-detskekrucky/zaloha.sh /root/zaloha-detskekrucky/zaloha.sh.puvodni-RRRR-MM-DD`
2. **Nahrání skriptů** z `deploy/zalohy/` do `/root/zaloha-detskekrucky/`:
   - `upozorneni.sh`, `kontrola-zaloh.sh` a `zaloha.sh` s oprávněním 700 a vlastníkem root,
   - konce řádků musí být LF,
   - `bash -n` každého souboru.
3. **Zkušební běh bez e-mailu:** `BEZ_EMAILU=1 /root/zaloha-detskekrucky/zaloha.sh`. Musí vzniknout
   dnešní `.aes` (přepíše se dnešní záloha novější) a soubor `stav/posledni-mistni-zaloha`.
4. **Ruční kontrola:** `/root/zaloha-detskekrucky/kontrola-zaloh.sh`. V `stav/posledni-kontrola` musí být
   `lokalni=ok mimo_server=ok`. Při prvním běhu se nic neposílá, protože výchozí stav je „ok“.
5. **Cron a rotace logů:**
   - `install -m 644 deploy/zalohy/cron.d/detskekrucky-kontrola-zaloh /etc/cron.d/`,
   - `install -m 644 deploy/zalohy/logrotate.d/detskekrucky-zalohy /etc/logrotate.d/`,
   - `logrotate -d /etc/logrotate.d/detskekrucky-zalohy`.
6. **Zkouška upozornění naostro** (volitelné, pošle 2 e-maily): dočasně
   `MAX_STARI_MISTNI_H=0 /root/zaloha-detskekrucky/kontrola-zaloh.sh` → „⚠️ záloha na serveru“.
   Pak běžný běh bez proměnné → „✅ obnoveno“.
7. Druhý den ráno ověřit v `cron.log` a `kontrola.log`, že noční záloha i kontroly proběhly.

**Návrat:** smazat `/etc/cron.d/detskekrucky-kontrola-zaloh` a vrátit
`zaloha.sh.puvodni-RRRR-MM-DD`. Zálohy ani Disk se tím nemění.

### Doporučení mimo tento dohled (zatím neprovedeno)
- `zaloha-gdrive.sh` (projekt Rezzum) maže na Disku soubory starší než 60 dní, i když nové
  nepřibývají. Kdyby zálohy přestaly vznikat na déle než 60 dní, Disk by zůstal prázdný.
  Bezpečnější je vždy ponechat nejméně N nejnovějších souborů. Tahle změna patří do
  projektu Rezzum.
- Dlouhodobé kopie (např. měsíční) ani neměnné úložiště zatím nejsou.

## Obnova denní zálohy

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in detskekrucky-RRRR-MM-DD.sql.gz.aes -pass file:HESLO | gunzip > zaloha.sql
createdb -h <server> -U <uzivatel> dk_obnova          # vždy NOVÁ databáze, nikdy přes produkční
psql -h <server> -U <uzivatel> -d dk_obnova -v ON_ERROR_STOP=1 -f zaloha.sql
```

Postup při poškození dat: `docs/nasazeni-eet.md`, oddíl A4.

## Ruční záloha před nasazením (18. 11. 2026)

`pg_dump --format=custom`, SHA-256 dumpu `807432fbf8a0fcd2846fbb05a5eeba334c258f0326a7433a6d1cf3f7f189951e`:
- kopie 1 na počítači v prodejně (šifrovaná složka Windows EFS),
- kopie 2 na Disku Google `Zalohy-server/detskekrucky/zaloha-prod-20261118-1857.dump.aes`
  (AES-256 s vlastním heslem, postup v přiloženém `…-CTI-ME.txt`).

Obě kopie jsou ověřené obnovou do izolované databáze. Kopie na Disku je stažená přes web
a otisk se shoduje. Po nasazení se nemažou.
