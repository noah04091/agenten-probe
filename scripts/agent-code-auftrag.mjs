// A6.2-1: Vertrauenswuerdige Auftragsfestlegung (Schema agent-auftrag-v1).
//
// Wirkungslos bis A6.4: Kein Workflow und kein anderes Skript ruft dieses Modul auf. Es hat keinen
// Einstiegspunkt, liest keine Prozessumgebung und stellt keine Netzanfragen. Alle Daten werden
// ausdruecklich uebergeben: Git-Objekte ueber root, baseSha und eine isolierte Git-Umgebung,
// GitHub-Daten (Start-Ereignis, Live-Issue, Ereignisverlauf, Laufdaten) als fertige Objekte.
//
// Vertrauensgrenze:
// - Vertrauenswuerdig sind nur Git-Objekte auf baseSha: .github/agent/policy.json,
//   agent-profiles/<id>.json und agent-acceptance/issue-<n>.mjs. Sie werden als Blob gelesen,
//   nie aus dem Dateisystem, und ihre Blob-ID wird nachgerechnet.
// - Nicht vertrauenswuerdig sind Issue-Titel, Issue-Text, Labels und alle Felder der GitHub-Daten.
//   Sie legen keine Datei-, Werkzeug-, Modell-, Budget- oder Sicherheitsrechte fest. Titel und
//   Text gehen nur als gemeinsamer Hash in den Auftrag ein.
//
// Zuordnung der Startfreigabe (K3), belegt an der GitHub-Dokumentation (geprueft am 10.11.2026):
// - Die Nutzlast von issues.labeled enthaelt weder eine Ereignis-ID noch einen Zeitpunkt des Labels.
// - Der Issue-Ereignisverlauf liefert je Eintrag id, actor, event, created_at und bei Labels label.
//   Eine Reihenfolge der Eintraege ist nicht dokumentiert.
// - GET actions/runs/{run_id} liefert created_at und run_attempt. Ihre Bedeutung bei einem
//   erneuten Lauf ist nicht dokumentiert.
// Deshalb gibt es keine direkte Verknuepfung zwischen Lauf und Label-Ereignis. Die Zuordnung ist
// konservativ: Genau eine zaehlende Freigabe muss im Fenster [Lauf-Erstellung minus 5 Minuten,
// Lauf-Erstellung] liegen, keine zaehlende Freigabe darf nach der Lauf-Erstellung liegen, und der
// Laufversuch muss 1 sein. Jede fehlende, doppelte, widerspruechliche oder mehrdeutige Angabe
// fuehrt zum Abbruch. Die Reihenfolge wird nicht der API geglaubt, sondern aus den IDs gebildet
// und gegen die Zeitstempel geprueft.
//
// Auch das Profil-Label waehlt Rechte aus (Dateien, Budget, Runden). Deshalb muss jedes Ereignis
// eines agent:-Labels von noah04091 stammen, das aktuelle Profil-Label muss vor der Freigabe
// gesetzt sein, und ab der Sekunde der Freigabe darf sich kein agent:-Label mehr aendern. Werden
// beide Labels in einem Schritt gesetzt, tragen sie dieselbe Sekunde und der Lauf bricht immer ab,
// unabhaengig von der Reihenfolge der IDs. Bedienung: erst agent:<id> setzen, dann bot-auftrag.
//
// Titel- und Textaenderungen erscheinen nicht im Ereignisverlauf. Deshalb darf updated_at des
// Issues hoechstens 2 Sekunden nach der Freigabe liegen. Gemessen am 10.11.2026 an elf Issues
// dieses Repositorys: Bei Label-Ereignissen ist updated_at sekundengleich mit dem Ereignis, bei
// closed liegt es bis zu 1 Sekunde davor. Jede spaetere Aktivitaet (Bearbeitung, Kommentar)
// bricht ab.
//
// Grenzen, die dieses Modul nicht schliessen kann und die A6.4 tragen muss:
// - Dieselbe Freigabe kann zwei Laeufe mit Versuch 1 bestaetigen, wenn zwei Laeufe entstehen.
//   Dagegen helfen nur eine concurrency-Gruppe je Issue und eine Einmal-Markierung je Freigabe.
// - Ob der Ereignisverlauf vollstaendig ist (alle Seiten), prueft der Leser in A6.2-2.
// - Vor resolveOrder darf nichts auf das Issue schreiben (auch kein Kommentar "Lauf gestartet"),
//   sonst bricht die Pruefung von updated_at ab.
// - Ungeklaert ist, ob der Ereignisverlauf nach dem Umbenennen eines Labels den alten oder den
//   neuen Namen liefert. Liefert er den neuen, koennte ein Umbenennen im Repository das Profil
//   unbemerkt wechseln. Messung mit einem Wegwerf-Label braucht eine Schreibfreigabe (A6.4).
// - Die Objektablage unter root muss aus einem frischen Checkout stammen. Commit, Baeume und
//   Blobs werden nachgerechnet, Ersatzobjekte (refs/replace) sind abgeschaltet.
// - Ein Ablehnungsgrund ist immer ein Fehler mit code: OrderError aus diesem Modul oder
//   ProfileError aus agent-profile.mjs.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { types } from 'node:util';

