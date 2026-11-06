
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { routeCodeIssue } from './agent-code-issue-route.mjs';

const REPO = 'noah04091/agenten-probe';
const OWNER = 'noah04091';
const API_ROOT = `https://api.github.com/repos/${REPO}`;
const PILOT_ISSUE = 38;

function refuse(message) {
  throw new Error(`Code-Live-Pruefung abgelehnt: ${message}`);
}

export function validateCurrentCodeIssue(issue, number) {
  if (
    number !== PILOT_ISSUE ||
    issue?.number !== PILOT_ISSUE ||
    issue?.state !== 'open' ||
    issue?.pull_request ||
    issue?.repository_url !== API_ROOT ||
    issue?.user?.login !== OWNER
  ) {
    refuse('Issue ist nicht der zugelassene offene Code-Auftrag');
  }

  if (
    !Array.isArray(issue.labels) ||
    !issue.labels.every(
      label => typeof label?.name === 'string'
    )
  ) {
    refuse('Ungueltige aktuelle Issue-Labels');
  }

  const names = issue.labels.map(label => label.name);

  const startLabels = names.filter(
    name => name === 'bot-auftrag'
  );

  const taskTypes = names.filter(
    name => name.startsWith('agent:')
  );

  if (
    startLabels.length !== 1 ||
    taskTypes.length !== 1 ||
    taskTypes[0] !== 'agent:code-pilot'
  ) {
    refuse('Startfreigabe oder Code-Aufgabentyp fehlt');
  }
}

export async function validateLiveCodeEvent(
  event,
  env = process.env,
  request = fetch
) {
  // Zuerst das urspruengliche Start-Ereignis pruefen.
  const route = routeCodeIssue(
    event,
    env.GITHUB_REPOSITORY,
    env.GITHUB_ACTOR
  );

  if (
    env.GITHUB_REF !== 'refs/heads/main' ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
  ) {
    refuse('Ungueltiger main-Ausgangspunkt');
  }

  if (
    typeof env.GH_TOKEN !== 'string' ||
    env.GH_TOKEN.length === 0
  ) {
    refuse('GitHub-Lesetoken fehlt');
  }

  // Ausschliesslich feste GitHub-API-Pfade verwenden.
  async function readGitHub(path) {
    let response;

    try {
      response = await request(`${API_ROOT}/${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      refuse('GitHub-API nicht erreichbar');
    }

    if (!response?.ok) {
      refuse('GitHub-API antwortet nicht erfolgreich');
    }

    try {
      return await response.json();
    } catch {
      refuse('GitHub-API lieferte ungueltige Daten');
    }
  }

  // Aktuellen Issue-Status inklusive Labels abfragen.
  const currentIssue = await readGitHub(
    `issues/${PILOT_ISSUE}`
  );

  validateCurrentCodeIssue(
    currentIssue,
    Number(route.issueNumber)
  );

  // main muss weiterhin auf dem freigegebenen
  // Ausgangscommit stehen.
  const main = await readGitHub('branches/main');

  if (main?.commit?.sha !== env.GITHUB_SHA) {
    refuse('main wurde seit dem Auftrag veraendert');
  }

  return route;
}

// Direkte Ausfuehrung in GitHub Actions.
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

    const result = await validateLiveCodeEvent(event);

    appendFileSync(
      outputPath,
      `issue_number=${result.issueNumber}\n` +
      `task_type=${result.taskType}\n`
    );

    console.log(
      `Code-Live-Pruefung bestanden: Issue #${result.issueNumber}`
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Code-Live-Pruefung fehlgeschlagen'
    );

    process.exitCode = 1;
  }
}
