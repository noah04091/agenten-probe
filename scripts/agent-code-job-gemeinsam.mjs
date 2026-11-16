// A6.4-2c-1 und A6.4-2c-2: Gemeinsame Hilfsfunktionen der Job-Einstiege (Job 0 Auftrag, Job 1a vor
// Claude, Job 1b nach Claude, Job 2 Abnahme, Job 3 Veroeffentlichung).
//
// Wirkungslos bis A6.4-4: Kein Workflow ruft die Einstiege auf. Dieses Modul importiert nur
// node:fs, node:crypto und node:path, kein Auftragsmodul, startet keinen Prozess und hat keine
// Netzschnittstelle. Es gibt nichts aus; Fehler tragen nur einen festen Code.
//
// Inhalt:
// - Umgebungsvertrag: genau die festen Namen je Job, jeder Wert streng geprueft. Andere Namen werden
//   nie gelesen. Dazu ein fester Stolperdraht gegen Zugangsdaten und Node-Schalter in der Umgebung.
// - Feste Geheimnisnamen je Job (SECRET_NAMES, tief eingefroren). Der Stolperdraht bekommt nie eine
//   Liste vom Aufrufer, sondern nur die feste Liste seines Jobs. Jeder Geheimnisname eines anderen
//   Jobs gilt als fremdes Geheimnis, auch wenn er keines der allgemeinen Muster traegt.
// - Feste Pfade unter RUNNER_TEMP: Schnappschuss, Paket, Pruefordner, Claude-Arbeitsordner,
//   Pruef-Checkout der Veroeffentlichung, eigenes Git-HOME je Job. Kein Pfad stammt aus dem Issue
//   oder aus einer frei waehlbaren Variable.
// - Dateiuebergabe: exklusiv schreiben, begrenzt lesen, keine Symlinks oder Sonderdateien.
// - Schnappschussformat agent-auftrag-schnappschuss-v1: bauen, kanonisch serialisieren, streng lesen.
// - Ausgabeschreiber fuer genau die zwei Hash-Ausgaben von Job 0 und genau paket_sha256 von Job 1b.
//
// Vertrauensgrenze der Geheimnisnamen (A6.4-2c-2): Die Namen sind nur ein Vertrag fuer eine spaetere,
// vertrauenswuerdige Workflow-Umgebung. Aus einem Namen folgt weder, dass ein echtes Geheimnis
// existiert, noch welchen Inhalt es hat, noch dass die Liste vollstaendig ist. Welcher Claude-Zugang
// und welcher Lesetoken wirklich verwendet werden und ob sie dem Vergleich in Job 1b vollstaendig
// vorliegen, muss A6.4-4 unabhaengig nachweisen.
//
// Grenzen:
// - Der Stolperdraht prueft die Umgebung erst nach dem Start von Node. Code, der ueber NODE_OPTIONS
//   (Vorladeschalter) oder vergleichbare Wege schon vorher lief, erkennt er nicht (S4). Die
//   Bereinigung der Umgebung vor dem Start von Node muss der geschuetzte Workflow leisten.
// - Ob GitHub die Variablen so belegt wie hier verlangt (etwa GITHUB_OUTPUT und GITHUB_EVENT_PATH
//   unter RUNNER_TEMP, keine weiteren Variablen mit TOKEN im Namen), ist nicht gemessen. Ein
//   Widerspruch fuehrt zur Ablehnung (falsches Nein), nie zur Annahme. Messung in A6.4-4.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';

export const SNAPSHOT_SCHEMA = 'agent-auftrag-schnappschuss-v1';
export const SNAPSHOT_REPOSITORY = 'noah04091/agenten-probe';
export const WORKFLOW_REF = 'noah04091/agenten-probe/.github/workflows/agent-auftrag.yml@refs/heads/main';
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_DEPTH = 8;
export const MAX_SNAPSHOT_EVENTS = 1000;
export const MAX_SNAPSHOT_LABELS = 20;
export const MAX_EVENT_FILE_BYTES = 1024 * 1024;
export const MAX_PACKAGE_FILE_BYTES = 64 * 1024;
export const MAX_ISSUE = 10_000_000;

export const SNAPSHOT_DIR = 'a6-auftrag';
export const SNAPSHOT_FILE = 'schnappschuss.json';
export const PACKAGE_DIR = 'a6-paket';
export const PACKAGE_FILE = 'paket-v2.json';
export const CHECK_DIR = 'a6-abnahme';
export const HOME_AUFTRAG = 'a6-auftrag-home';
export const HOME_ABNAHME = 'a6-abnahme-home';
export const WORK_DIR = 'a6-claude-arbeit';
export const PUBLISH_CHECK_DIR = 'a6-veroeffentlichung-pruefung';
export const HOME_CLAUDE_VOR = 'a6-claude-vor-home';
export const HOME_CLAUDE_NACH = 'a6-claude-nach-home';
export const HOME_VEROEFFENTLICHEN = 'a6-veroeffentlichen-home';
export const MAX_PROFILE_FILE_BYTES = 8192;
export const MIN_COMPARE_LENGTH = 20;
export const MAX_COMPARE_LENGTH = 4096;

