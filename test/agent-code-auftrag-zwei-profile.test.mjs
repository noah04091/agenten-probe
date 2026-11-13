// A6.3-2: Zwei-Profile-Trockenlauf mit echter Prozessgrenze zwischen simuliertem Job 2 und Job 3.
//
// Diese Datei hat drei Rollen:
// - Ohne Rollenargument (node --test): Orchestrator und regulaere Tests.
// - node <diese Datei> --a63-rolle=job2 ...: simulierter Job 2 als eigener Node-Prozess.
// - node <diese Datei> --a63-rolle=job3 ...: simulierter Job 3 als eigener Node-Prozess.
// Mit Rollenargument wird node:test nicht geladen und kein Test registriert.
//
// Was der Test zeigt: Fuer js-rechner und js-text laeuft die allgemeine Auftragskette auf DEMSELBEN
// synthetischen Ausgangscommit B vollstaendig durch. Job 2 und Job 3 sind getrennte Prozesse (PID und
// Zufallswert gemessen), uebergeben wird ausschliesslich ueber eine Paketdatei und eine Datei mit dem
// SHA-256 dieser Bytes. Beide Jobs rekonstruieren den Auftrag aus den festen Testdaten neu und pruefen
// das Paket selbst aus den empfangenen Bytes. Ausser den zwei Uebergabedateien lesen beide Jobs nur das
// gemeinsame synthetische Repository (das nach den Jobs unveraendert sein muss) und beim Laden dieser
// Datei die vertrauenswuerdigen Originalbytes aus dem Arbeitsbaum.
//
// Was der Test NICHT zeigt:
// - Keine GitHub-Actions-Uebergabe von Paket v2 (needs, Job-Ausgaben, Artefakt-Digest). Die lokale
//   Hashdatei belegt keine Authentizitaet: Wer Paket- und Hashdatei zusammen austauschen kann, faellt
//   hier nicht auf. Das ist Pflicht fuer A6.4.
// - Die Bindung von Code und Abnahmedatei vor der Abnahme und die Regel "nur abgenommen wird
//   veroeffentlicht" stehen nur in dieser Testdatei, in keinem Produktionsmodul.
// - Ein abgebrochener simulierter Job 2 belegt nur dieses Testgeruest, nicht die Jobabhaengigkeit in
//   GitHub Actions. K1 bis K4 und alle A6.4-Pflichtpunkte bleiben offen.
//
// Alles offline und synthetisch: kein Claude-Aufruf, keine Netzanfrage, keine Zugangsdaten, kein
// GitHub-Schreibzugriff. Git laeuft nur in Temp-Repositorys mit isolierter Umgebung. Aus dem echten
// Repository werden nur Dateien gelesen (Profile, Textmodul, Policy-Vorlage). src/rechne.js und
// test/rechne.test.js sind fest hinterlegt, weil der Trockenlauf-Job-2 sie vor npm test veraendert.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { orderSha256, resolveOrder } from '../scripts/agent-code-auftrag.mjs';
import { checkLiveOrder, readLiveState } from '../scripts/agent-code-auftrag-live.mjs';
import { SECURITY_FRAME, buildPrompt } from '../scripts/agent-code-auftrag-prompt.mjs';
import {
  MAX_PACKAGE_BYTES, applyPackageV2, compareWorkspace, createPackageV2, packageFileBytes, parsePackageV2, prepareWorkspace,
} from '../scripts/agent-code-auftrag-paket.mjs';
import { publishOrderDraft } from '../scripts/agent-code-auftrag-publish.mjs';
import { loadProfile } from '../scripts/agent-profile.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const gitBlobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
const cp = code => String.fromCodePoint(code);

// ---------------------------------------------------------------------------
// Vertrauenswuerdige Originalbytes von main (ce5c3a34fd922e56feb6ff3d0fc4c3bcc956bcee)
// ---------------------------------------------------------------------------

const MAIN_BLOBS = Object.freeze({
  'agent-profiles/js-rechner.json': 'acb982e0c9e65503213959574df170eaea767bcc',
  'agent-profiles/js-text.json': '6d565be9d4e96995c412ef32ce683e8c21db3391',
  'src/rechne.js': '796a4ef32bff24ffd913bf2d0f888b7a6a2adc42',
  'test/rechne.test.js': '43c20fdb9201d42497b3ed1f7b75fa5becdadc9b',
  'src/text.js': 'd6e32cd4d0feb33d0dbedc5f19cc075bb39eca79',
  'test/text.test.js': '7e19fd4cacb4dd4ce94a5f056444ef240108d436',
});

