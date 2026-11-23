# A6 P-1: gemeinsame Bausteine des Workflows agent-auftrag.yml. Entwurf, Ziel .github/agent/a6-funktionen.sh.
#
# Wird nie ausgefuehrt, nur geladen (source), und nur nachdem der Workflow den SHA-256 dieser Datei mit dem
# inline genehmigten Wert verglichen hat. Live-Pfad und Generalprobe laden dieselbe Datei; es gibt jeden
# Baustein genau einmal.
#
# Erwartete Umgebung (vom Workflow gesetzt): A6_NODE_IMAGE, A6_NODE_VERSION, A6_PROXY_IMAGE,
# A6_INTEGRITAET_SHA256, A6_ATTRAPPE_SHA256, A6_PROBE_SHA256, A6_ERSATZ_SHA256, A6_CC_VERSION, A6_EINSTELLUNGEN_SHA256,
# A6_PROTOKOLL_SHA256 (P-4), GITHUB_WORKSPACE, RUNNER_TEMP, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.

# Laedt ein Image mit festem Digest und prueft, dass genau dieser Digest vorliegt.
a6_image_laden() {
  local image="$1"
  local digests
  [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "A6-START image-ohne-digest" >&2; return 1; }
  docker pull --quiet "$image" > /dev/null
  digests="$(docker image inspect "$image" --format '{{json .RepoDigests}}')"
  [[ "$digests" == *"$image"* ]] || { echo "A6-START image-digest" >&2; return 1; }
}

# Startblock fuer jeden Job-Einstieg. Node laeuft nur im festen Image, mit festem PATH und festem Git aus
# dem Image, ohne geerbte Umgebung (docker run uebernimmt nur die genannten Namen), ohne Rechte, mit nur
# lesbarem Checkout. Im selben Container und ohne Zwischenschritt: Node-Version, aeusserer Anker des
# Integritaetspruefers, optional Anker des Vorlademoduls der Probe, Integritaetspruefer, Einstieg.
#   a6_container NETZ VORLADEN SKRIPT NAME...
# NETZ: none oder bridge. VORLADEN: leer im Live-Pfad, generalprobe/github-attrappe.mjs nur in der Probe.
a6_container() {
  local netz="$1" vorladen="$2" skript="$3"
  shift 3
  local name
  local umgebung=()
  [[ "$netz" == "none" || "$netz" == "bridge" ]] || { echo "A6-START netz" >&2; return 1; }
  [[ -z "$vorladen" || "$vorladen" == "generalprobe/github-attrappe.mjs" ]] || { echo "A6-START vorladen" >&2; return 1; }
  [[ "$skript" =~ ^agent-code-job-(auftrag|claude-vor|claude-nach|abnahme|veroeffentlichen)\.mjs$ ]] || { echo "A6-START skript" >&2; return 1; }

  for name in GITHUB_WORKSPACE RUNNER_TEMP "$@"; do
    [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ && "$name" != PATH && "$name" != NODE_* ]] || { echo "A6-START name" >&2; return 1; }
    umgebung+=(--env "$name")
  done

  a6_mitschnitt docker run --rm --pull=never --network "$netz" --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2 \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777 \
    --mount "type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly" \
    --mount "type=bind,src=$RUNNER_TEMP,dst=$RUNNER_TEMP" \
    --workdir "$GITHUB_WORKSPACE" --env PATH=/usr/local/bin:/usr/bin:/bin \
    "${umgebung[@]}" "$A6_NODE_IMAGE" /bin/sh -euc '
      # Das Image setzt NODE_VERSION und YARN_VERSION selbst; der Stolperdraht der Einstiege lehnt jede
      # NODE_-Variable ab. Beide entfernen und danach pruefen, dass keine NODE_-Variable uebrig ist.
      unset NODE_VERSION YARN_VERSION
      if env | grep -q "^NODE_"; then echo "A6-START node-umgebung" >&2; exit 1; fi
      [ "$(node --version)" = "$1" ] || { echo "A6-START node-version" >&2; exit 1; }
      printf "%s  %s\n" "$2" scripts/agent-code-integritaet.mjs | sha256sum -c --status || { echo "A6-START anker" >&2; exit 1; }
      if [ -n "$3" ]; then
        printf "%s  %s\n" "$4" "$3" | sha256sum -c --status || { echo "A6-START anker-vorladen" >&2; exit 1; }
      fi
      node scripts/agent-code-integritaet.mjs
      if [ -n "$3" ]; then
        exec node --import "./$3" "scripts/$5"
      fi
      exec node "scripts/$5"
    ' a6 "$A6_NODE_VERSION" "$A6_INTEGRITAET_SHA256" "$vorladen" "$A6_ATTRAPPE_SHA256" "$skript"
}

# Harness der Generalprobe im festen Image, ohne Netz. Nur Probejobs.
a6_probe() {
  docker run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 512 --memory 3g --cpus 2 \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
    --mount "type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly" \
    --mount "type=bind,src=$RUNNER_TEMP,dst=$RUNNER_TEMP" \
    --workdir "$GITHUB_WORKSPACE" --env PATH=/usr/local/bin:/usr/bin:/bin --env HOME=/tmp \
    --env A6_INTEGRITAET_SHA256 "$A6_NODE_IMAGE" /bin/sh -euc '
      printf "%s  %s\n" "$1" generalprobe/probe.mjs "$2" generalprobe/github-attrappe.mjs "$3" generalprobe/claude-ersatz.mjs | sha256sum -c --status || { echo "A6-START anker-probe" >&2; exit 1; }
      shift 3
      exec node generalprobe/probe.mjs "$@"
    ' a6 "$A6_PROBE_SHA256" "$A6_ATTRAPPE_SHA256" "$A6_ERSATZ_SHA256" "$@"
}