import {
  GIT_ENV_KEYS,
  ID_RE,
  checkProfileFiles,
  loadPolicy,
  loadProfile,
  parseTreeOutput,
  sha256,
  validateIssueInput,
} from './agent-profile.mjs';

export const ORDER_SCHEMA = 'agent-auftrag-v1';
export const REPOSITORY = 'noah04091/agenten-probe';
export const OWNER = 'noah04091';
export const START_LABEL = 'bot-auftrag';
export const PROFILE_LABEL_PREFIX = 'agent:';
export const POLICY_PATH = '.github/agent/policy.json';
export const MAX_ORDER_BYTES = 8192;
export const MAX_ACCEPTANCE_BYTES = 65536;
export const MAX_ISSUE_NUMBER = 10_000_000;
export const MAX_APPROVALS = 3;
export const MAX_EVENTS = 1000;
export const MAX_LABELS = 20;
export const APPROVAL_WINDOW_MS = 5 * 60 * 1000;
export const APPROVAL_DEADLINE_MS = 60 * 60 * 1000;
export const ISSUE_UPDATE_TOLERANCE_MS = 2 * 1000;

const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;
const TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const TREE_LINE_RE = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s;
const INPUT_KEYS = Object.freeze(['root', 'baseSha', 'gitEnv', 'repository', 'event', 'issue', 'events', 'run', 'now']);
const RUN_KEYS = Object.freeze(['id', 'attempt', 'createdAt']);
const APPROVAL_CONTEXT_KEYS = Object.freeze(['runCreatedAt', 'now', 'profileLabel']);

export class OrderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OrderError(code, `Auftrag abgelehnt: ${message}`);
}

// Ein Proxy koennte bei jedem Lesezugriff einen anderen Wert liefern und seinen Prototyp faelschen.
function isPlainObject(value) {
  // Arrays haben Array.prototype und fallen damit ebenfalls heraus.
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Liest nur eigene Dateneigenschaften. Getter, geerbte Werte und fehlende Felder ergeben undefined.
// Jeder Aufrufer hat vorher geprueft, dass value ein einfaches Objekt ist.
function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

// Liest eine Liste genau einmal in eine eigene Kopie. Loecher werden zu undefined und fallen bei
// der Pruefung der Elemente auf.
function readList(value, max) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > max) {
    return null;
  }

  const copy = [];

  for (let index = 0; index < value.length; index += 1) {
    copy.push(own(value, String(index)));
  }

  return copy;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(value[key]);
    }

    Object.freeze(value);
  }

  return value;
}

// Genau Sekundenformat mit Z, wie GitHub es liefert. Ungueltige Kalenderdaten fallen durch den
// Rueckvergleich auf (2026-02-30 wird sonst still zum 2. Maerz).
function parseTime(text) {
  if (typeof text !== 'string' || !TIME_RE.test(text)) {
    return null;
  }

  const ms = Date.parse(text);

  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== `${text.slice(0, 19)}.000Z`) {
    return null;
  }

  return ms;
}

function readNow(now) {
  let ms;

  // getTime wirft bei allem, was kein echtes Date ist, auch bei gefaelschtem Symbol.toStringTag.
  try {
    ms = Date.prototype.getTime.call(now);
  } catch {
    fail('auftrag-zeit', 'Pruefzeitpunkt fehlt');
  }

  if (!Number.isFinite(ms)) {
    fail('auftrag-zeit', 'Pruefzeitpunkt ungueltig');
  }

  return ms;
}

