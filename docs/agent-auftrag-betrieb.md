# Agent-Auftrag: Betriebsanleitung

> Gilt für den Stand nach A8 (main `0628e05e`, 21.11.2026). Der einzige Agentenpfad ist
> `.github/workflows/agent-auftrag.yml`. Die alten Workflows (`claude-agent`, `claude-bot`, `code-pilot-*`)
> und der Schalter `CODE_PILOT_ENABLED` existieren für diese Pipeline nicht mehr; Anleitungen dazu in
> älteren Dokumenten sind historisch. Hintergrund und Nachweise: `docs/agenten-system-masterplan.md`.

Alle Befehle für das Repository `noah04091/agenten-probe` und das Eigentümerkonto `noah04091`.
`<LAUF>` ist die Lauf-ID aus der Actions-Ansicht, `<ISSUE>` die Issue-Nummer.

## 1. Überblick

| Job | Was er tut | Freigabe | Zeitgrenze |
|---|---|---|---|
| Job 0 Auftrag festlegen | prüft Issue, Labels, Profil, Startfreigabe; Schnappschuss als Artefakt | keine, startet mit dem Startlabel | 10 min |
| Job 1 Claude im Container | prüft den Auftrag **erneut live** (1a), dann Claude im Container mit genau den Profildateien, danach Paket (1b) | Environment `claude-bot` | 40 min (Claude laut Profil höchstens 15 min) |
| Job 2 Abnahme ohne Netz | frische Kopie, Paket anwenden, `npm test`, Abnahme `agent-acceptance/issue-<ISSUE>.mjs`, Build, alles ohne Netz | keine, ohne Secrets | 20 min |
| Job 3 Draft-PR veröffentlichen | prüft den Auftrag erneut live, kurzlebiges App-Token, Branch `wp/<ISSUE>-agent-<LAUF>-1`, Draft-PR | Environment `claude-bot` (zweite, eigene Freigabe) | 10 min |

Job 1 bis 3 laufen nur bei `issues` auf `main` und nur nach Erfolg aller Vorgänger. Gemergt wird nie
automatisch. Bei einem PR laufen statt der Live-Jobs die Generalprobe-Jobs; deren Sammeljob
`agent-auftrag-sammel` ist einer der vier Pflichtchecks (`build`, `tests`, `schutzdateien`,
`agent-auftrag-sammel`).

## 2. Voraussetzungen

- Eigentümerkonto `noah04091`: nur seine Startlabels zählen, nur er gibt im Environment frei.
- Offenes Issue von `noah04091`, kein Pull Request.
- Aktives Profil auf `main` unter `agent-profiles/<id>.json` (`"aktiv": true`). Es legt Dateien, Modell,
  Budget, Runden und Laufzeit fest. Heute: `js-rechner` (`src/rechne.js`, `test/rechne.test.js`) und
  `js-text` (`src/text.js`, `test/text.test.js`).
- Abnahme auf `main`: `agent-acceptance/issue-<ISSUE>.mjs`.
- Genau ein Profil-Label `agent:<id>`, von `noah04091` **vor** dem Startlabel gesetzt und danach nicht
  mehr geändert, dazu das Startlabel `bot-auftrag`.
- Höchstens drei Startfreigaben je Issue. Jedes Setzen von `bot-auftrag` durch `noah04091` zählt als eine.
- Kein Zweig `wp/<ISSUE>-*` und kein früherer PR von einem solchen Zweig, gleich in welchem Zustand.
- Während des Laufs bleiben `main` und das Issue unverändert. Ein Merge nach `main` bricht den Lauf bei der
  nächsten Live-Prüfung ab (`live-main-geaendert`). Jede Änderung am Issue nach dem Startlabel, auch ein
  Kommentar, ein Label oder eine Bearbeitung von einem anderen Konto, macht den Auftrag ungültig. Der
  Abbruchcode hängt davon ab, welche Prüfung zuerst anschlägt. Möglich sind unter anderem
  `auftrag-issue-geaendert`, `auftrag-label-start-fehlt` (bei entferntem Startlabel, so in NF3),
  `auftrag-freigabe-entzogen` und `auftrag-profil-label-geaendert`.