# Liest kontrakt.env der Probe in die aktuelle Shell. Nur NAME=Wert mit erlaubten Zeichen, PATH nie.
a6_kontrakt_laden() {
  local zeile name wert
  while IFS= read -r zeile; do
    [[ "$zeile" =~ ^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_./:@=+-]+)$ ]] || { echo "A6-PROBE kontrakt" >&2; return 1; }
    name="${BASH_REMATCH[1]}"
    wert="${BASH_REMATCH[2]}"
    [[ "$name" != PATH && "$name" != NODE_* ]] || { echo "A6-PROBE kontrakt-name" >&2; return 1; }
    export "$name=$wert"
  done < "$1"
}

a6_lauf() {
  printf '%s-%s' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
}

# Installiert Claude Code genau aus der geschuetzten Sperrdatei (sha512 je Paket), ohne Schluessel.
# Netz nur fuer npm ci; das Verlinken der Plattformdatei (install.cjs) und die Versionspruefung ohne Netz.
#   a6_claude_installieren CHECKOUT ZIEL
a6_claude_installieren() {
  local checkout="$1" ziel="$2"
  local version
  mkdir -p "$ziel/app"
  cp "$checkout/.github/agent/claude-code/package.json" "$checkout/.github/agent/claude-code/package-lock.json" "$ziel/app/"
  docker run --rm --pull=never --network bridge --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777 \
    --mount "type=bind,src=$ziel/app,dst=/install" --workdir /install \
    --env HOME=/tmp --env PATH=/usr/local/bin:/usr/bin:/bin --env npm_config_cache=/tmp/npm \
    "$A6_NODE_IMAGE" npm ci --ignore-scripts --no-audit --no-fund --loglevel=error > /dev/null
  docker run --rm --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
    --mount "type=bind,src=$ziel/app,dst=/install" --workdir /install \
    --env HOME=/tmp --env PATH=/usr/local/bin:/usr/bin:/bin \
    "$A6_NODE_IMAGE" node node_modules/@anthropic-ai/claude-code/install.cjs > /dev/null
  version="$(docker run --rm --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
    --mount "type=bind,src=$ziel/app,dst=/opt/claude-code,readonly" \
    --env HOME=/tmp --env PATH=/usr/local/bin:/usr/bin:/bin --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    "$A6_NODE_IMAGE" /opt/claude-code/node_modules/.bin/claude --version)"
  [[ "$version" == "$A6_CC_VERSION (Claude Code)" ]] || { echo "A6-CLAUDE version" >&2; return 1; }
}

# Grenzen fuer Claude aus dem gebundenen Profil, gedeckelt durch die Policy. Setzt A6_MODELL, A6_RUNDEN,
# A6_BUDGET, A6_LAUFZEIT und A6_DATEIEN (JSON-Liste). Das Profil ergibt sich aus dem einzigen
# agent:-Label im Schnappschuss, den Job 1a zuvor gegen den Hash aus Job 0 geprueft hat.
#   a6_grenzen CHECKOUT SCHNAPPSCHUSS
a6_grenzen() {
  local checkout="$1" schnappschuss="$2"
  local id profil policy
  id="$(jq -r '[.issue.labels[].name | select(startswith("agent:"))] | if length == 1 then .[0][6:] else "" end' "$schnappschuss")"
  [[ "$id" =~ ^[a-z][a-z0-9-]{1,38}[a-z0-9]$ ]] || { echo "A6-CLAUDE profil-id" >&2; return 1; }
  profil="$checkout/agent-profiles/$id.json"
  policy="$checkout/.github/agent/policy.json"
  [[ -f "$profil" && ! -L "$profil" && -f "$policy" && ! -L "$policy" ]] || { echo "A6-CLAUDE profil-datei" >&2; return 1; }
  jq -e --slurpfile p "$policy" '
    .aktiv == true and (.modell | IN($p[0].modelle[])) and
    (.max_runden | type == "number" and . == floor and . >= 1) and
    (.budget_usd | type == "number" and . > 0) and
    (.max_laufzeit_minuten | type == "number" and . == floor and . >= 1) and
    (.dateien | type == "array" and length >= 1 and length <= $p[0].max_dateien and all(test("^(src|test)/[A-Za-z0-9._-]+$")))
  ' "$profil" > /dev/null || { echo "A6-CLAUDE profil-werte" >&2; return 1; }
  A6_MODELL="$(jq -r .modell "$profil")"
  A6_RUNDEN="$(jq -r --slurpfile p "$policy" '[.max_runden, $p[0].max_runden] | min' "$profil")"
  A6_BUDGET="$(jq -r --slurpfile p "$policy" '[.budget_usd, $p[0].max_budget_usd] | min' "$profil")"
  A6_LAUFZEIT="$(jq -r --slurpfile p "$policy" '[.max_laufzeit_minuten, $p[0].max_laufzeit_minuten] | min' "$profil")"
  A6_DATEIEN="$(jq -c '.dateien | sort' "$profil")"
}

