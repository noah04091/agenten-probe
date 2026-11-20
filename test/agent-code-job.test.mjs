// A6.4-2c-1: Offline-Tests der Job-Einstiege (Job 0 Auftrag, Job 2 Abnahme) und der gemeinsamen
// Hilfsfunktionen.
//
// Alles offline und synthetisch: kein Claude-Lauf, kein echtes Token, kein GitHub-Aufruf, kein Socket.
// Job 0 laeuft im Prozess; https.request wird wie in den Transporttests durch eine Attrappe ersetzt,
// die die Live-Antworten aus dem Speicher liefert. Damit bleibt createReadTransport der einzige Weg
// zum Netz. Job 2 laeuft im Prozess und als eigener Prozess (CLI) gegen ein synthetisches Repository
// mit Policy, beiden Profilen (js-text synthetisch aktiviert) und v2-Abnahmen. Jeder Versuch, einen
// Socket zu verbinden, wirft; ein eigener Test belegt am Ende, dass es keinen gab.
//
// Zeitpunkte: Freigabe und Lauf liegen wenige Minuten vor dem Start dieser Datei. Die Einstiege
// nehmen keinen Zeitwert entgegen; die Datei muss deshalb binnen rund 55 Minuten durchlaufen.
//
// Was diese Tests NICHT zeigen: echte GitHub-Actions-Ausfuehrung, echten Artefakttransport,
// Job-Isolation, Prozessbaum-Isolation, Bereinigung der Umgebung vor dem Start von Node, einen
// vertrauenswuerdigen Git-Pfad, Skript-Hashbindung, Job 1 und Job 3, K1 bis K4, Aktivierung.

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
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_EVENTS, MAX_LABELS, orderSha256, resolveOrder } from '../scripts/agent-code-auftrag.mjs';
import { WORKFLOW_PATH } from '../scripts/agent-code-auftrag-live.mjs';
import { ACCEPTANCE_FORMAT_LINE, acceptOrderPackage, requireAccepted } from '../scripts/agent-code-auftrag-abnahme.mjs';
import { createPackageV2, prepareWorkspace } from '../scripts/agent-code-auftrag-paket.mjs';
import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_DEPTH,
  MAX_SNAPSHOT_EVENTS,
  MAX_SNAPSHOT_LABELS,
  OUTPUT_KEYS,
  SECRET_NAMES,
  SNAPSHOT_SCHEMA,
  WORKFLOW_REF,
  buildSnapshot,
  errorCode,
  errorLine,
  parseSnapshot,
  readAbnahmeContract,
  readAuftragContract,
  writeHashOutputs,
} from '../scripts/agent-code-job-gemeinsam.mjs';
import { main as mainAuftrag } from '../scripts/agent-code-job-auftrag.mjs';
import { main as mainAbnahme } from '../scripts/agent-code-job-abnahme.mjs';
import { loadPolicy } from '../scripts/agent-profile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(ROOT, 'scripts');
const JOB0_PATH = join(SCRIPTS, 'agent-code-job-auftrag.mjs');
const JOB2_PATH = join(SCRIPTS, 'agent-code-job-abnahme.mjs');
const JOB1A_PATH = join(SCRIPTS, 'agent-code-job-claude-vor.mjs');
const JOB1B_PATH = join(SCRIPTS, 'agent-code-job-claude-nach.mjs');
const JOB3_PATH = join(SCRIPTS, 'agent-code-job-veroeffentlichen.mjs');
const EINSTIEGE = Object.freeze([JOB0_PATH, JOB1A_PATH, JOB1B_PATH, JOB2_PATH, JOB3_PATH]);
const ASYNC_EINSTIEGE = Object.freeze([JOB0_PATH, JOB1A_PATH, JOB3_PATH]);
const GEMEINSAM_PATH = join(SCRIPTS, 'agent-code-job-gemeinsam.mjs');
const EXEC = cp.execFileSync;
const SPAWN = cp.spawnSync;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;

const REPO_NAME = 'noah04091/agenten-probe';
const P = `/repos/${REPO_NAME}/`;
// Erfundenes Token nur fuer diese Tests, ohne Wirkung.
const TOKEN = 'ghs_NurTestOhneWirkung_job0_0123456789abcdef';
const OWNER = Object.freeze({ login: 'noah04091', id: 1, type: 'User', site_admin: false });
const FREMD = Object.freeze({ login: 'fremdes-konto', id: 2, type: 'User', site_admin: false });
const ISSUE_MARKER = 'ISSUE-MARKER-unvertrauenswuerdig';
const AGENT_MARKER = 'AGENTENAUSGABE-MARKER';
const PR_MARKER = 'PR-MARKER-zweig';
const FEHLER_ZEILE_RE = /^A6-FEHLER [a-z][a-z0-9-]{0,62}[a-z0-9]\n$/;

// ---------------------------------------------------------------------------
// Zeitpunkte relativ zum Start dieser Datei (Sekundenformat wie GitHub)
// ---------------------------------------------------------------------------

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
  throw new Error('Socket im Jobtest verboten');
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

// routes: Map von Pfad zu JSON-Wert. Unbekannte Pfade ergeben 404. Liefert das Protokoll.
function attrappe(routes) {
  const aufrufe = [];

  https.request = (options, onResponse) => {
    aufrufe.push({ method: options.method, path: options.path, host: options.hostname, auth: options.headers?.Authorization === `Bearer ${TOKEN}` || options.headers?.authorization === `Bearer ${TOKEN}` });
    return new FakeRequest(options, onResponse, opts => (routes.has(opts.path)
      ? { status: 200, body: JSON.stringify(routes.get(opts.path)) }
      : { status: 404, body: '{"message":"Not Found"}' }));
  };

  return aufrufe;
}

// Zaehlt Netzversuche, ohne sie auszufuehren.
function netzZaehler() {
  const zaehler = { https: 0 };
  https.request = () => {
    zaehler.https += 1;
    throw new Error('Netz im Abnahme-Einstieg verboten');
  };
  return zaehler;
}

afterEach(() => {
  https.request = ORIGINAL_REQUEST;
});

// ---------------------------------------------------------------------------
// Synthetische Abnahmen, Aenderungen und Repository
// ---------------------------------------------------------------------------

const RECHNE_ALT = '// Synthetischer Rechner fuer A6.4-2c-1.\nfunction addiere(a, b) {\n  return a + b;\n}\n\nmodule.exports = { addiere };\n';
const RECHNE_NEU = '// Synthetischer Rechner fuer A6.4-2c-1.\nfunction addiere(a, b) {\n  return a + b;\n}\n\nfunction quadrat(a) {\n  return a * a;\n}\n\nmodule.exports = { addiere, quadrat };\n';
const RECHNE_TEST_ALT = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { addiere } = require('../src/rechne.js');\n\ntest('addiere', () => assert.equal(addiere(2, 3), 5));\n";
const RECHNE_TEST_NEU = `${RECHNE_TEST_ALT}\ntest('quadrat', () => assert.equal(require('../src/rechne.js').quadrat(3), 9));\n`;
const TEXT_ALT = "// Synthetisches Textmodul fuer A6.4-2c-1.\nfunction zeichenzahl(text) {\n  if (typeof text !== 'string') {\n    throw new TypeError('Zeichenkette erwartet');\n  }\n\n  return [...text].length;\n}\n\nmodule.exports = { zeichenzahl };\n";
const TEXT_NEU = TEXT_ALT.replace('module.exports = { zeichenzahl };', "function istLeer(text) {\n  if (typeof text !== 'string') {\n    throw new TypeError('Zeichenkette erwartet');\n  }\n\n  return text === '';\n}\n\nmodule.exports = { zeichenzahl, istLeer };");
const TEXT_TEST_ALT = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { zeichenzahl } = require('../src/text.js');\n\ntest('zeichenzahl', () => assert.equal(zeichenzahl('ab'), 2));\n";
const TEXT_TEST_NEU = `${TEXT_TEST_ALT}\ntest('istLeer', () => assert.equal(require('../src/text.js').istLeer(''), true));\n`;

const AENDERUNG = Object.freeze({
  rechner: { 'src/rechne.js': RECHNE_NEU, 'test/rechne.test.js': RECHNE_TEST_NEU },
  text: { 'src/text.js': TEXT_NEU, 'test/text.test.js': TEXT_TEST_NEU },
});

// v2-Treiber wie in den Abnahmetests (A6.4-2a): Agentencode nur im Kindprozess, Bewertung im Treiber.
const V2_RECHNER = ACCEPTANCE_FORMAT_LINE + String.raw`// Synthetische v2-Abnahme fuer js-rechner (A6.4-2c-1).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ziel = fileURLToPath(new URL('../src/rechne.js', import.meta.url));
const eingaben = [0, 3, -4, 0.5, -1.5, 12];
const sonde = [
  'const m = require(' + JSON.stringify(ziel) + ');',
  'const e = JSON.parse(require("node:fs").readFileSync(0, "utf8"));',
  'process.stdout.write(JSON.stringify({ typ: [typeof m.addiere, typeof m.quadrat], werte: e.map(x => m.quadrat(x)), summe: m.addiere(2, 3) }));',
].join('\n');
const out = spawnSync(process.execPath, ['-e', sonde], { input: JSON.stringify(eingaben), env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });

if (out.error !== undefined || out.status !== 0 || out.signal !== null) {
  throw new Error('Sonde fehlgeschlagen');
}

const antwort = JSON.parse(out.stdout);
assert.deepEqual(antwort.typ, ['function', 'function']);
assert.deepEqual(antwort.werte, eingaben.map(x => x * x));
assert.equal(antwort.summe, 5);
process.stdout.write('A6-ABNAHME-BESTANDEN\n');
`;

const V2_TEXT = ACCEPTANCE_FORMAT_LINE + String.raw`// Synthetische v2-Abnahme fuer js-text (A6.4-2c-1).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ziel = fileURLToPath(new URL('../src/text.js', import.meta.url));
const texte = ['', ' ', 'Hallo', '0'];
const sonde = [
  'const m = require(' + JSON.stringify(ziel) + ');',
  'const e = JSON.parse(require("node:fs").readFileSync(0, "utf8"));',
  'process.stdout.write(JSON.stringify({ typ: [typeof m.zeichenzahl, typeof m.istLeer], zahl: e.map(t => m.zeichenzahl(t)), leer: e.map(t => m.istLeer(t)) }));',
].join('\n');
const out = spawnSync(process.execPath, ['-e', sonde], { input: JSON.stringify(texte), env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });

if (out.error !== undefined || out.status !== 0 || out.signal !== null) {
  throw new Error('Sonde fehlgeschlagen');
}

const antwort = JSON.parse(out.stdout);
assert.deepEqual(antwort.typ, ['function', 'function']);
assert.deepEqual(antwort.zahl, texte.map(t => [...t].length));
assert.deepEqual(antwort.leer, texte.map(t => t === ''));
process.stdout.write('A6-ABNAHME-BESTANDEN\n');
`;

// Scheiternde Abnahme, die Agentenausgabe mit Steuerzeilen fuer GitHub Actions auf beide Kanaele schreibt.
const V2_SCHEITERT = `${ACCEPTANCE_FORMAT_LINE}// Synthetisch: Abnahme scheitert und gibt Agentenausgabe aus.
process.stdout.write('${AGENT_MARKER}\\n::set-output name=auftrag_sha256::${'f'.repeat(64)}\\n');
process.stderr.write('${AGENT_MARKER} stderr\\n::error::eingeschleust\\n');
process.exitCode = 3;
`;

const AUFGABEN = Object.freeze({
  rechner: { issue: 6501, profil: 'js-rechner', abnahme: V2_RECHNER, aenderung: 'rechner' },
  text: { issue: 6502, profil: 'js-text', abnahme: V2_TEXT, aenderung: 'text' },
  scheitert: { issue: 6503, profil: 'js-rechner', abnahme: V2_SCHEITERT, aenderung: 'rechner' },
  ohneKennung: { issue: 6504, profil: 'js-rechner', abnahme: V2_RECHNER.slice(ACCEPTANCE_FORMAT_LINE.length), aenderung: 'rechner' },
});

const abnahmePfad = issue => `agent-acceptance/issue-${issue}.mjs`;
const runIdOf = issue => String(7_700_000_000 + issue);