function gitObjectId(type, bytes) {
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Isolierte Git-Umgebung und Lesen von Git-Objekten auf baseSha
// ---------------------------------------------------------------------------

function isInside(path, dir) {
  const separator = String.fromCharCode(92);
  return (
    typeof path === 'string' &&
    !path.includes('..') &&
    (path.startsWith(`${dir}/`) || path.startsWith(`${dir}${separator}`))
  );
}

// Gleiche Regeln wie readTree in agent-profile.mjs: nur erlaubte Schluessel, nur eigene
// Text-Dateneigenschaften, Systemkonfiguration aus, globale Konfiguration und XDG unterhalb eines
// eigenen HOME. Ergebnis ist eine Kopie ohne Prototyp, die nur dieses Modul an git weitergibt.
function isolatedEnv(gitEnv) {
  if (!isPlainObject(gitEnv)) {
    fail('auftrag-git-umgebung', 'Git-Umgebung fehlt');
  }

  const clean = Object.create(null);

  for (const key of Reflect.ownKeys(gitEnv)) {
    const value = own(gitEnv, key);

    // Symbol-Schluessel scheitern an includes(), weil GIT_ENV_KEYS nur Texte enthaelt.
    if (!GIT_ENV_KEYS.includes(key) || typeof value !== 'string') {
      fail('auftrag-git-umgebung', 'Git-Umgebung enthaelt nicht erlaubte oder ungueltige Eintraege');
    }

    clean[key] = value;
  }

  if (
    clean.GIT_CONFIG_NOSYSTEM !== '1' ||
    typeof clean.PATH !== 'string' ||
    typeof clean.HOME !== 'string' ||
    clean.HOME.length === 0 ||
    !isInside(clean.GIT_CONFIG_GLOBAL, clean.HOME) ||
    (clean.XDG_CONFIG_HOME !== undefined && !isInside(clean.XDG_CONFIG_HOME, clean.HOME))
  ) {
    fail('auftrag-git-umgebung', 'Git-Umgebung ist nicht isoliert');
  }

  return Object.freeze(clean);
}

// Ersatzobjekte (refs/replace) koennten Commit, Baum oder Blob austauschen. Sie sind abgeschaltet.
function runGit(git, args, code, binary = false) {
  try {
    return execFileSync('git', ['--no-replace-objects', ...args], {
      cwd: git.root,
      env: git.env,
      encoding: binary ? 'buffer' : 'utf8',
      timeout: 10_000,
      maxBuffer: 4_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail(code, `git ${args[0]} fehlgeschlagen`);
  }
}

// Oeffnet das Repository und liest den Baum von baseSha genau einmal. parseTreeOutput prueft
// Format, doppelte Pfade und Konflikte zwischen Eintrag und Ordner; hier kommen die Blob-IDs dazu.
function openRepository(root, baseSha, gitEnv) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    fail('auftrag-wurzel', 'Repository-Verzeichnis muss ein absoluter Pfad sein');
  }

  if (typeof baseSha !== 'string' || !HEX40_RE.test(baseSha)) {
    fail('auftrag-basis', 'Ausgangscommit muss aus 40 kleinen Hex-Zeichen bestehen');
  }

  const git = Object.freeze({ root, env: isolatedEnv(gitEnv) });

  // Leer nur in der obersten Ebene eines Repositorys. Sonst wuerde git ein umgebendes Repository
  // finden und dessen Objekte lesen.
  if (runGit(git, ['rev-parse', '--show-cdup'], 'auftrag-git-wurzel').trim() !== '') {
    fail('auftrag-git-wurzel', 'Verzeichnis ist nicht die oberste Ebene eines Repositorys');
  }

  if (runGit(git, ['cat-file', '-t', baseSha], 'auftrag-basis-fehlt').trim() !== 'commit') {
    fail('auftrag-basis-kein-commit', 'Ausgangscommit ist kein Commit');
  }

  // Commit und jeder erreichbare Baum werden nachgerechnet. Damit stammt die Zuordnung von Pfad zu
  // Blob nachweislich aus baseSha und nicht aus einem veraenderten Objekt der lokalen Ablage.
  const commit = runGit(git, ['cat-file', 'commit', baseSha], 'auftrag-objekt-lesen', true);

  if (gitObjectId('commit', commit) !== baseSha) {
    fail('auftrag-objekt-commit', 'Commit-Objekt passt nicht zum Ausgangscommit');
  }

  const verifyTree = oid => {
    if (gitObjectId('tree', runGit(git, ['cat-file', 'tree', oid], 'auftrag-objekt-lesen', true)) !== oid) {
      fail('auftrag-objekt-baum', `Baum-Objekt ${oid} passt nicht zu seiner ID`);
    }
  };

  // Erst der Wurzelbaum, dann jeder Unterbaum. git selbst prueft beim Auflisten nur den direkt
  // genannten Baum, nicht die Unterbaeume.
  const rootTree = /^tree ([0-9a-f]{40})\n/.exec(commit.toString('latin1'))[1];
  verifyTree(rootTree);
  const treeList = runGit(git, ['ls-tree', '-r', '-d', '-z', rootTree], 'auftrag-baum').split('\0');

  for (const line of treeList.filter(Boolean)) {
    verifyTree(TREE_LINE_RE.exec(line)[3]);
  }

  const output = runGit(git, ['ls-tree', '-r', '-z', rootTree], 'auftrag-baum');
  const tree = parseTreeOutput(output);

  for (const line of output.split('\0')) {
    if (line !== '') {
      const match = TREE_LINE_RE.exec(line);
      tree.get(match[4]).oid = match[3];
    }
  }

  return { git, tree };
}

// Liest einen Pfad als gewoehnlichen Blob (Modus 100644). Kein Symlink, nicht ausfuehrbar, kein
// Unterprojekt. Die Groesse wird vor dem Lesen begrenzt, die Blob-ID aus den Bytes nachgerechnet.
function readBlob(repo, path, maxBytes, code) {
  const entry = repo.tree.get(path);

  if (!entry) {
    fail(`${code}-fehlt`, `${path} fehlt im Ausgangscommit`);
  }

  // In Git hat nur ein gewoehnlicher Blob den Modus 100644.
  if (entry.mode !== '100644') {
    fail(`${code}-modus`, `${path} ist keine gewoehnliche Datei (Modus ${entry.mode})`);
  }

  const size = Number(runGit(repo.git, ['cat-file', '-s', entry.oid], `${code}-lesen`).trim());

  // Auch NaN faellt hier durch.
  if (!(size >= 1 && size <= maxBytes)) {
    fail(`${code}-groesse`, `${path} ist leer oder groesser als ${maxBytes} Bytes`);
  }

  const bytes = runGit(repo.git, ['cat-file', 'blob', entry.oid], `${code}-lesen`, true);

  // Die Blob-ID umfasst Laenge und Inhalt.
  if (gitObjectId('blob', bytes) !== entry.oid) {
    fail(`${code}-blob`, `Inhalt von ${path} passt nicht zur Blob-ID`);
  }

  return { path, bytes, blob: entry.oid, sha256: sha256(bytes) };
}

// ---------------------------------------------------------------------------
// Policy: nur aus dem Git-Objekt, ohne Ausnahmemodus, danach eingefroren und gebunden
// ---------------------------------------------------------------------------

const TRUSTED_POLICIES = new WeakSet();

function loadTrustedPolicy(repo) {
  const file = readBlob(repo, POLICY_PATH, 16384, 'auftrag-policy');
  const policy = deepFreeze(loadPolicy(file.bytes));
  TRUSTED_POLICIES.add(policy);
  return Object.freeze({ policy, path: POLICY_PATH, blob: file.blob, sha256: file.sha256 });
}

// Liest und prueft nur die Policy auf baseSha. Ergebnis: eingefrorene Policy, Pfad, Blob, SHA-256.
export function readTrustedPolicy(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, ['root', 'baseSha', 'gitEnv'])) {
    fail('auftrag-eingabe', 'Eingabe braucht genau root, baseSha und gitEnv');
  }

  return loadTrustedPolicy(openRepository(own(input, 'root'), own(input, 'baseSha'), own(input, 'gitEnv')));
}