export const OUTPUT_KEYS = Object.freeze(['auftrag_sha256', 'schnappschuss_sha256']);
export const PACKAGE_OUTPUT_KEY = 'paket_sha256';
export const UNKNOWN_CODE = 'job-unbekannt';

// Feste Geheimnisnamen je Job. Tief eingefroren; der Stolperdraht liest nur diese Listen.
export const SECRET_NAMES = Object.freeze({
  auftrag: Object.freeze(['A6_LESE_TOKEN']),
  claudeVor: Object.freeze(['A6_LESE_TOKEN']),
  claudeNach: Object.freeze(['A6_VERGLEICH_ANTHROPIC', 'A6_VERGLEICH_LESE_TOKEN']),
  abnahme: Object.freeze([]),
  veroeffentlichen: Object.freeze(['A6_APP_TOKEN']),
});
const KNOWN_SECRET_NAMES = Object.freeze([...new Set(Object.values(SECRET_NAMES).flat())].sort());

const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^[1-9][0-9]{0,15}$/;
const CODE_RE = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const SECRET_KEY_RE = /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|API_?KEY|CREDENTIAL|OAUTH/i;
const SECRET_VALUE_RE = /gh[psoru]_[A-Za-z0-9_]{8,}|github_pat_|sk-ant-|-----BEGIN/;
const NODE_KEY_RE = /^NODE_/i;
const WINDOWS_KEYS = Object.freeze(['SystemRoot', 'PATHEXT', 'ComSpec', 'windir']);
const READ_TOKEN_KEY = 'A6_LESE_TOKEN';
const APP_TOKEN_KEY = 'A6_APP_TOKEN';
const MAX_PATH_LENGTH = 4096;

const CONTRACT_AUFTRAG = Object.freeze([
  'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA',
  'GITHUB_WORKFLOW_REF', 'GITHUB_WORKSPACE', 'GITHUB_OUTPUT', 'RUNNER_TEMP', 'PATH', READ_TOKEN_KEY,
]);
const CONTRACT_ABNAHME = Object.freeze([
  'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKSPACE', 'RUNNER_TEMP', 'PATH', 'A6_AUFTRAG_SHA256', 'A6_SCHNAPPSCHUSS_SHA256', 'A6_PAKET_SHA256',
]);
const CONTRACT_CLAUDE_VOR = Object.freeze([
  'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKSPACE', 'GITHUB_OUTPUT', 'RUNNER_TEMP', 'PATH', 'A6_AUFTRAG_SHA256', 'A6_SCHNAPPSCHUSS_SHA256', READ_TOKEN_KEY,
]);
const CONTRACT_CLAUDE_NACH = Object.freeze([
  'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKSPACE', 'GITHUB_OUTPUT', 'RUNNER_TEMP', 'PATH', 'A6_AUFTRAG_SHA256', 'A6_SCHNAPPSCHUSS_SHA256',
  ...SECRET_NAMES.claudeNach,
]);
const CONTRACT_VEROEFFENTLICHEN = Object.freeze([
  'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA',
  'GITHUB_WORKFLOW_REF', 'GITHUB_WORKSPACE', 'RUNNER_TEMP', 'PATH', 'A6_AUFTRAG_SHA256', 'A6_PAKET_SHA256', APP_TOKEN_KEY,
]);

export class JobError extends Error {
  constructor(code) {
    super(`Job abgelehnt: ${code}`);
    this.name = 'JobError';
    this.code = code;
  }
}

export function jobFail(code) {
  throw new JobError(code);
}

// ---------------------------------------------------------------------------
// Fehlercodes und Ausgabe
// ---------------------------------------------------------------------------

// Liefert nur einen festen, geprueften Code. Meldung, Bericht, Stack und alle anderen Felder eines
// Fehlers werden nie gelesen: Sie koennen Issue-, PR- oder Agentendaten enthalten.
export function errorCode(error) {
  let value;

  try {
    const descriptor = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return UNKNOWN_CODE;
  }

  return typeof value === 'string' && CODE_RE.test(value) ? value : UNKNOWN_CODE;
}

