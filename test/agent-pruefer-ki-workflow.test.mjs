// B2.3a Freigabeschranke ohne KI-Aufruf: Wachen fuer den geschuetzten Workflow .github/workflows/agent-pruefer-ki.yml.
// Der Workflow kommt nur ueber den Eigentuemer-PR. Fehlt er im Klon, werden diese Tests sichtbar uebersprungen (Grund im
// Testbericht), nie gruen gezaehlt; die Liste der Workflows in a8-einziger-agentenpfad.test.mjs ist dann rot.
//   - Hash-Anker A6_PRUEFER_KI_WORKFLOW_SHA256 und feste Liste der Gruende
//   - der run-Block beider Jobs wird aus der Datei gelesen und mit bash gegen ein nachgebautes gh ausgefuehrt (eigener
//     PATH, Protokoll aller Aufrufe, nur GET). Jeder Rot-Fall: genau eine Logzeile mit festem Grund, Exitcode 1, keine
//     Ausgaben. Muss-Treffer: der pruefbare Fall ist gruen und setzt alle Ausgaben.
//   - echtes Log des Laufs 45397511852 (Job 138457104840) als Fixture
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WF_PFAD = join(ROOT, '.github', 'workflows', 'agent-pruefer-ki.yml');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'pruefer-ki', 'job-138457104840-lauf-45397511852.log');
const sha256 = b => createHash('sha256').update(b).digest('hex');
// SHA-256 des genehmigten agent-pruefer-ki.yml (Zeilenenden LF). Jede andere Fassung ist rot.
const A6_PRUEFER_KI_WORKFLOW_SHA256 = 'aed43d68b65e2a0682dd182970428348e9cd6792dce3b3f968fd0f46efbffc0c';
// SHA-256 des echten Logs (von Terminal 1 gelesen, Token maskiert).
const FIXTURE_SHA256 = '5301f65865867d9259be674635e6103a8769c8a51155f8bec27e0df13fdd89a8';

const DA = existsSync(WF_PFAD);
const OHNE_PATCH = DA ? false : 'Eigentuemer-Patch fehlt (.github/workflows/agent-pruefer-ki.yml, B2.3a): uebersprungen, nicht gruen';
const WERKZEUG = spawnSync('bash', ['-c', 'for w in jq sed grep stat mktemp; do command -v "$w" >/dev/null || exit 1; done; sed --version | grep -q GNU && echo ja'], { encoding: 'utf8' });
const WERKZEUG_DA = WERKZEUG.status === 0 && WERKZEUG.stdout.trim() === 'ja';
const OHNE_LAUF = OHNE_PATCH || (WERKZEUG_DA ? false : 'bash, jq oder GNU-Werkzeuge fehlen: Ausfuehrung uebersprungen, nicht gruen');
const WF = () => readFileSync(WF_PFAD, 'utf8').replace(/\r\n/g, '\n');

export const GRUENDE = [
  'konfig-nicht-lesbar', 'konfig-fehlt', 'konfig-abweichung', 'quelle-format', 'quelle-nicht-lesbar', 'quelle-herkunft',
  'quelle-nicht-erfolgreich', 'veralteter-versuch', 'job-fehlt', 'job-mehrdeutig', 'job-nicht-erfolgreich', 'log-nicht-lesbar',
  'zeile-fehlt', 'zeile-mehrdeutig', 'zeile-ungueltig', 'kein-auftrag', 'nicht-pruefbar', 'ausstehend', 'pr-unbekannt',
  'pr-nicht-lesbar', 'pr-nicht-offen', 'pr-herkunft', 'kopf-geaendert', 'verlauf-nicht-lesbar', 'verlauf-unvollstaendig',
  'verlauf-widerspruch', 'zu-viele-laeufe', 'zu-viele-abfragen', 'parallel-lauf', 'bereits-freigegeben',
];

// Jobs: Bloecke unter "jobs:" mit genau zwei Leerzeichen Einzug.
export function jobs(text) {
  const teil = text.split('\njobs:\n');
  assert.equal(teil.length, 2, 'Block "jobs:" nicht genau einmal');
  const bloecke = {};
  for (const b of teil[1].split(/\n(?= {2}[a-z_]+:\n)/)) {
    const m = /^ {2}([a-z_]+):\n/.exec(b);
    if (m) bloecke[m[1]] = `${b}\n`;
  }
  return bloecke;
}

// Der eine run-Block eines Jobs, Einzug entfernt.
export function runBlock(job) {
  const m = [...job.matchAll(/\n {8}run: \|\n((?:(?: {10}.*)?\n)+)/g)];
  assert.equal(m.length, 1, 'genau ein run-Block');
  return m[0][1].split('\n').map(z => z.slice(10)).join('\n').replace(/\n+$/, '\n');
}

export function stepEnv(job) {
  const m = /\n {8}env:\n((?: {10}[A-Z0-9_]+: .*\n)+)/.exec(job);
  assert.ok(m, 'env-Block fehlt');
  return m[1].trim().split('\n').map(z => z.trim());
}

// ---------------------------------------------------------------------------------------------------------------
// Nachgebautes gh: nur "gh api --method GET [-H ...] [--allow-escape-sequences] <pfad>". Antworten aus einer Datei,
// unbekannter Pfad: 404 wie das echte gh ("gh: Not Found (HTTP 404)" auf stderr, Exitcode 1). Enthaelt die Antwort
// Steuerzeichen und fehlt --allow-escape-sequences, verweigert es die Ausgabe wie das echte gh (Befund T1).
// ---------------------------------------------------------------------------------------------------------------

const GH_ATTRAPPE = `import { appendFileSync, readFileSync } from 'node:fs';
const [antwortenDatei, protokoll, ...args] = process.argv.slice(2);
appendFileSync(protokoll, JSON.stringify(args) + '\\n');
const raus = (code, text) => { appendFileSync(protokoll, JSON.stringify(['ATTRAPPE', code, text]) + '\\n'); process.stderr.write(text + '\\n'); process.exit(code); };
if (args[0] !== 'api') raus(2, 'VERSTOSS nur gh api');
let methode = null; let esc = false; let pfad = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--method') methode = args[++i];
  else if (a === '-H') { const h = args[++i]; if (h !== 'Accept: application/vnd.github+json' && h !== 'X-GitHub-Api-Version: 2022-11-28') raus(2, 'VERSTOSS Kopfzeile ' + h); }
  else if (a === '--allow-escape-sequences') esc = true;
  else if (a.startsWith('-')) raus(2, 'VERSTOSS Schalter ' + a);
  else if (pfad === null) pfad = a;
  else raus(2, 'VERSTOSS zweiter Pfad');
}
if (methode !== 'GET') raus(2, 'VERSTOSS nur GET');
const antworten = JSON.parse(readFileSync(antwortenDatei, 'utf8'));
const a = Object.hasOwn(antworten, pfad) ? antworten[pfad] : null;
if (a === null) { process.stdout.write('{"message":"Not Found"}'); raus(1, 'gh: Not Found (HTTP 404)'); }
if (a.status !== 200) { process.stdout.write('{"message":"Fehler"}'); raus(1, 'gh: Fehler (HTTP ' + a.status + ')'); }
const inhalt = Buffer.from(a.b64, 'base64');
if (inhalt.includes(27) && !esc) raus(1, 'the response contains terminal escape sequences');
process.stdout.write(inhalt);
`;

const ESC = String.fromCharCode(27);
const REPO = 'noah04091/agenten-probe';
const R = `repos/${REPO}`;
const LAUF = 45500000001;
const JOB = 138500000001;
const PR = 140;
const AUFTRAG = 45400000001;
const KOPF = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c';
const KOPF2 = '9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d';
const BASIS = '6fbebf1ee853996878cc4876d216538eae50e85d';
const WFSHA = '70dff873bfe9186680eef552e33e1e1d01f4a4dd';
const EIGEN = 45600000009;
const BOT = 'noah04091-agenten-probe-cloud-bot[bot]';
const PFAD_LAEUFE = `${R}/actions/workflows/agent-pruefer-ki.yml/runs?per_page=100`;

