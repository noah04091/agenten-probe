// A6 P-1: Waechter fuer den Workflow agent-auftrag.yml, seine Funktionsdatei, die Sperrdatei von Claude Code
// und den Build.
//
// Zwei Teile:
// 1. Entwurf (entwurf/a6-p1/): SHA-256-Anker auf den genehmigten Entwurf und Strukturpruefungen. Diese
//    Tests sind auf dem Bot-PR gruen.
// 2. Eigentuemerstand: Die geschuetzten Zieldateien muessen byte-gleich mit dem Entwurf sein. Bis Noahs
//    Eigentuemer-Commit sie anlegt, sind genau diese Tests bewusst rot. Sie werden nicht uebersprungen.
//    B1.2: Workflow und Funktionsdatei tragen zusaetzlich die Berichtsteile; fuer sie gilt die Gleichheit nach den
//    Ausschneide-Proben (Abschnitt B1.2). Der Entwurf bleibt der bisher genehmigte Stand.
//
// Was diese Tests NICHT zeigen: dass GitHub den Workflow so ausfuehrt (das zeigt die Generalprobe auf dem
// Eigentuemer-PR), dass Environment, Secrets und Rulesets so eingestellt sind wie angenommen, und K1a.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { K2_KONFIG, K2_MARKER, legeGitAblageAn } from '../generalprobe/claude-ersatz-k2.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lies = pfad => readFileSync(join(ROOT, pfad), 'utf8').replace(/\r\n/g, '\n');
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

// Genehmigter Stand des Workflow-Entwurfs (Zeilenenden LF). Jede Aenderung am Entwurf braucht diesen Wert neu.
const A6_WORKFLOW_SHA256 = 'd5bb6eaa3d16e2bd964c2466b8c2befa343c751703d0c8961d0b7026700eb20f';

