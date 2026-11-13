// A6.2-6: Allgemeiner Veroeffentlichungsplan und sicherer Draft-PR-Veroeffentlicher.
//
// Wirkungslos bis A6.4: Kein Workflow und kein anderes Skript ruft dieses Modul auf. Es hat keinen
// Einstiegspunkt, liest keine Prozessumgebung, hat keine Zugangsdaten und stellt selbst keine
// Netzanfragen. Jede GitHub-Anfrage laeuft ueber die ausdruecklich uebergebene Transportfunktion.
// Der A5-Veroeffentlicher (agent-code-publish.mjs) bleibt unveraendert und wird nicht verwendet.
//
// Ablauf von publishOrderDraft (Phasen wie im Auftrag A6.2-6):
// - A: root und checkRoot getrennt pruefen, Live-Zustand lesen, mit checkLiveOrder pruefen
//   (Ergebnis orderA), Paket mit parsePackageV2 pruefen und mit applyPackageV2 im frischen
//   Pruef-Checkout anwenden. parsePackageV2 und applyPackageV2 bekommen genau dasselbe Objekt orderA.
//   Unmittelbar vor dem Anwenden werden root und checkRoot erneut getrennt und muessen dieselben
//   kanonischen Pfade ergeben, danach muss root vollstaendig sauber sein. Dazu der Ausgangsbaum aus
//   den lokalen, nachgerechneten Git-Objekten unter root.
// - B: Live-Zustand neu lesen und vollstaendig pruefen, unmittelbar vor dem ersten Upload. Reicht die
//   Restfrist schon hier nicht fuer den Branch, wird nichts hochgeladen.
// - C: Blobs aus packageFileBytes hochladen, Baum und Commit bauen und jeweils zuruecklesen.
// - D: Live-Zustand neu lesen und vollstaendig pruefen, Freigabefrist mit Reserve pruefen.
// - E: Branch wp/<issue>-agent-<runId>-1 mit POST git/refs anlegen.
// - F: Unveraendert-Pruefung gegen den Zustand aus D, dann den Branch-Ref einzeln pruefen.
// - G: Remote-Diff (compare) pruefen.
// - H: Unveraendert-Pruefung, Branch-Ref und beide Zeitgrenzen erneut, dann POST pulls (Draft).
// Spaetere Live-Pruefungen bilden neue Auftragsobjekte. Sie werden nur ueber sameOrder an den
// erwarteten Hash gebunden und ersetzen orderA nie.
//
// Zeitgrenzen:
// - Die Startfreigabe gilt bis genau 60:00 nach orderA.startfreigabe.zeitpunkt (dieselbe Regel wie
//   evaluateStartApprovals: abgelaufen erst bei mehr als APPROVAL_DEADLINE_MS).
// - Vor POST git/refs muessen davon noch mindestens BRANCH_RESERVE_MS uebrig sein (58:00 gilt noch,
//   58:00,001 nicht mehr).
// - Von der Live-Pruefung in D bis POST pulls hoechstens PUBLISH_WINDOW_MS (120 000 ms gilt noch).
// - Je Pruefung genau ein Uhrwert. Der Wert aus D geht als now an checkLiveOrder und ist zugleich
//   der Beginn der Zeitklammer. Jeder Uhrwert muss mindestens so gross sein wie der vorige.
//   Wegen Reserve und Zeitklammer kann die 60-Minuten-Pruefung vor POST pulls im Ablauf nicht
//   ausloesen (58:00 plus 120 s ist genau 60:00). Sie bleibt als zweite Linie und ist einzeln
//   ueber checkApprovalDeadline getestet.
//
// Vertrag der Transportfunktion (wird erst in A6.4 gebaut):
// - transport({ method, path }) fuer GET und DELETE, transport({ method, path, body }) fuer POST mit
//   body als JSON-Text. path ist relativ zu https://api.github.com und beginnt immer mit
//   /repos/noah04091/agenten-probe/. Ergebnis (auch als Promise): { status, headers, body } wie in
//   agent-code-auftrag-live.mjs. Der Transport traegt Token, Zeitlimit, Groessenlimit und folgt
//   keiner Weiterleitung. Dieses Modul lehnt jede sichtbare Weiterleitung, jeden unerwarteten Status
//   und jede unvollstaendige Antwort ab.
// - Erlaubte Aufrufe: die sechs GET-Pfade der Live-Pruefung, GET git/commits/<sha>,
//   GET git/trees/<sha>?recursive=1, GET git/ref/heads/<eigener Branch>, GET compare/<a>...<b>,
//   POST git/blobs, git/trees, git/commits, git/refs, pulls und DELETE git/refs/heads/<eigener
//   Branch>. Keine Issue-Kommentare, keine anderen Methoden.
//
// Bereinigung (A1a): Der eigene Branch wird nur geloescht, wenn sein Name exakt dem berechneten
// entspricht, seine Anlage in diesem Lauf eindeutig bestaetigt ist, noch kein POST pulls abgeschickt
// wurde, die Spitze noch auf den eigenen Commit zeigt und die vollstaendige PR-Liste ohne PR zu
// diesem Branch gelesen wurde. Sonst bleibt er stehen. Der urspruengliche Fehler bleibt erhalten.
//
// Grenzen, die dieses Modul nicht schliessen kann und die A6.4 tragen muss:
// - K1 bis K4, tatsaechliche Isolation von Claude und Bind-Mount-Schutz, Concurrency je Issue,
//   Einmalverwendung der Startfreigabe, Messung des Webhook-Schnappschusses, sichere produktive
//   Transportfunktion und Token-Trennung, Geheimniswertabgleich vor dem Artefakt-Upload,
//   Absicherung aller Post- und Cleanup-Schritte, produktive Workflow-Verdrahtung.
// - Keine atomare Momentaufnahme: Zwischen der letzten Pruefung und POST pulls kann sich GitHub
//   aendern. Das Fenster ist durch die Zeitklammer begrenzt, nicht geschlossen.
// - Hochgeladene Blobs, Baeume und Commits ohne Branch bleiben bei einem Abbruch als nicht
//   referenzierte Objekte auf GitHub liegen. Sie sind ohne Ref nicht sichtbar und werden nicht
//   geloescht (dafuer gibt es keine API).
// - Pfadtrennung ist eine Pruefung zu einem Zeitpunkt. Zwischen der zweiten Trennung und dem
//   Schreiben in applyPackageV2 bleibt ein kurzes Fenster; die Nachpruefung von root faengt eine
//   Umlenkung danach ab, verhindert sie aber nicht. Die Elternordner beider Checkouts duerfen nur vom
//   Runner beschreibbar sein, die echte Trennung (Bind-Mount, Isolation) bleibt Pflicht in A6.4.
// - Transport und Uhr werden ohne this aufgerufen. Haengt der Transport, haengt auch die
//   Bereinigung; das Zeitlimit muss der Transport aus A6.4 tragen.
// - Ein fehlgeschlagener oder schon verwendeter Pruef-Checkout darf nicht weiterverwendet werden.
//   Innerhalb eines Prozesses lehnt das Modul denselben Pruef-Checkout ein zweites Mal ab.

