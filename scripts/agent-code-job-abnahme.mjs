// A6.4-2c-1: Einstieg fuer Job 2 (unabhaengige Abnahme ohne Geheimnisse und ohne Netz).
//
// Wirkungslos bis A6.4-4: Kein Workflow ruft diesen Einstieg auf. Aufruf spaeter genau so:
//   node scripts/agent-code-job-abnahme.mjs
// ohne Argumente. Alle Eingaben kommen aus dem festen Umgebungsvertrag (readAbnahmeContract):
// Repository, Ereignisart, Lauf-ID, Laufversuch 1, Ausgangscommit (GITHUB_SHA), Workflow-Ref, Checkout
// (GITHUB_WORKSPACE), RUNNER_TEMP, PATH und die drei erwarteten Hashes A6_AUFTRAG_SHA256,
// A6_SCHNAPPSCHUSS_SHA256 (beide aus Job 0) und A6_PAKET_SHA256 (spaeter aus Job 1). Schnappschuss
// und Paket liegen an festen Pfaden unter RUNNER_TEMP. Dieser Einstieg nimmt keine Zugangsdaten und
// keine Netzverbindung an und importiert kein Modul mit Netzzugang.
//
// Ablauf (verbindliche Reihenfolge):
//  1. bis 4. Umgebungsvertrag, Lauf-ID, Laufversuch 1, Checkout, Stolperdraht gegen Zugangsdaten.
//  5. bis 7. Schnappschussbytes lesen, SHA-256 unabhaengig berechnen und mit dem erwarteten vergleichen.
//  8. Schnappschuss mit exaktem Schema pruefen; er muss zu diesem Lauf gehoeren.
//  9. resolveOrder() bildet einen neuen, prozesslokal gebundenen Auftrag.
// 10. sameOrder() mit dem erwarteten Auftrags-SHA-256.
// 11. und 12. Paketbytes lesen, SHA-256 unabhaengig berechnen und vergleichen.
// 13. Paket mit parsePackageV2() gegen Auftrag und Paketformat pruefen.
// 14. acceptOrderPackage() in einem eigenen, neuen Pruefordner.
// 15. requireAccepted() mit dem tatsaechlich erhaltenen Nachweis.
// 16. Auftrag, Basiscommit, Paket-SHA-256 und Dateiliste des Nachweises kontrollieren.
// 17. Nur bei vollstaendigem Erfolg Exitcode 0. Keine Job-Ausgaben.
//
// Ausgabe: bei Erfolg nichts, Exitcode 0. Bei jedem Fehler genau eine Zeile "A6-FEHLER <code>" auf
// stderr und Exitcode 1. Ausgaben der Abnahme oder des Agentencodes erreichen das Protokoll nie.
//
// Grenzen: Der Pruefzeitpunkt ist die Uhr dieses Jobs. Liegt die Startfreigabe mehr als 60 Minuten
// zurueck, lehnt resolveOrder ab (falsches Nein). Prozessbaum-Isolation, Git-Pfad und die Bereinigung
// der Umgebung vor dem Start von Node sind nicht Teil dieses Einstiegs (S1, S2, S4).

import { orderSha256, resolveOrder, sameOrder } from './agent-code-auftrag.mjs';
import { acceptOrderPackage, requireAccepted } from './agent-code-auftrag-abnahme.mjs';
import { parsePackageV2 } from './agent-code-auftrag-paket.mjs';
import {
  CHECK_DIR,
  HOME_ABNAHME,
  MAX_PACKAGE_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  errorLine,
  freshDir,
  gitEnvironment,
  jobFail,
  packagePath,
  parseSnapshot,
  readAbnahmeContract,
  readBounded,
  sha256Hex,
  snapshotPath,
} from './agent-code-job-gemeinsam.mjs';

function runAbnahme(env) {
  // 1. bis 4.
  const contract = readAbnahmeContract(env);
  const gitEnv = gitEnvironment(contract, HOME_ABNAHME);

  // 5. bis 8.
  const snapshotBytes = readBounded(snapshotPath(contract.runnerTemp), MAX_SNAPSHOT_BYTES, 'job-schnappschuss-datei');

  if (sha256Hex(snapshotBytes) !== contract.snapshotSha256) {
    jobFail('job-schnappschuss-hash');
  }

  const snapshot = parseSnapshot(snapshotBytes);

  if (snapshot.run.id !== contract.runId) {
    jobFail('job-schnappschuss-lauf');
  }

  // 9. und 10.
  const order = resolveOrder({ root: contract.workspace, baseSha: contract.baseSha, gitEnv, ...snapshot, now: new Date() });
  sameOrder(order, contract.orderSha256);

  if (order.base_sha !== contract.baseSha || order.lauf.run_id !== contract.runId) {
    jobFail('job-auftrag-bindung');
  }

  // 11. bis 13.
  const packageBytes = readBounded(packagePath(contract.runnerTemp), MAX_PACKAGE_FILE_BYTES, 'job-paket-datei');
  const packageSha256 = sha256Hex(packageBytes);

  if (packageSha256 !== contract.packageSha256) {
    jobFail('job-paket-hash');
  }

  const parsed = parsePackageV2(order, contract.orderSha256, packageBytes, packageSha256);

  // 14. und 15.
  const nachweis = acceptOrderPackage({
    trustedRoot: contract.workspace,
    checkParent: freshDir(contract.runnerTemp, CHECK_DIR),
    order,
    expectedSha256: contract.orderSha256,
    packageBytes,
    packageSha256,
    gitEnv,
  });
  requireAccepted(nachweis, order, contract.orderSha256);

  // 16.
  const expectedFiles = parsed.dateien.map(meta => `${meta.pfad}\0${meta.git_blob}`);
  const acceptedFiles = nachweis.dateien.map(meta => `${meta.pfad}\0${meta.git_blob}`);

  if (
    nachweis.auftrag_sha256 !== orderSha256(order) ||
    nachweis.base_sha !== contract.baseSha ||
    nachweis.paket_sha256 !== packageSha256 ||
    nachweis.ergebnis !== 'bestanden' ||
    acceptedFiles.length !== expectedFiles.length ||
    acceptedFiles.some((entry, index) => entry !== expectedFiles[index]) ||
    nachweis.dateien.some(meta => !order.dateien.includes(meta.pfad))
  ) {
    jobFail('job-nachweis-bindung');
  }
}

// Liefert den Exitcode. Wirft nie; jeder Fehler wird zu genau einer festen Zeile auf stderr.
export function main(env) {
  try {
    runAbnahme(env);
    return 0;
  } catch (error) {
    process.stderr.write(errorLine(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.env);
}
