// A6.4-2c-2: Offline-Tests der Claude-Einstiege Job 1a (vor Claude) und Job 1b (nach Claude).
//
// Alles offline und synthetisch: kein Claude-Lauf, kein echtes Token, kein echter Geheimniswert, kein
// GitHub-Aufruf, kein Socket. Job 1a laeuft im Prozess; https.request wird wie in den Transporttests
// durch eine Attrappe ersetzt, die die Live-Antworten aus dem Speicher liefert. Job 1b laeuft im
// Prozess mit Zaehlern fuer Netz und Prozessstarts sowie als eigener Prozess (CLI). Die Daten
// stammen aus einem synthetischen Repository mit Policy, beiden Profilen (js-text nur hier, im
// temporaeren Repository, synthetisch aktiviert; nie unter agent-profiles/) und Abnahmedateien.
// Schnappschuss und Auftrags-Hash werden im Test so gebildet, wie Job 0 sie liefert.
//
// Zeitpunkte: Freigabe und Lauf liegen wenige Minuten vor dem Start dieser Datei. Die Einstiege
// nehmen keinen Zeitwert entgegen; die Datei muss deshalb binnen rund 55 Minuten durchlaufen.
//
// Was diese Tests NICHT zeigen: echten Claude-Container, Workspace- und Containeruebergabe, echte
// Geheimniswerte und ihre Vollstaendigkeit, Schreiberisolation zwischen Pruefung und Upload,
// Prozessbaum-Isolation, Git-Pfad, Umgebungsbereinigung vor Node, K1 bis K4, Aktivierung.

import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { orderSha256, resolveOrder } from '../scripts/agent-code-auftrag.mjs';
import { WORKFLOW_PATH } from '../scripts/agent-code-auftrag-live.mjs';
import { containsSecretValue, createPackageV2, parsePackageV2, prepareWorkspace } from '../scripts/agent-code-auftrag-paket.mjs';
import { SECURITY_FRAME } from '../scripts/agent-code-auftrag-prompt.mjs';
import {
  MAX_COMPARE_LENGTH,
  MIN_COMPARE_LENGTH,
  PACKAGE_OUTPUT_KEY,
  SECRET_NAMES,
  WORKFLOW_REF,
  buildSnapshot,
  readClaudeNachContract,
  readClaudeVorContract,
  writePackageOutput,
} from '../scripts/agent-code-job-gemeinsam.mjs';
import { main as mainVor } from '../scripts/agent-code-job-claude-vor.mjs';
import { main as mainNach, scanPackageSecrets } from '../scripts/agent-code-job-claude-nach.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JOB1B_PATH = join(ROOT, 'scripts', 'agent-code-job-claude-nach.mjs');
const EXEC = cp.execFileSync;
const SPAWN = cp.spawnSync;
const WRITE_SYNC = fs.writeSync;
const sha256 = data => createHash('sha256').update(data).digest('hex');

const REPO_NAME = 'noah04091/agenten-probe';
const P = `/repos/${REPO_NAME}/`;
// Erfundene Werte nur fuer diese Tests, ohne Wirkung. Keiner traegt ein bekanntes Geheimnismuster.
const TOKEN = 'ghs_NurTestOhneWirkung_job1a_0123456789abcdef';
const VERGLEICH_A = 'Synth?Vergleich>Anthropic~0123456789';
const VERGLEICH_L = 'Synth-Lese-Vergleich_9876543210-abcdef';
const OWNER = Object.freeze({ login: 'noah04091', id: 1, type: 'User', site_admin: false });
const ISSUE_MARKER = 'ISSUE-MARKER-unvertrauenswuerdig';
const FEHLER_ZEILE_RE = /^A6-FEHLER [a-z][a-z0-9-]{0,62}[a-z0-9]\n$/;
const PROMPT_AUSGABE_RE = /^prompt<<EOF_([0-9a-f]{32})\n([\s\S]*)\nEOF_\1\n$/;

const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
const T0 = Math.floor(Date.now() / 1000) * 1000 - 120_000;
const APPROVAL = iso(T0);
const RUN_CREATED = iso(T0 + 2000);

// ---------------------------------------------------------------------------
// Socket-Waechter und Attrappe fuer https.request
// ---------------------------------------------------------------------------

const ORIGINAL_REQUEST = https.request;
const ORIGINAL_CONNECT = net.Socket.prototype.connect;
let socketVersuche = 0;

net.Socket.prototype.connect = function verboten() {
  socketVersuche += 1;
  throw new Error('Socket im Claude-Jobtest verboten');
};

class FakeRequest extends EventEmitter {
  constructor(options, onResponse, antwort) {
    super();
    this.options = options;
    this.onResponse = onResponse;
    this.antwort = antwort;
  }

  write() {
    return true;
  }

  end() {
    queueMicrotask(() => {
      const { status, body } = this.antwort(this.options);
      const res = new Readable({ read() {} });
      res.statusCode = status;
      res.rawHeaders = [];
      res.headers = {};
      res.complete = true;
      this.onResponse(res);
      res.push(Buffer.from(body, 'utf8'));
      res.push(null);
    });
    return this;
  }

  destroy() {
    return this;
  }
}

function attrappe(routes) {
  const aufrufe = [];

  https.request = (options, onResponse) => {
    aufrufe.push({ method: options.method, path: options.path, host: options.hostname, auth: options.headers?.Authorization === `Bearer ${TOKEN}` });
    return new FakeRequest(options, onResponse, opts => (routes.has(opts.path)
      ? { status: 200, body: JSON.stringify(routes.get(opts.path)) }
      : { status: 404, body: '{"message":"Not Found"}' }));
  };

  return aufrufe;
}

function netzZaehler() {
  const zaehler = { https: 0 };
  https.request = () => {
    zaehler.https += 1;
    throw new Error('Netz in Job 1b verboten');
  };
  return zaehler;
}

afterEach(() => {
  https.request = ORIGINAL_REQUEST;
  cp.execFileSync = EXEC;
  cp.spawnSync = SPAWN;
  fs.writeSync = WRITE_SYNC;
  syncBuiltinESMExports();
});

// ---------------------------------------------------------------------------
// Synthetisches Repository
// ---------------------------------------------------------------------------

const RECHNE_ALT = '// Synthetischer Rechner fuer A6.4-2c-2.\nfunction addiere(a, b) {\n  return a + b;\n}\n\nmodule.exports = { addiere };\n';
const RECHNE_NEU = RECHNE_ALT.replace('module.exports = { addiere };', 'function quadrat(a) {\n  return a * a;\n}\n\nmodule.exports = { addiere, quadrat };');
const RECHNE_TEST_ALT = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { addiere } = require('../src/rechne.js');\n\ntest('addiere', () => assert.equal(addiere(2, 3), 5));\n";
const RECHNE_TEST_NEU = `${RECHNE_TEST_ALT}\ntest('quadrat', () => assert.equal(require('../src/rechne.js').quadrat(3), 9));\n`;
const TEXT_ALT = "// Synthetisches Textmodul fuer A6.4-2c-2.\nfunction zeichenzahl(text) {\n  return [...text].length;\n}\n\nmodule.exports = { zeichenzahl };\n";
const TEXT_NEU = TEXT_ALT.replace('module.exports = { zeichenzahl };', "function istLeer(text) {\n  return text === '';\n}\n\nmodule.exports = { zeichenzahl, istLeer };");
const TEXT_TEST_ALT = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { zeichenzahl } = require('../src/text.js');\n\ntest('zeichenzahl', () => assert.equal(zeichenzahl('ab'), 2));\n";
const TEXT_TEST_NEU = `${TEXT_TEST_ALT}\ntest('istLeer', () => assert.equal(require('../src/text.js').istLeer(''), true));\n`;

