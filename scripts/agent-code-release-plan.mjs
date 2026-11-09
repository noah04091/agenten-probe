
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { routeCodeIssue } from './agent-code-issue-route.mjs';

const REPO = 'noah04091/agenten-probe';
const OWNER = 'noah04091';

function refuse(message) {
  throw new Error(`Veroeffentlichungsplan abgelehnt: ${message}`);
}

export function prepareReleasePlan(event, env) {
  if (
    env?.GITHUB_REPOSITORY !== REPO ||
    env.GITHUB_EVENT_NAME !== 'issues' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_ACTOR !== OWNER
  ) {
    refuse('Ungueltiger GitHub-Kontext');
  }

  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) {
    refuse('Ungueltiger Ausgangscommit');
  }

  if (!/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '')) {
    refuse('Ungueltige Lauf-ID');
  }

  if (!/^[1-9][0-9]{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    refuse('Ungueltiger Ausfuehrungsversuch');
  }

  const route = routeCodeIssue(
    event,
    env.GITHUB_REPOSITORY,
    env.GITHUB_ACTOR
  );

  if (route.issueNumber !== '38') {
    refuse('Falsche Issue-Nummer');
  }

  return Object.freeze({
    issueNumber: 38,
    baseSha: env.GITHUB_SHA,
    branch:
      `wp/38-code-pilot-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    draft: true,
  });
}

// Direkter Aufruf erzeugt nur eine Vorschau.
// Keine GitHub-API-Aufrufe und keine Schreiboperationen.
if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (!process.env.GITHUB_EVENT_PATH) {
      refuse('GitHub-Ereignisdatei fehlt');
    }

    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')
    );

    const plan = prepareReleasePlan(event, process.env);

    console.log('Veroeffentlichungsplan erfolgreich geprueft.');
    console.log(`Issue: #${plan.issueNumber}`);
    console.log(`Ausgangscommit: ${plan.baseSha}`);
    console.log(`Geplanter Branch: ${plan.branch}`);
    console.log('Pull Request: Draft');
    console.log('Keine GitHub-Schreiboperation ausgefuehrt.');
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}