const fixtureText = () => readFileSync(FIXTURE, 'latin1');
const ECHTE_ZEILE = /^(2026-11-24T12:51:37\.2077048Z )A6-PRUEFER repo .*$/m;
// Das echte Log mit einer anderen echten Zeile (Zeile 217); alles andere bleibt, auch die eingerueckte Skriptzeile.
function logMit(zeile) {
  const t = fixtureText();
  assert.equal(t.match(new RegExp(ECHTE_ZEILE.source, 'gm')).length, 1, 'Muss-Treffer: echte Zeile im Fixture');
  return zeile === null ? t.replace(new RegExp(`${ECHTE_ZEILE.source}\\n`, 'm'), '') : t.replace(ECHTE_ZEILE, (_, z) => `${z}${zeile}`);
}
const pzeile = ({ pr = PR, kopf = KOPF, lauf = AUFTRAG, ergebnis = 'keine-auffaelligkeiten' } = {}) =>
  `A6-PRUEFER repo ${REPO} pr ${pr} kopf ${kopf} basis ${BASIS} lauf ${lauf} ergebnis ${ergebnis} befunde 0 hinweise 1`;
const schrankeLog = (pr = PR, kopf = KOPF, quelle = '45500000000-1') => [
  `2026-11-25T08:00:00.1000000Z ##[group]Run set -euo pipefail`,
  `2026-11-25T08:00:00.1000001Z ${ESC}[36;1mecho "A6-PRUEFER-SCHRANKE repo noah04091/agenten-probe quelle $A6_KI_QUELLE auftrag $A6_KI_AUFTRAG pr $A6_KI_PR kopf $A6_KI_KOPF workflow-sha $GITHUB_SHA ereignis $A6_KI_EREIGNIS freigegeben"${ESC}[0m`,
  `2026-11-25T08:00:01.2000000Z A6-PRUEFER-SCHRANKE repo ${REPO} quelle ${quelle} auftrag ${AUFTRAG} pr ${pr} kopf ${kopf} workflow-sha ${WFSHA} ereignis workflow_run freigegeben`,
  '',
].join('\n');

const json = body => ({ status: 200, b64: Buffer.from(JSON.stringify(body), 'utf8').toString('base64') });
const roh = text => ({ status: 200, b64: Buffer.from(text, 'latin1').toString('base64') });

// Ausgangsfall: pruefbarer Gegenstand, Weg workflow_run, keine frueheren KI-Laeufe.
function grundfall({ ereignis = 'workflow_run' } = {}) {
  const sz = { ereignis, lauf: String(LAUF), versuch: '1', runId: String(EIGEN), runAttempt: '1', sha: WFSHA, antworten: {} };
  const a = sz.antworten;
  a[`${R}/environments/claude-pruefer`] = json({
    id: 28418332669, node_id: 'EN_x', name: 'claude-pruefer', url: 'x', html_url: 'x', created_at: 'x', updated_at: 'x',
    can_admins_bypass: false,
    protection_rules: [
      { id: 1, node_id: 'GA_1', prevent_self_review: false, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'noah04091', id: 196186596, type: 'User' } }] },
      { id: 2, node_id: 'GA_2', type: 'branch_policy' },
    ],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
  a[`${R}/environments/claude-pruefer/deployment-branch-policies`] = json({ total_count: 1, branch_policies: [{ id: 3, node_id: 'DBP_3', name: 'main', type: 'branch' }] });
  a[`${R}/actions/runs/${LAUF}`] = json({
    id: LAUF, workflow_id: 429024670, path: '.github/workflows/agent-pruefer.yml', head_branch: 'main', event: 'workflow_run',
    status: 'completed', conclusion: 'success', run_attempt: 1,
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, triggering_actor: { login: BOT, type: 'Bot' },
  });
  a[`${R}/actions/runs/${LAUF}/attempts/1/jobs?per_page=100`] = json({
    total_count: 1, jobs: [{ id: JOB, run_id: LAUF, run_attempt: 1, name: 'Vorpruefung Agenten-PR', status: 'completed', conclusion: 'success' }],
  });
  a[`${R}/actions/jobs/${JOB}/logs`] = roh(logMit(pzeile()));
  a[`${R}/pulls/${PR}`] = json({
    number: PR, state: 'open', merged: false, draft: true,
    head: { sha: KOPF, ref: `wp/139-agent-${AUFTRAG}-1`, repo: { full_name: REPO } },
    base: { ref: 'main', sha: BASIS, repo: { full_name: REPO } },
    user: { login: BOT, type: 'Bot' },
  });
  verlauf(sz, []);
  return sz;
}

// Verlauf des KI-Workflows: der eigene Lauf (mit frueheren Versuchen) und weitere Laeufe. versuche: je Versuch die Jobs
// [{ name, conclusion, log }]. Liefert die Antworten fuer Liste, Versuche, Jobs je Versuch, filter=all und Logs.
let jobZaehler = 200000000001;
function verlauf(sz, laeufe, { eigeneVersuche = [] } = {}) {
  const a = sz.antworten;
  sz.runAttempt = String(eigeneVersuche.length + 1);
  const alle = [{ id: EIGEN, status: 'in_progress', versuche: eigeneVersuche, eigen: true }, ...laeufe];
  a[PFAD_LAEUFE] = json({
    total_count: alle.length,
    workflow_runs: alle.map(l => ({ id: l.id, run_attempt: l.eigen ? eigeneVersuche.length + 1 : l.versuche.length, status: l.status ?? 'completed', conclusion: l.eigen ? null : 'failure' })),
  });

  for (const l of alle) {
    const gesamt = [];
    l.versuche.forEach((liste, i) => {
      const n = i + 1;
      a[`${R}/actions/runs/${l.id}/attempts/${n}`] = json({ id: l.id, run_attempt: n, status: 'completed' });
      const js = liste.map(j => {
        const id = jobZaehler++;
        if (j.log !== undefined) a[`${R}/actions/jobs/${id}/logs`] = roh(j.log);
        return { id, run_id: l.id, run_attempt: n, name: j.name, status: 'completed', conclusion: j.conclusion };
      });
      a[`${R}/actions/runs/${l.id}/attempts/${n}/jobs?per_page=100`] = json({ total_count: js.length, jobs: js });
      gesamt.push(...js);
    });
    if (l.eigen) gesamt.push({ id: jobZaehler++, run_id: l.id, run_attempt: eigeneVersuche.length + 1, name: 'schranke_vorpruefung', status: 'in_progress', conclusion: null });
    a[`${R}/actions/runs/${l.id}/jobs?filter=all&per_page=100`] = json({ total_count: gesamt.length, jobs: gesamt });
  }
}

const VJ = { name: 'schranke_vorpruefung', conclusion: 'success' };
const VJ_ROT = { name: 'schranke_vorpruefung', conclusion: 'failure' };
const S_OK = (pr = PR, kopf = KOPF) => ({ name: 'schranke', conclusion: 'success', log: schrankeLog(pr, kopf) });
const S_ABGELEHNT = { name: 'schranke', conclusion: 'failure' };
const S_UEBERSPRUNGEN = { name: 'schranke', conclusion: 'skipped' };

// Antwort aendern: JSON lesen, Funktion anwenden, zurueckschreiben.
function aendere(sz, pfad, f) {
  const alt = sz.antworten[pfad];
  assert.ok(alt, `Muss-Treffer: Antwort ${pfad} vorhanden`);
  const body = JSON.parse(Buffer.from(alt.b64, 'base64').toString('utf8'));
  const neu = f(body);
  sz.antworten[pfad] = json(neu === undefined ? body : neu);
}

// ---------------------------------------------------------------------------------------------------------------
// Ausfuehrung
// ---------------------------------------------------------------------------------------------------------------

const TEMP = mkdtempSync(join(tmpdir(), 'a6-ki-'));
let fallNr = 0;

