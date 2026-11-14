// Tests fuer scripts/agent-code-auftrag-abnahme.mjs (A6.4-2a).
//
// Alles offline und synthetisch: kein Claude-Aufruf, keine Netzanfrage, keine Zugangsdaten, kein
// GitHub-Schreibzugriff. Git laeuft nur in Temp-Repositorys mit isolierter Umgebung. Aus dem echten
// Repository werden nur die beiden Profile, die Policy-Vorlage und die alte Abnahme issue-38.mjs gelesen.
//
// Eingriffe zwischen den Schritten des Moduls: Das Modul hat keinen Testhaken. Die Tests ersetzen
// execFileSync und spawnSync von node:child_process und gleichen die benannten Importe mit
// syncBuiltinESMExports ab. So laeuft eine Manipulation genau nach einem bestimmten Git-Befehl des
// Moduls (nach dem Klon, nach dem Auschecken, nach dem letzten Git-Befehl von applyPackageV2), und
// jeder Abnahmestart wird gezaehlt. Jeder Eingriff muss ausgeliefert worden sein (Muss-Treffer).
//
// Was diese Tests NICHT zeigen: Isolation gegen gleichzeitige Schreiber, Prozessbaum-Isolation,
// Trennung ueber Benutzerrechte, GitHub-Actions-Einbindung, Paket-v2-Transport, K1 bis K4.

import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { orderSha256, resolveOrder } from '../scripts/agent-code-auftrag.mjs';
import { createPackageV2, prepareWorkspace } from '../scripts/agent-code-auftrag-paket.mjs';
import {
  ACCEPTANCE_FORMAT_LINE, ACCEPTANCE_MAX_OUTPUT_BYTES, ACCEPTANCE_SUCCESS, ACCEPTANCE_TIMEOUT_MS, acceptOrderPackage, requireAccepted,
} from '../scripts/agent-code-auftrag-abnahme.mjs';

// Echte Funktionen, vor jedem Eingriff festgehalten. Die Testhelfer benutzen nur diese.
const EXEC = cp.execFileSync;
const SPAWN = cp.spawnSync;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_PATH = join(ROOT, 'scripts', 'agent-code-auftrag-abnahme.mjs');
const IS_WINDOWS = process.platform === 'win32';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const gitBlobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
const slash = path => path.split(sep).join('/');
// Diese Variablen ergaenzt libuv unter Windows selbst im Kindprozess (gemessen 13.11.2026).
const LIBUV_WINDOWS = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SystemRoot', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];

// ---------------------------------------------------------------------------
// Synthetische Quellen (Vorstufe statt Claude)
// ---------------------------------------------------------------------------

const RECHNE_ALT = '// Synthetischer Rechner fuer A6.4-2a.\nfunction addiere(a, b) {\n  return a + b;\n}\n\nmodule.exports = { addiere };\n';
const RECHNE_NEU = '// Synthetischer Rechner fuer A6.4-2a.\nfunction addiere(a, b) {\n  return a + b;\n}\n\nfunction quadrat(a) {\n  return a * a;\n}\n\nmodule.exports = { addiere, quadrat };\n';
const RECHNE_TEST_ALT = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { addiere } = require('../src/rechne.js');\n\ntest('addiere', () => assert.equal(addiere(2, 3), 5));\n";
const RECHNE_TEST_NEU = `${RECHNE_TEST_ALT}\ntest('quadrat', () => assert.equal(require('../src/rechne.js').quadrat(3), 9));\n`;
const TEXT_ALT = "// Synthetisches Textmodul fuer A6.4-2a.\nfunction zeichenzahl(text) {\n  if (typeof text !== 'string') {\n    throw new TypeError('Zeichenkette erwartet');\n  }\n\n  return [...text].length;\n}\n\nmodule.exports = { zeichenzahl };\n";
const TEXT_NEU = TEXT_ALT.replace('module.exports = { zeichenzahl };', "function istLeer(text) {\n  if (typeof text !== 'string') {\n    throw new TypeError('Zeichenkette erwartet');\n  }\n\n  return text === '';\n}\n\nmodule.exports = { zeichenzahl, istLeer };");
const TEXT_TEST_ALT = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { zeichenzahl } = require('../src/text.js');\n\ntest('zeichenzahl', () => assert.equal(zeichenzahl('ab'), 2));\n";
const TEXT_TEST_NEU = `${TEXT_TEST_ALT}\ntest('istLeer', () => assert.equal(require('../src/text.js').istLeer(''), true));\n`;

// A1: Agentencode gibt beim Laden die Erfolgszeile aus und beendet den Prozess mit Exitcode 0.
const ANGRIFF_A1 = `process.stdout.write(${JSON.stringify(ACCEPTANCE_SUCCESS)});\nprocess.exit(0);\n${RECHNE_NEU}`;
// A2: Agentencode liefert falsche Ergebnisse und schaltet beim Laden die Assertions des Prozesses ab.
const ANGRIFF_A2 = [
  "const strikt = require('node:assert').strict;",
  "for (const name of ['strictEqual', 'equal', 'deepEqual', 'deepStrictEqual', 'ok']) {",
  '  strikt[name] = () => {};',
  '}',
  RECHNE_NEU.replace('return a * a;', 'return a * a + 1;'),
].join('\n');

const AENDERUNG = Object.freeze({
  rechner: { 'src/rechne.js': RECHNE_NEU, 'test/rechne.test.js': RECHNE_TEST_NEU },
  text: { 'src/text.js': TEXT_NEU, 'test/text.test.js': TEXT_TEST_NEU },
  rechnerFalsch: { 'src/rechne.js': RECHNE_NEU.replace('return a * a;', 'return a === 3 ? 10 : a * a;'), 'test/rechne.test.js': RECHNE_TEST_NEU },
  textFalsch: { 'src/text.js': TEXT_NEU.replace("return text === '';", "return text.trim() === '';"), 'test/text.test.js': TEXT_TEST_NEU },
  a1: { 'src/rechne.js': ANGRIFF_A1, 'test/rechne.test.js': RECHNE_TEST_NEU },
  a2: { 'src/rechne.js': ANGRIFF_A2, 'test/rechne.test.js': RECHNE_TEST_NEU },
});

// ---------------------------------------------------------------------------
// Synthetische Abnahmedateien (im Ausgangscommit gebunden)
// ---------------------------------------------------------------------------

// v2-Treiber js-rechner: Agentencode nur im Kindprozess, Zufallseingaben ueber stdin, Bewertung hier.
const V2_RECHNER = ACCEPTANCE_FORMAT_LINE + String.raw`// Synthetische v2-Abnahme fuer js-rechner (A6.4-2a). Der Agentencode laeuft nur im Kindprozess.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const k = v => (Object.is(v, -0) ? '-0' : String(v));
const ziel = fileURLToPath(new URL('../src/rechne.js', import.meta.url));
const eingaben = [0, -0, 3, -4, 0.5, -1.5, Infinity, -Infinity, NaN];

for (let i = 0; i < 20; i += 1) {
  eingaben.push(randomInt(-1000, 1001));
}

const sonde = [
  'const k = v => (Object.is(v, -0) ? "-0" : String(v));',
  'const m = require(' + JSON.stringify(ziel) + ');',
  'const e = JSON.parse(require("node:fs").readFileSync(0, "utf8"));',
  'process.stdout.write(JSON.stringify({ typ: [typeof m.addiere, typeof m.quadrat], werte: e.map(x => k(m.quadrat(x === "-0" ? -0 : Number(x)))), summe: k(m.addiere(2, 3)) }));',
].join('\n');
const out = spawnSync(process.execPath, ['-e', sonde], { input: JSON.stringify(eingaben.map(k)), env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });

if (out.error !== undefined || out.status !== 0 || out.signal !== null) {
  throw new Error('Sonde fehlgeschlagen: ' + String(out.status) + ' ' + String(out.stderr).slice(0, 300));
}

const antwort = JSON.parse(out.stdout);
assert.deepEqual(antwort.typ, ['function', 'function'], 'Exporte fehlen');
assert.deepEqual(antwort.werte, eingaben.map(x => k(x * x)), 'quadrat liefert falsche Ergebnisse');
assert.equal(antwort.summe, '5', 'addiere wurde beeintraechtigt');
process.stdout.write('A6-ABNAHME-BESTANDEN\n');
`;

