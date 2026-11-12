// A6.2-4: Sicheres Codepaket v2 (Schema agent-code-auftrag-paket-v1), isolierter Arbeitsordner
// und Geheimnispruefung.
//
// Wirkungslos bis A6.4: Kein Workflow und kein anderes Skript ruft dieses Modul auf. Es hat keinen
// Einstiegspunkt, liest keine Prozessumgebung, stellt keine Netzanfragen und protokolliert nichts.
// Jeder Ablehnungsgrund ist ein OrderError mit code (oder ein ProfileError aus parseStrictJson).
//
// Ablauf in A6.4:
// 1. prepareWorkspace (vor Claude): prueft den vertrauenswuerdigen Checkout trustedRoot mit Git
//    und kopiert genau die geprueften Dateien von order.base_sha in einen neuen Arbeitsordner
//    workDir ohne .git.
// 2. Claude veraendert nur workDir.
// 3. compareWorkspace und createPackageV2 (nach Claude): reiner Dateisystemvergleich von workDir
//    mit trustedRoot. Kein Git, keine Shell, kein Prozess. Ein Git-Aufruf im veraenderten Ordner
//    koennte Konfiguration oder Hooks ausfuehren, die Claude dort angelegt hat (etwa
//    core.fsmonitor). Der ganze Abschnitt "OHNE GIT" unten ist deshalb frei von Git; ein Wachtest
//    prueft das am Quelltext.
// 4. parsePackageV2 (in jedem Job erneut): prueft ein Paket vollstaendig, bevor irgendetwas
//    geschrieben wird. Das Ergebnis ist nur innerhalb dieses Prozesses als geprueft gebunden
//    (WeakSet); die Dateibytes liegen privat in einer WeakMap und werden nur als Kopie herausgegeben.
// 5. applyPackageV2: schreibt in einen frischen, separaten Pruef-Checkout und prueft danach mit Git.
//
// Grenzen, die dieses Modul nicht schliessen kann und die A6.4 tragen muss:
// - Der Vergleich nach Claude ist nur gueltig, wenn Claude trustedRoot tatsaechlich nicht
//   veraendern konnte. Fuer die freigegebenen Dateien wird trustedRoot gegen order.basis_blobs
//   nachgerechnet, fuer alle anderen Dateien gilt trustedRoot als Referenz. Die Zugriffstrennung
//   (K1/K2) ist hier nicht belegt.
// - Zwischen Pruefung und Lesen oder Schreiben einer Datei bleibt ein Zeitfenster. Der Vergleich
//   muss laufen, wenn Claude beendet ist, und kein anderer Prozess darf in die Ordner schreiben.
// - Node.js muss mit einem Arbeitsverzeichnis ausserhalb von workDir laufen.
// - Ein Fehler in applyPackageV2 nach dem ersten Schreiben laesst einen halb beschriebenen
//   Pruef-Checkout zurueck. Er muss verworfen werden und darf weder fuer Tests noch fuer eine
//   Veroeffentlichung verwendet werden. Ebenso darf ein Arbeitsordner, dessen Vorbereitung
//   fehlgeschlagen ist, nicht an Claude gehen.
// - Pfadvergleiche sind bewusst unabhaengig von Gross- und Kleinschreibung. Auf Linux lehnt das
//   auch zwei Ordner ab, die sich nur darin unterscheiden (falsches Nein, kein falsches Ja).
// - containsSecretValue wird von createPackageV2 und parsePackageV2 NICHT aufgerufen, weil dieses
//   Modul keine Geheimniswerte kennt. A6.4 muss es vor jedem Artefakt-Upload selbst mit den
//   tatsaechlichen Werten aufrufen. scanForSecrets (Muster) laeuft dagegen immer mit.
// - UNC- und Geraetepfade (Beginn mit zwei Schraegstrichen) werden abgelehnt, weil realpath sie
//   nicht auf den lokalen Pfad zurueckfuehrt. Das gilt auch fuer verbundene Netzlaufwerke unter
//   Windows, deren realpath ein UNC-Pfad ist: Checkout und Arbeitsordner muessen lokal liegen. Zusaetzlich vergleicht prepareWorkspace die
//   Identitaet (Geraet und Inode) aller Vorfahren, damit auch Bind-Mounts auffallen.
// - Einige Pruefungen sind bewusst doppelt (Tiefenverteidigung) und hinter einer frueheren
//   Pruefung nicht einzeln erreichbar, etwa die zweite Nachrechnung der Bytes unmittelbar vor dem
//   Schreiben und die Git-Nachpruefung von Modus und Index. Der Rot-Beweis nennt sie einzeln.
// - Die Geheimnispruefung erkennt nur die genannten Muster und Kodierungen. Sie ersetzt K1 nicht.
//   Die Muster verlangen nach dem Praefix eine Mindestlaenge (siehe SECRET_PATTERNS), damit
//   blosse Erwaehnungen wie "ghp_" in Texten keinen Fehlalarm ausloesen.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { types } from 'node:util';

import { OrderError, openRepository, orderSha256, runGit, sameOrder } from './agent-code-auftrag.mjs';
import { parseStrictJson, sha256 } from './agent-profile.mjs';

export const PACKAGE_SCHEMA = 'agent-code-auftrag-paket-v1';
export const MAX_FILE_BYTES = 20_000;
export const MAX_PACKAGE_BYTES = 60_000;
export const MAX_CHANGED_LINES = 200;
export const MAX_PATCH_BYTES = 24_000;
export const MIN_SECRET_LENGTH = 20;
export const MAX_SECRET_LENGTH = 4096;
export const MAX_SECRET_VALUES = 50;
export const MAX_TREE_ENTRIES = 10_000;
export const MAX_TREE_DEPTH = 32;

const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const PACKAGE_KEYS = Object.freeze([
  'schema',
  'auftrag_sha256',
  'repository',
  'issue',
  'profil_id',
  'profil_sha256',
  'issue_sha256',
  'abnahme_sha256',
  'base_sha',
  'dateien',
]);
// Diese Felder muessen genau den Werten des Auftrags entsprechen.
const BOUND_KEYS = Object.freeze(['repository', 'issue', 'profil_id', 'profil_sha256', 'issue_sha256', 'abnahme_sha256', 'base_sha']);
const FILE_KEYS = Object.freeze(['pfad', 'basis_blob', 'git_blob', 'sha256', 'bytes', 'base64']);