import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { types } from 'node:util';

import { APPROVAL_DEADLINE_MS, MAX_ISSUE_NUMBER, OrderError, REPOSITORY, openRepository, orderSha256, runGit, sameOrder } from './agent-code-auftrag.mjs';
import { MAX_BODY_BYTES, checkApiRequest, checkLiveOrder, readLiveState } from './agent-code-auftrag-live.mjs';
import { applyPackageV2, packageFileBytes, parsePackageV2 } from './agent-code-auftrag-paket.mjs';

export const PUBLISH_WINDOW_MS = 120_000;
export const BRANCH_RESERVE_MS = 120_000;

const API_PREFIX = `/repos/${REPOSITORY}/`;
const PR_URL_PREFIX = `https://github.com/${REPOSITORY}/pull/`;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^[1-9][0-9]{0,15}$/;
const BRANCH_RE = /^wp\/[1-9][0-9]{0,7}-agent-[1-9][0-9]{0,15}-1$/;
const POST_PATHS = Object.freeze(['git/blobs', 'git/trees', 'git/commits', 'git/refs', 'pulls']);
const GET_PATTERNS = Object.freeze([
  /^git\/commits\/[0-9a-f]{40}$/,
  /^git\/trees\/[0-9a-f]{40}\?recursive=1$/,
  /^compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/,
]);
const INPUT_KEYS = Object.freeze([
  'root', 'checkRoot', 'baseSha', 'event', 'expectedSha256', 'runId', 'packageBytes', 'packageSha256', 'gitEnv', 'transport', 'clock',
]);
const ROOT_STATUS_ARGS = Object.freeze(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
const BACKSLASH = String.fromCharCode(92);
const USED_CHECKOUTS = new Set();

function fail(code, message) {
  throw new OrderError(code, `Veroeffentlichung abgelehnt: ${message}`);
}

// Wie in den anderen Auftragsmodulen: nur einfache Objekte ohne Proxy, nur eigene Dateneigenschaften.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value, key) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

// Liest eine JSON-Liste (aus JSON.parse, also nie ein Proxy) oder null.
function list(value) {
  return Array.isArray(value) ? value : null;
}

// Strenger Vergleich zweier JSON-Werte: gleiche Typen, gleiche Schluessel in gleicher Reihenfolge,
// gleiche Werte. Jede Abweichung zaehlt, auch eine harmlose.
function sameJson(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Object.is(a, b);
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }

  const keysA = Reflect.ownKeys(a);
  const keysB = Reflect.ownKeys(b);
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && sameJson(a[key], b[key]));
}

function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId) && Number.isSafeInteger(Number(runId));
}

// ---------------------------------------------------------------------------
// Feste Namen, erlaubte Anfragen und Zeitgrenzen (einzeln pruefbar)
// ---------------------------------------------------------------------------

// Einziger Branch-Name dieses Moduls. Keine freie Eingabe.
export function branchName(issue, runId) {
  if (!Number.isSafeInteger(issue) || issue < 1 || issue > MAX_ISSUE_NUMBER) {
    fail('publish-branch-name', 'Issue-Nummer ungueltig');
  }

  if (!isValidRunId(runId)) {
    fail('publish-branch-name', 'Lauf-ID ungueltig');
  }

  return `wp/${issue}-agent-${runId}-1`;
}

// Prueft jede eigene Anfrage dieses Moduls vor dem Transport. branch ist der berechnete Branch.
export function checkPublishRequest(method, path, branch) {
  if (typeof path !== 'string' || !path.startsWith(API_PREFIX)) {
    fail('publish-pfad', 'Pfad liegt ausserhalb des Repositorys');
  }

  const rest = path.slice(API_PREFIX.length);
  const ownBranch = typeof branch === 'string' && BRANCH_RE.test(branch) ? branch : null;

  if (method === 'POST') {
    if (!POST_PATHS.includes(rest)) {
      fail('publish-pfad', 'POST nur auf git/blobs, git/trees, git/commits, git/refs und pulls');
    }

    return true;
  }

  if (method === 'DELETE') {
    if (ownBranch === null || rest !== `git/refs/heads/${ownBranch}`) {
      fail('publish-pfad', 'DELETE nur auf den eigenen Branch');
    }

    return true;
  }

  if (method === 'GET') {
    if (!GET_PATTERNS.some(pattern => pattern.test(rest)) && (ownBranch === null || rest !== `git/ref/heads/${ownBranch}`)) {
      fail('publish-pfad', 'GET-Pfad ist nicht erlaubt');
    }

    return true;
  }

  fail('publish-methode', 'nur GET, POST und DELETE sind erlaubt');
}

function approvalMs(approvalTime) {
  const ms = typeof approvalTime === 'string' ? Date.parse(approvalTime) : Number.NaN;

  if (!Number.isFinite(ms)) {
    fail('publish-freigabe-zeit', 'Zeitpunkt der Startfreigabe ungueltig');
  }

  return ms;
}

