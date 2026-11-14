// A6.4-2a: Sicheres allgemeines Abnahmemodul (Abnahmeformat v2).
//
// Wirkungslos bis A6.4-4: Kein Workflow und kein anderes Skript ruft dieses Modul auf. Es hat keinen
// Einstiegspunkt, liest keine Prozessumgebung, stellt keine Netzanfragen und protokolliert nichts.
// Jeder Ablehnungsgrund ist ein OrderError mit code (auch aus den verwendeten Auftrags- und
// Paketmodulen). Ein Ablehnungsgrund des Abnahmeprozesses traegt zusaetzlich einen Bericht.
//
// Ablauf von acceptOrderPackage (verbindliche Reihenfolge):
//  1. Eingabe: genau die sieben Schluessel, Auftrag aus resolveOrder, Bindung mit sameOrder.
//  2. Paketbytes unabhaengig mit parsePackageV2 pruefen (kein paralleles Paketformat).
//  3. Git-Umgebung des Aufrufers pruefen. Von ihr gehen nur PATH und die Windows-Systemvariablen
//     weiter. HOME, globale Konfiguration, XDG und Vorlage legt das Modul selbst leer an.
//  4. trustedRoot pruefen (oberste Ebene, Commit und Baeume nachgerechnet, HEAD auf base_sha).
//  5. checkParent pruefen: echtes Verzeichnis, kein Symlink in der Kette, leer, ohne
//     Ueberschneidung mit trustedRoot. Darin einen neuen, eindeutigen Sitzungsordner anlegen.
//  6. git clone --no-local --no-hardlinks --no-checkout --template=<leer> vom geprueften trustedRoot.
//  7. Vor jedem weiteren Git-Befehl im Klon: Struktur von .git (Positivliste, keine Alternates,
//     kein commondir, keine Worktrees, keine Hooks, keine Symlinks, keine harten Links) und
//     Konfiguration (Positivliste konkreter Schluessel mit konkreten Werten).
//  8. Baum von base_sha pruefen (nur gewoehnliche Dateien), dann auf base_sha auschecken und
//     Struktur, Konfiguration, HEAD, Index, Status und Arbeitsbaum erneut kontrollieren.
//  9. Paket ausschliesslich im eigenen Checkout mit applyPackageV2 anwenden.
// 10. Unmittelbar vor der Abnahme erneut alles kontrollieren, die Abnahmedatei an Auftrag und
//     Ausgangscommit binden, das Format v2 aus den gebundenen Originalbytes pruefen und die
//     tatsaechlichen Codedateien gegen die Blob-IDs des geprueften Pakets rechnen.
// 11. Abnahmetreiber in einem eigenen Prozess starten (absoluter Node-Pfad, keine Shell, keine
//     weiteren Argumente, leere Umgebung, stdin zu, Ausgaben begrenzt, 10 s, SIGKILL).
// 12. Nur bei vollstaendigem Erfolg einen tief eingefrorenen Abnahmenachweis erzeugen.
//
// Jeder Git-Befehl dieses Moduls laeuft mit -c core.fsmonitor=false und -c core.hooksPath=<leerer
// eigener Ordner>. Die Konfigurationspruefung selbst laeuft ohne diese Schalter, damit sie nur die
// tatsaechliche Konfiguration sieht. applyPackageV2 ruft Git ohne diese Schalter auf; deshalb steht
// die Konfigurationspruefung vor dem Paketimport.
//
// Abnahmeformat v2: Die Abnahmedatei ist der vertrauenswuerdige Treiber. Sie beginnt mit genau der
// Zeile ACCEPTANCE_FORMAT_LINE. Der Treiber laedt Agentencode nie in seinen eigenen Prozess, sondern
// nur in einem Kindprozess, bewertet dessen Ergebnis selbst und gibt erst nach vollstaendigem Erfolg
// genau ACCEPTANCE_SUCCESS aus. Eine Datei ohne diese Kennung (etwa das Altformat
// agent-acceptance/issue-38.mjs) wird vor dem Start abgelehnt. Die Kennung beweist nicht, dass der
// Treiber sicher geschrieben ist; jede echte v2-Abnahme braucht eine unabhaengige Pruefung und die
// Freigabe durch noah04091 in einem geschuetzten Eigentuemer-PR.
//
// Grenzen, die dieses Modul nicht schliessen kann:
// - Zwischen der Pruefung der Abnahmebytes und dem Oeffnen der Datei durch Node.js bleibt ein
//   Zeitfenster. Ebenso zwischen der letzten Kontrolle der Codedateien und ihrem Laden durch den
//   Treiber. Kein anderer Prozess darf waehrenddessen in den Sitzungsordner schreiben.
// - Keine Isolation gegen gleichzeitige Schreiber und keine Trennung ueber Benutzerrechte. Der
//   Agentencode laeuft im Kindprozess des Treibers mit denselben Rechten wie dieses Modul und kann
//   ausserhalb des Pruef-Checkouts lesen und schreiben.
// - Keine Prozessbaum-Isolation: Ein abgekoppelter Enkelprozess, der die Ausgabe offen haelt, fuehrt
//   zu ETIMEDOUT und damit zur Ablehnung, wird aber nicht sicher beendet. Das muss der Runner oder
//   Container erzwingen.
// - Unter Windows ergaenzt libuv beim Start des Kindprozesses selbst einige Systemvariablen (etwa
//   PATH, TEMP, USERPROFILE), auch wenn hier nur SystemRoot uebergeben wird. Unter Linux ist die
//   Umgebung leer.
// - Ein Treiber kann nur beobachtbares Verhalten pruefen. Der Agentencode beherrscht seinen eigenen
//   Kindprozess vollstaendig und kann dort jedes Verhalten vortaeuschen, das er auch berechnen kann.
// - Der Abnahmenachweis gilt nur in diesem Prozess (WeakSet). Die Weitergabe zwischen Jobs braucht die
//   eigene Paket-, Job- und Laufbindung aus Pflichtpunkt 5.
// - Der Sitzungsordner bleibt nach dem Lauf bestehen und wird nicht wiederverwendet. Der Aufrufer
//   verwirft checkParent nach jedem Lauf, erfolgreich oder nicht.
// - Unterstuetzt sind Linux und Windows. Auf anderen Systemen schreibt git weitere Schluessel in die
//   Konfiguration und die Pruefung lehnt ab (falsches Nein, kein falsches Ja).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { types } from 'node:util';

