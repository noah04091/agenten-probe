// Tests fuer scripts/agent-code-auftrag-live.mjs (A6.2-2).
//
// Alle GitHub-Antworten sind kuenstlich und kommen aus einem API-Double im Speicher. Es gibt keine
// Netzanfragen, keine Zugangsdaten, keine GitHub-Schreibzugriffe und keine Agentenstarts. Das
// Git-Repository fuer resolveOrder entsteht in einem eigenen Temp-Ordner mit isoliertem HOME und
// wird am Ende entfernt. Auf das echte Repository wird nur lesend ueber das Dateisystem zugegriffen
// (Profile, Policy-Fixture, Quelltext und Workflows fuer die Wachtests), nie mit git.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OrderError, orderSha256, resolveOrder, sameOrder } from '../scripts/agent-code-auftrag.mjs';
import {
  MAX_BODY_BYTES,
  MAX_PAGES,
  PER_PAGE,
  WORKFLOW_PATH,
  checkApiRequest,
  checkLiveOrder,
  readLiveState,
} from '../scripts/agent-code-auftrag-live.mjs';
import { ProfileError } from '../scripts/agent-profile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_PATH = join(ROOT, 'scripts/agent-code-auftrag-live.mjs');
const RECHNER_BYTES = readFileSync(join(ROOT, 'agent-profiles/js-rechner.json'));
const TEXT_BYTES = readFileSync(join(ROOT, 'agent-profiles/js-text.json'));
const DRAFT_POLICY_BYTES = readFileSync(join(ROOT, 'test/fixtures/agent-policy.entwurf.json'));

const canon = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const POLICY_BYTES = canon({ ...JSON.parse(DRAFT_POLICY_BYTES), skript_hashes: { 'scripts/agent-profile.mjs': 'a'.repeat(64) } });

const ISSUE = 999001;
const RUN_ID = '42783596004';
const REPO_NAME = 'noah04091/agenten-probe';
const P = `/repos/${REPO_NAME}/`;
const OWNER_USER = Object.freeze({ login: 'noah04091', type: 'User' });

const BASE_FILES = Object.freeze({
  '.github/agent/policy.json': POLICY_BYTES,
  'agent-profiles/js-rechner.json': RECHNER_BYTES,
  'agent-profiles/js-text.json': TEXT_BYTES,
  'src/rechne.js': 'export const addiere = (a, b) => a + b;\n',
  'test/rechne.test.js': "import test from 'node:test';\n",
  [`agent-acceptance/issue-${ISSUE}.mjs`]: '// synthetische Abnahme, wird nie ausgefuehrt\nexport const synthetisch = true;\n',
});

// ---------------------------------------------------------------------------
// Temp-Repository mit isolierter Git-Umgebung (wie in agent-code-auftrag.test.mjs)
// ---------------------------------------------------------------------------

const GIT_PASSTHROUGH = Object.freeze(['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']);
let BASE_DIR;
let REPO;
let ENV;
let BASE;
let OTHER_SHA;
let EXPECTED;

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

