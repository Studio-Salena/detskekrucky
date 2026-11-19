#!/bin/bash
# Simulacni test dohledu zaloh (zaloha.sh, kontrola-zaloh.sh, upozorneni.sh).
# Bezi v docasne slozce s podvrzenymi prikazy docker, rclone a curl (Resend) - na skutecne zalohy,
# server, Google Drive ani e-mail nesaha. openssl, gzip a coreutils jsou skutecne.
#   bash deploy/zalohy/test/test-zalohy.sh
set -uo pipefail
ZDROJ="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap '[ -n "${PONECHAT:-}" ] || rm -rf "$TMP"' EXIT
OPENSSL_SKUTECNY="$(command -v openssl)"
SELHANI=0; TESTU=0
ok()   { TESTU=$((TESTU+1)); echo "  ✔ $1"; }
spatne() { TESTU=$((TESTU+1)); SELHANI=$((SELHANI+1)); echo "  ✖ $1"; }
over() { if eval "$2"; then ok "$1"; else spatne "$1   [podminka: $2]"; fi; }

# ── podvrzene prikazy ──
STUB="$TMP/stub"; mkdir -p "$STUB"
cat > "$STUB/docker" <<'EOF'
#!/bin/bash
case "${SIM_DOCKER:-ok}" in
  fail) echo "Error: No such container" >&2; exit 1 ;;
  neuplny) printf -- '-- PostgreSQL database dump\nCREATE TABLE t (id int);\n' ;;
  *) printf -- '-- PostgreSQL database dump\n'; for i in $(seq 1 3000); do printf "INSERT INTO zakaznici VALUES (%d, 'Jana Testovaci', 'jana@zakaznik.test', 'Hulin %d');\n" "$i" "$i"; done
     printf -- '\n-- PostgreSQL database dump complete\n' ;;
