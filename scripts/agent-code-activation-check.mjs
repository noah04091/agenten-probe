// Code-Pilot A4: prueft die Aktivierungsstellen und Sicherheitsbedingungen
// in .github/workflows/code-pilot-claude-stufe.yml.
//
// Zwei sichere Zustaende:
//   gesperrt: Job 1 und Job 3 beginnen mit `false &&` (Stand vor A4)
//   Schalter: Job 1 und Job 3 beginnen mit `vars.CODE_PILOT_ENABLED == 'true' &&`
// Jeder andere Zustand ist ein Fehler. Laeuft im Integrationstest des Workflows
// und zusaetzlich in `npm test` (Pflichtpruefung `tests`), damit ein
// uebersprungener Job nie als Nachweis zaehlt.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORKFLOW = '.github/workflows/code-pilot-claude-stufe.yml';
export const SWITCH_GATE = "vars.CODE_PILOT_ENABLED == 'true' &&";
export const LOCKED_GATE = 'false &&';

// Fingerabdruck (SHA-256, LF-Zeilenenden) der zwei einzigen erlaubten Fassungen.
// Die Einzelpruefungen unten liefern verstaendliche Fehlermeldungen; der
// Fingerabdruck faengt alles, was sie nicht sehen (Leerzeilen in Bloecken,
// Schritt-if, zusaetzliche Argumente, Umleitungen ueber env, ...). Jede
// gewollte Aenderung am Workflow muss diesen Wert sichtbar im Review anpassen.
export const FINGERPRINTS = Object.freeze({
  locked: '3561cc94213d7b868da41c5023b9d79bf53d51a2f9bab16ec71fcb18251eb7f8',
  switch: 'fe8f0580949655f239e1bd1f3ca91d8c8fb7501dc95c93f882a0cc4f4b70c2b1',
});

const JOBS = [
  'integrationstest',
  'claude_generator',
  'codepaket_pruefen',
  'veroeffentlichung_vorbereiten',
];

// Bedingungen nach der Sperre, Zeile fuer Zeile und in dieser Reihenfolge.
const GENERATOR_IF = [
  "github.event_name == 'issues' &&",
  "github.repository == 'noah04091/agenten-probe' &&",
  "github.ref == 'refs/heads/main' &&",
  "github.actor == 'noah04091' &&",
  "github.event.action == 'labeled' &&",
  "github.event.label.name == 'bot-auftrag' &&",
  'github.event.issue.number == 38 &&',
  "github.event.issue.state == 'open' &&",
  "github.event.issue.user.login == 'noah04091' &&",
  "contains(github.event.issue.labels.*.name, 'agent:code-pilot')",
];

const PUBLISHER_IF = [
  "needs.claude_generator.result == 'success' &&",
  "needs.codepaket_pruefen.result == 'success' &&",
  "github.event_name == 'issues' &&",
  "github.repository == 'noah04091/agenten-probe' &&",
  "github.ref == 'refs/heads/main' &&",
  "github.actor == 'noah04091' &&",
  "github.event.action == 'labeled' &&",
  "github.event.label.name == 'bot-auftrag' &&",
  'github.event.issue.number == 38',
];

// Integrationstest: bei jedem PR aus diesem Repository, nicht nur aus einem Branch.
const INTEGRATION_IF = [
  "github.event_name == 'pull_request' &&",
  "github.repository == 'noah04091/agenten-probe' &&",
  'github.event.pull_request.head.repo.full_name == github.repository',
];

function fail(message) {
  throw new Error(`Aktivierungspruefung: ${message}`);
}

function count(text, part) {
  return text.split(part).length - 1;
}

function jobSection(yaml, job) {
  const head = `\n  ${job}:\n`;

  if (count(yaml, head) !== 1) {
    fail(`Job ${job} nicht genau einmal vorhanden`);
  }

  const rest = yaml.slice(yaml.indexOf(head) + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

// Zeilen eines `if: >-` auf Job-Ebene, ohne Einrueckung.
function jobIf(section, job) {
  const lines = section.split('\n');
  const start = lines.indexOf('    if: >-');

  if (start < 0 || count(section, '\n    if:') !== 1) {
    fail(`Job ${job} braucht genau eine if-Bedingung als Block`);
  }

  const result = [];

  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('      ') || line.trim() === '') break;
    result.push(line.trim());
  }

  return result;
}

