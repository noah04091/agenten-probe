// A6.2-7: Historisch exaktes Offline-Nachspiel von Issue #38 durch die allgemeine Auftragskette.
//
// Was dieser Test zeigt: Die A6.2-Module (Auftrag, Live-Pruefung, Prompt, Arbeitsordner, Paket v2,
// Pruef-Checkout, Veroeffentlicher) fuehren den historischen Auftrag von Issue #38 mit Profil
// js-rechner zu genau den beiden Ergebnis-Blobs von PR #47. Die Aenderung selbst wird simuliert:
// Die beiden historischen Ergebnisdateien werden in den Arbeitsordner geschrieben. Der Test
// behauptet KEINE Wiederholung des damaligen KI-Laufs.
//
// Was dieser Test NICHT zeigt:
// - Keine echte Isolation von Claude (K1/K2), kein Bind-Mount-Schutz, keine Trennregel fuer
//   agent-acceptance/, kein Geheimniswertabgleich, kein produktiver Transport, keine Concurrency.
// - Die Pruefung der Code-Blobs unmittelbar vor der Abnahme, die Bindung der ausgefuehrten
//   Abnahmedatei und die Regel "nur ein abgenommenes Paket wird veroeffentlicht" stehen hier nur
//   im Testgeruest (Funktionen bindCodeBeforeAcceptance, runBoundAcceptance, publishAccepted).
//   Kein Produktionsmodul enthaelt sie. A6.4 muss sie im echten Pruef- und Veroeffentlichungsjob
//   selbst gewaehrleisten.
// - head.sha in der Antwort auf POST pulls: Seit A6.4-1 prueft das allgemeine Veroeffentlichungs-
//   modul, dass head.sha exakt dem eigenen Commit entspricht (offline nachgewiesen). Der letzte Test
//   dieser Datei belegt die Ablehnung einer manipulierten PR-Antwort. Die produktive Workflow-
//   Einbindung bleibt offen.
//
// Alles offline: kein Claude-Aufruf, keine Netzanfrage, keine Zugangsdaten, kein GitHub-Schreibzugriff.
// Alle Live-Zustaende kommen aus einem lokalen Simulator. Die Daten sind kuenstlich: Issue 38 ist im
// Test offen, die Lauf-ID 900000000001 ist synthetisch (nicht die historische 42783596004). Git laeuft
// nur in Temp-Repositorys mit isolierter Umgebung, nie im echten Repository. Aus dem echten
// Repository werden nur Dateien gelesen (Abnahme, Profil, Policy-Vorlage).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { orderSha256, resolveOrder, sameOrder } from '../scripts/agent-code-auftrag.mjs';
import { checkLiveOrder, readLiveState } from '../scripts/agent-code-auftrag-live.mjs';
import { SECURITY_FRAME, buildPrompt } from '../scripts/agent-code-auftrag-prompt.mjs';
import {
  applyPackageV2, compareWorkspace, createPackageV2, packageFileBytes, parsePackageV2, prepareWorkspace,
} from '../scripts/agent-code-auftrag-paket.mjs';
import { PublishError, publishOrderDraft } from '../scripts/agent-code-auftrag-publish.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IS_WINDOWS = globalThis.process.platform === 'win32';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const gitBlobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// Historische Daten von PR #47, fest hinterlegt. Herkunft: Git-Blobs der beiden Commits unten. Die
// Commit-IDs sind eine Herkunftsangabe und werden offline nicht geprueft; geprueft werden Pfad,
// Bytegroesse und Git-Blob-ID jeder Fassung.
// ---------------------------------------------------------------------------

const HIST_BASE_COMMIT = '21b9b56c6469574a575b496a511e00564d85bc73';
const HIST_HEAD_COMMIT = 'bb2ded1ea679d52611ae7b14b4dea86d543a80bf';

const VOR_RECHNE = [
  '// Spielcode für den Ablauftest. Kein Bezug zu Contract AI.',
  '//',
  '// Vorgabe fuer Issue #38: multipliziere(a, b) gibt exakt das Ergebnis',
  '// von a * b zurueck, einschliesslich -0 (0 * -9 ergibt -0, nicht 0).',
  '// Keine zusaetzliche Normalisierung. Auch eigene Tests unterscheiden',
  '// 0 und -0: assert.strictEqual(multipliziere(0, -9), -0).',
  'function addiere(a, b) {',
  '  return a + b;',
  '}',
  '',
  'function subtrahiere(a, b) {',
  '  return a - b;',
  '}',
  '',
  'module.exports = { addiere, subtrahiere };',
  '',
  '// T14',
  '// T16 a',
  '// T16 b',
  '// T13: Test nachtraeglicher Aenderungen',
].join('\n') + '\n';

const VOR_TEST = [
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "const { addiere, subtrahiere } = require('../src/rechne');",
  '',
  "test('addiere zählt zwei Zahlen zusammen', () => {",
  '  assert.strictEqual(addiere(2, 3), 5);',
  '});',
  '',
  "test('subtrahiere zieht die zweite Zahl von der ersten ab', () => {",
  '  assert.strictEqual(subtrahiere(5, 3), 2);',
  '});',
].join('\n') + '\n';

const NACH_RECHNE = [
  '// Spielcode für den Ablauftest. Kein Bezug zu Contract AI.',
  '//',
  '// Vorgabe fuer Issue #38: multipliziere(a, b) gibt exakt das Ergebnis',
  '// von a * b zurueck, einschliesslich -0 (0 * -9 ergibt -0, nicht 0).',
  '// Keine zusaetzliche Normalisierung. Auch eigene Tests unterscheiden',
  '// 0 und -0: assert.strictEqual(multipliziere(0, -9), -0).',
  'function addiere(a, b) {',
  '  return a + b;',
  '}',
  '',
  'function subtrahiere(a, b) {',
  '  return a - b;',
  '}',
  '',
  'function multipliziere(a, b) {',
  '  return a * b;',
  '}',
  '',
  'module.exports = { addiere, subtrahiere, multipliziere };',
  '',
  '// T14',
  '// T16 a',
  '// T16 b',
  '// T13: Test nachtraeglicher Aenderungen',
].join('\n') + '\n';

const NACH_TEST = [
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "const { addiere, subtrahiere, multipliziere } = require('../src/rechne');",
  '',
  "test('addiere zählt zwei Zahlen zusammen', () => {",
  '  assert.strictEqual(addiere(2, 3), 5);',
  '});',
  '',
  "test('subtrahiere zieht die zweite Zahl von der ersten ab', () => {",
  '  assert.strictEqual(subtrahiere(5, 3), 2);',
  '});',
  '',
  "test('multipliziere mit positiven Zahlen', () => {",
  '  assert.strictEqual(multipliziere(2, 3), 6);',
  '});',
  '',
  "test('multipliziere mit negativen Zahlen', () => {",
  '  assert.strictEqual(multipliziere(-2, -3), 6);',
  '  assert.strictEqual(multipliziere(-2, 3), -6);',
  '  assert.strictEqual(multipliziere(2, -3), -6);',
  '});',
  '',
  "test('multipliziere mit null', () => {",
  '  assert.strictEqual(multipliziere(0, 5), 0);',
  '  assert.strictEqual(multipliziere(5, 0), 0);',
  '  assert.strictEqual(multipliziere(0, 0), 0);',
  '  // 0 und -0 werden unterschieden (strictEqual nutzt Object.is)',
  '  assert.strictEqual(multipliziere(0, -9), -0);',
  '  assert.strictEqual(multipliziere(-9, 0), -0);',
  '});',
].join('\n') + '\n';

const HIST = Object.freeze({
  vorher: Object.freeze([
    Object.freeze({ pfad: 'src/rechne.js', text: VOR_RECHNE, bytes: 536, blob: '373b0fdb634b1c5aee2a87e054a3abe2ed349eff' }),
    Object.freeze({ pfad: 'test/rechne.test.js', text: VOR_TEST, bytes: 347, blob: '07b80ba8145e82818e1f8f2530a92b1714c1245f' }),
  ]),
  nachher: Object.freeze([
    Object.freeze({ pfad: 'src/rechne.js', text: NACH_RECHNE, bytes: 601, blob: '796a4ef32bff24ffd913bf2d0f888b7a6a2adc42' }),
    Object.freeze({ pfad: 'test/rechne.test.js', text: NACH_TEST, bytes: 1007, blob: '43c20fdb9201d42497b3ed1f7b75fa5becdadc9b' }),
  ]),
});

const RESULT_BLOBS = Object.freeze({
  'src/rechne.js': '796a4ef32bff24ffd913bf2d0f888b7a6a2adc42',
  'test/rechne.test.js': '43c20fdb9201d42497b3ed1f7b75fa5becdadc9b',
});

