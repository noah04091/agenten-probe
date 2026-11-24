// A8 (Ziel A, Stilllegung der alten Agenten-Pipeline). Nach A8 ist agent-auftrag.yml der einzige Workflow mit
// einem Agentenpfad. Diese Wache ersetzt die Sperren der entfernten Workflows (claude-agent-sperre fuer
// claude-agent.yml, Aktivierungspruefung mit Fingerabdruck fuer code-pilot-claude-stufe.yml): Statt einen
// stillgelegten zweiten Pfad zu bewachen, verbietet sie jeden zweiten Pfad.
//   1. Es gibt genau die vier genehmigten Workflow-Dateien. Jede weitere braucht eine sichtbare Aenderung hier.
//   2. Ausser agent-auftrag.yml startet kein Workflow durch Issues, Kommentare, Zeitplan oder Hand, und keiner
//      kennt Environment, Secrets, Claude, ein App-Token oder den alten Schalter CODE_PILOT_ENABLED.
// Den Inhalt von agent-auftrag.yml selbst bindet der Hash in agent-code-job.test.mjs.
// B2.1: kontrolliert fuenf Dateien. agent-pruefer.yml (Vorpruefung ohne KI) hat eigene Regeln (regelnPruefer unten):
// Ausloeser genau workflow_run, workflow_dispatch und pull_request; kein Environment, keine Secrets, kein Anthropic,
// kein Claude Code, kein App-Token, kein CODE_PILOT; nur Leserechte; kein Job mit einem Pflichtcheck-Namen; kein
// Checkout eines PR-Refs. Fuer die uebrigen drei Workflows bleibt alles wie bisher.
// B2.3a: kontrolliert sechs Dateien. agent-pruefer-ki.yml (Freigabeschranke) hat eigene Regeln (regelnKi unten):
// Ausloeser genau workflow_run (nur Agent-Vorpruefung, nur main) und workflow_dispatch (lauf, versuch); oben keine Rechte;
// Vorjob genau actions: read und pull-requests: read; genau ein Job mit Environment (claude-pruefer, ohne Rechte, mit needs
// und Erfolgsbedingung); jede Klausel der Bedingung B in beiden Jobs; globale Gruppe ohne Abbruch; kein uses, kein
// Ausdruck im run-Text, GH_TOKEN nur im Vorjob, kein Secret, keine Variable, kein Pflichtcheck-Name. Ueber alle Workflows:
// claude-pruefer genau einmal und nur dort als Environment, claude-bot nur in agent-auftrag.yml.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORDNER = join(ROOT, '.github', 'workflows');
const AGENT = 'agent-auftrag.yml';
const PRUEFER = 'agent-pruefer.yml';
const KI = 'agent-pruefer-ki.yml';
const GENEHMIGT = [AGENT, KI, PRUEFER, 'build.yml', 'schutz.yml', 'tests.yml'];
const PFLICHTCHECKS = ['build', 'tests', 'schutzdateien', 'agent-auftrag-sammel'];
const PRUEFER_RECHTE = ['actions: read', 'checks: read', 'contents: read', 'issues: read', 'pull-requests: read'];
const lies = name => readFileSync(join(ORDNER, name), 'utf8').replace(/\r\n/g, '\n');

// Ausloeser einer Workflow-Datei: die Schluessel direkt unter "on:".
function ausloeser(text) {
  const teile = text.split('\non:\n');
  assert.equal(teile.length, 2, 'Block "on:" nicht genau einmal');
  const block = teile[1].split(/\n(?=\S)/)[0];
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map(m => m[1]).sort();
}

const AGENTENMUSTER = [
  [/^\s*environment:/m, 'Environment'],
  [/secrets\./, 'Secrets'],
  [/anthropic/i, 'Anthropic'],
  [/claude-code/i, 'Claude Code'],
  [/create-github-app-token/, 'App-Token'],
  [/CODE_PILOT/, 'alter Schalter CODE_PILOT_*'],
];

test('A8: genau die sechs genehmigten Workflow-Dateien', () => {
  const dateien = readdirSync(ORDNER).sort();
  assert.ok(dateien.includes(AGENT), 'Muss-Treffer: agent-auftrag.yml gefunden');
  assert.deepEqual(dateien, GENEHMIGT, 'Workflow-Ordner weicht von der genehmigten Liste ab');
});