// ---------------------------------------------------------------------------
// Labels: genau das Startlabel und genau ein Profil-Label, sonst nichts
// ---------------------------------------------------------------------------

export function orderLabels(labels, policy) {
  if (!TRUSTED_POLICIES.has(policy)) {
    fail('auftrag-policy-ungeprueft', 'Policy stammt nicht aus readTrustedPolicy oder resolveOrder');
  }

  const list = readList(labels, MAX_LABELS);

  if (list === null) {
    fail('auftrag-labels-format', 'Labels fehlen oder sind zu viele');
  }

  const names = list.map(label => {
    const name = isPlainObject(label) ? own(label, 'name') : undefined;

    if (typeof name !== 'string') {
      fail('auftrag-labels-format', 'Label ohne Namen');
    }

    return name;
  });

  if (new Set(names).size !== names.length) {
    fail('auftrag-labels-doppelt', 'Label doppelt');
  }

  if (!names.includes(START_LABEL)) {
    fail('auftrag-label-start-fehlt', `Label ${START_LABEL} fehlt`);
  }

  const profileLabels = names.filter(name => name.startsWith(PROFILE_LABEL_PREFIX));

  if (profileLabels.length === 0) {
    fail('auftrag-label-profil-fehlt', 'kein Profil-Label');
  }

  if (profileLabels.length > 1) {
    fail('auftrag-label-profil-mehrdeutig', 'mehr als ein Profil-Label');
  }

  if (names.length !== 2) {
    fail('auftrag-labels-fremd', 'neben Start- und Profil-Label sind keine Labels erlaubt');
  }

  const profilId = profileLabels[0].slice(PROFILE_LABEL_PREFIX.length);

  if (!ID_RE.test(profilId) || profilId.includes('--')) {
    fail('auftrag-label-profil-ungueltig', 'Profil-ID im Label entspricht nicht dem Muster');
  }

  if (policy.reservierte_ids.includes(profilId)) {
    fail('auftrag-label-reserviert', `Profil ${profilId} ist reserviert`);
  }

  return Object.freeze({
    profilId,
    // Bereits sortiert: "agent:" steht vor "bot-auftrag".
    labels: Object.freeze([profileLabels[0], START_LABEL]),
  });
}

