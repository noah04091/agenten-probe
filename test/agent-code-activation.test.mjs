import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LOCKED_GATE,
  SWITCH_GATE,
  WORKFLOW,
  checkActivation,
} from '../scripts/agent-code-activation-check.mjs';

const PATCH = 'docs/a4-workflow-patch.diff';

function real() {
  return readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
}

// Stand nach A4. Solange Noah den Patch nicht angewendet hat, wird er hier
// in einer Kopie angewendet, damit der neue Zustand schon jetzt geprueft wird.
function switched() {
  const current = real();

  if (current.includes(SWITCH_GATE)) {
    return current;
  }

  assert.ok(existsSync(PATCH), 'Workflow noch gesperrt, aber kein A4-Patch vorhanden');

  const dir = mkdtempSync(join(tmpdir(), 'code-pilot-a4-'));

  try {
    mkdirSync(join(dir, dirname(WORKFLOW)), { recursive: true });
    writeFileSync(join(dir, WORKFLOW), current);
    execFileSync('git', ['apply', '--whitespace=nowarn', join(process.cwd(), PATCH)], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return readFileSync(join(dir, WORKFLOW), 'utf8').replace(/\r\n/g, '\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function change(text, from, to) {
  assert.equal(text.split(from).length, 2, `Stelle nicht genau einmal: ${from}`);
  return text.replace(from, to);
}

const JOB1_GATE = `      ${SWITCH_GATE}\n      github.event_name == 'issues' &&`;
const JOB3_GATE = `      ${SWITCH_GATE}\n      needs.claude_generator.result == 'success' &&`;

test('Aktivierung: der echte Workflow ist in einem sicheren Zustand', () => {
  assert.ok(['locked', 'switch'].includes(checkActivation(real())));
});

test('Aktivierung: der Stand nach A4 ist durch den Schalter gesichert', () => {
  assert.equal(checkActivation(switched(), { mode: 'switch' }), 'switch');
});

test('Aktivierung: falscher Zustand fuer den erwarteten Modus wird erkannt', () => {
  const after = switched();
  const current = real();

  // Solange der Patch nicht angewendet ist, ist die echte Datei die gesperrte Fassung.
  if (current.includes(LOCKED_GATE)) {
    assert.equal(checkActivation(current, { mode: 'locked' }), 'locked');
    assert.throws(() => checkActivation(current, { mode: 'switch' }), /erwartet Schalter/);
  }

  assert.throws(() => checkActivation(after, { mode: 'locked' }), /erwartet harte Sperre/);

  // Nur die zwei geprueften Fassungen sind erlaubt, keine Mischform.
  const handmade = after.split(SWITCH_GATE).join(LOCKED_GATE);
  assert.throws(() => checkActivation(handmade), /Fingerabdruck/);
});

test('Aktivierung: gueltiges YAML, das die Einzelpruefungen taeuscht, scheitert am Fingerabdruck', () => {
  const s = switched();
  const job1End = "      contains(github.event.issue.labels.*.name, 'agent:code-pilot')\n";
  const cases = [
    ['Leerzeile und || true in Job 1', change(s, job1End, job1End + '\n      || true\n')],
    ['Integrationstest per Leerzeile abgeschaltet', change(s, '      github.event.pull_request.head.repo.full_name == github.repository\n\n', '      github.event.pull_request.head.repo.full_name == github.repository\n\n      && false\n\n')],
    ['Recht nach Leerzeile', change(s, '      issues: read\n\n    steps:\n      - name: Freigegebenen main-Stand laden', '      issues: read\n\n      pull-requests: write\n\n    steps:\n      - name: Freigegebenen main-Stand laden')],
    ['Job mit Bindestrich', s + '\n  extra-job:\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: write\n    steps:\n      - run: echo x\n'],
    ['App-Recht in Anfuehrungszeichen', change(s, '          permission-pull-requests: write\n', "          permission-pull-requests: write\n          permission-administration: 'write'\n")],
    ['Schritt-if an der Live-Pruefung', change(s, '      - name: Issue-Freigabe nach Paketpruefung erneut bestaetigen\n', '      - name: Issue-Freigabe nach Paketpruefung erneut bestaetigen\n        if: false\n')],
    ['Zusaetzliche Claude-Freiheit', change(s, '            --disallowedTools Bash\n', '            --disallowedTools Bash\n            --dangerously-skip-permissions\n')],
    ['API-Schluessel umgeleitet', change(s, '\npermissions: {}\n', '\npermissions: {}\n\nenv:\n  ANTHROPIC_BASE_URL: https://example.invalid\n')],
    ['Claude-Action ungepinnt', s.replace(/anthropics\/claude-code-action@[0-9a-f]{40}/, 'anthropics/claude-code-action@main')],
  ];

  for (const [name, text] of cases) {
    assert.notEqual(text, s, `Mutation ohne Wirkung: ${name}`);
    assert.throws(() => checkActivation(text, { mode: 'switch' }), /Aktivierungspruefung/, name);
  }
});

test('Aktivierung: jede Abweichung an Sperren und Integrationstest wird erkannt', () => {
  const s = switched();
  const cases = [
    ['Sperre Job 1 entfernt', change(s, JOB1_GATE, "      github.event_name == 'issues' &&"), /dieselbe Sperre/],
    ['Sperre Job 3 entfernt', change(s, JOB3_GATE, "      needs.claude_generator.result == 'success' &&"), /dieselbe Sperre/],
    ['Schalter umgedreht', s.split(SWITCH_GATE).join("vars.CODE_PILOT_ENABLED != 'false' &&"), /unbekannte Sperre/],
    ['Schalter mit anderem Namen', s.split(SWITCH_GATE).join("vars.CODE_PILOT_ON == 'true' &&"), /unbekannte Sperre/],
    ['Sperren gemischt', change(s, JOB1_GATE, `      ${LOCKED_GATE}\n      github.event_name == 'issues' &&`), /dieselbe Sperre/],
    ['Schalter zusaetzlich verwendet', change(s, '    permissions: {}\n\n    # A1b', '    permissions: {}\n    env:\n      X: ${{ vars.CODE_PILOT_ENABLED }}\n\n    # A1b'), /nur in den beiden Sperren/],
    ['Integrationstest nur alter Branch', change(s, '      github.event.pull_request.head.repo.full_name == github.repository\n\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10', "      github.event.pull_request.head.repo.full_name == github.repository &&\n      github.event.pull_request.head.ref == 'wp/26-agent-code-pilot'\n\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10"), /alten Entwicklungsbranch/],
    ['Integrationstest abgeschaltet', change(s, "    if: >-\n      github.event_name == 'pull_request' &&", "    if: >-\n      false &&\n      github.event_name == 'pull_request' &&"), /jedem PR aus diesem Repository/],
    ['Pruefung im Integrationstest entfernt', change(s, '          node scripts/agent-code-activation-check.mjs --switch\n', ''), /--switch ausfuehren/],
    ['Pruefung im Integrationstest entschaerft', change(s, 'agent-code-activation-check.mjs --switch\n', 'agent-code-activation-check.mjs --switch || true\n'), /--switch ausfuehren/],
  ];

  for (const [name, text, error] of cases) {
    assert.throws(() => checkActivation(text, { mode: 'switch' }), error, name);
  }
});

test('Aktivierung: uebrige Sicherheitsbedingungen bleiben erzwungen', () => {
  const s = switched();
  const cases = [
    ['anderes Issue', change(s, '      github.event.issue.number == 38 &&', '      github.event.issue.number == 39 &&'), /Bedingungen von Job 1/],
    ['ohne Label-Pruefung', change(s, "      github.event.label.name == 'bot-auftrag' &&\n      github.event.issue.number == 38 &&", '      github.event.issue.number == 38 &&'), /Bedingungen von Job 1/],
    ['Job 3 ohne Erfolg von Job 2', change(s, "      needs.codepaket_pruefen.result == 'success' &&\n", ''), /Bedingungen von Job 3/],
    ['Job 3 ohne Environment', change(s, '    environment:\n      name: claude-bot\n\n    permissions:\n      contents: read\n      # A1a', '    permissions:\n      contents: read\n      # A1a'), /Environment claude-bot/],
    ['Job 1 schreibt Issues', change(s, '    permissions:\n      contents: read\n      issues: read\n\n    steps:\n      - name: Freigegebenen main-Stand laden', '    permissions:\n      contents: read\n      issues: write\n\n    steps:\n      - name: Freigegebenen main-Stand laden'), /Job 1 darf nur lesen/],
    ['Job 2 mit Rechten', change(s, '    permissions: {}\n\n    # A1b', '    permissions:\n      contents: read\n\n    # A1b'), /Job 2 darf keine Rechte/],
    ['hoeheres Budget', change(s, '--max-budget-usd 1.50', '--max-budget-usd 5.00'), /Budget/],
    ['Shell erlaubt', change(s, '            --disallowedTools Bash\n', ''), /disallowedTools Bash/],
    ['mehr Runden', change(s, '            --max-turns 8\n', '            --max-turns 80\n'), /max-turns 8/],
    ['App-Token mit Admin-Recht', change(s, '          permission-pull-requests: write\n', '          permission-pull-requests: write\n          permission-administration: write\n'), /App-Token/],
    ['Secret in Job 2', change(s, '    permissions: {}\n\n    # A1b', '    permissions: {}\n    env:\n      K: ${{ secrets.ANTHROPIC_API_KEY }}\n\n    # A1b'), /Secrets nur/],
    ['pull_request_target', change(s, '\non:\n', '\non:\n  pull_request_target:\n'), /pull_request_target/],
    ['manueller Start', change(s, '\non:\n', '\non:\n  workflow_dispatch:\n'), /workflow_dispatch/],
    ['continue-on-error', change(s, '    timeout-minutes: 20\n', '    timeout-minutes: 20\n    continue-on-error: true\n'), /continue-on-error/],
    ['zusaetzlicher Job', s + '\n  nebenbei:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo x\n', /genau diese Jobs/],
    ['Freigabe nicht nur Issue 38', change(s, "CODE_PILOT_PUBLISH_CONFIRM: 'issue-38-draft-only'", "CODE_PILOT_PUBLISH_CONFIRM: 'alles'"), /Issue 38 als Entwurf/],
    ['ohne Paket-Hash aus Job 2', change(s, 'CODE_PILOT_PACKAGE_SHA256: ${{ needs.codepaket_pruefen.outputs.package_sha256 }}', 'CODE_PILOT_PACKAGE_SHA256: x'), /Paket-Hash aus Job 2/],
    ['Job 3 schreibt Inhalte', change(s, '    permissions:\n      contents: read\n      # A1a', '    permissions:\n      contents: write\n      # A1a'), /Job 3 hat andere Rechte/],
    ['Job 2 wartet nicht auf Job 1', change(s, '    needs: claude_generator\n', ''), /Job 2 muss auf Job 1 warten/],
    ['Job 2 ohne Hash-Ausgabe', change(s, '      package_sha256: ${{ steps.paket_hash.outputs.package_sha256 }}\n', ''), /Paket-Hash nicht aus/],
    ['Workflow ohne permissions {}', change(s, '\npermissions: {}\n', '\n'), /permissions: \{\} auf oberster Ebene/],
    ['Integrationstest schreibt', change(s, '    permissions:\n      contents: read\n\n    steps:\n      - name: Repository laden', '    permissions:\n      contents: write\n\n    steps:\n      - name: Repository laden'), /Integrationstest darf nur lesen/],
    ['Job 3 wartet nicht auf Job 2', change(s, '    needs:\n      - claude_generator\n      - codepaket_pruefen\n', '    needs:\n      - claude_generator\n'), /Job 1 und Job 2 warten/],
  ];

  for (const [name, text, error] of cases) {
    assert.throws(() => checkActivation(text, { mode: 'switch' }), error, name);
  }
});

test('Aktivierung: CRLF-Zeilenenden aendern das Ergebnis nicht', () => {
  assert.equal(checkActivation(switched().replace(/\n/g, '\r\n'), { mode: 'switch' }), 'switch');
});