# Claude-Einstellungen: geschuetzte Basis (allow leer, 38 Verbote) plus allow nur fuer die Profildateien,
# je Read und Edit mit Pfad. Die Pfade gelten relativ zu /arbeit im Claude-Container, also zur Sicht.
# Hintergrund (Befund P-1): prepareWorkspace legt im Arbeitsordner a6-claude-arbeit den ganzen Baum des
# Ausgangscommits an. Claude bekommt deshalb nie diesen Ordner, sondern nur die Sicht (a6_sicht_anlegen).
# Geprueft wird hier: jede Profildatei ist im Arbeitsordner eine gewoehnliche Datei, und es gibt kein .git.
#   a6_einstellungen CHECKOUT ARBEIT ZIEL
# Die Basis muss genau die geschuetzte Datei mit dem inline genehmigten SHA-256 A6_EINSTELLUNGEN_SHA256 sein.
# Erzeugt wird ohne jq: der einzige Eintrag "allow": [], wird durch die Pfadregeln ersetzt, alles andere
# bleibt byte-gleich.
a6_einstellungen() {
  local checkout="$1" arbeit="$2" ziel="$3"
  local datei pfade basis regeln="" leer='"allow": [],'
  pfade="$(a6_profilpfade)" || return 1
  [[ ! -e "$arbeit/.git" && ! -L "$arbeit/.git" ]] || { echo "A6-CLAUDE arbeitsordner-git" >&2; return 1; }
  while IFS= read -r datei; do
    a6_echte_datei "$arbeit" "$datei" || { echo "A6-CLAUDE arbeitsordner $datei" >&2; return 1; }
    regeln+="${regeln:+, }\"Read(./$datei)\", \"Edit(./$datei)\""
  done <<< "$pfade"
  printf '%s  %s\n' "$A6_EINSTELLUNGEN_SHA256" "$checkout/.github/agent/claude-settings.json" | sha256sum -c --status \
    || { echo "A6-CLAUDE einstellungen-basis" >&2; return 1; }
  basis="$(cat "$checkout/.github/agent/claude-settings.json"; printf x)"
  basis="${basis%x}"
  [[ "$basis" == *"$leer"* && "${basis#*"$leer"}" != *"$leer"* ]] || { echo "A6-CLAUDE einstellungen-allow" >&2; return 1; }
  mkdir -p "$(dirname "$ziel")"
  printf '%s' "${basis/"$leer"/"\"allow\": [$regeln],"}" > "$ziel"
}

# ---------------------------------------------------------------------------------------------------
# Sicht fuer Claude: physisch getrennter Ordner nur mit den Profildateien
# ---------------------------------------------------------------------------------------------------
# Die Sicht liegt als eigener Ordner direkt unter RUNNER_TEMP neben a6-claude-arbeit und wird je Lauf neu
# und leer angelegt. Sie enthaelt genau die Profildateien (A6_DATEIEN, Form src/<name> oder test/<name>)
# unter denselben relativen Pfaden, sodass Read(./...) und Edit(./...) unveraendert greifen. Nur sie wird
# beschreibbar in den Claude-Container eingebunden. a6-claude-arbeit und die unabhaengige Pruefung in
# Job 1b bleiben unveraendert.

# Gewoehnliche Datei unter einem echten Wurzelordner: Elternordner echtes Verzeichnis, Datei kein Symlink,
# genau ein Link.
#   a6_echte_datei WURZEL PFAD
a6_echte_datei() {
  local wurzel="$1" datei="$2"
  [[ -d "$wurzel" && ! -L "$wurzel" ]] || return 1
  [[ -d "$wurzel/${datei%/*}" && ! -L "$wurzel/${datei%/*}" ]] || return 1
  [[ -f "$wurzel/$datei" && ! -L "$wurzel/$datei" ]] || return 1
  [[ "$(stat -c %h -- "$wurzel/$datei")" == "1" ]] || return 1
}

# Profilpfade aus A6_DATEIEN (kompakte JSON-Liste aus a6_grenzen), ohne jq und streng: jeder Eintrag genau
# src/<name> oder test/<name>, kein Name beginnt mit einem Punkt.
a6_profilpfade() {
  local eintrag='"(src|test)/[A-Za-z0-9_-][A-Za-z0-9._-]*"'
  local datei rest
  [[ "$A6_DATEIEN" =~ ^\[$eintrag(,$eintrag)*\]$ ]] || { echo "A6-SICHT profil" >&2; return 1; }
  rest="${A6_DATEIEN:1:${#A6_DATEIEN}-2}"
  while IFS= read -r datei; do
    datei="${datei#\"}"
    datei="${datei%\"}"
    [[ "$datei" =~ ^(src|test)/[A-Za-z0-9_-][A-Za-z0-9._-]*$ ]] || { echo "A6-SICHT pfad" >&2; return 1; }
    printf '%s\n' "$datei"
  done <<< "${rest//,/$'\n'}"
}

#   a6_sicht_anlegen ARBEIT SICHT
a6_sicht_anlegen() {
  local arbeit="$1" sicht="$2" datei pfade
  pfade="$(a6_profilpfade)" || return 1
  [[ ! -e "$sicht" && ! -L "$sicht" ]] || { echo "A6-SICHT vorhanden" >&2; return 1; }
  mkdir -m 0700 "$sicht"
  while IFS= read -r datei; do
    a6_echte_datei "$arbeit" "$datei" || { echo "A6-SICHT quelle" >&2; return 1; }
    [[ -d "$sicht/${datei%/*}" ]] || mkdir -m 0700 "$sicht/${datei%/*}"
    ( set -C; cat -- "$arbeit/$datei" > "$sicht/$datei" ) || { echo "A6-SICHT kopie" >&2; return 1; }
    chmod 0600 "$sicht/$datei"
  done <<< "$pfade"
}

# Nach dem Claude-Lauf: Die Sicht enthaelt exakt die Elternordner und die Profildateien, nichts sonst (auch
# nichts Verstecktes), jede Profildatei gewoehnlich und mit genau einem Link, jeder Ordner ein echtes
# Verzeichnis. Jede Abweichung bricht ab.
#   a6_sicht_pruefen SICHT
a6_sicht_pruefen() {
  local sicht="$1" pfade ist soll
  pfade="$(a6_profilpfade)" || return 1
  [[ -d "$sicht" && ! -L "$sicht" ]] || { echo "A6-SICHT ordner" >&2; return 1; }
  if [[ -n "$(find "$sicht" -mindepth 1 -name $'*\n*' -print -quit)" ]]; then
    echo "A6-SICHT name" >&2
    return 1
  fi
  ist="$(find "$sicht" -mindepth 1 \( -type d -printf 'd %P\n' \) -o -printf '%y %n %P\n' | LC_ALL=C sort)"
  soll="$( { cut -d/ -f1 <<< "$pfade" | LC_ALL=C sort -u | sed 's/^/d /'; sed 's/^/f 1 /' <<< "$pfade"; } | LC_ALL=C sort)"
  [[ "$ist" == "$soll" ]] || { echo "A6-SICHT inhalt" >&2; return 1; }
}