function fail(code, message) {
  throw new OrderError(code, `Paket abgelehnt: ${message}`);
}

// ===========================================================================
// ABSCHNITT OHNE GIT: Anfang
// Alles bis zur Endmarke laeuft ohne Git, Shell und Prozesse, nur mit lstat, stat, readdir,
// readFile, realpath, mkdir und writeFile. compareWorkspace, createPackageV2, parsePackageV2,
// packageFileBytes, requireAllChanged, scanForSecrets und containsSecretValue liegen hier.
// ===========================================================================

const BYTE_LENGTH = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const TYPED_SET = Uint8Array.prototype.set;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

// Genau diese Schluessel in genau dieser Reihenfolge. Damit hat jedes Paket nur eine Schreibweise.
function hasKeysInOrder(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

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

function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// Eigene Kopie in eigenem Speicher. Buffer.alloc nutzt nie den gemeinsamen Speicherpool von Node.js.
// Eine Kopie aus dem Pool laege im selben ArrayBuffer wie andere kleine Buffer, und wer einen
// solchen Buffer haelt, koennte ueber dessen .buffer hineinschreiben. Laenge und Inhalt kommen aus
// den eingebauten Zugriffen, nicht aus ueberschreibbaren Eigenschaften.
function ownCopy(bytes) {
  const copy = Buffer.alloc(Reflect.apply(BYTE_LENGTH, bytes, []));
  Reflect.apply(TYPED_SET, copy, [bytes]);
  return copy;
}

function readBuffer(value, code) {
  if (!Buffer.isBuffer(value) || types.isProxy(value)) {
    fail(code, 'Bytes muessen als Buffer uebergeben werden');
  }

  // Ein Objekt, das nur den Prototyp von Buffer traegt, hat keinen echten Speicher.
  try {
    return ownCopy(value);
  } catch {
    fail(code, 'Bytes muessen als Buffer uebergeben werden');
  }
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

// ---------------------------------------------------------------------------
// Geheimnispruefung
// ---------------------------------------------------------------------------

// Mindestlaengen nach dem Praefix: echte GitHub-Token haben 36 Zeichen (ghp_ und Verwandte) oder 82
// (github_pat_), Anthropic-Schluessel deutlich mehr. 20 Zeichen trennen Token von Erwaehnungen.
const SECRET_PATTERNS = Object.freeze([
  ['anthropic-schluessel', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['github-token', /gh[psour]_[A-Za-z0-9]{20,}/],
  ['github-pat', /github_pat_[A-Za-z0-9_]{20,}/],
  ['privater-schluessel', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]{0,6}-----/],
  ['aws-zugangsschluessel', /(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ['zugangstoken-url', /x-access-token:[^\s@'"`]{8,}/i],
]);

function secretResult(kinds) {
  return Object.freeze({ fund: kinds.length > 0, arten: Object.freeze([...new Set(kinds)].sort()) });
}

// Prueft dekodierte Dateibytes auf bekannte Muster. Ergebnis nennt nur, ob und welche Art gefunden
// wurde, nie den Wert.
export function scanForSecrets(bytes) {
  // latin1 bildet jedes Byte auf genau ein Zeichen ab. Die Muster sind reines ASCII.
  const text = readBuffer(bytes, 'geheimnis-eingabe').toString('latin1');
  return secretResult(SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind));
}

// Base64-Zeichen, die nur von den Bytes des Werts abhaengen, wenn er an einer Position mit Rest
// pad (0, 1 oder 2) bezogen auf 3 in einem laengeren Inhalt steht. Die Zeichen am Rand mischen Bits
// der Nachbarbytes und werden weggelassen.
function base64Core(value, pad) {
  const encoded = Buffer.concat([Buffer.alloc(pad), value]).toString('base64');
  const start = Math.ceil((pad * 8) / 6);
  const end = Math.floor(((pad + value.length) * 8) / 6);
  return encoded.slice(start, end);
}

function readSecretValues(values) {
  const list = readList(values, MAX_SECRET_VALUES);

  if (list === null) {
    fail('geheimnis-eingabe', `Geheimniswerte muessen eine Liste mit hoechstens ${MAX_SECRET_VALUES} Eintraegen sein`);
  }

  // Eine erwartete, aber leere Liste darf nie als bestandene Pruefung gelten.
  if (list.length === 0) {
    fail('geheimnis-werte-leer', 'keine Geheimniswerte uebergeben, Pruefung nicht moeglich');
  }

  return list.map((value, index) => {
    if (typeof value !== 'string' || !value.isWellFormed() || value.length > MAX_SECRET_LENGTH) {
      fail('geheimnis-eingabe', `Geheimniswert Nummer ${index + 1} ist kein gueltiger Text`);
    }

    if ([...value].length < MIN_SECRET_LENGTH) {
      fail('geheimnis-wert-kurz', `Geheimniswert Nummer ${index + 1} ist kuerzer als ${MIN_SECRET_LENGTH} Zeichen`);
    }

    return value;
  });
}

// Sucht ausdruecklich uebergebene Geheimniswerte in Klartext, Base64 und Base64url (je drei
// Ausrichtungen), Hex klein, gross und gemischt, umgedreht und ohne nicht alphanumerische Zeichen.
// Hex und Base64 werden zusaetzlich im Inhalt ohne Trenn- und Sonderzeichen gesucht (getrennt:
// etwa 41:62 oder '...' + '...'). Nicht erkannt werden zum Beispiel Dezimalbytes, umgedrehte
// Kodierungen und Verschluesselung. Ergebnis und Fehler nennen nie einen Wert, einen Teil davon
// oder eine Kodierung.
export function containsSecretValue(bytes, values) {
  const text = readBuffer(bytes, 'geheimnis-eingabe').toString('latin1');
  const secrets = readSecretValues(values);
  const compact = text.replace(/\s+/g, '');
  const alnumText = text.replace(/[^A-Za-z0-9]/g, '');
  const lowerText = text.toLowerCase();
  const lowerAlnum = alnumText.toLowerCase();
  const kinds = [];

  for (const secret of secrets) {
    const raw = Buffer.from(secret, 'utf8');
    const plain = raw.toString('latin1');
    const reversed = Buffer.from([...secret].reverse().join(''), 'utf8').toString('latin1');
    const alnum = plain.replace(/[^A-Za-z0-9]/g, '');
    const hex = raw.toString('hex');

    if (text.includes(plain)) {
      kinds.push('klartext');
    }

    if (text.includes(reversed)) {
      kinds.push('umgedreht');
    }

    // Erst ab 16 alphanumerischen Zeichen, sonst waeren Fehlalarme wahrscheinlich.
    if (alnum.length >= 16 && alnumText.includes(alnum)) {
      kinds.push('alphanumerisch');
    }

    if (text.includes(hex)) {
      kinds.push('hex-klein');
    }

    if (text.includes(hex.toUpperCase())) {
      kinds.push('hex-gross');
    }

    // Gemischte Schreibweise oder mit Trennzeichen (41:62, \x41\x62, 0x41 0x62).
    if (lowerText.includes(hex) || lowerAlnum.includes(hex) || lowerAlnum.includes(hex.replace(/(..)/g, 'x$1')) || lowerAlnum.includes(hex.replace(/(..)/g, '0x$1'))) {
      kinds.push('hex-getrennt');
    }

    for (const pad of [0, 1, 2]) {
      const core = base64Core(raw, pad);
      const url = core.replaceAll('+', '-').replaceAll('/', '_');

      if (text.includes(core) || compact.includes(core)) {
        kinds.push('base64');
      }

      if (text.includes(url) || compact.includes(url)) {
        kinds.push('base64url');
      }

      // Durch Verkettung oder Sonderzeichen geteilt. Erst ab 16 Zeichen, gegen Fehlalarme.
      const coreAlnum = core.replace(/[^A-Za-z0-9]/g, '');

      if (coreAlnum.length >= 16 && alnumText.includes(coreAlnum)) {
        kinds.push('base64-geteilt');
      }
    }
  }

  return secretResult(kinds);
}

// ---------------------------------------------------------------------------
// Inhaltsregeln und vollstaendige Aenderungsmenge
// ---------------------------------------------------------------------------

// label ist immer ein Pfad aus dem Auftrag, nie ein Name aus dem Arbeitsordner.
function checkContent(bytes, label) {
  if (bytes.length === 0) {
    fail('paket-datei-leer', `${label} ist leer`);
  }

  if (bytes.length > MAX_FILE_BYTES) {
    fail('paket-datei-groesse', `${label} ist groesser als ${MAX_FILE_BYTES} Bytes`);
  }

  if (bytes.includes(0)) {
    fail('paket-nul', `${label} enthaelt ein NUL-Byte`);
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('paket-utf8', `${label} ist kein gueltiges UTF-8`);
  }

  if (scanForSecrets(bytes).fund) {
    fail('paket-geheimnis', `${label} enthaelt ein bekanntes Geheimnismuster`);
  }
}

// Gemeinsame Regel fuer Dateisystemvergleich, Paketpruefung und Git-Nachpruefung: genau die Pfade
// aus order.dateien in derselben Reihenfolge, jeder mit einer Blob-ID ungleich dem Basis-Blob.
// Keine echte Teilmenge, keine Obermenge.
export function requireAllChanged(order, entries) {
  // Wirft auftrag-ungeprueft fuer alles, was nicht aus resolveOrder stammt.
  orderSha256(order);
  const files = order.dateien;
  const list = readList(entries, files.length);

  if (list === null || list.length !== files.length) {
    fail('paket-dateiliste', 'geaenderte Dateien entsprechen nicht genau den freigegebenen Dateien');
  }

  list.forEach((entry, index) => {
    const pfad = isPlainObject(entry) ? own(entry, 'pfad') : undefined;
    const blob = isPlainObject(entry) ? own(entry, 'git_blob') : undefined;

    if (pfad !== files[index]) {
      fail('paket-dateiliste', 'geaenderte Dateien entsprechen nicht genau den freigegebenen Dateien');
    }

    if (typeof blob !== 'string' || !HEX40_RE.test(blob)) {
      fail('paket-format', `Blob-ID fuer ${pfad} fehlt oder ist ungueltig`);
    }

    if (blob === order.basis_blobs[pfad]) {
      fail('paket-unveraendert', `${pfad} ist unveraendert, jede freigegebene Datei muss geaendert sein`);
    }
  });

  return true;
}

// ---------------------------------------------------------------------------
// Pfade: kanonisch, ohne Symlink, ohne Ueberschneidung
// ---------------------------------------------------------------------------

const BACKSLASH = String.fromCharCode(92);

// Vergleichsschluessel eines kanonischen Pfads: Schraegstriche, Kleinschreibung, Trenner am Ende.
function pathKey(path) {
  const text = path.split(BACKSLASH).join('/').toLowerCase();
  return text.endsWith('/') ? text : `${text}/`;
}

function overlaps(a, b) {
  const keyA = pathKey(a);
  const keyB = pathKey(b);
  return keyA.startsWith(keyB) || keyB.startsWith(keyA);
}

function checkPathInput(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    fail('paket-pfad', 'Pfad muss ein absoluter Pfad sein');
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    fail('paket-pfad', 'Pfad kann nicht geprueft werden');
  }
}

function realPath(path) {
  let real;

  try {
    real = realpathSync.native(path);
  } catch {
    fail('paket-pfad', 'Pfad kann nicht aufgeloest werden');
  }

  // UNC- und Geraetepfade fuehrt realpath nicht auf den lokalen Pfad zurueck. Ein Vergleich der
  // Texte waere dann wirkungslos.
  if (/^[\\/]{2}/.test(real)) {
    fail('paket-pfad', 'UNC- und Geraetepfade sind nicht erlaubt');
  }

  return real;
}

// Geraet und Inode eines vorhandenen Pfads, oder null. Inode 0 melden manche Dateisysteme fuer
// jeden Eintrag; dann sagt der Wert nichts und die Pruefung entfaellt (die Textpruefung bleibt).
function identity(path) {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function ancestors(path) {
  const list = [];

  for (let current = path; ; current = dirname(current)) {
    list.push(current);

    if (dirname(current) === current) {
      return list;
    }
  }
}

// Zweite, vom Pfadtext unabhaengige Pruefung: Kein Vorfahr des einen Ordners (einschliesslich
// des Ordners selbst) ist derselbe physische Ordner wie der andere. Faengt Bind-Mounts und andere
// Schreibweisen desselben Ordners. inner muss nicht existieren, dann zaehlen seine Vorfahren.
function sameDirectoryChain(a, b) {
  const idA = identity(a);
  const idB = identity(b);
  return (
    (idA !== null && ancestors(b).some(path => identity(path) === idA)) ||
    (idB !== null && ancestors(a).some(path => identity(path) === idB))
  );
}

// Vorhandenes Verzeichnis, selbst kein Symlink. Ergebnis ist der kanonische physische Pfad.
function realDir(path) {
  checkPathInput(path);
  const stat = lstatOrNull(path);

  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('paket-pfad', 'Verzeichnis fehlt, ist kein Verzeichnis oder ist ein Symlink');
  }

  return realPath(path);
}

// Arbeitsordner: entweder ein vorhandenes, leeres, echtes Verzeichnis oder ein neuer Name in einem
// vorhandenen Elternverzeichnis. Symlinks im Elternpfad loest realpath auf, der Ordner selbst darf
// keiner sein.
function plannedWorkDir(path) {
  checkPathInput(path);
  const stat = lstatOrNull(path);

  if (stat !== null) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('paket-pfad', 'Arbeitsordner ist kein Verzeichnis oder ein Symlink');
    }

    return realPath(path);
  }

  const name = basename(path);

  // Unter Windows entstehen bei Punkt oder Leerraum am Ende, bei reservierten Geraetenamen und bei
  // Datenstrom-Schreibweisen (name::$INDEX_ALLOCATION) Ordner, die anders heissen als angegeben
  // oder die viele Werkzeuge nicht ansprechen koennen. Solche Namen sind ueberall verboten.
  if (
    name === '' || name === '.' || name === '..' || name.endsWith('.') || /\s$/u.test(name) ||
    /[<>:"|?*\u0000-\u001f]/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(name)
  ) {
    fail('paket-pfad', 'Arbeitsordner braucht einen eigenen, unter Windows und Linux eindeutigen Namen');
  }

  return join(realDir(dirname(path)), name);
}

// ---------------------------------------------------------------------------
// Dateibaum lesen, nur mit lstat und readdir
// ---------------------------------------------------------------------------

// Liest einen Ordner vollstaendig. Symlinks, Sonderdateien, harte Links und .git (ausser dem
// obersten .git des vertrauenswuerdigen Checkouts) brechen ab. Fehlermeldungen nennen keine Namen
// aus dem Ordner, weil sie aus dem Arbeitsordner von Claude stammen koennen.
function walk(root, allowTopGit) {
  const files = new Map();
  const dirs = new Set();
  let entries = 0;

  const visit = (abs, rel, depth) => {
    if (depth > MAX_TREE_DEPTH) {
      fail('paket-baum-umfang', `mehr als ${MAX_TREE_DEPTH} Ordnerebenen`);
    }

    let names;

    try {
      names = readdirSync(abs);
    } catch {
      fail('paket-lesen', 'Ordner kann nicht gelesen werden');
    }

    for (const name of names.sort()) {
      entries += 1;

      if (entries > MAX_TREE_ENTRIES) {
        fail('paket-baum-umfang', `mehr als ${MAX_TREE_ENTRIES} Eintraege`);
      }

      if (allowTopGit && rel === '' && name === '.git') {
        continue;
      }

      if (name.toLowerCase() === '.git') {
        fail('paket-git-ordner', '.git im Arbeitsbereich gefunden');
      }

      const childAbs = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      let stat;

      try {
        stat = lstatSync(childAbs);
      } catch {
        fail('paket-lesen', 'Eintrag kann nicht geprueft werden');
      }

      if (stat.isSymbolicLink()) {
        fail('paket-symlink', 'Symlink im Arbeitsbereich gefunden');
      }

      if (stat.isDirectory()) {
        dirs.add(childRel);
        visit(childAbs, childRel, depth + 1);
      } else if (stat.isFile()) {
        // Ein harter Link koennte auf eine Datei ausserhalb des Ordners zeigen.
        if (stat.nlink !== 1) {
          fail('paket-hardlink', 'Datei mit mehreren harten Links gefunden');
        }

        files.set(childRel, { abs: childAbs, size: stat.size });
      } else {
        fail('paket-sonderdatei', 'Sonderdatei im Arbeitsbereich gefunden');
      }
    }
  };

  visit(root, '', 0);
  return { files, dirs };
}

function readExact(info) {
  let bytes;

  try {
    bytes = readFileSync(info.abs);
  } catch {
    fail('paket-lesen', 'Datei kann nicht gelesen werden');
  }

  if (bytes.length !== info.size) {
    fail('paket-lesen', 'Datei hat sich waehrend der Pruefung veraendert');
  }

  return bytes;
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

function sameSet(a, b) {
  return a.size === b.size && [...a].every(item => b.has(item));
}

// Der Ordner muss im Dateisystem genau dem Baum entsprechen: dieselben Dateien, dieselben Ordner
// (also keine leeren Zusatzordner), jede Datei mit der Blob-ID aus dem Baum. Ergebnis: Pfad zu Bytes.
function verifyAgainstTree(root, tree, allowTopGit, code) {
  const found = walk(root, allowTopGit);

  if (!sameSet(new Set(found.files.keys()), new Set(tree.keys())) || !sameSet(found.dirs, parentDirs(tree.keys()))) {
    fail(code, 'Dateien oder Ordner weichen vom Ausgangscommit ab');
  }

  const result = new Map();

  for (const [path, info] of found.files) {
    const bytes = readExact(info);

    if (gitBlobId(bytes) !== tree.get(path).oid) {
      fail(code, `${path} weicht vom Ausgangscommit ab`);
    }

    result.set(path, bytes);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Vergleich nach Claude und Paketbau
// ---------------------------------------------------------------------------

// Vergleicht workDir vollstaendig mit trustedRoot. Ergebnis: je freigegebene Datei die einmal
// gelesenen, geprueften Bytes. Genau diese Bytes gehen spaeter ins Paket.
function compareInternal(trustedRoot, order, expectedSha256, workDir) {
  sameOrder(order, expectedSha256);
  const trusted = realDir(trustedRoot);
  const work = realDir(workDir);

  if (overlaps(trusted, work) || sameDirectoryChain(trusted, work)) {
    fail('paket-ueberschneidung', 'Arbeitsordner und vertrauenswuerdiger Checkout ueberschneiden sich');
  }

  const base = walk(trusted, true);
  const changed = walk(work, false);

  for (const dir of changed.dirs) {
    if (base.files.has(dir)) {
      fail('paket-dateityp', 'eine Datei wurde durch einen Ordner ersetzt');
    }

    if (!base.dirs.has(dir)) {
      fail('paket-ordner-neu', 'zusaetzlicher Ordner im Arbeitsordner');
    }
  }

  for (const path of changed.files.keys()) {
    if (base.dirs.has(path)) {
      fail('paket-dateityp', 'ein Ordner wurde durch eine Datei ersetzt');
    }

    if (!base.files.has(path)) {
      fail('paket-datei-neu', 'zusaetzliche Datei im Arbeitsordner');
    }
  }

  for (const dir of base.dirs) {
    if (!changed.dirs.has(dir)) {
      fail('paket-ordner-fehlt', `Ordner ${dir} fehlt im Arbeitsordner`);
    }
  }

  for (const path of base.files.keys()) {
    if (!changed.files.has(path)) {
      fail('paket-datei-fehlt', `${path} fehlt im Arbeitsordner`);
    }
  }

  const allowed = new Set(order.dateien);

  // Ab hier stammen alle genannten Pfade aus trustedRoot oder dem Auftrag.
  for (const [path, info] of base.files) {
    if (allowed.has(path)) {
      continue;
    }

    const other = changed.files.get(path);

    if (other.size !== info.size || !readExact(other).equals(readExact(info))) {
      fail('paket-fremde-aenderung', `${path} ist nicht freigegeben und wurde veraendert`);
    }
  }

  const files = order.dateien.map(pfad => {
    const baseInfo = base.files.get(pfad);

    if (baseInfo === undefined || gitBlobId(readExact(baseInfo)) !== order.basis_blobs[pfad]) {
      fail('paket-quelle', `${pfad} im vertrauenswuerdigen Checkout weicht vom Ausgangscommit ab`);
    }

    const info = changed.files.get(pfad);

    // Groesse vor dem Lesen begrenzen, danach am Inhalt erneut.
    if (info.size > MAX_FILE_BYTES) {
      fail('paket-datei-groesse', `${pfad} ist groesser als ${MAX_FILE_BYTES} Bytes`);
    }

    const bytes = readExact(info);
    checkContent(bytes, pfad);
    return { pfad, git_blob: gitBlobId(bytes), sha256: sha256(bytes), bytes };
  });

  requireAllChanged(order, files);
  return files;
}

const describe = files => Object.freeze(files.map(file => Object.freeze({
  pfad: file.pfad,
  git_blob: file.git_blob,
  sha256: file.sha256,
  bytes: file.bytes.length,
})));

// Nach Claude: reiner Dateisystemvergleich. Ergebnis enthaelt nur Metadaten, keine Bytes.
export function compareWorkspace(trustedRoot, order, expectedSha256, workDir) {
  return Object.freeze({ dateien: describe(compareInternal(trustedRoot, order, expectedSha256, workDir)) });
}

// Baut das Paket aus genau den Bytes, die compareInternal geprueft hat, und prueft das Ergebnis
// danach mit derselben Funktion wie der Empfaenger. Ergebnis: kanonischer Text und sein SHA-256.
// Der Paket-Hash steht nicht im Paket, er wird getrennt zwischen den Jobs uebergeben.
export function createPackageV2(trustedRoot, order, expectedSha256, workDir) {
  const files = compareInternal(trustedRoot, order, expectedSha256, workDir);
  const data = {
    schema: PACKAGE_SCHEMA,
    auftrag_sha256: expectedSha256,
    repository: order.repository,
    issue: order.issue,
    profil_id: order.profil_id,
    profil_sha256: order.profil_sha256,
    issue_sha256: order.issue_sha256,
    abnahme_sha256: order.abnahme_sha256,
    base_sha: order.base_sha,
    dateien: files.map(file => ({
      pfad: file.pfad,
      basis_blob: order.basis_blobs[file.pfad],
      git_blob: file.git_blob,
      sha256: file.sha256,
      bytes: file.bytes.length,
      base64: file.bytes.toString('base64'),
    })),
  };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const bytes = Buffer.from(text, 'utf8');

  if (bytes.length > MAX_PACKAGE_BYTES) {
    fail('paket-groesse', `Paket groesser als ${MAX_PACKAGE_BYTES} Bytes`);
  }

  const packageSha256 = sha256(bytes);
  parsePackageV2(order, expectedSha256, bytes, packageSha256);
  return Object.freeze({ text, sha256: packageSha256, bytes: bytes.length });
}

// ---------------------------------------------------------------------------
// Paket pruefen und privat binden
// ---------------------------------------------------------------------------

const PARSED_PACKAGES = new WeakSet();
const PACKAGE_BYTES = new WeakMap();
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_FILE_BYTES / 3);

function checkEntry(entry, index, order) {
  if (!isPlainObject(entry) || !hasKeysInOrder(entry, FILE_KEYS)) {
    fail('paket-felder', 'Dateieintrag hat nicht genau die vorgesehenen Felder');
  }

  const pfad = own(entry, 'pfad');

  if (pfad !== order.dateien[index]) {
    fail('paket-dateiliste', 'Dateiliste weicht vom Auftrag ab');
  }

  if (own(entry, 'basis_blob') !== order.basis_blobs[pfad]) {
    fail('paket-basis-blob', `Basis-Blob von ${pfad} passt nicht zum Auftrag`);
  }

  const gitBlob = own(entry, 'git_blob');
  const hash = own(entry, 'sha256');
  const size = own(entry, 'bytes');
  const base64 = own(entry, 'base64');

  if (
    typeof gitBlob !== 'string' || !HEX40_RE.test(gitBlob) ||
    typeof hash !== 'string' || !HEX64_RE.test(hash) ||
    !Number.isSafeInteger(size) ||
    typeof base64 !== 'string'
  ) {
    fail('paket-format', `Dateieintrag ${pfad} hat ungueltige Typen`);
  }

  if (size < 1 || base64 === '') {
    fail('paket-datei-leer', `${pfad} ist leer`);
  }

  if (size > MAX_FILE_BYTES || base64.length > MAX_BASE64_CHARS) {
    fail('paket-datei-groesse', `${pfad} ist groesser als ${MAX_FILE_BYTES} Bytes`);
  }

  const bytes = Buffer.from(base64, 'base64');

  // Nur kanonisches Base64: genau die Schreibweise, die Node.js selbst erzeugt.
  if (bytes.toString('base64') !== base64) {
    fail('paket-base64', `${pfad} ist kein kanonisches Base64`);
  }

  if (bytes.length !== size) {
    fail('paket-bytes', `Bytezahl von ${pfad} stimmt nicht`);
  }

  checkContent(bytes, pfad);

  if (sha256(bytes) !== hash) {
    fail('paket-sha256', `SHA-256 von ${pfad} stimmt nicht`);
  }

  if (gitBlobId(bytes) !== gitBlob) {
    fail('paket-git-blob', `Git-Blob-ID von ${pfad} stimmt nicht`);
  }

  return { pfad, basis_blob: order.basis_blobs[pfad], git_blob: gitBlob, sha256: hash, bytes: size, data: ownCopy(bytes) };
}

// Prueft ein vollstaendig nicht vertrauenswuerdiges Paket. packageSha256 ist der getrennt
// uebergebene Hash der vollstaendigen Paketbytes. Ergebnis: eingefrorene Metadaten ohne Bytes,
// nur in diesem Prozess als geprueft gebunden. In jedem Job erneut aufrufen.
export function parsePackageV2(order, expectedSha256, packageBytes, packageSha256) {
  sameOrder(order, expectedSha256);

  if (typeof packageSha256 !== 'string' || !HEX64_RE.test(packageSha256)) {
    fail('paket-hash-format', 'Paket-Hash muss aus 64 kleinen Hex-Zeichen bestehen');
  }

  const bytes = readBuffer(packageBytes, 'paket-eingabe');

  if (bytes.length > MAX_PACKAGE_BYTES) {
    fail('paket-groesse', `Paket groesser als ${MAX_PACKAGE_BYTES} Bytes`);
  }

  if (sha256(bytes) !== packageSha256) {
    fail('paket-hash', 'Paket weicht vom erwarteten Paket-Hash ab');
  }

  const data = parseStrictJson(bytes, MAX_PACKAGE_BYTES);

  if (!hasKeysInOrder(data, PACKAGE_KEYS)) {
    fail('paket-felder', 'Paket hat nicht genau die vorgesehenen Felder');
  }

  if (own(data, 'schema') !== PACKAGE_SCHEMA) {
    fail('paket-schema', 'unbekanntes Paket-Schema');
  }

  if (own(data, 'auftrag_sha256') !== expectedSha256) {
    fail('paket-bindung', 'Paket gehoert zu einem anderen Auftrag');
  }

  for (const key of BOUND_KEYS) {
    if (own(data, key) !== order[key]) {
      fail('paket-bindung', `Feld ${key} passt nicht zum Auftrag`);
    }
  }

  const list = readList(own(data, 'dateien'), order.dateien.length);

  if (list === null || list.length !== order.dateien.length) {
    fail('paket-dateiliste', 'Dateiliste weicht vom Auftrag ab');
  }

  const files = list.map((entry, index) => checkEntry(entry, index, order));
  requireAllChanged(order, files);

  const result = deepFreeze({
    auftrag_sha256: expectedSha256,
    paket_sha256: packageSha256,
    dateien: files.map(({ data: _bytes, ...meta }) => meta),
  });
  PARSED_PACKAGES.add(result);
  PACKAGE_BYTES.set(result, { order, expectedSha256, bytes: new Map(files.map(file => [file.pfad, file.data])) });
  return result;
}

function requireParsed(parsed) {
  if (!PARSED_PACKAGES.has(parsed)) {
    fail('paket-ungeprueft', 'Paket stammt nicht aus parsePackageV2');
  }

  return PACKAGE_BYTES.get(parsed);
}

// Gibt die geprueften Bytes einer Datei als eigene Kopie heraus. Aenderungen an der Kopie wirken
// nicht auf das gepruefte Paket.
export function packageFileBytes(parsed, pfad) {
  const bytes = requireParsed(parsed).bytes.get(pfad);

  if (bytes === undefined) {
    fail('paket-eingabe', 'Datei gehoert nicht zum Paket');
  }

  return ownCopy(bytes);
}

// Rechnet SHA-256, Git-Blob-ID, Laenge und Inhaltsregeln aus genau den uebergebenen Bytes nach.
function verifyBytes(bytes, meta) {
  if (bytes.length !== meta.bytes || sha256(bytes) !== meta.sha256 || gitBlobId(bytes) !== meta.git_blob) {
    fail('paket-manipuliert', `Bytes von ${meta.pfad} passen nicht mehr zum geprueften Paket`);
  }

  checkContent(bytes, meta.pfad);
}

// ===========================================================================
// ABSCHNITT OHNE GIT: Ende
// ===========================================================================

// ---------------------------------------------------------------------------
// Git-Pruefung eines vertrauenswuerdigen Checkouts (nur trustedRoot und Pruef-Checkout)
// ---------------------------------------------------------------------------

const INDEX_LINE_RE = /^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t(.+)$/s;
const STATUS_ARGS = Object.freeze(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);

function readOptions(options) {
  const keys = isPlainObject(options) ? Reflect.ownKeys(options) : [];

  if (keys.length !== 1 || keys[0] !== 'gitEnv') {
    fail('paket-eingabe', 'Optionen brauchen genau gitEnv');
  }

  return own(options, 'gitEnv');
}

// Prueft root als oberste Ebene eines sauberen Checkouts auf order.base_sha. Commit und Baeume
// rechnet openRepository nach. Ergebnis: { git, tree } aus openRepository.
function openCheckout(root, order, gitEnv) {
  const repo = openRepository(root, order.base_sha, gitEnv);
  const { git, tree } = repo;
  const top = runGit(git, ['rev-parse', '--show-toplevel'], 'paket-git-wurzel').trim();

  if (top === '' || pathKey(realPath(top)) !== pathKey(root)) {
    fail('paket-git-wurzel', 'Verzeichnis ist nicht das Hauptverzeichnis des Repositorys');
  }

  if (runGit(git, ['rev-parse', '--verify', 'HEAD^{commit}'], 'paket-head').trim() !== order.base_sha) {
    fail('paket-head', 'HEAD steht nicht auf dem Ausgangscommit');
  }

  if (runGit(git, STATUS_ARGS, 'paket-status') !== '') {
    fail('paket-status', 'Checkout hat Aenderungen, ungetrackte oder ignorierte Dateien');
  }

  // Jeder Eintrag des Baums ist ein gewoehnlicher Blob. Pfade sind auch ohne Beachtung der
  // Gross- und Kleinschreibung eindeutig und enthalten kein .git.
  const seen = new Map();

  for (const [path, entry] of tree) {
    if (entry.mode !== '100644' || entry.type !== 'blob') {
      fail('paket-baum-modus', `${path} ist keine gewoehnliche Datei (Modus ${entry.mode})`);
    }

    const parts = path.split('/');

    if (parts.some(part => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      fail('paket-baum-pfad', `${path} ist als Pfad nicht erlaubt`);
    }

    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('/');
      const key = prefix.toLowerCase();

      if (seen.has(key) && seen.get(key) !== prefix) {
        fail('paket-baum-pfad', `${prefix} unterscheidet sich von einem anderen Pfad nur in der Schreibweise`);
      }

      seen.set(key, prefix);
    }
  }

  const index = runGit(git, ['ls-files', '--stage', '-z'], 'paket-index').split('\0').filter(Boolean);

  if (index.length !== tree.size) {
    fail('paket-index', 'Git-Index weicht vom Ausgangscommit ab');
  }

  for (const line of index) {
    const match = INDEX_LINE_RE.exec(line);

    if (!match || match[1] !== '100644' || match[3] !== '0' || tree.get(match[4])?.oid !== match[2]) {
      fail('paket-index', 'Git-Index weicht vom Ausgangscommit ab');
    }
  }

  for (const file of order.dateien) {
    if (tree.get(file)?.oid !== order.basis_blobs[file]) {
      fail('paket-basis-blob', `${file} hat im Checkout nicht den Basis-Blob des Auftrags`);
    }
  }

  return repo;
}

// ---------------------------------------------------------------------------
// Vor Claude: Arbeitsordner vorbereiten
// ---------------------------------------------------------------------------

// Prueft trustedRoot und kopiert genau die Dateien des Ausgangscommits in workDir, ohne .git.
// workDir ist neu (Elternordner vorhanden) oder ein vorhandener leerer Ordner. Ergebnis: der
// kanonische Pfad des Arbeitsordners und die Zahl der Dateien. Jeder Fehler wirft; ein dabei
// entstandener Ordner darf nicht verwendet werden.
export function prepareWorkspace(trustedRoot, order, expectedSha256, workDir, options) {
  sameOrder(order, expectedSha256);
  const gitEnv = readOptions(options);
  const trusted = realDir(trustedRoot);
  const target = plannedWorkDir(workDir);

  if (overlaps(trusted, target) || sameDirectoryChain(trusted, target)) {
    fail('paket-ueberschneidung', 'Arbeitsordner und vertrauenswuerdiger Checkout ueberschneiden sich');
  }

  const { tree } = openCheckout(trusted, order, gitEnv);
  const source = verifyAgainstTree(trusted, tree, true, 'paket-quelle');
  const exists = lstatOrNull(target);

  if (exists === null) {
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch {
      fail('paket-kopie', 'Arbeitsordner kann nicht angelegt werden');
    }
  } else {
    let entries = null;

    try {
      entries = readdirSync(target);
    } catch {
      // Unten abgelehnt.
    }

    if (exists.isSymbolicLink() || !exists.isDirectory() || entries === null || entries.length !== 0) {
      fail('paket-ziel-nicht-leer', 'Arbeitsordner ist nicht leer');
    }
  }

  // Nach dem Anlegen erneut kanonisch pruefen, falls der Ordner inzwischen umgelenkt wurde.
  const work = realDir(target);

  if (pathKey(work) !== pathKey(target) || overlaps(trusted, work) || sameDirectoryChain(trusted, work)) {
    fail('paket-ueberschneidung', 'Arbeitsordner hat sich beim Anlegen veraendert');
  }

  try {
    for (const dir of [...parentDirs(tree.keys())].sort()) {
      mkdirSync(join(work, ...dir.split('/')), { mode: 0o755 });
    }

    for (const [path, bytes] of source) {
      writeFileSync(join(work, ...path.split('/')), bytes, { flag: 'wx', mode: 0o644 });
    }
  } catch {
    fail('paket-kopie', 'Kopie in den Arbeitsordner fehlgeschlagen');
  }

  // Unabhaengige Kontrolle der Kopie: genau der Baum, Byte fuer Byte.
  verifyAgainstTree(work, tree, false, 'paket-kopie-kontrolle');
  return Object.freeze({ arbeitsordner: work, dateien: tree.size });
}

// ---------------------------------------------------------------------------
// Paket in einem frischen Pruef-Checkout anwenden
// ---------------------------------------------------------------------------

// Jede Ordnerebene bis zur Zieldatei ist ein echtes Verzeichnis, das Ziel eine gewoehnliche Datei
// mit genau einem Link und dem Basis-Blob.
function checkTarget(root, pfad, basisBlob) {
  const parts = pfad.split('/');
  let current = root;
  let size = -1;

  for (let depth = 0; depth < parts.length; depth += 1) {
    current = join(current, parts[depth]);
    const stat = lstatOrNull(current);
    const last = depth === parts.length - 1;

    if (stat === null || stat.isSymbolicLink() || (last ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
      fail('paket-ziel', `${pfad} ist kein zulaessiges Schreibziel`);
    }

    size = stat.size;
  }

  if (gitBlobId(readExact({ abs: current, size })) !== basisBlob) {
    fail('paket-ziel', `${pfad} hat nicht den Basis-Blob des Auftrags`);
  }

  return current;
}

function checkAfterWrite(git, root, order, writes) {
  const status = runGit(git, STATUS_ARGS, 'paket-nachpruefung').split('\0').filter(Boolean);

  // Nur ungestagte Aenderungen bestehender Dateien. Keine neuen, geloeschten, umbenannten oder
  // gestagten Dateien.
  if (!status.every(entry => entry.startsWith(' M '))) {
    fail('paket-nachpruefung-art', 'unerlaubte Art von Git-Aenderung');
  }

  const entries = status.map(entry => entry.slice(3)).sort().map(pfad => {
    let bytes;

    try {
      bytes = readFileSync(join(root, ...pfad.split('/')));
    } catch {
      fail('paket-nachpruefung-inhalt', 'geaenderte Datei kann nicht gelesen werden');
    }

    return { pfad, git_blob: gitBlobId(bytes), bytes };
  });

  requireAllChanged(order, entries);

  entries.forEach((entry, index) => {
    if (!entry.bytes.equals(writes[index].data) || entry.git_blob !== writes[index].meta.git_blob) {
      fail('paket-nachpruefung-inhalt', `${entry.pfad} enthaelt nicht die geprueften Bytes`);
    }
  });

  if (runGit(git, ['diff', '--cached', '--name-only', '-z'], 'paket-nachpruefung') !== '') {
    fail('paket-nachpruefung-gestaged', 'gestagte Aenderungen gefunden');
  }

  if (runGit(git, ['diff', '--summary', '--no-ext-diff'], 'paket-nachpruefung').trim() !== '') {
    fail('paket-nachpruefung-summary', 'Dateimodus oder Dateityp wurde veraendert');
  }

  for (const line of runGit(git, ['ls-files', '--stage', '-z', '--', ...order.dateien], 'paket-nachpruefung').split('\0').filter(Boolean)) {
    const match = INDEX_LINE_RE.exec(line);

    if (!match || match[1] !== '100644' || match[3] !== '0' || match[2] !== order.basis_blobs[match[4]]) {
      fail('paket-nachpruefung-modus', 'Git-Index oder Dateimodus wurde veraendert');
    }
  }

  // Wirft bei Leerzeichenfehlern (Exitcode ungleich 0).
  runGit(git, ['diff', '--check', '--no-ext-diff'], 'paket-diff-check');

  const numstat = runGit(git, ['diff', '--numstat', '--no-ext-diff', '--no-textconv', '--', ...order.dateien], 'paket-nachpruefung')
    .trim()
    .split('\n');

  if (numstat.length !== order.dateien.length) {
    fail('paket-nachpruefung-umfang', 'Aenderungsumfang nicht vollstaendig');
  }

  let changedLines = 0;

  for (const line of numstat) {
    const match = /^(\d+)\t(\d+)\t(.+)$/.exec(line);

    if (!match || !order.dateien.includes(match[3])) {
      fail('paket-nachpruefung-umfang', 'binaerer oder unerwarteter Git-Diff');
    }

    changedLines += Number(match[1]) + Number(match[2]);
  }

  // Wie A5: eine Aenderung ohne geaenderte Zeile ist keine zulaessige Aenderung.
  if (changedLines === 0) {
    fail('paket-zeilen', 'keine geaenderte Zeile');
  }

  if (changedLines > MAX_CHANGED_LINES) {
    fail('paket-zeilen', `mehr als ${MAX_CHANGED_LINES} geaenderte Zeilen`);
  }

  const patch = runGit(git, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--', ...order.dateien], 'paket-nachpruefung', true);

  if (patch.length > MAX_PATCH_BYTES) {
    fail('paket-patch', `Git-Patch groesser als ${MAX_PATCH_BYTES} Bytes`);
  }

  return { changedLines, patchBytes: patch.length };
}

// Wendet ein mit parsePackageV2 geprueftes Paket auf einen frischen, sauberen Pruef-Checkout an,
// niemals auf den Arbeitsordner von Claude. Alles wird vor dem ersten Schreiben geprueft, die Bytes
// werden unmittelbar vor jedem Schreiben erneut nachgerechnet, danach prueft Git unabhaengig.
export function applyPackageV2(checkRoot, order, expectedSha256, parsed, options) {
  sameOrder(order, expectedSha256);
  const bound = requireParsed(parsed);

  if (bound.order !== order || bound.expectedSha256 !== expectedSha256) {
    fail('paket-bindung', 'Paket wurde fuer einen anderen Auftrag geprueft');
  }

  const gitEnv = readOptions(options);
  requireAllChanged(order, parsed.dateien);
  const writes = parsed.dateien.map(meta => {
    const data = ownCopy(bound.bytes.get(meta.pfad));
    verifyBytes(data, meta);
    return { meta, data };
  });

  const root = realDir(checkRoot);
  const { git, tree } = openCheckout(root, order, gitEnv);
  verifyAgainstTree(root, tree, true, 'paket-pruef-checkout');
  const targets = writes.map(write => checkTarget(root, write.meta.pfad, write.meta.basis_blob));

  writes.forEach((write, index) => {
    // Unmittelbar vor dem Schreiben aus genau den Bytes, die geschrieben werden.
    verifyBytes(write.data, write.meta);

    try {
      writeFileSync(targets[index], write.data);
    } catch {
      fail('paket-schreiben', `${write.meta.pfad} konnte nicht geschrieben werden, Checkout verwerfen`);
    }
  });

  const result = checkAfterWrite(git, root, order, writes);
  return Object.freeze({
    dateien: Object.freeze(writes.map(write => write.meta.pfad)),
    geaenderte_zeilen: result.changedLines,
    patch_bytes: result.patchBytes,
  });
}