// Eine Zeile fuer stderr. Der Code kann wegen CODE_RE weder Zeilenumbruch noch Sonderzeichen tragen.
export function errorLine(error) {
  return `A6-FEHLER ${errorCode(error)}\n`;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sameBytes(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && a.equals(b);
}

// ---------------------------------------------------------------------------
// Umgebungsvertrag und Stolperdraht
// ---------------------------------------------------------------------------

// Liest nur eigene Text-Dateneigenschaften. Die Prozessumgebung liefert solche Eigenschaften.
function readEnv(env, key) {
  const descriptor = Object.getOwnPropertyDescriptor(env, key);
  const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  return typeof value === 'string' ? value : undefined;
}

// Fest je Job: welche geheimen Namen erlaubt sind. allowed ist immer eine Liste aus SECRET_NAMES und
// wird nur von den Vertragsfunktionen dieses Moduls uebergeben; nach aussen gibt es diese Funktion nicht.
function tripwire(env, allowed) {
  let keys;

  try {
    keys = Object.keys(env);
  } catch {
    jobFail('job-umgebung');
  }

  for (const key of keys) {
    if (NODE_KEY_RE.test(key)) {
      jobFail('job-umgebung-node');
    }

    if (allowed.includes(key)) {
      continue;
    }

    // Auch ein Geheimnisname eines anderen Jobs ist hier fremd, selbst ohne allgemeines Muster.
    if (KNOWN_SECRET_NAMES.includes(key) || SECRET_KEY_RE.test(key)) {
      jobFail('job-umgebung-geheimnis');
    }

    const value = readEnv(env, key);

    if (value !== undefined && SECRET_VALUE_RE.test(value)) {
      jobFail('job-umgebung-geheimnis');
    }
  }
}

function checkAbsolute(path, code) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > MAX_PATH_LENGTH ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    /[\\/]$/.test(path)
  ) {
    jobFail(code);
  }

  return path;
}