- Während eines Live-Laufs im ganzen Repository keine Labels setzen. Jedes `labeled`-Ereignis erzeugt einen
  Lauf in derselben Gruppe `agent-auftrag-live` (Abschnitt 7).
- Environment `claude-bot` mit `ANTHROPIC_API_KEY` und dem App-Schlüssel, Pflichtprüfer nur `noah04091`,
  nur Zweig `main`. Ablaufdaten siehe Abschnitt 7.

## 3. Normaler Ablauf

1. **Auftrag vorbereiten:** Issue-Text schreiben. Abnahme und, falls nötig, Profil kommen vorher per
   eigenem PR auf `main`. Erlaubte Dateien kommen nie aus dem Issue-Text.
2. **Profil-Label** `agent:<id>` setzen. Das erzeugt einen kurzen Lauf, in dem alle Jobs übersprungen
   werden und `agent-auftrag-sammel` rot endet. Das ist erwartet und betrifft keine PR-Prüfung.
3. **Startlabel** `bot-auftrag` erst setzen, wenn Text, Profil und Abnahme geprüft sind. Ab jetzt läuft
   die **Frist von 60 Minuten**: Danach lehnen Job 0, Job 1 und Job 3 den Auftrag ab
   (`auftrag-freigabe-abgelaufen`). Job 3 braucht vor dem Anlegen des Branches zusätzlich zwei Minuten
   Restfrist (`publish-freigabe-reserve`). Job 3 deshalb mit deutlichem Puffer vor Minute 58 freigeben.
4. **Job 0 prüfen:** muss grün sein. Erst dann weiter.
5. **Job 1 freigeben:** In der Lauf-Ansicht „Review deployments“, `claude-bot`, „Approve“, oder:
   `gh api --method POST repos/noah04091/agenten-probe/actions/runs/<LAUF>/pending_deployments -F "environment_ids[]=26238768633" -f state=approved -f comment="<Grund>"`.
   Eine Freigabeanfrage, die du nicht selbst ausgelöst hast, wird abgelehnt (Abschnitt 5).
6. **Job 2 abwarten:** Er braucht keine Freigabe. Rot heißt: kein PR, Ende.
7. **Job 3 freigeben:** nur wenn Job 2 grün ist, mit derselben Freigabe wie in Schritt 5.
8. **Draft-PR prüfen:** genau die Profildateien, Autor `noah04091-agenten-probe-cloud-bot`, alle vier
   Pflichtchecks grün.
9. **Merge von Hand:** `gh pr ready`, Review „Approve“ als Code-Owner, `gh pr merge --merge
   --match-head-commit <kopf>`. Ohne Admin-Ausnahme. Das Issue schließt sich dabei nicht von selbst.

## 4. Fehlerdiagnose

Die Pipeline schreibt **keinen Kommentar ins Issue**. Den Grund findest du im Log des Jobs:
`gh run view <LAUF> -R noah04091/agenten-probe --log-failed` oder in der Actions-Ansicht. Die Node-Einstiege
melden einen Fehler als genau eine Zeile `A6-FEHLER <code>`, die Shell-Schritte in Job 1 als
`A6-SICHT …`, `A6-CLAUDE …` oder `A6-PROXY …`.

