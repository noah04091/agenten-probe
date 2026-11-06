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

## 8. Erfolgskriterien

Der Pilot ist erfolgreich, wenn:

- Claude eine vorgegebene Rechenfunktion korrekt implementiert.
- Ausschließlich die beiden freigegebenen Dateien verändert werden.
- Build und automatisierte Tests bestehen.
- Ein eigener Branch und Draft-PR erzeugt werden.
- `main` unverändert bleibt, bis eine ausdrückliche menschliche Merge-Freigabe erfolgt.

Die Übertragung auf produktive Projekte ist nicht Bestandteil dieses Piloten.
