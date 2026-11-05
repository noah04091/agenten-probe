# Agenten-Auftragsannahme – Sicherheitskonzept

## Ziel

Der Claude-Cloud-Agent soll künftig verschiedene freigegebene GitHub-Issues selbstständig bearbeiten können. Jeder Auftrag erhält einen eigenen Branch und Draft-Pull-Request.

Das System wird zunächst ausschließlich im Testrepository `noah04091/agenten-probe` erprobt.

## 1. Auftragsfreigabe

Ein Auftrag darf nur starten, wenn das GitHub-Issue geöffnet ist, der Repository-Eigentümer das Startlabel `bot-auftrag` gesetzt hat und die persönliche Genehmigung über das Environment `claude-bot` erfolgt ist.

Die Freigabe gilt ausschließlich für den jeweiligen Workflow-Lauf. Ein erneuter Lauf benötigt eine neue persönliche Genehmigung.

## 2. Trennung von Auftrag und Berechtigungen

Der Issue-Inhalt beschreibt die gewünschte Aufgabe, ist aber keine vertrauenswürdige Sicherheitskonfiguration.

Dateiberechtigungen, zulässige Aufgabentypen, Veröffentlichungsregeln und Kostenlimits werden ausschließlich durch den geprüften Workflow vorgegeben.

Anweisungen innerhalb eines Issues dürfen diese Grenzen nicht erweitern.

## 3. Erste Ausbaustufe: Mehrere Testaufträge

Zunächst unterstützt der Agent ausschließlich einen fest zugelassenen Aufgabentyp: `test-note`.

Für Issue #N darf er nur die neu anzulegende Datei `test/agent-issues/issue-N.md` bearbeiten. Der Dateipfad wird vom Workflow erzeugt und nicht aus dem Issue-Text übernommen.

Andere Dateien, bestehende Konfigurationen, produktive Projekte und geschützte Bereiche bleiben ausgeschlossen.

## 4. Technische Sicherheitskontrollen

Claude erhält während der Bearbeitung nur lesenden GitHub-Zugriff und führt keine eigenen Veröffentlichungsoperationen aus.

Eine unabhängige Prüfung kontrolliert anschließend Dateipfad, Dateityp, Inhalt, Größe und sämtliche erkennbaren Änderungen.

Vor der Veröffentlichung werden Issue-Status, Startlabel und Ausgangscommit erneut kontrolliert.

Erst nach erfolgreicher Prüfung erhält der Veröffentlichungsschritt ein kurzlebiges GitHub-App-Schreib-Token.

## 5. Veröffentlichung und Nachvollziehbarkeit

Jeder erfolgreiche Auftrag erhält einen eindeutig benannten Entwicklungsbranch und einen Draft-Pull-Request.

Der Pull Request verweist auf das zugrunde liegende Issue und dokumentiert die durchgeführten Änderungen sowie die Prüfergebnisse.

Es findet niemals ein automatischer Merge nach `main` statt.

## 6. Spätere Erweiterung

Erst nach erfolgreichen Tests der allgemeinen Auftragsannahme werden weitere Aufgabentypen zugelassen, insbesondere echte Codeänderungen, Tests und umfangreichere Arbeitspakete.

Dafür sind zusätzliche Sicherheitskontrollen und eine gesonderte Freigabe erforderlich.

Die bestehenden lokalen Claude-Terminals, ihre Sitzungen und produktive Projekte bleiben bis dahin unverändert.
