// A6.4-2c-2: Einstieg fuer Job 3: das gebundene Paket ausschliesslich als Draft-PR veroeffentlichen.
//
// Wirkungslos bis A6.4-4: Kein Workflow ruft diesen Einstieg auf. Aufruf spaeter genau so:
//   node scripts/agent-code-job-veroeffentlichen.mjs
// ohne Argumente, nur nach erfolgreichem Job 2. Alle Eingaben kommen aus dem festen Umgebungsvertrag
// (readVeroeffentlichenContract): Repository, Ereignisart, Ereignisdatei, Lauf-ID, Laufversuch 1,
// Ausgangscommit (GITHUB_SHA), Workflow-Ref, Checkout (GITHUB_WORKSPACE), RUNNER_TEMP, PATH, der
// Auftrags-Hash aus Job 0, der Paket-Hash aus Job 1 und genau der App-Token A6_APP_TOKEN (ghs_).
// Das Paket liegt am festen Pfad unter RUNNER_TEMP. Der getrennte Pruef-Checkout liegt am festen Pfad
// RUNNER_TEMP/a6-veroeffentlichung-pruefung und muss vom Workflow frisch auf dem Ausgangscommit
// angelegt sein; dieser Einstieg legt ihn nicht an und startet keinen eigenen Prozess.
//
// Kein Prompt, keine Abnahme, kein Claude-Einstieg, keine eigene PR-, Commit- oder Branchlogik, keine
// eigene Schnappschuss- oder Live-Pruefung: Das alles erledigt publishOrderDraft, genau einmal
// aufgerufen, mit genau einem Veroeffentlichungstransport. Kein Retry, auch nicht bei unklarem Status.
//
// Ablauf (verbindliche Reihenfolge):
//  1. bis 6. Umgebungsvertrag, Repository, Workflow, Lauf-ID, Laufversuch 1, Ausgangscommit und die
//     zwei Hashformate.
//  7. Originalereignis aus der begrenzten Ereignisdatei des Runners.
//  8. und 9. Paketbytes begrenzt lesen, SHA-256 unabhaengig berechnen und vergleichen.
// 10. Vertrauenswuerdiger Checkout steht auf dem Ausgangscommit.
// 11. Getrennter Pruef-Checkout am festen Pfad.
// 12. createPublishTransport() mit festem Repository, Issue aus dem Ereignis und eigener Lauf-ID.
// 13. publishOrderDraft() genau einmal, Uhr () => new Date().
// 14. Exitcode 0 nur bei vollstaendig bestaetigtem Ablauf. Keine Job-Ausgabe, keine PR-Nummer.
//
// Ausgabe: bei Erfolg nichts. Bei jedem Fehler genau eine Zeile "A6-FEHLER <code>" auf stderr und
// Exitcode 1. Nie Bericht, Meldung, HTTP-Antwort, PR-Text, Branchname, Token oder Stack. Der Bericht
// des Veroeffentlichers bleibt im Prozess; die manuelle Nachpruefung eines unklaren PR-Status muss der
// Workflow ermoeglichen (A6.4-4).
//
// Grenzen: Rechte, Herkunft und Installation des App-Tokens, Frische des Pruef-Checkouts, Job- und
// Workflow-Zeitlimits, Bindung an den Erfolg von Job 2 und Artefaktidentitaet belegt dieser Einstieg
// nicht (A6.4-4). Die Fristen (60 Minuten, 120 Sekunden Branchreserve) kommen unveraendert aus dem
// Veroeffentlicher.

import { openRepository, runGit } from './agent-code-auftrag.mjs';
import { publishOrderDraft } from './agent-code-auftrag-publish.mjs';
import { createPublishTransport } from './agent-code-auftrag-transport.mjs';
import {
  HOME_VEROEFFENTLICHEN,
  MAX_ISSUE,
  MAX_PACKAGE_FILE_BYTES,
  PUBLISH_CHECK_DIR,
  errorLine,
  existingDir,
  gitEnvironment,
  jobFail,
  packagePath,
  readBounded,
  readEventFile,
  readVeroeffentlichenContract,
  sha256Hex,
} from './agent-code-job-gemeinsam.mjs';

function own(value, key) {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

// Der Checkout muss auf genau dem Ausgangscommit stehen.
function checkCheckout(contract, gitEnv) {
  const { git } = openRepository(contract.workspace, contract.baseSha, gitEnv);

  if (runGit(git, ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'], 'job-checkout-head').trim() !== contract.baseSha) {
    jobFail('job-checkout-head');
  }
}

async function runVeroeffentlichen(env) {
  // 1. bis 6.
  const contract = readVeroeffentlichenContract(env);
  const gitEnv = gitEnvironment(contract, HOME_VEROEFFENTLICHEN);

  // 7.
  const event = readEventFile(contract);
  const issueNumber = own(own(event, 'issue'), 'number');

  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > MAX_ISSUE) {
    jobFail('job-ereignis-issue');
  }

  // 8. und 9.
  const packageBytes = readBounded(packagePath(contract.runnerTemp), MAX_PACKAGE_FILE_BYTES, 'job-paket-datei');

  if (sha256Hex(packageBytes) !== contract.packageSha256) {
    jobFail('job-paket-hash');
  }

  // 10. und 11.
  checkCheckout(contract, gitEnv);
  const checkRoot = existingDir(contract.runnerTemp, PUBLISH_CHECK_DIR, 'job-pruef-checkout');

  // 12. und 13.
  const transport = createPublishTransport({ token: contract.token, issueNumber, runId: contract.runId });
  await publishOrderDraft({
    root: contract.workspace,
    checkRoot,
    baseSha: contract.baseSha,
    event,
    expectedSha256: contract.orderSha256,
    runId: contract.runId,
    packageBytes,
    packageSha256: contract.packageSha256,
    gitEnv,
    transport,
    clock: () => new Date(),
  });
}

// Liefert den Exitcode. Wirft nie; jeder Fehler wird zu genau einer festen Zeile auf stderr.
export async function main(env) {
  try {
    await runVeroeffentlichen(env);
    return 0;
  } catch (error) {
    process.stderr.write(errorLine(error));
    return 1;
  }
}

// Ohne import.meta.main (Node vor 22.18.0 und 24.2.0) laeuft der Einstieg mit leerem Vertrag und endet
// kontrolliert mit job-umgebung-fehlt. Nie ein ungeprueftes Exitcode 0.
if (import.meta.main === true) {
  process.exitCode = await main(process.env);
} else if (import.meta.main !== false) {
  process.exitCode = await main({});
}
