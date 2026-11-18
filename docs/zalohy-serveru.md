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
