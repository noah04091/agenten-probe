// A6.4-2c-2: Einstieg fuer Job 1b (nach Claude): Auftrag erneut rekonstruieren, Arbeitsordner
// vergleichen, Paket v2 bauen, auf Geheimnisse pruefen und erst dann exklusiv schreiben.
//
// Wirkungslos bis A6.4-4: Kein Workflow ruft diesen Einstieg auf. Aufruf spaeter genau so:
//   node scripts/agent-code-job-claude-nach.mjs
// ohne Argumente, erst wenn der Claude-Container vollstaendig beendet ist und ein frischer,
// vertrauenswuerdiger Checkout vorliegt. Alle Eingaben kommen aus dem festen Umgebungsvertrag
// (readClaudeNachContract): Repository, Ereignisart, Lauf-ID, Laufversuch 1, Ausgangscommit
// (GITHUB_SHA), Workflow-Ref, Checkout (GITHUB_WORKSPACE), GITHUB_OUTPUT, RUNNER_TEMP, PATH, die zwei
// Hashes aus Job 0 und genau die zwei Vergleichswerte A6_VERGLEICH_ANTHROPIC und
// A6_VERGLEICH_LESE_TOKEN. Arbeitsordner, Schnappschuss und Paket liegen an festen Pfaden.
//
// Kein Netzmodul, kein Live-Modul, kein Prompt, keine Abnahme, kein Veroeffentlicher, auch nicht
// transitiv. Git laeuft nur ueber das Auftragsmodul und nur im vertrauenswuerdigen Checkout, nie im
// Arbeitsordner von Claude. Dieser Einstieg importiert keinen Prozessstarter.
//
// Ablauf (verbindliche Reihenfolge):
//  1. bis 3. Umgebungsvertrag, Lauf, Versuch, Repository, Ausgangscommit, beide Vergleichswerte.
//  4. und 5. Schnappschussbytes unabhaengig hashen, parseSnapshot().
//  6. und 7. resolveOrder() im frischen Checkout, sameOrder() mit dem erwarteten Auftrags-Hash.
//  8. Der feste Arbeitsordner ist ein echtes Verzeichnis.
//  9. entfaellt: createPackageV2() vergleicht selbst (compareInternal); nur sein Ergebnis zaehlt.
// 10. createPackageV2().
// 11. und 12. Ergebnistext genau einmal in Bytes umwandeln, gegen result.sha256 und die Laenge pruefen.
// 13. parsePackageV2() auf genau diesen Bytes.
// 14. und 15. Muster und tatsaechliche Vergleichswerte in jeder dekodierten Datei und in den ganzen
//     Paketbytes (scanPackageSecrets).
// 16. bis 18. Erst dann exklusiv in einen neuen Ordner schreiben, zuruecklesen, Bytes und SHA-256.
// 19. Erst danach genau die Ausgabe paket_sha256.
//
// Ausgabe: bei Erfolg nichts auf stdout oder stderr, Exitcode 0, genau paket_sha256. Bei jedem Fehler
// genau eine Zeile "A6-FEHLER <code>" auf stderr und Exitcode 1, keine Ausgabe, keine Paketdatei.
//
// Grenzen:
// - Die Wertpruefung erkennt nur die in containsSecretValue genannten Darstellungen. Verschluesselung
//   oder unbekannte Umformungen erkennt sie nicht; sie ist keine vollstaendige DLP-Sicherheit.
// - Ob die zwei Vergleichswerte die tatsaechlich verwendeten Zugaenge sind und ob die Liste
//   vollstaendig ist, belegt dieser Einstieg nicht (A6.4-4).
// - Eine Pruefung vor dem Upload garantiert nicht, dass spaeter dieselbe Datei hochgeladen wird. Die
//   Schreiberisolation zwischen Pruefung und Upload bleibt Pflicht von A6.4-4.
// - Prozessbaum-Isolation, ueberlebende Agentenprozesse, Git-Pfad und Umgebungsbereinigung vor Node
//   sind nicht Teil dieses Einstiegs (S1, S2, S4).

import { openRepository, orderSha256, resolveOrder, runGit, sameOrder } from './agent-code-auftrag.mjs';
import { containsSecretValue, createPackageV2, packageFileBytes, parsePackageV2, scanForSecrets } from './agent-code-auftrag-paket.mjs';
import {
  HOME_CLAUDE_NACH,
  MAX_PACKAGE_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  PACKAGE_DIR,
  PACKAGE_FILE,
  WORK_DIR,
  errorLine,
  existingDir,
  freshDir,
  gitEnvironment,
  jobFail,
  packagePath,
  parseSnapshot,
  readBounded,
  readClaudeNachContract,
  sameBytes,
  sha256Hex,
  snapshotPath,
  writeExclusive,
  writePackageOutput,
} from './agent-code-job-gemeinsam.mjs';

