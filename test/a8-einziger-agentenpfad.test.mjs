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
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORDNER = join(ROOT, '.github', 'workflows');
const AGENT = 'agent-auftrag.yml';
const PRUEFER = 'agent-pruefer.yml';
const GENEHMIGT = [AGENT, PRUEFER, 'build.yml', 'schutz.yml', 'tests.yml'];
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

test('A8: genau die fuenf genehmigten Workflow-Dateien', () => {
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

  for (const name of GENEHMIGT.filter(n => n !== AGENT && n !== PRUEFER)) {
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