| Symptom | Wo nachsehen | Typische Codes |
|---|---|---|
| Auftrag nicht angenommen (Job 0 rot) | Log Job 0, Schritt „Auftrag pruefen“ | `auftrag-label-profil-fehlt`, `auftrag-profil-inaktiv`, `auftrag-freigabe-fremd`, `auftrag-freigaben-grenze`, `auftrag-issue-pr`, `auftrag-abnahme`, `auftrag-issue-geschlossen` (Issue geschlossen) |
| Lauf ohne Live-Jobs | Lauf in der Liste: `gh run list -R noah04091/agenten-probe --workflow agent-auftrag.yml` | anderes Label als `bot-auftrag` gesetzt: alle Jobs übersprungen, `agent-auftrag-sammel` rot, das ist erwartet |
| Kein Lauf zu sehen | Liste der Läufe wie oben | Workflow deaktiviert; Lauf wartet in der Gruppe `agent-auftrag-live` oder wurde dort durch einen neueren ersetzt (Abschnitt 7) |
| Claude nicht gestartet (Job 1 rot in 1a) | Log Job 1, Schritt „Job 1a“ | `auftrag-label-start-fehlt` (Startlabel entzogen), `auftrag-freigabe-entzogen`, `auftrag-freigabe-abgelaufen`, `auftrag-issue-geaendert`, `live-main-geaendert`, `live-branch-vorhanden`, `live-pr-vorhanden`, `job-live-bindung` |
| Claude lief, kein Paket (Job 1 rot nach Claude) | Log Job 1, Zeilen `A6-PROTOKOLL`, `A6-WERKZEUG`, `A6-DIAGNOSE`, `Claude beendet` | `paket-unveraendert` (mindestens eine Profildatei unverändert; jede muss geändert sein), `A6-CLAUDE <grund>` |
| Datei- oder Profilgrenze verletzt | Log Job 1: Schritt „Sicht nach Claude pruefen“ (`A6-SICHT …`) und Job 1b (`paket-*`, `job-paket-*`) | Zugriffe außerhalb zeigt `A6-WERKZEUG … ausserhalb` |
| Abnahme fehlgeschlagen (Job 2 rot) | Log Job 2, Schritt „Job 2 unabhaengige Abnahme“ | `abnahme-exitcode` (Abnahme nicht bestanden), `abnahme-ausgabe`, `abnahme-git-*` |
| Job 3 übersprungen | Job 2 oder Job 1 rot, oder Job 3 nicht freigegeben | siehe dort |
| Job 3 rot | Log Job 3 | `publish-*`, darunter `publish-freigabe-reserve` und `publish-freigabe-abgelaufen`. Ein Branch bleibt nur stehen, wenn er nach dem Anlegen nicht sicher als eigener gelöscht werden konnte; der Name steht dann im Log |
| **Sicherheitsalarm** | Log Job 1: Zeile `A6-ALARM <grund>` und `A6-DIAGNOSE alarm`, Job 1 endet rot | sofort Abschnitt 5, Lauf nicht wiederholen |
| Lauf unvollständig oder abgebrochen | Actions-Ansicht: abgebrochene oder übersprungene Jobs | Neustart nur über ein neues Startlabel (Abschnitt 6). „Re-run“ in GitHub scheitert, weil nur Laufversuch 1 erlaubt ist (je nach Stelle `auftrag-lauf-versuch`, `job-lauf-versuch` oder ein fehlendes Artefakt) |

## 5. Notabschaltung

Erst die Lage bestimmen, dann genau die passende Maßnahme. Laufende und wartende Läufe:

```bash
gh run list -R noah04091/agenten-probe --workflow agent-auftrag.yml --status in_progress
gh run list -R noah04091/agenten-probe --workflow agent-auftrag.yml --status waiting
gh run list -R noah04091/agenten-probe --workflow agent-auftrag.yml --status queued
```