// Kontrolle jeder Fassung: Pfad, Bytegroesse, Git-Blob-ID, nur LF. Jede Abweichung bricht ab.
function historicalBytes(list) {
  const expectedPaths = ['src/rechne.js', 'test/rechne.test.js'];
  assert.deepEqual(list.map(entry => entry.pfad), expectedPaths, 'historische Pfade');
  const out = {};

  for (const entry of list) {
    const bytes = Buffer.from(entry.text, 'utf8');
    assert.equal(bytes.length, entry.bytes, `Bytegroesse ${entry.pfad}`);
    assert.equal(gitBlobId(bytes), entry.blob, `Git-Blob-ID ${entry.pfad}`);
    assert.ok(!bytes.includes(0x0d), `${entry.pfad} enthaelt CR`);
    out[entry.pfad] = bytes;
  }

  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Originalabnahme (Abschnitt 6): beide Dateien, nur CRLF zu LF, feste Konstanten
// ---------------------------------------------------------------------------

const ABNAHME_BLOB = 'c4fcb2d3ef44513ee0c578e80ff1e399f6832777';
const ABNAHME_SHA256 = 'b9f7bf34ac26ccc0b3155b03227dbe76965ea1c3e2c768622b0cb5fbcabd73aa';
const ABNAHME_AUSGABE = 'Code-Pilot: 110 unabhaengige Rechenfaelle bestanden.\n';

// Ersetzt ausschliesslich die Bytefolge 0D 0A durch 0A. Sonst keine Normalisierung.
function crlfToLf(bytes) {
  const out = [];

  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      continue;
    }

    out.push(bytes[i]);
  }

  return Buffer.from(out);
}

function originalAcceptanceBytes() {
  const a = crlfToLf(readFileSync(join(ROOT, 'agent-acceptance', 'issue-38.mjs')));
  const b = crlfToLf(readFileSync(join(ROOT, 'scripts', 'agent-code-acceptance.mjs')));

  for (const bytes of [a, b]) {
    assert.equal(sha256(bytes), ABNAHME_SHA256, 'SHA-256 der Originalabnahme');
    assert.equal(gitBlobId(bytes), ABNAHME_BLOB, 'Git-Blob-ID der Originalabnahme');
  }

  assert.ok(a.equals(b), 'beide Abnahmedateien sind nicht bytegleich');
  return a;
}

// ---------------------------------------------------------------------------
// Kuenstliche Auftragsdaten
// ---------------------------------------------------------------------------

const ISSUE = 38;
const RUN_A = '900000000001';
const RUN_B = '900000000002';
const HISTORICAL_RUN_ID = '42783596004';
const REPO_NAME = 'noah04091/agenten-probe';
const P = `/repos/${REPO_NAME}/`;
const branchOf = runId => `wp/${ISSUE}-agent-${runId}-1`;
const OWNER_USER = Object.freeze({ login: 'noah04091', type: 'User' });
const TITLE = 'Synthetisches Nachspiel: multipliziere ergaenzen';
const BODY = 'Kuenstlicher Auftrag fuer das Offline-Nachspiel von Issue 38. Bitte multipliziere(a, b) ergaenzen.';
const APPROVAL_TIME = '2026-11-10T08:33:39Z';
const RUN_CREATED = '2026-11-10T08:33:41Z';
const NOW = Date.parse('2026-11-10T08:40:00Z');
const NONCE = '0123456789abcdef0123456789abcdef';

const PROFILE_BYTES = readFileSync(join(ROOT, 'agent-profiles', 'js-rechner.json'));
const OTHER_PROFILE_BYTES = readFileSync(join(ROOT, 'agent-profiles', 'js-text.json'));
const DRAFT_POLICY_BYTES = readFileSync(join(ROOT, 'test', 'fixtures', 'agent-policy.entwurf.json'));
// Kuenstliche gueltige Policy nur fuer das Temp-Repository, aus der vorhandenen Testvorlage.
const POLICY_BYTES = Buffer.from(`${JSON.stringify({ ...JSON.parse(DRAFT_POLICY_BYTES), skript_hashes: { 'scripts/agent-profile.mjs': 'a'.repeat(64) } }, null, 2)}\n`, 'utf8');

const labelEvent = (id, name, createdAt) => ({
  id, event: 'labeled', created_at: createdAt, actor: { ...OWNER_USER }, label: { name, color: 'ededed' }, performed_via_github_app: null,
});