// Der Checkout muss auf genau dem Ausgangscommit stehen. Git nur hier, im vertrauenswuerdigen Checkout.
function checkCheckout(contract, gitEnv) {
  const { git } = openRepository(contract.workspace, contract.baseSha, gitEnv);

  if (runGit(git, ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'], 'job-checkout-head').trim() !== contract.baseSha) {
    jobFail('job-checkout-head');
  }
}

// Prueft ein geprueftes Paket auf Geheimnisse: jede dekodierte Datei und die ganzen Paketbytes, je auf
// Muster (scanForSecrets) und auf die tatsaechlichen Vergleichswerte (containsSecretValue, beide Werte
// gemeinsam). Jeder Fund und jeder Eingabefehler wirft mit festem Code, nie mit Wert, Wertteil,
// Kodierung oder Dateiinhalt. parsed muss aus parsePackageV2 stammen (packageFileBytes prueft das).
export function scanPackageSecrets(parsed, packageBytes, compareValues) {
  const parts = parsed.dateien.map(meta => packageFileBytes(parsed, meta.pfad));
  parts.push(packageBytes);

  for (const bytes of parts) {
    if (scanForSecrets(bytes).fund) {
      jobFail('job-geheimnis-muster');
    }

    if (containsSecretValue(bytes, compareValues).fund) {
      jobFail('job-geheimnis-wert');
    }
  }

  return parts.length;
}

function runClaudeNach(env) {
  // 1. bis 3.
  const contract = readClaudeNachContract(env);
  const gitEnv = gitEnvironment(contract, HOME_CLAUDE_NACH);
  checkCheckout(contract, gitEnv);

  // 4. und 5.
  const snapshotBytes = readBounded(snapshotPath(contract.runnerTemp), MAX_SNAPSHOT_BYTES, 'job-schnappschuss-datei');

  if (sha256Hex(snapshotBytes) !== contract.snapshotSha256) {
    jobFail('job-schnappschuss-hash');
  }

  const snapshot = parseSnapshot(snapshotBytes);

  if (snapshot.run.id !== contract.runId) {
    jobFail('job-schnappschuss-lauf');
  }

  // 6. und 7.
  const order = resolveOrder({ root: contract.workspace, baseSha: contract.baseSha, gitEnv, ...snapshot, now: new Date() });
  sameOrder(order, contract.orderSha256);

  if (order.base_sha !== contract.baseSha || order.lauf.run_id !== contract.runId) {
    jobFail('job-auftrag-bindung');
  }

  // 8. und 10.
  const workDir = existingDir(contract.runnerTemp, WORK_DIR, 'job-arbeitsordner');
  const result = createPackageV2(contract.workspace, order, contract.orderSha256, workDir);

  // 11. und 12.
  const packageBytes = Buffer.from(result.text, 'utf8');

  if (packageBytes.length !== result.bytes || packageBytes.length > MAX_PACKAGE_FILE_BYTES || sha256Hex(packageBytes) !== result.sha256) {
    jobFail('job-paket-bytes');
  }

  // 13. bis 15.
  const parsed = parsePackageV2(order, contract.orderSha256, packageBytes, result.sha256);

  if (parsed.paket_sha256 !== result.sha256 || orderSha256(order) !== contract.orderSha256) {
    jobFail('job-paket-bindung');
  }

  scanPackageSecrets(parsed, packageBytes, contract.compareValues);

  // 16. bis 18.
  writeExclusive(freshDir(contract.runnerTemp, PACKAGE_DIR), PACKAGE_FILE, packageBytes);
  const back = readBounded(packagePath(contract.runnerTemp), MAX_PACKAGE_FILE_BYTES, 'job-paket-datei');

  if (!sameBytes(back, packageBytes) || sha256Hex(back) !== result.sha256) {
    jobFail('job-paket-rueckgelesen');
  }

  // 19.
  writePackageOutput(contract, sha256Hex(back));
}

// Liefert den Exitcode. Wirft nie; jeder Fehler wird zu genau einer festen Zeile auf stderr.
export function main(env) {
  try {
    runClaudeNach(env);
    return 0;
  } catch (error) {
    process.stderr.write(errorLine(error));
    return 1;
  }
}

// Ohne import.meta.main (Node vor 22.18.0 und 24.2.0) laeuft der Einstieg mit leerem Vertrag und endet
// kontrolliert mit job-umgebung-fehlt. Nie ein ungeprueftes Exitcode 0.
if (import.meta.main === true) {
  process.exitCode = main(process.env);
} else if (import.meta.main !== false) {
  process.exitCode = main({});
}