| Lage | Maßnahme | Wirkung und Grenze |
|---|---|---|
| **Noch nicht gestartet** (kein `bot-auftrag`) | Startlabel nicht setzen. Profil-Label entfernen, wenn der Auftrag ganz entfallen soll | Ohne `bot-auftrag` startet kein Live-Job |
| **Job 1 wartet auf die Freigabe** | Freigabe **ablehnen**: `gh api --method POST repos/noah04091/agenten-probe/actions/runs/<LAUF>/pending_deployments -F "environment_ids[]=26238768633" -f state=rejected -f comment="Notabschaltung"`. Zusätzlich `bot-auftrag` entfernen: `gh api --method DELETE repos/noah04091/agenten-probe/issues/<ISSUE>/labels/bot-auftrag` | **Ablehnen ist Pflicht:** Es beendet den Lauf ohne Claude und gibt die Gruppe `agent-auftrag-live` frei. Das Entfernen allein verhindert Claude ebenfalls (Job 1 prüft vor Claude erneut, `auftrag-label-start-fehlt`, live belegt in NF3, Lauf 44826212314), der Lauf wartet aber weiter auf die Freigabe und blockiert die Gruppe. Ein Entfernen zählt nicht als neue Startfreigabe |
| **Claude läuft bereits** (Job 1 aktiv) | Lauf **abbrechen**: `gh run cancel <LAUF> -R noah04091/agenten-probe`. Danach `bot-auftrag` entfernen | Abbrechen stoppt Job 1; der Aufräumschritt entfernt die Container. Das Entfernen des Labels allein stoppt einen laufenden Claude **nicht**. Bereits verbrauchte Modellkosten bleiben (Deckel je Profil, Abschnitt 7) |
| **Job 3 wartet auf die Freigabe** | Freigabe **ablehnen** (Befehl wie oben). Zusätzlich `bot-auftrag` entfernen | Ohne Freigabe entsteht kein Branch und kein PR. Würde Job 3 doch freigegeben, prüft er den Auftrag vor dem ersten Schreiben erneut live und bricht ohne Startlabel ab (laut Code und Tests, live nicht erprobt) |
| **Job 3 läuft bereits** | Lauf abbrechen, dann Branches und PRs `wp/<ISSUE>-*` prüfen | Ein schon angelegter Branch oder Draft-PR bleibt bestehen; nichts wird gemergt. Von Hand schließen und löschen |
| **Alle neuen Aufträge sofort sperren** | Workflow deaktivieren: `gh workflow disable agent-auftrag.yml -R noah04091/agenten-probe` (Workflow-ID `421414131`). Vorher laufende und wartende Läufe wie oben abbrechen oder ablehnen | Verhindert neue Läufe, beendet aber **keinen** laufenden. Nebenwirkung: Auf PRs fehlt dann der Pflichtcheck `agent-auftrag-sammel`, PRs gegen `main` lassen sich bis zur Wiedereinschaltung nicht mergen |

**Vorprüfung abschalten (B2.1):** `gh workflow disable agent-pruefer.yml -R noah04091/agenten-probe`. Danach startet
nach einem Auftrag keine Vorprüfung mehr; der Auftrag selbst und die Pflichtchecks bleiben unberührt (die Vorprüfung
ist kein Pflichtcheck). Ein laufender Prüflauf wird mit `gh run cancel <LAUF> -R noah04091/agenten-probe` beendet.
Details in Abschnitt 8.

**KI-Prüfer abschalten (B2.3a), genau in dieser Reihenfolge:**
1. Workflow deaktivieren: `gh workflow disable agent-pruefer-ki.yml -R noah04091/agenten-probe`. Danach startet nach
   einer Vorprüfung keine Freigabeanfrage mehr.
2. Wartende Freigaben ablehnen: `gh run list -R noah04091/agenten-probe --workflow agent-pruefer-ki.yml --status waiting`,
   dann je Lauf
   `gh api --method POST repos/noah04091/agenten-probe/actions/runs/<LAUF>/pending_deployments -F "environment_ids[]=28418332669" -f state=rejected -f comment="Notabschaltung"`.
3. Ab B2.3b zusätzlich: den Schlüssel im Environment `claude-pruefer` löschen und im Anthropic-Workspace widerrufen.

