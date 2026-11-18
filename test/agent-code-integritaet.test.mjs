// A6.4-2d: Tests fuer scripts/agent-code-integritaet.mjs.
// Rein lokal: keine Netzwerkanfragen, keine GitHub-Zugriffe, keine Zugangsdaten, kein Agentenstart.
// Der echte Pruefer laeuft als CLI in synthetischen Repositorybaeumen unter dem Temp-Ordner. Die Policy
// dort ist synthetisch und liegt nur im Testbaum; das echte Repository bleibt unveraendert.
//
// Was diese Tests NICHT belegen koennen (Vertrauensgrenzen, A6.4-3 und A6.4-4):
// - dass process.cwd() ein frischer, vertrauenswuerdiger Checkout auf dem erwarteten Commit ist;
// - dass die Policy autorisiert ist: Werden Skript und Policy gemeinsam geaendert, besteht der Pruefer
//   (Fall B unten). Abgewehrt wird das erst durch die geschuetzte Policy und den aeusseren Anker;
// - dass eine Datei nach der Pruefung bis zum spaeteren Import unveraendert bleibt (Zeitfenster, S1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fsModul from 'node:fs';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXIT_NACH_IMPORT = process.exitCode;
const integritaet = await import('../scripts/agent-code-integritaet.mjs');
const EXIT_NACH_PRUEFER_IMPORT = process.exitCode;
import { POLICY_KEYS, loadPolicy } from '../scripts/agent-profile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRUEFER = 'agent-code-integritaet.mjs';
const PRUEFER_PFAD = join(ROOT, 'scripts', PRUEFER);
const SOURCE = readFileSync(PRUEFER_PFAD, 'utf8');
const FIXTURE_PFAD = join(ROOT, 'test', 'fixtures', 'agent-skript-hashes.json');
const FIXTURE_BYTES = readFileSync(FIXTURE_PFAD);
const FIXTURE = JSON.parse(FIXTURE_BYTES.toString('utf8'));
const POLICY_ENTWURF = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'agent-policy.entwurf.json'), 'utf8'));
const SETTINGS_ENTWURF_BYTES = readFileSync(join(ROOT, 'test', 'fixtures', 'claude-settings.entwurf.json'));
// A6.4-3a: SHA-256 der freigegebenen produktiven Policy (Pruefpunkt B des Eigentuemer-PR).
// Stand nach dem Tokenformat-Fix: nur die Hashes von Transport- und Paketmodul sind neu.
const POLICY_SHA256 = '48f06180f146e2ffe81889c92fa2fdf6f8f8fe9104c78cc1a28f7b7a7009ea2d';

const IST_WINDOWS = process.platform === 'win32';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canon = value => JSON.stringify(value, null, 2) + '\n';

// Freigegebener Stand nach A6.4-2d: genau diese 26 Dateien.
const SKRIPTE = Object.freeze([
  'scripts/agent-code-acceptance.mjs',
  'scripts/agent-code-activation-check.mjs',
  'scripts/agent-code-auftrag-abnahme.mjs',
  'scripts/agent-code-auftrag-live.mjs',
  'scripts/agent-code-auftrag-paket.mjs',
  'scripts/agent-code-auftrag-prompt.mjs',
  'scripts/agent-code-auftrag-publish.mjs',
  'scripts/agent-code-auftrag-transport.mjs',
  'scripts/agent-code-auftrag.mjs',
  'scripts/agent-code-change-check.mjs',
  'scripts/agent-code-dryrun.mjs',
  'scripts/agent-code-integritaet.mjs',
  'scripts/agent-code-issue-live-check.mjs',
  'scripts/agent-code-issue-route.mjs',
  'scripts/agent-code-job-abnahme.mjs',
  'scripts/agent-code-job-auftrag.mjs',
  'scripts/agent-code-job-claude-nach.mjs',
  'scripts/agent-code-job-claude-vor.mjs',
  'scripts/agent-code-job-gemeinsam.mjs',
  'scripts/agent-code-job-veroeffentlichen.mjs',
  'scripts/agent-code-package.mjs',
  'scripts/agent-code-publish.mjs',
  'scripts/agent-code-release-plan.mjs',
  'scripts/agent-issue-live-check.mjs',
  'scripts/agent-issue-route.mjs',
  'scripts/agent-profile.mjs',
]);

// ---------------------------------------------------------------------------
// Synthetischer Repositorybaum
// ---------------------------------------------------------------------------

const baeume = [];

test.after(() => {
  for (const dir of baeume) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function neuerOrdner() {
  const dir = mkdtempSync(join(tmpdir(), 'a6-integritaet-'));
  baeume.push(dir);
  return dir;
}

// Kopiert alle echten Skripte als eigenstaendige Dateien (nlink 1) und legt eine synthetische,
// formal gueltige Policy mit den Hashes der kopierten Bytes an.
function baum() {
  const root = neuerOrdner();
  mkdirSync(join(root, 'scripts'));

  for (const name of readdirSync(join(ROOT, 'scripts'))) {
    copyFileSync(join(ROOT, 'scripts', name), join(root, 'scripts', name));
  }

  mkdirSync(join(root, '.github', 'agent'), { recursive: true });
  const policy = structuredClone(POLICY_ENTWURF);
  policy.skript_hashes = hashesVon(root);
  schreibePolicy(root, policy);
  return { root, policy };
}

function hashesVon(root) {
  return Object.fromEntries(
    readdirSync(join(root, 'scripts'))
      .sort()
      .map(name => [`scripts/${name}`, sha256(readFileSync(join(root, 'scripts', name)))])
  );
}

const policyPfad = root => join(root, '.github', 'agent', 'policy.json');

function schreibePolicy(root, policy) {
  writeFileSync(policyPfad(root), canon(policy));
}

function lauf(root, prueferDatei = join(root, 'scripts', PRUEFER)) {
  // Minimale Umgebung: der Pruefer liest keine Umgebungsvariablen.
  const env = IST_WINDOWS ? { SystemRoot: process.env.SystemRoot } : {};
  const r = spawnSync(process.execPath, [prueferDatei], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, signal: r.signal };
}

function bestanden(r) {
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '', signal: null });
}

function abgelehnt(r, code) {
  assert.deepEqual(r, { code: 1, stdout: '', stderr: `A6-FEHLER integritaet-${code}\n`, signal: null });
}

// Zustand aller Eintraege eines Baums: Art, Groesse, Inode, Aenderungszeit und Inhalt.
function abbild(root, start = '') {
  const eintraege = [];
  const gehe = rel => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const pfad = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, pfad), { bigint: true });
      const inhalt = st.isFile() ? sha256(readFileSync(join(root, pfad))) : '';
      eintraege.push(`${pfad} ${st.mode} ${st.size} ${st.ino} ${st.mtimeNs} ${st.nlink} ${inhalt}`);

      if (st.isDirectory()) {
        gehe(pfad);
      }
    }
  };
  gehe(start);
  return eintraege;
}