import { OrderError, openRepository, sameOrder } from './agent-code-auftrag.mjs';
import { applyPackageV2, parsePackageV2 } from './agent-code-auftrag-paket.mjs';
import { GIT_ENV_KEYS, sha256 } from './agent-profile.mjs';

export const ACCEPTANCE_FORMAT_LINE = '// agent-abnahme-format: v2\n';
export const ACCEPTANCE_SUCCESS = 'A6-ABNAHME-BESTANDEN\n';
export const ACCEPTANCE_TIMEOUT_MS = 10_000;
export const ACCEPTANCE_MAX_OUTPUT_BYTES = 64 * 1024;

const IS_WINDOWS = process.platform === 'win32';
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const INPUT_KEYS = Object.freeze(['trustedRoot', 'checkParent', 'order', 'expectedSha256', 'packageBytes', 'packageSha256', 'gitEnv']);
// Nur diese Variablen gehen aus der Git-Umgebung des Aufrufers weiter, alles andere setzt das Modul.
const SYSTEM_KEYS = Object.freeze(['PATH', 'SystemRoot', 'PATHEXT', 'ComSpec', 'windir']);
const FORMAT_BYTES = Buffer.from(ACCEPTANCE_FORMAT_LINE, 'utf8');
const STATUS_ARGS = Object.freeze(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
const INDEX_LINE_RE = /^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t(.+)$/s;

// Oberste Ebene von .git: genau diese Eintraege. index erst nach dem Auschecken.
const GIT_TOP_ALLOWED = Object.freeze(['HEAD', 'config', 'index', 'logs', 'objects', 'packed-refs', 'refs']);
const GIT_TOP_REQUIRED = Object.freeze(['HEAD', 'config', 'objects', 'refs']);
const PACK_FILE_RE = /^pack-[0-9a-f]{40}\.(pack|idx|rev)$/;

function fail(code, message, bericht) {
  const error = new OrderError(code, `Abnahme abgelehnt: ${message}`);

  if (bericht !== undefined) {
    error.bericht = Object.freeze(bericht);
  }

  throw error;
}

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

function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Pfade und Verzeichnisse
// ---------------------------------------------------------------------------

const BACKSLASH = String.fromCharCode(92);

function pathKey(path) {
  const text = path.split(BACKSLASH).join('/').toLowerCase();
  return text.endsWith('/') ? text : `${text}/`;
}

function overlaps(a, b) {
  const keyA = pathKey(a);
  const keyB = pathKey(b);
  return keyA.startsWith(keyB) || keyB.startsWith(keyA);
}

function isInside(path, dir) {
  return typeof path === 'string' && !path.includes('..') && (path.startsWith(`${dir}/`) || path.startsWith(`${dir}${BACKSLASH}`));
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    return undefined;
  }
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
  const list = [];

  for (let current = path; ; current = dirname(current)) {
    list.push(current);

    if (dirname(current) === current) {
      return list;
    }
  }
}

function sameDirectoryChain(a, b) {
  const idA = identity(a);
  const idB = identity(b);
  return (
    (idA !== null && ancestors(b).some(path => identity(path) === idA)) ||
    (idB !== null && ancestors(a).some(path => identity(path) === idB))
  );
}

