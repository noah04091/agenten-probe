
{/* Code-Pilot: kontrollierte Veroeffentlichung genau zweier gepruefter Dateien.
   Erst nach Integrationstests in einem Freigabejob aktivieren.
   Keine Commits auf main und niemals ein automatischer Merge. */}

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareReleasePlan } from './agent-code-release-plan.mjs';
import { checkCodeChanges } from './agent-code-change-check.mjs';
import { validateLiveCodeEvent } from './agent-code-issue-live-check.mjs';

const REPO = 'noah04091/agenten-probe';
const OWNER = 'noah04091';
const FILES = ['src/rechne.js', 'test/rechne.test.js'];
const API = `https://api.github.com/repos/${REPO}`;
const PACKAGE_NAME = 'code-pilot-package.json';
const MAX_PACKAGE = 60_000;

function refuse(reason) {
  throw new Error(`Code-Veroeffentlichung abgelehnt: ${reason}`);
}

function isSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Gleiche Rechnung wie `git hash-object`: so heisst der Blob auf GitHub.
function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

// A1b: Nur das Paket, das Job 2 geprueft hat, darf veroeffentlicht werden.
// Job 2 reicht den SHA-256 des Pakets weiter, hier wird er nachgerechnet,
// bevor ueberhaupt eine Anfrage an GitHub geht.
function loadVerifiedPackage(env, root, baseSha) {
  const expected = env.CODE_PILOT_PACKAGE_SHA256;

  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    refuse('Paket-Hash aus der Pruefung fehlt oder ist ungueltig');
  }

  if (typeof env.RUNNER_TEMP !== 'string' || !isAbsolute(env.RUNNER_TEMP)) {
    refuse('Ablage des geprueften Pakets fehlt');
  }

  const path = join(env.RUNNER_TEMP, PACKAGE_NAME);
  let bytes;

  try {
    if (statSync(path).size > MAX_PACKAGE) {
      bytes = null;
    } else {
      bytes = readFileSync(path);
    }
  } catch {
    refuse('Gepruefte Paketdatei nicht lesbar');
  }

  if (!bytes) {
    refuse('Paketdatei zu gross');
  }

  if (sha256(bytes) !== expected) {
    refuse('Paket-Hash weicht ab: geladen ist nicht gleich geprueft');
  }

  let data;

  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse('Gepruefte Paketdatei ist kein JSON');
  }

  if (
    data?.repository !== REPO ||
    data?.issue !== 38 ||
    data?.baseSha !== baseSha
  ) {
    refuse('Paket gehoert nicht zu diesem Auftrag oder Ausgangscommit');
  }

  if (!Array.isArray(data?.files) || data.files.length !== FILES.length) {
    refuse('Paketinhalt hat den falschen Umfang');
  }

  return FILES.map((file, index) => {
    const entry = data.files[index];

    if (entry?.path !== file || typeof entry.base64 !== 'string') {
      refuse(`Paketinhalt enthaelt unerwarteten Eintrag: ${file}`);
    }

    const packed = Buffer.from(entry.base64, 'base64');
    let local;

    try {
      local = readFileSync(resolve(root, file));
    } catch {
      refuse(`Gepruefte Datei nicht lesbar: ${file}`);
    }

    if (
      packed.toString('base64') !== entry.base64 ||
      sha256(packed) !== entry.sha256 ||
      !packed.equals(local)
    ) {
      refuse(`Paketinhalt weicht von der Arbeitskopie ab: ${file}`);
    }

    return { path: file, bytes: packed, blob: gitBlobSha(packed) };
  });
}

