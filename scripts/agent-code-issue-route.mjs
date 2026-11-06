
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'noah04091/agenten-probe';
const OWNER = 'noah04091';

const PILOT_ISSUE = 38;

const START_LABEL = 'bot-auftrag';
const TYPE_LABEL = 'agent:code-pilot';

const ALLOWED_FILES = Object.freeze([
  'src/rechne.js',
  'test/rechne.test.js',
]);

function refuse(message) {
  throw new Error(`Code-Auftrag abgelehnt: ${message}`);
}

/**
 * Prueft ausschliesslich das GitHub-Start-Ereignis.
 *
 * WICHTIG:
 * Diese Pruefung ersetzt NICHT die spaetere
 * Live-Abfrage des aktuellen GitHub-Issues.
 */
export function routeCodeIssue(event, repository, actor) {
  if (
    repository !== REPOSITORY ||
    event?.repository?.full_name !== REPOSITORY
  ) {
    refuse('Falsches Repository');
  }

  if (
    actor !== OWNER ||
    event?.sender?.login !== OWNER
  ) {
    refuse('Start nicht durch Repository-Eigentuemer');
  }

  if (
    event?.action !== 'labeled' ||
    event?.label?.name !== START_LABEL
  ) {
    refuse('Kein gueltiges Startlabel-Ereignis');
  }

  const issue = event?.issue;

  if (
    !issue ||
    issue.pull_request ||
    issue.state !== 'open'
  ) {
    refuse('Kein offenes GitHub-Issue');
  }

  // Der erste Code-Pilot darf NUR Issue #38 bearbeiten.
  if (issue.number !== PILOT_ISSUE) {
    refuse('Issue ist nicht fuer den Code-Pilot freigegeben');
  }

  if (issue.user?.login !== OWNER) {
    refuse('Issue stammt nicht vom Repository-Eigentuemer');
  }

  if (
    issue.repository_url !==
    `https://api.github.com/repos/${REPOSITORY}`
  ) {
    refuse('Issue gehoert nicht zum zugelassenen Repository');
  }

  if (
    !Array.isArray(issue.labels) ||
    !issue.labels.every(
      label => typeof label?.name === 'string'
    )
  ) {
    refuse('Ungueltige Issue-Labels');
  }

  const labels = issue.labels.map(label => label.name);

  const startLabels = labels.filter(
    name => name === START_LABEL
  );

  const taskTypes = labels.filter(
    name => name.startsWith('agent:')
  );

  if (startLabels.length !== 1) {
    refuse('Startlabel fehlt oder ist doppelt vorhanden');
  }

  if (
    taskTypes.length !== 1 ||
    taskTypes[0] !== TYPE_LABEL
  ) {
    refuse('Ungueltiger oder mehrfacher Aufgabentyp');
  }

  // Die Dateiliste ist fest im Programm hinterlegt.
  // Issue-Titel und Beschreibung koennen sie nicht aendern.
  return {
    issueNumber: String(PILOT_ISSUE),
    taskType: 'code-pilot',
    allowedFiles: [...ALLOWED_FILES],
  };
}

// Kommandozeilenmodus fuer GitHub Actions.
// Beim Import durch Tests wird nichts ausgefuehrt.
if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const outputPath = process.env.GITHUB_OUTPUT;

    if (!eventPath || !outputPath) {
      refuse('GitHub-Actions-Umgebung fehlt');
    }

    const event = JSON.parse(
      readFileSync(eventPath, 'utf8')
    );

    const result = routeCodeIssue(
      event,
      process.env.GITHUB_REPOSITORY,
      process.env.GITHUB_ACTOR
    );

    appendFileSync(
      outputPath,
      `issue_number=${result.issueNumber}\n` +
      `task_type=${result.taskType}\n`
    );

    console.log(
      `Code-Auftrag zugelassen: Issue #${result.issueNumber}`
    );

    console.log(
      `Erlaubte Dateien: ${result.allowedFiles.join(', ')}`
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Code-Auftrag abgelehnt'
    );

    process.exitCode = 1;
  }
}