function requireMs(value) {
  if (!Number.isSafeInteger(value)) {
    fail('publish-uhr', 'Zeitwert ungueltig');
  }

  return value;
}

// Dieselbe Grenze wie evaluateStartApprovals: genau 60:00 gilt noch, 60:00,001 nicht mehr.
export function checkApprovalDeadline(approvalTime, nowMs) {
  if (requireMs(nowMs) - approvalMs(approvalTime) > APPROVAL_DEADLINE_MS) {
    fail('publish-freigabe-abgelaufen', 'Startfreigabe ist aelter als 60 Minuten');
  }

  return true;
}

// Vor der Branch-Anlage muessen noch mindestens BRANCH_RESERVE_MS der Frist uebrig sein.
export function checkBranchReserve(approvalTime, nowMs) {
  if (APPROVAL_DEADLINE_MS - (requireMs(nowMs) - approvalMs(approvalTime)) < BRANCH_RESERVE_MS) {
    fail('publish-freigabe-reserve', 'Restfrist der Startfreigabe reicht nicht fuer Branch und PR');
  }

  return true;
}

// Von der letzten vollstaendigen Pruefung (startMs) bis jetzt hoechstens PUBLISH_WINDOW_MS.
export function checkTimeWindow(startMs, nowMs) {
  if (requireMs(nowMs) < requireMs(startMs)) {
    fail('publish-uhr-rueckwaerts', 'Uhr ist rueckwaerts gesprungen');
  }

  if (nowMs - startMs > PUBLISH_WINDOW_MS) {
    fail('publish-zeitklammer', `mehr als ${PUBLISH_WINDOW_MS} ms seit der letzten vollstaendigen Pruefung`);
  }

  return true;
}

// Genau ein Uhrwert je Pruefung. Nur echte Date-Objekte, nie rueckwaerts.
function readClock(ctx) {
  let value;
  let ms;

  try {
    // Ohne this: Die Uhr darf den internen Zustand nicht erreichen.
    value = Reflect.apply(ctx.clock, undefined, []);
  } catch {
    fail('publish-uhr', 'Uhr nicht lesbar');
  }

  try {
    ms = Date.prototype.getTime.call(value);
  } catch {
    fail('publish-uhr', 'Uhr liefert kein Date');
  }

  if (!Number.isSafeInteger(ms)) {
    fail('publish-uhr', 'Uhr liefert einen ungueltigen Zeitpunkt');
  }

  if (ctx.lastMs !== null && ms < ctx.lastMs) {
    fail('publish-uhr-rueckwaerts', 'Uhr ist rueckwaerts gesprungen');
  }

  ctx.lastMs = ms;
  ctx.clockReads += 1;
  return ms;
}

// ---------------------------------------------------------------------------
// Verzeichnistrennung von root und checkRoot
// ---------------------------------------------------------------------------

function pathKey(path) {
  const text = path.split(BACKSLASH).join('/').toLowerCase();
  return text.endsWith('/') ? text : `${text}/`;
}

// Vorhandenes, echtes Verzeichnis (selbst kein Symlink), kanonisch und ohne UNC- oder Geraetepfad.
function realDirectory(path, name) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    fail('publish-pfad-eingabe', `${name} muss ein absoluter Pfad sein`);
  }

  let stat;
  let real;

  try {
    stat = lstatSync(path);
    real = realpathSync.native(path);
  } catch {
    fail('publish-pfad-eingabe', `${name} kann nicht aufgeloest werden`);
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('publish-pfad-eingabe', `${name} ist kein echtes Verzeichnis`);
  }

  if (/^[\\/]{2}/.test(real)) {
    fail('publish-pfad-eingabe', `${name}: UNC- und Geraetepfade sind nicht erlaubt`);
  }

  return real;
}

