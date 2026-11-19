#!/bin/bash
# Denni automaticka zaloha databaze Detske krucky (cron roota 3:00).
# SIFROVANA: pg_dump | gzip | openssl AES-256 (PBKDF2, 600 000 iteraci). Nesifrovany soubor
# nikde nevznika - ani lokalne, ani na Google Drive (zaloha-gdrive.sh ve 4:00 kopiruje obsah
# slozky zalohy/), ani v e-mailu.
# Heslo: $ZALOHA_KOREN/.heslo-sifrovani (jen root); kopie MIMO server u majitelky.
# Desifrovani:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in detskekrucky-DATUM.sql.gz.aes -pass file:HESLO | gunzip > zaloha.sql
#
# Dohled (od 2026-11-19): selhani vytvoreni, sifrovani nebo kontroly zalohy hned posle
# upozorneni (upozorneni.sh, omezene opakovani, oznameni obnoveni). Uspech zapise
# stav/posledni-mistni-zaloha. Starsi zalohy se mazou JEN po uspesne nove zaloze.
# Nezavisle na teto uloze hlida stari zaloh a kopii na Google Drive kontrola-zaloh.sh.
#
# Test bez e-mailu se zalohou: BEZ_EMAILU=1 ./zaloha.sh
set -Eeuo pipefail
umask 077
ZALOHA_KOREN="${ZALOHA_KOREN:-/root/zaloha-detskekrucky}"
cd "$ZALOHA_KOREN"
source ./.env
source "$ZALOHA_KOREN/upozorneni.sh"

HESLO="$ZALOHA_KOREN/.heslo-sifrovani"
ADRESAR="$ZALOHA_KOREN/zalohy"
KONTEJNER="${KONTEJNER:-detskekrucky-db}"
DATUM=$(date +%Y-%m-%d)
SOUBOR="$ADRESAR/detskekrucky-$DATUM.sql.gz.aes"
DOCASNY="$SOUBOR.tmp"
SIFRA=(-aes-256-cbc -pbkdf2 -iter 600000)
KROK="příprava"
ZPRAVA=""

uklid() { rm -f "$DOCASNY" ${ZPRAVA:+"$ZPRAVA"}; }
selhani() {
  local kod=$?
  trap - ERR
  uklid
  loguj "CHYBA: zaloha $DATUM se nevytvorila (krok: $KROK, kod $kod) - starsi zalohy zustavaji"
  upozornit zaloha chyba "záloha databáze se nevytvořila" \
    "Denní záloha databáze $DATUM se nevytvořila. Selhal krok: $KROK."$'\n'"Starší zálohy zůstaly beze změny. Podrobnosti jsou v $ZALOHA_KOREN/cron.log na serveru."
  exit 1
}
trap selhani ERR
trap uklid EXIT
mkdir -p "$ADRESAR"

KROK="kontrola hesla k šifrování"
[ -s "$HESLO" ] || false

# dump -> gzip -> sifrovani; pipefail zajisti, ze chyba pg_dump zalohu neprojde
KROK="vytvoření a zašifrování zálohy (pg_dump | gzip | openssl)"
docker exec "$KONTEJNER" pg_dump -U postgres postgres | gzip | openssl enc "${SIFRA[@]}" -salt -pass file:"$HESLO" -out "$DOCASNY"

# kontrola: zaloha jde desifrovat, gzip je cely a konci jako kompletni dump
KROK="kontrola dešifrování a úplnosti zálohy"
openssl enc -d "${SIFRA[@]}" -in "$DOCASNY" -pass file:"$HESLO" | gunzip | tail -c 300 | grep -q 'PostgreSQL database dump complete'

KROK="uložení zálohy"
mv "$DOCASNY" "$SOUBOR"
chmod 600 "$SOUBOR"
VELIKOST_KB=$(( $(stat -c%s "$SOUBOR") / 1024 ))
echo "$(basename "$SOUBOR") $(date +%s) $(stat -c%s "$SOUBOR")" > "$STAV_DIR/posledni-mistni-zaloha"
upozornit zaloha ok "záloha databáze" "Denní záloha databáze se znovu vytváří ($DATUM, ${VELIKOST_KB} kB, šifrovaná)."

# Smazat lokalni zalohy starsi 30 dni - jen po uspesne nove zaloze (vyse)
KROK="mazání záloh starších 30 dní"
find "$ADRESAR" \( -name 'detskekrucky-*.sql.gz.aes' -o -name 'detskekrucky-*.sql.gz' \) -mtime +30 -delete
trap - ERR

if [ "${BEZ_EMAILU:-}" = "1" ]; then
  loguj "zaloha $DATUM (sifrovana), velikost ${VELIKOST_KB}kB, e-mail vynechan (test)"
  exit 0
fi

# E-mail s SIFROVANOU zalohou v priloze (JSON do souboru - priloha se nevejde na prikazovou radku).
# Zaloha je v tuto chvili uz ulozena; selhani e-mailu zalohu nerusi.
ZPRAVA=$(mktemp)
{
  printf '%s' "{\"from\":\"Dětské krůčky <info@detskekrucky.cz>\",\"to\":[\"$CIL_EMAIL\"],\"subject\":\"Záloha databáze $DATUM (${VELIKOST_KB} kB, šifrovaná)\",\"html\":\"<p>Automatická denní záloha databáze Dětských krůčků.</p><p>Datum: $DATUM<br>Velikost: ${VELIKOST_KB} kB</p><p>Příloha je šifrovaná (AES-256). Heslo k ní není v tomto e-mailu.</p>\",\"attachments\":[{\"filename\":\"detskekrucky-$DATUM.sql.gz.aes\",\"content\":\""
  base64 -w0 "$SOUBOR"
  printf '%s' "\"}]}"
} > "$ZPRAVA"

HTTP_STATUS=$(curl -s -m 60 -o "$ZALOHA_KOREN/posledni-odpoved.json" -w '%{http_code}' -X POST "$RESEND_URL" -H "Authorization: Bearer $RESEND_API_KEY" -H 'Content-Type: application/json' --data-binary @"$ZPRAVA") || HTTP_STATUS="000"
chmod 600 "$ZALOHA_KOREN/posledni-odpoved.json" 2>/dev/null || true
loguj "zaloha $DATUM (sifrovana), velikost ${VELIKOST_KB}kB, resend status $HTTP_STATUS"
if [ "$HTTP_STATUS" != "200" ]; then
  loguj "CHYBA: e-mail se zalohou se neodeslal (Resend $HTTP_STATUS), zaloha je ulozena na serveru"
  upozornit email chyba "e-mail s denní zálohou se neodeslal" \
    "Záloha $DATUM je uložená na serveru, ale e-mail s její šifrovanou kopií se nepodařilo odeslat (Resend $HTTP_STATUS)."
  exit 1
fi
upozornit email ok "e-mail s denní zálohou" "E-mail s denní zálohou se znovu odesílá ($DATUM)."