⚠️ **Löschen des Environments allein ist keine Notabschaltung.** Ein Lauf, der `claude-pruefer` nennt, legt das
Environment neu an, dann ohne Pflichtprüfer und ohne Branch-Regel (Hinweis H6 aus dem Plan, nicht gemessen; eine Probe
würde das Environment ändern). Der Vorjob erkennt eine solche Neuanlage an der abweichenden ID und Konfiguration und
stoppt (`konfig-abweichung`), das ersetzt aber nicht das Abschalten des Workflows in Schritt 1.

**Nicht mehr gültig:** `CODE_PILOT_ENABLED` steuert diese Pipeline nicht. Die Variable bleibt ungesetzt;
sie zu setzen oder zu löschen hat keine Wirkung auf `agent-auftrag.yml`.

**Fremde Freigabeanfragen:** Eine Environment-Anfrage, die du nicht selbst ausgelöst hast, wird immer
abgelehnt.

## 6. Wiederinbetriebnahme

Nur in dieser Reihenfolge, nie automatisch:
1. Ursache geklärt und belegt (Log, Codes, betroffene Dateien).
2. Keine offenen Läufe, keine verwaisten Branches oder PRs `wp/<ISSUE>-*`.
3. Bei einer Änderung an Profil, Abnahme, Skripten oder Workflow: eigener PR mit allen vier Pflichtchecks
   grün und unabhängiger Prüfung.
4. Ausdrückliche Freigabe durch `noah04091`.
5. Falls deaktiviert: `gh workflow enable agent-auftrag.yml -R noah04091/agenten-probe` (oder mit der festen
   Workflow-ID `421414131`, weil ein deaktivierter Workflow in Listen nicht mehr erscheint).
6. Neuer Start nur über ein neues `bot-auftrag` (zählt als weitere der höchstens drei Freigaben je Issue).

## 7. Wartung

| Punkt | Was zu tun ist |
|---|---|
| Modellkosten | Deckel je Lauf im Profil (`budget_usd`, heute 1,50 $ und 1,00 $). Kosten stehen im Log von Job 1 (`Claude beendet: … Kosten`). Ein Ausgabenlimit auf dem Anthropic-Schlüssel ist offene Entscheidung 9 im Masterplan |
| Anthropic-Schlüssel | `ANTHROPIC_API_KEY` im Environment `claude-bot` läuft laut Noah am **02.12.2026** ab (W1). Danach scheitert Job 1 |
| Bot-Token | Token von `noah04091-agent` läuft am **09.12.2026** ab (R7) |
| App | GitHub-App `noah04091-agenten-probe-cloud-bot`; ihren privaten Schlüssel im Environment nur der Eigentümer |
| Profile und Abnahmen | nur per PR auf `main`; Profiländerungen getrennt von anderen Änderungen (Trennregel in `schutz.yml`) |
| CI und Wachen | alle vier Pflichtchecks; die Wache `test/a8-einziger-agentenpfad.test.mjs` erlaubt genau sechs Workflows (seit B2.1 dazu `agent-pruefer.yml`, seit B2.3a `agent-pruefer-ki.yml`, beide mit eigenen Regeln) und nur einen Agentenpfad. Wachen nie abschwächen, um rote Checks zu beseitigen |
| Gleichzeitigkeit | immer nur ein Lauf aus Issue-Ereignissen (Gruppe `agent-auftrag-live`, ohne Abbruch); dazu zählt **jedes** `labeled`-Ereignis im Repository. Ein weiterer Lauf wartet; GitHub ersetzt dabei einen schon wartenden durch den neueren. Ein so verdrängter `bot-auftrag`-Lauf hat seine Startfreigabe trotzdem verbraucht (aus dem Verhalten von GitHub abgeleitet, nicht live erprobt). Deshalb während eines Laufs keine Labels setzen |
| Historische Workflow-Einträge | GitHub führt `code-pilot-start-diagnose.yml` noch als Eintrag, ohne Datei auf einem Zweig; nicht ausführbar. Alte Workflow-Dateien liegen noch auf `wp/28-…`, `wp/35-…` und dem Zweig von PR #96, ohne greifenden Auslöser |
| Regelmäßige Prüfung | monatlich: `gh run list -R noah04091/agenten-probe --limit 20`, offene Draft-PRs, Zweige `wp/*`, Ablaufdaten oben, dass `CODE_PILOT_ENABLED` nicht gesetzt ist |