function identity(path) {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function ancestors(path) {
  const result = [];

  for (let current = path; ; current = dirname(current)) {
    result.push(current);

    if (dirname(current) === current) {
      return result;
    }
  }
}

// Erste Ebene: Pfadtext nach realpath, ohne Gross- und Kleinschreibung, in beide Richtungen.
// Zweite Ebene: Geraet und Inode jedes Vorfahren, unabhaengig vom Pfadtext.
function separateDirectories(root, checkRoot) {
  const realRoot = realDirectory(root, 'root');
  const realCheck = realDirectory(checkRoot, 'checkRoot');
  const keyRoot = pathKey(realRoot);
  const keyCheck = pathKey(realCheck);

  if (keyRoot.startsWith(keyCheck) || keyCheck.startsWith(keyRoot)) {
    fail('publish-verzeichnis-ueberschneidung', 'root und checkRoot ueberschneiden sich');
  }

  const idRoot = identity(realRoot);
  const idCheck = identity(realCheck);

  if (
    idRoot === null || idCheck === null ||
    ancestors(realCheck).some(path => identity(path) === idRoot) ||
    ancestors(realRoot).some(path => identity(path) === idCheck)
  ) {
    fail('publish-verzeichnis-ueberschneidung', 'root und checkRoot sind nicht eindeutig getrennt');
  }

  return { realRoot, realCheck, checkKey: keyCheck };
}

// ---------------------------------------------------------------------------
// GitHub-Anfragen ueber den injizierten Transport
// ---------------------------------------------------------------------------

function readHeaders(headers) {
  if (!isPlainObject(headers)) {
    fail('publish-antwort-format', 'Kopfzeilen fehlen oder sind kein Objekt');
  }

  const names = new Set();

  for (const key of Reflect.ownKeys(headers)) {
    if (typeof key !== 'string' || typeof own(headers, key) !== 'string') {
      fail('publish-antwort-format', 'Kopfzeile ist kein Text');
    }

    const name = key.toLowerCase();

    if (names.has(name)) {
      fail('publish-antwort-format', 'Kopfzeile doppelt');
    }

    names.add(name);
  }

  // Keine eigene Antwort dieses Moduls ist seitenweise. Eine Fortsetzung hiesse unvollstaendig.
  if (names.has('link')) {
    fail('publish-antwort-unvollstaendig', 'Antwort ist seitenweise');
  }
}

// Ruft den Transport genau einmal auf. Schreibende Aufrufe nur, wenn der Ablauf sie gerade erlaubt.
async function send(ctx, method, rest, payload, expectedStatus) {
  const path = `${API_PREFIX}${rest}`;
  checkPublishRequest(method, path, ctx.branch);

  if (ctx.closed) {
    fail('publish-abgeschlossen', 'nach der PR-Anfrage sind keine weiteren Anfragen erlaubt');
  }

  if (method === 'POST' && ctx.allowedWrite !== rest) {
    fail('publish-schreiben-gesperrt', `POST ${rest} ist in diesem Schritt nicht erlaubt`);
  }

  if (method === 'DELETE' && !ctx.deleteAllowed) {
    fail('publish-schreiben-gesperrt', 'Loeschen ist nicht freigegeben');
  }

  const request = payload === undefined ? { method, path } : { method, path, body: JSON.stringify(payload) };

  if (method !== 'GET') {
    ctx.writes += 1;
  }

  if (method === 'POST' && rest === 'pulls') {
    // Ab hier ist unklar, ob GitHub einen PR anlegt. Danach nie mehr loeschen, keine Anfragen mehr.
    ctx.prRequested = true;
    ctx.closed = true;
  }

  let response;

  try {
    // Ohne this: Der Transport darf Merker wie prRequested oder branch nicht erreichen.
    response = await Reflect.apply(ctx.transport, undefined, [Object.freeze(request)]);
  } catch {
    // Die Nachricht des Transports wird nicht uebernommen (sie koennte Zugangsdaten enthalten).
    fail('publish-transport-fehler', `${method} ${rest.split('/')[0]} gescheitert`);
  }

  const status = own(response, 'status');
  const body = own(response, 'body');

  if (!Number.isInteger(status)) {
    fail('publish-antwort-format', 'Status fehlt');
  }

  readHeaders(own(response, 'headers'));

  if (status >= 300 && status < 400) {
    fail('publish-umleitung', `Weiterleitung ${status} wird nicht verfolgt`);
  }

  if (status !== expectedStatus) {
    fail('publish-http-status', `unerwarteter Status ${status}`);
  }

  if (typeof body !== 'string') {
    fail('publish-antwort-format', 'Antworttext fehlt');
  }

  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    fail('publish-antwort-gross', 'Antwort zu gross');
  }

  if (expectedStatus === 204) {
    if (body !== '') {
      fail('publish-antwort-format', 'Antwort auf DELETE ist nicht leer');
    }

    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    fail('publish-antwort-json', 'Antwort ist kein vollstaendiges JSON');
  }
}

// Transport fuer readLiveState: nur dessen GET-Pfade, gesperrt nach der PR-Anfrage.
function liveTransport(ctx) {
  return request => {
    if (ctx.closed) {
      fail('publish-abgeschlossen', 'nach der PR-Anfrage sind keine weiteren Anfragen erlaubt');
    }

    checkApiRequest(own(request, 'method'), own(request, 'path'));
    return Reflect.apply(ctx.transport, undefined, [request]);
  };
}

function readState(ctx) {
  return readLiveState({ transport: ctx.liveTransport, repository: REPOSITORY, issueNumber: ctx.issueNumber, runId: ctx.runId });
}

// Vollstaendige Live-Pruefung mit frischem Zustand und genau einem Uhrwert.
async function fullLiveCheck(ctx) {
  const state = await readState(ctx);
  const ms = readClock(ctx);
  const order = checkLiveOrder({
    expectedSha256: ctx.expectedSha256,
    event: ctx.event,
    state,
    root: ctx.realRoot,
    baseSha: ctx.baseSha,
    gitEnv: ctx.gitEnv,
    now: new Date(ms),
    runId: ctx.runId,
  });
  sameOrder(order, ctx.expectedSha256);
  ctx.liveChecks += 1;
  return { state, ms };
}

// ---------------------------------------------------------------------------
// Git-Objekte auf GitHub pruefen
// ---------------------------------------------------------------------------

function readSha(value, code) {
  if (typeof value !== 'string' || !HEX40_RE.test(value)) {
    fail(code, 'SHA fehlt oder ist ungueltig');
  }

  return value;
}

// Rekursiver Baum: vollstaendig, eindeutig, nur bekannte Typen. Ergebnis: Pfad -> { mode, type, sha }.
function readTree(json, sha, code) {
  const entries = list(own(json, 'tree'));

  if (!isPlainObject(json) || own(json, 'sha') !== sha || entries === null) {
    fail(code, 'Baum fehlt oder gehoert nicht zur angefragten SHA');
  }

  if (own(json, 'truncated') !== false) {
    fail('publish-baum-unvollstaendig', 'Baum ist abgeschnitten oder ohne Angabe zur Vollstaendigkeit');
  }

  const result = new Map();

  for (const entry of entries) {
    const path = own(entry, 'path');
    const mode = own(entry, 'mode');
    const type = own(entry, 'type');
    const entrySha = own(entry, 'sha');

    if (
      typeof path !== 'string' || path === '' || typeof mode !== 'string' ||
      !['blob', 'tree', 'commit'].includes(type) || typeof entrySha !== 'string' || !HEX40_RE.test(entrySha)
    ) {
      fail(code, 'Baumeintrag unvollstaendig');
    }

    if (result.has(path)) {
      fail(code, 'Baumeintrag doppelt');
    }

    result.set(path, { mode, type, sha: entrySha });
  }

  return result;
}

function parentDirs(paths) {
  const dirs = new Set();

  for (const path of paths) {
    const parts = path.split('/');

    for (let depth = 1; depth < parts.length; depth += 1) {
      dirs.add(parts.slice(0, depth).join('/'));
    }
  }

  return dirs;
}

