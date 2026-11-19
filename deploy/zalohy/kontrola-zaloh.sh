#!/bin/bash
# Nezavisla kontrola zaloh Detskych krucku (vlastni cron, kazdou hodinu - NEZAVISLE na zaloha.sh,
# takze upozorni i tehdy, kdyz se zalohovaci uloha vubec nespusti).
#
# Rozlisuje dva stavy a hlasi je zvlast (upozorneni.sh - omezene opakovani, oznameni obnoveni):
#   lokalni      - na serveru je sifrovana zaloha mladsi nez MAX_STARI_MISTNI_H, ma rozumnou
#                  velikost a jde desifrovat az do konce dumpu,
#   mimo_server  - na Google Drive je soubor se STEJNYM MD5 jako nektera mistni zaloha mladsi nez
#                  MAX_STARI_MIMO_H (nahrava zaloha-gdrive.sh ve 4:00; kontrola tedy pozna i jeho
#                  selhani nebo vypadek, aniz by se do nej zasahovalo).
# Nic nemaze ani nemeni na zalohach. Do zprav jde jen stari, velikost a nazev souboru.
set -uo pipefail
umask 077
ZALOHA_KOREN="${ZALOHA_KOREN:-/root/zaloha-detskekrucky}"
cd "$ZALOHA_KOREN" || exit 1
source ./.env
source "$ZALOHA_KOREN/upozorneni.sh"

ADRESAR="$ZALOHA_KOREN/zalohy"
HESLO="$ZALOHA_KOREN/.heslo-sifrovani"
DRIVE_CIL="${DRIVE_CIL:-gdrive:Zalohy-server/detskekrucky}"
MAX_STARI_MISTNI_H="${MAX_STARI_MISTNI_H:-26}"
MAX_STARI_MIMO_H="${MAX_STARI_MIMO_H:-28}"
MIN_VELIKOST_B="${MIN_VELIKOST_B:-20000}"
RCLONE_TIMEOUT="${RCLONE_TIMEOUT:-180}"

# jen jedna kontrola najednou
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STAV_DIR/kontrola.lock"
  flock -n 9 || { loguj "kontrola uz bezi"; exit 0; }
fi

TED=$(date +%s)
stari_h() { echo $(( (TED - $(stat -c %Y "$1")) / 3600 )); }

# ── 1) mistni zaloha ──
mapfile -t ZALOHY < <(ls -1t "$ADRESAR"/detskekrucky-*.sql.gz.aes 2>/dev/null)
LOKALNI="ok"; LOKALNI_TEXT=""
if [ "${#ZALOHY[@]}" -eq 0 ]; then
  LOKALNI="chyba"; LOKALNI_TEXT="Na serveru není žádná šifrovaná záloha databáze."
else
  NEJNOVEJSI="${ZALOHY[0]}"; JMENO=$(basename "$NEJNOVEJSI"); STARI=$(stari_h "$NEJNOVEJSI"); VELIKOST=$(stat -c %s "$NEJNOVEJSI")
  if [ "$STARI" -ge "$MAX_STARI_MISTNI_H" ]; then
    LOKALNI="chyba"; LOKALNI_TEXT="Poslední záloha na serveru ($JMENO) je stará $STARI h (limit $MAX_STARI_MISTNI_H h). Denní záloha se pravděpodobně nespustila nebo selhala."
  elif [ "$VELIKOST" -lt "$MIN_VELIKOST_B" ]; then
    LOKALNI="chyba"; LOKALNI_TEXT="Poslední záloha na serveru ($JMENO) je podezřele malá ($VELIKOST B)."
  elif ! { openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "$NEJNOVEJSI" -pass file:"$HESLO" 2>/dev/null | gunzip 2>/dev/null | tail -c 300 | grep -q 'PostgreSQL database dump complete'; }; then
    LOKALNI="chyba"; LOKALNI_TEXT="Poslední záloha na serveru ($JMENO) nejde dešifrovat nebo není kompletní."
  else
    LOKALNI_TEXT="Poslední záloha na serveru: $JMENO, stáří $STARI h, $((VELIKOST / 1024)) kB, dešifrování v pořádku."
  fi
fi
upozornit lokalni "$LOKALNI" "záloha na serveru" "$LOKALNI_TEXT"

# ── 2) kopie mimo server (Google Drive) ──
MIMO="chyba"; MIMO_TEXT=""
declare -A LOKALNI_MD5=()
for f in "${ZALOHY[@]}"; do
  [ "$(stari_h "$f")" -lt "$MAX_STARI_MIMO_H" ] || continue
  LOKALNI_MD5["$(md5sum < "$f" | cut -c1-32)"]="$(basename "$f")"
done
if [ "${#LOKALNI_MD5[@]}" -eq 0 ]; then
  MIMO_TEXT="Na serveru není záloha mladší než $MAX_STARI_MIMO_H h, takže ani její kopie mimo server nemůže být aktuální."
else
  VYPIS=$(timeout "$RCLONE_TIMEOUT" rclone md5sum "$DRIVE_CIL" --include 'detskekrucky-*.sql.gz.aes' 2>/dev/null); KOD=$?
  if [ "$KOD" -ne 0 ]; then
    MIMO_TEXT="Kopii záloh na Google Drive nejde ověřit (rclone skončil s kódem $KOD – výpadek spojení nebo přístupu k Disku)."
  else
    SHODA=""
    while read -r md5 _; do
      [ -n "${md5:-}" ] && [ -n "${LOKALNI_MD5[$md5]:-}" ] && { SHODA="${LOKALNI_MD5[$md5]}"; break; }
    done <<< "$VYPIS"
    if [ -n "$SHODA" ]; then
      MIMO="ok"; MIMO_TEXT="Na Google Drive je shodná kopie zálohy $SHODA."
    else
      MIMO_TEXT="Na Google Drive chybí kopie zálohy mladší než $MAX_STARI_MIMO_H h (nebo se neshoduje se zálohou na serveru). Nahrávání (zaloha-gdrive.sh ve 4:00) pravděpodobně selhalo."
    fi
  fi
fi
upozornit mimo_server "$MIMO" "kopie zálohy mimo server (Google Drive)" "$MIMO_TEXT"

echo "$TED lokalni=$LOKALNI mimo_server=$MIMO" > "$STAV_DIR/posledni-kontrola"
loguj "kontrola: lokalni=$LOKALNI mimo_server=$MIMO"