// ---------------------------------------------------------------------------
// K3: hoechstens drei Startfreigaben je Issue, eindeutige Zuordnung zum Lauf, Frist 60 Minuten
// ---------------------------------------------------------------------------

// events: vollstaendiger Ereignisverlauf des Issues (alle Seiten).
// context: { runCreatedAt, now, profileLabel }, profileLabel ist das aktuelle Label agent:<id>.
// Grenzen: Eine Freigabe genau 5:00 vor der Lauf-Erstellung oder in derselben Sekunde liegt im
// Fenster. Eine Freigabe genau 60:00 vor now ist noch gueltig, eine Sekunde spaeter nicht mehr.
export function evaluateStartApprovals(events, context) {
  if (!isPlainObject(context) || !hasExactKeys(context, APPROVAL_CONTEXT_KEYS)) {
    fail('auftrag-eingabe', 'Kontext braucht genau runCreatedAt, now und profileLabel');
  }

  const nowMs = readNow(own(context, 'now'));
  const profileLabel = own(context, 'profileLabel');

  if (
    typeof profileLabel !== 'string' ||
    !profileLabel.startsWith(PROFILE_LABEL_PREFIX) ||
    !ID_RE.test(profileLabel.slice(PROFILE_LABEL_PREFIX.length))
  ) {
    fail('auftrag-eingabe', 'profileLabel muss ein agent:-Label sein');
  }

  const list = readList(events, MAX_EVENTS);

  if (list === null) {
    fail('auftrag-ereignisse-umfang', `Ereignisverlauf fehlt oder hat mehr als ${MAX_EVENTS} Eintraege`);
  }

  const seen = new Set();
  const parsed = list.map(event => {
    if (!isPlainObject(event)) {
      fail('auftrag-ereignis-format', 'Ereignis ist kein Objekt');
    }

    const id = own(event, 'id');

    if (!Number.isSafeInteger(id) || id < 1) {
      fail('auftrag-ereignis-id', 'Ereignis ohne gueltige ID');
    }

    if (seen.has(id)) {
      fail('auftrag-ereignis-doppelt', `Ereignis ${id} doppelt`);
    }

    seen.add(id);
    const createdAt = own(event, 'created_at');
    const time = parseTime(createdAt);

    if (time === null) {
      fail('auftrag-ereignis-zeit', `Ereignis ${id} ohne gueltigen Zeitstempel`);
    }

    if (time > nowMs) {
      fail('auftrag-ereignis-zukunft', `Ereignis ${id} liegt nach dem Pruefzeitpunkt`);
    }

    const type = own(event, 'event');

    if (typeof type !== 'string') {
      fail('auftrag-ereignis-typ', `Ereignis ${id} ohne Typ`);
    }

    return { event, id, time, createdAt, type };
  }).sort((a, b) => a.id - b.id);

  // Spaetere IDs duerfen keinen frueheren Zeitstempel tragen.
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].time < parsed[index - 1].time) {
      fail('auftrag-ereignis-reihenfolge', 'IDs und Zeitstempel widersprechen sich');
    }
  }

  const approvals = [];
  const removals = [];
  const profileEvents = [];

  for (const item of parsed) {
    if (item.type !== 'labeled' && item.type !== 'unlabeled') {
      continue;
    }

    const label = own(item.event, 'label');
    const name = isPlainObject(label) ? own(label, 'name') : undefined;

    if (typeof name !== 'string') {
      fail('auftrag-ereignis-label', `Label-Ereignis ${item.id} ohne Labelnamen`);
    }

    const isStart = name === START_LABEL;
    const isProfile = name.startsWith(PROFILE_LABEL_PREFIX);

    if (!isStart && !isProfile) {
      continue;
    }

    // Ein entferntes Startlabel zieht die Freigabe zurueck, egal wer es entfernt.
    if (isStart && item.type === 'unlabeled') {
      removals.push(item);
      continue;
    }

    const actor = own(item.event, 'actor');
    const app = own(item.event, 'performed_via_github_app');
    const byOwner = (
      isPlainObject(actor) &&
      own(actor, 'login') === OWNER &&
      own(actor, 'type') === 'User' &&
      (app === undefined || app === null)
    );

    if (isProfile) {
      if (!byOwner) {
        fail('auftrag-profil-label-fremd', `Profil-Label-Ereignis ${item.id} nicht von ${OWNER}`);
      }

      profileEvents.push({ ...item, name });
      continue;
    }

    if (!byOwner) {
      fail('auftrag-freigabe-fremd', `Startlabel ${item.id} nicht von ${OWNER} gesetzt`);
    }

    approvals.push(item);
  }

  if (approvals.length > MAX_APPROVALS) {
    fail('auftrag-freigaben-grenze', `mehr als ${MAX_APPROVALS} Startfreigaben fuer dieses Issue`);
  }

  const runMs = parseTime(own(context, 'runCreatedAt'));

  if (runMs === null) {
    fail('auftrag-lauf-zeit', 'Erstellungszeitpunkt des Laufs ungueltig');
  }

  if (runMs > nowMs) {
    fail('auftrag-lauf-zukunft', 'Lauf wurde nach dem Pruefzeitpunkt erstellt');
  }

  if (approvals.some(item => item.time > runMs)) {
    fail('auftrag-lauf-ueberholt', 'eine spaetere Startfreigabe hat diesen Lauf ueberholt');
  }

  const candidates = approvals.filter(item => item.time >= runMs - APPROVAL_WINDOW_MS);

  if (candidates.length === 0) {
    fail('auftrag-freigabe-fehlt', 'keine Startfreigabe kurz vor der Lauf-Erstellung');
  }

  if (candidates.length > 1) {
    fail('auftrag-freigabe-mehrdeutig', 'mehrere Startfreigaben kommen als Ausloeser in Frage');
  }

  const chosen = candidates[0];

  if (removals.some(item => item.id > chosen.id)) {
    fail('auftrag-freigabe-entzogen', 'Startlabel wurde nach der Freigabe entfernt');
  }

  // Spaetere IDs haben nie einen frueheren Zeitstempel (oben geprueft). Damit faengt der Vergleich
  // der Zeit auch jedes spaetere Ereignis und dazu jedes in derselben Sekunde.
  if (profileEvents.some(item => item.time >= chosen.time)) {
    fail('auftrag-profil-label-geaendert', 'Profil-Label wurde nach der Freigabe geaendert');
  }

  // Das letzte Ereignis zum aktuellen Profil-Label muss sein Setzen durch noah04091 sein.
  const ownProfileEvents = profileEvents.filter(item => item.name === profileLabel);

  if (ownProfileEvents.length === 0 || ownProfileEvents.at(-1).type !== 'labeled') {
    fail('auftrag-profil-label-herkunft', `${profileLabel} wurde nicht vor der Freigabe von ${OWNER} gesetzt`);
  }

  if (nowMs - chosen.time > APPROVAL_DEADLINE_MS) {
    fail('auftrag-freigabe-abgelaufen', 'Freigabe ist aelter als 60 Minuten');
  }

  return Object.freeze({
    ereignis_id: chosen.id,
    zeitpunkt: chosen.createdAt,
    akteur: OWNER,
    // Keine zaehlende Freigabe liegt nach der zugeordneten, sie ist also die letzte.
    nummer: approvals.length,
  });
}