// Der Ausgangsbaum auf GitHub muss exakt dem lokal nachgerechneten Baum unter root entsprechen.
function checkBaseTree(remote, local) {
  const files = [...remote].filter(([, entry]) => entry.type !== 'tree');
  const dirs = [...remote].filter(([, entry]) => entry.type === 'tree').map(([path]) => path);
  const expectedDirs = parentDirs(local.keys());

  if (files.length !== local.size || dirs.length !== expectedDirs.size || !dirs.every(dir => expectedDirs.has(dir))) {
    fail('publish-basis-baum', 'Ausgangsbaum auf GitHub weicht vom lokalen Ausgangscommit ab');
  }

  for (const [path, entry] of files) {
    const mine = local.get(path);

    if (mine === undefined || mine.mode !== entry.mode || mine.type !== entry.type || mine.oid !== entry.sha) {
      fail('publish-basis-baum', 'Ausgangsbaum auf GitHub weicht vom lokalen Ausgangscommit ab');
    }
  }
}

// Der neue Baum ist der Ausgangsbaum, in dem genau die freigegebenen Dateien den gepruefen Blob
// tragen, mit Modus 100644. Nichts fehlt, nichts kommt dazu, nichts anderes aendert sich.
function checkNewTree(remote, base, files) {
  if (remote.size !== base.size) {
    fail('publish-baum-abweichung', 'neuer Baum hat fehlende oder zusaetzliche Eintraege');
  }

  const changed = new Map(files.map(file => [file.pfad, file.git_blob]));

  for (const [path, entry] of base) {
    const now = remote.get(path);
    const blob = changed.get(path);

    if (now === undefined) {
      fail('publish-baum-abweichung', 'neuer Baum hat fehlende Eintraege');
    }

    if (blob !== undefined) {
      if (now.type !== 'blob' || now.mode !== '100644' || now.sha !== blob) {
        fail('publish-baum-datei', 'freigegebene Datei hat im neuen Baum nicht Blob und Modus 100644');
      }
    } else if (now.type !== entry.type || now.mode !== entry.mode || (entry.type !== 'tree' && now.sha !== entry.sha)) {
      fail('publish-baum-abweichung', 'neuer Baum veraendert einen nicht freigegebenen Eintrag');
    }
  }
}

function checkCompare(json, ctx) {
  const commits = list(own(json, 'commits'));
  const files = list(own(json, 'files'));

  if (
    !isPlainObject(json) || own(json, 'status') !== 'ahead' || own(json, 'ahead_by') !== 1 || own(json, 'behind_by') !== 0 ||
    own(json, 'total_commits') !== 1 || commits === null || commits.length !== 1 || own(commits[0], 'sha') !== ctx.commit
  ) {
    fail('publish-compare-commits', 'Remote-Diff zeigt nicht genau den eigenen Commit');
  }

  const expected = new Map(ctx.files.map(file => [file.pfad, file.git_blob]));

  if (files === null || files.length !== expected.size) {
    fail('publish-compare-dateien', 'Remote-Diff hat fehlende oder zusaetzliche Dateien');
  }

  const seen = new Set();

  for (const file of files) {
    const name = own(file, 'filename');

    if (!expected.has(name) || seen.has(name)) {
      fail('publish-compare-dateien', 'Remote-Diff hat unerwartete oder doppelte Dateien');
    }

    seen.add(name);

    if (own(file, 'status') !== 'modified' || Object.hasOwn(file, 'previous_filename')) {
      fail('publish-compare-status', 'Remote-Diff enthaelt mehr als eine Aenderung bestehender Dateien');
    }

    if (own(file, 'sha') !== expected.get(name)) {
      fail('publish-compare-blob', 'Remote-Diff traegt einen anderen Blob');
    }
  }
}

// Einzelnes Ref-Objekt, keine Liste, exakt der eigene Branch auf dem eigenen Commit.
async function checkBranchRef(ctx) {
  const json = await send(ctx, 'GET', `git/ref/heads/${ctx.branch}`, undefined, 200);

  if (!isPlainObject(json)) {
    fail('publish-ref-format', 'Antwort ist kein einzelnes Ref-Objekt');
  }

  const object = own(json, 'object');

  if (own(json, 'ref') !== `refs/heads/${ctx.branch}` || own(object, 'type') !== 'commit' || own(object, 'sha') !== ctx.commit) {
    fail('publish-ref-abweichung', 'Branch zeigt nicht exakt auf den eigenen Commit');
  }
}

// Nach der eigenen Branch-Anlage: keine neue Freigabelogik, nur "nichts hat sich veraendert".
function checkUnchanged(ctx, state) {
  if (state.repository !== REPOSITORY || state.issueNumber !== ctx.issueNumber || state.runId !== ctx.runId) {
    fail('publish-unveraendert-zuordnung', 'Zustand gehoert zu einem anderen Repository, Issue oder Lauf');
  }

  if (own(state.run, 'id') !== Number(ctx.runId) || own(state.run, 'head_sha') !== ctx.baseSha) {
    fail('publish-unveraendert-lauf', 'Laufzuordnung hat sich veraendert');
  }

  if (state.mainSha !== ctx.baseSha) {
    fail('publish-unveraendert-main', 'main steht nicht mehr auf dem Ausgangscommit');
  }

  if (!sameJson(state.issue, ctx.stateD.issue)) {
    fail('publish-unveraendert-issue', 'Issue hat sich seit der letzten vollstaendigen Pruefung veraendert');
  }

  if (!sameJson(state.events, ctx.stateD.events)) {
    fail('publish-unveraendert-ereignisse', 'Ereignisverlauf hat sich seit der letzten vollstaendigen Pruefung veraendert');
  }

  if (state.branches.length !== 1 || state.branches[0] !== `refs/heads/${ctx.branch}`) {
    fail('publish-unveraendert-branches', 'Branch-Liste enthaelt nicht genau den eigenen Branch');
  }

  const prefix = `wp/${ctx.issueNumber}-`;

  if (state.pulls.some(pull => pull.head_ref.startsWith(prefix))) {
    fail('publish-unveraendert-pr', 'zu diesem Issue existiert inzwischen ein PR');
  }
}