const AENDERUNG = Object.freeze({
  rechner: Object.freeze({ 'src/rechne.js': RECHNE_NEU, 'test/rechne.test.js': RECHNE_TEST_NEU }),
  text: Object.freeze({ 'src/text.js': TEXT_NEU, 'test/text.test.js': TEXT_TEST_NEU }),
});

const AUFGABEN = Object.freeze({
  rechner: Object.freeze({ issue: 6601, profil: 'js-rechner', aenderung: 'rechner' }),
  text: Object.freeze({ issue: 6602, profil: 'js-text', aenderung: 'text' }),
});

const runIdOf = issue => String(7_800_000_000 + issue);
const PROFIL_RECHNER = readFileSync(join(ROOT, 'agent-profiles', 'js-rechner.json'));
// Historischer inaktiver Stand von js-text als feste Vorlage (Blob 6d565be9 von main vor der Aktivierung),
// an SHA-256 gebunden. Den echten Stand auf main prueft agent-profile.test.mjs.
const PROFIL_TEXT = (() => {
  const bytes = readFileSync(join(ROOT, 'test', 'fixtures', 'a6-js-text-vorlage', 'js-text.json.vorlage'));
  if (createHash('sha256').update(bytes).digest('hex') !== '71d1656f410fcae598f3c6390e8531fc45a85b2adf1f0be4726e47bbd8f1a108') throw new Error('Vorlage js-text.json weicht vom festen Stand ab');
  return bytes;
})();
const AKTIV_FALSE = Buffer.from('"aktiv": false', 'utf8');

// Synthetische Aktivierung nur fuer das temporaere Repository dieser Datei.
function activate(bytes) {
  const first = bytes.indexOf(AKTIV_FALSE);
  assert.ok(first >= 0 && bytes.indexOf(AKTIV_FALSE, first + 1) < 0, 'js-text muss auf main genau einmal "aktiv": false tragen');
  return Buffer.concat([bytes.subarray(0, first), Buffer.from('"aktiv": true'), bytes.subarray(first + AKTIV_FALSE.length)]);
}

const DRAFT_POLICY = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'agent-policy.entwurf.json'), 'utf8'));
const POLICY_BYTES = Buffer.from(`${JSON.stringify({ ...DRAFT_POLICY, skript_hashes: { 'scripts/agent-profile.mjs': 'a'.repeat(64) } }, null, 2)}\n`, 'utf8');

function baseFiles() {
  const files = {
    '.github/agent/policy.json': POLICY_BYTES,
    'agent-profiles/js-rechner.json': PROFIL_RECHNER,
    'agent-profiles/js-text.json': activate(PROFIL_TEXT),
    'src/rechne.js': Buffer.from(RECHNE_ALT),
    'src/text.js': Buffer.from(TEXT_ALT),
    'test/rechne.test.js': Buffer.from(RECHNE_TEST_ALT),
    'test/text.test.js': Buffer.from(TEXT_TEST_ALT),
  };

  for (const aufgabe of Object.values(AUFGABEN)) {
    files[`agent-acceptance/issue-${aufgabe.issue}.mjs`] = Buffer.from('// Synthetische Abnahme, in diesen Tests nie ausgefuehrt.\nexport const synthetisch = true;\n');
  }

  return files;
}

const WINDOWS_KEYS = ['SystemRoot', 'PATHEXT', 'ComSpec', 'windir'];
const systemEnv = () => Object.fromEntries(WINDOWS_KEYS.map(key => [key, process.env[key]]).filter(([, value]) => typeof value === 'string'));

let BASE_DIR;
let ENV;
let REPO;
let BASIS;
let PARENT;
let TRUSTED;

function git(cwd, args, input, extraEnv = {}) {
  return EXEC('git', args, {
    cwd, env: { ...ENV, ...extraEnv }, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

function commitFiles(repo, files, parents, message) {
  const indexEnv = { GIT_INDEX_FILE: join(repo, '.git', `aufbau-${parents.length}`) };
  git(repo, ['read-tree', '--empty'], undefined, indexEnv);

  for (const [path, bytes] of Object.entries(files)) {
    const oid = git(repo, ['hash-object', '-w', '--stdin'], bytes);
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], undefined, indexEnv);
  }

  const tree = git(repo, ['write-tree'], undefined, indexEnv);
  return git(repo, ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message], undefined, {
    GIT_AUTHOR_DATE: '2026-11-15T08:00:00Z', GIT_COMMITTER_DATE: '2026-11-15T08:00:00Z',
  });
}

function trustedClone(dir) {
  EXEC('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', REPO, dir], { cwd: BASE_DIR, env: ENV, stdio: 'ignore' });
  git(dir, ['checkout', '-q', '--detach', BASIS]);
  git(dir, ['remote', 'remove', 'origin']);
  return dir;
}

