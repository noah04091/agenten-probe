# A6 P-1: gemeinsame Bausteine des Workflows agent-auftrag.yml. Entwurf, Ziel .github/agent/a6-funktionen.sh.
#
# Wird nie ausgefuehrt, nur geladen (source), und nur nachdem der Workflow den SHA-256 dieser Datei mit dem
# inline genehmigten Wert verglichen hat. Live-Pfad und Generalprobe laden dieselbe Datei; es gibt jeden
# Baustein genau einmal.
#
# Erwartete Umgebung (vom Workflow gesetzt): A6_NODE_IMAGE, A6_NODE_VERSION, A6_PROXY_IMAGE,
# A6_INTEGRITAET_SHA256, A6_ATTRAPPE_SHA256, A6_PROBE_SHA256, A6_ERSATZ_SHA256, A6_CC_VERSION,
# GITHUB_WORKSPACE, RUNNER_TEMP, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.

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

  docker run --rm --pull=never --network "$netz" --read-only --cap-drop ALL \
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
# je Read und Edit mit Pfad.
# ACHTUNG (Befund P-1): prepareWorkspace legt den ganzen Baum des Ausgangscommits im Arbeitsordner an,
# auch agent-acceptance/, .github/ und scripts/. Diese Dateien schuetzen hier nur die Werkzeugrechte
# (allow nur fuer die Profildateien, dontAsk, Verbote der Basis). Belegt wird das erst durch K1a.
# Geprueft wird: jede Profildatei ist eine gewoehnliche Datei, und es gibt kein .git.
#   a6_einstellungen CHECKOUT ARBEIT ZIEL
a6_einstellungen() {
  local checkout="$1" arbeit="$2" ziel="$3"
  local datei
  [[ ! -e "$arbeit/.git" && ! -L "$arbeit/.git" ]] || { echo "A6-CLAUDE arbeitsordner-git" >&2; return 1; }
  while IFS= read -r datei; do
    [[ -f "$arbeit/$datei" && ! -L "$arbeit/$datei" ]] || { echo "A6-CLAUDE arbeitsordner $datei" >&2; return 1; }
  done < <(jq -r '.[]' <<< "$A6_DATEIEN")
  mkdir -p "$(dirname "$ziel")"
  jq --argjson d "$A6_DATEIEN" '.permissions.allow = [$d[] | ("Read(./" + . + ")"), ("Edit(./" + . + ")")]' \
    "$checkout/.github/agent/claude-settings.json" > "$ziel"
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
# Arbeitsordner beschreibbar, Zusatz-Einhaengungen nur lesbar ueber das Feld A6_EINHAENGEN, kein Token,
# nur ein Platzhalter als Schluessel. Zeitlimit A6_ZEITLIMIT (z. B. 15m), danach wird der Container entfernt.
#   a6_claude_container BEFEHL...
a6_claude_container() {
  local lauf status=0
  lauf="$(a6_lauf)"
  timeout --kill-after=30s "$A6_ZEITLIMIT" docker run --rm -i --name "a6-claude-$lauf" \
    --network "a6-intern-$lauf" --pull=never --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2 \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
    --mount "type=bind,src=$RUNNER_TEMP/a6-claude-arbeit,dst=/arbeit" \
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