// ---------------------------------------------------------------------------
// Start-Ereignis, Live-Issue und Laufdaten
// ---------------------------------------------------------------------------

function nested(value, ...keys) {
  return keys.reduce((current, key) => (isPlainObject(current) ? own(current, key) : undefined), value);
}

function checkIssue(issue) {
  if (!isPlainObject(issue)) {
    fail('auftrag-issue-format', 'Live-Issue fehlt');
  }

  const number = own(issue, 'number');

  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_ISSUE_NUMBER) {
    fail('auftrag-issue-nummer', 'Issue-Nummer ungueltig');
  }

  if (Object.hasOwn(issue, 'pull_request')) {
    fail('auftrag-issue-pr', 'Nummer gehoert zu einem Pull Request');
  }

  if (own(issue, 'state') !== 'open') {
    fail('auftrag-issue-geschlossen', 'Issue ist nicht offen');
  }

  if (nested(issue, 'user', 'login') !== OWNER || nested(issue, 'user', 'type') !== 'User') {
    fail('auftrag-issue-autor', `Issue nicht von ${OWNER} angelegt`);
  }

  const body = own(issue, 'body');
  const updatedAt = parseTime(own(issue, 'updated_at'));

  if (updatedAt === null) {
    fail('auftrag-issue-zeit', 'updated_at des Issues fehlt oder ist ungueltig');
  }

  return { number, title: own(issue, 'title'), body: body === null ? '' : body, labels: own(issue, 'labels'), updatedAt };
}

