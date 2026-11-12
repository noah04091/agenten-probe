// Tests fuer scripts/agent-code-auftrag-publish.mjs (A6.2-6).
//
// Alles offline: Ein GitHub-Simulator im Speicher beantwortet jede Anfrage. Er legt Blobs, Baeume
// und Commits als echte Git-Objekte in einem Temp-Repository an, damit SHAs, Modi und Diffs echt
// gerechnet sind. Keine Netzanfragen, keine Zugangsdaten, keine GitHub-Schreibzugriffe, keine
// Agentenstarts. Auf das echte Repository wird nur lesend ueber das Dateisystem zugegriffen
// (Profil, Policy-Fixture, Quelltext und Workflows fuer die Wachtests), nie mit git.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APPROVAL_DEADLINE_MS, orderSha256, resolveOrder } from '../scripts/agent-code-auftrag.mjs';
import { createPackageV2, prepareWorkspace } from '../scripts/agent-code-auftrag-paket.mjs';
import {
  BRANCH_RESERVE_MS, PUBLISH_WINDOW_MS, PublishError, branchName, checkApprovalDeadline, checkBranchReserve, checkPublishRequest,
  checkTimeWindow, publishOrderDraft,
} from '../scripts/agent-code-auftrag-publish.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_PATH = join(ROOT, 'scripts/agent-code-auftrag-publish.mjs');
const RECHNER_BYTES = readFileSync(join(ROOT, 'agent-profiles/js-rechner.json'));
const DRAFT_POLICY_BYTES = readFileSync(join(ROOT, 'test/fixtures/agent-policy.entwurf.json'));
const IS_WINDOWS = globalThis.process.platform === 'win32';

const canon = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const POLICY_BYTES = canon({ ...JSON.parse(DRAFT_POLICY_BYTES), skript_hashes: { 'scripts/agent-profile.mjs': 'a'.repeat(64) } });

const ISSUE = 999001;
const RUN_ID = '42783596004';
const REPO_NAME = 'noah04091/agenten-probe';
const P = `/repos/${REPO_NAME}/`;
const BRANCH = `wp/${ISSUE}-agent-${RUN_ID}-1`;
const OWNER_USER = Object.freeze({ login: 'noah04091', type: 'User' });
const TITLE = 'Potenz ergaenzen';
const BODY = 'Bitte eine Funktion potenz(a, b) ergaenzen.';
const APPROVAL_TIME = '2026-11-10T08:33:39Z';
const RUN_CREATED = '2026-11-10T08:33:41Z';
const APPROVAL = Date.parse(APPROVAL_TIME);
const NOW = Date.parse('2026-11-10T08:40:00Z');
const MIN = 60_000;

const RECHNE_BASE = 'export const addiere = (a, b) => a + b;\n';
const TEST_BASE = "import test from 'node:test';\n";
const RECHNE_NEU = `${RECHNE_BASE}export const potenz = (a, b) => a ** b;\n`;
const TEST_NEU = `${TEST_BASE}import assert from 'node:assert/strict';\nimport { potenz } from '../src/rechne.js';\n\ntest('potenz', () => {\n  assert.strictEqual(potenz(2, 3), 8);\n});\n`;

const BASE_FILES = Object.freeze({
  '.github/agent/policy.json': POLICY_BYTES,
  'agent-profiles/js-rechner.json': RECHNER_BYTES,
  'src/rechne.js': RECHNE_BASE,
  'test/rechne.test.js': TEST_BASE,
  'README.md': '# Probe\n',
  'docs/tief/info.md': 'Info\n',
  [`agent-acceptance/issue-${ISSUE}.mjs`]: '// synthetische Abnahme, wird nie ausgefuehrt\nexport const synthetisch = true;\n',
});

// ---------------------------------------------------------------------------
// Temp-Repository mit isolierter Git-Umgebung
// ---------------------------------------------------------------------------

const GIT_PASSTHROUGH = Object.freeze(['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']);
let BASE_DIR;
let REPO;
let ENV;
let BASE;
let OTHER;
let TRUSTED;
let PKG;
let dirNo = 0;
let refNo = 0;

