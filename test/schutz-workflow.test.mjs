// A6.4-3c: Regressionstest des echten Pruefschritts aus .github/workflows/schutz.yml.
//
// Kein zweiter Algorithmus: Der Test schneidet den einzigen run-Block des einzigen Jobs strukturell
// aus der echten YAML-Datei, schreibt ihn unveraendert in eine Wegwerfdatei und fuehrt ihn wie
// GitHub mit `bash --noprofile --norc -eo pipefail` aus. Aendert sich der Workflow, aendert sich
// damit das gepruefte Verhalten.
//
// Abgeschottet: Der PATH zeigt auf einen leeren Wegwerfordner. gh, grep, cut und sort sind Bash-
// Funktionen aus einer Wegwerfdatei, die bash ueber BASH_ENV vor dem Block liest; grep, cut und sort
// rufen ihr Programm mit absolutem Pfad auf. So muss nichts im Wegwerfordner ausfuehrbar sein (die
// isolierten CI-Container haengen /tmp mit noexec ein), und ein echtes gh ist nicht erreichbar.
// Der Fake kennt genau die drei erwarteten API-Aufrufe in fester Reihenfolge samt
// --jq-Ausdruck, beantwortet sie aus synthetischen Daten (TSV wie jq @tsv) und lehnt jeden anderen
// Aufruf mit Exitcode 97 ab. Kein Token, kein Netz, kein GitHub-Zugriff, kein Schreiben ausserhalb
// der Wegwerfordner, kein eval, Dateinamen sind nur Daten.
//
// Was dieser Test NICHT zeigt: das echte Verhalten von gh und jq (Seitenbildung, Fehlertexte),
// die echte GitHub-Ereignissteuerung, Rulesets und CODEOWNERS. Der Workflow laeuft bei
// pull_request in der Fassung des PR selbst; dieser Test ersetzt diese Vertrauensgrenze nicht.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'schutz.yml');
// Genehmigter Eigentuemerstand (A6.4-3c). Jede Aenderung an schutz.yml faellt hier auf.
const WORKFLOW_SHA256 = '46d5958e6345c19a7999ca0e1544093b4aade4291422d1ef90b4753037ac4ec5';

const IS_WINDOWS = process.platform === 'win32';
const GIT_WIN = 'C:\\Program Files\\Git';
const BASH = IS_WINDOWS ? join(GIT_WIN, 'usr', 'bin', 'bash.exe') : '/bin/bash';
const WERKZEUGE = ['grep', 'cut', 'sort'];
const posix = p => (IS_WINDOWS ? p.replace(/^([A-Za-z]):\\/, (_, l) => `/${l.toLowerCase()}/`).replace(/\\/g, '/') : p);
const vorwaerts = p => p.replace(/\\/g, '/');

const REPO = 'noah04091/agenten-probe';
const NR = '73';
const HEAD = 'e'.repeat(40);
const ANDERER_HEAD = 'f'.repeat(40);
const BOT = 'noah04091-agent';
const NOAH = 'noah04091';
const JQ_PR = '"\\(.changed_files) \\(.head.sha)"';
const JQ_DATEIEN = '.[] | [.filename, (.previous_filename // "")] | @tsv';
const ARGS_PR = ['api', `repos/${REPO}/pulls/${NR}`, '--jq', JQ_PR];
const ARGS_DATEIEN = ['api', '--paginate', `repos/${REPO}/pulls/${NR}/files?per_page=100`, '--jq', JQ_DATEIEN];

const TRENN = 'FEHLER: Profile oder Abnahmedateien nur allein und nur in einem Bereich aendern';
const GESCHUETZT = 'FEHLER: geschuetzte Datei geaendert durch';
const EINDEUTIG = 'FEHLER: Dateiliste nicht eindeutig';
const UNVOLLSTAENDIG = 'FEHLER: Liste unvollstaendig';
const GEAENDERT = 'FEHLER: PR hat sich waehrend der Pruefung geaendert';
const CF_UNBEKANNT = 'FEHLER: changed_files unbekannt';
const PLAN = 'docs/agenten-system-masterplan.md';

// ---------------------------------------------------------------------------------------------
// Strukturelles Ausschneiden des run-Blocks. Bricht bei jeder unerwarteten Struktur ab.