function checkStartEvent(event, repository, number) {
  if (!isPlainObject(event)) {
    fail('auftrag-ereignis-format', 'Start-Ereignis fehlt');
  }

  if (own(event, 'action') !== 'labeled' || nested(event, 'label', 'name') !== START_LABEL) {
    fail('auftrag-start-art', `Start ist kein Setzen von ${START_LABEL}`);
  }

  if (nested(event, 'sender', 'login') !== OWNER || nested(event, 'sender', 'type') !== 'User') {
    fail('auftrag-start-sender', `Start nicht von ${OWNER}`);
  }

  if (nested(event, 'repository', 'full_name') !== repository) {
    fail('auftrag-start-repository', 'Start aus einem anderen Repository');
  }

  if (nested(event, 'issue', 'number') !== number) {
    fail('auftrag-start-issue', 'Start betrifft ein anderes Issue');
  }

  // Die Nummer oben ist nur lesbar, wenn issue ein einfaches Objekt ist.
  if (Object.hasOwn(own(event, 'issue'), 'pull_request')) {
    fail('auftrag-issue-pr', 'Start betrifft einen Pull Request');
  }
}

function checkRun(run) {
  if (!isPlainObject(run) || !hasExactKeys(run, RUN_KEYS)) {
    fail('auftrag-lauf-format', 'Laufdaten brauchen genau id, attempt und createdAt');
  }

  if (typeof own(run, 'id') !== 'string' || !RUN_ID_RE.test(own(run, 'id'))) {
    fail('auftrag-lauf-id', 'Lauf-ID ungueltig');
  }

  if (own(run, 'attempt') !== 1) {
    fail('auftrag-lauf-versuch', 'nur der erste Laufversuch ist erlaubt');
  }

  return { id: own(run, 'id'), attempt: 1, createdAt: own(run, 'createdAt') };
}

// ---------------------------------------------------------------------------
// Auftrag bilden, binden, kanonisch serialisieren
// ---------------------------------------------------------------------------

const RESOLVED_ORDERS = new WeakSet();