const PROFIL_RECHNER = readFileSync(join(ROOT, 'agent-profiles', 'js-rechner.json'));
// Historischer inaktiver Stand von js-text als feste Vorlage (Blob 6d565be9 von main vor der Aktivierung),
// an SHA-256 gebunden. Den echten Stand auf main prueft agent-profile.test.mjs.
const PROFIL_TEXT = (() => {
  const bytes = readFileSync(join(ROOT, 'test', 'fixtures', 'a6-js-text-vorlage', 'js-text.json.vorlage'));
  if (createHash('sha256').update(bytes).digest('hex') !== '71d1656f410fcae598f3c6390e8531fc45a85b2adf1f0be4726e47bbd8f1a108') throw new Error('Vorlage js-text.json weicht vom festen Stand ab');
  return bytes;
})();
const AKTIV_FALSE = Buffer.from('"aktiv": false', 'utf8');

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
    files[abnahmePfad(aufgabe.issue)] = Buffer.from(aufgabe.abnahme, 'utf8');
  }

  return files;
}

const WINDOWS_KEYS = ['SystemRoot', 'PATHEXT', 'ComSpec', 'windir'];
const systemEnv = () => Object.fromEntries(WINDOWS_KEYS.map(key => [key, process.env[key]]).filter(([, value]) => typeof value === 'string'));

function gitEnvFor(home) {
  return {
    ...systemEnv(),
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'leer.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

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
    GIT_AUTHOR_DATE: '2026-11-13T08:00:00Z', GIT_COMMITTER_DATE: '2026-11-13T08:00:00Z',
  });
}

// Datei-Symlinks brauchen unter Windows besondere Rechte; ohne sie wird der Dateifall uebersprungen.
const symlinksErlaubt = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'agent-code-job-symlink-'));

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
  BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-code-job-test-'));
  const home = join(BASE_DIR, 'home');
  mkdirSync(join(home, 'xdg'), { recursive: true });
  writeFileSync(join(home, 'leer.gitconfig'), '');
  ENV = gitEnvFor(home);
  REPO = join(BASE_DIR, 'repo');
  mkdirSync(REPO);
  git(REPO, ['init', '-q']);
  PARENT = commitFiles(REPO, { 'README.md': Buffer.from('Elterncommit\n') }, [], 'Synthetischer Elterncommit');
  BASIS = commitFiles(REPO, baseFiles(), [PARENT], 'Synthetischer Ausgangscommit: js-text synthetisch aktiv');
  git(REPO, ['update-ref', 'refs/heads/main', BASIS]);
  git(REPO, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  TRUSTED = join(BASE_DIR, 'vertraut');
  EXEC('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', REPO, TRUSTED], { cwd: BASE_DIR, env: ENV, stdio: 'ignore' });
  git(TRUSTED, ['checkout', '-q', '--detach', BASIS]);
  git(TRUSTED, ['remote', 'remove', 'origin']);
});

