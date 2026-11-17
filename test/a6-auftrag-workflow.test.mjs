// A6 P-1: Waechter fuer den Workflow agent-auftrag.yml, seine Funktionsdatei, die Sperrdatei von Claude Code
// und den Build.
//
// Zwei Teile:
// 1. Entwurf (entwurf/a6-p1/): SHA-256-Anker auf den genehmigten Entwurf und Strukturpruefungen. Diese
//    Tests sind auf dem Bot-PR gruen.
// 2. Eigentuemerstand: Die geschuetzten Zieldateien muessen byte-gleich mit dem Entwurf sein. Bis Noahs
//    Eigentuemer-Commit sie anlegt, sind genau diese Tests bewusst rot. Sie werden nicht uebersprungen.
//
// Was diese Tests NICHT zeigen: dass GitHub den Workflow so ausfuehrt (das zeigt die Generalprobe auf dem
// Eigentuemer-PR), dass Environment, Secrets und Rulesets so eingestellt sind wie angenommen, und K1a.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lies = pfad => readFileSync(join(ROOT, pfad), 'utf8').replace(/\r\n/g, '\n');
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

// Genehmigter Stand des Workflow-Entwurfs (Zeilenenden LF). Jede Aenderung am Entwurf braucht diesen Wert neu.
const A6_WORKFLOW_SHA256 = '42380583a6feb11ffcc88bf410b9f92e0e8ef009e50669fe7a4a94ade17dc125';

const ENTWURF = 'entwurf/a6-p1';
const ZIELE = Object.freeze([
  [`${ENTWURF}/agent-auftrag.yml`, '.github/workflows/agent-auftrag.yml'],
  [`${ENTWURF}/a6-funktionen.sh`, '.github/agent/a6-funktionen.sh'],
  [`${ENTWURF}/claude-code/package.json`, '.github/agent/claude-code/package.json'],
  [`${ENTWURF}/claude-code/package-lock.json`, '.github/agent/claude-code/package-lock.json'],
  [`${ENTWURF}/package.json`, 'package.json'],
]);

const WF = lies(`${ENTWURF}/agent-auftrag.yml`);
const FN = lies(`${ENTWURF}/a6-funktionen.sh`);
const LIVE = Object.freeze(['auftrag', 'claude', 'abnahme', 'veroeffentlichen']);
const PROBE = Object.freeze(['probe_auftrag', 'probe_claude', 'probe_abnahme', 'probe_veroeffentlichen', 'probe_negativ', 'probe_sammel_a', 'probe_sammel_b', 'probe_sammel_pruefung']);

// Einfache, strenge Zerlegung: Jobs auf Ebene 2 unter "jobs:". Unbekannte Struktur scheitert.
function jobs(text) {
  const zeilen = text.split('\n');
  const start = zeilen.indexOf('jobs:');
  assert.ok(start > 0, 'jobs: fehlt');
  const ergebnis = new Map();
  let name = null;

  for (const zeile of zeilen.slice(start + 1)) {
    const kopf = /^ {2}([a-z_]+):$/.exec(zeile);

    if (kopf) {
      assert.ok(!ergebnis.has(kopf[1]), `Job ${kopf[1]} doppelt`);
      name = kopf[1];
      ergebnis.set(name, []);
    } else if (name !== null && !/^ {2}#/.test(zeile)) {
      assert.ok(zeile === '' || zeile.startsWith('    '), `unerwartete Zeile auf Jobebene: ${zeile}`);
      ergebnis.get(name).push(zeile);
    }
  }

  return new Map([...ergebnis].map(([job, z]) => [job, z.join('\n')]));
}

// Text der if-Bedingung eines Jobs (eine Zeile oder Block mit >-).
function bedingung(jobText) {
  const zeilen = jobText.split('\n');
  const i = zeilen.findIndex(z => /^ {4}if: /.test(z));

  if (i < 0) {
    return '';
  }

  if (zeilen[i] !== '    if: >-') {
    return zeilen[i].slice('    if: '.length);
  }

  const teile = [];

  for (const z of zeilen.slice(i + 1)) {
    if (!z.startsWith('      ')) {
      break;
    }

    teile.push(z.trim());
  }

  return teile.join(' ');
}

const J = jobs(WF);

// ---------------------------------------------------------------------------
// Teil 1: Entwurf
// ---------------------------------------------------------------------------

test('Entwurf: der Workflow-Entwurf ist genau der genehmigte Stand', () => {
  assert.equal(sha256(WF), A6_WORKFLOW_SHA256);
  assert.ok(!WF.includes('\t') && !WF.includes('\r'));
});