const V2_TEXT = ACCEPTANCE_FORMAT_LINE + String.raw`// Synthetische v2-Abnahme fuer js-text (A6.4-2a). Der Agentencode laeuft nur im Kindprozess.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ziel = fileURLToPath(new URL('../src/text.js', import.meta.url));
const z = String.fromCodePoint;
const texte = ['', ' ', 'Hallo', z(0xe4, 0xf6), z(0x1f600), 'a' + z(0x308), '\t', '0'];

for (let i = 0; i < 10; i += 1) {
  texte.push(z(randomInt(0x21, 0x7f), randomInt(0x21, 0x7f)).repeat(randomInt(0, 4)));
}

const sonde = [
  'const m = require(' + JSON.stringify(ziel) + ');',
  'const e = JSON.parse(require("node:fs").readFileSync(0, "utf8"));',
  'const wirft = (fn, wert) => { try { fn(wert); return false; } catch (f) { return f instanceof TypeError; } };',
  'const ungueltig = [null, undefined, 0, false, {}, [], Symbol("x"), new String("")];',
  'process.stdout.write(JSON.stringify({ typ: [typeof m.zeichenzahl, typeof m.istLeer], zahl: e.map(t => m.zeichenzahl(t)), leer: e.map(t => m.istLeer(t)), fehler: ungueltig.map(w => [wirft(m.zeichenzahl, w), wirft(m.istLeer, w)]) }));',
].join('\n');
const out = spawnSync(process.execPath, ['-e', sonde], { input: JSON.stringify(texte), env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });

if (out.error !== undefined || out.status !== 0 || out.signal !== null) {
  throw new Error('Sonde fehlgeschlagen: ' + String(out.status) + ' ' + String(out.stderr).slice(0, 300));
}

const antwort = JSON.parse(out.stdout);
assert.deepEqual(antwort.typ, ['function', 'function'], 'Exporte fehlen');
assert.deepEqual(antwort.zahl, texte.map(t => [...t].length), 'zeichenzahl wurde beeintraechtigt');
assert.deepEqual(antwort.leer, texte.map(t => t === ''), 'istLeer liefert falsche Ergebnisse');
assert.ok(antwort.fehler.length === 8 && antwort.fehler.every(([a, b]) => a === true && b === true), 'TypeError fehlt');
process.stdout.write('A6-ABNAHME-BESTANDEN\n');
`;

// Altformat wie agent-acceptance/issue-38.mjs: laedt den Agentencode im eigenen Prozess.
const V1_RECHNER = String.raw`// Altformat ohne v2-Kennung, gebaut wie agent-acceptance/issue-38.mjs. Laedt den Agentencode im eigenen Prozess.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { quadrat } = require('../src/rechne.js');

for (const [a, erwartet] of [[3, 9], [-4, 16], [0.5, 0.25]]) {
  assert.strictEqual(quadrat(a), erwartet, 'quadrat(' + a + ') falsch');
}

process.stdout.write('A6-ABNAHME-BESTANDEN\n');
`;

const v2 = body => `${ACCEPTANCE_FORMAT_LINE}// Synthetischer Prozessfall (A6.4-2a).\n${body}\n`;

const ENKEL = String.raw`import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const kind = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
writeFileSync(new URL('../../enkel.pid', import.meta.url), String(kind.pid));
kind.unref();
process.stdout.write('A6-ABNAHME-BESTANDEN\n');`;

const UMGEBUNG = String.raw`const schluessel = Object.keys(process.env).sort();
const erlaubt = process.platform === 'win32' ? ${JSON.stringify(LIBUV_WINDOWS)} : [];
const ok = schluessel.every(k => erlaubt.includes(k)) && process.execArgv.length === 0 && process.argv.length === 2;
if (ok) { process.stdout.write('A6-ABNAHME-BESTANDEN\n'); } else { process.stderr.write(JSON.stringify(schluessel)); process.exitCode = 7; }`;

const OK = "process.stdout.write('A6-ABNAHME-BESTANDEN\\n');";

const AUFGABEN = Object.freeze({
  rechner: { issue: 6401, profil: 'js-rechner', abnahme: V2_RECHNER },
  text: { issue: 6402, profil: 'js-text', abnahme: V2_TEXT },
  altformat: { issue: 6403, profil: 'js-rechner', abnahme: V1_RECHNER },
  ohneKennung: { issue: 6404, profil: 'js-rechner', abnahme: V2_RECHNER.slice(ACCEPTANCE_FORMAT_LINE.length) },
  falscheKennung: { issue: 6405, profil: 'js-rechner', abnahme: `// agent-abnahme-format: v1\n${V2_RECHNER.slice(ACCEPTANCE_FORMAT_LINE.length)}` },
  kennungVersetzt: { issue: 6406, profil: 'js-rechner', abnahme: `\n${V2_RECHNER}` },
  exitcode: { issue: 6410, profil: 'js-rechner', abnahme: v2('process.exitCode = 3;') },
  signal: { issue: 6411, profil: 'js-rechner', abnahme: v2("process.kill(process.pid, 'SIGKILL');") },
  stderr: { issue: 6412, profil: 'js-rechner', abnahme: v2(`${OK}\nprocess.stderr.write('Warnung\\n');`) },
  ohneZeilenende: { issue: 6413, profil: 'js-rechner', abnahme: v2("process.stdout.write('A6-ABNAHME-BESTANDEN');") },
  ohneAusgabe: { issue: 6414, profil: 'js-rechner', abnahme: v2('// keine Ausgabe') },
  doppelt: { issue: 6415, profil: 'js-rechner', abnahme: v2(`${OK}\n${OK}`) },
  schleife: { issue: 6416, profil: 'js-rechner', abnahme: v2('for (;;) {}') },
  puffer: { issue: 6417, profil: 'js-rechner', abnahme: v2(`process.stdout.write('x'.repeat(${ACCEPTANCE_MAX_OUTPUT_BYTES + 4096}));`) },
  enkel: { issue: 6418, profil: 'js-rechner', abnahme: v2(ENKEL) },
  umgebung: { issue: 6419, profil: 'js-rechner', abnahme: v2(UMGEBUNG) },
});

const aufgabeName = name => {
  const aufgabe = AUFGABEN[name];
  return {
    ...aufgabe,
    runId: String(900000000000 + aufgabe.issue),
    titel: `Synthetisch A6.4-2a: Aufgabe ${aufgabe.issue}`,
    text: `Kuenstlicher Auftrag fuer die Abnahmetests (${name}). Bitte die vorgesehene Funktion ergaenzen.`,
  };
};

const abnahmePfad = issue => `agent-acceptance/issue-${issue}.mjs`;

// ---------------------------------------------------------------------------
// Profile, Policy, synthetisches Repository
// ---------------------------------------------------------------------------

const PROFIL_RECHNER = readFileSync(join(ROOT, 'agent-profiles', 'js-rechner.json'));
const PROFIL_TEXT = readFileSync(join(ROOT, 'agent-profiles', 'js-text.json'));
const AKTIV_FALSE = Buffer.from('"aktiv": false', 'utf8');

function activate(bytes) {
  const first = bytes.indexOf(AKTIV_FALSE);
  assert.ok(first >= 0 && bytes.indexOf(AKTIV_FALSE, first + 1) < 0, 'js-text muss auf main genau einmal "aktiv": false tragen');
  return Buffer.concat([bytes.subarray(0, first), Buffer.from('"aktiv": true'), bytes.subarray(first + AKTIV_FALSE.length)]);
}

const DRAFT_POLICY = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'agent-policy.entwurf.json'), 'utf8'));
const POLICY_BYTES = Buffer.from(`${JSON.stringify({ ...DRAFT_POLICY, skript_hashes: { 'scripts/agent-profile.mjs': 'a'.repeat(64) } }, null, 2)}\n`, 'utf8');

function baseFiles(textProfil) {
  const files = {
    '.github/agent/policy.json': POLICY_BYTES,
    'agent-profiles/js-rechner.json': PROFIL_RECHNER,
    'agent-profiles/js-text.json': textProfil,
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

const COMMIT_DATE = '2026-11-13T08:00:00Z';
const APPROVAL_TIME = '2026-11-13T08:33:39Z';
const RUN_CREATED = '2026-11-13T08:33:41Z';
const NOW = Date.parse('2026-11-13T08:40:00Z');
const OWNER_USER = Object.freeze({ login: 'noah04091', type: 'User' });
const REPO_NAME = 'noah04091/agenten-probe';

function gitEnvFor(home) {
  const env = {};

  for (const key of ['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']) {
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

let BASE_DIR;
let ENV;
let REPO;
let BASIS;
let PARENT;
let TRUSTED;
let TRUSTED_P;

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
    GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE,
  });
}

// Eigenstaendiger Klon ohne Remote, detached auf sha, wie ein frischer Checkout.
function cloneAt(dir, sha) {
  EXEC('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', REPO, dir], { cwd: BASE_DIR, env: ENV, stdio: 'ignore' });
  git(dir, ['checkout', '-q', '--detach', sha]);
  git(dir, ['remote', 'remove', 'origin']);
  return dir;
}

