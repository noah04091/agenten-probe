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
von GitHub bestätigt, Spitze genau der Commit dieses Laufs, kein Pull Request zu diesem Branch
(auch kein geschlossener). Sonst bleibt der Branch stehen. In beiden Fällen stehen Grund und
Ergebnis im Log und als Kommentar im Issue. Das Aufräumen wirft nie und ersetzt nie den
ursprünglichen Fehler; der Lauf endet immer rot.

Bekannte Grenzen:
- Zwischen Prüfung der Spitze und Löschen liegt ein kurzes Zeitfenster, das die REST-API nicht
  atomar schließen kann. Den Branch-Namen kennt nur dieser Lauf.
- Meldet `POST pulls` einen Fehler, obwohl GitHub den PR angelegt hat, und zeigt die PR-Liste ihn
  noch nicht, würde der Branch gelöscht und der Draft-PR damit geschlossen. `main` bleibt unberührt.
- Bricht der Runner selbst ab (Zeitlimit, manueller Abbruch), läuft kein Aufräumen. Der Branch
  bleibt dann ohne Kommentar stehen; gelöscht wird nichts.
- Der Issue-Kommentar braucht im Workflow `issues: write` für das Job-Token und
  `CODE_PILOT_COMMENT_TOKEN`. Ohne das steht der Grund nur im Log.

Die nötige Workflow-Verdrahtung (Hash aus Job 2, Kommentar-Token) liegt als Vorschlag in
`docs/a1-workflow-patch.diff`. Agenten dürfen `.github/` nicht ändern, Noah wendet ihn an mit
`git apply docs/a1-workflow-patch.diff` und löscht die Datei danach.

## 8. Erfolgskriterien

Der Pilot ist erfolgreich, wenn:

- Claude eine vorgegebene Rechenfunktion korrekt implementiert.
- Ausschließlich die beiden freigegebenen Dateien verändert werden.
- Build und automatisierte Tests bestehen.
- Ein eigener Branch und Draft-PR erzeugt werden.
- `main` unverändert bleibt, bis eine ausdrückliche menschliche Merge-Freigabe erfolgt.

Die Übertragung auf produktive Projekte ist nicht Bestandteil dieses Piloten.
