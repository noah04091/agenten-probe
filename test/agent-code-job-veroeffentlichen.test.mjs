// A6.4-2c-2: Offline-Tests des Einstiegs Job 3 (Veroeffentlichung als Draft-PR).
//
// Alles offline und synthetisch: kein echtes Token, kein GitHub-Aufruf, kein Socket, keine echte
// Schreiboperation. Job 3 laeuft im Prozess. https.request wird wie in den Transporttests durch eine
// Attrappe ersetzt; hinter ihr steht ein kleiner GitHub-Simulator (nach dem Vorbild der Tests des
// Veroeffentlichers, nur die noetigen Helfer uebernommen), der Lesen wie die Live-Pruefung beantwortet
// und Schreibaufrufe als echte Git-Objekte in einem temporaeren Repository anlegt. So laufen der echte
// Veroeffentlichungstransport und der echte Veroeffentlicher vollstaendig durch.
//
// Zeitpunkte: Die Freigabe liegt wenige Minuten vor dem Start dieser Datei, fuer die Fristfaelle
// gezielt 58,5 und 61 Minuten zurueck. Job 3 nimmt keinen Zeitwert entgegen; die echte Uhr laeuft.
//
// Was diese Tests NICHT zeigen: echte TLS-Verbindung zu GitHub, echte Rechte und Installation des
// App-Tokens, echte Rate-Limits, Frische des Pruef-Checkouts im Workflow, Artefaktidentitaet, Bindung
// an den Erfolg von Job 2, Job- und Workflow-Zeitlimits, K1 bis K4, Aktivierung.

import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { orderSha256, resolveOrder } from '../scripts/agent-code-auftrag.mjs';
import { WORKFLOW_PATH } from '../scripts/agent-code-auftrag-live.mjs';
import { createPackageV2, prepareWorkspace } from '../scripts/agent-code-auftrag-paket.mjs';
import { BRANCH_RESERVE_MS } from '../scripts/agent-code-auftrag-publish.mjs';
import { createPublishTransport } from '../scripts/agent-code-auftrag-transport.mjs';
import { SECRET_NAMES, WORKFLOW_REF, readVeroeffentlichenContract } from '../scripts/agent-code-job-gemeinsam.mjs';
import { main as mainVeroeffentlichen } from '../scripts/agent-code-job-veroeffentlichen.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXEC = cp.execFileSync;
const sha256 = data => createHash('sha256').update(data).digest('hex');

const REPO_NAME = 'noah04091/agenten-probe';
const P = `/repos/${REPO_NAME}/`;
// Erfundene Werte nur fuer diese Tests, ohne Wirkung.
const APP_TOKEN = 'ghs_NurTestOhneWirkung_job3_0123456789abcdef';
const LESE_TOKEN = 'ghs_NurTestOhneWirkung_lese_0123456789abcdef';
const OWNER = Object.freeze({ login: 'noah04091', id: 1, type: 'User' });
const ISSUE = 6701;
const RUN_ID = '7900006701';
const BRANCH = `wp/${ISSUE}-agent-${RUN_ID}-1`;
const ISSUE_MARKER = 'ISSUE-MARKER-unvertrauenswuerdig';
const PR_MARKER = 'PR-MARKER-antwort';
const FEHLER_ZEILE_RE = /^A6-FEHLER [a-z][a-z0-9-]{0,62}[a-z0-9]\n$/;
const TIMEOUT_MS = 20_000;
const MIN = 60_000;

const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
const sekunde = () => Math.floor(Date.now() / 1000) * 1000;
const JETZT = sekunde();

// ---------------------------------------------------------------------------
// Socket-Waechter
// ---------------------------------------------------------------------------

const ORIGINAL_REQUEST = https.request;
const ORIGINAL_CONNECT = net.Socket.prototype.connect;
let socketVersuche = 0;

net.Socket.prototype.connect = function verboten() {
  socketVersuche += 1;
  throw new Error('Socket im Veroeffentlichungstest verboten');
};

afterEach(() => {
  https.request = ORIGINAL_REQUEST;
});

// ---------------------------------------------------------------------------
// Synthetisches Repository
// ---------------------------------------------------------------------------

const RECHNE_ALT = '// Synthetischer Rechner fuer A6.4-2c-2.\nfunction addiere(a, b) {\n  return a + b;\n}\n\nmodule.exports = { addiere };\n';
const RECHNE_NEU = RECHNE_ALT.replace('module.exports = { addiere };', 'function quadrat(a) {\n  return a * a;\n}\n\nmodule.exports = { addiere, quadrat };');
const TEST_ALT = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { addiere } = require('../src/rechne.js');\n\ntest('addiere', () => assert.equal(addiere(2, 3), 5));\n";
const TEST_NEU = `${TEST_ALT}\ntest('quadrat', () => assert.equal(require('../src/rechne.js').quadrat(3), 9));\n`;
const DRAFT_POLICY = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'agent-policy.entwurf.json'), 'utf8'));
const POLICY_BYTES = Buffer.from(`${JSON.stringify({ ...DRAFT_POLICY, skript_hashes: { 'scripts/agent-profile.mjs': 'a'.repeat(64) } }, null, 2)}\n`, 'utf8');