function checkPullResponse(json, ctx) {
  const number = own(json, 'number');
  const base = own(json, 'base');
  const head = own(json, 'head');

  if (
    !isPlainObject(json) || !Number.isSafeInteger(number) || number < 1 || own(json, 'draft') !== true ||
    own(base, 'ref') !== 'main' || own(own(base, 'repo'), 'full_name') !== REPOSITORY ||
    own(head, 'ref') !== ctx.branch || own(head, 'sha') !== ctx.commit ||
    own(own(head, 'repo'), 'full_name') !== REPOSITORY ||
    own(json, 'html_url') !== `${PR_URL_PREFIX}${number}`
  ) {
    fail('publish-pr-antwort', 'Draft-PR-Bestaetigung ungueltig, manuell pruefen, nicht loeschen');
  }

  return number;
}

// ---------------------------------------------------------------------------
// Eingabe
// ---------------------------------------------------------------------------

function readInput(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, INPUT_KEYS)) {
    fail('publish-eingabe', `Eingabe braucht genau ${INPUT_KEYS.join(', ')}`);
  }

  // Jedes Feld genau einmal lesen.
  const fields = Object.fromEntries(INPUT_KEYS.map(key => [key, own(input, key)]));

  if (typeof fields.transport !== 'function' || typeof fields.clock !== 'function') {
    fail('publish-eingabe', 'transport und clock muessen Funktionen sein');
  }

  if (typeof fields.baseSha !== 'string' || !HEX40_RE.test(fields.baseSha)) {
    fail('publish-eingabe', 'baseSha muss aus 40 kleinen Hex-Zeichen bestehen');
  }

  if (typeof fields.expectedSha256 !== 'string' || !HEX64_RE.test(fields.expectedSha256)) {
    fail('publish-eingabe', 'expectedSha256 muss aus 64 kleinen Hex-Zeichen bestehen');
  }

  if (typeof fields.packageSha256 !== 'string' || !HEX64_RE.test(fields.packageSha256)) {
    fail('publish-eingabe', 'packageSha256 muss aus 64 kleinen Hex-Zeichen bestehen');
  }

  if (!isValidRunId(fields.runId)) {
    fail('publish-eingabe', 'runId ungueltig');
  }

  // Nur fuer das Lesen des Live-Zustands. Ob die Nummer stimmt, prueft resolveOrder gegen das Issue.
  const issueNumber = own(own(fields.event, 'issue'), 'number');

  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > MAX_ISSUE_NUMBER) {
    fail('publish-eingabe', 'Issue-Nummer im Start-Ereignis ungueltig');
  }

  return { ...fields, issueNumber };
}

// ---------------------------------------------------------------------------
// Veroeffentlichung
// ---------------------------------------------------------------------------