test('Entwurf: jeder inline gepinnte SHA-256 stimmt mit der Datei ueberein, auch der aeussere Anker des Pruefers', () => {
  const env = name => {
    const m = new RegExp(`^ {2}${name}: ([0-9a-f]{64})$`, 'm').exec(WF);
    assert.ok(m, `${name} fehlt`);
    return m[1];
  };

  assert.equal(env('A6_FUNKTIONEN_SHA256'), sha256(FN));
  assert.equal(env('A6_PROBE_SHA256'), sha256(lies('generalprobe/probe.mjs')));
  assert.equal(env('A6_ATTRAPPE_SHA256'), sha256(lies('generalprobe/github-attrappe.mjs')));
  assert.equal(env('A6_ERSATZ_SHA256'), sha256(lies('generalprobe/claude-ersatz.mjs')));
  assert.equal(env('A6_EINSTELLUNGEN_SHA256'), sha256(lies('.github/agent/claude-settings.json')));
  assert.equal(env('A6_CC_PAKET_SHA256'), sha256(lies(`${ENTWURF}/claude-code/package.json`)));
  assert.equal(env('A6_CC_SPERRE_SHA256'), sha256(lies(`${ENTWURF}/claude-code/package-lock.json`)));
  // Der aeussere Anker ist der SHA-256 der Rohbytes des Pruefers; er stimmt mit der Policy ueberein, stammt
  // aber nie aus ihr.
  const pruefer = createHash('sha256').update(readFileSync(join(ROOT, 'scripts', 'agent-code-integritaet.mjs'))).digest('hex');
  assert.equal(env('A6_INTEGRITAET_SHA256'), pruefer);
  assert.equal(JSON.parse(lies('.github/agent/policy.json')).skript_hashes['scripts/agent-code-integritaet.mjs'], pruefer);
  assert.match(WF, /^ {2}A6_NODE_IMAGE: node@sha256:[0-9a-f]{64}$/m);
  assert.match(WF, /^ {2}A6_PROXY_IMAGE: nginxinc\/nginx-unprivileged@sha256:[0-9a-f]{64}$/m);
  assert.match(WF, /^ {2}A6_CC_VERSION: 2\.1\.326$/m);
  assert.equal(JSON.parse(lies(`${ENTWURF}/claude-code/package.json`)).dependencies['@anthropic-ai/claude-code'], '2.1.326');
});

test('Entwurf: genau diese Jobs, Ereignisse issues.labeled und pull_request, eine Gruppe ohne Abbruch', () => {
  assert.deepEqual([...J.keys()], [...LIVE, ...PROBE, 'sammel']);
  assert.match(WF, /^on:\n {2}issues:\n {4}types: \[labeled\]\n {2}pull_request:\n {4}branches: \[main\]\n {4}types: \[opened, synchronize, reopened\]\n\n/m);
  assert.match(WF, /^ {2}cancel-in-progress: false$/m);
  assert.match(WF, /^permissions: \{\}$/m);
  assert.ok(!/pull_request_target|workflow_dispatch|workflow_run|schedule:/.test(WF));

  for (const [name, text] of J) {
    assert.match(text, /^ {4}timeout-minutes: [0-9]+$/m, `${name} ohne timeout-minutes`);
    assert.match(text, /^ {4}permissions:/m, `${name} ohne eigene permissions`);
  }
});

test('Entwurf: Trennung der Pfade, Job 1 bis 3 abgeschaltet und an issues auf main gebunden', () => {
  const live = bedingung(J.get('auftrag'));
  assert.ok(live.includes("github.event_name == 'issues'") && live.includes("github.ref == 'refs/heads/main'") && live.includes("github.event.label.name == 'bot-auftrag'"));
  assert.ok(!live.includes('false'), 'Job 0 laeuft ohne Schalter');

  for (const name of ['claude', 'abnahme', 'veroeffentlichen']) {
    const b = bedingung(J.get(name));
    assert.ok(b.startsWith('false && '), `${name} nicht mit false && abgeschaltet`);
    assert.ok(b.includes("github.event_name == 'issues'") && b.includes("github.ref == 'refs/heads/main'"), `${name} nicht an issues und main gebunden`);
    assert.ok(!b.includes('always()'), `${name} mit always()`);
  }

  // Environment nur in Job 1 und Job 3; nie in der Probe.
  const mitEnvironment = [...J].filter(([, t]) => /^ {4}environment:/m.test(t)).map(([n]) => n);
  assert.deepEqual(mitEnvironment, ['claude', 'veroeffentlichen']);
  assert.ok(J.get('claude').includes('      name: claude-bot') && J.get('veroeffentlichen').includes('      name: claude-bot'));

  for (const name of PROBE) {
    const t = J.get(name);
    assert.ok(!t.includes('secrets.'), `${name} liest Secrets`);
    assert.ok(!/^ {6}[a-z-]+: write$/m.test(t), `${name} mit Schreibrecht`);
    const b = bedingung(t);
    assert.ok(b === 'false' || b.includes("github.event_name == 'pull_request'") || /^needs\.probe_[a-z_]+\.result == 'success'/.test(b), `${name}: Bedingung ${b}`);
  }

  // permissions-Bloecke stehen auf Ebene 4 (Job) mit Eintraegen auf Ebene 6; Eingaben der App-Token-Action
  // (permission-contents: write) stehen tiefer und gelten nur fuer das kurzlebige App-Token in Job 3.
  assert.ok(!/^ {6}[a-z-]+: write$/m.test(WF), 'Schreibrecht fuer GITHUB_TOKEN im Workflow');
  assert.ok(/^ {10}permission-contents: write$/m.test(J.get('veroeffentlichen')), 'Muss-Treffer: Schreibrecht nur fuer das App-Token');
});

test('Entwurf: nur Job 3 erzeugt ein App-Token, Secrets nur in Job 1 und Job 3', () => {
  for (const [name, text] of J) {
    const appToken = (text.match(/create-github-app-token@/g) ?? []).length;
    assert.equal(appToken, name === 'veroeffentlichen' ? 1 : 0, `${name}: App-Token`);
    const geheim = [...text.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/g)].map(m => m[1]);
    const erwartet = { claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'], veroeffentlichen: ['BOT_APP_PRIVATE_KEY'] }[name] ?? [];
    assert.deepEqual(geheim, erwartet, `${name}: Secrets`);
  }

  assert.ok(J.get('veroeffentlichen').includes('A6_APP_TOKEN: ${{ steps.app_token.outputs.token }}'));
  assert.equal((WF.match(/steps\.app_token\.outputs\.token/g) ?? []).length, 1);
});

// Zerlegt einen Job in Schritte (Name und Text).
function schritte(jobText) {
  return jobText.split(/\n(?= {6}- )/).filter(t => /^ {6}- /.test(t));
}