const symlinksErlaubt = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'agent-code-job-claude-symlink-'));

  try {
    writeFileSync(join(probe, 'ziel'), 'x');
    symlinkSync(join(probe, 'ziel'), join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let counter = 0;
const newDir = prefix => mkdtempSync(join(BASE_DIR, `${prefix}${(counter += 1)}-`));

before(() => {
  BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-code-job-claude-test-'));
  const home = join(BASE_DIR, 'home');
  mkdirSync(join(home, 'xdg'), { recursive: true });
  writeFileSync(join(home, 'leer.gitconfig'), '');
  ENV = {
    ...systemEnv(), PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'xdg'), TEMP: home, TMP: home, TMPDIR: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'leer.gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  REPO = join(BASE_DIR, 'repo');
  mkdirSync(REPO);
  git(REPO, ['init', '-q']);
  PARENT = commitFiles(REPO, { 'README.md': Buffer.from('Elterncommit\n') }, [], 'Synthetischer Elterncommit');
  BASIS = commitFiles(REPO, baseFiles(), [PARENT], 'Synthetischer Ausgangscommit: js-text synthetisch aktiv');
  git(REPO, ['update-ref', 'refs/heads/main', BASIS]);
  git(REPO, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  TRUSTED = trustedClone(join(BASE_DIR, 'vertraut'));
});

after(() => {
  net.Socket.prototype.connect = ORIGINAL_CONNECT;
  https.request = ORIGINAL_REQUEST;
  rmSync(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Live-Daten, Schnappschuss und Auftrag je Aufgabe
// ---------------------------------------------------------------------------

const label = name => ({ id: 1000 + name.length, node_id: 'LA_x', name, color: 'ededed', default: false });

function daten(name, mod = {}) {
  const a = AUFGABEN[name];
  const runId = runIdOf(a.issue);
  const titel = `Synthetisch A6.4-2c-2: Aufgabe ${a.issue} ${ISSUE_MARKER}`;
  const text = `Kuenstlicher Auftrag fuer die Claude-Jobtests (${name}).\r\nZweite Zeile ${ISSUE_MARKER}.`;
  const b = a.issue * 100;
  let issue = {
    number: a.issue, title: titel, user: { ...OWNER }, labels: [label('bot-auftrag'), label(`agent:${a.profil}`)], state: 'open',
    created_at: iso(T0 - 3_600_000), updated_at: APPROVAL, body: text, comments: 0, author_association: 'OWNER',
  };
  const payload = {
    action: 'labeled', issue: structuredClone(issue), label: label('bot-auftrag'),
    repository: { id: 42, name: 'agenten-probe', full_name: REPO_NAME, owner: { ...OWNER } }, sender: { ...OWNER },
  };
  let run = {
    id: Number(runId), event: 'issues', path: WORKFLOW_PATH, head_branch: 'main', head_sha: BASIS, run_attempt: 1, created_at: RUN_CREATED,
    status: 'in_progress', repository: { full_name: REPO_NAME }, head_repository: { full_name: REPO_NAME }, actor: { ...OWNER }, triggering_actor: { ...OWNER },
  };
  let events = [
    { id: b + 1, event: 'labeled', created_at: iso(T0 - 60_000), actor: { ...OWNER }, label: label(`agent:${a.profil}`), performed_via_github_app: null },
    { id: b + 2, event: 'labeled', created_at: APPROVAL, actor: { ...OWNER }, label: label('bot-auftrag'), performed_via_github_app: null },
  ];
  let pulls = [{ number: 60, head: { ref: 'wp/26-a6-4-2b-transport' } }];
  let refs = [];
  let main = { ref: 'refs/heads/main', object: { type: 'commit', sha: BASIS } };

  issue = mod.issue ? mod.issue(issue) : issue;
  run = mod.run ? mod.run(run) : run;
  events = mod.events ? mod.events(events) : events;
  pulls = mod.pulls ? mod.pulls(pulls) : pulls;
  refs = mod.refs ? mod.refs(refs) : refs;
  main = mod.main ? mod.main(main) : main;

  const routes = new Map([
    [`${P}actions/runs/${runId}`, run],
    [`${P}git/ref/heads/main`, main],
    [`${P}issues/${a.issue}`, issue],
    [`${P}issues/${a.issue}/events?per_page=100&page=1`, events],
    [`${P}git/matching-refs/heads/wp/${a.issue}-`, refs],
    [`${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=1`, pulls],
  ]);
  return { aufgabe: a, runId, payload, issue, events, run, routes };
}

// Was Job 0 fuer diese Aufgabe liefert: Schnappschussbytes, ihr Hash und der volle Auftrags-Hash.
const GRUND = new Map();

function grund(name) {
  if (!GRUND.has(name)) {
    const f = daten(name);
    const runData = { id: f.runId, attempt: 1, createdAt: RUN_CREATED };
    const order = resolveOrder({ root: TRUSTED, baseSha: BASIS, gitEnv: { ...ENV }, repository: REPO_NAME, event: f.payload, issue: f.issue, events: f.events, run: runData, now: new Date() });
    const snapshot = buildSnapshot({ issue: f.issue, events: f.events, run: runData, event: f.payload });
    GRUND.set(name, Object.freeze({ order, orderSha: orderSha256(order), snapshotText: snapshot.toString('utf8'), snapshotSha: sha256(snapshot), runId: f.runId, f }));
  }

  const g = GRUND.get(name);
  return { ...g, snapshotBytes: Buffer.from(g.snapshotText, 'utf8') };
}

function umgebung(temp, g, job) {
  const env = {
    ...systemEnv(),
    GITHUB_REPOSITORY: REPO_NAME,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_RUN_ID: g.runId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: BASIS,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_WORKSPACE: TRUSTED,
    GITHUB_OUTPUT: join(temp, '_runner_file_commands', 'set_output_test'),
    RUNNER_TEMP: temp,
    PATH: process.env.PATH,
    A6_AUFTRAG_SHA256: g.orderSha,
    A6_SCHNAPPSCHUSS_SHA256: g.snapshotSha,
  };

  if (job === 'vor') {
    env.A6_LESE_TOKEN = TOKEN;
  } else {
    env.A6_VERGLEICH_ANTHROPIC = VERGLEICH_A;
    env.A6_VERGLEICH_LESE_TOKEN = VERGLEICH_L;
  }

  return env;
}

const ohneUndefined = env => Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));

// RUNNER_TEMP mit Schnappschuss (null laesst weg) und leerer Ausgabedatei.
function neuesTemp(snapshotBytes) {
  const temp = newDir('t-');
  mkdirSync(join(temp, '_runner_file_commands'));
  writeFileSync(join(temp, '_runner_file_commands', 'set_output_test'), '');

  if (snapshotBytes !== null) {
    mkdirSync(join(temp, 'a6-auftrag'));
    writeFileSync(join(temp, 'a6-auftrag', 'schnappschuss.json'), snapshotBytes);
  }

  return temp;
}

async function fange(fn) {
  const err = [];
  const origErr = process.stderr.write;
  process.stderr.write = chunk => { err.push(String(chunk)); return true; };
  let code;

  try {
    code = await fn();
  } finally {
    process.stderr.write = origErr;
  }

  return { code, stdout: '', stderr: err.join('') };
}

const ausgabe = temp => readFileSync(join(temp, '_runner_file_commands', 'set_output_test'), 'utf8');

function abgelehnt(r, code) {
  assert.equal(r.code, 1, `keine Ablehnung, erwartet ${code}`);
  assert.equal(r.stderr, `A6-FEHLER ${code}\n`);
  assert.ok(FEHLER_ZEILE_RE.test(r.stderr));

  for (const marker of [ISSUE_MARKER, TOKEN, TOKEN.slice(4), VERGLEICH_A, VERGLEICH_L, VERGLEICH_A.slice(5, 25), Buffer.from(VERGLEICH_A).toString('base64').slice(0, 20)]) {
    assert.ok(!r.stderr.includes(marker), 'vertraulicher Inhalt im Protokoll');
  }
}

// ---------------------------------------------------------------------------
// Job 1a im Prozess
// ---------------------------------------------------------------------------

async function jobVor(name, { mod = {}, envMod = {}, snapshotBytes, vorher } = {}) {
  const g = grund(name);
  const f = daten(name, mod);
  const temp = neuesTemp(snapshotBytes === undefined ? g.snapshotBytes : snapshotBytes);
  const env = ohneUndefined({ ...umgebung(temp, g, 'vor'), ...envMod });
  vorher?.(temp, env);
  const aufrufe = attrappe(f.routes);
  const r = await fange(() => mainVor(env));
  return { ...r, g, temp, env, aufrufe, output: ausgabe(temp), workDir: join(temp, 'a6-claude-arbeit') };
}

function vorAbgelehnt(r, code) {
  abgelehnt(r, code);
  assert.equal(r.output, '', 'Prompt-Ausgabe trotz Ablehnung');
}

function vorErfolg(r) {
  assert.equal(r.stderr, '', r.stderr);
  assert.equal(r.code, 0);
  const match = PROMPT_AUSGABE_RE.exec(r.output);
  assert.ok(match, 'Prompt-Ausgabe hat nicht genau die Form prompt<<EOF_<nonce>');
  return match[2];
}

const LIVE_PFADE = (issue, runId) => [
  `GET ${P}actions/runs/${runId}`,
  `GET ${P}git/ref/heads/main`,
  `GET ${P}issues/${issue}`,
  `GET ${P}issues/${issue}/events?per_page=100&page=1`,
  `GET ${P}git/matching-refs/heads/wp/${issue}-`,
  `GET ${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=1`,
];

function baumDateien(dir, prefix = '') {
  const out = [];

  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    out.push(...(entry.isDirectory() ? baumDateien(dir, rel) : [rel]));
  }

  return out.sort();
}

// ---------------------------------------------------------------------------
// Job 1b im Prozess, mit Zaehlern fuer Netz und Prozessstarts
// ---------------------------------------------------------------------------

// RUNNER_TEMP wie nach Job 1a und Claude: Schnappschuss, vorbereiteter Arbeitsordner, veraendert.
function nachClaude(name, aendern) {
  const g = grund(name);
  const temp = neuesTemp(g.snapshotBytes);
  const work = prepareWorkspace(TRUSTED, g.order, g.orderSha, join(temp, 'a6-claude-arbeit'), { gitEnv: { ...ENV } }).arbeitsordner;
  const dateien = aendern === undefined ? AENDERUNG[AUFGABEN[name].aenderung] : aendern;

  if (typeof dateien === 'function') {
    dateien(work);
  } else {
    for (const [pfad, inhalt] of Object.entries(dateien)) {
      writeFileSync(join(work, ...pfad.split('/')), inhalt);
    }
  }

  return { g, temp, work };
}

async function jobNach(name, { aendern, envMod = {}, vorher, temp: fertig } = {}) {
  const lage = fertig ?? nachClaude(name, aendern);
  const env = ohneUndefined({ ...umgebung(lage.temp, lage.g, 'nach'), ...envMod });
  vorher?.(lage.temp, env);
  const netz = netzZaehler();
  const socketsVorher = socketVersuche;
  const starts = [];
  cp.execFileSync = function execFileSync(file, args, options) {
    starts.push({ file, cwd: options?.cwd });
    return EXEC(file, args, options);
  };
  cp.spawnSync = function spawnSync(file, args, options) {
    starts.push({ file, cwd: options?.cwd });
    return SPAWN(file, args, options);
  };
  syncBuiltinESMExports();
  let r;

  try {
    r = await fange(() => mainNach(env));
  } finally {
    cp.execFileSync = EXEC;
    cp.spawnSync = SPAWN;
    syncBuiltinESMExports();
  }

  assert.equal(netz.https, 0, 'Netzversuch in Job 1b');
  assert.equal(socketVersuche, socketsVorher, 'Socket in Job 1b');
  // Nur git, nur im vertrauenswuerdigen Checkout, nie im Arbeitsordner von Claude.
  assert.ok(starts.every(start => start.file === 'git' && start.cwd === TRUSTED), `unerwarteter Prozessstart: ${JSON.stringify(starts)}`);
  const paketDatei = join(lage.temp, 'a6-paket', 'paket-v2.json');
  return { ...r, ...lage, env, starts, output: ausgabe(lage.temp), paket: existsSync(paketDatei) ? readFileSync(paketDatei) : null };
}

function nachAbgelehnt(r, code) {
  abgelehnt(r, code);
  assert.equal(r.output, '', 'Hash trotz Ablehnung ausgegeben');
  assert.equal(r.paket, null, 'Paketdatei trotz Ablehnung geschrieben');
}

function nachErfolg(r) {
  assert.equal(r.stderr, '', r.stderr);
  assert.equal(r.code, 0);
  const match = /^paket_sha256=([0-9a-f]{64})\n$/.exec(r.output);
  assert.ok(match, `Ausgabe unerwartet: ${JSON.stringify(r.output)}`);
  assert.ok(r.paket !== null);
  assert.equal(sha256(r.paket), match[1]);
  return match[1];
}

// Aenderung mit einer zusaetzlichen Kommentarzeile, die eine Darstellung eines Werts traegt.
const mitZeile = (name, zeile) => ({ ...AENDERUNG[AUFGABEN[name].aenderung], [name === 'text' ? 'src/text.js' : 'src/rechne.js']: `${name === 'text' ? TEXT_NEU : RECHNE_NEU}// Notiz: ${zeile}\n` });

// ===========================================================================
// Job 1a: positive Laeufe
// ===========================================================================

for (const [name, profil] of [['rechner', 'js-rechner'], ['text', 'js-text']]) {
  test(`Positiv Job 1a ${profil}: Schnappschuss, Auftrag, frische Live-Pruefung, Arbeitsordner, Profil und genau die Prompt-Ausgabe`, async () => {
    const r = await jobVor(name);
    const prompt = vorErfolg(r);
    const a = AUFGABEN[name];

    // Nur die sechs Live-GETs, je einmal, an api.github.com, mit dem Lesetoken.
    assert.deepEqual(r.aufrufe.map(c => `${c.method} ${c.path}`), LIVE_PFADE(a.issue, r.g.runId));
    assert.ok(r.aufrufe.every(c => c.host === 'api.github.com' && c.auth));

    // Prompt: fester Sicherheitsrahmen zuerst, Profilrahmen, erlaubte Dateien aus dem Auftrag, Titel und
    // Text aus dem gebundenen Schnappschuss (CRLF normalisiert), Markierung mit Nonce.
    assert.ok(prompt.startsWith(SECURITY_FRAME));
    assert.ok(prompt.includes(`# Aufgabe aus dem geprueften Profil ${profil}`));

    for (const datei of r.g.order.dateien) {
      assert.ok(prompt.includes(`- ${datei}\n`), `${datei} fehlt im Prompt`);
    }

    assert.ok(prompt.includes(`Titel: Synthetisch A6.4-2c-2: Aufgabe ${a.issue} ${ISSUE_MARKER}\n`));
    assert.ok(prompt.includes('Zweite Zeile') && !prompt.includes('\r'));
    assert.ok(!prompt.includes(TOKEN) && !prompt.includes(TOKEN.slice(4)), 'Token im Prompt');

    // Arbeitsordner: genau die Dateien des Ausgangscommits, unveraendert, ohne .git, ausserhalb des Checkouts.
    assert.deepEqual(baumDateien(r.workDir), Object.keys(baseFiles()).sort());
    assert.equal(readFileSync(join(r.workDir, 'src', 'rechne.js'), 'utf8'), RECHNE_ALT);
    assert.ok(!existsSync(join(r.workDir, '.git')));
    assert.deepEqual(readdirSync(r.temp).sort(), ['_runner_file_commands', 'a6-auftrag', 'a6-claude-arbeit', 'a6-claude-vor-home']);
    assert.equal(git(TRUSTED, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']), '', 'Checkout veraendert');
  });
}

test('Positiv Kette: Job 1a bereitet vor, Claude veraendert den Arbeitsordner, Job 1b packt im selben RUNNER_TEMP', async () => {
  const vor = await jobVor('rechner');
  vorErfolg(vor);

  for (const [pfad, inhalt] of Object.entries(AENDERUNG.rechner)) {
    writeFileSync(join(vor.workDir, ...pfad.split('/')), inhalt);
  }

  // Die Ausgabedatei des Runners ist pro Schritt neu.
  writeFileSync(join(vor.temp, '_runner_file_commands', 'set_output_test'), '');
  const r = await jobNach('rechner', { temp: { g: vor.g, temp: vor.temp, work: vor.workDir } });
  const hash = nachErfolg(r);
  const parsed = parsePackageV2(vor.g.order, vor.g.orderSha, r.paket, hash);
  assert.deepEqual(parsed.dateien.map(meta => meta.pfad), ['src/rechne.js', 'test/rechne.test.js']);
});

// ===========================================================================
// Job 1a: Ablehnungen
// ===========================================================================

test('Job 1a Umgebung: fremdes Repository, Lauf-ID, Laufversuch, Ausgangscommit, Workflow, Hashformat, Token und Ausgabepfad', async () => {
  const faelle = [
    [{ GITHUB_REPOSITORY: 'noah04091/anderes' }, 'job-repository'],
    [{ GITHUB_RUN_ATTEMPT: '2' }, 'job-lauf-versuch'],
    [{ GITHUB_RUN_ID: '0123' }, 'job-lauf-id'],
    [{ GITHUB_WORKFLOW_REF: `${REPO_NAME}/.github/workflows/tests.yml@refs/heads/main` }, 'job-workflow'],
    [{ A6_AUFTRAG_SHA256: 'A'.repeat(64) }, 'job-hash-format'],
    [{ A6_SCHNAPPSCHUSS_SHA256: undefined }, 'job-umgebung-fehlt'],
    [{ A6_LESE_TOKEN: undefined }, 'job-umgebung-fehlt'],
    [{ A6_APP_TOKEN: TOKEN }, 'job-umgebung-geheimnis'],
    [{ A6_VERGLEICH_ANTHROPIC: VERGLEICH_A }, 'job-umgebung-geheimnis'],
    [{ ANTHROPIC_API_KEY: 'x' }, 'job-umgebung-geheimnis'],
    [{ NODE_OPTIONS: '--require ./x.cjs' }, 'job-umgebung-node'],
    [{ GITHUB_OUTPUT: join(tmpdir(), 'ausserhalb-output') }, 'job-ausgabe-pfad'],
  ];

  for (const [envMod, code] of faelle) {
    const r = await jobVor('rechner', { envMod });
    vorAbgelehnt(r, code);
    assert.equal(r.aufrufe.length, 0, `Netz trotz ${code}`);
    assert.ok(!existsSync(r.workDir), `Arbeitsordner trotz ${code}`);
  }

  // Falscher Ausgangscommit: der Checkout steht nicht darauf.
  const falsch = await jobVor('rechner', { envMod: { GITHUB_SHA: PARENT } });
  vorAbgelehnt(falsch, 'job-checkout-head');
  assert.equal(falsch.aufrufe.length, 0);
});

test('Job 1a Schnappschuss: falsche Bytes, fremder Lauf, abweichender Auftrags-Hash, fehlende Datei', async () => {
  const g = grund('rechner');
  const t = grund('text');

  // Veraenderte Bytes bei erwartetem Hash, und ein fremder Schnappschuss mit eigenem Hash.
  const verfaelscht = Buffer.from(g.snapshotText.replace(ISSUE_MARKER, 'ISSUE-MARKER-unvertrauenswuerdiX'), 'utf8');
  vorAbgelehnt(await jobVor('rechner', { snapshotBytes: verfaelscht }), 'job-schnappschuss-hash');
  vorAbgelehnt(await jobVor('rechner', { snapshotBytes: t.snapshotBytes, envMod: { A6_SCHNAPPSCHUSS_SHA256: t.snapshotSha } }), 'job-schnappschuss-lauf');
  vorAbgelehnt(await jobVor('rechner', { snapshotBytes: null }), 'job-schnappschuss-datei');

  // Stimmiger Schnappschuss, aber ein anderer erwarteter Auftrag.
  const r = await jobVor('rechner', { envMod: { A6_AUFTRAG_SHA256: t.orderSha } });
  vorAbgelehnt(r, 'auftrag-abweichung');
  assert.equal(r.aufrufe.length, 0, 'Netz vor der Auftragsbindung');

  // Ungepruefter Prompt: Titel im Schnappschuss geaendert, Hash passend nachgerechnet. Der Auftrag
  // weicht dann ab, bevor ein Prompt entsteht.
  const value = JSON.parse(g.snapshotText);
  value.issue.title = 'Anderer Titel ohne Freigabe';
  value.event.issue.title = 'Anderer Titel ohne Freigabe';
  const neu = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  vorAbgelehnt(await jobVor('rechner', { snapshotBytes: neu, envMod: { A6_SCHNAPPSCHUSS_SHA256: sha256(neu) } }), 'auftrag-abweichung');
});

test('Job 1a Live: geaenderte Freigabe, geaendertes Issue, vorhandener PR, vorhandener Branch, main, fremder Lauf', async () => {
  const faelle = [
    [{ events: e => [...e, { id: e[1].id + 1, event: 'unlabeled', created_at: iso(T0 + 1000), actor: { ...OWNER }, label: label('bot-auftrag'), performed_via_github_app: null }] }, 'auftrag-freigabe-entzogen'],
    [{ issue: i => ({ ...i, updated_at: iso(T0 + 30_000) }) }, 'auftrag-issue-geaendert'],
    [{ pulls: p => [...p, { number: 77, head: { ref: 'wp/6601-frueher' } }] }, 'live-pr-vorhanden'],
    [{ refs: () => [{ ref: 'refs/heads/wp/6601-agent-1-1', object: { type: 'commit', sha: BASIS } }] }, 'live-branch-vorhanden'],
    [{ main: m => ({ ...m, object: { ...m.object, sha: PARENT } }) }, 'live-main-geaendert'],
    [{ run: run => ({ ...run, path: '.github/workflows/tests.yml' }) }, 'live-lauf-workflow'],
  ];

  for (const [mod, code] of faelle) {
    const r = await jobVor('rechner', { mod });
    vorAbgelehnt(r, code);
    assert.equal(r.aufrufe.length, 6, 'genau eine Live-Lesung');
    assert.ok(!existsSync(r.workDir), 'Arbeitsordner trotz Live-Ablehnung');
  }
});

test('Job 1a Arbeitsordner und Profil: vorhandener Ordner, Symlink, verschmutzter Checkout, Ausgabedatei ohne Zeilenende', async t => {
  // Vorhandener, auch leerer Arbeitsordner wird nie verwendet.
  vorAbgelehnt(await jobVor('rechner', { vorher: temp => mkdirSync(join(temp, 'a6-claude-arbeit')) }), 'job-arbeitsordner');

  // Manipuliertes Profil im vertrauenswuerdigen Checkout: eigener Klon, damit die anderen Faelle sauber bleiben.
  const eigen = trustedClone(newDir('profil-'));
  writeFileSync(join(eigen, 'agent-profiles', 'js-rechner.json'), Buffer.concat([PROFIL_RECHNER, Buffer.from(' ')]));
  const r = await jobVor('rechner', { envMod: { GITHUB_WORKSPACE: eigen } });
  vorAbgelehnt(r, 'paket-status');

  // Ausgabedatei endet nicht mit einem Zeilenumbruch: keine Ausgabe, kein Prompt.
  const offen = await jobVor('rechner', { vorher: temp => writeFileSync(join(temp, '_runner_file_commands', 'set_output_test'), 'frueher=1') });
  assert.equal(offen.code, 1);
  assert.equal(offen.stderr, 'A6-FEHLER ausgabe-datei-ende\n');
  assert.equal(offen.output, 'frueher=1');

  // Checkout innerhalb von RUNNER_TEMP.
  const temp = newDir('innen-');
  const innen = trustedClone(join(temp, 'checkout'));
  const g = grund('rechner');
  const env = umgebung(temp, g, 'vor');
  mkdirSync(join(temp, '_runner_file_commands'));
  writeFileSync(env.GITHUB_OUTPUT, '');
  attrappe(daten('rechner').routes);
  abgelehnt(await fange(() => mainVor({ ...env, GITHUB_WORKSPACE: innen })), 'job-checkout');

  if (!symlinksErlaubt) {
    t.diagnostic('Symlink-Fall uebersprungen: das System erlaubt keine Symlinks');
    return;
  }

  vorAbgelehnt(await jobVor('rechner', { vorher: temp2 => symlinkSync(newDir('ziel-'), join(temp2, 'a6-claude-arbeit'), 'dir') }), 'job-arbeitsordner');
});

// ===========================================================================
// Job 1b: positive Laeufe
// ===========================================================================

for (const [name, profil] of [['rechner', 'js-rechner'], ['text', 'js-text']]) {
  test(`Positiv Job 1b ${profil}: Auftrag neu, Paket v2, Muster- und Wertpruefung, exklusiv geschrieben, zurueckgelesen, genau eine Ausgabe`, async () => {
    const r = await jobNach(name);
    const hash = nachErfolg(r);
    assert.ok(r.starts.length > 0, 'Muss-Treffer: Git lief im vertrauenswuerdigen Checkout');

    // Unabhaengig im Test: das Paket gehoert zum Auftrag und traegt genau die geaenderten Dateien.
    const parsed = parsePackageV2(r.g.order, r.g.orderSha, r.paket, hash);
    const erwartet = AENDERUNG[AUFGABEN[name].aenderung];
    assert.deepEqual(parsed.dateien.map(meta => meta.pfad), Object.keys(erwartet).sort());
    const paket = JSON.parse(r.paket.toString('utf8'));

    for (const eintrag of paket.dateien) {
      assert.equal(Buffer.from(eintrag.base64, 'base64').toString('utf8'), erwartet[eintrag.pfad]);
    }

    // Derselbe Hash wie createPackageV2 im Test, und die Datei ist die einzige im neuen Paketordner.
    assert.equal(createPackageV2(TRUSTED, r.g.order, r.g.orderSha, r.work).sha256, hash);
    assert.deepEqual(readdirSync(join(r.temp, 'a6-paket')), ['paket-v2.json']);
    assert.deepEqual(readdirSync(r.temp).sort(), ['_runner_file_commands', 'a6-auftrag', 'a6-claude-arbeit', 'a6-claude-nach-home', 'a6-paket']);

    // Keine Vergleichswerte und keine Kodierung davon in Paket und Ausgabe.
    for (const wert of [VERGLEICH_A, VERGLEICH_L]) {
      assert.equal(containsSecretValue(r.paket, [wert]).fund, false);
      assert.equal(containsSecretValue(Buffer.from(r.output), [wert]).fund, false);
    }
  });
}

test('Positiv Job 1b als CLI: nur die feste Ausgabe, nichts auf stdout oder stderr', () => {
  const { g, temp } = nachClaude('rechner');
  const out = SPAWN(process.execPath, [JOB1B_PATH], { env: umgebung(temp, g, 'nach'), encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(out.stderr, '', out.stderr);
  assert.equal(out.stdout, '');
  assert.equal(out.status, 0);
  const hash = sha256(readFileSync(join(temp, 'a6-paket', 'paket-v2.json')));
  assert.equal(ausgabe(temp), `${PACKAGE_OUTPUT_KEY}=${hash}\n`);

  // Mit einem Vergleichswert im Paket: genau eine feste Zeile, kein Wert.
  const boese = nachClaude('rechner', mitZeile('rechner', VERGLEICH_L));
  const nein = SPAWN(process.execPath, [JOB1B_PATH], { env: umgebung(boese.temp, boese.g, 'nach'), encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(nein.status, 1);
  assert.equal(nein.stderr, 'A6-FEHLER job-geheimnis-wert\n');
  assert.equal(nein.stdout, '');
  assert.equal(ausgabe(boese.temp), '');
  assert.ok(!existsSync(join(boese.temp, 'a6-paket')));
});

// ===========================================================================
// Job 1b: Arbeitsordner, Checkout und Vertrag
// ===========================================================================

test('Job 1b Arbeitsordner: unerlaubte Datei, fehlende Aenderung, fremde Git-Konfiguration, fehlender Ordner, Symlink', async t => {
  const faelle = [
    ['unerlaubte Datei', 'paket-datei-neu', w => { writeFileSync(join(w, 'src', 'rechne.js'), RECHNE_NEU); writeFileSync(join(w, 'test', 'rechne.test.js'), RECHNE_TEST_NEU); writeFileSync(join(w, 'src', 'neu.js'), 'x\n'); }],
    ['fehlende Aenderung', 'paket-unveraendert', w => { writeFileSync(join(w, 'src', 'rechne.js'), RECHNE_NEU); }],
    ['keine Aenderung', 'paket-unveraendert', () => {}],
    ['fremde Git-Konfiguration', 'paket-git-ordner', w => { writeFileSync(join(w, 'src', 'rechne.js'), RECHNE_NEU); writeFileSync(join(w, 'test', 'rechne.test.js'), RECHNE_TEST_NEU); mkdirSync(join(w, '.git')); writeFileSync(join(w, '.git', 'config'), '[core]\n\tfsmonitor = boese\n'); }],
    ['geaenderte fremde Datei', 'paket-fremde-aenderung', w => { writeFileSync(join(w, 'src', 'rechne.js'), RECHNE_NEU); writeFileSync(join(w, 'test', 'rechne.test.js'), RECHNE_TEST_NEU); writeFileSync(join(w, 'src', 'text.js'), 'geaendert\n'); }],
  ];

  for (const [fall, code, aendern] of faelle) {
    const r = await jobNach('rechner', { aendern });
    assert.equal(r.code, 1, fall);
    nachAbgelehnt(r, code);
  }

  // Fehlender Arbeitsordner.
  const ohne = await jobNach('rechner', { vorher: temp => rmSync(join(temp, 'a6-claude-arbeit'), { recursive: true, force: true }) });
  nachAbgelehnt(ohne, 'job-arbeitsordner');

  // Vorhandener Paketordner wird nie verwendet, eine vorhandene Paketdatei nie ueberschrieben.
  const vorhanden = await jobNach('rechner', { vorher: temp => { mkdirSync(join(temp, 'a6-paket')); writeFileSync(join(temp, 'a6-paket', 'paket-v2.json'), 'alt'); } });
  abgelehnt(vorhanden, 'job-ordner');
  assert.equal(vorhanden.output, '');
  assert.equal(vorhanden.paket.toString('utf8'), 'alt');

  if (!symlinksErlaubt) {
    t.diagnostic('Symlink-Faelle uebersprungen: das System erlaubt keine Symlinks');
    return;
  }

  const link = await jobNach('rechner', { aendern: w => { writeFileSync(join(w, 'test', 'rechne.test.js'), RECHNE_TEST_NEU); rmSync(join(w, 'src', 'rechne.js')); symlinkSync(join(TRUSTED, 'src', 'rechne.js'), join(w, 'src', 'rechne.js')); } });
  assert.ok(/^A6-FEHLER paket-[a-z0-9-]+\n$/.test(link.stderr), link.stderr);
  nachAbgelehnt(link, link.stderr.slice('A6-FEHLER '.length, -1));
  const ordnerLink = await jobNach('rechner', { vorher: temp => { const ziel = join(temp, 'a6-claude-arbeit'); const echt = join(temp, 'echt'); fs.renameSync(ziel, echt); symlinkSync(echt, ziel, 'dir'); } });
  nachAbgelehnt(ordnerLink, 'job-arbeitsordner');
});

test('Job 1b Vertrag: Basiscommit, Lauf, Versuch, Repository, Schnappschuss, Auftrags-Hash', async () => {
  const t = grund('text');
  const faelle = [
    [{ GITHUB_SHA: null }, 'job-checkout-head'],
    [{ GITHUB_RUN_ATTEMPT: '2' }, 'job-lauf-versuch'],
    [{ GITHUB_REPOSITORY: 'noah04091/anderes' }, 'job-repository'],
    [{ A6_SCHNAPPSCHUSS_SHA256: 'c'.repeat(64) }, 'job-schnappschuss-hash'],
    [{ A6_AUFTRAG_SHA256: t.orderSha }, 'auftrag-abweichung'],
    [{ GITHUB_RUN_ID: t.runId }, 'job-schnappschuss-lauf'],
  ];

  for (const [envMod, code] of faelle) {
    const r = await jobNach('rechner', { envMod: envMod.GITHUB_SHA === null ? { GITHUB_SHA: PARENT } : envMod });
    nachAbgelehnt(r, code);
  }
});

test('Job 1b Vergleichswerte: unvollstaendige Liste, fehlend, leer, zu kurz, zu lang, ungueltig, zusaetzlicher Geheimnisname', async () => {
  const kurz = 'x'.repeat(MIN_COMPARE_LENGTH - 1);
  const genau = 'Synth-Grenzwert-20-Z';
  assert.equal([...genau].length, MIN_COMPARE_LENGTH);
  const faelle = [
    [{ A6_VERGLEICH_LESE_TOKEN: undefined }, 'job-umgebung-fehlt'],
    [{ A6_VERGLEICH_ANTHROPIC: undefined }, 'job-umgebung-fehlt'],
    [{ A6_VERGLEICH_ANTHROPIC: '' }, 'job-umgebung-fehlt'],
    [{ A6_VERGLEICH_LESE_TOKEN: kurz }, 'job-vergleich-wert'],
    [{ A6_VERGLEICH_ANTHROPIC: 'y'.repeat(MAX_COMPARE_LENGTH + 1) }, 'job-vergleich-wert'],
    [{ A6_VERGLEICH_ANTHROPIC: `Synth-Vergleich-${String.fromCharCode(0xd800)}-ungueltig` }, 'job-vergleich-wert'],
    [{ A6_LESE_TOKEN: TOKEN }, 'job-umgebung-geheimnis'],
    [{ A6_APP_TOKEN: TOKEN }, 'job-umgebung-geheimnis'],
    [{ ANTHROPIC_API_KEY: VERGLEICH_A }, 'job-umgebung-geheimnis'],
    [{ GH_TOKEN: 'x' }, 'job-umgebung-geheimnis'],
    [{ NODE_OPTIONS: '--require ./x.cjs' }, 'job-umgebung-node'],
  ];

  for (const [envMod, code] of faelle) {
    nachAbgelehnt(await jobNach('rechner', { envMod }), code);
  }

  // Muss-Treffer: genau 20 Zeichen und genau die Hoechstlaenge sind erlaubt.
  nachErfolg(await jobNach('rechner', { envMod: { A6_VERGLEICH_ANTHROPIC: genau, A6_VERGLEICH_LESE_TOKEN: 'z'.repeat(MAX_COMPARE_LENGTH) } }));
});

// ===========================================================================
// Job 1b: Geheimniswerte in Dateien und Paket
// ===========================================================================

const hexGemischt = hex => [...hex].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('');
const b64 = (wert, pad = 0) => Buffer.concat([Buffer.alloc(pad), Buffer.from(wert, 'utf8')]).toString('base64');

test('Job 1b Wertpruefung: Klartext, Base64, Base64url, Hex klein, gross, gemischt, getrennt, umgedreht, geteilt; beide Werte', async () => {
  const urlForm = b64(VERGLEICH_A).replaceAll('+', '-').replaceAll('/', '_');
  assert.notEqual(urlForm, b64(VERGLEICH_A), 'Muss-Treffer: Base64url unterscheidet sich hier von Base64');
  const hexA = Buffer.from(VERGLEICH_A, 'utf8').toString('hex');
  const darstellungen = [
    ['klartext', VERGLEICH_A, 'klartext'],
    ['base64', b64(VERGLEICH_A), 'base64'],
    ['base64url', urlForm, 'base64url'],
    ['hex klein', hexA, 'hex-klein'],
    ['hex gross', hexA.toUpperCase(), 'hex-gross'],
    ['hex gemischt', hexGemischt(hexA), 'hex-getrennt'],
    ['hex getrennt', hexA.replace(/(..)(?!$)/g, '$1:'), 'hex-getrennt'],
    ['umgedreht', [...VERGLEICH_A].reverse().join(''), 'umgedreht'],
    ['geteilt', `'${b64(VERGLEICH_A).slice(0, 12)}' + '${b64(VERGLEICH_A).slice(12)}'`, 'base64-geteilt'],
    ['zweiter Wert klartext', VERGLEICH_L, 'klartext'],
    ['zweiter Wert base64', b64(VERGLEICH_L, 1), 'base64'],
    ['zweiter Wert hex', Buffer.from(VERGLEICH_L).toString('hex'), 'hex-klein'],
  ];

  for (const [fall, zeile, art] of darstellungen) {
    // Unabhaengig: die Darstellung wird von containsSecretValue mit dieser Art erkannt.
    const wert = fall.startsWith('zweiter') ? VERGLEICH_L : VERGLEICH_A;
    assert.ok(containsSecretValue(Buffer.from(`// Notiz: ${zeile}\n`), [wert]).arten.includes(art), `${fall}: Art ${art} nicht erkannt`);
    const r = await jobNach('rechner', { aendern: mitZeile('rechner', zeile) });
    nachAbgelehnt(r, 'job-geheimnis-wert');
  }

  // Auch in einer Testdatei und im js-text-Profil.
  nachAbgelehnt(await jobNach('text', { aendern: { ...AENDERUNG.text, 'test/text.test.js': `${TEXT_TEST_NEU}// ${b64(VERGLEICH_L, 2)}\n` } }), 'job-geheimnis-wert');

  // Muss-Treffer: dieselbe Zeile ohne Wert besteht.
  nachErfolg(await jobNach('rechner', { aendern: mitZeile('rechner', 'harmloser Kommentar ohne Wert') }));
});

test('Job 1b Musterpruefung bleibt: bekannte Token-Muster werden schon beim Paketbau abgelehnt', async () => {
  const muster = `ghp_${'A'.repeat(36)}`;
  const r = await jobNach('rechner', { aendern: mitZeile('rechner', muster) });
  nachAbgelehnt(r, 'paket-geheimnis');
});

test('Job 1b Integritaet: ausgetauschte Paketbytes beim Schreiben werden beim Zuruecklesen erkannt, kein frueher Hash', async () => {
  let getauscht = 0;
  const r = await jobNach('rechner', {
    vorher: () => {
      fs.writeSync = function writeSync(fd, buffer, offset, length, ...rest) {
        // Nur der Paketinhalt (beginnt mit dem JSON-Objekt des Pakets) wird beim Schreiben verfaelscht.
        if (Buffer.isBuffer(buffer) && buffer.length > 1000 && buffer.toString('utf8', 0, 30).includes('"schema"')) {
          getauscht += 1;
          const kopie = Buffer.from(buffer);
          kopie[kopie.length - 3] ^= 1;
          return WRITE_SYNC(fd, kopie, offset, length, ...rest);
        }

        return WRITE_SYNC(fd, buffer, offset, length, ...rest);
      };
      syncBuiltinESMExports();
    },
  });
  assert.equal(getauscht, 1, 'Muss-Treffer: das Schreiben wurde abgefangen');
  abgelehnt(r, 'job-paket-rueckgelesen');
  assert.equal(r.output, '', 'Hash vor dem Zuruecklesen ausgegeben');
});

test('Scanfunktion direkt: Geheimnis in Paketmetadaten, nur in den Paketbytes, Muster, leere Liste, ungepruefte Eingabe', () => {
  const g = grund('rechner');
  const work = prepareWorkspace(TRUSTED, g.order, g.orderSha, join(newDir('scan-'), 'arbeit'), { gitEnv: { ...ENV } }).arbeitsordner;

  for (const [pfad, inhalt] of Object.entries(AENDERUNG.rechner)) {
    writeFileSync(join(work, ...pfad.split('/')), inhalt);
  }

  const pkg = createPackageV2(TRUSTED, g.order, g.orderSha, work);
  const bytes = Buffer.from(pkg.text, 'utf8');
  const parsed = parsePackageV2(g.order, g.orderSha, bytes, pkg.sha256);

  // Muss-Treffer: das saubere Paket besteht, geprueft werden zwei Dateien und das ganze Paket.
  assert.equal(scanPackageSecrets(parsed, bytes, [VERGLEICH_A, VERGLEICH_L]), 3);

  // Das Paket hat kein Freitextfeld. Konstruierte Paketbytes mit einem Wert in zusaetzlichen Metadaten.
  const meta = wert => Buffer.from(pkg.text.replace('"schema": ', `"metadaten": ${JSON.stringify(wert)},\n  "schema": `), 'utf8');
  const fehler = code => error => error.code === code && !String(error.message).includes(VERGLEICH_A) && !String(error.message).includes(VERGLEICH_L);

  for (const wert of [VERGLEICH_A, VERGLEICH_L, b64(VERGLEICH_A, 1), Buffer.from(VERGLEICH_L).toString('hex').toUpperCase(), [...VERGLEICH_A].reverse().join('')]) {
    assert.throws(() => scanPackageSecrets(parsed, meta(wert), [VERGLEICH_A, VERGLEICH_L]), fehler('job-geheimnis-wert'));
  }

  assert.throws(() => scanPackageSecrets(parsed, meta(`ghs_${'B'.repeat(36)}`), [VERGLEICH_A, VERGLEICH_L]), fehler('job-geheimnis-muster'));

  // Jeder der beiden Werte allein wird gefunden; der Vergleich laesst keinen aus.
  assert.throws(() => scanPackageSecrets(parsed, meta(VERGLEICH_L), [VERGLEICH_A, VERGLEICH_L]), fehler('job-geheimnis-wert'));
  assert.equal(scanPackageSecrets(parsed, meta(VERGLEICH_L), [VERGLEICH_A]), 3, 'Muss-Treffer: ohne den zweiten Wert faellt der Fund weg');

  // Leere oder ungueltige Liste ist nie eine bestandene Pruefung.
  assert.throws(() => scanPackageSecrets(parsed, bytes, []), error => error.code === 'geheimnis-werte-leer');
  assert.throws(() => scanPackageSecrets(parsed, bytes, ['kurz']), error => error.code === 'geheimnis-wert-kurz');

  // Ein frei gebautes Objekt statt des geprueften Pakets.
  assert.throws(() => scanPackageSecrets({ dateien: parsed.dateien.map(d => ({ ...d })) }, bytes, [VERGLEICH_A]), error => error.code === 'paket-ungeprueft');
});

// ===========================================================================
// Vertraege und Ausgabe
// ===========================================================================

test('Vertrag: Job 1a und Job 1b lesen nur die festen Namen; 1a kennt keinen Vergleichswert, 1b keinen Token', () => {
  const temp = newDir('v-');
  mkdirSync(join(temp, '_runner_file_commands'));
  const g = grund('rechner');
  const v1 = readClaudeVorContract({ ...umgebung(temp, g, 'vor'), UNBEKANNT: 'egal' });
  assert.deepEqual(Object.keys(v1), ['repository', 'runId', 'baseSha', 'workspace', 'runnerTemp', 'outputPath', 'path', 'system', 'orderSha256', 'snapshotSha256', 'token']);
  assert.ok(Object.isFrozen(v1));
  const v2 = readClaudeNachContract(umgebung(temp, g, 'nach'));
  assert.deepEqual(Object.keys(v2), ['repository', 'runId', 'baseSha', 'workspace', 'runnerTemp', 'outputPath', 'path', 'system', 'orderSha256', 'snapshotSha256', 'compareValues']);
  assert.ok(Object.isFrozen(v2) && Object.isFrozen(v2.compareValues));
  assert.deepEqual([...v2.compareValues], [VERGLEICH_A, VERGLEICH_L]);
  assert.ok(!Object.keys(v2).some(key => /token/i.test(key)));
  assert.deepEqual([...SECRET_NAMES.claudeVor], ['A6_LESE_TOKEN']);
  assert.deepEqual([...SECRET_NAMES.claudeNach], ['A6_VERGLEICH_ANTHROPIC', 'A6_VERGLEICH_LESE_TOKEN']);
});

test('Ausgabe Job 1b: genau paket_sha256, nur 64 kleine Hex-Zeichen, ein Schreibvorgang', () => {
  const temp = newDir('aus-');
  const datei = join(temp, 'out');
  writeFileSync(datei, '');
  const a = 'a'.repeat(64);

  for (const falsch of [`${a}\nboese=1`, a.toUpperCase(), a.slice(1), 42, undefined, `${a}\n`]) {
    assert.throws(() => writePackageOutput({ outputPath: datei }, falsch), error => error.code === 'job-ausgabe-format');
  }

  assert.equal(readFileSync(datei, 'utf8'), '');
  writePackageOutput({ outputPath: datei }, a, 'zusatz', { weiter: 'x' });
  assert.equal(readFileSync(datei, 'utf8'), `paket_sha256=${a}\n`);
  assert.equal(writePackageOutput.length, 2);
  assert.throws(() => writePackageOutput({ outputPath: join(temp, 'fehlt') }, a), error => error.code === 'job-ausgabe-datei');
});

test('Wache: in dieser Testdatei wurde kein Socket verbunden', () => {
  assert.equal(socketVersuche, 0);
  assert.throws(() => new net.Socket().connect(1, '127.0.0.1'), /Socket im Claude-Jobtest verboten/);
  assert.equal(socketVersuche, 1);
  socketVersuche = 0;
});