function vorbereiten(skript, env) {
  const dir = join(TEMP, `f${fallNr++}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'runner'));
  writeFileSync(join(dir, 'gh.mjs'), GH_ATTRAPPE);
  writeFileSync(join(dir, 'antworten.json'), JSON.stringify(env.antworten ?? {}));
  writeFileSync(join(dir, 'protokoll.jsonl'), '');
  writeFileSync(join(dir, 'ausgabe'), '');
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'gh.mjs')}' '${join(dir, 'antworten.json')}' '${join(dir, 'protokoll.jsonl')}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'skript.sh'), skript);
  return dir;
}

const BASH = WERKZEUG_DA ? spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() : 'bash';

// ohneJq: PATH enthaelt nur das nachgebaute gh und mktemp, grep, sed, stat, aber kein jq.
function ausfuehren(skript, umgebung, antworten, { ohneJq = false } = {}) {
  const dir = vorbereiten(skript, { antworten });
  let pfad = `${join(dir, 'bin')}:/usr/local/bin:/usr/bin:/bin`;
  if (ohneJq) {
    mkdirSync(join(dir, 'werkzeug'));
    for (const w of ['mktemp', 'grep', 'sed', 'stat']) {
      const ziel = spawnSync('bash', ['-c', `command -v ${w}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(ziel, join(dir, 'werkzeug', w));
    }
    pfad = `${join(dir, 'bin')}:${join(dir, 'werkzeug')}`;
  }
  const env = {
    PATH: pfad, HOME: dir, RUNNER_TEMP: join(dir, 'runner'), GITHUB_OUTPUT: join(dir, 'ausgabe'),
    ...umgebung,
  };
  return new Promise(resolve => {
    const p = spawn(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail', join(dir, 'skript.sh')], { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    const uhr = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('close', status => {
      clearTimeout(uhr);
      const protokoll = readFileSync(join(dir, 'protokoll.jsonl'), 'utf8').split('\n').filter(Boolean).map(z => JSON.parse(z));
      resolve({ status, stdout, stderr, ausgabe: readFileSync(join(dir, 'ausgabe'), 'utf8'), protokoll });
    });
  });
}

function vorjob(sz, optionen) {
  const j = jobs(WF()).schranke_vorpruefung;
  return ausfuehren(runBlock(j), {
    GH_TOKEN: 'attrappe-ohne-geheimnis', A6_KI_EREIGNIS: sz.ereignis, A6_KI_LAUF: sz.lauf, A6_KI_VERSUCH: sz.versuch,
    GITHUB_RUN_ID: sz.runId, GITHUB_RUN_ATTEMPT: sz.runAttempt, GITHUB_SHA: sz.sha, GITHUB_REPOSITORY: REPO,
  }, sz.antworten, optionen);
}

function schranke(werte) {
  const j = jobs(WF()).schranke;
  return ausfuehren(runBlock(j), { GITHUB_REPOSITORY: REPO, ...werte }, {});
}

// Faelle parallel, hoechstens acht zugleich.
async function alle(faelle, f) {
  const ergebnisse = new Array(faelle.length);
  let i = 0;
  const arbeiter = async () => {
    while (i < faelle.length) {
      const k = i++;
      ergebnisse[k] = await f(faelle[k]);
    }
  };
  await Promise.all(Array.from({ length: 8 }, arbeiter));
  return ergebnisse;
}

function nurGet(r, was) {
  for (const z of r.protokoll) {
    assert.notEqual(z[0], 'ATTRAPPE', `${was}: Attrappe meldet ${JSON.stringify(z)}`.slice(0, 300));
  }
  assert.ok(!r.protokoll.some(z => z[0] === 'ATTRAPPE' && /VERSTOSS/.test(z[2])), `${was}: Verstoss`);
}

function nurGetErlaubtFehler(r, was) {
  assert.ok(!r.protokoll.some(z => z[0] === 'ATTRAPPE' && /VERSTOSS/.test(String(z[2]))), `${was}: Verstoss gegen nur GET`);
  assert.ok(r.protokoll.filter(z => z[0] !== 'ATTRAPPE').every(z => z[0] === 'api' && z[1] === '--method' && z[2] === 'GET'), `${was}: nur gh api --method GET`);
}

const zeileRot = (quelle, grund) => `A6-PRUEFER-SCHRANKE repo ${REPO} quelle ${quelle} ergebnis keine-anfrage grund ${grund}\n`;

function istRot(r, grund, was, quelle = `${LAUF}-1`) {
  assert.equal(r.stdout, zeileRot(quelle, grund), `${was}: ${r.stdout}${r.stderr}`.slice(0, 600));
  assert.equal(r.status, 1, `${was}: Exitcode`);
  assert.equal(r.ausgabe, '', `${was}: keine Ausgaben`);
  nurGetErlaubtFehler(r, was);
}

async function pruefeFaelle(faelle) {
  const ergebnisse = await alle(faelle, ([, sz]) => vorjob(sz));
  faelle.forEach(([was, , grund, quelle], k) => istRot(ergebnisse[k], grund, was, quelle));
}

const gruenAusgabe = (quelle = `${LAUF}-1`, pr = PR, kopf = KOPF) => `quelle=${quelle}\nauftrag=${AUFTRAG}\npr=${pr}\nkopf=${kopf}\n`;
function istGruen(r, was, { quelle = `${LAUF}-1`, pr = PR, kopf = KOPF } = {}) {
  assert.equal(r.stdout, `A6-PRUEFER-SCHRANKE repo ${REPO} quelle ${quelle} auftrag ${AUFTRAG} pr ${pr} kopf ${kopf} ergebnis anfrage\n`, `${was}: ${r.stdout}${r.stderr}`.slice(0, 600));
  assert.equal(r.status, 0, `${was}: Exitcode`);
  assert.equal(r.ausgabe, gruenAusgabe(quelle, pr, kopf), `${was}: Ausgaben`);
  nurGet(r, was);
}

// ---------------------------------------------------------------------------------------------------------------
// Datei, Anker, Gruende
// ---------------------------------------------------------------------------------------------------------------

test('KI-Schranke: genehmigter Stand (Hash-Anker), Fixture unveraendert', { skip: OHNE_PATCH }, () => {
  assert.equal(sha256(Buffer.from(WF(), 'utf8')), A6_PRUEFER_KI_WORKFLOW_SHA256, 'agent-pruefer-ki.yml ist nicht der genehmigte Stand');
  assert.equal(sha256(readFileSync(FIXTURE)), FIXTURE_SHA256, 'Fixture veraendert');
  assert.ok(!/\r/.test(readFileSync(WF_PFAD, 'utf8')), 'Zeilenenden LF');
});

