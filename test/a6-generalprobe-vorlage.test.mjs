// A6 Fixture-Fix nach Live 1, Versuch 2: Die Generalprobe arbeitet mit einer festen Rechner-Vorlage.
//
// Anlass: Der erste echte Auftrag (Issue #78, Lauf 44536520447, PR #96) hat src/rechne.js fachlich
// korrekt um quadrat(a) erweitert. Danach fand das feste Testpaket der Generalprobe seine Exportzeile
// nicht mehr ("Generalprobe: Exportzeile in src/rechne.js nicht gefunden"). Seit diesem Fix ersetzt
// baueRepo im synthetischen Repository src/rechne.js und test/rechne.test.js durch die Vorlage aus
// generalprobe/vorlage/, gelesen aus dem Commit und nur mit festem SHA-256.
//
// Was dieser Test NICHT zeigt: die Probejobs in echten GitHub Actions (erst auf dem Eigentuemer-PR mit
// dem neuen A6_PROBE_SHA256), Container und Netz.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { schreibeTestpaket } from '../generalprobe/claude-ersatz.mjs';
import { VORLAGE, baueRepo, kette, nf2, pruefeAnfragen } from '../generalprobe/probe.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANKER = createHash('sha256').update(readFileSync(join(ROOT, 'scripts', 'agent-code-integritaet.mjs'))).digest('hex');
const BASIS_DIR = mkdtempSync(join(tmpdir(), 'a6-generalprobe-vorlage-'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

after(() => rmSync(BASIS_DIR, { recursive: true, force: true }));

// Zweite, unabhaengige Festschreibung: Git-Blob-IDs der Vorlage (Rechner vor dem ersten Live-Auftrag)
// und des Ergebnisses aus PR #96. Eine Aenderung nur in probe.mjs macht diesen Test rot.
const VORLAGE_BLOB = Object.freeze({
  'src/rechne.js': '796a4ef32bff24ffd913bf2d0f888b7a6a2adc42',
  'test/rechne.test.js': '43c20fdb9201d42497b3ed1f7b75fa5becdadc9b',
});
const PR96_BLOB = Object.freeze({
  'src/rechne.js': 'f85e427b998b70ff9768e14205f165656ad3b856',
  'test/rechne.test.js': '3986614217f5844259e7dce5be3aca040ec74750',
});

// Nur lesend auf den vertrauenswuerdigen Checkout, wie NUR_LESEN in probe.mjs: im Container des Trockenlaufs
// gehoert /work einem anderen Benutzer. Ausnahme genau fuer ROOT, nicht pauschal. Als eigene globale Datei,
// weil git beim lokalen Klonen "-c"-Werte nicht an upload-pack weitergibt (GIT_CONFIG_PARAMETERS wird entfernt).
const GLOBAL = join(BASIS_DIR, 'gitconfig');
const wurzel = resolve(ROOT).replaceAll('\\', '/');
writeFileSync(GLOBAL, `[safe]\n\tdirectory = ${wurzel}\n\tdirectory = ${wurzel}/.git\n`);
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL, GIT_AUTHOR_NAME: 'Probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'Probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid' };
const git = (cwd, args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitBytes = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

function ersetzeEinmal(text, alt, neu) {
  assert.equal(text.split(alt).length, 2, `nicht eindeutig: ${alt}`);
  return text.replace(alt, () => neu);
}

// Der Stand aus PR #96, hergeleitet aus der Vorlage und per Git-Blob-ID gegen den echten PR-Kopf belegt.
function pr96Dateien() {
  const rechne = readFileSync(join(ROOT, VORLAGE['src/rechne.js'].quelle), 'utf8');
  const tests = readFileSync(join(ROOT, VORLAGE['test/rechne.test.js'].quelle), 'utf8');
  const dateien = {
    'src/rechne.js': ersetzeEinmal(rechne, 'module.exports = { addiere, subtrahiere, multipliziere };',
      'function quadrat(a) {\n  return a * a;\n}\n\nmodule.exports = { addiere, subtrahiere, multipliziere, quadrat };'),
    'test/rechne.test.js': ersetzeEinmal(tests, "const { addiere, subtrahiere, multipliziere } = require('../src/rechne');\n",
      [
        "const { addiere, subtrahiere, multipliziere, quadrat } = require('../src/rechne');",
        '',
        "test('quadrat entspricht a * a', () => {",
        '  assert.strictEqual(quadrat(3), 9);',
        '  assert.strictEqual(quadrat(-4), 16);',
        '  assert.strictEqual(quadrat(0), 0);',
        '  assert.strictEqual(quadrat(-0), -0 * -0);',
        '  assert.strictEqual(quadrat(0.5), 0.25);',
        '  assert.strictEqual(quadrat(Infinity), Infinity);',
        '  assert.strictEqual(quadrat(-Infinity), Infinity);',
        '  assert.strictEqual(quadrat(NaN), NaN);',
        '  assert.strictEqual(quadrat(1e200), 1e200 * 1e200);',
        '});',
        '',
      ].join('\n')),
  };

  for (const [pfad, text] of Object.entries(dateien)) {
    assert.equal(blobId(Buffer.from(text, 'utf8')), PR96_BLOB[pfad], `${pfad} entspricht nicht PR #96`);
  }

  return dateien;
}

// Quelle mit eigenem Commit ueber HEAD: jede Datei aus aenderungen geschrieben, dann committet.
function quelleMit(name, aenderungen, { nachCommit } = {}) {
  const dir = join(BASIS_DIR, name);
  git(ROOT, ['clone', '-q', '--no-local', '--no-hardlinks', resolve(ROOT), dir]);
  git(dir, ['checkout', '-q', '--detach', git(ROOT, ['rev-parse', 'HEAD']).trim()]);

  for (const [pfad, inhalt] of Object.entries(aenderungen)) {
    if (inhalt === null) {
      git(dir, ['rm', '-q', '--', pfad]);
    } else {
      writeFileSync(join(dir, pfad), inhalt);
      git(dir, ['add', '--', pfad]);
    }
  }

  nachCommit?.(dir);
  git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `Probe: ${name}`]);
  return dir;
}

let PR96_DIR;

// main nach der Eigentuemer-Uebernahme: Policy aus dem Entwurf (neuer Hash fuer agent-code-dryrun.mjs),
// dazu der Rechner aus PR #96. Nach der Uebernahme sind Entwurf und .github/agent/policy.json gleich.
// Erst bei Bedarf gebaut, damit ein Fehler hier nur die Tests trifft, die diese Quelle brauchen.
function pr96Quelle() {
  PR96_DIR ??= quelleMit('pr96', { ...pr96Dateien(), '.github/agent/policy.json': readFileSync(join(ROOT, 'entwurf', 'a6-p1', 'policy.json')) });
  return PR96_DIR;
}

test('Vorlage: im Commit, fester SHA-256 und dieselben Bytes wie der Rechner vor dem ersten Live-Auftrag', () => {
  const profil = JSON.parse(readFileSync(join(ROOT, 'agent-profiles', 'js-rechner.json'), 'utf8'));
  assert.deepEqual(Object.keys(VORLAGE), profil.dateien);
  assert.deepEqual(readdirSync(join(ROOT, 'generalprobe', 'vorlage')).sort(), ['rechne.js.vorlage', 'rechne.test.js.vorlage']);

  for (const [pfad, { quelle, sha256: erwartet }] of Object.entries(VORLAGE)) {
    const bytes = gitBytes(ROOT, ['show', `HEAD:${quelle}`]);
    assert.equal(sha256(bytes), erwartet, `${quelle}: SHA-256`);
    assert.equal(blobId(bytes), VORLAGE_BLOB[pfad], `${quelle}: Git-Blob-ID`);
    assert.ok(!bytes.includes(0x0d), `${quelle} enthaelt CR`);
    assert.equal(git(ROOT, ['ls-tree', 'HEAD', '--', quelle]).split(' ')[0], '100644');
  }
});

test('Vorlage: kein Agentenprofil, kein Live-Skript, keine Abnahme und kein Workflow kennt sie', () => {
  for (const name of readdirSync(join(ROOT, 'agent-profiles'))) {
    const profil = JSON.parse(readFileSync(join(ROOT, 'agent-profiles', name), 'utf8'));
    assert.ok(profil.dateien.length > 0 && profil.dateien.every(p => !p.startsWith('generalprobe/')), name);
  }

  const dateienUnter = dir => readdirSync(join(ROOT, dir), { recursive: true }).map(p => join(dir, String(p))).filter(p => statSync(join(ROOT, p)).isFile());
  const geprueft = [...dateienUnter('scripts'), ...dateienUnter('agent-acceptance'), ...dateienUnter('.github'), ...dateienUnter('entwurf'),
    'generalprobe/claude-ersatz.mjs', 'generalprobe/github-attrappe.mjs'];
  assert.ok(geprueft.some(p => p.replaceAll('\\', '/') === 'scripts/agent-code-auftrag-abnahme.mjs'), 'Muss-Treffer: Abnahmemodul geprueft');
  assert.ok(geprueft.some(p => p.replaceAll('\\', '/') === 'agent-acceptance/issue-78.mjs'), 'Muss-Treffer: echte Abnahme geprueft');
  assert.ok(geprueft.some(p => p.replaceAll('\\', '/') === '.github/workflows/agent-auftrag.yml'), 'Muss-Treffer: Workflow geprueft');

  for (const pfad of geprueft) {
    assert.ok(!readFileSync(join(ROOT, pfad), 'utf8').includes('vorlage/rechne'), `${pfad} verweist auf die Vorlage`);
  }

  // Muss-Treffer der Suche selbst: der Harness verweist darauf.
  assert.ok(readFileSync(join(ROOT, 'generalprobe', 'probe.mjs'), 'utf8').includes('generalprobe/vorlage/rechne.js.vorlage'));
});

test('PR #96 auf main: altes Testpaket scheitert wie in CI, mit Vorlage laeuft die Kette, NF2 bleibt rot', () => {
  // Muss-Treffer: ohne Vorlage genau die bisherige Fehlermeldung aus der CI von PR #96.
  const direkt = join(BASIS_DIR, 'direkt');
  git(pr96Quelle(), ['worktree', 'add', '-q', '--detach', direkt]);
  assert.throws(() => schreibeTestpaket(direkt), /^Error: Generalprobe: Exportzeile in src\/rechne\.js nicht gefunden$/);

  const e = kette(join(BASIS_DIR, 'kette-pr96'), { quelle: pr96Quelle(), anker: ANKER });
  assert.deepEqual(pruefeAnfragen(e), []);
  assert.match(e.paket, /^[0-9a-f]{64}$/);

  // Synthetischer Ausgangscommit traegt die Vorlage, nicht den Rechner aus PR #96.
  for (const pfad of Object.keys(VORLAGE)) {
    assert.equal(blobId(gitBytes(e.checkout, ['show', `HEAD:${pfad}`])), VORLAGE_BLOB[pfad], pfad);
  }

  // Das Testpaket ist die feste quadrat-Aenderung relativ zur Vorlage.
  const paket = JSON.parse(e.paketBytes.toString('utf8'));
  const rechne = paket.dateien.find(d => d.pfad === 'src/rechne.js');
  assert.ok(rechne !== undefined);
  // Vorlage plus feste Aenderung ergibt byte-gleich den Rechner aus PR #96, quadrat also genau einmal.
  assert.equal(blobId(Buffer.from(rechne.base64, 'base64')), PR96_BLOB['src/rechne.js']);

  // Die Quelle selbst bleibt der Stand aus PR #96.
  assert.equal(blobId(gitBytes(pr96Quelle(), ['show', 'HEAD:src/rechne.js'])), PR96_BLOB['src/rechne.js']);

  // NF2: fachlich falscher Code wird auch auf diesem Stand von der Abnahme abgelehnt.
  const n = nf2(join(BASIS_DIR, 'nf2-pr96'), { quelle: pr96Quelle(), anker: ANKER });
  assert.equal(n.r.status, 1);
  assert.equal(n.code, 'abnahme-exitcode');
});

test('Vorlage manipuliert, fehlend, mit falschem Modus oder nur im Arbeitsordner: nachvollziehbarer Abbruch', () => {
  const quelle = VORLAGE['src/rechne.js'].quelle;
  const original = readFileSync(join(ROOT, quelle));
  const ein = Buffer.from(original);
  ein[ein.indexOf('a * b')] = 'c'.charCodeAt(0);
  assert.equal(ein.length, original.length);

  const faelle = [
    ['manipuliert', quelleMit('vorlage-manipuliert', { [quelle]: ein }), /^Generalprobe: Vorlage generalprobe\/vorlage\/rechne\.js\.vorlage weicht vom festen SHA-256 ab$/],
    ['fehlend', quelleMit('vorlage-fehlend', { [quelle]: null }), /^Generalprobe: Vorlage generalprobe\/vorlage\/rechne\.js\.vorlage fehlt im Commit$/],
    ['ausfuehrbar', quelleMit('vorlage-modus', {}, { nachCommit: dir => git(dir, ['update-index', '--chmod=+x', '--', quelle]) }), /^Generalprobe: Vorlage generalprobe\/vorlage\/rechne\.js\.vorlage hat nicht den Modus 100644$/],
    ['test-fehlt', quelleMit('test-fehlt', { 'test/rechne.test.js': null }), /^Generalprobe: test\/rechne\.test\.js fehlt im Commit$/],
  ];

  for (const [name, dir, meldung] of faelle) {
    assert.throws(() => baueRepo(dir, join(BASIS_DIR, `repo-${name}`)), err => meldung.test(err.message), name);
  }

  // Nur im Arbeitsordner manipuliert: zaehlt nicht, gelesen wird der Commit.
  const arbeit = quelleMit('vorlage-arbeitsordner', {});
  writeFileSync(join(arbeit, quelle), ein);
  const ziel = join(BASIS_DIR, 'repo-arbeitsordner');
  baueRepo(arbeit, ziel);
  assert.equal(blobId(gitBytes(ziel, ['show', 'HEAD:src/rechne.js'])), VORLAGE_BLOB['src/rechne.js']);

  // Gegenprobe: unveraenderte Quelle baut ohne Fehler.
  baueRepo(pr96Quelle(), join(BASIS_DIR, 'repo-ok'));
});

test('Eigentuemer-Entwurf Policy: gegenueber .github/agent/policy.json nur der Hash von agent-code-dryrun.mjs', () => {
  const SKRIPT = 'scripts/agent-code-dryrun.mjs';
  const entwurfBytes = readFileSync(join(ROOT, 'entwurf', 'a6-p1', 'policy.json'));
  const entwurf = JSON.parse(entwurfBytes.toString('utf8'));
  const produktiv = JSON.parse(readFileSync(join(ROOT, '.github', 'agent', 'policy.json'), 'utf8'));
  assert.equal(`${JSON.stringify(entwurf, null, 2)}\n`, entwurfBytes.toString('utf8'), 'Entwurf nicht kanonisch');
  assert.equal(entwurf.skript_hashes[SKRIPT], sha256(readFileSync(join(ROOT, SKRIPT))), 'Entwurf traegt nicht den echten Hash');

  // Vor der Uebernahme genau eine Abweichung, danach keine.
  const abweichend = Object.keys(entwurf.skript_hashes).filter(k => entwurf.skript_hashes[k] !== produktiv.skript_hashes[k]);
  assert.ok(abweichend.length === 0 || (abweichend.length === 1 && abweichend[0] === SKRIPT), `abweichend: ${abweichend.join(', ')}`);
  assert.deepEqual(Object.keys(entwurf.skript_hashes), Object.keys(produktiv.skript_hashes));
  assert.deepEqual({ ...entwurf, skript_hashes: null }, { ...produktiv, skript_hashes: null });
});