test('A8: agent-auftrag.yml ist der einzige Agentenpfad', () => {
  // Muss-Treffer: die Muster erkennen den echten Agentenpfad, sonst beweist ihr Fehlen anderswo nichts.
  const agent = lies(AGENT);
  for (const [muster, name] of AGENTENMUSTER.filter(([, n]) => n !== 'App-Token' && n !== 'alter Schalter CODE_PILOT_*')) {
    assert.match(agent, muster, `Muss-Treffer: ${name} in ${AGENT} nicht erkannt`);
  }
  assert.deepEqual(ausloeser(agent), ['issues', 'pull_request']);

  for (const name of GENEHMIGT.filter(n => n !== AGENT && n !== PRUEFER && n !== KI)) {
    const text = lies(name);
    const an = ausloeser(text);
    assert.ok(an.length > 0 && an.every(a => a === 'pull_request' || a === 'push'), `${name}: Ausloeser ${an.join(',')} nicht erlaubt`);
    for (const [muster, was] of AGENTENMUSTER) {
      assert.doesNotMatch(text, muster, `${name}: ${was} ausserhalb von ${AGENT}`);
    }
  }
});

// B2.1: Regeln fuer agent-pruefer.yml. Liefert die Liste der Verstoesse (leer heisst: alle Regeln eingehalten).
function regelnPruefer(text) {
  const v = [];
  let an = [];

  try {
    an = ausloeser(text);
  } catch {
    v.push('ausloeser');
  }

  if (JSON.stringify(an) !== JSON.stringify(['pull_request', 'workflow_dispatch', 'workflow_run'])) {
    v.push('ausloeser');
  }

  for (const [muster, name] of AGENTENMUSTER) {
    if (muster.test(text)) {
      v.push(name);
    }
  }

  if (/claude\s*code|ANTHROPIC|@anthropic-ai/i.test(text)) {
    v.push('Claude Code');
  }

  if (!/\npermissions: \{\}\n/.test(text)) {
    v.push('rechte-oben');
  }

  // Jeder Rechte-Block eines Jobs: nur read, und nur aus der festen Liste.
  for (const m of text.matchAll(/\n {4}permissions:(.*)\n((?: {6}.*\n)*)/g)) {
    const zeilen = m[2].trim() === '' ? [m[1].trim()] : m[2].trim().split('\n').map(z => z.trim());

    if (!zeilen.every(z => PRUEFER_RECHTE.includes(z))) {
      v.push('rechte');
    }
  }

  if (/\b[a-z-]+: write\b|write-all|read-all/.test(text)) {
    v.push('schreibrecht');
  }

  // Kein Job (ID oder Anzeigename) mit einem Pflichtcheck-Namen.
  const ids = [...text.split('\njobs:\n')[1]?.matchAll(/^ {2}([a-z_][a-z0-9_-]*):$/gm) ?? []].map(m => m[1]);
  const namen = [...text.matchAll(/^ {4}name: (.+)$/gm)].map(m => m[1].trim());

  if ([...ids, ...namen].some(n => PFLICHTCHECKS.includes(n))) {
    v.push('pflichtcheck-name');
  }

  // Checkout nur github.sha; nie Ref, Zweig oder SHA des PR.
  const refs = [...text.matchAll(/^ {10}ref: (.+)$/gm)].map(m => m[1].trim());

  if (refs.length === 0 || refs.some(r => r !== '${{ github.sha }}') || /head_ref|pull_request\.head\.(sha|ref)|refs\/pull\//.test(text)) {
    v.push('checkout-pr');
  }

  return v;
}

