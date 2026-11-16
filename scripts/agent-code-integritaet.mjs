// A6.4-2d: Integritaetspruefer fuer alle Skripte unter scripts/.
//
// Prueft die tatsaechlichen Rohbytes jeder Datei in scripts/ gegen die vollstaendige Hashliste
// skript_hashes der produktiven Policy .github/agent/policy.json. Ohne Wirkung: Kein Workflow ruft
// diese Datei auf, und die produktive Policy gibt es noch nicht (A6.4-3). Fehlt sie, bricht der
// Pruefer ab; das ist auf main das erwartete Verhalten.
//
// Eigenstaendig: nur node:crypto, node:fs und node:path. Kein lokales Modul, auch nicht das Profilmodul. Bei ESM laufen statische
// Importe vor dem eigenen Code; ein lokaler Import wuerde also Code starten, dessen Hash noch nicht
// geprueft ist. Kein Prozessstart, kein Netz, kein Git, keine Shell, keine Prozessumgebung, keine
// Argumente, kein Schreibzugriff.
//
// Vertrauensgrenzen, die dieser Pruefer selbst NICHT belegen kann:
// 1. Wurzel ist ausschliesslich process.cwd(). Dass dieses Arbeitsverzeichnis ein frischer,
//    vertrauenswuerdiger Checkout auf dem erwarteten Commit ist, muss der geschuetzte Workflow
//    sicherstellen (A6.4-4). Ebenso die bereinigte Umgebung vor dem Start von Node (S4).
// 2. Keine Selbstbeglaubigung: Der Pruefer steht selbst in der Hashliste, das ist nur eine
//    Konsistenzpruefung. Vertrauenswurzel ist ein fest genehmigter SHA-256 dieser Datei im
//    geschuetzten Workflow, der vor dem Start mit den tatsaechlichen Bytes verglichen wird. Dieser
//    aeussere Hash stammt nie aus der Policy desselben Checkouts (A6.4-4).
// 3. Stimmen Skript und Policy desselben Checkouts ueberein, beweist das keine Autorisierung. Wer
//    beide zugleich aendert, besteht diese Pruefung. Abgewehrt wird das erst durch die geschuetzte
//    Policy (A6.4-3) und den aeusseren Anker (A6.4-4).
// 4. Zeitfenster: Eine Datei kann nach der Pruefung und vor dem spaeteren Import noch geaendert
//    werden. Das verhindern erst Prozess- und Dateisystemisolation (S1, A6.4-4).
//
// Erfolg: Exitcode 0, keine Ausgabe. Fehler: genau eine feste Zeile A6-FEHLER integritaet-<code>
// auf stderr und Exitcode 1. Keine Pfade, Inhalte oder Policydaten in der Meldung.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

const POLICY_SCHEMA = 'agent-policy-v1';

// Genau die Felder der Policy, wie das Profilmodul sie verlangt. Der Test vergleicht beide Listen.
const POLICY_KEYS = Object.freeze([
  'schema',
  'modelle',
  'claude_werkzeuge',
  'max_budget_usd',
  'max_runden',
  'max_laufzeit_minuten',
  'max_dateien',
  'max_auftrag_rahmen_zeichen',
  'max_issue_titel_zeichen',
  'max_issue_text_zeichen',
  'gesperrte_praefixe',
  'gesperrte_dateien',
  'reservierte_ids',
  'pr_titel_praefixe',
  'skript_hashes',
]);

const SCRIPTS_DIR = 'scripts';
const POLICY_DIRS = Object.freeze(['.github', join('.github', 'agent')]);
const POLICY_FILE = join('.github', 'agent', 'policy.json');
const SELF_PATH = 'scripts/agent-code-integritaet.mjs';

export const SKRIPT_PFAD_RE = /^scripts\/agent-[a-z0-9]+(?:-[a-z0-9]+)*\.mjs$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

export const MAX_POLICY_BYTES = 16384;
export const MAX_SKRIPT_BYTES = 262144;
export const MAX_SKRIPTE = 64;