function isBelow(path, dir) {
  const rel = relative(dir, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${'/'}`) && !rel.startsWith('..\\');
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function checkDirectory(path, code) {
  const stat = lstatOrNull(checkAbsolute(path, code));

  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    jobFail(code);
  }

  return path;
}

function checkCommon(env, keys) {
  if (env === null || typeof env !== 'object') {
    jobFail('job-umgebung');
  }

  const values = Object.create(null);

  for (const key of keys) {
    const value = readEnv(env, key);

    if (value === undefined || value.length === 0 || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      jobFail('job-umgebung-fehlt');
    }

    values[key] = value;
  }

  if (values.GITHUB_REPOSITORY !== SNAPSHOT_REPOSITORY) {
    jobFail('job-repository');
  }

  if (values.GITHUB_EVENT_NAME !== 'issues') {
    jobFail('job-ereignis-art');
  }

  if (!RUN_ID_RE.test(values.GITHUB_RUN_ID) || !Number.isSafeInteger(Number(values.GITHUB_RUN_ID))) {
    jobFail('job-lauf-id');
  }

  // Jeder Einstieg prueft den Laufversuch selbst. Ein erneuter Versuch ist nie erlaubt.
  if (values.GITHUB_RUN_ATTEMPT !== '1') {
    jobFail('job-lauf-versuch');
  }

  if (!HEX40_RE.test(values.GITHUB_SHA)) {
    jobFail('job-basis');
  }

  if (values.GITHUB_WORKFLOW_REF !== WORKFLOW_REF) {
    jobFail('job-workflow');
  }

  const temp = checkDirectory(values.RUNNER_TEMP, 'job-runner-temp');
  const workspace = checkDirectory(values.GITHUB_WORKSPACE, 'job-checkout');

  if (isBelow(workspace, temp) || isBelow(temp, workspace) || relative(temp, workspace) === '') {
    jobFail('job-checkout');
  }

  const system = {};

  for (const key of WINDOWS_KEYS) {
    const value = readEnv(env, key);

    if (value !== undefined) {
      system[key] = value;
    }
  }

  return { values, system };
}

// Job 0. Ergebnis: eingefrorener, gepruefter Vertrag. Der Lesetoken wird nur weitergereicht.
export function readAuftragContract(env) {
  const { values, system } = checkCommon(env, CONTRACT_AUFTRAG);
  tripwire(env, SECRET_NAMES.auftrag);
  const temp = values.RUNNER_TEMP;
  const eventPath = checkAbsolute(values.GITHUB_EVENT_PATH, 'job-ereignis-pfad');
  const outputPath = checkAbsolute(values.GITHUB_OUTPUT, 'job-ausgabe-pfad');

  if (!isBelow(eventPath, temp)) {
    jobFail('job-ereignis-pfad');
  }

  if (!isBelow(outputPath, temp)) {
    jobFail('job-ausgabe-pfad');
  }

  return Object.freeze({
    repository: values.GITHUB_REPOSITORY,
    runId: values.GITHUB_RUN_ID,
    baseSha: values.GITHUB_SHA,
    workspace: values.GITHUB_WORKSPACE,
    runnerTemp: temp,
    eventPath,
    outputPath,
    path: values.PATH,
    system: Object.freeze(system),
    token: values[READ_TOKEN_KEY],
  });
}

// Job 2. Kein geheimer Name ist erlaubt, auch nicht der Lesetoken von Job 0.
export function readAbnahmeContract(env) {
  const { values, system } = checkCommon(env, CONTRACT_ABNAHME);
  tripwire(env, SECRET_NAMES.abnahme);
  checkHashes(values, ['A6_AUFTRAG_SHA256', 'A6_SCHNAPPSCHUSS_SHA256', 'A6_PAKET_SHA256']);

  return Object.freeze({
    repository: values.GITHUB_REPOSITORY,
    runId: values.GITHUB_RUN_ID,
    baseSha: values.GITHUB_SHA,
    workspace: values.GITHUB_WORKSPACE,
    runnerTemp: values.RUNNER_TEMP,
    path: values.PATH,
    system: Object.freeze(system),
    orderSha256: values.A6_AUFTRAG_SHA256,
    snapshotSha256: values.A6_SCHNAPPSCHUSS_SHA256,
    packageSha256: values.A6_PAKET_SHA256,
  });
}

function checkHashes(values, keys) {
  for (const key of keys) {
    if (!HEX64_RE.test(values[key])) {
      jobFail('job-hash-format');
    }
  }
}

function outputBelow(values) {
  const outputPath = checkAbsolute(values.GITHUB_OUTPUT, 'job-ausgabe-pfad');

  if (!isBelow(outputPath, values.RUNNER_TEMP)) {
    jobFail('job-ausgabe-pfad');
  }

  return outputPath;
}

// Job 1a, vor Claude. Nur der Lesetoken ist erlaubt, kein Zugang fuer Claude und kein App-Token.
export function readClaudeVorContract(env) {
  const { values, system } = checkCommon(env, CONTRACT_CLAUDE_VOR);
  tripwire(env, SECRET_NAMES.claudeVor);
  checkHashes(values, ['A6_AUFTRAG_SHA256', 'A6_SCHNAPPSCHUSS_SHA256']);

  return Object.freeze({
    repository: values.GITHUB_REPOSITORY,
    runId: values.GITHUB_RUN_ID,
    baseSha: values.GITHUB_SHA,
    workspace: values.GITHUB_WORKSPACE,
    runnerTemp: values.RUNNER_TEMP,
    outputPath: outputBelow(values),
    path: values.PATH,
    system: Object.freeze(system),
    orderSha256: values.A6_AUFTRAG_SHA256,
    snapshotSha256: values.A6_SCHNAPPSCHUSS_SHA256,
    token: values[READ_TOKEN_KEY],
  });
}

// Job 1b, nach Claude. Genau die zwei Vergleichswerte sind erlaubt und beide Pflicht. Sie dienen nur
// dem Wertvergleich im Paket; kein Netz, kein Token fuer GitHub. Jeder Wert: gueltiger Text, mindestens
// MIN_COMPARE_LENGTH Zeichen, hoechstens MAX_COMPARE_LENGTH UTF-16-Einheiten (dieselben Grenzen wie
// containsSecretValue). Ein Wert wird nie ausgegeben.
export function readClaudeNachContract(env) {
  const { values, system } = checkCommon(env, CONTRACT_CLAUDE_NACH);
  tripwire(env, SECRET_NAMES.claudeNach);
  checkHashes(values, ['A6_AUFTRAG_SHA256', 'A6_SCHNAPPSCHUSS_SHA256']);
  const compare = SECRET_NAMES.claudeNach.map(key => values[key]);

  if (compare.length !== 2 || compare.some(value => !value.isWellFormed() || [...value].length < MIN_COMPARE_LENGTH || value.length > MAX_COMPARE_LENGTH)) {
    jobFail('job-vergleich-wert');
  }

  return Object.freeze({
    repository: values.GITHUB_REPOSITORY,
    runId: values.GITHUB_RUN_ID,
    baseSha: values.GITHUB_SHA,
    workspace: values.GITHUB_WORKSPACE,
    runnerTemp: values.RUNNER_TEMP,
    outputPath: outputBelow(values),
    path: values.PATH,
    system: Object.freeze(system),
    orderSha256: values.A6_AUFTRAG_SHA256,
    snapshotSha256: values.A6_SCHNAPPSCHUSS_SHA256,
    compareValues: Object.freeze(compare),
  });
}

// Job 3, Veroeffentlichung. Nur der App-Token ist erlaubt. Keine Ausgabedatei: Job 3 gibt nichts aus.
export function readVeroeffentlichenContract(env) {
  const { values, system } = checkCommon(env, CONTRACT_VEROEFFENTLICHEN);
  tripwire(env, SECRET_NAMES.veroeffentlichen);
  checkHashes(values, ['A6_AUFTRAG_SHA256', 'A6_PAKET_SHA256']);
  const eventPath = checkAbsolute(values.GITHUB_EVENT_PATH, 'job-ereignis-pfad');

  if (!isBelow(eventPath, values.RUNNER_TEMP)) {
    jobFail('job-ereignis-pfad');
  }

  return Object.freeze({
    repository: values.GITHUB_REPOSITORY,
    runId: values.GITHUB_RUN_ID,
    baseSha: values.GITHUB_SHA,
    workspace: values.GITHUB_WORKSPACE,
    runnerTemp: values.RUNNER_TEMP,
    eventPath,
    path: values.PATH,
    system: Object.freeze(system),
    orderSha256: values.A6_AUFTRAG_SHA256,
    packageSha256: values.A6_PAKET_SHA256,
    token: values[APP_TOKEN_KEY],
  });
}

// ---------------------------------------------------------------------------
// Feste Pfade, eigene Ordner, Git-Umgebung
// ---------------------------------------------------------------------------

export const snapshotPath = runnerTemp => join(runnerTemp, SNAPSHOT_DIR, SNAPSHOT_FILE);
export const packagePath = runnerTemp => join(runnerTemp, PACKAGE_DIR, PACKAGE_FILE);

// Fester Ordner direkt unter RUNNER_TEMP, der noch nicht existieren darf (auch kein Symlink). Ergebnis:
// der Pfad. Das Anlegen uebernimmt der Aufrufer (etwa prepareWorkspace).
export function absentDir(runnerTemp, name, code) {
  const path = join(runnerTemp, name);

  if (lstatOrNull(path) !== null) {
    jobFail(code);
  }

  return path;
}

// Fester, schon vorhandener Ordner direkt unter RUNNER_TEMP: echtes Verzeichnis, kein Symlink.
export function existingDir(runnerTemp, name, code) {
  return checkDirectory(join(runnerTemp, name), code);
}

// Legt einen neuen Ordner direkt unter RUNNER_TEMP an. Ein vorhandener Ordner wird nie verwendet.
export function freshDir(runnerTemp, name) {
  const path = join(runnerTemp, name);

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    jobFail('job-ordner');
  }

  return checkDirectory(path, 'job-ordner');
}

// Isolierte Git-Umgebung mit eigenem, leerem HOME unter RUNNER_TEMP. PATH stammt aus dem
// Umgebungsvertrag; ein vertrauenswuerdiger Git-Pfad ist damit NICHT belegt (S2).
export function gitEnvironment(contract, homeName) {
  const home = freshDir(contract.runnerTemp, homeName);
  writeExclusive(home, 'leer.gitconfig', Buffer.alloc(0));
  return {
    ...contract.system,
    PATH: contract.path,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'leer.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  };
}

// ---------------------------------------------------------------------------
// Dateiuebergabe
// ---------------------------------------------------------------------------

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Schreibt genau diese Bytes in eine neue Datei. Vorhandene Dateien und Symlinks scheitern an wx.
export function writeExclusive(dir, name, bytes) {
  const path = join(dir, name);
  let fd;

  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    let offset = 0;

    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }

    fsyncSync(fd);
  } catch {
    jobFail('job-datei-schreiben');
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }

  return path;
}

// Liest eine gewoehnliche Datei vollstaendig und begrenzt. Kein Symlink, keine Sonderdatei, und die
// geoeffnete Datei muss dieselbe sein wie die gepruefte.
export function readBounded(path, maxBytes, code) {
  checkAbsolute(path, code);
  const before = lstatOrNull(path);

  if (!before || before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > maxBytes) {
    jobFail(code);
  }

  let fd;

  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    jobFail(code);
  }

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) {
      jobFail(code);
    }

    const bytes = Buffer.alloc(stat.size);
    let offset = 0;

    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);

      if (read === 0) {
        jobFail(code);
      }

      offset += read;
    }

    // Die Datei darf nicht gewachsen sein.
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) {
      jobFail(code);
    }

    return bytes;
  } finally {
    closeSync(fd);
  }
}

// Haengt genau die zwei Hash-Ausgaben von Job 0 an GITHUB_OUTPUT an, in einem einzigen Schreibvorgang.
// Die Schluessel sind fest, die Werte muessen 64 kleine Hex-Zeichen sein.
export function writeHashOutputs(contract, auftragSha256, schnappschussSha256) {
  if (!HEX64_RE.test(auftragSha256) || !HEX64_RE.test(schnappschussSha256)) {
    jobFail('job-ausgabe-format');
  }

  const text = `${OUTPUT_KEYS[0]}=${auftragSha256}\n${OUTPUT_KEYS[1]}=${schnappschussSha256}\n`;
  appendOutput(contract.outputPath, text);
}

// Haengt genau die eine Ausgabe paket_sha256 von Job 1b an GITHUB_OUTPUT an. Fester Schluessel, Wert
// 64 kleine Hex-Zeichen. Kein Pfad, kein Inhalt, kein freies JSON.
export function writePackageOutput(contract, paketSha256) {
  if (!HEX64_RE.test(paketSha256)) {
    jobFail('job-ausgabe-format');
  }

  appendOutput(contract.outputPath, `${PACKAGE_OUTPUT_KEY}=${paketSha256}\n`);
}

// Einzige anhaengende Schreibstelle: bestehende gewoehnliche Datei, kein Symlink, dieselbe Datei wie
// geprueft, ein einziger Schreibvorgang.
function appendOutput(outputPath, text) {
  const before = lstatOrNull(outputPath);

  if (!before || before.isSymbolicLink() || !before.isFile()) {
    jobFail('job-ausgabe-datei');
  }

  let fd;

  try {
    fd = openSync(outputPath, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
  } catch {
    jobFail('job-ausgabe-datei');
  }

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      jobFail('job-ausgabe-datei');
    }

    const bytes = Buffer.from(text, 'utf8');

    if (writeSync(fd, bytes, 0, bytes.length) !== bytes.length) {
      jobFail('job-ausgabe-datei');
    }
  } finally {
    closeSync(fd);
  }
}

// Ereignisdatei des Runners: begrenzt, strenges UTF-8, ein JSON-Objekt.
export function readEventFile(contract) {
  const bytes = readBounded(contract.eventPath, MAX_EVENT_FILE_BYTES, 'job-ereignis-datei');
  let value;

  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    jobFail('job-ereignis-datei');
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    jobFail('job-ereignis-datei');
  }

  return value;
}

// ---------------------------------------------------------------------------
// Schnappschuss agent-auftrag-schnappschuss-v1
// ---------------------------------------------------------------------------
//
// Genau diese Felder, in dieser Reihenfolge, ohne weitere:
// {
//   schema: "agent-auftrag-schnappschuss-v1",
//   repository: "noah04091/agenten-probe",
//   issue: { number, state, title, body, updated_at, user: { login, type }, labels: [{ name }] },
//   events: [{ id, event, created_at, actor, label, performed_via_github_app }],
//   run: { id, attempt: 1, createdAt },
//   event: { action, label: { name }, sender: { login, type }, repository: { full_name },
//            issue: { number, title, body, updated_at } }
// }
// Typen: number und id sind sichere Ganzzahlen; body ist Text oder null; alle anderen Blattwerte
// des Issues, des Laufs und der Nutzlast sind Texte. In events gilt:
// - actor: null oder { login: Text oder null, type: Text oder null }
// - label: null oder { name: Text oder null }
// - performed_via_github_app: null oder { id: Ganzzahl oder null, slug: Text oder null }
// Ein Ereignis ueber eine App bleibt also immer ein Objekt. Fehlend und null sind fuer die Pruefung
// des Auftragsmoduls gleichbedeutend (Eigentuemerereignis); jeder andere Originalwert wird hier zu
// einem Objekt und damit nie zu fehlend oder null. Das Feld ist Pflicht, ein Weglassen scheitert.
// Fehlende Felder des Originals werden nur dort zu null, wo das Auftragsmodul fehlend und null
// gleich behandelt (actor, login, type, label, name, App). Kein Wert wird eigentuemerfreundlicher.

const ISSUE_KEYS = Object.freeze(['number', 'state', 'title', 'body', 'updated_at', 'user', 'labels']);
const EVENT_ITEM_KEYS = Object.freeze(['id', 'event', 'created_at', 'actor', 'label', 'performed_via_github_app']);
const RUN_KEYS = Object.freeze(['id', 'attempt', 'createdAt']);
const START_KEYS = Object.freeze(['action', 'label', 'sender', 'repository', 'issue']);
const START_ISSUE_KEYS = Object.freeze(['number', 'title', 'body', 'updated_at']);
const TOP_KEYS = Object.freeze(['schema', 'repository', 'issue', 'events', 'run', 'event']);
const USER_KEYS = Object.freeze(['login', 'type']);
const NAME_KEYS = Object.freeze(['name']);
const APP_KEYS = Object.freeze(['id', 'slug']);

function isPlain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value, key) {
  if (!isPlain(value)) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function ownList(value, max, code) {
  if (!Array.isArray(value) || value.length > max) {
    jobFail(code);
  }

  const copy = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    copy.push(descriptor && 'value' in descriptor ? descriptor.value : undefined);
  }

  return copy;
}

const isText = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
const isCount = value => Number.isSafeInteger(value) && value >= 1;
const textOrNull = value => (isText(value) ? value : null);

function need(condition, code) {
  if (!condition) {
    jobFail(code);
  }
}

function text(value, code) {
  need(isText(value), code);
  return value;
}

function user(value, code) {
  return { login: text(own(value, 'login'), code), type: text(own(value, 'type'), code) };
}

// Baut den Schnappschuss aus den bereits gelesenen Originaldaten. Wird nur nach einem erfolgreichen
// resolveOrder auf genau diesen Daten aufgerufen; jede unerwartete Form bricht trotzdem ab.
// Ergebnis: kanonische Bytes (JSON mit zwei Leerzeichen, abschliessender Zeilenumbruch).
export function buildSnapshot({ issue, events, run, event }) {
  const code = 'job-schnappschuss-quelle';
  const number = own(issue, 'number');
  const body = own(issue, 'body');
  need(isCount(number) && number <= MAX_ISSUE && (body === null || isText(body)), code);

  const snapshotIssue = {
    number,
    state: text(own(issue, 'state'), code),
    title: text(own(issue, 'title'), code),
    body,
    updated_at: text(own(issue, 'updated_at'), code),
    user: user(own(issue, 'user'), code),
    labels: ownList(own(issue, 'labels'), MAX_SNAPSHOT_LABELS, code).map(label => ({ name: text(own(label, 'name'), code) })),
  };

  const snapshotEvents = ownList(events, MAX_SNAPSHOT_EVENTS, code).map(item => {
    const id = own(item, 'id');
    need(isPlain(item) && isCount(id), code);
    const actor = own(item, 'actor');
    const label = own(item, 'label');
    const app = own(item, 'performed_via_github_app');
    const appId = own(app, 'id');

    return {
      id,
      event: text(own(item, 'event'), code),
      created_at: text(own(item, 'created_at'), code),
      actor: isPlain(actor) ? { login: textOrNull(own(actor, 'login')), type: textOrNull(own(actor, 'type')) } : null,
      label: isPlain(label) ? { name: textOrNull(own(label, 'name')) } : null,
      // Nur fehlend und null werden zu null. Jeder andere Wert bleibt als Objekt erkennbar.
      performed_via_github_app: app === undefined || app === null
        ? null
        : { id: Number.isSafeInteger(appId) ? appId : null, slug: textOrNull(own(app, 'slug')) },
    };
  });

  const runId = own(run, 'id');
  need(isText(runId) && RUN_ID_RE.test(runId) && own(run, 'attempt') === 1, code);
  const snapshotRun = { id: runId, attempt: 1, createdAt: text(own(run, 'createdAt'), code) };

  const startIssue = own(event, 'issue');
  const startNumber = own(startIssue, 'number');
  const startBody = own(startIssue, 'body');
  need(isCount(startNumber) && startNumber <= MAX_ISSUE && (startBody === null || isText(startBody)), code);
  const snapshotEvent = {
    action: text(own(event, 'action'), code),
    label: { name: text(own(own(event, 'label'), 'name'), code) },
    sender: user(own(event, 'sender'), code),
    repository: { full_name: text(own(own(event, 'repository'), 'full_name'), code) },
    issue: { number: startNumber, title: text(own(startIssue, 'title'), code), body: startBody, updated_at: text(own(startIssue, 'updated_at'), code) },
  };

  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    repository: SNAPSHOT_REPOSITORY,
    issue: snapshotIssue,
    events: snapshotEvents,
    run: snapshotRun,
    event: snapshotEvent,
  };
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  need(bytes.length <= MAX_SNAPSHOT_BYTES, 'job-schnappschuss-groesse');
  return bytes;
}

// Tiefe von Objekten und Listen, Klammern in Texten zaehlen nicht.
function jsonDepth(source) {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  let escaped = false;

  for (const char of source) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
      deepest = Math.max(deepest, depth);
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
  }

  return deepest;
}

function exactKeys(value, keys, code) {
  need(isPlain(value), code);
  const actual = Reflect.ownKeys(value);
  need(actual.length === keys.length && keys.every((key, index) => actual[index] === key), code);
}

function readUser(value, code) {
  exactKeys(value, USER_KEYS, code);
  return { login: text(value.login, code), type: text(value.type, code) };
}

function readNullableUser(value, code) {
  if (value === null) {
    return null;
  }

  exactKeys(value, USER_KEYS, code);
  need(value.login === null || isText(value.login), code);
  need(value.type === null || isText(value.type), code);
  return { login: value.login, type: value.type };
}

function readNullableName(value, code) {
  if (value === null) {
    return null;
  }

  exactKeys(value, NAME_KEYS, code);
  need(value.name === null || isText(value.name), code);
  return { name: value.name };
}

function readApp(value, code) {
  if (value === null) {
    return null;
  }

  exactKeys(value, APP_KEYS, code);
  need(value.id === null || Number.isSafeInteger(value.id), code);
  need(value.slug === null || isText(value.slug), code);
  return { id: value.id, slug: value.slug };
}

// Liest Schnappschussbytes streng: Groesse, UTF-8 ohne BOM, kein NUL, Tiefe, kanonische Form (damit
// auch keine doppelten Schluessel), exakte Schluessel und Typen. Ergebnis: frisch gebaute Daten fuer
// resolveOrder (repository, issue, events, run, event), nie die geparsten Objekte selbst.
export function parseSnapshot(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length >= 1 && bytes.length <= MAX_SNAPSHOT_BYTES, 'job-schnappschuss-groesse');
  need(!bytes.includes(0), 'job-schnappschuss-format');
  need(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'job-schnappschuss-format');
  let source;

  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    jobFail('job-schnappschuss-utf8');
  }

  need(jsonDepth(source) <= MAX_SNAPSHOT_DEPTH, 'job-schnappschuss-tiefe');
  let value;

  try {
    value = JSON.parse(source);
  } catch {
    jobFail('job-schnappschuss-format');
  }

  need(`${JSON.stringify(value, null, 2)}\n` === source, 'job-schnappschuss-kanonisch');
  const code = 'job-schnappschuss-schema';
  exactKeys(value, TOP_KEYS, code);
  need(value.schema === SNAPSHOT_SCHEMA, code);
  need(value.repository === SNAPSHOT_REPOSITORY, code);

  const issue = value.issue;
  exactKeys(issue, ISSUE_KEYS, code);
  need(isCount(issue.number) && issue.number <= MAX_ISSUE, code);
  need(issue.body === null || isText(issue.body), code);
  need(Array.isArray(issue.labels) && issue.labels.length <= MAX_SNAPSHOT_LABELS, code);
  const labels = issue.labels.map(label => {
    exactKeys(label, NAME_KEYS, code);
    return { name: text(label.name, code) };
  });

  need(Array.isArray(value.events) && value.events.length <= MAX_SNAPSHOT_EVENTS, code);
  const events = value.events.map(item => {
    exactKeys(item, EVENT_ITEM_KEYS, code);
    need(isCount(item.id), code);
    return {
      id: item.id,
      event: text(item.event, code),
      created_at: text(item.created_at, code),
      actor: readNullableUser(item.actor, code),
      label: readNullableName(item.label, code),
      performed_via_github_app: readApp(item.performed_via_github_app, code),
    };
  });

  const run = value.run;
  exactKeys(run, RUN_KEYS, code);
  need(isText(run.id) && RUN_ID_RE.test(run.id) && run.attempt === 1, code);

  const event = value.event;
  exactKeys(event, START_KEYS, code);
  exactKeys(event.label, NAME_KEYS, code);
  exactKeys(event.repository, ['full_name'], code);
  exactKeys(event.issue, START_ISSUE_KEYS, code);
  need(isCount(event.issue.number) && event.issue.number <= MAX_ISSUE, code);
  need(event.issue.body === null || isText(event.issue.body), code);

  return {
    repository: value.repository,
    issue: {
      number: issue.number,
      state: text(issue.state, code),
      title: text(issue.title, code),
      body: issue.body,
      updated_at: text(issue.updated_at, code),
      user: readUser(issue.user, code),
      labels,
    },
    events,
    run: { id: run.id, attempt: 1, createdAt: text(run.createdAt, code) },
    event: {
      action: text(event.action, code),
      label: { name: text(event.label.name, code) },
      sender: readUser(event.sender, code),
      repository: { full_name: text(event.repository.full_name, code) },
      issue: {
        number: event.issue.number,
        title: text(event.issue.title, code),
        body: event.issue.body,
        updated_at: text(event.issue.updated_at, code),
      },
    },
  };
}