function symlinkMoeglich() {
  const dir = neuerOrdner();
  writeFileSync(join(dir, 'ziel'), 'x');

  try {
    symlinkSync(join(dir, 'ziel'), join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  }
}

const SYMLINKS = symlinkMoeglich();
const OHNE_SYMLINKS = SYMLINKS ? false : 'Symlinks auf dieser Plattform ohne Rechte nicht anlegbar (Linux-Lauf deckt sie ab)';
const NUR_LINUX = process.platform === 'linux' ? false : 'FIFO und Socket nur unter Linux';

// ---------------------------------------------------------------------------
// Inventar und Driftfixture
// ---------------------------------------------------------------------------

test('Inventar: scripts/ enthaelt genau die 26 freigegebenen Dateien, alle mit gueltigem Namen', () => {
  const ist = readdirSync(join(ROOT, 'scripts')).map(name => `scripts/${name}`).sort();
  assert.equal(SKRIPTE.length, 26);
  assert.deepEqual(ist, [...SKRIPTE].sort());
  assert.ok(ist.every(path => integritaet.SKRIPT_PFAD_RE.test(path)));

  for (const name of readdirSync(join(ROOT, 'scripts'))) {
    assert.ok(lstatSync(join(ROOT, 'scripts', name)).isFile(), name);
  }
});

test('Driftfixture: kanonisch, genau 26 Eintraege, jeder Hash gleich den tatsaechlichen Rohbytes', () => {
  assert.equal(canon(FIXTURE), FIXTURE_BYTES.toString('utf8'), 'Fixture nicht kanonisch');
  assert.deepEqual(Object.keys(FIXTURE), [...SKRIPTE].sort(), 'Fixture deckt nicht genau die 26 Dateien ab');

  for (const [path, erwartet] of Object.entries(FIXTURE)) {
    assert.match(erwartet, /^[0-9a-f]{64}$/);
    const bytes = readFileSync(join(ROOT, path));
    // Ohne .gitattributes schreibt ein Windows-Checkout mit core.autocrlf=true CRLF in den Arbeitsbaum.
    // Die Fixture gilt fuer die Bytes im Git-Index (LF); der Pruefer normalisiert bewusst nichts.
    const grund = bytes.includes(0x0d)
      ? ' (Datei enthaelt CR: Windows-Checkout mit core.autocrlf, die Fixture gilt fuer LF-Bytes wie im Git-Index)'
      : '';
    assert.equal(sha256(bytes), erwartet, `Drift in ${path}${grund}`);
  }
});

test('Driftfixture: ist nur Testhilfe, der Pruefer liest sie nie', () => {
  assert.ok(!SOURCE.includes('fixtures') && !SOURCE.includes('skript-hashes') && !SOURCE.includes('test/'));
  // Muss-Treffer: die Suche findet die feste Policyquelle.
  assert.ok(SOURCE.includes("join('.github', 'agent', 'policy.json')"));
});

// ---------------------------------------------------------------------------
// Quelltextwachen
// ---------------------------------------------------------------------------

const ohneKommentare = text => text.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');

const ERLAUBTE_IMPORTE = Object.freeze([
  "import { createHash } from 'node:crypto';",
  "import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';",
  "import { join } from 'node:path';",
]);

const VERBOTEN = Object.freeze([
  [/\bimport\s*\(/, 'dynamischer Import'],
  [/\brequire\s*\(/, 'require'],
  [/createRequire/, 'createRequire'],
  [/^\s*export\s[^;]*\bfrom\b/m, 'Re-Export'],
  [/^\s*export\s*\*/m, 'Re-Export'],
  [/child_process/, 'Prozessstarter'],
  [/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b/, 'Prozessstarter'],
  [/process\.(binding|dlopen|_linkedBinding|kill|chdir|exit\b|env|argv|execArgv)/, 'Prozesszugriff'],
  [/\bfetch\b|XMLHttpRequest|WebSocket|node:(https?|http2|net|tls|dgram|dns|worker_threads|vm|module|os|url)\b/, 'Netz oder Laufzeit'],
  [/\b(Worker|eval|Function)\s*\(/, 'Codeausfuehrung'],
  [/WebAssembly|globalThis|import\.meta\.(resolve|url|dirname|filename)/, 'Codeausfuehrung'],
  [/GITHUB_|RUNNER_|\bgit\b(?!hub)/, 'Git oder Workflowumgebung'],
  [/write|append|O_WRONLY|O_RDWR|O_CREAT|O_APPEND|O_TRUNC|unlink|rename|mkdir|rmSync|copyFile|chmod|utimes|truncate/, 'Schreibzugriff'],
]);

// Liefert die Verstoesse eines Pruefer-Quelltexts; leer bedeutet unauffaellig.
function quellProbleme(text) {
  const code = ohneKommentare(text);
  const probleme = [];
  const importe = code.split('\n').filter(line => /^\s*import\b/.test(line));

  if (JSON.stringify(importe) !== JSON.stringify(ERLAUBTE_IMPORTE)) {
    probleme.push('Importe weichen ab');
  }

  // Jedes Vorkommen von import ausserhalb der drei Zeilen ist verboten, ausser import.meta.main.
  const sonstige = code.replace(/import\.meta\.main/g, '').match(/\bimport\b/g) ?? [];

  if (sonstige.length !== ERLAUBTE_IMPORTE.length) {
    probleme.push('zusaetzliches import');
  }

  if (/from\s+['"]\.{0,2}\//.test(code) || /['"]\.{1,2}\/[^'"]*\.m?js['"]/.test(code)) {
    probleme.push('lokales Modul');
  }

  for (const [muster, grund] of VERBOTEN) {
    const ohneStderr = code.replace(/process\.stderr\.write/g, 'process.stderr.ausgabe');

    if (muster.test(ohneStderr)) {
      probleme.push(grund);
    }
  }

  // Keine Verweise auf Fach- oder Jobmodule; erlaubt sind nur der eigene Name und das Policy-Schema.
  const namen = [...new Set(text.match(/agent-[a-z0-9-]+/g) ?? [])].sort();

  if (JSON.stringify(namen) !== JSON.stringify(['agent-code-integritaet', 'agent-policy-v1'])) {
    probleme.push('Verweis auf anderes Modul');
  }

  probleme.push(...formProbleme(code));
  return probleme;
}

// A6.4-3-0 (U1, U2): erlaubte Formen statt Verbote. Gezaehlt wird im Code ohne Kommentarzeilen und
// ohne Importzeilen. Damit fallen auch Aliase und Umwege auf, die kein Verbotsmuster nennt
// (const p = process, Reflect.get(process, ...), process [x], const o = openSync, Zahl statt O_WRONLY).
// Grenze: Das ist eine Regressionswache, keine Garantie gegen beliebig verschleiertes JavaScript.
// Vertrauenswurzel bleiben der geschuetzte aeussere Hashanker, die geschuetzte Policy und der Workflow.
const ERLAUBTE_PROCESS = Object.freeze([
  ['process.cwd()', 1],
  ['process.stderr.write(', 2],
  ['process.exitCode =', 2],
]);
const OPEN_FLAGS_ZEILE =
  'const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);';
const OPEN_AUFRUF = 'openSync(pfad, OPEN_FLAGS)';
const anzahl = (text, muster) => (text.match(muster) ?? []).length;

function formProbleme(code) {
  const probleme = [];
  const zeilen = code.split('\n').filter(line => !/^\s*import\b/.test(line));
  const rumpf = zeilen.join('\n');

  // Die Kommentarzeilen-Filterung ist zeilenweise; ein Blockkommentar koennte Code hinter einer
  // scheinbaren Kommentarzeile verstecken. Der Pruefer braucht keine Blockkommentare.
  if (rumpf.includes('/*')) {
    probleme.push('Blockkommentar');
  }

  let rest = rumpf;

  for (const [form, soll] of ERLAUBTE_PROCESS) {
    if (rest.split(form).length - 1 !== soll) {
      rest = null;
      break;
    }

    rest = rest.replaceAll(form, '');
  }

  if (rest === null || /\bprocess\b/.test(rest) || anzahl(rumpf, /\bprocess\b/g) !== 5) {
    probleme.push('process weicht ab');
  }

  if (/getBuiltinModule/.test(rumpf)) {
    probleme.push('getBuiltinModule');
  }

  if (anzahl(rumpf, /\bopenSync\b/g) !== 1 || rumpf.split(OPEN_AUFRUF).length !== 2) {
    probleme.push('openSync weicht ab');
  }

  const ohneFlagsZeile = zeilen.filter(line => line !== OPEN_FLAGS_ZEILE).join('\n');

  if (zeilen.filter(line => line === OPEN_FLAGS_ZEILE).length !== 1 || /\bconstants\b/.test(ohneFlagsZeile)) {
    probleme.push('constants weicht ab');
  }

  if (anzahl(rumpf, /\bOPEN_FLAGS\b/g) !== 2) {
    probleme.push('OPEN_FLAGS weicht ab');
  }

  return probleme;
}

test('Wache: Pruefer importiert nur node:crypto, node:fs und node:path, kein lokales Modul', () => {
  assert.deepEqual(quellProbleme(SOURCE), []);
  // Muss-Treffer: die Importsuche findet genau die drei Zeilen.
  assert.equal(ohneKommentare(SOURCE).split('\n').filter(line => /^\s*import\b/.test(line)).length, 3);
  assert.ok(SOURCE.includes("from 'node:fs'"));
});

test('Wache: jede verbotene Form wird erkannt (lokaler Import, Prozess, Netz, Schreiben, Umgebung)', () => {
  const ende = "import { join } from 'node:path';\n";
  assert.ok(SOURCE.includes(ende));
  const varianten = [
    ['lokaler Import', s => s.replace(ende, `${ende}import { sha256 } from './agent-profile.mjs';\n`)],
    ['Seiteneffekt-Import', s => s.replace(ende, `${ende}import './agent-code-job-gemeinsam.mjs';\n`)],
    ['dynamischer Import', s => s.replace('export function main() {', "export function main() {\n  import('./agent-profile.mjs');")],
    ['require', s => s.replace('export function main() {', "export function main() {\n  require('node:fs');")],
    ['createRequire', s => s.replace(ende, `${ende}import { createRequire } from 'node:module';\n`)],
    ['Re-Export', s => s + "export { sha256 } from './agent-profile.mjs';\n"],
    ['Prozessstarter', s => s.replace(ende, `${ende}import { execFileSync } from 'node:child_process';\n`)],
    ['spawn', s => s.replace('export function main() {', 'export function main() {\n  spawn(1);')],
    ['fetch', s => s.replace('export function main() {', "export function main() {\n  fetch('https://example.org');")],
    ['http', s => s.replace(ende, `${ende}import https from 'node:https';\n`)],
    ['Umgebung', s => s.replace('export function main() {', 'export function main() {\n  const w = process.env.GITHUB_WORKSPACE;')],
    ['Argumente', s => s.replace('export function main() {', 'export function main() {\n  const a = process.argv[2];')],
    ['Wurzelwechsel', s => s.replace('export function main() {', "export function main() {\n  process.chdir('..');")],
    ['Schreiben', s => s.replace('closeSync, constants', 'closeSync, writeFileSync, constants')],
    ['O_RDWR', s => s.replace('constants.O_RDONLY', 'constants.O_RDWR')],
    ['Git', s => s.replace('export function main() {', "export function main() {\n  const g = 'git';")],
    ['eval', s => s.replace('export function main() {', "export function main() {\n  eval('1');")],
    ['Fremdname', s => s.replace("const SCRIPTS_DIR = 'scripts';", "const SCRIPTS_DIR = 'scripts';\nconst X = 'agent-code-auftrag-publish';")],
  ];

  for (const [name, aendern] of varianten) {
    const mutiert = aendern(SOURCE);
    assert.notEqual(mutiert, SOURCE, `${name}: Mutation greift nicht`);
    assert.ok(quellProbleme(mutiert).length > 0, `${name}: nicht erkannt`);
  }

  // Muss-Treffer mit genauem Grund fuer die bestehenden Verbotsgruppen.
  const grund = [
    ['Prozessstarter', s => s.replace(ende, `${ende}import { execFileSync } from 'node:child_process';\n`)],
    ['Netz oder Laufzeit', s => s.replace(ende, `${ende}import https from 'node:https';\n`)],
    ['Netz oder Laufzeit', s => s.replace('export function main() {', "export function main() {\n  fetch('https://example.org');")],
    ['Importe weichen ab', s => s.replace(ende, `${ende}import { inspect } from 'node:util';\n`)],
    ['lokales Modul', s => s.replace(ende, `${ende}import './agent-code-integritaet-x.mjs';\n`)],
  ];

  for (const [erwartet, aendern] of grund) {
    assert.ok(quellProbleme(aendern(SOURCE)).includes(erwartet), `${erwartet}: nicht als Grund erkannt`);
  }
});

// A6.4-3-0: Muss-Treffer der erlaubten Formen am unveraenderten Pruefer.
test('Wache U1/U2: unveraenderter Pruefer hat genau die erlaubten Formen', () => {
  const code = ohneKommentare(SOURCE);
  const rumpf = code.split('\n').filter(line => !/^\s*import\b/.test(line)).join('\n');
  assert.deepEqual(formProbleme(code), []);
  assert.equal(anzahl(rumpf, /\bprocess\b/g), 5);
  assert.equal(rumpf.split('process.cwd()').length - 1, 1);
  assert.equal(rumpf.split('process.stderr.write(').length - 1, 2);
  assert.equal(rumpf.split('process.exitCode =').length - 1, 2);
  assert.equal(anzahl(rumpf, /\bopenSync\b/g), 1);
  assert.ok(rumpf.includes(`fd = ${OPEN_AUFRUF};`));
  assert.ok(code.split('\n').includes(OPEN_FLAGS_ZEILE));
  assert.equal(anzahl(rumpf, /\bconstants\b/g), 3);
  assert.equal(anzahl(rumpf, /\bOPEN_FLAGS\b/g), 2);
  // Die Flags bestehen nur aus Lesen, kein Folgen von Symlinks und nicht blockierend.
  assert.deepEqual(OPEN_FLAGS_ZEILE.match(/O_[A-Z]+/g), ['O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK']);
});

test('Wache U1/U2: jede Abweichung wird mit genau ihrem Grund erkannt', () => {
  const START = '  const wurzel = process.cwd();\n';
  const MAIN = 'export function main() {\n';
  assert.equal(SOURCE.split(START).length, 2);
  assert.equal(SOURCE.split(MAIN).length, 2);
  const nachStart = zeile => s => s.replace(START, `${START}  ${zeile}\n`);
  const inMain = zeile => s => s.replace(MAIN, `${MAIN}  ${zeile}\n`);
  const flags = neu => s => s.replace(OPEN_FLAGS_ZEILE, neu);

  const varianten = [
    // U1: Schreibmodus ueber den bereits importierten openSync
    ['openSync mit w statt OPEN_FLAGS', s => s.replace(OPEN_AUFRUF, "openSync(pfad, 'w')"), ['openSync weicht ab', 'OPEN_FLAGS weicht ab']],
    ['zusaetzlicher openSync mit w', nachStart("closeSync(openSync('marke', 'w'));"), ['openSync weicht ab']],
    ['zusaetzlicher openSync mit Zahl', nachStart("closeSync(openSync('marke', 577));"), ['openSync weicht ab']],
    ['openSync-Alias', inMain('const o = openSync;'), ['openSync weicht ab']],
    ['OPEN_FLAGS erweitert im Aufruf', s => s.replace(OPEN_AUFRUF, 'openSync(pfad, OPEN_FLAGS | 1)'), ['openSync weicht ab']],
    ['O_WRONLY statt O_RDONLY', flags(OPEN_FLAGS_ZEILE.replace('O_RDONLY', 'O_WRONLY')), ['Schreibzugriff', 'constants weicht ab']],
    ['Zahl statt O_WRONLY', flags(OPEN_FLAGS_ZEILE.replace('constants.O_RDONLY', 'constants.O_RDONLY | 1')), ['constants weicht ab']],
    ['O_NOFOLLOW entfernt', flags(OPEN_FLAGS_ZEILE.replace(' | (constants.O_NOFOLLOW ?? 0)', '')), ['constants weicht ab']],
    ['constants-Alias', inMain('const c = constants;'), ['constants weicht ab']],
    ['OPEN_FLAGS weiterverwendet', inMain('const f = OPEN_FLAGS;'), ['OPEN_FLAGS weicht ab']],
    // U2: Basismodul ueber process und dynamische Zugriffe
    ['getBuiltinModule', nachStart("process.getBuiltinModule('node:fs').mkdtempSync('marke-');"), ['process weicht ab', 'getBuiltinModule']],
    ['process[...] mit Name', inMain("const m = process['getBuiltinModule'];"), ['process weicht ab', 'getBuiltinModule']],
    ['process [...] mit Leerraum', inMain("const m = process ['getBuilt' + 'inModule'];"), ['process weicht ab']],
    ['process mit Zeilenumbruch vor [', inMain("const m = process\n    ['getBuilt' + 'inModule'];"), ['process weicht ab']],
    ['process . mit Leerraum', inMain("const m = process .cwd();"), ['process weicht ab']],
    ['process-Alias', inMain('const p = process;'), ['process weicht ab']],
    ['Reflect.get', inMain("const m = Reflect.get(process, 'getBuilt' + 'inModule');"), ['process weicht ab']],
    ['dritter exitCode', inMain('process.exitCode = 0;'), ['process weicht ab']],
    ['erlaubte Form entfernt', s => s.replace("process.stderr.write(fehlerZeile(error));", 'fehlerZeile(error);'), ['process weicht ab']],
    ['Blockkommentar versteckt Code', inMain('/*\n// */ const a = 1;'), ['Blockkommentar']],
  ];

  for (const [name, aendern, erwartet] of varianten) {
    const mutiert = aendern(SOURCE);
    assert.notEqual(mutiert, SOURCE, `${name}: Mutation greift nicht`);
    assert.deepEqual(quellProbleme(mutiert), erwartet, name);
  }
});

// Laufzeitbeleg: Mutationen mit gueltiger Syntax wirken tatsaechlich. In einem synthetischen Baum mit
// passender Policy legen sie eine Marke im Arbeitsverzeichnis an und enden trotzdem mit 0. Gerade das
// faengt nur die Quelltextwache ab; der Pruefer selbst kann sich nicht pruefen (Fall B).
test('Laufzeit U1/U2: gefaehrliche Mutation schreibt, endet mit 0, und die Wache erkennt genau sie', () => {
  const START = '  const wurzel = process.cwd();\n';
  const faelle = [
    ['U1', `${START}  closeSync(openSync('marke', 'w'));\n`, ['openSync weicht ab'], root => existsSync(join(root, 'marke'))],
    [
      'U2',
      `${START}  process.getBuiltinModule('node:fs').mkdtempSync('marke-');\n`,
      ['process weicht ab', 'getBuiltinModule'],
      root => readdirSync(root).some(name => name.startsWith('marke-')),
    ],
  ];

  for (const [name, ersatz, erwartet, markeDa] of faelle) {
    const mutiert = SOURCE.replace(START, ersatz);
    assert.notEqual(mutiert, SOURCE);
    assert.deepEqual(quellProbleme(mutiert), erwartet, name);

    const { root, policy } = baum();
    // Gegenprobe vorher: der unveraenderte Pruefer besteht und hinterlaesst keine Marke.
    bestanden(lauf(root));
    assert.equal(markeDa(root), false, `${name}: Marke vor der Mutation`);

    writeFileSync(join(root, 'scripts', PRUEFER), mutiert);
    policy.skript_hashes = hashesVon(root);
    schreibePolicy(root, policy);
    bestanden(lauf(root));
    assert.equal(markeDa(root), true, `${name}: Mutation hat nicht geschrieben`);
  }
});

const EINSTIEG =
  "if (import.meta.main === true) {\n  process.exitCode = main();\n} else if (import.meta.main !== false) {\n  process.stderr.write(fehlerZeile(new IntegritaetFehler('umgebung-fehlt')));\n  process.exitCode = 1;\n}\n";
const UNSICHER = 'if (import.meta.main) {\n  process.exitCode = main();\n}\n';

test('Wache: Einstieg genau in der fail-closed-Form am Dateiende', () => {
  assert.ok(SOURCE.endsWith(EINSTIEG), 'erlaubte Einstiegskonstruktion fehlt am Dateiende');
  assert.equal(SOURCE.split(EINSTIEG).length, 2);
  assert.ok(!SOURCE.includes('if (import.meta.main) {'));
  assert.equal((ohneKommentare(SOURCE).match(/import\.meta\.main/g) ?? []).length, 2);
});

test('Wache: Policypfad und Wurzel sind fest, keine Umschaltung', () => {
  const code = ohneKommentare(SOURCE);
  assert.equal((code.match(/process\.cwd\(\)/g) ?? []).length, 1);
  assert.ok(code.includes('const wurzel = process.cwd();'));
  assert.ok(!/--[a-z]/.test(code), 'Kommandozeilenschalter im Quelltext');
  assert.ok(!/(test|draft|skip|allow|entwurf)[A-Z_-]*(modus|mode)?\s*[:=]/i.test(code), 'Ausnahmemodus');
  assert.equal((code.match(/policy\.json/g) ?? []).length, 1);
  // Alle Pfade sind relativ: aufgeloest gegen process.cwd() durch das Dateisystem selbst.
  assert.ok(!/['"`]\//.test(code), 'absoluter Pfad');
});

test('Wache: eigene Policyfelder stimmen mit POLICY_KEYS des Profilmoduls ueberein', () => {
  const match = SOURCE.match(/const POLICY_KEYS = Object\.freeze\(\[\n([\s\S]*?)\n\]\);/);
  assert.ok(match, 'Liste nicht gefunden');
  const eigene = match[1].split('\n').map(line => line.trim().replace(/^'|',?$/g, ''));
  assert.deepEqual(eigene, [...POLICY_KEYS]);
});

// ---------------------------------------------------------------------------
// Einstieg und Import
// ---------------------------------------------------------------------------

test('Import unter Node 24: keine Pruefung, keine Ausgabe, Exitcode unberuehrt', () => {
  assert.equal(EXIT_NACH_IMPORT, undefined);
  assert.equal(EXIT_NACH_PRUEFER_IMPORT, undefined);
  assert.equal(typeof integritaet.pruefeIntegritaet, 'function');

  // In einem leeren Ordner wuerde eine Pruefung sofort mit policy-fehlt scheitern.
  const leer = neuerOrdner();
  const url = pathToFileURL(PRUEFER_PFAD).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
    cwd: leer,
    encoding: 'utf8',
  });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  // Gegenprobe: derselbe Ordner als CLI scheitert.
  abgelehnt(lauf(leer, PRUEFER_PFAD), 'policy-fehlt');
});

test('Laufzeit: ohne import.meta.main endet der Start mit umgebung-fehlt; der alte Ausdruck endete mit 0', () => {
  const fehlt = s => s.replaceAll('import.meta.main', 'import.meta.mainFehlt');

  const { root } = baum();
  const pfad = join(root, 'scripts', PRUEFER);
  writeFileSync(pfad, fehlt(SOURCE));
  assert.ok(readFileSync(pfad, 'utf8').includes('import.meta.mainFehlt === true'));
  abgelehnt(lauf(root), 'umgebung-fehlt');

  // Der alte Ausdruck haette ungeprueft mit 0 geendet, obwohl die Policy nicht mehr passt.
  writeFileSync(pfad, fehlt(SOURCE.replace(EINSTIEG, UNSICHER)));
  assert.ok(readFileSync(pfad, 'utf8').includes('if (import.meta.mainFehlt) {'));
  bestanden(lauf(root));
  // Gegenprobe: mit vorhandenem import.meta.main prueft dieselbe Kopie und lehnt ab.
  writeFileSync(pfad, SOURCE.replace(EINSTIEG, UNSICHER));
  abgelehnt(lauf(root), 'skript-hash');
});

// ---------------------------------------------------------------------------
// Positive Faelle
// ---------------------------------------------------------------------------

test('Positiv: 26 Dateien, vollstaendige Policy, Erfolg ohne Ausgabe und ohne Schreibzugriff', () => {
  const { root, policy } = baum();
  assert.equal(Object.keys(policy.skript_hashes).length, 26);
  assert.deepEqual(Object.keys(policy.skript_hashes), [...SKRIPTE].sort());
  // Die synthetische Policy besteht auch die volle Pruefung des Profilmoduls (mit neuer Pfadregel).
  assert.deepEqual(loadPolicy(readFileSync(policyPfad(root))), policy);
  // Die Kopie ist byte-identisch mit dem Original und mit der Driftfixture.
  assert.deepEqual(policy.skript_hashes, FIXTURE);

  const vorher = abbild(root);
  bestanden(lauf(root));
  assert.deepEqual(abbild(root), vorher);
});

test('Positiv: pruefeIntegritaet nutzt process.cwd() als Wurzel und nichts sonst', t => {
  const { root } = baum();
  const alt = process.cwd();
  t.after(() => process.chdir(alt));
  process.chdir(root);
  assert.equal(integritaet.pruefeIntegritaet(), undefined);
  // Gegenprobe (A6.4-3a): ein zweiter synthetischer Baum ohne Policy. Derselbe Aufruf scheitert dort,
  // die Wurzel folgt also allein process.cwd(). Unabhaengig davon, ob das echte Repository eine Policy hat.
  const ohne = baum().root;
  rmSync(policyPfad(ohne));
  assert.ok(!existsSync(policyPfad(ohne)));
  process.chdir(ohne);
  assert.throws(() => integritaet.pruefeIntegritaet(), error => error.code === 'policy-fehlt');
  abgelehnt(lauf(ohne), 'policy-fehlt');
  process.chdir(root);
  assert.equal(integritaet.pruefeIntegritaet(), undefined);
});

// A6.4-3a: Auf main liegen die produktive Policy und die Claude-Basiseinstellungen. Bis der
// Eigentuemer-PR sie einrichtet, ist dieser Test bewusst rot; er wird nicht uebersprungen.
test('Echtes Repository: produktive Policy und Claude-Basis gueltig, Pruefer besteht ohne Ausgabe und ohne Schreibzugriff', () => {
  const pfad = join(ROOT, '.github', 'agent', 'policy.json');
  const settingsPfad = join(ROOT, '.github', 'agent', 'claude-settings.json');
  const stat = lstatSync(pfad);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Policy ist keine gewoehnliche Datei');

  const bytes = readFileSync(pfad);
  const text = bytes.toString('utf8');
  assert.ok(text.charCodeAt(0) !== 0xfeff && !text.includes(String.fromCharCode(13)), 'BOM oder CR in der Policy');
  const policy = JSON.parse(text);
  assert.equal(canon(policy), text, 'Policy nicht kanonisch');
  assert.equal(sha256(bytes), POLICY_SHA256);
  // Volle Pruefung des Profilmoduls ohne Entwurfsmodus.
  assert.deepEqual(loadPolicy(bytes), policy);
  // Alle uebrigen Werte entsprechen dem geprueften Entwurf; nur skript_hashes ist befuellt.
  assert.deepEqual({ ...policy, skript_hashes: POLICY_ENTWURF.skript_hashes }, POLICY_ENTWURF);
  assert.equal(Object.keys(policy.skript_hashes).length, 26);
  assert.deepEqual(policy.skript_hashes, FIXTURE);

  for (const [skript, hash] of Object.entries(policy.skript_hashes)) {
    assert.equal(sha256(readFileSync(join(ROOT, skript))), hash, skript);
  }

  // Pruefpunkt C: die Claude-Basiseinstellungen sind byte-gleich mit der geprueften Fixture.
  const settingsStat = lstatSync(settingsPfad);
  assert.ok(settingsStat.isFile() && !settingsStat.isSymbolicLink(), 'Einstellungen sind keine gewoehnliche Datei');
  assert.ok(readFileSync(settingsPfad).equals(SETTINGS_ENTWURF_BYTES), 'Claude-Basis weicht von der Fixture ab');

  // Der echte Pruefer im echten Repository: Erfolg ohne Ausgabe, scripts/ und .github/agent/ unveraendert.
  const vorher = [...abbild(ROOT, 'scripts'), ...abbild(ROOT, '.github/agent')];
  assert.ok(vorher.length >= 28, 'Gegenprobe: Abbild zu klein');
  bestanden(lauf(ROOT, PRUEFER_PFAD));
  assert.deepEqual([...abbild(ROOT, 'scripts'), ...abbild(ROOT, '.github/agent')], vorher);
});

// ---------------------------------------------------------------------------
// Negative Faelle: Skripte
// ---------------------------------------------------------------------------

function kippeByte(datei) {
  const bytes = readFileSync(datei);
  const stelle = bytes.indexOf(0x2f); // erstes '/', liegt im Kopfkommentar
  bytes[stelle] = 0x2a;
  writeFileSync(datei, bytes);
  return bytes.length;
}

for (const name of ['agent-code-job-gemeinsam.mjs', 'agent-code-auftrag-paket.mjs', 'agent-code-auftrag-publish.mjs', PRUEFER]) {
  test(`Skript: ein Byte in ${name} veraendert, gleiche Laenge, wird abgelehnt (Fall A)`, () => {
    const { root } = baum();
    const datei = join(root, 'scripts', name);
    const laenge = readFileSync(datei).length;
    assert.equal(kippeByte(datei), laenge);
    assert.equal(readFileSync(datei).length, laenge);
    abgelehnt(lauf(root, name === PRUEFER ? PRUEFER_PFAD : undefined), 'skript-hash');
  });
}

test('Skript: falscher Hash in der Policy wird abgelehnt', () => {
  const { root, policy } = baum();
  policy.skript_hashes['scripts/agent-code-package.mjs'] = '0'.repeat(64);
  schreibePolicy(root, policy);
  abgelehnt(lauf(root), 'skript-hash');
});

test('Skript: fehlender Hash, fehlende Datei, zusaetzlicher Hash und zusaetzliche Datei werden abgelehnt', () => {
  {
    const { root, policy } = baum();
    delete policy.skript_hashes['scripts/agent-code-dryrun.mjs'];
    schreibePolicy(root, policy);
    abgelehnt(lauf(root), 'skript-ohne-hash');
  }
  {
    const { root } = baum();
    unlinkSync(join(root, 'scripts', 'agent-code-dryrun.mjs'));
    abgelehnt(lauf(root), 'hash-ohne-skript');
  }
  {
    const { root, policy } = baum();
    policy.skript_hashes['scripts/agent-code-zusatz.mjs'] = 'a'.repeat(64);
    schreibePolicy(root, policy);
    abgelehnt(lauf(root), 'hash-ohne-skript');
  }
  {
    const { root } = baum();
    writeFileSync(join(root, 'scripts', 'agent-code-zusatz.mjs'), '// zusaetzlich\n');
    abgelehnt(lauf(root), 'skript-ohne-hash');
  }
  {
    // Zusaetzliche Datei mit passendem Hash in derselben Policy: Mengen gleich, Pruefung besteht.
    // Das ist Fall B (siehe unten), keine Luecke des Pruefers.
    const { root, policy } = baum();
    writeFileSync(join(root, 'scripts', 'agent-code-zusatz.mjs'), '// zusaetzlich\n');
    policy.skript_hashes = hashesVon(root);
    schreibePolicy(root, policy);
    bestanden(lauf(root));
  }
});

test('Skript: Nicht-Skriptdateien, versteckte Dateien und falsche Schreibweisen werden abgelehnt', () => {
  for (const name of ['README.md', '.agent-code-x.mjs', '.gitkeep', 'agent-code-x.js', 'agent-code-x.cjs', 'agent-Code-x.mjs', 'agent-code--x.mjs', 'agent-code-x-.mjs', 'agent_code_x.mjs', 'agent-code-x.mjs.bak', 'agent-code-ä.mjs', 'agent-code-x​.mjs']) {
    const { root } = baum();
    writeFileSync(join(root, 'scripts', name), '// x\n');
    abgelehnt(lauf(root), 'skript-name');
  }
});

test('Skript: falsche Gross-/Kleinschreibung einer vorhandenen Datei wird abgelehnt', () => {
  const { root } = baum();
  renameSync(join(root, 'scripts', 'agent-code-package.mjs'), join(root, 'scripts', 'tmp-umbenennung'));
  renameSync(join(root, 'scripts', 'tmp-umbenennung'), join(root, 'scripts', 'agent-code-Package.mjs'));
  assert.ok(readdirSync(join(root, 'scripts')).includes('agent-code-Package.mjs'));
  abgelehnt(lauf(root), 'skript-name');
});

test('Skript: Unterverzeichnis wird abgelehnt, auch mit gueltigem Namen', () => {
  {
    const { root } = baum();
    mkdirSync(join(root, 'scripts', 'unter'));
    abgelehnt(lauf(root), 'skript-name');
  }
  {
    const { root, policy } = baum();
    mkdirSync(join(root, 'scripts', 'agent-code-unter.mjs'));
    policy.skript_hashes['scripts/agent-code-unter.mjs'] = 'a'.repeat(64);
    schreibePolicy(root, policy);
    abgelehnt(lauf(root), 'skript-eintrag');
  }
});

test('Skript: Symlink-Datei mit identischen Bytes wird abgelehnt', { skip: OHNE_SYMLINKS }, () => {
  const { root } = baum();
  const aussen = join(neuerOrdner(), 'kopie.mjs');
  const datei = join(root, 'scripts', 'agent-code-package.mjs');
  copyFileSync(datei, aussen);
  unlinkSync(datei);
  symlinkSync(aussen, datei, 'file');
  assert.equal(sha256(readFileSync(datei)), FIXTURE['scripts/agent-code-package.mjs']);
  abgelehnt(lauf(root), 'skript-eintrag');
});

test('Skript: Symlink-Verzeichnis scripts/ wird abgelehnt', { skip: OHNE_SYMLINKS }, () => {
  const { root } = baum();
  const echt = join(neuerOrdner(), 'scripts');
  renameSync(join(root, 'scripts'), echt);
  symlinkSync(echt, join(root, 'scripts'), 'dir');
  abgelehnt(lauf(root, join(echt, PRUEFER)), 'skripte-ordner');
});

test('Skript: Hardlink mit identischen Bytes wird abgelehnt', () => {
  const { root } = baum();
  linkSync(join(root, 'scripts', 'agent-code-package.mjs'), join(neuerOrdner(), 'zweitname.mjs'));
  assert.equal(lstatSync(join(root, 'scripts', 'agent-code-package.mjs')).nlink, 2);
  abgelehnt(lauf(root), 'skript-link');
});

test('Skript: FIFO wird abgelehnt, ohne es zu oeffnen', { skip: NUR_LINUX }, () => {
  for (const name of ['agent-code-fifo.mjs', 'agent-code-package.mjs']) {
    const { root } = baum();
    const pfad = join(root, 'scripts', name);

    if (existsSync(pfad)) {
      unlinkSync(pfad);
    }

    execFileSync('mkfifo', [pfad]);
    // Ein blockierendes Oeffnen wuerde hier bis zum Zeitlimit haengen.
    abgelehnt(lauf(root), 'skript-eintrag');
  }
});

test('Skript: Socket wird abgelehnt', { skip: NUR_LINUX }, async () => {
  const { root } = baum();
  const server = net.createServer();
  await new Promise(resolve => server.listen(join(root, 'scripts', 'agent-code-sock.mjs'), resolve));

  try {
    abgelehnt(lauf(root), 'skript-eintrag');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Skript: zu grosse Datei wird abgelehnt, bevor sie gehasht wird', () => {
  const { root, policy } = baum();
  writeFileSync(join(root, 'scripts', 'agent-code-gross.mjs'), Buffer.alloc(integritaet.MAX_SKRIPT_BYTES + 1, 0x20));
  policy.skript_hashes = hashesVon(root);
  schreibePolicy(root, policy);
  abgelehnt(lauf(root), 'skript-groesse');
});

test('Skript: Datei waehrend des Lesens vergroessert oder veraendert wird abgelehnt', t => {
  const { root } = baum();
  const alt = process.cwd();
  const original = fsModul.readSync;
  t.after(() => {
    fsModul.readSync = original;
    syncBuiltinESMExports();
    process.chdir(alt);
  });
  process.chdir(root);
  const ziel = join(root, 'scripts', 'agent-code-auftrag-publish.mjs');
  const zielIno = lstatSync(ziel, { bigint: true }).ino;
  let aktion = null;
  let ausgeloest = 0;

  fsModul.readSync = (fd, ...rest) => {
    if (aktion && fsModul.fstatSync(fd, { bigint: true }).ino === zielIno && ausgeloest === 0) {
      ausgeloest += 1;
      aktion();
    }

    return original(fd, ...rest);
  };
  syncBuiltinESMExports();

  // Vergroessert, waehrend der Deskriptor offen ist.
  aktion = () => appendFileSync(ziel, '// angehaengt\n');
  assert.throws(() => integritaet.pruefeIntegritaet(), error => error.code === 'skript-veraendert');
  assert.equal(ausgeloest, 1, 'Eingriff nicht ausgeloest');

  // Gleiche Laenge, anderer Inhalt: faellt beim Hash auf.
  const urspruenglich = readFileSync(join(ROOT, 'scripts', 'agent-code-auftrag-publish.mjs'));
  writeFileSync(ziel, urspruenglich);
  ausgeloest = 0;
  aktion = () => {
    const bytes = Buffer.from(urspruenglich);
    bytes[bytes.indexOf(0x2f)] = 0x2a;
    writeFileSync(ziel, bytes);
  };
  assert.throws(() => integritaet.pruefeIntegritaet(), error => error.code === 'skript-hash');
  assert.equal(ausgeloest, 1, 'Eingriff nicht ausgeloest');

  // Gegenprobe ohne Eingriff: derselbe Baum besteht.
  writeFileSync(ziel, urspruenglich);
  aktion = null;
  assert.equal(integritaet.pruefeIntegritaet(), undefined);
});

// ---------------------------------------------------------------------------
// Negative Faelle: Policy
// ---------------------------------------------------------------------------

test('Policy: fehlend, leer, Ordner, zu gross, BOM, UTF-8, CR, NUL werden abgelehnt', () => {
  const faelle = [
    ['policy-fehlt', root => unlinkSync(policyPfad(root))],
    ['policy-leer', root => writeFileSync(policyPfad(root), '')],
    ['policy-datei', root => { unlinkSync(policyPfad(root)); mkdirSync(policyPfad(root)); }],
    ['policy-groesse', root => writeFileSync(policyPfad(root), Buffer.alloc(integritaet.MAX_POLICY_BYTES + 1, 0x20))],
    ['policy-bom', root => writeFileSync(policyPfad(root), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(policyPfad(root))]))],
    ['policy-utf8', root => writeFileSync(policyPfad(root), Buffer.concat([readFileSync(policyPfad(root)), Buffer.from([0xc3, 0x28])]))],
    ['policy-zeichen', root => writeFileSync(policyPfad(root), readFileSync(policyPfad(root), 'utf8').replaceAll('\n', '\r\n'))],
    ['policy-zeichen', root => writeFileSync(policyPfad(root), readFileSync(policyPfad(root), 'utf8') + '\u0000')],
    ['policy-ordner', root => { rmSync(join(root, '.github', 'agent'), { recursive: true }); writeFileSync(join(root, '.github', 'agent'), 'x'); }],
    ['policy-fehlt', root => rmSync(join(root, '.github', 'agent'), { recursive: true })],
    ['policy-fehlt', root => rmSync(join(root, '.github'), { recursive: true })],
  ];

  for (const [code, aendern] of faelle) {
    const { root } = baum();
    aendern(root);
    abgelehnt(lauf(root), code);
  }
});

test('Policy: ungueltiges, mehrdeutiges und nicht kanonisches JSON wird abgelehnt', () => {
  const faelle = [
    ['policy-json', text => text.slice(0, -3)],
    ['policy-json', () => 'nicht json\n'],
    // Doppelter Schluessel: der zweite gewinnt bei JSON.parse; die kanonische Form deckt das auf.
    ['policy-kanonisch', text => text.replace('  "skript_hashes": {', '  "skript_hashes": {},\n  "skript_hashes": {')],
    ['policy-kanonisch', text => text.replace('"scripts/agent-profile.mjs"', '"scripts/agent-profile.mjs": "' + '1'.repeat(64) + '",\n    "scripts/agent-profile.mjs"')],
    ['policy-kanonisch', text => text.replaceAll('\n  ', '\n    ')],
    ['policy-kanonisch', text => text.slice(0, -1)],
    ['policy-kanonisch', text => text + '\n'],
    ['policy-kanonisch', text => text.replace('"schema"', '"sch\\u0065ma"')],
    ['policy-kanonisch', text => text.replace('1.5', '1.50')],
  ];

  for (const [code, aendern] of faelle) {
    const { root } = baum();
    const text = readFileSync(policyPfad(root), 'utf8');
    const neu = aendern(text);
    assert.notEqual(neu, text);
    writeFileSync(policyPfad(root), neu);
    abgelehnt(lauf(root), code);
  }
});

test('Policy: manipulierte Felder, Schema und Hashwerte werden abgelehnt', () => {
  const faelle = [
    ['policy-schema', p => { p.zusatz = true; }],
    ['policy-schema', p => { delete p.modelle; }],
    ['policy-schema', p => { p.schema = 'agent-policy-v2'; }],
    ['policy-hashes', p => { p.skript_hashes = []; }],
    ['policy-hashes', p => { p.skript_hashes = null; }],
    ['policy-hashes', p => { p.skript_hashes = {}; }],
    ['policy-hashes', p => { p.skript_hashes['scripts/agent-code-package.mjs'] = p.skript_hashes['scripts/agent-code-package.mjs'].toUpperCase(); }],
    ['policy-hashes', p => { p.skript_hashes['scripts/agent-code-package.mjs'] += '0'; }],
    ['policy-hashes', p => { p.skript_hashes['scripts/agent-code-package.mjs'] = p.skript_hashes['scripts/agent-code-package.mjs'].slice(1); }],
    ['policy-hashes', p => { p.skript_hashes['scripts/agent-code-package.mjs'] = 1; }],
    ['policy-hashes', p => { p.skript_hashes['scripts/../scripts/agent-code-package.mjs'] = 'a'.repeat(64); }],
    ['policy-hashes', p => { p.skript_hashes['scripts/agent-code-Package.mjs'] = 'a'.repeat(64); }],
    ['policy-hashes', p => { p.skript_hashes['src/rechne.js'] = 'a'.repeat(64); }],
    ['policy-hashes', p => { for (let i = 0; i < 64; i += 1) p.skript_hashes[`scripts/agent-x${i}.mjs`] = 'a'.repeat(64); }],
    ['policy-selbst', p => { delete p.skript_hashes['scripts/agent-code-integritaet.mjs']; }],
  ];

  for (const [code, aendern] of faelle) {
    const { root, policy } = baum();
    aendern(policy);
    schreibePolicy(root, policy);
    abgelehnt(lauf(root), code);
  }
});

test('Policy: Symlink und Hardlink der Policydatei werden abgelehnt', () => {
  {
    const { root } = baum();
    linkSync(policyPfad(root), join(neuerOrdner(), 'policy.json'));
    abgelehnt(lauf(root), 'policy-link');
  }

  if (SYMLINKS) {
    const { root } = baum();
    const aussen = join(neuerOrdner(), 'policy.json');
    copyFileSync(policyPfad(root), aussen);
    unlinkSync(policyPfad(root));
    symlinkSync(aussen, policyPfad(root), 'file');
    abgelehnt(lauf(root), 'policy-datei');

    const zweiter = baum();
    const echt = join(neuerOrdner(), 'agent');
    renameSync(join(zweiter.root, '.github', 'agent'), echt);
    symlinkSync(echt, join(zweiter.root, '.github', 'agent'), 'dir');
    abgelehnt(lauf(zweiter.root), 'policy-ordner');
  }
});

// ---------------------------------------------------------------------------
// Vertrauensgrenze: Skript und Hashliste gemeinsam
// ---------------------------------------------------------------------------

test('Vertrauensgrenze: Fall A lehnt ab, Fall B besteht; Autorisierung leistet erst der aeussere Anker', () => {
  // Fall A: Skript geaendert, Policy unveraendert. Der Pruefer lehnt ab.
  const a = baum();
  const datei = join(a.root, 'scripts', 'agent-code-job-gemeinsam.mjs');
  writeFileSync(datei, readFileSync(datei, 'utf8') + '// manipuliert\n');
  abgelehnt(lauf(a.root), 'skript-hash');

  // Fall B: Skript und ungeschuetzte Hashliste desselben Checkouts gemeinsam geaendert. Beide sind in
  // sich stimmig, der Pruefer besteht. Das ist die dokumentierte Grenze, kein Fehler: Uebereinstimmung
  // mit einer mitgelieferten Liste beweist keine Autorisierung.
  const b = baum();
  const dateiB = join(b.root, 'scripts', 'agent-code-job-gemeinsam.mjs');
  writeFileSync(dateiB, readFileSync(dateiB, 'utf8') + '// manipuliert\n');
  b.policy.skript_hashes = hashesVon(b.root);
  schreibePolicy(b.root, b.policy);
  bestanden(lauf(b.root));
  assert.notEqual(b.policy.skript_hashes['scripts/agent-code-job-gemeinsam.mjs'], FIXTURE['scripts/agent-code-job-gemeinsam.mjs']);

  // Fall C (A6.4-4): Der geschuetzte Workflow vergleicht vor dem Start den Pruefer mit einem fest
  // genehmigten Hash und liest die Policy nur aus der geschuetzten Quelle. Gegen diesen Anker, hier
  // nachgestellt durch die Driftfixture als Stellvertreter, faellt die Manipulation aus Fall B auf.
  // Das ist nur eine Veranschaulichung; die Fixture selbst ist kein Sicherheitsanker.
  assert.notDeepEqual(b.policy.skript_hashes, FIXTURE);
});

test('Lokaler Import im Pruefer: fremder Code liefe vor jeder Hashpruefung', () => {
  // Darum verbietet die Quelltextwache jeden lokalen Import. Nachweis an einer Kopie: Das importierte
  // Modul hinterlaesst eine Marke, obwohl sein Hash nicht passt und der Pruefer danach ablehnt.
  const { root } = baum();
  const marke = join(root, 'marke');
  writeFileSync(join(root, 'scripts', 'agent-code-zusatz.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marke)}, 'lief');\n`);
  const mutiert = SOURCE.replace("import { join } from 'node:path';\n", "import { join } from 'node:path';\nimport './agent-code-zusatz.mjs';\n");
  assert.ok(quellProbleme(mutiert).includes('lokales Modul'));
  writeFileSync(join(root, 'scripts', PRUEFER), mutiert);
  abgelehnt(lauf(root), 'skript-ohne-hash');
  assert.equal(readFileSync(marke, 'utf8'), 'lief', 'der importierte Code lief vor der Pruefung');
});