test('A8 (B2.1): agent-pruefer.yml haelt alle eigenen Regeln ein; jede Regel erkennt ihren Verstoss (Muss-Treffer)', () => {
  const text = lies(PRUEFER);
  assert.deepEqual(regelnPruefer(text), []);

  const rot = [
    ['Ausloeser issues', text.replace('\non:\n', '\non:\n  issues:\n    types: [labeled]\n'), 'ausloeser'],
    ['Ausloeser pull_request_target', text.replace('  pull_request:\n', '  pull_request_target:\n'), 'ausloeser'],
    ['Ausloeser schedule', text.replace('\non:\n', '\non:\n  schedule:\n    - cron: 0 0 * * *\n'), 'ausloeser'],
    ['Environment', text.replace('    runs-on: ubuntu-24.04\n', '    environment: claude-bot\n    runs-on: ubuntu-24.04\n'), 'Environment'],
    ['Secrets', text.replace('A6_LESE_TOKEN: ${{ github.token }}', 'A6_LESE_TOKEN: ${{ secrets.LESE }}'), 'Secrets'],
    ['Anthropic', text.replace('name: Agent-Vorpruefung', 'name: Agent-Vorpruefung anthropic'), 'Anthropic'],
    ['claude-code', text.replace('# Notabschaltung', '# claude-code\n# Notabschaltung'), 'Claude Code'],
    ['Claude Code mit Leerzeichen', text.replace('# Notabschaltung', '# Claude Code\n# Notabschaltung'), 'Claude Code'],
    ['App-Token', text.replace('    steps:\n', '    steps:\n      - uses: actions/create-github-app-token@x\n'), 'App-Token'],
    ['CODE_PILOT', text.replace('  A6_NODE_VERSION:', '  CODE_PILOT_ENABLED: x\n  A6_NODE_VERSION:'), 'alter Schalter CODE_PILOT_*'],
    ['Rechte oben', text.replace('\npermissions: {}\n', '\npermissions:\n  contents: read\n'), 'rechte-oben'],
    ['checks: write', text.replace('      checks: read\n', '      checks: write\n'), 'schreibrecht'],
    ['pull-requests: write', text.replace('      pull-requests: read\n', '      pull-requests: write\n'), 'schreibrecht'],
    ['issues: write', text.replace('      issues: read\n', '      issues: write\n'), 'schreibrecht'],
    ['contents: write', text.replace('      contents: read\n', '      contents: write\n'), 'schreibrecht'],
    ['statuses: read nicht in der Liste', text.replace('      checks: read\n', '      checks: read\n      statuses: read\n'), 'rechte'],
    ['Job-Name build', text.replace('    name: Vorpruefung Agenten-PR\n', '    name: build\n'), 'pflichtcheck-name'],
    ['Job-ID tests', text.replace('\n  probe_vorpruefung:\n', '\n  tests:\n'), 'pflichtcheck-name'],
    ['Job-Name agent-auftrag-sammel', text.replace('    name: Generalprobe Vorpruefung gegen nachgebautes GitHub\n', '    name: agent-auftrag-sammel\n'), 'pflichtcheck-name'],
    ['Checkout PR-Kopf', text.replace('ref: ${{ github.sha }}', 'ref: ${{ github.event.pull_request.head.sha }}'), 'checkout-pr'],
    ['Checkout head_ref', text.replace('ref: ${{ github.sha }}', 'ref: ${{ github.head_ref }}'), 'checkout-pr'],
    ['Checkout refs/pull', text.replace('ref: ${{ github.sha }}', 'ref: refs/pull/1/merge'), 'checkout-pr'],
  ];

  for (const [was, geaendert, erwartet] of rot) {
    assert.notEqual(geaendert, text, `${was}: Muss-Treffer, die Aenderung greift`);
    assert.ok(regelnPruefer(geaendert).includes(erwartet), `${was}: ${JSON.stringify(regelnPruefer(geaendert))}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// B2.3a: Regeln fuer agent-pruefer-ki.yml (Freigabeschranke). Ohne Eigentuemer-PR fehlt die Datei; dann sind diese
// Tests bewusst rot (Liste der Workflows), nicht uebersprungen.
// ---------------------------------------------------------------------------------------------------------------

const KI_ON = [
  '  workflow_run:', '    workflows: [Agent-Vorpruefung]', '    types: [completed]', '    branches: [main]',
  '  workflow_dispatch:', '    inputs:',
  '      lauf:', '        description: Lauf-ID der Vorpruefung', '        required: true', '        type: string',
  '      versuch:', '        description: Versuch (run_attempt) dieses Laufs', '        required: true', '        type: string',
].join('\n');
const KI_B = "github.repository == 'noah04091/agenten-probe' && github.ref == 'refs/heads/main' && "
  + "((github.event_name == 'workflow_run' && github.event.workflow_run.workflow_id == 429024670 && "
  + "github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository && "
  + "github.event.workflow_run.conclusion == 'success' && "
  + "(github.event.workflow_run.event == 'workflow_run' || github.event.workflow_run.event == 'workflow_dispatch')) || "
  + "(github.event_name == 'workflow_dispatch' && github.actor == 'noah04091' && github.triggering_actor == 'noah04091'))";
const KI_B_KLAUSELN = [
  "github.repository == 'noah04091/agenten-probe'", "github.ref == 'refs/heads/main'", "github.event_name == 'workflow_run'",
  'github.event.workflow_run.workflow_id == 429024670', "github.event.workflow_run.head_branch == 'main'",
  'github.event.workflow_run.head_repository.full_name == github.repository', "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'workflow_run'", "github.event.workflow_run.event == 'workflow_dispatch'",
  "github.event_name == 'workflow_dispatch'", "github.actor == 'noah04091'", "github.triggering_actor == 'noah04091'",
];

const KI_CLAUDE_ZEILEN = ['          UMGEBUNG=claude-pruefer', '      name: claude-pruefer'];

function kiJobs(text) {
  const teil = text.split('\njobs:\n');
  const bloecke = {};
  if (teil.length !== 2) return bloecke;
  for (const b of teil[1].split(/\n(?= {2}[a-z_]+:\n)/)) {
    const m = /^ {2}([a-z_]+):\n/.exec(b);
    if (m) bloecke[m[1]] = `${b}\n`;
  }
  return bloecke;
}

// Liefert die Liste der Verstoesse (leer heisst: alle Regeln eingehalten).
function regelnKi(text) {
  const v = [];
  let an = [];
  try {
    an = ausloeser(text);
  } catch {
    v.push('ausloeser');
  }
  if (JSON.stringify(an) !== JSON.stringify(['workflow_dispatch', 'workflow_run'])) v.push('ausloeser');
  if (text.split('\non:\n')[1]?.split('\n\n')[0] !== KI_ON) v.push('ausloeser-block');
  if (!/\npermissions: \{\}\n/.test(text) || (text.match(/^permissions:/gm) ?? []).length !== 1) v.push('rechte-oben');
  if (!text.includes('\nconcurrency:\n  group: agent-pruefer-ki\n  cancel-in-progress: false\n') || (text.match(/concurrency:/g) ?? []).length !== 1) v.push('gruppe');

  const j = kiJobs(text);
  if (JSON.stringify(Object.keys(j)) !== JSON.stringify(['schranke_vorpruefung', 'schranke'])) v.push('jobs');
  const vor = j.schranke_vorpruefung ?? '';
  const sch = j.schranke ?? '';
  const rechte = b => [...b.matchAll(/\n {4}permissions:(.*)\n((?: {6}.*\n)*)/g)].map(m => (m[2].trim() === '' ? [m[1].trim()] : m[2].trim().split('\n').map(z => z.trim())));
  if (JSON.stringify(rechte(vor)) !== JSON.stringify([['actions: read', 'pull-requests: read']])) v.push('rechte-vorjob');
  if (JSON.stringify(rechte(sch)) !== JSON.stringify([['{}']])) v.push('rechte-schranke');
  if (/:\s*write\b|write-all|read-all/.test(text)) v.push('schreibrecht');
  if ((text.match(/^\s*environment:/gm) ?? []).length !== 1 || !sch.includes('\n    environment:\n      name: claude-pruefer\n') || /environment:/.test(vor)) v.push('environment');
  if (!sch.includes('\n    needs: schranke_vorpruefung\n') || (text.match(/needs:/g) ?? []).length !== 1) v.push('needs');
  const bedingung = b => /\n {4}if: >-\n((?: {6}.*\n)+)/.exec(b)?.[1].replace(/\s+/g, ' ').trim();
  if (bedingung(vor) !== KI_B || bedingung(sch) !== `${KI_B} && needs.schranke_vorpruefung.result == 'success'`) v.push('bedingung');
  if (/\buses:/.test(text)) v.push('uses');
  for (const m of text.matchAll(/\n {8}run: \|\n((?:(?: {10}.*)?\n)+)/g)) {
    if (m[1].includes('${{')) v.push('ausdruck-im-run');
  }
  if ((text.match(/GH_TOKEN/g) ?? []).length !== 1 || !vor.includes('\n          GH_TOKEN: ${{ github.token }}\n') || (text.match(/github\.token/g) ?? []).length !== 1) v.push('gh-token');
  if (/secrets\./.test(text)) v.push('Secrets');
  if (/\bvars\./.test(text)) v.push('Variablen');
  if (/anthropic/i.test(text)) v.push('Anthropic');
  if (/BOT_APP_|create-github-app-token/.test(text)) v.push('App-Token');
  if (/CODE_PILOT/.test(text)) v.push('alter Schalter CODE_PILOT_*');
  // Nur zwei Nennungen, beide claude-pruefer: der Environment-Name des Schrankenjobs und die eine feste Zuweisung, mit der
  // der Vorjob dieses Environment liest. Keine weitere Nennung, auch nicht in Kommentaren.
  if (JSON.stringify(text.split('\n').filter(z => /claude/i.test(z))) !== JSON.stringify(KI_CLAUDE_ZEILEN)
    || (text.match(/claude/gi) ?? []).length !== 2 || !vor.includes(`\n${KI_CLAUDE_ZEILEN[0]}\n`)) v.push('claude');
  const namen = [...text.matchAll(/^ {4}name: (.+)$/gm)].map(m => m[1].trim());
  if ([...Object.keys(j), ...namen].some(n => PFLICHTCHECKS.includes(n))) v.push('pflichtcheck-name');
  if (!/\n {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 5\n/.test(vor) || !/\n {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 2\n/.test(sch)) v.push('runner');
  return v;
}

// Ueber alle Workflows: claude-pruefer nur in agent-pruefer-ki.yml, dort genau einmal als Environment und genau einmal
// als feste Zuweisung im Vorjob (der das Environment liest); claude-bot nur in agent-auftrag.yml.
function regelnUebergreifend(texte) {
  const v = [];
  const zaehle = (t, w) => t.split(w).length - 1;
  const pruefer = Object.entries(texte).filter(([, t]) => t.includes('claude-pruefer'));
  if (pruefer.length !== 1 || pruefer[0][0] !== KI || zaehle(pruefer[0][1], 'claude-pruefer') !== 2
    || zaehle(pruefer[0][1], '\n    environment:\n      name: claude-pruefer\n') !== 1
    || zaehle(pruefer[0][1], `\n${KI_CLAUDE_ZEILEN[0]}\n`) !== 1) v.push('claude-pruefer');
  const bot = Object.entries(texte).filter(([, t]) => t.includes('claude-bot')).map(([n]) => n);
  if (JSON.stringify(bot) !== JSON.stringify([AGENT])) v.push('claude-bot');
  return v;
}

test('A8 (B2.3a): ueber alle Workflows claude-pruefer genau einmal und nur in agent-pruefer-ki.yml, claude-bot nur in agent-auftrag.yml', () => {
  const texte = Object.fromEntries(readdirSync(ORDNER).sort().map(n => [n, lies(n)]));
  assert.ok(texte[AGENT].includes('claude-bot'), 'Muss-Treffer: claude-bot in agent-auftrag.yml');
  assert.deepEqual(regelnUebergreifend(texte), []);
  const rot = [
    ['claude-pruefer in agent-auftrag.yml', { ...texte, [AGENT]: texte[AGENT].replace('      name: claude-bot\n', '      name: claude-pruefer\n') }, 'claude-pruefer'],
    ['claude-bot als Environment im KI-Workflow', { ...texte, [KI]: texte[KI].replace('name: claude-pruefer', 'name: claude-bot') }, 'claude-bot'],
    ['claude-pruefer zweimal', { ...texte, [KI]: texte[KI].replace(/^name: Agent-Pruefer-KI\n/, 'name: Agent-Pruefer-KI\n# claude-pruefer\n') }, 'claude-pruefer'],
    ['claude-pruefer in tests.yml', { ...texte, 'tests.yml': `${texte['tests.yml']}# claude-pruefer\n` }, 'claude-pruefer'],
    ['Vorjob liest claude-bot', { ...texte, [KI]: texte[KI].replace('UMGEBUNG=claude-pruefer', 'UMGEBUNG=claude-bot') }, 'claude-bot'],
    ['Zuweisung im Vorjob fehlt', { ...texte, [KI]: texte[KI].replace('          UMGEBUNG=claude-pruefer\n', '') }, 'claude-pruefer'],
  ];
  for (const [was, geaendert, erwartet] of rot) {
    assert.notDeepEqual(geaendert, texte, `${was}: Muss-Treffer, die Aenderung greift`);
    assert.ok(regelnUebergreifend(geaendert).includes(erwartet), `${was}: ${JSON.stringify(regelnUebergreifend(geaendert))}`);
  }
});

test('A8 (B2.3a): agent-pruefer-ki.yml haelt alle eigenen Regeln ein; jede Regel erkennt ihren Verstoss (Muss-Treffer)', () => {
  const text = lies(KI);
  assert.deepEqual(regelnKi(text), []);
  // Klausel nur in der Bedingung des genannten Jobs ersetzen (dieselben Ausdruecke stehen auch in env).
  const inBedingung = (t, job, alt, neu) => {
    const block = kiJobs(t)[job].slice(0, -1);
    const bed = /\n {4}if: >-\n((?: {6}.*\n)+)/.exec(block)[0];
    assert.equal(bed.split(alt).length, 2, `Muss-Treffer: ${alt} genau einmal in der Bedingung von ${job}`);
    assert.equal(t.split(block).length, 2);
    return t.replace(block, () => block.replace(bed, () => bed.replace(alt, () => neu)));
  };

  const rot = [
    ['claude-bot als Environment', text.replace('name: claude-pruefer', 'name: claude-bot'), 'environment'],
    ['zweiter Environment-Job', text.replace('    timeout-minutes: 5\n', '    timeout-minutes: 5\n    environment:\n      name: x\n'), 'environment'],
    ['Environment einzeilig', text.replace('    environment:\n      name: claude-pruefer\n', '    environment: claude-pruefer\n'), 'environment'],
    ['Schrankenjob mit Recht', text.replace('    permissions: {}\n    steps:', '    permissions:\n      actions: read\n    steps:'), 'rechte-schranke'],
    ['Vorjob mit Schreibrecht', text.replace('      actions: read\n', '      actions: write\n'), 'schreibrecht'],
    ['Vorjob mit drittem Recht', text.replace('      pull-requests: read\n', '      pull-requests: read\n      contents: read\n'), 'rechte-vorjob'],
    ['Vorjob ohne pull-requests', text.replace('      pull-requests: read\n', ''), 'rechte-vorjob'],
    ['Rechte oben', text.replace('\npermissions: {}\n', '\npermissions:\n  actions: read\n'), 'rechte-oben'],
    ['needs entfernt', text.replace('    needs: schranke_vorpruefung\n', ''), 'needs'],
    ['Erfolgsbedingung entfernt', text.replace(" &&\n      needs.schranke_vorpruefung.result == 'success'", ''), 'bedingung'],
    ['Erfolgsbedingung gelockert', text.replace("needs.schranke_vorpruefung.result == 'success'", "needs.schranke_vorpruefung.result != 'failure'"), 'bedingung'],
    ['branches entfernt', text.replace('    branches: [main]\n', ''), 'ausloeser-block'],
    ['anderer Quellworkflow', text.replace('workflows: [Agent-Vorpruefung]', 'workflows: [Agent-Auftrag]'), 'ausloeser-block'],
    ['Eingabe versuch entfernt', text.replace('      versuch:\n        description: Versuch (run_attempt) dieses Laufs\n        required: true\n        type: string\n', ''), 'ausloeser-block'],
    ['Eingabe versuch optional', text.replace('Versuch (run_attempt) dieses Laufs\n        required: true', 'Versuch (run_attempt) dieses Laufs\n        required: false'), 'ausloeser-block'],
    ['Gruppe pro Lauf', text.replace('  group: agent-pruefer-ki\n', '  group: agent-pruefer-ki-${{ github.run_id }}\n'), 'gruppe'],
    ['cancel-in-progress true', text.replace('  cancel-in-progress: false\n', '  cancel-in-progress: true\n'), 'gruppe'],
    ['pull_request ergaenzt', text.replace('\non:\n', '\non:\n  pull_request:\n    branches: [main]\n'), 'ausloeser'],
    ['issues ergaenzt', text.replace('\non:\n', '\non:\n  issues:\n    types: [labeled]\n'), 'ausloeser'],
    ['secrets.X', text.replace('A6_KI_EREIGNIS: ${{ github.event_name }}\n          A6_KI_LAUF', 'A6_KI_EREIGNIS: ${{ secrets.X }}\n          A6_KI_LAUF'), 'Secrets'],
    ['vars.X', text.replace('A6_KI_EREIGNIS: ${{ github.event_name }}\n          A6_KI_LAUF', 'A6_KI_EREIGNIS: ${{ vars.X }}\n          A6_KI_LAUF'), 'Variablen'],
    ['actions/checkout', text.replace('    steps:\n      - name: Environment', '    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - name: Environment'), 'uses'],
    ['Ausdruck im run-Text', text.replace('          REPO=noah04091/agenten-probe\n', '          REPO=${{ github.repository }}\n'), 'ausdruck-im-run'],
    ['GH_TOKEN im Schrankenjob', text.replace('          A6_KI_QUELLE:', '          GH_TOKEN: ${{ github.token }}\n          A6_KI_QUELLE:'), 'gh-token'],
    ['zweites Token im Vorjob', text.replace('          A6_KI_EREIGNIS: ${{ github.event_name }}\n          A6_KI_LAUF', '          A6_KI_EREIGNIS: ${{ github.event_name }}\n          A6_LESE: ${{ github.token }}\n          A6_KI_LAUF'), 'gh-token'],
    ['Job-Name tests', text.replace('  schranke_vorpruefung:\n    if:', '  schranke_vorpruefung:\n    name: tests\n    if:'), 'pflichtcheck-name'],
    ['Anthropic', text.replace(/^name: Agent-Pruefer-KI\n/, 'name: Agent-Pruefer-KI\n# ANTHROPIC_API_KEY\n'), 'Anthropic'],
    ['Claude-Nennung', text.replace(/^name: Agent-Pruefer-KI\n/, 'name: Agent-Pruefer-KI\n# Claude\n'), 'claude'],
    ['Environment-Name ein drittes Mal im run-Text', text.replace('          REPO=noah04091/agenten-probe\n', '          REPO=noah04091/agenten-probe # claude-pruefer\n'), 'claude'],
    ['Zuweisung in den Schrankenjob verschoben', text.replace('          UMGEBUNG=claude-pruefer\n', '').replace('          set -euo pipefail\n          [[ "$A6_KI_QUELLE"', '          set -euo pipefail\n          UMGEBUNG=claude-pruefer\n          [[ "$A6_KI_QUELLE"'), 'claude'],
    ['App-Schluessel', text.replace(/^name: Agent-Pruefer-KI\n/, 'name: Agent-Pruefer-KI\n# BOT_APP_ID\n'), 'App-Token'],
    ['anderer Runner', text.replace('    runs-on: ubuntu-24.04\n    timeout-minutes: 2\n', '    runs-on: ubuntu-latest\n    timeout-minutes: 2\n'), 'runner'],
    ['laengere Laufzeit Vorjob', text.replace('    timeout-minutes: 5\n', '    timeout-minutes: 60\n'), 'runner'],
  ];
  // Jede Klausel der Bedingung B einzeln, je im Vorjob (1. Vorkommen) und im Schrankenjob (2. Vorkommen), durch true ersetzt.
  for (const klausel of KI_B_KLAUSELN) {
    for (const job of ['schranke_vorpruefung', 'schranke']) {
      rot.push([`Klausel ${klausel} (${job})`, inBedingung(text, job, klausel, 'true'), 'bedingung']);
    }
  }

  for (const [was, geaendert, erwartet] of rot) {
    assert.notEqual(geaendert, text, `${was}: Muss-Treffer, die Aenderung greift`);
    assert.ok(regelnKi(geaendert).includes(erwartet), `${was}: ${JSON.stringify(regelnKi(geaendert))}`);
  }
  assert.ok(rot.length >= 50);
});
