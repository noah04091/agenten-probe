# Claude-Code-Agent – Sicherer Entwicklungspilot

## 1. Ziel

Der Claude-Cloud-Agent soll erstmals eine echte Entwicklungsaufgabe aus einem GitHub-Issue bearbeiten können.

Die erste Ausbaustufe bleibt auf das Testrepository `noah04091/agenten-probe` beschränkt.

## 2. Zulässiger Aufgabentyp

Neuer Aufgabentyp: `agent:code-pilot`

Ein Auftrag benötigt:
- Ein offenes GitHub-Issue
- Das Label `agent:code-pilot`
- Das Startlabel `bot-auftrag`
- Auslösung durch den Repository-Eigentümer
- Persönliche Freigabe über das Environment `claude-bot`

Der bisherige Aufgabentyp `agent:test-note` bleibt unverändert.

## 3. Erlaubte Dateien

Claude darf ausschließlich diese beiden bestehenden Dateien bearbeiten:

- `src/rechne.js`
- `test/rechne.test.js`

Nicht erlaubt sind neue Dateien, Löschungen, Umbenennungen, symbolische Links oder Änderungen außerhalb dieser Freigabeliste.

Insbesondere ausgeschlossen sind Workflows, Sicherheitskonfigurationen, Zugangsdaten und produktive Projekte.

## 4. Umsetzung

Claude erhält eine konkrete, begrenzte Programmieraufgabe aus einem GitHub-Issue.

Claude arbeitet ausschließlich lokal. Es darf keine eigenen Commits, Branches, Pull Requests oder GitHub-Schreiboperationen durchführen.

Der Issue-Inhalt darf die Sicherheitsregeln nicht verändern.

## 5. Unabhängige Sicherheitsprüfung

Nach der Bearbeitung prüft ein unabhängiger Schritt:

- Ausschließlich freigegebene Dateipfade wurden geändert.
- Keine Datei wurde gelöscht oder umbenannt.
- Keine symbolischen Links wurden erstellt.
- Der Ausgangscommit stimmt weiterhin.
- Der Auftrag ist weiterhin freigegeben.
- Der Änderungssatz bleibt innerhalb der festgelegten Größenlimits.

Bei einer Verletzung wird die Veröffentlichung abgebrochen.

## 6. Build und Tests

Die Änderungen müssen erfolgreich gebaut und getestet werden.

Da geänderter JavaScript-Code selbst ausführbar ist, erfolgen diese Prüfungen in einer getrennten Umgebung ohne Geheimnisse und ohne GitHub-Schreib-Token.

Ein erfolgreicher Test allein ersetzt keine Codeprüfung.

## 7. Veröffentlichung

Erst nach erfolgreicher Sicherheits- und Qualitätsprüfung darf ein kurzlebiges GitHub-App-Schreib-Token zur Veröffentlichung erstellt werden.

Der Agent erhält einen eigenen Entwicklungsbranch und einen Draft-Pull-Request.

Ein automatischer Merge ist ausgeschlossen.

### 7.1 Geprüft ist gleich veröffentlicht (A1b)

- Job 2 reicht den SHA-256 des geprüften Pakets als `CODE_PILOT_PACKAGE_SHA256` an Job 3 weiter.
- `scripts/agent-code-publish.mjs` rechnet den Hash des geladenen Pakets nach und vergleicht die
  Paketinhalte Byte für Byte mit der Arbeitskopie. Bei Abweichung oder fehlendem Hash geht keine
  einzige Anfrage an GitHub.
- Nach dem Anlegen des Git-Baums liest das Skript den Baum rekursiv und vergleicht die Blob-SHAs
  beider Dateien mit den lokal berechneten (`git hash-object`-Rechnung). Erst danach entsteht ein
  Commit. Der Remote-Diff prüft zusätzlich den Blob-SHA jeder Datei, nicht nur den Namen.

### 7.2 Keine verwaisten Branches (A1a)

Scheitert die Veröffentlichung nach dem Anlegen des Branches, wird er nur gelöscht, wenn alle
Bedingungen belegt sind: Name exakt `wp/38-code-pilot-<run_id>-<attempt>`, Anlage in diesem Lauf
von GitHub bestätigt, **die Pull-Request-Anfrage wurde noch nicht abgeschickt**, Spitze genau der
Commit dieses Laufs, kein Pull Request zu diesem Branch (auch kein geschlossener). Sonst bleibt
der Branch stehen. In beiden Fällen stehen Grund und Ergebnis im Log und als Kommentar im Issue.
Das Aufräumen wirft nie und ersetzt nie den ursprünglichen Fehler; der Lauf endet immer rot.