const baseEvents = () => [
  { id: 5000, event: 'assigned', created_at: '2026-11-10T08:00:00Z', actor: { ...OWNER_USER }, performed_via_github_app: null },
  labelEvent(5100, 'agent:js-rechner', '2026-11-10T08:30:00Z'),
  labelEvent(5101, 'bot-auftrag', APPROVAL_TIME),
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

// ---------------------------------------------------------------------------
// Temp-Repositorys mit isolierter Git-Umgebung
// ---------------------------------------------------------------------------

const GIT_PASSTHROUGH = Object.freeze(['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']);
let BASE_DIR;
let REPO;
let ENV;
let BASE;
let TEMPLATE;
let TRUSTED;
let dirNo = 0;

const envValue = key => Object.getOwnPropertyDescriptor(globalThis.process.env, key)?.value;

function gitTestEnv(home) {
  const env = {};

  for (const key of GIT_PASSTHROUGH) {
    const value = envValue(key);

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
  assert.ok(cwd.startsWith(BASE_DIR), `git ausserhalb des Temp-Ordners: ${cwd}`);
  return execFileSync('git', args, {
    cwd,
    env: { ...ENV, ...extraEnv },
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

const git = (args, input, extraEnv) => gitIn(REPO, args, input, extraEnv);

function newDir(prefix) {
  dirNo += 1;
  return join(BASE_DIR, `${prefix}${dirNo}`);
}

// Frischer, eigenstaendiger Checkout auf BASE: Dateikopie einer Vorlage, die selbst ein Klon ohne
// Hardlinks und ohne Remote ist. Eigenes .git-Verzeichnis, eigener Objektspeicher, kein Verweis.
function checkout(prefix = 'c') {
  const dir = newDir(prefix);
  cpSync(TEMPLATE, dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// GitHub-Simulator (Vorlage: A6.2-6-Test), Schreiben als echte Git-Objekte in REPO
// ---------------------------------------------------------------------------

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

const pullRecord = (number, ref) => ({
  number,
  state: 'closed',
  draft: false,
  html_url: `https://github.com/${REPO_NAME}/pull/${number}`,
  head: { ref, repo: { full_name: REPO_NAME } },
  base: { ref: 'main', repo: { full_name: REPO_NAME } },
});

function readTreeObject(sha) {
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
    if (rest === `actions/runs/${sim.run.id}`) {
      return ok(sim.run);
    }

    if (rest === 'git/ref/heads/main') {
      return ok({ ref: 'refs/heads/main', node_id: 'x', url: 'x', object: { sha: BASE, type: 'commit', url: 'x' } });
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
    const bytes = Buffer.from(body.content, 'base64');
    sim.uploads.push(bytes);
    const sha = git(['hash-object', '-w', '--stdin'], bytes);
    return created({ sha, url: 'x' });
  }

  if (req.method === 'POST' && rest === 'git/trees') {
    const indexEnv = { GIT_INDEX_FILE: join(BASE_DIR, `sim-index-${sim.id}`) };
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
    const record = {
      ...pullRecord(number, body.head),
      head: { ref: body.head, sha: sim.refs.get(`refs/heads/${body.head}`), repo: { full_name: REPO_NAME } },
      state: 'open',
      draft: body.draft,
      merged: false,
      title: body.title,
      body: body.body,
    };
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

let simNo = 0;

// tamper(req, res): veraendert eine Antwort (Rueckgabe undefined laesst sie unveraendert).
function createSim(runId = RUN_A) {
  simNo += 1;
  const sim = {
    id: simNo,
    issue: liveIssue(),
    events: baseEvents(),
    run: {
      id: Number(runId),
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
    },
    refs: new Map(),
    pulls: [pullRecord(1, 'wp/1-anderes'), pullRecord(2, 'wp/2-anderes')],
    nextPr: 4701,
    log: [],
    uploads: [],
    tamper: null,
  };

  sim.transport = async request => {
    const req = { method: request.method, path: request.path, body: request.body };
    sim.log.push(req);
    const res = handle(sim, req);
    return (sim.tamper?.(req, res)) ?? res;
  };

  return sim;
}

const restOf = req => req.path.slice(P.length);
const writes = sim => sim.log.filter(req => req.method !== 'GET').map(req => `${req.method} ${restOf(req)}`);
const WRITES_OK = Object.freeze(['POST git/blobs', 'POST git/blobs', 'POST git/trees', 'POST git/commits', 'POST git/refs', 'POST pulls']);
const liveChecks = (sim, runId) => sim.log.filter(req => req.method === 'GET' && restOf(req) === `actions/runs/${runId}`).length;

function clockOf(...values) {
  const clock = () => {
    if (clock.calls >= values.length) {
      throw new Error('Uhr: mehr Aufrufe als vorgesehen');
    }

    clock.calls += 1;
    return new Date(values[clock.calls - 1]);
  };

  clock.calls = 0;
  return clock;
}

// ---------------------------------------------------------------------------
// Testgeruest fuer die Uebergaenge, die A6.4 tragen muss (kein Produktionscode)
// ---------------------------------------------------------------------------

class NachspielError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NachspielError';
    this.code = code;
  }
}

const nfail = (code, message) => {
  throw new NachspielError(code, message);
};

let acceptanceStarts = 0;

// Abschnitt 10: Unmittelbar vor der Abnahme die Bytes, die JETZT im Pruef-Checkout liegen, gegen
// die Blob-IDs des geprueften Pakets rechnen. Pfade muessen genau die freigegebenen sein.
function bindCodeBeforeAcceptance(checkRoot, order, parsed) {
  const paths = parsed.dateien.map(meta => meta.pfad);

  if (paths.length !== order.dateien.length || paths.some((pfad, i) => pfad !== order.dateien[i])) {
    nfail('nachspiel-code-pfade', 'Paketpfade entsprechen nicht genau den freigegebenen Dateien');
  }

  return Object.freeze(Object.fromEntries(parsed.dateien.map(meta => {
    const abs = join(checkRoot, ...meta.pfad.split('/'));
    const stat = lstatSync(abs, { throwIfNoEntry: false });

    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
      nfail('nachspiel-code-datei', `${meta.pfad} ist keine gewoehnliche Datei`);
    }

    const blob = gitBlobId(readFileSync(abs));

    if (blob !== meta.git_blob) {
      nfail('nachspiel-code-blob', `${meta.pfad} weicht vom geprueften Paket ab`);
    }

    return [meta.pfad, blob];
  })));
}

// Abschnitt 11: genau die gebundene Abnahmedatei, absoluter Pfad, leere Umgebung, 10 Sekunden.
function runBoundAcceptance(checkRoot, order) {
  const file = join(checkRoot, ...order.abnahme_pfad.split('/'));
  const stat = lstatSync(file, { throwIfNoEntry: false });

  if (!isAbsolute(file) || !isAbsolute(globalThis.process.execPath) || stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
    nfail('nachspiel-abnahme-datei', 'Abnahmedatei oder Node-Pfad ungueltig');
  }

  const bytes = readFileSync(file);

  if (sha256(bytes) !== order.abnahme_sha256 || sha256(bytes) !== ABNAHME_SHA256) {
    nfail('nachspiel-abnahme-hash', 'Abnahmedatei im Pruef-Checkout weicht vom Auftrag ab');
  }

  // Bekannte Blob-ID bestaetigen (Abschnitt 11). Hinter der SHA-256-Pruefung derselben Bytes ist
  // dieser Zweig praktisch nicht einzeln erreichbar; er bleibt als ausdrueckliche zweite Bindung.
  if (gitBlobId(bytes) !== order.abnahme_blob || gitBlobId(bytes) !== ABNAHME_BLOB) {
    nfail('nachspiel-abnahme-blob', 'Blob-ID der Abnahmedatei weicht ab');
  }

  acceptanceStarts += 1;
  const out = spawnSync(globalThis.process.execPath, [file], {
    cwd: checkRoot, env: acceptanceEnv(), timeout: ACCEPTANCE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return Object.freeze({ status: out.status, signal: out.signal, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error ?? null });
}

// Leere Prozessumgebung, unter Windows nur SystemRoot. Austauschbar nur fuer die Gegenprobe.
const ACCEPTANCE_TIMEOUT_MS = 10_000;
const isolatedEnv = () => (IS_WINDOWS ? { SystemRoot: envValue('SystemRoot') } : {});
let acceptanceEnv = isolatedEnv;

// Prueft das Paket aus seinen BYTES selbst (parsePackageV2), bindet dann den Code im Pruef-Checkout
// an genau dieses Paket und fuehrt erst danach die Abnahme aus. Ergebnis: Nachweis, welcher Auftrag
// und welches Paket abgenommen wurden. Kein uebergebenes Metadatenobjekt wird geglaubt.
function acceptPackage(checkRoot, order, expectedSha256, pkg) {
  const parsed = parsePackageV2(order, expectedSha256, pkg.bytes, pkg.sha256);
  const blobs = bindCodeBeforeAcceptance(checkRoot, order, parsed);
  const run = runBoundAcceptance(checkRoot, order);

  if (run.status !== 0 || run.signal !== null || run.stdout !== ABNAHME_AUSGABE || run.stderr !== '') {
    const error = new NachspielError('nachspiel-abnahme-rot', 'unabhaengige Abnahme nicht bestanden');
    error.lauf = run;
    throw error;
  }

  return Object.freeze({ auftrag_sha256: expectedSha256, paket_sha256: sha256(pkg.bytes), blobs });
}

// Veroeffentlicht nur ein Paket, dessen Abnahme fuer genau diesen Auftrag und genau dieses Paket
// bestanden ist. Sonst kein einziger Transportaufruf.
async function publishAccepted(accepted, { sim, runId = RUN_A, expectedSha256, pkg, root = TRUSTED, checkRoot = checkout('v') }) {
  if (accepted?.auftrag_sha256 !== expectedSha256 || accepted?.paket_sha256 !== pkg.sha256) {
    nfail('nachspiel-abnahme-bindung', 'Paket oder Auftrag wurde nicht abgenommen');
  }

  return publishOrderDraft({
    root,
    checkRoot,
    baseSha: BASE,
    event: payload(),
    expectedSha256,
    runId,
    packageBytes: pkg.bytes,
    packageSha256: pkg.sha256,
    gitEnv: { ...ENV },
    transport: sim.transport,
    clock: clockOf(NOW, NOW, NOW, NOW),
  });
}

// ---------------------------------------------------------------------------
// Bausteine der Kette
// ---------------------------------------------------------------------------

function orderFor(runId, now = NOW) {
  return resolveOrder({
    root: TRUSTED,
    baseSha: BASE,
    gitEnv: { ...ENV },
    repository: REPO_NAME,
    event: payload(),
    issue: liveIssue(),
    events: baseEvents(),
    run: { id: runId, attempt: 1, createdAt: RUN_CREATED },
    now: new Date(now),
  });
}

// Arbeitsordner vorbereiten, Dateien schreiben (simulierte Aenderung), Paket bauen.
function packageFrom(order, hash, files, extra = () => {}) {
  const work = prepareWorkspace(TRUSTED, order, hash, newDir('w'), { gitEnv: { ...ENV } }).arbeitsordner;

  for (const [pfad, bytes] of Object.entries(files)) {
    writeFileSync(join(work, ...pfad.split('/')), bytes);
  }

  extra(work);
  const vergleich = compareWorkspace(TRUSTED, order, hash, work);
  const pkg = createPackageV2(TRUSTED, order, hash, work);
  return Object.freeze({ work, vergleich, text: pkg.text, bytes: Buffer.from(pkg.text, 'utf8'), sha256: pkg.sha256 });
}

const editPackage = (pkg, edit) => {
  const data = JSON.parse(pkg.text);
  edit(data);
  const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return Object.freeze({ bytes, sha256: sha256(bytes) });
};

function throwsCode(fn, code) {
  let caught = null;

  try {
    fn();
  } catch (error) {
    caught = error;
  }

  assert.ok(caught !== null, `erwartet ${code}, aber kein Fehler`);
  assert.equal(caught.code, code, `erwartet ${code}, erhalten ${caught.code}: ${caught.message}`);
  return caught;
}

// Sucht in .git/config nach dem Temp-Ordner in jeder Schreibweise, die Git verwendet (unter Windows
// mit verdoppelten Backslashes oder mit Schraegstrichen).
function configReferencesTemp(dir) {
  const text = readFileSync(join(dir, '.git', 'config'), 'utf8').toLowerCase();
  const base = BASE_DIR.toLowerCase();
  return [base, base.replaceAll('\\', '\\\\'), base.replaceAll('\\', '/')].some(form => text.includes(form));
}

const statusOf = dir => gitIn(dir, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);

let HIST_VOR;
let HIST_NACH;
let ACCEPTANCE_BYTES;
let ORDER;
let HASH;
let ORDER_B;
let HASH_B;
let PKG;
let PKG_B;

// ---------------------------------------------------------------------------
// Aufbau (einmalig) und Abbau
// ---------------------------------------------------------------------------

before(() => {
  // Vor jedem Aufbau: historische Daten und Originalabnahme. Jede Abweichung bricht hier ab.
  HIST_VOR = historicalBytes(HIST.vorher);
  HIST_NACH = historicalBytes(HIST.nachher);
  ACCEPTANCE_BYTES = originalAcceptanceBytes();

  BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-auftrag-nachspiel-test-'));
  REPO = join(BASE_DIR, 'github');
  const home = join(BASE_DIR, 'home');
  mkdirSync(REPO);
  mkdirSync(join(home, 'xdg'), { recursive: true });
  writeFileSync(join(home, 'leer.gitconfig'), '');
  ENV = gitTestEnv(home);

  // Simuliertes GitHub-Repository: genau ein Commit mit dem historischen Stand vor PR #47.
  git(['init', '-q']);
  const files = {
    '.github/agent/policy.json': POLICY_BYTES,
    'agent-acceptance/issue-38.mjs': ACCEPTANCE_BYTES,
    'agent-profiles/js-rechner.json': PROFILE_BYTES,
    'src/rechne.js': HIST_VOR['src/rechne.js'],
    'test/rechne.test.js': HIST_VOR['test/rechne.test.js'],
  };

  for (const [path, bytes] of Object.entries(files)) {
    git(['update-index', '--add', '--cacheinfo', `100644,${git(['hash-object', '-w', '--stdin'], bytes)},${path}`]);
  }

  BASE = git(['commit-tree', git(['write-tree']), '-m', 'Synthetischer Stand vor PR #47'], undefined, {
    GIT_AUTHOR_DATE: '2026-11-10T08:00:00Z', GIT_COMMITTER_DATE: '2026-11-10T08:00:00Z',
  });
  git(['update-ref', 'refs/heads/main', BASE]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);

  // Vorlage aller Checkouts: Klon ohne Hardlinks, danach ohne Remote.
  TEMPLATE = join(BASE_DIR, 'vorlage');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', REPO, TEMPLATE], { cwd: BASE_DIR, env: ENV, stdio: 'ignore' });
  gitIn(TEMPLATE, ['checkout', '-q', '--detach', BASE]);
  gitIn(TEMPLATE, ['remote', 'remove', 'origin']);
  TRUSTED = checkout('t');

  ORDER = orderFor(RUN_A);
  HASH = orderSha256(ORDER);
  ORDER_B = orderFor(RUN_B);
  HASH_B = orderSha256(ORDER_B);
  PKG = packageFrom(ORDER, HASH, HIST_NACH);
  PKG_B = packageFrom(ORDER_B, HASH_B, HIST_NACH);
});

after(() => {
  if (BASE_DIR !== undefined) {
    rmSync(BASE_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Grundlagen: historische Bytes, Originalabnahme, synthetische Umgebung
// ---------------------------------------------------------------------------

test('Historische Daten: vier Fassungen von PR #47 mit Pfad, Bytegroesse, Blob-ID und LF', () => {
  assert.match(HIST_BASE_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(HIST_HEAD_COMMIT, /^[0-9a-f]{40}$/);
  const seen = [...HIST.vorher, ...HIST.nachher].map(entry => [entry.pfad, Buffer.byteLength(entry.text), gitBlobId(Buffer.from(entry.text, 'utf8'))]);
  assert.deepEqual(seen, [
    ['src/rechne.js', 536, '373b0fdb634b1c5aee2a87e054a3abe2ed349eff'],
    ['test/rechne.test.js', 347, '07b80ba8145e82818e1f8f2530a92b1714c1245f'],
    ['src/rechne.js', 601, '796a4ef32bff24ffd913bf2d0f888b7a6a2adc42'],
    ['test/rechne.test.js', 1007, '43c20fdb9201d42497b3ed1f7b75fa5becdadc9b'],
  ]);

  // Gegenprobe: schon ein Zeichen Unterschied faellt auf.
  assert.throws(() => historicalBytes([{ ...HIST.nachher[0], text: NACH_RECHNE.replace('a * b', 'a + b') }, HIST.nachher[1]]), /Git-Blob-ID src\/rechne\.js/);
  assert.throws(() => historicalBytes([{ ...HIST.nachher[0], text: NACH_RECHNE.replaceAll('\n', '\r\n'), bytes: 625 }, HIST.nachher[1]]), /Git-Blob-ID|CR/);
  assert.throws(() => historicalBytes([HIST.nachher[1], HIST.nachher[0]]), /historische Pfade/);
});

test('Originalabnahme: beide Dateien nach CRLF zu LF bytegleich, SHA-256 und Blob-ID fest', () => {
  assert.equal(ACCEPTANCE_BYTES.length, 1768);
  assert.equal(sha256(ACCEPTANCE_BYTES), ABNAHME_SHA256);
  assert.equal(gitBlobId(ACCEPTANCE_BYTES), ABNAHME_BLOB);
  // Im Temp-Repository liegen genau diese Bytes, und der Auftrag bindet sie.
  assert.ok(readFileSync(join(TRUSTED, 'agent-acceptance', 'issue-38.mjs')).equals(ACCEPTANCE_BYTES));
  assert.equal(ORDER.abnahme_pfad, 'agent-acceptance/issue-38.mjs');
  assert.equal(ORDER.abnahme_blob, ABNAHME_BLOB);
  assert.equal(ORDER.abnahme_sha256, ABNAHME_SHA256);
  // Nur CRLF wird ersetzt, ein einzelnes CR bleibt stehen.
  assert.deepEqual([...crlfToLf(Buffer.from('a\r\nb\rc\n'))], [...Buffer.from('a\nb\rc\n')]);
});

test('Synthetische Umgebung: eigenstaendige Checkouts mit eigenem .git, kein Verweis, CommonJS-Kontext', () => {
  const check = checkout();

  for (const dir of [TRUSTED, check]) {
    const dotGit = lstatSync(join(dir, '.git'));
    assert.ok(dotGit.isDirectory() && !dotGit.isSymbolicLink(), `${dir}: .git ist kein eigenes Verzeichnis`);
    assert.equal(existsSync(join(dir, '.git', 'objects', 'info', 'alternates')), false, 'fremder Objektspeicher');
    assert.equal(existsSync(join(dir, '.git', 'commondir')), false, 'verknuepfter Arbeitsbaum');
    assert.equal(gitIn(dir, ['remote']), '', 'Remote vorhanden');
    assert.equal(configReferencesTemp(dir), false, 'Konfiguration verweist auf einen anderen Ordner');
    assert.equal(gitIn(dir, ['rev-parse', 'HEAD']), BASE);
    assert.equal(statusOf(dir), '');
  }

  // Gegenprobe (Muss-Treffer): Ein Klon, der seinen Remote behaelt, wird erkannt.
  const linked = newDir('l');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', REPO, linked], { cwd: BASE_DIR, env: ENV, stdio: 'ignore' });
  assert.equal(configReferencesTemp(linked), true, 'Verweissuche ist blind');

  assert.notEqual(TRUSTED, check);
  assert.deepEqual(gitIn(TRUSTED, ['ls-files']).split('\n'), [
    '.github/agent/policy.json', 'agent-acceptance/issue-38.mjs', 'agent-profiles/js-rechner.json', 'src/rechne.js', 'test/rechne.test.js',
  ]);
  assert.equal(existsSync(join(TRUSTED, 'package.json')), false);

  // Wirksamer Modulkontext: Das naechste package.json oberhalb von src/ darf nicht type=module sein.
  let dir = join(check, 'src');

  for (;;) {
    const file = join(dir, 'package.json');

    if (existsSync(file)) {
      assert.notEqual(JSON.parse(readFileSync(file, 'utf8')).type, 'module', `${file} setzt type=module`);
      break;
    }

    if (dirname(dir) === dir) {
      break;
    }

    dir = dirname(dir);
  }

  // Die historischen Dateien bleiben CommonJS.
  assert.ok(HIST_NACH['src/rechne.js'].toString('utf8').includes('module.exports = { addiere, subtrahiere, multipliziere };'));
  assert.ok(!/^export /m.test(HIST_NACH['src/rechne.js'].toString('utf8')));
});

// ---------------------------------------------------------------------------
// Positive Kette A bis F mit historischem Endnachweis
// ---------------------------------------------------------------------------

test('Positive Kette: Auftrag, Prompt, Arbeitsordner, Paket, Pruef-Checkout, Abnahme und Draft-PR ergeben die Blobs von PR #47', async () => {
  // A: Auftrag festlegen und live bestaetigen.
  assert.equal(sameOrder(ORDER, HASH), true);
  assert.equal(ORDER.issue, ISSUE);
  assert.equal(ORDER.profil_id, 'js-rechner');
  assert.equal(ORDER.profil_sha256, sha256(PROFILE_BYTES));
  assert.deepEqual([...ORDER.dateien], ['src/rechne.js', 'test/rechne.test.js']);
  assert.deepEqual({ ...ORDER.basis_blobs }, { 'src/rechne.js': HIST.vorher[0].blob, 'test/rechne.test.js': HIST.vorher[1].blob });
  assert.deepEqual([...ORDER.labels].sort(), ['agent:js-rechner', 'bot-auftrag']);
  assert.deepEqual({ ...ORDER.startfreigabe }, { ereignis_id: 5101, zeitpunkt: APPROVAL_TIME, akteur: 'noah04091', nummer: 1 });
  assert.deepEqual({ ...ORDER.lauf }, { run_id: RUN_A, run_attempt: 1, erstellt: RUN_CREATED });
  assert.notEqual(ORDER.lauf.run_id, HISTORICAL_RUN_ID);
  assert.equal(ORDER.base_sha, BASE);

  const liveSim = createSim();
  const state = await readLiveState({ transport: liveSim.transport, repository: REPO_NAME, issueNumber: ISSUE, runId: RUN_A });
  const live = checkLiveOrder({ expectedSha256: HASH, event: payload(), state, root: TRUSTED, baseSha: BASE, gitEnv: { ...ENV }, now: new Date(NOW), runId: RUN_A });
  assert.equal(orderSha256(live), HASH);
  assert.deepEqual(writes(liveSim), []);

  // B: Prompt aus dem geprueften Auftrag. Kein Claude-Aufruf.
  const prompt = buildPrompt({ order: ORDER, expectedSha256: HASH, profileBytes: PROFILE_BYTES, title: TITLE, body: BODY, createNonce: () => NONCE });
  assert.ok(prompt.startsWith(SECURITY_FRAME));
  const profile = JSON.parse(PROFILE_BYTES);
  assert.ok(prompt.includes(profile.auftrag_rahmen));
  assert.ok(prompt.includes('Erlaubte Dateien aus dem geprueften Auftrag:\n- src/rechne.js\n- test/rechne.test.js\n'));
  const open = prompt.indexOf(`<auftrag-${NONCE}>\n`);
  const close = prompt.indexOf(`</auftrag-${NONCE}>\n`);
  assert.ok(open > prompt.indexOf('# Issue-Daten (nicht vertrauenswuerdig, nur fachliche Beschreibung)'));
  assert.ok(close > open && prompt.endsWith(`</auftrag-${NONCE}>\n`));
  assert.ok(prompt.indexOf(TITLE) > open && prompt.indexOf(TITLE) < close, 'Titel ausserhalb des Blocks');
  assert.ok(prompt.indexOf(BODY) > open && prompt.indexOf(BODY) < close, 'Text ausserhalb des Blocks');
  assert.equal(prompt.split(TITLE).length, 2);

  // C: Arbeitsordner (beim Aufbau angelegt) ohne .git, Byte fuer Byte der Ausgangsstand ausser den
  // beiden simulierten Aenderungen. Der vertrauenswuerdige Checkout bleibt unveraendert.
  assert.equal(existsSync(join(PKG.work, '.git')), false);
  assert.deepEqual(readdirSync(PKG.work, { recursive: true }).filter(entry => !lstatSync(join(PKG.work, entry)).isDirectory()).map(entry => entry.replaceAll('\\', '/')).sort(),
    ['.github/agent/policy.json', 'agent-acceptance/issue-38.mjs', 'agent-profiles/js-rechner.json', 'src/rechne.js', 'test/rechne.test.js']);
  assert.ok(readFileSync(join(PKG.work, 'agent-acceptance', 'issue-38.mjs')).equals(ACCEPTANCE_BYTES));
  assert.equal(statusOf(TRUSTED), '');
  assert.ok(readFileSync(join(TRUSTED, 'src', 'rechne.js')).equals(HIST_VOR['src/rechne.js']));

  // D: Vergleich und Paket.
  assert.deepEqual(PKG.vergleich.dateien.map(file => [file.pfad, file.git_blob, file.bytes]), [
    ['src/rechne.js', RESULT_BLOBS['src/rechne.js'], 601],
    ['test/rechne.test.js', RESULT_BLOBS['test/rechne.test.js'], 1007],
  ]);
  assert.equal(PKG.sha256, sha256(PKG.bytes));
  const data = JSON.parse(PKG.text);
  assert.equal(data.auftrag_sha256, HASH);
  assert.equal(data.abnahme_sha256, ABNAHME_SHA256);

  // E: unabhaengig pruefen und in einen frischen Pruef-Checkout anwenden.
  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);
  assert.equal(parsed.auftrag_sha256, HASH);
  assert.equal(parsed.paket_sha256, PKG.sha256);
  assert.deepEqual(parsed.dateien.map(meta => [meta.pfad, meta.basis_blob, meta.git_blob]), [
    ['src/rechne.js', HIST.vorher[0].blob, RESULT_BLOBS['src/rechne.js']],
    ['test/rechne.test.js', HIST.vorher[1].blob, RESULT_BLOBS['test/rechne.test.js']],
  ]);

  for (const pfad of ORDER.dateien) {
    assert.ok(packageFileBytes(parsed, pfad).equals(HIST_NACH[pfad]), pfad);
  }

  const check = checkout();
  const applied = applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
  assert.deepEqual([...applied.dateien], ['src/rechne.js', 'test/rechne.test.js']);
  assert.equal(statusOf(check), ' M src/rechne.js\n M test/rechne.test.js');
  assert.equal(gitIn(check, ['diff', '--name-status', '--no-renames']), 'M\tsrc/rechne.js\nM\ttest/rechne.test.js');
  assert.equal(gitIn(check, ['diff', '--summary']), '');
  assert.equal(gitIn(check, ['ls-files', '-s', '--', 'src/rechne.js', 'test/rechne.test.js']),
    `100644 ${HIST.vorher[0].blob} 0\tsrc/rechne.js\n100644 ${HIST.vorher[1].blob} 0\ttest/rechne.test.js`);
  assert.equal(gitIn(check, ['hash-object', 'src/rechne.js', 'test/rechne.test.js']), `${RESULT_BLOBS['src/rechne.js']}\n${RESULT_BLOBS['test/rechne.test.js']}`);
  assert.equal(sha256(PKG.bytes), PKG.sha256);
  assert.equal(statusOf(TRUSTED), '');

  // Abschnitt 10 und 11: Code binden, gebundene Abnahme tatsaechlich ausfuehren.
  const startsBefore = acceptanceStarts;
  const accepted = acceptPackage(check, ORDER, HASH, PKG);
  assert.equal(acceptanceStarts, startsBefore + 1);
  assert.deepEqual({ ...accepted.blobs }, RESULT_BLOBS);

  // Die historischen Tests laufen als CommonJS unveraendert im Pruef-Checkout.
  const own = spawnSync(globalThis.process.execPath, ['--test', '--test-reporter=tap', join(check, 'test', 'rechne.test.js')], {
    cwd: check, env: IS_WINDOWS ? { SystemRoot: envValue('SystemRoot') } : {}, timeout: 30_000, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(own.status, 0, own.stdout + own.stderr);
  assert.match(own.stdout, /^# pass 5$/m);
  assert.match(own.stdout, /^# fail 0$/m);

  // Abschnitt 12: Veroeffentlichung aus einem weiteren frischen Pruef-Checkout.
  const sim = createSim();
  const publishCheck = checkout('v');
  const result = await publishAccepted(accepted, { sim, expectedSha256: HASH, pkg: PKG, checkRoot: publishCheck });

  assert.deepEqual(writes(sim), WRITES_OK);
  assert.equal(liveChecks(sim, RUN_A), 5, 'Live-Pruefungen');
  const firstWrite = sim.log.findIndex(req => req.method !== 'GET');
  assert.equal(sim.log.slice(0, firstWrite).filter(req => restOf(req) === `actions/runs/${RUN_A}`).length, 2, 'zwei vollstaendige Live-Pruefungen vor dem ersten Schreiben');
  assert.ok(!sim.log.some(req => /merge/i.test(req.path)), 'Merge-Anfrage');

  // Bytegenaue Uploads, Baum, Commit mit genau einem Parent, Branch, Remote-Diff, Draft-PR.
  assert.deepEqual(sim.uploads.map(bytes => bytes.toString('base64')), ORDER.dateien.map(pfad => HIST_NACH[pfad].toString('base64')));
  const tree = JSON.parse(sim.log.find(req => restOf(req) === 'git/trees' && req.method === 'POST').body);
  assert.equal(tree.base_tree, git(['rev-parse', `${BASE}^{tree}`]));
  assert.deepEqual(tree.tree, ORDER.dateien.map(pfad => ({ path: pfad, mode: '100644', type: 'blob', sha: RESULT_BLOBS[pfad] })));
  assert.equal(git(['rev-parse', `${result.commit}^@`]), BASE);
  assert.equal(git(['rev-parse', `${result.commit}^{tree}`]), result.baum);
  assert.equal(sim.refs.get(`refs/heads/${branchOf(RUN_A)}`), result.commit);
  assert.equal(result.branch, branchOf(RUN_A));
  assert.equal(git(['diff-tree', '-r', '--no-renames', '--name-status', BASE, result.commit]), 'M\tsrc/rechne.js\nM\ttest/rechne.test.js');
  const compare = JSON.parse(handle(sim, { method: 'GET', path: `${P}compare/${BASE}...${result.commit}` }).body);
  assert.deepEqual(compare.files.map(file => [file.filename, file.sha]), Object.entries(RESULT_BLOBS));
  const pr = sim.pulls.at(-1);
  assert.equal(pr.draft, true);
  assert.equal(pr.merged, false);
  assert.equal(pr.head.ref, branchOf(RUN_A));
  assert.equal(result.pr_nummer, pr.number);
  assert.equal(result.auftrag_sha256, HASH);
  assert.equal(result.paket_sha256, PKG.sha256);
  assert.ok(JSON.parse(sim.log.at(-1).body).body.includes(HASH));

  // Historischer Endnachweis: PR #47 = gepruefte Paket-Blobs = veroeffentlichte Blobs.
  const published = Object.fromEntries(git(['ls-tree', result.commit, '--', ...ORDER.dateien]).split('\n').map(line => {
    const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    return [match[2], match[1]];
  }));
  const packaged = Object.fromEntries(parsed.dateien.map(meta => [meta.pfad, meta.git_blob]));
  const historical = Object.fromEntries(HIST.nachher.map(entry => [entry.pfad, entry.blob]));
  assert.deepEqual(historical, RESULT_BLOBS);
  assert.deepEqual(packaged, RESULT_BLOBS);
  assert.deepEqual(published, RESULT_BLOBS);
  assert.deepEqual({ ...accepted.blobs }, RESULT_BLOBS);

  // Nur der Veroeffentlichungs-Checkout wurde beschrieben, root blieb sauber.
  assert.equal(statusOf(TRUSTED), '');
  assert.equal(statusOf(publishCheck), ' M src/rechne.js\n M test/rechne.test.js');
});

// ---------------------------------------------------------------------------
// Abnahme negativ: fachlich falsche, formal gueltige Staende durch die ganze Paketkette
// ---------------------------------------------------------------------------

const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `Ersetzung nicht eindeutig: ${from}`);
  return text.replace(from, () => to);
};

const FACHLICH_FALSCH = Object.freeze([
  {
    name: 'Multiplikation durch Addition ersetzt',
    files: () => ({ ...HIST_NACH, 'src/rechne.js': Buffer.from(replaceOnce(NACH_RECHNE, 'return a * b;', 'return a + b;')) }),
    grund: 'multipliziere(2, 3) liefert ein falsches Ergebnis',
    art: 'arithmetik',
    exitcode: 1,
  },
  {
    name: '-0 unzulaessig zu 0 normalisiert',
    files: () => ({ ...HIST_NACH, 'src/rechne.js': Buffer.from(replaceOnce(NACH_RECHNE, 'return a * b;', 'return a * b + 0;')) }),
    grund: 'multipliziere(0, -9) liefert ein falsches Ergebnis',
    art: 'arithmetik',
    exitcode: 1,
  },
  {
    name: 'Export multipliziere entfernt',
    files: () => ({ ...HIST_NACH, 'src/rechne.js': Buffer.from(replaceOnce(NACH_RECHNE, 'module.exports = { addiere, subtrahiere, multipliziere };', 'module.exports = { addiere, subtrahiere };')) }),
    grund: 'multipliziere muss exportiert sein',
    art: 'export',
    exitcode: 1,
  },
  {
    name: 'addiere beschaedigt',
    files: () => ({ ...HIST_NACH, 'src/rechne.js': Buffer.from(replaceOnce(NACH_RECHNE, 'return a + b;', 'return a + b + 1;')) }),
    grund: 'addiere(2, 3) wurde beeintraechtigt',
    art: 'arithmetik',
    exitcode: 1,
  },
  {
    // Ablehnung durch fehlenden Export, KEINE arithmetische Gegenprobe. Weil der Testcode als
    // src/rechne.js geladen wird, registriert er node:test-Tests; dessen Geruest meldet den
    // Abbruch der Abnahme mit Exitcode 7 statt 1. Der Grund bleibt dieselbe AssertionError.
    name: 'Inhalte von Code- und Testdatei vertauscht',
    files: () => ({ 'src/rechne.js': HIST_NACH['test/rechne.test.js'], 'test/rechne.test.js': HIST_NACH['src/rechne.js'] }),
    grund: 'addiere muss exportiert sein',
    art: 'export',
    exitcode: 7,
  },
]);

test('Abnahme negativ: fuenf fachlich falsche Staende bestehen die Paketpruefung und scheitern getrennt an der Abnahme', async () => {
  const reasons = [];

  for (const fall of FACHLICH_FALSCH) {
    // Formal gueltig: Arbeitsordner, Paket, Pruefung, Anwendung und Code-Bindung bestehen.
    const pkg = packageFrom(ORDER, HASH, fall.files());
    const parsed = parsePackageV2(ORDER, HASH, pkg.bytes, pkg.sha256);
    const check = checkout();
    applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
    bindCodeBeforeAcceptance(check, ORDER, parsed);

    const startsBefore = acceptanceStarts;
    const error = throwsCode(() => acceptPackage(check, ORDER, HASH, pkg), 'nachspiel-abnahme-rot');
    assert.equal(acceptanceStarts, startsBefore + 1, `${fall.name}: Abnahme lief nicht`);
    const { status, stderr } = error.lauf;
    assert.equal(status, fall.exitcode, `${fall.name}: ${stderr}`);
    assert.match(stderr, /AssertionError \[ERR_ASSERTION\]/, `${fall.name}: keine fachliche Ablehnung`);
    assert.ok(stderr.includes(fall.grund), `${fall.name}: erwartet "${fall.grund}", erhalten ${stderr}`);
    assert.doesNotMatch(stderr, /SyntaxError|ReferenceError|TypeError|ERR_REQUIRE|ERR_MODULE/, `${fall.name}: Lade- oder Syntaxfehler`);
    reasons.push(`${fall.art}: ${fall.grund}`);

    // Bei roter Abnahme entsteht kein Abnahmenachweis, also ist keine Veroeffentlichung moeglich.
    // Die Bindung Abnahme -> Veroeffentlichung pruefen die Uebergangstests unten.
  }

  assert.equal(new Set(reasons).size, FACHLICH_FALSCH.length, 'Ablehnungsgruende nicht getrennt');
});

// ---------------------------------------------------------------------------
// Uebergaenge
// ---------------------------------------------------------------------------

test('Uebergang Auftragsbindung: derselbe volle Auftrags-SHA in jeder Stufe, Uhrzeit aendert ihn nicht', async () => {
  // Spaeterer Pruefzeitpunkt im zulaessigen Fenster: derselbe Auftrag.
  assert.equal(orderSha256(orderFor(RUN_A, NOW + 30 * 60_000)), HASH);
  assert.notEqual(HASH_B, HASH);

  // Jede Stufe verlangt genau HASH. Ein anderer gueltiger Hash wird abgelehnt.
  throwsCode(() => buildPrompt({ order: ORDER, expectedSha256: HASH_B, profileBytes: PROFILE_BYTES, title: TITLE, body: BODY }), 'auftrag-abweichung');
  throwsCode(() => prepareWorkspace(TRUSTED, ORDER, HASH_B, newDir('w'), { gitEnv: { ...ENV } }), 'auftrag-abweichung');
  throwsCode(() => createPackageV2(TRUSTED, ORDER, HASH_B, PKG.work), 'auftrag-abweichung');
  throwsCode(() => parsePackageV2(ORDER, HASH_B, PKG.bytes, PKG.sha256), 'auftrag-abweichung');
  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);
  throwsCode(() => applyPackageV2(checkout(), ORDER, HASH_B, parsed, { gitEnv: { ...ENV } }), 'auftrag-abweichung');
  assert.equal(JSON.parse(PKG.text).auftrag_sha256, HASH);

  // Paket eines anderen Auftrags: Veroeffentlichung lehnt vor dem ersten Schreibaufruf ab.
  const sim = createSim();
  const outcome = await publishOrderDraft({
    root: TRUSTED, checkRoot: checkout('v'), baseSha: BASE, event: payload(), expectedSha256: HASH, runId: RUN_A,
    packageBytes: PKG_B.bytes, packageSha256: PKG_B.sha256, gitEnv: { ...ENV }, transport: sim.transport, clock: clockOf(NOW, NOW, NOW, NOW),
  }).then(() => null, error => error);
  assert.ok(outcome instanceof PublishError, String(outcome));
  assert.equal(outcome.code, 'paket-bindung');
  assert.deepEqual(writes(sim), []);
  assert.equal(outcome.bericht.schreibaufrufe, 0);
});

test('Uebergang fremder Lauf: Paket aus Lauf A in Lauf B wird ohne Schreibaufruf abgelehnt', async () => {
  // Der Lauf steckt im Auftrag: gleiche Issue-Daten, anderer Lauf, anderer Auftrag.
  assert.equal(ORDER_B.lauf.run_id, RUN_B);
  assert.notEqual(HASH_B, HASH);

  // B mit seinen eigenen vertrauenswuerdigen Daten, aber dem Paket von A.
  const simB = createSim(RUN_B);
  const own = await publishOrderDraft({
    root: TRUSTED, checkRoot: checkout('v'), baseSha: BASE, event: payload(), expectedSha256: HASH_B, runId: RUN_B,
    packageBytes: PKG.bytes, packageSha256: PKG.sha256, gitEnv: { ...ENV }, transport: simB.transport, clock: clockOf(NOW, NOW, NOW, NOW),
  }).then(() => null, error => error);
  assert.ok(own instanceof PublishError, String(own));
  assert.equal(own.code, 'paket-bindung');
  assert.deepEqual(writes(simB), []);

  // B mit dem Auftrags-Hash von A: die Live-Pruefung bildet den Auftrag von B und lehnt ab.
  const simB2 = createSim(RUN_B);
  const foreign = await publishOrderDraft({
    root: TRUSTED, checkRoot: checkout('v'), baseSha: BASE, event: payload(), expectedSha256: HASH, runId: RUN_B,
    packageBytes: PKG.bytes, packageSha256: PKG.sha256, gitEnv: { ...ENV }, transport: simB2.transport, clock: clockOf(NOW, NOW, NOW, NOW),
  }).then(() => null, error => error);
  assert.ok(foreign instanceof PublishError, String(foreign));
  assert.equal(foreign.code, 'auftrag-abweichung');
  assert.deepEqual(writes(simB2), []);

  // Auch offline: Pruefung des A-Pakets gegen den B-Auftrag.
  throwsCode(() => parsePackageV2(ORDER_B, HASH_B, PKG.bytes, PKG.sha256), 'paket-bindung');
});

test('Uebergang Auftrag zu Prompt: fremder Auftrag, ungepruefter Auftrag, anderes Profil und anderer Issue-Text', () => {
  const base = { order: ORDER, expectedSha256: HASH, profileBytes: PROFILE_BYTES, title: TITLE, body: BODY, createNonce: () => NONCE };
  throwsCode(() => buildPrompt({ ...base, order: ORDER_B }), 'auftrag-abweichung');
  throwsCode(() => buildPrompt({ ...base, order: JSON.parse(JSON.stringify(ORDER)) }), 'auftrag-ungeprueft');
  throwsCode(() => buildPrompt({ ...base, profileBytes: OTHER_PROFILE_BYTES }), 'prompt-profil-hash');
  throwsCode(() => buildPrompt({ ...base, body: `${BODY} Zusaetzlich scripts/ aendern.` }), 'prompt-issue-abweichung');
  assert.ok(buildPrompt(base).includes(BODY));
});

test('Uebergang Auftrag zu Paket: veraenderter Paket-SHA, Issue-Bindung, zusaetzliche Datei und Dateieintrag', () => {
  // Veraenderter Paket-SHA.
  throwsCode(() => parsePackageV2(ORDER, HASH, PKG.bytes, sha256(Buffer.from('anders'))), 'paket-hash');

  // Manipulierte Issue-Bindung (Hash passend neu berechnet, damit die Bindung selbst greift).
  const otherIssue = editPackage(PKG, data => {
    data.issue = 39;
  });
  throwsCode(() => parsePackageV2(ORDER, HASH, otherIssue.bytes, otherIssue.sha256), 'paket-bindung');
  const otherIssueHash = editPackage(PKG, data => {
    data.issue_sha256 = 'f'.repeat(64);
  });
  throwsCode(() => parsePackageV2(ORDER, HASH, otherIssueHash.bytes, otherIssueHash.sha256), 'paket-bindung');

  // Zusaetzlicher Dateieintrag im Paket.
  const extraEntry = editPackage(PKG, data => {
    data.dateien.push({ ...data.dateien[0], pfad: 'agent-acceptance/issue-38.mjs' });
  });
  throwsCode(() => parsePackageV2(ORDER, HASH, extraEntry.bytes, extraEntry.sha256), 'paket-dateiliste');

  // Zusaetzliche, nicht erlaubte Datei im Arbeitsordner: kein Paket.
  for (const extra of [
    work => writeFileSync(join(work, 'README.md'), '# neu\n'),
    work => writeFileSync(join(work, 'agent-acceptance', 'issue-38.mjs'), "console.log('Code-Pilot: 110 unabhaengige Rechenfaelle bestanden.');\n"),
  ]) {
    assert.throws(() => packageFrom(ORDER, HASH, HIST_NACH, extra), error => typeof error.code === 'string' && error.code.startsWith('paket-'));
  }
});

test('Uebergang Paket zu Pruef-Checkout: fremd gepruefter Auftrag und unsauberer Checkout', () => {
  const parsedB = parsePackageV2(ORDER_B, HASH_B, PKG_B.bytes, PKG_B.sha256);
  throwsCode(() => applyPackageV2(checkout(), ORDER, HASH, parsedB, { gitEnv: { ...ENV } }), 'paket-bindung');

  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);
  const dirty = checkout();
  writeFileSync(join(dirty, 'src', 'rechne.js'), HIST_NACH['src/rechne.js']);
  throwsCode(() => applyPackageV2(dirty, ORDER, HASH, parsed, { gitEnv: { ...ENV } }), 'paket-status');

  // Ein schon beschriebener Pruef-Checkout ist nicht wiederverwendbar.
  const used = checkout();
  applyPackageV2(used, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
  throwsCode(() => applyPackageV2(used, ORDER, HASH, parsed, { gitEnv: { ...ENV } }), 'paket-status');
});

test('Uebergang Pruef-Checkout zu Abnahme: Manipulation nach dem Anwenden faellt vor dem Start der Abnahme auf', () => {
  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);
  const cases = [
    ['src/rechne.js', bytes => Buffer.from(bytes.toString('utf8').replace('return a * b;', 'return a + b;'))],
    ['src/rechne.js', bytes => Buffer.concat([bytes, Buffer.from('// nachtraeglich\n')])],
    ['test/rechne.test.js', bytes => Buffer.from(bytes.toString('utf8').replace('multipliziere(0, -9), -0', 'multipliziere(0, -9), 0'))],
  ];

  for (const [pfad, change] of cases) {
    const check = checkout();
    applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
    const abs = join(check, ...pfad.split('/'));
    const before = readFileSync(abs);
    writeFileSync(abs, change(before));
    assert.ok(!readFileSync(abs).equals(before), 'Manipulation hat nichts veraendert');

    const startsBefore = acceptanceStarts;
    throwsCode(() => acceptPackage(check, ORDER, HASH, PKG), 'nachspiel-code-blob');
    assert.equal(acceptanceStarts, startsBefore, 'Abnahme wurde trotz Manipulation gestartet');
  }

  // Die Abnahmedatei selbst wird gebunden: ein Ersatz, der nur die Erfolgszeile ausgibt, laeuft nie.
  const check = checkout();
  applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
  writeFileSync(join(check, 'agent-acceptance', 'issue-38.mjs'), `console.log(${JSON.stringify(ABNAHME_AUSGABE.trim())});\n`);
  const startsBefore = acceptanceStarts;
  throwsCode(() => acceptPackage(check, ORDER, HASH, PKG), 'nachspiel-abnahme-hash');
  assert.equal(acceptanceStarts, startsBefore);

  // Kontrolle: unveraendert angewendet besteht die Bindung.
  const clean = checkout();
  applyPackageV2(clean, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
  assert.deepEqual({ ...bindCodeBeforeAcceptance(clean, ORDER, parsed) }, RESULT_BLOBS);
});

test('Uebergang Abnahme zu Veroeffentlichung: nur das abgenommene Paket des abgenommenen Auftrags', async () => {
  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);
  const check = checkout();
  applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
  const accepted = acceptPackage(check, ORDER, HASH, PKG);

  // Anderes, formal gueltiges Paket (fachlich falsch) mit derselben Abnahme: kein Transportaufruf.
  const wrong = packageFrom(ORDER, HASH, FACHLICH_FALSCH[0].files());
  const sim = createSim();
  await assert.rejects(publishAccepted(accepted, { sim, expectedSha256: HASH, pkg: wrong }), error => error.code === 'nachspiel-abnahme-bindung');
  // Abnahme fuer Auftrag A, Veroeffentlichung fuer Auftrag B: kein Transportaufruf.
  await assert.rejects(publishAccepted(accepted, { sim, runId: RUN_B, expectedSha256: HASH_B, pkg: PKG }), error => error.code === 'nachspiel-abnahme-bindung');
  assert.equal(sim.log.length, 0);
});

test('Uebergang Abnahme: der Nachweis haengt an den Paketbytes, nicht an behaupteten Metadaten', () => {
  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);
  const check = checkout();
  applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });

  // Pruef-Checkout traegt das richtige Paket, behauptet wird ein anderes, formal gueltiges Paket:
  // Die Code-Bindung rechnet gegen die Bytes des behaupteten Pakets und stoppt vor der Abnahme.
  const wrong = packageFrom(ORDER, HASH, FACHLICH_FALSCH[0].files());
  const startsBefore = acceptanceStarts;
  throwsCode(() => acceptPackage(check, ORDER, HASH, wrong), 'nachspiel-code-blob');
  // Richtige Bytes mit fremdem Hash: parsePackageV2 lehnt ab.
  throwsCode(() => acceptPackage(check, ORDER, HASH, { bytes: PKG.bytes, sha256: wrong.sha256 }), 'paket-hash');
  // Richtiges Paket, anderer Auftrag.
  throwsCode(() => acceptPackage(check, ORDER, HASH_B, PKG), 'auftrag-abweichung');
  assert.equal(acceptanceStarts, startsBefore, 'Abnahme wurde gestartet');

  // Kontrolle: das richtige Paket wird abgenommen und als genau dieses Paket nachgewiesen.
  const accepted = acceptPackage(check, ORDER, HASH, PKG);
  assert.equal(accepted.paket_sha256, PKG.sha256);
  assert.equal(accepted.auftrag_sha256, HASH);
});

test('Abnahme-Ausfuehrung: leere Umgebung, Zeitlimit und nur gewoehnliche Codedateien', () => {
  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);

  // NODE_OPTIONS aus der Umgebung des Testprozesses erreicht die Abnahme nicht.
  const marker = join(BASE_DIR, 'node-options-marker.txt');
  const evil = join(BASE_DIR, 'node-options-evil.cjs');
  writeFileSync(evil, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
  const env = globalThis.process.env;
  const saved = Object.getOwnPropertyDescriptor(env, 'NODE_OPTIONS')?.value;

  try {
    env.NODE_OPTIONS = `--require=${JSON.stringify(evil)}`;
    const check = checkout();
    applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
    acceptPackage(check, ORDER, HASH, PKG);
    assert.equal(existsSync(marker), false, 'NODE_OPTIONS hat die Abnahme erreicht');

    // Gegenprobe (Muss-Treffer): mit geerbter Umgebung wird die Einschleusung wirksam.
    acceptanceEnv = () => ({ ...env });
    acceptPackage(check, ORDER, HASH, PKG);
    assert.equal(existsSync(marker), true, 'Gegenprobe ohne Wirkung, Messung blind');
  } finally {
    acceptanceEnv = isolatedEnv;

    if (saved === undefined) {
      delete env.NODE_OPTIONS;
    } else {
      env.NODE_OPTIONS = saved;
    }
  }

  // Haengende Abnahme: das Zeitlimit beendet sie, das Ergebnis ist rot.
  const hang = packageFrom(ORDER, HASH, {
    ...HIST_NACH, 'src/rechne.js': Buffer.from(replaceOnce(NACH_RECHNE, '  return a * b;\n', '  for (;;) {\n    // haengt\n  }\n')),
  });
  const hangCheck = checkout();
  applyPackageV2(hangCheck, ORDER, HASH, parsePackageV2(ORDER, HASH, hang.bytes, hang.sha256), { gitEnv: { ...ENV } });
  const started = Date.now();
  const error = throwsCode(() => acceptPackage(hangCheck, ORDER, HASH, hang), 'nachspiel-abnahme-rot');
  const elapsed = Date.now() - started;
  assert.equal(error.lauf.status, null);
  assert.equal(error.lauf.signal, 'SIGTERM');
  assert.ok(elapsed >= ACCEPTANCE_TIMEOUT_MS - 500 && elapsed < 3 * ACCEPTANCE_TIMEOUT_MS, `Laufzeit ${elapsed} ms`);

  // Eine freigegebene Datei, die keine gewoehnliche Datei mehr ist, stoppt vor der Abnahme.
  const dirCheck = checkout();
  applyPackageV2(dirCheck, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
  rmSync(join(dirCheck, 'src', 'rechne.js'));
  mkdirSync(join(dirCheck, 'src', 'rechne.js'));
  const startsBefore = acceptanceStarts;
  throwsCode(() => acceptPackage(dirCheck, ORDER, HASH, PKG), 'nachspiel-code-datei');
  assert.equal(acceptanceStarts, startsBefore);
});

test('Simulator-Antwort manipuliert: falsche Blob-ID nach dem Upload stoppt vor Baum, Branch und PR', async () => {
  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);
  const check = checkout();
  applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
  const accepted = acceptPackage(check, ORDER, HASH, PKG);

  const sim = createSim();
  sim.tamper = (req, res) => (req.method === 'POST' && restOf(req) === 'git/blobs'
    ? { ...res, body: JSON.stringify({ ...JSON.parse(res.body), sha: HIST.vorher[0].blob }) }
    : undefined);
  const error = await publishAccepted(accepted, { sim, expectedSha256: HASH, pkg: PKG }).then(() => null, caught => caught);
  assert.ok(error instanceof PublishError, String(error));
  assert.equal(error.code, 'publish-blob-abweichung');
  assert.deepEqual(writes(sim), ['POST git/blobs']);
  assert.equal(sim.refs.size, 0);
  assert.equal(error.bericht.bereinigung, 'nicht-noetig');
});

// ---------------------------------------------------------------------------
// Fruehere Luecke, seit A6.4-1 geschlossen: fremde head.sha in der PR-Antwort
// ---------------------------------------------------------------------------

test('A6.4-1: fremde head.sha in der Antwort auf POST pulls wird abgelehnt, Branch und Draft-PR bleiben stehen', async () => {
  // Bis A6.4-1 hat dieser Test die Luecke gemessen (gefaelschte head.sha wurde akzeptiert). Jetzt
  // belegt er die Ablehnung und die Sicherheitsfolgen nach einer bereits gestellten PR-Anfrage.
  const parsed = parsePackageV2(ORDER, HASH, PKG.bytes, PKG.sha256);
  const check = checkout();
  applyPackageV2(check, ORDER, HASH, parsed, { gitEnv: { ...ENV } });
  const accepted = acceptPackage(check, ORDER, HASH, PKG);

  const sim = createSim();
  const foreignHead = 'e'.repeat(40);
  const delivered = [];
  sim.tamper = (req, res) => {
    if (req.method !== 'POST' || restOf(req) !== 'pulls') {
      return undefined;
    }

    const json = JSON.parse(res.body);
    const forged = { ...json, head: { ...json.head, sha: foreignHead } };
    delivered.push(forged.head.sha);
    return { ...res, body: JSON.stringify(forged) };
  };
  const error = await publishAccepted(accepted, { sim, expectedSha256: HASH, pkg: PKG }).then(() => null, caught => caught);
  const branch = branchOf(RUN_A);
  const commit = sim.refs.get(`refs/heads/${branch}`);

  // Muss-Treffer: Die gefaelschte Antwort wurde genau einmal ausgeliefert und weicht vom Commit ab.
  assert.deepEqual(delivered, [foreignHead]);
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.notEqual(commit, foreignHead);

  // Ablehnung mit vollstaendigem Fehlerbericht, kein Erfolg.
  assert.ok(error instanceof PublishError, String(error));
  assert.equal(error.code, 'publish-pr-antwort');
  assert.equal(error.bericht.pr_angefragt, true);
  assert.equal(error.bericht.bereinigung, 'nicht-geloescht');
  assert.equal(error.bericht.bereinigung_grund, 'pr-angefragt');
  assert.equal(error.bericht.commit, commit);
  assert.equal(error.bericht.branch, branch);

  // Alle Schreibaufrufe bis einschliesslich POST pulls, danach keine Anfrage, kein DELETE.
  assert.deepEqual(writes(sim), WRITES_OK);
  assert.equal(sim.log.at(-1).method, 'POST');
  assert.equal(restOf(sim.log.at(-1)), 'pulls');
  assert.ok(!sim.log.some(req => req.method === 'DELETE'));

  // Eigener Branch und simulierter Draft-PR bestehen weiter, die Branchspitze ist unveraendert.
  assert.ok(sim.refs.has(`refs/heads/${branch}`));
  assert.equal(sim.pulls.at(-1).head.ref, branch);
  assert.equal(sim.pulls.at(-1).head.sha, commit);
  assert.equal(sim.pulls.at(-1).draft, true);
});