const ENTWURF = 'entwurf/a6-p1';
const ZIELE = Object.freeze([
  [`${ENTWURF}/agent-auftrag.yml`, '.github/workflows/agent-auftrag.yml'],
  [`${ENTWURF}/a6-funktionen.sh`, '.github/agent/a6-funktionen.sh'],
  [`${ENTWURF}/a6-protokoll.mjs`, '.github/agent/a6-protokoll.mjs'],
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
  assert.equal(env('A6_ERSATZ_K2_SHA256'), sha256(lies('generalprobe/claude-ersatz-k2.mjs')));
  assert.equal(env('A6_PROTOKOLL_SHA256'), sha256(lies(`${ENTWURF}/a6-protokoll.mjs`)));
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

// P-4: Die Live-Jobs haben keinen Schalter mehr. Jede Bedingung ist vollstaendig festgelegt: nur issues auf
// main in diesem Repository, Job 0 nur fuer das Label bot-auftrag, Job 1 bis 3 nur nach erfolgreichen
// Vorgaengern, nie always(). Startfreigabe und K3 prueft Job 0 (agent-code-job-auftrag.mjs) und Job 1a erneut.
const LIVE_RAHMEN = "github.event_name == 'issues' && github.ref == 'refs/heads/main' && github.repository == 'noah04091/agenten-probe'";
const LIVE_BEDINGUNGEN = Object.freeze({
  auftrag: `${LIVE_RAHMEN} && github.event.action == 'labeled' && github.event.label.name == 'bot-auftrag'`,
  claude: `${LIVE_RAHMEN} && needs.auftrag.result == 'success'`,
  abnahme: `${LIVE_RAHMEN} && needs.auftrag.result == 'success' && needs.claude.result == 'success'`,
  veroeffentlichen: `${LIVE_RAHMEN} && needs.auftrag.result == 'success' && needs.claude.result == 'success' && needs.abnahme.result == 'success'`,
});
const LIVE_NEEDS = Object.freeze({ auftrag: null, claude: 'needs: auftrag', abnahme: 'needs: [auftrag, claude]', veroeffentlichen: 'needs: [auftrag, claude, abnahme]' });
const LIVE_ZEIT = Object.freeze({ auftrag: 10, claude: 40, abnahme: 20, veroeffentlichen: 10 });

test('Entwurf: Trennung der Pfade, Job 1 bis 3 ohne Schalter nur fuer issues auf main und nur nach erfolgreichen Vorgaengern (P-4)', () => {
  for (const name of LIVE) {
    const t = J.get(name);
    assert.equal(bedingung(t), LIVE_BEDINGUNGEN[name], `${name}: Bedingung`);
    assert.ok(!/\bfalse\b|always\(\)|\|\||!/.test(bedingung(t)), `${name}: Schalter, always() oder Oder in der Bedingung`);
    const needs = /^ {4}needs: .+$/m.exec(t)?.[0].trim() ?? null;
    assert.equal(needs, LIVE_NEEDS[name], `${name}: needs`);
    assert.match(t, new RegExp(`^ {4}timeout-minutes: ${LIVE_ZEIT[name]}$`, 'm'), `${name}: Zeitgrenze`);
    assert.ok(!t.includes('continue-on-error'), `${name}: continue-on-error`);
  }

  // Der Schalter ist nur im Entwurf entfernt; der Kopfkommentar sagt es, und keine Bedingung traegt ihn.
  assert.ok(!/^ {6}false &&$/m.test(WF), 'false && in einer Bedingung');
  assert.match(WF, /P-4: die bisherigen "false &&"-/);

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
    assert.match(z, /^--mount "type=bind,src=\$(ERSATZ|LESEPROBE|K2ERSATZ),dst=\/opt\/a6\/[a-z0-9-]+\.(mjs|md),readonly"$/, z);
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
  // Live, Probe mit Platzhalter, K1-A und K1-B (test/a6-k1-nachweis.test.mjs).
  assert.equal((WF.match(/\| a6_claude_aufruf /g) ?? []).length, 4);
  assert.ok(!/docker run[^\n]*claude|node_modules\/\.bin\/claude/.test(WF));
  assert.equal((FN.match(/node_modules\/\.bin\/claude/g) ?? []).length, 2, 'nur Versionspruefung und a6_claude_aufruf');
});

// ---------------------------------------------------------------------------
// Sicht: Anlegen, Pruefen, Rueckkopie (reines Dateisystem, ohne Docker)
// ---------------------------------------------------------------------------

function sichtLauf(vorbereiten, befehl, nachher) {
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
    const zusatz = nachher?.({ dir, arbeit, sicht });
    return { zusatz, anlegen, r, sicht: liste(sicht), arbeit: liste(arbeit), rechne: readFileSync(join(arbeit, 'src', 'rechne.js'), 'utf8'), test: readFileSync(join(arbeit, 'test', 'rechne.test.js'), 'utf8'), vorher };
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
  git_ablage_fsmonitor: ({ sicht }) => legeGitAblageAn(sicht),
  git_config_allein: ({ sicht }) => { mkdirSync(join(sicht, '.git')); writeFileSync(join(sicht, '.git', 'config'), K2_KONFIG); },
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

// K2, Test A: Eine Git-Ablage mit core.fsmonitor in der Sicht. Die Gegenprobe in einer Kopie zeigt, dass Git
// den Marker anlegen wuerde; die Pruefung lehnt die Sicht vor jeder Rueckkopie ab, und der Marker entsteht
// weder in der Sicht noch im Arbeitsordner noch sonst unter dem Probeordner.
function findeMarker(dir) {
  return spawnSync('find', [dir, '-name', K2_MARKER, '-printf', '%P\n'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
}

test('Sicht K2: Git-Ablage mit core.fsmonitor wird vor der Rueckkopie abgelehnt, der Marker entsteht nie, Arbeitsordner unveraendert', () => {
  const basis = sichtLauf();
  const git = (cwd, ...args) => spawnSync('git', ['-c', 'safe.directory=*', '-C', cwd, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } });
  const x = sichtLauf(({ sicht }) => {
    writeFileSync(join(sicht, 'src', 'rechne.js'), 'neu\n');
    legeGitAblageAn(sicht);
  }, 'a6_sicht_uebernehmen', ({ dir, arbeit, sicht }) => {
    const vorGegenprobe = findeMarker(dir);
    // Gegenprobe nur in einer Kopie: die Ablage ist scharf, Git fuehrt core.fsmonitor dort aus.
    const kopie = join(dir, 'gegenprobe');
    cpSync(sicht, kopie, { recursive: true });
    const status = git(kopie, 'status', '--porcelain');
    const gegenprobe = existsSync(join(kopie, K2_MARKER));
    rmSync(kopie, { recursive: true, force: true });
    return {
      vorGegenprobe,
      gitLief: status.error === undefined,
      gegenprobe,
      nachGegenprobe: findeMarker(dir),
      konfig: readFileSync(join(sicht, '.git', 'config'), 'utf8'),
      arbeitGit: existsSync(join(arbeit, '.git')),
    };
  });

  assert.equal(x.anlegen.status, 0, x.anlegen.stderr);
  assert.deepEqual([x.r.status, x.r.stderr], [1, 'A6-SICHT inhalt\n'], 'nicht am vorgesehenen Mechanismus abgelehnt');
  assert.equal(x.zusatz.konfig, K2_KONFIG, 'Muss-Treffer: die praeparierte Konfiguration lag in der Sicht');
  assert.ok(x.zusatz.gitLief, 'git nicht verfuegbar');
  assert.equal(x.zusatz.gegenprobe, true, 'Gegenprobe: Git haette den Marker anlegen muessen');
  assert.deepEqual(x.zusatz.vorGegenprobe, [], 'Marker entstand vor der Gegenprobe');
  assert.deepEqual(x.zusatz.nachGegenprobe, [], 'Marker ausserhalb der Gegenprobe-Kopie');
  assert.equal(x.zusatz.arbeitGit, false, '.git im Arbeitsordner');
  assert.deepEqual(x.arbeit, basis.arbeit, 'Arbeitsordner hat neue oder fehlende Eintraege');
  assert.deepEqual([x.rechne, x.test], ['alt rechne\n', 'alt test\n'], 'Rueckkopie trotz Ablehnung');
});

test('Funktionen: a6_protokoll_auswerten startet den Auswerter nur nach dem Anker, ohne Netz, nur lesbar, Exitcode unveraendert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a6-diagnose-'));

  try {
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, '.github', 'agent'), { recursive: true });
    writeFileSync(join(ws, '.github', 'agent', 'a6-protokoll.mjs'), lies(`${ENTWURF}/a6-protokoll.mjs`));
    const protokoll = join(dir, 'protokoll.jsonl');
    writeFileSync(protokoll, '{}\n');
    const anker = /^ {2}A6_PROTOKOLL_SHA256: ([0-9a-f]{64})$/m.exec(WF)[1];
    const lauf = ({ a = anker, code = 0, datei = protokoll } = {}) => {
      const argv = join(dir, `argv-${Math.random().toString(16).slice(2)}`);
      const r = spawnSync('bash', ['-c', `source "$1"; docker() { printf "%s\\0" "$@" > "${argv}"; return ${code}; }; a6_protokoll_auswerten "$2"`, 'probe', join(ROOT, ENTWURF, 'a6-funktionen.sh'), datei], {
        encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_WORKSPACE: ws, A6_PROTOKOLL_SHA256: a, A6_NODE_IMAGE: 'a6-image', A6_DATEIEN: '["src/rechne.js"]' },
      });
      return { status: r.status, stdout: r.stdout, argv: existsSync(argv) ? readFileSync(argv, 'utf8').split('\0').slice(0, -1) : null };
    };

    const ok = lauf();
    assert.equal(ok.status, 0);
    const a = ok.argv;
    assert.deepEqual(a.slice(0, 2), ['run', '--rm']);
    assert.deepEqual(optionen(a, '--network'), ['none']);
    assert.ok(a.includes('--read-only') && optionen(a, '--cap-drop')[0] === 'ALL' && optionen(a, '--security-opt')[0] === 'no-new-privileges');
    assert.deepEqual(optionen(a, '--mount'), [
      `type=bind,src=${ws}/.github/agent/a6-protokoll.mjs,dst=/opt/a6/a6-protokoll.mjs,readonly`,
      `type=bind,src=${protokoll},dst=/opt/a6/protokoll.jsonl,readonly`,
    ]);
    assert.deepEqual(optionen(a, '--env'), ['A6_DATEIEN=["src/rechne.js"]', 'PATH=/usr/local/bin:/usr/bin:/bin']);
    assert.deepEqual(a.slice(a.indexOf('a6-image')), ['a6-image', 'node', '/opt/a6/a6-protokoll.mjs', '/opt/a6/protokoll.jsonl']);
    // Fehlendes Protokoll: keine Einhaengung, der Auswerter meldet "fehlt".
    assert.equal(optionen(lauf({ datei: join(dir, 'nicht-da.jsonl') }).argv, '--mount').length, 1);
    // Exitcode des Auswerters wird unveraendert weitergegeben, auch Alarm (1).
    assert.equal(lauf({ code: 1 }).status, 1);
    assert.equal(lauf({ code: 2 }).status, 2);
    assert.equal(lauf({ code: 125 }).status, 125);
    // Falscher Anker: kein Start, feste Zeile, nicht null.
    const falsch = lauf({ a: 'f'.repeat(64) });
    assert.deepEqual([falsch.status, falsch.stdout, falsch.argv], [2, 'A6-DIAGNOSE anker\n', null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Der Live-Schritt mit Claude: Aufruf und Auswertung durch Mitschreiber ersetzt, Rest wortgleich aus dem Entwurf.
const CLAUDE_SCHRITT = 'Claude im internen Netz hinter dem Vorschaltcontainer ausfuehren';

function liveClaudeSkript(wf = WF) {
  const s = schritte(jobs(wf).get('claude')).find(x => schrittName(x) === CLAUDE_SCHRITT);
  assert.ok(s, 'Claude-Schritt fehlt');
  assert.ok(!/^ {8}(continue-on-error|if):/m.test(s), 'Claude-Schritt mit continue-on-error oder if');
  const zeilen = s.split('\n');
  const start = zeilen.indexOf('        run: |');
  assert.ok(start > 0);
  return zeilen.slice(start + 1).filter(z => z.trim() !== '').map(z => z.slice(10)).join('\n') + '\n';
}

function liveClaude({ aufruf, protokoll, skript = liveClaudeSkript() }) {
  const dir = mkdtempSync(join(tmpdir(), 'a6-live-claude-'));

  try {
    mkdirSync(join(dir, 'ws', '.github', 'agent'), { recursive: true });
    mkdirSync(join(dir, 'rt'), { recursive: true });
    const datei = join(dir, 'rt', 'a6-claude-protokoll.jsonl');
    const spur = join(dir, 'spur');
    // Die Funktionsdatei ist ein Stellvertreter: nur Aufruf und Auswertung zaehlen, die Auswertung ist echt.
    writeFileSync(join(dir, 'ws', '.github', 'agent', 'a6-funktionen.sh'), [
      `a6_image_laden() { :; }`,
      `a6_grenzen() { A6_LAUFZEIT=15; A6_DATEIEN='["src/rechne.js","test/rechne.test.js"]'; export A6_DATEIEN; }`,
      `a6_proxy_starten() { :; }`,
      `a6_claude_aufruf() { cat > /dev/null; echo aufruf >> "${spur}"; ${protokoll === null ? ':' : `cat "${join(dir, 'quelle.jsonl')}" > "$1"`}; return ${aufruf}; }`,
      `a6_protokoll_auswerten() { echo diagnose >> "${spur}"; node "${AUSWERTER_ENTWURF}" "$1"; }`,
    ].join('\n'));

    if (protokoll !== null) {
      writeFileSync(join(dir, 'quelle.jsonl'), protokoll);
    }

    const vorspann = [
      'sha256sum() { cat > /dev/null; return 0; }',
      `jq() { echo jq >> "${spur}"; return 0; }`,
    ].join('\n');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `${vorspann}\n${skript}`], {
      cwd: join(dir, 'ws'), encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: join(dir, 'rt'), A6_PROMPT: 'Auftrag', A6_FUNKTIONEN_SHA256: 'x', A6_PROXY_IMAGE: 'a6-proxy-image', GITHUB_WORKSPACE: join(dir, 'ws') },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, spur: existsSync(spur) ? readFileSync(spur, 'utf8').split('\n').filter(Boolean) : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const AUSWERTER_ENTWURF = join(ROOT, ENTWURF, 'a6-protokoll.mjs');
const fixture = name => readFileSync(join(ROOT, 'test', 'fixtures', 'a6-k1a', `${name}.jsonl`), 'utf8');

test('Live-Claude-Schritt: Auswertung auch nach gescheitertem Aufruf, ein Fehlschlag bleibt immer ein Fehlschlag', () => {
  // Erfolg: Aufruf 0, Protokoll vollstaendig ohne Alarm, danach die bisherigen jq-Pruefungen.
  const ok = liveClaude({ aufruf: 0, protokoll: fixture('katalog') });
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr} ${ok.spur}`);
  assert.deepEqual(ok.spur, ['aufruf', 'diagnose', 'jq', 'jq']);
  assert.ok(ok.stdout.includes('A6-DIAGNOSE ok'));

  // Gescheiterter Aufruf mit auswertbarem Protokoll: Diagnose erreicht und ok, Schritt trotzdem rot.
  for (const code of [1, 124, 137]) {
    const r = liveClaude({ aufruf: code, protokoll: fixture('api-401') });
    assert.notEqual(r.status, 0, `Aufruf ${code}: Schritt gruen`);
    assert.deepEqual(r.spur, ['aufruf', 'diagnose'], `Aufruf ${code}: Reihenfolge`);
    assert.ok(r.stdout.includes('A6-PROTOKOLL vollstaendig') && r.stdout.includes('A6-LAUF fehler-api') && r.stdout.includes('A6-DIAGNOSE ok'));
    assert.ok(r.stdout.includes('A6-CLAUDE aufruf-fehlgeschlagen'));
  }

  // Gescheiterter Aufruf ohne oder mit abgeschnittenem Protokoll.
  const ohne = liveClaude({ aufruf: 1, protokoll: null });
  assert.notEqual(ohne.status, 0);
  assert.ok(ohne.stdout.includes('A6-PROTOKOLL fehlt') && ohne.stdout.includes('A6-CLAUDE aufruf-fehlgeschlagen'));
  const kurz = liveClaude({ aufruf: 124, protokoll: fixture('katalog').slice(0, -200) });
  assert.notEqual(kurz.status, 0);
  assert.ok(kurz.stdout.includes('A6-PROTOKOLL abgeschnitten'));

  // Erfolgreicher Aufruf, aber Diagnose nicht ok (fehlt, abgeschnitten, Alarm): Schritt rot, jq nie erreicht.
  // Alarm: die Ablehnung von K1A-N3 (/etc/hostname) konsistent in einen Erfolg verwandelt.
  const ereignisse = fixture('katalog').split('\n').filter(Boolean).map(z => JSON.parse(z));
  const nutzer = ereignisse.find(e => e.type === 'user' && e.message.content.some(b => b.tool_use_id === 'toolu_k1a_n3'));
  delete nutzer.message.content[0].is_error;
  nutzer.tool_result_meta[0].permission_decision.decision = 'accept';
  ereignisse.at(-1).permission_denials = ereignisse.at(-1).permission_denials.filter(d => d.tool_use_id !== 'toolu_k1a_n3');
  const alarm = `${ereignisse.map(e => JSON.stringify(e)).join('\n')}\n`;

  for (const [name, protokoll, zeile] of [['fehlt', null, 'A6-PROTOKOLL fehlt'], ['abgeschnitten', fixture('katalog').slice(0, -1), 'A6-PROTOKOLL abgeschnitten'], ['alarm', alarm, 'A6-ALARM erfolg-ausserhalb-profil']]) {
    const r = liveClaude({ aufruf: 0, protokoll });
    assert.notEqual(r.status, 0, `${name}: Schritt gruen`);
    assert.ok(r.stdout.includes(zeile), `${name}: ${r.stdout}`);
    assert.ok(r.stdout.includes('A6-CLAUDE diagnose-fehlgeschlagen'), name);
    assert.ok(!r.spur.includes('jq'), `${name}: jq trotz Diagnosefehler erreicht`);
  }
});

test('Live-Claude-Schritt: Gegenproben, jede Abschwaechung der Fehlerbehandlung faellt auf', () => {
  const skript = liveClaudeSkript();
  const ersetze = (alt, neu) => {
    assert.equal(skript.split(alt).length, 2, `Mutation nicht eindeutig: ${alt}`);
    return skript.replace(alt, () => neu);
  };
  const mutationen = {
    aufruf_verschluckt: ersetze('if [[ "$aufruf" != "0" ]]; then', 'if false; then'),
    diagnose_verschluckt: ersetze('if [[ "$diagnose" != "0" ]]; then', 'if false; then'),
    diagnose_ohne_status: ersetze('a6_protokoll_auswerten "$RUNNER_TEMP/a6-claude-protokoll.jsonl" || diagnose=$?', 'a6_protokoll_auswerten "$RUNNER_TEMP/a6-claude-protokoll.jsonl" || true'),
    diagnose_nach_abbruch: ersetze('printf \'%s\' "$A6_PROMPT" | a6_claude_aufruf "$RUNNER_TEMP/a6-claude-protokoll.jsonl" || aufruf=$?', 'printf \'%s\' "$A6_PROMPT" | a6_claude_aufruf "$RUNNER_TEMP/a6-claude-protokoll.jsonl"'),
  };
  const faelle = [
    { aufruf: 1, protokoll: fixture('api-401') },
    { aufruf: 0, protokoll: null },
  ];

  // Muss-Treffer: das unveraenderte Skript erreicht in beiden Faellen die Diagnose und bleibt rot. Sonst
  // waere jede Mutation nur deshalb "erkannt", weil der Lauf schon vorher scheitert.
  for (const f of faelle) {
    const r = liveClaude(f);
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.spur, ['aufruf', 'diagnose'], `Muss-Treffer: ${r.stderr}`);
    assert.ok(r.stdout.includes('A6-DIAGNOSE') && r.stdout.includes('A6-CLAUDE '), r.stdout);
  }

  for (const [name, mutiert] of Object.entries(mutationen)) {
    const erkannt = faelle.some(f => {
      const r = liveClaude({ ...f, skript: mutiert });
      return r.status === 0 || !r.spur.includes('diagnose');
    });
    assert.ok(erkannt, `${name}: nicht erkannt`);
  }
});

test('Generalprobe: K1a-Auswertung und K2-Negativfall sind in Job 1 der Probe verdrahtet', () => {
  const s = schritte(J.get('probe_claude'));
  const claude = s.find(x => schrittName(x) === 'Claude-Container hinter dem Vorschaltcontainer (Platzhalter, Ersatz, Isolation)');
  const sicht = s.find(x => schrittName(x) === 'Sicht pruefen, Manipulationen ablehnen, Aenderung uebernehmen');
  const nach = s.find(x => schrittName(x) === 'Job 1b auf frischem synthetischem Checkout');
  const reihenfolge = (text, teile) => {
    const stellen = teile.map(t => text.indexOf(t));
    assert.ok(stellen.every(x => x > 0), JSON.stringify(stellen));
    assert.deepEqual([...stellen].sort((a, b) => a - b), stellen);
  };

  reihenfolge(claude, [
    'printf \'%s  %s\\n\' "$A6_ERSATZ_K2_SHA256" "$K2ERSATZ" | sha256sum -c --status',
    'a6_claude_aufruf "$O/claude-platzhalter.jsonl"; then',
    'a6_protokoll_auswerten "$O/claude-platzhalter.jsonl" > "$O/diagnose-platzhalter.txt"',
    "grep -qx 'A6-DIAGNOSE ok' \"$O/diagnose-platzhalter.txt\"",
    'if a6_protokoll_auswerten "$O/claude-abgeschnitten.jsonl"',
    'a6_sicht_anlegen "$RUNNER_TEMP/a6-claude-arbeit" "$O/k2/a6-claude-sicht"',
    'A6_EINHAENGEN=(--mount "type=bind,src=$K2ERSATZ,dst=/opt/a6/claude-ersatz-k2.mjs,readonly")',
    '( export RUNNER_TEMP="$O/k2"; a6_claude_container node /opt/a6/claude-ersatz-k2.mjs git-ablage /arbeit )',
  ]);
  reihenfolge(sicht, [
    'a6_claude_beendet',
    "grep -qx $'\\tfsmonitor = touch a6-k2-marker' \"$K2S/.git/config\"",
    'if a6_sicht_uebernehmen "$ARBEIT" "$K2S" 2> "$O/k2.err"; then',
    'test "$(cat "$O/k2.err")" = "A6-SICHT inhalt"',
    'test ! -e "$ARBEIT/.git"',
    'test -e "$O/k2-gegenprobe/a6-k2-marker"',
    'test -z "$(find "$WURZEL" "$GITHUB_WORKSPACE" -name a6-k2-marker -print -quit)"',
    'a6_sicht_uebernehmen "$ARBEIT" "$SICHT"',
  ]);
  reihenfolge(nach, [
    'agent-code-job-claude-nach.mjs',
    'git -C "$O/checkout" rev-parse --git-dir > /dev/null',
    'test -z "$(git -C "$O/checkout" config --get core.fsmonitor || true)"',
    'test -z "$(find "$RUNNER_TEMP" "$GITHUB_WORKSPACE" -name a6-k2-marker -print -quit)"',
  ]);
  // Der K2-Ersatz faehrt nie Git und legt den Marker nie an; er ist an seinen SHA-256 gebunden.
  const k2 = lies('generalprobe/claude-ersatz-k2.mjs');
  assert.ok(!/child_process|spawn|exec/.test(k2));
  assert.equal(K2_KONFIG, '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch a6-k2-marker\n');
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

// ---------------------------------------------------------------------------
// K3: Nutzlast-Hashes in Job 0 (nur SHA-256 von title, body, updated_at aus GITHUB_EVENT_PATH)
// ---------------------------------------------------------------------------

const K3_NAME = 'K3 Nutzlast-Hashes protokollieren';
const K3_FELDER = Object.freeze(['title', 'body', 'updated_at']);
const K3_SKRIPT = Object.freeze([
  'set -euo pipefail',
  'test -f "$GITHUB_EVENT_PATH"',
  `jq -e '(.issue | type) == "object" and (.issue | has("title") and has("body") and has("updated_at"))' "$GITHUB_EVENT_PATH" > /dev/null`,
  ...K3_FELDER.map(f => `${f}_sha256="$(jq -c '.issue.${f}' "$GITHUB_EVENT_PATH" | sha256sum | cut -d ' ' -f 1)"`),
  'for wert in "$title_sha256" "$body_sha256" "$updated_at_sha256"; do',
  '  [[ "$wert" =~ ^[0-9a-f]{64}$ ]] || exit 1',
  'done',
  ...K3_FELDER.map(f => `printf 'A6-NUTZLAST ${f} %s\\n' "$${f}_sha256"`),
]);

const schrittName = s => /^ {6}- name: (.+)$/m.exec(s)?.[1];

// Struktur: genau zwischen Repository laden und Auftragspruefung, nur name und run, keine Interpolation,
// kein Fehler-Verschlucken, Skript zeilengenau. Ergebnis: das Skript des Schritts.
function k3Struktur(wf) {
  const s = schritte(jobs(wf).get('auftrag'));
  const namen = s.map(schrittName);
  assert.deepEqual(namen.slice(0, 3), ['Repository laden', K3_NAME, 'Auftrag pruefen und Schnappschuss erzeugen'], `Reihenfolge in Job 0: ${namen}`);
  assert.equal(namen.filter(n => n === K3_NAME).length, 1, 'Messschritt doppelt');
  const k3 = s[1];
  assert.ok(!k3.includes('${{'), 'Interpolation im Messschritt');
  const zeilen = k3.split('\n').filter(z => z.trim() !== '');
  assert.deepEqual(zeilen.slice(0, 2), [`      - name: ${K3_NAME}`, '        run: |'], 'Messschritt hat weitere Schluessel');
  const skript = zeilen.slice(2);
  assert.ok(skript.every(z => z.startsWith('          ')), 'unerwartete Zeile im Messschritt');
  assert.deepEqual(skript.map(z => z.slice(10)), [...K3_SKRIPT], 'Skript des Messschritts weicht ab');
  return skript.map(z => z.slice(10)).join('\n') + '\n';
}

// Ersatz fuer jq und sha256sum als Shell-Funktionen (keine ausfuehrbare Datei in /tmp noetig).
const K3_ERSATZ = Object.freeze({
  jq_x: 'jq() { case "$1" in -e) return 0;; -cj) printf \'"x"\';; *) printf \'"x"\\n\';; esac; }',
  jq_fehler: 'jq() { return 5; }',
  jq_body_fehler: 'jq() { case "$*" in *.issue.body*) return 5;; esac; if [ "$1" = -e ]; then return 0; fi; printf \'"x"\\n\'; }',
  sha_fehler: 'sha256sum() { cat > /dev/null; return 3; }',
});

function k3Lauf(skript, ereignis, ersatz = []) {
  const dir = mkdtempSync(join(tmpdir(), 'a6-k3-'));

  try {
    const datei = join(dir, 'ereignis.json');
    writeFileSync(datei, typeof ereignis === 'string' ? ereignis : JSON.stringify(ereignis));
    const vorspann = ersatz.map(n => K3_ERSATZ[n]).join('\n');
    const r = spawnSync('bash', ['-c', `${vorspann}\n${skript}`], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: datei } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, eintraege: readdirSync(dir).sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const k3Soll = werte => K3_FELDER.map(f => `A6-NUTZLAST ${f} ${sha256(`${werte[f]}\n`)}\n`).join('');
const K3_EREIGNIS = { action: 'labeled', issue: { number: 83, title: 'x', body: null, updated_at: 'x' } };

// Verhalten ohne echtes jq: richtige Hash-Pipeline und keine Ausgabe, sobald jq oder sha256sum scheitert.
function k3Verhalten(skript) {
  const x = k3Lauf(skript, K3_EREIGNIS, ['jq_x']);
  assert.deepEqual([x.status, x.stdout], [0, k3Soll({ title: '"x"', body: '"x"', updated_at: '"x"' })], 'Hash-Ausgabe falsch');

  for (const ersatz of [['jq_fehler'], ['jq_body_fehler'], ['jq_x', 'sha_fehler']]) {
    const r = k3Lauf(skript, K3_EREIGNIS, ersatz);
    assert.notEqual(r.status, 0, `${ersatz}: Fehler verdeckt`);
    assert.equal(r.stdout, '', `${ersatz}: Messnachweis trotz Fehler`);
  }
}

const k3Gesamt = wf => k3Verhalten(k3Struktur(wf));

test('K3: Messschritt direkt nach Repository laden und vor der Auftragspruefung, nur Hashes, Fehler in jq ohne Ausgabe', () => {
  k3Gesamt(WF);
  // Job 0 hat genau vier Schritte: Laden, Messen, Auftrag pruefen, Schnappschuss sichern.
  assert.equal(schritte(J.get('auftrag')).length, 4);
});

test('K3: mit echtem jq genau drei Hashes der jq-c-Darstellung, body null als JSON-null, nie Rohwerte, nichts ausgefuehrt', t => {
  if (spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status !== 0) {
    t.skip('jq fehlt in dieser Umgebung; Struktur und Fehlerfaelle prueft der Test davor ohne jq');
    return;
  }

  const skript = k3Struktur(WF);
  const titel = 'K3 "Titel" $(touch boese) `touch boese2` ; touch boese3 \u00FC';
  const beschreibung = 'Zeile 1\nZeile 2 mit \\ und "Zitat"';

  for (const [body, sollBody] of [[null, 'null'], [beschreibung, JSON.stringify(beschreibung)]]) {
    const ereignis = { action: 'labeled', label: { name: 'bot-auftrag' }, issue: { number: 83, title: titel, body, updated_at: '2026-11-17T10:00:00Z', user: { login: 'x' } } };
    const r = k3Lauf(skript, ereignis);
    assert.deepEqual([r.status, r.stderr], [0, '']);
    assert.equal(r.stdout, k3Soll({ title: JSON.stringify(titel), body: sollBody, updated_at: '"2026-11-17T10:00:00Z"' }));
    assert.ok(!r.stdout.includes('Titel') && !r.stdout.includes('Zeile'), 'Rohwert im Protokoll');
    assert.deepEqual(r.eintraege, ['ereignis.json'], 'Inhalt des Issues wurde ausgefuehrt');
  }

  // body null und body "null" sind verschieden.
  assert.notEqual(sha256('null\n'), sha256('"null"\n'));

  // Fehlendes Feld, fehlendes issue, kaputtes JSON, fehlende Datei: Abbruch ohne Messnachweis.
  const ohne = feld => ({ issue: Object.fromEntries(Object.entries({ title: 't', body: null, updated_at: 'u' }).filter(([k]) => k !== feld)) });
  for (const [name, ereignis] of [['title', ohne('title')], ['body', ohne('body')], ['updated_at', ohne('updated_at')], ['issue', { action: 'labeled' }], ['issue-kein-objekt', { issue: 'x' }], ['json', '{"issue": ']]) {
    const r = k3Lauf(skript, ereignis);
    assert.notEqual(r.status, 0, `${name}: angenommen`);
    assert.equal(r.stdout, '', `${name}: Messnachweis trotz Fehler`);
  }

  const fehlt = spawnSync('bash', ['-c', skript], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: '/a6-gibt-es-nicht/ereignis.json' } });
  assert.deepEqual([fehlt.status !== 0, fehlt.stdout], [true, '']);
});

// Gegenproben: jede Mutation des Workflow-Texts muss am K3-Waechter scheitern.
const K3_TITEL_ZEILE = `          title_sha256="$(jq -c '.issue.title' "$GITHUB_EVENT_PATH" | sha256sum | cut -d ' ' -f 1)"\n`;
const K3_BODY_ZEILE = `          body_sha256="$(jq -c '.issue.body' "$GITHUB_EVENT_PATH" | sha256sum | cut -d ' ' -f 1)"\n`;
const K3_BODY_AUSGABE = `          printf 'A6-NUTZLAST body %s\\n' "$body_sha256"\n`;
const k3Block = wf => {
  const start = wf.indexOf(`      - name: ${K3_NAME}\n`);
  const ende = wf.indexOf('      - name: Auftrag pruefen und Schnappschuss erzeugen\n');
  assert.ok(start > 0 && ende > start);
  return wf.slice(start, ende);
};
const ersetze = (wf, alt, neu) => {
  assert.equal(wf.split(alt).length, 2, `Mutation nicht eindeutig: ${alt}`);
  return wf.replace(alt, () => neu);
};
const K3_MUTATIONEN = Object.freeze({
  schritt_fehlt: wf => wf.replace(k3Block(wf), ''),
  hinter_auftragspruefung: wf => {
    const block = k3Block(wf);
    const ohne = wf.replace(block, '');
    const nach = ohne.indexOf('      - name: Schnappschuss als Artefakt sichern\n');
    return ohne.slice(0, nach) + block + ohne.slice(nach);
  },
  interpolation_titel: wf => ersetze(wf, K3_TITEL_ZEILE, `          printf '%s' "\${{ github.event.issue.title }}" > /dev/null\n${K3_TITEL_ZEILE}`),
  interpolation_env: wf => ersetze(wf, `      - name: ${K3_NAME}\n`, `      - name: ${K3_NAME}\n        env:\n          TITEL: \${{ github.event.issue.title }}\n`),
  ausgabe_body_fehlt: wf => ersetze(wf, K3_BODY_AUSGABE, ''),
  falscher_hash: wf => ersetze(wf, K3_TITEL_ZEILE, K3_TITEL_ZEILE.replace('sha256sum', 'md5sum')),
  hash_ohne_zeilenende: wf => ersetze(wf, K3_TITEL_ZEILE, K3_TITEL_ZEILE.replace("jq -c '.issue.title'", "jq -cj '.issue.title'")),
  pipefail_fehlt: wf => ersetze(wf, '          set -euo pipefail\n          test -f "$GITHUB_EVENT_PATH"\n', '          set -eu\n          test -f "$GITHUB_EVENT_PATH"\n'),
  hash_in_printf: wf => ersetze(ersetze(wf, K3_BODY_ZEILE, ''), K3_BODY_AUSGABE, `          printf 'A6-NUTZLAST body %s\\n' "$(jq -c '.issue.body' "$GITHUB_EVENT_PATH" | sha256sum | cut -d ' ' -f 1)"\n`),
  fehler_verschluckt: wf => ersetze(wf, `      - name: ${K3_NAME}\n`, `      - name: ${K3_NAME}\n        continue-on-error: true\n`),
  rohwert_ausgabe: wf => ersetze(wf, K3_BODY_AUSGABE, `${K3_BODY_AUSGABE}          jq -r '.issue.title' "$GITHUB_EVENT_PATH"\n`),
});

test('K3: Gegenproben, jede Mutation des Messschritts scheitert am Waechter', () => {
  for (const [name, mutation] of Object.entries(K3_MUTATIONEN)) {
    const mutiert = mutation(WF);
    assert.notEqual(mutiert, WF, `${name}: Mutation wirkungslos`);
    assert.throws(() => k3Gesamt(mutiert), assert.AssertionError, `${name}: nicht erkannt`);
  }

  // Verhalten allein (ohne Strukturpruefung): diese Mutationen fallen auch beim Ausfuehren auf.
  for (const name of ['falscher_hash', 'hash_ohne_zeilenende', 'pipefail_fehlt', 'hash_in_printf', 'ausgabe_body_fehlt']) {
    const skript = k3Block(K3_MUTATIONEN[name](WF)).split('\n').filter(z => z.startsWith('          ')).map(z => z.slice(10)).join('\n');
    assert.throws(() => k3Verhalten(skript), assert.AssertionError, `${name}: im Verhalten nicht erkannt`);
  }
});

// ---------------------------------------------------------------------------
// B1.2 Job-Zusammenfassungen (ziel-b/b1-2-auftrag.md): Ausschneide-Proben, Wachen und Verhalten
// ---------------------------------------------------------------------------
// Diese Tests lesen den geschuetzten Stand (.github/workflows/agent-auftrag.yml und .github/agent/a6-funktionen.sh).
// Auf dem Bot-PR ohne Eigentuemer-Commit sind sie deshalb bewusst rot; sie werden nicht uebersprungen. Der Entwurf
// unter entwurf/a6-p1/ bleibt der bisher genehmigte Stand (A6_WORKFLOW_SHA256 oben, Funktionsanker darin).
//
// Was diese Tests NICHT zeigen: dass GitHub die Zusammenfassung anzeigt, job.status so setzt und die Warnungen als
// Anmerkung des Laufs zeigt (das zeigt die Generalprobe auf dem Eigentuemer-PR), und das echte docker (hier ein
// Ersatz im PATH, der nie das echte docker aufruft).

const WF_ZIEL = lies('.github/workflows/agent-auftrag.yml');
const FN_ZIEL = lies('.github/agent/a6-funktionen.sh');
const FN_ZIEL_PFAD = join(ROOT, '.github', 'agent', 'a6-funktionen.sh');
const FN_ALT_PFAD = join(ROOT, ENTWURF, 'a6-funktionen.sh');
const B12_JOBS = Object.freeze(['auftrag', 'claude', 'abnahme', 'veroeffentlichen', 'probe_auftrag', 'probe_claude', 'probe_abnahme', 'probe_veroeffentlichen', 'sammel']);
const B12_ERGEBNISSE = Object.freeze([['AUFTRAG', 'auftrag'], ['CLAUDE', 'claude'], ['ABNAHME', 'abnahme'], ['VEROEFFENTLICHEN', 'veroeffentlichen'],
  ['PROBE_AUFTRAG', 'probe_auftrag'], ['PROBE_CLAUDE', 'probe_claude'], ['PROBE_ABNAHME', 'probe_abnahme'],
  ['PROBE_VEROEFFENTLICHEN', 'probe_veroeffentlichen'], ['PROBE_NEGATIV', 'probe_negativ'], ['PROBE_SAMMEL', 'probe_sammel_pruefung']]);
const B12_NAME = 'Bericht in die Zusammenfassung schreiben';
const b12Zeilen = job => [
  `      - name: ${B12_NAME}`,
  '        if: ${{ !cancelled() }}',
  '        continue-on-error: true',
  '        timeout-minutes: 1',
  '        env:',
  '          A6_JOB_STATUS: ${{ job.status }}',
  ...(job === 'sammel' ? B12_ERGEBNISSE.map(([k, n]) => `          A6_ERGEBNIS_${k}: \${{ needs.${n}.result }}`) : []),
  '        run: |',
  '          set -euo pipefail',
  '          printf \'%s  %s\\n\' "$A6_FUNKTIONEN_SHA256" .github/agent/a6-funktionen.sh | sha256sum -c --status || { echo "::warning title=A6-BERICHT::funktionen-hash"; exit 1; }',
  '          source .github/agent/a6-funktionen.sh',
  job === 'sammel' ? '          a6_bericht_sammel' : `          a6_bericht ${job}`,
];
const b12Schritt = job => `\n\n${b12Zeilen(job).join('\n')}`;
const B12_MARKE = '\n# ---------------------------------------------------------------------------------------------------\n# B1.2 Job-Zusammenfassungen:';
const B12_AUFRUF_ALT = '  docker run --rm --pull=never --network "$netz" --read-only --cap-drop ALL \\\n';
const B12_AUFRUF_NEU = `  a6_mitschnitt ${B12_AUFRUF_ALT.slice(2)}`;
const B12_FUNKTIONEN = Object.freeze(['a6_bericht_eigen', 'a6_bericht_ordner', 'a6_mitschnitt', 'a6_bericht_warnung', 'a6_bericht_ziel', 'a6_bericht_kosten', 'a6_bericht', 'a6_bericht_sammel']);
const B12_GRUENDE = Object.freeze(['job-ungueltig', 'ziel-ungueltig', 'funktionen-hash', 'image', 'start', 'pruefung', 'integritaet', 'nicht-geschrieben']);
const anker = (wf, name) => {
  const m = [...wf.matchAll(new RegExp(`^ {2}${name}: ([0-9a-f]{64})$`, 'gm'))];
  assert.equal(m.length, 1, `${name} nicht genau einmal`);
  return m[0][1];
};

// K3 Punkt 1: der Workflow ohne genau die neun Berichtsschritte und mit dem bisherigen Funktionsanker. Jeder
// Schritt muss woertlich, genau einmal und als letzter Schritt in genau seinem Job stehen.
function workflowOhneBericht(wf, fn = FN_ZIEL) {
  const jobsZiel = jobs(wf);

  for (const job of B12_JOBS) {
    const letzter = schritte(jobsZiel.get(job) ?? '').at(-1) ?? '';
    assert.equal(letzter.trimEnd(), b12Zeilen(job).join('\n'), `${job}: Berichtsschritt fehlt, weicht ab oder ist nicht der letzte Schritt`);
  }

  let rest = wf;

  for (const job of B12_JOBS) {
    assert.equal(rest.split(b12Schritt(job)).length, 2, `${job}: Berichtsschritt nicht genau einmal`);
    rest = rest.replace(b12Schritt(job), () => '');
  }

  assert.ok(!/a6_bericht|A6_JOB_STATUS|A6_ERGEBNIS_|A6-BERICHT|continue-on-error: true/.test(rest), 'Reste von Berichtsschritten ausserhalb der neun');
  assert.equal(anker(rest, 'A6_FUNKTIONEN_SHA256'), sha256(fn), 'Funktionsanker passt nicht zur Funktionsdatei');
  return rest.replace(`  A6_FUNKTIONEN_SHA256: ${sha256(fn)}\n`, () => `  A6_FUNKTIONEN_SHA256: ${anker(WF, 'A6_FUNKTIONEN_SHA256')}\n`);
}

// K3 Punkt 2: die Funktionsdatei ohne den B1.2-Block am Dateiende und mit dem alten docker-run-Aufruf in
// a6_container. Der Block enthaelt nur Funktionsdefinitionen (beim Laden wird nichts ausgefuehrt).
function funktionenOhneBericht(fn) {
  const i = fn.indexOf(B12_MARKE);
  assert.ok(i > 0 && fn.indexOf(B12_MARKE, i + 1) < 0, 'B1.2-Block nicht genau einmal');
  const vorn = fn.slice(0, i);
  const block = fn.slice(i);
  assert.equal(vorn.split(B12_AUFRUF_NEU).length, 2, 'a6_mitschnitt nicht genau einmal vor docker run');
  const start = vorn.indexOf('a6_container() {');
  const ende = vorn.indexOf('\n}\n', start);
  const stelle = vorn.indexOf(B12_AUFRUF_NEU);
  assert.ok(start > 0 && stelle > start && stelle < ende, 'a6_mitschnitt nicht in a6_container');
  assert.ok(!/a6_mitschnitt|a6_bericht/.test(vorn.replace(B12_AUFRUF_NEU, '')), 'B1.2-Aufruf ausserhalb des Blocks');

  // Oberste Ebene des Blocks: nur Leerzeilen, Kommentare, Funktionskoepfe und schliessende Klammern.
  const namen = [];

  for (const zeile of block.split('\n')) {
    if (zeile === '' || zeile.startsWith('#') || zeile === '}' || /^\s/.test(zeile)) {
      continue;
    }

    const m = /^([a-z0-9_]+)\(\) \{$/.exec(zeile);
    assert.ok(m, `Anweisung auf oberster Ebene im B1.2-Block: ${zeile}`);
    namen.push(m[1]);
  }

  assert.deepEqual(namen, [...B12_FUNKTIONEN]);
  assert.ok(block.endsWith('\n}\n'));
  return vorn.replace(B12_AUFRUF_NEU, () => B12_AUFRUF_ALT);
}

const pruefeWorkflowB12 = (wf, fn = FN_ZIEL) => {
  assert.equal(sha256(workflowOhneBericht(wf, fn)), A6_WORKFLOW_SHA256);
  assert.equal(anker(wf, 'A6_FUNKTIONEN_SHA256'), sha256(fn));
};
const pruefeFunktionenB12 = fn => {
  const alt = funktionenOhneBericht(fn);
  assert.equal(alt, FN);
  assert.equal(sha256(alt), anker(WF, 'A6_FUNKTIONEN_SHA256'));
};

test('B1.2 T13: Ausschneide-Probe Workflow, ohne die neun Berichtsschritte byte-gleich mit dem genehmigten Stand', () => {
  pruefeWorkflowB12(WF_ZIEL);
  assert.notEqual(sha256(WF_ZIEL), A6_WORKFLOW_SHA256, 'Muss-Treffer: der geschuetzte Workflow traegt die Berichtsschritte');
  // Jobs ohne Bericht: Negativfaelle und Sammelkette der Probe.
  const jobsZiel = jobs(WF_ZIEL);
  assert.deepEqual([...jobsZiel.keys()], [...J.keys()]);

  for (const job of ['probe_negativ', 'probe_sammel_a', 'probe_sammel_b', 'probe_sammel_pruefung']) {
    assert.equal(jobsZiel.get(job), J.get(job), job);
  }
});

test('B1.2 T13: Ausschneide-Probe Funktionen, ohne den B1.2-Block und mit dem alten docker run byte-gleich', () => {
  pruefeFunktionenB12(FN_ZIEL);
  assert.notEqual(FN_ZIEL, FN, 'Muss-Treffer: die geschuetzte Funktionsdatei traegt den Block');
});

const B12_WF_MUTATIONEN = Object.freeze({
  bestehender_schritt: wf => wf.replace('    timeout-minutes: 10\n    permissions:\n      contents: read\n      issues: read', '    timeout-minutes: 11\n    permissions:\n      contents: read\n      issues: read'),
  job_bedingung_always: wf => wf.replace("    needs: auftrag\n    # P-4: Live-Schalter entfernt. Nur issues auf main, nur nach erfolgreichen Vorgaengern.\n    if: >-\n", "    needs: auftrag\n    # P-4: Live-Schalter entfernt. Nur issues auf main, nur nach erfolgreichen Vorgaengern.\n    if: >-\n      always() &&\n"),
  bericht_always: wf => wf.replace(b12Schritt('auftrag'), () => b12Schritt('auftrag').replace('!cancelled()', 'always()')),
  bericht_ohne_bedingung: wf => wf.replace(b12Schritt('veroeffentlichen'), () => b12Schritt('veroeffentlichen').replace('        if: ${{ !cancelled() }}\n', '')),
  bericht_zeitgrenze: wf => wf.replace(b12Schritt('probe_claude'), () => b12Schritt('probe_claude').replace('        timeout-minutes: 1\n', '        timeout-minutes: 5\n')),
  ohne_continue_on_error: wf => wf.replace(b12Schritt('abnahme'), () => b12Schritt('abnahme').replace('        continue-on-error: true\n', '')),
  bericht_mit_secret: wf => wf.replace(b12Schritt('claude'), () => b12Schritt('claude').replace('          A6_JOB_STATUS: ${{ job.status }}\n', '          A6_JOB_STATUS: ${{ job.status }}\n          A6_X: ${{ secrets.ANTHROPIC_API_KEY }}\n')),
  vertauschte_jobs: wf => wf.replace('          a6_bericht auftrag\n', '          a6_bericht XX\n').replace('          a6_bericht claude\n', '          a6_bericht auftrag\n').replace('          a6_bericht XX\n', '          a6_bericht claude\n'),
  zusaetzlicher_bericht: wf => wf.replace('          a6_probe negativ "$RUNNER_TEMP/a6-negativ"\n', `          a6_probe negativ "$RUNNER_TEMP/a6-negativ"${b12Schritt('auftrag')}\n`),
  bericht_nicht_letzter: wf => {
    const s = b12Schritt('auftrag');
    const ohne = wf.replace(s, '');
    return ohne.replace('\n\n      - name: Schnappschuss als Artefakt sichern\n', `${s}\n\n      - name: Schnappschuss als Artefakt sichern\n`);
  },
  anker_falsch: wf => wf.replace(/^ {2}A6_FUNKTIONEN_SHA256: [0-9a-f]{64}$/m, `  A6_FUNKTIONEN_SHA256: ${'0'.repeat(64)}`),
  sammel_ergebnis_vertauscht: wf => wf.replace('          A6_ERGEBNIS_CLAUDE: ${{ needs.claude.result }}', '          A6_ERGEBNIS_CLAUDE: ${{ needs.abnahme.result }}'),
  artefakt_bericht: wf => wf.replace('          path: ${{ runner.temp }}/a6-auftrag/schnappschuss.json\n', '          path: ${{ runner.temp }}/a6-bericht/\n'),
});

const B12_FN_MUTATIONEN = Object.freeze({
  container_netz: fn => fn.replace('    --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2 \\\n    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777 \\\n    --mount "type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly" \\\n    --mount "type=bind,src=$RUNNER_TEMP,dst=$RUNNER_TEMP" \\\n    --workdir "$GITHUB_WORKSPACE" --env PATH=/usr/local/bin:/usr/bin:/bin \\\n    "${umgebung[@]}"', '    --security-opt no-new-privileges --pids-limit 512 --memory 2g --cpus 2 \\\n    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777 \\\n    --mount "type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly" \\\n    --mount "type=bind,src=$RUNNER_TEMP,dst=$RUNNER_TEMP" \\\n    --workdir "$GITHUB_WORKSPACE" --env PATH=/usr/local/bin:/usr/bin:/bin \\\n    "${umgebung[@]}"'),
  sammel_geaendert: fn => fn.replace('    if [[ "${paar#*=}" != "success" ]]; then', '    if [[ "${paar#*=}" != "success" && "${paar#*=}" != "skipped" ]]; then'),
  anweisung_im_block: fn => fn.replace('\na6_bericht() {\n', '\nexport A6_X=1\na6_bericht() {\n'),
  zusaetzliche_funktion: fn => `${fn}\na6_extra() {\n  :\n}\n`,
  ohne_mitschnitt: fn => fn.replace(B12_AUFRUF_NEU, B12_AUFRUF_ALT),
  mitschnitt_im_proxy: fn => fn.replace('  docker run -d --name "a6-proxy-$lauf"', '  a6_mitschnitt docker run -d --name "a6-proxy-$lauf"'),
});

test('B1.2 T13: jede zusaetzliche Aenderung macht die Ausschneide-Proben rot (Gegenproben)', () => {
  for (const [name, mutation] of Object.entries(B12_WF_MUTATIONEN)) {
    const mutiert = mutation(WF_ZIEL);
    assert.notEqual(mutiert, WF_ZIEL, `${name}: Mutation wirkungslos`);
    assert.throws(() => { pruefeWorkflowB12(mutiert); pruefeBerichtsschritte(mutiert); }, assert.AssertionError, `${name}: nicht erkannt`);
  }

  for (const [name, mutation] of Object.entries(B12_FN_MUTATIONEN)) {
    const mutiert = mutation(FN_ZIEL);
    assert.notEqual(mutiert, FN_ZIEL, `${name}: Mutation wirkungslos`);
    assert.throws(() => pruefeFunktionenB12(mutiert), assert.AssertionError, `${name}: nicht erkannt`);
  }
});

// K3 Punkt 4: genau diese Schritte, genau diese Felder, kein secrets., kein always(), continue-on-error und Zeitgrenze.
function pruefeBerichtsschritte(wf) {
  const alle = [...jobs(wf)].flatMap(([job, text]) => schritte(text).map(s => [job, s])).filter(([, s]) => /a6_bericht|A6-BERICHT|A6_JOB_STATUS/.test(s));
  assert.deepEqual(alle.map(([job]) => job), [...B12_JOBS]);

  for (const [job, s] of alle) {
    assert.equal(s.trimEnd(), b12Zeilen(job).join('\n'), job);
    assert.ok(!s.includes('secrets.') && !s.includes('always()') && !/^ {8}id:/m.test(s) && !s.includes('github.token'), job);
    assert.ok(s.includes('        if: ${{ !cancelled() }}\n        continue-on-error: true\n        timeout-minutes: 1\n'), job);
  }

  assert.equal((wf.match(/continue-on-error/g) ?? []).length, B12_JOBS.length, 'continue-on-error ausserhalb der Berichtsschritte');
  assert.equal((wf.match(/\ba6_bericht\b/g) ?? []).length, B12_JOBS.length - 1);
  assert.equal((wf.match(/\ba6_bericht_sammel\b/g) ?? []).length, 1);

  // K8: kein Artefaktpfad enthaelt a6-bericht.
  const pfade = [...wf.matchAll(/^ {10}path: (.+)$/gm)].map(m => m[1]);
  assert.ok(pfade.length >= 10, 'Muss-Treffer: Artefaktpfade gefunden');
  assert.ok(pfade.every(p => !p.includes('a6-bericht')), pfade.join(', '));
  assert.ok(pfade.every(p => p.startsWith('${{ runner.temp }}/')), pfade.join(', '));
}

test('B1.2 Wache: genau neun Berichtsschritte mit genau diesen Feldern, ohne Secrets, ohne always(), nie in einem Artefakt', () => {
  pruefeBerichtsschritte(WF_ZIEL);
  // Job-Bedingungen, Rechte, Secrets je Job und Umgebung sind gleich dem genehmigten Stand (K3 Punkt 3).
  const jobsZiel = jobs(WF_ZIEL);

  for (const [name, text] of J) {
    assert.equal(bedingung(jobsZiel.get(name)), bedingung(text), `${name}: Bedingung`);
    assert.deepEqual([...jobsZiel.get(name).matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/g)].map(m => m[1]), [...text.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/g)].map(m => m[1]), `${name}: Secrets`);
    assert.equal(/^ {4}permissions:[^\n]*(\n {6}.+)*/m.exec(jobsZiel.get(name))[0], /^ {4}permissions:[^\n]*(\n {6}.+)*/m.exec(text)[0], `${name}: permissions`);
  }
});

function funktion(fn, name) {
  const start = fn.indexOf(`\n${name}() {\n`);
  assert.ok(start > 0, `${name} fehlt`);
  return fn.slice(start + 1, fn.indexOf('\n}\n', start) + 2);
}

test('B1.2 T14 und T23 statisch: a6_bericht nur ohne Netz, drei feste Einhaengungen, keine Secrets, feste Jobnamen; Rohr sicher', () => {
  const b = funktion(FN_ZIEL, 'a6_bericht');
  assert.deepEqual([...b.matchAll(/--network \S+/g)].map(m => m[0]), ['--network none']);
  assert.deepEqual([...b.matchAll(/--mount "([^"]+)"/g)].map(m => m[1]), [
    'type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly',
    'type=bind,src=$basis,dst=/a6/bericht,readonly',
    'type=bind,src=$ziel,dst=/a6/zusammenfassung',
  ]);
  assert.ok(b.includes('local job="${1:-}" ziel="${GITHUB_STEP_SUMMARY:-}" basis="$RUNNER_TEMP/a6-bericht"'));
  assert.ok(!/src=\$RUNNER_TEMP[,"]/.test(b) && !b.includes('src=$RUNNER_TEMP,dst'), 'ganz RUNNER_TEMP eingehaengt');
  assert.deepEqual([...b.matchAll(/--env \S+/g)].map(m => m[0]), ['--env A6_BERICHT_JOB', '--env A6_JOB_STATUS)', '--env PATH=/usr/local/bin:/usr/bin:/bin']);
  assert.ok(!/TOKEN|ANTHROPIC|secrets|--env-file|\s-e\s|--privileged|--cap-add|docker\.sock|--network bridge|--pull=always/.test(b));
  for (const teil of ['--rm --pull=never --network none --read-only --cap-drop ALL', '--security-opt no-new-privileges', '--user "$(id -u):$(id -g)"', '"$A6_NODE_IMAGE" /bin/sh -euc']) {
    assert.ok(b.includes(teil), teil);
  }
  assert.ok(b.includes('[[ ! "$job" =~ ^(auftrag|claude|abnahme|veroeffentlichen|probe_auftrag|probe_claude|probe_abnahme|probe_veroeffentlichen)$ ]]'));
  // Kein Netz, nirgends im B1.2-Block: kein Laden eines Images, kein pull; fehlt das Image, nur die Warnung image.
  const block = FN_ZIEL.slice(FN_ZIEL.indexOf(B12_MARKE));
  assert.ok(!/a6_image_laden|docker pull|image pull|--pull=always|--network bridge|--network host/.test(block), 'Netz im B1.2-Block');
  assert.ok(b.includes('  if ! docker image inspect "$A6_NODE_IMAGE" > /dev/null 2>&1; then\n    a6_bericht_warnung image\n    return 1\n  fi\n'));
  // Die Sammeltabelle startet nie einen Container und ruft docker nie auf.
  assert.ok(!/docker|--mount|--env/.test(funktion(FN_ZIEL, 'a6_bericht_sammel')));
  // Eigentuemer ueber stat und id (wie -O); an beiden Stellen genutzt, -O selbst kommt im Block nicht mehr vor.
  assert.ok(!/\s-O\s/.test(block));
  assert.equal((block.match(/a6_bericht_eigen "\$(ordner|basis)"/g) ?? []).length, 2);
  // Startblock im Container wie bei a6_container: Umgebung, Node-Version, Anker, Integritaetspruefer, dann das Skript.
  const reihenfolge = ['unset NODE_VERSION YARN_VERSION', 'grep -q "^NODE_"', 'node --version', 'scripts/agent-code-integritaet.mjs | sha256sum -c --status', 'node scripts/agent-code-integritaet.mjs || exit 4', 'exec node scripts/agent-code-job-bericht.mjs'];
  const stellen = reihenfolge.map(t => b.indexOf(t));
  assert.ok(stellen.every(s => s > 0) && [...stellen].sort((x, y) => x - y).join() === stellen.join(), JSON.stringify(stellen));

  // Warnungen nur aus der festen Liste.
  const w = funktion(FN_ZIEL, 'a6_bericht_warnung');
  assert.ok(w.includes(`    ${B12_GRUENDE.join('|')})\n`));
  assert.deepEqual([...FN_ZIEL.matchAll(/a6_bericht_warnung ([a-z-]+)/g)].map(m => m[1]).filter(g => !B12_GRUENDE.includes(g)), []);
  assert.deepEqual([...FN_ZIEL.matchAll(/::warning title=A6-BERICHT::/g)].length, 2);

  // K8: kein mktemp -u; privates Verzeichnis mit mktemp -d, Rohr mit Modus 600, Pruefung auf Modus 700 und realpath.
  const m = funktion(FN_ZIEL, 'a6_mitschnitt');
  assert.ok(!/mktemp\s+(-[a-zA-Z]*u|--dry-run)/.test(FN_ZIEL), 'mktemp -u');
  for (const teil of ['mktemp -d "$basis/lauf.XXXXXXXX"', 'mkfifo -m 600 -- "$tmp/rohr"', '"$(stat -c %a -- "$tmp" 2> /dev/null)" != "700"', '"$echt" != "$basis_echt"/lauf.*',
    'tee --output-error=warn "$tmp/mitschnitt" <&"$lese" >&2 2> "$tmp/tee-fehler" {schreiber}>&- {lese}<&- &', 'wait "$leser" || tee_rc=$?', '(( groesse <= 65536 ))', 'head -c 65536']) {
    assert.ok(m.includes(teil), teil);
  }
  // K9: Schreib- und Leseende oeffnet die Elternshell selbst, beide vor tee; tee liest nie den Pfad des Rohrs;
  // die Elternshell schliesst ihr Leseende nach dem Start von tee und vor dem Befehl.
  const k9 = ['{ exec {schreiber}<> "$tmp/rohr"; }', '{ exec {lese}< "$tmp/rohr"; }', 'tee --output-error=warn "$tmp/mitschnitt" <&"$lese"', '  leser=$!\n  exec {lese}<&-\n', '  "$@" 2>&"$schreiber" {schreiber}>&- || rc=$?', '  exec {schreiber}>&-\n  wait "$leser"'];
  const k9Stellen = k9.map(t => m.indexOf(t));
  assert.ok(k9Stellen.every(x => x > 0) && [...k9Stellen].sort((x, y) => x - y).join() === k9Stellen.join(), JSON.stringify(k9Stellen));
  assert.ok(!m.includes('< "$tmp/rohr" >&2') && (m.match(/"\$tmp\/rohr"/g) ?? []).length === 3, 'tee oeffnet das Rohr selbst');
  // Status wird erst nach wait geschrieben.
  assert.ok(m.indexOf('wait "$leser"') < m.indexOf('status=erfasst') && m.indexOf('wait "$leser"') < m.lastIndexOf('>> "$basis/status"'));
});

// ---------------------------------------------------------------------------
// B1.2 Verhalten mit Ersatz-docker (T12, T19, T21, T23, T24; T14, T20, T22 fuer a6_bericht)
// ---------------------------------------------------------------------------

const NUR_LINUX_B12 = process.platform === 'linux' ? false : 'braucht bash, mkfifo, GNU tee und /proc unter Linux; laeuft in CI';
// Offene Deskriptoren der Shell, die in einen Berichtsordner zeigen (Rohr, Mitschnitt, Status).
const B12_FDS = String.raw`for f in /proc/$$/fd/*; do l="$(readlink "$f" 2> /dev/null)" || continue; [[ "$l" == *a6-bericht* ]] && printf "%s\n" "$l"; done > "$RUNNER_TEMP/fds"`;
// Fester Pfad, damit ein eingeschraenkter PATH im Test (ohne docker) bash selbst nicht verliert.
const B12_BASH = NUR_LINUX_B12 ? 'bash' : spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

// Ersatz fuer docker im PATH. run: schreibt B12_STDOUT und B12_STDERR (Dateien) und endet mit B12_RC; mit
// B12_WARTEN schreibt es eine Fehlerzeile, legt die Marke an und wartet. image/pull fuer a6_image_laden.
const ERSATZ_DOCKER = `#!/bin/bash
if [[ -n "\${B12_ARGV:-}" ]]; then
  n=0; while [[ -e "$B12_ARGV/$n" ]]; do n=$((n + 1)); done
  printf '%s\\0' "$@" > "$B12_ARGV/$n"
fi
case "$1" in
  image) [[ "\${B12_IMAGE_RC:-0}" == 0 ]] || exit "$B12_IMAGE_RC"; printf '["%s"]\\n' "$3"; exit 0 ;;
  pull) exit "\${B12_PULL_RC:-0}" ;;
esac
if [[ -n "\${B12_RECHTE:-}" ]]; then
  for d in "$RUNNER_TEMP"/a6-bericht/lauf.*; do stat -c '%a %F' -- "$d" "$d/rohr"; done > "$B12_RECHTE"
fi
if [[ -n "\${B12_SCHREIBE:-}" ]]; then
  for a in "$@"; do
    if [[ "$a" == type=bind,src=*,dst=/a6/zusammenfassung ]]; then z="\${a#type=bind,src=}"; printf 'ersatz\\n' >> "\${z%,dst=/a6/zusammenfassung}"; fi
  done
fi
if [[ -n "\${B12_WARTEN:-}" ]]; then
  printf '%s\\n' "$$" > "$B12_WARTEN"
  printf 'A6-FEHLER abnahme-exitcode\\n' >&2
  exec sleep 30
fi
[[ -z "\${B12_STDOUT:-}" ]] || cat -- "$B12_STDOUT"
[[ -z "\${B12_STDERR:-}" ]] || cat -- "$B12_STDERR" >&2
exit "\${B12_RC:-0}"
`;

function b12Ordner() {
  const dir = mkdtempSync(join(tmpdir(), 'a6-b12-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'docker'), ERSATZ_DOCKER, { mode: 0o755 });
  mkdirSync(join(dir, 'ws'));
  return dir;
}

function b12Env(dir, rt, extra = {}) {
  return {
    PATH: `${join(dir, 'bin')}:/usr/local/bin:/usr/bin:/bin`, HOME: dir, LC_ALL: 'C.UTF-8',
    GITHUB_WORKSPACE: join(dir, 'ws'), RUNNER_TEMP: rt, GITHUB_REPOSITORY: 'noah04091/agenten-probe',
    A6_NODE_IMAGE: `node@sha256:${'0'.repeat(64)}`, A6_NODE_VERSION: 'v0', A6_INTEGRITAET_SHA256: 'a'.repeat(64), A6_ATTRAPPE_SHA256: 'b'.repeat(64),
    ...extra,
  };
}

// Startet a6_container wie im Workflow (set -euo pipefail, Funktionsdatei geladen). vorspann ersetzt Werkzeuge
// als Shell-Funktion nach dem Laden. Ergebnis als Bytes.
function b12Container(fnPfad, dir, rt, { extra = {}, vorspann = '', nachher = '' } = {}) {
  mkdirSync(rt, { recursive: true });
  const skript = nachher === ''
    ? `set -euo pipefail\nsource "$1"\n${vorspann}\na6_container none "" agent-code-job-abnahme.mjs GITHUB_REPOSITORY`
    : `set -uo pipefail\nsource "$1"\n${vorspann}\nrc=0\na6_container none "" agent-code-job-abnahme.mjs GITHUB_REPOSITORY || rc=$?\n${nachher}\nexit "$rc"`;
  const r = spawnSync(B12_BASH, ['--noprofile', '--norc', '-c', skript, 'b12', fnPfad], { env: b12Env(dir, rt, extra), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(r.error, undefined, `bash: ${r.error}`);
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

const b12Lies = pfad => (existsSync(pfad) ? readFileSync(pfad, 'utf8') : null);
const b12Rest = rt => (existsSync(join(rt, 'a6-bericht')) ? readdirSync(join(rt, 'a6-bericht')).filter(n => n.startsWith('lauf.')) : []);

// Bash-Fehlermeldungen nennen Datei und Zeile des Aufrufs; nur dieser Vorspann darf abweichen.
const ohneOrt = puffer => puffer.toString('latin1').replace(/^[^\n]*?: line \d+: /gm, '');

function b12Gleich(alt, neu, name) {
  assert.equal(neu.signal, null, `${name}: Signal`);
  assert.equal(neu.status, alt.status, `${name}: Exitcode`);
  assert.ok(neu.stdout.equals(alt.stdout), `${name}: stdout weicht ab`);
  assert.ok(neu.stderr.equals(alt.stderr), `${name}: stderr weicht ab (${JSON.stringify(neu.stderr.toString('latin1').slice(0, 200))})`);
}

const B12_STDERR = Object.freeze({
  keine: Buffer.alloc(0),
  eine: Buffer.from('A6-FEHLER abnahme-exitcode\n'),
  zwei: Buffer.from('A6-FEHLER abnahme-exitcode\nA6-FEHLER abnahme-ausgabe\n'),
  start: Buffer.from('A6-START anker\n'),
  bytes: Buffer.concat([Buffer.from('vorher\r\nA6-FEHLER  doppelt\nA6-FEHLER abnahme-exitcode \n\0\xff\xfe\n', 'latin1'), Buffer.from('A6-FEHLER job-unbekannt\nÄ\n')]),
  ohne_ende: Buffer.from('rauschen\nA6-FEHLER abnahme-ausgabe'),
  gross: Buffer.concat([Buffer.from('A6-FEHLER abnahme-exitcode\n'), Buffer.alloc(1024 * 1024, 'x'), Buffer.from('\nA6-FEHLER abnahme-ausgabe\n')]),
});
const B12_FEHLER = Object.freeze({
  keine: null, eine: 'A6-FEHLER abnahme-exitcode\n', zwei: 'A6-FEHLER abnahme-exitcode\nA6-FEHLER abnahme-ausgabe\n', start: null,
  bytes: 'A6-FEHLER job-unbekannt\n', ohne_ende: 'A6-FEHLER abnahme-ausgabe\n', gross: 'A6-FEHLER abnahme-exitcode\n',
});

test('B1.2 T12: a6_container alt gegen neu mit Ersatz-docker: stdout, stderr und Exitcode byte-gleich, Fehlerdatei genau die passenden Zeilen', { skip: NUR_LINUX_B12 }, async () => {
  const { logAuszug } = await import('../werkzeuge/zentrale/log-auszug.mjs');
  const dir = b12Ordner();

  try {
    const aus = join(dir, 'stdout');
    writeFileSync(aus, Buffer.from('ausgabe\0\xff\nzweite', 'latin1'));
    let fall = 0;

    for (const [name, bytes] of Object.entries(B12_STDERR)) {
      for (const rc of [0, 1, 2, 137]) {
        const err = join(dir, `stderr-${name}`);
        writeFileSync(err, bytes);
        const extra = { B12_STDOUT: aus, B12_STDERR: err, B12_RC: String(rc) };
        const rtAlt = join(dir, `alt-${fall}`);
        const rtNeu = join(dir, `neu-${fall}`);
        fall += 1;
        const alt = b12Container(FN_ALT_PFAD, dir, rtAlt, { extra });
        const neu = b12Container(FN_ZIEL_PFAD, dir, rtNeu, { extra });
        b12Gleich(alt, neu, `${name}/${rc}`);
        assert.equal(neu.status, rc, `${name}/${rc}: Exitcode des Ersatz-docker`);
        assert.ok(neu.stderr.equals(bytes), `${name}/${rc}: stderr nicht genau die Bytes des Containers`);
        assert.deepEqual(logAuszug(neu.stderr.toString('utf8')), logAuszug(alt.stderr.toString('utf8')), `${name}/${rc}: logAuszug`);
        assert.ok(!existsSync(join(rtAlt, 'a6-bericht')), 'der alte Stand legt nichts an');
        assert.equal(b12Lies(join(rtNeu, 'a6-bericht', 'fehler')), B12_FEHLER[name], `${name}/${rc}: Fehlerdatei`);
        assert.equal(b12Lies(join(rtNeu, 'a6-bericht', 'status')), name === 'gross' ? 'unvollstaendig\n' : 'erfasst\n', `${name}/${rc}: Status`);
        assert.deepEqual(b12Rest(rtNeu), [], `${name}/${rc}: Rohr und Mitschnitt nicht entfernt`);
      }
    }

    // Nach der Rueckkehr laeuft kein tee mehr: keine Kindprozesse der Shell, keine Hintergrundjobs.
    const err = join(dir, 'stderr-eine');
    const nachher = `jobs -p > "$RUNNER_TEMP/jobs"\nfor p in /proc/[0-9]*; do f=(); read -r -a f < "$p/stat" 2> /dev/null || continue; [[ "\${f[3]:-}" == "$$" ]] && printf "%s\\n" "\${f[1]}"; done > "$RUNNER_TEMP/kinder"\n${B12_FDS}`;
    const rt = join(dir, 'prozesse');
    const r = b12Container(FN_ZIEL_PFAD, dir, rt, { extra: { B12_STDERR: err, B12_RC: '1' }, nachher });
    assert.equal(r.status, 1);
    assert.equal(readFileSync(join(rt, 'jobs'), 'utf8'), '');
    assert.equal(readFileSync(join(rt, 'kinder'), 'utf8'), '');
    // K9: die Elternshell haelt weder Schreib- noch Leseende des Rohrs offen.
    assert.equal(readFileSync(join(rt, 'fds'), 'utf8'), '');
    // Gegenprobe der Messung: ein absichtlich nicht abgewarteter Hintergrundprozess wird gefunden (vor seinem exec
    // heisst er noch bash, danach sleep) und erscheint auch in jobs -p.
    const g = b12Container(FN_ZIEL_PFAD, dir, join(dir, 'gegenprobe'), { extra: { B12_RC: '0' }, nachher: `sleep 5 &\nexec {g}< "$RUNNER_TEMP/a6-bericht/status"\n${nachher}\nkill %1` });
    assert.equal(g.status, 0);
    assert.match(readFileSync(join(dir, 'gegenprobe', 'kinder'), 'utf8'), /^\((sleep|bash)\)\n$/);
    assert.match(readFileSync(join(dir, 'gegenprobe', 'jobs'), 'utf8'), /^[0-9]+\n$/);
    assert.equal(readFileSync(join(dir, 'gegenprobe', 'fds'), 'utf8'), `${join(dir, 'gegenprobe', 'a6-bericht', 'status')}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1.2 T23: privates Verzeichnis mit Modus 700, Rohr mit Modus 600, danach aufgeraeumt', { skip: NUR_LINUX_B12 }, () => {
  const dir = b12Ordner();

  try {
    const rt = join(dir, 'rt');
    const rechte = join(dir, 'rechte');
    const r = b12Container(FN_ZIEL_PFAD, dir, rt, { extra: { B12_RECHTE: rechte } });
    assert.equal(r.status, 0);
    assert.equal(readFileSync(rechte, 'utf8'), '700 directory\n600 fifo\n');
    assert.deepEqual(b12Rest(rt), []);
    assert.deepEqual(readdirSync(join(rt, 'a6-bericht')).sort(), ['status']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Erfassungsfehler (T19, T24, K8, K9): der Einstieg bleibt byte-gleich, nie "erfasst", kein Haengen.
const B12_ANDERER_NUTZER = 'id() { if [[ "${1:-}" == "-u" ]]; then echo 4242; else command id "$@"; fi; }';
const B12_TEE_SPAET = 'tee() { if [[ "$*" == *mitschnitt* ]]; then sleep 1; fi; command tee "$@"; }';
const B12_STOERUNGEN = Object.freeze({
  mkdir_scheitert: { vorbereiten: rt => chmodSync(rt, 0o555), status: null },
  ordner_schreibgeschuetzt: { vorbereiten: rt => { mkdirSync(join(rt, 'a6-bericht')); chmodSync(join(rt, 'a6-bericht'), 0o555); }, status: null },
  ordner_ist_datei: { vorbereiten: rt => writeFileSync(join(rt, 'a6-bericht'), 'x'), status: null },
  link_statt_ordner: { vorbereiten: (rt, dir) => { mkdirSync(join(dir, 'fremd'), { recursive: true }); symlinkSync(join(dir, 'fremd'), join(rt, 'a6-bericht')); }, status: null, fremdLeer: true },
  mktemp_scheitert: { vorspann: 'mktemp() { return 1; }', status: 'unvollstaendig\n' },
  mktemp_falscher_modus: { vorspann: 'mktemp() { local d="$RUNNER_TEMP/a6-bericht/lauf.test0001"; command mkdir -m 755 "$d" && printf "%s\\n" "$d"; }', status: 'unvollstaendig\n' },
  mktemp_ausserhalb: { vorspann: 'mktemp() { local d="$RUNNER_TEMP/lauf.aussen"; command mkdir -m 700 "$d" && printf "%s\\n" "$d"; }', status: 'unvollstaendig\n', bleibt: 'lauf.aussen' },
  mkfifo_scheitert: { vorspann: 'mkfifo() { return 1; }', status: 'unvollstaendig\n' },
  rohr_nicht_oeffenbar: { vorspann: 'mkfifo() { command mkdir "${@: -1}"; }', status: 'unvollstaendig\n' },
  mitschnitt_voll: { vorspann: 'mktemp() { local d="$RUNNER_TEMP/a6-bericht/lauf.test0002"; command mkdir -m 700 "$d" && ln -s /dev/full "$d/mitschnitt" && printf "%s\\n" "$d"; }', status: 'unvollstaendig\n', teeFehler: true },
  mitschnitt_nicht_beschreibbar: { vorspann: 'mktemp() { local d="$RUNNER_TEMP/a6-bericht/lauf.test0003"; command mkdir -m 700 "$d" && command mkdir "$d/mitschnitt" && printf "%s\\n" "$d"; }', status: 'unvollstaendig\n', teeFehler: true },
  tee_fehlt: { vorspann: 'tee() { return 127; }', status: 'unvollstaendig\n' },
  // tee meldet etwas, endet aber mit 0: die Meldung geht nach tee-fehler, nie ins Log, und der Status ist nicht erfasst.
  tee_warnt: { vorspann: 'tee() { echo "tee: warnung" >&2; command tee "$@"; }', status: 'unvollstaendig\n' },
  // Der Berichtsordner gehoert einem anderen Nutzer als dem ausfuehrenden (die Shell gibt sich als Nutzer 4242
  // aus; ohne Rechte laesst sich kein fremder Eigentuemer anlegen). Er ist beschreibbar, wird aber nie benutzt.
  fremder_eigentuemer: { vorbereiten: rt => mkdirSync(join(rt, 'a6-bericht')), vorspann: B12_ANDERER_NUTZER, status: null, leer: true },
  // Gegenprobe zur Messung: derselbe Ersatz fuer id mit dem eigenen Nutzer laesst die Erfassung zu.
  eigener_eigentuemer: { vorbereiten: rt => mkdirSync(join(rt, 'a6-bericht')), vorspann: 'id() { command id "$@"; }', status: 'erfasst\n', fehler: 'A6-FEHLER abnahme-exitcode\n' },
  // K9-Wettlauf: tee kommt erst eine Sekunde nach dem Ende des Ersatz-docker zum Lesen, auch ueber den Rohrpuffer hinaus.
  leser_verzoegert: { vorspann: B12_TEE_SPAET, status: 'erfasst\n', fehler: 'A6-FEHLER abnahme-exitcode\n' },
  leser_verzoegert_gross: { vorspann: B12_TEE_SPAET, stderr: Buffer.concat([Buffer.from('A6-FEHLER abnahme-exitcode\n'), Buffer.alloc(200 * 1024, 'z'), Buffer.from('\nende\n')]), status: 'unvollstaendig\n', fehler: 'A6-FEHLER abnahme-exitcode\n' },
  ueber_64kb: { stderr: Buffer.concat([Buffer.from('A6-FEHLER abnahme-exitcode\n'), Buffer.alloc(70 * 1024, 'y'), Buffer.from('\n')]), status: 'unvollstaendig\n', fehler: 'A6-FEHLER abnahme-exitcode\n' },
  genau_64kb: { stderr: Buffer.concat([Buffer.from('A6-FEHLER abnahme-exitcode\n'), Buffer.alloc(65536 - 28, 'y'), Buffer.from('\n')]), status: 'erfasst\n', fehler: 'A6-FEHLER abnahme-exitcode\n' },
});

test('B1.2 T19, T24, K8: Erfassungsfehler lassen Ausgabe und Exitcode byte-gleich, Status nie "erfasst", keine tee-Meldung im Log', { skip: NUR_LINUX_B12 }, () => {
  const dir = b12Ordner();

  try {
    for (const [name, f] of Object.entries(B12_STOERUNGEN)) {
      for (const rc of [0, 1]) {
        const err = join(dir, `stderr-${name}`);
        writeFileSync(err, f.stderr ?? Buffer.from('A6-FEHLER abnahme-exitcode\nweiter\n'));
        const extra = { B12_STDERR: err, B12_RC: String(rc) };
        const rtAlt = join(dir, `${name}-${rc}-alt`);
        const rtNeu = join(dir, `${name}-${rc}-neu`);
        mkdirSync(rtNeu, { recursive: true });
        f.vorbereiten?.(rtNeu, join(dir, `${name}-${rc}`));
        const alt = b12Container(FN_ALT_PFAD, dir, rtAlt, { extra, vorspann: f.vorspann ?? '' });
        const neu = b12Container(FN_ZIEL_PFAD, dir, rtNeu, { extra, vorspann: f.vorspann ?? '' });
        chmodSync(rtNeu, 0o755);
        if (existsSync(join(rtNeu, 'a6-bericht')) && !f.fremdLeer) chmodSync(join(rtNeu, 'a6-bericht'), 0o755);
        if (f.haengtNicht) {
          // Ohne funktionierendes tee kann die Weitergabe nicht gelingen; massgeblich: kein Haengen, Exitcode gleich.
          assert.equal(neu.signal, null, `${name}: haengt`);
          assert.equal(neu.status, alt.status, `${name}: Exitcode`);
          assert.ok(neu.stdout.equals(alt.stdout), `${name}: stdout`);
        } else {
          b12Gleich(alt, neu, `${name}/${rc}`);
        }
        assert.ok(!neu.stderr.toString('latin1').includes('tee:'), `${name}: tee-Meldung im Log`);
        const basis = join(rtNeu, 'a6-bericht');
        const status = f.fremdLeer || !existsSync(basis) || !statSync(basis).isDirectory() ? null : b12Lies(join(basis, 'status'));
        assert.equal(status, f.status, `${name}/${rc}: Status`);
        assert.ok(status === null || !status.includes('erfasst\n') || f.status === 'erfasst\n', `${name}: erfasst trotz Fehler`);
        if (f.fehler !== undefined) assert.equal(b12Lies(join(basis, 'fehler')), f.fehler, `${name}: Fehlerdatei`);
        if (f.fremdLeer) assert.deepEqual(readdirSync(join(dir, `${name}-${rc}`, 'fremd')), [], `${name}: durch den Link geschrieben`);
        // Ein Pfad ausserhalb des Berichtsordners wird nie geloescht, auch wenn mktemp ihn liefert.
        if (f.bleibt) assert.ok(existsSync(join(rtNeu, f.bleibt)), `${name}: fremder Pfad geloescht`);
        if (f.leer) assert.deepEqual(readdirSync(basis), [], `${name}: fremder Ordner benutzt`);
        if (existsSync(basis) && statSync(basis).isDirectory() && !f.fremdLeer) assert.deepEqual(b12Rest(rtNeu), [], `${name}: Reste`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1.2 K9: Startfehler, docker fehlt oder ist nicht ausfuehrbar: kein Haengen, Exitcode wie heute, Status nicht erfasst', { skip: NUR_LINUX_B12 }, () => {
  const dir = b12Ordner();

  try {
    // Eigener PATH nur mit den noetigen Werkzeugen, ohne docker (auf dem Runner liegt ein echtes docker in /usr/bin).
    const bin = join(dir, 'nur-werkzeuge');
    mkdirSync(bin);
    for (const w of ['mkdir', 'mktemp', 'realpath', 'stat', 'mkfifo', 'tee', 'head', 'grep', 'rm', 'id', 'cat']) {
      const quelle = spawnSync('bash', ['-c', `command -v ${w}`], { encoding: 'utf8' }).stdout.trim();
      assert.ok(quelle.startsWith('/'), w);
      symlinkSync(quelle, join(bin, w));
    }

    for (const [name, vorbereiten, rc] of [['fehlt', () => {}, 127], ['nicht_ausfuehrbar', () => writeFileSync(join(bin, 'docker'), '#!/bin/sh\n', { mode: 0o644 }), 126]]) {
      vorbereiten();
      const extra = { PATH: bin };
      const alt = b12Container(FN_ALT_PFAD, dir, join(dir, `${name}-alt`), { extra });
      const neu = b12Container(FN_ZIEL_PFAD, dir, join(dir, `${name}-neu`), { extra });
      assert.equal(neu.signal, null, `${name}: haengt`);
      assert.equal(neu.status, rc, name);
      assert.equal(neu.status, alt.status, name);
      assert.ok(neu.stdout.equals(alt.stdout), name);
      assert.equal(ohneOrt(neu.stderr), ohneOrt(alt.stderr), name);
      assert.ok(ohneOrt(neu.stderr).includes('docker: '), `${name}: Muss-Treffer`);
      assert.equal(b12Lies(join(dir, `${name}-neu`, 'a6-bericht', 'status')), 'unvollstaendig\n', name);
      assert.deepEqual(b12Rest(join(dir, `${name}-neu`)), []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Startet a6_container im Hintergrund, liest stderr mit, wartet auf die Fehlerzeile und beendet die Shell.
function b12Abbruch(signal) {
  return new Promise((resolve, reject) => {
    const dir = b12Ordner();
    const rt = join(dir, 'rt');
    mkdirSync(rt);
    const marke = join(dir, 'marke');
    const kind = spawn('bash', ['--noprofile', '--norc', '-c', 'set -euo pipefail\nsource "$1"\na6_container none "" agent-code-job-abnahme.mjs GITHUB_REPOSITORY', 'b12', FN_ZIEL_PFAD],
      { env: b12Env(dir, rt, { B12_WARTEN: marke }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let fehler = '';
    let vorEnde = false;
    const ende = (wert, problem) => {
      clearTimeout(uhr);
      try { process.kill(-kind.pid, 'SIGKILL'); } catch { /* schon beendet */ }
      setTimeout(() => {
        const status = b12Lies(join(rt, 'a6-bericht', 'status'));
        const rest = b12Rest(rt);
        rmSync(dir, { recursive: true, force: true });
        problem ? reject(problem) : resolve({ ...wert, status, rest });
      }, 200);
    };
    const uhr = setTimeout(() => ende(null, new Error(`Fehlerzeile kam nicht vor dem Ende des Ersatz-docker an: ${JSON.stringify(fehler)}`)), 10_000);
    kind.stderr.on('data', d => {
      fehler += d.toString('utf8');
      if (!vorEnde && fehler.includes('A6-FEHLER abnahme-exitcode\n')) {
        // Die Marke traegt die PID des Ersatz-docker und entsteht vor der Zeile; lebt er noch, lief der Container.
        const pid = Number(readFileSync(marke, 'utf8'));
        try { process.kill(pid, 0); vorEnde = pid > 0; } catch { vorEnde = false; }
        const abbruch = kind;
        abbruch.kill(signal);
        abbruch.once('exit', (code, sig) => setTimeout(() => ende({ fehler, vorEnde, sig }), 100));
      }
    });
  });
}

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`B1.2 T21 (5a): Fehlerzeile erreicht das Log vor dem Ende des Containers und bleibt nach ${signal} erhalten`, { skip: NUR_LINUX_B12 }, async () => {
    const r = await b12Abbruch(signal);
    assert.equal(r.sig, signal);
    assert.ok(r.fehler.includes('A6-FEHLER abnahme-exitcode\n'));
    // Der Ersatz-docker wartet nach der Zeile 30 Sekunden; die Zeile kam also, waehrend er noch lief.
    assert.equal(r.vorEnde, true, 'Zeile kam erst nach dem Container an');
    // Abbruch: keine Statuszeile, der private Ordner bleibt liegen; der Bericht meldet "unvollstaendig".
    assert.equal(r.status, null);
    assert.equal(r.rest.length, 1);
  });
}