function runBlock(yaml) {
  assert.ok(!yaml.includes('\r'), 'schutz.yml enthaelt CR');
  assert.ok(!yaml.includes('\t'), 'schutz.yml enthaelt Tabulatoren');
  const z = yaml.split('\n');
  const genau = (re, text) => {
    const n = z.filter(l => re.test(l)).length;
    assert.equal(n, 1, `${text}: ${n} statt genau 1`);
    return z.findIndex(l => re.test(l));
  };
  const jobs = genau(/^jobs:\s*$/, 'jobs');
  const jobNamen = z.slice(jobs + 1).filter(l => /^ {2}[^ #]/.test(l));
  assert.deepEqual(jobNamen, ['  schutzdateien:'], 'genau ein Job namens schutzdateien');
  assert.ok(z.slice(jobs + 1).every(l => !/^\S/.test(l) || l === ''), 'nach jobs folgt kein weiterer Abschnitt');
  genau(/^ {4}name: schutzdateien$/, 'Jobanzeige schutzdateien');
  genau(/^ {4}steps:\s*$/, 'steps');
  genau(/^ {6}- /, 'Schritt');
  assert.equal(z.filter(l => /^\s*-?\s*run\s*:/.test(l)).length, 1, 'genau ein run-Schluessel');
  genau(/^ {8}shell: bash$/, 'shell: bash');
  const run = genau(/^ {8}run: \|$/, 'run: |');
  const env = genau(/^ {8}env:$/, 'env');
  assert.ok(env < run, 'env steht vor run');
  const envSchluessel = [];
  for (let i = env + 1; i < run && /^ {10}\S/.test(z[i]); i++) envSchluessel.push(z[i].trim().split(':')[0]);
  assert.deepEqual(envSchluessel, ['GH_TOKEN', 'REPO', 'NR', 'AUTOR', 'HEAD_SHA'], 'env des Schritts');
  const block = [];
  let i = run + 1;
  for (; i < z.length; i++) {
    if (z[i] === '') { block.push(''); continue; }
    if (!z[i].startsWith(' '.repeat(10))) break;
    block.push(z[i].slice(10));
  }
  assert.ok(z.slice(i).every(l => l === ''), 'nach dem run-Block folgt nichts mehr');
  while (block.length && block[block.length - 1] === '') block.pop();
  assert.ok(block.length > 10, 'run-Block zu kurz');
  assert.equal(block[0], 'set -euo pipefail', 'run-Block beginnt mit set -euo pipefail');
  const text = `${block.join('\n')}\n`;
  assert.ok(!text.includes('${{'), 'run-Block enthaelt Ausdruecke');
  return text;
}

// Ein Windows-Checkout mit core.autocrlf liefert CRLF; Git speichert LF. Gehasht und geprueft wird LF.
const WORKFLOW_TEXT = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------------------------
// gh-Fake. Argumente: Szenariodatei, Protokolldatei, danach die gh-Argumente.

const FAKE = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const [szenarioPfad, logPfad, ...args] = process.argv.slice(2);
const szenario = JSON.parse(readFileSync(szenarioPfad, 'utf8'));
const bisher = existsSync(logPfad) ? readFileSync(logPfad, 'utf8').split('\n').filter(Boolean).length : 0;
const schritt = szenario.schritte[bisher];
const gleich = schritt && JSON.stringify(schritt.args) === JSON.stringify(args);
appendFileSync(logPfad, JSON.stringify({ args, unerwartet: !gleich }) + '\n');
if (!gleich) { process.stderr.write('GH-FAKE: unerwarteter Aufruf ' + JSON.stringify(args) + '\n'); process.exit(97); }
const a = schritt.antwort;
if (a.fehler) { process.stderr.write('HTTP 502: synthetischer Fehler\n'); process.exit(1); }
if ('roh' in a) { process.stdout.write(a.roh); process.exit(0); }
if ('changed_files' in a) { process.stdout.write(a.changed_files + ' ' + a.head_sha + '\n'); process.exit(0); }
const tsv = s => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
for (const d of a.dateien) process.stdout.write(tsv(d.filename) + '\t' + tsv(d.previous_filename ?? '') + '\n');
`;

function umgebung(dir, { mitGh = true, ghRumpf = null } = {}) {
  const leer = join(dir, 'leer');
  mkdirSync(leer);
  const fake = join(dir, 'gh-fake.mjs');
  const szenario = join(dir, 'szenario.json');
  const log = join(dir, 'aufrufe.log');
  writeFileSync(fake, FAKE);
  const funktionen = [];
  for (const w of WERKZEUGE) {
    const quelle = IS_WINDOWS ? join(GIT_WIN, 'usr', 'bin', `${w}.exe`) : `/usr/bin/${w}`;
    assert.ok(existsSync(quelle), `${w} fehlt unter ${quelle}`);
    funktionen.push(`${w}() { /usr/bin/${w} "$@"; }`);
  }
  const ghAufruf = `'${posix(process.execPath)}' '${vorwaerts(fake)}' '${vorwaerts(szenario)}' '${vorwaerts(log)}' "$@"`;
  if (mitGh) funktionen.push(`gh() { ${ghRumpf ?? ghAufruf}; }`);
  const bashEnv = join(dir, 'umgebung.sh');
  writeFileSync(bashEnv, `${funktionen.join('\n')}\n`);
  return { fake, szenario, log, path: posix(leer), bashEnv: vorwaerts(bashEnv) };
}

function fuehreAus(fall, workflowText = WORKFLOW_TEXT) {
  const dir = mkdtempSync(join(tmpdir(), 'schutz-workflow-'));
  try {
    const u = umgebung(dir, fall.umgebung);
    const schritte = [
      { args: ARGS_PR, antwort: fall.pr1 },
      { args: ARGS_DATEIEN, antwort: fall.liste },
      { args: ARGS_PR, antwort: fall.pr2 },
    ];
    writeFileSync(u.szenario, JSON.stringify({ schritte }));
    const skript = join(dir, 'pruefschritt.sh');
    writeFileSync(skript, runBlock(workflowText));
    const env = {
      PATH: u.path, BASH_ENV: u.bashEnv, HOME: dir, LC_ALL: 'C.UTF-8', MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*',
      GH_TOKEN: 'synthetisch-kein-token', REPO, NR: fall.nr ?? NR, AUTOR: fall.autor, HEAD_SHA: HEAD,
    };
    if (IS_WINDOWS) env.SYSTEMROOT = process.env.SYSTEMROOT;
    const o = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', vorwaerts(skript)], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(o.error, undefined, `bash nicht ausfuehrbar: ${o.error}`);
    const aufrufe = existsSync(u.log) ? readFileSync(u.log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    return { status: o.status, stdout: o.stdout, stderr: o.stderr, aufrufe };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Faelle

const d = (filename, previous_filename) => (previous_filename === undefined ? { filename } : { filename, previous_filename });
const pr = (dateien, head = HEAD) => ({ changed_files: dateien.length, head_sha: head });

function fall(name, autor, dateien, erwartet, abweichung = {}) {
  return { name, autor, pr1: pr(dateien), liste: { dateien }, pr2: pr(dateien), erwartet, ...abweichung };
}
const bestanden = n => ({ status: 0, meldung: `Pruefung bestanden: ${n} von ${n} Dateien geprueft.`, aufrufe: 3 });
const fehler = (meldung, aufrufe = 2) => ({ status: 1, meldung, aufrufe });

const P_A = 'agent-profiles/js-rechner.json';
const P_B = 'agent-profiles/js-text.json';
const A_A = 'agent-acceptance/issue-38.mjs';
const A_B = 'agent-acceptance/issue-41.mjs';

const POSITIV = [
  fall('P01 normaler PR mit src/ und test/', BOT, [d('src/rechne.js'), d('test/rechne.test.js')], bestanden(2)),
  fall('P02 ein Profil', BOT, [d(P_A)], bestanden(1)),
  fall('P03 mehrere Profile', BOT, [d(P_A), d(P_B), d('agent-profiles/js-neu.json')], bestanden(3)),
  fall('P04 eine Abnahmedatei', BOT, [d(A_A)], bestanden(1)),
  fall('P05 mehrere Abnahmedateien', BOT, [d(A_A), d(A_B)], bestanden(2)),
  fall('P06 Umbenennung innerhalb agent-profiles/', BOT, [d(P_B, 'agent-profiles/js-alt.json')], bestanden(1)),
  fall('P07 Umbenennung innerhalb agent-acceptance/', BOT, [d(A_B, A_A)], bestanden(1)),
  fall('P08 Eigentuemer-PR mit schutz.yml und Masterplan', NOAH, [d('.github/workflows/schutz.yml'), d(PLAN)], bestanden(2)),
  fall('P09 aehnliches Verzeichnis agent-profiles-x/ mit src/', BOT, [d('agent-profiles-x/a.json'), d('src/rechne.js')], bestanden(2)),
  fall('P10 Autorregel positiv: Noah aendert Policy und package.json', NOAH, [d('.github/agent/policy.json'), d('package.json'), d('src/rechne.js')], bestanden(3)),
  fall('P11 Sonderzeichen im Profilnamen (Leerzeichen, Umlaut, Tab, Backslash, Zeilenumbruch)', BOT,
    [d('agent-profiles/ä ö.json'), d('agent-profiles/a\tb.json'), d('agent-profiles/c\\d.json'), d('agent-profiles/e\nsrc/f.json')], bestanden(4)),
  // A6 P-1, KA: Praefix-Gegenprobe fuer den Abnahmebereich, wie P09 fuer die Profile.
  fall('P12 aehnliches Verzeichnis agent-acceptance-x/ mit src/', BOT, [d('agent-acceptance-x/a.mjs'), d('src/rechne.js')], bestanden(2)),
  // A6 P-1, KB: PR mit 0 gemeldeten und 0 gelisteten Dateien. Das heutige Verhalten (bestanden) wird hier
  // festgeschrieben, nicht bewertet; jede Aenderung daran faellt auf.
  fall('P13 Null-Dateien-Fall: 0 gemeldet, 0 gelistet', BOT, [], bestanden(0)),
];

const NEGATIV = [
  fall('N01 Profil plus src/', BOT, [d(P_A), d('src/rechne.js')], fehler(TRENN)),
  fall('N02 Profil plus test/', BOT, [d(P_A), d('test/rechne.test.js')], fehler(TRENN)),
  fall('N03 Profil plus .github/ durch den Bot (Autorregel greift zuerst)', BOT, [d(P_A), d('.github/workflows/tests.yml')], fehler(GESCHUETZT, 2)),
  fall('N04 Profil plus .github/ durch Noah', NOAH, [d(P_A), d('.github/workflows/tests.yml')], fehler(TRENN)),
  fall('N05 Profil plus Masterplan durch Noah', NOAH, [d(P_A), d(PLAN)], fehler(TRENN)),
  fall('N06 Abnahme plus src/', BOT, [d(A_A), d('src/rechne.js')], fehler(TRENN)),
  fall('N07 Abnahme plus test/', BOT, [d(A_A), d('test/rechne.test.js')], fehler(TRENN)),
  fall('N08 Abnahme plus Workflow durch Noah', NOAH, [d(A_A), d('.github/workflows/schutz.yml')], fehler(TRENN)),
  fall('N09 Profil plus Abnahme', BOT, [d(P_A), d(A_A)], fehler(TRENN)),
  fall('N10 Umbenennung aus agent-profiles/ nach src/', BOT, [d('src/rechner.json', P_A)], fehler(TRENN)),
  fall('N11 Umbenennung aus src/ nach agent-acceptance/', BOT, [d(A_B, 'src/abnahme.mjs')], fehler(TRENN)),
  fall('N12 Umbenennung aus agent-profiles/ nach agent-acceptance/', BOT, [d(A_B, P_A)], fehler(TRENN)),
  fall('N13 doppelter API-Eintrag', BOT, [d('src/rechne.js'), d('src/rechne.js')], fehler(EINDEUTIG)),
  fall('N14 widerspruechliche API-Eintraege (gleicher Name, anderer alter Name)', BOT, [d('src/b.js', 'src/a.js'), d('src/b.js', 'src/c.js')], fehler(EINDEUTIG)),
  fall('N15 unvollstaendige Dateiliste', BOT, [d('src/rechne.js'), d(P_A)], fehler(UNVOLLSTAENDIG, 2),
    { liste: { dateien: [d('src/rechne.js')] } }),
  fall('N16 leere Dateiliste bei zwei gemeldeten Dateien', BOT, [d('src/rechne.js'), d('test/rechne.test.js')], fehler(UNVOLLSTAENDIG, 2),
    { liste: { dateien: [] } }),
  fall('N17 Kopf-SHA am Anfang falsch', BOT, [d('src/rechne.js')], fehler(GEAENDERT, 1),
    { pr1: { changed_files: 1, head_sha: ANDERER_HEAD } }),
  fall('N18 Kopf-SHA nach dem Dateilistenabruf geaendert', BOT, [d('src/rechne.js')], fehler(GEAENDERT, 3),
    { pr2: { changed_files: 1, head_sha: ANDERER_HEAD } }),
  fall('N19 Dateianzahl nach dem Dateilistenabruf geaendert', BOT, [d('src/rechne.js')], fehler(GEAENDERT, 3),
    { pr2: { changed_files: 2, head_sha: HEAD } }),
  fall('N20 API-Fehler beim ersten PR-Abruf', BOT, [d('src/rechne.js')], { status: 1, stderr: 'HTTP 502', aufrufe: 1 },
    { pr1: { fehler: true } }),
  fall('N21 API-Fehler bei der Dateiliste', BOT, [d('src/rechne.js')], { status: 1, stderr: 'HTTP 502', aufrufe: 2 },
    { liste: { fehler: true } }),
  fall('N22 API-Fehler beim abschliessenden PR-Abruf', BOT, [d('src/rechne.js')], { status: 1, stderr: 'HTTP 502', aufrufe: 3 },
    { pr2: { fehler: true } }),
  fall('N23 Sonderzeichen: Zeilenumbruch taeuscht einen Profilpfad vor, Datei liegt in src/', BOT,
    [d(P_A), d('src/a\nagent-profiles/b.json')], fehler(TRENN)),
  fall('N24 Sonderzeichen: Profil plus src-Datei mit Tab und Backslash', BOT, [d('agent-profiles/a\tb.json'), d('src/c\\d.js')], fehler(TRENN)),
  fall('N25 gh-Fake liefert unbrauchbare Antwort', BOT, [d('src/rechne.js')], fehler(CF_UNBEKANNT, 1),
    { pr1: { roh: 'kaputt\n' } }),
  fall('N26 gh-Fake fehlt', BOT, [d('src/rechne.js')], { status: 127, stderr: 'gh: command not found', aufrufe: 0 },
    { umgebung: { mitGh: false } }),
  fall('N27 gh-Fake bricht ohne Ausgabe ab', BOT, [d('src/rechne.js')], { status: 3, aufrufe: 0 },
    { umgebung: { ghRumpf: 'return 3' } }),
  fall('N28 Autorregel: Bot aendert einen Workflow', BOT, [d('.github/workflows/tests.yml'), d('src/rechne.js')], fehler(GESCHUETZT, 2)),
  fall('N29 Autorregel: Bot benennt package.json um (alter Name geschuetzt)', BOT, [d('src/paket.json', 'package.json')], fehler(GESCHUETZT, 2)),
  fall('N30 Autorregel: Bot aendert schutz.yml und Masterplan', BOT, [d('.github/workflows/schutz.yml'), d(PLAN)], fehler(GESCHUETZT, 2)),
  fall('N31 ungueltige PR-Nummer', BOT, [d('src/rechne.js')], fehler('FEHLER: PR-Nummer unbekannt', 0), { nr: '73;x' }),
  fall('N32 mehr als 3000 Dateien gemeldet', BOT, [d('src/rechne.js')], fehler('FEHLER: mehr als 3000 Dateien', 1),
    { pr1: { changed_files: 3001, head_sha: HEAD } }),
];

function pruefeFall(f, r) {
  const e = f.erwartet;
  const zeilen = r.stdout.split('\n').filter(Boolean);
  const kontext = `\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
  assert.equal(r.status, e.status, `Exitcode${kontext}`);
  assert.equal(r.aufrufe.length, e.aufrufe, `Zahl der gh-Aufrufe${kontext}`);
  assert.ok(r.aufrufe.every(a => !a.unerwartet), `unerwarteter gh-Aufruf${kontext}`);
  const fehlerZeilen = zeilen.filter(l => l.startsWith('FEHLER'));
  if (e.meldung && e.status === 0) assert.equal(zeilen.at(-1), e.meldung, `letzte Meldung${kontext}`);
  if (e.meldung && e.status !== 0) {
    assert.equal(fehlerZeilen.length, 1, `genau eine FEHLER-Zeile${kontext}`);
    assert.ok(fehlerZeilen[0].startsWith(e.meldung), `Sperre statt "${e.meldung}"${kontext}`);
  }
  if (!e.meldung) assert.equal(fehlerZeilen.length, 0, `keine FEHLER-Zeile erwartet${kontext}`);
  if (e.stderr) assert.ok(r.stderr.includes(e.stderr), `stderr ohne "${e.stderr}"${kontext}`);
  if (e.status !== 0) assert.ok(!r.stdout.includes('Pruefung bestanden'), `Erfolgsmeldung trotz Fehler${kontext}`);
  else assert.equal(zeilen.filter(l => l.startsWith('Pruefung bestanden')).length, 1);
}

// ---------------------------------------------------------------------------------------------
// Tests

test('Struktur: schutz.yml ist der genehmigte Stand mit genau einem Job, einem Schritt und einem run-Block', () => {
  assert.equal(createHash('sha256').update(WORKFLOW_TEXT).digest('hex'), WORKFLOW_SHA256);
  const block = runBlock(WORKFLOW_TEXT);
  assert.ok(/^on:\n {2}pull_request:\n/m.test(WORKFLOW_TEXT), 'Ausloeser ist pull_request');
  assert.ok(!WORKFLOW_TEXT.includes('pull_request_target'), 'kein pull_request_target');
  assert.ok(!/actions\/checkout|uses:/.test(WORKFLOW_TEXT), 'kein Checkout und keine Aktion');
  assert.equal((block.match(/\bgh /g) ?? []).length, 3, 'genau drei gh-Aufrufe im Pruefschritt');
});

test('Struktur: veraenderter Jobname, doppelter oder fehlender run-Block wird erkannt', () => {
  const varianten = {
    'Jobname': WORKFLOW_TEXT.replace('  schutzdateien:\n', '  schutz:\n'),
    'Jobanzeige': WORKFLOW_TEXT.replace('    name: schutzdateien\n', '    name: schutz\n'),
    'zweiter Job': `${WORKFLOW_TEXT}  zweiter:\n    runs-on: ubuntu-24.04\n`,
    'zweiter Schritt': `${WORKFLOW_TEXT}      - name: x\n        run: echo x\n`,
    'run ohne Literalblock': WORKFLOW_TEXT.replace('        run: |\n', '        run: >\n'),
    'kein run-Block': WORKFLOW_TEXT.replace('        run: |\n', '        script: |\n'),
    'Ausdruck im Block': WORKFLOW_TEXT.replace('set -euo pipefail\n', 'set -euo pipefail\n          echo "${{ github.token }}"\n'),
    'Block ohne set -euo': WORKFLOW_TEXT.replace('set -euo pipefail\n', 'set -u\n'),
    'zusaetzliche env': WORKFLOW_TEXT.replace('          HEAD_SHA:', '          EXTRA: x\n          HEAD_SHA:'),
    'CRLF': WORKFLOW_TEXT.replace(/\n/g, '\r\n'),
  };
  for (const [name, text] of Object.entries(varianten)) {
    assert.notEqual(text, WORKFLOW_TEXT, `Variante ${name} nicht angewendet`);
    assert.throws(() => runBlock(text), assert.AssertionError, `Variante ${name} nicht erkannt`);
  }
});

test('gh-Fake: jeder unbekannte oder ueberzaehlige Aufruf scheitert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'schutz-fake-'));
  try {
    const u = umgebung(dir);
    writeFileSync(u.szenario, JSON.stringify({ schritte: [{ args: ARGS_PR, antwort: { changed_files: 1, head_sha: HEAD } }] }));
    const ruf = args => spawnSync(process.execPath, [u.fake, u.szenario, u.log, ...args], { encoding: 'utf8' });
    for (const args of [
      ['api', `repos/${REPO}/pulls/${NR}/reviews`],
      ['api', `repos/${REPO}/pulls/${NR}`, '--jq', '.head.sha'],
      ['api', '-X', 'POST', `repos/${REPO}/pulls/${NR}`, '--jq', JQ_PR],
      ['pr', 'view', NR],
    ]) {
      rmSync(u.log, { force: true });
      const o = ruf(args);
      assert.equal(o.status, 97, JSON.stringify(args));
      assert.match(o.stderr, /GH-FAKE: unerwarteter Aufruf/);
    }
    rmSync(u.log, { force: true });
    assert.equal(ruf(ARGS_PR).status, 0);
    assert.equal(ruf(ARGS_PR).status, 97, 'zweiter Aufruf ueber das Szenario hinaus');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const f of POSITIV) test(`Schutzworkflow positiv: ${f.name}`, () => pruefeFall(f, fuehreAus(f)));
for (const f of NEGATIV) test(`Schutzworkflow negativ: ${f.name}`, () => pruefeFall(f, fuehreAus(f)));