let counter = 0;
const newDir = prefix => mkdtempSync(join(BASE_DIR, `${prefix}${(counter += 1)}-`));

const ORDERS = new Map();

function orderFor(name, root = TRUSTED, baseSha = BASIS) {
  const key = `${name}|${root}|${baseSha}`;

  if (!ORDERS.has(key)) {
    const task = aufgabeName(name);
    const order = resolveOrder({
      root,
      baseSha,
      gitEnv: { ...ENV },
      repository: REPO_NAME,
      event: {
        action: 'labeled', label: { name: 'bot-auftrag' }, sender: { ...OWNER_USER }, repository: { full_name: REPO_NAME },
        issue: { number: task.issue, user: { login: 'noah04091' }, title: task.titel, body: task.text, updated_at: APPROVAL_TIME },
      },
      issue: {
        number: task.issue, state: 'open', title: task.titel, body: task.text, updated_at: APPROVAL_TIME, comments: 0, user: { ...OWNER_USER },
        labels: [{ name: 'bot-auftrag' }, { name: `agent:${task.profil}` }],
      },
      events: [
        { id: task.issue * 100, event: 'assigned', created_at: '2026-11-13T08:00:00Z', actor: { ...OWNER_USER }, performed_via_github_app: null },
        { id: task.issue * 100 + 1, event: 'labeled', created_at: '2026-11-13T08:30:00Z', actor: { ...OWNER_USER }, label: { name: `agent:${task.profil}`, color: 'ededed' }, performed_via_github_app: null },
        { id: task.issue * 100 + 2, event: 'labeled', created_at: APPROVAL_TIME, actor: { ...OWNER_USER }, label: { name: 'bot-auftrag', color: 'ededed' }, performed_via_github_app: null },
      ],
      run: { id: task.runId, attempt: 1, createdAt: RUN_CREATED },
      now: new Date(NOW),
    });
    ORDERS.set(key, order);
  }

  return ORDERS.get(key);
}

const PAKETE = new Map();

// Paket aus einem Arbeitsordner nach prepareWorkspace, wie nach Claude. Ergebnis wird je Fall gemerkt.
function paket(name, aenderung = AUFGABEN[name].profil === 'js-text' ? 'text' : 'rechner') {
  const key = `${name}|${aenderung}`;

  if (!PAKETE.has(key)) {
    const order = orderFor(name);
    const hash = orderSha256(order);
    const work = prepareWorkspace(TRUSTED, order, hash, join(newDir('w'), 'arbeit'), { gitEnv: { ...ENV } }).arbeitsordner;

    for (const [pfad, text] of Object.entries(AENDERUNG[aenderung])) {
      writeFileSync(join(work, ...pfad.split('/')), text);
    }

    const pkg = createPackageV2(TRUSTED, order, hash, work);
    PAKETE.set(key, Object.freeze({ order, hash, text: pkg.text, sha256: pkg.sha256, aenderung }));
  }

  const p = PAKETE.get(key);
  return { ...p, bytes: Buffer.from(p.text, 'utf8') };
}

function eingabe(p, extra = {}) {
  return {
    trustedRoot: TRUSTED,
    checkParent: newDir('p'),
    order: p.order,
    expectedSha256: p.hash,
    packageBytes: p.bytes,
    packageSha256: p.sha256,
    gitEnv: { ...ENV },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Eingriffe zwischen den Schritten des Moduls
// ---------------------------------------------------------------------------

// Unterbefehl eines Git-Aufrufs ohne die globalen Schalter.
function sub(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--no-replace-objects') {
      continue;
    }

    if (args[i] === '-c') {
      i += 1;
      continue;
    }

    return args[i];
  }

  return undefined;
}

const NACH_KLON = args => sub(args) === 'clone';
const NACH_CHECKOUT = args => sub(args) === 'checkout';
// Letzter Git-Befehl von applyPackageV2 (checkAfterWrite): der Patch.
const NACH_IMPORT = args => sub(args) === 'diff' && args.includes('--binary');

// Fuehrt acceptOrderPackage aus. eingriffe: [{ wann, tu }], tu erhaelt den Pruef-Checkout.
function lauf(input, eingriffe = []) {
  const offen = eingriffe.map(e => ({ ...e, erledigt: false }));
  const protokoll = { git: [], abnahmen: [], checkout: null };
  let ergebnis;
  let fehler;

  cp.execFileSync = function execFileSync(file, args, options) {
    const result = EXEC(file, args, options);

    if (file === 'git') {
      protokoll.git.push({ args: [...args], cwd: options?.cwd, env: { ...options?.env } });

      if (NACH_KLON(args)) {
        protokoll.checkout = args[args.length - 1];
      }

      for (const e of offen) {
        if (!e.erledigt && e.wann(args)) {
          e.erledigt = true;
          e.tu(protokoll.checkout);
        }
      }
    }

    return result;
  };
  cp.spawnSync = function spawnSync(file, args, options) {
    if (file === process.execPath) {
      protokoll.abnahmen.push({ file, args: [...args], options: { ...options } });
    }

    return SPAWN(file, args, options);
  };
  syncBuiltinESMExports();

  try {
    ergebnis = acceptOrderPackage(input);
  } catch (error) {
    fehler = error;
  } finally {
    cp.execFileSync = EXEC;
    cp.spawnSync = SPAWN;
    syncBuiltinESMExports();
  }

  offen.forEach((e, i) => assert.ok(e.erledigt, `Eingriff ${i} wurde nicht ausgeliefert`));
  return { ergebnis, fehler, protokoll };
}

function erwarte(r, code) {
  assert.ok(r.fehler !== undefined, `keine Ablehnung, erwartet ${code}`);
  assert.equal(r.fehler.code, code, `${r.fehler.code}: ${r.fehler.message}`);
  assert.equal(r.fehler.name, 'OrderError');
  assert.equal(r.ergebnis, undefined);
  return r.fehler;
}

function ohneAbnahme(r, code) {
  erwarte(r, code);
  assert.deepEqual(r.protokoll.abnahmen, [], 'Abnahme wurde trotz Ablehnung gestartet');
}

// Alle Dateien unter dir mit Inhalt, fuer den Vergleich vorher und nachher.
function snapshot(dir) {
  const result = [];
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const stat = lstatSync(childAbs);
      result.push(stat.isDirectory() ? `${childRel}/` : `${childRel} ${sha256(readFileSync(childAbs))} ${stat.mode}`);

      if (stat.isDirectory()) {
        visit(childAbs, childRel);
      }
    }
  };

  visit(dir, '');
  return result;
}

