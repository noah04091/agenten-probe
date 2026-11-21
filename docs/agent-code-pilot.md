# Claude-Code-Agent – Sicherer Entwicklungspilot

> **Historisches Dokument.** Es beschreibt den Code-Pilot für Issue #38 (Label `agent:code-pilot`,
> Workflow `code-pilot-claude-stufe.yml`) bis A5. Dieser Pfad ist seit A8 (PR #106) stillgelegt; seine
> Workflows existieren auf `main` nicht mehr. Nichts in dieser Datei ist eine aktuelle Handlungsanweisung.
> **Aktueller Betrieb:** `docs/agent-auftrag-betrieb.md`, Projektstand: `docs/agenten-system-masterplan.md`.

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

Erledigt mit Commit `f192b2a`: Hash aus Job 2, Kommentar-Token und die drei zusätzlichen Prüfungen
im Integrationstest. Beide `false &&`-Sperren sind unverändert. Pflichtprüfungen laufen nur bei
PRs gegen `main`; die CI für Arbeit am Code-Pilot entsteht deshalb auf PR #37.

### 7.4 Trockenlauf und Probe-Workflows (A2, historisch, abgelöst durch A8)

> **Stand nach A8 (PR #106, main `0628e05e`):** Der Trockenlauf `code-pilot-trockenlauf.yml` und die
> Probe-Workflows `code-pilot-isolation`, `-transfer`, `-abnahme-transferprobe`, `-auftrag-probe` und
> `-issue-startprobe` existieren auf `main` nicht mehr. Ihre Prüfungen übernimmt `agent-auftrag.yml`:
> Bei jedem PR laufen dort die Generalprobe-Jobs 0 bis 3 (Docker ohne Netz und Rechte, Paketübergabe mit
> Hash, Veröffentlichung gegen ein nachgebautes GitHub) und die Generalprobe der Negativfälle; ihr
> Sammeljob `agent-auftrag-sammel` ist Pflichtcheck. Die echten Pfade sind zusätzlich durch die sechs
> Live-Nachweise belegt (Masterplan Abschnitt 6).

Bis A8 prüfte der Trockenlauf bei jedem PR Job 2 und Job 3 des Code-Pilots ohne Claude, ohne Secrets
und ohne Kosten (eingeführt mit PR #41, Lauf 42691955117). Die damalige Zuordnung der Probe-Workflows
zum Trockenlauf und seine Wachen stehen in der Git-Historie dieser Datei (Stand vor PR #106).

### 7.5 Aktivierung über den Schalter `CODE_PILOT_ENABLED` (A4, historisch, abgelöst durch A8)

> **Nicht mehr anwenden.** Der Workflow `code-pilot-claude-stufe.yml`, den dieser Schalter steuerte,
> ist mit A8 entfernt. `CODE_PILOT_ENABLED` hat auf die heutige Pipeline `agent-auftrag.yml` **keine
> Wirkung**: Sie wird über vertrauenswürdige Profile auf `main`, das Profil-Label, das Startlabel
> `bot-auftrag` vom Eigentümer und zwei getrennte Freigaben im Environment `claude-bot` gesteuert. Die
> Variable bleibt ungesetzt.
>
> **Notabschaltung, Ablauf und Wartung heute:** `docs/agent-auftrag-betrieb.md`.

Bis A8 ersetzte der Schalter `vars.CODE_PILOT_ENABLED == 'true' &&` die beiden `false &&`-Sperren in
Job 1 und Job 3 des Code-Pilots (PR #43, PR #44). Er war ein Betriebsschalter, keine Autorisierung;
die Autorisierung lag schon damals bei der Freigabe im Environment `claude-bot`. Die frühere
Notabschaltung über diesen Schalter und die Aktivierungsprüfung mit Fingerabdruck
(`scripts/agent-code-activation-check.mjs`) sind mit A8 gegenstandslos; der Wortlaut steht in der
Git-Historie dieser Datei.

## 8. Erfolgskriterien

Der Pilot ist erfolgreich, wenn:

- Claude eine vorgegebene Rechenfunktion korrekt implementiert.
- Ausschließlich die beiden freigegebenen Dateien verändert werden.
- Build und automatisierte Tests bestehen.
- Ein eigener Branch und Draft-PR erzeugt werden.
- `main` unverändert bleibt, bis eine ausdrückliche menschliche Merge-Freigabe erfolgt.

Die Übertragung auf produktive Projekte ist nicht Bestandteil dieses Piloten.
