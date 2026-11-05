
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'noah04091/agenten-probe';
const OWNER = 'noah04091';
const START_LABEL = 'bot-auftrag';
const TYPE_LABEL = 'agent:test-note';

function refuse(message) {
  throw new Error(`Auftrag abgelehnt: ${message}`);
}

export function routeIssue(event, repository, actor) {
  if (repository !== REPOSITORY || event?.repository?.full_name !== REPOSITORY) {
    refuse('Falsches Repository');
  }

  if (actor !== OWNER || event?.sender?.login !== OWNER) {
    refuse('Start nicht vom Repository-Eigentuemer');
  }

  if (event?.action !== 'labeled' || event?.label?.name !== START_LABEL) {
    refuse('Kein gueltiges Startlabel-Ereignis');
  }

  const issue = event?.issue;

  if (!issue || issue.state !== 'open' || issue.pull_request) {
    refuse('Issue nicht offen oder kein echtes Issue');
  }

  const n = issue.number;

  if (!Number.isSafeInteger(n) || n < 1) {
    refuse('Ungueltige Issue-Nummer');
  }

  if (
    !Array.isArray(issue.labels) ||
    !issue.labels.every(l => typeof l?.name === 'string')
  ) {
    refuse('Ungueltige Issue-Labels');
  }

  const labels = issue.labels.map(l => l.name);

  if (!labels.includes(START_LABEL)) {
    refuse('Startlabel fehlt am Issue');
  }

  const types = labels.filter(name => name.startsWith('agent:'));

  if (types.length !== 1 || types[0] !== TYPE_LABEL) {
    refuse('Aufgabentyp fehlt, ist mehrfach vorhanden oder nicht erlaubt');
  }

  return {
    issueNumber: String(n),
    taskType: 'test-note',
    filePath: `test/agent-issues/issue-${n}.md`,
  };
}

// Keine Ausfuehrung beim Import durch Tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const outputPath = process.env.GITHUB_OUTPUT;

    if (!eventPath || !outputPath) {
      refuse('GitHub-Actions-Umgebung fehlt');
    }

    const event = JSON.parse(readFileSync(eventPath, 'utf8'));

    const result = routeIssue(
      event,
      process.env.GITHUB_REPOSITORY,
      process.env.GITHUB_ACTOR
    );

    appendFileSync(
      outputPath,
      `issue_number=${result.issueNumber}\n` +
      `task_type=${result.taskType}\n` +
      `file_path=${result.filePath}\n`
    );

    console.log(
      `Auftrag zugelassen: Issue #${result.issueNumber}, Typ ${result.taskType}`
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error)
    );

    process.exitCode = 1;
  }
}