// Vorhandenes echtes Verzeichnis. Weder der Pfad noch ein Vorfahr ist ein Symlink oder eine andere
// Schreibweise: Der kanonische Pfad muss dem angegebenen entsprechen.
function exactDir(path, code, label) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    fail(code, `${label} muss ein absoluter Pfad sein`);
  }

  const stat = lstatOrNull(path);

  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(code, `${label} fehlt, ist kein Verzeichnis oder ist ein Symlink`);
  }

  let real;

  try {
    real = realpathSync.native(path);
  } catch {
    fail(code, `${label} kann nicht aufgeloest werden`);
  }

  if (/^[\\/]{2}/.test(real) || pathKey(real) !== pathKey(path)) {
    fail(code, `${label} ist ueber einen Symlink, ein Netzlaufwerk oder eine andere Schreibweise erreichbar`);
  }

  return real;
}

function listDir(path, code) {
  try {
    return readdirSync(path).sort();
  } catch {
    fail(code, 'Ordner kann nicht gelesen werden');
  }
}

// ---------------------------------------------------------------------------
// Git-Umgebung und Git-Aufrufe
// ---------------------------------------------------------------------------

// Dieselben Regeln wie isolatedEnv im Auftragsmodul. Ergebnis sind nur die Systemvariablen.
function readCallerEnv(gitEnv) {
  if (!isPlainObject(gitEnv)) {
    fail('abnahme-git-umgebung', 'Git-Umgebung fehlt');
  }

  const clean = Object.create(null);

  for (const key of Reflect.ownKeys(gitEnv)) {
    const value = own(gitEnv, key);

    if (!GIT_ENV_KEYS.includes(key) || typeof value !== 'string' || value.includes('\0')) {
      fail('abnahme-git-umgebung', 'Git-Umgebung enthaelt nicht erlaubte oder ungueltige Eintraege');
    }

    clean[key] = value;
  }

  if (
    clean.GIT_CONFIG_NOSYSTEM !== '1' ||
    typeof clean.PATH !== 'string' || clean.PATH.length === 0 ||
    typeof clean.HOME !== 'string' || clean.HOME.length === 0 ||
    !isInside(clean.GIT_CONFIG_GLOBAL, clean.HOME) ||
    (clean.XDG_CONFIG_HOME !== undefined && !isInside(clean.XDG_CONFIG_HOME, clean.HOME))
  ) {
    fail('abnahme-git-umgebung', 'Git-Umgebung ist nicht isoliert');
  }

  const system = {};

  for (const key of SYSTEM_KEYS) {
    if (clean[key] !== undefined) {
      system[key] = clean[key];
    }
  }

  return Object.freeze(system);
}