const RECHNE_JS = [
  '// Spielcode f' + cp(0xfc) + 'r den Ablauftest. Kein Bezug zu Contract AI.',
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

const RECHNE_TEST = [
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "const { addiere, subtrahiere, multipliziere } = require('../src/rechne');",
  '',
  "test('addiere z" + cp(0xe4) + "hlt zwei Zahlen zusammen', () => {",
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

// Liest eine Datei des echten Repositorys und bindet sie an die Blob-ID von main.
function mainBytes(pfad) {
  const bytes = readFileSync(join(ROOT, ...pfad.split('/')));

  if (gitBlobId(bytes) !== MAIN_BLOBS[pfad]) {
    throw new Error(`${pfad} weicht von main ab`);
  }

  return bytes;
}

function fixedBytes(pfad, text) {
  const bytes = Buffer.from(text, 'utf8');

  if (gitBlobId(bytes) !== MAIN_BLOBS[pfad]) {
    throw new Error(`fest hinterlegtes ${pfad} weicht von main ab`);
  }

  return bytes;
}

const ORIGINAL = Object.freeze({
  'agent-profiles/js-rechner.json': mainBytes('agent-profiles/js-rechner.json'),
  'agent-profiles/js-text.json': mainBytes('agent-profiles/js-text.json'),
  'src/rechne.js': fixedBytes('src/rechne.js', RECHNE_JS),
  'test/rechne.test.js': fixedBytes('test/rechne.test.js', RECHNE_TEST),
  'src/text.js': mainBytes('src/text.js'),
  'test/text.test.js': mainBytes('test/text.test.js'),
});

// Synthetische Aktivierung: genau die Bytefolge "aktiv": false durch "aktiv": true ersetzen.
const AKTIV_FALSE = Buffer.from('"aktiv": false', 'utf8');
const AKTIV_TRUE = Buffer.from('"aktiv": true', 'utf8');

function activateProfileBytes(bytes) {
  const first = bytes.indexOf(AKTIV_FALSE);

  if (first < 0 || bytes.indexOf(AKTIV_FALSE, first + 1) >= 0) {
    throw new Error('"aktiv": false kommt nicht genau einmal vor');
  }

  return Buffer.concat([bytes.subarray(0, first), AKTIV_TRUE, bytes.subarray(first + AKTIV_FALSE.length)]);
}

const TEXT_PROFIL_AKTIV = activateProfileBytes(ORIGINAL['agent-profiles/js-text.json']);
const DRAFT_POLICY = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'agent-policy.entwurf.json'), 'utf8'));
const POLICY_BYTES = Buffer.from(`${JSON.stringify({ ...DRAFT_POLICY, skript_hashes: { 'scripts/agent-profile.mjs': 'a'.repeat(64) } }, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------------------
// Synthetische Abnahmedateien (im Ausgangscommit gebunden, nie aus dem Arbeitsordner)
// ---------------------------------------------------------------------------

const ABNAHME_RECHNER = [
  '// Synthetische unabhaengige Abnahme fuer js-rechner (A6.3-2). Nur im Pruef-Checkout ausfuehren.',
  "import assert from 'node:assert/strict';",
  "import { createRequire } from 'node:module';",
  '',
  'const require = createRequire(import.meta.url);',
  "const rechner = require('../src/rechne.js');",
  '',
  "for (const name of ['addiere', 'subtrahiere', 'multipliziere', 'quadrat']) {",
  "  assert.equal(typeof rechner[name], 'function', name + ' muss exportiert sein');",
  '}',
  '',
  'const { addiere, subtrahiere, multipliziere, quadrat } = rechner;',
  'const faelle = [[0, 0], [3, 9], [-4, 16], [12, 144], [0.5, 0.25], [-1.5, 2.25], [Infinity, Infinity], [-Infinity, Infinity]];',
  '',
  'for (const [a, erwartet] of faelle) {',
  "  assert.ok(Object.is(quadrat(a), erwartet), 'quadrat(' + a + ') liefert ein falsches Ergebnis');",
  '}',
  '',
  "assert.ok(Object.is(quadrat(-0), 0), 'quadrat(-0) muss +0 ergeben');",
  "assert.ok(Number.isNaN(quadrat(Number.NaN)), 'quadrat(NaN) muss NaN ergeben');",
  '// Andere Eingabetypen: Ergebnis entspricht exakt dem nativen Ausdruck a * a.',
  "assert.ok(Number.isNaN(quadrat(undefined)), 'quadrat(undefined) muss NaN ergeben');",
  "assert.ok(Object.is(quadrat(null), 0), 'quadrat(null) muss 0 ergeben');",
  "assert.ok(Object.is(quadrat('3'), 9), 'quadrat(\"3\") muss 9 ergeben');",
  '',
  "assert.ok(Object.is(multipliziere(0, -9), -0), 'multipliziere(0, -9) muss -0 ergeben');",
  "assert.ok(Object.is(multipliziere(-9, 0), -0), 'multipliziere(-9, 0) muss -0 ergeben');",
  "assert.ok(Object.is(multipliziere(2, 3), 6), 'multipliziere(2, 3) wurde beeintraechtigt');",
  "assert.ok(Object.is(addiere(2, 3), 5), 'addiere(2, 3) wurde beeintraechtigt');",
  "assert.ok(Object.is(addiere(-1, 1), 0), 'addiere(-1, 1) wurde beeintraechtigt');",
  "assert.ok(Object.is(subtrahiere(5, 3), 2), 'subtrahiere(5, 3) wurde beeintraechtigt');",
  '',
  "console.log('A6.3-2: Abnahme js-rechner bestanden.');",
].join('\n') + '\n';

const ABNAHME_TEXT = [
  '// Synthetische unabhaengige Abnahme fuer js-text (A6.3-2). Nur im Pruef-Checkout ausfuehren.',
  "import assert from 'node:assert/strict';",
  "import { createRequire } from 'node:module';",
  '',
  'const require = createRequire(import.meta.url);',
  "const textModul = require('../src/text.js');",
  'const cp = String.fromCodePoint;',
  '',
  "for (const name of ['zeichenzahl', 'istLeer']) {",
  "  assert.equal(typeof textModul[name], 'function', name + ' muss exportiert sein');",
  '}',
  '',
  'const { zeichenzahl, istLeer } = textModul;',
  'const zaehlung = [',
  "  ['', 0],",
  "  ['Hallo', 5],",
  '  [cp(0xe4, 0xf6, 0xfc), 3],',
  '  [cp(0x1f600), 1],',
  "  ['a' + cp(0x308), 2],",
  '  [cp(0x1f1e9, 0x1f1ea), 2],',
  '  [cp(0x1f469, 0x200d, 0x1f4bb), 3],',
  '];',
  '',
  'for (const [text, erwartet] of zaehlung) {',
  "  assert.strictEqual(zeichenzahl(text), erwartet, 'zeichenzahl wurde beeintraechtigt: ' + JSON.stringify(text));",
  '}',
  '',
  "assert.strictEqual(istLeer(''), true, 'istLeer(\"\") muss true ergeben');",
  "for (const text of [' ', 'Hallo', cp(0x1f600), cp(0x200b), '\\t', '\\n', 'a' + cp(0x308), '0']) {",
  "  assert.strictEqual(istLeer(text), false, 'istLeer muss false ergeben: ' + JSON.stringify(text));",
  '}',
  '',
  "const ungueltig = [null, undefined, 0, false, 0n, Symbol('x'), [], [''], {}, new String(''), new String('Hallo'), () => ''];",
  '',
  'for (const fn of [zeichenzahl, istLeer]) {',
  '  for (const wert of ungueltig) {',
  "    assert.throws(() => fn(wert), error => error.constructor === TypeError, fn.name + ' muss TypeError ausloesen: ' + typeof wert);",
  '  }',
  '}',
  '',
  "console.log('A6.3-2: Abnahme js-text bestanden.');",
].join('\n') + '\n';

// ---------------------------------------------------------------------------
// Feste synthetische Aufgaben (vertrauenswuerdige Testdaten fuer Orchestrator, Job 2 und Job 3)
// ---------------------------------------------------------------------------

const REPO_NAME = 'noah04091/agenten-probe';
const P = `/repos/${REPO_NAME}/`;
const OWNER_USER = Object.freeze({ login: 'noah04091', type: 'User' });
const APPROVAL_TIME = '2026-11-10T08:33:39Z';
const RUN_CREATED = '2026-11-10T08:33:41Z';
const NOW = Date.parse('2026-11-10T08:40:00Z');
const COMMIT_DATE = '2026-11-10T08:00:00Z';
const COMMIT_MESSAGE_P = 'Synthetischer Elterncommit P: js-text inaktiv';
const COMMIT_MESSAGE_B = 'Synthetischer Ausgangscommit B: js-text synthetisch aktiv';

// Festes Ergebnis des deterministischen Aufbaus (feste Bytes, Namen und Zeiten). Beide Jobs verlangen
// genau diesen Ausgangscommit und genau diesen einzigen Parent.
const SYNTH_PARENT_SHA = '71c167cb101264739d2e213ac6b9a9641f609da9';
const SYNTH_BASIS_SHA = '3c9ae17f4f01cf32dcf17a149c07db32ebb49f4d';

const AUFGABEN = Object.freeze({
  'js-rechner': Object.freeze({
    profil: 'js-rechner',
    issue: 6301,
    runId: '900000000301',
    titel: 'Synthetisch A6.3-2: quadrat ergaenzen',
    text: 'Kuenstlicher Auftrag fuer den Zwei-Profile-Trockenlauf. Bitte quadrat(a) als a * a ergaenzen, quadrat(-0) ergibt +0.',
    dateien: Object.freeze(['src/rechne.js', 'test/rechne.test.js']),
    abnahme: ABNAHME_RECHNER,
    erfolg: 'A6.3-2: Abnahme js-rechner bestanden.\n',
  }),
  'js-text': Object.freeze({
    profil: 'js-text',
    issue: 6302,
    runId: '900000000302',
    titel: 'Synthetisch A6.3-2: istLeer ergaenzen',
    text: 'Kuenstlicher Auftrag fuer den Zwei-Profile-Trockenlauf. Bitte istLeer(text) ergaenzen: nur die leere Zeichenkette ist leer.',
    dateien: Object.freeze(['src/text.js', 'test/text.test.js']),
    abnahme: ABNAHME_TEXT,
    erfolg: 'A6.3-2: Abnahme js-text bestanden.\n',
  }),
});

const abnahmePfad = aufgabe => `agent-acceptance/issue-${aufgabe.issue}.mjs`;

function baseFiles(textProfil) {
  return {
    '.github/agent/policy.json': POLICY_BYTES,
    [abnahmePfad(AUFGABEN['js-rechner'])]: Buffer.from(ABNAHME_RECHNER, 'utf8'),
    [abnahmePfad(AUFGABEN['js-text'])]: Buffer.from(ABNAHME_TEXT, 'utf8'),
    'agent-profiles/js-rechner.json': ORIGINAL['agent-profiles/js-rechner.json'],
    'agent-profiles/js-text.json': textProfil,
    'src/rechne.js': ORIGINAL['src/rechne.js'],
    'src/text.js': ORIGINAL['src/text.js'],
    'test/rechne.test.js': ORIGINAL['test/rechne.test.js'],
    'test/text.test.js': ORIGINAL['test/text.test.js'],
  };
}

const labelEvent = (id, name, createdAt) => ({
  id, event: 'labeled', created_at: createdAt, actor: { ...OWNER_USER }, label: { name, color: 'ededed' }, performed_via_github_app: null,
});

const eventsFor = (aufgabe, profil = aufgabe.profil) => [
  { id: aufgabe.issue * 100, event: 'assigned', created_at: '2026-11-10T08:00:00Z', actor: { ...OWNER_USER }, performed_via_github_app: null },
  labelEvent(aufgabe.issue * 100 + 1, `agent:${profil}`, '2026-11-10T08:30:00Z'),
  labelEvent(aufgabe.issue * 100 + 2, 'bot-auftrag', APPROVAL_TIME),
];

const payloadFor = aufgabe => ({
  action: 'labeled',
  label: { name: 'bot-auftrag' },
  sender: { ...OWNER_USER },
  repository: { full_name: REPO_NAME },
  issue: { number: aufgabe.issue, user: { login: 'noah04091' }, title: aufgabe.titel, body: aufgabe.text, updated_at: APPROVAL_TIME },
});

const issueFor = (aufgabe, profil = aufgabe.profil) => ({
  number: aufgabe.issue,
  state: 'open',
  title: aufgabe.titel,
  body: aufgabe.text,
  updated_at: APPROVAL_TIME,
  comments: 0,
  user: { ...OWNER_USER },
  labels: [{ name: 'bot-auftrag' }, { name: `agent:${profil}` }],
});

// ---------------------------------------------------------------------------
// Simulierte Codeaenderungen (Vorstufe statt Claude)
// ---------------------------------------------------------------------------

function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) {
    throw new Error(`Ersetzung nicht eindeutig: ${from}`);
  }

  return text.replace(from, () => to);
}

const RECHNE_NEU = replaceOnce(
  replaceOnce(RECHNE_JS, 'function multipliziere(a, b) {\n  return a * b;\n}\n', 'function multipliziere(a, b) {\n  return a * b;\n}\n\nfunction quadrat(a) {\n  return a * a;\n}\n'),
  'module.exports = { addiere, subtrahiere, multipliziere };', 'module.exports = { addiere, subtrahiere, multipliziere, quadrat };',
);

const RECHNE_TEST_NEU = `${RECHNE_TEST}${[
  '',
  "test('quadrat', () => {",
  "  const { quadrat } = require('../src/rechne');",
  '  assert.strictEqual(quadrat(3), 9);',
  '  assert.strictEqual(quadrat(-4), 16);',
  '  assert.strictEqual(quadrat(0.5), 0.25);',
  '  // quadrat(-0) ergibt +0',
  '  assert.ok(Object.is(quadrat(-0), 0));',
  '});',
].join('\n')}\n`;

const TEXT_ALT = ORIGINAL['src/text.js'].toString('utf8');
const TEXT_TEST_ALT = ORIGINAL['test/text.test.js'].toString('utf8');

const TEXT_NEU = replaceOnce(TEXT_ALT, 'module.exports = { zeichenzahl };', [
  '// Nur die primitive leere Zeichenkette ist leer. Kein Trimmen, keine Normalisierung, keine',
  '// Typumwandlung.',
  'function istLeer(text) {',
  "  if (typeof text !== 'string') {",
  "    throw new TypeError('istLeer erwartet eine primitive Zeichenkette');",
  '  }',
  '',
  "  return text === '';",
  '}',
  '',
  'module.exports = { zeichenzahl, istLeer };',
].join('\n'));

// Einzige Aenderung an bestehenden Tests: die Export-Erwartung. Neue Tests werden angehaengt.
const TEXT_TEST_NEU = `${replaceOnce(TEXT_TEST_ALT, "assert.deepEqual(Object.keys(textModul), ['zeichenzahl']);", "assert.deepEqual(Object.keys(textModul), ['zeichenzahl', 'istLeer']);")}${[
  '',
  "test('istLeer: nur die primitive leere Zeichenkette ist leer', () => {",
  '  const { istLeer } = textModul;',
  "  assert.strictEqual(istLeer(''), true);",
  "  assert.strictEqual(istLeer(' '), false);",
  "  assert.strictEqual(istLeer('Hallo'), false);",
  '  assert.strictEqual(istLeer(String.fromCodePoint(0x1f600)), false);',
  "  assert.throws(() => istLeer(new String('')), TypeError);",
  '  assert.throws(() => istLeer(null), TypeError);',
  '});',
].join('\n')}\n`;

const AENDERUNG = Object.freeze({
  'js-rechner': () => ({ 'src/rechne.js': Buffer.from(RECHNE_NEU), 'test/rechne.test.js': Buffer.from(RECHNE_TEST_NEU) }),
  'js-text': () => ({ 'src/text.js': Buffer.from(TEXT_NEU), 'test/text.test.js': Buffer.from(TEXT_TEST_NEU) }),
});

// ---------------------------------------------------------------------------
// Git in Temp-Repositorys
// ---------------------------------------------------------------------------

const GIT_PASSTHROUGH = Object.freeze(['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']);

function gitEnvFor(home) {
  const env = {};

  for (const key of GIT_PASSTHROUGH) {
    const value = own(process.env, key);

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

function prepareHome(home) {
  mkdirSync(join(home, 'xdg'), { recursive: true });
  writeFileSync(join(home, 'leer.gitconfig'), '');
}

function gitIn(cwd, env, args, input, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd,
    env: { ...env, ...extraEnv },
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

// Eigenstaendiger Klon ohne Hardlinks und ohne Remote, detached auf sha.
function cloneAt(source, dir, sha, env, cwd) {
  execFileSync('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', source, dir], { cwd, env, stdio: 'ignore' });
  gitIn(dir, env, ['checkout', '-q', '--detach', sha]);
  gitIn(dir, env, ['remote', 'remove', 'origin']);
  return dir;
}

function commitFiles(repo, env, files, parents, message) {
  const indexEnv = { GIT_INDEX_FILE: join(repo, '.git', `aufbau-${parents.length}`) };
  gitIn(repo, env, ['read-tree', '--empty'], undefined, indexEnv);

  for (const [path, bytes] of Object.entries(files)) {
    const oid = gitIn(repo, env, ['hash-object', '-w', '--stdin'], bytes);
    gitIn(repo, env, ['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], undefined, indexEnv);
  }

  const tree = gitIn(repo, env, ['write-tree'], undefined, indexEnv);
  return gitIn(repo, env, ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message], undefined, {
    GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE,
  });
}

// Baut das gemeinsame synthetische Repository: P (js-text inaktiv) und B (Parent P, js-text aktiv).
function buildSyntheticRepo(repo, env) {
  mkdirSync(repo);
  gitIn(repo, env, ['init', '-q']);
  const parent = commitFiles(repo, env, baseFiles(ORIGINAL['agent-profiles/js-text.json']), [], COMMIT_MESSAGE_P);
  const basis = commitFiles(repo, env, baseFiles(TEXT_PROFIL_AKTIV), [parent], COMMIT_MESSAGE_B);
  gitIn(repo, env, ['update-ref', 'refs/heads/main', basis]);
  gitIn(repo, env, ['update-ref', 'refs/heads/eltern', parent]);
  gitIn(repo, env, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { parent, basis };
}

// ---------------------------------------------------------------------------
// GitHub-Simulator (Vorlage A6.2-7), schreibt echte Git-Objekte in ein eigenes Repository
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

function createSim({ gitDir, env, aufgabe, runId, baseSha, indexFile }) {
  const git = (args, input, extraEnv) => gitIn(gitDir, env, args, input, extraEnv);
  const sim = {
    issue: issueFor(aufgabe),
    events: eventsFor(aufgabe),
    run: {
      id: Number(runId),
      event: 'issues',
      path: '.github/workflows/code-pilot-claude-stufe.yml',
      head_branch: 'main',
      head_sha: baseSha,
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
    nextPr: 6300,
    log: [],
    uploads: [],
  };

  const readTree = sha => {
    try {
      if (git(['cat-file', '-t', sha]) !== 'tree') {
        return notFound();
      }
    } catch {
      return notFound();
    }

    const tree = git(['ls-tree', '-r', '-t', '-z', sha]).split('\0').filter(Boolean).map(line => {
      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s.exec(line);
      return { path: match[4], mode: match[1], type: match[2], sha: match[3], url: 'x' };
    });
    return ok({ sha, url: 'x', tree, truncated: false });
  };

  const readCommit = sha => {
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
  };

  const compare = (base, head) => {
    const commits = git(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
    const behind = Number(git(['rev-list', '--count', `${head}..${base}`]));
    const raw = git(['diff-tree', '-r', '-z', '--no-renames', '--raw', base, head]).split('\0').filter(Boolean);
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
  };

  const handle = req => {
    const rest = req.path.slice(P.length);
    const pageOf = prefix => (rest.startsWith(prefix) ? Number(rest.slice(prefix.length)) : null);
    const n = aufgabe.issue;

    if (req.method === 'GET') {
      if (rest === `actions/runs/${sim.run.id}`) {
        return ok(sim.run);
      }

      if (rest === 'git/ref/heads/main') {
        return ok({ ref: 'refs/heads/main', node_id: 'x', url: 'x', object: { sha: baseSha, type: 'commit', url: 'x' } });
      }

      if (rest === `issues/${n}`) {
        return ok(sim.issue);
      }

      const eventPage = pageOf(`issues/${n}/events?per_page=100&page=`);

      if (eventPage !== null) {
        return pageResponse(sim.events, eventPage, `issues/${n}/events?`);
      }

      if (rest === `git/matching-refs/heads/wp/${n}-`) {
        return ok([...sim.refs].filter(([name]) => name.startsWith(`refs/heads/wp/${n}-`)).map(([ref, sha]) => ({ ref, object: { sha, type: 'commit', url: 'x' } })));
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
        return readCommit(rest.slice('git/commits/'.length));
      }

      const treeMatch = /^git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(rest);

      if (treeMatch) {
        return readTree(treeMatch[1]);
      }

      const compareMatch = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest);

      if (compareMatch) {
        return compare(compareMatch[1], compareMatch[2]);
      }

      return notFound();
    }

    const body = req.body === undefined ? undefined : JSON.parse(req.body);

    if (req.method === 'POST' && rest === 'git/blobs') {
      const bytes = Buffer.from(body.content, 'base64');
      sim.uploads.push(bytes);
      return created({ sha: git(['hash-object', '-w', '--stdin'], bytes), url: 'x' });
    }

    if (req.method === 'POST' && rest === 'git/trees') {
      const indexEnv = { GIT_INDEX_FILE: indexFile };
      git(['read-tree', body.base_tree], undefined, indexEnv);

      for (const entry of body.tree) {
        try {
          git(['cat-file', '-e', entry.sha]);
        } catch {
          return unprocessable();
        }

        git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`], undefined, indexEnv);
      }

      return created({ sha: git(['write-tree'], undefined, indexEnv), url: 'x', tree: [], truncated: false });
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
  };

  sim.transport = async request => {
    const req = { method: request.method, path: request.path, body: request.body };
    sim.log.push(req);
    return handle(req);
  };
  sim.git = git;
  return sim;
}