# Prueft, dass kein Claude-Container mehr existiert (auch kein angehaltener).
a6_claude_beendet() {
  [[ -z "$(docker ps -aq --filter 'name=^a6-claude-')" ]] || { echo "A6-SICHT claude-laeuft" >&2; return 1; }
}

# Erst vollstaendige Pruefung der Sicht und aller Ziele, dann Rueckkopie der Bytes nur in die vorhandenen
# Profilpfade von a6-claude-arbeit. Dort entsteht nichts Neues.
#   a6_sicht_uebernehmen ARBEIT SICHT
a6_sicht_uebernehmen() {
  local arbeit="$1" sicht="$2" datei pfade
  a6_sicht_pruefen "$sicht" || return 1
  pfade="$(a6_profilpfade)" || return 1
  while IFS= read -r datei; do
    a6_echte_datei "$arbeit" "$datei" || { echo "A6-SICHT ziel" >&2; return 1; }
    a6_echte_datei "$sicht" "$datei" || { echo "A6-SICHT inhalt" >&2; return 1; }
  done <<< "$pfade"
  while IFS= read -r datei; do
    cat -- "$sicht/$datei" > "$arbeit/$datei"
    cmp -s -- "$sicht/$datei" "$arbeit/$datei" || { echo "A6-SICHT rueckkopie" >&2; return 1; }
  done <<< "$pfade"
}

# Vorschaltcontainer: zwei Netze, Schluessel nur hier (aus der Umgebung des Aufrufers, nie auf der
# Kommandozeile), festes Ziel api.anthropic.com, nur POST /v1/messages und /v1/messages/count_tokens.
a6_proxy_starten() {
  local lauf ordner code i
  lauf="$(a6_lauf)"
  ordner="$RUNNER_TEMP/a6-proxy"
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] || { echo "A6-PROXY schluessel" >&2; return 1; }
  mkdir -p "$ordner"
  cat > "$ordner/default.conf.template" <<'A6_PROXY_KONFIGURATION'
# Nur POST /v1/messages und POST /v1/messages/count_tokens, Ziel fest api.anthropic.com.
log_format a6p '$remote_addr "$request" uri=$uri args=$args status=$status '
               'upstream=$upstream_addr upstream_status=$upstream_status bytes=$body_bytes_sent';
resolver 127.0.0.11 ipv6=off valid=60s;
resolver_timeout 5s;

upstream anthropic_api {
    zone anthropic_api 64k;
    server api.anthropic.com:443 resolve;
    keepalive 8;
}

server {
    listen 8080 default_server;
    server_name _;
    server_tokens off;
    access_log /dev/stdout a6p;

    client_max_body_size 32m;
    client_body_buffer_size 1m;
    client_header_timeout 10s;
    client_body_timeout 30s;
    send_timeout 600s;
    keepalive_timeout 30s;
    large_client_header_buffers 4 16k;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host api.anthropic.com;
    proxy_set_header Authorization "";
    proxy_set_header Proxy-Authorization "";
    proxy_set_header Cookie "";
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Real-IP "";
    proxy_set_header x-api-key "${ANTHROPIC_API_KEY}";
    proxy_hide_header Set-Cookie;
    proxy_redirect off;
    proxy_buffering off;
    proxy_request_buffering on;
    proxy_intercept_errors off;
    proxy_next_upstream off;
    proxy_connect_timeout 10s;
    proxy_send_timeout 60s;
    proxy_read_timeout 600s;
    proxy_ssl_server_name on;
    proxy_ssl_name api.anthropic.com;
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 3;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_protocols TLSv1.2 TLSv1.3;
    proxy_ssl_session_reuse on;

    location = /v1/messages {
        limit_except POST { deny all; }
        proxy_pass https://anthropic_api/v1/messages;
    }

    location = /v1/messages/count_tokens {
        limit_except POST { deny all; }
        proxy_pass https://anthropic_api/v1/messages/count_tokens;
    }

    location / {
        return 403;
    }
}
A6_PROXY_KONFIGURATION
  docker network create --internal "a6-intern-$lauf" > /dev/null
  docker network create "a6-aussen-$lauf" > /dev/null
  docker run -d --name "a6-proxy-$lauf" --network "a6-aussen-$lauf" --pull=never --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 101:101 --memory 128m --memory-swap 128m --pids-limit 64 --cpus 1 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,uid=101,gid=101,mode=0700 \
    --tmpfs /var/cache/nginx:rw,nosuid,nodev,noexec,size=16m,uid=101,gid=101,mode=0700 \
    --tmpfs /var/run:rw,nosuid,nodev,noexec,size=1m,uid=101,gid=101,mode=0700 \
    --tmpfs /etc/nginx/conf.d:rw,nosuid,nodev,noexec,size=1m,uid=101,gid=101,mode=0700 \
    --env ANTHROPIC_API_KEY --env 'NGINX_ENVSUBST_FILTER=^ANTHROPIC_API_KEY$' \
    --mount "type=bind,src=$ordner/default.conf.template,dst=/etc/nginx/templates/default.conf.template,readonly" \
    "$A6_PROXY_IMAGE" > /dev/null
  docker network connect --alias a6-proxy "a6-intern-$lauf" "a6-proxy-$lauf"

  for i in $(seq 1 30); do
    code="$(docker run --rm --pull=never --network "a6-intern-$lauf" --read-only --cap-drop ALL \
      --security-opt no-new-privileges --user 1000:1000 "$A6_NODE_IMAGE" \
      curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://a6-proxy:8080/ || true)"
    [[ "$code" == "403" ]] && return 0
    sleep 1
  done

  echo "A6-PROXY nicht-bereit" >&2
  return 1
}