## 8. Vorprüfung ohne KI (B2.1)

Nach jedem erfolgreich abgeschlossenen Auftrag startet `.github/workflows/agent-pruefer.yml` (Job „Vorpruefung
Agenten-PR“) von selbst und prüft den erzeugten Draft-PR **nur lesend und deterministisch**. Kein Claude, kein
Anthropic-Schlüssel, kein Environment, keine Secrets, nur Leserechte. Der Bericht ist **nie eine Freigabe**; über
den Merge entscheidet Noah. Ein grüner Prüflauf heißt nur „Prüfung ausgeführt“.

| Ergebnis | Bedeutung |
|---|---|
| `auffaelligkeiten` | mindestens ein Befund oder Hinweis im geprüften Umfang |
| `keine-auffaelligkeiten` | im geprüften Umfang nichts gefunden; ausdrücklich keine Freigabe |
| `ausstehend` | Pflichtchecks am PR-Kopf nach 12 Wiederholungen im Abstand von 30 s noch nicht fertig |
| `nicht-pruefbar` | Herkunft, Zuordnung, Auftragsbindung oder Daten fehlen, sind mehrdeutig oder widersprüchlich (fester Code im Bericht) |

Was geprüft wird, jeweils über die API und nie aus Titel oder Text des PR:
- **Herkunft:** Lauf aus `agent-auftrag.yml`, Ereignis `issues`, Zweig `main`, Versuch 1, Job 0 bis 3 erfolgreich.
- **Zuordnung:** genau ein PR nach `main` vom Zweig `wp/<ISSUE>-agent-<LAUF>-1`, offen, Draft, vom Bot, aus diesem
  Repository, genau ein Commit auf dem Ausgangsstand des Laufs; Kopf am Anfang und unmittelbar vor dem Bericht gleich.
- **Auftragsbindung:** Titel und Text des Issues gleich den Hashzeilen `A6-NUTZLAST` aus dem Log von Job 0; Startlabel
  von `noah04091` höchstens 60 s vor dem Laufstart.
- **Gate:** genau die Profildateien, kein gesperrter Pfad, Abnahmedatei vorhanden, Testdatei mit mehr `test(`-Aufrufen,
  Muster in der Quelldatei als Hinweis, Größen- und Inhaltsgrenzen, Pflichtchecks nur von GitHub Actions.

**Wo das Ergebnis steht:** genau eine Logzeile
`A6-PRUEFER repo noah04091/agenten-probe pr <n> kopf <sha> basis <sha> lauf <id> ergebnis <wert> befunde <n> hinweise <n>`
und der Bericht in der Zusammenfassung des Prüflaufs. Die Zentrale zeigt je Agenten-PR die Spalte „Vorprüfung“, nur
zum aktuellen Kopf; ein älterer Kopf heißt „veraltet“, kein Lauf „nicht geprüft“.

**Von Hand erneut prüfen** (nur `noah04091`, nur auf `main`):
`gh workflow run agent-pruefer.yml -R noah04091/agenten-probe -f lauf=<LAUF>`

**Container:** festes Node-Image, zuerst der äußere Anker und der Integritätsprüfer für alle Skripte unter
`scripts/`, erst danach das Prüfskript. Scheitert die Integrität, endet der Lauf rot mit `nicht-pruefbar` (Grund
`integritaet`), bevor etwas bewertet wird. Root-Dateisystem und Checkout nur lesbar, genau eine beschreibbare
Ergebnisdatei, keine Rechte, eigener Nutzer, nur die Variablen Token, Lauf-ID, Repository und ein fester `PATH`.

