// Tests fuer scripts/agent-code-auftrag-paket.mjs (A6.2-4).
//
// Keine Netzanfragen, keine Zugangsdaten, keine GitHub-Schreibzugriffe und keine Agentenstarts.
// Alle Repositorys, Checkouts und Arbeitsordner liegen in einem eigenen Temp-Ordner mit isoliertem
// HOME. Geheimnisse sind kuenstliche Werte. Auf das echte Repository wird nur lesend ueber das
// Dateisystem zugegriffen (Profile, Policy-Fixture, Quelltext und Workflows fuer die Wachtests).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, chmodSync, constants as fsConstants, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OrderError, orderSha256, resolveOrder } from '../scripts/agent-code-auftrag.mjs';
import {
  MAX_CHANGED_LINES, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_PATCH_BYTES, MIN_SECRET_LENGTH, PACKAGE_SCHEMA,
  applyPackageV2, compareWorkspace, containsSecretValue, createPackageV2, packageFileBytes, parsePackageV2,
  prepareWorkspace, requireAllChanged, scanForSecrets,
} from '../scripts/agent-code-auftrag-paket.mjs';
import { ProfileError } from '../scripts/agent-profile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_PATH = join(ROOT, 'scripts/agent-code-auftrag-paket.mjs');
const RECHNER_BYTES = readFileSync(join(ROOT, 'agent-profiles/js-rechner.json'));
const DRAFT_POLICY_BYTES = readFileSync(join(ROOT, 'test/fixtures/agent-policy.entwurf.json'));
const IS_WINDOWS = globalThis.process.platform === 'win32';

const canon = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const POLICY_BYTES = canon({ ...JSON.parse(DRAFT_POLICY_BYTES), skript_hashes: { 'scripts/agent-profile.mjs': 'a'.repeat(64) } });
const RECHNER = JSON.parse(RECHNER_BYTES);
// Profile mit drei Dateien fuer die Paketgrenze von 60 000 Bytes.
const DREI_FILES = ['src/drei-a.js', 'src/drei-b.js', 'src/drei-c.js'];
const DREI_BYTES = canon({ ...RECHNER, id: 'js-drei', dateien: DREI_FILES });
// Mit js-drei ist genau 60 000 erreichbar, 60 001 bis 60 003 nicht (Base64 waechst in
// Viererschritten, die Ziffern von bytes nur an Zehnergrenzen). Die um ein Zeichen laengere
// Profil-ID js-dreix macht genau 60 001 erreichbar, deshalb ein zweites Profil mit denselben Dateien.
const DREIX_BYTES = canon({ ...RECHNER, id: 'js-dreix', dateien: DREI_FILES });

const ISSUE = 999001;
const REPO_NAME = 'noah04091/agenten-probe';
const OWNER_USER = Object.freeze({ login: 'noah04091', type: 'User' });
const TITLE = 'Potenz ergaenzen';
const BODY = 'Bitte eine Funktion potenz(a, b) ergaenzen.';
const APPROVAL_TIME = '2026-11-10T08:33:39Z';
const RUN_CREATED = '2026-11-10T08:33:41Z';

const RECHNE_BASE = 'export const addiere = (a, b) => a + b;\n';
const TEST_BASE = "import test from 'node:test';\n";
const RECHNE_NEU = `${RECHNE_BASE}export const potenz = (a, b) => a ** b;\n`;
const TEST_NEU = `${TEST_BASE}import assert from 'node:assert/strict';\nimport { potenz } from '../src/rechne.js';\n\ntest('potenz', () => {\n  assert.strictEqual(potenz(2, 3), 8);\n});\n`;

const BASE_FILES = Object.freeze({
  '.github/agent/policy.json': POLICY_BYTES,
  'agent-profiles/js-rechner.json': RECHNER_BYTES,
  'agent-profiles/js-drei.json': DREI_BYTES,
  'agent-profiles/js-dreix.json': DREIX_BYTES,
  'src/rechne.js': RECHNE_BASE,
  'test/rechne.test.js': TEST_BASE,
  'src/drei-a.js': '// a\n',
  'src/drei-b.js': '// b\n',
  'src/drei-c.js': '// c\n',
  'README.md': '# Probe\n',
  'docs/tief/info.md': 'Info\n',
  [`agent-acceptance/issue-${ISSUE}.mjs`]: '// synthetische Abnahme, wird nie ausgefuehrt\nexport const synthetisch = true;\n',
});

// ---------------------------------------------------------------------------
// Temp-Repository, Checkouts und echter Auftrag aus resolveOrder
// ---------------------------------------------------------------------------

const GIT_PASSTHROUGH = Object.freeze(['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']);
let BASE_DIR;
let REPO;
let ENV;
let BASE;
let OTHER;
let TRUSTED;
let refNo = 0;
let dirNo = 0;

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