const BASE_FILES = Object.freeze({
  '.github/agent/policy.json': POLICY_BYTES,
  'agent-profiles/js-rechner.json': readFileSync(join(ROOT, 'agent-profiles', 'js-rechner.json')),
  'src/rechne.js': Buffer.from(RECHNE_ALT),
  'test/rechne.test.js': Buffer.from(TEST_ALT),
  'README.md': Buffer.from('# Probe\n'),
  [`agent-acceptance/issue-${ISSUE}.mjs`]: Buffer.from('// Synthetische Abnahme, in diesen Tests nie ausgefuehrt.\nexport const synthetisch = true;\n'),
});

const WINDOWS_KEYS = ['SystemRoot', 'PATHEXT', 'ComSpec', 'windir'];
const systemEnv = () => Object.fromEntries(WINDOWS_KEYS.map(key => [key, process.env[key]]).filter(([, value]) => typeof value === 'string'));

let BASE_DIR;
let ENV;
let REPO;
let BASIS;
let TRUSTED;
let TEMPLATE;

function gitIn(cwd, args, input, extraEnv = {}) {
  return EXEC('git', args, {
    cwd, env: { ...ENV, ...extraEnv }, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

const git = (args, input, extraEnv) => gitIn(REPO, args, input, extraEnv);
let counter = 0;
const newDir = prefix => mkdtempSync(join(BASE_DIR, `${prefix}${(counter += 1)}-`));

function checkout(dir) {
  cpSync(TEMPLATE, dir, { recursive: true });
  return dir;
}

before(() => {
  BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-code-job-veroeffentlichen-test-'));
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
  git(['init', '-q']);
  git(['read-tree', '--empty']);

  for (const [path, content] of Object.entries(BASE_FILES)) {
    git(['update-index', '--add', '--cacheinfo', `100644,${git(['hash-object', '-w', '--stdin'], content)},${path}`]);
  }

  BASIS = git(['commit-tree', git(['write-tree']), '-m', 'Synthetischer Ausgangscommit'], undefined, { GIT_AUTHOR_DATE: '2026-11-15T08:00:00Z', GIT_COMMITTER_DATE: '2026-11-15T08:00:00Z' });
  git(['update-ref', 'refs/heads/main', BASIS]);
  git(['read-tree', '--empty']);
  TEMPLATE = join(BASE_DIR, 'vorlage');
  EXEC('git', ['clone', '-q', '--no-checkout', REPO, TEMPLATE], { env: ENV, stdio: 'ignore' });
  gitIn(TEMPLATE, ['checkout', '-q', '--detach', BASIS]);
  TRUSTED = checkout(join(BASE_DIR, 'vertraut'));
});

after(() => {
  net.Socket.prototype.connect = ORIGINAL_CONNECT;
  https.request = ORIGINAL_REQUEST;
  rmSync(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Szenario: Freigabezeit, Auftrag, Paket
// ---------------------------------------------------------------------------

const label = name => ({ name, color: 'ededed' });

function szenario(approvalMs = JETZT - 2 * MIN) {
  const approval = iso(approvalMs);
  const runCreated = iso(approvalMs + 2000);
  const titel = `Synthetisch A6.4-2c-2: Veroeffentlichung ${ISSUE_MARKER}`;
  const text = `Kuenstlicher Auftrag fuer den Veroeffentlichungstest. ${ISSUE_MARKER}`;
  const issue = { number: ISSUE, state: 'open', title: titel, body: text, updated_at: approval, comments: 0, user: { ...OWNER }, labels: [label('bot-auftrag'), label('agent:js-rechner')] };
  const payload = { action: 'labeled', label: label('bot-auftrag'), sender: { ...OWNER }, repository: { full_name: REPO_NAME }, issue: { number: ISSUE, title: titel, body: text, updated_at: approval } };
  const events = [
    { id: 670101, event: 'labeled', created_at: iso(approvalMs - MIN), actor: { ...OWNER }, label: label('agent:js-rechner'), performed_via_github_app: null },
    { id: 670102, event: 'labeled', created_at: approval, actor: { ...OWNER }, label: label('bot-auftrag'), performed_via_github_app: null },
  ];
  const run = {
    id: Number(RUN_ID), event: 'issues', path: WORKFLOW_PATH, head_branch: 'main', head_sha: BASIS, run_attempt: 1, status: 'in_progress', created_at: runCreated,
    actor: { ...OWNER }, triggering_actor: { ...OWNER }, repository: { full_name: REPO_NAME }, head_repository: { full_name: REPO_NAME },
  };
  // Der Auftrag haengt nicht von now ab; now muss nur innerhalb der Frist liegen.
  const order = resolveOrder({
    root: TRUSTED, baseSha: BASIS, gitEnv: { ...ENV }, repository: REPO_NAME, event: payload, issue, events, run: { id: RUN_ID, attempt: 1, createdAt: runCreated }, now: new Date(approvalMs + MIN),
  });
  const orderSha = orderSha256(order);
  const work = prepareWorkspace(TRUSTED, order, orderSha, join(newDir('w-'), 'arbeit'), { gitEnv: { ...ENV } }).arbeitsordner;
  writeFileSync(join(work, 'src', 'rechne.js'), RECHNE_NEU);
  writeFileSync(join(work, 'test', 'rechne.test.js'), TEST_NEU);
  const pkg = createPackageV2(TRUSTED, order, orderSha, work);
  return Object.freeze({ issue, payload, events, run, order, orderSha, packageText: pkg.text, packageSha: pkg.sha256 });
}

let STANDARD = null;
const standard = () => (STANDARD ??= szenario());

// ---------------------------------------------------------------------------
// GitHub-Simulator hinter der https.request-Attrappe
// ---------------------------------------------------------------------------

const ok = json => ({ status: 200, body: JSON.stringify(json) });
const created = json => ({ status: 201, body: JSON.stringify(json) });
const notFound = () => ({ status: 404, body: '{"message":"Not Found"}' });
const unprocessable = () => ({ status: 422, body: '{"message":"Reference already exists"}' });
const HAENGT = Symbol('haengt');

function readTreeObject(sha) {
  try {
    if (!/^[0-9a-f]{40}$/.test(sha) || git(['cat-file', '-t', sha]) !== 'tree') {
      return notFound();
    }
  } catch {
    return notFound();
  }

  const tree = gitIn(REPO, ['ls-tree', '-r', '-t', '-z', sha]).split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s.exec(line);
    return { path: match[4], mode: match[1], type: match[2], sha: match[3], url: 'x' };
  });
  return ok({ sha, url: 'x', tree, truncated: false });
}

function readCommitObject(sha) {
  let raw;

  try {
    raw = git(['cat-file', 'commit', sha]);
  } catch {
    return notFound();
  }

  const [head, ...rest] = raw.split('\n\n');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)[1];
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(match => ({ sha: match[1], url: 'x', html_url: 'x' }));
  return ok({ sha, url: 'x', tree: { sha: tree, url: 'x' }, parents, message: rest.join('\n\n'), author: { name: 'Test' } });
}

function compareObjects(base, head) {
  const commits = git(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
  const behind = Number(git(['rev-list', '--count', `${head}..${base}`]));
  const raw = gitIn(REPO, ['diff-tree', '-r', '-z', '--no-renames', '--raw', base, head]).split('\0').filter(Boolean);
  const files = [];

  for (let i = 0; i < raw.length; i += 2) {
    const [, , , newSha, letter] = raw[i].split(' ');
    files.push({ sha: newSha, filename: raw[i + 1], status: { M: 'modified', A: 'added', D: 'removed' }[letter], additions: 1, deletions: 0 });
  }

  return ok({
    status: behind === 0 ? (commits.length > 0 ? 'ahead' : 'identical') : 'diverged',
    ahead_by: commits.length, behind_by: behind, total_commits: commits.length, commits: commits.map(sha => ({ sha, url: 'x' })), files,
  });
}

const pullRecord = (number, ref) => ({
  number, state: 'closed', draft: false, html_url: `https://github.com/${REPO_NAME}/pull/${number}`,
  head: { ref, repo: { full_name: REPO_NAME } }, base: { ref: 'main', repo: { full_name: REPO_NAME } },
});

function handle(sim, req) {
  const rest = req.path.slice(P.length);

  if (req.method === 'GET') {
    // Jede Lauf-ID bekommt den simulierten Lauf; ob er passt, entscheidet die Live-Pruefung.
    if (/^actions\/runs\/[0-9]+$/.test(rest)) {
      return ok(sim.run);
    }

    if (rest === 'git/ref/heads/main') {
      return ok({ ref: 'refs/heads/main', node_id: 'x', url: 'x', object: { sha: sim.mainSha, type: 'commit', url: 'x' } });
    }

    if (rest === `issues/${ISSUE}`) {
      return ok(sim.issue);
    }

    if (rest === `issues/${ISSUE}/events?per_page=100&page=1`) {
      return ok(sim.events);
    }

    if (rest === `git/matching-refs/heads/wp/${ISSUE}-`) {
      return ok([...sim.refs].filter(([name]) => name.startsWith(`refs/heads/wp/${ISSUE}-`)).map(([ref, sha]) => ({ ref, object: { sha, type: 'commit', url: 'x' } })));
    }

    if (rest === 'pulls?state=all&sort=created&direction=asc&per_page=100&page=1') {
      return ok(sim.pulls);
    }

    if (rest.startsWith('git/ref/heads/')) {
      const ref = `refs/heads/${rest.slice('git/ref/heads/'.length)}`;
      return sim.refs.has(ref) ? ok({ ref, node_id: 'x', url: 'x', object: { sha: sim.refs.get(ref), type: 'commit', url: 'x' } }) : notFound();
    }

    if (rest.startsWith('git/commits/')) {
      return readCommitObject(rest.slice('git/commits/'.length));
    }

    const treeMatch = /^git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(rest);

    if (treeMatch) {
      return readTreeObject(treeMatch[1]);
    }

    const compareMatch = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest);
    return compareMatch ? compareObjects(compareMatch[1], compareMatch[2]) : notFound();
  }

  const body = req.body === undefined ? undefined : JSON.parse(req.body);

  if (req.method === 'POST' && rest === 'git/blobs') {
    return created({ sha: git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')), url: 'x' });
  }

  if (req.method === 'POST' && rest === 'git/trees') {
    const indexEnv = { GIT_INDEX_FILE: join(BASE_DIR, 'sim-index') };
    git(['read-tree', body.base_tree], undefined, indexEnv);

    for (const entry of body.tree) {
      git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`], undefined, indexEnv);
    }

    return created({ sha: git(['write-tree'], undefined, indexEnv), url: 'x', tree: [], truncated: false });
  }

  if (req.method === 'POST' && rest === 'git/commits') {
    const sha = git(['commit-tree', body.tree, ...body.parents.flatMap(parent => ['-p', parent]), '-m', body.message], undefined, { GIT_AUTHOR_DATE: '2026-11-15T09:00:00Z', GIT_COMMITTER_DATE: '2026-11-15T09:00:00Z' });
    return created({ sha, url: 'x', tree: { sha: body.tree }, parents: body.parents.map(parent => ({ sha: parent })), message: body.message });
  }

  if (req.method === 'POST' && rest === 'git/refs') {
    if (sim.refs.has(body.ref)) {
      return unprocessable();
    }

    sim.refs.set(body.ref, body.sha);
    return created({ ref: body.ref, node_id: 'x', url: 'x', object: { sha: body.sha, type: 'commit', url: 'x' } });
  }

  if (req.method === 'POST' && rest === 'pulls') {
    const number = sim.nextPr;
    sim.nextPr += 1;
    const neu = pullRecord(number, body.head);
    const record = { ...neu, head: { ...neu.head, sha: sim.refs.get(`refs/heads/${body.head}`) }, state: 'open', draft: body.draft, title: body.title, body: body.body };
    sim.pulls.push(record);
    return created(record);
  }

  if (req.method === 'DELETE' && rest.startsWith('git/refs/heads/')) {
    const ref = `refs/heads/${rest.slice('git/refs/heads/'.length)}`;

    if (!sim.refs.has(ref)) {
      return { status: 422, body: '{"message":"Reference does not exist"}' };
    }

    sim.refs.delete(ref);
    return { status: 204, body: '' };
  }

  return notFound();
}

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

  end(body) {
    queueMicrotask(() => {
      const res0 = this.antwort({ method: this.options.method, path: this.options.path, body, headers: this.options.headers, host: this.options.hostname });

      if (res0 === HAENGT) {
        return;
      }

      const res = new Readable({ read() {} });
      res.statusCode = res0.status;
      res.rawHeaders = [];
      res.headers = {};
      res.complete = true;
      this.onResponse(res);

      if (res0.body !== '') {
        res.push(Buffer.from(res0.body, 'utf8'));
      }

      res.push(null);
    });
    return this;
  }

  destroy() {
    return this;
  }
}

// override(req, sim): eigene Antwort oder undefined. Jede Anfrage wird mit Kopfzeilen protokolliert.
function createSim(sz = standard()) {
  const sim = {
    issue: structuredClone(sz.issue), events: structuredClone(sz.events), run: structuredClone(sz.run), mainSha: BASIS,
    refs: new Map(), pulls: [pullRecord(1, 'wp/1-anderes')], nextPr: 9001, log: [], override: null, haengend: false,
  };
  sim.install = () => {
    https.request = (options, onResponse) => new FakeRequest(options, onResponse, req => {
      sim.log.push(req);
      const eigen = sim.override?.(req, sim);

      if (eigen === HAENGT) {
        sim.haengend = true;
      }

      return eigen ?? handle(sim, req);
    });
  };
  return sim;
}

const restOf = req => req.path.slice(P.length);
const writes = sim => sim.log.filter(req => req.method !== 'GET').map(req => `${req.method} ${restOf(req)}`);
const WRITES_OK = Object.freeze(['POST git/blobs', 'POST git/blobs', 'POST git/trees', 'POST git/commits', 'POST git/refs', 'POST pulls']);
const prPosts = sim => sim.log.filter(req => req.method === 'POST' && restOf(req) === 'pulls').length;

// ---------------------------------------------------------------------------
// Job 3 im Prozess
// ---------------------------------------------------------------------------

function umgebung(temp, sz) {
  return {
    ...systemEnv(),
    GITHUB_REPOSITORY: REPO_NAME,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_EVENT_PATH: join(temp, '_github_workflow', 'event.json'),
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: BASIS,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_WORKSPACE: TRUSTED,
    GITHUB_OUTPUT: join(temp, '_runner_file_commands', 'set_output_test'),
    RUNNER_TEMP: temp,
    PATH: process.env.PATH,
    A6_AUFTRAG_SHA256: sz.orderSha,
    A6_PAKET_SHA256: sz.packageSha,
    A6_APP_TOKEN: APP_TOKEN,
  };
}

const ohneUndefined = env => Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));

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

  return { code, stderr: err.join('') };
}

function vorbereiten(sz, { packageBytes, ohnePruefCheckout = false } = {}) {
  const temp = newDir('t3-');
  mkdirSync(join(temp, '_github_workflow'));
  mkdirSync(join(temp, '_runner_file_commands'));
  writeFileSync(join(temp, '_github_workflow', 'event.json'), JSON.stringify(sz.payload));
  writeFileSync(join(temp, '_runner_file_commands', 'set_output_test'), '');
  mkdirSync(join(temp, 'a6-paket'));
  writeFileSync(join(temp, 'a6-paket', 'paket-v2.json'), packageBytes ?? Buffer.from(sz.packageText, 'utf8'));

  if (!ohnePruefCheckout) {
    checkout(join(temp, 'a6-veroeffentlichung-pruefung'));
  }

  return temp;
}

async function job3({ sz = standard(), sim = createSim(sz), envMod = {}, packageBytes, ohnePruefCheckout, waehrend } = {}) {
  const temp = vorbereiten(sz, { packageBytes, ohnePruefCheckout });
  const env = ohneUndefined({ ...umgebung(temp, sz), ...envMod });
  sim.install();
  const lauf = fange(() => mainVeroeffentlichen(env)).then(r => { sim.ende = true; return r; });
  await waehrend?.(sim);
  const r = await lauf;
  return { ...r, sim, temp, env, output: readFileSync(env.GITHUB_OUTPUT ?? join(temp, '_runner_file_commands', 'set_output_test'), 'utf8') };
}

function abgelehnt(r, code) {
  assert.equal(r.code, 1, `keine Ablehnung, erwartet ${code}`);
  assert.equal(r.stderr, `A6-FEHLER ${code}\n`);
  assert.ok(FEHLER_ZEILE_RE.test(r.stderr));
  assert.equal(r.output, '', 'Job 3 hat eine Ausgabe geschrieben');

  for (const marker of [ISSUE_MARKER, PR_MARKER, APP_TOKEN, APP_TOKEN.slice(4), LESE_TOKEN, 'wp/', 'https:', 'bericht', 'Gateway']) {
    assert.ok(!r.stderr.includes(marker), `${marker} im Protokoll`);
  }
}

// ===========================================================================
// Positiver Ablauf
// ===========================================================================

test('Positiv Job 3: vollstaendiger synthetischer Ablauf ueber den echten Transport, genau ein Draft-PR, keine Ausgabe', async () => {
  const r = await job3();
  assert.equal(r.stderr, '', r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.output, '', 'keine eigene Job-Ausgabe, keine PR-Nummer');

  // Blobs, Baum, Commit, Branch und PR in genau dieser Reihenfolge, genau ein POST pulls.
  assert.deepEqual(writes(r.sim), WRITES_OK);
  assert.equal(prPosts(r.sim), 1);
  const pr = r.sim.pulls.at(-1);
  assert.equal(pr.draft, true);
  assert.equal(pr.head.ref, BRANCH);
  assert.equal(r.sim.refs.get(`refs/heads/${BRANCH}`), pr.head.sha);
  assert.equal(git(['show', `${pr.head.sha}:src/rechne.js`]), RECHNE_NEU.trim());
  assert.equal(git(['rev-parse', `${pr.head.sha}^@`]), BASIS);

  // Jede Anfrage: api.github.com, App-Token, nie der Lesetoken; keine Issue-Kommentare, keine fremden Pfade.
  assert.ok(r.sim.log.length > 10);
  assert.ok(r.sim.log.every(req => req.host === 'api.github.com' && req.headers.Authorization === `Bearer ${APP_TOKEN}`));
  assert.ok(r.sim.log.every(req => req.path.startsWith(P) && !/comments|issues\/\d+\/labels/.test(req.path)));
  assert.ok(!JSON.stringify(r.sim.log.map(req => req.body ?? '')).includes(ISSUE_MARKER), 'Issue-Inhalt in einer Schreibanfrage');

  // Der vertrauenswuerdige Checkout bleibt sauber; nur der Pruef-Checkout wurde beschrieben.
  assert.equal(gitIn(TRUSTED, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']), '');
  assert.notEqual(gitIn(join(r.temp, 'a6-veroeffentlichung-pruefung'), ['status', '--porcelain']), '');
  assert.deepEqual(readdirSync(r.temp).sort(), ['_github_workflow', '_runner_file_commands', 'a6-paket', 'a6-veroeffentlichen-home', 'a6-veroeffentlichung-pruefung']);
});

test('Doppelte PR-Anfrage: ein zweiter Lauf fuer denselben Auftrag schreibt nichts mehr', async () => {
  const sim = createSim();
  const erster = await job3({ sim });
  assert.equal(erster.code, 0, erster.stderr);
  const vorher = sim.log.length;
  const zweiter = await job3({ sim });
  abgelehnt(zweiter, 'live-branch-vorhanden');
  assert.deepEqual(writes({ log: sim.log.slice(vorher) }), [], 'zweiter Lauf hat geschrieben');
  assert.equal(prPosts(sim), 1);
});

// ===========================================================================
// Vertrag, Hashes und Token
// ===========================================================================

test('Job 3 Vertrag: Auftrags-Hash, Paket-Hash, Lauf, Laufversuch, Repository, Workflow, Ereignis, Pruef-Checkout', async () => {
  const andere = Buffer.from(standard().packageText.replace('"bytes":', '"bytes" :'), 'utf8');
  const faelle = [
    [{ envMod: { A6_PAKET_SHA256: 'b'.repeat(64) } }, 'job-paket-hash', 0],
    [{ packageBytes: andere }, 'job-paket-hash', 0],
    [{ envMod: { A6_PAKET_SHA256: 'B'.repeat(64) } }, 'job-hash-format', 0],
    [{ envMod: { A6_AUFTRAG_SHA256: undefined } }, 'job-umgebung-fehlt', 0],
    [{ envMod: { GITHUB_RUN_ATTEMPT: '2' } }, 'job-lauf-versuch', 0],
    [{ envMod: { GITHUB_REPOSITORY: 'noah04091/anderes' } }, 'job-repository', 0],
    [{ envMod: { GITHUB_WORKFLOW_REF: `${REPO_NAME}/.github/workflows/agent-code.yml@refs/heads/main` } }, 'job-workflow', 0],
    [{ envMod: { GITHUB_EVENT_PATH: join(tmpdir(), 'event.json') } }, 'job-ereignis-pfad', 0],
    [{ ohnePruefCheckout: true }, 'job-pruef-checkout', 0],
  ];

  for (const [optionen, code, anfragen] of faelle) {
    const r = await job3(optionen);
    abgelehnt(r, code);
    assert.equal(r.sim.log.length, anfragen, `${code}: Anfragen trotz Ablehnung`);
  }

  // Falscher Auftrags-Hash: der Veroeffentlicher lehnt in Phase A ohne Schreibaufruf ab.
  const falsch = await job3({ envMod: { A6_AUFTRAG_SHA256: 'a'.repeat(64) } });
  abgelehnt(falsch, 'auftrag-abweichung');
  assert.deepEqual(writes(falsch.sim), []);

  // Falscher Lauf: die Live-Pruefung findet einen anderen Lauf.
  const lauf = await job3({ envMod: { GITHUB_RUN_ID: '7900009999' } });
  abgelehnt(lauf, 'live-lauf-id-abweichung');
  assert.deepEqual(writes(lauf.sim), []);
});

test('Job 3 Token: fremder Token, persoenliches Token, fehlender App-Token, Vergleichswerte, Node-Schalter', async () => {
  const faelle = [
    [{ A6_LESE_TOKEN: LESE_TOKEN }, 'job-umgebung-geheimnis'],
    [{ GITHUB_TOKEN: 'x' }, 'job-umgebung-geheimnis'],
    [{ A6_VERGLEICH_ANTHROPIC: 'Synth-Vergleichswert-ohne-Wirkung' }, 'job-umgebung-geheimnis'],
    [{ A6_APP_TOKEN: `ghp_${'A'.repeat(36)}` }, 'transport-token'],
    [{ A6_APP_TOKEN: `github_pat_${'B'.repeat(40)}` }, 'transport-token'],
    [{ A6_APP_TOKEN: undefined }, 'job-umgebung-fehlt'],
    [{ NODE_OPTIONS: '--require ./x.cjs' }, 'job-umgebung-node'],
  ];

  for (const [envMod, code] of faelle) {
    const r = await job3({ envMod });
    abgelehnt(r, code);
    assert.equal(r.sim.log.length, 0, `${code}: Anfrage trotz Ablehnung`);
  }

  assert.deepEqual([...SECRET_NAMES.veroeffentlichen], ['A6_APP_TOKEN']);
});

test('Job 3 Endpunkt: der Veroeffentlichungstransport nimmt keinen unzulaessigen Pfad an und ruft dafuer nie https.request', async () => {
  let netz = 0;
  https.request = () => {
    netz += 1;
    throw new Error('darf nicht erreicht werden');
  };
  const transport = createPublishTransport({ token: APP_TOKEN, issueNumber: ISSUE, runId: RUN_ID });

  for (const [method, path, body] of [
    ['GET', `${P}issues/${ISSUE}/comments`],
    ['POST', `${P}issues/${ISSUE}/comments`, '{"body":"x"}'],
    ['DELETE', `${P}git/refs/heads/main`],
    ['PATCH', `${P}pulls/1`, '{}'],
    ['GET', '/repos/fremd/repo/pulls'],
    ['POST', `${P}git/refs/heads/wp/${ISSUE}-agent-${RUN_ID}-1`, '{}'],
  ]) {
    await assert.rejects(Promise.resolve().then(() => transport(body === undefined ? { method, path } : { method, path, body })), error => /^transport-/.test(error.code));
  }

  assert.equal(netz, 0);
});

// ===========================================================================
// Live-Pruefung, PR-Status, Zeitlimit, Fehlermeldungen, Fristen
// ===========================================================================

test('Job 3 Live: fehlgeschlagene Live-Pruefung (frueherer PR, main, Issue) schreibt nichts', async () => {
  for (const [aendern, code] of [
    [sim => sim.pulls.push(pullRecord(2, `wp/${ISSUE}-frueher`)), 'live-pr-vorhanden'],
    [sim => { sim.mainSha = '1'.repeat(40); }, 'live-main-geaendert'],
    [sim => { sim.issue.updated_at = iso(JETZT); }, 'auftrag-issue-geaendert'],
  ]) {
    const sim = createSim();
    aendern(sim);
    const r = await job3({ sim });
    abgelehnt(r, code);
    assert.deepEqual(writes(sim), []);
  }
});

test('Job 3 unklarer PR-Status: kein Retry, keine Loeschung, nur der feste Code ohne Antworttext', async () => {
  const sim = createSim();
  sim.override = req => (req.method === 'POST' && restOf(req) === 'pulls'
    ? { status: 502, body: JSON.stringify({ message: `${PR_MARKER} Bad Gateway`, documentation_url: 'https://docs.github.com/x' }) }
    : undefined);
  const r = await job3({ sim });
  abgelehnt(r, 'publish-http-status');
  assert.equal(prPosts(sim), 1, 'POST pulls wiederholt');
  assert.deepEqual(writes(sim), WRITES_OK, 'nach der PR-Anfrage weitere Schreibaufrufe');
  assert.equal(sim.log.at(-1).method, 'POST', 'nach der PR-Anfrage weitere Anfragen');
  assert.ok(sim.refs.has(`refs/heads/${BRANCH}`), 'Branch nach unklarem Status geloescht');
});

test('Job 3 untrusted Fehlermeldung: abgelehnte Branch-Anlage mit fremdem Text erscheint nur als fester Code', async () => {
  const sim = createSim();
  sim.override = req => (req.method === 'POST' && restOf(req) === 'git/refs'
    ? { status: 422, body: JSON.stringify({ message: `${PR_MARKER}\n::error::eingeschleust ${APP_TOKEN}` }) }
    : undefined);
  const r = await job3({ sim });
  abgelehnt(r, 'publish-http-status');
  assert.ok(!r.stderr.includes('::'), 'Steuerzeile im Protokoll');
  assert.equal(prPosts(sim), 0);
});

// Das Live-Modul fasst jeden Transportfehler zum festen Code live-transport-fehler zusammen; dass die
// Ursache das Zeitlimit des Transports ist, belegt der Uhrschritt (vor 20 000 ms kein Ende).
test('Job 3 Zeitlimit: eine haengende Antwort endet erst nach 20 Sekunden mit festem Code, ohne Retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sim = createSim();
  sim.override = req => (req.method === 'GET' && restOf(req) === `actions/runs/${RUN_ID}` ? HAENGT : undefined);
  const r = await job3({
    sim,
    waehrend: async s => {
      for (let i = 0; i < 2000 && !s.haengend; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }

      assert.ok(s.haengend, 'Muss-Treffer: die Anfrage haengt');
      t.mock.timers.tick(TIMEOUT_MS - 1);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(s.log.length, 1, 'vor Ablauf keine weitere Anfrage');
      assert.equal(s.ende, undefined, 'vor Ablauf schon beendet');
      t.mock.timers.tick(1);
    },
  });
  abgelehnt(r, 'live-transport-fehler');
  assert.equal(sim.log.length, 1, 'Anfrage wiederholt');
});

test('Job 3 Fristen: fehlende Branchreserve bei 58,5 Minuten und abgelaufene Freigabe bei 61 Minuten schreiben nichts', async () => {
  // Reserve: Auftrag gueltig (unter 60 Minuten), aber weniger als BRANCH_RESERVE_MS bis zur Frist.
  assert.equal(BRANCH_RESERVE_MS, 120_000);
  const knapp = szenario(sekunde() - 58.5 * MIN);
  const r1 = await job3({ sz: knapp, sim: createSim(knapp) });
  abgelehnt(r1, 'publish-freigabe-reserve');
  assert.deepEqual(writes(r1.sim), [], 'Upload trotz fehlender Reserve');

  // Frist: die Freigabe ist aelter als 60 Minuten.
  const alt = szenario(sekunde() - 61 * MIN);
  const r2 = await job3({ sz: alt, sim: createSim(alt) });
  abgelehnt(r2, 'auftrag-freigabe-abgelaufen');
  assert.deepEqual(writes(r2.sim), []);

  // Muss-Treffer: dasselbe Verfahren mit frischer Freigabe veroeffentlicht.
  const frisch = szenario(sekunde() - 5 * MIN);
  const r3 = await job3({ sz: frisch, sim: createSim(frisch) });
  assert.equal(r3.code, 0, r3.stderr);
});

// ===========================================================================
// Vertrag und Regression
// ===========================================================================

test('Vertrag: Job 3 liest nur die festen Namen, kennt keine Ausgabedatei und keinen Lesetoken', () => {
  const temp = newDir('v-');
  mkdirSync(join(temp, '_github_workflow'));
  const v = readVeroeffentlichenContract({ ...umgebung(temp, standard()), UNBEKANNT: 'egal' });
  assert.deepEqual(Object.keys(v), ['repository', 'runId', 'baseSha', 'workspace', 'runnerTemp', 'eventPath', 'path', 'system', 'orderSha256', 'packageSha256', 'token']);
  assert.ok(Object.isFrozen(v));
  assert.equal(v.token, APP_TOKEN);
  assert.ok(!('outputPath' in v));
});

test('Regression: kein A6-Workflow, kein Workflow ruft einen Job-Einstieg auf, die produktive Policy fehlt', () => {
  const workflows = join(ROOT, '.github', 'workflows');
  const files = readdirSync(workflows).filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.length >= 10, 'Gegenprobe: zu wenige Workflows gefunden');
  assert.ok(!files.includes('agent-auftrag.yml'));
  assert.ok(files.every(name => !/agent-code-job|A6_APP_TOKEN|A6_VERGLEICH/.test(readFileSync(join(workflows, name), 'utf8'))));
  assert.ok(files.some(name => readFileSync(join(workflows, name), 'utf8').includes('agent-code-package')), 'Muss-Treffer der Suche');
  assert.equal(existsSync(join(ROOT, '.github', 'agent', 'policy.json')), false);
  // Das Profil js-text ist auf main weiterhin inaktiv; die Tests aktivieren es nur in temporaeren Repositories.
  assert.ok(readFileSync(join(ROOT, 'agent-profiles', 'js-text.json'), 'utf8').includes('"aktiv": false'));
});

test('Wache: in dieser Testdatei wurde kein Socket verbunden', () => {
  assert.equal(socketVersuche, 0);
  assert.throws(() => new net.Socket().connect(1, '127.0.0.1'), /Socket im Veroeffentlichungstest verboten/);
  assert.equal(socketVersuche, 1);
  socketVersuche = 0;
});
