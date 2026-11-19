// Ziel A, Live-1-Fix (19.11.2026). Live-1-Lauf 44509846928: Job 2 lud das Repository flach (fetch-depth 1),
// der Pruefklon der Abnahme erbte .git/shallow, die unveraenderte Strukturpruefung lehnte mit
// abnahme-git-struktur ab. Der Fix laedt Job 2 vollstaendig (fetch-depth 0). Diese Datei sichert:
//   1. Struktur: genau diese eine Zeile im Live-Teil, alles andere byte-gleich mit main 27c7989.
//   2. Generalprobe Job 2 laedt wortgleich wie Job 2 und prueft am echten Checkout den Klon des Moduls.
//   3. Verhalten: der Generalprobe-Schritt wortgleich in bash mit echtem git, vollstaendig gruen, flach rot.
// Der Regressionstest gegen das echte Abnahmemodul steht in agent-code-auftrag-abnahme.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lies = pfad => readFileSync(join(ROOT, pfad), 'utf8').replace(/\r\n/g, '\n');
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const WF = lies('entwurf/a6-p1/agent-auftrag.yml');
const AUSWEICH = lies('entwurf/a6-p1/ausweich/code-pilot-trockenlauf.yml');

// SHA-256 der Live-Teile von .github/workflows/agent-auftrag.yml auf main 27c7989 (Zeilenenden LF), wie im
// K1-Test: alles vor dem Abschnitt Generalprobe und der Sammeljob.
const LIVE_VORN_MAIN_SHA256 = '65c642af5f55133a7d4ab5866b231d107e933ea1e75626a512feafc895b9f303';
const LIVE_SAMMEL_SHA256 = '437b6cddaac1291e463a009980a26af91a997f65df35c28f347a24b104415ac7';
const TRENNER = '  # -------------------------------------------------------------------------------------------------\n';

const CHECKOUT_JOB2 = [
  '      - name: Repository laden',
  '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  '        with:',
  '          persist-credentials: false',
  '          ref: ${{ github.sha }}',
  '          fetch-depth: 0',
  '',
].join('\n');
const TIEFE = '          fetch-depth: 0\n';
const PRUEF_NAME = 'Pruefklon gegen den echten Checkout wie in Job 2, flache Gegenprobe';

// Fixture-Fix nach Live 1, Versuch 2: A6_PROBE_SHA256 in der globalen Umgebung folgt generalprobe/probe.mjs. Kein
// Live-Job liest ihn (nur a6_probe in den Probejobs). Fuer den Vergleich mit main darf nur genau diese eine
// Definition in der globalen Umgebung abweichen; die Bindung an probe.mjs prueft a6-auftrag-workflow.test.mjs.
const PROBE_ANKER_MAIN = '  A6_PROBE_SHA256: 2cad8a9e00512e41b8fddd222df60562e2978544dd97e1600e2cb3ee45f31ca7\n';

function mitProbeAnkerVonMain(vorn) {
  const treffer = [...vorn.matchAll(/^ {2}A6_PROBE_SHA256: [0-9a-f]{64}\n/gm)];
  const env = vorn.indexOf('\nenv:\n');
  const jobs = vorn.indexOf('\njobs:\n');
  assert.ok(treffer.length === 1 && vorn.split('A6_PROBE_SHA256').length === 2, 'Probeanker nicht genau einmal');
  assert.ok(env > 0 && treffer[0].index > env && treffer[0].index < jobs, 'Probeanker nicht in der globalen Umgebung');
  return vorn.slice(0, treffer[0].index) + PROBE_ANKER_MAIN + vorn.slice(treffer[0].index + treffer[0][0].length);
}

function liveTeile(text) {
  const g = text.indexOf(`${TRENNER}  # Generalprobe:`);
  const s = text.indexOf(`${TRENNER}  # Sammeljob`);
  assert.ok(g > 10_000 && s > g && text.indexOf(`${TRENNER}  # Generalprobe:`, g + 1) < 0, 'Abschnitte nicht eindeutig');
  return { vorn: text.slice(0, g), sammel: text.slice(s) };
}

