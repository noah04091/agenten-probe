// A6.4-2c-2: Einstieg fuer Job 1a (vor Claude): Auftrag pruefen, Live-Zustand bestaetigen,
// Arbeitsordner und Prompt vorbereiten.
//
// Wirkungslos bis A6.4-4: Kein Workflow ruft diesen Einstieg auf. Aufruf spaeter genau so:
//   node scripts/agent-code-job-claude-vor.mjs
// ohne Argumente. Alle Eingaben kommen aus dem festen Umgebungsvertrag (readClaudeVorContract):
// Repository, Ereignisart, Lauf-ID, Laufversuch 1, Ausgangscommit (GITHUB_SHA), Workflow-Ref, Checkout
// (GITHUB_WORKSPACE), GITHUB_OUTPUT, RUNNER_TEMP, PATH, die zwei Hashes aus Job 0 und der Lesetoken
// A6_LESE_TOKEN. Der Schnappschuss liegt am festen Pfad unter RUNNER_TEMP, der Arbeitsordner fuer
// Claude entsteht neu am festen Pfad RUNNER_TEMP/a6-claude-arbeit, ausserhalb des Checkouts.
//
// Dieser Einstieg startet Claude nicht und schreibt nichts auf GitHub. Netzzugang nur ueber
// createReadTransport (nur GET, nur die gebundenen Live-Pfade).
//
// Ablauf (verbindliche Reihenfolge):
//  1. bis 3. Umgebungsvertrag, Repository, Workflow, Lauf-ID und Laufversuch 1.
//  4. Checkout steht auf dem Ausgangscommit.
//  5. bis 7. Schnappschussbytes begrenzt lesen, SHA-256 unabhaengig nachrechnen, streng parsen.
//  8. und 9. resolveOrder() aus dem Schnappschuss, sameOrder() mit dem Auftrags-Hash aus Job 0.
// 10. und 11. Frischen Live-Zustand lesen, checkLiveOrder() mit genau diesem Zustand.
// 12. Auftragsidentitaet erneut bestaetigen.
// 13. prepareWorkspace() im festen, noch nicht vorhandenen Arbeitsordner.
// 14. Profilbytes aus dem vertrauenswuerdigen Checkout lesen.
// 15. buildPrompt() mit Titel und Text aus dem gebundenen Schnappschuss.
// 16. writeStepOutput() schreibt nur die Ausgabe prompt.
// Alle Auftragspruefungen verwenden denselben Pruefzeitpunkt.
//
// Ausgabe: bei Erfolg nichts auf stdout oder stderr, Exitcode 0, genau die Schrittausgabe prompt.
// Bei jedem Fehler genau eine Zeile "A6-FEHLER <code>" auf stderr und Exitcode 1.
//
// Grenzen: Workspace- und Containeruebergabe an Claude, Prozessbaum-Isolation, Git-Pfad und die
// Bereinigung der Umgebung vor dem Start von Node sind nicht Teil dieses Einstiegs (S1, S2, S4, A6.4-4).
// Faellt ein Schritt nach prepareWorkspace aus, bleibt ein Arbeitsordner ohne Prompt zurueck; der
// Workflow darf Claude dann nicht starten.

import { join } from 'node:path';

import { openRepository, orderSha256, resolveOrder, runGit, sameOrder } from './agent-code-auftrag.mjs';
import { checkLiveOrder, readLiveState } from './agent-code-auftrag-live.mjs';
import { prepareWorkspace } from './agent-code-auftrag-paket.mjs';
import { buildPrompt, writeStepOutput } from './agent-code-auftrag-prompt.mjs';
import { createReadTransport } from './agent-code-auftrag-transport.mjs';
import {
  HOME_CLAUDE_VOR,
  MAX_PROFILE_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  WORK_DIR,
  absentDir,
  errorLine,
  gitEnvironment,
  jobFail,
  parseSnapshot,
  readBounded,
  readClaudeVorContract,
  sha256Hex,
  snapshotPath,
} from './agent-code-job-gemeinsam.mjs';

// Der Checkout muss auf genau dem Ausgangscommit stehen.
function checkCheckout(contract, gitEnv) {
  const { git } = openRepository(contract.workspace, contract.baseSha, gitEnv);

  if (runGit(git, ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'], 'job-checkout-head').trim() !== contract.baseSha) {
    jobFail('job-checkout-head');
  }
}

async function runClaudeVor(env) {
  // 1. bis 4.
  const contract = readClaudeVorContract(env);
  const gitEnv = gitEnvironment(contract, HOME_CLAUDE_VOR);
  checkCheckout(contract, gitEnv);
  const now = new Date();
  const base = { root: contract.workspace, baseSha: contract.baseSha, gitEnv };

  // 5. bis 7.
  const snapshotBytes = readBounded(snapshotPath(contract.runnerTemp), MAX_SNAPSHOT_BYTES, 'job-schnappschuss-datei');

  if (sha256Hex(snapshotBytes) !== contract.snapshotSha256) {
    jobFail('job-schnappschuss-hash');
  }

  const snapshot = parseSnapshot(snapshotBytes);

  if (snapshot.run.id !== contract.runId) {
    jobFail('job-schnappschuss-lauf');
  }

  // 8. und 9.
  const order = resolveOrder({ ...base, ...snapshot, now });
  sameOrder(order, contract.orderSha256);

  if (order.base_sha !== contract.baseSha || order.lauf.run_id !== contract.runId) {
    jobFail('job-auftrag-bindung');
  }

  // 10. und 11.
  const transport = createReadTransport({ token: contract.token, issueNumber: order.issue, runId: contract.runId });
  const state = await readLiveState({ transport, repository: contract.repository, issueNumber: order.issue, runId: contract.runId });
  const live = checkLiveOrder({ expectedSha256: contract.orderSha256, event: snapshot.event, state, ...base, now, runId: contract.runId });

  // 12.
  if (orderSha256(live) !== contract.orderSha256 || orderSha256(order) !== contract.orderSha256) {
    jobFail('job-live-bindung');
  }

  // 13.
  const workDir = absentDir(contract.runnerTemp, WORK_DIR, 'job-arbeitsordner');
  prepareWorkspace(contract.workspace, order, contract.orderSha256, workDir, { gitEnv });

  // 14. und 15.
  const profileBytes = readBounded(join(contract.workspace, ...order.profil_pfad.split('/')), MAX_PROFILE_FILE_BYTES, 'job-profil-datei');
  const prompt = buildPrompt({
    order,
    expectedSha256: contract.orderSha256,
    profileBytes,
    title: snapshot.issue.title,
    body: snapshot.issue.body,
  });

  // 16.
  writeStepOutput({ outputPath: contract.outputPath, name: 'prompt', prompt });
}

// Liefert den Exitcode. Wirft nie; jeder Fehler wird zu genau einer festen Zeile auf stderr.
export async function main(env) {
  try {
    await runClaudeVor(env);
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
