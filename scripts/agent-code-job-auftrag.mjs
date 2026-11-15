// A6.4-2c-1: Einstieg fuer Job 0 (Auftrag festlegen und Schnappschuss erzeugen).
//
// Wirkungslos bis A6.4-4: Kein Workflow ruft diesen Einstieg auf. Aufruf spaeter genau so:
//   node scripts/agent-code-job-auftrag.mjs
// ohne Argumente. Alle Eingaben kommen aus dem festen Umgebungsvertrag (readAuftragContract): Repository,
// Ereignisart und Ereignisdatei, Lauf-ID, Laufversuch 1, Ausgangscommit (GITHUB_SHA), Workflow-Ref,
// Checkout (GITHUB_WORKSPACE), GITHUB_OUTPUT, RUNNER_TEMP, PATH und der Lesetoken A6_LESE_TOKEN.
//
// Netzzugang nur ueber createReadTransport (nur GET, nur die gebundenen Live-Pfade). Es gibt keine
// Schnittstelle, die einen anderen Transport annimmt.
//
// Ablauf (verbindliche Reihenfolge):
//  1. bis 3. Umgebungsvertrag, Lauf-ID, Laufversuch 1, Repository, Ausgangscommit und Checkout pruefen.
//  4. Festen Lesetransport erzeugen.
//  5. readLiveState() aufrufen.
//  6. resolveOrder() aus den vollstaendigen Originaldaten.
//  7. Vollstaendigen Auftrags-SHA-256 bilden.
//  8. Minimalen Schnappschuss aus den bereits gelesenen Daten bauen.
//  9. Aus den Schnappschussbytes mit resolveOrder() einen zweiten Auftrag bilden.
// 10. Beide vollstaendigen Auftrags-Hashes vergleichen.
// 11. checkLiveOrder() mit dem urspruenglichen frischen Zustand und dem erwarteten Hash. Der Zustand
//     wird dabei genau einmal verbraucht.
// 12. Die erneute Auftragsbindung bestaetigen.
// 13. Schnappschussbytes exklusiv in die feste Datei unter RUNNER_TEMP schreiben.
// 14. Dieselben Bytes zuruecklesen, vergleichen und SHA-256 neu berechnen.
// 15. Erst danach genau die zwei Hash-Ausgaben schreiben.
// Alle drei Auftragspruefungen verwenden denselben Pruefzeitpunkt.
//
// Ausgabe: bei Erfolg nichts auf stdout oder stderr, Exitcode 0. Bei jedem Fehler genau eine Zeile
// "A6-FEHLER <code>" auf stderr und Exitcode 1. Meldungen, Berichte und Stacks werden nie ausgegeben.
//
// Grenzen: siehe Kopf von agent-code-job-gemeinsam.mjs (S4) und von agent-code-auftrag-live.mjs. Ein
// Hashwert allein beweist keine erfolgreiche Live-Pruefung; der Workflow muss zusaetzlich verlangen,
// dass dieser Job erfolgreich war.

import { openRepository, orderSha256, resolveOrder, runGit } from './agent-code-auftrag.mjs';
import { checkLiveOrder, readLiveState } from './agent-code-auftrag-live.mjs';
import { createReadTransport } from './agent-code-auftrag-transport.mjs';
import {
  HOME_AUFTRAG,
  MAX_ISSUE,
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_DIR,
  SNAPSHOT_FILE,
  buildSnapshot,
  errorLine,
  freshDir,
  gitEnvironment,
  jobFail,
  parseSnapshot,
  readAuftragContract,
  readBounded,
  readEventFile,
  sameBytes,
  sha256Hex,
  snapshotPath,
  writeExclusive,
  writeHashOutputs,
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

async function runAuftrag(env) {
  // 1. bis 3.
  const contract = readAuftragContract(env);
  const event = readEventFile(contract);
  const issueNumber = own(own(event, 'issue'), 'number');

  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > MAX_ISSUE) {
    jobFail('job-ereignis-issue');
  }

  const gitEnv = gitEnvironment(contract, HOME_AUFTRAG);
  checkCheckout(contract, gitEnv);
  const now = new Date();
  const base = { root: contract.workspace, baseSha: contract.baseSha, gitEnv };

  // 4. und 5.
  const transport = createReadTransport({ token: contract.token, issueNumber, runId: contract.runId });
  const state = await readLiveState({ transport, repository: contract.repository, issueNumber, runId: contract.runId });

  // 6. und 7.
  const run = { id: contract.runId, attempt: own(state.run, 'run_attempt'), createdAt: own(state.run, 'created_at') };
  const original = resolveOrder({ ...base, repository: contract.repository, event, issue: state.issue, events: state.events, run, now });
  const orderHash = orderSha256(original);

  // 8. bis 10.
  const bytes = buildSnapshot({ issue: state.issue, events: state.events, run, event });
  const again = resolveOrder({ ...base, ...parseSnapshot(bytes), now });

  if (orderSha256(again) !== orderHash) {
    jobFail('job-rundweg');
  }

  // 11. und 12.
  const live = checkLiveOrder({ expectedSha256: orderHash, event, state, ...base, now, runId: contract.runId });

  if (orderSha256(live) !== orderHash) {
    jobFail('job-live-bindung');
  }

  // 13. und 14.
  writeExclusive(freshDir(contract.runnerTemp, SNAPSHOT_DIR), SNAPSHOT_FILE, bytes);
  const back = readBounded(snapshotPath(contract.runnerTemp), MAX_SNAPSHOT_BYTES, 'job-schnappschuss-datei');

  if (!sameBytes(back, bytes) || sha256Hex(back) !== sha256Hex(bytes)) {
    jobFail('job-schnappschuss-rueckgelesen');
  }

  // 15.
  writeHashOutputs(contract, orderHash, sha256Hex(back));
}

// Liefert den Exitcode. Wirft nie; jeder Fehler wird zu genau einer festen Zeile auf stderr.
export async function main(env) {
  try {
    await runAuftrag(env);
    return 0;
  } catch (error) {
    process.stderr.write(errorLine(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.env);
}