export async function publishCodePilot(
  event,
  env,
  request = fetch,
  root = process.cwd(),
  log = message => console.error(message)
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

  const verified = loadVerifiedPackage(env, root, plan.baseSha);
  const blobOf = Object.fromEntries(verified.map(f => [f.path, f.blob]));

  const source = verified.map(file => ({
    path: file.path,
    mode: '100644',
    type: 'blob',
    content: file.bytes.toString('utf8'),
  }));

  // Startfreigabe und aktuellen main-Stand live pruefen.
  await validateLiveCodeEvent(event, env, request);

  async function send(endpoint, method = 'GET', body, token = env.GH_TOKEN) {
    try {
      return await request(`${API}/${endpoint}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
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
  }

  async function parse(response, method, endpoint) {
    if (!response?.ok) {
      refuse(`GitHub hat Anfrage abgelehnt: ${method} ${endpoint}`);
    }

    try {
      return await response.json();
    } catch {
      refuse('GitHub lieferte ungueltige JSON-Daten');
    }
  }

  async function api(endpoint, method = 'GET', body) {
    return parse(await send(endpoint, method, body), method, endpoint);
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

  // A1b: Der Baum auf GitHub muss genau die gepruefte Bytefolge tragen.
  const fullTree = await api(`git/trees/${tree.sha}?recursive=1`);

  if (
    fullTree?.sha !== tree.sha ||
    fullTree?.truncated !== false ||
    !Array.isArray(fullTree?.tree)
  ) {
    refuse('Neuer Git-Baum nicht vollstaendig lesbar');
  }

  for (const file of verified) {
    const entries = fullTree.tree.filter(entry => entry?.path === file.path);

    if (
      entries.length !== 1 ||
      entries[0].type !== 'blob' ||
      entries[0].mode !== '100644' ||
      entries[0].sha !== file.blob
    ) {
      refuse(`Blob im neuen Baum weicht von der Pruefung ab: ${file.path}`);
    }
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
  let branchAttempted = false;
  let branchCreated = false;

  try {
    branchAttempted = true;

    const created = await send('git/refs', 'POST', {
      ref: branchRef,
      sha: commit.sha,
    });

    // Nur eine erfolgreiche Antwort belegt, dass DIESER Lauf den Branch
    // angelegt hat. GitHub lehnt einen schon vorhandenen Ref ab.
    if (created?.ok) {
      branchCreated = true;
    }

    await parse(created, 'POST', 'git/refs');

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
          file.status !== 'modified' ||
          file.sha !== blobOf[file.filename]
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
  } catch (error) {
    if (branchAttempted) {
      await reportAndCleanUp(error);
    }

    throw error;
  }

  // A1a: Aufraeumen nur, wenn ALLE Bedingungen belegt sind. Sonst bleibt
  // der Branch stehen und der Grund steht im Log und im Issue.
  // Diese Funktion wirft nie, damit der urspruengliche Fehler erhalten bleibt.
  async function cleanUpBranch() {
    try {
      const expected =
        `wp/38-code-pilot-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;

      if (
        plan.branch !== expected ||
        !/^wp\/38-code-pilot-[1-9][0-9]*-[1-9][0-9]*$/.test(plan.branch)
      ) {
        return 'der Branch-Name entspricht nicht dem fuer diesen Lauf berechneten Namen';
      }

      if (!branchCreated) {
        return 'die Anlage des Branches in diesem Lauf ist nicht bestaetigt';
      }

      const tipResponse = await send(`git/ref/heads/${plan.branch}`);

      if (!tipResponse?.ok) {
        return `die Spitze des Branches ist nicht lesbar (HTTP ${tipResponse?.status})`;
      }

      const tip = await tipResponse.json();

      if (Array.isArray(tip) || tip?.ref !== branchRef) {
        return 'die Spitze des Branches ist nicht eindeutig';
      }

      if (tip?.object?.sha !== commit.sha) {
        return `die Spitze ${String(tip?.object?.sha).slice(0, 40)} ist nicht der Commit dieses Laufs`;
      }

      const head = encodeURIComponent(`${OWNER}:${plan.branch}`);
      const listResponse = await send(
        `pulls?state=all&head=${head}&per_page=100`
      );

      if (!listResponse?.ok) {
        return `die Liste der Pull Requests ist nicht lesbar (HTTP ${listResponse?.status})`;
      }

      const pulls = await listResponse.json();

      if (!Array.isArray(pulls)) {
        return 'die Liste der Pull Requests ist nicht lesbar';
      }

      if (pulls.length > 0) {
        return `zu diesem Branch gibt es bereits einen Pull Request (#${pulls[0]?.number})`;
      }

      const removed = await send(`git/refs/heads/${plan.branch}`, 'DELETE');

      if (!removed?.ok) {
        return `GitHub hat das Loeschen abgelehnt (HTTP ${removed?.status})`;
      }

      return null;
    } catch (error) {
      return `das Aufraeumen ist fehlgeschlagen (${error instanceof Error ? error.message : 'unbekannt'})`;
    }
  }

  async function reportAndCleanUp(error) {
    try {
      const reason = await cleanUpBranch();
      const cause = String(
        error instanceof Error ? error.message : error
      ).slice(0, 500);

      const message = [
        `Code-Pilot-Lauf ${env.GITHUB_RUN_ID} (Versuch ${env.GITHUB_RUN_ATTEMPT}) abgebrochen.`,
        `Grund: ${cause}`,
        reason === null
          ? `Branch ${plan.branch} wurde geloescht: in diesem Lauf angelegt, Spitze ${commit.sha}, kein Pull Request.`
          : `Branch ${plan.branch} wurde nicht geloescht, weil ${reason}. Bitte von Hand pruefen.`,
        'Es wurde nichts gemergt.',
      ].join('\n');

      log(message);

      try {
        // Eigenes Token fuer den Kommentar (im Workflow das Job-Token mit
        // issues: write), damit das App-Token keine Issue-Schreibrechte braucht.
        const commentToken =
          typeof env.CODE_PILOT_COMMENT_TOKEN === 'string' &&
          env.CODE_PILOT_COMMENT_TOKEN !== ''
            ? env.CODE_PILOT_COMMENT_TOKEN
            : env.GH_TOKEN;

        const response = await send(
          `issues/${plan.issueNumber}/comments`,
          'POST',
          { body: message },
          commentToken
        );

        if (!response?.ok) {
          log(`Issue-Kommentar nicht geschrieben (HTTP ${response?.status}).`);
        }
      } catch {
        log('Issue-Kommentar nicht geschrieben (Anfrage fehlgeschlagen).');
      }
    } catch {
      // Bericht darf den urspruenglichen Fehler nie ersetzen.
    }
  }
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