// Werte eines permissions-Blocks auf Job-Ebene, Kommentare ausgenommen.
function jobPermissions(section, job) {
  if (section.includes('\n    permissions: {}\n')) {
    return [];
  }

  const lines = section.split('\n');
  const start = lines.indexOf('    permissions:');

  if (start < 0) {
    fail(`Job ${job} braucht eigene Rechte`);
  }

  const result = [];

  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith('#')) continue;
    if (!line.startsWith('      ') || line.trim() === '') break;
    result.push(line.trim());
  }

  return result.sort();
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {string} text Inhalt von code-pilot-claude-stufe.yml
 * @param {{ mode?: 'any' | 'switch' | 'locked' }} options
 * @returns {'switch' | 'locked'}
 */
export function checkActivation(text, { mode = 'any' } = {}) {
  const yaml = String(text).replace(/\r\n/g, '\n');

  // Workflow-Ebene.
  if (count(yaml, '\npermissions: {}\n') !== 1) {
    fail('Workflow braucht permissions: {} auf oberster Ebene');
  }

  for (const word of [
    'pull_request_' + 'target',
    'workflow_' + 'dispatch',
    'workflow_' + 'run',
    'sched' + 'ule:',
    'continue-on-' + 'error',
  ]) {
    if (yaml.includes(word)) {
      fail(`Workflow enthaelt Unzulaessiges: ${word}`);
    }
  }

  const jobs = yaml.slice(yaml.indexOf('\njobs:\n')).match(/\n {2}[a-z_]+:\n/g) ?? [];

  if (!same(jobs.map(j => j.trim().slice(0, -1)), JOBS)) {
    fail(`genau diese Jobs erwartet: ${JOBS.join(', ')}`);
  }

  const integration = jobSection(yaml, 'integrationstest');
  const generator = jobSection(yaml, 'claude_generator');
  const check = jobSection(yaml, 'codepaket_pruefen');
  const publisher = jobSection(yaml, 'veroeffentlichung_vorbereiten');

  // Die beiden Sperren.
  const generatorIf = jobIf(generator, 'claude_generator');
  const publisherIf = jobIf(publisher, 'veroeffentlichung_vorbereiten');
  const gate = generatorIf[0];

  if (gate !== publisherIf[0]) {
    fail('Job 1 und Job 3 muessen dieselbe Sperre tragen');
  }

  let state;

  if (gate === SWITCH_GATE) {
    state = 'switch';
  } else if (gate === LOCKED_GATE) {
    state = 'locked';
  } else {
    fail(`unbekannte Sperre in Job 1 und Job 3: ${gate}`);
  }

  if (mode !== 'any' && mode !== state) {
    fail(`erwartet ${mode === 'switch' ? 'Schalter' : 'harte Sperre'}, gefunden ${state === 'switch' ? 'Schalter' : 'harte Sperre'}`);
  }

  // Der Schalter darf nirgends sonst stehen und nicht anders geschrieben sein.
  if (count(yaml, 'CODE_PILOT_ENABLED') !== (state === 'switch' ? 2 : 0)) {
    fail('CODE_PILOT_ENABLED nur in den beiden Sperren erlaubt');
  }

  if (!same(generatorIf.slice(1), GENERATOR_IF)) {
    fail('Bedingungen von Job 1 veraendert');
  }

  if (!same(publisherIf.slice(1), PUBLISHER_IF)) {
    fail('Bedingungen von Job 3 veraendert');
  }

  // Integrationstest: nach A4 bei jedem PR aus diesem Repository.
  if (state === 'switch') {
    if (yaml.includes('wp/26-agent-' + 'code-pilot')) {
      fail('Workflow verweist noch auf den alten Entwicklungsbranch');
    }

    if (!same(jobIf(integration, 'integrationstest'), INTEGRATION_IF)) {
      fail('Integrationstest muss bei jedem PR aus diesem Repository laufen');
    }

    if (count(integration, '\n          node scripts/agent-code-activation-check.mjs --switch\n') !== 1) {
      fail('Integrationstest muss die Aktivierungspruefung mit --switch ausfuehren');
    }
  }

  if (!same(jobPermissions(integration, 'integrationstest'), ['contents: read'])) {
    fail('Integrationstest darf nur lesen');
  }

  // Menschliche Freigabe vor Job 1 und Job 3.
  for (const [job, section] of [['claude_generator', generator], ['veroeffentlichung_vorbereiten', publisher]]) {
    if (count(section, '\n    environment:\n      name: claude-bot\n') !== 1) {
      fail(`Job ${job} braucht das Environment claude-bot`);
    }
  }

  if (count(yaml, 'environment:') !== 2) {
    fail('Environment nur in Job 1 und Job 3');
  }

  // Rechte je Job.
  if (!same(jobPermissions(generator, 'claude_generator'), ['contents: read', 'issues: read'])) {
    fail('Job 1 darf nur lesen');
  }

  if (!same(jobPermissions(check, 'codepaket_pruefen'), [])) {
    fail('Job 2 darf keine Rechte haben');
  }

  if (!same(jobPermissions(publisher, 'veroeffentlichung_vorbereiten'), ['contents: read', 'issues: write'])) {
    fail('Job 3 hat andere Rechte als contents: read und issues: write');
  }

  if (!check.includes('\n    needs: claude_generator\n')) {
    fail('Job 2 muss auf Job 1 warten');
  }

  if (!publisher.includes('\n    needs:\n      - claude_generator\n      - codepaket_pruefen\n')) {
    fail('Job 3 muss auf Job 1 und Job 2 warten');
  }

  // Secrets nur dort, wo sie gebraucht werden.
  if (
    count(yaml, 'secrets.') !== 2 ||
    count(generator, '${{ secrets.ANTHROPIC_API_KEY }}') !== 1 ||
    count(publisher, '${{ secrets.BOT_APP_PRIVATE_KEY }}') !== 1
  ) {
    fail('Secrets nur ANTHROPIC_API_KEY in Job 1 und BOT_APP_PRIVATE_KEY in Job 3');
  }

  // Claude: Budget, Runden, keine Shell.
  const budget = generator.match(/\n {12}--max-budget-usd ([0-9]+(?:\.[0-9]+)?)\n/);

  if (!budget || Number(budget[1]) > 1.5 || count(generator, '--max-budget-usd') !== 1) {
    fail('Claude-Budget fehlt oder liegt ueber 1,50 $');
  }

  for (const arg of ['--max-turns 8', '--allowedTools Read,Edit,Write', '--disallowedTools Bash']) {
    if (count(generator, `\n            ${arg}\n`) !== 1) {
      fail(`Claude-Argument fehlt: ${arg}`);
    }
  }

  // Job 3: Token nur mit diesen Rechten, gepruefter Ablauf.
  const appPermissions = (publisher.match(/\n {10}permission-[a-z-]+: [a-z]+/g) ?? [])
    .map(line => line.trim())
    .sort();

  if (!same(appPermissions, [
    'permission-contents: write',
    'permission-issues: read',
    'permission-pull-requests: write',
  ])) {
    fail('App-Token von Job 3 hat andere Rechte als vorgesehen');
  }

  for (const [part, what] of [
    ['node scripts/agent-code-package.mjs apply', 'erneute Paketpruefung'],
    ['node scripts/agent-code-issue-live-check.mjs', 'Live-Pruefung des Issues'],
    ['node scripts/agent-code-publish.mjs --publish', 'gepruefter Veroeffentlicher'],
    ['CODE_PILOT_PACKAGE_SHA256: ${{ needs.codepaket_pruefen.outputs.package_sha256 }}', 'Paket-Hash aus Job 2'],
    ['CODE_PILOT_COMMENT_TOKEN: ${{ github.token }}', 'Kommentar-Token'],
    ["CODE_PILOT_PUBLISH_CONFIRM: 'issue-38-draft-only'", 'Freigabe nur fuer Issue 38 als Entwurf'],
  ]) {
    if (!publisher.includes(part)) {
      fail(`Job 3 ohne ${what}`);
    }
  }

  if (!check.includes('package_sha256: ${{ steps.paket_hash.outputs.package_sha256 }}')) {
    fail('Job 2 gibt den Paket-Hash nicht aus');
  }

  // Letzte Schranke: die Datei muss genau der gepruefte Stand sein.
  const fingerprint = createHash('sha256').update(yaml).digest('hex');

  if (fingerprint !== FINGERPRINTS[state]) {
    fail(`Workflow weicht vom geprueften Stand ab (SHA-256 ${fingerprint}); jede Aenderung braucht einen neuen, im Review geprueften Fingerabdruck`);
  }

  return state;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const flag = process.argv[2];
    const mode = flag === '--switch' ? 'switch' : flag === '--locked' ? 'locked' : flag === undefined ? 'any' : null;

    if (!mode) {
      fail('Option --switch, --locked oder keine erwartet');
    }

    const state = checkActivation(readFileSync(WORKFLOW, 'utf8'), { mode });

    console.log(state === 'switch'
      ? "Job 1 und Job 3 nur mit vars.CODE_PILOT_ENABLED == 'true' und Freigabe im Environment."
      : 'Job 1 und Job 3 hart gesperrt (false &&).');
    console.log('Bedingungen, Rechte, Secrets, Budget und Ablauf unveraendert.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