const fileIn = (checkout, pfad) => join(checkout, ...pfad.split('/'));
const symlinksAllowed = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'agent-abnahme-symlink-'));

  try {
    symlinkSync(join(probe, 'ziel'), join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

before(() => {
  BASE_DIR = mkdtempSync(join(tmpdir(), 'agent-auftrag-abnahme-test-'));
  const home = join(BASE_DIR, 'home');
  mkdirSync(join(home, 'xdg'), { recursive: true });
  writeFileSync(join(home, 'leer.gitconfig'), '');
  ENV = gitEnvFor(home);
  REPO = join(BASE_DIR, 'repo');
  mkdirSync(REPO);
  git(REPO, ['init', '-q']);
  PARENT = commitFiles(REPO, baseFiles(PROFIL_TEXT), [], 'Synthetischer Elterncommit: js-text inaktiv');
  BASIS = commitFiles(REPO, baseFiles(activate(PROFIL_TEXT)), [PARENT], 'Synthetischer Ausgangscommit: js-text synthetisch aktiv');
  git(REPO, ['update-ref', 'refs/heads/main', BASIS]);
  git(REPO, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  TRUSTED = cloneAt(join(BASE_DIR, 'vertraut'), BASIS);
  TRUSTED_P = cloneAt(join(BASE_DIR, 'vertraut-p'), PARENT);
});

after(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Positive Laeufe beider Profile
// ---------------------------------------------------------------------------

for (const [name, profil] of [['rechner', 'js-rechner'], ['text', 'js-text']]) {
  test(`Positiv ${profil}: Auftrag, Paket v2, eigener Checkout, v2-Abnahme, eingefrorener Nachweis`, () => {
    const p = paket(name);
    const vorher = snapshot(TRUSTED);
    const input = eingabe(p);
    const r = lauf(input);
    assert.equal(r.fehler, undefined, r.fehler?.message);
    const nachweis = r.ergebnis;

    // Nachweis: genau die vorgesehenen Felder, tief eingefroren, gebunden.
    assert.deepEqual(Object.keys(nachweis), ['auftrag_sha256', 'paket_sha256', 'base_sha', 'abnahme_pfad', 'abnahme_blob', 'abnahme_sha256', 'dateien', 'ergebnis']);
    assert.equal(nachweis.auftrag_sha256, p.hash);
    assert.equal(nachweis.paket_sha256, sha256(p.bytes));
    assert.equal(nachweis.base_sha, BASIS);
    assert.equal(nachweis.abnahme_pfad, abnahmePfad(AUFGABEN[name].issue));
    assert.equal(nachweis.abnahme_sha256, sha256(Buffer.from(AUFGABEN[name].abnahme)));
    assert.equal(nachweis.abnahme_blob, gitBlobId(Buffer.from(AUFGABEN[name].abnahme)));
    assert.equal(nachweis.ergebnis, 'bestanden');
    assert.deepEqual(nachweis.dateien, Object.entries(AENDERUNG[name]).map(([pfad, text]) => ({ pfad, git_blob: gitBlobId(Buffer.from(text)) })));
    assert.ok(Object.isFrozen(nachweis) && Object.isFrozen(nachweis.dateien) && nachweis.dateien.every(Object.isFrozen));
    assert.equal(requireAccepted(nachweis, p.order, p.hash), nachweis);

    // Eigener Checkout im Pruefordner, Klon mit den vorgesehenen Schaltern und leerer Vorlage.
    const sessions = readdirSync(input.checkParent);
    assert.equal(sessions.length, 1);
    const session = join(input.checkParent, sessions[0]);
    const same = (a, b) => slash(a).toLowerCase() === slash(b).toLowerCase();
    assert.ok(same(r.protokoll.checkout, join(session, 'checkout')));
    const clone = r.protokoll.git.find(call => NACH_KLON(call.args));
    for (const flag of ['--no-local', '--no-hardlinks', '--no-checkout', '-c', 'core.fsmonitor=false']) {
      assert.ok(clone.args.includes(flag), `Klon ohne ${flag}`);
    }
    const vorlage = clone.args.find(arg => arg.startsWith('--template=')).slice('--template='.length);
    assert.deepEqual(readdirSync(vorlage), [], 'Vorlage nicht leer');
    assert.ok(same(clone.args[clone.args.length - 2], TRUSTED), 'Klon nicht vom geprueften trustedRoot');

    // Jeder Git-Aufruf des Moduls laeuft mit der eigenen Umgebung, nie mit der des Aufrufers.
    for (const call of r.protokoll.git) {
      assert.ok(slash(call.env.HOME).toLowerCase().startsWith(slash(session).toLowerCase()), 'Git-Aufruf mit fremdem HOME');
      assert.ok(!Object.keys(call.env).some(key => key.startsWith('GIT_AUTHOR') || key === 'NODE_OPTIONS'));
      if (sub(call.args) !== 'config') {
        assert.ok(call.args.includes('--no-replace-objects'));
      }
    }

    // Genau ein Abnahmestart: gebundene Datei im eigenen Checkout, feste Prozessoptionen.
    assert.equal(r.protokoll.abnahmen.length, 1);
    const start = r.protokoll.abnahmen[0];
    assert.equal(start.file, process.execPath);
    assert.deepEqual(start.args, [fileIn(r.protokoll.checkout, nachweis.abnahme_pfad)]);
    assert.equal(start.options.cwd, r.protokoll.checkout);
    assert.deepEqual(Object.keys(start.options.env), IS_WINDOWS ? ['SystemRoot'] : []);
    assert.deepEqual(start.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(start.options.shell, false);
    assert.equal(start.options.timeout, 10_000);
    assert.equal(start.options.killSignal, 'SIGKILL');
    assert.equal(start.options.maxBuffer, 65_536);

    // Kein Schreiben in den vertrauenswuerdigen Checkout.
    assert.deepEqual(snapshot(TRUSTED), vorher);
  });
}

test('Positiv: feste Konstanten des Abnahmeformats v2 und der Prozessausfuehrung', () => {
  assert.equal(ACCEPTANCE_SUCCESS, 'A6-ABNAHME-BESTANDEN\n');
  assert.equal(ACCEPTANCE_FORMAT_LINE, '// agent-abnahme-format: v2\n');
  assert.equal(ACCEPTANCE_TIMEOUT_MS, 10_000);
  assert.equal(ACCEPTANCE_MAX_OUTPUT_BYTES, 65_536);
});

// ---------------------------------------------------------------------------
// Angriffe A1 und A2, Altformat
// ---------------------------------------------------------------------------

// Gegenprobe ausserhalb des Moduls: Im Altformat bestehen beide Angriffe tatsaechlich.
function runOldFormatDirectly(aenderung) {
  const dir = cloneAt(join(newDir('alt'), 'c'), BASIS);

  for (const [pfad, text] of Object.entries(AENDERUNG[aenderung])) {
    writeFileSync(fileIn(dir, pfad), text);
  }

  const out = SPAWN(process.execPath, [fileIn(dir, abnahmePfad(AUFGABEN.altformat.issue))], {
    cwd: dir, env: IS_WINDOWS ? { SystemRoot: own(process.env, 'SystemRoot') } : {}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

test('Altformat: A1 (Erfolgszeile beim Laden, Exitcode 0) wird vor dem Start der alten Abnahme abgelehnt', () => {
  // Gegenprobe: direkt gestartet besteht die alte Abnahme den Angriff.
  assert.deepEqual(runOldFormatDirectly('a1'), { status: 0, stdout: ACCEPTANCE_SUCCESS, stderr: '' });
  ohneAbnahme(lauf(eingabe(paket('altformat', 'a1'))), 'abnahme-format');
});

test('Altformat: A2 (Assertions im gemeinsamen Prozess abgeschaltet, falsches Ergebnis) wird vor dem Start abgelehnt', () => {
  assert.deepEqual(runOldFormatDirectly('a2'), { status: 0, stdout: ACCEPTANCE_SUCCESS, stderr: '' });
  ohneAbnahme(lauf(eingabe(paket('altformat', 'a2'))), 'abnahme-format');
});

test('Altformat: auch mit ehrlichem Code startet eine Datei ohne v2-Kennung nicht', () => {
  ohneAbnahme(lauf(eingabe(paket('altformat'))), 'abnahme-format');
  // Muss-Treffer: die echte alte Abnahme auf main ist Altformat und wuerde ebenso abgelehnt.
  const issue38 = readFileSync(join(ROOT, 'agent-acceptance', 'issue-38.mjs'));
  assert.ok(!issue38.subarray(0, ACCEPTANCE_FORMAT_LINE.length).equals(Buffer.from(ACCEPTANCE_FORMAT_LINE)));
  assert.ok(issue38.includes("require('../src/rechne.js')"), 'Gegenprobe: alte Abnahme laedt den Agentencode im eigenen Prozess');
});

for (const [name, beschreibung] of [['ohneKennung', 'fehlende v2-Kennung'], ['falscheKennung', 'falsche Kennung v1'], ['kennungVersetzt', 'Kennung nicht am Anfang']]) {
  test(`Format: ${beschreibung} wird vor dem Start abgelehnt, obwohl der Treiber sonst bestehen wuerde`, () => {
    ohneAbnahme(lauf(eingabe(paket(name))), 'abnahme-format');
  });
}

test('v2: A1 besteht nicht, weil der Agentencode nur im Kindprozess des Treibers laeuft', () => {
  const r = lauf(eingabe(paket('rechner', 'a1')));
  erwarte(r, 'abnahme-exitcode');
  assert.equal(r.protokoll.abnahmen.length, 1);
  assert.match(r.fehler.bericht.stderr_anfang, /JSON|Unexpected/);
});

test('v2: A2 besteht nicht, weil abgeschaltete Assertions nur den Kindprozess betreffen', () => {
  const r = lauf(eingabe(paket('rechner', 'a2')));
  erwarte(r, 'abnahme-exitcode');
  assert.match(r.fehler.bericht.stderr_anfang, /quadrat liefert falsche Ergebnisse/);
});

test('Fachlich negativ: falscher Code beider Profile wird von den v2-Treibern erkannt', () => {
  erwarte(lauf(eingabe(paket('rechner', 'rechnerFalsch'))), 'abnahme-exitcode');
  const r = lauf(eingabe(paket('text', 'textFalsch')));
  erwarte(r, 'abnahme-exitcode');
  assert.match(r.fehler.bericht.stderr_anfang, /istLeer liefert falsche Ergebnisse/);
});

// ---------------------------------------------------------------------------
// Prozess
// ---------------------------------------------------------------------------

test('Prozess: Exitcode ungleich 0, stderr, nicht exakte, fehlende und zusaetzliche Ausgabe', () => {
  for (const [name, code] of [
    ['exitcode', 'abnahme-exitcode'],
    ['stderr', 'abnahme-stderr'],
    ['ohneZeilenende', 'abnahme-ausgabe'],
    ['ohneAusgabe', 'abnahme-ausgabe'],
    ['doppelt', 'abnahme-ausgabe'],
  ]) {
    const r = lauf(eingabe(paket(name)));
    erwarte(r, code);
    assert.equal(r.protokoll.abnahmen.length, 1, name);
    assert.equal(r.fehler.bericht.fehler, null, name);
  }
});

test('Prozess: Signalabbruch wird abgelehnt (unter Windows als Exitcode ungleich 0)', () => {
  const r = lauf(eingabe(paket('signal')));
  erwarte(r, IS_WINDOWS ? 'abnahme-exitcode' : 'abnahme-signal');
  assert.equal(r.fehler.bericht.signal, IS_WINDOWS ? null : 'SIGKILL');
});

test('Prozess: Endlosschleife endet nach dem Zeitlimit mit ETIMEDOUT und SIGKILL', () => {
  const start = Date.now();
  const r = lauf(eingabe(paket('schleife')));
  erwarte(r, 'abnahme-prozess-fehler');
  assert.equal(r.fehler.bericht.fehler, 'ETIMEDOUT');
  assert.equal(r.fehler.bericht.signal, 'SIGKILL');
  assert.ok(Date.now() - start >= ACCEPTANCE_TIMEOUT_MS);
});

test('Prozess: Ausgabe ueber 64 KiB endet mit ENOBUFS', () => {
  const r = lauf(eingabe(paket('puffer')));
  erwarte(r, 'abnahme-prozess-fehler');
  assert.equal(r.fehler.bericht.fehler, 'ENOBUFS');
});

test('Prozess: Enkelprozess haelt die Pipe offen, ETIMEDOUT trotz status 0, signal null und exakter Erfolgsausgabe', () => {
  const input = eingabe(paket('enkel'));
  let pid;

  try {
    const r = lauf(input);
    const fehler = erwarte(r, 'abnahme-prozess-fehler');
    pid = Number(readFileSync(join(input.checkParent, readdirSync(input.checkParent)[0], 'enkel.pid'), 'utf8'));
    // Genau der von Terminal 1 belegte Fall: ohne die Pruefung von out.error waere das ein Erfolg.
    assert.deepEqual(
      { fehler: fehler.bericht.fehler, status: fehler.bericht.status, signal: fehler.bericht.signal, stdout: fehler.bericht.stdout_zeichen, stderr: fehler.bericht.stderr_zeichen },
      { fehler: 'ETIMEDOUT', status: 0, signal: null, stdout: ACCEPTANCE_SUCCESS.length, stderr: 0 },
    );
  } finally {
    // Nur der eigene, von dieser Abnahme gestartete Enkelprozess.
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // bereits beendet
      }
    }
  }
});

test('Prozess: die Umgebung des Aufrufers (NODE_OPTIONS, NODE_PATH, Geheimnisse) erreicht die Abnahme nicht', () => {
  const preload = join(newDir('preload'), 'vorgeladen.cjs');
  writeFileSync(preload, "process.stdout.write('VORGELADEN\\n');\n");
  const alt = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH, A642_GEHEIM: process.env.A642_GEHEIM };
  process.env.NODE_OPTIONS = `--require ${preload}`;
  process.env.NODE_PATH = BASE_DIR;
  process.env.A642_GEHEIM = 'geheim-geheim-geheim';

  try {
    const r = lauf(eingabe(paket('umgebung')));
    assert.equal(r.fehler, undefined, r.fehler?.message);
  } finally {
    for (const [key, value] of Object.entries(alt)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('Prozess: Git-Umgebung mit NODE_OPTIONS, GIT_DIR oder ohne Isolation wird vor jedem Schritt abgelehnt', () => {
  const p = paket('rechner');

  for (const gitEnv of [
    { ...ENV, NODE_OPTIONS: '--require x' },
    { ...ENV, GIT_DIR: BASE_DIR },
    { ...ENV, GIT_CONFIG_PARAMETERS: "'core.fsmonitor=x'" },
    { ...ENV, GIT_CONFIG_NOSYSTEM: '0' },
    { ...ENV, GIT_CONFIG_GLOBAL: join(BASE_DIR, 'fremd.gitconfig') },
    { ...ENV, PATH: 42 },
    null,
  ]) {
    const input = eingabe(p, { gitEnv });
    const r = lauf(input);
    ohneAbnahme(r, 'abnahme-git-umgebung');
    assert.deepEqual(r.protokoll.git, []);
    assert.deepEqual(readdirSync(input.checkParent), [], 'Sitzung trotz Ablehnung angelegt');
  }
});

// ---------------------------------------------------------------------------
// Auftrag, Paket, Eingabe, Nachweis
// ---------------------------------------------------------------------------

test('Auftrag und Paket: ungepruefter Auftrag, falscher Hash, fremdes, manipuliertes oder falsch gebundenes Paket', () => {
  const p = paket('rechner');
  const fremd = paket('text');
  const kopie = JSON.parse(JSON.stringify(p.order));
  const edit = fn => {
    const data = JSON.parse(p.text);
    fn(data);
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
    return { packageBytes: bytes, packageSha256: sha256(bytes) };
  };
  const tampered = Buffer.from(p.bytes);
  tampered[tampered.length - 5] ^= 1;

  for (const [extra, code] of [
    [{ order: null }, 'auftrag-ungeprueft'],
    [{ order: kopie }, 'auftrag-ungeprueft'],
    [{ order: Object.freeze({ ...p.order }) }, 'auftrag-ungeprueft'],
    [{ expectedSha256: '0'.repeat(64) }, 'auftrag-abweichung'],
    [{ expectedSha256: p.hash.toUpperCase() }, 'auftrag-hash-format'],
    [{ packageBytes: fremd.bytes, packageSha256: fremd.sha256 }, 'paket-bindung'],
    [{ packageSha256: '1'.repeat(64) }, 'paket-hash'],
    [{ packageBytes: tampered }, 'paket-hash'],
    [{ packageBytes: p.text }, 'paket-eingabe'],
    [edit(data => { data.base_sha = PARENT; }), 'paket-bindung'],
    [edit(data => { data.dateien.reverse(); }), 'paket-dateiliste'],
    [edit(data => { data.dateien[0].git_blob = '0'.repeat(40); }), 'paket-git-blob'],
    [edit(data => { data.dateien[0].sha256 = '0'.repeat(64); }), 'paket-sha256'],
  ]) {
    const input = eingabe(p, extra);
    const r = lauf(input);
    ohneAbnahme(r, code);
    assert.deepEqual(r.protokoll.git, [], `${code}: Git trotz ungeprueftem Auftrag oder Paket`);
    assert.deepEqual(readdirSync(input.checkParent), []);
  }
});

test('Eingabe: genau die sieben Schluessel, keine Getter, kein Proxy', () => {
  const p = paket('rechner');
  const base = eingabe(p);
  const { gitEnv: _gitEnv, ...ohne } = base;
  const getter = { ...base };
  Object.defineProperty(getter, 'order', { get: () => p.order, enumerable: true });

  for (const input of [null, ohne, { ...base, abnahmePfad: 'x' }, { ...base, erfolg: ACCEPTANCE_SUCCESS }, { ...base, nachweis: {} }, new Proxy(base, {}), getter, [base]]) {
    const r = lauf(input);
    ohneAbnahme(r, input === getter ? 'auftrag-ungeprueft' : 'abnahme-eingabe');
  }
});

test('Nachweis: requireAccepted lehnt kopierte, frei gebaute und fremd gebundene Nachweise ab', () => {
  const p = paket('rechner');
  const r = lauf(eingabe(p));
  assert.equal(r.fehler, undefined, r.fehler?.message);
  const echt = r.ergebnis;
  const kopie = JSON.parse(JSON.stringify(echt));
  assert.deepEqual(kopie, JSON.parse(JSON.stringify(echt)));

  for (const falsch of [kopie, { ...echt }, Object.freeze({ ...echt }), null, undefined, structuredClone(echt)]) {
    assert.throws(() => requireAccepted(falsch, p.order, p.hash), error => error.code === 'abnahme-ungeprueft');
  }

  const fremd = paket('text');
  assert.throws(() => requireAccepted(echt, fremd.order, fremd.hash), error => error.code === 'abnahme-bindung');
  assert.throws(() => requireAccepted(echt, p.order, '0'.repeat(64)), error => error.code === 'auftrag-abweichung');
  assert.equal(requireAccepted(echt, p.order, p.hash), echt);
  assert.throws(() => { echt.ergebnis = 'x'; }, TypeError);
});

// ---------------------------------------------------------------------------
// Pruefordner und Quelle
// ---------------------------------------------------------------------------

test('Pruefordner: ungueltig, nicht leer, bereits benutzt, ueberschneidend oder ueber Symlink erreichbar', t => {
  const p = paket('rechner');
  const datei = join(newDir('f'), 'datei');
  writeFileSync(datei, 'x');
  const voll = newDir('voll');
  writeFileSync(join(voll, 'rest.txt'), 'x');
  const cases = [
    ['relativ', 'pruef', 'abnahme-pruefordner'],
    ['fehlt', join(BASE_DIR, 'gibt-es-nicht'), 'abnahme-pruefordner'],
    ['Datei', datei, 'abnahme-pruefordner'],
    ['in trustedRoot', join(TRUSTED, 'src'), 'abnahme-pruefordner'],
    ['trustedRoot selbst', TRUSTED, 'abnahme-pruefordner'],
    ['Eltern von trustedRoot', BASE_DIR, 'abnahme-pruefordner'],
    ['nicht leer', voll, 'abnahme-pruefordner-benutzt'],
  ];

  if (symlinksAllowed) {
    const ziel = newDir('ziel');
    mkdirSync(join(ziel, 'unter'));
    const link = join(newDir('l'), 'link');
    symlinkSync(ziel, link, 'dir');
    cases.push(['Symlink', link, 'abnahme-pruefordner'], ['ueber Symlink im Pfad', join(link, 'unter'), 'abnahme-pruefordner']);
  } else {
    t.diagnostic('Symlink-Faelle uebersprungen: Symlinks sind auf diesem System nicht erlaubt (laufen unter Ubuntu in der CI)');
  }

  for (const [name, checkParent, code] of cases) {
    const r = lauf(eingabe(p, { checkParent }));
    ohneAbnahme(r, code);
    assert.ok(!r.protokoll.git.some(call => NACH_KLON(call.args)), `${name}: Klon trotz ungueltigem Pruefordner`);
  }
});

test('Pruefordner: ein benutzter oder fehlgeschlagener Pruefordner wird nie wiederverwendet', () => {
  const p = paket('rechner');
  const input = eingabe(p);
  assert.equal(lauf(input).fehler, undefined);
  const zweiter = lauf({ ...input });
  ohneAbnahme(zweiter, 'abnahme-pruefordner-benutzt');
  assert.equal(readdirSync(input.checkParent).length, 1);

  // Fehlgeschlagener Lauf: Manipulation nach dem Klon, danach ist derselbe Pruefordner gesperrt.
  const fehlgeschlagen = eingabe(p);
  erwarte(lauf(fehlgeschlagen, [{ wann: NACH_KLON, tu: dir => mkdirSync(join(dir, '.git', 'worktrees')) }]), 'abnahme-git-struktur');
  ohneAbnahme(lauf({ ...fehlgeschlagen }), 'abnahme-pruefordner-benutzt');
});

test('Quelle: trustedRoot auf einem anderen Commit, Unterordner oder fehlend wird abgelehnt', () => {
  const p = paket('rechner');
  ohneAbnahme(lauf(eingabe(p, { trustedRoot: TRUSTED_P })), 'abnahme-quelle-head');
  ohneAbnahme(lauf(eingabe(p, { trustedRoot: join(TRUSTED, 'src') })), 'auftrag-git-wurzel');
  ohneAbnahme(lauf(eingabe(p, { trustedRoot: join(BASE_DIR, 'fehlt') })), 'abnahme-quelle');
  ohneAbnahme(lauf(eingabe(p, { trustedRoot: 'vertraut' })), 'abnahme-quelle');
});

// ---------------------------------------------------------------------------
// Checkout und Git: Eingriffe nach dem Klon
// ---------------------------------------------------------------------------

const config = (dir, key, value) => git(dir, ['config', key, value]);

test('Git-Struktur: .git als Datei, Linked Worktree, Worktrees, commondir, Alternates, Hooks, info, shallow, harter Link', () => {
  const p = paket('rechner');
  const andere = cloneAt(join(newDir('anders'), 'c'), BASIS);
  const cases = [
    ['.git als Verweisdatei', dir => {
      const ziel = join(dirname(dir), 'verschoben.git');
      renameSync(join(dir, '.git'), ziel);
      writeFileSync(join(dir, '.git'), `gitdir: ${slash(ziel)}\n`);
    }],
    ['Linked Worktree', dir => {
      rmSync(join(dir, '.git'), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
      git(andere, ['worktree', 'add', '-q', '--detach', '--no-checkout', dir, BASIS]);
    }],
    ['Worktrees-Ordner', dir => mkdirSync(join(dir, '.git', 'worktrees', 'w'), { recursive: true })],
    ['commondir', dir => writeFileSync(join(dir, '.git', 'commondir'), `${slash(join(andere, '.git'))}\n`)],
    ['Alternates (fremder Objektverweis)', dir => writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${slash(join(andere, '.git', 'objects'))}\n`)],
    ['http-alternates', dir => writeFileSync(join(dir, '.git', 'objects', 'info', 'http-alternates'), 'https://example.invalid/objects\n')],
    ['Hook-Ordner', dir => {
      mkdirSync(join(dir, '.git', 'hooks'));
      writeFileSync(join(dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 0\n');
    }],
    ['info/attributes', dir => {
      mkdirSync(join(dir, '.git', 'info'));
      writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=x\n');
    }],
    ['shallow', dir => writeFileSync(join(dir, '.git', 'shallow'), `${BASIS}\n`)],
    ['config.worktree', dir => writeFileSync(join(dir, '.git', 'config.worktree'), '[core]\n\tfsmonitor = x\n')],
    ['harter Link in refs', dir => linkSync(join(andere, '.git', 'HEAD'), join(dir, '.git', 'refs', 'tags', 'h'))],
    ['unerwartete Pack-Datei', dir => writeFileSync(join(dir, '.git', 'objects', 'pack', 'x.promisor'), '')],
  ];

  if (symlinksAllowed) {
    cases.push(['Symlink in refs', dir => symlinkSync(join(andere, '.git', 'HEAD'), join(dir, '.git', 'refs', 'tags', 's'))]);
    cases.push(['.git als Symlink', dir => {
      const ziel = join(dirname(dir), 'verschoben.git');
      renameSync(join(dir, '.git'), ziel);
      symlinkSync(ziel, join(dir, '.git'), 'dir');
    }]);
  }

  for (const [name, tu] of cases) {
    const r = lauf(eingabe(p), [{ wann: NACH_KLON, tu }]);
    ohneAbnahme(r, 'abnahme-git-struktur');
    assert.ok(!r.protokoll.git.some(call => NACH_CHECKOUT(call.args)), `${name}: ausgecheckt trotz Befund`);
  }
});

test('Git-Konfiguration: Positivliste konkreter Schluessel und Werte, keine Wildcards, keine fremden Quellen', () => {
  const p = paket('rechner');
  const cases = [
    ['core.hooksPath', dir => config(dir, 'core.hooksPath', join(BASE_DIR, 'hooks'))],
    ['remote.origin.uploadpack', dir => config(dir, 'remote.origin.uploadpack', 'git-upload-pack --boese')],
    ['remote.origin.receivepack', dir => config(dir, 'remote.origin.receivepack', 'x')],
    ['unbekanntes remote.origin.pushurl', dir => config(dir, 'remote.origin.pushurl', 'x')],
    ['unbekanntes remote.origin.tagopt', dir => config(dir, 'remote.origin.tagopt', '--no-tags')],
    ['remote.origin.url veraendert', dir => config(dir, 'remote.origin.url', join(BASE_DIR, 'repo'))],
    ['remote.origin.fetch veraendert', dir => config(dir, 'remote.origin.fetch', '+refs/*:refs/*')],
    ['zweiter Wert fuer remote.origin.fetch', dir => git(dir, ['config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*'])],
    ['core.filemode umgekehrt', dir => config(dir, 'core.filemode', IS_WINDOWS ? 'true' : 'false')],
    ['core.bare als Text veraendert', dir => config(dir, 'core.bare', 'no')],
    ['include.path', dir => config(dir, 'include.path', join(BASE_DIR, 'home', 'leer.gitconfig'))],
    ['includeIf', dir => config(dir, 'includeIf.gitdir:/.path', join(BASE_DIR, 'x'))],
    ['Filter', dir => config(dir, 'filter.x.clean', 'cat')],
    ['protocol.allow', dir => config(dir, 'protocol.allow', 'always')],
    ['core.sshCommand', dir => config(dir, 'core.sshCommand', 'x')],
    ['core.worktree', dir => config(dir, 'core.worktree', BASE_DIR)],
    ['extensions', dir => config(dir, 'extensions.worktreeConfig', 'true')],
    ['branch.main.merge veraendert', dir => config(dir, 'branch.main.merge', 'refs/heads/anders')],
    ['fremder Zweig', dir => config(dir, 'branch.anders.remote', 'origin')],
    ['Eintrag entfernt', dir => git(dir, ['config', '--unset', 'core.logallrefupdates'])],
    ['globale Konfiguration der Sitzung', dir => writeFileSync(join(dirname(dir), 'home', 'leer.gitconfig'), '[core]\n\tfsmonitor = x\n')],
    ['XDG der Sitzung', dir => mkdirSync(join(dirname(dir), 'home', 'xdg', 'git'))],
    ['Hook-Ordner der Sitzung', dir => writeFileSync(join(dirname(dir), 'hooks', 'post-checkout'), '#!/bin/sh\n')],
  ];

  for (const [name, tu] of cases) {
    const r = lauf(eingabe(p), [{ wann: NACH_KLON, tu }]);
    const session = name.includes('Sitzung');
    ohneAbnahme(r, session ? 'abnahme-sitzung' : 'abnahme-git-config');
    assert.ok(!r.protokoll.git.some(call => NACH_CHECKOUT(call.args)), `${name}: ausgecheckt trotz Befund`);
  }
});

// Ein Skript, das beim Aufruf eine Markerdatei schreibt. Beim fsmonitor laesst Exitcode 1 git ohne
// fsmonitor weiterlaufen; beim post-checkout-Hook wird der Exitcode zu dem von git checkout.
function markerScript(name, exitCode) {
  const dir = newDir('marker');
  const marker = join(dir, `${name}.marker`);
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\necho ausgefuehrt > "${slash(marker)}"\nexit ${exitCode}\n`);
  chmodSync(script, 0o755);
  return { marker, script: slash(script) };
}

const exists = path => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

test('fsmonitor: ein praepariertes core.fsmonitor wird abgelehnt und nicht ausgefuehrt; Gegenprobe: es ist hier ausfuehrbar', () => {
  const p = paket('rechner');
  const { marker, script } = markerScript('fsmonitor', 1);
  const r = lauf(eingabe(p), [{ wann: NACH_KLON, tu: dir => config(dir, 'core.fsmonitor', script) }]);
  ohneAbnahme(r, 'abnahme-git-config');
  assert.ok(!exists(marker), 'fsmonitor wurde ausgefuehrt');

  // Gegenprobe im selben Aufbau: derselbe Hook laeuft bei git status tatsaechlich.
  const kontrolle = cloneAt(join(newDir('kontrolle'), 'c'), BASIS);
  config(kontrolle, 'core.fsmonitor', script);
  git(kontrolle, ['status', '--porcelain']);
  assert.ok(exists(marker), 'Gegenprobe: fsmonitor ist auf diesem System nicht ausfuehrbar, der Test belegt sonst nichts');
});

test('Hook: ein vor dem Auschecken eingeschleuster post-checkout-Hook laeuft nicht; Gegenprobe: er ist hier ausfuehrbar', () => {
  const p = paket('rechner');
  const { marker, script } = markerScript('hook', 0);
  const hook = readFileSync(script);
  const plant = dir => {
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'post-checkout'), hook);
    chmodSync(join(dir, 'hooks', 'post-checkout'), 0o755);
  };
  const r = lauf(eingabe(p), [{ wann: NACH_KLON, tu: dir => plant(join(dir, '.git')) }]);
  ohneAbnahme(r, 'abnahme-git-struktur');
  assert.ok(!exists(marker), 'Hook wurde vor Abschluss der Pruefung ausgefuehrt');

  // Auch ein hooksPath auf denselben Hook laeuft nicht.
  const hooksDir = newDir('hookpfad');
  plant(hooksDir);
  ohneAbnahme(lauf(eingabe(p), [{ wann: NACH_KLON, tu: dir => config(dir, 'core.hooksPath', join(hooksDir, 'hooks')) }]), 'abnahme-git-config');
  assert.ok(!exists(marker), 'Hook ueber core.hooksPath wurde ausgefuehrt');

  // Gegenprobe: derselbe Hook laeuft bei einem gewoehnlichen git checkout.
  const kontrolle = cloneAt(join(newDir('kontrolle'), 'c'), BASIS);
  plant(join(kontrolle, '.git'));
  git(kontrolle, ['checkout', '-q', '--detach', PARENT]);
  assert.ok(exists(marker), 'Gegenprobe: Hooks sind auf diesem System nicht ausfuehrbar, der Test belegt sonst nichts');
});

// ---------------------------------------------------------------------------
// Checkout und Git: Eingriffe nach dem Auschecken
// ---------------------------------------------------------------------------

test('Checkout: falscher HEAD, manipulierter Index, unerlaubter Modus und zusaetzliche Datei nach dem Auschecken', () => {
  const p = paket('rechner');

  for (const [tu, code] of [
    [dir => writeFileSync(join(dir, '.git', 'HEAD'), `${PARENT}\n`), 'abnahme-git-head'],
    [dir => writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n'), 'abnahme-git-head'],
    [dir => git(dir, ['update-index', '--chmod=+x', 'src/rechne.js']), 'abnahme-git-index'],
    [dir => {
      const oid = git(dir, ['hash-object', '-w', '--stdin'], 'x');
      git(dir, ['update-index', '--add', '--cacheinfo', `100644,${oid},neu.txt`]);
    }, 'abnahme-git-index'],
    [dir => writeFileSync(join(dir, 'neu.txt'), 'x'), 'abnahme-git-status'],
    [dir => writeFileSync(join(dir, 'src', 'rechne.js'), RECHNE_NEU), 'abnahme-git-status'],
  ]) {
    ohneAbnahme(lauf(eingabe(p), [{ wann: NACH_CHECKOUT, tu }]), code);
  }
});

// ---------------------------------------------------------------------------
// Codedateien und Abnahmedatei: Eingriffe nach dem Paketimport
// ---------------------------------------------------------------------------

test('Code nach dem Import: falscher Blob, vertauschte Dateien, harter Link, Ordner statt Datei, Index, Modus, Zusatzdatei', t => {
  const p = paket('rechner');
  const rechne = dir => fileIn(dir, 'src/rechne.js');
  const extern = join(newDir('extern'), 'rechne.js');
  writeFileSync(extern, RECHNE_NEU);
  const cases = [
    ['einzelne falsche Blob-ID', dir => writeFileSync(rechne(dir), RECHNE_NEU.replace('a * a', 'a * a * 1')), 'abnahme-code-blob'],
    ['gleich lang, anderer Inhalt', dir => writeFileSync(rechne(dir), RECHNE_NEU.replace('a * a', 'a + a')), 'abnahme-code-blob'],
    ['vertauschte Dateien', dir => {
      const a = readFileSync(rechne(dir));
      writeFileSync(rechne(dir), readFileSync(fileIn(dir, 'test/rechne.test.js')));
      writeFileSync(fileIn(dir, 'test/rechne.test.js'), a);
    }, 'abnahme-code-blob'],
    ['harter Link auf externe Datei mit gleichen Bytes', dir => {
      unlinkSync(rechne(dir));
      linkSync(extern, rechne(dir));
    }, 'abnahme-code-datei'],
    ['Ordner statt Datei (unerwarteter Dateityp)', dir => {
      unlinkSync(rechne(dir));
      mkdirSync(rechne(dir));
      writeFileSync(join(rechne(dir), 'x.js'), 'x');
    }, 'abnahme-git-status'],
    ['zusaetzliche Datei', dir => writeFileSync(fileIn(dir, 'src/zusatz.js'), 'x'), 'abnahme-git-status'],
    ['geloeschte Datei', dir => unlinkSync(fileIn(dir, 'src/text.js')), 'abnahme-git-status'],
    ['fremde Datei veraendert', dir => writeFileSync(fileIn(dir, 'src/text.js'), TEXT_NEU), 'abnahme-git-status'],
    ['Modus 100755 im Index', dir => git(dir, ['update-index', '--chmod=+x', 'src/rechne.js']), 'abnahme-git-index'],
    ['gestagte Aenderung', dir => git(dir, ['add', 'src/rechne.js']), 'abnahme-git-index'],
    ['falscher HEAD', dir => writeFileSync(join(dir, '.git', 'HEAD'), `${PARENT}\n`), 'abnahme-git-head'],
    ['Alternates nach dem Import', dir => writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${slash(join(TRUSTED, '.git', 'objects'))}\n`), 'abnahme-git-struktur'],
    ['fsmonitor nach dem Import', dir => config(dir, 'core.fsmonitor', 'x'), 'abnahme-git-config'],
  ];

  if (!IS_WINDOWS) {
    cases.push(['Modus 100755 im Dateisystem', dir => chmodSync(rechne(dir), 0o755), 'abnahme-code-modus']);
  } else {
    t.diagnostic('Ausfuehrungsrecht im Dateisystem gibt es unter Windows nicht; der Fall laeuft unter Ubuntu in der CI');
  }

  if (symlinksAllowed) {
    cases.push(['Symlink statt Datei', dir => {
      unlinkSync(rechne(dir));
      symlinkSync(extern, rechne(dir));
    }, 'abnahme-git-status']);
  }

  for (const [name, tu, code] of cases) {
    const r = lauf(eingabe(p), [{ wann: NACH_IMPORT, tu }]);
    assert.ok(r.fehler !== undefined, `${name}: keine Ablehnung`);
    assert.equal(r.fehler.code, code, `${name}: ${r.fehler.message}`);
    assert.deepEqual(r.protokoll.abnahmen, [], `${name}: Abnahme gestartet`);
  }
});

test('Code nach dem Import: FIFO (nur Linux) wird vor der Abnahme abgelehnt', t => {
  if (IS_WINDOWS) {
    t.skip('FIFOs gibt es unter Windows nicht; der Fall laeuft unter Ubuntu in der CI');
    return;
  }

  // git status meldet eine FIFO nicht (gemessen unter Linux, git 2.54); nur der eigene Dateibaumvergleich faengt sie.
  ohneAbnahme(lauf(eingabe(paket('rechner')), [{ wann: NACH_IMPORT, tu: dir => EXEC('mkfifo', [fileIn(dir, 'src/kanal')]) }]), 'abnahme-code-datei');
});

test('Abnahmedatei nach dem Import: manipulierte Bytes, fehlend, harter Link, Ordner, Symlink', t => {
  const p = paket('rechner');
  const pfad = dir => fileIn(dir, abnahmePfad(AUFGABEN.rechner.issue));
  const extern = join(newDir('extern'), 'abnahme.mjs');
  writeFileSync(extern, V2_RECHNER);
  const cases = [
    ['manipulierte Originalbytes', dir => writeFileSync(pfad(dir), V2_RECHNER.replace("process.stdout.write('A6", "void 0; process.stdout.write('A6")), 'abnahme-datei-blob'],
    ['nur Erfolgszeile mit v2-Kennung', dir => writeFileSync(pfad(dir), v2(OK)), 'abnahme-datei-blob'],
    ['Abnahme eines anderen Auftrags', dir => writeFileSync(pfad(dir), V2_TEXT), 'abnahme-datei-blob'],
    ['fehlend', dir => unlinkSync(pfad(dir)), 'abnahme-datei'],
    ['harter Link mit gleichen Bytes', dir => {
      unlinkSync(pfad(dir));
      linkSync(extern, pfad(dir));
    }, 'abnahme-datei'],
    ['Ordner statt Datei', dir => {
      unlinkSync(pfad(dir));
      mkdirSync(pfad(dir));
    }, 'abnahme-datei'],
  ];

  if (symlinksAllowed) {
    cases.push(['Symlink mit gleichen Bytes', dir => {
      unlinkSync(pfad(dir));
      symlinkSync(extern, pfad(dir));
    }, 'abnahme-datei']);
    cases.push(['Ordner der Abnahme als Symlink', dir => {
      const ziel = join(dirname(dir), 'abnahmeordner');
      renameSync(dirname(pfad(dir)), ziel);
      symlinkSync(ziel, dirname(pfad(dir)), 'dir');
    }, 'abnahme-datei']);
  } else {
    t.diagnostic('Symlink-Faelle uebersprungen: Symlinks sind auf diesem System nicht erlaubt (laufen unter Ubuntu in der CI)');
  }

  for (const [name, tu, code] of cases) {
    const r = lauf(eingabe(p), [{ wann: NACH_IMPORT, tu }]);
    assert.ok(r.fehler !== undefined, `${name}: keine Ablehnung`);
    assert.equal(r.fehler.code, code, `${name}: ${r.fehler.message}`);
    assert.deepEqual(r.protokoll.abnahmen, [], `${name}: Abnahme gestartet`);
  }
});

// ---------------------------------------------------------------------------
// Wachtests auf Quelltext und Workflows
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(MODULE_PATH, 'utf8');

test('Wache: nur die vorgesehenen Importe, keine Umgebung, kein Netz, keine Shell, genau ein Prozessstart', () => {
  const imports = [...SOURCE.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./agent-code-auftrag-paket.mjs', './agent-code-auftrag.mjs', './agent-profile.mjs', 'node:child_process', 'node:crypto', 'node:fs', 'node:path', 'node:util']);
  assert.equal([...SOURCE.matchAll(/\bimport\b/g)].length, imports.length);
  assert.ok(SOURCE.includes("import { OrderError, openRepository, sameOrder } from './agent-code-auftrag.mjs';"));
  assert.ok(SOURCE.includes("import { applyPackageV2, parsePackageV2 } from './agent-code-auftrag-paket.mjs';"));
  assert.ok(SOURCE.includes("import { execFileSync, spawnSync } from 'node:child_process';"));
  assert.ok(!/\bexport\b[^;]*\bfrom\b/.test(SOURCE), 'export ... from im Modul');

  // fetch nur als Aufruf: remote.origin.fetch ist ein Konfigurationsschluessel der Positivliste.
  for (const forbidden of [/process\.env/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bglobalThis\b/, /\brequire\b/, /\bconsole\b/, /GITHUB_/, /\beval\b/, /\bFunction\b/, /(?<![.\w])exec\(/, /(?<![.\w])spawn\(/, /\bexecSync\b/, /\bfork\(/, /shell:\s*true/, /\bnode:(net|http|https|dns|worker_threads|vm)\b/, /\brmSync\b/, /packageFileBytes/]) {
    assert.ok(!forbidden.test(SOURCE), `verbotener Zugriff im Modul: ${forbidden}`);
  }

  // Muss-Treffer: dieselben Suchen finden etwas, wo es vorkommt.
  assert.ok(/process\.env/.test(readFileSync(join(ROOT, 'scripts', 'agent-code-publish.mjs'), 'utf8')));
  assert.ok(/(?<![.\w])spawn\(/.test(V2_RECHNER.replace('spawnSync(', 'spawn(')) && /\.exec\(/.test(SOURCE));

  // process nur fuer Plattform und den absoluten Node-Pfad.
  assert.deepEqual([...new Set([...SOURCE.matchAll(/\bprocess\.(\w+)/g)].map(m => m[1]))].sort(), ['execPath', 'platform']);
  assert.equal([...SOURCE.matchAll(/\bspawnSync\(/g)].length, 1, 'genau ein Start des Abnahmeprozesses');
  assert.equal([...SOURCE.matchAll(/\bexecFileSync\(/g)].length, 1, 'genau eine Stelle fuer Git');
  assert.ok(/execFileSync\('git', args,/.test(SOURCE));
  // Die Erfolgsausgabe ist eine feste Konstante, kein Argument.
  assert.equal([...SOURCE.matchAll(/A6-ABNAHME-BESTANDEN/g)].length, 1);
});

test('Wache: kein Workflow und kein anderes Skript verweist auf das Abnahmemodul', () => {
  const workflows = join(ROOT, '.github', 'workflows');
  const files = readdirSync(workflows).filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.length >= 10, 'Gegenprobe: zu wenige Workflows gefunden');
  assert.ok(files.every(name => !readFileSync(join(workflows, name), 'utf8').includes('agent-code-auftrag')), 'ein Workflow verweist auf ein Auftragsmodul');

  const scripts = join(ROOT, 'scripts');
  const names = readdirSync(scripts).filter(name => name.endsWith('.mjs'));
  assert.ok(names.includes('agent-code-auftrag-abnahme.mjs'), 'Gegenprobe: Modul fehlt');
  const others = names.filter(name => name !== 'agent-code-auftrag-abnahme.mjs').map(name => readFileSync(join(scripts, name), 'utf8'));
  assert.ok(others.length >= 10, 'Gegenprobe: zu wenige Skripte gefunden');
  assert.ok(others.some(text => text.includes('agent-code-auftrag-paket')), 'Gegenprobe ohne Treffer');
  assert.ok(others.every(text => !text.includes('agent-code-auftrag-abnahme')), 'ein Skript verweist auf das Abnahmemodul');
});