test('Entwurf: kein Schluessel erreicht den Claude-Container; der Schluessel liegt nur beim Vorschaltcontainer', () => {
  const claude = schritte(J.get('claude'));
  const mitSchluessel = claude.filter(s => s.includes('secrets.ANTHROPIC_API_KEY'));
  assert.equal(mitSchluessel.length, 2);
  // Schritt mit dem echten Schluessel: startet nur den Vorschaltcontainer und Claude, keinen Einstieg.
  const proxySchritt = mitSchluessel.find(s => s.includes('ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'));
  assert.ok(proxySchritt.includes('a6_proxy_starten') && proxySchritt.includes('a6_claude_aufruf'));
  assert.ok(!proxySchritt.includes('a6_container '), 'Einstieg im Schritt mit dem Schluessel');
  // Zweiter Schritt: nur als Vergleichswert fuer Job 1b, ohne Netz.
  const vergleich = mitSchluessel.find(s => s.includes('A6_VERGLEICH_ANTHROPIC: ${{ secrets.ANTHROPIC_API_KEY }}'));
  assert.ok(vergleich.includes('a6_container none "" agent-code-job-claude-nach.mjs'));

  // Funktionsdatei: der Claude-Container bekommt nur einen festen Platzhalter.
  const container = FN.slice(FN.indexOf('a6_claude_container() {'), FN.indexOf('\n}\n', FN.indexOf('a6_claude_container() {')));
  assert.ok(container.includes('--env ANTHROPIC_API_KEY=a6-platzhalter-kein-schluessel'));
  assert.ok(container.includes('--network "a6-intern-$lauf"'));
  assert.equal((container.match(/--env /g) ?? []).length, 6);
  assert.ok(!/--env ANTHROPIC_API_KEY\s/.test(container) && !/-e /.test(container));
  // Nur der Vorschaltcontainer reicht die Variable ANTHROPIC_API_KEY durch.
  assert.equal((FN.match(/--env ANTHROPIC_API_KEY /g) ?? []).length, 1);
  const proxy = FN.slice(FN.indexOf('a6_proxy_starten() {'), FN.indexOf('\na6_claude_container() {'));
  assert.ok(proxy.includes('--env ANTHROPIC_API_KEY --env'));
  assert.ok(proxy.includes('docker network create --internal "a6-intern-$lauf"'));
});