esac
EOF
cat > "$STUB/curl" <<'EOF'
#!/bin/bash
out=""; data=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; --data-binary) data="${2#@}"; shift ;; esac; shift; done
n=$(ls "$SIM_OUTBOX" | wc -l); cp "$data" "$SIM_OUTBOX/$(printf '%03d' $((n+1))).json"
[ -n "$out" ] && echo '{"id":"sim"}' > "$out"
printf '%s' "${SIM_CURL_KOD:-200}"
EOF
cat > "$STUB/rclone" <<'EOF'
#!/bin/bash
[ "${SIM_RCLONE:-ok}" = "fail" ] && { echo "Failed to create file system: couldn't fetch token" >&2; exit 3; }
[ "$1" = "md5sum" ] || exit 2
for f in "$SIM_DRIVE"/detskekrucky-*.sql.gz.aes; do [ -e "$f" ] && echo "$(md5sum < "$f" | cut -c1-32)  $(basename "$f")"; done; exit 0
EOF
cat > "$STUB/openssl" <<EOF
#!/bin/bash
if [ "\${SIM_OPENSSL:-ok}" = "fail" ] && [ "\$1" = "enc" ] && [ "\$2" != "-d" ]; then echo "bad decrypt" >&2; exit 1; fi
# jen na Windows (Git Bash): nativni openssl nerozumi cestam /tmp/... - prevest pres cygpath
if command -v cygpath >/dev/null 2>&1; then
  a=(); for x in "\$@"; do
    case "\$x" in file:/*) a+=("file:\$(cygpath -m "\${x#file:}")") ;; /*) a+=("\$(cygpath -m "\$x")") ;; *) a+=("\$x") ;; esac
  done; set -- "\${a[@]}"
fi
exec "$OPENSSL_SKUTECNY" "\$@"
EOF
chmod +x "$STUB"/*
export PATH="$STUB:$PATH"

# ── docasny "server" ──
K="$TMP/server"; mkdir -p "$K/zalohy"
cp "$ZDROJ/zaloha.sh" "$ZDROJ/kontrola-zaloh.sh" "$ZDROJ/upozorneni.sh" "$K/"; chmod +x "$K"/*.sh
TAJNE_KLIC="re_TAJNY_KLIC_NESMI_DO_ZPRAVY_123"
printf 'RESEND_API_KEY=%s\nCIL_EMAIL=zalohy@example.test\n' "$TAJNE_KLIC" > "$K/.env"
printf 'TajneHesloZalohNesmiDoZpravy987' > "$K/.heslo-sifrovani"
export ZALOHA_KOREN="$K" SIM_OUTBOX="$TMP/outbox" SIM_DRIVE="$TMP/drive" KONTEJNER=detskekrucky-db MIN_VELIKOST_B=1000
mkdir -p "$SIM_OUTBOX" "$SIM_DRIVE"
emailu() { ls "$SIM_OUTBOX" | wc -l; }
posledni_predmet() { local f; f=$(ls "$SIM_OUTBOX" | tail -1); [ -n "$f" ] && grep -o '"subject":"[^"]*"' "$SIM_OUTBOX/$f" | head -1; }
zaloha() { (cd "$K" && ./zaloha.sh) >> "$TMP/zaloha.log" 2>&1; }
kontrola() { (cd "$K" && ./kontrola-zaloh.sh) >> "$TMP/kontrola.log" 2>&1; }
nahrat() { cp "$K"/zalohy/*.aes "$SIM_DRIVE/" 2>/dev/null; }   # jako zaloha-gdrive.sh
dnes="detskekrucky-$(date +%F).sql.gz.aes"
uprav_stav() { local klic="$1" posun="$2"; read -r s t < "$K/stav/upozorneni-$klic"; echo "$s $((t - posun))" > "$K/stav/upozorneni-$klic"; }

echo "1) uspesna zaloha + kontrola"
touch -d '40 days ago' "$K/zalohy/detskekrucky-2000-01-01.sql.gz.aes"    # stara (rotace)
zaloha; kod=$?
over "zaloha skoncila kodem 0" "[ $kod -eq 0 ]"
over "vznikl sifrovany soubor dne" "[ -s '$K/zalohy/$dnes' ] && head -c 8 '$K/zalohy/$dnes' | grep -q Salted__"
over "zadny nesifrovany ani docasny soubor" "! ls '$K'/zalohy | grep -qvE '\\.aes\$'"
over "zapsan stav posledni mistni zalohy" "grep -q '$dnes' '$K/stav/posledni-mistni-zaloha'"
over "stara zaloha (40 dni) po uspechu smazana rotaci" "[ ! -e '$K/zalohy/detskekrucky-2000-01-01.sql.gz.aes' ]"
over "odeslan jen e-mail se zalohou (1), zadne upozorneni" "[ \$(emailu) -eq 1 ] && posledni_predmet | grep -q 'Záloha databáze'"
nahrat; kontrola
over "kontrola OK: lokalni i mimo server, zadny dalsi e-mail" "grep -q 'lokalni=ok mimo_server=ok' '$K/stav/posledni-kontrola' && [ \$(emailu) -eq 1 ]"

echo "2) selhani pg_dump: upozorneni, posledni funkcni kopie zustava"
pred=$(md5sum < "$K/zalohy/$dnes"); rm -f "$K/zalohy/$dnes"; cp "$SIM_DRIVE/$dnes" "$K/zalohy/detskekrucky-1999-12-31.sql.gz.aes"; touch -d '2 hours ago' "$K/zalohy/detskekrucky-1999-12-31.sql.gz.aes"
touch -d '40 days ago' "$K/zalohy/detskekrucky-1999-01-01.sql.gz.aes"
SIM_DOCKER=fail zaloha; kod=$?
over "zaloha skoncila chybou" "[ $kod -ne 0 ]"
over "nevznikl soubor ani .tmp" "[ ! -e '$K/zalohy/$dnes' ] && ! ls '$K'/zalohy | grep -q tmp"
over "predchozi zaloha zustala" "[ -s '$K/zalohy/detskekrucky-1999-12-31.sql.gz.aes' ]"
over "rotace pri selhani nebezela (stara 40 dni zustala)" "[ -e '$K/zalohy/detskekrucky-1999-01-01.sql.gz.aes' ]"
over "odeslano upozorneni se jmenem kroku" "[ \$(emailu) -eq 2 ] && posledni_predmet | grep -q 'záloha databáze se nevytvořila' && grep -q 'pg_dump' '$SIM_OUTBOX/002.json'"
SIM_DOCKER=fail zaloha
over "opakovane selhani: zadne dalsi upozorneni (omezeni opakovani)" "[ \$(emailu) -eq 2 ]"
uprav_stav zaloha 90000; SIM_DOCKER=fail zaloha
over "po 24 h pripominka 'trvá'" "[ \$(emailu) -eq 3 ] && posledni_predmet | grep -q 'trvá'"
rm -f "$K/zalohy/detskekrucky-1999-01-01.sql.gz.aes"

echo "3) selhani sifrovani a neuplny dump"
SIM_OPENSSL=fail zaloha; kod=$?
over "selhani openssl = chyba, bez souboru" "[ $kod -ne 0 ] && [ ! -e '$K/zalohy/$dnes' ]"
SIM_DOCKER=neuplny zaloha; kod=$?
over "neuplny dump neprojde kontrolou" "[ $kod -ne 0 ] && [ ! -e '$K/zalohy/$dnes' ] && tail -3 '$TMP/zaloha.log' | grep -q 'kontrola dešifrování'"
mv "$K/.heslo-sifrovani" "$K/.heslo.bak"; zaloha; kod=$?; mv "$K/.heslo.bak" "$K/.heslo-sifrovani"
over "chybejici heslo = chyba (krok kontrola hesla)" "[ $kod -ne 0 ] && tail -3 '$TMP/zaloha.log' | grep -q 'kontrola hesla'"
over "behem trvajici chyby zadna dalsi upozorneni" "[ \$(emailu) -eq 3 ]"

echo "4) obnoveni zalohy"
zaloha; kod=$?
over "zaloha opet uspesna" "[ $kod -eq 0 ] && [ -s '$K/zalohy/$dnes' ]"
over "odeslano 'obnoveno' + e-mail se zalohou" "[ \$(emailu) -eq 5 ] && grep -l 'obnoveno: záloha databáze' '$SIM_OUTBOX'/*.json >/dev/null"

echo "5) kopie mimo server chybi / rclone selze (lokalni zaloha v poradku)"
rm -f "$SIM_DRIVE"/*; kontrola
over "lokalni ok, mimo server chyba" "grep -q 'lokalni=ok mimo_server=chyba' '$K/stav/posledni-kontrola'"
over "upozorneni na kopii mimo server" "[ \$(emailu) -eq 6 ] && posledni_predmet | grep -q 'kopie zálohy mimo server'"
SIM_RCLONE=fail kontrola
over "selhani rclone: stale chyba, bez noveho e-mailu" "grep -q 'mimo_server=chyba' '$K/stav/posledni-kontrola' && [ \$(emailu) -eq 6 ]"
echo "poskozeny" > "$SIM_DRIVE/$dnes"; kontrola
over "kopie na Disku se neshoduje (MD5) = chyba" "grep -q 'mimo_server=chyba' '$K/stav/posledni-kontrola'"
nahrat; kontrola
over "po nahrani 'obnoveno' pro kopii mimo server" "grep -q 'mimo_server=ok' '$K/stav/posledni-kontrola' && [ \$(emailu) -eq 7 ] && posledni_predmet | grep -q 'obnoveno: kopie zálohy mimo server'"

echo "6) uloha zalohy se vubec nespustila (stara zaloha) - nezavisla kontrola"
for f in "$K"/zalohy/*.aes "$SIM_DRIVE"/*.aes; do touch -d '30 hours ago' "$f"; done
kontrola
over "lokalni chyba (stari), mimo server chyba (zadna cerstva kopie)" "grep -q 'lokalni=chyba mimo_server=chyba' '$K/stav/posledni-kontrola'"
over "dve oddelena upozorneni (server a mimo server)" "[ \$(emailu) -eq 9 ] && grep -l 'záloha na serveru' '$SIM_OUTBOX/008.json' '$SIM_OUTBOX/009.json' >/dev/null && grep -l 'stará 30 h' '$SIM_OUTBOX'/00[89].json >/dev/null"
kontrola
over "dalsi hodinova kontrola nic neopakuje" "[ \$(emailu) -eq 9 ]"
rm -f "$K"/zalohy/*.aes; kontrola
over "zadna zaloha na serveru = chyba (bez noveho e-mailu, uz hlaseno)" "grep -q 'lokalni=chyba' '$K/stav/posledni-kontrola' && [ \$(emailu) -eq 9 ]"

echo "7) upozorneni nejde odeslat (Resend vypadek) - zkusi se znovu"
zaloha >/dev/null; nahrat; kontrola   # obnoveno (2 zpravy) + e-mail zalohy
n=$(emailu)
rm -f "$SIM_DRIVE"/*; SIM_CURL_KOD=500 kontrola
over "pri chybe Resend se stav nezapsal jako odeslany" "grep -q '^ok' '$K/stav/upozorneni-mimo_server'"
kontrola
over "pri dalsim behu se upozorneni odeslalo" "grep -q '^chyba' '$K/stav/upozorneni-mimo_server' && [ \$(emailu) -ge \$((n + 2)) ]"

echo "8) zpravy neobsahuji tajne udaje ani data zakazniku"
over "zadna zprava neobsahuje heslo k zaloham" "! grep -rq 'TajneHesloZaloh' '$SIM_OUTBOX'"
over "zadna zprava neobsahuje klic Resend" "! grep -rq '$TAJNE_KLIC' '$SIM_OUTBOX'"
over "upozorneni neobsahuji data z dumpu" "! grep -l '⚠️\\|obnoveno' '$SIM_OUTBOX'/*.json | xargs grep -q 'Jana Testovaci\\|zakaznik.test\\|INSERT INTO'"
over "priloha e-mailu se zalohou je sifrovana (base64 'Salted__')" "grep -l 'attachments' '$SIM_OUTBOX'/*.json | head -1 | xargs grep -q '\"content\":\"U2FsdGVkX1'"

echo
echo "Testu: $TESTU, selhalo: $SELHANI"
[ "$SELHANI" -eq 0 ]