function gitIn(cwd, args, input) {
  return execFileSync('git', args, {
    cwd,
    env: ENV,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

const git = (args, input) => gitIn(REPO, args, input);

// Baut einen Commit aus { pfad: inhalt } oder { pfad: { mode, content } } und haengt ihn an einen
// eigenen Zweig, damit jeder Klon ihn enthaelt.
function commitWith(files) {
  git(['read-tree', '--empty']);

  for (const [path, value] of Object.entries(files)) {
    const { mode, content } = typeof value === 'object' && !Buffer.isBuffer(value) ? value : { mode: '100644', content: value };
    const oid = git(['hash-object', '-w', '--stdin'], content);
    git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`]);
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

// Frischer Checkout auf sha, als eigener Klon mit eigenem .git.
function checkout(sha = BASE) {
  const dir = newDir('c');
  execFileSync('git', ['clone', '-q', '--no-checkout', REPO, dir], { env: ENV, stdio: 'ignore' });
  gitIn(dir, ['checkout', '-q', '--detach', sha]);
  return dir;
}

const labelEvent = (id, event, name, createdAt) => ({
  id, event, created_at: createdAt, actor: { ...OWNER_USER }, label: { name, color: 'ededed' }, performed_via_github_app: null,
});

function realOrder({ baseSha = BASE, profile = 'js-rechner' } = {}) {
  return resolveOrder({
    root: REPO,
    baseSha,
    gitEnv: { ...ENV },
    repository: REPO_NAME,
    event: {
      action: 'labeled',
      label: { name: 'bot-auftrag' },
      sender: { ...OWNER_USER },
      repository: { full_name: REPO_NAME },
      issue: { number: ISSUE, user: { login: 'noah04091' }, title: TITLE, body: BODY, updated_at: APPROVAL_TIME },
    },
    issue: {
      number: ISSUE,
      state: 'open',
      title: TITLE,
      body: BODY,
      updated_at: APPROVAL_TIME,
      user: { ...OWNER_USER },
      labels: [{ name: 'bot-auftrag' }, { name: `agent:${profile}` }],
    },
    events: [
      labelEvent(5100, 'labeled', `agent:${profile}`, '2026-11-10T08:30:00Z'),
      labelEvent(5101, 'labeled', 'bot-auftrag', APPROVAL_TIME),
    ],
    run: { id: '42783596004', attempt: 1, createdAt: RUN_CREATED },
    now: new Date('2026-11-10T08:40:00Z'),
  });
}

const opts = () => ({ gitEnv: { ...ENV } });
const sha256 = data => createHash('sha256').update(data).digest('hex');
const blobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function assertCode(error, codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  assert.ok(error instanceof OrderError || error instanceof ProfileError, `unerwarteter Fehler: ${error?.stack ?? error}`);
  assert.ok(list.includes(error.code), `erwartet ${list.join(' oder ')}, erhalten ${error.code}: ${error.message}`);
  return true;
}

const rejects = (fn, codes) => assert.throws(fn, error => assertCode(error, codes));

// Vorbereiteter Arbeitsordner fuer einen echten Auftrag.
function setup({ profile = 'js-rechner', trusted = TRUSTED } = {}) {
  const order = realOrder({ profile });
  const hash = orderSha256(order);
  const work = newDir('w');
  const result = prepareWorkspace(trusted, order, hash, work, opts());
  return { order, hash, trusted, work: result.arbeitsordner, result };
}

function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

const GOOD = Object.freeze({ 'src/rechne.js': RECHNE_NEU, 'test/rechne.test.js': TEST_NEU });

function edited(files = GOOD, options) {
  const ctx = setup(options);
  write(ctx.work, files);
  return ctx;
}

function packaged(files, options) {
  const ctx = edited(files, options);
  const created = createPackageV2(ctx.trusted, ctx.order, ctx.hash, ctx.work);
  return { ...ctx, created, bytes: Buffer.from(created.text, 'utf8') };
}

// Baut aus einem veraenderten Paketobjekt kanonische Bytes und den passenden Paket-Hash.
function rebuilt(data) {
  const bytes = canon(data);
  return { bytes, hash: sha256(bytes) };
}

function entryFor(order, pfad, content) {
  const bytes = Buffer.from(content);
  return {
    pfad,
    basis_blob: order.basis_blobs[pfad],
    git_blob: blobId(bytes),
    sha256: sha256(bytes),
    bytes: bytes.length,
    base64: bytes.toString('base64'),
  };
}

function parseRejects(ctx, data, codes) {
  const { bytes, hash } = rebuilt(data);
  rejects(() => parsePackageV2(ctx.order, ctx.hash, bytes, hash), codes);
}

function walkFiles(dir, rel = '') {
  const out = [];

  for (const name of readdirSync(join(dir, rel)).sort()) {
    const path = rel === '' ? name : `${rel}/${name}`;

    try {
      readdirSync(join(dir, path));
      out.push(`${path}/`, ...walkFiles(dir, path));
    } catch {
      out.push(path);
    }
  }

  return out;
}

const treeOf = files => {
  const out = new Set();

  for (const path of Object.keys(files)) {
    const parts = path.split('/');

    for (let depth = 1; depth < parts.length; depth += 1) {
      out.add(`${parts.slice(0, depth).join('/')}/`);
    }

    out.add(path);
  }

  return [...out].sort();
};

function trySymlink(t, target, link, type) {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Symlinks sind auf diesem System nicht erlaubt (laeuft unter Ubuntu in der CI)');
      return false;
    }

    throw error;
  }
}

before(() => {
  BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-auftrag-paket-test-'));
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
  TRUSTED = checkout(BASE);
});

after(() => {
  rmSync(BASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ---------------------------------------------------------------------------
// prepareWorkspace: Positiv
// ---------------------------------------------------------------------------

test('Vorbereitung: kopiert genau die Dateien des Ausgangscommits, ohne .git, Byte fuer Byte', () => {
  const { work, result } = setup();
  assert.deepEqual(walkFiles(work), treeOf(BASE_FILES));
  assert.ok(!existsSync(join(work, '.git')));
  assert.equal(result.dateien, Object.keys(BASE_FILES).length);

  for (const [path, content] of Object.entries(BASE_FILES)) {
    assert.ok(readFileSync(join(work, ...path.split('/'))).equals(Buffer.from(content)), path);
  }

  assert.ok(Object.isFrozen(result));
  // Der vertrauenswuerdige Checkout bleibt unveraendert und sauber.
  assert.equal(gitIn(TRUSTED, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']), '');
});

test('Vorbereitung: ein vorhandener leerer Ordner wird angenommen', () => {
  const order = realOrder();
  const work = newDir('w');
  mkdirSync(work);
  const result = prepareWorkspace(TRUSTED, order, orderSha256(order), work, opts());
  assert.deepEqual(walkFiles(result.arbeitsordner), treeOf(BASE_FILES));
});

// ---------------------------------------------------------------------------
// prepareWorkspace: Auftrag, Checkout und Ausgangsbaum
// ---------------------------------------------------------------------------

test('Vorbereitung: nur ein echter Auftrag mit passendem Hash', () => {
  const order = realOrder();
  const hash = orderSha256(order);
  rejects(() => prepareWorkspace(TRUSTED, JSON.parse(JSON.stringify(order)), hash, newDir('w'), opts()), 'auftrag-ungeprueft');
  rejects(() => prepareWorkspace(TRUSTED, order, 'f'.repeat(64), newDir('w'), opts()), 'auftrag-abweichung');
  rejects(() => prepareWorkspace(TRUSTED, order, hash.toUpperCase(), newDir('w'), opts()), 'auftrag-hash-format');
});

test('Vorbereitung: Optionen brauchen genau gitEnv mit isolierter Umgebung', () => {
  const order = realOrder();
  const hash = orderSha256(order);
  rejects(() => prepareWorkspace(TRUSTED, order, hash, newDir('w'), {}), 'paket-eingabe');
  rejects(() => prepareWorkspace(TRUSTED, order, hash, newDir('w'), { ...opts(), extra: 1 }), 'paket-eingabe');
  rejects(() => prepareWorkspace(TRUSTED, order, hash, newDir('w')), 'paket-eingabe');
  rejects(() => prepareWorkspace(TRUSTED, order, hash, newDir('w'), { gitEnv: { ...ENV, GIT_DIR: 'x' } }), 'auftrag-git-umgebung');
});

test('Vorbereitung: falscher Ausgangscommit im Checkout', () => {
  const order = realOrder();
  rejects(() => prepareWorkspace(checkout(OTHER), order, orderSha256(order), newDir('w'), opts()), 'paket-head');
});

test('Vorbereitung: falsches Repository-Verzeichnis', () => {
  const order = realOrder();
  const hash = orderSha256(order);
  // Unterordner eines Checkouts und ein Ordner ganz ohne Repository.
  rejects(() => prepareWorkspace(join(TRUSTED, 'src'), order, hash, newDir('w'), opts()), 'auftrag-git-wurzel');
  const plain = newDir('p');
  mkdirSync(plain);
  rejects(() => prepareWorkspace(plain, order, hash, newDir('w'), opts()), 'auftrag-git-wurzel');
  rejects(() => prepareWorkspace('relativ/pfad', order, hash, newDir('w'), opts()), 'paket-pfad');
});

test('Vorbereitung: unsauberer Index, ungetrackte und ignorierte Dateien, leerer Zusatzordner', () => {
  const order = realOrder();
  const hash = orderSha256(order);

  const staged = checkout();
  writeFileSync(join(staged, 'README.md'), '# geaendert\n');
  gitIn(staged, ['add', 'README.md']);
  rejects(() => prepareWorkspace(staged, order, hash, newDir('w'), opts()), 'paket-status');

  const modified = checkout();
  writeFileSync(join(modified, 'README.md'), '# geaendert\n');
  rejects(() => prepareWorkspace(modified, order, hash, newDir('w'), opts()), 'paket-status');

  const untracked = checkout();
  writeFileSync(join(untracked, 'neu.txt'), 'neu\n');
  rejects(() => prepareWorkspace(untracked, order, hash, newDir('w'), opts()), 'paket-status');

  const ignored = checkout();
  writeFileSync(join(ignored, '.git', 'info', 'exclude'), 'cache/\n');
  write(ignored, { 'cache/x.bin': 'x' });
  rejects(() => prepareWorkspace(ignored, order, hash, newDir('w'), opts()), 'paket-status');

  // Leere Ordner zeigt git status nicht an, die Dateisystempruefung schon.
  const emptyDir = checkout();
  mkdirSync(join(emptyDir, 'leer'));
  rejects(() => prepareWorkspace(emptyDir, order, hash, newDir('w'), opts()), 'paket-quelle');

  // Index nur in der Ablage veraendert, Arbeitsdatei gleich: Status zeigt die gestagte Aenderung.
  const indexOnly = checkout();
  const oid = gitIn(indexOnly, ['hash-object', '-w', '--stdin'], 'anders\n');
  gitIn(indexOnly, ['update-index', '--cacheinfo', `100644,${oid},README.md`]);
  rejects(() => prepareWorkspace(indexOnly, order, hash, newDir('w'), opts()), 'paket-status');
});

test('Vorbereitung: ausfuehrbare Datei und Symlink im Ausgangsbaum werden abgelehnt', () => {
  for (const entry of [{ mode: '100755', content: '#!/bin/sh\n' }, { mode: '120000', content: 'README.md' }]) {
    const sha = commitWith({ ...BASE_FILES, 'docs/werkzeug': entry });
    const order = realOrder({ baseSha: sha });
    rejects(() => prepareWorkspace(checkout(sha), order, orderSha256(order), newDir('w'), opts()), 'paket-baum-modus');
  }
});

test('Vorbereitung: Pfade, die sich nur in der Schreibweise unterscheiden', () => {
  const sha = commitWith({ ...BASE_FILES, 'docs/Hinweis.md': 'A\n', 'docs/hinweis.md': 'B\n' });
  const order = realOrder({ baseSha: sha });
  // Unter Windows kollidieren die Dateien schon beim Checkout, der Status ist dann nicht sauber.
  // Unter Ubuntu liegen beide vor, und erst die Pfadpruefung lehnt ab.
  rejects(() => prepareWorkspace(checkout(sha), order, orderSha256(order), newDir('w'), opts()), IS_WINDOWS ? ['paket-status', 'paket-baum-pfad'] : 'paket-baum-pfad');

  const dirSha = commitWith({ ...BASE_FILES, 'Docs/x.md': 'A\n' });
  const dirOrder = realOrder({ baseSha: dirSha });
  rejects(() => prepareWorkspace(checkout(dirSha), dirOrder, orderSha256(dirOrder), newDir('w'), opts()), IS_WINDOWS ? ['paket-status', 'paket-baum-pfad', 'paket-quelle'] : 'paket-baum-pfad');
});

test('Vorbereitung: Basis-Blob des Auftrags muss zum Checkout passen', () => {
  // Auftrag auf OTHER (andere README, gleiche Profildateien), Checkout auf OTHER: gueltig.
  const order = realOrder({ baseSha: OTHER });
  assert.ok(prepareWorkspace(checkout(OTHER), order, orderSha256(order), newDir('w'), opts()).dateien > 0);
});

// ---------------------------------------------------------------------------
// prepareWorkspace: Arbeitsordner und Ueberschneidung
// ---------------------------------------------------------------------------

test('Ueberschneidung: Arbeitsordner im Checkout, Checkout im Arbeitsordner, identisch', () => {
  const order = realOrder();
  const hash = orderSha256(order);
  const trusted = checkout();
  rejects(() => prepareWorkspace(trusted, order, hash, join(trusted, 'arbeit'), opts()), 'paket-ueberschneidung');
  rejects(() => prepareWorkspace(trusted, order, hash, join(trusted, 'src', 'arbeit'), opts()), 'paket-ueberschneidung');
  rejects(() => prepareWorkspace(trusted, order, hash, trusted, opts()), 'paket-ueberschneidung');
  // Checkout liegt im Arbeitsordner: der Elternordner enthaelt den Checkout.
  rejects(() => prepareWorkspace(trusted, order, hash, dirname(trusted), opts()), 'paket-ueberschneidung');
  // Nichts wurde im Checkout angelegt.
  assert.ok(!existsSync(join(trusted, 'arbeit')));
  assert.equal(gitIn(trusted, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']), '');
});

test('Ueberschneidung: andere Schreibweise des Checkout-Pfads', () => {
  const order = realOrder();
  const hash = orderSha256(order);
  const trusted = checkout();
  // Windows: derselbe Ordner. Ubuntu: ein neuer Ordner, der sich nur in der Schreibweise
  // unterscheidet. Beide gelten als Ueberschneidung (unter Ubuntu bewusst ein falsches Nein).
  const upper = join(dirname(trusted), basename(trusted).toUpperCase());
  rejects(() => prepareWorkspace(trusted, order, hash, upper, opts()), 'paket-ueberschneidung');
  assert.ok(IS_WINDOWS || !existsSync(upper));
  if (IS_WINDOWS) {
    rejects(() => prepareWorkspace(trusted, order, hash, join(upper, 'arbeit'), opts()), 'paket-ueberschneidung');
  }
});

test('Ueberschneidung: ueber einen Symlink im Elternpfad (nur wo Symlinks erlaubt sind)', t => {
  const order = realOrder();
  const trusted = checkout();
  const link = newDir('l');

  if (!trySymlink(t, trusted, link, 'dir')) {
    return;
  }

  // Ist der direkte Elternordner ein Symlink, wird er schon als Pfad abgelehnt.
  rejects(() => prepareWorkspace(trusted, order, orderSha256(order), join(link, 'arbeit'), opts()), 'paket-pfad');
  // Liegt der Symlink weiter oben, loest realpath ihn auf und die Ueberschneidung faellt auf.
  const upper = newDir('l');
  symlinkSync(dirname(trusted), upper, 'dir');
  rejects(() => prepareWorkspace(trusted, order, orderSha256(order), join(upper, basename(trusted), 'arbeit'), opts()), 'paket-ueberschneidung');
  rejects(() => prepareWorkspace(trusted, order, orderSha256(order), join(upper, basename(trusted), 'src', 'arbeit'), opts()), 'paket-ueberschneidung');
  // Der Arbeitsordner selbst darf kein Symlink sein, auch nicht auf einen leeren Ordner.
  const empty = newDir('e');
  mkdirSync(empty);
  const workLink = newDir('l');
  symlinkSync(empty, workLink, 'dir');
  rejects(() => prepareWorkspace(trusted, order, orderSha256(order), workLink, opts()), 'paket-pfad');
  assert.ok(!existsSync(join(trusted, 'arbeit')));
});

test('Arbeitsordner: nicht leer, keine Datei, Elternordner fehlt, relativer Pfad', () => {
  const order = realOrder();
  const hash = orderSha256(order);
  const full = newDir('w');
  mkdirSync(full);
  writeFileSync(join(full, 'alt.txt'), 'alt\n');
  rejects(() => prepareWorkspace(TRUSTED, order, hash, full, opts()), 'paket-ziel-nicht-leer');
  assert.deepEqual(readdirSync(full), ['alt.txt']);
  const file = newDir('f');
  writeFileSync(file, 'x');
  rejects(() => prepareWorkspace(TRUSTED, order, hash, file, opts()), 'paket-pfad');
  rejects(() => prepareWorkspace(TRUSTED, order, hash, join(newDir('fehlt'), 'arbeit'), opts()), 'paket-pfad');
  rejects(() => prepareWorkspace(TRUSTED, order, hash, 'arbeit', opts()), 'paket-pfad');
  rejects(() => prepareWorkspace(TRUSTED, order, hash, `${newDir('n')}\0x`, opts()), 'paket-pfad');
});

test('Arbeitsordner: UNC-Pfad auf denselben Datentraeger wird abgelehnt (nur Windows)', t => {
  if (!IS_WINDOWS) {
    t.skip('UNC-Pfade gibt es nur unter Windows');
    return;
  }

  const order = realOrder();
  const trusted = checkout();
  const unc = `\\\\localhost\\${trusted[0]}$${trusted.slice(2)}`;

  if (!existsSync(join(unc, 'README.md'))) {
    t.skip('Administrative Freigabe ist hier nicht erreichbar');
    return;
  }

  rejects(() => prepareWorkspace(trusted, order, orderSha256(order), join(unc, 'arbeit'), opts()), 'paket-pfad');
  rejects(() => prepareWorkspace(unc, order, orderSha256(order), newDir('w'), opts()), 'paket-pfad');
  assert.ok(!existsSync(join(trusted, 'arbeit')));
  assert.equal(gitIn(trusted, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']), '');
});

test('Arbeitsordner: Name mit Punkt oder Leerzeichen am Ende wird abgelehnt', () => {
  const order = realOrder();

  for (const suffix of ['.', ' ', '..', '\u3000', '\t']) {
    const work = `${newDir('w')}${suffix}`;
    rejects(() => prepareWorkspace(TRUSTED, order, orderSha256(order), work, opts()), 'paket-pfad');
  }

  // Datenstrom-Schreibweise, reservierte Geraetenamen und verbotene Zeichen. Es entsteht kein Ordner.
  for (const name of ['neu::$INDEX_ALLOCATION', 'neu:strom', 'NUL', 'con', 'aux.txt', 'Com1', 'a<b', 'a|b', 'a?b', 'a*b', 'a"b', 'a\u0001b']) {
    const parent = newDir('n');
    mkdirSync(parent);
    rejects(() => prepareWorkspace(TRUSTED, order, orderSha256(order), join(parent, name), opts()), 'paket-pfad');
    assert.deepEqual(readdirSync(parent), [], name);
  }
});

test('Vorbereitung und Anwenden: als unveraendert markierte, aber geaenderte Datei', () => {
  // git status sieht die Aenderung nicht, die Dateisystempruefung gegen die Blob-IDs schon.
  const order = realOrder();
  const hash = orderSha256(order);
  const hidden = checkout();
  gitIn(hidden, ['update-index', '--assume-unchanged', 'README.md']);
  writeFileSync(join(hidden, 'README.md'), '# heimlich\n');
  assert.equal(gitIn(hidden, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']), '', 'Gegenprobe: Status bleibt sauber');
  rejects(() => prepareWorkspace(hidden, order, hash, newDir('w'), opts()), 'paket-quelle');

  const ctx = packaged();
  const parsed = parsePackageV2(ctx.order, ctx.hash, ctx.bytes, ctx.created.sha256);
  rejects(() => applyPackageV2(hidden, ctx.order, ctx.hash, parsed, opts()), 'paket-pruef-checkout');
  assert.equal(readFileSync(join(hidden, 'src', 'rechne.js'), 'utf8'), RECHNE_BASE);
});

// ---------------------------------------------------------------------------
// compareWorkspace: nach Claude
// ---------------------------------------------------------------------------

test('Vergleich: korrekter Arbeitsordner mit allen freigegebenen Aenderungen', () => {
  const { order, hash, trusted, work } = edited();
  const result = compareWorkspace(trusted, order, hash, work);
  assert.deepEqual(result.dateien.map(file => file.pfad), ['src/rechne.js', 'test/rechne.test.js']);
  assert.equal(result.dateien[0].git_blob, blobId(Buffer.from(RECHNE_NEU)));
  assert.equal(result.dateien[0].sha256, sha256(RECHNE_NEU));
  assert.equal(result.dateien[1].bytes, Buffer.byteLength(TEST_NEU));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.dateien) && Object.isFrozen(result.dateien[0]));
  assert.ok(!JSON.stringify(result).includes('potenz'));
});

test('Vergleich: neue Datei, auch mit verdaechtigem Namen, wird ohne Namen gemeldet', () => {
  const { order, hash, trusted, work } = edited();
  const name = `ghp_${'N'.repeat(36)}.js`;
  writeFileSync(join(work, 'src', name), 'x\n');
  assert.throws(() => compareWorkspace(trusted, order, hash, work), error => assertCode(error, 'paket-datei-neu') && !error.message.includes(name.slice(0, 10)));
});

test('Vergleich: geloeschte Datei, fehlender Ordner, zusaetzlicher Ordner', () => {
  const missing = edited();
  unlinkSync(join(missing.work, 'README.md'));
  rejects(() => compareWorkspace(missing.trusted, missing.order, missing.hash, missing.work), 'paket-datei-fehlt');

  const noDir = edited();
  rmSync(join(noDir.work, 'docs'), { recursive: true });
  rejects(() => compareWorkspace(noDir.trusted, noDir.order, noDir.hash, noDir.work), 'paket-ordner-fehlt');

  const extra = edited();
  mkdirSync(join(extra.work, 'src', 'leer'));
  rejects(() => compareWorkspace(extra.trusted, extra.order, extra.hash, extra.work), 'paket-ordner-neu');

  const allowedMissing = edited();
  unlinkSync(join(allowedMissing.work, 'test', 'rechne.test.js'));
  rejects(() => compareWorkspace(allowedMissing.trusted, allowedMissing.order, allowedMissing.hash, allowedMissing.work), 'paket-datei-fehlt');
});

test('Vergleich: fremde Aenderung, auch bei gleicher Groesse', () => {
  // '# Prove' hat genau die Groesse von '# Probe': nur der Bytevergleich findet diese Aenderung.
  assert.equal(Buffer.byteLength('# Prove\n'), Buffer.byteLength(BASE_FILES['README.md']));

  for (const content of ['# Prove\n', '# Probe!\n', '# Prob\n', '# Probe\n\n']) {
    const ctx = edited({ ...GOOD, 'README.md': content });
    rejects(() => compareWorkspace(ctx.trusted, ctx.order, ctx.hash, ctx.work), 'paket-fremde-aenderung');
  }

  const deep = edited({ ...GOOD, 'agent-profiles/js-rechner.json': '{}\n' });
  rejects(() => compareWorkspace(deep.trusted, deep.order, deep.hash, deep.work), 'paket-fremde-aenderung');
});

test('Vergleich: jede freigegebene Datei muss geaendert sein', () => {
  const one = edited({ 'src/rechne.js': RECHNE_NEU });
  rejects(() => compareWorkspace(one.trusted, one.order, one.hash, one.work), 'paket-unveraendert');
  const none = edited({});
  rejects(() => compareWorkspace(none.trusted, none.order, none.hash, none.work), 'paket-unveraendert');
});

test('Vergleich: Dateityp geaendert', () => {
  const asDir = edited();
  unlinkSync(join(asDir.work, 'README.md'));
  mkdirSync(join(asDir.work, 'README.md'));
  rejects(() => compareWorkspace(asDir.trusted, asDir.order, asDir.hash, asDir.work), 'paket-dateityp');

  const asFile = edited();
  rmSync(join(asFile.work, 'docs'), { recursive: true });
  writeFileSync(join(asFile.work, 'docs'), 'x\n');
  rejects(() => compareWorkspace(asFile.trusted, asFile.order, asFile.hash, asFile.work), 'paket-dateityp');
});

test('Vergleich: .git nachtraeglich angelegt, auch in anderer Schreibweise und tiefer', () => {
  for (const path of ['.git/config', '.GIT/config', 'src/.git/HEAD', '.git']) {
    const ctx = edited();
    write(ctx.work, { [path]: '[core]\n' });
    rejects(() => compareWorkspace(ctx.trusted, ctx.order, ctx.hash, ctx.work), 'paket-git-ordner');
  }
});

test('Vergleich: harter Link wird abgelehnt', () => {
  const ctx = edited();
  const outside = join(newDir('h'));
  writeFileSync(outside, RECHNE_NEU);
  unlinkSync(join(ctx.work, 'src', 'rechne.js'));
  linkSync(outside, join(ctx.work, 'src', 'rechne.js'));
  rejects(() => compareWorkspace(ctx.trusted, ctx.order, ctx.hash, ctx.work), 'paket-hardlink');
});

test('Vergleich: Symlink im Arbeitsordner (nur wo Symlinks erlaubt sind)', t => {
  const ctx = edited();
  unlinkSync(join(ctx.work, 'README.md'));

  if (!trySymlink(t, join(ctx.trusted, 'README.md'), join(ctx.work, 'README.md'), 'file')) {
    return;
  }

  rejects(() => compareWorkspace(ctx.trusted, ctx.order, ctx.hash, ctx.work), 'paket-symlink');
  // Auch eine freigegebene Datei als Symlink auf eine geaenderte Datei ausserhalb.
  const other = edited();
  const outside = newDir('s');
  writeFileSync(outside, RECHNE_NEU);
  unlinkSync(join(other.work, 'src', 'rechne.js'));
  symlinkSync(outside, join(other.work, 'src', 'rechne.js'), 'file');
  rejects(() => compareWorkspace(other.trusted, other.order, other.hash, other.work), 'paket-symlink');
});

test('Vergleich: Inhaltsregeln fuer freigegebene Dateien', () => {
  const cases = [
    ['', 'paket-datei-leer'],
    ['a\0b\n', 'paket-nul'],
    [Buffer.from([0x61, 0xff, 0x0a]), 'paket-utf8'],
    [`const t = 'ghp_${'A'.repeat(36)}';\n`, 'paket-geheimnis'],
    ['x'.repeat(MAX_FILE_BYTES + 1), 'paket-datei-groesse'],
  ];

  for (const [content, code] of cases) {
    const ctx = edited({ ...GOOD, 'src/rechne.js': content });
    rejects(() => compareWorkspace(ctx.trusted, ctx.order, ctx.hash, ctx.work), code);
  }
});

test('Vergleich: veraenderter vertrauenswuerdiger Checkout und Ueberschneidung', () => {
  const trusted = checkout();
  const ctx = edited(GOOD, { trusted });
  writeFileSync(join(trusted, 'src', 'rechne.js'), RECHNE_NEU);
  rejects(() => compareWorkspace(trusted, ctx.order, ctx.hash, ctx.work), 'paket-quelle');
  rejects(() => compareWorkspace(ctx.work, ctx.order, ctx.hash, ctx.work), 'paket-ueberschneidung');
  rejects(() => compareWorkspace(ctx.trusted, ctx.order, ctx.hash, join(ctx.work, 'fehlt')), 'paket-pfad');
  rejects(() => compareWorkspace(ctx.trusted, JSON.parse(JSON.stringify(ctx.order)), ctx.hash, ctx.work), 'auftrag-ungeprueft');
});

// ---------------------------------------------------------------------------
// Git-Verbot nach Claude: core.fsmonitor als Angriffsprobe
// ---------------------------------------------------------------------------

test('Git-Verbot: Vergleich und Paketbau loesen keinen Git-Hook im Arbeitsbereich aus', t => {
  // Ein kuenstliches Repository umschliesst den Arbeitsordner. Jeder Git-Aufruf mit cwd im
  // Arbeitsordner findet es und fuehrt core.fsmonitor aus.
  const outer = newDir('fsm');
  mkdirSync(outer);
  gitIn(outer, ['init', '-q']);
  writeFileSync(join(outer, 'datei.txt'), 'x\n');
  gitIn(outer, ['add', 'datei.txt']);
  gitIn(outer, ['commit', '-q', '-m', 'probe']);
  const marker = join(BASE_DIR, `fsmonitor-marker-${dirNo}`);
  const hook = join(BASE_DIR, `fsmonitor-hook-${dirNo}.sh`);
  writeFileSync(hook, `#!/bin/sh\necho treffer > '${marker.split('\\').join('/')}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  gitIn(outer, ['config', 'core.fsmonitor', hook.split('\\').join('/')]);

  const order = realOrder();
  const hash = orderSha256(order);
  const work = prepareWorkspace(TRUSTED, order, hash, join(outer, 'arbeit'), opts()).arbeitsordner;
  write(work, GOOD);

  // Muss-Treffer: ein Git-Befehl im Arbeitsordner erzeugt den Marker.
  let gitOutput = '';

  try {
    execFileSync('git', ['status'], { cwd: work, env: ENV, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    // Der Hook endet mit Exitcode 1; entscheidend ist nur der Marker.
    gitOutput = String(error?.stderr ?? '').split('\n')[0];
  }

  if (!existsSync(marker)) {
    // Ausnahme nur unter Windows und im schreibgeschuetzten Container des Trockenlaufs (Repository
    // nicht beschreibbar). Im normalen Ubuntu-Testjob muss die Gegenprobe treffen.
    let repoWritable = true;

    try {
      accessSync(ROOT, fsConstants.W_OK);
    } catch {
      repoWritable = false;
    }

    if (IS_WINDOWS || !repoWritable) {
      t.skip(`core.fsmonitor-Hook wird hier nicht ausgefuehrt (${IS_WINDOWS ? 'Windows' : 'schreibgeschuetzter Container'}; git: ${gitOutput || 'keine Meldung'}). Pflichtlauf im Ubuntu-Testjob`);
      return;
    }

    assert.fail(`Gegenprobe: der Hook hat keinen Marker erzeugt (git: ${gitOutput || 'keine Meldung'})`);
  }

  unlinkSync(marker);
  assert.equal(compareWorkspace(TRUSTED, order, hash, work).dateien.length, 2);
  const created = createPackageV2(TRUSTED, order, hash, work);
  assert.ok(created.bytes > 0);
  assert.ok(!existsSync(marker), 'Vergleich oder Paketbau hat Git im Arbeitsbereich ausgefuehrt');
});

// ---------------------------------------------------------------------------
// createPackageV2 und parsePackageV2
// ---------------------------------------------------------------------------

test('Paket: kanonisches Format mit genau den vorgesehenen Feldern', () => {
  const { order, hash, created, bytes } = packaged();
  assert.equal(created.sha256, sha256(bytes));
  assert.equal(created.bytes, bytes.length);
  const data = JSON.parse(created.text);
  assert.equal(created.text, canon(data).toString('utf8'));
  assert.deepEqual(Object.keys(data), ['schema', 'auftrag_sha256', 'repository', 'issue', 'profil_id', 'profil_sha256', 'issue_sha256', 'abnahme_sha256', 'base_sha', 'dateien']);
  assert.equal(data.schema, PACKAGE_SCHEMA);
  assert.equal(data.auftrag_sha256, hash);
  assert.equal(data.issue, ISSUE);
  assert.equal(data.base_sha, BASE);
  assert.ok(!('paket_sha256' in data));
  assert.deepEqual(data.dateien, [entryFor(order, 'src/rechne.js', RECHNE_NEU), entryFor(order, 'test/rechne.test.js', TEST_NEU)]);
  assert.ok(Object.isFrozen(created));
});

test('Paket: Pruefung bindet das Ergebnis, Bytes nur als Kopie', () => {
  const { order, hash, created, bytes } = packaged();
  const parsed = parsePackageV2(order, hash, bytes, created.sha256);
  assert.equal(parsed.paket_sha256, created.sha256);
  assert.equal(parsed.auftrag_sha256, hash);
  assert.deepEqual(parsed.dateien.map(file => Object.keys(file)), [
    ['pfad', 'basis_blob', 'git_blob', 'sha256', 'bytes'],
    ['pfad', 'basis_blob', 'git_blob', 'sha256', 'bytes'],
  ]);
  // Keine Buffer im Ergebnis, alles eingefroren.
  const visit = value => {
    assert.ok(!Buffer.isBuffer(value) && !(value instanceof Uint8Array));
    if (value !== null && typeof value === 'object') {
      assert.ok(Object.isFrozen(value));
      Object.values(value).forEach(visit);
    }
  };
  visit(parsed);
  assert.throws(() => { parsed.dateien[0].git_blob = 'f'.repeat(40); }, TypeError);
  assert.throws(() => { parsed.dateien.push({}); }, TypeError);

  const copy = packageFileBytes(parsed, 'src/rechne.js');
  assert.ok(copy.equals(Buffer.from(RECHNE_NEU)));
  // Die Kopie hat eigenen Speicher und wirkt nicht zurueck.
  copy.fill(0x41);
  assert.ok(packageFileBytes(parsed, 'src/rechne.js').equals(Buffer.from(RECHNE_NEU)));
  assert.notEqual(packageFileBytes(parsed, 'src/rechne.js').buffer, packageFileBytes(parsed, 'src/rechne.js').buffer);
  rejects(() => packageFileBytes(parsed, 'README.md'), 'paket-eingabe');
  rejects(() => packageFileBytes({ ...parsed }, 'src/rechne.js'), 'paket-ungeprueft');
  // Die Eingabebytes koennen nach der Pruefung veraendert werden, ohne Wirkung.
  bytes.fill(0x20);
  assert.ok(packageFileBytes(parsed, 'test/rechne.test.js').equals(Buffer.from(TEST_NEU)));
});

test('Paket: nachgebauter oder gefaelschter Auftrag und falscher Auftragshash', () => {
  const { order, hash, created, bytes } = packaged();
  rejects(() => parsePackageV2(JSON.parse(JSON.stringify(order)), hash, bytes, created.sha256), 'auftrag-ungeprueft');
  rejects(() => parsePackageV2(order, 'e'.repeat(64), bytes, created.sha256), 'auftrag-abweichung');
  rejects(() => parsePackageV2(order, hash, bytes, 'nicht-hex'), 'paket-hash-format');
  rejects(() => parsePackageV2(order, hash, bytes, created.sha256.toUpperCase()), 'paket-hash-format');
  rejects(() => parsePackageV2(order, hash, created.text, created.sha256), 'paket-eingabe');
  rejects(() => parsePackageV2(order, hash, new Uint8Array(bytes), created.sha256), 'paket-eingabe');
  rejects(() => parsePackageV2(order, hash, new Proxy(bytes, {}), created.sha256), 'paket-eingabe');
  rejects(() => parsePackageV2(order, hash, Object.create(Buffer.prototype), created.sha256), 'paket-eingabe');
});

test('Paket: externer Paket-Hash bindet die vollstaendigen Bytes', () => {
  const ctx = packaged();
  const data = JSON.parse(ctx.created.text);
  // Inhalt geaendert, interne Hashes passend nachgerechnet, externer Hash vom Original.
  data.dateien[0] = entryFor(ctx.order, 'src/rechne.js', `${RECHNE_NEU}// anders\n`);
  const { bytes, hash } = rebuilt(data);
  rejects(() => parsePackageV2(ctx.order, ctx.hash, bytes, ctx.created.sha256), 'paket-hash');
  // Mit dem eigenen Hash waere dasselbe Paket gueltig: der externe Hash ist die Bindung.
  assert.ok(parsePackageV2(ctx.order, ctx.hash, bytes, hash));
  // Ein Byte mehr am Ende.
  rejects(() => parsePackageV2(ctx.order, ctx.hash, Buffer.concat([ctx.bytes, Buffer.from('\n')]), ctx.created.sha256), 'paket-hash');
});

test('Paket: nicht kanonisches JSON und andere Feldreihenfolge', () => {
  const ctx = packaged();
  const data = JSON.parse(ctx.created.text);
  const compact = Buffer.from(JSON.stringify(data));
  rejects(() => parsePackageV2(ctx.order, ctx.hash, compact, sha256(compact)), 'json-kanonisch');
  const crlf = Buffer.from(ctx.created.text.replaceAll('\n', '\r\n'));
  rejects(() => parsePackageV2(ctx.order, ctx.hash, crlf, sha256(crlf)), 'json-zeilenende');
  const { schema, ...rest } = data;
  parseRejects(ctx, { ...rest, schema }, 'paket-felder');
  const entry = data.dateien[0];
  const { pfad, ...entryRest } = entry;
  parseRejects(ctx, { ...data, dateien: [{ ...entryRest, pfad }, data.dateien[1]] }, 'paket-felder');
  rejects(() => parsePackageV2(ctx.order, ctx.hash, Buffer.from('[]\n'), sha256('[]\n')), 'json-objekt');
  rejects(() => parsePackageV2(ctx.order, ctx.hash, Buffer.alloc(0), sha256('')), 'json-leer');
});

test('Paket: fremde Metadaten, Schema und Bindungsfelder', () => {
  const ctx = packaged();
  const data = JSON.parse(ctx.created.text);
  parseRejects(ctx, { ...data, extra: 1 }, 'paket-felder');
  const missing = { ...data };
  delete missing.abnahme_sha256;
  parseRejects(ctx, missing, 'paket-felder');
  parseRejects(ctx, { ...data, schema: 'agent-code-pilot-v1' }, 'paket-schema');
  parseRejects(ctx, { ...data, auftrag_sha256: 'a'.repeat(64) }, 'paket-bindung');

  const changes = {
    repository: 'noah04091/anderes',
    issue: ISSUE + 1,
    profil_id: 'js-text',
    profil_sha256: 'b'.repeat(64),
    issue_sha256: 'c'.repeat(64),
    abnahme_sha256: 'd'.repeat(64),
    base_sha: OTHER,
  };

  for (const [key, value] of Object.entries(changes)) {
    parseRejects(ctx, { ...data, [key]: value }, 'paket-bindung');
  }

  parseRejects(ctx, { ...data, issue: String(ISSUE) }, 'paket-bindung');
});

test('Paket: Dateiliste muss genau order.dateien entsprechen', () => {
  const ctx = packaged();
  const data = JSON.parse(ctx.created.text);
  const [a, b] = data.dateien;
  parseRejects(ctx, { ...data, dateien: [a] }, 'paket-dateiliste');
  parseRejects(ctx, { ...data, dateien: [b, a] }, 'paket-dateiliste');
  parseRejects(ctx, { ...data, dateien: [a, a] }, 'paket-dateiliste');
  parseRejects(ctx, { ...data, dateien: [a, b, b] }, 'paket-dateiliste');
  parseRejects(ctx, { ...data, dateien: [] }, 'paket-dateiliste');
  parseRejects(ctx, { ...data, dateien: {} }, 'paket-dateiliste');
  parseRejects(ctx, { ...data, dateien: [a, { ...entryFor(ctx.order, 'test/rechne.test.js', TEST_NEU), pfad: 'README.md' }] }, 'paket-dateiliste');
  parseRejects(ctx, { ...data, dateien: [a, { ...b, pfad: 'test/../README.md' }] }, 'paket-dateiliste');
  parseRejects(ctx, { ...data, dateien: [a, 'x'] }, 'paket-felder');
});

test('Paket: Basis-Blob, Base64, Bytezahl, Hashes und Typen', () => {
  const ctx = packaged();
  const data = JSON.parse(ctx.created.text);
  const [a, b] = data.dateien;
  const withA = changes => ({ ...data, dateien: [{ ...a, ...changes }, b] });

  parseRejects(ctx, withA({ basis_blob: b.basis_blob }), 'paket-basis-blob');
  parseRejects(ctx, withA({ basis_blob: a.git_blob }), 'paket-basis-blob');
  // Nicht kanonisches Base64: ohne Polsterung, mit Zeilenumbruch, URL-Alphabet, Fremdzeichen.
  for (const base64 of [a.base64.replace(/=+$/, ''), `${a.base64.slice(0, 8)}\n${a.base64.slice(8)}`, a.base64.replaceAll('+', '-').replaceAll('/', '_') + '-', `${a.base64}!`, ` ${a.base64}`]) {
    parseRejects(ctx, withA({ base64 }), 'paket-base64');
  }

  parseRejects(ctx, withA({ bytes: a.bytes + 1 }), 'paket-bytes');
  parseRejects(ctx, withA({ sha256: 'a'.repeat(64) }), 'paket-sha256');
  parseRejects(ctx, withA({ git_blob: 'a'.repeat(40) }), 'paket-git-blob');
  parseRejects(ctx, withA({ git_blob: a.git_blob.toUpperCase() }), 'paket-format');
  parseRejects(ctx, withA({ sha256: 5 }), 'paket-format');
  parseRejects(ctx, withA({ bytes: '61' }), 'paket-format');
  parseRejects(ctx, withA({ bytes: 1.5 }), 'paket-format');
  parseRejects(ctx, withA({ base64: null }), 'paket-format');
  parseRejects(ctx, withA({ bytes: 0, base64: '' }), 'paket-datei-leer');
});

test('Paket: Inhaltsregeln auch bei passenden Hashes', () => {
  const ctx = packaged();
  const data = JSON.parse(ctx.created.text);
  const b = data.dateien[1];
  const cases = [
    [RECHNE_BASE, 'paket-unveraendert'],
    ['a\0b\n', 'paket-nul'],
    [Buffer.from([0x61, 0xc3, 0x28]), 'paket-utf8'],
    [`k = "sk-ant-api03-${'Q'.repeat(30)}"\n`, 'paket-geheimnis'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMII\n', 'paket-geheimnis'],
    ['y'.repeat(MAX_FILE_BYTES + 1), 'paket-datei-groesse'],
  ];

  for (const [content, code] of cases) {
    parseRejects(ctx, { ...data, dateien: [entryFor(ctx.order, 'src/rechne.js', content), b] }, code);
  }
});

test('Paket: ungepruefte Eingaben in requireAllChanged', () => {
  const ctx = packaged();
  const parsed = parsePackageV2(ctx.order, ctx.hash, ctx.bytes, ctx.created.sha256);
  assert.equal(requireAllChanged(ctx.order, parsed.dateien), true);
  rejects(() => requireAllChanged(JSON.parse(JSON.stringify(ctx.order)), parsed.dateien), 'auftrag-ungeprueft');
  rejects(() => requireAllChanged(ctx.order, parsed.dateien.slice(0, 1)), 'paket-dateiliste');
  rejects(() => requireAllChanged(ctx.order, [...parsed.dateien].reverse()), 'paket-dateiliste');
  rejects(() => requireAllChanged(ctx.order, [parsed.dateien[0], { ...parsed.dateien[1], git_blob: ctx.order.basis_blobs['test/rechne.test.js'] }]), 'paket-unveraendert');
  rejects(() => requireAllChanged(ctx.order, [parsed.dateien[0], { pfad: 'test/rechne.test.js' }]), 'paket-format');
  rejects(() => requireAllChanged(ctx.order, new Proxy([...parsed.dateien], {})), 'paket-dateiliste');
  rejects(() => requireAllChanged(ctx.order, 'x'), 'paket-dateiliste');
});

// ---------------------------------------------------------------------------
// applyPackageV2
// ---------------------------------------------------------------------------

function applyCtx(files = GOOD, options) {
  const ctx = packaged(files, options);
  const parsed = parsePackageV2(ctx.order, ctx.hash, ctx.bytes, ctx.created.sha256);
  return { ...ctx, parsed, target: checkout() };
}

test('Anwenden: frischer Pruef-Checkout erhaelt genau die geprueften Bytes', () => {
  const ctx = applyCtx();
  const result = applyPackageV2(ctx.target, ctx.order, ctx.hash, ctx.parsed, opts());
  assert.deepEqual([...result.dateien], ['src/rechne.js', 'test/rechne.test.js']);
  assert.equal(result.geaenderte_zeilen, RECHNE_NEU.split('\n').length - RECHNE_BASE.split('\n').length + TEST_NEU.split('\n').length - TEST_BASE.split('\n').length);
  assert.ok(result.patch_bytes > 0 && result.patch_bytes <= MAX_PATCH_BYTES);
  assert.equal(readFileSync(join(ctx.target, 'src', 'rechne.js'), 'utf8'), RECHNE_NEU);
  assert.equal(readFileSync(join(ctx.target, 'test', 'rechne.test.js'), 'utf8'), TEST_NEU);
  assert.equal(gitIn(ctx.target, ['status', '--porcelain']), 'M src/rechne.js\n M test/rechne.test.js');
  assert.ok(Object.isFrozen(result));
});

test('Anwenden: nur ein gepruefter Paketwert, gebunden an denselben Auftrag', () => {
  const ctx = applyCtx();
  rejects(() => applyPackageV2(ctx.target, ctx.order, ctx.hash, JSON.parse(JSON.stringify(ctx.parsed)), opts()), 'paket-ungeprueft');
  rejects(() => applyPackageV2(ctx.target, ctx.order, ctx.hash, { ...ctx.parsed }, opts()), 'paket-ungeprueft');
  // Ein zweiter echter Auftrag mit demselben Hash ist ein anderes Objekt.
  const second = realOrder();
  assert.equal(orderSha256(second), ctx.hash);
  rejects(() => applyPackageV2(ctx.target, second, ctx.hash, ctx.parsed, opts()), 'paket-bindung');
  rejects(() => applyPackageV2(ctx.target, JSON.parse(JSON.stringify(ctx.order)), ctx.hash, ctx.parsed, opts()), 'auftrag-ungeprueft');
  rejects(() => applyPackageV2(ctx.target, ctx.order, ctx.hash, ctx.parsed, {}), 'paket-eingabe');
  // Nichts wurde geschrieben.
  assert.equal(gitIn(ctx.target, ['status', '--porcelain']), '');
});

test('Anwenden: nie im Arbeitsordner, nur in einem sauberen Checkout auf dem Ausgangscommit', () => {
  const ctx = applyCtx();
  rejects(() => applyPackageV2(ctx.work, ctx.order, ctx.hash, ctx.parsed, opts()), 'auftrag-git-wurzel');

  const dirty = checkout();
  writeFileSync(join(dirty, 'README.md'), '# fremd\n');
  rejects(() => applyPackageV2(dirty, ctx.order, ctx.hash, ctx.parsed, opts()), 'paket-status');
  assert.equal(readFileSync(join(dirty, 'src', 'rechne.js'), 'utf8'), RECHNE_BASE);

  rejects(() => applyPackageV2(checkout(OTHER), ctx.order, ctx.hash, ctx.parsed, opts()), 'paket-head');

  const extraDir = checkout();
  mkdirSync(join(extraDir, 'leer'));
  rejects(() => applyPackageV2(extraDir, ctx.order, ctx.hash, ctx.parsed, opts()), 'paket-pruef-checkout');
});

test('Anwenden: Zieldatei als Symlink oder mit hartem Link', t => {
  const ctx = applyCtx();
  const hard = checkout();
  linkSync(join(hard, 'src', 'rechne.js'), newDir('hl'));
  rejects(() => applyPackageV2(hard, ctx.order, ctx.hash, ctx.parsed, opts()), 'paket-hardlink');
  assert.equal(readFileSync(join(hard, 'src', 'rechne.js'), 'utf8'), RECHNE_BASE);

  const sym = checkout();
  unlinkSync(join(sym, 'src', 'rechne.js'));

  if (!trySymlink(t, join(TRUSTED, 'src', 'rechne.js'), join(sym, 'src', 'rechne.js'), 'file')) {
    return;
  }

  // Git meldet den Typwechsel als Aenderung, noch bevor das Dateisystem geprueft wird.
  rejects(() => applyPackageV2(sym, ctx.order, ctx.hash, ctx.parsed, opts()), 'paket-status');
  assert.equal(readFileSync(join(TRUSTED, 'src', 'rechne.js'), 'utf8'), RECHNE_BASE);
});

test('Anwenden: Schreibfehler fuehrt zu keinem Ergebnis', () => {
  const ctx = applyCtx();
  const file = join(ctx.target, 'test', 'rechne.test.js');
  chmodSync(file, 0o444);

  try {
    rejects(() => applyPackageV2(ctx.target, ctx.order, ctx.hash, ctx.parsed, opts()), 'paket-schreiben');
  } finally {
    chmodSync(file, 0o644);
  }
});

test('Anwenden: Leerzeichenfehler im Diff werden abgelehnt', () => {
  const ctx = applyCtx({ ...GOOD, 'src/rechne.js': `${RECHNE_BASE}export const x = 1;   \n` });
  rejects(() => applyPackageV2(ctx.target, ctx.order, ctx.hash, ctx.parsed, opts()), 'paket-diff-check');
});

test('Anwenden: gepruefte Bytes sind gegen Schreiben in den Speicherpool geschuetzt', () => {
  const ctx = applyCtx();
  // Ein Angreifer im selben Prozess schreibt ueber einen eigenen kleinen Buffer in den gemeinsamen
  // Speicherpool von Node.js und ersetzt jede Kopie der Dateiinhalte, die er dort findet.
  const slab = new Uint8Array(Buffer.from('x').buffer);
  let hits = 0;

  for (const content of [RECHNE_NEU, TEST_NEU]) {
    const needle = Buffer.from(content);

    for (let at = slab.indexOf(needle[0]); at !== -1; at = slab.indexOf(needle[0], at + 1)) {
      if (Buffer.from(slab.subarray(at, at + needle.length)).equals(needle)) {
        slab.fill(0x5a, at, at + needle.length);
        hits += 1;
      }
    }
  }

  // Muss-Treffer: im Pool liegen tatsaechlich Kopien (etwa die dekodierten Base64-Inhalte).
  assert.ok(hits >= 1, 'Gegenprobe: keine Kopie im Speicherpool gefunden');
  applyPackageV2(ctx.target, ctx.order, ctx.hash, ctx.parsed, opts());
  assert.equal(readFileSync(join(ctx.target, 'src', 'rechne.js'), 'utf8'), RECHNE_NEU);
  assert.equal(readFileSync(join(ctx.target, 'test', 'rechne.test.js'), 'utf8'), TEST_NEU);
});

// ---------------------------------------------------------------------------
// Grenzen
// ---------------------------------------------------------------------------

test('Grenzwerte: die A5-Grenzen gelten unveraendert', () => {
  assert.equal(MAX_FILE_BYTES, 20_000);
  assert.equal(MAX_PACKAGE_BYTES, 60_000);
  assert.equal(MAX_CHANGED_LINES, 200);
  assert.equal(MAX_PATCH_BYTES, 24_000);
  assert.equal(MIN_SECRET_LENGTH, 20);
  // Dieselben Werte wie in den A5-Skripten.
  const check = readFileSync(join(ROOT, 'scripts/agent-code-change-check.mjs'), 'utf8');
  const pack = readFileSync(join(ROOT, 'scripts/agent-code-package.mjs'), 'utf8');
  for (const line of ['const MAX_FILE_BYTES = 20_000;', 'const MAX_CHANGED_LINES = 200;', 'const MAX_PATCH_BYTES = 24_000;']) {
    assert.ok(check.includes(line), line);
  }
  assert.ok(pack.includes('const MAX_PACKAGE = 60_000;') && pack.includes('const MAX_BYTES = 20_000;'));
});

const lines = (count, prefix) => Array.from({ length: count }, (_, i) => `// ${prefix} ${i}\n`).join('');

test('Grenze: 20 000 Bytes je Datei, 20 001 abgelehnt', () => {
  const exact = `${RECHNE_BASE}//${'x'.repeat(MAX_FILE_BYTES - RECHNE_BASE.length - 3)}\n`;
  assert.equal(Buffer.byteLength(exact), MAX_FILE_BYTES);
  const ok = packaged({ ...GOOD, 'src/rechne.js': exact });
  assert.equal(JSON.parse(ok.created.text).dateien[0].bytes, MAX_FILE_BYTES);
  const over = edited({ ...GOOD, 'src/rechne.js': `${exact}x` });
  rejects(() => createPackageV2(over.trusted, over.order, over.hash, over.work), 'paket-datei-groesse');
  const data = JSON.parse(ok.created.text);
  parseRejects(ok, { ...data, dateien: [entryFor(ok.order, 'src/rechne.js', `${exact}x`), data.dateien[1]] }, 'paket-datei-groesse');
  // Mehrbyte-Zeichen zaehlen nach Bytes.
  const umlauts = edited({ ...GOOD, 'src/rechne.js': `// ${'ä'.repeat(MAX_FILE_BYTES / 2)}\n` });
  rejects(() => createPackageV2(umlauts.trusted, umlauts.order, umlauts.hash, umlauts.work), 'paket-datei-groesse');
});

test('Grenze: 200 geaenderte Zeilen, 201 abgelehnt', () => {
  const at = applyCtx({ 'src/rechne.js': RECHNE_BASE + lines(100, 'a'), 'test/rechne.test.js': TEST_BASE + lines(100, 'b') });
  assert.equal(applyPackageV2(at.target, at.order, at.hash, at.parsed, opts()).geaenderte_zeilen, MAX_CHANGED_LINES);
  const over = applyCtx({ 'src/rechne.js': RECHNE_BASE + lines(101, 'a'), 'test/rechne.test.js': TEST_BASE + lines(100, 'b') });
  rejects(() => applyPackageV2(over.target, over.order, over.hash, over.parsed, opts()), 'paket-zeilen');
  // Geloeschte Zeilen zaehlen mit: 199 neue und eine geloeschte.
  const mixed = applyCtx({ 'src/rechne.js': lines(100, 'a'), 'test/rechne.test.js': TEST_BASE + lines(100, 'b') });
  rejects(() => applyPackageV2(mixed.target, mixed.order, mixed.hash, mixed.parsed, opts()), 'paket-zeilen');
});

// Misst die Patchgroesse eines Inhalts in einem eigenen Wegwerf-Checkout mit denselben Objekten.
function patchSize(files) {
  const dir = checkout();
  write(dir, files);
  return execFileSync('git', ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--', 'src/rechne.js', 'test/rechne.test.js'], { cwd: dir, env: ENV }).length;
}

function patchFiles(fill) {
  return {
    'src/rechne.js': `${RECHNE_BASE}// ${'p'.repeat(fill)}\n`,
    'test/rechne.test.js': `${TEST_BASE}// ${'q'.repeat(12_000)}\n`,
  };
}

test('Grenze: 24 000 Bytes Git-Patch, 24 001 abgelehnt', () => {
  const probe = 10_000;
  const fill = probe + MAX_PATCH_BYTES - patchSize(patchFiles(probe));
  assert.equal(patchSize(patchFiles(fill)), MAX_PATCH_BYTES);
  const at = applyCtx(patchFiles(fill));
  assert.equal(applyPackageV2(at.target, at.order, at.hash, at.parsed, opts()).patch_bytes, MAX_PATCH_BYTES);
  const over = applyCtx(patchFiles(fill + 1));
  rejects(() => applyPackageV2(over.target, over.order, over.hash, over.parsed, opts()), 'paket-patch');
});

// Paketgroesse fuer Dateien der Laengen sizes, ohne den Inhalt: Hashes haben feste Laengen.
function predictedSize(order, sizes) {
  const data = {
    schema: PACKAGE_SCHEMA,
    auftrag_sha256: 'a'.repeat(64),
    repository: order.repository,
    issue: order.issue,
    profil_id: order.profil_id,
    profil_sha256: order.profil_sha256,
    issue_sha256: order.issue_sha256,
    abnahme_sha256: order.abnahme_sha256,
    base_sha: order.base_sha,
    dateien: order.dateien.map((pfad, i) => ({
      pfad, basis_blob: 'b'.repeat(40), git_blob: 'c'.repeat(40), sha256: 'd'.repeat(64), bytes: sizes[i], base64: 'e'.repeat(4 * Math.ceil(sizes[i] / 3)),
    })),
  };
  return canon(data).length;
}

// Sucht Dateigroessen bis 20 000 Bytes, fuer die das Paket genau target Bytes hat.
function sizesFor(order, target) {
  for (const first of [MAX_FILE_BYTES, 19_999, 9_999]) {
    for (const second of [MAX_FILE_BYTES, 9_999]) {
      for (let third = 1; third <= MAX_FILE_BYTES; third += 1) {
        if (predictedSize(order, [first, second, third]) === target) {
          return [first, second, third];
        }
      }
    }
  }

  return null;
}

const dreiContent = size => `/*${'z'.repeat(size - 5)}*/\n`;
const dreiFiles = (order, sizes) => Object.fromEntries(order.dateien.map((pfad, i) => [pfad, dreiContent(sizes[i])]));

test('Grenze: 60 000 Bytes Gesamtpaket, 60 001 abgelehnt', () => {
  const order = realOrder({ profile: 'js-drei' });
  const exact = sizesFor(order, MAX_PACKAGE_BYTES);
  assert.ok(exact, 'Gegenprobe: 60 000 Bytes nicht erreichbar');
  // Mit diesen Pfaden sind 60 001 bis 60 003 nicht erreichbar, der naechste Wert ist 60 004.
  assert.deepEqual([1, 2, 3].map(extra => sizesFor(order, MAX_PACKAGE_BYTES + extra)), [null, null, null]);
  const next = sizesFor(order, MAX_PACKAGE_BYTES + 4);

  const ok = packaged(dreiFiles(order, exact), { profile: 'js-drei' });
  assert.equal(ok.created.bytes, MAX_PACKAGE_BYTES);
  assert.ok(parsePackageV2(ok.order, ok.hash, ok.bytes, ok.created.sha256));
  // Mehrere Dateien nahe 20 000 Bytes passen einzeln, das Paket aber nicht: keine Grenzerhoehung.
  const big = edited(dreiFiles(order, next), { profile: 'js-drei' });
  rejects(() => createPackageV2(big.trusted, big.order, big.hash, big.work), 'paket-groesse');

  // Genau 60 001 Bytes mit dem zweiten Profil, beim Bau und als fertiges Paket mit gueltigen Hashes.
  const orderX = realOrder({ profile: 'js-dreix' });
  const over = sizesFor(orderX, MAX_PACKAGE_BYTES + 1);
  assert.ok(over, 'Gegenprobe: 60 001 Bytes nicht erreichbar');
  const bigX = edited(dreiFiles(orderX, over), { profile: 'js-dreix' });
  rejects(() => createPackageV2(bigX.trusted, bigX.order, bigX.hash, bigX.work), 'paket-groesse');
  const smaller = over.map((size, i) => (i === 2 ? size - 3 : size));
  const okX = packaged(dreiFiles(orderX, smaller), { profile: 'js-dreix' });
  assert.ok(okX.created.bytes <= MAX_PACKAGE_BYTES);
  const data = JSON.parse(okX.created.text);
  const tooBig = { ...data, dateien: orderX.dateien.map((pfad, i) => entryFor(okX.order, pfad, dreiContent(over[i]))) };
  assert.equal(canon(tooBig).length, MAX_PACKAGE_BYTES + 1);
  parseRejects(okX, tooBig, 'paket-groesse');
});

// ---------------------------------------------------------------------------
// Geheimnisse
// ---------------------------------------------------------------------------

const ARTIFICIAL = Object.freeze({
  'anthropic-schluessel': `sk-ant-api03-${'K'.repeat(40)}`,
  'github-token': `ghs_${'T'.repeat(36)}`,
  'github-pat': `github_pat_${'P'.repeat(30)}`,
  'privater-schluessel': '-----BEGIN OPENSSH PRIVATE KEY-----',
  'aws-zugangsschluessel': `AKIA${'A1B2C3D4E5F6G7H8'}`,
  'zugangstoken-url': `https://x-access-token:${'v'.repeat(20)}@github.com/x/y`,
});

test('Geheimnismuster: jedes Pflichtmuster wird erkannt, Erwaehnungen nicht', () => {
  for (const [kind, value] of Object.entries(ARTIFICIAL)) {
    const result = scanForSecrets(Buffer.from(`vorher ${value} nachher\n`));
    assert.deepEqual([...result.arten], [kind], kind);
    assert.equal(result.fund, true);
    assert.ok(!JSON.stringify(result).includes(value.slice(4, 14)));
  }

  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghr_']) {
    assert.deepEqual([...scanForSecrets(Buffer.from(`${prefix}${'a1'.repeat(18)}`)).arten], ['github-token']);
  }

  assert.deepEqual([...scanForSecrets(Buffer.from('-----BEGIN PRIVATE KEY-----')).arten], ['privater-schluessel']);
  assert.deepEqual([...scanForSecrets(Buffer.from('-----BEGIN EC PRIVATE KEY-----')).arten], ['privater-schluessel']);
  assert.deepEqual([...scanForSecrets(Buffer.from('-----BEGIN PGP PRIVATE KEY BLOCK-----')).arten], ['privater-schluessel']);
  assert.deepEqual([...scanForSecrets(Buffer.from('ASIAZZZZ9999YYYY8888')).arten], ['aws-zugangsschluessel']);
  assert.deepEqual([...scanForSecrets(Buffer.from('X-ACCESS-TOKEN:abcdefgh12')).arten], ['zugangstoken-url']);

  for (const harmless of [
    'Token beginnen mit ghp_ oder ghs_.',
    'sk-ant- ist das Praefix.',
    'AKIA123',
    'AKIAabcdefghijklmnop',
    '-----BEGIN PUBLIC KEY-----',
    'x-access-token: wird nie geloggt',
    'github_pat_kurz',
    RECHNE_NEU,
  ]) {
    const result = scanForSecrets(Buffer.from(harmless));
    assert.equal(result.fund, false, harmless);
    assert.deepEqual([...result.arten], []);
  }

  assert.ok(Object.isFrozen(scanForSecrets(Buffer.from('x'))));
  rejects(() => scanForSecrets('text'), 'geheimnis-eingabe');
  // Ein Objekt mit dem Prototyp von Buffer, aber ohne Speicher: Ablehnung mit Code, kein TypeError.
  rejects(() => scanForSecrets(Object.create(Buffer.prototype)), 'geheimnis-eingabe');
});

// Kuenstlicher Wert, dessen Base64 die Zeichen + und / enthaelt, damit sich Base64url unterscheidet.
const SECRET = 'geheim>>>???wert>>>???ende~~~';

function embed(position) {
  return Buffer.concat([Buffer.from('p'.repeat(position)), Buffer.from(SECRET), Buffer.from(' und weiter')]);
}

test('Geheimniswerte: Base64 und Base64url an allen drei Byte-Ausrichtungen', () => {
  for (const position of [0, 1, 2, 3, 4, 5]) {
    const standard = embed(position).toString('base64');
    const url = embed(position).toString('base64url');
    assert.ok(/[+/]/.test(standard), 'Gegenprobe: Kodierung enthaelt + oder /');
    assert.notEqual(standard.replace(/=+$/, ''), url);

    const found = containsSecretValue(Buffer.from(`daten=${standard}\n`), [SECRET]);
    assert.ok(found.arten.includes('base64'), `Base64 an Position ${position}`);
    const foundUrl = containsSecretValue(Buffer.from(`daten=${url}\n`), [SECRET]);
    assert.ok(foundUrl.arten.includes('base64url'), `Base64url an Position ${position}`);
    assert.ok(!foundUrl.arten.includes('base64'), `Base64url wird nicht als Base64 erkannt (${position})`);
    // Umbrochenes Base64 (76 Zeichen je Zeile).
    const wrapped = standard.replace(/(.{76})/g, '$1\n');
    assert.ok(containsSecretValue(Buffer.from(wrapped), [SECRET]).arten.includes('base64'));
  }

  // Drei Ausrichtungen ergeben drei verschiedene Kodierungen.
  const cores = [0, 1, 2].map(position => embed(position).toString('base64'));
  assert.equal(new Set(cores.map(text => text.slice(4, 20))).size, 3);
});

test('Geheimniswerte: Klartext, umgedreht, bereinigt, Hex klein und gross', () => {
  const value = 'Abc-Def_Ghi.Jkl:Mno+Pqr/Stu';
  const check = (content, kind, expected = true) => {
    const result = containsSecretValue(Buffer.from(content), [value]);
    assert.equal(result.arten.includes(kind), expected, `${kind}: ${expected}`);
    return result;
  };

  check(`x ${value} y`, 'klartext');
  check(`x ${[...value].reverse().join('')} y`, 'umgedreht');
  check(`x ${value.replace(/[^A-Za-z0-9]/g, ' ')} y`, 'alphanumerisch');
  check(`x ${value.replace(/[^A-Za-z0-9]/g, '')} y`, 'alphanumerisch');
  const hex = Buffer.from(value).toString('hex');
  check(`h=${hex}`, 'hex-klein');
  check(`h=${hex}`, 'hex-gross', false);
  check(`h=${hex.toUpperCase()}`, 'hex-gross');
  check(`h=${hex.toUpperCase()}`, 'hex-klein', false);

  // Gemischte Schreibweise und Trennzeichen.
  const mixed = [...hex].map((char, i) => (i % 2 ? char.toUpperCase() : char)).join('');
  check(`h=${mixed}`, 'hex-getrennt');
  check(`h=${mixed}`, 'hex-klein', false);
  check(hex.replace(/(..)(?!$)/g, '$1:'), 'hex-getrennt');
  check(hex.replace(/(..)/g, '\\x$1'), 'hex-getrennt');
  check(hex.replace(/(..)/g, '0x$1, '), 'hex-getrennt');
  // Base64, durch Verkettung geteilt.
  const b64 = Buffer.from(`ab${value}cd`).toString('base64');
  check(`const s = '${b64.slice(0, 15)}' +\n  '${b64.slice(15)}';`, 'base64-geteilt');
  check(`const s = '${b64.slice(0, 15)}' +\n  '${b64.slice(15)}';`, 'base64', false);

  const none = containsSecretValue(Buffer.from(`${RECHNE_NEU}${value.slice(0, 12)} ${hex.slice(0, 20)}`), [value]);
  assert.equal(none.fund, false);
  assert.deepEqual([...none.arten], []);
  // Mehrere Werte: jeder wird geprueft.
  assert.equal(containsSecretValue(Buffer.from(`x ${SECRET}`), [value, SECRET]).fund, true);
  // Nicht-ASCII-Wert in Klartext und Hex.
  const umlaut = 'Geheimnis-mit-Umlauten-äöü-ß';
  assert.ok(containsSecretValue(Buffer.from(`a${umlaut}b`), [umlaut]).arten.includes('klartext'));
  assert.ok(containsSecretValue(Buffer.from(Buffer.from(umlaut).toString('hex')), [umlaut]).arten.includes('hex-klein'));
});

test('Geheimniswerte: Eingaben, leere Liste, kurze Werte und keine Ausgabe der Werte', () => {
  const content = Buffer.from(`x ${SECRET}`);
  rejects(() => containsSecretValue(content, []), 'geheimnis-werte-leer');
  rejects(() => containsSecretValue(content, undefined), 'geheimnis-eingabe');
  rejects(() => containsSecretValue(content, SECRET), 'geheimnis-eingabe');
  rejects(() => containsSecretValue(content, [5]), 'geheimnis-eingabe');
  rejects(() => containsSecretValue(content, ['a\uD800'.repeat(10)]), 'geheimnis-eingabe');
  rejects(() => containsSecretValue(content, new Proxy([SECRET], {})), 'geheimnis-eingabe');
  rejects(() => containsSecretValue(content, Array(51).fill(SECRET)), 'geheimnis-eingabe');
  rejects(() => containsSecretValue('text', [SECRET]), 'geheimnis-eingabe');
  const short = 'k'.repeat(MIN_SECRET_LENGTH - 1);
  // Ein kurzer Wert wird nicht still uebersprungen, auch nicht neben einem gueltigen.
  for (const values of [[short], [SECRET, short]]) {
    assert.throws(() => containsSecretValue(content, values), error => assertCode(error, 'geheimnis-wert-kurz') && !error.message.includes(short));
  }
  // Zeichen zaehlen, nicht UTF-16-Einheiten: 19 Emoji sind zu kurz.
  rejects(() => containsSecretValue(content, ['😀'.repeat(MIN_SECRET_LENGTH - 1)]), 'geheimnis-wert-kurz');
  assert.equal(containsSecretValue(Buffer.from('x'), ['k'.repeat(MIN_SECRET_LENGTH)]).fund, false);

  const result = containsSecretValue(content, [SECRET]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.arten));
  assert.deepEqual(Object.keys(result), ['fund', 'arten']);
  const text = JSON.stringify(result);

  for (const part of [SECRET.slice(0, 8), Buffer.from(SECRET).toString('base64').slice(0, 8), Buffer.from(SECRET).toString('hex').slice(0, 8)]) {
    assert.ok(!text.includes(part));
  }
});

// ---------------------------------------------------------------------------
// Wachtests auf Quelltext und Workflows
// ---------------------------------------------------------------------------

const MODULES = ['agent-code-auftrag.mjs', 'agent-code-auftrag-live.mjs', 'agent-code-auftrag-prompt.mjs', 'agent-code-auftrag-paket.mjs', 'agent-code-auftrag-publish.mjs', 'agent-code-auftrag-abnahme.mjs'];
const SOURCE = readFileSync(MODULE_PATH, 'utf8');

test('Wache: nur die vorgesehenen Importe, kein Netz-, Prozess-, Umgebungs- oder Protokollzugriff', () => {
  const imports = [...SOURCE.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./agent-code-auftrag.mjs', './agent-profile.mjs', 'node:crypto', 'node:fs', 'node:path', 'node:util']);
  assert.equal([...SOURCE.matchAll(/\bimport\b/g)].length, imports.length);
  // Genau diese Namen, ohne Umbenennung.
  assert.ok(SOURCE.includes("import { OrderError, openRepository, orderSha256, runGit, sameOrder } from './agent-code-auftrag.mjs';"));
  assert.ok(SOURCE.includes("import { parseStrictJson, sha256 } from './agent-profile.mjs';"));
  assert.ok(!/^import[^;]*\bas\b/m.test(SOURCE), 'Umbenennung im Import');
  assert.ok(!/\bexport\b[^;]*\bfrom\b/.test(SOURCE), 'export ... from im Modul');
  for (const forbidden of [/\bprocess\b/, /\bfetch\b/, /\bglobalThis\b/, /\brequire\b/, /\bconsole\b/, /GITHUB_/, /child_process/, /\bexecFile/, /\bspawn/, /\beval\b/, /\bFunction\b/, /\bnode:(net|http|https|dns|worker_threads|vm)\b/]) {
    assert.ok(!forbidden.test(SOURCE), `verbotener Zugriff im Modul: ${forbidden}`);
  }
  // Muss-Treffer der Suche: dieselben Muster finden etwas im Auftragsmodul.
  assert.ok(/child_process/.test(readFileSync(join(ROOT, 'scripts/agent-code-auftrag.mjs'), 'utf8')));
});

test('Wache: der Abschnitt ohne Git ruft weder Git noch Funktionen ausserhalb des Abschnitts auf', () => {
  const start = SOURCE.indexOf('// ABSCHNITT OHNE GIT: Anfang');
  const end = SOURCE.indexOf('// ABSCHNITT OHNE GIT: Ende');
  assert.ok(start > 0 && end > start, 'Abschnittsmarken fehlen');
  assert.equal(SOURCE.split('ABSCHNITT OHNE GIT: Anfang').length, 2);
  assert.equal(SOURCE.split('ABSCHNITT OHNE GIT: Ende').length, 2);
  const section = SOURCE.slice(start, end);
  const outside = SOURCE.slice(0, start) + SOURCE.slice(end);

  // Die Funktionen nach Claude liegen im Abschnitt.
  for (const name of ['compareWorkspace', 'createPackageV2', 'parsePackageV2', 'packageFileBytes', 'requireAllChanged', 'scanForSecrets', 'containsSecretValue', 'compareInternal', 'walk']) {
    assert.ok(new RegExp(`function ${name}\\(`).test(section), `${name} liegt nicht im Abschnitt ohne Git`);
    assert.ok(!new RegExp(`function ${name}\\(`).test(outside), `${name} ist ausserhalb doppelt definiert`);
  }

  // Kein Git, keine Shell im Abschnitt. Muss-Treffer: ausserhalb gibt es runGit und openRepository.
  for (const word of ['runGit', 'openRepository', 'openCheckout', 'checkAfterWrite', 'execFile', 'spawn', 'STATUS_ARGS']) {
    assert.ok(!section.includes(word), `${word} im Abschnitt ohne Git`);
  }
  assert.ok(outside.includes('runGit(') && outside.includes('openRepository('));

  // Jede aufgerufene Funktion ist im Abschnitt definiert oder eine erlaubte eingebaute Funktion.
  // Nur ganze Kommentarzeilen entfernen. Texte und Muster bleiben stehen.
  const code = section.replace(/^\s*\/\/.*$/gm, '');
  const defined = new Set([...code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  for (const m of code.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) {
    defined.add(m[1]);
  }
  const allowed = new Set([
    'sameOrder', 'orderSha256', 'sha256', 'parseStrictJson', 'fail',
    'createHash', 'lstatSync', 'statSync', 'readdirSync', 'readFileSync', 'realpathSync', 'mkdirSync', 'writeFileSync', 'basename', 'dirname', 'isAbsolute', 'join',
    'Object', 'Reflect', 'Buffer', 'Number', 'Math', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Array', 'String', 'TextDecoder', 'Uint8Array',
    'isProxy', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'ownKeys', 'apply', 'freeze', 'isArray', 'isBuffer', 'alloc', 'concat', 'from', 'fromCharCode',
    'isSafeInteger', 'ceil', 'floor', 'native',
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  ]);
  const called = [...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  assert.ok(called.includes('walk') && called.includes('compareInternal'), 'Gegenprobe: Aufrufsuche findet nichts');
  const unknown = [...new Set(called.filter(name => !defined.has(name) && !allowed.has(name)))];
  assert.deepEqual(unknown, [], `unbekannte Aufrufe im Abschnitt ohne Git: ${unknown.join(', ')}`);

  // Zweite, vom Aufrufmuster unabhaengige Pruefung: Jeder Name, der ausserhalb des Abschnitts auf
  // oberster Ebene definiert wird, darf im Abschnitt nicht vorkommen, ausser reinen Datenkonstanten
  // und fail. Das faengt auch Methodenaufrufe, Rueckrufe und Aliasse ab.
  const outsideCode = outside.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/^(?:export\s+)?(?:const|let|var)\s*[{[]/m.test(outsideCode), 'Destrukturierung auf oberster Ebene ausserhalb');
  const outsideNames = new Set([...outsideCode.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
  const dataConstants = new Set([
    'PACKAGE_SCHEMA', 'MAX_FILE_BYTES', 'MAX_PACKAGE_BYTES', 'MAX_CHANGED_LINES', 'MAX_PATCH_BYTES', 'MIN_SECRET_LENGTH',
    'MAX_SECRET_LENGTH', 'MAX_SECRET_VALUES', 'MAX_TREE_ENTRIES', 'MAX_TREE_DEPTH', 'HEX40_RE', 'HEX64_RE', 'PACKAGE_KEYS',
    'BOUND_KEYS', 'FILE_KEYS', 'fail',
  ]);
  for (const name of ['openCheckout', 'checkAfterWrite', 'applyPackageV2', 'prepareWorkspace', 'STATUS_ARGS', 'fail']) {
    assert.ok(outsideNames.has(name), `Gegenprobe: ${name} nicht als Definition ausserhalb gefunden`);
  }
  const forbidden = [...outsideNames, 'runGit', 'openRepository'].filter(name => !dataConstants.has(name));
  const used = forbidden.filter(name => new RegExp(`(?<![\\w$])${name.replace('$', '\\$')}(?![\\w$])`).test(code));
  assert.deepEqual(used, [], `Namen von ausserhalb im Abschnitt ohne Git: ${used.join(', ')}`);
  // Die Datenkonstanten sind wirklich nur Daten: Text, Zahl, Regex oder eingefrorene Textliste.
  for (const name of dataConstants) {
    if (name !== 'fail') {
      assert.ok(new RegExp(`^(?:export )?const ${name} = (?:'[^']*'|[0-9_]+;|\\/|Object\\.freeze\\(\\[)`, 'm').test(outsideCode), `${name} ist keine reine Datenkonstante`);
    }
  }
});

test('Wache: das Auftragsmodul exportiert runGit und openRepository, isolatedEnv bleibt intern', () => {
  const source = readFileSync(join(ROOT, 'scripts/agent-code-auftrag.mjs'), 'utf8');
  assert.ok(source.includes('export function runGit(git, args, code, binary = false) {'));
  assert.ok(source.includes('export function openRepository(root, baseSha, gitEnv) {'));
  assert.ok(source.includes('function isolatedEnv(gitEnv) {'), 'Gegenprobe: isolatedEnv nicht gefunden');
  assert.ok(!/export\s+(function\s+)?isolatedEnv|export\s*\{[^}]*isolatedEnv/.test(source));
});

test('Wache: kein Workflow ruft eines der vier Auftragsmodule auf', () => {
  const dir = join(ROOT, '.github/workflows');
  const files = readdirSync(dir).filter(name => /\.ya?ml$/.test(name));
  const texts = files.map(name => readFileSync(join(dir, name), 'utf8'));
  assert.ok(files.length >= 10, 'Gegenprobe: zu wenige Workflows gefunden');
  assert.ok(texts.some(text => text.includes('agent-code-package')), 'Gegenprobe ohne Treffer');
  assert.ok(texts.every(text => !text.includes('agent-code-auftrag')), 'ein Workflow verweist auf ein Auftragsmodul');
});

test('Wache: kein anderes Skript verweist auf eines der vier Auftragsmodule', () => {
  const dir = join(ROOT, 'scripts');
  const names = readdirSync(dir).filter(name => name.endsWith('.mjs'));
  assert.ok(MODULES.every(name => names.includes(name)), 'Gegenprobe: ein Auftragsmodul fehlt');
  const others = names.filter(name => !MODULES.includes(name));
  assert.equal(others.length, names.length - MODULES.length);
  const texts = others.map(name => readFileSync(join(dir, name), 'utf8'));
  assert.ok(texts.length >= 10, 'Gegenprobe: zu wenige Skripte gefunden');
  assert.ok(texts.some(text => text.includes('./agent-code-release-plan.mjs')), 'Gegenprobe ohne Treffer');
  assert.ok(texts.every(text => !text.includes('agent-code-auftrag')), 'ein Skript verweist auf ein Auftragsmodul');
  assert.ok(SOURCE.includes("from './agent-code-auftrag.mjs'"), 'Gegenprobe: Import nicht gefunden');
});