async function runPublish(ctx, input) {
  ctx.phase = 'A';
  const fields = readInput(input);
  Object.assign(ctx, {
    transport: fields.transport,
    clock: fields.clock,
    baseSha: fields.baseSha,
    expectedSha256: fields.expectedSha256,
    packageSha256: fields.packageSha256,
    runId: fields.runId,
    event: fields.event,
    gitEnv: fields.gitEnv,
    issueNumber: fields.issueNumber,
  });
  ctx.liveTransport = liveTransport(ctx);

  const { realRoot, realCheck, checkKey } = separateDirectories(fields.root, fields.checkRoot);
  ctx.realRoot = realRoot;

  if (USED_CHECKOUTS.has(checkKey)) {
    fail('publish-pruef-checkout-verbraucht', 'Pruef-Checkout wurde in diesem Prozess schon verwendet');
  }

  // Phase A: Auftrag und Paket pruefen. Noch kein Schreibaufruf.
  const stateA = await readState(ctx);
  const msA = readClock(ctx);
  const orderA = checkLiveOrder({
    expectedSha256: ctx.expectedSha256,
    event: ctx.event,
    state: stateA,
    root: realRoot,
    baseSha: ctx.baseSha,
    gitEnv: ctx.gitEnv,
    now: new Date(msA),
    runId: ctx.runId,
  });
  sameOrder(orderA, ctx.expectedSha256);
  ctx.liveChecks += 1;

  if (orderA.issue !== ctx.issueNumber || orderA.base_sha !== ctx.baseSha || orderA.repository !== REPOSITORY || orderA.lauf.run_id !== ctx.runId) {
    fail('publish-auftrag-zuordnung', 'Auftrag passt nicht zu Issue, Ausgangscommit oder Lauf');
  }

  ctx.branch = branchName(orderA.issue, ctx.runId);
  const parsed = parsePackageV2(orderA, ctx.expectedSha256, fields.packageBytes, ctx.packageSha256);
  USED_CHECKOUTS.add(checkKey);

  // Waehrend der Live-Lesung koennte ein Elternordner umgelenkt worden sein. Deshalb unmittelbar
  // vor dem Anwenden erneut trennen und dieselben kanonischen Pfade verlangen.
  const again = separateDirectories(fields.root, fields.checkRoot);

  if (again.realRoot !== realRoot || again.realCheck !== realCheck) {
    fail('publish-verzeichnis-geaendert', 'root oder checkRoot zeigt inzwischen auf einen anderen Ordner');
  }

  const applied = applyPackageV2(realCheck, orderA, ctx.expectedSha256, parsed, { gitEnv: ctx.gitEnv });

  // Nachweis danach: root ist weiterhin vollstaendig sauber, es wurde nichts hineingeschrieben.
  const repo = openRepository(realRoot, ctx.baseSha, ctx.gitEnv);

  if (runGit(repo.git, ROOT_STATUS_ARGS, 'publish-root-status') !== '') {
    fail('publish-root-veraendert', 'der vertrauenswuerdige Checkout ist nicht sauber');
  }

  if (!sameJson([...applied.dateien], [...orderA.dateien])) {
    fail('publish-dateiliste', 'angewendete Dateien weichen vom Auftrag ab');
  }

  ctx.files = parsed.dateien.map(meta => Object.freeze({ pfad: meta.pfad, git_blob: meta.git_blob }));

  if (!sameJson(ctx.files.map(file => file.pfad), [...orderA.dateien])) {
    fail('publish-dateiliste', 'Paketdateien weichen vom Auftrag ab');
  }

  // Bytes jetzt binden und nachrechnen, nicht erst beim Hochladen.
  const uploads = ctx.files.map(file => {
    const bytes = packageFileBytes(parsed, file.pfad);

    if (gitBlobId(bytes) !== file.git_blob) {
      fail('publish-blob-lokal', 'Paketbytes passen nicht zur geprueften Blob-ID');
    }

    return { file, base64: bytes.toString('base64') };
  });

  // Ausgangsbaum aus den lokalen, nachgerechneten Git-Objekten des vertrauenswuerdigen Checkouts.
  const localTree = repo.tree;
  const localTreeSha = runGit(repo.git, ['rev-parse', '--verify', `${ctx.baseSha}^{tree}`], 'publish-basis-baum').trim();

  for (const file of ctx.files) {
    if (localTree.get(file.pfad)?.oid !== orderA.basis_blobs[file.pfad]) {
      fail('publish-basis-baum', 'lokaler Ausgangsbaum passt nicht zum Auftrag');
    }
  }

  // Phase B: vollstaendige Live-Pruefung unmittelbar vor dem ersten Upload.
  // Reicht die Restfrist schon jetzt nicht fuer den Branch, wird gar nicht erst hochgeladen.
  ctx.phase = 'B';
  const checkB = await fullLiveCheck(ctx);
  checkBranchReserve(orderA.startfreigabe.zeitpunkt, checkB.ms);

  // Phase C: Git-Objekte erstellen und zuruecklesen.
  ctx.phase = 'C';
  ctx.allowedWrite = 'git/blobs';

  for (const upload of uploads) {
    const blob = await send(ctx, 'POST', 'git/blobs', { content: upload.base64, encoding: 'base64' }, 201);

    if (own(blob, 'sha') !== upload.file.git_blob) {
      fail('publish-blob-abweichung', 'GitHub meldet eine andere Blob-ID');
    }
  }

  ctx.allowedWrite = null;
  const baseCommit = await send(ctx, 'GET', `git/commits/${ctx.baseSha}`, undefined, 200);

  if (own(baseCommit, 'sha') !== ctx.baseSha || own(own(baseCommit, 'tree'), 'sha') !== localTreeSha) {
    fail('publish-basis-baum', 'Ausgangscommit auf GitHub hat einen anderen Baum');
  }

  const baseTree = readTree(await send(ctx, 'GET', `git/trees/${localTreeSha}?recursive=1`, undefined, 200), localTreeSha, 'publish-basis-baum');
  checkBaseTree(baseTree, localTree);

  ctx.allowedWrite = 'git/trees';
  const created = await send(ctx, 'POST', 'git/trees', {
    base_tree: localTreeSha,
    tree: ctx.files.map(file => ({ path: file.pfad, mode: '100644', type: 'blob', sha: file.git_blob })),
  }, 201);
  ctx.allowedWrite = null;
  const newTree = readSha(own(created, 'sha'), 'publish-baum-format');
  checkNewTree(readTree(await send(ctx, 'GET', `git/trees/${newTree}?recursive=1`, undefined, 200), newTree, 'publish-baum-format'), baseTree, ctx.files);

  // Ohne # vor der Nummer: Ein Verweis auf das Issue im Commit koennte schon beim Anlegen des Branches
  // ein Ereignis im Issue-Verlauf erzeugen und die Unveraendert-Pruefung zufaellig scheitern lassen.
  const message = `${orderA.pr_titel_praefix} Codeauftrag fuer Issue ${orderA.issue}\n\nAuftrag ${ctx.expectedSha256}\nPaket ${ctx.packageSha256}`;
  ctx.allowedWrite = 'git/commits';
  const commit = await send(ctx, 'POST', 'git/commits', { message, tree: newTree, parents: [ctx.baseSha] }, 201);
  ctx.allowedWrite = null;
  ctx.commit = readSha(own(commit, 'sha'), 'publish-commit-format');
  const readBack = await send(ctx, 'GET', `git/commits/${ctx.commit}`, undefined, 200);
  const parents = list(own(readBack, 'parents'));

  if (
    own(readBack, 'sha') !== ctx.commit || own(own(readBack, 'tree'), 'sha') !== newTree ||
    parents === null || parents.length !== 1 || own(parents[0], 'sha') !== ctx.baseSha
  ) {
    fail('publish-commit-abweichung', 'Commit hat nicht genau den geprueften Baum und den Ausgangscommit als Eltern');
  }

  // Phase D: letzte vollstaendige K3-Pruefung vor dem Branch, Zeitpunkt festhalten.
  ctx.phase = 'D';
  const checkD = await fullLiveCheck(ctx);
  ctx.stateD = checkD.state;
  ctx.startMs = checkD.ms;
  checkApprovalDeadline(orderA.startfreigabe.zeitpunkt, ctx.startMs);
  checkBranchReserve(orderA.startfreigabe.zeitpunkt, ctx.startMs);

  // Phase E: Branch anlegen. Bestaetigt nur bei eindeutiger, vollstaendiger Antwort.
  ctx.phase = 'E';
  ctx.allowedWrite = 'git/refs';
  ctx.branchRequested = true;
  const ref = await send(ctx, 'POST', 'git/refs', { ref: `refs/heads/${ctx.branch}`, sha: ctx.commit }, 201);
  ctx.allowedWrite = null;

  if (
    !isPlainObject(ref) || own(ref, 'ref') !== `refs/heads/${ctx.branch}` ||
    own(own(ref, 'object'), 'type') !== 'commit' || own(own(ref, 'object'), 'sha') !== ctx.commit
  ) {
    fail('publish-branch-antwort', 'Branch-Anlage nicht eindeutig bestaetigt');
  }

  ctx.branchConfirmed = true;

  // Phase F: Unveraendert-Pruefung und konkreter Branch-Ref.
  ctx.phase = 'F';
  checkUnchanged(ctx, await readState(ctx));
  await checkBranchRef(ctx);

  // Phase G: Remote-Diff.
  ctx.phase = 'G';
  checkCompare(await send(ctx, 'GET', `compare/${ctx.baseSha}...${ctx.commit}`, undefined, 200), ctx);

  // Phase H: letzte Kontrolle, dann Draft-PR.
  ctx.phase = 'H';
  checkUnchanged(ctx, await readState(ctx));
  await checkBranchRef(ctx);
  const msH = readClock(ctx);
  checkTimeWindow(ctx.startMs, msH);
  checkApprovalDeadline(orderA.startfreigabe.zeitpunkt, msH);

  ctx.allowedWrite = 'pulls';
  const pull = await send(ctx, 'POST', 'pulls', {
    title: `${orderA.pr_titel_praefix} Codeauftrag fuer Issue #${orderA.issue}`,
    head: ctx.branch,
    base: 'main',
    draft: true,
    body: [
      `Automatisch erstellter Draft-PR fuer Issue #${orderA.issue}.`,
      '',
      `Auftrag: ${orderA.kennung}`,
      `Auftrags-SHA-256: ${ctx.expectedSha256}`,
      `Paket-SHA-256: ${ctx.packageSha256}`,
      `Lauf: ${ctx.runId}`,
      'Geaenderte Dateien:',
      ...ctx.files.map(file => `- ${file.pfad}`),
      '',
      'Kein automatischer Merge. Freigabe nur durch noah04091.',
    ].join('\n'),
  }, 201);
  const number = checkPullResponse(pull, ctx);

  ctx.phase = 'fertig';
  return Object.freeze({
    pr_nummer: number,
    pr_url: `${PR_URL_PREFIX}${number}`,
    branch: ctx.branch,
    commit: ctx.commit,
    baum: newTree,
    dateien: Object.freeze(ctx.files.map(file => file.pfad)),
    auftrag_sha256: orderSha256(orderA),
    paket_sha256: ctx.packageSha256,
  });
}

