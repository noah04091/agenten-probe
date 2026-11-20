// A8 (Ziel A, Stilllegung der alten Agenten-Pipeline). Nach A8 ist agent-auftrag.yml der einzige Workflow mit
// einem Agentenpfad. Diese Wache ersetzt die Sperren der entfernten Workflows (claude-agent-sperre fuer
// claude-agent.yml, Aktivierungspruefung mit Fingerabdruck fuer code-pilot-claude-stufe.yml): Statt einen
// stillgelegten zweiten Pfad zu bewachen, verbietet sie jeden zweiten Pfad.
//   1. Es gibt genau die vier genehmigten Workflow-Dateien. Jede weitere braucht eine sichtbare Aenderung hier.
//   2. Ausser agent-auftrag.yml startet kein Workflow durch Issues, Kommentare, Zeitplan oder Hand, und keiner
//      kennt Environment, Secrets, Claude, ein App-Token oder den alten Schalter CODE_PILOT_ENABLED.
// Den Inhalt von agent-auftrag.yml selbst bindet der Hash in agent-code-job.test.mjs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORDNER = join(ROOT, '.github', 'workflows');
const AGENT = 'agent-auftrag.yml';
const GENEHMIGT = [AGENT, 'build.yml', 'schutz.yml', 'tests.yml'];
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

test('A8: genau die vier genehmigten Workflow-Dateien', () => {
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

  for (const name of GENEHMIGT.filter(n => n !== AGENT)) {
    const text = lies(name);
    const an = ausloeser(text);
    assert.ok(an.length > 0 && an.every(a => a === 'pull_request' || a === 'push'), `${name}: Ausloeser ${an.join(',')} nicht erlaubt`);
    for (const [muster, was] of AGENTENMUSTER) {
      assert.doesNotMatch(text, muster, `${name}: ${was} ausserhalb von ${AGENT}`);
    }
  }
});