function gitTestEnv(home) {
  const env = {};

  for (const key of GIT_PASSTHROUGH) {
    const value = Object.getOwnPropertyDescriptor(globalThis.process.env, key)?.value;

    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  return {
    ...env,
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

function gitIn(cwd, args, input, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd,
    env: { ...ENV, ...extraEnv },
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

const git = (args, input, extraEnv) => gitIn(REPO, args, input, extraEnv);

function commitWith(files) {
  git(['read-tree', '--empty']);

  for (const [path, content] of Object.entries(files)) {
    const oid = git(['hash-object', '-w', '--stdin'], content);
    git(['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`]);
  }

  const sha = git(['commit-tree', git(['write-tree']), '-m', 'Testbaum']);
  refNo += 1;
  git(['update-ref', `refs/heads/t${refNo}`, sha]);
  return sha;
}

function newDir(prefix = 'd') {
  dirNo += 1;
  return join(BASE_DIR, `${prefix}${dirNo}`);
}

// Frischer Checkout als eigener Klon mit eigenem .git. Auf BASE als Dateikopie einer sauberen
// Vorlage (schneller als ein Klon, gleiches Ergebnis: eigenes .git, sauberer Status).
let TEMPLATE = null;

function checkout(sha = BASE, dir = newDir('c')) {
  if (sha === BASE && TEMPLATE !== null) {
    cpSync(TEMPLATE, dir, { recursive: true });
    return dir;
  }

  execFileSync('git', ['clone', '-q', '--no-checkout', REPO, dir], { env: ENV, stdio: 'ignore' });
  gitIn(dir, ['checkout', '-q', '--detach', sha]);
  return dir;
}

// ---------------------------------------------------------------------------
// Kuenstlicher GitHub-Zustand
// ---------------------------------------------------------------------------

const labelEvent = (id, event, name, createdAt, actor = OWNER_USER) => ({
  id, event, created_at: createdAt, actor: { ...actor }, label: { name, color: 'ededed' }, performed_via_github_app: null,
});

const baseEvents = () => [
  { id: 5000, event: 'assigned', created_at: '2026-11-10T08:00:00Z', actor: { ...OWNER_USER }, performed_via_github_app: null },
  labelEvent(5100, 'labeled', 'agent:js-rechner', '2026-11-10T08:30:00Z'),
  labelEvent(5101, 'labeled', 'bot-auftrag', APPROVAL_TIME),
];

const payload = () => ({
  action: 'labeled',
  label: { name: 'bot-auftrag' },
  sender: { ...OWNER_USER },
  repository: { full_name: REPO_NAME },
  issue: { number: ISSUE, user: { login: 'noah04091' }, title: TITLE, body: BODY, updated_at: APPROVAL_TIME },
});

const liveIssue = () => ({
  number: ISSUE,
  state: 'open',
  title: TITLE,
  body: BODY,
  updated_at: APPROVAL_TIME,
  comments: 0,
  user: { ...OWNER_USER },
  labels: [{ name: 'bot-auftrag' }, { name: 'agent:js-rechner' }],
});

const liveRun = () => ({
  id: Number(RUN_ID),
  event: 'issues',
  path: '.github/workflows/code-pilot-claude-stufe.yml',
  head_branch: 'main',
  head_sha: BASE,
  run_attempt: 1,
  status: 'in_progress',
  created_at: RUN_CREATED,
  actor: { ...OWNER_USER },
  triggering_actor: { ...OWNER_USER },
  repository: { full_name: REPO_NAME },
  head_repository: { full_name: REPO_NAME },
});

const pullRecord = (number, ref) => ({
  number,
  state: 'closed',
  draft: false,
  html_url: `https://github.com/${REPO_NAME}/pull/${number}`,
  head: { ref, repo: { full_name: REPO_NAME } },
  base: { ref: 'main', repo: { full_name: REPO_NAME } },
});

const ok = (json, headers = {}) => ({ status: 200, headers, body: JSON.stringify(json) });
const created = json => ({ status: 201, headers: {}, body: JSON.stringify(json) });
const notFound = () => ({ status: 404, headers: {}, body: '{"message":"Not Found"}' });
const unprocessable = () => ({ status: 422, headers: {}, body: '{"message":"Reference already exists"}' });
const LINK_BASE = 'https://api.github.com/repositories/1442279535/';

function pageResponse(items, page, kind) {
  const pages = [];

  for (let i = 0; i < items.length; i += 100) {
    pages.push(items.slice(i, i + 100));
  }

  if (pages.length === 0) {
    pages.push([]);
  }

  const n = pages.length;
  const url = k => `<${LINK_BASE}${kind}per_page=100&page=${k}>`;
  const parts = [];

  if (page > n) {
    parts.push(`${url(n)}; rel="prev"`, `${url(n)}; rel="last"`, `${url(1)}; rel="first"`);
    return ok([], { link: parts.join(', ') });
  }

  if (page > 1) {
    parts.push(`${url(page - 1)}; rel="prev"`);
  }

  if (page < n) {
    parts.push(`${url(page + 1)}; rel="next"`, `${url(n)}; rel="last"`);
  }

  if (page > 1) {
    parts.push(`${url(1)}; rel="first"`);
  }

  return ok(pages[page - 1], parts.length > 0 ? { link: parts.join(', ') } : {});
}

// ---------------------------------------------------------------------------
// GitHub-Simulator: Lesen wie die Live-Pruefung, Schreiben als echte Git-Objekte
// ---------------------------------------------------------------------------

function readTreeObject(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return notFound();
  }

  try {
    if (git(['cat-file', '-t', sha]) !== 'tree') {
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
    ahead_by: commits.length,
    behind_by: behind,
    total_commits: commits.length,
    commits: commits.map(sha => ({ sha, url: 'x' })),
    files,
  });
}

function handle(sim, req) {
  const rest = req.path.slice(P.length);
  const pageOf = prefix => (rest.startsWith(prefix) ? Number(rest.slice(prefix.length)) : null);

  if (req.method === 'GET') {
    if (/^actions\/runs\/[0-9]+$/.test(rest)) {
      return ok(sim.run);
    }

    if (rest === 'git/ref/heads/main') {
      return ok({ ref: 'refs/heads/main', node_id: 'x', url: 'x', object: { sha: sim.mainSha, type: 'commit', url: 'x' } });
    }

    if (rest === `issues/${ISSUE}`) {
      return ok(sim.issue);
    }

    const eventPage = pageOf(`issues/${ISSUE}/events?per_page=100&page=`);

    if (eventPage !== null) {
      return pageResponse(sim.events, eventPage, `issues/${ISSUE}/events?`);
    }

    if (rest === `git/matching-refs/heads/wp/${ISSUE}-`) {
      return ok([...sim.refs].filter(([name]) => name.startsWith(`refs/heads/wp/${ISSUE}-`)).map(([ref, sha]) => ({ ref, object: { sha, type: 'commit', url: 'x' } })));
    }

    const pullPage = pageOf('pulls?state=all&sort=created&direction=asc&per_page=100&page=');

    if (pullPage !== null) {
      return pageResponse(sim.pulls, pullPage, 'pulls?state=all&sort=created&direction=asc&');
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

    if (compareMatch) {
      return compareObjects(compareMatch[1], compareMatch[2]);
    }

    return notFound();
  }

  const body = req.body === undefined ? undefined : JSON.parse(req.body);

  if (req.method === 'POST' && rest === 'git/blobs') {
    assert.equal(body.encoding, 'base64');
    const sha = git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64'));
    return created({ sha, url: 'x' });
  }

  if (req.method === 'POST' && rest === 'git/trees') {
    const indexEnv = { GIT_INDEX_FILE: join(BASE_DIR, 'sim-index') };
    git(['read-tree', body.base_tree], undefined, indexEnv);

    for (const entry of body.tree) {
      try {
        git(['cat-file', '-e', entry.sha]);
      } catch {
        return unprocessable();
      }

      git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`], undefined, indexEnv);
    }

    const sha = git(['write-tree'], undefined, indexEnv);
    return created({ sha, url: 'x', tree: [], truncated: false });
  }

  if (req.method === 'POST' && rest === 'git/commits') {
    const args = ['commit-tree', body.tree, ...body.parents.flatMap(parent => ['-p', parent]), '-m', body.message];
    const sha = git(args, undefined, { GIT_AUTHOR_DATE: '2026-11-10T09:00:00Z', GIT_COMMITTER_DATE: '2026-11-10T09:00:00Z' });
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
    const record = { ...pullRecord(number, body.head), state: 'open', draft: body.draft, title: body.title, body: body.body };
    sim.pulls.push(record);
    return created(record);
  }

  if (req.method === 'DELETE' && rest.startsWith('git/refs/heads/')) {
    const ref = `refs/heads/${rest.slice('git/refs/heads/'.length)}`;

    if (!sim.refs.has(ref)) {
      return { status: 422, headers: {}, body: '{"message":"Reference does not exist"}' };
    }

    sim.refs.delete(ref);
    return { status: 204, headers: {}, body: '' };
  }

  return notFound();
}

// onRequest(req, sim): darf den Zustand vor der Antwort aendern. override(req, sim): eigene Antwort
// oder undefined (darf werfen, dann scheitert der Transport). tamper(req, res, sim): veraendert die
// Antwort (Rueckgabe undefined laesst sie unveraendert).
function createSim() {
  const sim = {
    issue: liveIssue(),
    events: baseEvents(),
    run: liveRun(),
    mainSha: BASE,
    refs: new Map(),
    pulls: [pullRecord(1, 'wp/1-anderes'), pullRecord(2, 'wp/2-anderes')],
    nextPr: 5001,
    log: [],
    liveReads: 0,
    onRequest: null,
    override: null,
    tamper: null,
  };

  sim.transport = async request => {
    const req = { method: request.method, path: request.path, body: request.body };
    sim.log.push(req);

    if (req.method === 'GET' && req.path === `${P}actions/runs/${RUN_ID}`) {
      sim.liveReads += 1;
    }

    sim.onRequest?.(req, sim);
    let res = sim.override?.(req, sim);

    if (res === undefined) {
      res = handle(sim, req);
    }

    return (sim.tamper?.(req, res, sim)) ?? res;
  };

  return sim;
}

const restOf = req => req.path.slice(P.length);
const writes = sim => sim.log.filter(req => req.method !== 'GET').map(req => `${req.method} ${restOf(req)}`);
const WRITES_OK = Object.freeze(['POST git/blobs', 'POST git/blobs', 'POST git/trees', 'POST git/commits', `POST git/refs`, 'POST pulls']);
const WRITES_BEFORE_REF = WRITES_OK.slice(0, 4);
const isLive = req => req.method === 'GET' && /^(actions\/runs\/|git\/ref\/heads\/main$|issues\/|git\/matching-refs\/|pulls\?)/.test(restOf(req));

// Ablauf als Folge: jede Live-Pruefung als LIVE (Beginn mit actions/runs), sonst Methode und Endpunkt.
function tokens(sim) {
  const out = [];

  for (const req of sim.log) {
    const rest = restOf(req);

    if (isLive(req)) {
      if (rest.startsWith('actions/runs/')) {
        out.push('LIVE');
      }

      continue;
    }

    out.push(`${req.method} ${rest.replace(/\/[0-9a-f]{40}(\.\.\.[0-9a-f]{40})?(\?recursive=1)?$/, '').replace(`/heads/${BRANCH}`, '')}`);
  }

  return out;
}

const FLOW_OK = Object.freeze([
  'LIVE', 'LIVE',
  'POST git/blobs', 'POST git/blobs', 'GET git/commits', 'GET git/trees', 'POST git/trees', 'GET git/trees', 'POST git/commits', 'GET git/commits',
  'LIVE', 'POST git/refs',
  'LIVE', 'GET git/ref', 'GET compare',
  'LIVE', 'GET git/ref', 'POST pulls',
]);

// Uhr mit genau den angegebenen Werten. Jeder weitere Aufruf wirft (und laesst die Pruefung scheitern).
function clockOf(...values) {
  const clock = () => {
    if (clock.calls >= values.length) {
      throw new Error('Uhr: mehr Aufrufe als vorgesehen');
    }

    const value = values[clock.calls];
    clock.calls += 1;
    return typeof value === 'number' ? new Date(value) : value;
  };

  clock.calls = 0;
  return clock;
}

const defaultClock = () => clockOf(NOW, NOW, NOW, NOW);

function input(sim, changes = {}) {
  return {
    root: TRUSTED,
    checkRoot: checkout(),
    baseSha: BASE,
    event: payload(),
    expectedSha256: PKG.hash,
    runId: RUN_ID,
    packageBytes: PKG.bytes,
    packageSha256: PKG.sha256,
    gitEnv: { ...ENV },
    transport: sim.transport,
    clock: defaultClock(),
    ...changes,
  };
}

async function publish({ sim = createSim(), changes = {} } = {}) {
  const args = input(sim, changes);

  try {
    return { result: await publishOrderDraft(args), sim, args };
  } catch (error) {
    return { error, sim, args };
  }
}

function assertFail(outcome, code) {
  const { error } = outcome;
  assert.ok(error instanceof PublishError, `erwartet PublishError ${code}, erhalten ${error?.stack ?? 'Erfolg'}`);
  assert.equal(error.code, code, `erwartet ${code}, erhalten ${error.code}: ${error.cause?.message}`);
  assert.equal(error.bericht.code, code);
  assert.ok(Object.isFrozen(error.bericht));
  return error.bericht;
}

// Fehler ohne einen einzigen Transportaufruf.
async function rejectsWithoutCalls(changes, code) {
  const outcome = await publish({ changes });
  assertFail(outcome, code);
  assert.equal(outcome.sim.log.length, 0, 'es gab Transportaufrufe');
  return outcome;
}

// Fehler vor dem ersten Schreibaufruf (Lesen ist erlaubt).
async function rejectsWithoutWrites(setupSim, code, changes = {}) {
  const sim = createSim();
  setupSim?.(sim);
  const outcome = await publish({ sim, changes });
  const bericht = assertFail(outcome, code);
  assert.deepEqual(writes(sim), []);
  assert.equal(bericht.schreibaufrufe, 0);
  assert.equal(bericht.bereinigung, 'nicht-noetig');
  return outcome;
}

// Aendert den Zustand genau zu Beginn der n-ten Live-Pruefung.
const atLiveRead = (n, change) => (req, sim) => {
  if (req.method === 'GET' && req.path === `${P}actions/runs/${RUN_ID}` && sim.liveReads === n) {
    change(sim);
  }
};

// Ersetzt die k-te Antwort (1-basiert) auf Anfragen, die match erfuellen.
function tamperNth(match, k, change) {
  let seen = 0;
  return (req, res) => {
    if (!match(req)) {
      return undefined;
    }

    seen += 1;
    return seen === k ? change(res, req) : undefined;
  };
}

const jsonEdit = edit => res => {
  const json = JSON.parse(res.body);
  const next = edit(json) ?? json;
  return { ...res, body: JSON.stringify(next) };
};

const isReq = (method, pattern) => req => req.method === method && pattern.test(restOf(req));

// Fehler nach der Branch-Anlage, vor POST pulls: Der Branch muss geloescht sein.
function assertCleanedUp(outcome, code) {
  const bericht = assertFail(outcome, code);
  assert.equal(bericht.branch_bestaetigt, true);
  assert.equal(bericht.pr_angefragt, false);
  assert.equal(bericht.bereinigung, 'geloescht', bericht.bereinigung_grund);
  assert.ok(!writes(outcome.sim).includes('POST pulls'));
  assert.equal(writes(outcome.sim).at(-1), `DELETE git/refs/heads/${BRANCH}`);
  assert.equal(outcome.sim.refs.has(`refs/heads/${BRANCH}`), false);
  return bericht;
}

function assertNotCleanedUp(outcome, code, reason) {
  const bericht = assertFail(outcome, code);
  assert.equal(bericht.bereinigung, 'nicht-geloescht');
  assert.equal(bericht.bereinigung_grund, reason);
  assert.ok(!writes(outcome.sim).some(entry => entry.startsWith('DELETE')), 'es wurde geloescht');
  return bericht;
}

// Fehler nach POST pulls: nie loeschen, keine weitere Anfrage.
function assertAfterPull(outcome, code) {
  const bericht = assertNotCleanedUp(outcome, code, 'pr-angefragt');
  assert.equal(bericht.pr_angefragt, true);
  assert.deepEqual(writes(outcome.sim), WRITES_OK);
  assert.equal(outcome.sim.log.at(-1).method, 'POST');
  assert.equal(restOf(outcome.sim.log.at(-1)), 'pulls');
  assert.ok(outcome.sim.refs.has(`refs/heads/${BRANCH}`));
  return bericht;
}

// ---------------------------------------------------------------------------
// Aufbau und Abbau
// ---------------------------------------------------------------------------

before(() => {
  BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-auftrag-publish-test-'));
  REPO = join(BASE_DIR, 'repo');
  const home = join(BASE_DIR, 'home');
  mkdirSync(REPO);
  mkdirSync(join(home, 'xdg'), { recursive: true });
  writeFileSync(join(home, 'leer.gitconfig'), '');
  ENV = gitTestEnv(home);
  git(['init', '-q']);
  BASE = commitWith(BASE_FILES);
  OTHER = commitWith({ ...BASE_FILES, 'README.md': '# Anders\n' });
  git(['update-ref', 'refs/heads/main', BASE]);
  TEMPLATE = checkout(BASE);
  TRUSTED = checkout(BASE);

  // Derselbe Auftrag, den checkLiveOrder aus dem Simulator bildet (now geht nicht in den Auftrag ein).
  const order = resolveOrder({
    root: TRUSTED,
    baseSha: BASE,
    gitEnv: { ...ENV },
    repository: REPO_NAME,
    event: payload(),
    issue: liveIssue(),
    events: baseEvents(),
    run: { id: RUN_ID, attempt: 1, createdAt: RUN_CREATED },
    now: new Date(NOW),
  });
  const hash = orderSha256(order);
  const work = prepareWorkspace(TRUSTED, order, hash, newDir('w'), { gitEnv: { ...ENV } }).arbeitsordner;
  writeFileSync(join(work, 'src', 'rechne.js'), RECHNE_NEU);
  writeFileSync(join(work, 'test', 'rechne.test.js'), TEST_NEU);
  const pkg = createPackageV2(TRUSTED, order, hash, work);
  PKG = Object.freeze({ hash, text: pkg.text, bytes: Buffer.from(pkg.text, 'utf8'), sha256: pkg.sha256 });
});

after(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Positivbeweis
// ---------------------------------------------------------------------------

test('Gueltiger Fall: Blobs, Baum, Commit, Branch und Draft-PR in genau dieser Reihenfolge', async () => {
  const outcome = await publish();
  assert.equal(outcome.error, undefined, outcome.error?.cause?.stack);
  const { result, sim } = outcome;

  assert.deepEqual(writes(sim), WRITES_OK);
  // Live-Pruefungen in A und B, vor dem Branch (D), nach dem Branch (F) und vor dem PR (H).
  assert.deepEqual(tokens(sim), FLOW_OK);
  assert.equal(sim.liveReads, 5);
  assert.equal(outcome.args.clock.calls, 4);

  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.dateien));
  assert.deepEqual(Object.keys(result), ['pr_nummer', 'pr_url', 'branch', 'commit', 'baum', 'dateien', 'auftrag_sha256', 'paket_sha256']);
  assert.equal(result.branch, BRANCH);
  assert.equal(result.pr_nummer, 5001);
  assert.equal(result.pr_url, `https://github.com/${REPO_NAME}/pull/5001`);
  assert.deepEqual([...result.dateien], ['src/rechne.js', 'test/rechne.test.js']);
  assert.equal(result.auftrag_sha256, PKG.hash);
  assert.equal(result.paket_sha256, PKG.sha256);
  assert.equal(sim.refs.get(`refs/heads/${BRANCH}`), result.commit);

  // Der Commit auf "GitHub" traegt genau die geprueften Bytes und genau einen Elternteil.
  assert.equal(git(['show', `${result.commit}:src/rechne.js`]), RECHNE_NEU.trim());
  assert.equal(git(['show', `${result.commit}:test/rechne.test.js`]), TEST_NEU.trim());
  assert.equal(git(['rev-parse', `${result.commit}^@`]), BASE);
  assert.equal(git(['diff', '--name-only', BASE, result.commit]), 'src/rechne.js\ntest/rechne.test.js');

  const pr = sim.pulls.at(-1);
  assert.equal(pr.draft, true);
  assert.equal(pr.head.ref, BRANCH);
});

test('Gueltiger Fall: Anfragen tragen genau die geprueften Daten, keine Issue-Inhalte im PR', async () => {
  const { result, sim, error } = await publish();
  assert.equal(error, undefined);
  const bodies = (method, rest) => sim.log.filter(req => req.method === method && restOf(req) === rest).map(req => JSON.parse(req.body));

  const blobs = bodies('POST', 'git/blobs');
  assert.deepEqual(blobs.map(blob => Object.keys(blob)), [['content', 'encoding'], ['content', 'encoding']]);
  assert.deepEqual(blobs.map(blob => blob.encoding), ['base64', 'base64']);
  assert.deepEqual(blobs.map(blob => Buffer.from(blob.content, 'base64').toString('utf8')), [RECHNE_NEU, TEST_NEU]);

  const [tree] = bodies('POST', 'git/trees');
  assert.equal(tree.base_tree, git(['rev-parse', `${BASE}^{tree}`]));
  assert.deepEqual(tree.tree, [
    { path: 'src/rechne.js', mode: '100644', type: 'blob', sha: git(['hash-object', '--stdin'], RECHNE_NEU) },
    { path: 'test/rechne.test.js', mode: '100644', type: 'blob', sha: git(['hash-object', '--stdin'], TEST_NEU) },
  ]);

  const [commit] = bodies('POST', 'git/commits');
  assert.deepEqual(commit.parents, [BASE]);
  assert.equal(commit.tree, result.baum);

  assert.deepEqual(bodies('POST', 'git/refs'), [{ ref: `refs/heads/${BRANCH}`, sha: result.commit }]);

  const [pull] = bodies('POST', 'pulls');
  assert.deepEqual(Object.keys(pull), ['title', 'head', 'base', 'draft', 'body']);
  assert.equal(pull.draft, true);
  assert.equal(pull.base, 'main');
  assert.equal(pull.head, BRANCH);
  assert.equal(pull.title, `feat: Codeauftrag fuer Issue #${ISSUE}`);

  for (const text of [pull.title, pull.body, commit.message]) {
    assert.ok(!text.includes(TITLE) && !text.includes(BODY), 'Issue-Inhalt im PR oder Commit');
    assert.ok(!/close[sd]?|fixe[sd]?|resolve[sd]?/i.test(text), 'Schluesselwort, das ein Issue schliesst');
  }

  assert.ok(pull.body.includes(PKG.hash) && pull.body.includes(PKG.sha256));
  // Kein Issue-Verweis im Commit, der schon vor dem PR ein Ereignis im Issue-Verlauf erzeugen koennte.
  assert.ok(!commit.message.includes('#'), commit.message);
  assert.ok(commit.message.includes(`Issue ${ISSUE}`));
});

test('Gueltiger Fall: Transport und Uhr ohne this, jeder Uhrwert erst nach der zugehoerigen Lesung', async () => {
  const sim = createSim();
  const thisValues = [];
  const lastRequest = [];
  const base = defaultClock();
  const clock = function () {
    thisValues.push(this);
    lastRequest.push(restOf(sim.log.at(-1)));
    return base();
  };
  const transport = function (request) {
    thisValues.push(this);
    return sim.transport(request);
  };
  const outcome = await publish({ sim, changes: { clock, transport } });
  assert.equal(outcome.error, undefined, outcome.error?.code);
  assert.ok(thisValues.length > 40 && thisValues.every(value => value === undefined), 'this ist gesetzt');
  // A, B und D: nach der letzten Seite der PR-Liste, also nach der vollstaendigen Live-Lesung.
  // H: nach Live-Lesung und Branch-Ref, unmittelbar vor POST pulls.
  assert.equal(lastRequest.length, 4);
  assert.ok(lastRequest.slice(0, 3).every(rest => rest.startsWith('pulls?')), lastRequest.join(' | '));
  assert.equal(lastRequest[3], `git/ref/heads/${BRANCH}`);
});

test('Gueltiger Fall: der vertrauenswuerdige Checkout bleibt unberuehrt, nur der Pruef-Checkout wird beschrieben', async () => {
  const { args, error } = await publish();
  assert.equal(error, undefined);
  assert.equal(gitIn(TRUSTED, ['status', '--porcelain', '--untracked-files=all', '--ignored']), '');
  assert.equal(readFileSync(join(TRUSTED, 'src', 'rechne.js'), 'utf8'), RECHNE_BASE);
  assert.equal(readFileSync(join(args.checkRoot, 'src', 'rechne.js'), 'utf8'), RECHNE_NEU);
});

// ---------------------------------------------------------------------------
// Eingabe und Verzeichnistrennung: null Transportaufrufe
// ---------------------------------------------------------------------------

test('Eingabe: falsche Form wird ohne einen einzigen Transportaufruf abgelehnt', async () => {
  for (const changes of [
    { baseSha: BASE.toUpperCase() },
    { baseSha: 'a'.repeat(39) },
    { expectedSha256: 'a'.repeat(63) },
    { expectedSha256: PKG.hash.toUpperCase() },
    { packageSha256: 'x'.repeat(64) },
    { runId: '0' },
    { runId: '01' },
    { runId: 'abc' },
    { runId: 42783596004 },
    { runId: '12345678901234567' },
    { transport: 'nein' },
    { clock: new Date(NOW) },
    { event: { ...payload(), issue: { ...payload().issue, number: 0 } } },
    { event: { ...payload(), issue: undefined } },
    { event: null },
  ]) {
    await rejectsWithoutCalls(changes, 'publish-eingabe');
  }
});

test('Eingabe: zusaetzliche, fehlende, geerbte oder versteckte Felder werden abgelehnt', async () => {
  for (const make of [
    args => ({ ...args, branch: 'wp/1-frei' }),
    args => ({ ...args, order: {} }),
    args => { const copy = { ...args }; delete copy.clock; return copy; },
    args => Object.assign(Object.create({ clock: args.clock }), { ...args, clock: undefined }),
    args => new Proxy(args, {}),
    args => { const copy = { ...args }; Object.defineProperty(copy, 'runId', { get: () => RUN_ID, enumerable: true }); return copy; },
  ]) {
    const sim = createSim();
    await assert.rejects(() => publishOrderDraft(make(input(sim))), error => error instanceof PublishError && error.code === 'publish-eingabe');
    assert.equal(sim.log.length, 0);
  }

  await assert.rejects(() => publishOrderDraft(null), error => error.code === 'publish-eingabe');
});

test('Verzeichnisse: gleich, verschachtelt in beide Richtungen, relativ oder fehlend wird ohne Transportaufruf abgelehnt', async () => {
  const outer = newDir('o');
  mkdirSync(outer);
  const inner = checkout(BASE, join(outer, 'inner'));
  const root = checkout();
  mkdirSync(join(root, 'leer'));

  await rejectsWithoutCalls({ root, checkRoot: root }, 'publish-verzeichnis-ueberschneidung');
  await rejectsWithoutCalls({ root, checkRoot: join(root, 'leer') }, 'publish-verzeichnis-ueberschneidung');
  await rejectsWithoutCalls({ root: inner, checkRoot: outer }, 'publish-verzeichnis-ueberschneidung');
  await rejectsWithoutCalls({ root: outer, checkRoot: inner }, 'publish-verzeichnis-ueberschneidung');
  await rejectsWithoutCalls({ checkRoot: 'relativ/pruef' }, 'publish-pfad-eingabe');
  await rejectsWithoutCalls({ checkRoot: join(BASE_DIR, 'gibt-es-nicht') }, 'publish-pfad-eingabe');
  await rejectsWithoutCalls({ root: join(BASE_DIR, 'gibt-es-auch-nicht') }, 'publish-pfad-eingabe');
  await rejectsWithoutCalls({ checkRoot: `${root}\0x` }, 'publish-pfad-eingabe');
  await rejectsWithoutCalls({ checkRoot: join(root, 'README.md') }, 'publish-pfad-eingabe');
});

test('Verzeichnisse: andere Schreibweise desselben Ordners wird abgelehnt', async () => {
  const root = checkout();
  const variant = root.replace(/agent-auftrag-publish-test-/, 'AGENT-AUFTRAG-PUBLISH-TEST-');
  assert.notEqual(variant, root);
  // Windows: derselbe Ordner, also Ueberschneidung. Linux: der Pfad existiert nicht.
  await rejectsWithoutCalls({ root, checkRoot: variant }, IS_WINDOWS ? 'publish-verzeichnis-ueberschneidung' : 'publish-pfad-eingabe');
});

test('Verzeichnisse: Umleitung ueber Verknuepfungen wird abgelehnt', async () => {
  const root = checkout();
  mkdirSync(join(root, 'leer'));
  const link = newDir('l');
  symlinkSync(root, link, IS_WINDOWS ? 'junction' : 'dir');
  // Der Pruef-Checkout selbst ist eine Verknuepfung.
  await rejectsWithoutCalls({ root: TRUSTED, checkRoot: link }, 'publish-pfad-eingabe');
  // Ein Ordner hinter einer Verknuepfung liegt in Wahrheit in root.
  await rejectsWithoutCalls({ root, checkRoot: join(link, 'leer') }, 'publish-verzeichnis-ueberschneidung');
});

test('Verzeichnisse: UNC-Pfad wird abgelehnt (nur Windows)', async t => {
  if (!IS_WINDOWS) {
    t.skip('UNC-Pfade gibt es nur unter Windows');
    return;
  }

  const root = checkout();
  const unc = path => `\\\\localhost\\${path[0]}$${path.slice(2)}`;

  if (!existsSync(join(unc(root), 'README.md'))) {
    t.skip('Administrative Freigabe ist hier nicht erreichbar');
    return;
  }

  // Ueber UNC waere derselbe Ordner textlich ein anderer.
  await rejectsWithoutCalls({ root, checkRoot: unc(root) }, 'publish-pfad-eingabe');
  await rejectsWithoutCalls({ root: unc(root) }, 'publish-pfad-eingabe');
});

test('Verzeichnisse: Umlenkung eines Elternordners waehrend der Live-Lesung wird vor dem Anwenden erkannt', async () => {
  // checkRoot = P/c. Waehrend der ersten Live-Lesung wird P durch eine Verknuepfung ersetzt.
  const swap = (target, root = TRUSTED) => {
    const parent = newDir('p');
    mkdirSync(parent);
    const check = checkout(BASE, join(parent, 'c'));
    const sim = createSim();
    sim.onRequest = atLiveRead(1, () => {
      renameSync(parent, `${parent}-alt`);
      symlinkSync(target, parent, IS_WINDOWS ? 'junction' : 'dir');
    });
    return { sim, changes: { root, checkRoot: check }, old: join(`${parent}-alt`, 'c') };
  };

  // Ziel ist ein anderer, ebenfalls sauberer Checkout: andere kanonische Pfade.
  const other = newDir('y');
  mkdirSync(other);
  checkout(BASE, join(other, 'c'));
  const first = swap(other);
  const a = await publish({ sim: first.sim, changes: first.changes });
  assertFail(a, 'publish-verzeichnis-geaendert');
  assert.deepEqual(writes(first.sim), []);

  // Ziel ist der Elternordner von root: checkRoot waere jetzt root selbst.
  const holder = newDir('x');
  mkdirSync(holder);
  const root = checkout(BASE, join(holder, 'c'));
  const second = swap(holder, root);
  const b = await publish({ sim: second.sim, changes: second.changes });
  assertFail(b, 'publish-verzeichnis-ueberschneidung');
  assert.deepEqual(writes(second.sim), []);
  assert.equal(readFileSync(join(root, 'src', 'rechne.js'), 'utf8'), RECHNE_BASE, 'root wurde beschrieben');
  assert.equal(gitIn(root, ['status', '--porcelain', '--untracked-files=all']), '');
});

test('Verzeichnisse: ein nicht sauberer root wird nach dem Anwenden erkannt, ohne Schreibaufruf', async () => {
  const root = checkout();
  writeFileSync(join(root, 'fremd.txt'), 'x\n');
  await rejectsWithoutWrites(null, 'publish-root-veraendert', { root });
});

test('Verzeichnisse: ein schon verwendeter Pruef-Checkout wird kein zweites Mal verwendet', async () => {
  const check = checkout();
  const first = await publish({ changes: { checkRoot: check } });
  assert.equal(first.error, undefined);
  const second = await publish({ changes: { checkRoot: check } });
  assertFail(second, 'publish-pruef-checkout-verbraucht');
  assert.equal(second.sim.log.length, 0);
});

// ---------------------------------------------------------------------------
// Phase A: Auftrag und Paket, null Schreibaufrufe
// ---------------------------------------------------------------------------

test('Phase A: falscher Auftragshash, falscher Auftrag und falsche Lauf-ID schreiben nichts', async () => {
  await rejectsWithoutWrites(null, 'auftrag-abweichung', { expectedSha256: 'a'.repeat(64) });
  await rejectsWithoutWrites(null, 'auftrag-start-zuordnung', { event: { ...payload(), issue: { ...payload().issue, updated_at: '2026-11-10T08:33:38Z' } } });
  await rejectsWithoutWrites(null, 'auftrag-issue-abweichung', { event: { ...payload(), issue: { ...payload().issue, title: 'Anderer Titel' } } });
  await rejectsWithoutWrites(null, 'live-lauf-id-abweichung', { runId: '42783596005' });
});

test('Phase A: manipuliertes Issue, ungueltige Freigabe, main, Branch und frueherer PR schreiben nichts', async () => {
  await rejectsWithoutWrites(sim => { sim.issue.title = 'Heimlich geaendert'; }, 'auftrag-issue-abweichung');
  await rejectsWithoutWrites(sim => { sim.issue.updated_at = '2026-11-10T08:35:00Z'; }, 'auftrag-issue-geaendert');
  await rejectsWithoutWrites(sim => { sim.events[2] = labelEvent(5101, 'labeled', 'bot-auftrag', APPROVAL_TIME, { login: 'fremd', type: 'User' }); }, 'auftrag-freigabe-fremd');
  await rejectsWithoutWrites(sim => { sim.events.push(labelEvent(5102, 'unlabeled', 'bot-auftrag', '2026-11-10T08:34:00Z')); }, 'auftrag-freigabe-entzogen');
  await rejectsWithoutWrites(sim => { sim.mainSha = OTHER; }, 'live-main-geaendert');
  await rejectsWithoutWrites(sim => { sim.refs.set(`refs/heads/${BRANCH}`, BASE); }, 'live-branch-vorhanden');
  await rejectsWithoutWrites(sim => { sim.refs.set(`refs/heads/wp/${ISSUE}-fremd`, BASE); }, 'live-branch-vorhanden');
  await rejectsWithoutWrites(sim => { sim.pulls.push(pullRecord(3, `wp/${ISSUE}-alt`)); }, 'live-pr-vorhanden');
});

test('Phase A: ungueltiges Paket, falscher Paket-Hash, falsche Blob-ID und andere Dateiliste schreiben nichts', async () => {
  const data = JSON.parse(PKG.text);
  const rebuilt = edit => {
    const copy = JSON.parse(PKG.text);
    edit(copy);
    const bytes = canon(copy);
    return { packageBytes: bytes, packageSha256: sha256(bytes) };
  };
  assert.equal(data.dateien.length, 2, 'Gegenprobe: Paket hat zwei Dateien');

  await rejectsWithoutWrites(null, 'paket-felder', { packageBytes: canon({}), packageSha256: sha256(canon({})) });
  await rejectsWithoutWrites(null, 'paket-hash', { packageSha256: sha256('anders') });
  await rejectsWithoutWrites(null, 'paket-git-blob', rebuilt(copy => { copy.dateien[0].git_blob = 'a'.repeat(40); }));
  await rejectsWithoutWrites(null, 'paket-dateiliste', rebuilt(copy => { copy.dateien.pop(); }));
  await rejectsWithoutWrites(null, 'paket-bindung', rebuilt(copy => { copy.auftrag_sha256 = 'b'.repeat(64); }));
  await rejectsWithoutWrites(null, 'paket-eingabe', { packageBytes: PKG.text });
});

test('Phase A: fehlerhafter Pruef-Checkout schreibt nichts auf GitHub', async () => {
  const dirty = checkout();
  writeFileSync(join(dirty, 'neu.txt'), 'x\n');
  await rejectsWithoutWrites(null, 'paket-status', { checkRoot: dirty });

  const changed = checkout();
  writeFileSync(join(changed, 'src', 'rechne.js'), RECHNE_NEU);
  await rejectsWithoutWrites(null, 'paket-status', { checkRoot: changed });

  await rejectsWithoutWrites(null, 'paket-head', { checkRoot: checkout(OTHER) });
});

test('Phase B: Aenderung zwischen erster und zweiter Pruefung verhindert jeden Upload', async () => {
  await rejectsWithoutWrites(sim => { sim.onRequest = atLiveRead(2, s => { s.mainSha = OTHER; }); }, 'live-main-geaendert');
  await rejectsWithoutWrites(sim => { sim.onRequest = atLiveRead(2, s => { s.issue.title = 'Spaeter'; }); }, 'auftrag-issue-abweichung');
  await rejectsWithoutWrites(sim => { sim.onRequest = atLiveRead(2, s => { s.refs.set(`refs/heads/${BRANCH}`, BASE); }); }, 'live-branch-vorhanden');
  // Gegenprobe: dieselbe Aenderung erst nach Phase B wird erst spaeter erkannt (es gab Uploads).
  const sim = createSim();
  sim.onRequest = atLiveRead(3, s => { s.mainSha = OTHER; });
  const outcome = await publish({ sim });
  assertFail(outcome, 'live-main-geaendert');
  assert.deepEqual(writes(sim), WRITES_BEFORE_REF);
});

// ---------------------------------------------------------------------------
// Uhr und Zeitgrenzen
// ---------------------------------------------------------------------------

const D = elapsed => APPROVAL + elapsed;
const withClock = (...values) => ({ clock: clockOf(...values) });

test('Zeit: Reserve vor dem Branch, 57:59,999 und 58:00,000 zulaessig, 58:00,001 nicht', async () => {
  for (const elapsed of [58 * MIN - 1, 58 * MIN]) {
    const outcome = await publish({ changes: withClock(NOW, NOW, D(elapsed), D(elapsed)) });
    assert.equal(outcome.error, undefined, `${elapsed}: ${outcome.error?.code}`);
    assert.deepEqual(writes(outcome.sim), WRITES_OK);
  }

  // Schon in B zu spaet: gar kein Upload.
  const early = await rejectsWithoutWrites(null, 'publish-freigabe-reserve', withClock(NOW, D(58 * MIN + 1)));
  assert.equal(early.error.bericht.schritt, 'B');

  const late = await publish({ changes: withClock(NOW, NOW, D(58 * MIN + 1)) });
  const bericht = assertFail(late, 'publish-freigabe-reserve');
  assert.deepEqual(writes(late.sim), WRITES_BEFORE_REF);
  assert.equal(bericht.schritt, 'D');
  assert.equal(bericht.bereinigung, 'nicht-noetig');
  assert.equal(bericht.bereinigung_grund, 'kein-branch');
});

test('Zeit: in D greift bei 59:50 und bei 60:00,000 die Reserve, bei 60:00,001 die Frist selbst', async () => {
  assertFail(await publish({ changes: withClock(NOW, NOW, D(59 * MIN + 50_000)) }), 'publish-freigabe-reserve');
  assertFail(await publish({ changes: withClock(NOW, NOW, D(60 * MIN)) }), 'publish-freigabe-reserve');
  // Belegt, dass der Uhrwert aus D als now an checkLiveOrder geht.
  const expired = await publish({ changes: withClock(NOW, NOW, D(60 * MIN + 1)) });
  assertFail(expired, 'auftrag-freigabe-abgelaufen');
  assert.deepEqual(writes(expired.sim), WRITES_BEFORE_REF);
});

test('Zeit: Zeitklammer bis POST pulls, 120 000 ms zulaessig, 120 001 ms nicht (Branch wird geloescht)', async () => {
  const start = D(50 * MIN);
  const exact = await publish({ changes: withClock(NOW, NOW, start, start + PUBLISH_WINDOW_MS) });
  assert.equal(exact.error, undefined, exact.error?.code);
  assert.equal(exact.args.clock.calls, 4);

  const late = await publish({ changes: withClock(NOW, NOW, start, start + PUBLISH_WINDOW_MS + 1) });
  const bericht = assertCleanedUp(late, 'publish-zeitklammer');
  assert.equal(bericht.schritt, 'H');
});

test('Zeit: genau ein Uhrwert je Pruefung, Beginn der Klammer ist der Wert aus D', async () => {
  // Grenzfall beider Regeln zugleich: D bei 58:00, PR genau 120 000 ms spaeter, also genau 60:00.
  const outcome = await publish({ changes: withClock(NOW, NOW, D(58 * MIN), D(58 * MIN) + PUBLISH_WINDOW_MS) });
  assert.equal(outcome.error, undefined, outcome.error?.code);
  assert.equal(outcome.args.clock.calls, 4);
});

test('Zeit: ungueltige Uhrwerte und Rueckspruenge werden abgelehnt', async () => {
  await rejectsWithoutWrites(null, 'publish-uhr', withClock(new Date(Number.NaN)));
  await rejectsWithoutWrites(null, 'publish-uhr', withClock({ getTime: () => NOW }));
  await rejectsWithoutWrites(null, 'publish-uhr', withClock(new Proxy(new Date(NOW), {})));
  await rejectsWithoutWrites(null, 'publish-uhr', { clock: () => { throw new Error('kaputt'); } });
  await rejectsWithoutWrites(null, 'publish-uhr-rueckwaerts', withClock(NOW, NOW - 1));

  const backwards = await publish({ changes: withClock(NOW, NOW, D(30 * MIN), D(30 * MIN) - 1) });
  assertCleanedUp(backwards, 'publish-uhr-rueckwaerts');
  // Ein Date-Ableger mit falschem getTime zaehlt mit seinem echten Zeitwert.
  class FakeDate extends Date {
    getTime() {
      return 0;
    }
  }
  const real = await publish({ changes: withClock(new FakeDate(NOW), NOW, NOW, NOW) });
  assert.equal(real.error, undefined, real.error?.code);
});

test('Zeit: reine Fristpruefungen einzeln an den Grenzen', () => {
  const code = c => error => error.code === c;
  assert.equal(checkApprovalDeadline(APPROVAL_TIME, APPROVAL + APPROVAL_DEADLINE_MS), true);
  assert.throws(() => checkApprovalDeadline(APPROVAL_TIME, APPROVAL + APPROVAL_DEADLINE_MS + 1), code('publish-freigabe-abgelaufen'));
  // 59:50 plus weitere 90 Sekunden.
  assert.throws(() => checkApprovalDeadline(APPROVAL_TIME, APPROVAL + 59 * MIN + 50_000 + 90_000), code('publish-freigabe-abgelaufen'));
  assert.equal(checkApprovalDeadline(APPROVAL_TIME, APPROVAL + 59 * MIN + 50_000), true);

  assert.equal(checkBranchReserve(APPROVAL_TIME, APPROVAL + 58 * MIN - 1), true);
  assert.equal(checkBranchReserve(APPROVAL_TIME, APPROVAL + 58 * MIN), true);
  assert.throws(() => checkBranchReserve(APPROVAL_TIME, APPROVAL + 58 * MIN + 1), code('publish-freigabe-reserve'));
  assert.equal(BRANCH_RESERVE_MS, 120_000);

  assert.equal(checkTimeWindow(1000, 1000 + 120_000), true);
  assert.throws(() => checkTimeWindow(1000, 1000 + 120_001), code('publish-zeitklammer'));
  assert.throws(() => checkTimeWindow(1000, 999), code('publish-uhr-rueckwaerts'));
  assert.equal(PUBLISH_WINDOW_MS, 120_000);

  for (const bad of [Number.NaN, 1.5, '5', null]) {
    assert.throws(() => checkApprovalDeadline(APPROVAL_TIME, bad), code('publish-uhr'));
    assert.throws(() => checkTimeWindow(bad, 5), code('publish-uhr'));
  }

  for (const bad of ['', 'gestern', null, 5]) {
    assert.throws(() => checkApprovalDeadline(bad, NOW), code('publish-freigabe-zeit'));
  }
});

// ---------------------------------------------------------------------------
// Phase C: Git-Objekte
// ---------------------------------------------------------------------------

// Fehler in Phase C: kein Branch, also nichts zu loeschen.
function assertNoBranch(outcome, code) {
  const bericht = assertFail(outcome, code);
  assert.equal(bericht.schritt, 'C');
  assert.ok(!writes(outcome.sim).includes('POST git/refs'));
  assert.equal(bericht.bereinigung, 'nicht-noetig');
  assert.equal(outcome.sim.refs.size, 0);
  return bericht;
}

async function tampered(tamper) {
  const sim = createSim();
  sim.tamper = tamper;
  return publish({ sim });
}

const blobPost = isReq('POST', /^git\/blobs$/);
const treeGet = isReq('GET', /^git\/trees\//);
const commitGet = isReq('GET', /^git\/commits\//);

test('Phase C: Blob-Antworten werden streng geprueft', async () => {
  const wrong = await tampered(tamperNth(blobPost, 1, jsonEdit(json => { json.sha = 'b'.repeat(40); })));
  assertNoBranch(wrong, 'publish-blob-abweichung');
  assert.deepEqual(writes(wrong.sim), ['POST git/blobs']);

  assertNoBranch(await tampered(tamperNth(blobPost, 2, res => ({ ...res, status: 200 }))), 'publish-http-status');
  assertNoBranch(await tampered(tamperNth(blobPost, 1, () => ({ status: 302, headers: { location: 'https://example.invalid' }, body: '' }))), 'publish-umleitung');
  assertNoBranch(await tampered(tamperNth(blobPost, 1, res => ({ ...res, body: res.body.slice(0, 10) }))), 'publish-antwort-json');
  assertNoBranch(await tampered(tamperNth(blobPost, 1, res => ({ ...res, headers: { link: '<x>; rel="next"' } }))), 'publish-antwort-unvollstaendig');
  assertNoBranch(await tampered(tamperNth(blobPost, 1, res => ({ ...res, headers: { A: '1', a: '2' } }))), 'publish-antwort-format');
  assertNoBranch(await tampered(tamperNth(blobPost, 1, jsonEdit(json => ({ ...json, rest: 'x'.repeat(16 * 1024 * 1024) })))), 'publish-antwort-gross');

  const sim = createSim();
  sim.override = req => {
    if (blobPost(req)) {
      throw new Error('Token ghs_GEHEIM im Text');
    }
  };
  const thrown = await publish({ sim });
  assertNoBranch(thrown, 'publish-transport-fehler');
  assert.ok(!thrown.error.message.includes('GEHEIM') && !thrown.error.cause.message.includes('GEHEIM'));
});

test('Phase C: Ausgangscommit und Ausgangsbaum muessen dem lokalen Ausgangscommit entsprechen', async () => {
  assertNoBranch(await tampered(tamperNth(commitGet, 1, jsonEdit(json => { json.tree.sha = 'c'.repeat(40); }))), 'publish-basis-baum');
  assertNoBranch(await tampered(tamperNth(commitGet, 1, jsonEdit(json => { json.sha = 'c'.repeat(40); }))), 'publish-basis-baum');
  assertNoBranch(await tampered(tamperNth(treeGet, 1, jsonEdit(json => { json.tree.push({ path: 'extra.js', mode: '100644', type: 'blob', sha: 'd'.repeat(40) }); }))), 'publish-basis-baum');
  assertNoBranch(await tampered(tamperNth(treeGet, 1, jsonEdit(json => { json.tree.find(e => e.path === 'README.md').sha = 'd'.repeat(40); }))), 'publish-basis-baum');
  assertNoBranch(await tampered(tamperNth(treeGet, 1, jsonEdit(json => { json.tree.find(e => e.path === 'README.md').mode = '100755'; }))), 'publish-basis-baum');
  assertNoBranch(await tampered(tamperNth(treeGet, 1, jsonEdit(json => { json.tree = json.tree.filter(e => e.path !== 'docs/tief'); }))), 'publish-basis-baum');
  assertNoBranch(await tampered(tamperNth(treeGet, 1, jsonEdit(json => { json.truncated = true; }))), 'publish-baum-unvollstaendig');
});

test('Phase C: der neue Baum muss vollstaendig, eindeutig und genau wie erwartet sein', async () => {
  const newTree = edit => tampered(tamperNth(treeGet, 2, jsonEdit(edit)));
  const entry = (json, path) => json.tree.find(e => e.path === path);

  assertNoBranch(await newTree(json => { json.truncated = true; }), 'publish-baum-unvollstaendig');
  assertNoBranch(await newTree(json => { delete json.truncated; }), 'publish-baum-unvollstaendig');
  assertNoBranch(await newTree(json => { json.tree.push({ path: 'extra.js', mode: '100644', type: 'blob', sha: 'd'.repeat(40) }); }), 'publish-baum-abweichung');
  assertNoBranch(await newTree(json => { json.tree = json.tree.filter(e => e.path !== 'README.md'); }), 'publish-baum-abweichung');
  assertNoBranch(await newTree(json => { json.tree = json.tree.filter(e => e.path !== 'src/rechne.js'); json.tree.push({ path: 'src/anders.js', mode: '100644', type: 'blob', sha: 'd'.repeat(40) }); }), 'publish-baum-abweichung');
  assertNoBranch(await newTree(json => { entry(json, 'src/rechne.js').mode = '100755'; }), 'publish-baum-datei');
  assertNoBranch(await newTree(json => { entry(json, 'src/rechne.js').mode = '120000'; }), 'publish-baum-datei');
  assertNoBranch(await newTree(json => { entry(json, 'test/rechne.test.js').sha = 'd'.repeat(40); }), 'publish-baum-datei');
  assertNoBranch(await newTree(json => { entry(json, 'README.md').sha = 'd'.repeat(40); }), 'publish-baum-abweichung');
  assertNoBranch(await newTree(json => { entry(json, 'README.md').mode = '100755'; }), 'publish-baum-abweichung');
  assertNoBranch(await newTree(json => { json.tree.push({ ...entry(json, 'README.md') }); }), 'publish-baum-format');
  assertNoBranch(await newTree(json => { json.sha = 'e'.repeat(40); }), 'publish-baum-format');
  assertNoBranch(await newTree(json => { entry(json, 'README.md').type = 'symlink'; }), 'publish-baum-format');
  assertNoBranch(await tampered(tamperNth(isReq('POST', /^git\/trees$/), 1, jsonEdit(json => { json.sha = 'nicht-hex'; }))), 'publish-baum-format');
});

test('Phase C: Commit muss genau den neuen Baum und genau den Ausgangscommit als Elternteil tragen', async () => {
  const readBack = edit => tampered(tamperNth(commitGet, 2, jsonEdit(edit)));
  assertNoBranch(await readBack(json => { json.parents.push({ sha: OTHER }); }), 'publish-commit-abweichung');
  assertNoBranch(await readBack(json => { json.parents = [{ sha: OTHER }]; }), 'publish-commit-abweichung');
  assertNoBranch(await readBack(json => { json.parents = []; }), 'publish-commit-abweichung');
  assertNoBranch(await readBack(json => { json.tree.sha = 'f'.repeat(40); }), 'publish-commit-abweichung');
  assertNoBranch(await readBack(json => { json.sha = 'f'.repeat(40); }), 'publish-commit-abweichung');
  assertNoBranch(await tampered(tamperNth(isReq('POST', /^git\/commits$/), 1, jsonEdit(json => { json.sha = 42; }))), 'publish-commit-format');
});

// ---------------------------------------------------------------------------
// Phase E: Branch-Anlage-Marker
// ---------------------------------------------------------------------------

const refPost = isReq('POST', /^git\/refs$/);

test('Phase E: ohne eindeutige Bestaetigung der Anlage wird nie geloescht', async () => {
  // GitHub legt den Branch an, die Antwort geht verloren.
  const lost = createSim();
  lost.override = (req, sim) => {
    if (refPost(req)) {
      handle(sim, req);
      throw new Error('Zeitlimit');
    }
  };
  const lostOutcome = await publish({ sim: lost });
  const bericht = assertNotCleanedUp(lostOutcome, 'publish-transport-fehler', 'branch-anlage-unbestaetigt');
  assert.equal(bericht.branch_bestaetigt, false);
  assert.equal(bericht.schritt, 'E');
  assert.ok(lost.refs.has(`refs/heads/${BRANCH}`), 'Branch bleibt stehen');

  assertNotCleanedUp(await tampered(tamperNth(refPost, 1, jsonEdit(json => { json.object.sha = OTHER; }))), 'publish-branch-antwort', 'branch-anlage-unbestaetigt');
  assertNotCleanedUp(await tampered(tamperNth(refPost, 1, jsonEdit(json => { json.ref = 'refs/heads/main'; }))), 'publish-branch-antwort', 'branch-anlage-unbestaetigt');
  assertNotCleanedUp(await tampered(tamperNth(refPost, 1, jsonEdit(json => [json]))), 'publish-branch-antwort', 'branch-anlage-unbestaetigt');
  assertNotCleanedUp(await tampered(tamperNth(refPost, 1, res => ({ ...res, status: 200 }))), 'publish-http-status', 'branch-anlage-unbestaetigt');
  assertNotCleanedUp(await tampered(tamperNth(refPost, 1, () => unprocessable())), 'publish-http-status', 'branch-anlage-unbestaetigt');
});

// ---------------------------------------------------------------------------
// Phase F und H: Unveraendert-Pruefung nach der Branch-Anlage
// ---------------------------------------------------------------------------

async function changedAt(n, change) {
  const sim = createSim();
  sim.onRequest = atLiveRead(n, change);
  return publish({ sim });
}

test('Phase F: jede Abweichung nach der Branch-Anlage wird erkannt und der eigene Branch geloescht', async () => {
  const cases = [
    [s => { s.mainSha = OTHER; }, 'publish-unveraendert-main'],
    [s => { s.issue.comments = 1; }, 'publish-unveraendert-issue'],
    [s => { s.issue = { comments: 0, ...s.issue }; }, 'publish-unveraendert-issue'],
    [s => { s.issue.labels[0].color = 'ffffff'; }, 'publish-unveraendert-issue'],
    [s => { s.events.push({ id: 6000, event: 'subscribed', created_at: '2026-11-10T08:39:00Z', actor: { login: 'jemand', type: 'User' }, performed_via_github_app: null }); }, 'publish-unveraendert-ereignisse'],
    [s => { s.events[0].created_at = '2026-11-10T08:00:01Z'; }, 'publish-unveraendert-ereignisse'],
    [s => { s.events.reverse(); }, 'publish-unveraendert-ereignisse'],
    [s => { s.refs.set(`refs/heads/wp/${ISSUE}-fremd`, BASE); }, 'publish-unveraendert-branches'],
    [s => { s.pulls.push(pullRecord(7, `wp/${ISSUE}-anderer`)); }, 'publish-unveraendert-pr'],
    [s => { s.run = { ...liveRun(), id: 1 }; }, 'publish-unveraendert-lauf'],
    [s => { s.run = { ...liveRun(), head_sha: OTHER }; }, 'publish-unveraendert-lauf'],
  ];

  for (const [change, code] of cases) {
    const bericht = assertCleanedUp(await changedAt(4, change), code);
    assert.equal(bericht.schritt, 'F');
  }

  // Status und Zeitstempel des Laufs duerfen sich aendern.
  const running = await changedAt(4, s => { s.run = { ...liveRun(), status: 'completed', updated_at: '2026-11-10T08:41:00Z' }; });
  assert.equal(running.error, undefined, running.error?.code);
});

test('Phase F: der eigene Branch fehlt in der Branch-Liste', async () => {
  const outcome = await changedAt(4, s => { s.refs.set(`refs/heads/${BRANCH}x`, BASE); s.refs.delete(`refs/heads/${BRANCH}`); });
  // Ohne eigenen Branch zeigt auch die Bereinigung keine passende Spitze: nicht loeschen.
  assertNotCleanedUp(outcome, 'publish-unveraendert-branches', 'branch-spitze');
});

test('Phase F: ein PR auf dem eigenen Branch verhindert das Loeschen', async () => {
  const outcome = await changedAt(4, s => { s.pulls.push(pullRecord(8, BRANCH)); });
  assertNotCleanedUp(outcome, 'publish-unveraendert-pr', 'pr-vorhanden');
  assert.ok(outcome.sim.refs.has(`refs/heads/${BRANCH}`));
});

test('Phase H: Abweichung zwischen F und H verhindert den PR', async () => {
  for (const [change, code] of [
    [s => { s.issue.comments = 2; }, 'publish-unveraendert-issue'],
    [s => { s.mainSha = OTHER; }, 'publish-unveraendert-main'],
    [s => { s.pulls.push(pullRecord(9, `wp/${ISSUE}-neu`)); }, 'publish-unveraendert-pr'],
  ]) {
    const bericht = assertCleanedUp(await changedAt(5, change), code);
    assert.equal(bericht.schritt, 'H');
  }
});

// ---------------------------------------------------------------------------
// Konkreter Branch-Ref und Remote-Diff
// ---------------------------------------------------------------------------

const refGet = isReq('GET', new RegExp(`^git/ref/heads/${BRANCH}$`));

test('Branch-Ref: nur ein einzelnes Objekt auf genau den eigenen Commit', async () => {
  // Nur die Antwort in F wird veraendert, die Bereinigung liest die echte Spitze und loescht.
  for (const [edit, code] of [
    [json => [json], 'publish-ref-format'],
    [json => [], 'publish-ref-format'],
    [json => { json.object.sha = OTHER; }, 'publish-ref-abweichung'],
    [json => { json.object.type = 'tag'; }, 'publish-ref-abweichung'],
    [json => { json.ref = `refs/heads/${BRANCH}-x`; }, 'publish-ref-abweichung'],
  ]) {
    assertCleanedUp(await tampered(tamperNth(refGet, 1, jsonEdit(edit))), code);
  }

  // In H.
  assertCleanedUp(await tampered(tamperNth(refGet, 2, jsonEdit(json => { json.object.sha = OTHER; }))), 'publish-ref-abweichung');
  assertCleanedUp(await tampered(tamperNth(refGet, 2, () => notFound())), 'publish-http-status');
});

test('Remote-Diff: genau ein Commit, genau die Dateien, nur modified mit dem geprueften Blob', async () => {
  const compareGet = isReq('GET', /^compare\//);
  const edits = [
    [json => { json.ahead_by = 2; }, 'publish-compare-commits'],
    [json => { json.behind_by = 1; }, 'publish-compare-commits'],
    [json => { json.status = 'diverged'; }, 'publish-compare-commits'],
    [json => { json.total_commits = 2; }, 'publish-compare-commits'],
    [json => { json.commits.push({ sha: OTHER }); }, 'publish-compare-commits'],
    [json => { json.commits[0].sha = OTHER; }, 'publish-compare-commits'],
    [json => { json.files.push({ ...json.files[0], filename: 'extra.js' }); }, 'publish-compare-dateien'],
    [json => { json.files.pop(); }, 'publish-compare-dateien'],
    [json => { delete json.files; }, 'publish-compare-dateien'],
    [json => { json.files[1] = { ...json.files[0] }; }, 'publish-compare-dateien'],
    [json => { json.files[0].filename = 'README.md'; }, 'publish-compare-dateien'],
    [json => { json.files[0].status = 'added'; }, 'publish-compare-status'],
    [json => { json.files[0].status = 'renamed'; }, 'publish-compare-status'],
    [json => { json.files[0].previous_filename = 'alt.js'; }, 'publish-compare-status'],
    [json => { json.files[1].sha = 'a'.repeat(40); }, 'publish-compare-blob'],
    [json => [json], 'publish-compare-commits'],
  ];

  for (const [edit, code] of edits) {
    const bericht = assertCleanedUp(await tampered(tamperNth(compareGet, 1, jsonEdit(edit))), code);
    assert.equal(bericht.schritt, 'G');
  }

  assertCleanedUp(await tampered(tamperNth(compareGet, 1, res => ({ ...res, headers: { Link: '<x>; rel="next"' } }))), 'publish-antwort-unvollstaendig');
});

// ---------------------------------------------------------------------------
// PR-Antwort und PR-Anfrage-Marker: ab POST pulls nie loeschen
// ---------------------------------------------------------------------------

const pullPost = isReq('POST', /^pulls$/);

test('PR-Antwort: jede Abweichung wird abgelehnt, der Branch bleibt stehen', async () => {
  for (const edit of [
    json => { json.draft = false; },
    json => { delete json.draft; },
    json => { json.base.ref = 'dev'; },
    json => { json.base.repo.full_name = 'fremd/agenten-probe'; },
    json => { json.head.ref = 'wp/1-anderes'; },
    json => { json.head.repo.full_name = 'fremd/agenten-probe'; },
    json => { json.html_url = `https://github.com.evil.example/${REPO_NAME}/pull/${json.number}`; },
    json => { json.html_url = `https://github.com/${REPO_NAME}/pull/1`; },
    json => { json.number = 0; },
    json => { json.number = '5001'; },
    json => [json],
  ]) {
    assertAfterPull(await tampered(tamperNth(pullPost, 1, jsonEdit(edit))), 'publish-pr-antwort');
  }
});

test('PR-Anfrage: Zeitlimit, Fehlerstatus oder verlorene Antwort fuehren nie zum Loeschen', async () => {
  const lost = createSim();
  lost.override = (req, sim) => {
    if (pullPost(req)) {
      handle(sim, req);
      throw new Error('Verbindung abgebrochen');
    }
  };
  const bericht = assertAfterPull(await publish({ sim: lost }), 'publish-transport-fehler');
  assert.equal(bericht.schritt, 'H');
  assert.equal(lost.pulls.at(-1).head.ref, BRANCH, 'GitHub hat den PR angelegt');

  assertAfterPull(await tampered(tamperNth(pullPost, 1, () => ({ status: 500, headers: {}, body: '{}' }))), 'publish-http-status');
  assertAfterPull(await tampered(tamperNth(pullPost, 1, res => ({ ...res, status: 200 }))), 'publish-http-status');
  assertAfterPull(await tampered(tamperNth(pullPost, 1, () => ({ status: 422, headers: {}, body: '{"message":"x"}' }))), 'publish-http-status');
});

// ---------------------------------------------------------------------------
// Bereinigung: jede Bedingung einzeln
// ---------------------------------------------------------------------------

// Loest einen Fehler in G aus (zusaetzliche Datei im Remote-Diff), danach greift die Bereinigung.
const failInCompare = () => tamperNth(isReq('GET', /^compare\//), 1, jsonEdit(json => { json.files.pop(); }));

test('Bereinigung: unlesbare PR-Liste, abgelehnte Loeschung oder fremde Spitze lassen den Branch stehen', async () => {
  // PR-Liste in der Bereinigung (fuenfte Live-Lesung: A, B, D, F, Bereinigung) nicht lesbar.
  const noList = createSim();
  const noListFail = failInCompare();
  noList.tamper = (req, res, sim) => noListFail(req, res) ?? (sim.liveReads === 5 && /^pulls\?/.test(restOf(req)) ? { status: 500, headers: {}, body: '{}' } : undefined);
  const a = assertNotCleanedUp(await publish({ sim: noList }), 'publish-compare-dateien', 'pr-liste');
  assert.equal(a.branch_bestaetigt, true);

  // Loeschen abgelehnt: der urspruengliche Fehler bleibt erhalten.
  const refused = createSim();
  const refusedFail = failInCompare();
  refused.tamper = (req, res) => refusedFail(req, res) ?? (req.method === 'DELETE' ? { status: 500, headers: {}, body: '' } : undefined);
  const outcome = await publish({ sim: refused });
  const b = assertFail(outcome, 'publish-compare-dateien');
  assert.equal(b.bereinigung, 'nicht-geloescht');
  assert.equal(b.bereinigung_grund, 'loeschen-abgelehnt');
  assert.deepEqual(writes(refused).at(-1), `DELETE git/refs/heads/${BRANCH}`);

  // Antwort auf DELETE mit Inhalt gilt nicht als Bestaetigung.
  const odd = createSim();
  const oddFail = failInCompare();
  odd.tamper = (req, res) => oddFail(req, res) ?? (req.method === 'DELETE' ? { ...res, body: '{}' } : undefined);
  const c = assertFail(await publish({ sim: odd }), 'publish-compare-dateien');
  assert.equal(c.bereinigung_grund, 'loeschen-abgelehnt');

  // Spitze zeigt inzwischen auf einen anderen Commit.
  const moved = createSim();
  const movedFail = failInCompare();
  moved.tamper = (req, res) => movedFail(req, res) ?? (refGet(req) && moved.log.filter(refGet).length === 2 ? jsonEdit(json => { json.object.sha = OTHER; })(res) : undefined);
  assertNotCleanedUp(await publish({ sim: moved }), 'publish-compare-dateien', 'branch-spitze');

  // Kontrolle: ohne Stoerung wird geloescht, und zwar genau der eigene Branch.
  const clean = createSim();
  clean.tamper = failInCompare();
  const cleaned = await publish({ sim: clean });
  assertCleanedUp(cleaned, 'publish-compare-dateien');
  assert.equal(clean.log.at(-1).path, `${P}git/refs/heads/${BRANCH}`);
  assert.equal(clean.log.at(-1).body, undefined);
});

test('Bereinigung: ein fremder Branch mit aehnlichem Namen wird nie geloescht', async () => {
  const sim = createSim();
  sim.tamper = failInCompare();
  sim.onRequest = atLiveRead(5, s => { s.refs.set(`refs/heads/wp/${ISSUE}-agent-${RUN_ID}-2`, BASE); });
  const outcome = await publish({ sim });
  assertCleanedUp(outcome, 'publish-compare-dateien');
  assert.ok(sim.refs.has(`refs/heads/wp/${ISSUE}-agent-${RUN_ID}-2`));
  assert.equal(writes(sim).filter(entry => entry.startsWith('DELETE')).length, 1);
});

// ---------------------------------------------------------------------------
// Erlaubte Anfragen und Branch-Name
// ---------------------------------------------------------------------------

test('API-Grenze: nur die erlaubten Methoden und Pfade', () => {
  const sha = 'a'.repeat(40);
  const allowed = [
    ['POST', 'git/blobs'], ['POST', 'git/trees'], ['POST', 'git/commits'], ['POST', 'git/refs'], ['POST', 'pulls'],
    ['GET', `git/commits/${sha}`], ['GET', `git/trees/${sha}?recursive=1`], ['GET', `compare/${sha}...${sha}`],
    ['GET', `git/ref/heads/${BRANCH}`], ['DELETE', `git/refs/heads/${BRANCH}`],
  ];

  for (const [method, rest] of allowed) {
    assert.equal(checkPublishRequest(method, `${P}${rest}`, BRANCH), true, `${method} ${rest}`);
  }

  const rejected = [
    ['PUT', 'git/blobs', 'publish-methode'], ['PATCH', `git/refs/heads/${BRANCH}`, 'publish-methode'], ['HEAD', `git/commits/${sha}`, 'publish-methode'],
    ['POST', `issues/${ISSUE}/comments`, 'publish-pfad'], ['POST', 'git/tags', 'publish-pfad'], ['POST', 'git/refs/heads/x', 'publish-pfad'],
    ['POST', 'pulls/1/merge', 'publish-pfad'], ['POST', 'merges', 'publish-pfad'], ['POST', 'actions/secrets', 'publish-pfad'],
    ['DELETE', 'git/refs/heads/main', 'publish-pfad'], ['DELETE', `git/refs/heads/wp/${ISSUE}-agent-${RUN_ID}-2`, 'publish-pfad'],
    ['DELETE', `git/refs/heads/${BRANCH}/x`, 'publish-pfad'], ['DELETE', `issues/${ISSUE}`, 'publish-pfad'],
    ['GET', 'git/ref/heads/main', 'publish-pfad'], ['GET', `git/trees/${sha}`, 'publish-pfad'], ['GET', `git/trees/${sha}?recursive=0`, 'publish-pfad'],
    ['GET', `git/commits/${sha.toUpperCase()}`, 'publish-pfad'], ['GET', `compare/${sha}..${sha}`, 'publish-pfad'], ['GET', 'git/ref/heads/wp/1-anderes', 'publish-pfad'],
    ['GET', `compare/main...${sha}`, 'publish-pfad'],
  ];

  for (const [method, rest, code] of rejected) {
    assert.throws(() => checkPublishRequest(method, `${P}${rest}`, BRANCH), error => error.code === code, `${method} ${rest}`);
  }

  for (const path of ['/repos/noah04091/anderes/git/blobs', `https://api.github.com${P}git/blobs`, `${P.slice(0, -1)}`, null]) {
    assert.throws(() => checkPublishRequest('POST', path, BRANCH), error => error.code === 'publish-pfad');
  }

  // Ohne gueltigen eigenen Branch kein Ref-Zugriff und kein Loeschen.
  for (const branch of [null, 'main', `wp/${ISSUE}-agent-${RUN_ID}-2`, `${BRANCH}/x`]) {
    assert.throws(() => checkPublishRequest('DELETE', `${P}git/refs/heads/${branch}`, branch), error => error.code === 'publish-pfad');
    assert.throws(() => checkPublishRequest('GET', `${P}git/ref/heads/${branch}`, branch), error => error.code === 'publish-pfad');
  }
});

test('Branch-Name: fest aus Issue und Lauf-ID, keine freie Eingabe', () => {
  assert.equal(branchName(ISSUE, RUN_ID), BRANCH);
  assert.equal(branchName(38, '1'), 'wp/38-agent-1-1');

  for (const [issue, runId] of [[0, RUN_ID], [10_000_001, RUN_ID], ['38', RUN_ID], [38.5, RUN_ID], [38, '0'], [38, '01'], [38, 'x'], [38, 7], [38, '1/../main']]) {
    assert.throws(() => branchName(issue, runId), error => error.code === 'publish-branch-name');
  }
});

// ---------------------------------------------------------------------------
// Wachtests auf Quelltext und Workflows
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(MODULE_PATH, 'utf8');
const MODULES = ['agent-code-auftrag.mjs', 'agent-code-auftrag-live.mjs', 'agent-code-auftrag-prompt.mjs', 'agent-code-auftrag-paket.mjs', 'agent-code-auftrag-publish.mjs'];

test('Wache: nur die vorgesehenen Importe, kein Netz-, Prozess-, Umgebungs- oder Protokollzugriff', () => {
  const imports = [...SOURCE.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./agent-code-auftrag-live.mjs', './agent-code-auftrag-paket.mjs', './agent-code-auftrag.mjs', 'node:crypto', 'node:fs', 'node:path', 'node:util']);
  assert.equal([...SOURCE.matchAll(/\bimport\b/g)].length, imports.length);
  assert.ok(SOURCE.includes("import { applyPackageV2, packageFileBytes, parsePackageV2 } from './agent-code-auftrag-paket.mjs';"));
  assert.ok(SOURCE.includes("import { MAX_BODY_BYTES, checkApiRequest, checkLiveOrder, readLiveState } from './agent-code-auftrag-live.mjs';"));
  assert.ok(!/^import[^;]*\bas\b/m.test(SOURCE), 'Umbenennung im Import');
  assert.ok(!/\bexport\b[^;]*\bfrom\b/.test(SOURCE), 'export ... from im Modul');

  for (const forbidden of [
    /\bprocess\b/, /\bfetch\b/, /\bglobalThis\b/, /\brequire\b/, /\bconsole\b/, /GITHUB_/, /child_process/, /\bexecFile/, /\bspawn/, /\beval\b/,
    /\bFunction\b/, /\bnode:(net|http|https|dns|worker_threads|vm)\b/, /comments/, /'PUT'/, /'PATCH'/, /checkCodeChanges/, /from '\.\/agent-code-publish\.mjs'/,
    /writeFileSync/, /\bmerge\b/,
  ]) {
    assert.ok(!forbidden.test(SOURCE), `verbotener Zugriff im Modul: ${forbidden}`);
  }

  // Transport und Uhr nur ohne this aufrufen. Muss-Treffer: die Aufrufe ueber Reflect.apply gibt es.
  assert.ok(!/ctx\.(transport|clock)\s*\(/.test(SOURCE), 'Aufruf mit ctx als this');
  assert.equal([...SOURCE.matchAll(/Reflect\.apply\(ctx\.(transport|clock), undefined,/g)].length, 3);

  // Muss-Treffer: dieselben Suchen finden etwas im A5-Veroeffentlicher.
  const old = readFileSync(join(ROOT, 'scripts/agent-code-publish.mjs'), 'utf8');
  assert.ok(/\bprocess\b/.test(old) && /comments/.test(old) && /checkCodeChanges/.test(old));
});

test('Wache: Schreibmethoden nur an den erlaubten Stellen im Quelltext', () => {
  const posts = [...SOURCE.matchAll(/send\(ctx, 'POST', '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(posts, ['git/blobs', 'git/trees', 'git/commits', 'git/refs', 'pulls']);
  const deletes = [...SOURCE.matchAll(/send\(ctx, 'DELETE', `([^`]+)`/g)].map(m => m[1]);
  assert.deepEqual(deletes, ['git/refs/heads/${ctx.branch}']);
  assert.equal([...SOURCE.matchAll(/'DELETE'/g)].length, 3, 'DELETE nur in Grenze, Gate und Bereinigung');
  // Muss-Treffer der Suche nach GET-Aufrufen.
  assert.ok([...SOURCE.matchAll(/send\(ctx, 'GET', /g)].length >= 5);
});

test('Wache: kein Workflow und kein anderes Skript verweist auf das Modul', () => {
  const dir = join(ROOT, '.github/workflows');
  const files = readdirSync(dir).filter(name => /\.ya?ml$/.test(name));
  const texts = files.map(name => readFileSync(join(dir, name), 'utf8'));
  assert.ok(files.length >= 10, 'Gegenprobe: zu wenige Workflows gefunden');
  assert.ok(texts.some(text => text.includes('agent-code-package')), 'Gegenprobe ohne Treffer');
  assert.ok(texts.every(text => !text.includes('agent-code-auftrag')), 'ein Workflow verweist auf ein Auftragsmodul');

  const scripts = join(ROOT, 'scripts');
  const names = readdirSync(scripts).filter(name => name.endsWith('.mjs'));
  assert.ok(MODULES.every(name => names.includes(name)), 'Gegenprobe: ein Auftragsmodul fehlt');
  const others = names.filter(name => !MODULES.includes(name)).map(name => readFileSync(join(scripts, name), 'utf8'));
  assert.equal(others.length, names.length - MODULES.length);
  assert.ok(others.length >= 10, 'Gegenprobe: zu wenige Skripte gefunden');
  assert.ok(others.some(text => text.includes('./agent-code-release-plan.mjs')), 'Gegenprobe ohne Treffer');
  assert.ok(others.every(text => !text.includes('agent-code-auftrag')), 'ein Skript verweist auf ein Auftragsmodul');
  // Nur dieses Modul selbst darf die anderen Auftragsmodule importieren, kein anderes Auftragsmodul importiert es.
  for (const name of MODULES.filter(name => name !== 'agent-code-auftrag-publish.mjs')) {
    assert.ok(!readFileSync(join(scripts, name), 'utf8').includes('agent-code-auftrag-publish'), `${name} verweist auf das Modul`);
  }
  assert.ok(SOURCE.includes("from './agent-code-auftrag.mjs'"), 'Gegenprobe: Import nicht gefunden');
});