Grundsatz: **Ein unklarer Zustand führt nie zum Löschen.** Sobald `POST pulls` abgeschickt ist,
kann GitHub den PR angelegt haben, auch bei Fehlermeldung, Zeitlimit oder ungültiger Antwort, und
die PR-Liste zeigt ihn eventuell erst später. Ab diesem Punkt bleibt der Branch immer stehen.
Dasselbe gilt, wenn das Anlegen des Branches ohne Antwort bleibt oder GitHub einen HTTP-Fehler meldet.

Bekannte Grenzen:
- Zwischen Prüfung der Spitze und Löschen liegt ein kurzes Zeitfenster, das die REST-API nicht
  atomar schließen kann. Ein Dritter müsste genau in diesen Millisekunden einen PR öffnen.
- Scheitert der Lauf nach der PR-Anfrage, bleibt ein Branch eventuell ohne PR stehen. Das ist
  gewollt (lieber ein Branch zu viel als ein verlorener PR) und steht im Issue-Kommentar.
- Bricht der Runner selbst ab (Zeitlimit, manueller Abbruch), läuft kein Aufräumen. Der Branch
  bleibt dann ohne Kommentar stehen; gelöscht wird nichts.
- Der Issue-Kommentar braucht im Workflow `issues: write` für das Job-Token und
  `CODE_PILOT_COMMENT_TOKEN`. Ohne das steht der Grund nur im Log.

### 7.3 Workflow-Verdrahtung und CI (Integration in PR #37)

Die Workflow-Verdrahtung (Hash aus Job 2, Kommentar-Token, drei zusätzliche Prüfungen im
Integrationstest) liegt bis zur Anwendung als `docs/a1-workflow-patch.diff` bereit. Agenten
dürfen `.github/` nicht ändern, deshalb wendet Noah sie mit seinem eigenen Konto an. Der Patch
lässt beide `false &&`-Sperren unverändert. Ohne Patch bricht Job 3 bewusst ab, weil der Hash
fehlt.

Alle Pflichtprüfungen (`tests`, `build`, `schutzdateien`, die Code-Pilot-Prüfungen) laufen nur bei
PRs gegen `main`. Die vollständige CI für A1 entsteht deshalb auf PR #37: Jeder Push auf
`wp/26-agent-code-pilot` löst sie dort aus. Ein PR gegen den Branch von #37 bekommt keine CI.

Schritte für Noah:
1. PR #40 in `wp/26-agent-code-pilot` übernehmen (Merge im GitHub-Fenster).
2. Lokal mit eigenem Konto: `git switch wp/26-agent-code-pilot`, `git pull --ff-only`,
   `git apply --check docs/a1-workflow-patch.diff` (meldet es einen Fehler, liegt die Workflow-Datei
   meist mit CRLF statt LF vor: dann nichts erzwingen, sondern stoppen), dann
   `git apply docs/a1-workflow-patch.diff`
   und `git rm docs/a1-workflow-patch.diff`.
3. Prüfen: `grep -c '^      false &&$' .github/workflows/code-pilot-claude-stufe.yml` muss `2`
   liefern, `npm test` und `npm run build` grün.
4. Nur `.github/workflows/code-pilot-claude-stufe.yml` und die gelöschte Patch-Datei committen und
   pushen. Danach auf PR #37 alle Prüfungen abwarten; der Integrationstest prüft dort die Sperren
   und die neue Verdrahtung.

## 8. Erfolgskriterien

Der Pilot ist erfolgreich, wenn:

- Claude eine vorgegebene Rechenfunktion korrekt implementiert.
- Ausschließlich die beiden freigegebenen Dateien verändert werden.
- Build und automatisierte Tests bestehen.
- Ein eigener Branch und Draft-PR erzeugt werden.
- `main` unverändert bleibt, bis eine ausdrückliche menschliche Merge-Freigabe erfolgt.

Die Übertragung auf produktive Projekte ist nicht Bestandteil dieses Piloten.