// O_NOFOLLOW gibt es unter Windows nicht; dort tragen lstat und der Vergleich von Geraet und Inode.
// O_NONBLOCK verhindert, dass ein unterschobenes FIFO das Oeffnen blockiert.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

class IntegritaetFehler extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function abbruch(code) {
  throw new IntegritaetFehler(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function ordner(pfad, code, fehltCode) {
  let stat;

  try {
    stat = lstatSync(pfad, { bigint: true });
  } catch (error) {
    abbruch(error?.code === 'ENOENT' ? fehltCode : code);
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    abbruch(code);
  }
}

// Liest eine gewoehnliche Datei vollstaendig als Rohbytes. Kein Symlink, kein Hardlink, keine
// Aenderung waehrend des Lesens. Der Inhalt wird nicht veraendert, auch nicht die Zeilenenden.
function leseDatei(pfad, maxBytes, code) {
  let vorher;

  try {
    vorher = lstatSync(pfad, { bigint: true });
  } catch (error) {
    abbruch(error?.code === 'ENOENT' ? `${code}-fehlt` : `${code}-datei`);
  }

  if (!vorher.isFile()) {
    abbruch(`${code}-datei`);
  }

  let fd;

  try {
    fd = openSync(pfad, OPEN_FLAGS);
  } catch {
    abbruch(`${code}-datei`);
  }

  try {
    const offen = fstatSync(fd, { bigint: true });

    if (!offen.isFile() || offen.dev !== vorher.dev || offen.ino !== vorher.ino) {
      abbruch(`${code}-datei`);
    }

    if (offen.nlink !== 1n) {
      abbruch(`${code}-link`);
    }

    if (offen.size !== vorher.size || offen.size > BigInt(maxBytes)) {
      abbruch(`${code}-groesse`);
    }

    const size = Number(offen.size);
    // Ein Byte mehr als erwartet anfordern: kommt es an, ist die Datei waehrend des Lesens gewachsen.
    const buffer = Buffer.alloc(size + 1);
    let gelesen = 0;

    while (gelesen < buffer.length) {
      const anzahl = readSync(fd, buffer, gelesen, buffer.length - gelesen, gelesen);

      if (anzahl === 0) {
        break;
      }

      gelesen += anzahl;
    }

    const nachher = fstatSync(fd, { bigint: true });

    if (gelesen !== size || nachher.size !== offen.size) {
      abbruch(`${code}-veraendert`);
    }

    return buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

// Policy nur in genau einer Schreibweise, wie parseStrictJson im Profilmodul: nicht leer,
// kein BOM, gueltiges UTF-8, kein Wagenruecklauf, keine NUL, kanonisch mit zwei Leerzeichen und
// abschliessendem Zeilenumbruch. Damit sind doppelte Schluessel und andere Schreibweisen
// ausgeschlossen. Die uebrigen Fachregeln von validatePolicy() ersetzt diese Pruefung nicht.
function lesePolicy(wurzel) {
  for (const pfad of POLICY_DIRS) {
    ordner(join(wurzel, pfad), 'policy-ordner', 'policy-fehlt');
  }

  const bytes = leseDatei(join(wurzel, POLICY_FILE), MAX_POLICY_BYTES, 'policy');

  if (bytes.length === 0) {
    abbruch('policy-leer');
  }

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    abbruch('policy-bom');
  }

  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    abbruch('policy-utf8');
  }

  if (text.includes('\r') || text.includes('\u0000')) {
    abbruch('policy-zeichen');
  }

  let policy;

  try {
    policy = JSON.parse(text);

    if (JSON.stringify(policy, null, 2) + '\n' !== text) {
      abbruch('policy-kanonisch');
    }
  } catch (error) {
    if (error instanceof IntegritaetFehler) {
      throw error;
    }

    abbruch('policy-json');
  }

  if (
    !isPlainObject(policy) ||
    Object.keys(policy).length !== POLICY_KEYS.length ||
    !POLICY_KEYS.every(key => Object.hasOwn(policy, key)) ||
    policy.schema !== POLICY_SCHEMA
  ) {
    abbruch('policy-schema');
  }

  const hashes = policy.skript_hashes;

  if (!isPlainObject(hashes)) {
    abbruch('policy-hashes');
  }

  const eintraege = Object.entries(hashes);

  if (
    eintraege.length === 0 ||
    eintraege.length > MAX_SKRIPTE ||
    !eintraege.every(([pfad, hash]) => SKRIPT_PFAD_RE.test(pfad) && typeof hash === 'string' && HEX64_RE.test(hash))
  ) {
    abbruch('policy-hashes');
  }

  if (!Object.hasOwn(hashes, SELF_PATH)) {
    abbruch('policy-selbst');
  }

  return hashes;
}

// Vollstaendiges Inventar von scripts/: nur gewoehnliche Dateien mit erlaubtem Namen, nichts sonst.
function inventar(wurzel) {
  ordner(join(wurzel, SCRIPTS_DIR), 'skripte-ordner', 'skripte-ordner');
  let namen;

  try {
    namen = readdirSync(join(wurzel, SCRIPTS_DIR));
  } catch {
    abbruch('skripte-ordner');
  }

  if (namen.length === 0 || namen.length > MAX_SKRIPTE) {
    abbruch('skripte-anzahl');
  }

  const pfade = [];

  for (const name of namen) {
    const pfad = `${SCRIPTS_DIR}/${name}`;

    if (!SKRIPT_PFAD_RE.test(pfad)) {
      abbruch('skript-name');
    }

    let stat;

    try {
      stat = lstatSync(join(wurzel, SCRIPTS_DIR, name), { bigint: true });
    } catch {
      abbruch('skript-eintrag');
    }

    // Unterordner, Symlinks, FIFOs, Sockets und Geraete scheiden hier aus, bevor etwas geoeffnet wird.
    if (!stat.isFile()) {
      abbruch('skript-eintrag');
    }

    pfade.push(pfad);
  }

  return pfade.sort();
}

// Wurzel ist ausschliesslich das Arbeitsverzeichnis, einmal zu Beginn festgehalten. Kein Argument,
// keine Umgebungsvariable, kein anderer Pfad.
export function pruefeIntegritaet() {
  const wurzel = process.cwd();
  const hashes = lesePolicy(wurzel);
  const pfade = inventar(wurzel);
  const vorhanden = new Set(pfade);

  // Mengen exakt gleich: jede Datei hat genau einen Hash, jeder Hash genau eine Datei.
  for (const pfad of pfade) {
    if (!Object.hasOwn(hashes, pfad)) {
      abbruch('skript-ohne-hash');
    }
  }

  for (const pfad of Object.keys(hashes)) {
    if (!vorhanden.has(pfad)) {
      abbruch('hash-ohne-skript');
    }
  }

  if (vorhanden.size !== Object.keys(hashes).length) {
    abbruch('skript-menge');
  }

  for (const pfad of pfade) {
    const bytes = leseDatei(join(wurzel, SCRIPTS_DIR, pfad.slice(SCRIPTS_DIR.length + 1)), MAX_SKRIPT_BYTES, 'skript');

    if (createHash('sha256').update(bytes).digest('hex') !== hashes[pfad]) {
      abbruch('skript-hash');
    }
  }
}

function fehlerZeile(error) {
  const code = error instanceof IntegritaetFehler && /^[a-z0-9-]+$/.test(error.code) ? error.code : 'unerwartet';
  return `A6-FEHLER integritaet-${code}\n`;
}

// Liefert den Exitcode. Wirft nie; jeder Fehler wird zu genau einer festen Zeile auf stderr.
export function main() {
  try {
    pruefeIntegritaet();
    return 0;
  } catch (error) {
    process.stderr.write(fehlerZeile(error));
    return 1;
  }
}

// Ohne import.meta.main (Node vor 22.18.0 und 24.2.0) laesst sich Start und Import nicht
// unterscheiden. Dann wird nie geprueft und nie mit 0 geendet, sondern kontrolliert abgebrochen.
if (import.meta.main === true) {
  process.exitCode = main();
} else if (import.meta.main !== false) {
  process.stderr.write(fehlerZeile(new IntegritaetFehler('umgebung-fehlt')));
  process.exitCode = 1;
}
