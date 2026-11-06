# Claude-Code-Pilot – Isolierte Ausführung

## Ziel

KI-generierter JavaScript-Code darf keine Zugangsdaten des Claude-Agenten oder des GitHub-App-Veröffentlichungsprozesses erreichen.

## 1. Agenten-Job

- Persönliche Freigabe über `claude-bot`.
- Claude bearbeitet ausschließlich `src/rechne.js` und `test/rechne.test.js`.
- GitHub-Zugriff während der Bearbeitung nur lesend.
- Keine Ausführung des veränderten Anwendungscodes.
- Unabhängige Prüfung aller erkennbaren Dateiänderungen.
- Geprüfte Änderungen werden für die nächste Stufe bereitgestellt.

## 2. Separater Prüf-Job

- Neuer, unabhängiger GitHub-Actions-Runner.
- Kein Environment `claude-bot`.
- Keine Anthropic-API-Schlüssel oder GitHub-App-Geheimnisse.
- Keine GitHub-Schreibberechtigungen.
- Checkout ohne gespeicherte Zugangsdaten.
- Geprüfte Änderungen werden in eine frische Arbeitskopie übernommen.
- Unabhängige Dateiprüfung vor der Codeausführung.
- Anschließend `npm test` und `npm run build`.
- Keine Installation zusätzlicher Pakete aus dem Agentenauftrag.
- Keine Freigabe bei Fehlern oder unerwarteten Änderungen.

Die Netzwerkisolation muss gesondert bewertet und technisch umgesetzt werden. Ein GitHub-gehosteter Runner allein garantiert keine Netzwerksperre.

## 3. Veröffentlichungs-Job

- Start ausschließlich nach erfolgreichem Prüf-Job.
- Erneute Kontrolle der Dateiänderungen und des geprüften Artefakts.
- Erneute Live-Prüfung des Issues und des Ausgangscommits.
- Kein Ausführen des veränderten JavaScripts.
- Kurzlebiges GitHub-App-Schreib-Token erst nach den Prüfungen.
- Erstellung eines eigenen Branches und Draft-Pull-Requests.
- Kein automatischer Merge.

## 4. Fehlerverhalten

Bei fehlgeschlagenen oder unvollständigen Prüfungen wird die Veröffentlichung verhindert.

Zugangsdaten, bestehende GitHub-Schutzregeln und produktive Projekte bleiben unverändert.

## 5. Abnahmekriterien

Vor dem ersten echten Code-Agent-Test müssen die getrennten Jobs, die sichere Übertragung der Änderungen, die Berechtigungen und das Verhalten bei Sicherheitsfehlern überprüft werden.

Bis dahin bleibt ausschließlich `agent:test-note` ausführbar.
