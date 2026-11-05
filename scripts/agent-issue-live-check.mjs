
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { routeIssue } from './agent-issue-route.mjs';

const REPOSITORY = 'noah04091/agenten-probe';
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;

function refuse(message) {
  throw new Error(`Live-Pruefung abgelehnt: ${message}`);
}

export function validateCurrentIssue(issue, number) {
  if (
    !Number.isSafeInteger(number) || number < 1 ||
    issue?.number !== number || issue?.state !== 'open' ||
    issue?.pull_request || issue?.repository_url !== API_ROOT
  ) {
    refuse('Issue ist nicht der freigegebene offene Auftrag');
  }

  if (!Array.isArray(issue.labels) ||
      !issue.labels.every(label => typeof label?.name === 'string')) {
    refuse('Ungueltige Live-Labels');
  }

  const labels = issue.labels.map(label => label.name);
  const types = labels.filter(label => label.startsWith('agent:'));

  if (labels.filter(label => label === 'bot-auftrag').length !== 1 ||
      types.length !== 1 || types[0] !== 'agent:test-note') {
    refuse('Startlabel oder erlaubter Aufgabentyp fehlt');
  }
}

export async function validateLiveEvent(event, env = process.env, request = fetch) {
  const route = routeIssue(event, env.GITHUB_REPOSITORY, env.GITHUB_ACTOR);

  if (env.GITHUB_REF !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) {
    refuse('Ungueltiger main-Ausgangspunkt');
  }

  const token = env.GH_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    refuse('GitHub-Lesetoken fehlt');
  }

  async function readGitHub(path) {
    let response;
    try {
      response = await request(`${API_ROOT}/${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      refuse('GitHub-API ist nicht erreichbar');
    }

    if (!response?.ok) refuse('GitHub-API antwortet nicht erfolgreich');

    try {
      return await response.json();
    } catch {
      refuse('GitHub-API lieferte ungueltiges JSON');
    }
  }

  const currentIssue = await readGitHub(`issues/${route.issueNumber}`);
  validateCurrentIssue(currentIssue, Number(route.issueNumber));

  const main = await readGitHub('branches/main');
  if (main?.commit?.sha !== env.GITHUB_SHA) {
    refuse('main hat sich seit dem Start des Auftrags veraendert');
  }

  return route;
}

// Nur bei direkter Ausfuehrung, nicht beim Import durch Tests.
if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_OUTPUT) {
      refuse('GitHub-Actions-Umgebung fehlt');
    }

    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')
    );

    const route = await validateLiveEvent(event);

    appendFileSync(process.env.GITHUB_OUTPUT,
      `issue_number=${route.issueNumber}\n` +
      `task_type=${route.taskType}\n` +
      `file_path=${route.filePath}\n`);

    console.log(`Live-Pruefung bestanden: Issue #${route.issueNumber}`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Live-Pruefung fehlgeschlagen'
    );
    process.exitCode = 1;
  }
}