// Text eines Jobs bis zum naechsten Job oder Abschnittstrenner.
function job(text, name) {
  const s = text.indexOf(`\n  ${name}:\n`);
  assert.ok(s > 0 && text.indexOf(`\n  ${name}:\n`, s + 1) < 0, `Job ${name} nicht genau einmal`);
  const ende = /\n {2}(?:[a-z_]+:\n|# -{10})/g;
  ende.lastIndex = s + 1;
  const m = ende.exec(text);
  return text.slice(s + 1, m ? m.index + 1 : text.length);
}

const schritte = jobText => jobText.split(/\n(?= {6}- name: )/).slice(1).map(t => t.replace(/\n(\n| {6}#[^\n]*\n)*$/, '\n'));
const schrittName = s => /^ {6}- name: (.+)$/m.exec(s)?.[1];

function pruefSchritt(text = WF) {
  const alle = schritte(job(text, 'probe_abnahme'));
  const namen = alle.map(schrittName);
  assert.equal(namen.filter(n => n === PRUEF_NAME).length, 1, 'Pruefklon-Schritt fehlt oder doppelt');
  assert.equal(namen.indexOf(PRUEF_NAME), 1, 'Pruefklon-Schritt nicht direkt nach dem Checkout');
  return { checkout: alle[0], schritt: alle[1] };
}

function pruefSkript(text = WF) {
  const zeilen = pruefSchritt(text).schritt.split('\n');
  const start = zeilen.indexOf('        run: |');
  assert.ok(start > 0, 'run-Block fehlt');
  return zeilen.slice(start + 1).filter(z => z === '' || z.startsWith('          ')).map(z => z.slice(10)).join('\n');
}

// ---------------------------------------------------------------------------
// Teil 1: Struktur
// ---------------------------------------------------------------------------

test('Live-1-Fix Struktur: Job 2 laedt mit fetch-depth 0, sonst ist der Live-Teil byte-gleich mit main 27c7989 (bis auf den Probeanker)', () => {
  const { vorn, sammel } = liveTeile(WF);
  const abnahme = job(WF, 'abnahme');
  assert.equal(schritte(abnahme)[0], CHECKOUT_JOB2, 'Checkout von Job 2 nicht genau wie freigegeben');
  // Genau zweimal im ganzen Entwurf: Job 2 und Generalprobe Job 2. Kein anderer Job aendert seine Tiefe.
  const schluessel = text => (text.match(/^ +fetch-depth:/gm) ?? []).length;
  assert.equal(schluessel(WF), 2);
  assert.equal(schluessel(vorn), 1);
  for (const name of ['auftrag', 'claude', 'veroeffentlichen']) {
    assert.ok(!job(WF, name).includes('fetch-depth'), `${name}: Tiefe veraendert`);
  }
  // Ohne genau diese Zeile ist der Live-Teil der von main; Sammeljob unveraendert.
  const at = vorn.indexOf(`          ref: \${{ github.sha }}\n${TIEFE}`, vorn.indexOf('\n  abnahme:\n'));
  assert.ok(at > 0 && at < vorn.indexOf('\n  veroeffentlichen:\n'), 'Zeile nicht in Job 2');
  const ohne = mitProbeAnkerVonMain(vorn.slice(0, at) + vorn.slice(at).replace(TIEFE, ''));
  assert.equal(sha256(ohne), LIVE_VORN_MAIN_SHA256, 'Live-Teil weicht ausser in der Tiefe von main ab');
  assert.equal(sha256(sammel), LIVE_SAMMEL_SHA256);
});

test('Live-1-Fix Struktur: Generalprobe Job 2 laedt wortgleich wie Job 2 und prueft den Klon des Moduls', () => {
  const live = schritte(job(WF, 'abnahme'))[0];
  const { checkout, schritt } = pruefSchritt();
  assert.equal(checkout, live, 'Generalprobe laedt anders als Job 2');
  // Nur run, keine Aktion, keine Geheimnisse.
  assert.deepEqual(schritt.split('\n').filter(z => /^ {8}[a-z-]+:/.test(z)).map(z => z.trim().split(':')[0]), ['run']);
  assert.ok(!/secrets\.|\$\{\{/.test(schritt));
  // Derselbe Klon wie im Modul: dieselben Schalter in derselben Reihenfolge, leere Vorlage.
  const modul = lies('scripts/agent-code-auftrag-abnahme.mjs');
  assert.ok(modul.includes("'clone', '--no-local', '--no-hardlinks', '--no-checkout', '--quiet', `--template=${session.template}`, '--', trusted, session.checkout,"), 'Muss-Treffer im Modul');
  const skript = pruefSkript();
  assert.equal(skript.split('git clone --no-local --no-hardlinks --no-checkout --quiet "--template=$K/vorlage" -- ').length - 1, 2);
  // Erst die Pruefung des echten Checkouts, dann die Gegenprobe; jede Erwartung als eigener test-Befehl.
  const folge = [
    'set -euo pipefail',
    'test "$(git rev-parse --is-shallow-repository)" = "false"',
    'test ! -e .git/shallow',
    '-- "$GITHUB_WORKSPACE" "$K/voll"',
    'test ! -e "$K/voll/.git/shallow"',
    '--depth=1 "file://$GITHUB_WORKSPACE" "$(git rev-parse HEAD)"',
    'test "$(git -C "$K/flach-quelle" rev-parse --is-shallow-repository)" = "true"',
    '-- "$K/flach-quelle" "$K/flach"',
    'test -e "$K/flach/.git/shallow"',
  ];
  let pos = -1;
  for (const teil of folge) {
    const i = skript.indexOf(teil, pos + 1);
    assert.ok(i > pos, `Reihenfolge: ${teil}`);
    assert.equal(skript.split(teil).length - 1, 1, `nicht genau einmal: ${teil}`);
    pos = i;
  }
  assert.ok(!/\|\| true|\|\| :|set \+e/.test(skript), 'Fehler wird verschluckt');
  // Die Ausweichloesung traegt Generalprobe Job 2 wortgleich.
  assert.equal(job(AUSWEICH, 'probe_abnahme').replace(/\n+$/, '\n'), job(WF, 'probe_abnahme').replace(/\n+$/, '\n'));
});

// ---------------------------------------------------------------------------
// Teil 2: Verhalten mit echtem git (bash, kein Windows-Pfad in file://)
// ---------------------------------------------------------------------------

const BASH = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0;
const OHNE_BASH = BASH ? false : 'braucht bash und git unter Linux (file://-Pfade); laeuft in CI';

function umgebung(home) {
  return {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'leer.gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

// Quelle mit zwei Commits, damit Tiefe 1 wirklich flach ist. Danach der Nachbau von actions/checkout mit den
// Befehlen aus dem Log von Lauf 44509846928 (Job 2): init, remote, Abruf mit oder ohne --depth=1, checkout.
function aufbau(basis, tiefe) {
  const env = umgebung(join(basis, 'home'));
  mkdirSync(join(basis, 'home'), { recursive: true });
  writeFileSync(join(basis, 'home', 'leer.gitconfig'), '');
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const quelle = join(basis, 'quelle');
  mkdirSync(quelle);
  git(quelle, ['init', '-q', '-b', 'main']);
  for (const n of [1, 2]) {
    writeFileSync(join(quelle, 'datei.txt'), `Stand ${n}\n`);
    git(quelle, ['add', 'datei.txt']);
    git(quelle, ['commit', '-q', '-m', `Stand ${n}`]);
  }
  const sha = git(quelle, ['rev-parse', 'HEAD']);
  const ws = join(basis, 'arbeit');
  git(basis, ['init', '-q', ws]);
  git(ws, ['remote', 'add', 'origin', pathToFileURL(quelle).href]);
  git(ws, ['config', '--local', 'gc.auto', '0']);
  git(ws, tiefe === 1
    ? ['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', '--prune', '--no-recurse-submodules', '--depth=1', 'origin', sha]
    : ['-c', 'protocol.version=2', 'fetch', '-q', '--prune', '--no-recurse-submodules', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']);
  git(ws, ['checkout', '-q', '--force', sha]);
  return { ws, env };
}

function fuehreAus(skript, tiefe) {
  const basis = mkdtempSync(join(tmpdir(), 'a6-tiefe-'));

  try {
    const { ws, env } = aufbau(basis, tiefe);
    mkdirSync(join(basis, 'runner-temp'));
    const r = spawnSync('bash', ['-c', skript], {
      cwd: ws, encoding: 'utf8', timeout: 60_000,
      env: { ...env, GITHUB_WORKSPACE: ws, RUNNER_TEMP: join(basis, 'runner-temp') },
    });
    return { status: r.status, out: r.stdout, err: r.stderr, flachKlon: existsSync(join(basis, 'runner-temp', 'a6-probe-pruefklon', 'flach', '.git', 'shallow')) };
  } finally {
    rmSync(basis, { recursive: true, force: true });
  }
}

test('Live-1-Fix Verhalten: Pruefklon-Schritt wortgleich, vollstaendiger Checkout gruen, flacher Checkout rot', { skip: OHNE_BASH }, () => {
  const skript = pruefSkript();

  // Positiv: Checkout wie mit fetch-depth 0. Beide Pruefungen laufen, die Gegenprobe traegt shallow.
  const voll = fuehreAus(skript, 0);
  assert.equal(voll.status, 0, voll.err);
  assert.equal(voll.out, 'Pruefklon: vollstaendiger Checkout, kein .git/shallow.\nGegenprobe: flacher Checkout, der Pruefklon traegt .git/shallow.\n');
  assert.ok(voll.flachKlon, 'Gegenprobe ohne .git/shallow im Klon');

  // Negativ: Rueckbau auf fetch-depth 1. Der Schritt scheitert an der ersten Pruefung, nichts wird gemeldet.
  const flach = fuehreAus(skript, 1);
  assert.notEqual(flach.status, 0, 'flacher Checkout nicht erkannt');
  assert.equal(flach.out, '');

  // Negativ: eine wirkungslose Gegenprobe (Abruf ohne --depth=1) wird selbst rot.
  const ohneTiefe = skript.replace(' --depth=1 ', ' ');
  assert.notEqual(ohneTiefe, skript);
  const leer = fuehreAus(ohneTiefe, 0);
  assert.notEqual(leer.status, 0, 'wirkungslose Gegenprobe nicht erkannt');
  assert.equal(leer.out, 'Pruefklon: vollstaendiger Checkout, kein .git/shallow.\n');
});