// ---------------------------------------------------------------------------
// Bereinigung nach A1a und Fehlerbericht
// ---------------------------------------------------------------------------

// Wirft nie. Loescht den eigenen Branch nur, wenn jede Bedingung belegt ist.
async function cleanUp(ctx) {
  const result = (ergebnis, grund) => ({ ergebnis, grund });

  try {
    if (ctx.writes === 0) {
      return result('nicht-noetig', 'keine-schreibaufrufe');
    }

    if (!ctx.branchRequested) {
      return result('nicht-noetig', 'kein-branch');
    }

    if (!ctx.branchConfirmed) {
      return result('nicht-geloescht', 'branch-anlage-unbestaetigt');
    }

    if (ctx.prRequested) {
      return result('nicht-geloescht', 'pr-angefragt');
    }

    if (ctx.branch !== branchName(ctx.issueNumber, ctx.runId)) {
      return result('nicht-geloescht', 'branch-name');
    }

    ctx.phase = 'bereinigung';

    try {
      await checkBranchRef(ctx);
    } catch {
      return result('nicht-geloescht', 'branch-spitze');
    }

    let state;

    try {
      state = await readState(ctx);
    } catch {
      return result('nicht-geloescht', 'pr-liste');
    }

    if (state.pulls.some(pull => pull.head_ref === ctx.branch)) {
      return result('nicht-geloescht', 'pr-vorhanden');
    }

    ctx.deleteAllowed = true;

    try {
      await send(ctx, 'DELETE', `git/refs/heads/${ctx.branch}`, undefined, 204);
    } catch {
      return result('nicht-geloescht', 'loeschen-abgelehnt');
    } finally {
      ctx.deleteAllowed = false;
    }

    return result('geloescht', 'bedingungen-erfuellt');
  } catch {
    return result('nicht-geloescht', 'bereinigung-fehler');
  }
}

// Fehler mit dem Code des urspruenglichen Fehlers und einem strukturierten Bericht.
export class PublishError extends Error {
  constructor(code, bericht, cause) {
    super(`Veroeffentlichung abgebrochen: ${code}`);
    this.name = 'PublishError';
    this.code = code;
    this.bericht = bericht;
    this.cause = cause;
  }
}

function safeCode(error) {
  try {
    const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    return typeof code === 'string' && /^[a-z0-9-]{1,80}$/.test(code) ? code : 'publish-unbekannt';
  } catch {
    return 'publish-unbekannt';
  }
}

// input: { root, checkRoot, baseSha, event, expectedSha256, runId, packageBytes, packageSha256,
// gitEnv, transport, clock }, genau diese Felder. root: vertrauenswuerdiger Checkout auf baseSha.
// checkRoot: frischer, sauberer Pruef-Checkout auf baseSha, getrennt von root. event: Original-
// Nutzlast von issues.labeled. runId: Lauf-ID aus dem eigenen Workflow-Kontext. packageBytes und
// packageSha256: Paket und sein getrennt uebergebener Hash. clock: liefert je Aufruf ein Date.
// Ergebnis: eingefrorene PR-Angaben. Jeder Fehler wirft PublishError mit code und bericht.
export async function publishOrderDraft(input) {
  const ctx = {
    phase: 'eingabe',
    writes: 0,
    liveChecks: 0,
    clockReads: 0,
    lastMs: null,
    allowedWrite: null,
    deleteAllowed: false,
    closed: false,
    branch: null,
    branchRequested: false,
    branchConfirmed: false,
    prRequested: false,
    commit: null,
  };

  try {
    return await runPublish(ctx, input);
  } catch (error) {
    const phase = ctx.phase;
    const code = safeCode(error);
    const cleanup = await cleanUp(ctx);
    throw new PublishError(code, Object.freeze({
      code,
      schritt: phase,
      schreibaufrufe: ctx.writes,
      branch: ctx.branch,
      branch_bestaetigt: ctx.branchConfirmed,
      pr_angefragt: ctx.prRequested,
      commit: ctx.commit,
      bereinigung: cleanup.ergebnis,
      bereinigung_grund: cleanup.grund,
    }), error);
  }
}
