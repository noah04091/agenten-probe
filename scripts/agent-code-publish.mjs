
{/* Code-Pilot: kontrollierte Veroeffentlichung genau zweier gepruefter Dateien.
   Erst nach Integrationstests in einem Freigabejob aktivieren.
   Keine Commits auf main und niemals ein automatischer Merge. */}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareReleasePlan } from './agent-code-release-plan.mjs';
import { checkCodeChanges } from './agent-code-change-check.mjs';
import { validateLiveCodeEvent } from './agent-code-issue-live-check.mjs';

const REPO = 'noah04091/agenten-probe';
const FILES = ['src/rechne.js', 'test/rechne.test.js'];
const API = `https://api.github.com/repos/${REPO}`;

function refuse(reason) {
  throw new Error(`Code-Veroeffentlichung abgelehnt: ${reason}`);
}

function isSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

export async function publishCodePilot(
  event,
  env,
  request = fetch,
  root = process.cwd()
) {
  // Zwei unabhaengige Aktivierungssperren.
  // Das Skript ist zunaechst deaktiviert.
  if (
    env?.CODE_PILOT_PUBLISH_ENABLED !== 'true' ||
    env.CODE_PILOT_PUBLISH_CONFIRM !== 'issue-38-draft-only'
  ) {
    refuse('Veroeffentlichung nicht freigeschaltet');
  }

  const plan = prepareReleasePlan(event, env);

  if (!env.GH_TOKEN || typeof env.GH_TOKEN !== 'string') {
    refuse('Kurzlebiges GitHub-App-Token fehlt');
  }

  // Keine vom Agenten erstellte Datei als Skript ausfuehren.
  // Beide geaenderten Dateien wurden bereits getrennt getestet.
  const changes = checkCodeChanges(root, plan.baseSha);

  if (
    changes.files.length !== 2 ||
    changes.files.some((file, index) => file !== FILES[index])
  ) {
    refuse('Unzulaessiger Aenderungsumfang');
  }

  const source = FILES.map(file => ({
    path: file,
    mode: '100644',
    type: 'blob',
    content: readFileSync(resolve(root, file), 'utf8'),
  }));

  // Startfreigabe und aktuellen main-Stand live pruefen.
  await validateLiveCodeEvent(event, env, request);

  async function api(endpoint, method = 'GET', body) {
    let response;

    try {
      response = await request(`${API}/${endpoint}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
      });
    } catch {
      refuse(`GitHub-Anfrage fehlgeschlagen: ${method} ${endpoint}`);
    }

    if (!response?.ok) {
      refuse(`GitHub hat Anfrage abgelehnt: ${method} ${endpoint}`);
    }

    try {
      return await response.json();
    } catch {
      refuse('GitHub lieferte ungueltige JSON-Daten');
    }
  }

  const parent = await api(`git/commits/${plan.baseSha}`);

  if (!isSha(parent?.tree?.sha)) {
    refuse('Ausgangsbaum ungueltig');
  }

  // Git-Baum mit genau zwei freigegebenen Dateipfaden.
  const tree = await api('git/trees', 'POST', {
    base_tree: parent.tree.sha,
    tree: source,
  });

  if (!isSha(tree?.sha)) {
    refuse('Neuer Git-Baum ungueltig');
  }

  const commit = await api('git/commits', 'POST', {
    message: 'feat: Code-Pilot Multiplikation fuer Issue #38',
    tree: tree.sha,
    parents: [plan.baseSha],
  });

  if (!isSha(commit?.sha)) {
    refuse('Neuer Git-Commit ungueltig');
  }

  // Bei geaendertem Issue oder main sofort abbrechen.
  await validateLiveCodeEvent(event, env, request);

  const branchRef = `refs/heads/${plan.branch}`;

  await api('git/refs', 'POST', {
    ref: branchRef,
    sha: commit.sha,
  });

  const remoteRef = await api(
    `git/ref/heads/${plan.branch}`
  );

  if (
    remoteRef?.ref !== branchRef ||
    remoteRef?.object?.sha !== commit.sha
  ) {
    refuse('Branch zeigt nicht auf den geprueften Commit');
  }

  const compare = await api(
    `compare/${plan.baseSha}...${commit.sha}`
  );

  const files = compare?.files;

  if (
    compare?.ahead_by !== 1 ||
    !Array.isArray(files) ||
    files.length !== 2 ||
    files.some(
      file =>
        !FILES.includes(file.filename) ||
        file.status !== 'modified'
    ) ||
    new Set(files.map(file => file.filename)).size !== 2
  ) {
    refuse('Remote-Diff verletzt die Dateigrenzen');
  }

  // Letzte Live-Pruefung vor dem PR-Schreibaufruf.
  await validateLiveCodeEvent(event, env, request);

  const currentRef = await api(
    `git/ref/heads/${plan.branch}`
  );

  if (currentRef?.object?.sha !== commit.sha) {
    refuse('Zielbranch wurde zwischenzeitlich geaendert');
  }

  const pr = await api('pulls', 'POST', {
    title: 'feat: Multiplikation durch Code-Pilot (Issue #38)',
    head: plan.branch,
    base: 'main',
    draft: true,
    body: [
      'Closes #38',
      '',
      'Automatisch erzeugter Draft-PR nach isolierter Sicherheits- und Abnahmepruefung.',
      'Nur src/rechne.js und test/rechne.test.js wurden geaendert.',
      'Manuelle Freigabe und Merge bleiben erforderlich.',
    ].join('\n'),
  });

  if (
    pr?.draft !== true ||
    pr?.base?.ref !== 'main' ||
    pr?.head?.ref !== plan.branch ||
    typeof pr?.html_url !== 'string' ||
    !pr.html_url.startsWith(
      `https://github.com/${REPO}/pull/`
    )
  ) {
    refuse('Draft-PR-Bestaetigung ungueltig, manuell pruefen');
  }

  return {
    url: pr.html_url,
    branch: plan.branch,
    commit: commit.sha,
  };
}

// Ohne ausdrueckliche Freigabe keine GitHub-Schreibaufrufe.
if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] !== '--publish') {
      refuse('Option --publish fehlt');
    }

    if (!process.env.GITHUB_EVENT_PATH) {
      refuse('GitHub-Eventdatei fehlt');
    }

    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')
    );

    const result = await publishCodePilot(
      event,
      process.env
    );

    console.log(
      `Sicherer Draft-PR erstellt: ${result.url}`
    );
    console.log('Kein Merge ausgefuehrt.');
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : String(error)
    );

    process.exitCode = 1;
  }
}