// input: { root, baseSha, gitEnv, repository, event, issue, events, run, now }, genau diese Felder.
// root: absoluter Pfad zur obersten Ebene eines Repositorys, das baseSha enthaelt.
// gitEnv: isolierte Umgebung (siehe isolatedEnv). event: Nutzlast von issues.labeled.
// issue: Live-Issue aus der REST-API. events: vollstaendiger Ereignisverlauf des Issues.
// run: { id: Lauf-ID als Ziffernfolge, attempt: 1, createdAt: created_at aus GET actions/runs }.
// now: Date des Pruefzeitpunkts.
// Ergebnis: tief eingefrorener, gebundener Auftrag agent-auftrag-v1. Jeder Fehler wirft.
export function resolveOrder(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, INPUT_KEYS)) {
    fail('auftrag-eingabe', `Eingabe braucht genau ${INPUT_KEYS.join(', ')}`);
  }

  // Jedes Feld wird genau einmal gelesen.
  const fields = Object.fromEntries(INPUT_KEYS.map(key => [key, own(input, key)]));
  const get = key => fields[key];
  const nowMs = readNow(get('now'));

  if (get('repository') !== REPOSITORY) {
    fail('auftrag-repository', `nur ${REPOSITORY} ist erlaubt`);
  }

  const run = checkRun(get('run'));
  const issue = checkIssue(get('issue'));
  checkStartEvent(get('event'), REPOSITORY, issue.number);

  const repo = openRepository(get('root'), get('baseSha'), get('gitEnv'));
  const trusted = loadTrustedPolicy(repo);
  const { profilId, labels } = orderLabels(issue.labels, trusted.policy);
  const issueInput = validateIssueInput(issue.title, issue.body, trusted.policy);

  const profilePath = `agent-profiles/${profilId}.json`;
  const profileFile = readBlob(repo, profilePath, 8192, 'auftrag-profil');
  const { profile } = loadProfile(profileFile.bytes, { policy: trusted.policy, fileName: `${profilId}.json` });

  if (profile.aktiv !== true) {
    fail('auftrag-profil-inaktiv', `Profil ${profilId} ist nicht aktiv`);
  }

  checkProfileFiles(profile, repo.tree);
  const files = [...profile.dateien].sort();
  const baseBlobs = {};

  for (const file of files) {
    baseBlobs[file] = repo.tree.get(file).oid;
  }

  const acceptancePath = `agent-acceptance/issue-${issue.number}.mjs`;
  const acceptance = readBlob(repo, acceptancePath, MAX_ACCEPTANCE_BYTES, 'auftrag-abnahme');

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(acceptance.bytes);
  } catch {
    fail('auftrag-abnahme-inhalt', 'Abnahmedatei ist kein gueltiger UTF-8-Text');
  }

  if (acceptance.bytes.includes(0)) {
    fail('auftrag-abnahme-inhalt', 'Abnahmedatei enthaelt ein NUL-Byte');
  }

  const approval = evaluateStartApprovals(get('events'), {
    runCreatedAt: run.createdAt,
    now: new Date(nowMs),
    profileLabel: `${PROFILE_LABEL_PREFIX}${profilId}`,
  });

  // Titel und Text duerfen nach der Freigabe nicht mehr bearbeitet worden sein.
  if (issue.updatedAt > Date.parse(approval.zeitpunkt) + ISSUE_UPDATE_TOLERANCE_MS) {
    fail('auftrag-issue-geaendert', 'Issue wurde nach der Freigabe veraendert');
  }

  const order = {
    schema: ORDER_SCHEMA,
    repository: REPOSITORY,
    issue: issue.number,
    issue_autor: OWNER,
    issue_sha256: issueInput.sha256,
    labels: [...labels],
    profil_id: profilId,
    profil_pfad: profilePath,
    profil_blob: profileFile.blob,
    profil_sha256: profileFile.sha256,
    policy_pfad: trusted.path,
    policy_blob: trusted.blob,
    policy_sha256: trusted.sha256,
    abnahme_pfad: acceptancePath,
    abnahme_blob: acceptance.blob,
    abnahme_sha256: acceptance.sha256,
    base_sha: get('baseSha'),
    dateien: files,
    basis_blobs: baseBlobs,
    modell: profile.modell,
    budget_usd: profile.budget_usd,
    max_runden: profile.max_runden,
    max_laufzeit_minuten: profile.max_laufzeit_minuten,
    pr_titel_praefix: profile.pr_titel_praefix,
    startfreigabe: { ...approval },
    lauf: { run_id: run.id, run_attempt: run.attempt, erstellt: run.createdAt },
    kennung: [
      `issue-${issue.number}`,
      profilId,
      profileFile.sha256.slice(0, 12),
      issueInput.sha256.slice(0, 12),
      acceptance.sha256.slice(0, 12),
    ].join('/'),
  };

  if (Buffer.byteLength(JSON.stringify(order), 'utf8') > MAX_ORDER_BYTES) {
    fail('auftrag-groesse', `Auftrag groesser als ${MAX_ORDER_BYTES} Bytes`);
  }

  deepFreeze(order);
  RESOLVED_ORDERS.add(order);
  return order;
}

function requireResolved(order) {
  if (!RESOLVED_ORDERS.has(order)) {
    fail('auftrag-ungeprueft', 'Auftrag stammt nicht aus resolveOrder');
  }
}

// Kanonische Bytes: feste Feldreihenfolge aus resolveOrder, ohne Leerraum, UTF-8.
export function canonicalOrderBytes(order) {
  requireResolved(order);
  return Buffer.from(JSON.stringify(order), 'utf8');
}

export function orderSha256(order) {
  return sha256(canonicalOrderBytes(order));
}

// Vergleicht immer den vollen SHA-256 der kanonischen Bytes. Die Kennung zaehlt hier nicht.
export function sameOrder(order, expectedSha256) {
  if (typeof expectedSha256 !== 'string' || !HEX64_RE.test(expectedSha256)) {
    fail('auftrag-hash-format', 'erwarteter Auftrags-Hash muss aus 64 kleinen Hex-Zeichen bestehen');
  }

  if (orderSha256(order) !== expectedSha256) {
    fail('auftrag-abweichung', 'Auftrag weicht vom erwarteten Auftrag ab');
  }

  return true;
}