test('KI-Schranke: Schritt-Umgebung fest, GH_TOKEN nur im Vorjob, kein Ausdruck im run-Text, Ausgaben nur aus dem Pruefschritt', { skip: OHNE_PATCH }, () => {
  const j = jobs(WF());
  assert.deepEqual(Object.keys(j), ['schranke_vorpruefung', 'schranke']);
  assert.deepEqual(stepEnv(j.schranke_vorpruefung), [
    'GH_TOKEN: ${{ github.token }}',
    'A6_KI_EREIGNIS: ${{ github.event_name }}',
    "A6_KI_LAUF: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.id || inputs.lauf }}",
    "A6_KI_VERSUCH: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.run_attempt || inputs.versuch }}",
  ]);
  assert.deepEqual(stepEnv(j.schranke), [
    'A6_KI_EREIGNIS: ${{ github.event_name }}',
    'A6_KI_QUELLE: ${{ needs.schranke_vorpruefung.outputs.quelle }}',
    'A6_KI_AUFTRAG: ${{ needs.schranke_vorpruefung.outputs.auftrag }}',
    'A6_KI_PR: ${{ needs.schranke_vorpruefung.outputs.pr }}',
    'A6_KI_KOPF: ${{ needs.schranke_vorpruefung.outputs.kopf }}',
  ]);
  assert.match(j.schranke_vorpruefung, /\n {4}outputs:\n {6}quelle: \$\{\{ steps\.pruefung\.outputs\.quelle \}\}\n {6}auftrag: \$\{\{ steps\.pruefung\.outputs\.auftrag \}\}\n {6}pr: \$\{\{ steps\.pruefung\.outputs\.pr \}\}\n {6}kopf: \$\{\{ steps\.pruefung\.outputs\.kopf \}\}\n/);
  assert.equal([...WF().matchAll(/GH_TOKEN/g)].length, 1, 'GH_TOKEN genau einmal');
  assert.equal([...WF().matchAll(/github\.token/g)].length, 1, 'github.token genau einmal');
  assert.ok(!j.schranke.includes('GH_TOKEN') && !j.schranke.includes('github.token'), 'kein Token im Schrankenjob');
  for (const b of [j.schranke_vorpruefung, j.schranke]) {
    assert.doesNotMatch(runBlock(b), /\$\{\{/, 'kein Ausdruck im run-Text');
    assert.equal([...b.matchAll(/\n {6}- name: /g)].length, 1, 'genau ein Schritt');
  }
  // Die Logzeile des Schrankenjobs kommt nur aus env; Kopf und workflow-sha aus verschiedenen Quellen.
  assert.ok(runBlock(j.schranke).includes('echo "A6-PRUEFER-SCHRANKE repo noah04091/agenten-probe quelle $A6_KI_QUELLE auftrag $A6_KI_AUFTRAG pr $A6_KI_PR kopf $A6_KI_KOPF workflow-sha $GITHUB_SHA ereignis $A6_KI_EREIGNIS freigegeben"'));
  assert.doesNotMatch(runBlock(j.schranke_vorpruefung), /GITHUB_SHA/, 'der Vorjob kennt den Workflow-Stand nicht');
});

test('KI-Schranke: genau die festen Gruende, jeder ueber stopp und jeder in der Liste', { skip: OHNE_PATCH }, () => {
  const text = runBlock(jobs(WF()).schranke_vorpruefung);
  const gefunden = [...new Set([...text.matchAll(/\bstopp ([a-z-]+)/g)].map(m => m[1]))].sort();
  assert.ok(gefunden.length > 0, 'Muss-Treffer');
  assert.deepEqual(gefunden, [...GRUENDE].sort());
  assert.equal(GRUENDE.length, 30);
});

// ---------------------------------------------------------------------------------------------------------------
// Muss-Treffer gruen
// ---------------------------------------------------------------------------------------------------------------

test('KI-Schranke gruen (Muss-Treffer): workflow_run und Dispatch setzen alle Ausgaben; Schrankenjob schreibt genau die Zeile', { skip: OHNE_LAUF }, async () => {
  for (const ereignis of ['workflow_run', 'workflow_dispatch']) {
    const sz = grundfall({ ereignis });
    const r = await vorjob(sz);
    istGruen(r, ereignis);
    // Jeder Abruf nur GET; das Log nur mit --allow-escape-sequences; Reihenfolge der Abrufe fest.
    const pfade = r.protokoll.map(z => z.at(-1));
    assert.deepEqual(pfade, [
      `${R}/environments/claude-pruefer`,
      `${R}/environments/claude-pruefer/deployment-branch-policies`,
      `${R}/actions/runs/${LAUF}`,
      `${R}/actions/runs/${LAUF}/attempts/1/jobs?per_page=100`,
      `${R}/actions/jobs/${JOB}/logs`,
      `${R}/pulls/${PR}`,
      PFAD_LAEUFE,
      `${R}/actions/runs/${EIGEN}/jobs?filter=all&per_page=100`,
    ]);
    assert.ok(r.protokoll[4].includes('--allow-escape-sequences'));

    const s = await schranke({ A6_KI_EREIGNIS: ereignis, A6_KI_QUELLE: `${LAUF}-1`, A6_KI_AUFTRAG: String(AUFTRAG), A6_KI_PR: String(PR), A6_KI_KOPF: KOPF, GITHUB_SHA: WFSHA });
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stdout, `A6-PRUEFER-SCHRANKE repo ${REPO} quelle ${LAUF}-1 auftrag ${AUFTRAG} pr ${PR} kopf ${KOPF} workflow-sha ${WFSHA} ereignis ${ereignis} freigegeben\n`);
    assert.deepEqual(s.protokoll, [], 'Schrankenjob ruft nichts ab');
  }
});

test('KI-Schranke Bindung: kopf kommt aus Vorpruefungszeile und PR, workflow-sha aus GITHUB_SHA; nie gleichgesetzt', { skip: OHNE_LAUF }, async () => {
  const sz = grundfall();
  assert.notEqual(sz.sha, KOPF, 'Attrappe liefert verschiedene Werte');
  const r = await vorjob(sz);
  istGruen(r, 'Bindung');
  const aus = Object.fromEntries(r.ausgabe.trim().split('\n').map(z => z.split('=')));
  assert.equal(aus.kopf, KOPF);
  assert.notEqual(aus.kopf, WFSHA);
  // Ein anderer Workflow-Stand aendert den Kopf nicht.
  const r2 = await vorjob({ ...grundfall(), sha: KOPF2 });
  assert.equal(r2.ausgabe, r.ausgabe);

  const s = await schranke({ A6_KI_EREIGNIS: 'workflow_dispatch', A6_KI_QUELLE: aus.quelle, A6_KI_AUFTRAG: aus.auftrag, A6_KI_PR: aus.pr, A6_KI_KOPF: aus.kopf, GITHUB_SHA: WFSHA });
  const m = /^A6-PRUEFER-SCHRANKE repo \S+ quelle (\S+) auftrag (\S+) pr (\S+) kopf (\S+) workflow-sha (\S+) ereignis (\S+) freigegeben\n$/.exec(s.stdout);
  assert.ok(m, s.stdout);
  assert.deepEqual(m.slice(1), [`${LAUF}-1`, String(AUFTRAG), String(PR), KOPF, WFSHA, 'workflow_dispatch']);
});

test('KI-Schranke ohne jq: der Vorjob stoppt ohne Freigabeanfrage und ohne Ausgaben (Gegenprobe mit jq gruen)', { skip: OHNE_LAUF }, async () => {
  const ohne = await vorjob(grundfall(), { ohneJq: true });
  istRot(ohne, 'konfig-nicht-lesbar', 'ohne jq');
  // Muss-Treffer: beide Environment-Abrufe gelangen durch, der Stopp kommt erst an der ersten jq-Pruefung.
  assert.deepEqual(ohne.protokoll.map(z => z.at(-1)), [`${R}/environments/claude-pruefer`, `${R}/environments/claude-pruefer/deployment-branch-policies`]);
  istGruen(await vorjob(grundfall()), 'mit jq');
});

test('KI-Schranke Schrankenjob: jede Ausgabe wird erneut gegen ihr Format geprueft', { skip: OHNE_LAUF }, async () => {
  const gut = { A6_KI_EREIGNIS: 'workflow_run', A6_KI_QUELLE: `${LAUF}-1`, A6_KI_AUFTRAG: String(AUFTRAG), A6_KI_PR: String(PR), A6_KI_KOPF: KOPF, GITHUB_SHA: WFSHA };
  const faelle = [
    ['Quelle leer', { A6_KI_QUELLE: '' }, 'quelle'], ['Quelle ohne Versuch', { A6_KI_QUELLE: String(LAUF) }, 'quelle'],
    ['Auftrag leer', { A6_KI_AUFTRAG: '' }, 'auftrag'], ['PR unbekannt', { A6_KI_PR: 'unbekannt' }, 'pr'],
    ['Kopf kurz', { A6_KI_KOPF: KOPF.slice(1) }, 'kopf'], ['Kopf gross', { A6_KI_KOPF: KOPF.toUpperCase() }, 'kopf'],
    ['workflow-sha leer', { GITHUB_SHA: '' }, 'workflow-sha'], ['Ereignis push', { A6_KI_EREIGNIS: 'push' }, 'ereignis'],
    ['Zeilenumbruch im PR', { A6_KI_PR: '140\nA6-PRUEFER-SCHRANKE' }, 'pr'],
  ];
  const ergebnisse = await alle(faelle, ([, w]) => schranke({ ...gut, ...w }));
  faelle.forEach(([was, , code], k) => {
    assert.equal(ergebnisse[k].status, 1, was);
    assert.equal(ergebnisse[k].stdout, '', was);
    assert.equal(ergebnisse[k].stderr, `A6-START ${code}\n`, was);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Reihenfolge: Format, Environment, Quelllauf, Job, Log, PR, Doppelsperre. Der erste Fehler entscheidet.
// ---------------------------------------------------------------------------------------------------------------

test('KI-Schranke Reihenfolge: Format vor Environment vor Quelllauf vor Job vor Log vor PR vor Doppelsperre', { skip: OHNE_LAUF }, async () => {
  const kaputt = sz => {
    sz.antworten[`${R}/environments/claude-pruefer`] = { status: 500, b64: '' };
    sz.antworten[`${R}/actions/runs/${LAUF}`] = { status: 500, b64: '' };
    sz.antworten[`${R}/pulls/${PR}`] = { status: 500, b64: '' };
    delete sz.antworten[PFAD_LAEUFE];
    return sz;
  };
  const faelle = [
    ['Format zuerst', { ...kaputt(grundfall()), lauf: 'x' }, 'quelle-format', 'unbekannt'],
    ['dann Environment', kaputt(grundfall()), 'konfig-nicht-lesbar'],
    ['dann Quelllauf', (() => { const sz = kaputt(grundfall()); sz.antworten[`${R}/environments/claude-pruefer`] = grundfall().antworten[`${R}/environments/claude-pruefer`]; return sz; })(), 'quelle-nicht-lesbar'],
    ['Log vor PR (echtes Log)', (() => { const sz = grundfall(); sz.antworten[`${R}/actions/jobs/${JOB}/logs`] = roh(fixtureText()); sz.antworten[`${R}/pulls/${PR}`] = { status: 500, b64: '' }; return sz; })(), 'nicht-pruefbar'],
    ['PR vor Doppelsperre', (() => { const sz = grundfall(); sz.antworten[`${R}/pulls/${PR}`] = { status: 500, b64: '' }; delete sz.antworten[PFAD_LAEUFE]; return sz; })(), 'pr-nicht-lesbar'],
  ];
  await pruefeFaelle(faelle);
});

// ---------------------------------------------------------------------------------------------------------------
// Environment (Plan 2.1, Auftrag 3)
// ---------------------------------------------------------------------------------------------------------------

test('KI-Schranke Environment: jede Abweichung, 404 und nicht lesbare Antwort stoppen ohne Anfrage', { skip: OHNE_LAUF }, async () => {
  const E = `${R}/environments/claude-pruefer`;
  const Z = `${R}/environments/claude-pruefer/deployment-branch-policies`;
  const mit = (pfad, f) => { const sz = grundfall(); aendere(sz, pfad, f); return sz; };
  const regeln = f => mit(E, b => { f(b.protection_rules); });
  const pruefer = f => regeln(r => { f(r[0].reviewers); });
  const faelle = [
    ['404', (() => { const sz = grundfall(); delete sz.antworten[E]; return sz; })(), 'konfig-fehlt'],
    ['Branch-Regeln 404', (() => { const sz = grundfall(); delete sz.antworten[Z]; return sz; })(), 'konfig-fehlt'],
    ['500', (() => { const sz = grundfall(); sz.antworten[E] = { status: 500, b64: '' }; return sz; })(), 'konfig-nicht-lesbar'],
    ['403 Branch-Regeln', (() => { const sz = grundfall(); sz.antworten[Z] = { status: 403, b64: '' }; return sz; })(), 'konfig-nicht-lesbar'],
    ['kein JSON', (() => { const sz = grundfall(); sz.antworten[E] = roh('<html>'); return sz; })(), 'konfig-nicht-lesbar'],
    ['JSON-Liste', (() => { const sz = grundfall(); sz.antworten[E] = json([]); return sz; })(), 'konfig-nicht-lesbar'],
    ['falsche ID', mit(E, b => { b.id = 28418332670; }), 'konfig-abweichung'],
    ['falscher Name', mit(E, b => { b.name = 'claude-bot'; }), 'konfig-abweichung'],
    ['Bypass true', mit(E, b => { b.can_admins_bypass = true; }), 'konfig-abweichung'],
    ['Bypass fehlt', mit(E, b => { delete b.can_admins_bypass; }), 'konfig-abweichung'],
    ['Bypass null', mit(E, b => { b.can_admins_bypass = null; }), 'konfig-abweichung'],
    ['protected_branches true', mit(E, b => { b.deployment_branch_policy.protected_branches = true; }), 'konfig-abweichung'],
    ['custom_branch_policies false', mit(E, b => { b.deployment_branch_policy.custom_branch_policies = false; }), 'konfig-abweichung'],
    ['deployment_branch_policy null', mit(E, b => { b.deployment_branch_policy = null; }), 'konfig-abweichung'],
    ['deployment_branch_policy mit Zusatzfeld', mit(E, b => { b.deployment_branch_policy.x = 1; }), 'konfig-abweichung'],
    ['zweiter Pruefer', pruefer(p => { p.push({ type: 'User', reviewer: { login: 'x', id: 1 } }); }), 'konfig-abweichung'],
    ['Team-Pruefer', pruefer(p => { p[0].type = 'Team'; }), 'konfig-abweichung'],
    ['anderer Pruefer', pruefer(p => { p[0].reviewer.id = 196186597; }), 'konfig-abweichung'],
    ['kein Pruefer', pruefer(p => { p.length = 0; }), 'konfig-abweichung'],
    ['Zusatzregel wait_timer', regeln(r => { r.push({ id: 9, type: 'wait_timer', wait_timer: 0 }); }), 'konfig-abweichung'],
    ['Regel branch_policy fehlt', regeln(r => { r.pop(); }), 'konfig-abweichung'],
    ['Regel required_reviewers fehlt', regeln(r => { r.shift(); }), 'konfig-abweichung'],
    ['zwei Regeln required_reviewers', regeln(r => { r[1] = { ...r[0] }; }), 'konfig-abweichung'],
    ['Regeln fehlen', mit(E, b => { delete b.protection_rules; }), 'konfig-abweichung'],
    ['Branch-Regel fehlt', mit(Z, b => { b.total_count = 0; b.branch_policies = []; }), 'konfig-abweichung'],
    ['zweite Branch-Regel', mit(Z, b => { b.total_count = 2; b.branch_policies.push({ id: 4, name: 'wp/*', type: 'branch' }); }), 'konfig-abweichung'],
    ['Typ tag', mit(Z, b => { b.branch_policies[0].type = 'tag'; }), 'konfig-abweichung'],
    ['Muster *', mit(Z, b => { b.branch_policies[0].name = '*'; }), 'konfig-abweichung'],
    ['total_count widerspricht', mit(Z, b => { b.total_count = 2; }), 'konfig-abweichung'],
  ];
  await pruefeFaelle(faelle);
});

// ---------------------------------------------------------------------------------------------------------------
// Quelle (Plan 2.2 Schritt 1, Auftrag 4.1), je fuer beide Wege
// ---------------------------------------------------------------------------------------------------------------

test('KI-Schranke Quelle: Format, Herkunft, Erfolg und Versuch, je fuer workflow_run und Dispatch', { skip: OHNE_LAUF }, async () => {
  const L = `${R}/actions/runs/${LAUF}`;
  const faelle = [];
  for (const ereignis of ['workflow_run', 'workflow_dispatch']) {
    const g = () => grundfall({ ereignis });
    const mit = f => { const sz = g(); aendere(sz, L, f); return sz; };
    faelle.push(
      [`${ereignis}: Lauf 0`, { ...g(), lauf: '0' }, 'quelle-format', 'unbekannt'],
      [`${ereignis}: Lauf mit Text`, { ...g(), lauf: '455x' }, 'quelle-format', 'unbekannt'],
      [`${ereignis}: Lauf 17 Stellen`, { ...g(), lauf: '12345678901234567' }, 'quelle-format', 'unbekannt'],
      [`${ereignis}: Lauf leer`, { ...g(), lauf: '' }, 'quelle-format', 'unbekannt'],
      [`${ereignis}: Versuch 0`, { ...g(), versuch: '0' }, 'quelle-format', 'unbekannt'],
      [`${ereignis}: Versuch 1000`, { ...g(), versuch: '1000' }, 'quelle-format', 'unbekannt'],
      [`${ereignis}: Versuch mit Zeilenumbruch`, { ...g(), versuch: '1\n2' }, 'quelle-format', 'unbekannt'],
      [`${ereignis}: Lauf nicht lesbar`, (() => { const sz = g(); sz.antworten[L] = { status: 500, b64: '' }; return sz; })(), 'quelle-nicht-lesbar'],
      [`${ereignis}: Lauf fehlt`, (() => { const sz = g(); delete sz.antworten[L]; return sz; })(), 'quelle-nicht-lesbar'],
      [`${ereignis}: Lauf kein JSON`, (() => { const sz = g(); sz.antworten[L] = roh('x'); return sz; })(), 'quelle-nicht-lesbar'],
      [`${ereignis}: andere ID`, mit(b => { b.id = LAUF + 1; }), 'quelle-herkunft'],
      [`${ereignis}: falsche workflow_id`, mit(b => { b.workflow_id = 429024671; }), 'quelle-herkunft'],
      [`${ereignis}: falscher path`, mit(b => { b.path = '.github/workflows/agent-pruefer-ki.yml'; }), 'quelle-herkunft'],
      [`${ereignis}: path mit Ref`, mit(b => { b.path = '.github/workflows/agent-pruefer.yml@refs/heads/wp/1'; }), 'quelle-herkunft'],
      [`${ereignis}: head_branch anders`, mit(b => { b.head_branch = 'wp/139-agent-1-1'; }), 'quelle-herkunft'],
      [`${ereignis}: fremdes Repo`, mit(b => { b.repository.full_name = 'x/agenten-probe'; }), 'quelle-herkunft'],
      [`${ereignis}: fremdes Kopf-Repo`, mit(b => { b.head_repository.full_name = 'x/agenten-probe'; }), 'quelle-herkunft'],
      [`${ereignis}: Kopf-Repo fehlt`, mit(b => { delete b.head_repository; }), 'quelle-herkunft'],
      [`${ereignis}: Ereignis pull_request`, mit(b => { b.event = 'pull_request'; }), 'quelle-herkunft'],
      [`${ereignis}: Ereignis issues`, mit(b => { b.event = 'issues'; }), 'quelle-herkunft'],
      [`${ereignis}: Dispatch durch den Bot`, mit(b => { b.event = 'workflow_dispatch'; b.triggering_actor = { login: BOT, type: 'Bot' }; }), 'quelle-herkunft'],
      [`${ereignis}: Dispatch ohne triggering_actor`, mit(b => { b.event = 'workflow_dispatch'; delete b.triggering_actor; }), 'quelle-herkunft'],
      [`${ereignis}: conclusion failure`, mit(b => { b.conclusion = 'failure'; }), 'quelle-nicht-erfolgreich'],
      [`${ereignis}: in_progress`, mit(b => { b.status = 'in_progress'; b.conclusion = null; }), 'quelle-nicht-erfolgreich'],
      [`${ereignis}: run_attempt 2 bei Versuch 1`, mit(b => { b.run_attempt = 2; }), 'veralteter-versuch'],
      [`${ereignis}: Versuch 2 bei run_attempt 1`, { ...g(), versuch: '2' }, 'veralteter-versuch', `${LAUF}-2`],
    );
  }
  faelle.push(['Ereignis push', { ...grundfall(), ereignis: 'push' }, 'quelle-format', 'unbekannt']);
  faelle.push(['eigene Lauf-ID ungueltig', { ...grundfall(), runId: '' }, 'quelle-format', 'unbekannt']);
  await pruefeFaelle(faelle);

  // Gegenprobe: Dispatch der Vorpruefung durch noah04091 ist eine gueltige Quelle.
  const sz = grundfall({ ereignis: 'workflow_dispatch' });
  aendere(sz, L, b => { b.event = 'workflow_dispatch'; b.triggering_actor = { login: 'noah04091', type: 'User' }; });
  istGruen(await vorjob(sz), 'Dispatch durch noah04091');
});

// ---------------------------------------------------------------------------------------------------------------
// Job und Log (Plan 2.2 Schritte 2 und 3, Auftrag 4.2 und 4.3)
// ---------------------------------------------------------------------------------------------------------------

test('KI-Schranke Job und Log: echtes Log ergibt nicht-pruefbar, nie zeile-mehrdeutig; jede Zeilenregel der Zentrale', { skip: OHNE_LAUF }, async () => {
  const J = `${R}/actions/runs/${LAUF}/attempts/1/jobs?per_page=100`;
  const LG = `${R}/actions/jobs/${JOB}/logs`;
  const jobsMit = f => { const sz = grundfall(); aendere(sz, J, f); return sz; };
  const logMitText = text => { const sz = grundfall(); sz.antworten[LG] = roh(text); return sz; };
  const skriptzeile = `2026-11-24T12:51:19.0043044Z ${ESC}[36;1m  echo "A6-PRUEFER repo noah04091/agenten-probe pr unbekannt kopf unbekannt basis unbekannt lauf $A6_PRUEFER_LAUF ergebnis nicht-pruefbar befunde 0 hinweise 0"${ESC}[0m`;
  assert.ok(fixtureText().includes(skriptzeile), 'Muss-Treffer: eingefaerbte Skriptzeile im Fixture');
  const faelle = [
    ['echtes Log (Lauf 45397511852)', logMitText(fixtureText()), 'nicht-pruefbar'],
    ['Job fehlt', jobsMit(b => { b.jobs = []; b.total_count = 0; }), 'job-fehlt'],
    ['Job anderer Name', jobsMit(b => { b.jobs[0].name = 'Generalprobe Vorpruefung gegen nachgebautes GitHub'; }), 'job-fehlt'],
    ['zwei Jobs', jobsMit(b => { b.jobs.push({ ...b.jobs[0], id: JOB + 1 }); b.total_count = 2; }), 'job-mehrdeutig'],
    ['Job failure', jobsMit(b => { b.jobs[0].conclusion = 'failure'; }), 'job-nicht-erfolgreich'],
    ['Job skipped', jobsMit(b => { b.jobs[0].conclusion = 'skipped'; }), 'job-nicht-erfolgreich'],
    ['Job in_progress', jobsMit(b => { b.jobs[0].status = 'in_progress'; b.jobs[0].conclusion = null; }), 'job-nicht-erfolgreich'],
    ['Job anderer Versuch', jobsMit(b => { b.jobs[0].run_attempt = 2; }), 'job-nicht-erfolgreich'],
    ['total_count widerspruechlich', jobsMit(b => { b.total_count = 2; }), 'quelle-nicht-lesbar'],
    ['Jobs nicht lesbar', (() => { const sz = grundfall(); sz.antworten[J] = { status: 500, b64: '' }; return sz; })(), 'quelle-nicht-lesbar'],
    ['Log nicht lesbar', (() => { const sz = grundfall(); sz.antworten[LG] = { status: 410, b64: '' }; return sz; })(), 'log-nicht-lesbar'],
    ['Log fehlt (404)', (() => { const sz = grundfall(); delete sz.antworten[LG]; return sz; })(), 'log-nicht-lesbar'],
    ['ausstehend', logMitText(logMit(pzeile({ ergebnis: 'ausstehend' }))), 'ausstehend'],
    ['nicht-pruefbar mit PR', logMitText(logMit(pzeile({ ergebnis: 'nicht-pruefbar' }))), 'nicht-pruefbar'],
    ['pr unbekannt', logMitText(logMit(pzeile({ pr: 'unbekannt' }))), 'pr-unbekannt'],
    ['kopf unbekannt', logMitText(logMit(pzeile({ kopf: 'unbekannt' }))), 'pr-unbekannt'],
    ['Auftrag unbekannt', logMitText(logMit(pzeile({ lauf: 'unbekannt' }))), 'zeile-ungueltig'],
    ['kein Agenten-Auftrag', logMitText(logMit('A6-PRUEFER kein Agenten-Auftrag lauf 45061471286 code quelle-kein-auftrag')), 'kein-auftrag'],
    ['keine Zeile', logMitText(logMit(null)), 'zeile-fehlt'],
    ['nur eingerueckte Skriptzeile', logMitText(`${skriptzeile}\n`), 'zeile-fehlt'],
    ['Zeile mit Steuerzeichen davor', logMitText(logMit(`${ESC}[0m${pzeile()}`)), 'zeile-fehlt'],
    ['Zeile eingerueckt', logMitText(logMit(` ${pzeile()}`)), 'zeile-fehlt'],
    ['Zeitstempel ohne Z', logMitText(logMit(pzeile()).replace('2026-11-24T12:51:37.2077048Z A6-PRUEFER', '2026-11-24T12:51:37.2077048 A6-PRUEFER')), 'zeile-fehlt'],
    ['Zeitstempel mit zehn Nachkommastellen', logMitText(logMit(pzeile()).replace('2026-11-24T12:51:37.2077048Z A6-PRUEFER', '2026-11-24T12:51:37.2077048000Z A6-PRUEFER')), 'zeile-fehlt'],
    ['zwei Zeilen', logMitText(`${logMit(pzeile())}2026-11-24T12:51:38.0000000Z ${pzeile()}\n`), 'zeile-mehrdeutig'],
    ['zweite Zeile nicht-pruefbar', logMitText(`${logMit(pzeile())}2026-11-24T12:51:38.0000000Z ${pzeile({ ergebnis: 'nicht-pruefbar' })}\n`), 'zeile-mehrdeutig'],
    ['Zeile mit Zusatztext', logMitText(logMit(`${pzeile()} x`)), 'zeile-ungueltig'],
    ['unbekannter Ergebniswert', logMitText(logMit(pzeile({ ergebnis: 'bestanden' }))), 'zeile-ungueltig'],
    ['fremdes Repo in der Zeile', logMitText(logMit(pzeile().replace(REPO, 'x/agenten-probe'))), 'zeile-ungueltig'],
    ['Kopf in Grossbuchstaben', logMitText(logMit(pzeile({ kopf: KOPF.toUpperCase() }))), 'zeile-ungueltig'],
    ['Log ueber 16 MiB', logMitText(`${logMit(pzeile())}${'x'.repeat(16 * 1024 * 1024)}\n`), 'log-nicht-lesbar'],
  ];
  await pruefeFaelle(faelle);

  // Gegenproben: Zeile ohne Zeitstempel, mit CR am Ende und mit Steuerzeichen-Zeile daneben bleibt gruen (Regeln der Zentrale).
  const gruen = [
    ['ohne Zeitstempel', `${pzeile()}\n`],
    ['CRLF', logMit(pzeile()).replace(/\n/g, '\r\n')],
    ['Steuerzeichen-Zeile daneben', `${logMit(pzeile())}2026-11-24T12:51:38.0000000Z ${ESC}[0m${pzeile({ ergebnis: 'nicht-pruefbar' })}\n`],
    ['auffaelligkeiten', logMit(pzeile({ ergebnis: 'auffaelligkeiten' }))],
  ];
  const r = await alle(gruen, ([, text]) => vorjob(logMitText(text)));
  gruen.forEach(([was], k) => istGruen(r[k], was));
});

test('KI-Schranke Log: ohne --allow-escape-sequences verweigert gh das echte Log (Muss-Treffer der Attrappe)', { skip: OHNE_LAUF }, async () => {
  const dir = vorbereiten('', { antworten: { x: roh(fixtureText()) } });
  const ohne = spawnSync(join(dir, 'bin', 'gh'), ['api', '--method', 'GET', 'x'], { encoding: 'latin1' });
  assert.equal(ohne.status, 1);
  assert.match(ohne.stderr, /terminal escape sequences/);
  const mit = spawnSync(join(dir, 'bin', 'gh'), ['api', '--method', 'GET', '--allow-escape-sequences', 'x'], { encoding: 'latin1' });
  assert.equal(mit.status, 0);
  assert.equal(sha256(Buffer.from(mit.stdout, 'latin1')), FIXTURE_SHA256);
  const post = spawnSync(join(dir, 'bin', 'gh'), ['api', '--method', 'POST', 'x'], { encoding: 'utf8' });
  assert.equal(post.status, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// PR (Plan 2.2 Schritt 4, Auftrag 4.4)
// ---------------------------------------------------------------------------------------------------------------

test('KI-Schranke PR: nur ein offener PR der App mit gleichem Kopf, Basis main und Zweig des Auftrags', { skip: OHNE_LAUF }, async () => {
  const P = `${R}/pulls/${PR}`;
  const mit = f => { const sz = grundfall(); aendere(sz, P, f); return sz; };
  const faelle = [
    ['zu', mit(b => { b.state = 'closed'; }), 'pr-nicht-offen'],
    ['gemergt', mit(b => { b.state = 'closed'; b.merged = true; }), 'pr-nicht-offen'],
    ['Kopf anders', mit(b => { b.head.sha = KOPF2; }), 'kopf-geaendert'],
    ['Basis anders', mit(b => { b.base.ref = 'wp/1-x'; }), 'pr-herkunft'],
    ['Autor noah04091-agent', mit(b => { b.user = { login: 'noah04091-agent', type: 'User' }; }), 'pr-herkunft'],
    ['Autor noah04091', mit(b => { b.user = { login: 'noah04091', type: 'User' }; }), 'pr-herkunft'],
    ['Typ User mit App-Namen', mit(b => { b.user.type = 'User'; }), 'pr-herkunft'],
    ['fremde App mit Typ Bot', mit(b => { b.user = { login: 'dependabot[bot]', type: 'Bot' }; }), 'pr-herkunft'],
    ['Typ fehlt', mit(b => { delete b.user.type; }), 'pr-herkunft'],
    ['Zweig mit anderer Auftrags-ID', mit(b => { b.head.ref = `wp/139-agent-${AUFTRAG + 1}-1`; }), 'pr-herkunft'],
    ['Zweig -2 statt -1', mit(b => { b.head.ref = `wp/139-agent-${AUFTRAG}-2`; }), 'pr-herkunft'],
    ['Zweig mit Zusatz', mit(b => { b.head.ref = `wp/139-agent-${AUFTRAG}-1-x`; }), 'pr-herkunft'],
    ['Zweig ohne Issue', mit(b => { b.head.ref = `wp/agent-${AUFTRAG}-1`; }), 'pr-herkunft'],
    ['fremdes Kopf-Repo', mit(b => { b.head.repo.full_name = 'x/agenten-probe'; }), 'pr-herkunft'],
    ['Kopf-Repo geloescht', mit(b => { b.head.repo = null; }), 'pr-herkunft'],
    ['andere PR-Nummer', mit(b => { b.number = PR + 1; }), 'pr-herkunft'],
    ['nicht lesbar', (() => { const sz = grundfall(); sz.antworten[P] = { status: 502, b64: '' }; return sz; })(), 'pr-nicht-lesbar'],
    ['fehlt', (() => { const sz = grundfall(); delete sz.antworten[P]; return sz; })(), 'pr-nicht-lesbar'],
  ];
  await pruefeFaelle(faelle);
});

// ---------------------------------------------------------------------------------------------------------------
// Doppelsperre ueber alle Laeufe und alle Versuche (Auftrag 5, verbindliche Ergaenzung ChatGPT)
// ---------------------------------------------------------------------------------------------------------------

test('KI-Schranke Doppelsperre: Pflichtfaelle 1 bis 8', { skip: OHNE_LAUF }, async () => {
  const ANDERER = 45600000001;
  const fall = (laeufe, eigeneVersuche = [], f = () => {}) => { const sz = grundfall(); verlauf(sz, laeufe, { eigeneVersuche }); f(sz); return sz; };
  const quelle2 = `${LAUF}-1`;

  const faelle = [
    // 1. derselbe KI-Lauf, Versuch 1 freigegeben, jetzt Versuch 2
    ['1 eigener Lauf, Versuch 1 freigegeben', fall([], [[VJ, S_OK()]]), 'bereits-freigegeben'],
    ['1b eigener Lauf, Versuch 1 freigegeben, Versuch 2 abgelehnt, jetzt Versuch 3', fall([], [[VJ, S_OK()], [VJ, S_ABGELEHNT]]), 'bereits-freigegeben'],
    // 2. zwei verschiedene KI-Laeufe fuer denselben Umfang
    ['2 anderer Lauf freigegeben', fall([{ id: ANDERER, versuche: [[VJ, S_OK()]] }]), 'bereits-freigegeben'],
    ['2b anderer Lauf, erst Versuch 2 freigegeben', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT], [VJ, S_OK()]] }]), 'bereits-freigegeben'],
    ['2c anderer Lauf, Versuch 1 freigegeben, Versuch 2 Vorjob rot', fall([{ id: ANDERER, versuche: [[VJ, S_OK()], [VJ_ROT, S_UEBERSPRUNGEN]] }]), 'bereits-freigegeben'],
    // 4. Jobs oder Log eines frueheren Versuchs nicht lesbar
    ['4 Jobs eines frueheren Versuchs nicht lesbar', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => { sz.antworten[`${R}/actions/runs/${ANDERER}/attempts/1/jobs?per_page=100`] = { status: 500, b64: '' }; }), 'verlauf-nicht-lesbar'],
    ['4b Log eines Erfolgs nicht lesbar', fall([{ id: ANDERER, versuche: [[VJ, { name: 'schranke', conclusion: 'success' }]] }]), 'verlauf-nicht-lesbar'],
    ['4c Versuch nicht lesbar', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => { delete sz.antworten[`${R}/actions/runs/${ANDERER}/attempts/1`]; }), 'verlauf-nicht-lesbar'],
    ['4d eigener frueherer Versuch nicht lesbar', fall([], [[VJ, S_ABGELEHNT]], sz => { sz.antworten[`${R}/actions/runs/${EIGEN}/attempts/1/jobs?per_page=100`] = { status: 500, b64: '' }; }), 'verlauf-nicht-lesbar'],
    ['4e Liste nicht lesbar', fall([], [], sz => { sz.antworten[PFAD_LAEUFE] = { status: 500, b64: '' }; }), 'verlauf-nicht-lesbar'],
    ['4f filter=all nicht lesbar', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => { delete sz.antworten[`${R}/actions/runs/${ANDERER}/jobs?filter=all&per_page=100`]; }), 'verlauf-nicht-lesbar'],
    ['4g Liste kein JSON', fall([], [], sz => { sz.antworten[PFAD_LAEUFE] = roh('{'); }), 'verlauf-nicht-lesbar'],
    // 5. Versuchszaehler und API widerspruechlich
    ['5 attempts/2 liefert run_attempt 1', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT], [VJ, S_ABGELEHNT]] }], [], sz => { aendere(sz, `${R}/actions/runs/${ANDERER}/attempts/2`, b => { b.run_attempt = 1; }); }), 'verlauf-widerspruch'],
    ['5b attempts liefert anderen Lauf', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => { aendere(sz, `${R}/actions/runs/${ANDERER}/attempts/1`, b => { b.id = EIGEN; }); }), 'verlauf-widerspruch'],
    ['5c Job mit falschem run_attempt', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT], [VJ, S_ABGELEHNT]] }], [], sz => { aendere(sz, `${R}/actions/runs/${ANDERER}/attempts/2/jobs?per_page=100`, b => { b.jobs[0].run_attempt = 1; }); }), 'verlauf-widerspruch'],
    ['5d total_count der Jobs ungleich Laenge', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => { aendere(sz, `${R}/actions/runs/${ANDERER}/attempts/1/jobs?per_page=100`, b => { b.total_count = 3; }); }), 'verlauf-widerspruch'],
    ['5e total_count der Laeufe ungleich Laenge', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => { aendere(sz, PFAD_LAEUFE, b => { b.total_count = 3; }); }), 'verlauf-unvollstaendig'],
    ['5f eigener Lauf fehlt in der Liste', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => { aendere(sz, PFAD_LAEUFE, b => { b.workflow_runs.shift(); b.total_count = 1; }); }), 'verlauf-widerspruch'],
    ['5g zwei Schrankenjobs success in einem Versuch', fall([{ id: ANDERER, versuche: [[S_OK(PR, KOPF2), S_OK(PR, KOPF2)]] }]), 'verlauf-widerspruch'],
    ['5h Schrankenzeile fehlt im Log', fall([{ id: ANDERER, versuche: [[VJ, { name: 'schranke', conclusion: 'success', log: '2026-11-25T08:00:01.2000000Z nichts\n' }]] }]), 'verlauf-widerspruch'],
    ['5i Schrankenzeile ungueltig', fall([{ id: ANDERER, versuche: [[VJ, { name: 'schranke', conclusion: 'success', log: schrankeLog().replace(' freigegeben\n', ' freigegeben x\n') }]] }]), 'verlauf-widerspruch'],
    ['5j zwei Schrankenzeilen', fall([{ id: ANDERER, versuche: [[VJ, { name: 'schranke', conclusion: 'success', log: schrankeLog(PR, KOPF2) + schrankeLog(PR, KOPF2) }]] }]), 'verlauf-widerspruch'],
    ['5k Versuchszahl in der Liste ungueltig', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => { aendere(sz, PFAD_LAEUFE, b => { b.workflow_runs[1].run_attempt = 0; }); }), 'verlauf-widerspruch'],
    // 6. aelterer Erfolg fehlt in der Abfrage des Versuchs, erscheint aber in filter=all
    ['6 Erfolg nur in filter=all', fall([{ id: ANDERER, versuche: [[VJ, S_OK()], [VJ, S_ABGELEHNT]] }], [], sz => {
      aendere(sz, `${R}/actions/runs/${ANDERER}/attempts/1/jobs?per_page=100`, b => { b.jobs = b.jobs.filter(j => j.name !== 'schranke'); b.total_count = b.jobs.length; });
    }), 'verlauf-widerspruch'],
    ['6b Erfolg in der Versuchsabfrage als abgelehnt, in filter=all erfolgreich', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => {
      aendere(sz, `${R}/actions/runs/${ANDERER}/jobs?filter=all&per_page=100`, b => { b.jobs.find(j => j.name === 'schranke').conclusion = 'success'; });
    }), 'verlauf-widerspruch'],
    ['6c filter=all mit Job aus einem hoeheren Versuch', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => {
      aendere(sz, `${R}/actions/runs/${ANDERER}/jobs?filter=all&per_page=100`, b => { b.jobs.push({ id: 1, name: 'schranke', run_attempt: 2, status: 'completed', conclusion: 'success' }); b.total_count += 1; });
    }), 'verlauf-widerspruch'],
    ['6f filter=all mit abgelehntem Job aus einem hoeheren Versuch', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => {
      aendere(sz, `${R}/actions/runs/${ANDERER}/jobs?filter=all&per_page=100`, b => { b.jobs.push({ id: 2, name: 'schranke', run_attempt: 2, status: 'completed', conclusion: 'failure' }); b.total_count += 1; });
    }), 'verlauf-widerspruch'],
    ['6d filter=all total_count ungleich Laenge', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT]] }], [], sz => {
      aendere(sz, `${R}/actions/runs/${ANDERER}/jobs?filter=all&per_page=100`, b => { b.total_count += 1; });
    }), 'verlauf-widerspruch'],
    ['6e eigener frueherer Erfolg nur in filter=all', fall([], [[VJ, S_OK()]], sz => {
      aendere(sz, `${R}/actions/runs/${EIGEN}/attempts/1/jobs?per_page=100`, b => { b.jobs = b.jobs.filter(j => j.name !== 'schranke'); b.total_count = b.jobs.length; });
    }), 'verlauf-widerspruch'],
    // 8. Grenzen und Parallelitaet
    ['8 mehr als 100 Laeufe', fall([], [], sz => { aendere(sz, PFAD_LAEUFE, b => { b.total_count = 101; }); }), 'zu-viele-laeufe'],
    ['8b anderer Lauf waiting', fall([{ id: ANDERER, status: 'waiting', versuche: [[VJ]] }]), 'parallel-lauf'],
    ['8c anderer Lauf in_progress', fall([{ id: ANDERER, status: 'in_progress', versuche: [[VJ]] }]), 'parallel-lauf'],
    ['8d anderer Lauf requested', fall([{ id: ANDERER, status: 'requested', versuche: [[VJ]] }]), 'parallel-lauf'],
    ['8e ueber 400 Abrufe', fall(Array.from({ length: 99 }, (_, i) => ({ id: 45700000001 + i, versuche: [[VJ, S_ABGELEHNT], [VJ, S_UEBERSPRUNGEN], [VJ_ROT]] }))), 'zu-viele-abfragen'],
  ];
  await pruefeFaelle(faelle.map(([w, sz, g]) => [w, sz, g, quelle2]));

  // 3. frueherer Versuch abgelehnt oder uebersprungen: gruen. 7. gleicher PR, neuer Kopf: gruen. Fremder PR: gruen.
  const gruen = [
    ['3 eigener Versuch 1 abgelehnt', fall([], [[VJ, S_ABGELEHNT]])],
    ['3b eigener Versuch 1 uebersprungen (Vorjob rot)', fall([], [[VJ_ROT, S_UEBERSPRUNGEN]])],
    ['3c anderer Lauf abgelehnt und uebersprungen', fall([{ id: ANDERER, versuche: [[VJ, S_ABGELEHNT], [VJ_ROT, S_UEBERSPRUNGEN]] }])],
    ['3d anderer Lauf abgebrochen', fall([{ id: ANDERER, versuche: [[VJ, { name: 'schranke', conclusion: 'cancelled' }]] }])],
    ['7 gleicher PR, neuer Kopf', fall([{ id: ANDERER, versuche: [[VJ, S_OK(PR, KOPF2)]] }], [[VJ, S_OK(PR, KOPF2)]])],
    ['7b anderer PR, gleicher Kopf', fall([{ id: ANDERER, versuche: [[VJ, S_OK(PR + 1, KOPF)]] }])],
    ['8f anderer Lauf queued (wartet in der Gruppe)', fall([{ id: ANDERER, status: 'queued', versuche: [[]] }])],
    ['8g 60 fruehere Laeufe unter 400 Abrufen', fall(Array.from({ length: 60 }, (_, i) => ({ id: 45700000001 + i, versuche: [[VJ, S_ABGELEHNT], [VJ_ROT]] })))],
  ];
  const r = await alle(gruen, ([, sz]) => vorjob(sz));
  gruen.forEach(([was], k) => istGruen(r[k], was));
  // Muss-Treffer: im Fall 3 wurde der eigene fruehere Versuch wirklich gelesen.
  assert.ok(r[0].protokoll.some(z => z.at(-1) === `${R}/actions/runs/${EIGEN}/attempts/1/jobs?per_page=100`));
  assert.ok(!r[0].protokoll.some(z => z.at(-1) === `${R}/actions/runs/${EIGEN}/attempts/2/jobs?per_page=100`), 'laufender eigener Versuch nicht als frueher gewertet');
});

test('KI-Schranke: aufraeumen', () => {
  rmSync(TEMP, { recursive: true, force: true });
});