const restOf = req => req.path.slice(P.length);
const writesOf = sim => sim.log.filter(req => req.method !== 'GET').map(req => `${req.method} ${restOf(req)}`);
const WRITES_OK = Object.freeze(['POST git/blobs', 'POST git/blobs', 'POST git/trees', 'POST git/commits', 'POST git/refs', 'POST pulls']);

function clockOf(...values) {
  let calls = 0;
  return () => {
    if (calls >= values.length) {
      throw new Error('Uhr: mehr Aufrufe als vorgesehen');
    }

    calls += 1;
    return new Date(values[calls - 1]);
  };
}

// ---------------------------------------------------------------------------
// Gemeinsame Bausteine fuer Orchestrator und Jobs
// ---------------------------------------------------------------------------

class KetteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KetteError';
    this.code = code;
  }
}

const kfail = (code, message) => {
  throw new KetteError(code, message);
};

// Auftrag aus den festen Testdaten und dem vertrauenswuerdigen Checkout.
function orderFor(root, baseSha, env, aufgabe, { runId = aufgabe.runId, titel = aufgabe.titel, text = aufgabe.text } = {}) {
  const task = { ...aufgabe, titel, text };
  return resolveOrder({
    root,
    baseSha,
    gitEnv: { ...env },
    repository: REPO_NAME,
    event: payloadFor(task),
    issue: issueFor(task),
    events: eventsFor(task),
    run: { id: runId, attempt: 1, createdAt: RUN_CREATED },
    now: new Date(NOW),
  });
}

// Live-Pruefung gegen einen frischen Simulator. Ergebnis: der live bestaetigte Auftrag.
async function liveOrder(root, baseSha, env, aufgabe, hash, simDir) {
  const sim = createSim({ gitDir: simDir, env, aufgabe, runId: aufgabe.runId, baseSha, indexFile: join(simDir, 'live-index') });
  const state = await readLiveState({ transport: sim.transport, repository: REPO_NAME, issueNumber: aufgabe.issue, runId: aufgabe.runId });
  const order = checkLiveOrder({ expectedSha256: hash, event: payloadFor(aufgabe), state, root, baseSha, gitEnv: { ...env }, now: new Date(NOW), runId: aufgabe.runId });

  if (writesOf(sim).length !== 0) {
    kfail('kette-live-schreibt', 'Live-Pruefung hat geschrieben');
  }

  return order;
}

// Strenges Lesen einer Uebergabedatei: gewoehnliche Datei, kein Symlink, Groesse 1..maxBytes.
function readHandoverFile(path, maxBytes, code) {
  const stat = lstatSync(path, { throwIfNoEntry: false });

  if (stat === undefined) {
    kfail(`${code}-fehlt`, 'Uebergabedatei fehlt');
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    kfail(`${code}-art`, 'Uebergabedatei ist keine gewoehnliche Datei');
  }

  if (stat.size < 1 || stat.size > maxBytes) {
    kfail(`${code}-groesse`, 'Uebergabedatei ist leer oder zu gross');
  }

  const bytes = readFileSync(path);

  if (bytes.length !== stat.size) {
    kfail(`${code}-groesse`, 'Uebergabedatei hat sich beim Lesen veraendert');
  }

  return bytes;
}

const HASH_FILE_RE = /^[0-9a-f]{64}\n$/;

// Hashdatei: exakt 64 kleine Hex-Zeichen und ein LF, sonst nichts.
function readHashFile(path) {
  const bytes = readHandoverFile(path, 65, 'hash-datei');
  const text = bytes.toString('latin1');

  if (bytes.length !== 65 || !HASH_FILE_RE.test(text)) {
    kfail('hash-datei-format', 'Hashdatei hat nicht genau 64 kleine Hex-Zeichen und ein LF');
  }

  return text.slice(0, 64);
}

const hashFileText = hex => `${hex}\n`;

let acceptanceStarts = 0;

// Unmittelbar vor der Abnahme: die Bytes, die JETZT im Pruef-Checkout liegen, gegen das gepruefte Paket.
function bindCodeBeforeAcceptance(checkRoot, order, parsed) {
  const paths = parsed.dateien.map(meta => meta.pfad);

  if (paths.length !== order.dateien.length || paths.some((pfad, i) => pfad !== order.dateien[i])) {
    kfail('kette-code-pfade', 'Paketpfade entsprechen nicht genau den freigegebenen Dateien');
  }

  return Object.fromEntries(parsed.dateien.map(meta => {
    const abs = join(checkRoot, ...meta.pfad.split('/'));
    const stat = lstatSync(abs, { throwIfNoEntry: false });

    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
      kfail('kette-code-datei', `${meta.pfad} ist keine gewoehnliche Datei`);
    }

    const blob = gitBlobId(readFileSync(abs));

    if (blob !== meta.git_blob) {
      kfail('kette-code-blob', `${meta.pfad} weicht vom geprueften Paket ab`);
    }

    return [meta.pfad, blob];
  }));
}

const ACCEPTANCE_TIMEOUT_MS = 10_000;