# Der Container, in dem Claude laeuft (und in der Probe der Ersatz): nur am internen Netz, nur der
# Sicht (a6-claude-sicht, nur Profildateien) beschreibbar, Zusatz-Einhaengungen nur lesbar ueber das Feld A6_EINHAENGEN, kein Token,
# nur ein Platzhalter als Schluessel. Zeitlimit A6_ZEITLIMIT (z. B. 15m), danach wird der Container entfernt.
#   a6_claude_container BEFEHL...
a6_claude_container() {
  local lauf status=0
  lauf="$(a6_lauf)"
  timeout --kill-after=30s "$A6_ZEITLIMIT" docker run --rm -i --name "a6-claude-$lauf" \
    --network "a6-intern-$lauf" --pull=never --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2 \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
    --mount "type=bind,src=$RUNNER_TEMP/a6-claude-sicht,dst=/arbeit" \
    "${A6_EINHAENGEN[@]}" --workdir /arbeit \
    --env HOME=/tmp --env PATH=/usr/local/bin:/usr/bin:/bin \
    --env ANTHROPIC_BASE_URL=http://a6-proxy:8080 \
    --env ANTHROPIC_API_KEY=a6-platzhalter-kein-schluessel \
    --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --env DISABLE_AUTOUPDATER=1 \
    "$A6_NODE_IMAGE" "$@" || status=$?
  docker rm -f "a6-claude-$lauf" > /dev/null 2>&1 || true
  return "$status"
}

# Der Claude-Aufruf mit allen drei Schichten aus dem Plan (Abschnitt 0, Punkt 2). Prompt ueber stdin,
# weil --tools variadisch ist. Ausgabe stream-json in die Protokolldatei.
#   a6_claude_aufruf PROTOKOLL < PROMPT
a6_claude_aufruf() {
  local protokoll="$1"
  A6_EINHAENGEN=(
    --mount "type=bind,src=$RUNNER_TEMP/a6-claude-code/app,dst=/opt/claude-code,readonly"
    --mount "type=bind,src=$RUNNER_TEMP/a6-claude-einstellungen/settings.json,dst=/opt/a6/settings.json,readonly"
  )
  a6_claude_container /opt/claude-code/node_modules/.bin/claude -p \
    --tools "Read,Edit" \
    --settings /opt/a6/settings.json \
    --setting-sources "" \
    --strict-mcp-config \
    --permission-mode dontAsk \
    --model "$A6_MODELL" \
    --max-turns "$A6_RUNDEN" \
    --max-budget-usd "$A6_BUDGET" \
    --no-session-persistence \
    --output-format stream-json \
    --verbose > "$protokoll"
}

# K1a: wertet das Claude-Protokoll aus (P-4). Der Auswerter .github/agent/a6-protokoll.mjs laeuft nur nach dem
# Vergleich mit dem inline genehmigten A6_PROTOKOLL_SHA256, im festen Image, ohne Netz, ohne Rechte, mit dem
# Protokoll nur lesbar. Er gibt nur feste Kennungen aus. Exitcode 0 nur bei vollstaendigem Protokoll ohne
# Alarm; jeder andere Wert ist ein Fehlschlag. Die Funktion entscheidet nie ueber den Claude-Aufruf selbst.
#   a6_protokoll_auswerten PROTOKOLL
a6_protokoll_auswerten() {
  local protokoll="$1" auswerter="$GITHUB_WORKSPACE/.github/agent/a6-protokoll.mjs" status=0
  local einhaengen=(--mount "type=bind,src=$auswerter,dst=/opt/a6/a6-protokoll.mjs,readonly")
  printf '%s  %s\n' "$A6_PROTOKOLL_SHA256" "$auswerter" | sha256sum -c --status \
    || { echo "A6-DIAGNOSE anker"; return 2; }
  if [[ -f "$protokoll" && ! -L "$protokoll" ]]; then
    einhaengen+=(--mount "type=bind,src=$protokoll,dst=/opt/a6/protokoll.jsonl,readonly")
  fi
  docker run --rm --pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 64 --memory 512m --cpus 1 --user "$(id -u):$(id -g)" \
    "${einhaengen[@]}" --env "A6_DATEIEN=${A6_DATEIEN:-}" --env PATH=/usr/local/bin:/usr/bin:/bin \
    "$A6_NODE_IMAGE" node /opt/a6/a6-protokoll.mjs /opt/a6/protokoll.jsonl || status=$?
  return "$status"
}

# Raeumt Claude-Container, Vorschaltcontainer und beide Netze ab. Darf immer laufen.
a6_aufraeumen() {
  local lauf
  lauf="$(a6_lauf)"
  docker rm -f "a6-claude-$lauf" "a6-proxy-$lauf" > /dev/null 2>&1 || true
  docker network rm "a6-intern-$lauf" "a6-aussen-$lauf" > /dev/null 2>&1 || true
}