// Eigene, leere Git-Umgebung im Sitzungsordner. Keine Einstellung des Aufrufers ausser den
// Systemvariablen erreicht git.
function controlledEnv(system, home) {
  return Object.freeze({
    ...system,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'leer.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  });
}

function execGit(cwd, env, args, code) {
  try {
    return execFileSync('git', args, {
      cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8_000_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch {
    fail(code, `git ${args.find(arg => !arg.startsWith('-') && !arg.includes('=')) ?? ''} fehlgeschlagen`);
  }
}

// Jeder Git-Befehl dieses Moduls (ausser der Konfigurationsliste) laeuft mit abgeschaltetem
// fsmonitor und einem leeren eigenen Hook-Ordner.
function guardedGit(session, cwd, args, code) {
  return execGit(cwd, session.env, ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${session.hooks}`, ...args], code);
}

// ---------------------------------------------------------------------------
// Sitzungsordner
// ---------------------------------------------------------------------------

function createSession(checkParent, trusted, system) {
  const parent = exactDir(checkParent, 'abnahme-pruefordner', 'Pruefordner');

  if (overlaps(parent, trusted) || sameDirectoryChain(parent, trusted)) {
    fail('abnahme-pruefordner', 'Pruefordner und vertrauenswuerdiger Checkout ueberschneiden sich');
  }

  // PRUEFUNG-WIEDERVERWENDUNG: Ein benutzter oder vorbelegter Pruefordner wird nie wiederverwendet.
  if (listDir(parent, 'abnahme-pruefordner').length !== 0) {
    fail('abnahme-pruefordner-benutzt', 'Pruefordner ist nicht leer, ein frueherer Checkout wird nicht wiederverwendet');
  }

  let root;

  try {
    root = mkdtempSync(join(parent, 'abnahme-'));
    mkdirSync(join(root, 'home'), { mode: 0o700 });
    mkdirSync(join(root, 'home', 'xdg'), { mode: 0o700 });
    writeFileSync(join(root, 'home', 'leer.gitconfig'), '', { flag: 'wx', mode: 0o600 });
    mkdirSync(join(root, 'vorlage'), { mode: 0o700 });
    mkdirSync(join(root, 'hooks'), { mode: 0o700 });
  } catch {
    fail('abnahme-pruefordner', 'Sitzungsordner kann nicht angelegt werden');
  }

  const real = exactDir(root, 'abnahme-pruefordner', 'Sitzungsordner');

  if (pathKey(dirname(real)) !== pathKey(parent) || overlaps(real, trusted)) {
    fail('abnahme-pruefordner', 'Sitzungsordner hat sich beim Anlegen veraendert');
  }

  const home = join(real, 'home');
  return Object.freeze({
    root: real,
    home,
    template: join(real, 'vorlage'),
    hooks: join(real, 'hooks'),
    checkout: join(real, 'checkout'),
    env: controlledEnv(system, home),
  });
}

// Die eigene leere Umgebung muss leer geblieben sein.
function checkSession(session) {
  const empty = [[session.template, 'Vorlage'], [session.hooks, 'Hook-Ordner'], [join(session.home, 'xdg'), 'XDG-Ordner']];

  for (const [dir, label] of empty) {
    const stat = lstatOrNull(dir);

    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || listDir(dir, 'abnahme-sitzung').length !== 0) {
      fail('abnahme-sitzung', `${label} der Sitzung ist nicht mehr leer`);
    }
  }

  const config = lstatOrNull(session.env.GIT_CONFIG_GLOBAL);

  if (!config || config.isSymbolicLink() || !config.isFile() || config.size !== 0 || config.nlink !== 1) {
    fail('abnahme-sitzung', 'globale Git-Konfiguration der Sitzung ist nicht mehr leer');
  }

  if (listDir(session.home, 'abnahme-sitzung').join('/') !== 'leer.gitconfig/xdg') {
    fail('abnahme-sitzung', 'HOME der Sitzung enthaelt unerwartete Eintraege');
  }
}

// ---------------------------------------------------------------------------
// Struktur von .git und Konfiguration
// ---------------------------------------------------------------------------

// Rekursiv, nur lstat und readdir: keine Symlinks, keine harten Links, keine Sonderdateien.
function walkGitTree(dir) {
  for (const name of listDir(dir, 'abnahme-git-struktur')) {
    const abs = join(dir, name);
    const stat = lstatOrNull(abs);

    if (!stat || stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
      fail('abnahme-git-struktur', '.git enthaelt einen Symlink, einen harten Link oder eine Sonderdatei');
    }

    if (stat.isDirectory()) {
      walkGitTree(abs);
    }
  }
}

// Prueft .git des eigenen Checkouts. Ergebnis: der Zweig, auf den HEAD nach dem Klonen zeigt, oder
// null. withIndex: nach dem Auschecken muss index vorhanden sein, vorher darf er fehlen.
function checkGitDir(session, withIndex) {
  const repo = exactDir(session.checkout, 'abnahme-git-struktur', 'Pruef-Checkout');
  const gitDir = join(repo, '.git');
  const stat = lstatOrNull(gitDir);

  // PRUEFUNG-ISOLATION: eigenstaendiges .git-Verzeichnis, keine Verweisdatei, kein Symlink.
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('abnahme-git-struktur', '.git ist kein eigenstaendiges Verzeichnis');
  }

  const top = listDir(gitDir, 'abnahme-git-struktur');

  if (
    !top.every(name => GIT_TOP_ALLOWED.includes(name)) ||
    !GIT_TOP_REQUIRED.every(name => top.includes(name)) ||
    top.includes('index') !== withIndex
  ) {
    fail('abnahme-git-struktur', '.git enthaelt unerwartete Eintraege (etwa Hooks, commondir, Worktrees oder info)');
  }

  // PRUEFUNG-ALTERNATES: keine fremden Objektverzeichnisse, nur Packs und lose Objekte.
  const objects = join(gitDir, 'objects');

  for (const name of listDir(objects, 'abnahme-git-struktur')) {
    if (name === 'info') {
      if (listDir(join(objects, 'info'), 'abnahme-git-struktur').length !== 0) {
        fail('abnahme-git-struktur', 'objects/info ist nicht leer (Alternates oder fremde Objektverweise)');
      }
    } else if (name === 'pack') {
      if (!listDir(join(objects, 'pack'), 'abnahme-git-struktur').every(file => PACK_FILE_RE.test(file))) {
        fail('abnahme-git-struktur', 'objects/pack enthaelt unerwartete Dateien');
      }
    } else if (!/^[0-9a-f]{2}$/.test(name) || !listDir(join(objects, name), 'abnahme-git-struktur').every(file => /^[0-9a-f]{38}$/.test(file))) {
      fail('abnahme-git-struktur', 'objects enthaelt unerwartete Eintraege');
    }
  }

  for (const name of top) {
    const entry = lstatOrNull(join(gitDir, name));
    const mustBeDir = name === 'logs' || name === 'objects' || name === 'refs';

    if (!entry || entry.isDirectory() !== mustBeDir) {
      fail('abnahme-git-struktur', `.git/${name} hat den falschen Typ`);
    }
  }

  walkGitTree(gitDir);

  let head;

  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8');
  } catch {
    fail('abnahme-git-head', 'HEAD kann nicht gelesen werden');
  }

  const branch = /^ref: refs\/heads\/(.+)\n$/.exec(head)?.[1] ?? null;

  if (branch !== null ? !BRANCH_RE.test(branch) : !/^[0-9a-f]{40}\n$/.test(head)) {
    fail('abnahme-git-head', 'HEAD hat ein unerwartetes Format');
  }

  return { repo, head, branch };
}

// PRUEFUNG-KONFIGURATION: strikte Positivliste konkreter Schluessel mit konkreten Werten, keine
// Wildcards. Jeder Eintrag muss aus der lokalen Konfiguration des Klons stammen.
function expectedConfig(trusted, branch) {
  const entries = [
    ['core.repositoryformatversion', '0'],
    ['core.filemode', IS_WINDOWS ? 'false' : 'true'],
    ['core.bare', 'false'],
    ['core.logallrefupdates', 'true'],
  ];

  if (IS_WINDOWS) {
    entries.push(['core.symlinks', 'false'], ['core.ignorecase', 'true']);
  }

  entries.push(['remote.origin.url', trusted], ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);

  if (branch !== null) {
    entries.push([`branch.${branch}.remote`, 'origin'], [`branch.${branch}.merge`, `refs/heads/${branch}`]);
  }

  return new Map(entries);
}

function checkGitConfig(session, repo, trusted, branch) {
  // Bewusst ohne -c: die Liste soll nur zeigen, was tatsaechlich konfiguriert ist.
  const output = execGit(repo, session.env, ['--no-replace-objects', 'config', '--list', '--show-scope', '-z'], 'abnahme-git-config');
  const parts = output.split('\0');

  if (parts.pop() !== '' || parts.length % 2 !== 0) {
    fail('abnahme-git-config', 'Git-Konfiguration ist nicht lesbar');
  }

  const expected = expectedConfig(trusted, branch);
  const seen = new Set();

  for (let index = 0; index < parts.length; index += 2) {
    const scope = parts[index];
    const entry = parts[index + 1];
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? null : entry.slice(newline + 1);

    if (scope !== 'local' || !expected.has(key) || expected.get(key) !== value || seen.has(key)) {
      fail('abnahme-git-config', 'Git-Konfiguration enthaelt einen nicht erlaubten Schluessel, Wert oder eine fremde Quelle');
    }

    seen.add(key);
  }

  if (seen.size !== expected.size) {
    fail('abnahme-git-config', 'Git-Konfiguration ist unvollstaendig');
  }
}

// Struktur und Konfiguration zusammen, vor jedem weiteren Git-Befehl im Klon.
function checkIsolation(session, trusted, withIndex, branch) {
  checkSession(session);
  const state = checkGitDir(session, withIndex);
  checkGitConfig(session, state.repo, trusted, branch === undefined ? state.branch : branch);
  return state;
}

// ---------------------------------------------------------------------------
// Baum, Index, Status und Arbeitsbaum des eigenen Checkouts
// ---------------------------------------------------------------------------

// Nur gewoehnliche Blobs, keine .git-Bestandteile, eindeutig ohne Beachtung der Schreibweise.
function checkTreeModes(tree) {
  const seen = new Map();

  for (const [path, entry] of tree) {
    if (entry.mode !== '100644' || entry.type !== 'blob') {
      fail('abnahme-git-baum', `${path} ist keine gewoehnliche Datei (Modus ${entry.mode})`);
    }

    const parts = path.split('/');

    if (parts.some(part => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      fail('abnahme-git-baum', `${path} ist als Pfad nicht erlaubt`);
    }

    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('/');

      if (seen.has(prefix.toLowerCase()) && seen.get(prefix.toLowerCase()) !== prefix) {
        fail('abnahme-git-baum', `${prefix} unterscheidet sich von einem anderen Pfad nur in der Schreibweise`);
      }

      seen.set(prefix.toLowerCase(), prefix);
    }
  }
}

function checkHead(session, repo, head, baseSha) {
  if (head !== `${baseSha}\n` || guardedGit(session, repo, ['rev-parse', '--verify', 'HEAD^{commit}'], 'abnahme-git-head').trim() !== baseSha) {
    fail('abnahme-git-head', 'HEAD steht nicht auf dem gebundenen Ausgangscommit');
  }
}

// Der Index muss genau dem Baum von base_sha entsprechen: keine gestagte Aenderung, kein anderer Modus.
function checkIndex(session, repo, tree) {
  const lines = guardedGit(session, repo, ['ls-files', '--stage', '-z'], 'abnahme-git-index').split('\0').filter(Boolean);

  if (lines.length !== tree.size) {
    fail('abnahme-git-index', 'Git-Index weicht vom Ausgangscommit ab');
  }

  for (const line of lines) {
    const match = INDEX_LINE_RE.exec(line);

    if (!match || match[1] !== '100644' || match[3] !== '0' || tree.get(match[4])?.oid !== match[2]) {
      fail('abnahme-git-index', 'Git-Index weicht vom Ausgangscommit ab');
    }
  }
}

// Nach dem Import: genau die freigegebenen Dateien als ungestagte Aenderung, sonst nichts, auch keine
// ungetrackten oder ignorierten Dateien. Vor dem Import: gar keine Aenderung.
function checkStatus(session, repo, changed) {
  const expected = changed.map(path => ` M ${path}\0`).join('');

  if (guardedGit(session, repo, STATUS_ARGS, 'abnahme-git-status') !== expected) {
    fail('abnahme-git-status', 'Git-Status weicht von den freigegebenen Aenderungen ab');
  }

  if (guardedGit(session, repo, ['diff', '--summary', '--no-ext-diff'], 'abnahme-code-modus').trim() !== '') {
    fail('abnahme-code-modus', 'Dateimodus oder Dateityp wurde veraendert');
  }
}

// Liest den Arbeitsbaum ohne Git. Genau die Dateien und Ordner des Baums, nur gewoehnliche Dateien
// mit genau einem Link, ohne Ausfuehrungsrecht. Ergebnis: Pfad zu Bytes.
function readWorktree(repo, tree) {
  const files = new Map();
  const dirs = new Set();

  const visit = (abs, rel) => {
    for (const name of listDir(abs, 'abnahme-code-datei')) {
      if (rel === '' && name === '.git') {
        continue;
      }

      if (name.toLowerCase() === '.git') {
        fail('abnahme-code-datei', '.git im Arbeitsbaum gefunden');
      }

      const childAbs = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const stat = lstatOrNull(childAbs);

      if (!stat || stat.isSymbolicLink()) {
        fail('abnahme-code-datei', `${childRel} ist ein Symlink oder nicht lesbar`);
      }

      if (stat.isDirectory()) {
        dirs.add(childRel);
        visit(childAbs, childRel);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) {
          fail('abnahme-code-datei', `${childRel} hat mehrere harte Links`);
        }

        if (!IS_WINDOWS && (stat.mode & 0o7111) !== 0) {
          fail('abnahme-code-modus', `${childRel} ist ausfuehrbar oder traegt Sonderrechte`);
        }

        files.set(childRel, { abs: childAbs, size: stat.size });
      } else {
        fail('abnahme-code-datei', `${childRel} ist keine gewoehnliche Datei`);
      }
    }
  };

  visit(repo, '');
  const expectedDirs = new Set();

  for (const path of tree.keys()) {
    const parts = path.split('/');

    for (let depth = 1; depth < parts.length; depth += 1) {
      expectedDirs.add(parts.slice(0, depth).join('/'));
    }
  }

  const sameSet = (a, b) => a.size === b.size && [...a].every(item => b.has(item));

  if (!sameSet(new Set(files.keys()), new Set(tree.keys())) || !sameSet(dirs, expectedDirs)) {
    fail('abnahme-code-datei', 'Dateien oder Ordner im Pruef-Checkout weichen ab');
  }

  const bytes = new Map();

  for (const [path, info] of files) {
    let data;

    try {
      data = readFileSync(info.abs);
    } catch {
      fail('abnahme-code-datei', `${path} kann nicht gelesen werden`);
    }

    if (data.length !== info.size) {
      fail('abnahme-code-datei', `${path} hat sich waehrend der Pruefung veraendert`);
    }

    bytes.set(path, data);
  }

  return bytes;
}

// PRUEFUNG-CODE-BLOB: Jede freigegebene Datei traegt genau die Blob-ID des geprueften Pakets, jede
// andere Datei genau die Blob-ID des Ausgangscommits.
function checkCodeFiles(bytes, tree, parsed) {
  const changed = new Map(parsed.dateien.map(meta => [meta.pfad, meta]));

  for (const [path, data] of bytes) {
    const meta = changed.get(path);

    if (meta !== undefined) {
      if (data.length !== meta.bytes || gitBlobId(data) !== meta.git_blob) {
        fail('abnahme-code-blob', `${path} weicht vom geprueften Paket ab`);
      }
    } else if (gitBlobId(data) !== tree.get(path).oid) {
      fail('abnahme-fremde-aenderung', `${path} weicht vom Ausgangscommit ab`);
    }
  }
}

// ---------------------------------------------------------------------------
// Abnahmedatei
// ---------------------------------------------------------------------------

// Die Abnahmedatei stammt nur aus order.abnahme_pfad, gehoert zum Baum von base_sha, ist eine
// gewoehnliche Datei ohne Symlink in der Kette, und ihre tatsaechlichen Bytes tragen genau den
// SHA-256 und die Blob-ID des Auftrags. Ergebnis: absoluter Pfad und die gebundenen Bytes.
function bindAcceptanceFile(repo, order, tree) {
  const pfad = order.abnahme_pfad;

  if (typeof pfad !== 'string' || !/^agent-acceptance\/issue-[1-9][0-9]*\.mjs$/.test(pfad) || order.dateien.includes(pfad)) {
    fail('abnahme-datei', 'Abnahmepfad ist nicht der gebundene Pfad des Auftrags');
  }

  bindAcceptanceFileInTree(order, tree);
  let current = repo;
  const parts = pfad.split('/');
  let stat;

  for (let depth = 0; depth < parts.length; depth += 1) {
    current = join(current, parts[depth]);
    stat = lstatOrNull(current);
    const last = depth === parts.length - 1;

    if (!stat || stat.isSymbolicLink() || (last ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
      fail('abnahme-datei', 'Abnahmedatei fehlt, ist ein Symlink oder keine gewoehnliche Datei');
    }
  }

  let bytes;

  try {
    bytes = readFileSync(current);
  } catch {
    fail('abnahme-datei', 'Abnahmedatei kann nicht gelesen werden');
  }

  // PRUEFUNG-ABNAHME-BLOB
  if (gitBlobId(bytes) !== order.abnahme_blob) {
    fail('abnahme-datei-blob', 'Git-Blob der Abnahmedatei weicht vom Auftrag ab');
  }

  if (bytes.length !== stat.size || sha256(bytes) !== order.abnahme_sha256) {
    fail('abnahme-datei-hash', 'SHA-256 der Abnahmedatei weicht vom Auftrag ab');
  }

  return { file: current, bytes };
}

// PRUEFUNG-FORMAT-V2: Kennung ausschliesslich aus den gebundenen Originalbytes, vor dem Start.
function requireFormatV2(bytes) {
  if (bytes.length < FORMAT_BYTES.length || !bytes.subarray(0, FORMAT_BYTES.length).equals(FORMAT_BYTES)) {
    fail('abnahme-format', 'Abnahmedatei traegt nicht die Kennung des Abnahmeformats v2 (Altformat wird nicht gestartet)');
  }
}

// ---------------------------------------------------------------------------
// Abnahmeprozess
// ---------------------------------------------------------------------------

function processEnv(system) {
  // PRUEFUNG-UMGEBUNG: unter Linux leer, unter Windows nur SystemRoot.
  return IS_WINDOWS && typeof system.SystemRoot === 'string' ? { SystemRoot: system.SystemRoot } : {};
}

function runAcceptance(file, repo, system) {
  const node = process.execPath;

  if (typeof node !== 'string' || !isAbsolute(node)) {
    fail('abnahme-prozess-fehler', 'Pfad von Node.js ist nicht absolut');
  }

  const out = spawnSync(node, [file], {
    cwd: repo,
    env: processEnv(system),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    timeout: ACCEPTANCE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: ACCEPTANCE_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    windowsHide: true,
  });
  const stdout = typeof out.stdout === 'string' ? out.stdout : '';
  const stderr = typeof out.stderr === 'string' ? out.stderr : '';
  const bericht = {
    status: out.status ?? null,
    signal: out.signal ?? null,
    fehler: out.error === undefined ? null : String(out.error?.code ?? 'unbekannt'),
    stdout_zeichen: stdout.length,
    stderr_zeichen: stderr.length,
    stderr_anfang: stderr.slice(0, 500),
  };

  // PRUEFUNG-PROZESSFEHLER: auch bei status 0 und signal null (Enkelprozess haelt die Pipe offen).
  if (out.error !== undefined) {
    fail('abnahme-prozess-fehler', `Abnahmeprozess fehlgeschlagen (${bericht.fehler})`, bericht);
  }

  if (out.signal !== null) {
    fail('abnahme-signal', 'Abnahmeprozess wurde durch ein Signal beendet', bericht);
  }

  if (out.status !== 0) {
    fail('abnahme-exitcode', 'Abnahmeprozess endete nicht mit Exitcode 0', bericht);
  }

  if (out.stderr !== '') {
    fail('abnahme-stderr', 'Abnahmeprozess hat auf stderr geschrieben', bericht);
  }

  // PRUEFUNG-AUSGABE: genau die feste Erfolgsausgabe, nichts davor und nichts danach.
  if (out.stdout !== ACCEPTANCE_SUCCESS) {
    fail('abnahme-ausgabe', 'Abnahmeprozess hat nicht genau die Erfolgsausgabe geliefert', bericht);
  }
}

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------

const ACCEPTED = new WeakSet();

function checkTrustedRoot(trustedRoot, order, session) {
  const trusted = exactDir(trustedRoot, 'abnahme-quelle', 'vertrauenswuerdiger Checkout');
  const { git } = openRepository(trusted, order.base_sha, session.env);

  if (execGit(trusted, git.env, ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${session.hooks}`, 'rev-parse', '--verify', 'HEAD^{commit}'], 'abnahme-quelle-head').trim() !== order.base_sha) {
    fail('abnahme-quelle-head', 'vertrauenswuerdiger Checkout steht nicht auf dem Ausgangscommit');
  }

  return trusted;
}

// input: { trustedRoot, checkParent, order, expectedSha256, packageBytes, packageSha256, gitEnv },
// genau diese Felder. trustedRoot: vertrauenswuerdiger Checkout auf order.base_sha (Quelle des
// Klons, wird nur gelesen). checkParent: leeres, eigenes Verzeichnis fuer genau diesen einen Lauf.
// order aus resolveOrder im selben Prozess, expectedSha256 sein voller SHA-256. packageBytes und
// packageSha256: die empfangenen Paketbytes und ihr getrennt uebergebener Hash. gitEnv: isolierte
// Git-Umgebung wie fuer resolveOrder. Ergebnis: tief eingefrorener Abnahmenachweis. Jeder Fehler wirft.
export function acceptOrderPackage(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, INPUT_KEYS)) {
    fail('abnahme-eingabe', `Eingabe braucht genau ${INPUT_KEYS.join(', ')}`);
  }

  const fields = Object.fromEntries(INPUT_KEYS.map(key => [key, own(input, key)]));
  const { order, expectedSha256 } = fields;

  // 1. und 2.: Auftrag und Paketbytes.
  sameOrder(order, expectedSha256);
  const parsed = parsePackageV2(order, expectedSha256, fields.packageBytes, fields.packageSha256);

  // 3. bis 5.: Umgebung, Quelle, Sitzung. Die Quelle wird mit der eigenen Umgebung geprueft; dafuer
  // entsteht die Sitzung vorher, ihr Pruefordner wird gegen die kanonische Quelle geprueft.
  const system = readCallerEnv(fields.gitEnv);
  const trustedGuess = exactDir(fields.trustedRoot, 'abnahme-quelle', 'vertrauenswuerdiger Checkout');
  const session = createSession(fields.checkParent, trustedGuess, system);
  const trusted = checkTrustedRoot(trustedGuess, order, session);

  // 6.: eigener Klon.
  guardedGit(session, session.root, [
    'clone', '--no-local', '--no-hardlinks', '--no-checkout', '--quiet', `--template=${session.template}`, '--', trusted, session.checkout,
  ], 'abnahme-klon');

  // 7.: vor jedem weiteren Git-Befehl im Klon.
  const cloned = checkIsolation(session, trusted, false);
  const branch = cloned.branch;

  // 8.: Baum pruefen, auschecken, alles erneut kontrollieren.
  const { tree } = openRepository(cloned.repo, order.base_sha, session.env);
  checkTreeModes(tree);
  bindAcceptanceFileInTree(order, tree);
  guardedGit(session, cloned.repo, ['checkout', '--quiet', '--detach', order.base_sha], 'abnahme-checkout');
  const checkedOut = checkIsolation(session, trusted, true, branch);
  checkHead(session, checkedOut.repo, checkedOut.head, order.base_sha);
  checkIndex(session, checkedOut.repo, tree);
  checkStatus(session, checkedOut.repo, []);
  readWorktree(checkedOut.repo, tree).forEach((data, path) => {
    if (gitBlobId(data) !== tree.get(path).oid) {
      fail('abnahme-fremde-aenderung', `${path} weicht nach dem Auschecken vom Ausgangscommit ab`);
    }
  });

  // 9.: Paket nur im eigenen Checkout anwenden.
  applyPackageV2(checkedOut.repo, order, expectedSha256, parsed, { gitEnv: { ...session.env } });

  // 10.: unmittelbar vor der Abnahme.
  const ready = checkIsolation(session, trusted, true, branch);
  checkHead(session, ready.repo, ready.head, order.base_sha);
  checkIndex(session, ready.repo, tree);
  const acceptance = bindAcceptanceFile(ready.repo, order, tree);
  requireFormatV2(acceptance.bytes);
  checkStatus(session, ready.repo, parsed.dateien.map(meta => meta.pfad));
  const bytes = readWorktree(ready.repo, tree);
  checkCodeFiles(bytes, tree, parsed);

  // 11.: Abnahmetreiber in eigenem Prozess.
  runAcceptance(acceptance.file, ready.repo, system);

  // 12.: Nachweis.
  const nachweis = deepFreeze({
    auftrag_sha256: expectedSha256,
    paket_sha256: parsed.paket_sha256,
    base_sha: order.base_sha,
    abnahme_pfad: order.abnahme_pfad,
    abnahme_blob: order.abnahme_blob,
    abnahme_sha256: order.abnahme_sha256,
    dateien: parsed.dateien.map(meta => ({ pfad: meta.pfad, git_blob: meta.git_blob })),
    ergebnis: 'bestanden',
  });
  ACCEPTED.add(nachweis);
  return nachweis;
}

function bindAcceptanceFileInTree(order, tree) {
  const entry = tree.get(order.abnahme_pfad);

  if (!entry || entry.mode !== '100644' || entry.oid !== order.abnahme_blob) {
    fail('abnahme-datei-blob', 'Abnahmedatei gehoert nicht mit dieser Blob-ID zum Ausgangscommit');
  }
}

// Akzeptiert nur einen Nachweis, den acceptOrderPackage in diesem Prozess erzeugt hat, und nur fuer
// genau den Auftrag, fuer den er erzeugt wurde. Ein frei gebautes oder kopiertes Objekt faellt durch.
export function requireAccepted(nachweis, order, expectedSha256) {
  if (!ACCEPTED.has(nachweis)) {
    fail('abnahme-ungeprueft', 'Abnahmenachweis stammt nicht aus acceptOrderPackage');
  }

  sameOrder(order, expectedSha256);

  if (nachweis.auftrag_sha256 !== expectedSha256 || nachweis.base_sha !== order.base_sha || nachweis.abnahme_blob !== order.abnahme_blob) {
    fail('abnahme-bindung', 'Abnahmenachweis gehoert zu einem anderen Auftrag');
  }

  return nachweis;
}