after(() => {
  net.Socket.prototype.connect = ORIGINAL_CONNECT;
  https.request = ORIGINAL_REQUEST;
  rmSync(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Live-Daten, Nutzlast und Umgebung je Fall
// ---------------------------------------------------------------------------

const label = name => ({ id: 1000 + name.length, node_id: 'LA_x', name, color: 'ededed', default: false });

// Vollstaendiger Verlauf mit allem, was der Schnappschuss tragen muss: Umbenennung durch noah04091,
// eine fruehere, zurueckgenommene Freigabe (nummer 2), App-Ereignisse und ein Eintrag ohne App-Feld.
function standardEvents(a, titel) {
  const b = a.issue * 100;
  return [
    { id: b + 1, node_id: 'IE_1', event: 'assigned', created_at: iso(T0 - 3_000_000), actor: { ...OWNER }, commit_id: null },
    { id: b + 2, event: 'renamed', created_at: iso(T0 - 2_400_000), actor: { ...OWNER }, rename: { from: 'Alter Titel', to: titel }, performed_via_github_app: null },
    { id: b + 3, event: 'labeled', created_at: iso(T0 - 2_000_000), actor: { login: 'fremde-app[bot]', id: 3, type: 'Bot' }, label: label('doku'), performed_via_github_app: { id: 99, slug: 'fremde-app', name: 'Fremde App', owner: { ...FREMD } } },
    { id: b + 4, event: 'unlabeled', created_at: iso(T0 - 1_900_000), actor: { login: 'fremde-app[bot]', id: 3, type: 'Bot' }, label: label('doku'), performed_via_github_app: { id: 99, slug: 'fremde-app' } },
    { id: b + 5, event: 'labeled', created_at: iso(T0 - 1_800_000), actor: { ...OWNER }, label: label('bot-auftrag'), performed_via_github_app: null },
    { id: b + 6, event: 'unlabeled', created_at: iso(T0 - 1_700_000), actor: { ...OWNER }, label: label('bot-auftrag'), performed_via_github_app: null },
    { id: b + 7, event: 'labeled', created_at: iso(T0 - 60_000), actor: { ...OWNER }, label: label(`agent:${a.profil}`), performed_via_github_app: null },
    { id: b + 8, event: 'labeled', created_at: APPROVAL, actor: { ...OWNER }, label: label('bot-auftrag'), performed_via_github_app: null },
  ];
}

// mod: optionale Funktionen, die je einen Teil der Daten veraendern.
function daten(name, mod = {}) {
  const a = AUFGABEN[name];
  const runId = mod.runId ?? runIdOf(a.issue);
  const titel = `Synthetisch A6.4-2c-1: Aufgabe ${a.issue} ${ISSUE_MARKER}`;
  const text = `Kuenstlicher Auftrag fuer die Jobtests (${name}). Bitte die vorgesehene Funktion ergaenzen.\r\nZweite Zeile ${ISSUE_MARKER}.`;
  const user = { ...OWNER };
  let issue = {
    url: `https://api.github.com/repos/${REPO_NAME}/issues/${a.issue}`, id: 5_000_000 + a.issue, node_id: 'I_x', number: a.issue, title: titel, user,
    labels: [label('bot-auftrag'), label(`agent:${a.profil}`)], state: 'open', locked: false, assignee: { ...OWNER }, comments: 0,
    created_at: iso(T0 - 3_600_000), updated_at: APPROVAL, closed_at: null, author_association: 'OWNER', body: text,
    reactions: { total_count: 0 }, performed_via_github_app: null,
  };
  let payload = {
    action: 'labeled',
    issue: structuredClone(issue),
    label: label('bot-auftrag'),
    repository: { id: 42, name: 'agenten-probe', full_name: REPO_NAME, owner: { ...OWNER }, private: false },
    sender: { ...OWNER },
  };
  let run = {
    id: Number(runId), name: 'agent-auftrag', event: 'issues', path: WORKFLOW_PATH, head_branch: 'main', head_sha: BASIS, run_attempt: 1,
    created_at: RUN_CREATED, status: 'in_progress', repository: { full_name: REPO_NAME }, head_repository: { full_name: REPO_NAME },
    actor: { ...OWNER }, triggering_actor: { ...OWNER },
  };
  let events = standardEvents(a, titel);
  let pulls = [{ number: 60, head: { ref: 'wp/26-a6-4-2b-transport' } }, { number: 61, head: { ref: 'main-fremd' } }];
  let refs = [];
  let main = { ref: 'refs/heads/main', object: { type: 'commit', sha: BASIS } };

  issue = mod.issue ? mod.issue(issue) : issue;
  payload = mod.payload ? mod.payload(payload) : payload;
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
  return { aufgabe: a, runId, payload, routes, issue, events };
}

function umgebung0(temp, runId) {
  return {
    ...systemEnv(),
    GITHUB_REPOSITORY: REPO_NAME,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_EVENT_PATH: join(temp, '_github_workflow', 'event.json'),
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: BASIS,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_WORKSPACE: TRUSTED,
    GITHUB_OUTPUT: join(temp, '_runner_file_commands', 'set_output_test'),
    RUNNER_TEMP: temp,
    PATH: process.env.PATH,
    A6_LESE_TOKEN: TOKEN,
  };
}

function umgebung2(temp, werte) {
  return {
    ...systemEnv(),
    GITHUB_REPOSITORY: REPO_NAME,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_RUN_ID: werte.runId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: BASIS,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_WORKSPACE: TRUSTED,
    RUNNER_TEMP: temp,
    PATH: process.env.PATH,
    A6_AUFTRAG_SHA256: werte.orderSha,
    A6_SCHNAPPSCHUSS_SHA256: werte.snapshotSha,
    A6_PAKET_SHA256: werte.packageSha,
  };
}

const ohneUndefined = env => Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));

// Faengt stderr dieses Prozesses waehrend fn. stdout bleibt unberuehrt, denn ueber stdout meldet der
// Kindprozess von node --test seine Ergebnisse. Dass die Einstiege nie auf stdout schreiben, belegen
// die Quelltextwache und die CLI-Laeufe als eigener Prozess.
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

// Fuehrt Job 0 im Prozess aus. envMod ueberschreibt einzelne Variablen (undefined entfernt sie).
async function job0(name, mod = {}, envMod = {}, { vorher } = {}) {
  const f = daten(name, mod);
  const temp = newDir('t0-');
  mkdirSync(join(temp, '_github_workflow'));
  mkdirSync(join(temp, '_runner_file_commands'));
  const env = ohneUndefined({ ...umgebung0(temp, f.runId), ...envMod });
  writeFileSync(join(temp, '_github_workflow', 'event.json'), JSON.stringify(f.payload));
  writeFileSync(join(temp, '_runner_file_commands', 'set_output_test'), '');
  vorher?.(temp, env);
  const aufrufe = attrappe(f.routes);
  const r = await fange(() => mainAuftrag(env));
  const snapshotFile = join(temp, 'a6-auftrag', 'schnappschuss.json');
  return {
    ...r, f, temp, env, aufrufe,
    output: readFileSync(join(temp, '_runner_file_commands', 'set_output_test'), 'utf8'),
    snapshot: existsSync(snapshotFile) ? readFileSync(snapshotFile) : null,
  };
}

function abgelehnt(r, code) {
  assert.equal(r.code, 1, `keine Ablehnung, erwartet ${code}`);
  assert.equal(r.stderr, `A6-FEHLER ${code}\n`);
  assert.equal(r.stdout, '');
  assert.ok(FEHLER_ZEILE_RE.test(r.stderr));

  for (const marker of [ISSUE_MARKER, AGENT_MARKER, PR_MARKER, TOKEN, TOKEN.slice(4)]) {
    assert.ok(!r.stderr.includes(marker) && !r.stdout.includes(marker), `${marker} im Protokoll`);
  }
}

function job0Abgelehnt(r, code) {
  abgelehnt(r, code);
  assert.equal(r.output, '', 'Ausgabe trotz Ablehnung geschrieben');
  assert.equal(r.snapshot, null, 'Schnappschuss trotz Ablehnung geschrieben');
}

const OUTPUT_RE = /^auftrag_sha256=([0-9a-f]{64})\nschnappschuss_sha256=([0-9a-f]{64})\n$/;

function job0Erfolg(r) {
  assert.equal(r.stderr, '', r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.code, 0);
  const match = OUTPUT_RE.exec(r.output);
  assert.ok(match, `Ausgabe unerwartet: ${JSON.stringify(r.output)}`);
  return { orderSha: match[1], snapshotSha: match[2] };
}

// Auftrag aus Schnappschussbytes, wie ihn ein Pruefer unabhaengig nachrechnet.
const orderFromSnapshot = bytes => resolveOrder({ root: TRUSTED, baseSha: BASIS, gitEnv: { ...ENV }, ...parseSnapshot(bytes), now: new Date() });

const PAKETE = new Map();

function paketFuer(order, hash, aenderung) {
  const key = `${hash}|${aenderung}`;

  if (!PAKETE.has(key)) {
    const work = prepareWorkspace(TRUSTED, order, hash, join(newDir('w-'), 'arbeit'), { gitEnv: { ...ENV } }).arbeitsordner;

    for (const [pfad, inhalt] of Object.entries(AENDERUNG[aenderung])) {
      writeFileSync(join(work, ...pfad.split('/')), inhalt);
    }

    const pkg = createPackageV2(TRUSTED, order, hash, work);
    PAKETE.set(key, { text: pkg.text, sha256: pkg.sha256 });
  }

  return PAKETE.get(key);
}

// Positiver Job-0-Lauf je Aufgabe, einmal gerechnet und gemerkt, samt passendem Paket v2.
const KETTEN = new Map();

async function kette(name) {
  if (!KETTEN.has(name)) {
    const r = await job0(name);
    const { orderSha, snapshotSha } = job0Erfolg(r);
    const order = orderFromSnapshot(r.snapshot);
    assert.equal(orderSha256(order), orderSha);
    const pkg = paketFuer(order, orderSha, AUFGABEN[name].aenderung);
    KETTEN.set(name, Object.freeze({
      runId: r.f.runId, orderSha, snapshotSha, snapshotText: r.snapshot.toString('utf8'), order, packageText: pkg.text, packageSha: pkg.sha256, r,
    }));
  }

  const k = KETTEN.get(name);
  return { ...k, snapshotBytes: Buffer.from(k.snapshotText, 'utf8'), packageBytes: Buffer.from(k.packageText, 'utf8') };
}

// Legt RUNNER_TEMP fuer Job 2 an: Schnappschuss und Paket an den festen Pfaden (null laesst weg).
function temp2(snapshotBytes, packageBytes) {
  const temp = newDir('t2-');

  if (snapshotBytes !== null) {
    mkdirSync(join(temp, 'a6-auftrag'));
    writeFileSync(join(temp, 'a6-auftrag', 'schnappschuss.json'), snapshotBytes);
  }

  if (packageBytes !== null) {
    mkdirSync(join(temp, 'a6-paket'));
    writeFileSync(join(temp, 'a6-paket', 'paket-v2.json'), packageBytes);
  }

  return temp;
}

// Fuehrt Job 2 im Prozess aus und protokolliert jeden Prozessstart und jeden Netzversuch.
async function job2(werte, envMod = {}, { snapshotBytes = werte.snapshotBytes, packageBytes = werte.packageBytes } = {}) {
  const temp = temp2(snapshotBytes, packageBytes);
  const env = ohneUndefined({ ...umgebung2(temp, werte), ...envMod });
  const netz = netzZaehler();
  const socketsVorher = socketVersuche;
  const starts = [];
  cp.execFileSync = function execFileSync(file, args, options) {
    starts.push(file);
    return EXEC(file, args, options);
  };
  cp.spawnSync = function spawnSync(file, args, options) {
    starts.push(file);
    return SPAWN(file, args, options);
  };
  syncBuiltinESMExports();
  let r;

  try {
    r = await fange(() => mainAbnahme(env));
  } finally {
    cp.execFileSync = EXEC;
    cp.spawnSync = SPAWN;
    syncBuiltinESMExports();
  }

  assert.equal(netz.https, 0, 'Netzversuch im Abnahme-Einstieg');
  assert.equal(socketVersuche, socketsVorher, 'Socket im Abnahme-Einstieg');
  // Nur git und der absolute Node-Pfad fuer den Abnahmetreiber, nie Claude oder eine Shell.
  assert.ok(starts.every(file => file === 'git' || file === process.execPath), `unerwarteter Prozessstart: ${starts.join(', ')}`);
  return { ...r, temp, env, starts };
}

function job2Erfolg(r) {
  assert.equal(r.stderr, '', r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.code, 0);
}

// Kanonische Bytes eines veraenderten Schnappschusses samt Hash.
function umbauen(bytes, fn) {
  const value = JSON.parse(bytes.toString('utf8'));
  fn(value);
  const neu = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return { bytes: neu, sha: sha256(neu) };
}

function schnappschussAbgelehnt(bytes, code) {
  assert.throws(() => parseSnapshot(bytes), error => {
    assert.equal(error.name, 'JobError');
    assert.equal(error.code, code);
    return true;
  });
}

// ===========================================================================
// Positive Laeufe
// ===========================================================================

for (const [name, profil] of [['rechner', 'js-rechner'], ['text', 'js-text']]) {
  test(`Positiv Job 0 ${profil}: Live-Daten ueber simuliertes HTTP, Rundweg, checkLiveOrder, Schnappschuss, genau zwei Ausgaben`, async () => {
    const k = await kette(name);
    const r = k.r;

    // Nur die sechs Live-GETs, je einmal, an api.github.com, mit dem Lesetoken.
    const a = AUFGABEN[name];
    assert.deepEqual(r.aufrufe.map(c => `${c.method} ${c.path}`), [
      `GET ${P}actions/runs/${k.runId}`,
      `GET ${P}git/ref/heads/main`,
      `GET ${P}issues/${a.issue}`,
      `GET ${P}issues/${a.issue}/events?per_page=100&page=1`,
      `GET ${P}git/matching-refs/heads/wp/${a.issue}-`,
      `GET ${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=1`,
    ]);
    assert.ok(r.aufrufe.every(c => c.host === 'api.github.com' && c.auth));

    // Ausgaben: genau auftrag_sha256 und schnappschuss_sha256, in dieser Reihenfolge.
    assert.deepEqual(OUTPUT_KEYS, ['auftrag_sha256', 'schnappschuss_sha256']);
    assert.equal(r.output, `auftrag_sha256=${k.orderSha}\nschnappschuss_sha256=${k.snapshotSha}\n`);
    assert.equal(sha256(r.snapshot), k.snapshotSha, 'zurueckgelesener Hash');

    // Auftrag aus dem Schnappschuss: gebunden an Ausgangscommit, Lauf, Profil, Freigabe.
    const order = k.order;
    assert.equal(order.base_sha, BASIS);
    assert.equal(order.issue, a.issue);
    assert.equal(order.profil_id, profil);
    assert.equal(order.abnahme_pfad, abnahmePfad(a.issue));
    assert.deepEqual(order.lauf, { run_id: k.runId, run_attempt: 1, erstellt: RUN_CREATED });
    assert.deepEqual(order.startfreigabe, { ereignis_id: a.issue * 100 + 8, zeitpunkt: APPROVAL, akteur: 'noah04091', nummer: 2 });

    // Auftrag aus den Originaldaten (unabhaengig im Test gerechnet) hat denselben Hash.
    const original = resolveOrder({
      root: TRUSTED, baseSha: BASIS, gitEnv: { ...ENV }, repository: REPO_NAME, event: r.f.payload, issue: r.f.issue, events: r.f.events,
      run: { id: k.runId, attempt: 1, createdAt: RUN_CREATED }, now: new Date(),
    });
    assert.equal(orderSha256(original), k.orderSha);

    // Schnappschussdatei unter RUNNER_TEMP, als einzige Datei im eigenen Ordner.
    assert.deepEqual(readdirSync(join(r.temp, 'a6-auftrag')), ['schnappschuss.json']);
    assert.deepEqual(readdirSync(r.temp).sort(), ['_github_workflow', '_runner_file_commands', 'a6-auftrag', 'a6-auftrag-home']);
  });
}

test('Positiv Schnappschuss: genau die Pflichtfelder, keine Rohantworten, App-Herkunft und Rohwerte bleiben erhalten', async () => {
  const k = await kette('rechner');
  const s = JSON.parse(k.snapshotText);
  assert.equal(k.snapshotText, `${JSON.stringify(s, null, 2)}\n`, 'kanonische Form');
  assert.deepEqual(Object.keys(s), ['schema', 'repository', 'issue', 'events', 'run', 'event']);
  assert.equal(s.schema, SNAPSHOT_SCHEMA);
  assert.equal(s.repository, REPO_NAME);
  assert.deepEqual(Object.keys(s.issue), ['number', 'state', 'title', 'body', 'updated_at', 'user', 'labels']);
  assert.deepEqual(s.issue.user, { login: 'noah04091', type: 'User' });
  assert.deepEqual(s.issue.labels, [{ name: 'bot-auftrag' }, { name: 'agent:js-rechner' }]);
  // Rohwerte unveraendert, auch CRLF im Text.
  assert.ok(s.issue.body.includes('\r\n'));
  assert.equal(s.issue.updated_at, APPROVAL);
  assert.deepEqual(s.run, { id: k.runId, attempt: 1, createdAt: RUN_CREATED });
  assert.deepEqual(Object.keys(s.event), ['action', 'label', 'sender', 'repository', 'issue']);
  assert.deepEqual(s.event.sender, { login: 'noah04091', type: 'User' });
  assert.deepEqual(s.event.repository, { full_name: REPO_NAME });
  assert.deepEqual(Object.keys(s.event.issue), ['number', 'title', 'body', 'updated_at']);

  // Alle acht Ereignisse, je genau die sechs Felder.
  assert.equal(s.events.length, 8);
  assert.ok(s.events.every(e => JSON.stringify(Object.keys(e)) === JSON.stringify(['id', 'event', 'created_at', 'actor', 'label', 'performed_via_github_app'])));
  const b = 6501 * 100;
  // Ohne App-Feld im Original: null. App-Ereignisse: bleiben Objekte.
  assert.equal(s.events[0].performed_via_github_app, null);
  assert.equal(s.events[0].label, null);
  assert.deepEqual(s.events[2], { id: b + 3, event: 'labeled', created_at: iso(T0 - 2_000_000), actor: { login: 'fremde-app[bot]', type: 'Bot' }, label: { name: 'doku' }, performed_via_github_app: { id: 99, slug: 'fremde-app' } });
  assert.deepEqual(s.events[3].performed_via_github_app, { id: 99, slug: 'fremde-app' });
  assert.equal(s.events[1].event, 'renamed');

  // Keine Rohfelder der HTTP-Antworten, keine Zugangsdaten.
  for (const fremd of ['node_id', 'url', 'reactions', 'rename', 'color', 'head_sha', 'author_association', 'site_admin', 'locked', 'comments', 'owner', 'name": "Fremde App', 'Authorization']) {
    assert.ok(!k.snapshotText.includes(`"${fremd}"`), `${fremd} im Schnappschuss`);
  }

  assert.ok(k.snapshotText.includes('"label"') && k.snapshotText.includes('"renamed"'), 'Muss-Treffer der Suche');
  assert.ok(!k.snapshotText.includes(TOKEN) && !k.snapshotText.includes(TOKEN.slice(4)), 'Token im Schnappschuss');

  assert.equal(MAX_SNAPSHOT_EVENTS, MAX_EVENTS);
  assert.equal(MAX_SNAPSHOT_LABELS, MAX_LABELS);
  assert.equal(MAX_SNAPSHOT_BYTES, 1024 * 1024);
  assert.equal(MAX_SNAPSHOT_DEPTH, 8);
});

test('Positiv Job 2 js-rechner und js-text: unabhaengige Rekonstruktion, Paket v2, v2-Abnahme, ohne Ausgaben, ohne Netz', async () => {
  for (const name of ['rechner', 'text']) {
    const k = await kette(name);
    const r = await job2(k);
    job2Erfolg(r);
    // Eigener Pruefordner und eigenes HOME unter RUNNER_TEMP, genau ein Abnahmestart.
    assert.deepEqual(readdirSync(r.temp).sort(), ['a6-abnahme', 'a6-abnahme-home', 'a6-auftrag', 'a6-paket']);
    assert.equal(readdirSync(join(r.temp, 'a6-abnahme')).length, 1);
    assert.equal(r.starts.filter(file => file === process.execPath).length, 1, 'genau ein Abnahmestart');
  }
});

test('Positiv Kette: Ausgaben von Job 0 werden unveraendert zum Vertrag von Job 2, beide Einstiege als CLI', async () => {
  const k = await kette('rechner');
  const temp = temp2(k.snapshotBytes, k.packageBytes);
  // Job 2 ohne jede Zugangsdaten als eigener Prozess; eine vorhandene GITHUB_OUTPUT-Datei bleibt unberuehrt.
  const outputFile = join(temp, 'ausgabe-unberuehrt');
  writeFileSync(outputFile, '');
  const env = { ...umgebung2(temp, k), GITHUB_OUTPUT: outputFile };
  const out = SPAWN(process.execPath, [JOB2_PATH], { env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(out.stderr, '', out.stderr);
  assert.equal(out.stdout, '');
  assert.equal(out.status, 0);
  assert.equal(readFileSync(outputFile, 'utf8'), '', 'Job 2 hat eine Ausgabe geschrieben');

  // Job 0 als CLI ohne Lesetoken: feste Ablehnung vor jedem Netzzugriff.
  const t0 = newDir('t0cli-');
  const env0 = { ...umgebung0(t0, k.runId) };
  delete env0.A6_LESE_TOKEN;
  const out0 = SPAWN(process.execPath, [JOB0_PATH], { env: env0, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(out0.status, 1);
  assert.equal(out0.stderr, 'A6-FEHLER job-umgebung-fehlt\n');
  assert.equal(out0.stdout, '');
});

test('Positiv: requireAccepted nimmt nur den echten Nachweis; ein frei gebautes oder kopiertes Objekt faellt durch', async () => {
  const k = await kette('rechner');
  const order = orderFromSnapshot(k.snapshotBytes);
  const nachweis = acceptOrderPackage({
    trustedRoot: TRUSTED, checkParent: newDir('p-'), order, expectedSha256: k.orderSha, packageBytes: k.packageBytes, packageSha256: k.packageSha, gitEnv: { ...ENV },
  });
  assert.equal(requireAccepted(nachweis, order, k.orderSha), nachweis);

  for (const falsch of [{ ...nachweis }, JSON.parse(JSON.stringify(nachweis)), Object.freeze({ ...nachweis, ergebnis: 'bestanden' })]) {
    assert.throws(() => requireAccepted(falsch, order, k.orderSha), error => error.code === 'abnahme-ungeprueft');
  }
});

// A6.4-3a: Bis der Eigentuemer-PR die Policy einrichtet, ist dieser Test bewusst rot; er wird nicht uebersprungen.
test('Positiv: die produktive Policy liegt auf main vor und ist ohne Entwurfsmodus gueltig', () => {
  const pfad = join(ROOT, '.github', 'agent', 'policy.json');
  assert.equal(existsSync(pfad), true);
  const bytes = readFileSync(pfad);
  assert.deepEqual(loadPolicy(bytes), JSON.parse(bytes.toString('utf8')));
  // Muss-Treffer: dieselbe Pruefung findet eine vorhandene Datei.
  assert.equal(existsSync(join(ROOT, 'agent-profiles', 'js-rechner.json')), true);
});

// ===========================================================================
// Job 0: Umgebung, Auftrag und Live-Zustand
// ===========================================================================

test('Job 0 Umgebung: Repository, Ereignis, Lauf-ID, Laufversuch, Ausgangscommit, Workflow, Pfade, Token', async () => {
  const faelle = [
    [{ GITHUB_REPOSITORY: 'noah04091/anderes' }, 'job-repository'],
    [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, 'job-ereignis-art'],
    [{ GITHUB_RUN_ID: '0123' }, 'job-lauf-id'],
    [{ GITHUB_RUN_ID: '99999999999999999' }, 'job-lauf-id'],
    [{ GITHUB_RUN_ATTEMPT: '2' }, 'job-lauf-versuch'],
    [{ GITHUB_RUN_ATTEMPT: '01' }, 'job-lauf-versuch'],
    [{ GITHUB_SHA: 'A'.repeat(40) }, 'job-basis'],
    [{ GITHUB_WORKFLOW_REF: `${REPO_NAME}/.github/workflows/code-pilot-claude-stufe.yml@refs/heads/main` }, 'job-workflow'],
    [{ GITHUB_WORKFLOW_REF: `${WORKFLOW_REF.replace('@refs/heads/main', '@refs/heads/wp/1-x')}` }, 'job-workflow'],
    [{ A6_LESE_TOKEN: undefined }, 'job-umgebung-fehlt'],
    [{ PATH: '' }, 'job-umgebung-fehlt'],
    [{ GITHUB_WORKSPACE: join(BASE_DIR, 'gibt-es-nicht') }, 'job-checkout'],
    [{ RUNNER_TEMP: 'relativ/temp' }, 'job-runner-temp'],
  ];

  for (const [envMod, code] of faelle) {
    const r = await job0('rechner', {}, envMod);
    job0Abgelehnt(r, code);
    assert.equal(r.aufrufe.length, 0, `Netzzugriff trotz ${code}`);
  }

  // Ereignisdatei und GITHUB_OUTPUT ausserhalb von RUNNER_TEMP.
  const aussen = join(newDir('aussen-'), 'event.json');
  writeFileSync(aussen, '{}');
  job0Abgelehnt(await job0('rechner', {}, { GITHUB_EVENT_PATH: aussen }), 'job-ereignis-pfad');
  job0Abgelehnt(await job0('rechner', {}, { GITHUB_OUTPUT: aussen }), 'job-ausgabe-pfad');

  // Checkout steht nicht auf dem Ausgangscommit (GITHUB_SHA ist ein anderer, vorhandener Commit).
  const r = await job0('rechner', {}, { GITHUB_SHA: PARENT });
  job0Abgelehnt(r, 'job-checkout-head');
  assert.equal(r.aufrufe.length, 0);
});

test('Job 0 Stolperdraht: fremde Zugangsdaten und Node-Schalter in der Umgebung', async () => {
  for (const [envMod, code] of [
    [{ NODE_OPTIONS: '--import=./x.mjs' }, 'job-umgebung-node'],
    [{ node_path: '/tmp' }, 'job-umgebung-node'],
    [{ ANTHROPIC_API_KEY: 'x' }, 'job-umgebung-geheimnis'],
    [{ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, 'job-umgebung-geheimnis'],
    [{ GITHUB_TOKEN: 'x' }, 'job-umgebung-geheimnis'],
    [{ HARMLOS: `ghp_${'a'.repeat(30)}` }, 'job-umgebung-geheimnis'],
  ]) {
    const r = await job0('rechner', {}, envMod);
    job0Abgelehnt(r, code);
    assert.equal(r.aufrufe.length, 0);
  }
});

test('Job 0 Live-Zustand: Lauf, Actor, Issue, Workflowpfad, main, Branch, frueherer PR', async () => {
  const faelle = [
    [{ run: r => ({ ...r, id: r.id + 1 }) }, 'live-lauf-id-abweichung'],
    [{ run: r => ({ ...r, path: '.github/workflows/code-pilot-claude-stufe.yml' }) }, 'live-lauf-workflow'],
    [{ run: r => ({ ...r, actor: { ...FREMD } }) }, 'live-lauf-akteur'],
    [{ run: r => ({ ...r, triggering_actor: { ...FREMD } }) }, 'live-lauf-akteur'],
    [{ run: r => ({ ...r, head_sha: PARENT }) }, 'live-lauf-sha'],
    [{ run: r => ({ ...r, run_attempt: 2 }) }, 'auftrag-lauf-versuch'],
    [{ issue: i => ({ ...i, number: i.number + 1 }) }, 'live-issue-abweichung'],
    [{ main: m => ({ ...m, object: { type: 'commit', sha: PARENT } }) }, 'live-main-geaendert'],
    [{ refs: () => [{ ref: 'refs/heads/wp/6501-alt', object: { type: 'commit', sha: BASIS } }] }, 'live-branch-vorhanden'],
  ];

  for (const [mod, code] of faelle) {
    job0Abgelehnt(await job0('rechner', mod), code);
  }

  // Frueherer PR mit unvertrauenswuerdigem Zweignamen samt Steuerzeile: nur der Code erscheint.
  const r = await job0('rechner', { pulls: p => [...p, { number: 77, head: { ref: `wp/6501-${PR_MARKER}\n::set-output name=auftrag_sha256::${'e'.repeat(64)}` } }] });
  job0Abgelehnt(r, 'live-pr-vorhanden');
});

test('Job 0 Auftrag: Freigabe, Issue, Nutzlast, Profil-Label, Repository und Actor des Starts', async () => {
  const b = 6501 * 100;
  const faelle = [
    // Freigabe geaendert: spaetere Freigabe, entzogen, fremd gesetzt.
    [{ events: e => [...e, { id: b + 9, event: 'unlabeled', created_at: APPROVAL, actor: { ...OWNER }, label: label('bot-auftrag'), performed_via_github_app: null }] }, 'auftrag-freigabe-entzogen'],
    [{ events: e => e.map(x => (x.id === b + 8 ? { ...x, actor: { ...FREMD } } : x)) }, 'auftrag-freigabe-fremd'],
    [{ events: e => e.map(x => (x.id === b + 8 ? { ...x, performed_via_github_app: { id: 7, slug: 'app' } } : x)) }, 'auftrag-freigabe-fremd'],
    [{ events: e => e.filter(x => x.id !== b + 8) }, 'auftrag-freigabe-fehlt'],
    // Issue veraendert: spaeter bearbeitet, Titel weicht von der Nutzlast ab, fremder Autor.
    [{ issue: i => ({ ...i, updated_at: iso(T0 + 1000) }) }, 'auftrag-issue-geaendert'],
    [{ issue: i => ({ ...i, title: `${i.title} geaendert` }) }, 'auftrag-issue-abweichung'],
    [{ issue: i => ({ ...i, user: { ...FREMD } }) }, 'auftrag-issue-autor'],
    // Profilfreigabe fehlt oder ist fremd.
    [{ events: e => e.map(x => (x.id === b + 7 ? { ...x, actor: { ...FREMD } } : x)) }, 'auftrag-profil-label-fremd'],
    [{ events: e => e.filter(x => x.id !== b + 7) }, 'auftrag-profil-label-herkunft'],
    [{ issue: i => ({ ...i, labels: [label('bot-auftrag')] }) }, 'auftrag-label-profil-fehlt'],
    // Start-Ereignis: falsches Repository, fremder Actor, anderes Issue.
    [{ payload: p => ({ ...p, repository: { ...p.repository, full_name: 'noah04091/anderes' } }) }, 'auftrag-start-repository'],
    [{ payload: p => ({ ...p, sender: { ...FREMD } }) }, 'auftrag-start-sender'],
    [{ payload: p => ({ ...p, issue: { ...p.issue, updated_at: iso(T0 - 1_800_000) } }) }, 'auftrag-start-zuordnung'],
  ];

  for (const [mod, code] of faelle) {
    job0Abgelehnt(await job0('rechner', mod), code);
  }

  // Anderes Issue in der Nutzlast: Lesen und Pruefen gehoeren dann zu diesem anderen Issue.
  const r = await job0('rechner', { payload: p => ({ ...p, issue: { ...p.issue, number: 6599 } }) });
  job0Abgelehnt(r, 'live-http-status');
  assert.ok(r.aufrufe.some(c => c.path === `${P}issues/6599`));
});

test('Job 0 Integritaet: nach dem Schreiben veraenderte Schnappschussbytes werden erkannt, keine Ausgabe', async () => {
  const ORIGINAL = fs.fsyncSync;
  let getroffen = 0;
  fs.fsyncSync = fd => {
    ORIGINAL(fd);

    // Nur die Schnappschussdatei (das leere Git-HOME bleibt unberuehrt): erstes Byte austauschen.
    if (fs.fstatSync(fd).size > 100) {
      fs.writeSync(fd, Buffer.from('['), 0, 1, 0);
      getroffen += 1;
    }
  };
  syncBuiltinESMExports();
  let r;

  try {
    r = await job0('rechner');
  } finally {
    fs.fsyncSync = ORIGINAL;
    syncBuiltinESMExports();
  }

  assert.equal(getroffen, 1, 'Eingriff nicht ausgeliefert');
  abgelehnt(r, 'job-schnappschuss-rueckgelesen');
  assert.equal(r.output, '', 'Ausgabe vor vollstaendiger Pruefung');
});

test('Job 0 Integritaet: vorhandener Schnappschussordner oder Symlink wird nie verwendet', async () => {
  const r = await job0('rechner', {}, {}, {
    vorher: temp => {
      mkdirSync(join(temp, 'a6-auftrag'));
      writeFileSync(join(temp, 'a6-auftrag', 'alt.json'), 'alt');
    },
  });
  abgelehnt(r, 'job-ordner');
  assert.equal(r.output, '');

  // Schnappschussordner als Verzeichnisverknuepfung auf einen fremden Ordner.
  const fremd = newDir('fremd-');
  const s = await job0('rechner', {}, {}, { vorher: temp => symlinkSync(fremd, join(temp, 'a6-auftrag'), 'junction') });
  abgelehnt(s, 'job-ordner');
  assert.equal(s.output, '');
  assert.deepEqual(readdirSync(fremd), [], 'durch die Verknuepfung geschrieben');
});

// ===========================================================================
// Schnappschuss: Format und Angriffe
// ===========================================================================

test('Schnappschuss Format: Schema, Pflichtfelder, Zusatzfelder, Reihenfolge, __proto__, Typen', async () => {
  const k = await kette('rechner');
  const bytes = k.snapshotBytes;
  const fehler = 'job-schnappschuss-schema';
  const faelle = [
    s => { s.schema = 'agent-auftrag-schnappschuss-v2'; },
    s => { s.repository = 'noah04091/anderes'; },
    s => { delete s.run; },
    s => { s.extra = 1; },
    s => { delete s.issue.user; },
    s => { delete s.event.sender; },
    s => { delete s.event.repository; },
    s => { s.issue.user.id = 1; },
    s => { s.events[0].rename = { from: 'a', to: 'b' }; },
    s => { delete s.events[2].performed_via_github_app; },
    s => { s.events[2].performed_via_github_app.name = 'x'; },
    s => { s.issue.number = '6501'; },
    s => { s.run.attempt = 2; },
    s => { s.run.id = 1; },
    s => { s.issue.labels[0].name = 7; },
    s => { s.issue.body = 5; },
    s => { s.events[0].id = 0; },
    s => { s.events[0].actor = 'noah04091'; },
    s => { s.issue.title = 'mit\0NUL'; },
  ];

  for (const fn of faelle) {
    schnappschussAbgelehnt(umbauen(bytes, fn).bytes, fehler);
  }

  // Andere Schluesselreihenfolge, gleiche Werte.
  const umgestellt = umbauen(bytes, s => { const run = s.run; delete s.run; s.run = run; const ev = s.event; delete s.event; s.event = ev; s.issue = { state: s.issue.state, ...s.issue }; });
  schnappschussAbgelehnt(umgestellt.bytes, fehler);

  // __proto__ als eigener Schluessel, wie JSON.parse ihn anlegt.
  const text = bytes.toString('utf8').replace('  "schema"', '  "__proto__": {},\n  "schema"');
  schnappschussAbgelehnt(Buffer.from(text, 'utf8'), fehler);
  assert.equal(Object.getPrototypeOf(JSON.parse(text)), Object.prototype, 'Gegenprobe: Prototyp nicht manipuliert');

  // Muss-Treffer: die unveraenderten Bytes werden angenommen, und ein Rundweg ueber umbauen ist identisch.
  assert.ok(parseSnapshot(bytes));
  assert.ok(umbauen(bytes, () => {}).bytes.equals(bytes));
});

test('Schnappschuss Bytes: UTF-8, BOM, NUL, mehrdeutiges JSON, Formatierung, Groesse, Tiefe', async () => {
  const k = await kette('rechner');
  const bytes = k.snapshotBytes;
  const text = bytes.toString('utf8');

  schnappschussAbgelehnt(Buffer.concat([bytes.subarray(0, 20), Buffer.from([0xff, 0xfe]), bytes.subarray(20)]), 'job-schnappschuss-utf8');
  schnappschussAbgelehnt(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), 'job-schnappschuss-format');
  schnappschussAbgelehnt(Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([0, 0x0a])]), 'job-schnappschuss-format');
  // Doppelter Schluessel: JSON.parse nimmt den letzten, die kanonische Form verraet ihn.
  schnappschussAbgelehnt(Buffer.from(text.replace('  "schema"', '  "schema": "agent-auftrag-schnappschuss-v1",\n  "schema"'), 'utf8'), 'job-schnappschuss-kanonisch');
  schnappschussAbgelehnt(Buffer.from(text.replace('\n', '\r\n'), 'utf8'), 'job-schnappschuss-kanonisch');
  schnappschussAbgelehnt(Buffer.from(text.slice(0, -1), 'utf8'), 'job-schnappschuss-kanonisch');
  schnappschussAbgelehnt(Buffer.from(JSON.stringify(JSON.parse(text)), 'utf8'), 'job-schnappschuss-kanonisch');
  schnappschussAbgelehnt(Buffer.from(text.replace('"open"', '"\\u006fpen"'), 'utf8'), 'job-schnappschuss-kanonisch');
  schnappschussAbgelehnt(Buffer.alloc(0), 'job-schnappschuss-groesse');
  schnappschussAbgelehnt(Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 0x20), 'job-schnappschuss-groesse');
  schnappschussAbgelehnt('kein Buffer', 'job-schnappschuss-groesse');

  // Tiefe 9 (auch in kanonischer Form) scheitert vor dem Parsen; Tiefe 8 kommt bis zur Schemapruefung.
  const tief = tiefe => { let v = 1; for (let i = 1; i < tiefe; i += 1) { v = [v]; } return v; };
  const mit = tiefe => Buffer.from(`${JSON.stringify({ ...JSON.parse(text), extra: tief(tiefe) }, null, 2)}\n`, 'utf8');
  schnappschussAbgelehnt(mit(9), 'job-schnappschuss-tiefe');
  schnappschussAbgelehnt(mit(7), 'job-schnappschuss-schema');
  // Klammern in Texten zaehlen nicht.
  schnappschussAbgelehnt(umbauen(bytes, s => { s.extra = '[[[[[[[[[[[['; }).bytes, 'job-schnappschuss-schema');
});

test('Schnappschuss Bau: Getter, Proxy-artige Quellen und fremde Typen werden nicht still uebernommen', () => {
  const issue = { number: 6501, state: 'open', title: 't', body: 'b', updated_at: APPROVAL, user: { login: 'noah04091', type: 'User' }, labels: [{ name: 'bot-auftrag' }] };
  const run = { id: '7700006501', attempt: 1, createdAt: RUN_CREATED };
  const event = { action: 'labeled', label: { name: 'bot-auftrag' }, sender: { login: 'noah04091', type: 'User' }, repository: { full_name: REPO_NAME }, issue: { number: 6501, title: 't', body: 'b', updated_at: APPROVAL } };
  const events = [{ id: 1, event: 'labeled', created_at: APPROVAL, actor: { login: 'noah04091', type: 'User' }, label: { name: 'bot-auftrag' }, performed_via_github_app: false }];
  // Muss-Treffer: gueltige Quelle. Ein App-Wert false (weder fehlend noch null) bleibt ein Objekt.
  const s = JSON.parse(buildSnapshot({ issue, events, run, event }).toString('utf8'));
  assert.deepEqual(s.events[0].performed_via_github_app, { id: null, slug: null });

  const getter = Object.defineProperty({ ...issue }, 'title', { get: () => 't', enumerable: true });
  const mitPrototyp = Object.assign(Object.create({ geerbt: 1 }), issue);
  for (const [quelle, teil] of [[getter, 'issue'], [mitPrototyp, 'issue'], [{ ...run, attempt: 2 }, 'run'], [{ ...event, sender: 'noah04091' }, 'event'], [[...events, { id: 2 }], 'events']]) {
    assert.throws(() => buildSnapshot({ issue, events, run, event, [teil]: quelle }), error => error.code === 'job-schnappschuss-quelle');
  }
});

test('Job 2 Schnappschuss-Angriffe: Hashbindung, Laufbindung und Rekonstruktion', async () => {
  const k = await kette('rechner');
  const b = 6501 * 100;
  const mit = (fn, extra = {}) => {
    const u = umbauen(k.snapshotBytes, fn);
    return job2({ ...k, snapshotSha: u.sha, ...extra }, {}, { snapshotBytes: u.bytes });
  };

  // Schicht 1: falscher Schnappschuss-Hash und ausgetauschte Datei (nur ein irrelevantes Ereignis
  // fehlt, der Auftrag bliebe gleich).
  abgelehnt(await job2({ ...k, snapshotSha: 'c'.repeat(64) }), 'job-schnappschuss-hash');
  const getauscht = umbauen(k.snapshotBytes, s => { s.events.splice(3, 1); });
  assert.equal(orderSha256(orderFromSnapshot(getauscht.bytes)), k.orderSha, 'Gegenprobe: Auftrag waere gleich');
  abgelehnt(await job2(k, {}, { snapshotBytes: getauscht.bytes }), 'job-schnappschuss-hash');

  // Schicht 2: Hash passt zum Angriff, Schema oder Bindung lehnt ab.
  abgelehnt(await mit(s => { delete s.events[2].performed_via_github_app; }), 'job-schnappschuss-schema');
  abgelehnt(await mit(s => { delete s.issue.user; }), 'job-schnappschuss-schema');
  abgelehnt(await mit(s => { delete s.event.sender; }), 'job-schnappschuss-schema');
  abgelehnt(await mit(s => { delete s.event.repository; }), 'job-schnappschuss-schema');

  // Fremder Schnappschuss (anderer Lauf) mit eigenem, stimmigem Hash.
  abgelehnt(await mit(s => { s.run.id = '7700009999'; }), 'job-schnappschuss-lauf');
  abgelehnt(await job2({ ...k, runId: '7700009999' }), 'job-schnappschuss-lauf');

  // Schicht 3: resolveOrder auf den rekonstruierten Daten. Erwartet wird der ehrliche Auftrags-Hash.
  abgelehnt(await mit(s => { s.issue.user = { login: 'fremdes-konto', type: 'User' }; }), 'auftrag-issue-autor');
  abgelehnt(await mit(s => { s.event.sender = { login: 'fremdes-konto', type: 'User' }; }), 'auftrag-start-sender');
  abgelehnt(await mit(s => { s.events[7].performed_via_github_app = { id: 7, slug: 'app' }; }), 'auftrag-freigabe-fremd');
  abgelehnt(await mit(s => { s.events[7].actor = null; }), 'auftrag-freigabe-fremd');
  abgelehnt(await mit(s => { s.event.issue.updated_at = iso(T0 - 1_800_000); }), 'auftrag-start-zuordnung');
  abgelehnt(await mit(s => { s.run.createdAt = iso(T0 + 86_400_000); }), 'auftrag-lauf-zukunft');

  // Schicht 4: sameOrder gegen den erwarteten Hash (Rekonstruktion gelingt, Auftrag weicht ab).
  abgelehnt(await mit(s => { s.events[7].id = b + 9; }), 'auftrag-abweichung');
  abgelehnt(await mit(s => { s.events.splice(4, 2); }), 'auftrag-abweichung');
  abgelehnt(await job2({ ...k, orderSha: 'd'.repeat(64) }), 'auftrag-abweichung');
  // Falscher Auftrags-Hash ohne Paket: sameOrder lehnt vor jedem Paketzugriff ab.
  abgelehnt(await job2({ ...k, orderSha: 'd'.repeat(64) }, {}, { packageBytes: null }), 'auftrag-abweichung');

  // Schnappschuss als Ordner oder fehlend.
  const ordner = temp2(null, k.packageBytes);
  mkdirSync(join(ordner, 'a6-auftrag', 'schnappschuss.json'), { recursive: true });
  const r = await fange(() => mainAbnahme(umgebung2(ordner, k)));
  abgelehnt(r, 'job-schnappschuss-datei');
  abgelehnt(await job2(k, {}, { snapshotBytes: null }), 'job-schnappschuss-datei');

  // Schnappschuss als Symlink auf eine Datei mit den richtigen Bytes.
  if (symlinksErlaubt) {
    const mitLink = temp2(null, k.packageBytes);
    mkdirSync(join(mitLink, 'a6-auftrag'));
    writeFileSync(join(mitLink, 'echt.json'), k.snapshotBytes);
    symlinkSync(join(mitLink, 'echt.json'), join(mitLink, 'a6-auftrag', 'schnappschuss.json'));
    abgelehnt(await fange(() => mainAbnahme(umgebung2(mitLink, k))), 'job-schnappschuss-datei');
  }
});

// ===========================================================================
// Job 2: Umgebung, Paket und Abnahme
// ===========================================================================

test('Job 2 Umgebung: Laufversuch, Lauf, Workflow, Hashformate, kein Token, keine Node-Schalter', async () => {
  const k = await kette('rechner');
  const faelle = [
    [{ GITHUB_RUN_ATTEMPT: '2' }, 'job-lauf-versuch'],
    [{ GITHUB_REPOSITORY: 'noah04091/anderes' }, 'job-repository'],
    [{ GITHUB_WORKFLOW_REF: `${REPO_NAME}/.github/workflows/tests.yml@refs/heads/main` }, 'job-workflow'],
    [{ A6_PAKET_SHA256: 'E'.repeat(64) }, 'job-hash-format'],
    [{ A6_AUFTRAG_SHA256: undefined }, 'job-umgebung-fehlt'],
    [{ A6_LESE_TOKEN: TOKEN }, 'job-umgebung-geheimnis'],
    [{ GITHUB_TOKEN: 'x' }, 'job-umgebung-geheimnis'],
    [{ GH_TOKEN: 'x' }, 'job-umgebung-geheimnis'],
    [{ ANTHROPIC_API_KEY: 'x' }, 'job-umgebung-geheimnis'],
    [{ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid' }, 'job-umgebung-geheimnis'],
    [{ HARMLOS: TOKEN }, 'job-umgebung-geheimnis'],
    [{ NODE_OPTIONS: '--require ./x.cjs' }, 'job-umgebung-node'],
    [{ NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }, 'job-umgebung-node'],
  ];

  // Muss-Treffer: der Netzzaehler bemerkt einen Versuch.
  const zaehler = netzZaehler();
  assert.throws(() => https.request({}), /Netz im Abnahme-Einstieg verboten/);
  assert.equal(zaehler.https, 1);

  for (const [envMod, code] of faelle) {
    const r = await job2(k, envMod);
    abgelehnt(r, code);
    assert.ok(!r.starts.includes(process.execPath), `Abnahme trotz ${code} gestartet`);
  }
});

test('Job 2 Paket: manipulierte Bytes, falscher Hash, Dateiliste, Blobs, Bindung, fremdes Paket', async () => {
  const k = await kette('rechner');
  const pkg = JSON.parse(k.packageText);
  const mitPaket = fn => {
    const value = structuredClone(pkg);
    fn(value);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return job2({ ...k, packageSha: sha256(bytes) }, {}, { packageBytes: bytes });
  };

  // Manipulierte Bytes bei erwartetem Hash von Job 1, und falscher Hash bei echten Bytes.
  const verfaelscht = Buffer.from(k.packageText.replace('"base64": "', '"base64": "A'), 'utf8');
  abgelehnt(await job2(k, {}, { packageBytes: verfaelscht }), 'job-paket-hash');
  abgelehnt(await job2({ ...k, packageSha: 'b'.repeat(64) }), 'job-paket-hash');
  abgelehnt(await job2(k, {}, { packageBytes: null }), 'job-paket-datei');

  // Stimmiger Hash, falscher Inhalt: parsePackageV2 lehnt ab.
  abgelehnt(await mitPaket(p => { p.dateien.reverse(); }), 'paket-dateiliste');
  abgelehnt(await mitPaket(p => { p.dateien[0].basis_blob = '0'.repeat(40); }), 'paket-basis-blob');
  abgelehnt(await mitPaket(p => { p.dateien[0].git_blob = '0'.repeat(40); }), 'paket-git-blob');
  abgelehnt(await mitPaket(p => { p.abnahme_sha256 = '0'.repeat(64); }), 'paket-bindung');
  abgelehnt(await mitPaket(p => { p.schema = 'agent-code-auftrag-paket-v0'; }), 'paket-schema');

  // Paket eines anderen Auftrags (js-text) mit seinem eigenen Hash.
  const t = await kette('text');
  abgelehnt(await job2({ ...k, packageSha: t.packageSha }, {}, { packageBytes: t.packageBytes }), 'paket-bindung');
});

test('Job 2 Abnahme: scheiternde Abnahme mit Agentenausgabe und fehlende v2-Kennung, als CLI ohne Bericht im Protokoll', async () => {
  for (const [name, code] of [['scheitert', 'abnahme-exitcode'], ['ohneKennung', 'abnahme-format']]) {
    const k = await kette(name);
    const r = await job2(k);
    abgelehnt(r, code);

    // Als eigener Prozess: die echten Kanaele enthalten nur die feste Zeile.
    const temp = temp2(k.snapshotBytes, k.packageBytes);
    const out = SPAWN(process.execPath, [JOB2_PATH], { env: umgebung2(temp, k), encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(out.status, 1);
    assert.equal(out.stderr, `A6-FEHLER ${code}\n`);
    assert.equal(out.stdout, '');
  }

  // Muss-Treffer: der Treiber schreibt den Marker tatsaechlich, und der Bericht des Moduls traegt ihn.
  const k = await kette('scheitert');
  const order = orderFromSnapshot(k.snapshotBytes);
  assert.throws(() => acceptOrderPackage({
    trustedRoot: TRUSTED, checkParent: newDir('p-'), order, expectedSha256: k.orderSha, packageBytes: k.packageBytes, packageSha256: k.packageSha, gitEnv: { ...ENV },
  }), error => error.code === 'abnahme-exitcode' && JSON.stringify(error.bericht).includes(AGENT_MARKER));
});

// ===========================================================================
// Fehlercodes und Ausgaben
// ===========================================================================

test('Ausgabe: nur feste Codes, nie Meldung, Bericht oder Stack; Steuerzeichen werden zum generischen Code', () => {
  const mitCode = code => Object.assign(new Error(`Meldung mit ${ISSUE_MARKER}\n::error::x`), { code, bericht: { stderr_anfang: AGENT_MARKER } });
  assert.equal(errorLine(mitCode('auftrag-issue-autor')), 'A6-FEHLER auftrag-issue-autor\n');

  for (const falsch of ['', 'Gross', 'a\nb', 'x::set-output', `auftrag-${'x'.repeat(80)}`, 'a-', 42, null]) {
    assert.equal(errorLine(mitCode(falsch)), 'A6-FEHLER job-unbekannt\n');
  }

  for (const wert of [null, undefined, 'text', 7, new Error('ohne Code'), Object.defineProperty({}, 'code', { get: () => 'auftrag-x' })]) {
    assert.equal(errorCode(wert), 'job-unbekannt');
  }

  assert.equal(errorCode(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('Falle'); } })), 'job-unbekannt');
});

test('Ausgabe: genau zwei feste Schluessel, nur 64 Hex-Zeichen, ein Schreibvorgang, keine Zusatzzeilen', () => {
  const temp = newDir('aus-');
  const datei = join(temp, 'out');
  writeFileSync(datei, '');
  const vertrag = { outputPath: datei };
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);

  for (const [x, y] of [[`${a}\nboese=1`, b], [a, `${b}\n`], [a.toUpperCase(), b], [a.slice(1), b], [a, 42]]) {
    assert.throws(() => writeHashOutputs(vertrag, x, y), error => error.code === 'job-ausgabe-format');
  }

  assert.equal(readFileSync(datei, 'utf8'), '');
  // Ein zusaetzliches Argument fuehrt nie zu weiteren Schluesseln.
  writeHashOutputs(vertrag, a, b, { weiter: 'x' }, 'boese');
  assert.equal(readFileSync(datei, 'utf8'), `auftrag_sha256=${a}\nschnappschuss_sha256=${b}\n`);
  assert.equal(writeHashOutputs.length, 3);

  // Fehlende Datei oder Ordner statt Datei.
  assert.throws(() => writeHashOutputs({ outputPath: join(temp, 'fehlt') }, a, b), error => error.code === 'job-ausgabe-datei');
  assert.throws(() => writeHashOutputs({ outputPath: temp }, a, b), error => error.code === 'job-ausgabe-datei');
});

test('Vertrag: Einstiege lesen nur die festen Namen; Job 2 kennt keinen Token', () => {
  const temp = newDir('v-');
  const base = umgebung0(temp, '1');
  mkdirSync(join(temp, '_github_workflow'));
  const vertrag = readAuftragContract({ ...base, UNBEKANNT: 'egal' });
  assert.deepEqual(Object.keys(vertrag), ['repository', 'runId', 'baseSha', 'workspace', 'runnerTemp', 'eventPath', 'outputPath', 'path', 'system', 'token']);
  assert.ok(Object.isFrozen(vertrag));
  const v2 = readAbnahmeContract(umgebung2(temp, { runId: '1', orderSha: 'a'.repeat(64), snapshotSha: 'b'.repeat(64), packageSha: 'c'.repeat(64) }));
  assert.deepEqual(Object.keys(v2), ['repository', 'runId', 'baseSha', 'workspace', 'runnerTemp', 'path', 'system', 'orderSha256', 'snapshotSha256', 'packageSha256']);
  assert.ok(!Object.keys(v2).some(key => /token/i.test(key)));
});

// ===========================================================================
// Import-, Berechtigungs- und Ausgabewachen
// ===========================================================================

const LOCAL_IMPORT_RE = /^import\s[^;]*?from\s+'(\.\/[^']+)';/gms;
const ANY_IMPORT_RE = /^import\s[^;]*?from\s+'([^']+)';/gms;
const readScript = name => readFileSync(join(SCRIPTS, name), 'utf8');