# Sammelpruefung: jedes Paar name=ergebnis muss success sein, sonst eine Zeile je Abweichung und rot.
#   a6_sammel NAME=ERGEBNIS...
a6_sammel() {
  local paar fehler=0
  (( $# > 0 )) || { echo "SAMMEL-FEHLER keine Pflichtjobs"; return 1; }
  for paar in "$@"; do
    [[ "$paar" =~ ^[a-z0-9_]+=[a-z]*$ ]] || { echo "SAMMEL-FEHLER Eingabe"; return 1; }
    if [[ "${paar#*=}" != "success" ]]; then
      echo "SAMMEL-FEHLER ${paar%%=*}: ${paar#*=}"
      fehler=1
    fi
  done
  return "$fehler"
}

# Gegenstueck fuer den PR-Fall: jedes Paar muss skipped sein (Live-Pfad bewusst aus).
a6_sammel_uebersprungen() {
  local paar fehler=0
  (( $# > 0 )) || { echo "SAMMEL-FEHLER keine Live-Jobs"; return 1; }
  for paar in "$@"; do
    [[ "$paar" =~ ^[a-z0-9_]+=[a-z]*$ ]] || { echo "SAMMEL-FEHLER Eingabe"; return 1; }
    if [[ "${paar#*=}" != "skipped" ]]; then
      echo "SAMMEL-FEHLER ${paar%%=*} lief auf einem PR: ${paar#*=}"
      fehler=1
    fi
  done
  return "$fehler"
}

# ---------------------------------------------------------------------------------------------------
# B1.2 Job-Zusammenfassungen: Mitschnitt der Fehlerzeile (K5, K6, K8, K9) und Berichtsstarter (K1, K7)
# ---------------------------------------------------------------------------------------------------
# a6_container startet den Einstiegscontainer ueber a6_mitschnitt; das ist dort die einzige Aenderung.
# stdout bleibt unberuehrt. stderr laeuft ueber ein benanntes Rohr an tee, das jede Zeile sofort ins Log
# weitergibt und zugleich mitschreibt. Erst nach dem Ende von tee werden die Zeilen ^A6-FEHLER <code>$ aus
# den ersten 64 KB an a6-bericht/fehler angehaengt und genau eine Statuszeile an a6-bericht/status. Jeder
# Erfassungsfehler laesst den Aufruf unveraendert: gleiche Bytes, gleicher Exitcode, keine neue Logzeile.
# Kein Baustein dieses Blocks laedt ein Image oder braucht Netz.

# Eigentuemer ist der eigene effektive Nutzer. Gleiche Bedeutung wie -O, aber ueber stat und id ausgedrueckt,
# damit ein fremder Eigentuemer ohne Rechte pruefbar ist (Test mit einem anderen effektiven Nutzer).
#   a6_bericht_eigen PFAD
a6_bericht_eigen() {
  local besitzer="" ich=""
  besitzer="$(stat -c %u -- "$1" 2> /dev/null)" || besitzer=""
  ich="$(id -u 2> /dev/null)" || ich=""
  if [[ "$besitzer" =~ ^[0-9]+$ && "$besitzer" == "$ich" ]]; then
    return 0
  fi
  return 1
}

# Berichtsordner: echtes Verzeichnis unter RUNNER_TEMP, kein Link, eigener Nutzer, beschreibbar.
#   a6_bericht_ordner ORDNER
a6_bericht_ordner() {
  local ordner="$1"
  if [[ -L "$ordner" ]]; then
    return 1
  fi
  if ! mkdir -p -- "$ordner" 2> /dev/null; then
    return 1
  fi
  if [[ -d "$ordner" && ! -L "$ordner" && -w "$ordner" ]] && a6_bericht_eigen "$ordner"; then
    return 0
  fi
  return 1
}

#   a6_mitschnitt BEFEHL...
a6_mitschnitt() {
  local basis="$RUNNER_TEMP/a6-bericht" tmp="" echt="" basis_echt="" schreiber="" lese="" leser="" zeilen=""
  local rc=0 tee_rc=0 status=unvollstaendig groesse=""

  # K5 und K8: ohne brauchbaren Berichtsordner laeuft der Einstieg genau wie bisher, ohne Erfassung.
  if ! a6_bericht_ordner "$basis"; then
    "$@" || rc=$?
    return "$rc"
  fi

  # K8: je Aufruf ein mit mktemp -d tatsaechlich angelegtes privates Verzeichnis (Modus 700) unter dem
  # Berichtsordner, darin das Rohr mit Modus 600. tee muss vorab laufen, sonst gingen Logzeilen verloren.
  # K9: Die Elternshell oeffnet zuerst den Schreib-Endpunkt (lesend und schreibend, blockiert nie) und dann
  # das Leseende selbst (blockiert nicht, weil ein Schreiber offen ist). Jeder Fehlschlag: ohne Erfassung.
  tmp="$(mktemp -d "$basis/lauf.XXXXXXXX" 2> /dev/null)" || tmp=""
  if [[ -n "$tmp" ]]; then
    basis_echt="$(realpath -e -- "$basis" 2> /dev/null)" || basis_echt=""
    echt="$(realpath -e -- "$tmp" 2> /dev/null)" || echt=""
  fi
  if [[ -z "$tmp" || -z "$basis_echt" || "$echt" != "$basis_echt"/lauf.* || -L "$tmp" || ! -d "$tmp" ]] \
    || [[ "$(stat -c %a -- "$tmp" 2> /dev/null)" != "700" ]] \
    || ! tee --output-error=warn -- /dev/null < /dev/null > /dev/null 2>&1 \
    || ! mkfifo -m 600 -- "$tmp/rohr" 2> /dev/null \
    || ! { exec {schreiber}<> "$tmp/rohr"; } 2> /dev/null \
    || ! { exec {lese}< "$tmp/rohr"; } 2> /dev/null; then
    if [[ "$schreiber" =~ ^[0-9]+$ ]]; then
      exec {schreiber}>&-
    fi
    if [[ "$lese" =~ ^[0-9]+$ ]]; then
      exec {lese}<&-
    fi
    # Geloescht wird nur ein geprueftes privates Verzeichnis unter dem Berichtsordner, nie ein fremder Pfad.
    if [[ -n "$tmp" && -n "$basis_echt" && "$echt" == "$basis_echt"/lauf.* && ! -L "$tmp" ]]; then
      rm -rf -- "$tmp" 2> /dev/null || true
    fi
    printf '%s\n' unvollstaendig >> "$basis/status" 2> /dev/null || true
    "$@" || rc=$?
    return "$rc"
  fi

  # K6 und K9: tee erbt das Leseende beim Start des Hintergrundprozesses. Ab da hat das Rohr immer einen
  # Leser: kein Byte geht verloren, auch wenn tee erst nach dem Ende des Befehls zum Zug kommt, und tee sieht
  # das Ende, sobald der letzte Schreiber schliesst. Die Elternshell schliesst ihr Leseende danach sofort.
  # tee gibt jede Zeile sofort an die eigene stderr (das Log) weiter; seine eigenen Meldungen gehen nach
  # tee-fehler, nie ins Log. --output-error=warn: ein Schreibfehler im Mitschnitt bricht die Weitergabe nicht ab.
  tee --output-error=warn "$tmp/mitschnitt" <&"$lese" >&2 2> "$tmp/tee-fehler" {schreiber}>&- {lese}<&- &
  leser=$!
  exec {lese}<&-
  "$@" 2>&"$schreiber" {schreiber}>&- || rc=$?
  exec {schreiber}>&-
  wait "$leser" || tee_rc=$?

  # K9: erfasst nur, wenn tee mit 0 endet, tee-fehler leer ist und der Mitschnitt hoechstens 64 KB hat.
  # Exitcode 126 oder 127 heisst: der Befehl startete gar nicht (Startfehler), also nie erfasst.
  if [[ "$rc" != "126" && "$rc" != "127" && "$tee_rc" == "0" && -f "$tmp/tee-fehler" && ! -s "$tmp/tee-fehler" && -f "$tmp/mitschnitt" ]]; then
    groesse="$(stat -c %s -- "$tmp/mitschnitt" 2> /dev/null)" || groesse=""
    if [[ "$groesse" =~ ^[0-9]+$ ]] && (( groesse <= 65536 )); then
      status=erfasst
    fi
  fi
  zeilen="$(head -c 65536 -- "$tmp/mitschnitt" 2> /dev/null | LC_ALL=C grep -a -E -x 'A6-FEHLER [a-z0-9-]{1,60}' 2> /dev/null)" || zeilen=""
  if [[ -n "$zeilen" ]]; then
    printf '%s\n' "$zeilen" >> "$basis/fehler" 2> /dev/null || status=unvollstaendig
  fi
  printf '%s\n' "$status" >> "$basis/status" 2> /dev/null || true
  rm -rf -- "$tmp" 2> /dev/null || true
  return "$rc"
}

# K7: genau eine feste Warnung je Berichtsfehler, nur aus dieser Liste, ohne Pfade, Werte oder Rohtext.
#   a6_bericht_warnung GRUND
a6_bericht_warnung() {
  case "$1" in
    job-ungueltig|ziel-ungueltig|funktionen-hash|image|start|pruefung|integritaet|nicht-geschrieben)
      printf '::warning title=A6-BERICHT::%s\n' "$1"
      ;;
    *)
      printf '::warning title=A6-BERICHT::%s\n' unbekannt
      ;;
  esac
}

# K1: Schreibziel streng pruefen. GITHUB_STEP_SUMMARY ist eine gewoehnliche Datei, kein Link, realpath
# gleich dem Pfad, unmittelbar in RUNNER_TEMP/_runner_file_commands, Name step_summary_<id>.
#   a6_bericht_ziel PFAD
a6_bericht_ziel() {
  local ziel="$1"
  if [[ -z "$ziel" || ! -f "$ziel" || -L "$ziel" ]]; then
    return 1
  fi
  if [[ "$(realpath -e -- "$ziel" 2> /dev/null)" != "$ziel" ]]; then
    return 1
  fi
  if [[ "${ziel%/*}" != "$RUNNER_TEMP/_runner_file_commands" ]]; then
    return 1
  fi
  if [[ ! "${ziel##*/}" =~ ^step_summary_[A-Za-z0-9_-]{1,80}$ ]]; then
    return 1
  fi
  return 0
}

# Runden und Kosten aus dem Claude-Protokoll: nur bei genau einem result-Ereignis mit zwei Zahlen. Sonst
# keine Datei, der Bericht meldet dann "Kosten unbekannt".
#   a6_bericht_kosten PROTOKOLL ZIEL
a6_bericht_kosten() {
  local protokoll="$1" ziel="$2" werte=""
  rm -f -- "$ziel" 2> /dev/null || true
  if [[ ! -f "$protokoll" || -L "$protokoll" ]]; then
    return 0
  fi
  werte="$(jq -s -r 'map(select(.type == "result")) | if length == 1 and (.[0].num_turns | type) == "number" and (.[0].total_cost_usd | type) == "number" then "\(.[0].num_turns) \(.[0].total_cost_usd)" else empty end' -- "$protokoll" 2> /dev/null)" || werte=""
  if [[ "$werte" =~ ^[0-9.eE+-]+\ [0-9.eE+-]+$ ]]; then
    printf '%s\n' "$werte" > "$ziel" 2> /dev/null || rm -f -- "$ziel" 2> /dev/null || true
  fi
  return 0
}

# Berichtsstarter fuer die Jobs mit Einstieg. Das Berichtsskript laeuft im festen, schon geladenen Image ohne
# Netz, ohne Secrets und ohne Token, mit genau drei Einhaengungen: Checkout nur lesbar, a6-bericht nur lesbar
# (nur wenn es ein echter eigener Ordner ist), die einzelne Zusammenfassungsdatei beschreibbar unter
# /a6/zusammenfassung. Fehlt das Image, wird nichts geladen: Warnung image. Jeder Berichtsfehler ergibt genau
# eine feste Warnung und Rueckgabe 1; das Jobergebnis bleibt unveraendert.
#   a6_bericht JOB
a6_bericht() {
  local job="${1:-}" ziel="${GITHUB_STEP_SUMMARY:-}" basis="$RUNNER_TEMP/a6-bericht" rc=0
  local einhaengen=() umgebung=(--env A6_BERICHT_JOB --env A6_JOB_STATUS)
  if [[ ! "$job" =~ ^(auftrag|claude|abnahme|veroeffentlichen|probe_auftrag|probe_claude|probe_abnahme|probe_veroeffentlichen)$ ]]; then
    echo "A6-START bericht-job" >&2
    a6_bericht_warnung job-ungueltig
    return 1
  fi
  if ! a6_bericht_ziel "$ziel"; then
    echo "A6-BERICHT ziel-ungueltig"
    a6_bericht_warnung ziel-ungueltig
    return 1
  fi
  if [[ "$job" == "claude" ]] && a6_bericht_ordner "$basis"; then
    a6_bericht_kosten "$RUNNER_TEMP/a6-claude-protokoll.jsonl" "$basis/claude"
  fi
  if ! docker image inspect "$A6_NODE_IMAGE" > /dev/null 2>&1; then
    a6_bericht_warnung image
    return 1
  fi
  export A6_BERICHT_JOB="$job"
  einhaengen=(--mount "type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly")
  if [[ -d "$basis" && ! -L "$basis" ]] && a6_bericht_eigen "$basis"; then
    einhaengen+=(--mount "type=bind,src=$basis,dst=/a6/bericht,readonly")
  fi
  einhaengen+=(--mount "type=bind,src=$ziel,dst=/a6/zusammenfassung")

  docker run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777 \
    "${einhaengen[@]}" --workdir "$GITHUB_WORKSPACE" --env PATH=/usr/local/bin:/usr/bin:/bin \
    "${umgebung[@]}" "$A6_NODE_IMAGE" /bin/sh -euc '
      unset NODE_VERSION YARN_VERSION
      if env | grep -q "^NODE_"; then echo "A6-START node-umgebung" >&2; exit 3; fi
      [ "$(node --version)" = "$1" ] || { echo "A6-START node-version" >&2; exit 3; }
      printf "%s  %s\n" "$2" scripts/agent-code-integritaet.mjs | sha256sum -c --status || { echo "A6-START anker" >&2; exit 3; }
      node scripts/agent-code-integritaet.mjs || exit 4
      exec node scripts/agent-code-job-bericht.mjs
    ' a6 "$A6_NODE_VERSION" "$A6_INTEGRITAET_SHA256" || rc=$?

  case "$rc" in
    0) return 0 ;;
    1) a6_bericht_warnung nicht-geschrieben ;;
    3) a6_bericht_warnung pruefung ;;
    4) a6_bericht_warnung integritaet ;;
    *) a6_bericht_warnung start ;;
  esac
  return 1
}