test('Entwurf: Live-Aufrufe ohne Vorlademodul, Probe nur mit dem nachgebauten GitHub', () => {
  const aufrufe = [...WF.matchAll(/a6_container (none|bridge) ("[^"]*"|generalprobe\/github-attrappe\.mjs) (agent-code-job-[a-z-]+\.mjs)/g)];
  assert.ok(aufrufe.length >= 10);

  for (const [name, text] of J) {
    for (const m of text.matchAll(/a6_container (none|bridge) (\S+) (\S+)/g)) {
      if (LIVE.includes(name)) {
        assert.equal(m[2], '""', `${name}: Live-Aufruf mit Vorlademodul`);
      } else {
        assert.equal(m[1], 'none', `${name}: Probe mit Netz`);
        assert.ok(m[2] === '""' || m[2] === 'generalprobe/github-attrappe.mjs');
      }
    }
  }

  // Jeder Schritt mit a6_* laedt die Funktionsdatei erst nach dem Hashvergleich.
  for (const [name, text] of J) {
    for (const s of schritte(text).filter(s => /\ba6_[a-z_]+\b/.test(s.replace(/A6_[A-Z_]+/g, '')) && s.includes('run: |'))) {
      const lauf = s.slice(s.indexOf('run: |'));
      const vergleich = lauf.indexOf('printf \'%s  %s\\n\' "$A6_FUNKTIONEN_SHA256" .github/agent/a6-funktionen.sh | sha256sum -c --status');
      const laden = lauf.indexOf('source .github/agent/a6-funktionen.sh');
      assert.ok(vergleich > 0 && laden > vergleich, `${name}: Funktionsdatei ohne vorherigen Hashvergleich`);
    }
  }
});

test('Entwurf: jede verwendete Action ist auf einen vollstaendigen Commit-SHA gepinnt', () => {
  const uses = [...WF.matchAll(/uses: (\S+)/g)].map(m => m[1]);
  assert.ok(uses.length >= 20);
  assert.ok(uses.every(u => /^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/.test(u)), uses.join(', '));
  assert.ok(!WF.includes('anthropics/claude-code-action'), 'die alte Action wird nicht verwendet');
});

test('Funktionen: Startblock mit fester Umgebung, Anker vor dem Pruefer und Entfernen der Image-Variablen', () => {
  const start = FN.slice(FN.indexOf('a6_container() {'), FN.indexOf('\n}\n', FN.indexOf('a6_container() {')));
  for (const teil of ['--network "$netz"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', 'readonly"', '--env PATH=/usr/local/bin:/usr/bin:/bin', '"$A6_NODE_IMAGE"']) {
    assert.ok(start.includes(teil), teil);
  }

  // Das Image setzt NODE_VERSION und YARN_VERSION; der Stolperdraht lehnt jede NODE_-Variable ab.
  const reihenfolge = ['unset NODE_VERSION YARN_VERSION', 'grep -q "^NODE_"', 'node --version', 'scripts/agent-code-integritaet.mjs | sha256sum -c --status', 'node scripts/agent-code-integritaet.mjs', 'exec node "scripts/$5"'];
  const stellen = reihenfolge.map(teil => start.indexOf(teil));
  assert.ok(stellen.every(s => s > 0), JSON.stringify(stellen));
  assert.deepEqual([...stellen].sort((a, b) => a - b), stellen);
  // Keine Umgebung wird pauschal geerbt.
  assert.ok(!/--env-file|\s-e\s/.test(start));
  assert.deepEqual([...start.matchAll(/--env "[^"]*"/g)].map(m => m[0]), ['--env "$name"']);
  assert.ok(start.includes('[[ "$name" =~ ^[A-Z][A-Z0-9_]*$ && "$name" != PATH && "$name" != NODE_* ]]'));
});

test('Funktionen: Vorschaltcontainer nur fuer zwei POST-Pfade mit festem Ziel', () => {
  const vorlage = FN.slice(FN.indexOf("<<'A6_PROXY_KONFIGURATION'"), FN.indexOf('\nA6_PROXY_KONFIGURATION\n'));
  assert.deepEqual([...vorlage.matchAll(/location (\S+(?: \S+)?) \{/g)].map(m => m[1]), ['= /v1/messages', '= /v1/messages/count_tokens', '/']);
  assert.deepEqual([...vorlage.matchAll(/proxy_pass (\S+);/g)].map(m => m[1]), ['https://anthropic_api/v1/messages', 'https://anthropic_api/v1/messages/count_tokens']);
  assert.equal((vorlage.match(/limit_except POST \{ deny all; \}/g) ?? []).length, 2);
  assert.ok(vorlage.includes('server api.anthropic.com:443 resolve;') && vorlage.includes('proxy_ssl_verify on;') && vorlage.includes('proxy_redirect off;'));
  assert.ok(/location \/ \{\n {8}return 403;\n {4}\}/.test(vorlage));
  // Genau ein Ersetzungsausdruck, der Schluessel.
  assert.deepEqual([...vorlage.matchAll(/\$\{[A-Z_]+\}/g)].map(m => m[0]), ['${ANTHROPIC_API_KEY}']);
  assert.ok(FN.includes("--env 'NGINX_ENVSUBST_FILTER=^ANTHROPIC_API_KEY$'"));
});

function sammel(funktion, ...paare) {
  const r = spawnSync('bash', ['-c', 'source "$1"; shift; f="$1"; shift; "$f" "$@"', 'probe', join(ROOT, ENTWURF, 'a6-funktionen.sh'), funktion, ...paare], { encoding: 'utf8' });
  assert.equal(r.error, undefined, 'bash nicht verfuegbar');
  return { status: r.status, out: r.stdout };
}

test('Funktionen: Sammelpruefung nimmt nur vollstaendigen Erfolg an', () => {
  assert.deepEqual(sammel('a6_sammel', 'a=success', 'b=success'), { status: 0, out: '' });
  assert.deepEqual(sammel('a6_sammel', 'a=success', 'b=skipped'), { status: 1, out: 'SAMMEL-FEHLER b: skipped\n' });
  assert.deepEqual(sammel('a6_sammel', 'a=failure', 'b=cancelled'), { status: 1, out: 'SAMMEL-FEHLER a: failure\nSAMMEL-FEHLER b: cancelled\n' });
  assert.deepEqual(sammel('a6_sammel', 'a='), { status: 1, out: 'SAMMEL-FEHLER a: \n' });
  assert.deepEqual(sammel('a6_sammel'), { status: 1, out: 'SAMMEL-FEHLER keine Pflichtjobs\n' });
  assert.deepEqual(sammel('a6_sammel', 'a=success; true'), { status: 1, out: 'SAMMEL-FEHLER Eingabe\n' });
  assert.deepEqual(sammel('a6_sammel_uebersprungen', 'a=skipped'), { status: 0, out: '' });
  assert.deepEqual(sammel('a6_sammel_uebersprungen', 'a=success'), { status: 1, out: 'SAMMEL-FEHLER a lief auf einem PR: success\n' });
  // Der Sammeljob verlangt im Issue-Lauf alle vier Live-Jobs, im PR-Lauf die ganze Probe.
  const s = J.get('sammel');
  assert.ok(bedingung(s) === 'always()');
  assert.ok(s.includes('a6_sammel "${LIVE[@]}"') && s.includes('a6_sammel_uebersprungen "${LIVE[@]}"'));
  for (const job of ['probe_auftrag', 'probe_claude', 'probe_abnahme', 'probe_veroeffentlichen', 'probe_negativ', 'probe_sammel_pruefung']) {
    assert.ok(s.includes(`"${job}=$R_${job.toUpperCase()}"`) || s.includes(`${job}=$R_`), job);
  }
});

test('Build: der Entwurf von package.json baut jede src-Datei jedes Profils', () => {
  const build = JSON.parse(lies(`${ENTWURF}/package.json`)).scripts.build;
  const profile = readdirSync(join(ROOT, 'agent-profiles')).filter(n => n.endsWith('.json'));
  const quellen = [...new Set(profile.flatMap(n => JSON.parse(lies(`agent-profiles/${n}`)).dateien.filter(d => d.startsWith('src/'))))].sort();
  assert.deepEqual(quellen, ['src/rechne.js', 'src/text.js'], 'Muss-Treffer: beide Profile');
  assert.equal(build, quellen.map(q => `node --check ${q}`).join(' && '));
  // Sonst unveraendert gegenueber dem heutigen package.json.
  const heute = JSON.parse(lies('package.json'));
  assert.deepEqual({ ...JSON.parse(lies(`${ENTWURF}/package.json`)), scripts: { ...heute.scripts, build: heute.scripts.build } }, heute);
});

// ---------------------------------------------------------------------------
// Wirksamer Claude-Aufruf: Funktionsdatei in Bash laden, nur docker und timeout durch Mitschreiber ersetzen
// ---------------------------------------------------------------------------

const RT = '/a6-rt';
const WS = '/a6-ws';

// Fuehrt a6_claude_aufruf aus und liefert die tatsaechliche Argumentliste von "docker run".
function wirksamerAufruf() {
  const skript = [
    'source "$1"',
    'docker() { if [[ "$1" == run ]]; then printf "%s\\0" "$@" > "$2.argv"; fi; return 0; }',
    'timeout() { while [[ "$1" == --* ]]; do shift; done; shift; "$@"; }',
    'export RUNNER_TEMP=/a6-rt GITHUB_WORKSPACE=/a6-ws GITHUB_RUN_ID=11 GITHUB_RUN_ATTEMPT=1 A6_NODE_IMAGE=a6-image',
    'export A6_ZEITLIMIT=5m A6_MODELL=sonnet A6_RUNDEN=8 A6_BUDGET=1.5',
    'a6_claude_aufruf /dev/null < /dev/null',
    'printf "NUTZER %s\\n" "$(id -u):$(id -g)"',
  ].join('\n');
  const ziel = join(mkdtempSync(join(tmpdir(), 'a6-aufruf-')), 'docker');
  const r = spawnSync('bash', ['-c', skript.replace('"$2.argv"', JSON.stringify(`${ziel}.argv`)), 'probe', join(ROOT, ENTWURF, 'a6-funktionen.sh')], { encoding: 'utf8' });
  assert.equal(r.error, undefined, 'bash nicht verfuegbar');
  assert.equal(r.status, 0, r.stderr);
  const argv = readFileSync(`${ziel}.argv`, 'utf8').split('\0').slice(0, -1);
  rmSync(dirname(ziel), { recursive: true, force: true });
  const nutzer = /^NUTZER (\d+:\d+)$/m.exec(r.stdout)[1];
  const bild = argv.indexOf('a6-image');
  assert.ok(bild > 0, 'Image nicht im Aufruf');
  return { argv, nutzer, docker: argv.slice(0, bild), claude: argv.slice(bild + 1) };
}

const optionen = (liste, name) => liste.flatMap((wert, i) => (wert === name ? [liste[i + 1]] : []));

test('Claude-Aufruf: Einhaengungen genau Sicht, Installation und Einstellungen, nie RUNNER_TEMP, Checkout oder Ausgangsbaum', () => {
  const { docker } = wirksamerAufruf();
  assert.deepEqual(optionen(docker, '--mount'), [
    `type=bind,src=${RT}/a6-claude-sicht,dst=/arbeit`,
    `type=bind,src=${RT}/a6-claude-code/app,dst=/opt/claude-code,readonly`,
    `type=bind,src=${RT}/a6-claude-einstellungen/settings.json,dst=/opt/a6/settings.json,readonly`,
  ]);

  for (const m of optionen(docker, '--mount')) {
    const quelle = /src=([^,]+)/.exec(m)[1];
    assert.notEqual(quelle, RT, 'ganzes RUNNER_TEMP eingebunden');
    assert.ok(!quelle.startsWith(WS), 'Checkout eingebunden');
    assert.ok(!quelle.includes('a6-claude-arbeit'), 'vollstaendiger Ausgangsbaum eingebunden');
  }

  assert.ok(!docker.some(a => /^(-v|--volume|--volumes-from|--mount=|--tmpfs=|--privileged|--network=host)/.test(a)), 'weitere Einhaengung oder Rechte');
  assert.deepEqual(optionen(docker, '--tmpfs'), ['/tmp:rw,nosuid,nodev,size=256m,mode=1777']);
  assert.equal(optionen(docker, '--workdir')[0], '/arbeit');

  // Zusatz-Einhaengungen im Workflow: nur lesbar und nur unter /opt/a6/.
  const zusatz = [...WF.matchAll(/A6_EINHAENGEN\+?=\((.*)\)$/gm)].map(m => m[1]);
  assert.ok(zusatz.length >= 2, 'Muss-Treffer: Zusatz-Einhaengungen der Probe');
  for (const z of zusatz) {
    assert.match(z, /^--mount "type=bind,src=\$(ERSATZ|LESEPROBE),dst=\/opt\/a6\/[a-z-]+\.(mjs|md),readonly"$/, z);
  }
});

test('Claude-Aufruf: Werkzeuge genau Read und Edit, keine weiteren Werkzeugschalter', () => {
  const { claude } = wirksamerAufruf();
  assert.equal(claude[0], '/opt/claude-code/node_modules/.bin/claude');
  assert.deepEqual(optionen(claude, '--tools'), ['Read,Edit']);
  assert.ok(!claude.some(a => /^--(allowed-?tools|allowedTools|disallowed-?tools|disallowedTools|dangerously|add-dir|tools=)/i.test(a)), claude.join(' '));
  // Kein Werkzeugname steht lose im Aufruf, der variadische Schalter --tools schluckt sonst Folgewerte.
  assert.ok(!claude.some(a => /^(Bash|Write|Glob|Grep|WebFetch|WebSearch|Task|Agent|NotebookEdit)\b/.test(a)), claude.join(' '));
});

test('Claude-Aufruf: geschuetzte Einstellungen, setting-sources leer, dontAsk, strict-mcp-config', () => {
  const { claude, docker } = wirksamerAufruf();
  assert.deepEqual(optionen(claude, '--settings'), ['/opt/a6/settings.json']);
  assert.deepEqual(optionen(claude, '--setting-sources'), ['']);
  assert.deepEqual(optionen(claude, '--permission-mode'), ['dontAsk']);
  assert.equal(claude.filter(a => a === '--strict-mcp-config').length, 1);
  assert.ok(!claude.includes('--mcp-config'));
  // Die Einstellungsdatei im Container ist die erzeugte Datei aus der geschuetzten Basis.
  assert.ok(optionen(docker, '--mount').includes(`type=bind,src=${RT}/a6-claude-einstellungen/settings.json,dst=/opt/a6/settings.json,readonly`));
  // Die erzeugte Datei: Basis unveraendert, allow nur Read und Edit mit Pfad der Profildateien.
  const dir = mkdtempSync(join(tmpdir(), 'a6-einstellungen-'));

  try {
    const checkout = join(dir, 'checkout');
    const arbeit = join(dir, 'arbeit');
    mkdirSync(join(checkout, '.github', 'agent'), { recursive: true });
    mkdirSync(join(arbeit, 'src'), { recursive: true });
    mkdirSync(join(arbeit, 'test'), { recursive: true });
    writeFileSync(join(checkout, '.github', 'agent', 'claude-settings.json'), readFileSync(join(ROOT, '.github', 'agent', 'claude-settings.json')));
    writeFileSync(join(arbeit, 'src', 'rechne.js'), 'x\n');
    writeFileSync(join(arbeit, 'test', 'rechne.test.js'), 'x\n');
    const anker = /^ {2}A6_EINSTELLUNGEN_SHA256: ([0-9a-f]{64})$/m.exec(WF)[1];
    const erzeuge = (ziel, a = anker) => spawnSync('bash', ['-c', 'source "$1"; a6_einstellungen "$2" "$3" "$4"', 'probe', join(ROOT, ENTWURF, 'a6-funktionen.sh'), checkout, arbeit, join(dir, ziel)], {
      encoding: 'utf8', env: { PATH: process.env.PATH, A6_DATEIEN: '["src/rechne.js","test/rechne.test.js"]', A6_EINSTELLUNGEN_SHA256: a },
    });
    const r = erzeuge('aus/settings.json');
    assert.equal(r.status, 0, r.stderr);
    const basis = JSON.parse(lies('.github/agent/claude-settings.json'));
    const erzeugt = JSON.parse(readFileSync(join(dir, 'aus', 'settings.json'), 'utf8'));
    assert.deepEqual(erzeugt.permissions.allow, ['Read(./src/rechne.js)', 'Edit(./src/rechne.js)', 'Read(./test/rechne.test.js)', 'Edit(./test/rechne.test.js)']);
    assert.deepEqual({ ...erzeugt, permissions: { ...erzeugt.permissions, allow: [] } }, basis);
    assert.deepEqual(basis.permissions.allow, []);
    assert.ok(basis.permissions.deny.includes('Bash') && basis.permissions.deny.length >= 38);
    // Die Basis ist an den genehmigten SHA-256 gebunden; jede andere Basis wird abgelehnt.
    assert.equal(anker, sha256(lies('.github/agent/claude-settings.json')));
    const falsch = erzeuge('falsch/settings.json', 'f'.repeat(64));
    assert.deepEqual([falsch.status, falsch.stderr], [1, 'A6-CLAUDE einstellungen-basis\n']);
    assert.ok(!existsSync(join(dir, 'falsch', 'settings.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude-Aufruf: der vollstaendige wirksame Aufruf ist genau festgelegt, und Claude startet nur ueber a6_claude_aufruf', () => {
  const { argv, nutzer } = wirksamerAufruf();
  assert.deepEqual(argv, [
    'run', '--rm', '-i', '--name', 'a6-claude-11-1', '--network', 'a6-intern-11-1', '--pull=never', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--user', nutzer,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', `type=bind,src=${RT}/a6-claude-sicht,dst=/arbeit`,
    '--mount', `type=bind,src=${RT}/a6-claude-code/app,dst=/opt/claude-code,readonly`,
    '--mount', `type=bind,src=${RT}/a6-claude-einstellungen/settings.json,dst=/opt/a6/settings.json,readonly`,
    '--workdir', '/arbeit', '--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    '--env', 'ANTHROPIC_BASE_URL=http://a6-proxy:8080', '--env', 'ANTHROPIC_API_KEY=a6-platzhalter-kein-schluessel',
    '--env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', '--env', 'DISABLE_AUTOUPDATER=1', 'a6-image',
    '/opt/claude-code/node_modules/.bin/claude', '-p', '--tools', 'Read,Edit', '--settings', '/opt/a6/settings.json',
    '--setting-sources', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--model', 'sonnet', '--max-turns', '8',
    '--max-budget-usd', '1.5', '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
  ]);
  // Im Workflow startet Claude nur ueber a6_claude_aufruf; kein eigener docker-Aufruf mit Claude.
  assert.equal((WF.match(/a6_claude_aufruf /g) ?? []).length, 2);
  assert.ok(!/docker run[^\n]*claude|node_modules\/\.bin\/claude/.test(WF));
  assert.equal((FN.match(/node_modules\/\.bin\/claude/g) ?? []).length, 2, 'nur Versionspruefung und a6_claude_aufruf');
});

// ---------------------------------------------------------------------------
// Sicht: Anlegen, Pruefen, Rueckkopie (reines Dateisystem, ohne Docker)
// ---------------------------------------------------------------------------

function sichtLauf(vorbereiten, befehl) {
  const dir = mkdtempSync(join(tmpdir(), 'a6-sicht-'));

  try {
    const arbeit = join(dir, 'a6-claude-arbeit');
    const sicht = join(dir, 'a6-claude-sicht');
    for (const [pfad, inhalt] of [['src/rechne.js', 'alt rechne\n'], ['test/rechne.test.js', 'alt test\n'], ['src/text.js', 'text\n'], ['agent-acceptance/issue-1.mjs', 'abnahme\n'], ['scripts/x.mjs', 'skript\n'], ['.github/agent/policy.json', '{}\n']]) {
      mkdirSync(join(arbeit, dirname(pfad)), { recursive: true });
      writeFileSync(join(arbeit, pfad), inhalt);
    }

    const env = { PATH: process.env.PATH, A6_DATEIEN: '["src/rechne.js","test/rechne.test.js"]' };
    const anlegen = spawnSync('bash', ['-c', 'source "$1"; a6_sicht_anlegen "$2" "$3"', 'probe', join(ROOT, ENTWURF, 'a6-funktionen.sh'), arbeit, sicht], { encoding: 'utf8', env });
    vorbereiten?.({ dir, arbeit, sicht });
    const vorher = readFileSync(join(arbeit, 'src', 'rechne.js'), 'utf8');
    const r = befehl === undefined
      ? anlegen
      : spawnSync('bash', ['-c', `source "$1"; ${befehl} "$2" "$3"`, 'probe', join(ROOT, ENTWURF, 'a6-funktionen.sh'), arbeit, sicht], { encoding: 'utf8', env });
    const liste = d => (existsSync(d) ? spawnSync('find', [d, '-mindepth', '1', '-printf', '%y %P\n'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort() : null);
    return { anlegen, r, sicht: liste(sicht), arbeit: liste(arbeit), rechne: readFileSync(join(arbeit, 'src', 'rechne.js'), 'utf8'), test: readFileSync(join(arbeit, 'test', 'rechne.test.js'), 'utf8'), vorher };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Sicht: enthaelt genau die Profildateien, eine erlaubte Aenderung wird uebernommen, im Arbeitsordner entsteht nichts Neues', () => {
  const a = sichtLauf();
  assert.equal(a.anlegen.status, 0, a.anlegen.stderr);
  assert.deepEqual(a.sicht, ['d src', 'd test', 'f src/rechne.js', 'f test/rechne.test.js']);
  const u = sichtLauf(({ sicht }) => writeFileSync(join(sicht, 'src', 'rechne.js'), 'neu rechne\n'), 'a6_sicht_uebernehmen');
  assert.equal(u.r.status, 0, u.r.stderr);
  assert.equal(u.rechne, 'neu rechne\n');
  assert.equal(u.test, 'alt test\n');
  assert.deepEqual(u.arbeit, a.arbeit, 'Arbeitsordner hat neue oder fehlende Eintraege');
  // Anlegen scheitert, wenn die Sicht schon existiert oder eine Quelle ein Symlink ist.
  const vorhanden = sichtLauf(undefined, 'a6_sicht_anlegen');
  assert.equal(vorhanden.r.status, 1);
  assert.equal(vorhanden.r.stderr, 'A6-SICHT vorhanden\n');
});

const SICHT_FAELLE = Object.freeze({
  zusatzdatei: ({ sicht }) => writeFileSync(join(sicht, 'src', 'neu.js'), 'x\n'),
  versteckte_datei: ({ sicht }) => writeFileSync(join(sicht, '.versteckt'), 'x\n'),
  versteckt_im_ordner: ({ sicht }) => writeFileSync(join(sicht, 'test', '.x'), 'x\n'),
  zusatzordner: ({ sicht }) => mkdirSync(join(sicht, 'agent-acceptance')),
  symlink_statt_datei: ({ sicht, arbeit }) => { rmSync(join(sicht, 'src', 'rechne.js')); symlinkSync(join(arbeit, 'agent-acceptance', 'issue-1.mjs'), join(sicht, 'src', 'rechne.js')); },
  symlink_statt_ordner: ({ sicht, dir }) => { renameSync(join(sicht, 'src'), join(dir, 'src-aussen')); symlinkSync(join(dir, 'src-aussen'), join(sicht, 'src')); },
  hardlink_nach_aussen: ({ sicht, dir }) => linkSync(join(sicht, 'src', 'rechne.js'), join(dir, 'aussen.js')),
  hardlink_innen: ({ sicht }) => linkSync(join(sicht, 'src', 'rechne.js'), join(sicht, 'test', 'rechne.test.js.2')),
  datei_fehlt: ({ sicht }) => rmSync(join(sicht, 'test', 'rechne.test.js')),
  fifo_statt_datei: ({ sicht }) => { rmSync(join(sicht, 'src', 'rechne.js')); spawnSync('mkfifo', [join(sicht, 'src', 'rechne.js')]); },
  ordner_statt_datei: ({ sicht }) => { rmSync(join(sicht, 'src', 'rechne.js')); mkdirSync(join(sicht, 'src', 'rechne.js')); },
  zeilenumbruch_im_namen: ({ sicht }) => writeFileSync(join(sicht, 'src', 'a\nf 1 src'), 'x\n'),
  sicht_ist_symlink: ({ sicht, dir }) => { renameSync(sicht, join(dir, 'echt')); symlinkSync(join(dir, 'echt'), sicht); },
});
const SICHT_CODES = Object.freeze({ zeilenumbruch_im_namen: 'A6-SICHT name\n', sicht_ist_symlink: 'A6-SICHT ordner\n' });

test('Sicht: jede Manipulation wird vor der Rueckkopie abgelehnt, der Arbeitsordner bleibt unveraendert', () => {
  for (const [name, fall] of Object.entries(SICHT_FAELLE)) {
    const x = sichtLauf(k => { writeFileSync(join(k.sicht, 'src', 'rechne.js'), 'neu\n'); fall(k); }, 'a6_sicht_uebernehmen');
    assert.equal(x.anlegen.status, 0, x.anlegen.stderr);
    assert.equal(x.r.status, 1, `${name} angenommen`);
    assert.equal(x.r.stderr, SICHT_CODES[name] ?? 'A6-SICHT inhalt\n', name);
    assert.equal(x.rechne, 'alt rechne\n', `${name}: Arbeitsordner veraendert`);
  }

  // Ziel im Arbeitsordner als Symlink: keine Rueckkopie.
  const ziel = sichtLauf(({ arbeit }) => { rmSync(join(arbeit, 'test', 'rechne.test.js')); symlinkSync(join(arbeit, 'scripts', 'x.mjs'), join(arbeit, 'test', 'rechne.test.js')); }, 'a6_sicht_uebernehmen');
  assert.equal(ziel.r.status, 1);
  assert.equal(ziel.r.stderr, 'A6-SICHT ziel\n');
  assert.equal(ziel.rechne, 'alt rechne\n', 'Rueckkopie begann vor der vollstaendigen Pruefung');
});

test('Sicht: Profilpfade werden streng gelesen, alles andere wird abgelehnt', () => {
  const pfade = dateien => spawnSync('bash', ['-c', 'source "$1"; a6_profilpfade', 'probe', join(ROOT, ENTWURF, 'a6-funktionen.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH, A6_DATEIEN: dateien } });
  const gut = pfade('["src/rechne.js","test/rechne.test.js"]');
  assert.deepEqual([gut.status, gut.stdout], [0, 'src/rechne.js\ntest/rechne.test.js\n']);

  for (const falsch of ['[]', '["scripts/x.mjs"]', '["src/../x"]', '["src/.x"]', '["src/a/b.js"]', '["src/a.js", "test/b.js"]', '["src/a.js"', 'src/a.js', '["src/a.js","agent-acceptance/x.mjs"]', '["src/a\nb.js"]']) {
    const r = pfade(falsch);
    assert.deepEqual([r.status, r.stderr], [1, 'A6-SICHT profil\n'], falsch);
  }
});

test('Sicht: im Workflow liegt die Sicht neben dem Arbeitsordner, Pruefung und Rueckkopie erst nach dem Claude-Container', () => {
  for (const job of ['claude', 'probe_claude']) {
    const t = J.get(job);
    const anlegen = t.indexOf('a6_sicht_anlegen "$RUNNER_TEMP/a6-claude-arbeit" "$RUNNER_TEMP/a6-claude-sicht"');
    const aufruf = t.indexOf('a6_claude_aufruf ');
    const aufraeumen = t.indexOf('a6_aufraeumen');
    const beendet = t.indexOf('a6_claude_beendet');
    const uebernehmen = t.indexOf('a6_sicht_uebernehmen "', beendet);
    const job1b = t.indexOf('agent-code-job-claude-nach.mjs');
    assert.ok(anlegen > 0 && anlegen < aufruf && aufruf < aufraeumen && aufraeumen < beendet && beendet < uebernehmen && uebernehmen < job1b, `${job}: Reihenfolge ${[anlegen, aufruf, aufraeumen, beendet, uebernehmen, job1b]}`);
  }

  assert.ok(FN.includes("docker ps -aq --filter 'name=^a6-claude-'"));
});

// Ausweichloesung (b): nur falls GitHub agent-auftrag.yml auf seinem eigenen PR nicht startet.
const A6_AUSWEICH_SHA256 = '33a9eb3d567f3e510705bf81983eccc4fd5456c7169542c4a3d34308aaaedede';

test('Ausweichloesung: ergaenzt den heutigen Trockenlauf nur und traegt Umgebung und Probejobs wortgleich', () => {
  const aus = lies(`${ENTWURF}/ausweich/code-pilot-trockenlauf.yml`);
  assert.equal(sha256(aus), A6_AUSWEICH_SHA256);
  const z = WF.split('\n');
  const envStart = z.indexOf('env:');
  let envEnde = envStart + 1;

  while (/^ {2}\S/.test(z[envEnde])) {
    envEnde += 1;
  }

  const envBlock = z.slice(envStart, envEnde).join('\n');
  const probe = WF.slice(WF.indexOf('  probe_auftrag:\n'), WF.indexOf('  # -------------------------------------------------------------------------------------------------\n  # Sammeljob')).replace(/\n+$/, '\n');
  assert.ok(envBlock.length > 500 && probe.length > 10_000, 'Muss-Treffer: Umgebung und Probejobs gefunden');
  assert.ok(aus.includes(`\n${envBlock}\n`), 'Umgebung nicht wortgleich');
  assert.ok(aus.includes(`\n${probe}`), 'Probejobs nicht wortgleich');
  // Ohne die zwei eingefuegten Teile bleibt genau der heutige Trockenlauf.
  const kopf = aus.slice(aus.indexOf('# A6 P-1, Ausweichloesung (b): traegt'), aus.indexOf('concurrency:\n'));
  const ohne = aus.replace(kopf, '').slice(0, aus.replace(kopf, '').indexOf('\n  # A6 P-1, Ausweichloesung (b): Probejobs'));
  assert.equal(`${ohne.replace(/\n+$/, '')}\n`, lies('.github/workflows/code-pilot-trockenlauf.yml'));
  assert.ok(/\n {2}probe_gesamt:\n[\s\S]*a6_sammel "probe_auftrag=\$R_PROBE_AUFTRAG"/.test(aus));
});

// ---------------------------------------------------------------------------
// Teil 2: Eigentuemerstand (bis zum Eigentuemer-Commit bewusst rot)
// ---------------------------------------------------------------------------

for (const [entwurf, ziel] of ZIELE) {
  test(`Eigentuemerstand: ${ziel} ist byte-gleich mit ${entwurf}`, () => {
    assert.ok(existsSync(join(ROOT, ziel)), `${ziel} fehlt`);
    assert.equal(sha256(lies(ziel)), sha256(lies(entwurf)));
  });
}