// Fuehrt genau die im Auftrag gebundene Abnahmedatei aus: absoluter Pfad, leere Umgebung (Windows:
// nur SystemRoot), aeusseres Zeitlimit mit SIGKILL.
function runBoundAcceptance(checkRoot, order, aufgabe) {
  const file = join(checkRoot, ...order.abnahme_pfad.split('/'));
  const stat = lstatSync(file, { throwIfNoEntry: false });

  if (order.abnahme_pfad !== abnahmePfad(aufgabe) || !isAbsolute(file) || stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
    kfail('kette-abnahme-datei', 'Abnahmedatei ungueltig');
  }

  const bytes = readFileSync(file);

  if (sha256(bytes) !== order.abnahme_sha256 || sha256(bytes) !== sha256(Buffer.from(aufgabe.abnahme, 'utf8'))) {
    kfail('kette-abnahme-hash', 'Abnahmedatei im Pruef-Checkout weicht vom Auftrag ab');
  }

  acceptanceStarts += 1;
  const env = IS_WINDOWS ? { SystemRoot: own(process.env, 'SystemRoot') } : {};
  const out = spawnSync(process.execPath, [file], {
    cwd: checkRoot, env, timeout: ACCEPTANCE_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1_000_000,
  });
  return { status: out.status, signal: out.signal, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

// Paket aus seinen BYTES pruefen, Code binden, erst dann die Abnahme. Kein Metadatenobjekt wird geglaubt.
function acceptPackage(checkRoot, order, hash, packageBytes, aufgabe) {
  const parsed = parsePackageV2(order, hash, packageBytes, sha256(packageBytes));
  const blobs = bindCodeBeforeAcceptance(checkRoot, order, parsed);
  const run = runBoundAcceptance(checkRoot, order, aufgabe);

  if (run.status !== 0 || run.signal !== null || run.stdout !== aufgabe.erfolg || run.stderr !== '') {
    const error = new KetteError('kette-abnahme-rot', 'unabhaengige Abnahme nicht bestanden');
    error.lauf = run;
    throw error;
  }

  return { paket_sha256: sha256(packageBytes), blobs };
}

// Nach applyPackageV2: genau die beiden Dateien geaendert, Modus 100644, sonst nichts.
function checkAppliedCheckout(checkRoot, env, aufgabe) {
  const status = gitIn(checkRoot, env, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);

  if (status !== aufgabe.dateien.map(pfad => ` M ${pfad}`).join('\n')) {
    kfail('kette-pruef-checkout', 'Pruef-Checkout hat andere Aenderungen als die freigegebenen Dateien');
  }

  if (gitIn(checkRoot, env, ['diff', '--summary']) !== '') {
    kfail('kette-pruef-checkout', 'Dateimodus oder Dateityp veraendert');
  }
}

// ---------------------------------------------------------------------------
// Kindprozessrollen
// ---------------------------------------------------------------------------

const ROLE_KEYS = Object.freeze({
  job2: Object.freeze(['a63-rolle', 'repo', 'basis', 'profil', 'paket', 'ausgabe', 'arbeit']),
  job3: Object.freeze(['a63-rolle', 'repo', 'basis', 'profil', 'paket', 'hash', 'arbeit']),
});
const PATH_KEYS = Object.freeze(['repo', 'paket', 'hash', 'ausgabe', 'arbeit']);
const FORBIDDEN_ENV = /^(NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT|GIT_.*|GH_.*|GITHUB_.*|ANTHROPIC_.*|BOT_APP_.*|ACTIONS_.*|RUNNER_.*|CI)$/i;
// Unter Windows ergaenzt libuv beim Start jedes Prozesses selbst einige Pflichtvariablen (gemessen mit
// Node 24: HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR).
const ALLOWED_CHILD_ENV = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir', 'HOME',
  ...(IS_WINDOWS ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'] : []),
]);

// null: kein Rollenaufruf. Sonst die strikt gepruefte Rollenbeschreibung.
function parseRoleArgs(argv) {
  if (!argv.some(arg => arg.startsWith('--a63-'))) {
    return null;
  }

  const fields = {};

  for (const arg of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/s.exec(arg);

    if (!match || Object.hasOwn(fields, match[1])) {
      kfail('rolle-argumente', 'ungueltiges oder doppeltes Argument');
    }

    fields[match[1]] = match[2];
  }

  const keys = ROLE_KEYS[fields['a63-rolle']];

  if (keys === undefined) {
    kfail('rolle-unbekannt', 'unbekannte Rolle');
  }

  if (Object.keys(fields).length !== keys.length || !keys.every(key => Object.hasOwn(fields, key))) {
    kfail('rolle-argumente', 'Argumente passen nicht zur Rolle');
  }

  for (const key of PATH_KEYS) {
    if (Object.hasOwn(fields, key) && !isAbsolute(fields[key])) {
      kfail('rolle-pfad', `${key} ist kein absoluter Pfad`);
    }
  }

  if (!Object.hasOwn(AUFGABEN, fields.profil)) {
    kfail('rolle-profil', 'unbekanntes Profil');
  }

  if (fields.basis !== SYNTH_BASIS_SHA) {
    kfail('rolle-basis', 'Ausgangscommit ist nicht der synthetische Ausgangscommit B');
  }

  return Object.freeze({ rolle: fields['a63-rolle'], ...fields });
}

function checkChildEnv() {
  for (const key of Object.keys(process.env)) {
    if (FORBIDDEN_ENV.test(key) || !ALLOWED_CHILD_ENV.includes(key)) {
      kfail('rolle-umgebung', `unerlaubte Umgebungsvariable ${key}`);
    }
  }

  const home = own(process.env, 'HOME');

  if (typeof home !== 'string' || !isAbsolute(home)) {
    kfail('rolle-umgebung', 'HOME fehlt');
  }

  return home;
}

// Eigener frischer Klon auf B. Prueft den vollstaendigen SHA und den einzigen Parent P.
function jobClone(args, env, name) {
  const dir = cloneAt(args.repo, join(args.arbeit, name), args.basis, env, args.arbeit);

  if (gitIn(dir, env, ['rev-parse', 'HEAD']) !== SYNTH_BASIS_SHA || gitIn(dir, env, ['rev-parse', `${SYNTH_BASIS_SHA}^@`]) !== SYNTH_PARENT_SHA) {
    kfail('rolle-basis', 'Klon steht nicht auf B mit Parent P');
  }

  return dir;
}

async function roleJob2(args, env) {
  const aufgabe = AUFGABEN[args.profil];
  // Billige Pruefungen zuerst: Paketbytes lesen und selbst hashen.
  const packageBytes = readHandoverFile(args.paket, MAX_PACKAGE_BYTES, 'paket-datei');
  const packageSha = sha256(packageBytes);

  const trusted = jobClone(args, env, 'vertrauenswuerdig');
  const order = orderFor(trusted, args.basis, env, aufgabe);
  const hash = orderSha256(order);
  const simDir = join(args.arbeit, 'github.git');
  execFileSync('git', ['clone', '-q', '--bare', '--no-hardlinks', args.repo, simDir], { cwd: args.arbeit, env, stdio: 'ignore' });
  const live = await liveOrder(trusted, args.basis, env, aufgabe, hash, simDir);

  const parsed = parsePackageV2(live, hash, packageBytes, packageSha);
  const check = join(args.arbeit, 'pruef');
  cpSync(trusted, check, { recursive: true });
  applyPackageV2(check, live, hash, parsed, { gitEnv: { ...env } });
  checkAppliedCheckout(check, env, aufgabe);
  const accepted = acceptPackage(check, live, hash, packageBytes, aufgabe);

  // Uebergabe: genau die gepruefte Bytefolge und ihr SHA-256, neu angelegt, danach zurueckgelesen.
  const paketOut = join(args.ausgabe, 'code-paket.json');
  const hashOut = join(args.ausgabe, 'code-paket.sha256');
  writeFileSync(paketOut, packageBytes, { flag: 'wx' });
  writeFileSync(hashOut, hashFileText(packageSha), { flag: 'wx' });

  if (sha256(readFileSync(paketOut)) !== packageSha || readHashFile(hashOut) !== packageSha) {
    kfail('job2-uebergabe', 'Uebergabedateien weichen nach dem Schreiben ab');
  }

  return {
    rolle: 'job2',
    profil: aufgabe.profil,
    pid: process.pid,
    zufall: randomBytes(16).toString('hex'),
    status: 'geprueft-und-abgenommen',
    auftrag_sha256: hash,
    paket_sha256: packageSha,
    blobs: accepted.blobs,
  };
}

async function roleJob3(args, env) {
  const aufgabe = AUFGABEN[args.profil];
  // Billige Pruefungen zuerst: Paket und Hashdatei lesen, selbst hashen, vergleichen.
  const packageBytes = readHandoverFile(args.paket, MAX_PACKAGE_BYTES, 'paket-datei');
  const expected = readHashFile(args.hash);
  const packageSha = sha256(packageBytes);

  if (packageSha !== expected) {
    kfail('job3-paket-hash', 'empfangene Paketbytes passen nicht zur Hashdatei');
  }

  const trusted = jobClone(args, env, 'vertrauenswuerdig');
  const order = orderFor(trusted, args.basis, env, aufgabe);
  const hash = orderSha256(order);
  const simDir = join(args.arbeit, 'github.git');
  execFileSync('git', ['clone', '-q', '--bare', '--no-hardlinks', args.repo, simDir], { cwd: args.arbeit, env, stdio: 'ignore' });
  const live = await liveOrder(trusted, args.basis, env, aufgabe, hash, simDir);

  const parsed = parsePackageV2(live, hash, packageBytes, packageSha);
  const check = join(args.arbeit, 'pruef');
  cpSync(trusted, check, { recursive: true });
  applyPackageV2(check, live, hash, parsed, { gitEnv: { ...env } });
  checkAppliedCheckout(check, env, aufgabe);
  // acceptPackage prueft das Paket selbst aus genau diesen Bytes (parsePackageV2).
  const accepted = acceptPackage(check, live, hash, packageBytes, aufgabe);

  const sim = createSim({ gitDir: simDir, env, aufgabe, runId: aufgabe.runId, baseSha: args.basis, indexFile: join(args.arbeit, 'sim-index') });
  const publishCheck = join(args.arbeit, 'veroeffentlichung');
  // Der Pruef-Checkout oben ist beschrieben; der Veroeffentlicher bekommt eine frische Kopie von trusted.
  cpSync(trusted, publishCheck, { recursive: true });
  let result;

  try {
    result = await publishOrderDraft({
      root: trusted,
      checkRoot: publishCheck,
      baseSha: args.basis,
      event: payloadFor(aufgabe),
      expectedSha256: hash,
      runId: aufgabe.runId,
      packageBytes,
      packageSha256: packageSha,
      gitEnv: { ...env },
      transport: sim.transport,
      clock: clockOf(NOW, NOW, NOW, NOW),
    });
  } catch (error) {
    error.schreibaufrufe = writesOf(sim);
    throw error;
  }

  const published = Object.fromEntries(sim.git(['ls-tree', result.commit, '--', ...aufgabe.dateien]).split('\n').map(line => {
    const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    return [match[2], match[1]];
  }));
  const pr = sim.pulls.at(-1);

  if (
    JSON.stringify(writesOf(sim)) !== JSON.stringify(WRITES_OK) || pr.draft !== true || pr.merged !== false ||
    result.paket_sha256 !== packageSha || result.auftrag_sha256 !== hash ||
    JSON.stringify([...result.dateien]) !== JSON.stringify(aufgabe.dateien) ||
    JSON.stringify(published) !== JSON.stringify(accepted.blobs) || sim.log.some(req => /merge/i.test(req.path))
  ) {
    kfail('job3-ergebnis', 'simulierter Draft-PR entspricht nicht dem geprueften Paket');
  }

  return {
    rolle: 'job3',
    profil: aufgabe.profil,
    pid: process.pid,
    zufall: randomBytes(16).toString('hex'),
    status: 'draft-pr-simuliert',
    auftrag_sha256: hash,
    paket_sha256: packageSha,
    erwarteter_paket_sha256: expected,
    veroeffentlichter_paket_sha256: result.paket_sha256,
    blobs: published,
    pr_nummer: result.pr_nummer,
    commit: result.commit,
    schreibaufrufe: writesOf(sim),
  };
}

async function runRole(argv) {
  let rolle = 'unbekannt';

  try {
    const args = parseRoleArgs(argv);
    rolle = args.rolle;
    const home = checkChildEnv();
    prepareHome(home);
    const env = gitEnvFor(home);
    const result = rolle === 'job2' ? await roleJob2(args, env) : await roleJob3(args, env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ rolle, fehler: typeof error?.code === 'string' ? error.code : 'unerwartet', meldung: String(error?.message ?? error).slice(0, 300), schreibaufrufe: error?.schreibaufrufe ?? [] })}\n`);
    process.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// Einstieg: Rolle oder Testregistrierung
// ---------------------------------------------------------------------------

let roleRequest = null;

try {
  roleRequest = parseRoleArgs(process.argv.slice(2)) === null ? null : process.argv.slice(2);
} catch {
  roleRequest = process.argv.slice(2);
}

if (roleRequest !== null) {
  await runRole(roleRequest);
} else {
  await registerTests();
}

// ===========================================================================
// Orchestrator und Tests (nur ohne Rollenargument)
// ===========================================================================

async function registerTests() {
  const { default: test, before, after } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');

  let BASE_DIR;
  let REPO;
  let ENV;
  let PARENT;
  let BASIS;
  let TEMPLATE;
  let TEMPLATE_P;
  let TRUSTED;
  let dirNo = 0;
  const VORSTUFE = {};
  const UEBERGABE = {};
  const MESSUNG = {};

  const newDir = prefix => {
    dirNo += 1;
    return join(BASE_DIR, `${prefix}${dirNo}`);
  };

  const checkout = (template = TEMPLATE, prefix = 'c') => {
    const dir = newDir(prefix);
    cpSync(template, dir, { recursive: true });
    return dir;
  };

  const repoSnapshot = () => ({
    refs: gitIn(REPO, ENV, ['for-each-ref', '--format=%(refname) %(objectname)']),
    objekte: gitIn(REPO, ENV, ['cat-file', '--batch-all-objects', '--batch-check']),
  });

  const statusOf = dir => gitIn(dir, ENV, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);

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

  // Minimale Kindumgebung: nur Pfadsuche, unter Windows die Systemvariablen, ein eigenes HOME.
  function childEnv(home, extra = {}) {
    const env = {};

    for (const key of ['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']) {
      const value = own(process.env, key);

      if (typeof value === 'string') {
        env[key] = value;
      }
    }

    return { ...env, HOME: home, ...extra };
  }

  const JOB_TIMEOUT_MS = 60_000;

  // Startet eine Rolle als eigenen Node-Prozess ueber den absoluten Pfad process.execPath.
  function runJob(rolle, params, { timeout = JOB_TIMEOUT_MS, extraEnv = {}, rawArgs = null } = {}) {
    const arbeit = newDir(`${rolle}-`);
    mkdirSync(arbeit);
    const args = rawArgs ?? [`--a63-rolle=${rolle}`, ...Object.entries({ ...params, arbeit }).map(([key, value]) => `--${key}=${value}`)];
    const started = Date.now();
    const out = spawnSync(process.execPath, [THIS_FILE, ...args], {
      cwd: arbeit,
      env: childEnv(join(arbeit, 'home'), extraEnv),
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1_000_000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run = { rolle, pid: out.pid, status: out.status, signal: out.signal, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error ?? null, ms: Date.now() - started };

    // Nach einem SIGKILL koennen Git-Enkelprozesse kurz Dateien halten (Windows). Das Aufraeumen
    // wiederholt sich deshalb; bleibt etwas liegen, raeumt after() den ganzen Temp-Ordner.
    try {
      rmSync(arbeit, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // after() entfernt BASE_DIR vollstaendig.
    }

    return run;
  }

  // Erfolg nur bei Exitcode 0, ohne Signal, leerem stderr und genau einer JSON-Zeile mit eigener PID.
  function acceptJobOutput(run, rolle, profil) {
    if (run.error !== null || run.signal !== null || run.status !== 0) {
      kfail('orchestrator-job-fehlgeschlagen', `${rolle}: Exitcode ${run.status}, Signal ${run.signal}`);
    }

    if (run.stderr !== '') {
      kfail('orchestrator-stderr', `${rolle}: stderr nicht leer`);
    }

    if (!/^[^\n]+\n$/.test(run.stdout)) {
      kfail('orchestrator-protokoll', `${rolle}: nicht genau eine Ausgabezeile`);
    }

    let json;

    try {
      json = JSON.parse(run.stdout);
    } catch {
      kfail('orchestrator-protokoll', `${rolle}: keine gueltige JSON-Zeile`);
    }

    if (json === null || typeof json !== 'object' || Array.isArray(json) || json.rolle !== rolle || json.profil !== profil) {
      kfail('orchestrator-zuordnung', `${rolle}: Ergebnis gehoert nicht zu Rolle oder Profil`);
    }

    // Die gemeldete PID muss die des tatsaechlich gestarteten Prozesses sein (von spawnSync gemessen).
    if (!Number.isSafeInteger(json.pid) || json.pid <= 0 || json.pid === process.pid || json.pid !== run.pid) {
      kfail('orchestrator-prozess', `${rolle}: keine eigene Prozess-ID`);
    }

    if (typeof json.zufall !== 'string' || !/^[0-9a-f]{32}$/.test(json.zufall)) {
      kfail('orchestrator-protokoll', `${rolle}: Zufallswert fehlt`);
    }

    if (!/^[0-9a-f]{64}$/.test(json.paket_sha256 ?? '') || !/^[0-9a-f]{64}$/.test(json.auftrag_sha256 ?? '')) {
      kfail('orchestrator-protokoll', `${rolle}: Hashes fehlen`);
    }

    return json;
  }

  const jobError = run => {
    try {
      return JSON.parse(run.stderr);
    } catch {
      return { fehler: null, roh: run.stderr };
    }
  };

  // Job 2 fuer ein Profil. Ergebnis: Ausgabe und Uebergabeordner mit genau zwei Dateien.
  function runJob2(profil, paket) {
    const ausgabe = newDir('uebergabe-');
    mkdirSync(ausgabe);
    const run = runJob('job2', { repo: REPO, basis: BASIS, profil, paket, ausgabe });
    return { run, ausgabe, paket: join(ausgabe, 'code-paket.json'), hash: join(ausgabe, 'code-paket.sha256') };
  }

  const runJob3 = (profil, paket, hash, options) => runJob('job3', { repo: REPO, basis: BASIS, profil, paket, hash }, options);

  // Uebergabe von Job 2 je Profil, einmal erzeugt und fuer die Negativfaelle kopiert.
  function uebergabe(profil) {
    if (UEBERGABE[profil] === undefined) {
      const job2 = runJob2(profil, VORSTUFE[profil].datei);
      const json = acceptJobOutput(job2.run, 'job2', profil);
      UEBERGABE[profil] = { ...job2, json };
    }

    return UEBERGABE[profil];
  }

  // Legt eine Uebergabe mit beliebigen Bytes an (fuer Negativfaelle).
  function handover(paketBytes, hashBytes) {
    const dir = newDir('manipuliert-');
    mkdirSync(dir);
    const paket = join(dir, 'code-paket.json');
    const hash = join(dir, 'code-paket.sha256');

    if (paketBytes !== null) {
      writeFileSync(paket, paketBytes);
    }

    if (hashBytes !== null) {
      writeFileSync(hash, hashBytes);
    }

    return { paket, hash };
  }

  // Job 3 muss scheitern: kein Erfolg, keine Schreibaufrufe vor der Veroeffentlichung, Grund dokumentiert.
  function expectJob3Rejects(profil, files, fehler) {
    const run = runJob3(profil, files.paket, files.hash);
    assert.throws(() => acceptJobOutput(run, 'job3', profil), error => error.code === 'orchestrator-job-fehlgeschlagen');
    assert.equal(run.stdout, '', 'Job 3 hat eine Erfolgsausgabe geschrieben');
    assert.equal(run.status, 3, run.stderr);
    const info = jobError(run);
    assert.equal(info.fehler, fehler, `erwartet ${fehler}, erhalten ${run.stderr}`);
    assert.deepEqual(info.schreibaufrufe, [], 'GitHub-Schreibaufrufe trotz Ablehnung');
    return info;
  }

  // Vollstaendige Kette fuer ein Profil: Job 2, Uebergabe, Job 3. Job 3 laeuft nur nach gueltigem Job 2.
  async function zweiJobs(profil) {
    const job2 = runJob2(profil, VORSTUFE[profil].datei);
    const json2 = acceptJobOutput(job2.run, 'job2', profil);
    const run3 = runJob3(profil, job2.paket, job2.hash);
    const json3 = acceptJobOutput(run3, 'job3', profil);

    if (json2.pid === json3.pid || json2.zufall === json3.zufall) {
      kfail('orchestrator-prozess', 'Job 2 und Job 3 sind nicht getrennt');
    }

    return { job2, json2, run3, json3 };
  }

  // -------------------------------------------------------------------------
  // Aufbau und Abbau
  // -------------------------------------------------------------------------

  before(async () => {
    BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-auftrag-zwei-profile-test-'));
    const home = join(BASE_DIR, 'home');
    prepareHome(home);
    ENV = gitEnvFor(home);
    REPO = join(BASE_DIR, 'repo');
    ({ parent: PARENT, basis: BASIS } = buildSyntheticRepo(REPO, ENV));
    TEMPLATE = cloneAt(REPO, join(BASE_DIR, 'vorlage-b'), BASIS, ENV, BASE_DIR);
    TEMPLATE_P = cloneAt(REPO, join(BASE_DIR, 'vorlage-p'), PARENT, ENV, BASE_DIR);
    TRUSTED = checkout(TEMPLATE, 't');
    const simRepo = join(BASE_DIR, 'github.git');
    execFileSync('git', ['clone', '-q', '--bare', '--no-hardlinks', REPO, simRepo], { cwd: BASE_DIR, env: ENV, stdio: 'ignore' });

    // Vorstufe je Profil (simuliert Claude, ist NICHT Job 2).
    for (const profil of Object.keys(AUFGABEN)) {
      const aufgabe = AUFGABEN[profil];
      const order = orderFor(TRUSTED, BASIS, ENV, aufgabe);
      const hash = orderSha256(order);
      const live = await liveOrder(TRUSTED, BASIS, ENV, aufgabe, hash, simRepo);
      const prompt = buildPrompt({
        order: live, expectedSha256: hash, profileBytes: profil === 'js-text' ? TEXT_PROFIL_AKTIV : ORIGINAL['agent-profiles/js-rechner.json'],
        title: aufgabe.titel, body: aufgabe.text, createNonce: () => '0123456789abcdef0123456789abcdef',
      });
      const work = prepareWorkspace(TRUSTED, live, hash, newDir('w'), { gitEnv: { ...ENV } }).arbeitsordner;

      for (const [pfad, bytes] of Object.entries(AENDERUNG[profil]())) {
        writeFileSync(join(work, ...pfad.split('/')), bytes);
      }

      const vergleich = compareWorkspace(TRUSTED, live, hash, work);
      const pkg = createPackageV2(TRUSTED, live, hash, work);
      const datei = join(BASE_DIR, `vorstufe-${profil}.json`);
      const bytes = Buffer.from(pkg.text, 'utf8');
      writeFileSync(datei, bytes, { flag: 'wx' });
      VORSTUFE[profil] = { order: live, hash, prompt, work, vergleich, text: pkg.text, bytes, sha256: pkg.sha256, datei };
    }
  });

  after(() => {
    if (BASE_DIR !== undefined) {
      rmSync(BASE_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  // Paket fuer eine Aufgabe mit beliebigen Dateien (fuer Negativfaelle), optional anderer Lauf oder Text.
  function packageFor(profil, files, { orderOptions = {}, extra = () => {}, root = TRUSTED, basis = BASIS } = {}) {
    const order = orderFor(root, basis, ENV, AUFGABEN[profil], orderOptions);
    const hash = orderSha256(order);
    const work = prepareWorkspace(root, order, hash, newDir('w'), { gitEnv: { ...ENV } }).arbeitsordner;

    for (const [pfad, bytes] of Object.entries(files)) {
      writeFileSync(join(work, ...pfad.split('/')), bytes);
    }

    extra(work);
    const pkg = createPackageV2(root, order, hash, work);
    return { order, hash, bytes: Buffer.from(pkg.text, 'utf8'), sha256: pkg.sha256, text: pkg.text };
  }

  const editPackage = (text, edit) => {
    const data = JSON.parse(text);
    edit(data);
    return Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
  };

  // -------------------------------------------------------------------------
  // Grundlagen
  // -------------------------------------------------------------------------

  test('Grundlagen: Originalbytes von main, byte-genaue Aktivierung, gemeinsamer Ausgangscommit B mit Parent P', () => {
    // Die Datei auf main ist unveraendert inaktiv.
    assert.equal(JSON.parse(ORIGINAL['agent-profiles/js-text.json']).aktiv, false);
    assert.equal(gitBlobId(readFileSync(join(ROOT, 'agent-profiles', 'js-text.json'))), MAIN_BLOBS['agent-profiles/js-text.json']);

    // Aktivierung: genau eine Stelle, sonst kein Byte veraendert.
    const original = ORIGINAL['agent-profiles/js-text.json'];
    const at = original.indexOf(AKTIV_FALSE);
    assert.ok(at > 0);
    assert.equal(original.indexOf(AKTIV_FALSE, at + 1), -1);
    assert.equal(TEXT_PROFIL_AKTIV.length, original.length - 1);
    assert.ok(TEXT_PROFIL_AKTIV.subarray(0, at).equals(original.subarray(0, at)));
    assert.ok(TEXT_PROFIL_AKTIV.subarray(at + AKTIV_TRUE.length).equals(original.subarray(at + AKTIV_FALSE.length)));
    assert.notEqual(sha256(TEXT_PROFIL_AKTIV), sha256(original));
    const policy = JSON.parse(POLICY_BYTES);
    assert.equal(loadProfile(TEXT_PROFIL_AKTIV, { policy, fileName: 'js-text.json' }).profile.aktiv, true);
    assert.throws(() => activateProfileBytes(Buffer.concat([original, AKTIV_FALSE])), /nicht genau einmal/);

    // Deterministischer Aufbau: genau die festen Commits, B hat genau den Parent P.
    assert.equal(PARENT, SYNTH_PARENT_SHA);
    assert.equal(BASIS, SYNTH_BASIS_SHA);
    assert.equal(gitIn(REPO, ENV, ['rev-parse', `${BASIS}^@`]), PARENT);
    assert.equal(gitIn(REPO, ENV, ['diff-tree', '-r', '--no-renames', '--name-only', PARENT, BASIS]), 'agent-profiles/js-text.json');
    assert.equal(gitIn(REPO, ENV, ['rev-parse', `${BASIS}:agent-profiles/js-text.json`]), gitBlobId(TEXT_PROFIL_AKTIV));
    assert.equal(gitIn(REPO, ENV, ['rev-parse', `${PARENT}:agent-profiles/js-text.json`]), MAIN_BLOBS['agent-profiles/js-text.json']);

    for (const pfad of ['agent-profiles/js-rechner.json', 'src/rechne.js', 'test/rechne.test.js', 'src/text.js', 'test/text.test.js']) {
      assert.equal(gitIn(REPO, ENV, ['rev-parse', `${BASIS}:${pfad}`]), MAIN_BLOBS[pfad], pfad);
    }

    // Eigenstaendige Checkouts ohne Remote.
    for (const dir of [TEMPLATE, TEMPLATE_P, TRUSTED]) {
      assert.ok(lstatSync(join(dir, '.git')).isDirectory());
      assert.equal(existsSync(join(dir, '.git', 'objects', 'info', 'alternates')), false);
      assert.equal(gitIn(dir, ENV, ['remote']), '');
    }
  });

  test('Vorstufe: zwei getrennte Auftraege auf demselben Ausgangscommit, Prompt, Arbeitsordner und Paket v2', () => {
    const r = VORSTUFE['js-rechner'];
    const t = VORSTUFE['js-text'];

    assert.equal(r.order.base_sha, BASIS);
    assert.equal(t.order.base_sha, BASIS);
    assert.equal(r.order.profil_id, 'js-rechner');
    assert.equal(t.order.profil_id, 'js-text');
    // Positive Bindung an die synthetisch aktivierten Bytes.
    assert.equal(t.order.profil_sha256, sha256(TEXT_PROFIL_AKTIV));
    assert.equal(r.order.profil_sha256, sha256(ORIGINAL['agent-profiles/js-rechner.json']));
    assert.deepEqual([...r.order.dateien], ['src/rechne.js', 'test/rechne.test.js']);
    assert.deepEqual([...t.order.dateien], ['src/text.js', 'test/text.test.js']);
    assert.equal(r.order.abnahme_pfad, 'agent-acceptance/issue-6301.mjs');
    assert.equal(t.order.abnahme_pfad, 'agent-acceptance/issue-6302.mjs');
    assert.equal(r.order.abnahme_sha256, sha256(Buffer.from(ABNAHME_RECHNER)));
    assert.equal(t.order.abnahme_sha256, sha256(Buffer.from(ABNAHME_TEXT)));
    assert.deepEqual([r.order.lauf.run_id, t.order.lauf.run_id], ['900000000301', '900000000302']);
    assert.notEqual(r.hash, t.hash);
    assert.notEqual(r.sha256, t.sha256);

    for (const v of [r, t]) {
      assert.ok(v.prompt.startsWith(SECURITY_FRAME));
      assert.ok(v.prompt.includes(`Erlaubte Dateien aus dem geprueften Auftrag:\n${v.order.dateien.map(f => `- ${f}`).join('\n')}\n`));
      assert.equal(existsSync(join(v.work, '.git')), false);
      assert.equal(JSON.parse(v.text).auftrag_sha256, v.hash);
      assert.equal(sha256(readFileSync(v.datei)), v.sha256);
    }

    assert.deepEqual(r.vergleich.dateien.map(f => f.pfad), ['src/rechne.js', 'test/rechne.test.js']);
    assert.deepEqual(t.vergleich.dateien.map(f => f.pfad), ['src/text.js', 'test/text.test.js']);
    assert.equal(statusOf(TRUSTED), '');

    // Die synthetische Textaenderung erweitert nur die Export-Erwartung, bestehende Tests bleiben.
    const alt = TEXT_TEST_ALT.split('\n');
    const neu = TEXT_TEST_NEU.split('\n');
    const changed = alt.filter((line, i) => neu[i] !== line);
    assert.deepEqual(changed, ["  assert.deepEqual(Object.keys(textModul), ['zeichenzahl']);"]);
    assert.ok(TEXT_TEST_NEU.startsWith(TEXT_TEST_ALT.replace("['zeichenzahl']);", "['zeichenzahl', 'istLeer']);")));
    assert.ok(RECHNE_NEU.includes('module.exports = { addiere, subtrahiere, multipliziere, quadrat };'));
  });

  // -------------------------------------------------------------------------
  // Positive Kette ueber die Prozessgrenze
  // -------------------------------------------------------------------------

  test('Zwei Profile: Job 2 und Job 3 als getrennte Prozesse, gleicher Paket-SHA ueber die Grenze, simulierter Draft-PR', async t => {
    const ergebnisse = {};
    const repoVorher = repoSnapshot();

    for (const profil of Object.keys(AUFGABEN)) {
      const aufgabe = AUFGABEN[profil];
      const v = VORSTUFE[profil];
      const { job2, json2, run3, json3 } = await zweiJobs(profil);

      // Prozessidentitaet.
      assert.ok(Number.isSafeInteger(process.pid) && process.pid > 0);
      assert.notEqual(json2.pid, process.pid);
      assert.notEqual(json3.pid, process.pid);
      assert.notEqual(json2.pid, json3.pid);
      assert.notEqual(json2.zufall, json3.zufall);
      assert.equal(json2.status, 'geprueft-und-abgenommen');
      assert.equal(json3.status, 'draft-pr-simuliert');

      // Genau zwei Uebergabedateien aus den Bytes nach Job 2.
      const uebergabeBytes = readFileSync(job2.paket);
      const hashText = readFileSync(job2.hash, 'latin1');
      assert.deepEqual(readdirSync(job2.ausgabe).sort(), ['code-paket.json', 'code-paket.sha256']);
      assert.match(hashText, /^[0-9a-f]{64}\n$/);

      // Paket-SHA-Kette: Vorstufe = Job 2 geprueft = Uebergabedatei = Hashdatei = Job 3 empfangen = veroeffentlicht.
      const kette = [v.sha256, json2.paket_sha256, sha256(uebergabeBytes), hashText.slice(0, 64), json3.paket_sha256, json3.erwarteter_paket_sha256, json3.veroeffentlichter_paket_sha256];
      assert.equal(new Set(kette).size, 1, kette.join(' | '));
      assert.ok(uebergabeBytes.equals(v.bytes));

      // Auftragsbindung je Profil, unabhaengig von beiden Jobs neu berechnet.
      assert.equal(json2.auftrag_sha256, v.hash);
      assert.equal(json3.auftrag_sha256, v.hash);

      // Ergebnis: genau die freigegebenen Dateien mit den Paket-Blobs, Draft-PR, kein Merge.
      const paketBlobs = Object.fromEntries(JSON.parse(v.text).dateien.map(f => [f.pfad, f.git_blob]));
      assert.deepEqual(Object.keys(json3.blobs), [...aufgabe.dateien]);
      assert.deepEqual(json3.blobs, paketBlobs);
      assert.deepEqual(json2.blobs, paketBlobs);
      assert.deepEqual(json3.schreibaufrufe, WRITES_OK);
      assert.match(json3.commit, /^[0-9a-f]{40}$/);
      ergebnisse[profil] = { json2, json3, ms2: job2.run.ms, ms3: run3.ms };
      MESSUNG[profil] = { job2_ms: job2.run.ms, job3_ms: run3.ms };
    }

    // Getrennte Auftraege und Pakete zwischen den Profilen.
    const r = ergebnisse['js-rechner'];
    const tx = ergebnisse['js-text'];
    assert.notEqual(r.json3.auftrag_sha256, tx.json3.auftrag_sha256);
    assert.notEqual(r.json3.paket_sha256, tx.json3.paket_sha256);
    assert.equal(new Set([r.json2.pid, r.json3.pid, tx.json2.pid, tx.json3.pid]).size, 4);
    // Das gemeinsame Repository ist nach beiden Jobs beider Profile unveraendert (Refs und Objekte).
    assert.deepEqual(repoSnapshot(), repoVorher);
    t.diagnostic(`Laufzeit ms: ${JSON.stringify(MESSUNG)}`);
  });

  // -------------------------------------------------------------------------
  // Prozessgrenze: Pruefung der Kindausgaben
  // -------------------------------------------------------------------------

  test('Prozessgrenze: Orchestrator verlangt Exitcode 0, leeres stderr, genau eine JSON-Zeile und eine fremde PID', () => {
    const good = { rolle: 'job2', profil: 'js-rechner', pid: process.pid + 1, zufall: 'a'.repeat(32), paket_sha256: 'b'.repeat(64), auftrag_sha256: 'c'.repeat(64) };
    const run = (changes = {}, json = good) => ({ pid: process.pid + 1, status: 0, signal: null, error: null, stderr: '', stdout: `${JSON.stringify(json)}\n`, ...changes });

    assert.equal(acceptJobOutput(run(), 'job2', 'js-rechner').pid, process.pid + 1);
    throwsCode(() => acceptJobOutput(run({ status: 1 }), 'job2', 'js-rechner'), 'orchestrator-job-fehlgeschlagen');
    throwsCode(() => acceptJobOutput(run({ status: null, signal: 'SIGKILL' }), 'job2', 'js-rechner'), 'orchestrator-job-fehlgeschlagen');
    throwsCode(() => acceptJobOutput(run({ stderr: 'Warnung\n' }), 'job2', 'js-rechner'), 'orchestrator-stderr');
    throwsCode(() => acceptJobOutput(run({ stdout: '' }), 'job2', 'js-rechner'), 'orchestrator-protokoll');
    throwsCode(() => acceptJobOutput(run({ stdout: `${JSON.stringify(good)}\n${JSON.stringify(good)}\n` }), 'job2', 'js-rechner'), 'orchestrator-protokoll');
    throwsCode(() => acceptJobOutput(run({ stdout: 'git: fertig\n' }), 'job2', 'js-rechner'), 'orchestrator-protokoll');
    throwsCode(() => acceptJobOutput(run({}, { ...good, pid: process.pid }), 'job2', 'js-rechner'), 'orchestrator-prozess');
    // Ein Ersatz, der nur eine fremde PID behauptet: passt nicht zum gestarteten Prozess.
    throwsCode(() => acceptJobOutput(run({ pid: process.pid + 2 }), 'job2', 'js-rechner'), 'orchestrator-prozess');
    throwsCode(() => acceptJobOutput(run({ pid: undefined }), 'job2', 'js-rechner'), 'orchestrator-prozess');
    throwsCode(() => acceptJobOutput(run({}, { ...good, profil: 'js-text' }), 'job2', 'js-rechner'), 'orchestrator-zuordnung');
    throwsCode(() => acceptJobOutput(run({}, { ...good, rolle: 'job3' }), 'job2', 'js-rechner'), 'orchestrator-zuordnung');
    throwsCode(() => acceptJobOutput(run({}, { ...good, zufall: undefined }), 'job2', 'js-rechner'), 'orchestrator-protokoll');
  });

  test('Rollenaufruf: unbekannte, doppelte oder unvollstaendige Argumente und fremde Umgebung werden abgelehnt', () => {
    const files = uebergabe('js-rechner');
    const base = ['--a63-rolle=job3', `--repo=${REPO}`, `--basis=${BASIS}`, '--profil=js-rechner', `--paket=${files.paket}`, `--hash=${files.hash}`];
    const cases = [
      [['--a63-rolle=job4'], 'rolle-unbekannt'],
      [[...base, '--a63-rolle=job3', `--arbeit=${BASE_DIR}`], 'rolle-argumente'],
      [base, 'rolle-argumente'],
      [[...base, `--arbeit=${BASE_DIR}`, '--auftrag=x'], 'rolle-argumente'],
      [base.map(arg => (arg.startsWith('--basis=') ? `--basis=${PARENT}` : arg)).concat(`--arbeit=${BASE_DIR}`), 'rolle-basis'],
      [base.map(arg => (arg.startsWith('--profil=') ? '--profil=js-anders' : arg)).concat(`--arbeit=${BASE_DIR}`), 'rolle-profil'],
      [base.map(arg => (arg.startsWith('--paket=') ? '--paket=relativ.json' : arg)).concat(`--arbeit=${BASE_DIR}`), 'rolle-pfad'],
    ];

    for (const [args, fehler] of cases) {
      const run = runJob('job3', {}, { rawArgs: args });
      assert.equal(run.status, 3, run.stderr);
      assert.equal(run.stdout, '');
      assert.equal(jobError(run).fehler, fehler, run.stderr);
    }

    // Fremde Umgebungsvariablen: der Job verweigert, bevor er etwas liest.
    for (const extraEnv of [{ NODE_OPTIONS: '--no-warnings' }, { GH_TOKEN: 'synthetisch' }, { GIT_DIR: BASE_DIR }, { ANTHROPIC_API_KEY: 'synthetisch' }]) {
      const run = runJob('job3', { repo: REPO, basis: BASIS, profil: 'js-rechner', paket: files.paket, hash: files.hash }, { extraEnv });
      assert.equal(run.status, 3, run.stderr);
      assert.equal(jobError(run).fehler, 'rolle-umgebung', run.stderr);
    }
  });

  // -------------------------------------------------------------------------
  // Uebergabe negativ: Paket- und Hashdateien
  // -------------------------------------------------------------------------

  test('Uebergabe negativ: fehlende, leere, abgeschnittene, veraenderte oder ausgetauschte Paket- und Hashdateien', () => {
    const files = uebergabe('js-rechner');
    const bytes = readFileSync(files.paket);
    const hash = readFileSync(files.hash);
    const flipped = Buffer.from(bytes);
    flipped[200] ^= 0x01;
    // Fachlich korrektes, formal gueltiges anderes Paket (nur ein Kommentar mehr), gleicher Auftrag.
    const anders = packageFor('js-rechner', {
      'src/rechne.js': Buffer.from(`${RECHNE_NEU}// anders\n`), 'test/rechne.test.js': Buffer.from(RECHNE_TEST_NEU),
    });

    const cases = [
      ['Paketdatei fehlt', handover(null, hash), 'paket-datei-fehlt'],
      ['Paketdatei ist ein Ordner', (() => {
        const h = handover(null, hash);
        mkdirSync(h.paket);
        return h;
      })(), 'paket-datei-art'],
      ['Hashdatei ist ein Ordner', (() => {
        const h = handover(bytes, null);
        mkdirSync(h.hash);
        return h;
      })(), 'hash-datei-art'],
      ['Paketdatei leer', handover(Buffer.alloc(0), hash), 'paket-datei-groesse'],
      ['Paketdatei abgeschnitten', handover(bytes.subarray(0, bytes.length - 10), hash), 'job3-paket-hash'],
      ['Hashdatei fehlt', handover(bytes, null), 'hash-datei-fehlt'],
      ['Hashdatei leer', handover(bytes, Buffer.alloc(0)), 'hash-datei-groesse'],
      ['Hashdatei mit ungueltigen Zeichen', handover(bytes, Buffer.from(`${hash.toString('latin1').slice(0, 63)}g\n`)), 'hash-datei-format'],
      ['Hashdatei gross geschrieben', handover(bytes, Buffer.from(hash.toString('latin1').toUpperCase())), 'hash-datei-format'],
      ['Hashdatei verkuerzt', handover(bytes, Buffer.from(`${hash.toString('latin1').slice(0, 63)}\n`)), 'hash-datei-format'],
      ['Hashdatei ohne LF', handover(bytes, hash.subarray(0, 64)), 'hash-datei-format'],
      ['Hashdatei mit CRLF', handover(bytes, Buffer.from(`${hash.toString('latin1').slice(0, 64)}\r\n`)), 'hash-datei-groesse'],
      ['Hashdatei mit zweiter Zeile', handover(bytes, Buffer.concat([hash, Buffer.from('x\n')])), 'hash-datei-groesse'],
      ['Paket mit veraendertem Byte', handover(flipped, hash), 'job3-paket-hash'],
      ['anderes Paket bei unveraendertem Hash', handover(anders.bytes, hash), 'job3-paket-hash'],
    ];

    for (const [name, h, fehler] of cases) {
      const info = expectJob3Rejects('js-rechner', h, fehler);
      assert.ok(info.meldung.length > 0, name);
    }

    // Paketdatei nach Job 2 ausgetauscht (im Uebergabeordner selbst), Hash unveraendert.
    const ordner = runJob2('js-rechner', VORSTUFE['js-rechner'].datei);
    acceptJobOutput(ordner.run, 'job2', 'js-rechner');
    writeFileSync(ordner.paket, anders.bytes);
    expectJob3Rejects('js-rechner', ordner, 'job3-paket-hash');
  });

  // -------------------------------------------------------------------------
  // Auftrag und Profil negativ ueber die Prozessgrenze
  // -------------------------------------------------------------------------

  test('Auftrag und Profil negativ: fremder Auftrag, fremder Lauf, vertauschte Profile, falscher Auftrags-SHA', () => {
    const passend = pkg => handover(pkg, Buffer.from(hashFileText(sha256(pkg))));
    const textNeu = { 'src/rechne.js': Buffer.from(RECHNE_NEU), 'test/rechne.test.js': Buffer.from(RECHNE_TEST_NEU) };
    const fremderAuftrag = packageFor('js-rechner', textNeu, { orderOptions: { titel: 'Synthetisch A6.3-2: anderer Auftrag' } });
    const fremderLauf = packageFor('js-rechner', textNeu, { orderOptions: { runId: '900000000399' } });
    const falscherHash = editPackage(VORSTUFE['js-rechner'].text, data => {
      data.auftrag_sha256 = VORSTUFE['js-text'].hash;
    });

    // Paket- und Hashdatei passen jeweils zueinander: Ablehnung erst an der Auftragsbindung.
    expectJob3Rejects('js-rechner', passend(fremderAuftrag.bytes), 'paket-bindung');
    expectJob3Rejects('js-rechner', passend(fremderLauf.bytes), 'paket-bindung');
    expectJob3Rejects('js-text', passend(VORSTUFE['js-rechner'].bytes), 'paket-bindung');
    expectJob3Rejects('js-rechner', passend(VORSTUFE['js-text'].bytes), 'paket-bindung');
    expectJob3Rejects('js-rechner', passend(falscherHash), 'paket-bindung');

    // Auch Job 2 lehnt das Rechnerpaket fuer das Textprofil ab.
    const ausgabe = newDir('uebergabe-');
    mkdirSync(ausgabe);
    const run = runJob('job2', { repo: REPO, basis: BASIS, profil: 'js-text', paket: VORSTUFE['js-rechner'].datei, ausgabe });
    assert.equal(run.status, 3, run.stderr);
    assert.equal(jobError(run).fehler, 'paket-bindung');
    assert.equal(existsSync(join(ausgabe, 'code-paket.json')), false, 'Job 2 hat trotz Fehler uebergeben');
  });

  // -------------------------------------------------------------------------
  // Prozessfehler
  // -------------------------------------------------------------------------

  test('Prozessfehler: Job 2 scheitert oder wird abgebrochen, Job 3 veroeffentlicht nicht', () => {
    // Job 2 meldet einen Fehler (fachlich falsches Paket): keine Erfolgsausgabe, keine Uebergabe.
    const falsch = packageFor('js-rechner', { 'src/rechne.js': Buffer.from(replaceOnce(RECHNE_NEU, 'return a * a;', 'return a + a;')), 'test/rechne.test.js': Buffer.from(RECHNE_TEST_NEU) });
    const paket = join(newDir('falsch-'), 'paket.json');
    mkdirSync(join(paket, '..'), { recursive: true });
    writeFileSync(paket, falsch.bytes);
    const fehler = runJob2('js-rechner', paket);
    throwsCode(() => acceptJobOutput(fehler.run, 'job2', 'js-rechner'), 'orchestrator-job-fehlgeschlagen');
    assert.equal(jobError(fehler.run).fehler, 'kette-abnahme-rot');
    assert.equal(fehler.run.stdout, '');
    assert.equal(existsSync(fehler.paket), false);
    assert.equal(existsSync(fehler.hash), false);
    // Job 3 auf dem leeren Uebergabeordner.
    expectJob3Rejects('js-rechner', fehler, 'paket-datei-fehlt');

    // Job 2 kontrolliert abgebrochen: aeusseres Zeitlimit mit SIGKILL.
    const ausgabe = newDir('abbruch-');
    mkdirSync(ausgabe);
    const started = Date.now();
    const killed = runJob('job2', { repo: REPO, basis: BASIS, profil: 'js-rechner', paket: VORSTUFE['js-rechner'].datei, ausgabe }, { timeout: 150 });
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(killed.status, null);
    assert.ok(Date.now() - started < 30_000);
    throwsCode(() => acceptJobOutput(killed, 'job2', 'js-rechner'), 'orchestrator-job-fehlgeschlagen');
    expectJob3Rejects('js-rechner', { paket: join(ausgabe, 'code-paket.json'), hash: join(ausgabe, 'code-paket.sha256') }, 'paket-datei-fehlt');

    // Fehlerhafte Uebergabedatei aus Job 2 (Hashdatei nachtraeglich gekuerzt).
    const kaputt = runJob2('js-rechner', VORSTUFE['js-rechner'].datei);
    acceptJobOutput(kaputt.run, 'job2', 'js-rechner');
    writeFileSync(kaputt.hash, readFileSync(kaputt.hash).subarray(0, 40));
    expectJob3Rejects('js-rechner', kaputt, 'hash-datei-format');
  });

  test('Job 3 prueft selbst: fachlich falsches Paket mit passender Hashdatei wird nicht veroeffentlicht', () => {
    const faelle = [
      ['js-rechner', { 'src/rechne.js': Buffer.from(replaceOnce(RECHNE_NEU, 'return a * a;', 'return a * a + 1;')), 'test/rechne.test.js': Buffer.from(RECHNE_TEST_NEU) }],
      ['js-text', { 'src/text.js': Buffer.from(replaceOnce(TEXT_NEU, "return text === '';", "return text.trim() === '';")), 'test/text.test.js': Buffer.from(TEXT_TEST_NEU) }],
    ];

    for (const [profil, files] of faelle) {
      const pkg = packageFor(profil, files);
      expectJob3Rejects(profil, handover(pkg.bytes, Buffer.from(hashFileText(pkg.sha256))), 'kette-abnahme-rot');
    }
  });

  // -------------------------------------------------------------------------
  // Fachliche Negativfaelle im Testprozess
  // -------------------------------------------------------------------------

  // Formal gueltig: Paket, Pruefung, Anwendung und Code-Bindung bestehen, die Abnahme lehnt ab.
  function expectAcceptanceRejects(profil, files, grund) {
    const pkg = packageFor(profil, files);
    const order = VORSTUFE[profil].order;
    const parsed = parsePackageV2(order, pkg.hash, pkg.bytes, pkg.sha256);
    const check = checkout();
    applyPackageV2(check, order, pkg.hash, parsed, { gitEnv: { ...ENV } });
    bindCodeBeforeAcceptance(check, order, parsed);
    const before = acceptanceStarts;
    const error = throwsCode(() => acceptPackage(check, order, pkg.hash, pkg.bytes, AUFGABEN[profil]), 'kette-abnahme-rot');
    assert.equal(acceptanceStarts, before + 1);
    assert.notEqual(error.lauf.status, 0);
    assert.match(error.lauf.stderr, /AssertionError \[ERR_ASSERTION\]/);
    assert.ok(error.lauf.stderr.includes(grund), `erwartet "${grund}", erhalten ${error.lauf.stderr}`);
    assert.doesNotMatch(error.lauf.stderr, /SyntaxError|ReferenceError|ERR_REQUIRE|ERR_MODULE/);
  }

  test('Fachlich negativ: die unabhaengigen Abnahmen erkennen falschen Code beider Profile', () => {
    const r = code => ({ 'src/rechne.js': Buffer.from(code), 'test/rechne.test.js': Buffer.from(RECHNE_TEST_NEU) });
    const x = code => ({ 'src/text.js': Buffer.from(code), 'test/text.test.js': Buffer.from(TEXT_TEST_NEU) });

    expectAcceptanceRejects('js-rechner', r(replaceOnce(RECHNE_NEU, 'return a * a;', 'return a + a;')), 'quadrat(3) liefert ein falsches Ergebnis');
    expectAcceptanceRejects('js-rechner', r(replaceOnce(RECHNE_NEU, 'return a * a;', 'return a === 0 ? a : a * a;')), 'quadrat(-0) muss +0 ergeben');
    expectAcceptanceRejects('js-rechner', r(replaceOnce(RECHNE_NEU, 'return a * a;', 'return Math.abs(a) * Math.abs(a) || -0;')), 'quadrat(0) liefert ein falsches Ergebnis');
    expectAcceptanceRejects('js-rechner', r(replaceOnce(RECHNE_NEU, 'return a + b;', 'return a + b + 1;')), 'addiere(2, 3) wurde beeintraechtigt');
    expectAcceptanceRejects('js-rechner', r(replaceOnce(RECHNE_NEU, 'function multipliziere(a, b) {\n  return a * b;', 'function multipliziere(a, b) {\n  return a * b + 0;')), 'multipliziere(0, -9) muss -0 ergeben');
    expectAcceptanceRejects('js-text', x(replaceOnce(TEXT_NEU, '  return anzahl;', '  return text.length;')), 'zeichenzahl wurde beeintraechtigt');
    expectAcceptanceRejects('js-text', x(replaceOnce(TEXT_NEU, "for (const _codepoint of text) {", "for (const _codepoint of text.normalize('NFC')) {")), 'zeichenzahl wurde beeintraechtigt');
    expectAcceptanceRejects('js-text', x(replaceOnce(TEXT_NEU, "return text === '';", "return text.trim() === '';")), 'istLeer muss false ergeben');
    expectAcceptanceRejects('js-text', x(replaceOnce(TEXT_NEU, "  if (typeof text !== 'string') {\n    throw new TypeError('istLeer", "  if (typeof text !== 'string' && !(text instanceof String)) {\n    throw new TypeError('istLeer")), 'istLeer muss TypeError ausloesen: object');
    expectAcceptanceRejects('js-text', x(replaceOnce(TEXT_NEU, "  if (typeof text !== 'string') {\n    throw new TypeError('istLeer", "  if (text === null) {\n    throw new TypeError('istLeer")), 'istLeer muss TypeError ausloesen');
  });

  test('Pruef-Checkout: zusaetzliche Datei, Ordner statt Codedatei oder Abnahmedatei stoppen vor der Abnahme; die synthetischen Tests laufen', () => {
    const v = VORSTUFE['js-rechner'];
    const parsed = parsePackageV2(v.order, v.hash, v.bytes, v.sha256);
    const fresh = () => {
      const dir = checkout();
      applyPackageV2(dir, v.order, v.hash, parsed, { gitEnv: { ...ENV } });
      return dir;
    };

    const extra = fresh();
    writeFileSync(join(extra, 'notiz.txt'), 'x\n');
    throwsCode(() => checkAppliedCheckout(extra, ENV, AUFGABEN['js-rechner']), 'kette-pruef-checkout');

    for (const [ziel, fehler] of [['src/rechne.js', 'kette-code-datei'], ['agent-acceptance/issue-6301.mjs', 'kette-abnahme-datei']]) {
      const dir = fresh();
      rmSync(join(dir, ...ziel.split('/')));
      mkdirSync(join(dir, ...ziel.split('/')));
      const before = acceptanceStarts;
      throwsCode(() => acceptPackage(dir, v.order, v.hash, v.bytes, AUFGABEN['js-rechner']), fehler);
      assert.equal(acceptanceStarts, before);
    }

    // Die mitgelieferten synthetischen Testdateien beider Profile laufen im Pruef-Checkout gruen.
    for (const profil of Object.keys(AUFGABEN)) {
      const w = VORSTUFE[profil];
      const dir = checkout();
      applyPackageV2(dir, w.order, w.hash, parsePackageV2(w.order, w.hash, w.bytes, w.sha256), { gitEnv: { ...ENV } });
      const out = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(dir, ...AUFGABEN[profil].dateien[1].split('/'))], {
        cwd: dir, env: IS_WINDOWS ? { SystemRoot: own(process.env, 'SystemRoot') } : {}, timeout: 30_000, killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true,
      });
      assert.equal(out.status, 0, out.stdout + out.stderr);
      assert.match(out.stdout, /^# fail 0$/m);
      assert.match(out.stdout, profil === 'js-rechner' ? /^# pass 6$/m : /^# pass 11$/m);
    }
  });

  test('Fachlich negativ: Dateigrenzen, Blob, Pruef-Checkout, Ausgangscommit, Abnahmedatei und inaktives Profil', () => {
    const rOk = { 'src/rechne.js': Buffer.from(RECHNE_NEU), 'test/rechne.test.js': Buffer.from(RECHNE_TEST_NEU) };
    const order = VORSTUFE['js-rechner'].order;
    const hash = VORSTUFE['js-rechner'].hash;

    // Zusaetzliche nicht erlaubte Datei, Datei des anderen Profils, fehlende erlaubte Aenderung.
    assert.throws(() => packageFor('js-rechner', rOk, { extra: work => writeFileSync(join(work, 'README.md'), '# neu\n') }), error => error.code === 'paket-datei-neu');
    assert.throws(() => packageFor('js-rechner', { ...rOk, 'src/text.js': Buffer.from(TEXT_NEU) }), error => error.code === 'paket-fremde-aenderung');
    assert.throws(() => packageFor('js-text', { 'src/text.js': Buffer.from(TEXT_NEU), 'src/rechne.js': Buffer.from(RECHNE_NEU) }), error => error.code === 'paket-fremde-aenderung');
    assert.throws(() => packageFor('js-rechner', { 'src/rechne.js': Buffer.from(RECHNE_NEU) }), error => error.code === 'paket-unveraendert');

    // Falscher Git-Blob im Paket (Hash passend neu berechnet).
    const falscherBlob = editPackage(VORSTUFE['js-rechner'].text, data => {
      data.dateien[0].git_blob = MAIN_BLOBS['src/rechne.js'];
    });
    throwsCode(() => parsePackageV2(order, hash, falscherBlob, sha256(falscherBlob)), 'paket-git-blob');

    // Unsauberer Pruef-Checkout.
    const parsed = parsePackageV2(order, hash, VORSTUFE['js-rechner'].bytes, VORSTUFE['js-rechner'].sha256);
    const dirty = checkout();
    writeFileSync(join(dirty, 'notiz.txt'), 'x\n');
    throwsCode(() => applyPackageV2(dirty, order, hash, parsed, { gitEnv: { ...ENV } }), 'paket-status');

    // Falscher Ausgangscommit: Pruef-Checkout auf P.
    throwsCode(() => applyPackageV2(checkout(TEMPLATE_P), order, hash, parsed, { gitEnv: { ...ENV } }), 'paket-head');

    // Ausgetauschte Abnahmedatei, Codeaenderung unmittelbar vor der Abnahme.
    for (const [ziel, aendern, fehler] of [
      ['agent-acceptance/issue-6301.mjs', () => Buffer.from("console.log('A6.3-2: Abnahme js-rechner bestanden.');\n"), 'kette-abnahme-hash'],
      ['src/rechne.js', bytes => Buffer.concat([bytes, Buffer.from('// spaet\n')]), 'kette-code-blob'],
    ]) {
      const check = checkout();
      applyPackageV2(check, order, hash, parsed, { gitEnv: { ...ENV } });
      const abs = join(check, ...ziel.split('/'));
      writeFileSync(abs, aendern(readFileSync(abs)));
      const before = acceptanceStarts;
      throwsCode(() => acceptPackage(check, order, hash, VORSTUFE['js-rechner'].bytes, AUFGABEN['js-rechner']), fehler);
      assert.equal(acceptanceStarts, before, 'Abnahme wurde gestartet');
    }

    // Kontrolle: unveraendert angewendet besteht die Abnahme.
    const clean = checkout();
    applyPackageV2(clean, order, hash, parsed, { gitEnv: { ...ENV } });
    assert.deepEqual(acceptPackage(clean, order, hash, VORSTUFE['js-rechner'].bytes, AUFGABEN['js-rechner']).paket_sha256, VORSTUFE['js-rechner'].sha256);

    // Das echte inaktive js-text-Profil aus Elterncommit P.
    const trustedP = checkout(TEMPLATE_P, 'tp');
    throwsCode(() => orderFor(trustedP, PARENT, ENV, AUFGABEN['js-text']), 'auftrag-profil-inaktiv');
    // js-rechner auf P: anderer Ausgangscommit, also ein anderer Auftrag.
    assert.notEqual(orderSha256(orderFor(trustedP, PARENT, ENV, AUFGABEN['js-rechner'])), hash);
  });
}