function git(args, input) {
  return execFileSync('git', args, {
    cwd: REPO,
    env: ENV,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

function commitWith(files, message) {
  git(['read-tree', '--empty']);

  for (const [path, content] of Object.entries(files)) {
    const oid = git(['hash-object', '-w', '--stdin'], content);
    git(['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`]);
  }

  return git(['commit-tree', git(['write-tree']), '-m', message]);
}

// ---------------------------------------------------------------------------
// Kuenstlicher GitHub-Zustand
// ---------------------------------------------------------------------------

const RUN_CREATED = '2026-11-10T08:33:41Z';
const NOW = '2026-11-10T08:40:00Z';
const APPROVAL_TIME = '2026-11-10T08:33:39Z';
const TITLE = 'Potenz ergaenzen';
const BODY = 'Bitte eine Funktion potenz(a, b) ergaenzen.';

const at = (iso, deltaSeconds) => new Date(Date.parse(iso) + deltaSeconds * 1000).toISOString().replace('.000Z', 'Z');

const labelEvent = (id, event, name, createdAt, actor = OWNER_USER, extra = {}) => ({
  id, event, created_at: createdAt, actor: { ...actor }, label: { name, color: 'ededed' }, performed_via_github_app: null, ...extra,
});

const baseEvents = () => [
  { id: 5000, event: 'assigned', created_at: '2026-11-10T08:00:00Z', actor: { ...OWNER_USER }, performed_via_github_app: null },
  labelEvent(5100, 'labeled', 'agent:js-rechner', '2026-11-10T08:30:00Z'),
  labelEvent(5101, 'labeled', 'bot-auftrag', APPROVAL_TIME),
];

// Fremde Ereignisse ohne Bedeutung fuer die Freigabe, um mehrere Seiten zu fuellen.
const fillerEvents = count => Array.from({ length: count }, (_, i) => ({
  id: i + 1, event: 'subscribed', created_at: '2026-11-10T07:00:00Z', actor: { login: 'jemand', type: 'User' }, performed_via_github_app: null,
}));

const payload = () => ({
  action: 'labeled',
  label: { name: 'bot-auftrag' },
  sender: { ...OWNER_USER },
  repository: { full_name: REPO_NAME },
  issue: { number: ISSUE, user: { login: 'noah04091' }, title: TITLE, body: BODY, updated_at: APPROVAL_TIME },
});

const liveIssue = (number = ISSUE) => ({
  number,
  state: 'open',
  title: TITLE,
  body: BODY,
  updated_at: APPROVAL_TIME,
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
  created_at: RUN_CREATED,
  actor: { ...OWNER_USER },
  triggering_actor: { ...OWNER_USER },
  repository: { full_name: REPO_NAME },
  head_repository: { full_name: REPO_NAME },
});

const pr = (number, ref, extra = {}) => ({
  number, state: 'closed', merged_at: null, head: { ref, repo: { full_name: REPO_NAME } }, ...extra,
});

// Fuellt die PR-Liste mit fremden PRs, deren Branch nie zu ISSUE passt.
const otherPrs = (count, start = 1) => Array.from({ length: count }, (_, i) => pr(start + i, `wp/${start + i}-anderes`));

function data(changes = {}) {
  return {
    issueNumber: ISSUE,
    issue: liveIssue(),
    events: baseEvents(),
    run: liveRun(),
    main: { ref: 'refs/heads/main', node_id: 'x', url: 'x', object: { sha: BASE, type: 'commit', url: 'x' } },
    refs: [],
    pulls: otherPrs(43),
    ...changes,
  };
}

const ok = (json, headers = {}) => ({ status: 200, headers, body: JSON.stringify(json) });
const LINK_BASE = 'https://api.github.com/repositories/1442279535/';

// Seiten wie gemessen: eine Seite ohne Link-Header; Seite 1 mit next und last; mittlere Seiten mit
// prev, next, last, first; letzte Seite mit prev und first; leere Seite hinter dem Ende mit prev,
// last und first.
function pageResponse(list, page, kind) {
  const pages = [];

  for (let i = 0; i < list.length; i += 100) {
    pages.push(list.slice(i, i + 100));
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

const eventsPath = (k, n = ISSUE) => `${P}issues/${n}/events?per_page=100&page=${k}`;
const pullsPath = k => `${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=${k}`;

function defaultResponse(d, path) {
  const n = d.issueNumber;
  const pageOf = prefix => (path.startsWith(prefix) ? Number(path.slice(prefix.length)) : null);

  if (path === `${P}issues/${n}`) {
    return ok(d.issue);
  }

  const eventPage = pageOf(`${P}issues/${n}/events?per_page=100&page=`);

  if (eventPage !== null) {
    return pageResponse(d.events, eventPage, `issues/${n}/events?`);
  }

  if (path === `${P}git/ref/heads/main`) {
    return ok(d.main);
  }

  if (path === `${P}git/matching-refs/heads/wp/${n}-`) {
    return ok(d.refs);
  }

  const pullPage = pageOf(`${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=`);

  if (pullPage !== null) {
    return pageResponse(d.pulls, pullPage, 'pulls?state=all&sort=created&direction=asc&');
  }

  if (path === `${P}actions/runs/${RUN_ID}`) {
    return ok(d.run);
  }

  return { status: 404, headers: {}, body: '{"message":"Not Found"}' };
}

// tweak: Pfad -> Antwort oder Funktion(request) -> Antwort, ueberschreibt den Normalfall.
function apiDouble(d = data(), tweak = {}) {
  const calls = [];
  const transport = async request => {
    calls.push(request);
    const special = Object.hasOwn(tweak, request.path) ? tweak[request.path] : undefined;

    if (special !== undefined) {
      return typeof special === 'function' ? special(request) : special;
    }

    return defaultResponse(d, request.path);
  };

  return { transport, calls };
}

const readArgs = (transport, changes = {}) => ({ transport, repository: REPO_NAME, issueNumber: ISSUE, runId: RUN_ID, ...changes });
const checkArgs = (state, changes = {}) => ({
  expectedSha256: EXPECTED,
  event: payload(),
  state,
  root: REPO,
  baseSha: BASE,
  gitEnv: { ...ENV },
  now: new Date(NOW),
  runId: RUN_ID,
  ...changes,
});

function assertCode(error, code) {
  assert.ok(error instanceof OrderError || error instanceof ProfileError, `unerwarteter Fehler: ${error?.stack ?? error}`);
  assert.equal(error.code, code, `erwartet ${code}, erhalten ${error.code}: ${error.message}`);
  return true;
}

// Vollstaendiger Ablauf: lesen, dann pruefen.
async function live({ d = data(), tweak = {}, read = {}, check = {} } = {}) {
  const { transport, calls } = apiDouble(d, tweak);
  const state = await readLiveState(readArgs(transport, read));
  const order = checkLiveOrder(checkArgs(state, check));
  return { order, calls, state };
}

async function liveRejects(code, options = {}) {
  await assert.rejects(() => live(options), error => assertCode(error, code));
}

async function readRejects(code, d = data(), tweak = {}, read = {}) {
  const { transport } = apiDouble(d, tweak);
  await assert.rejects(() => readLiveState(readArgs(transport, read)), error => assertCode(error, code));
}

function apiRejects(method, path, code) {
  assert.throws(() => checkApiRequest(method, path), error => assertCode(error, code));
}

before(() => {
  BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-auftrag-live-test-'));
  REPO = join(BASE_DIR, 'repo');
  const home = join(BASE_DIR, 'home');
  mkdirSync(REPO);
  mkdirSync(join(home, 'xdg'), { recursive: true });
  writeFileSync(join(home, 'leer.gitconfig'), '');
  ENV = gitTestEnv(home);
  git(['init', '-q']);
  BASE = commitWith(BASE_FILES, 'Testbaum');
  OTHER_SHA = commitWith({ ...BASE_FILES, 'src/rechne.js': 'export const addiere = (a, b) => b + a;\n' }, 'neuer main');

  // Der erwartete Hash entsteht wie spaeter in Job 0: aus der ersten Festlegung mit resolveOrder.
  EXPECTED = orderSha256(resolveOrder({
    root: REPO,
    baseSha: BASE,
    gitEnv: { ...ENV },
    repository: REPO_NAME,
    event: payload(),
    issue: liveIssue(),
    events: baseEvents(),
    run: { id: RUN_ID, attempt: 1, createdAt: RUN_CREATED },
    now: new Date('2026-11-10T08:34:00Z'),
  }));
});

after(() => {
  rmSync(BASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ---------------------------------------------------------------------------
// Positiv
// ---------------------------------------------------------------------------

test('Positiv: unveraenderter Live-Zustand bestaetigt denselben Auftrag ueber resolveOrder und sameOrder', async () => {
  const { order, calls, state } = await live();
  assert.equal(orderSha256(order), EXPECTED);
  assert.equal(sameOrder(order, EXPECTED), true);
  assert.equal(order.issue, ISSUE);
  assert.equal(order.base_sha, BASE);
  assert.deepEqual(order.lauf, { run_id: RUN_ID, run_attempt: 1, erstellt: RUN_CREATED });
  assert.equal(order.startfreigabe.ereignis_id, 5101);
  // Genau die sechs festen Endpunkte, jeweils nur GET, Seiten selbst gebaut.
  assert.deepEqual(calls.map(c => c.path), [
    `${P}actions/runs/${RUN_ID}`,
    `${P}git/ref/heads/main`,
    `${P}issues/${ISSUE}`,
    eventsPath(1),
    `${P}git/matching-refs/heads/wp/${ISSUE}-`,
    pullsPath(1),
  ]);
  assert.ok(calls.every(c => c.method === 'GET' && Object.isFrozen(c) && Reflect.ownKeys(c).length === 2));
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.events) && Object.isFrozen(state.issue));
  assert.equal(WORKFLOW_PATH, '.github/workflows/code-pilot-claude-stufe.yml');
  assert.equal(PER_PAGE, 100);
  assert.equal(MAX_PAGES, 10);
  assert.equal(MAX_BODY_BYTES, 16 * 1024 * 1024);
});

test('Positiv: synchroner Transport und Kopfzeilen in beliebiger Schreibweise', async () => {
  // Mehrere Seiten, damit der Link-Header wirklich gelesen werden muss (hier als "LINK").
  const d = data({ pulls: otherPrs(150) });
  const paths = [];
  const direct = request => {
    paths.push(request.path);
    const response = defaultResponse(d, request.path);
    return { ...response, headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toUpperCase(), v])) };
  };
  const state = await readLiveState(readArgs(direct));
  assert.equal(orderSha256(checkLiveOrder(checkArgs(state))), EXPECTED);
  assert.deepEqual(paths.filter(p => p.includes('pulls?')), [pullsPath(1), pullsPath(2)]);
});

test('Positiv: wiederholte Pruefung mit frisch gelesenem Zustand gelingt erneut', async () => {
  const first = await live();
  const second = await live({ check: { now: new Date(at(APPROVAL_TIME, 59 * 60)) } });
  assert.equal(orderSha256(first.order), orderSha256(second.order));
  // Genau 60:00 nach der Freigabe noch gueltig.
  await live({ check: { now: new Date(at(APPROVAL_TIME, 60 * 60)) } });
});

test('Positiv: Paginierung ohne Link-Header, mit mehreren Seiten und mit voller letzter Seite', async () => {
  // Eine Seite ohne Link-Header (gemessen: 43 PRs, kein Link-Header).
  const single = await live();
  assert.equal(single.calls.filter(c => c.path.includes('pulls?')).length, 1);
  // Leere PR-Liste ohne Link-Header.
  await live({ d: data({ pulls: [] }) });
  // Drei Seiten Ereignisse und PRs; letzte Seite hat nur prev und first.
  const many = await live({ d: data({ events: [...fillerEvents(250), ...baseEvents()], pulls: otherPrs(250) }) });
  assert.deepEqual(many.calls.filter(c => c.path.includes('/events?')).map(c => c.path), [eventsPath(1), eventsPath(2), eventsPath(3)]);
  assert.deepEqual(many.calls.filter(c => c.path.includes('pulls?')).map(c => c.path), [pullsPath(1), pullsPath(2), pullsPath(3)]);
  // Genau 100 PRs ohne rel="next": Seite 2 wird selbst gebaut abgerufen und muss leer sein.
  const full = await live({ d: data({ pulls: otherPrs(100) }) });
  assert.deepEqual(full.calls.filter(c => c.path.includes('pulls?')).map(c => c.path), [pullsPath(1), pullsPath(2)]);
  // Genau 200 Ereignisse: Seite 3 als leere Bestaetigung.
  const events200 = await live({ d: data({ events: [...fillerEvents(197), ...baseEvents()] }) });
  assert.deepEqual(events200.calls.filter(c => c.path.includes('/events?')).map(c => c.path), [eventsPath(1), eventsPath(2), eventsPath(3)]);
  // 999 PRs auf zehn Seiten sind noch vollstaendig lesbar.
  const max = await live({ d: data({ pulls: otherPrs(999) }) });
  assert.equal(max.calls.filter(c => c.path.includes('pulls?')).length, 10);
});

test('Positiv: aehnliche, aber nicht passende Branch-Namen fuehren nicht zur Ablehnung', async () => {
  const similar = [
    pr(1, `wp/${ISSUE}0-rechner-abc`),
    pr(2, `wp/${String(ISSUE).slice(0, -1)}-rechner`),
    pr(3, `wp/${ISSUE}`),
    pr(4, `xwp/${ISSUE}-rechner`),
    pr(5, `feature/wp/${ISSUE}-rechner`),
    pr(6, `WP/${ISSUE}-rechner`),
    pr(7, `wp/${ISSUE}_rechner`),
  ];
  await live({ d: data({ pulls: similar }) });
});

test('Positiv: der erlaubte Pfadsatz besteht checkApiRequest', () => {
  for (const path of [
    `${P}issues/1`,
    `${P}issues/${ISSUE}/events?per_page=100&page=1`,
    `${P}issues/10000000/events?per_page=100&page=10`,
    `${P}git/ref/heads/main`,
    `${P}git/matching-refs/heads/wp/38-`,
    `${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=7`,
    `${P}actions/runs/9007199254740991`,
  ]) {
    assert.equal(checkApiRequest('GET', path), true);
  }
});

// ---------------------------------------------------------------------------
// Historische PRs (Praefix wp/<n>-)
// ---------------------------------------------------------------------------

test('PR: frueherer PR in jedem Zustand fuehrt zur Ablehnung', async () => {
  for (const extra of [
    { state: 'open' },
    { state: 'closed', merged_at: null },
    { state: 'closed', merged_at: '2026-11-10T09:00:00Z', merged: true },
  ]) {
    await liveRejects('live-pr-vorhanden', { d: data({ pulls: [...otherPrs(5), pr(6, `wp/${ISSUE}-rechner-abc`, extra)] }) });
  }
});

test('PR: geloeschter Branch, anderer Zusatz, Fork und head.repo null zaehlen ebenfalls', async () => {
  for (const ref of [`wp/${ISSUE}-rechner-abc`, `wp/${ISSUE}-code-pilot-xyz`, `wp/${ISSUE}-andere-aufgabe`, `wp/${ISSUE}-`]) {
    await liveRejects('live-pr-vorhanden', { d: data({ pulls: [pr(1, ref)] }) });
  }
  await liveRejects('live-pr-vorhanden', { d: data({ pulls: [pr(1, `wp/${ISSUE}-x`, { head: { ref: `wp/${ISSUE}-x`, repo: null } })] }) });
  await liveRejects('live-pr-vorhanden', { d: data({ pulls: [pr(1, `wp/${ISSUE}-x`, { head: { ref: `wp/${ISSUE}-x`, repo: { full_name: 'fremd/agenten-probe' } } })] }) });
});

test('PR: Treffer auf Seite 2, 3 und 10 werden gefunden', async () => {
  for (const index of [150, 250, 950]) {
    const pulls = otherPrs(960);
    pulls[index] = pr(pulls[index].number, `wp/${ISSUE}-spaet`);
    await liveRejects('live-pr-vorhanden', { d: data({ pulls }) });
  }
});

test('PR: Issue #38 mit gemergtem PR #47 wird als frueherer PR erkannt', async () => {
  const d = data({
    issueNumber: 38,
    issue: liveIssue(38),
    pulls: [...otherPrs(46), pr(47, 'wp/38-code-pilot-42783596004-1', { merged_at: '2026-11-10T09:00:00Z' })],
  });
  await liveRejects('live-pr-vorhanden', { d, read: { issueNumber: 38 } });
});

test('PR: wp/260- ist kein Treffer fuer Issue 26, wp/26- schon', async () => {
  const d26 = pulls => data({ issueNumber: 26, issue: liveIssue(26), pulls });
  await liveRejects('live-pr-vorhanden', { d: d26([pr(1, 'wp/26-a6-2-2-live')]), read: { issueNumber: 26 } });
  // Mit wp/260- und wp/2600- besteht die PR-Pruefung. Der Lauf scheitert erst danach in resolveOrder,
  // weil die Nutzlast zu Issue 999001 gehoert: der Fehlercode belegt, dass die PR-Pruefung bestanden ist.
  for (const ref of ['wp/260-rechner', 'wp/2600-x', 'wp/26', 'wp/2-6-x']) {
    await liveRejects('auftrag-start-issue', { d: d26([pr(1, ref)]), read: { issueNumber: 26 } });
  }
});

test('PR: fehlende, widerspruechliche oder doppelte Pflichtfelder fuehren zur Ablehnung', async () => {
  for (const bad of [
    { number: 1, head: null },
    { number: 1 },
    { number: 1, head: { ref: 5 } },
    { number: 1, head: { ref: '' } },
    { number: '1', head: { ref: 'wp/1-a' } },
    { number: 0, head: { ref: 'wp/1-a' } },
    { number: 1.5, head: { ref: 'wp/1-a' } },
    { number: 2 ** 53, head: { ref: 'wp/1-a' } },
    { number: 1, head: [] },
  ]) {
    await readRejects('live-pr-format', data({ pulls: [bad] }));
  }
  await readRejects('live-liste-format', data({ pulls: [null] }));
  await readRejects('live-liste-format', data({ pulls: ['wp/1-a'] }));
  await readRejects('live-pr-doppelt', data({ pulls: [pr(1, 'wp/1-a'), pr(1, 'wp/2-b')] }));
});

// ---------------------------------------------------------------------------
// Paginierung
// ---------------------------------------------------------------------------

test('Seiten: Link-URLs werden nie aufgerufen, Folgeseiten nur selbst gebaut', async () => {
  const evil = { link: '<https://evil.example/repos/noah04091/agenten-probe/pulls?page=2>; rel="next", <https://evil.example/x>; rel="last"' };
  const { calls } = await live({
    d: data({ pulls: otherPrs(150) }),
    tweak: { [pullsPath(1)]: ok(otherPrs(100), evil) },
  });
  assert.deepEqual(calls.filter(c => c.path.includes('pulls?')).map(c => c.path), [pullsPath(1), pullsPath(2)]);
  assert.ok(calls.every(c => c.path.startsWith(P) && !c.path.includes('evil') && !c.path.includes('repositories/')));
});

test('Seiten: rel="next" verlangt genau 100 Eintraege', async () => {
  const next = { link: `<${LINK_BASE}x&page=2>; rel="next", <${LINK_BASE}x&page=2>; rel="last"` };
  await readRejects('live-seite-widerspruch', data(), { [pullsPath(1)]: ok(otherPrs(99), next) });
  await readRejects('live-seite-widerspruch', data(), { [pullsPath(1)]: ok([], next) });
  await readRejects('live-seite-widerspruch', data(), { [eventsPath(1)]: ok(baseEvents(), next) });
  await readRejects('live-seite-widerspruch', data(), { [pullsPath(1)]: ok(otherPrs(101)) });
});

test('Seiten: rel="next" mit 99 Eintraegen und nicht leerer Folgeseite', async () => {
  // Nur die 100er-Regel faengt das: Seite 2 ist nicht leer, die Regel fuer leere Seiten greift nicht.
  const next = { link: `<${LINK_BASE}x&page=2>; rel="next", <${LINK_BASE}x&page=2>; rel="last"` };
  const prev = { link: `<${LINK_BASE}x&page=1>; rel="prev", <${LINK_BASE}x&page=1>; rel="first"` };
  await readRejects('live-seite-widerspruch', data(), { [pullsPath(1)]: ok(otherPrs(99), next), [pullsPath(2)]: ok([pr(500, 'wp/500-a')], prev) });
});

test('Seiten: rel="last" ohne rel="next" nur auf einer leeren Seite', async () => {
  const last = { link: `<${LINK_BASE}x&page=3>; rel="last"` };
  await readRejects('live-seite-widerspruch', data(), { [eventsPath(1)]: ok(baseEvents(), last) });
  await readRejects('live-seite-widerspruch', data(), { [pullsPath(1)]: ok(otherPrs(50), last) });
  // Eine leere Seite 1 mit last ohne next wuerde sonst eine leere Liste vortaeuschen.
  await readRejects('live-seite-widerspruch', data({ pulls: [pr(1, `wp/${ISSUE}-x`)] }), { [pullsPath(1)]: ok([], last) });
  await readRejects('live-seite-widerspruch', data(), { [eventsPath(1)]: ok([], last) });
  // Die leere Bestaetigungsseite traegt last ohne next und wird angenommen (siehe Positivtests).
});

test('Seiten: volle letzte Seite verlangt eine leere Folgeseite ohne rel="next"', async () => {
  const d = data({ pulls: otherPrs(100) });
  await readRejects('live-seite-widerspruch', d, { [pullsPath(2)]: ok([pr(500, 'wp/500-a')]) });
  await readRejects('live-seite-widerspruch', d, { [pullsPath(2)]: ok([], { link: `<${LINK_BASE}x&page=3>; rel="next"` }) });
  await readRejects('live-http-status', d, { [pullsPath(2)]: { status: 404, headers: {}, body: '{}' } });
});

test('Seiten: eine per rel="next" angekuendigte leere Seite ist ein Widerspruch', async () => {
  const d = data({ pulls: otherPrs(150) });
  await readRejects('live-seite-widerspruch', d, { [pullsPath(2)]: ok([], { link: `<${LINK_BASE}x&page=1>; rel="prev"` }) });
});

test('Seiten: fehlende, doppelte und abgebrochene Seiten', async () => {
  const d = data({ pulls: otherPrs(250), events: [...fillerEvents(250), ...baseEvents()] });
  // Seite 2 fehlt
  await readRejects('live-http-status', d, { [pullsPath(2)]: { status: 404, headers: {}, body: '{}' } });
  await readRejects('live-http-status', d, { [eventsPath(2)]: { status: 500, headers: {}, body: '{}' } });
  // Seite 2 liefert noch einmal Seite 1
  await readRejects('live-pr-doppelt', d, { [pullsPath(2)]: pageResponse(d.pulls, 1, 'pulls?') });
  const page1 = pageResponse(d.events, 1, 'x?');
  await readRejects('live-ereignis-doppelt', d, { [eventsPath(2)]: { ...page1, headers: pageResponse(d.events, 2, 'x?').headers } });
  // Abgeschnittene Antwort
  await readRejects('live-antwort-json', d, { [pullsPath(2)]: { status: 200, headers: {}, body: JSON.stringify(otherPrs(100)).slice(0, 500) } });
});

test('Seiten: Grenze von zehn Seiten', async () => {
  // rel="next" auf Seite 10
  await readRejects('live-seiten-grenze', data({ pulls: otherPrs(1001) }));
  // Seite 10 voll ohne rel="next": eine Bestaetigung braeuchte Seite 11
  await readRejects('live-seiten-grenze', data({ pulls: otherPrs(1000) }));
  await readRejects('live-seiten-grenze', data({ events: [...fillerEvents(998), ...baseEvents()] }));
  // Seite 11 wird nie angefragt.
  const { transport, calls } = apiDouble(data({ pulls: otherPrs(1001) }));
  await assert.rejects(() => readLiveState(readArgs(transport)));
  assert.ok(calls.every(c => !c.path.endsWith('page=11')));
});

test('Seiten: fehlerhafte oder widerspruechliche Link-Header', async () => {
  for (const link of [
    '',
    'kaputt',
    `<${LINK_BASE}x>; rel="next"; rel="last"`,
    `<${LINK_BASE}x>; rel=next`,
    `<${LINK_BASE}x>; rel="sonstwas"`,
    `<${LINK_BASE}x>; rel="last", <${LINK_BASE}y>; rel="last"`,
    `${LINK_BASE}x; rel="last"`,
    `<${LINK_BASE}x>; rel="last",`,
  ]) {
    await readRejects('live-link-format', data(), { [pullsPath(1)]: ok(otherPrs(5), { link }) });
  }
  // prev oder first auf Seite 1 widerspricht sich selbst.
  await readRejects('live-seite-widerspruch', data(), { [pullsPath(1)]: ok(otherPrs(5), { link: `<${LINK_BASE}x>; rel="prev"` }) });
  await readRejects('live-seite-widerspruch', data(), { [eventsPath(1)]: ok(baseEvents(), { link: `<${LINK_BASE}x>; rel="first"` }) });
  // Doppelte Kopfzeile in verschiedener Schreibweise
  await readRejects('live-header-doppelt', data(), { [pullsPath(1)]: ok(otherPrs(5), { link: `<${LINK_BASE}x>; rel="last"`, Link: `<${LINK_BASE}x>; rel="last"` }) });
});

// ---------------------------------------------------------------------------
// Ereignisverlauf: roh und vollstaendig bis resolveOrder
// ---------------------------------------------------------------------------

test('Ereignisse: ungueltige, leere oder doppelte Ereignisse fuehren zur Ablehnung', async () => {
  await readRejects('live-ereignis-id', data({ events: [{ event: 'labeled' }, ...baseEvents()] }));
  await readRejects('live-ereignis-id', data({ events: [{ id: '7', event: 'labeled' }, ...baseEvents()] }));
  await readRejects('live-ereignis-id', data({ events: [{ id: 0, event: 'labeled' }, ...baseEvents()] }));
  await readRejects('live-ereignis-id', data({ events: [{ id: 2 ** 53, event: 'labeled' }, ...baseEvents()] }));
  await readRejects('live-ereignis-doppelt', data({ events: [...baseEvents(), ...baseEvents()] }));
  await readRejects('live-liste-format', data({ events: [null, ...baseEvents()] }));
  await readRejects('live-liste-format', data({ events: [[], ...baseEvents()] }));
  await readRejects('live-liste-format', data(), { [eventsPath(1)]: ok({}) });
  await readRejects('live-liste-format', data(), { [pullsPath(1)]: ok({ 0: pr(1, 'wp/1-a'), length: 1 }) });
  // Leerer Verlauf geht an resolveOrder und scheitert dort.
  await liveRejects('auftrag-freigabe-fehlt', { d: data({ events: [] }) });
});

test('Ereignisse: fremdes renamed gelangt roh bis resolveOrder', async () => {
  const renamed = {
    id: 50, event: 'renamed', created_at: '2026-11-01T10:00:00Z', actor: { login: 'jemand', type: 'User' },
    performed_via_github_app: null, rename: { from: 'Alter Titel', to: TITLE },
  };
  await liveRejects('auftrag-titel-fremd', { d: data({ events: [renamed, ...baseEvents()] }) });
  // Auch auf Seite 2.
  await liveRejects('auftrag-titel-fremd', { d: data({ events: [...fillerEvents(150), { ...renamed, id: 4000, created_at: '2026-11-10T07:30:00Z' }, ...baseEvents()] }) });
});

test('Ereignisse: Regeln aus resolveOrder greifen mit den Live-Daten', async () => {
  const foreignStart = labelEvent(50, 'labeled', 'bot-auftrag', '2026-11-01T10:00:00Z', { login: 'jemand', type: 'User' });
  await liveRejects('auftrag-freigabe-fremd', { d: data({ events: [foreignStart, ...baseEvents()] }) });

  const four = [10, 20, 30].flatMap((id, i) => [
    labelEvent(id, 'labeled', 'bot-auftrag', `2026-11-0${i + 1}T10:00:00Z`),
    labelEvent(id + 1, 'unlabeled', 'bot-auftrag', `2026-11-0${i + 1}T10:05:00Z`),
  ]);
  await liveRejects('auftrag-freigaben-grenze', { d: data({ events: [...four, ...baseEvents()] }) });

  const removal = labelEvent(5102, 'unlabeled', 'bot-auftrag', '2026-11-10T08:35:00Z', { login: 'jemand', type: 'User' });
  await liveRejects('auftrag-freigabe-entzogen', { d: data({ events: [...baseEvents(), removal] }) });

  const later = [labelEvent(5102, 'unlabeled', 'bot-auftrag', '2026-11-10T08:34:00Z'), labelEvent(5103, 'labeled', 'bot-auftrag', '2026-11-10T08:35:00Z')];
  await liveRejects('auftrag-lauf-ueberholt', { d: data({ events: [...baseEvents(), ...later] }) });

  const profile = labelEvent(5102, 'labeled', 'agent:js-text', '2026-11-10T08:34:00Z');
  await liveRejects('auftrag-profil-label-geaendert', { d: data({ events: [...baseEvents(), profile] }) });
});

// ---------------------------------------------------------------------------
// Live-Issue (strenge Regel aus resolveOrder bleibt)
// ---------------------------------------------------------------------------

test('Issue: Titel, Text, Kommentar und Profil-Label nach der Freigabe brechen ab', async () => {
  await liveRejects('auftrag-issue-abweichung', { d: data({ issue: { ...liveIssue(), title: 'Anderer Titel' } }) });
  await liveRejects('auftrag-issue-abweichung', { d: data({ issue: { ...liveIssue(), body: 'Anderer Text' } }) });
  // Ein Kommentar, auch von einem fremden Konto, aendert updated_at.
  await liveRejects('auftrag-issue-geaendert', { d: data({ issue: { ...liveIssue(), updated_at: at(APPROVAL_TIME, 120) } }) });
  await liveRejects('auftrag-labels-fremd', { d: data({ issue: { ...liveIssue(), labels: [...liveIssue().labels, { name: 'frage' }] } }) });
  await liveRejects('auftrag-issue-geschlossen', { d: data({ issue: { ...liveIssue(), state: 'closed' } }) });
});

test('Issue: Nummer, Format und Frist', async () => {
  await readRejects('live-issue-abweichung', data({ issue: liveIssue(ISSUE + 1) }));
  await readRejects('live-issue-format', data({ issue: [liveIssue()] }));
  await readRejects('live-issue-format', data({ issue: null }));
  await liveRejects('auftrag-freigabe-abgelaufen', { check: { now: new Date(at(APPROVAL_TIME, 60 * 60 + 1)) } });
});

// ---------------------------------------------------------------------------
// main und bestehende Branches
// ---------------------------------------------------------------------------

test('main: neuer Commit, falscher Ref, falscher Typ oder ungueltige SHA', async () => {
  const main = changes => data({ main: { ref: 'refs/heads/main', object: { sha: BASE, type: 'commit' }, ...changes } });
  await liveRejects('live-main-geaendert', { d: main({ object: { sha: OTHER_SHA, type: 'commit' } }) });
  await readRejects('live-main-format', main({ ref: 'refs/heads/master' }));
  await readRejects('live-main-format', main({ ref: 'refs/heads/main-alt' }));
  await readRejects('live-main-format', main({ object: { sha: BASE, type: 'tag' } }));
  await readRejects('live-main-format', main({ object: { sha: BASE.slice(0, 39), type: 'commit' } }));
  await readRejects('live-main-format', main({ object: { sha: BASE.toUpperCase(), type: 'commit' } }));
  await readRejects('live-main-format', main({ object: null }));
  await readRejects('live-main-format', main({ object: { sha: [BASE], type: 'commit' } }));
  await readRejects('live-main-format', data({ main: [] }));
  await readRejects('live-http-status', data(), { [`${P}git/ref/heads/main`]: { status: 404, headers: {}, body: '{}' } });
});

test('Branches: passender Branch, unerwartete Refs, Link-Header und Fehlerstatus', async () => {
  const ref = (name, changes = {}) => ({ ref: name, node_id: 'x', url: 'x', object: { sha: BASE, type: 'commit', url: 'x' }, ...changes });
  await liveRejects('live-branch-vorhanden', { d: data({ refs: [ref(`refs/heads/wp/${ISSUE}-rechner`)] }) });
  await liveRejects('live-branch-vorhanden', { d: data({ refs: [ref(`refs/heads/wp/${ISSUE}-`)] }) });
  await readRejects('live-ref-format', data({ refs: [ref(`refs/heads/wp/${ISSUE}0-rechner`)] }));
  await readRejects('live-ref-format', data({ refs: [ref(`refs/tags/wp/${ISSUE}-x`)] }));
  await readRejects('live-ref-format', data({ refs: [ref(`refs/heads/wp/${ISSUE}-x`, { object: { sha: BASE, type: 'tag' } })] }));
  await readRejects('live-ref-format', data({ refs: [ref(`refs/heads/wp/${ISSUE}-x`, { object: { sha: 'abc', type: 'commit' } })] }));
  await readRejects('live-ref-format', data({ refs: [ref(5)] }));
  await readRejects('live-ref-format', data({ refs: [ref(`refs/heads/wp/${ISSUE}-x`, { object: { sha: [BASE], type: 'commit' } })] }));
  await readRejects('live-ref-format', data({ refs: [ref([`refs/heads/wp/${ISSUE}-x`])] }));
  await readRejects('live-liste-format', data({ refs: {} }));
  await readRejects('live-liste-format', data({ refs: [null] }));
  const refsPath = `${P}git/matching-refs/heads/wp/${ISSUE}-`;
  await readRejects('live-ref-link', data(), { [refsPath]: ok([], { link: `<${LINK_BASE}x>; rel="last"` }) });
  for (const status of [404, 409, 500]) {
    await readRejects('live-http-status', data(), { [refsPath]: { status, headers: {}, body: '[]' } });
  }
});

// ---------------------------------------------------------------------------
// Workflow-Lauf
// ---------------------------------------------------------------------------

test('Lauf: jedes Identitaetsmerkmal wird geprueft', async () => {
  const run = changes => data({ run: { ...liveRun(), ...changes } });
  const without = key => {
    const value = liveRun();
    delete value[key];
    return data({ run: value });
  };

  await liveRejects('live-lauf-id-abweichung', { d: run({ id: 42783596005 }) });
  await liveRejects('live-lauf-id-abweichung', { d: run({ id: RUN_ID }) });
  await liveRejects('live-lauf-id-abweichung', { d: without('id') });
  await liveRejects('live-lauf-ereignis', { d: run({ event: 'workflow_dispatch' }) });
  await liveRejects('live-lauf-ereignis', { d: without('event') });
  await liveRejects('live-lauf-workflow', { d: run({ path: `${WORKFLOW_PATH}@main` }) });
  await liveRejects('live-lauf-workflow', { d: run({ path: `${WORKFLOW_PATH}@refs/heads/main` }) });
  await liveRejects('live-lauf-workflow', { d: run({ path: '.github/workflows/claude-agent.yml' }) });
  await liveRejects('live-lauf-workflow', { d: without('path') });
  await liveRejects('live-lauf-branch', { d: run({ head_branch: 'wp/1-x' }) });
  await liveRejects('live-lauf-branch', { d: run({ head_branch: null }) });
  await liveRejects('live-lauf-repository', { d: run({ head_repository: { full_name: 'fremd/agenten-probe' } }) });
  await liveRejects('live-lauf-repository', { d: run({ head_repository: null }) });
  await liveRejects('live-lauf-repository', { d: run({ repository: { full_name: 'fremd/agenten-probe' } }) });
  await liveRejects('live-lauf-repository', { d: without('repository') });
  await liveRejects('live-lauf-akteur', { d: run({ actor: { login: 'jemand', type: 'User' } }) });
  await liveRejects('live-lauf-akteur', { d: run({ actor: { login: 'noah04091', type: 'Bot' } }) });
  await liveRejects('live-lauf-akteur', { d: without('actor') });
  await liveRejects('live-lauf-akteur', { d: run({ triggering_actor: { login: 'noah04091-agent', type: 'User' } }) });
  await liveRejects('live-lauf-akteur', { d: run({ triggering_actor: { login: 'noah04091', type: 'Bot' } }) });
  await liveRejects('live-lauf-akteur', { d: without('triggering_actor') });
  await liveRejects('live-lauf-sha', { d: run({ head_sha: OTHER_SHA }) });
  await liveRejects('live-lauf-sha', { d: without('head_sha') });
  // Laufversuch und Erstellzeit prueft resolveOrder (keine zweite Implementierung).
  await liveRejects('auftrag-lauf-versuch', { d: run({ run_attempt: 2 }) });
  await liveRejects('auftrag-lauf-versuch', { d: without('run_attempt') });
  await liveRejects('auftrag-lauf-zeit', { d: run({ created_at: '2026-11-10 08:33:41' }) });
  await liveRejects('auftrag-lauf-zeit', { d: without('created_at') });
  // Ein spaeter erstellter Lauf passt nicht mehr zur Freigabe und aendert den Auftrags-Hash.
  await liveRejects('auftrag-freigabe-fehlt', { d: run({ created_at: at(APPROVAL_TIME, 6 * 60) }) });
  await liveRejects('auftrag-abweichung', { d: run({ created_at: at(RUN_CREATED, 1) }) });
  await readRejects('live-lauf-format', data({ run: [] }));
});

test('Lauf: Lauf-ID nur als sichere Ganzzahl', async () => {
  // GitHub-ID jenseits von Number.MAX_SAFE_INTEGER: JSON.parse rundet still.
  const body = JSON.stringify(liveRun()).replace(`"id":${RUN_ID}`, '"id":42783596004.5');
  await liveRejects('live-lauf-id-abweichung', { tweak: { [`${P}actions/runs/${RUN_ID}`]: { status: 200, headers: {}, body } } });
  const unsafe = '9007199254740993';
  const runPath = `${P}actions/runs/9007199254740991`;
  const bodyUnsafe = JSON.stringify(liveRun()).replace(`"id":${RUN_ID}`, `"id":${unsafe}`);
  await liveRejects('live-lauf-id-abweichung', {
    tweak: { [runPath]: { status: 200, headers: {}, body: bodyUnsafe } },
    read: { runId: '9007199254740991' },
    check: { runId: '9007199254740991' },
  });
  for (const runId of [unsafe, '9007199254740992', '0', '0123', '-1', '1.5', '', 42783596004, null]) {
    await readRejects('live-lauf-id', data(), {}, { runId });
  }
});

test('Lauf: Laufkennung muss zum gelesenen Zustand passen', async () => {
  const { transport } = apiDouble();
  const state = await readLiveState(readArgs(transport));
  assert.throws(() => checkLiveOrder(checkArgs(state, { runId: '42783596005' })), error => assertCode(error, 'live-lauf-zuordnung'));
  const { transport: t2 } = apiDouble();
  const state2 = await readLiveState(readArgs(t2));
  assert.throws(() => checkLiveOrder(checkArgs(state2, { runId: 'abc' })), error => assertCode(error, 'live-lauf-id'));
});

// ---------------------------------------------------------------------------
// Hash, Zustand, Eingaben
// ---------------------------------------------------------------------------

test('Hash: falscher, ungueltiger oder fehlender erwarteter Auftrags-Hash', async () => {
  await liveRejects('auftrag-abweichung', { check: { expectedSha256: 'f'.repeat(64) } });
  for (const expectedSha256 of ['F'.repeat(64), 'f'.repeat(63), undefined, 5, `${'f'.repeat(64)}\n`]) {
    await liveRejects('live-hash-format', { check: { expectedSha256 } });
  }
});

test('Zustand: nur ein frischer, unbenutzter Zustand aus readLiveState wird angenommen', async () => {
  const { transport } = apiDouble();
  const state = await readLiveState(readArgs(transport));
  // Gefaelschter Zustand mit denselben Daten
  const forged = JSON.parse(JSON.stringify(state));
  assert.throws(() => checkLiveOrder(checkArgs(forged)), error => assertCode(error, 'live-zustand-ungeprueft'));
  assert.equal(orderSha256(checkLiveOrder(checkArgs(state))), EXPECTED);
  // Zweite Verwendung desselben Zustands
  assert.throws(() => checkLiveOrder(checkArgs(state)), error => assertCode(error, 'live-zustand-ungeprueft'));
  // Auch ein abgelehnter Zustand ist verbraucht.
  const { transport: t2 } = apiDouble();
  const state2 = await readLiveState(readArgs(t2));
  assert.throws(() => checkLiveOrder(checkArgs(state2, { expectedSha256: 'f'.repeat(64) })), error => assertCode(error, 'auftrag-abweichung'));
  assert.throws(() => checkLiveOrder(checkArgs(state2)), error => assertCode(error, 'live-zustand-ungeprueft'));
  // Auch ein Scheitern schon an Eingabe oder Hash-Format verbraucht den Zustand.
  for (const broken of [s => ({ ...checkArgs(s), extra: 1 }), s => checkArgs(s, { expectedSha256: 'x' })]) {
    const { transport: t3 } = apiDouble();
    const state3 = await readLiveState(readArgs(t3));
    assert.throws(() => checkLiveOrder(broken(state3)));
    assert.throws(() => checkLiveOrder(checkArgs(state3)), error => assertCode(error, 'live-zustand-ungeprueft'));
  }
});

test('Eingaben: kein Auftragsobjekt als Ersatz, nur genau die erwarteten Felder', async () => {
  const { transport } = apiDouble();
  const state = await readLiveState(readArgs(transport));
  const fakeOrder = JSON.parse(JSON.stringify((await live()).order));
  assert.throws(() => checkLiveOrder({ ...checkArgs(state), order: fakeOrder }), error => assertCode(error, 'live-eingabe'));
  assert.throws(() => checkLiveOrder(null), error => assertCode(error, 'live-eingabe'));
  const missing = checkArgs(state);
  delete missing.event;
  assert.throws(() => checkLiveOrder(missing), error => assertCode(error, 'live-eingabe'));
  // Ein JSON-Auftragsobjekt wird auch von sameOrder nicht als geprueft angenommen.
  assert.throws(() => sameOrder(fakeOrder, EXPECTED), error => assertCode(error, 'auftrag-ungeprueft'));
  // Die Original-Nutzlast wird unveraendert an resolveOrder gegeben.
  await liveRejects('auftrag-start-zuordnung', { check: { event: { ...payload(), issue: { ...payload().issue, updated_at: at(APPROVAL_TIME, -1) } } } });
  // root, baseSha und gitEnv gehen ebenso unveraendert an resolveOrder.
  await liveRejects('auftrag-git-umgebung', { check: { gitEnv: { ...ENV, GIT_CONFIG_NOSYSTEM: '0' } } });
});

test('Eingaben: readLiveState prueft Transport, Repository und Issue-Nummer vor jeder Anfrage', async () => {
  const { transport, calls } = apiDouble();
  await assert.rejects(() => readLiveState(readArgs(undefined)), error => assertCode(error, 'live-transport'));
  await assert.rejects(() => readLiveState(readArgs('https://api.github.com')), error => assertCode(error, 'live-transport'));
  await assert.rejects(() => readLiveState(readArgs(transport, { repository: 'fremd/agenten-probe' })), error => assertCode(error, 'live-repository'));
  for (const issueNumber of [0, -1, 1.5, '38', 10_000_001, 2 ** 53, null]) {
    await assert.rejects(() => readLiveState(readArgs(transport, { issueNumber })), error => assertCode(error, 'live-issue-nummer'));
  }
  await assert.rejects(() => readLiveState({ ...readArgs(transport), extra: 1 }), error => assertCode(error, 'live-eingabe'));
  await assert.rejects(() => readLiveState(null), error => assertCode(error, 'live-eingabe'));
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Request-Grenze und HTTP
// ---------------------------------------------------------------------------

test('Request-Grenze: nur GET', () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'get', '', undefined]) {
    apiRejects(method, `${P}issues/1`, 'live-methode');
  }
});

test('Request-Grenze: nur die sechs festen Pfade ohne fremde Parameter', () => {
  for (const path of [
    `https://api.github.com${P}issues/1`,
    `/repos/fremd/agenten-probe/issues/1`,
    // Gleich lang wie /repos/noah04091/agenten-probe/: faellt nur am Praefix auf.
    `/repos/fremd0000/agenten-probe/issues/1`,
    `${P}issues/1/comments`,
    `${P}issues/1?x=1`,
    `${P}issues/01`,
    `${P}issues/0`,
    `${P}issues/1/events`,
    `${P}issues/1/events?per_page=50&page=1`,
    `${P}issues/1/events?per_page=100&page=0`,
    `${P}issues/1/events?per_page=100&page=11`,
    `${P}issues/1/events?page=1&per_page=100`,
    `${P}issues/1/events?per_page=100&page=1&foo=1`,
    `${P}pulls?state=open&sort=created&direction=asc&per_page=100&page=1`,
    `${P}pulls?state=all&sort=created&direction=desc&per_page=100&page=1`,
    `${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=1&head=x`,
    `${P}git/matching-refs/heads/wp/1`,
    `${P}git/matching-refs/heads/`,
    `${P}git/matching-refs/heads/wp/1-x`,
    `${P}git/ref/heads/main2`,
    `${P}git/refs/heads/main`,
    `${P}actions/runs/1/rerun`,
    `${P}actions/runs/01`,
    `${P}issues/1/../2`,
    `${P}issues/%31`,
    `${P}issues/1#x`,
    `${P}issues/1\n`,
    `//evil.example${P}issues/1`,
    5,
  ]) {
    apiRejects('GET', path, 'live-pfad');
  }
  // Passt zum Muster, ist aber keine sichere Ganzzahl: eigene zweite Schicht.
  apiRejects('GET', `${P}actions/runs/9007199254740992`, 'live-pfad-lauf-id');
  apiRejects('GET', `${P}actions/runs/9999999999999999`, 'live-pfad-lauf-id');
});

test('HTTP: Fehlerstatus und Weiterleitungen fuehren zur Ablehnung', async () => {
  const issuePath = `${P}issues/${ISSUE}`;
  for (const status of [401, 403, 404, 409, 410, 429, 500, 201, 204]) {
    await readRejects('live-http-status', data(), { [issuePath]: { status, headers: {}, body: '{}' } });
  }
  for (const status of [301, 302, 303, 307, 308]) {
    await readRejects('live-umleitung', data(), { [issuePath]: { status, headers: { location: 'https://evil.example/' }, body: '' } });
  }
});

test('HTTP: ungueltige, uebergrosse oder unvollstaendige Antworten', async () => {
  const issuePath = `${P}issues/${ISSUE}`;
  for (const response of [
    null,
    'text',
    { status: '200', headers: {}, body: '{}' },
    { status: 200, body: '{}' },
    { status: 200, headers: null, body: '{}' },
    { status: 200, headers: { link: 5 }, body: '{}' },
    { status: 200, headers: [], body: '{}' },
    { status: 200, headers: {}, body: {} },
    { status: 200, headers: {}, body: Buffer.from('{}') },
  ]) {
    await readRejects('live-antwort-format', data(), { [issuePath]: response });
  }
  await readRejects('live-antwort-json', data(), { [issuePath]: { status: 200, headers: {}, body: '{"number":' } });
  await readRejects('live-antwort-json', data(), { [issuePath]: { status: 200, headers: {}, body: '' } });
  await readRejects('live-antwort-gross', data(), { [issuePath]: { status: 200, headers: {}, body: ' '.repeat(MAX_BODY_BYTES + 1) } });
  // Mehrbyte-Zeichen zaehlen nach Bytes, nicht nach Zeichen.
  await readRejects('live-antwort-gross', data(), { [issuePath]: { status: 200, headers: {}, body: 'ä'.repeat(MAX_BODY_BYTES / 2 + 1) } });
  // Proxy, Getter und fremde Typen werden nie als Antwort oder Kopfzeilen gelesen.
  const valid = ok(liveIssue());
  for (const response of [
    new Proxy(valid, {}),
    { get status() { return 200; }, headers: {}, body: valid.body },
    { status: 200, headers: new Proxy({}, {}), body: valid.body },
    { status: 200, headers: new Headers(), body: valid.body },
    { status: 200, headers: { get link() { return ''; } }, body: valid.body },
    Object.assign(Object.create({ status: 200, headers: {} }), { body: valid.body }),
  ]) {
    await readRejects('live-antwort-format', data(), { [issuePath]: response });
  }
  // Ein werfender Transport bricht immer mit eigenem Code ab, ohne die fremde Nachricht zu lesen.
  for (const thrown of [
    new Error('Netz weg'),
    { get message() { throw new TypeError('boom'); } },
    { message: { toString() { throw new RangeError('x'); } } },
    { message: Symbol('s') },
    null,
  ]) {
    await readRejects('live-transport-fehler', data(), { [issuePath]: () => { throw thrown; } });
  }
  const { transport } = apiDouble(data(), { [issuePath]: () => { throw new Error('Authorization: Bearer ghs_GEHEIM'); } });
  await assert.rejects(() => readLiveState(readArgs(transport)), error => {
    assertCode(error, 'live-transport-fehler');
    assert.ok(!error.message.includes('ghs_GEHEIM'), 'Zugangsdaten in der Fehlermeldung');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Race-Condition: frueheres positives Ergebnis ist keine dauerhafte Freigabe
// ---------------------------------------------------------------------------

test('Race: ein nach der ersten Pruefung entstandener PR oder Branch wird bei der naechsten Pruefung erkannt', async () => {
  const d = data();
  const { transport } = apiDouble(d);
  const first = await readLiveState(readArgs(transport));
  // Zwischen Lesen und Pruefen entsteht ein PR: dieselbe Pruefung sieht ihn nicht (keine atomare
  // Momentaufnahme), die naechste frische Pruefung schon.
  d.pulls = [...d.pulls, pr(9999, `wp/${ISSUE}-parallel`, { state: 'open' })];
  assert.equal(orderSha256(checkLiveOrder(checkArgs(first))), EXPECTED);
  const second = await readLiveState(readArgs(transport));
  assert.throws(() => checkLiveOrder(checkArgs(second)), error => assertCode(error, 'live-pr-vorhanden'));
  d.pulls = otherPrs(43);
  d.refs = [{ ref: `refs/heads/wp/${ISSUE}-parallel`, object: { sha: BASE, type: 'commit' } }];
  const third = await readLiveState(readArgs(transport));
  assert.throws(() => checkLiveOrder(checkArgs(third)), error => assertCode(error, 'live-branch-vorhanden'));
});

// ---------------------------------------------------------------------------
// Wachtests auf Quelltext und Workflows
// ---------------------------------------------------------------------------

test('Wache: das Modul hat keinen eigenen Netz-, Prozess- oder Umgebungszugriff', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./agent-code-auftrag.mjs', 'node:util']);
  for (const forbidden of ['process.', 'fetch(', 'globalThis', 'require(', 'import(', 'XMLHttpRequest', 'WebSocket', 'eval(', 'Function(']) {
    assert.ok(!source.includes(forbidden), `verbotener Zugriff im Modul: ${forbidden}`);
  }
});

test('Wache: kein Workflow ruft eines der beiden Auftragsmodule auf', () => {
  const dir = join(ROOT, '.github/workflows');
  const files = readdirSync(dir).filter(name => /\.ya?ml$/.test(name));
  const texts = files.map(name => readFileSync(join(dir, name), 'utf8'));
  // Muss-Treffer: die Suche findet ein bekanntes Skript, kann also ueberhaupt etwas finden.
  assert.ok(files.length >= 10, 'Gegenprobe: zu wenige Workflows gefunden');
  assert.ok(texts.some(text => text.includes('agent-code-package')), 'Gegenprobe ohne Treffer');
  assert.ok(texts.every(text => !text.includes('agent-code-auftrag')), 'ein Workflow verweist auf ein Auftragsmodul');
});

test('Wache: kein anderes Skript verweist auf eines der beiden Auftragsmodule', () => {
  const dir = join(ROOT, 'scripts');
  const names = readdirSync(dir).filter(name => name.endsWith('.mjs'));
  // Muss-Treffer: beide Module existieren, und die Suche findet bekannte Importe in anderen Skripten.
  assert.ok(names.includes('agent-code-auftrag.mjs') && names.includes('agent-code-auftrag-live.mjs'));
  const others = names
    .filter(name => name !== 'agent-code-auftrag.mjs' && name !== 'agent-code-auftrag-live.mjs' && name !== 'agent-code-auftrag-prompt.mjs' && name !== 'agent-code-auftrag-paket.mjs' && name !== 'agent-code-auftrag-publish.mjs')
    .map(name => readFileSync(join(dir, name), 'utf8'));
  assert.ok(others.length >= 10, 'Gegenprobe: zu wenige Skripte gefunden');
  assert.ok(others.some(text => text.includes('./agent-code-release-plan.mjs')), 'Gegenprobe ohne Treffer');
  assert.ok(others.every(text => !text.includes('agent-code-auftrag')), 'ein Skript verweist auf ein Auftragsmodul');
  // Das neue Modul selbst importiert das Auftragsmodul (Muss-Treffer fuer die Suche nach dem Namen).
  assert.ok(readFileSync(MODULE_PATH, 'utf8').includes("from './agent-code-auftrag.mjs'"));
});