// Alle lokalen Module, die von name aus statisch erreichbar sind, samt aller Node-Importe.
function importGraph(name) {
  const lokal = new Set();
  const node = new Set();
  const offen = [name];

  while (offen.length > 0) {
    const current = offen.pop();

    if (lokal.has(current)) {
      continue;
    }

    lokal.add(current);
    const source = readScript(current);
    // Kein dynamischer Import, kein require, kein export ... from in der ganzen Kette.
    assert.ok(!/\bimport\s*\(/.test(source), `dynamischer Import in ${current}`);
    assert.ok(!/\brequire\s*\(/.test(source), `require in ${current}`);
    assert.ok(!/\bexport\b[^;]*\bfrom\b/.test(source), `export ... from in ${current}`);

    for (const [, spec] of source.matchAll(ANY_IMPORT_RE)) {
      if (spec.startsWith('./')) {
        offen.push(spec.slice(2));
      } else {
        node.add(spec);
      }
    }
  }

  lokal.delete(name);
  return { lokal: [...lokal].sort(), node: [...node].sort() };
}

const directImports = source => [...source.matchAll(ANY_IMPORT_RE)].map(m => m[1]).sort();

test('Wache: gemeinsame Hilfsdatei nur mit node:fs, node:crypto, node:path; kein Auftragsmodul, kein Netz, kein Prozess', () => {
  const source = readFileSync(GEMEINSAM_PATH, 'utf8');
  assert.deepEqual(directImports(source), ['node:crypto', 'node:fs', 'node:path']);
  assert.equal([...source.matchAll(/\bimport\b/g)].length, 3);
  assert.ok(!source.includes('agent-code-auftrag'), 'Verweis auf ein Auftragsmodul');

  for (const forbidden of [/\bprocess\b/, /\bfetch\b/, /\bglobalThis\b/, /\brequire\b/, /\bconsole\b/, /child_process/, /\beval\b/, /\bFunction\(/, /\bnode:(net|http|https|dns|tls|worker_threads|vm)\b/, /\bspawn/, /\bexec/]) {
    assert.ok(!forbidden.test(source), `verbotener Zugriff: ${forbidden}`);
  }

  // Ausgabeschluessel fest: genau eine Funktion schreibt, mit fester Signatur und nur aus OUTPUT_KEYS.
  assert.ok(source.includes("export const OUTPUT_KEYS = Object.freeze(['auftrag_sha256', 'schnappschuss_sha256']);"));
  assert.ok(source.includes('export function writeHashOutputs(contract, auftragSha256, schnappschussSha256) {'));
  assert.ok(source.includes('const text = `${OUTPUT_KEYS[0]}=${auftragSha256}\\n${OUTPUT_KEYS[1]}=${schnappschussSha256}\\n`;'));
  assert.equal([...source.matchAll(/O_APPEND/g)].length, 1, 'genau eine anhaengende Schreibstelle');
  // Muss-Treffer: dieselben Suchen finden in einem anderen Skript etwas.
  assert.ok(/\bprocess\b/.test(readScript('agent-code-publish.mjs')));
});

test('Wache: Job 0 importiert nur Auftrag, Live, Lesetransport und Hilfsdatei, direkt und transitiv', () => {
  const source = readFileSync(JOB0_PATH, 'utf8');
  assert.deepEqual(directImports(source), ['./agent-code-auftrag-live.mjs', './agent-code-auftrag-transport.mjs', './agent-code-auftrag.mjs', './agent-code-job-gemeinsam.mjs']);
  assert.ok(source.includes("import { createReadTransport } from './agent-code-auftrag-transport.mjs';"), 'nur der Lesetransport');
  assert.ok(!source.includes('createPublishTransport'));
  const graph = importGraph('agent-code-job-auftrag.mjs');
  assert.deepEqual(graph.lokal, ['agent-code-auftrag-live.mjs', 'agent-code-auftrag-transport.mjs', 'agent-code-auftrag.mjs', 'agent-code-job-gemeinsam.mjs', 'agent-profile.mjs']);
  assert.deepEqual(graph.node, ['node:child_process', 'node:crypto', 'node:fs', 'node:https', 'node:path', 'node:tls', 'node:util']);

  for (const verboten of ['agent-code-auftrag-abnahme', 'agent-code-auftrag-paket', 'agent-code-auftrag-prompt', 'agent-code-auftrag-publish']) {
    assert.ok(!source.includes(verboten), `${verboten} in Job 0`);
  }
});

test('Wache: Job 2 importiert nur Auftrag, Paket, Abnahme und Hilfsdatei; kein Live, kein Transport, kein Netz', () => {
  const source = readFileSync(JOB2_PATH, 'utf8');
  assert.deepEqual(directImports(source), ['./agent-code-auftrag-abnahme.mjs', './agent-code-auftrag-paket.mjs', './agent-code-auftrag.mjs', './agent-code-job-gemeinsam.mjs']);
  const graph = importGraph('agent-code-job-abnahme.mjs');
  assert.deepEqual(graph.lokal, ['agent-code-auftrag-abnahme.mjs', 'agent-code-auftrag-paket.mjs', 'agent-code-auftrag.mjs', 'agent-code-job-gemeinsam.mjs', 'agent-profile.mjs']);
  assert.ok(!graph.node.some(spec => /^node:(net|http|https|http2|tls|dns|dgram)$/.test(spec)), `Netzmodul: ${graph.node.join(', ')}`);

  for (const verboten of ['agent-code-auftrag-live', 'agent-code-auftrag-transport', 'agent-code-auftrag-prompt', 'agent-code-auftrag-publish', 'Transport', 'token', 'Token', 'fetch']) {
    assert.ok(!source.includes(verboten), `${verboten} in Job 2`);
  }

  // Kein Nachweis aus JSON und kein selbst gebautes WeakSet: requireAccepted bekommt das Ergebnis von acceptOrderPackage.
  assert.ok(!/JSON\.parse|WeakSet|WeakMap/.test(source));
  assert.ok(/const nachweis = acceptOrderPackage\(\{/.test(source) && source.includes('requireAccepted(nachweis, order, contract.orderSha256);'));

  // A6.4-2c-2: Job 2 schreibt keine Job-Ausgabe, auch nicht ueber die neuen Ausgabeschreiber.
  assert.ok(!/writeHashOutputs|writePackageOutput|outputPath|GITHUB_OUTPUT|OUTPUT_KEY/.test(source), 'Ausgabe in Job 2');
  assert.ok(/writeHashOutputs/.test(readFileSync(JOB0_PATH, 'utf8')), 'Muss-Treffer der Ausgabesuche');
});

// ---------------------------------------------------------------------------
// A6.4-2c-2: Wachen der drei neuen Einstiege und Regression von Job 0 und Job 2
// ---------------------------------------------------------------------------

const NETZ_RE = /^node:(net|http|https|http2|tls|dns|dgram)$/;
// Quelltext ohne ganze Kommentarzeilen: Aufrufe werden nur im Code gezaehlt.
const ohneKommentare = source => source.replace(/^\s*\/\/.*$/gm, '');

test('Wache: Job 1a importiert nur Auftrag, Live, Lesetransport, Prompt, Paket und Hilfsdatei; keine Abnahme, kein Veroeffentlicher', () => {
  const source = readFileSync(JOB1A_PATH, 'utf8');
  assert.deepEqual(directImports(source), [
    './agent-code-auftrag-live.mjs', './agent-code-auftrag-paket.mjs', './agent-code-auftrag-prompt.mjs', './agent-code-auftrag-transport.mjs',
    './agent-code-auftrag.mjs', './agent-code-job-gemeinsam.mjs', 'node:path',
  ]);
  assert.ok(source.includes("import { createReadTransport } from './agent-code-auftrag-transport.mjs';"), 'nur der Lesetransport');
  assert.ok(source.includes("import { prepareWorkspace } from './agent-code-auftrag-paket.mjs';"), 'aus dem Paketmodul nur prepareWorkspace');
  assert.ok(source.includes("import { buildPrompt, writeStepOutput } from './agent-code-auftrag-prompt.mjs';"));
  const graph = importGraph('agent-code-job-claude-vor.mjs');
  assert.deepEqual(graph.lokal, [
    'agent-code-auftrag-live.mjs', 'agent-code-auftrag-paket.mjs', 'agent-code-auftrag-prompt.mjs', 'agent-code-auftrag-transport.mjs',
    'agent-code-auftrag.mjs', 'agent-code-job-gemeinsam.mjs', 'agent-profile.mjs',
  ]);
  assert.deepEqual(graph.node, ['node:child_process', 'node:crypto', 'node:fs', 'node:https', 'node:path', 'node:tls', 'node:util']);

  // Kein Claude-Start, keine Schreibanfrage, kein eigener Prompt und kein frei gewaehlter Arbeitsordner.
  for (const verboten of ['agent-code-auftrag-abnahme', 'agent-code-auftrag-publish', 'createPublishTransport', 'child_process', 'spawn', 'execFile', "'POST'", "'DELETE'", 'SECURITY_FRAME', 'createNonce', 'process.cwd', 'mkdtemp']) {
    assert.ok(!source.includes(verboten), `${verboten} in Job 1a`);
  }

  assert.equal([...ohneKommentare(source).matchAll(/buildPrompt\(/g)].length, 1);
  assert.equal([...source.matchAll(/writeStepOutput\(\{ outputPath: contract\.outputPath, name: 'prompt', prompt \}\)/g)].length, 1);
  assert.ok(source.includes('const workDir = absentDir(contract.runnerTemp, WORK_DIR, \'job-arbeitsordner\');'));
  assert.ok(source.includes('title: snapshot.issue.title,') && source.includes('body: snapshot.issue.body,'), 'Titel und Text aus dem gebundenen Schnappschuss');
  assert.ok(source.includes('state, ...base, now, runId: contract.runId });'), 'checkLiveOrder mit genau dem frisch gelesenen Zustand');
});

test('Wache: Job 1b importiert nur Auftrag, Paket und Hilfsdatei; kein Netz, kein Live, kein Prompt, keine Abnahme, kein Prozessstarter', () => {
  const source = readFileSync(JOB1B_PATH, 'utf8');
  assert.deepEqual(directImports(source), ['./agent-code-auftrag-paket.mjs', './agent-code-auftrag.mjs', './agent-code-job-gemeinsam.mjs']);
  assert.ok(source.includes("import { containsSecretValue, createPackageV2, packageFileBytes, parsePackageV2, scanForSecrets } from './agent-code-auftrag-paket.mjs';"));
  const graph = importGraph('agent-code-job-claude-nach.mjs');
  assert.deepEqual(graph.lokal, ['agent-code-auftrag-paket.mjs', 'agent-code-auftrag.mjs', 'agent-code-job-gemeinsam.mjs', 'agent-profile.mjs']);
  assert.ok(!graph.node.some(spec => NETZ_RE.test(spec)), `Netzmodul: ${graph.node.join(', ')}`);
  // Git nur ueber das Auftragsmodul (resolveOrder, openRepository und runGit), nie ein eigener Import.
  assert.deepEqual(graph.node, ['node:child_process', 'node:crypto', 'node:fs', 'node:path', 'node:util']);

  for (const verboten of ['agent-code-auftrag-live', 'agent-code-auftrag-transport', 'agent-code-auftrag-prompt', 'agent-code-auftrag-abnahme', 'agent-code-auftrag-publish', 'node:', 'child_process', 'spawn', 'execFile', 'fork(', 'Transport', 'token', 'fetch', 'compareWorkspace', 'JSON.stringify', 'JSON.parse']) {
    assert.ok(!source.includes(verboten), `${verboten} in Job 1b`);
  }

  // Git laeuft nur im vertrauenswuerdigen Checkout, nie im Arbeitsordner von Claude.
  assert.deepEqual([...source.matchAll(/openRepository\(([^,]+),/g)].map(m => m[1]), ['contract.workspace']);
  assert.deepEqual([...source.matchAll(/resolveOrder\(\{ root: ([^,]+),/g)].map(m => m[1]), ['contract.workspace']);
  assert.equal([...source.matchAll(/runGit\(/g)].length, 1);
  assert.ok(!/(?:runGit|openRepository|resolveOrder)\([^)]*workDir/.test(source));

  // Reihenfolge: Paket bauen, Bytes binden, pruefen, Geheimnisse, dann schreiben, zuruecklesen, ausgeben.
  const stelle = text => {
    const index = source.indexOf(text);
    assert.ok(index > 0, `${text} fehlt`);
    return index;
  };
  const folge = [
    'const result = createPackageV2(', "Buffer.from(result.text, 'utf8')", 'parsePackageV2(order, contract.orderSha256, packageBytes, result.sha256)',
    'scanPackageSecrets(parsed, packageBytes, contract.compareValues);', 'writeExclusive(freshDir(contract.runnerTemp, PACKAGE_DIR), PACKAGE_FILE, packageBytes);',
    'const back = readBounded(packagePath(', 'writePackageOutput(contract, sha256Hex(back));',
  ].map(stelle);
  assert.deepEqual(folge, [...folge].sort((a, b) => a - b), 'Reihenfolge im Quelltext');
  const code = ohneKommentare(source);
  assert.equal([...code.matchAll(/writeExclusive\(/g)].length, 1);
  assert.equal([...code.matchAll(/writePackageOutput\(/g)].length, 1);
  assert.equal([...code.matchAll(/Buffer\.from\(/g)].length, 1, 'Ergebnistext genau einmal in Bytes');
});

test('Wache: Job 3 importiert nur Veroeffentlicher, Veroeffentlichungstransport, Auftrag und Hilfsdatei; ein Aufruf, kein Retry', () => {
  const source = readFileSync(JOB3_PATH, 'utf8');
  assert.deepEqual(directImports(source), ['./agent-code-auftrag-publish.mjs', './agent-code-auftrag-transport.mjs', './agent-code-auftrag.mjs', './agent-code-job-gemeinsam.mjs']);
  assert.ok(source.includes("import { createPublishTransport } from './agent-code-auftrag-transport.mjs';"));
  assert.ok(source.includes("import { publishOrderDraft } from './agent-code-auftrag-publish.mjs';"));
  assert.ok(source.includes("import { openRepository, runGit } from './agent-code-auftrag.mjs';"));
  const graph = importGraph('agent-code-job-veroeffentlichen.mjs');
  assert.deepEqual(graph.lokal, [
    'agent-code-auftrag-live.mjs', 'agent-code-auftrag-paket.mjs', 'agent-code-auftrag-publish.mjs', 'agent-code-auftrag-transport.mjs',
    'agent-code-auftrag.mjs', 'agent-code-job-gemeinsam.mjs', 'agent-profile.mjs',
  ]);

  for (const verboten of ['agent-code-auftrag-prompt', 'agent-code-auftrag-abnahme', 'agent-code-job-claude', 'createReadTransport', 'readLiveState', 'checkLiveOrder', 'resolveOrder', 'parseSnapshot', 'branchName', '/repos/', "'POST'", "'DELETE'", 'pulls', 'git/refs', 'child_process', 'spawn', 'execFile', 'while', 'for (', 'catch {', 'JSON.parse(', 'bericht']) {
    assert.ok(!source.includes(verboten), `${verboten} in Job 3`);
  }

  // Genau ein Transport, genau ein Aufruf des Veroeffentlichers mit genau den elf Schluesseln und der echten Uhr.
  const code = ohneKommentare(source);
  assert.equal([...code.matchAll(/createPublishTransport\(/g)].length, 1);
  assert.equal([...code.matchAll(/publishOrderDraft\(/g)].length, 1);
  assert.equal([...source.matchAll(/await publishOrderDraft\(\{/g)].length, 1);
  const call = source.slice(source.indexOf('await publishOrderDraft({'), source.indexOf('});', source.indexOf('await publishOrderDraft({')));
  assert.deepEqual([...call.matchAll(/^ {4}(\w+)[,:]/gm)].map(m => m[1]), [
    'root', 'checkRoot', 'baseSha', 'event', 'expectedSha256', 'runId', 'packageBytes', 'packageSha256', 'gitEnv', 'transport', 'clock',
  ]);
  assert.ok(call.includes('clock: () => new Date(),'));
  assert.ok(call.includes('packageSha256: contract.packageSha256,') && call.includes('expectedSha256: contract.orderSha256,'), 'Hashes nur aus dem Vertrag');
  assert.ok(source.includes('const event = readEventFile(contract);'), 'Ereignis nur aus der Ereignisdatei des Runners');
});

test('Wache: Hilfsdatei kennt die Geheimnisnamen nur als feste, eingefrorene Listen; der Stolperdraht bekommt nie eine Liste von aussen', () => {
  const source = readFileSync(GEMEINSAM_PATH, 'utf8');
  assert.equal([...source.matchAll(/tripwire\(/g)].length, 6, 'eine Definition und fuenf Aufrufe');
  assert.ok(source.includes('function tripwire(env, allowed) {'));
  assert.deepEqual([...source.matchAll(/^ {2}tripwire\(env, ([^)]+)\);$/gm)].map(m => m[1]).sort(), [
    'SECRET_NAMES.abnahme', 'SECRET_NAMES.auftrag', 'SECRET_NAMES.claudeNach', 'SECRET_NAMES.claudeVor', 'SECRET_NAMES.veroeffentlichen',
  ]);
  assert.ok(!/export function tripwire/.test(source));
  assert.equal([...source.matchAll(/O_APPEND/g)].length, 1, 'weiterhin genau eine anhaengende Schreibstelle');
  assert.ok(source.includes("export const PACKAGE_OUTPUT_KEY = 'paket_sha256';"));
  assert.ok(source.includes('appendOutput(contract.outputPath, `${PACKAGE_OUTPUT_KEY}=${paketSha256}\\n`);'));
});

test('Regression: feste Geheimnisnamen je Job; Job 0 nur Lesetoken, Job 2 keiner, fremde Namen werden abgelehnt', async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SECRET_NAMES)), {
    auftrag: ['A6_LESE_TOKEN'],
    claudeVor: ['A6_LESE_TOKEN'],
    claudeNach: ['A6_VERGLEICH_ANTHROPIC', 'A6_VERGLEICH_LESE_TOKEN'],
    abnahme: [],
    veroeffentlichen: ['A6_APP_TOKEN'],
  });
  assert.ok(Object.isFrozen(SECRET_NAMES) && Object.values(SECRET_NAMES).every(Object.isFrozen));
  assert.throws(() => SECRET_NAMES.abnahme.push('A6_APP_TOKEN'), TypeError);
  assert.throws(() => { SECRET_NAMES.abnahme = ['A6_APP_TOKEN']; }, TypeError);
  assert.deepEqual(SECRET_NAMES.abnahme, []);

  // Job 2: kein einziger Geheimnisname, auch nicht die der anderen Jobs mit harmlos wirkendem Wert.
  const harmlos = 'Synthetischer-Vergleichswert-ohne-Wirkung-0001';
  const k = await kette('rechner');

  for (const name of ['A6_LESE_TOKEN', 'A6_VERGLEICH_ANTHROPIC', 'A6_VERGLEICH_LESE_TOKEN', 'A6_APP_TOKEN']) {
    const r = await job2(k, { [name]: name === 'A6_LESE_TOKEN' || name === 'A6_APP_TOKEN' ? TOKEN : harmlos });
    abgelehnt(r, 'job-umgebung-geheimnis');
    assert.ok(!r.starts.includes(process.execPath), `Abnahme trotz ${name} gestartet`);
  }

  // Muss-Treffer: ohne fremden Namen besteht derselbe Lauf.
  job2Erfolg(await job2(k));

  // Job 0: nur der Lesetoken; App-Token und Vergleichswerte sind fremd, auch ohne Muster im Namen.
  for (const [name, wert] of [['A6_APP_TOKEN', TOKEN], ['A6_VERGLEICH_ANTHROPIC', harmlos], ['A6_VERGLEICH_LESE_TOKEN', harmlos]]) {
    const r = await job0('rechner', {}, { [name]: wert });
    job0Abgelehnt(r, 'job-umgebung-geheimnis');
    assert.equal(r.aufrufe.length, 0, `Netz trotz ${name}`);
  }
});

test('Wache: alle fuenf Einstiege geben nur feste Codes aus und lesen process nur fuer stderr, Exitcode und den Vertrag', () => {
  assert.equal(EINSTIEGE.length, 5);

  for (const path of EINSTIEGE) {
    const source = readFileSync(path, 'utf8');
    assert.deepEqual([...new Set([...source.matchAll(/\bprocess\.(\w+)/g)].map(m => m[1]))].sort(), ['env', 'exitCode', 'stderr']);
    assert.equal([...source.matchAll(/process\.env/g)].length, 1, 'process.env nur im CLI-Einstieg');
    assert.equal([...source.matchAll(/process\.stderr\.write\(/g)].length, 1);
    assert.ok(source.includes('process.stderr.write(errorLine(error));'));

    for (const forbidden of [/\bconsole\b/, /\.message\b/, /\.bericht\b/, /\.stack\b/, /JSON\.stringify\(error/, /process\.stdout/, /\bfetch\b/, /\beval\b/, /child_process/]) {
      assert.ok(!forbidden.test(source), `verbotener Zugriff: ${forbidden}`);
    }
  }
});

// Einstiegserkennung: nur genau diese zwei Formen. Ohne import.meta.main (Node vor 22.18.0 und
// 24.2.0) darf ein Start nie ungeprueft mit Exitcode 0 enden. Gilt fuer alle fuenf Einstiege.
const EINSTIEG = {
  [JOB0_PATH]: 'if (import.meta.main === true) {\n  process.exitCode = await main(process.env);\n} else if (import.meta.main !== false) {\n  process.exitCode = await main({});\n}\n',
  [JOB2_PATH]: 'if (import.meta.main === true) {\n  process.exitCode = main(process.env);\n} else if (import.meta.main !== false) {\n  process.exitCode = main({});\n}\n',
  [JOB1A_PATH]: 'if (import.meta.main === true) {\n  process.exitCode = await main(process.env);\n} else if (import.meta.main !== false) {\n  process.exitCode = await main({});\n}\n',
  [JOB1B_PATH]: 'if (import.meta.main === true) {\n  process.exitCode = main(process.env);\n} else if (import.meta.main !== false) {\n  process.exitCode = main({});\n}\n',
  [JOB3_PATH]: 'if (import.meta.main === true) {\n  process.exitCode = await main(process.env);\n} else if (import.meta.main !== false) {\n  process.exitCode = await main({});\n}\n',
};
const UNSICHER = {
  [JOB0_PATH]: 'if (import.meta.main) {\n  process.exitCode = await main(process.env);\n}\n',
  [JOB2_PATH]: 'if (import.meta.main) {\n  process.exitCode = main(process.env);\n}\n',
  [JOB1A_PATH]: 'if (import.meta.main) {\n  process.exitCode = await main(process.env);\n}\n',
  [JOB1B_PATH]: 'if (import.meta.main) {\n  process.exitCode = main(process.env);\n}\n',
  [JOB3_PATH]: 'if (import.meta.main) {\n  process.exitCode = await main(process.env);\n}\n',
};

test('Wache: Einstiegserkennung nur in der fail-closed-Form, der alte Ausdruck und andere Erkennungen sind verboten', () => {
  assert.deepEqual(Object.keys(EINSTIEG).sort(), [...EINSTIEGE].sort());
  assert.deepEqual(Object.keys(UNSICHER).sort(), [...EINSTIEGE].sort());

  for (const path of EINSTIEGE) {
    const source = readFileSync(path, 'utf8');
    assert.ok(source.endsWith(EINSTIEG[path]), 'erlaubte Einstiegskonstruktion fehlt am Dateiende');
    assert.equal(source.split(EINSTIEG[path]).length, 2, 'Einstieg nicht genau einmal');
    assert.ok(!source.includes('if (import.meta.main) {'), 'unsicherer Ausdruck if (import.meta.main)');
    // import.meta nur in den zwei Zeilen der erlaubten Form; keine Erkennung ueber argv, url, filename oder require.main.
    assert.equal([...source.matchAll(/\bimport\.meta\b/g)].length, 2 + [...source.matchAll(/^\/\/.*import\.meta/gm)].length);
    assert.equal([...source.matchAll(/^(?:if|} else if) \(import\.meta\.main (?:=== true|!== false)\) \{$/gm)].length, 2);
    assert.ok(!/process\.argv|require\.main|import\.meta\.(url|filename|dirname|resolve)|module\.parent/.test(source), 'andere Einstiegserkennung');
    assert.equal([...source.matchAll(/process\.exitCode =/g)].length, 2);
    assert.equal([...source.matchAll(/main\(\{\}\)/g)].length, 1, 'Ersatzlauf mit leerem Vertrag fehlt');
  }
});

// Baut eine Kopie des Einstiegs, deren lokale Importe auf die echten Module zeigen. ersetze wandelt den
// Quelltext ab; so laesst sich unter Node 24 ein Lauf ohne import.meta.main nachstellen.
function einstiegKopie(path, ersetze) {
  let source = readFileSync(path, 'utf8').replace(/from '\.\/([^']+)'/g, (_, name) => `from '${new URL(`../scripts/${name}`, import.meta.url).href}'`);
  source = ersetze(source);
  const datei = join(newDir('einstieg-'), 'einstieg.mjs');
  writeFileSync(datei, source);
  return datei;
}

const cli = (args, env = { ...systemEnv() }) => SPAWN(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });

test('Laufzeit: ohne import.meta.main endet jeder Start mit job-umgebung-fehlt; der alte Ausdruck endete mit 0', () => {
  for (const path of EINSTIEGE) {
    // Nachstellung eines Node ohne import.meta.main: die Eigenschaft ist dann undefined.
    const fehlt = s => s.replaceAll('import.meta.main', 'import.meta.mainFehlt');
    const korrigiert = einstiegKopie(path, fehlt);
    const neu = cli([korrigiert]);
    assert.equal(neu.status, 1, neu.stderr);
    assert.equal(neu.stdout, '');
    assert.equal(neu.stderr, 'A6-FEHLER job-umgebung-fehlt\n');

    // Muss-Treffer: dieselbe Nachstellung mit dem frueheren Ausdruck endet ungeprueft mit 0.
    const alt = einstiegKopie(path, s => fehlt(s.replace(EINSTIEG[path], UNSICHER[path])));
    assert.ok(readFileSync(alt, 'utf8').includes('if (import.meta.mainFehlt) {'), 'Nachstellung des alten Ausdrucks fehlt');
    const vorher = cli([alt]);
    assert.equal(vorher.status, 0);
    assert.equal(vorher.stderr, '');

    // Mit unterstuetztem import.meta.main: direkter Start ohne Vertrag lehnt ab.
    const direkt = cli([path]);
    assert.equal(direkt.status, 1);
    assert.equal(direkt.stderr, 'A6-FEHLER job-umgebung-fehlt\n');
    assert.equal(direkt.stdout, '');

    // Import des Moduls fuehrt keine Job-Pruefung aus.
    const imp = cli(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path).href)});`]);
    assert.equal(imp.status, 0, imp.stderr);
    assert.equal(imp.stderr, '');
    assert.equal(imp.stdout, '');
  }

  assert.equal(typeof import.meta.main, 'boolean', 'diese Probe setzt ein Node mit import.meta.main voraus');
});

// A6 P-1: Einzige Ausnahme ist agent-auftrag.yml mit genau dem genehmigten SHA-256 (Zeilenenden LF). Jede
// andere Fassung und jeder andere Workflow, der auf einen Job-Einstieg verweist, bleibt rot.
const A6_WORKFLOW_SHA256 = 'd5bb6eaa3d16e2bd964c2466b8c2befa343c751703d0c8961d0b7026700eb20f';
// Ausweichfassung (b) von code-pilot-trockenlauf.yml mit denselben Probejobs; nur genau diese Fassung.
const A6_AUSWEICH_SHA256 = '02b04a82b4eeab1a8e438e2a4c48a62334a8debbab49750908b3957f4f25a0b0';

test('Wache: ausser dem genehmigten agent-auftrag.yml ruft kein Workflow die Job-Einstiege auf; genau diese fuenf Einstiege und die Hilfsdatei, keine weitere Jobdatei', () => {
  const workflows = join(ROOT, '.github', 'workflows');
  const files = readdirSync(workflows).filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.length >= 10, 'Gegenprobe: zu wenige Workflows gefunden');
  const text = name => readFileSync(join(workflows, name), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(files.some(name => text(name).includes('agent-code-package')), 'Gegenprobe ohne Treffer');

  if (files.includes('agent-auftrag.yml')) {
    assert.equal(sha256(Buffer.from(text('agent-auftrag.yml'), 'utf8')), A6_WORKFLOW_SHA256, 'agent-auftrag.yml ist nicht der genehmigte Stand');
  }

  const genehmigt = name => name === 'agent-auftrag.yml' || (name === 'code-pilot-trockenlauf.yml' && sha256(Buffer.from(text(name), 'utf8')) === A6_AUSWEICH_SHA256);
  const andere = files.filter(name => !genehmigt(name));
  assert.ok(andere.every(name => !/agent-code-job|agent-auftrag\.yml/.test(text(name))), 'ein Workflow verweist auf einen Job-Einstieg');

  // Kein anderes Skript verweist auf die Job-Skripte.
  const names = readdirSync(SCRIPTS).filter(name => name.endsWith('.mjs'));
  const jobs = names.filter(name => name.startsWith('agent-code-job'));
  // Exakte Liste ohne Platzhalter: jede zusaetzliche Jobdatei braucht eine eigene Freigabe.
  assert.deepEqual(jobs.sort(), [
    'agent-code-job-abnahme.mjs',
    'agent-code-job-auftrag.mjs',
    'agent-code-job-claude-nach.mjs',
    'agent-code-job-claude-vor.mjs',
    'agent-code-job-gemeinsam.mjs',
    'agent-code-job-veroeffentlichen.mjs',
  ]);
  const others = names.filter(name => !jobs.includes(name)).map(readScript);
  assert.ok(others.length >= 10);
  assert.ok(others.every(text => !text.includes('agent-code-job')), 'ein anderes Skript verweist auf ein Job-Skript');
});

test('Wache: in dieser Testdatei wurde kein Socket verbunden', () => {
  assert.equal(socketVersuche, 0);
  // Muss-Treffer: der Waechter greift tatsaechlich.
  assert.throws(() => new net.Socket().connect(1, '127.0.0.1'), /Socket im Jobtest verboten/);
  assert.equal(socketVersuche, 1);
  socketVersuche = 0;
});