# Sammeltabelle ohne Container, ohne Docker, ohne Netz: nur die zehn A6_ERGEBNIS_*-Werte (aus needs.<job>.result)
# als fest formatierte Tabelle. Erlaubt sind success, failure, cancelled, skipped; jeder andere Wert erscheint als
# "unbekannt", skipped nie als Erfolg. Kein Wert erreicht die Ausgabe als Text. Dieselbe Zielpruefung und
# dieselben festen Warnungen wie a6_bericht. Massgeblich bleibt die Sammelpruefung davor.
#   a6_bericht_sammel
a6_bericht_sammel() {
  local ziel="${GITHUB_STEP_SUMMARY:-}" eintrag name anzeige pruefung text
  if ! a6_bericht_ziel "$ziel"; then
    echo "A6-BERICHT ziel-ungueltig"
    a6_bericht_warnung ziel-ungueltig
    return 1
  fi
  case "${A6_JOB_STATUS:-}" in
    success) pruefung='bestanden' ;;
    failure) pruefung='nicht bestanden' ;;
    cancelled) pruefung='abgebrochen' ;;
    *) pruefung='Status unbekannt' ;;
  esac
  text=$'### Bericht: agent-auftrag-sammel\n\n'"Sammelprüfung: ${pruefung}"$'\n\n| Job | Ergebnis |\n|---|---|\n'
  for eintrag in 'AUFTRAG:Job 0 Auftrag festlegen' 'CLAUDE:Job 1 Claude im Container' 'ABNAHME:Job 2 Abnahme ohne Netz' \
    'VEROEFFENTLICHEN:Job 3 Draft-PR veröffentlichen' 'PROBE_AUFTRAG:Generalprobe Job 0' 'PROBE_CLAUDE:Generalprobe Job 1' \
    'PROBE_ABNAHME:Generalprobe Job 2' 'PROBE_VEROEFFENTLICHEN:Generalprobe Job 3' 'PROBE_NEGATIV:Generalprobe Negativfälle' \
    'PROBE_SAMMEL:Generalprobe Sammelprüfung'; do
    name="A6_ERGEBNIS_${eintrag%%:*}"
    case "${!name:-}" in
      success) anzeige='erfolgreich' ;;
      failure) anzeige='fehlgeschlagen' ;;
      cancelled) anzeige='abgebrochen' ;;
      skipped) anzeige='übersprungen' ;;
      *) anzeige='unbekannt' ;;
    esac
    text+="| ${eintrag#*:} | ${anzeige} |"$'\n'
  done
  if ! printf '%s\n' "$text" >> "$ziel" 2> /dev/null; then
    a6_bericht_warnung nicht-geschrieben
    return 1
  fi
  return 0
}