test('B1.2 T21: ein abgebrochener Aufruf wird im Bericht nie als erfasst gezeigt', { skip: NUR_LINUX_B12 }, async () => {
  const { main } = await import('../scripts/agent-code-job-bericht.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'a6-b12-rest-'));

  try {
    mkdirSync(join(dir, 'bericht', 'lauf.abcdefgh'), { recursive: true });
    writeFileSync(join(dir, 'bericht', 'status'), 'erfasst\n');
    writeFileSync(join(dir, 'ziel'), '');
    assert.equal(main({ A6_BERICHT_JOB: 'abnahme', A6_JOB_STATUS: 'failure' }, { ordner: join(dir, 'bericht'), ziel: join(dir, 'ziel') }), 0);
    assert.ok(readFileSync(join(dir, 'ziel'), 'utf8').includes('- Fehlerdaten: unvollständig\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// a6_bericht mit Ersatz-docker: Ziel unter RUNNER_TEMP/_runner_file_commands wie auf dem Runner.
function b12Bericht(job, { ziel, vorbereiten, extra = {}, rt: rtArg, lesen, vorspann = '', befehl = 'a6_bericht "$2"' } = {}) {
  const dir = b12Ordner();

  try {
    const rt = rtArg ?? join(dir, 'rt');
    mkdirSync(join(rt, '_runner_file_commands'), { recursive: true });
    const standard = join(rt, '_runner_file_commands', 'step_summary_0a1b2c3d-4e5f');
    writeFileSync(standard, '');
    const argv = join(dir, 'argv');
    mkdirSync(argv);
    const zielPfad = ziel === undefined ? standard : ziel(rt, dir);
    vorbereiten?.(rt, dir);
    const env = b12Env(dir, rt, { B12_ARGV: argv, GITHUB_STEP_SUMMARY: zielPfad, A6_JOB_STATUS: 'success', ANTHROPIC_API_KEY: 'sk-ant-geheim', A6_APP_TOKEN: 'ghs_geheim', GITHUB_TOKEN: 'ghp_geheim', ...extra });
    if (zielPfad === null) delete env.GITHUB_STEP_SUMMARY;
    const r = spawnSync('bash', ['--noprofile', '--norc', '-c', `set -euo pipefail\nsource "$1"\n${vorspann}\nrc=0\n${befehl} || rc=$?\nexit "$rc"`, 'b12', FN_ZIEL_PFAD, job], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.error, undefined);
    const aufrufe = readdirSync(argv).sort((a, b) => Number(a) - Number(b)).map(n => readFileSync(join(argv, n), 'utf8').split('\0').slice(0, -1));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, aufrufe, inhalt: existsSync(standard) ? readFileSync(standard, 'utf8') : null, rt, dir, gelesen: lesen?.(rt, dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const laeufe = r => r.aufrufe.filter(a => a[0] === 'run');
const b12Optionen = (a, name) => a.flatMap((x, i) => (x === name ? [a[i + 1]] : []));

test('B1.2 T14: a6_bericht startet genau einen Container ohne Netz mit genau drei Einhaengungen und nur den festen Umgebungsnamen', { skip: NUR_LINUX_B12 }, () => {
  for (const job of B12_JOBS.filter(j => j !== 'sammel')) {
    const r = b12Bericht(job, { vorbereiten: rt => mkdirSync(join(rt, 'a6-bericht')), extra: { B12_SCHREIBE: '1' } });
    assert.equal(r.status, 0, `${job}: ${r.stdout} ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.equal(r.inhalt, 'ersatz\n', `${job}: nicht in die Zusammenfassung geschrieben`);
    const [a, ...weitere] = laeufe(r);
    assert.equal(weitere.length, 0);
    assert.deepEqual(b12Optionen(a, '--network'), ['none']);
    assert.ok(a.includes('--read-only') && a.includes('--rm') && a.includes('--pull=never') && b12Optionen(a, '--cap-drop')[0] === 'ALL');
    assert.deepEqual(b12Optionen(a, '--mount'), [
      `type=bind,src=${join(r.dir, 'ws')},dst=${join(r.dir, 'ws')},readonly`,
      `type=bind,src=${join(r.rt, 'a6-bericht')},dst=/a6/bericht,readonly`,
      `type=bind,src=${join(r.rt, '_runner_file_commands', 'step_summary_0a1b2c3d-4e5f')},dst=/a6/zusammenfassung`,
    ]);
    assert.ok(!a.some(x => x.includes(`src=${r.rt},`)), 'ganz RUNNER_TEMP eingehaengt');
    assert.deepEqual(b12Optionen(a, '--env'), ['PATH=/usr/local/bin:/usr/bin:/bin', 'A6_BERICHT_JOB', 'A6_JOB_STATUS']);
    assert.ok(!a.some(x => /geheim|TOKEN|ANTHROPIC/.test(x)) && !a.includes('-e') && !a.includes('--env-file'));
    assert.deepEqual(a.slice(-3), ['a6', 'v0', 'a'.repeat(64)]);
  }

  // Ohne echten Berichtsordner (fehlt oder Link): nur zwei Einhaengungen, nie durch einen Link.
  for (const [name, vorbereiten, vorspann] of [['fehlt', null], ['link', (rt, dir) => { mkdirSync(join(dir, 'fremd')); symlinkSync(join(dir, 'fremd'), join(rt, 'a6-bericht')); }],
    ['fremder_eigentuemer', rt => mkdirSync(join(rt, 'a6-bericht')), B12_ANDERER_NUTZER]]) {
    const r = b12Bericht('abnahme', { vorbereiten, vorspann });
    assert.equal(r.status, 0, name);
    assert.deepEqual(b12Optionen(laeufe(r)[0], '--mount').map(m => m.split(',dst=')[1]), [join(r.dir, 'ws').replaceAll('\\', '/') + ',readonly', '/a6/zusammenfassung'], name);
  }

  // Nur feste Jobnamen: sonst A6-START bericht-job, Warnung, Rueckgabe 1, kein Container.
  for (const job of ['', 'sammel', 'probe_negativ', 'probe_sammel_pruefung', 'auftrag ', 'Auftrag', 'auftrag;id', '../x', 'sammel2']) {
    const r = b12Bericht(job);
    assert.equal(r.status, 1, job);
    assert.equal(r.stderr, 'A6-START bericht-job\n', job);
    assert.equal(r.stdout, '::warning title=A6-BERICHT::job-ungueltig\n', job);
    assert.deepEqual(r.aufrufe, [], job);
  }
});

test('B1.2 T20: ungueltiges Schreibziel ergibt A6-BERICHT ziel-ungueltig, Rueckgabe 1, nichts geschrieben, kein Container', { skip: NUR_LINUX_B12 }, () => {
  const faelle = {
    leer: () => '',
    fehlt: () => null,
    link: rt => { const l = join(rt, '_runner_file_commands', 'step_summary_link'); symlinkSync(join(rt, '_runner_file_commands', 'step_summary_0a1b2c3d-4e5f'), l); return l; },
    verzeichnis: rt => { const d = join(rt, '_runner_file_commands', 'step_summary_ordner'); mkdirSync(d); return d; },
    realpath_abweichend: rt => `${rt}/_runner_file_commands/../_runner_file_commands/step_summary_0a1b2c3d-4e5f`,
    // Der Ordner selbst ist ein Link: Pfad und Name stimmen als Text, nur realpath weicht ab.
    ordner_link: rt => {
      renameSync(join(rt, '_runner_file_commands'), join(rt, 'echt'));
      symlinkSync(join(rt, 'echt'), join(rt, '_runner_file_commands'));
      return join(rt, '_runner_file_commands', 'step_summary_0a1b2c3d-4e5f');
    },
    doppelter_schraegstrich: rt => `${rt}/_runner_file_commands//step_summary_0a1b2c3d-4e5f`,
    ausserhalb: rt => { const d = join(rt, 'anderswo'); mkdirSync(d); writeFileSync(join(d, 'step_summary_abc'), ''); return join(d, 'step_summary_abc'); },
    unterordner: rt => { const d = join(rt, '_runner_file_commands', 'tiefer'); mkdirSync(d); writeFileSync(join(d, 'step_summary_abc'), ''); return join(d, 'step_summary_abc'); },
    falscher_name: rt => { const p = join(rt, '_runner_file_commands', 'set_output_abc'); writeFileSync(p, ''); return p; },
    name_zu_lang: rt => { const p = join(rt, '_runner_file_commands', `step_summary_${'a'.repeat(81)}`); writeFileSync(p, ''); return p; },
    name_mit_punkt: rt => { const p = join(rt, '_runner_file_commands', 'step_summary_a.b'); writeFileSync(p, ''); return p; },
    fehlende_datei: rt => join(rt, '_runner_file_commands', 'step_summary_gibtsnicht'),
  };

  for (const [name, ziel] of Object.entries(faelle)) {
    const r = b12Bericht('auftrag', { ziel, extra: { B12_SCHREIBE: '1' } });
    assert.equal(r.status, 1, name);
    assert.equal(r.stdout, 'A6-BERICHT ziel-ungueltig\n::warning title=A6-BERICHT::ziel-ungueltig\n', name);
    assert.equal(r.stderr, '', name);
    assert.deepEqual(r.aufrufe, [], `${name}: Container gestartet`);
    assert.equal(r.inhalt, '', `${name}: geschrieben`);
  }

  // Gegenprobe: gueltiger Name mit 80 Zeichen wird angenommen.
  const ok = b12Bericht('auftrag', { ziel: rt => { const p = join(rt, '_runner_file_commands', `step_summary_${'a'.repeat(80)}`); writeFileSync(p, ''); return p; } });
  assert.equal(ok.status, 0, ok.stdout);
});

test('B1.2 T22: jeder Berichtsfehler ergibt genau eine feste Warnung, nie einen Pfad oder Wert', { skip: NUR_LINUX_B12 }, () => {
  for (const [rc, grund] of [[1, 'nicht-geschrieben'], [3, 'pruefung'], [4, 'integritaet'], [125, 'start'], [126, 'start'], [127, 'start'], [137, 'start'], [2, 'start']]) {
    const r = b12Bericht('claude', { extra: { B12_RC: String(rc) } });
    assert.equal(r.status, 1, String(rc));
    assert.equal(r.stdout, `::warning title=A6-BERICHT::${grund}\n`, String(rc));
  }

  // Kein Netz: fehlt das Image, wird nichts geladen. Nur die Warnung image, Rueckgabe 1, kein pull, kein Container.
  for (const job of ['auftrag', 'claude', 'probe_abnahme']) {
    const ohne = b12Bericht(job, { extra: { B12_IMAGE_RC: '1', B12_PULL_RC: '0' } });
    assert.equal(ohne.status, 1, job);
    assert.equal(ohne.stdout, '::warning title=A6-BERICHT::image\n', job);
    assert.deepEqual(ohne.aufrufe.map(x => x.slice(0, 2)), [['image', 'inspect']], job);
  }

  // Unbekannter Grund wird nie durchgereicht.
  const w = spawnSync('bash', ['-c', 'source "$1"; a6_bericht_warnung "pfad/geheim"; a6_bericht_warnung start', 'b12', FN_ZIEL_PFAD], { encoding: 'utf8' });
  assert.equal(w.stdout, '::warning title=A6-BERICHT::unbekannt\n::warning title=A6-BERICHT::start\n');

  // Funktionen-Hash falsch: der Workflowschritt warnt und endet rot, laedt die Funktionsdatei nicht.
  const schritt = b12Zeilen('abnahme').slice(b12Zeilen('abnahme').indexOf('        run: |') + 1).map(z => z.slice(10)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'a6-b12-hash-'));
  try {
    mkdirSync(join(dir, '.github', 'agent'), { recursive: true });
    writeFileSync(join(dir, '.github', 'agent', 'a6-funktionen.sh'), 'echo GELADEN\n');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-c', schritt], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, A6_FUNKTIONEN_SHA256: '0'.repeat(64) } });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '::warning title=A6-BERICHT::funktionen-hash\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1.2 T10 und T22: der Startblock im Berichtscontainer endet mit festen Codes; Skript-Hash falsch ergibt 4 (integritaet)', { skip: NUR_LINUX_B12 }, () => {
  const b = funktion(FN_ZIEL, 'a6_bericht');
  const skript = b.slice(b.indexOf("/bin/sh -euc '") + "/bin/sh -euc '".length, b.indexOf("' a6 \"$A6_NODE_VERSION\" \"$A6_INTEGRITAET_SHA256\""));
  assert.ok(skript.includes('exec node scripts/agent-code-job-bericht.mjs'));
  const pruefer = createHash('sha256').update(readFileSync(join(ROOT, 'scripts', 'agent-code-integritaet.mjs'))).digest('hex');
  const dir = mkdtempSync(join(tmpdir(), 'a6-b12-start-'));

  try {
    cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, '.github', 'agent'), { recursive: true });
    cpSync(join(ROOT, '.github', 'agent', 'policy.json'), join(dir, '.github', 'agent', 'policy.json'));
    const lauf = (version, anker, env = {}) => spawnSync('sh', ['-euc', skript, 'a6', version, anker], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

    // Alles stimmt: das Berichtsskript laeuft und scheitert nur am fehlenden /a6/zusammenfassung (Exitcode 1).
    const ok = lauf(process.version, pruefer);
    assert.equal(ok.status, 1, ok.stderr);
    assert.equal(ok.stdout + ok.stderr, '');
    assert.equal(lauf('v0.0.0', pruefer).status, 3);
    assert.equal(lauf(process.version, '0'.repeat(64)).status, 3);
    assert.equal(lauf(process.version, pruefer, { NODE_OPTIONS: '--no-warnings' }).status, 3);
    // Berichtsskript veraendert, Policy unveraendert: der Integritaetspruefer lehnt ab.
    writeFileSync(join(dir, 'scripts', 'agent-code-job-bericht.mjs'), `${readFileSync(join(dir, 'scripts', 'agent-code-job-bericht.mjs'), 'utf8')}\n// veraendert\n`);
    const falsch = lauf(process.version, pruefer);
    assert.equal(falsch.status, 4);
    assert.match(falsch.stderr, /^A6-FEHLER integritaet-[a-z-]+\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1.2 Runden und Kosten: genau ein result-Ereignis mit zwei Zahlen ergibt die Datei claude, sonst keine', { skip: NUR_LINUX_B12 || (spawnSync('bash', ['-c', 'command -v jq']).status !== 0 ? 'jq fehlt in dieser Umgebung; laeuft in CI' : false) }, () => {
  const faelle = [
    ['{"type":"system"}\n{"type":"result","num_turns":7,"total_cost_usd":0.0312,"is_error":false}\n', '7 0.0312\n'],
    ['{"type":"result","num_turns":3,"total_cost_usd":0,"is_error":true}\n', '3 0\n'],
    ['{"type":"result","num_turns":3,"total_cost_usd":"0.1"}\n', null],
    ['{"type":"result","num_turns":3}\n', null],
    ['{"type":"result","num_turns":3,"total_cost_usd":0.1}\n{"type":"result","num_turns":4,"total_cost_usd":0.2}\n', null],
    ['{"type":"result","num_turns":3,"total_cost_usd":0.1}\n{kaputt\n', null],
    ['', null],
  ];

  // Ueber a6_bericht: fuer claude wird die Datei aus RUNNER_TEMP/a6-claude-protokoll.jsonl erzeugt, fuer andere Jobs nie.
  for (const job of ['claude', 'abnahme']) {
    const r = b12Bericht(job, { vorbereiten: rt => { mkdirSync(join(rt, 'a6-bericht')); writeFileSync(join(rt, 'a6-claude-protokoll.jsonl'), faelle[0][0]); }, lesen: rt => b12Lies(join(rt, 'a6-bericht', 'claude')) });
    assert.equal(r.status, 0, job);
    assert.equal(r.gelesen, job === 'claude' ? '7 0.0312\n' : null, job);
  }

  // Inhalt der Datei je Fall (eigener Lauf, damit der Ordner nicht mit dem Ersatz geloescht wird).
  for (const [protokoll, erwartet] of faelle) {
    const dir = mkdtempSync(join(tmpdir(), 'a6-b12-kosten-'));
    try {
      writeFileSync(join(dir, 'p.jsonl'), protokoll);
      writeFileSync(join(dir, 'claude'), 'alt\n');
      const r = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; a6_bericht_kosten "$2/p.jsonl" "$2/claude"', 'b12', FN_ZIEL_PFAD, dir], { encoding: 'utf8' });
      assert.equal(r.status, 0);
      assert.equal(b12Lies(join(dir, 'claude')), erwartet, protokoll);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Sammeltabelle (Nachbesserung Punkt 3): a6_bericht_sammel ohne Container, ohne docker, ohne Netz.
const B12_SAMMEL_TITEL = Object.freeze(['Job 0 Auftrag festlegen', 'Job 1 Claude im Container', 'Job 2 Abnahme ohne Netz', 'Job 3 Draft-PR veröffentlichen',
  'Generalprobe Job 0', 'Generalprobe Job 1', 'Generalprobe Job 2', 'Generalprobe Job 3', 'Generalprobe Negativfälle', 'Generalprobe Sammelprüfung']);
const b12SammelText = (pruefung, werte) => `### Bericht: agent-auftrag-sammel\n\nSammelprüfung: ${pruefung}\n\n| Job | Ergebnis |\n|---|---|\n${B12_SAMMEL_TITEL.map((t, i) => `| ${t} | ${werte[i]} |\n`).join('')}\n`;
const b12SammelEnv = wert => Object.fromEntries(B12_ERGEBNISSE.map(([k]) => [`A6_ERGEBNIS_${k}`, wert]));
const b12Sammel = (extra, weiter = {}) => b12Bericht('', { ...weiter, befehl: 'a6_bericht_sammel', extra: { ...b12SammelEnv('success'), ...extra } });

test('B1.2 Sammeltabelle: feste Tabelle aus den zehn needs-Ergebnissen, nie docker, uebersprungen nie als Erfolg', { skip: NUR_LINUX_B12 }, () => {
  const ok = b12Sammel({ A6_JOB_STATUS: 'success' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout + ok.stderr, '');
  assert.equal(ok.inhalt, b12SammelText('bestanden', Array(10).fill('erfolgreich')));
  assert.deepEqual(ok.aufrufe, [], 'docker im Sammelschritt aufgerufen');

  for (const [wert, anzeige] of [['success', 'erfolgreich'], ['failure', 'fehlgeschlagen'], ['cancelled', 'abgebrochen'], ['skipped', 'übersprungen']]) {
    const r = b12Sammel({ A6_JOB_STATUS: 'failure', A6_ERGEBNIS_CLAUDE: wert });
    const werte = Array(10).fill('erfolgreich');
    werte[1] = anzeige;
    assert.equal(r.inhalt, b12SammelText('nicht bestanden', werte), wert);
    assert.deepEqual(r.aufrufe, []);
  }

  const alleSkipped = b12Sammel({ A6_JOB_STATUS: 'success', ...b12SammelEnv('skipped') });
  assert.equal(alleSkipped.inhalt, b12SammelText('bestanden', Array(10).fill('übersprungen')));
  assert.ok(!alleSkipped.inhalt.includes('| erfolgreich |'));

  for (const [status, pruefung] of [['cancelled', 'abgebrochen'], ['', 'Status unbekannt'], ['skipped', 'Status unbekannt'], ['success|x', 'Status unbekannt']]) {
    assert.ok(b12Sammel({ A6_JOB_STATUS: status }).inhalt.includes(`Sammelprüfung: ${pruefung}\n`), status);
  }
});

test('B1.2 Sammeltabelle: Injektionswerte erscheinen nie, werden nie ausgefuehrt und gelten nie als Erfolg', { skip: NUR_LINUX_B12 }, () => {
  const marke = join(tmpdir(), `a6-b12-marke-${process.pid}`);
  const boese = ['success|x', 'success ', ' success', 'SUCCESS', 'success\n| Job 0 Auftrag festlegen | erfolgreich |', '| x | erfolgreich |',
    '[klick](https://example.invalid)', '<script>alert(1)</script>', `$(touch ${marke})`, `\`touch ${marke}\``, '${A6_ERGEBNIS_AUFTRAG}',
    '::warning title=A6-BERICHT::x', '%0A::error::x', '‮', 'skipped\nsuccess', ''];

  for (const wert of boese) {
    const r = b12Sammel({ A6_JOB_STATUS: 'success', A6_ERGEBNIS_ABNAHME: wert });
    assert.equal(r.status, 0, JSON.stringify(wert));
    const werte = Array(10).fill('erfolgreich');
    werte[2] = 'unbekannt';
    assert.equal(r.inhalt, b12SammelText('bestanden', werte), JSON.stringify(wert));
    assert.deepEqual(r.aufrufe, []);
    assert.ok(!existsSync(marke), `${JSON.stringify(wert)}: ausgefuehrt`);
  }

  // Alle zehn Werte zugleich boese: genau zehnmal unbekannt, keinmal erfolgreich.
  const alle = b12Sammel({ A6_JOB_STATUS: 'success', ...b12SammelEnv('success|x') });
  assert.equal(alle.inhalt, b12SammelText('bestanden', Array(10).fill('unbekannt')));
});

test('B1.2 Sammeltabelle: ungueltiges Ziel und Schreibfehler ergeben dieselben festen Warnungen, nie docker', { skip: NUR_LINUX_B12 }, () => {
  const faelle = {
    leer: () => '',
    fehlt: () => null,
    link: rt => { const l = join(rt, '_runner_file_commands', 'step_summary_link'); symlinkSync(join(rt, '_runner_file_commands', 'step_summary_0a1b2c3d-4e5f'), l); return l; },
    verzeichnis: rt => { const d = join(rt, '_runner_file_commands', 'step_summary_ordner'); mkdirSync(d); return d; },
    ausserhalb: rt => { const d = join(rt, 'anderswo'); mkdirSync(d); writeFileSync(join(d, 'step_summary_abc'), ''); return join(d, 'step_summary_abc'); },
    falscher_name: rt => { const q = join(rt, '_runner_file_commands', 'set_output_abc'); writeFileSync(q, ''); return q; },
  };

  for (const [name, ziel] of Object.entries(faelle)) {
    const r = b12Sammel({ A6_JOB_STATUS: 'success' }, { ziel });
    assert.equal(r.status, 1, name);
    assert.equal(r.stdout, 'A6-BERICHT ziel-ungueltig\n::warning title=A6-BERICHT::ziel-ungueltig\n', name);
    assert.equal(r.inhalt, '', name);
    assert.deepEqual(r.aufrufe, [], name);
  }

  // Schreibfehler (Ziel schreibgeschuetzt; als root nicht herstellbar, CI und Container laufen ohne root).
  assert.notEqual(process.getuid?.(), 0, 'Test braucht einen Nutzer ohne root');
  const r = b12Sammel({ A6_JOB_STATUS: 'success' }, { vorbereiten: rt => chmodSync(join(rt, '_runner_file_commands', 'step_summary_0a1b2c3d-4e5f'), 0o444) });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '::warning title=A6-BERICHT::nicht-geschrieben\n');
  assert.equal(r.inhalt, '');
  assert.deepEqual(r.aufrufe, []);
});

test('B1.2 Sammeltabelle: der Workflowschritt des Sammeljobs schreibt sie ohne docker und mit dem echten Funktionsanker', { skip: NUR_LINUX_B12 }, () => {
  const schritt = schritte(jobs(WF_ZIEL).get('sammel')).at(-1);
  const zeilen = schritt.trimEnd().split('\n');
  const lauf = zeilen.slice(zeilen.indexOf('        run: |') + 1).map(z => z.slice(10)).join('\n');
  assert.ok(lauf.endsWith('a6_bericht_sammel'));
  const dir = b12Ordner();

  try {
    mkdirSync(join(dir, 'ws', '.github', 'agent'), { recursive: true });
    writeFileSync(join(dir, 'ws', '.github', 'agent', 'a6-funktionen.sh'), readFileSync(FN_ZIEL_PFAD));
    const rt = join(dir, 'rt');
    mkdirSync(join(rt, '_runner_file_commands'), { recursive: true });
    const ziel = join(rt, '_runner_file_commands', 'step_summary_abc');
    writeFileSync(ziel, '');
    mkdirSync(join(dir, 'argv'));
    const env = b12Env(dir, rt, { B12_ARGV: join(dir, 'argv'), GITHUB_STEP_SUMMARY: ziel, A6_JOB_STATUS: 'failure', A6_FUNKTIONEN_SHA256: anker(WF_ZIEL, 'A6_FUNKTIONEN_SHA256'), ...b12SammelEnv('skipped') });
    const r = spawnSync(B12_BASH, ['--noprofile', '--norc', '-c', lauf], { cwd: join(dir, 'ws'), env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(ziel, 'utf8'), b12SammelText('nicht bestanden', Array(10).fill('übersprungen')));
    assert.deepEqual(readdirSync(join(dir, 'argv')), [], 'docker im Sammelschritt aufgerufen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Teil 2: Eigentuemerstand (bis zum Eigentuemer-Commit bewusst rot)
// ---------------------------------------------------------------------------

// B1.2: fuer Workflow und Funktionsdatei der Stand ohne genau die Berichtsteile (Ausschneide-Proben oben).
const B12_OHNE = Object.freeze({
  '.github/workflows/agent-auftrag.yml': text => workflowOhneBericht(text),
  '.github/agent/a6-funktionen.sh': text => funktionenOhneBericht(text),
});

for (const [entwurf, ziel] of ZIELE) {
  const ohne = B12_OHNE[ziel];
  test(`Eigentuemerstand: ${ziel} ist${ohne ? ' ohne die Berichtsteile (B1.2)' : ''} byte-gleich mit ${entwurf}`, () => {
    assert.ok(existsSync(join(ROOT, ziel)), `${ziel} fehlt`);
    assert.equal(sha256(ohne ? ohne(lies(ziel)) : lies(ziel)), sha256(lies(entwurf)));
  });
}