**Generalprobe:** Auf jedem PR läuft der Job „Generalprobe Vorpruefung gegen nachgebautes GitHub“ ohne Netz mit je
einem Fall für alle vier Ergebnisse. Er ist kein Pflichtcheck.

**Notabschaltung:** `gh workflow disable agent-pruefer.yml -R noah04091/agenten-probe` (Abschnitt 5).

## 9. KI-Prüfer: Freigabeschranke (B2.3a)

> **Gebaut, nicht aktiv.** In B2.3a läuft nach der Freigabe kein KI-Aufruf, kein Schlüssel und kein Checkout, nur eine
> Logzeile. Die Live-Proben (Plan B2.3a, L0 bis L8) stehen aus; nichts davon ist live belegt.

**Zweck:** Bevor ab B2.3b ein KI-Prüfer Geld kostet, fragt GitHub Noah um Freigabe, und zwar nur für einen fachlich
prüfbaren Gegenstand. Ein nicht prüfbares Ergebnis der Vorprüfung erzeugt **keine** Freigabeanfrage.

**Ablauf:** Nach jeder erfolgreichen Vorprüfung (Workflow `Agent-Vorpruefung` auf `main`) startet
`.github/workflows/agent-pruefer-ki.yml` (Workflow `Agent-Pruefer-KI`), oder Noah startet ihn von Hand.
1. Job `schranke_vorpruefung` (nur `actions: read` und `pull-requests: read`, kein Environment, kein Checkout) prüft in
   fester Reihenfolge; der erste Fehler entscheidet:
   1. Quelle: Ereignis, Lauf-ID und Versuch im festen Format.
   2. Environment `claude-pruefer` gegen das vollständige Soll: ID `28418332669`, genau ein Pflichtprüfer
      (`noah04091`), keine Admin-Umgehung, genau eine Branch-Regel `main`, keine weitere Regel.
   3. Quelllauf: Workflow `agent-pruefer.yml` (ID `429024670`), Zweig `main`, dieses Repository, Ereignis
      `workflow_run` oder `workflow_dispatch` (dann nur durch `noah04091`), abgeschlossen und erfolgreich, und der
      genannte Versuch ist der jüngste.
   4. Job „Vorpruefung Agenten-PR“ genau dieses Versuchs erfolgreich.
   5. Logzeile `A6-PRUEFER` nach denselben Regeln wie die Zentrale (Zeitstempel ab, nur Zeilen, die danach direkt mit
      `A6-PRUEFER ` beginnen, genau eine, strenges Muster). Nur `auffaelligkeiten` oder `keine-auffaelligkeiten` mit
      bekanntem PR und Kopf gehen weiter.
   6. PR: offen, Kopf gleich der Logzeile, Basis `main`, Autor die App `noah04091-agenten-probe-cloud-bot[bot]`
      (Typ `Bot`), Zweig `wp/<ISSUE>-agent-<AUFTRAG>-1` mit dem Auftragslauf aus der Logzeile.
   7. Doppelsperre: Derselbe Prüfumfang (PR und Kopf) wurde in keinem Versuch keines Laufs dieses Workflows schon
      freigegeben, frühere Versuche des eigenen Laufs eingeschlossen. Gegenprobe über `filter=all`; jede nicht lesbare
      oder widersprüchliche Antwort stoppt.
2. Nur wenn alles stimmt: Job `schranke` mit Environment `claude-pruefer`, ohne Rechte und ohne Token. Er wartet auf
   Noahs Freigabe, prüft die übergebenen Werte erneut gegen ihr Format und schreibt genau eine Zeile.

**Logzeilen** (genau eine je Job):
- Vorjob, Stopp: `A6-PRUEFER-SCHRANKE repo noah04091/agenten-probe quelle <lauf>-<versuch> ergebnis keine-anfrage grund <code>`
  (vor bestandener Formatprüfung `quelle unbekannt`), Lauf rot, keine Anfrage.
