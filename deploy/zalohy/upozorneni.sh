#!/bin/bash
# Sdilene funkce pro upozorneni o zalohach Detskych krucku (source z zaloha.sh a kontrola-zaloh.sh).
#
# Prijemce a klic Resend se berou z $ZALOHA_KOREN/.env (CIL_EMAIL, RESEND_API_KEY) - stejny
# prijemce jako u denni zalohy. V repozitari ani ve zpravach nejsou zadne prihlasovaci udaje.
#
# Zpravy se skladaji JEN z vlastnich vet a nazvu souboru/stari - nikdy z vystupu prikazu,
# obsahu .env, hesla nebo dat zalohy.
#
# Omezeni opakovani (stav v $STAV_DIR/upozorneni-<klic>: "<stav> <cas posledniho odeslani>"):
#   - zmena ok -> chyba: upozorneni hned,
#   - chyba trva: pripominka nejvys jednou za $OPAKOVAT_S (vychozi 24 h),
#   - chyba -> ok: jedna zprava "obnoveno",
#   - pokud se upozorneni nepodari odeslat, stav se nezapise a zkusi se pri dalsim behu.

ZALOHA_KOREN="${ZALOHA_KOREN:-/root/zaloha-detskekrucky}"
STAV_DIR="${STAV_DIR:-$ZALOHA_KOREN/stav}"
OPAKOVAT_S="${OPAKOVAT_S:-86400}"
RESEND_URL="${RESEND_URL:-https://api.resend.com/emails}"
PREDMET_PREFIX="[Dětské krůčky – zálohy]"

mkdir -p "$STAV_DIR"
chmod 700 "$STAV_DIR" 2>/dev/null || true

cas() { date '+%Y-%m-%d %H:%M:%S'; }
loguj() { echo "$(cas) $*"; }

# JSON retezec: zpetne lomitko, uvozovky a ridici znaky
json_text() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/ }"
  printf '%s' "$s"
}
# HTML: jen &, <, >
html_text() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  printf '%s' "$s"
}

# posli_email "predmet" "text (vice radku)" -> 0 = odeslano
posli_email() {
  local predmet="$1" text="$2" zprava odpoved kod
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${CIL_EMAIL:-}" ]; then
    loguj "UPOZORNENI NEODESLANO: v .env chybi prijemce nebo klic Resend"
    return 1
  fi
  local html="<p>$(html_text "$text" | sed ':a;N;$!ba;s/\n/<br>/g')</p><p style=\"color:#888;font-size:12px\">Automatický dohled záloh, server $(hostname 2>/dev/null || echo '?').</p>"
  zprava=$(mktemp); odpoved=$(mktemp)
  printf '{"from":"Dětské krůčky <info@detskekrucky.cz>","to":["%s"],"subject":"%s","html":"%s"}' \
    "$(json_text "$CIL_EMAIL")" "$(json_text "$PREDMET_PREFIX $predmet")" "$(json_text "$html")" > "$zprava"
  kod=$(curl -s -m 30 -o "$odpoved" -w '%{http_code}' -X POST "$RESEND_URL" \
    -H "Authorization: Bearer $RESEND_API_KEY" -H 'Content-Type: application/json' --data-binary @"$zprava" 2>/dev/null) || kod="000"
  rm -f "$zprava" "$odpoved"
  if [ "$kod" = "200" ]; then return 0; fi
  loguj "UPOZORNENI NEODESLANO: Resend vratil $kod"
  return 1
}

# upozornit KLIC chyba|ok "predmet" "text"
upozornit() {
  local klic="$1" novy="$2" predmet="$3" text="$4"
  local soubor="$STAV_DIR/upozorneni-$klic" stary="ok" naposledy=0 ted
  ted=$(date +%s)
  if [ -f "$soubor" ]; then read -r stary naposledy < "$soubor" || true; fi
  naposledy="${naposledy:-0}"
  if [ "$novy" = "chyba" ]; then
    if [ "$stary" != "chyba" ]; then
      posli_email "⚠️ $predmet" "$text" && { echo "chyba $ted" > "$soubor"; loguj "upozorneni odeslano: $klic"; }
    elif [ $((ted - naposledy)) -ge "$OPAKOVAT_S" ]; then
      posli_email "⚠️ trvá: $predmet" "$text"$'\n\n'"Problém trvá od předchozího upozornění. Další připomínka nejdřív za $((OPAKOVAT_S / 3600)) h." \
        && { echo "chyba $ted" > "$soubor"; loguj "pripominka odeslana: $klic"; }
    else
      loguj "chyba trva, upozorneni uz odeslano: $klic"
    fi
  else
    if [ "$stary" = "chyba" ]; then
      posli_email "✅ obnoveno: $predmet" "$text" && { echo "ok $ted" > "$soubor"; loguj "obnoveni oznameno: $klic"; }
    else
      echo "ok $ted" > "$soubor"
    fi
  fi
  return 0
}