- Vorjob, bestanden: `A6-PRUEFER-SCHRANKE repo noah04091/agenten-probe quelle <lauf>-<versuch> auftrag <id> pr <n> kopf <sha> ergebnis anfrage`
- Schrankenjob nach der Freigabe: `A6-PRUEFER-SCHRANKE repo noah04091/agenten-probe quelle <lauf>-<versuch> auftrag <id> pr <n> kopf <sha> workflow-sha <sha> ereignis <workflow_run|workflow_dispatch> freigegeben`

`kopf` ist immer der PR-Kopf (aus Vorprüfungszeile und PR). `workflow-sha` ist nur der Stand des KI-Workflows. Beide
werden nie gleichgesetzt.

**Gründe:**

| Gruppe | Codes |
|---|---|
| Environment | `konfig-fehlt` (404), `konfig-nicht-lesbar`, `konfig-abweichung` |
| Quelle | `quelle-format`, `quelle-nicht-lesbar`, `quelle-herkunft`, `quelle-nicht-erfolgreich`, `veralteter-versuch` |
| Job und Log | `job-fehlt`, `job-mehrdeutig`, `job-nicht-erfolgreich`, `log-nicht-lesbar`, `zeile-fehlt`, `zeile-mehrdeutig`, `zeile-ungueltig`, `kein-auftrag` |
| Ergebnis | `nicht-pruefbar`, `ausstehend`, `pr-unbekannt` |
| PR | `pr-nicht-lesbar`, `pr-nicht-offen`, `kopf-geaendert`, `pr-herkunft` |
| Doppelsperre | `verlauf-nicht-lesbar`, `verlauf-unvollstaendig`, `verlauf-widerspruch`, `zu-viele-laeufe` (mehr als 100 Läufe), `zu-viele-abfragen` (mehr als 400 Abrufe), `parallel-lauf`, `bereits-freigegeben` |

**Freigeben oder ablehnen:** in der Lauf-Ansicht „Review deployments“, `claude-pruefer`, oder:
`gh api --method POST repos/noah04091/agenten-probe/actions/runs/<LAUF>/pending_deployments -F "environment_ids[]=28418332669" -f state=approved -f comment="<Grund>"`
(ablehnen mit `state=rejected`). Vor der Freigabe Gegenstand und Vorprüfungsergebnis ansehen. Eine Anfrage, die du
nicht erwartet hast, wird abgelehnt.

**Von Hand anstoßen** (nur `noah04091`, nur auf `main`):
`gh workflow run agent-pruefer-ki.yml -R noah04091/agenten-probe --ref main -f lauf=<LAUF der Vorprüfung> -f versuch=<VERSUCH>`

**Gleichzeitigkeit:** eine Gruppe für den ganzen Workflow (`agent-pruefer-ki`, ohne Abbruch). Ein Lauf, der auf die
Freigabe wartet, hält die Gruppe; ein zweiter wartet dahinter. **Hinweis H8** (nicht gemessen): GitHub hält je Gruppe
nur einen wartenden Lauf, ein dritter verdrängt den zweiten. Das ist kein Verlust: nicht freigegeben heißt nicht
geprüft, ein erneuter Dispatch ist möglich. Ablehnen gibt die Gruppe frei.

**Grenzen:** Zwischen Vorjob und Freigabe kann sich etwas ändern (PR-Kopf, Environment). In B2.3a ist das folgenlos, weil
nur eine Logzeile läuft. Vor B2.3b ist dieselbe Prüfung nach der Freigabe Pflicht. Ab mehr als 100 Läufen oder 400
Abrufen stoppt die Schranke grundsätzlich (fail-closed); dann braucht es eine neue Entscheidung.

**Notabschaltung:** Abschnitt 5, „KI-Prüfer abschalten“.
