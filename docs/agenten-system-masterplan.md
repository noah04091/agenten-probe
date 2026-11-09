# Agenten-System: Masterplan

> Verbindlicher Projektstand für `noah04091/agenten-probe`. Wer neu einsteigt (neues Terminal,
> neuer Chat, anderes Modell), liest zuerst diese Datei und arbeitet dann Abschnitt 12 ab.
> Jede Änderung am System aktualisiert diese Datei im selben Pull Request. Stand: 09.11.2026.

## 1. Ursprung: die Terminal- und Sitzungsorganisation (Ziel 0)

Noah arbeitet an Contract AI mit vielen parallelen Claude-Code-Terminals, zeitweise sieben gleichzeitig.
Dabei ging Arbeit verloren, wurde doppelt gemacht, Terminals überschrieben sich gegenseitig, und
veraltete Anleitungen in alten Arbeitsbäumen führten zu falschen Befehlen. Daraus entstand zuerst eine
**Ordnung für Terminals und Sitzungen** (September bis Anfang November 2026). Sie läuft bis heute und
ist die Grundlage für alles Weitere:

| Baustein | Was er leistet | Ort |
|---|---|---|
| Globale Arbeitsanweisung | gilt in jedem Terminal, hängt an keinem Git-Stand | `~/.claude/CLAUDE.md` |
| Ein Terminal, ein Arbeitsbaum | jedes Terminal arbeitet in eigenem, frischem Baum und räumt ihn am Ende ab | `~/.claude/CLAUDE.md` Abschnitt 3b |
| Getrennter Deploy-Ordner | nur von dort wird Contract AI live gestellt | `Documents/contract-ai-main` |
| Türsteher | blockiert gefährliche Befehle (`git add .`, `stash`, Force-Push auf main, Reset) | `~/.claude/hooks/tuersteher.js` |
| Statuszeile | zeigt Ordnerrolle, Abstand zu main, offene Änderungen | `~/.claude/statusline.js` |
| Übergabe und Übernahme | nahtloser Wechsel bei Limit, Modellwechsel, neuem Terminal | Skills `/uebergabe`, `/uebernahme` |
| Sitzungsübersicht | listet lokale Claude-Sitzungen in einer HTML-Seite | `Documents/claude-werkzeuge/sitzungen.js` |

Diese Ordnung bleibt gültig. Ziel B (Abschnitt 2) baut darauf auf: Die Sitzungsübersicht soll dort
zur Zentrale werden, die lokale Sitzungen **und** Agentenläufe in GitHub zeigt.

**Nicht verhandelbar, für alle Ziele:** Kein Agent schreibt auf `main`, kein automatischer Merge,
keine Umgehung von Schutzregeln, keine Produktivprojekte (Contract AI, FORDERA) vor Abschluss von
Ziel B im Testrepo und Noahs ausdrücklicher Freigabe. Erlaubte Dateien und Rechte kommen nie aus
einem Issue-Text.

## 2. Ziele A und B

**Ziel A: Code-Agent (MVP).** Noah gibt ein Issue frei, Claude ändert Code nur in erlaubten Dateien,
eine getrennte Prüfung ohne Geheimnisse führt Tests, Abnahmetests und Build aus, danach entsteht ein
eigener Branch mit Draft-PR und Zusammenfassung. Noah prüft und merged. Ein Auftrag, ein Agent, ein Lauf.

**Ziel B: Multi-Agenten-Plattform.** Mehrere Agenten parallel mit Rollen (Entwickler, Prüfer),
eine Zentrale für Aufträge, Läufe und lokale Sitzungen, Wiederaufnahme nach Fehlern, Kostenkontrolle,
längere Läufe bis zum Nachtbetrieb. Erst danach der Übertrag auf ein echtes Projekt.

**Übergang A zu B:** B beginnt erst, wenn A fertig ist (Abschnitt 8). Was A als Einzelfall baut
(Auftragsprofil, Prüfer-Job, Veröffentlicher), wird in B zum wiederverwendbaren Baustein. Darum wird
A von Anfang an ohne Festverdrahtung auf einzelne Issues gebaut (Paket A6).

## 3. Rollen und Verantwortung

| Wer | Aufgabe | Rechte |
|---|---|---|
| Noah | Aufträge freigeben, jeden Agentenlauf im Environment bestätigen, PRs prüfen und mergen, Entscheidungen in Abschnitt 11 | Admin (einziger), einziger Code-Owner |
| Claude Code im Bot-Terminal `Documents/agenten-probe-agent` | baut und pflegt die Plattform, pusht nur auf `wp/*`, öffnet Draft-PRs | GitHub `noah04091-agent`, Rolle write, nur dieses Repo, keine Admin-Ausnahme |
| Claude Code im Repo-Terminal mit Noahs Konto | Bestandsaufnahme, Gegenprüfung, Übergaben, **keine Schreibvorgänge auf GitHub** | Noahs Token (Admin), deshalb nur lesend |
| ChatGPT | Architektur, Planung, unabhängige Gegenprüfung jedes Arbeitsblocks | nur lesend |
| Agent in GitHub Actions | bearbeitet freigegebene Issues | Claude ohne Shell und ohne Schreibrechte; geschrieben wird nur in Job 3 mit kurzlebigem App-Token |

## 4. Architektur

```
 Noah ──(Issue + Label "bot-auftrag")──► GitHub Issue
   │                                        │ issues:labeled (nur Workflows auf main)
   │                                        ▼
   │                ┌── Job 1 Generator ─────────────────────┐
   │  bestätigt im  │ Environment "claude-bot"               │
   ├──Actions-UI───►│ Claude: nur Read/Edit/Write, kein Bash │
   │                │ Budget-Deckel, Ergebnis = Codepaket    │
   │                └───────────────┬────────────────────────┘
   │                                ▼ Artefakt (unveränderlich)
   │                ┌── Job 2 Prüfer, keine Secrets ─────────┐
   │                │ frische Kopie, Paket prüfen, Docker    │
   │                │ ohne Netz: npm test, Abnahme, Build    │
   │                └───────────────┬────────────────────────┘
   │                                ▼
   │                ┌── Job 3 Veröffentlicher ───────────────┐
   │                │ Issue live neu prüfen, Paket erneut    │
   │                │ prüfen, kurzlebiges App-Token, Branch, │
   │                │ Draft-PR. Führt keinen Agentencode aus │
   │                └───────────────┬────────────────────────┘
   │                                ▼
   │                Pflicht-CI: build, tests, schutzdateien
   ▼                                ▼
 Review + Merge (nur Noah) ◄── Draft-PR ──► Project-Board
```

**Wo die Sicherheit wirklich liegt:**
1. Environment `claude-bot`: Secrets (`ANTHROPIC_API_KEY`, `BOT_APP_PRIVATE_KEY`) nur dort, nur für
   `main`, jeder Lauf braucht Noahs Bestätigung. Auf Repo-Ebene liegen keine Secrets.
2. Job 2 und 3 arbeiten auf frischen Kopien. Die Prüfung in Job 1 ist nur eine Vorprüfung, denn
   Claude hat dort Schreibzugriff auf den Arbeitsbereich und könnte auch Prüfskripte verändern.
3. Agentencode läuft nur im Docker-Container ohne Netz, ohne Secrets, schreibgeschützt, ohne Rechte.
4. Ruleset `main-pruefungen` (ohne Ausnahme): PR-Pflicht, kein Force-Push, kein Löschen,
   Pflicht-Checks `build`, `tests`, `schutzdateien`. Ruleset `main-freigabe`: Code-Owner-Freigabe,
   Freigabe nach dem letzten Push, Ausnahme nur für die Admin-Rolle.
5. Check `schutzdateien`: Ein PR, der nicht von Noah stammt, darf `.github/`, `.claude/`,
   `CODEOWNERS`, `package.json`, `CLAUDE.md` nicht ändern.
6. Actions nur aus festgepinnten SHAs, Standard-Token nur lesend, Actions dürfen keine PRs freigeben.

## 5. Meilensteine

| Datum | Meilenstein | Beleg |
|---|---|---|
| 02.11. | Testrepo, Board, CI mit Versionsnachweis, Fehler „übersprungen zählt als bestanden“ behoben | PR #2, #4; `claude-werkzeuge/C1-testprotokoll.md` |
| 02.11. | Bot-Konto `noah04091-agent` (write, nur dieses Repo), erste Bot-PRs, Freigabe-Pflicht | PR #6, #8, #12 |
| 03.11. | CI vereinfacht, Check `schutzdateien`, CODEOWNERS | Issue #13, PR #14 |
| 03.11. bis 04.11. | Negative Sicherheitstests: roter Test, roter Build, geschützte Dateien, Bot ohne Freigabe | Issue #15, PR #16 bis #25 |
| 05.11. | GitHub-App mit kurzlebigen Tokens, Agenten-Runner in Actions | PR #27, #29, #30, #31 |
| 05.11. | **Erster echter Agentenlauf:** Claude schreibt eine Markdown-Datei, App öffnet Draft-PR | Issue #28, PR #32 |
| 05.11. bis 06.11. | Sichere Auftragsannahme und Live-Prüfung des Issues | PR #33, #34 |
| 06.11. | Zweiter echter Lauf mit dynamischem Routing, CI grün | Issue #35, PR #36 |
| 06.11. | Code-Pilot mit drei Jobs vorbereitet, gesperrt, nicht gemergt | PR #37, Issue #38 |
| 09.11. | Wechsel der Umsetzung zu Claude Code, Bestandsaufnahme, dieser Masterplan | dieser PR |

## 6. Ist-Zustand (09.11.2026)

| Baustein | Stand | Ort |
|---|---|---|
| CI und Schutz | funktioniert | `build.yml`, `tests.yml`, `schutz.yml`, `CODEOWNERS`, Rulesets |
| Bot-Konto | funktioniert, Token am 09.11. erneuert, Anmeldung als `noah04091-agent` geprüft (R7) | `noah04091-agent` |
| GitHub-App, kurzlebige Tokens | funktioniert | `noah04091-agenten-probe-cloud-bot` |
| Agent für Markdown-Testdateien | funktioniert echt (PR #32, #36) | `claude-agent.yml` auf main, Label `agent:test-note` |
| Code-Pilot (3 Jobs) | vorbereitet, gesperrt, nie gelaufen | PR #37, `code-pilot-claude-stufe.yml` |
| Probe-Workflows | grün, simulieren Teile ohne Claude | PR #37: `code-pilot-transfer`, `-abnahme-transferprobe`, `-isolation`, `-auftrag-probe`, `-issue-startprobe` |
| Lokales Windows-Bot-Konto (Plan C3) | nicht umgesetzt, geparkt | `claude-werkzeuge/C3-migrationsplan.md` |
| Sitzungsübersicht | vorhanden, seit 01.11. nicht erneuert, liest nur Contract AI | `claude-werkzeuge/sitzungen.js` |

**Aktivierung des Code-Pilots braucht vier Stellen:** `false &&` in Job 1 und Job 3, die Prüfung im
Integrationstest, die zwei Freigabevariablen in Job 3 (`CODE_PILOT_PUBLISH_*`). Und der Workflow
muss auf `main` liegen, weil Issue-Ereignisse nur Workflows auf `main` starten.

## 7. Offene Risiken und technische Schulden

| # | Punkt | Gewicht | Geplante Lösung |
|---|---|---|---|
| R1 | Abbruch nach Branch-Erstellung hinterlässt Branch ohne PR (`agent-code-publish.mjs` ab Zeile 131) | mittel | Aufgabe A1a |
| R2 | Bindung geprüftes Paket zu veröffentlichtem Inhalt nur indirekt (gleicher Lauf, gleiches Artefakt); der Vergleich auf GitHub prüft nur Dateinamen | mittel | Aufgabe A1b |
| R3 | Alles fest auf Issue #38 verdrahtet (Workflow, Prompt, Paket, Plan, Publisher, Abnahmetest) | hoch für Ziel A | Auftragsprofile in einer vertrauenswürdigen Datei auf `main` (A6) |
| R4 | Zwei Agenten-Workflows lauschen auf dieselben Label-Ereignisse | niedrig | alten Agenten nach Ziel A stilllegen (A8) |
| R5 | Sitzungen mit Noahs Admin-Token können die Freigaberegel umgehen | mittel | Schreiben nur im Bot-Terminal, Repo-Terminal nur lesend |
| R6 | Admin-Ausnahme in `main-freigabe` | bewusst | nötig, weil Noah einziger Code-Owner ist und eigene PRs nicht selbst freigeben kann |
| R7 | Bot-Token ist ein klassisches Token (nur `public_repo`) mit begrenzter Laufzeit. Das erste vom 02.11. lief am 09.11. ab; erneuert am 09.11., läuft laut GitHub am 09.12.2026 um 14:43 UTC ab | mittel | rechtzeitig vor Ablauf erneuern; langfristig auch das Bot-Terminal über kurzlebige App-Tokens |

### Aufgabe A1a: keine verwaisten Branches (R1)
Scheitert Job 3 nach dem Anlegen des Branches, darf er **nur unter allen diesen Bedingungen** aufräumen:
der Branch heißt exakt wie der in diesem Lauf berechnete Name (`wp/<issue>-code-pilot-<run_id>-<attempt>`),
er wurde in **diesem** Lauf angelegt, seine Spitze ist **genau** der Commit, den dieser Lauf erzeugt hat,
und es gibt keinen PR zu diesem Branch. Dann wird er gelöscht. Trifft auch nur eine Bedingung nicht zu,
wird **nichts** gelöscht, der Branch bleibt stehen und der Grund steht im Issue-Kommentar und im Log.
Nie wird ein anderer Branch, ein Branch mit PR oder `main` angefasst. Abnahme: Unit-Tests für Abbruch
nach Branch-Erstellung, für fremde Spitze und für vorhandenen PR, jeweils vorher rot.

### Aufgabe A1b: geprüft ist gleich veröffentlicht (R2)
Job 2 gibt den SHA-256 des geprüften Pakets als Job-Ausgabe weiter. Job 3 berechnet den Hash des
geladenen Pakets und bricht bei Abweichung ab, bevor irgendetwas auf GitHub geschrieben wird. Nach dem
Anlegen des Git-Baums vergleicht Job 3 die Blob-SHAs im neuen Baum mit den Blob-SHAs der lokal geprüften
Dateien. Abnahme: Unit-Tests für abweichenden Paket-Hash und abweichenden Blob, jeweils vorher rot.

**Beide Aufgaben werden erst in Phase 2 nach Freigabe gebaut, nicht vorher.**

## 8. Roadmap

### Phase 1: Übergabe sichern ✅ wenn diese Datei auf main liegt
Lokale Vorschläge archiviert (`docs/archiv/2026-11-02-lokal/`), lokale Sicherung
`Documents/agenten-probe-sicherung_2026-11-09/`, Arbeitsplatz festgelegt, Masterplan auf main.

### Phase 2: Erster echter Code-Lauf (Ziel A, MVP)
| Paket | Ergebnis | Abnahme |
|---|---|---|
| A0 Bot-Zugang ✅ 09.11. | neues Bot-Token, Ablaufdatum in R7 | erfüllt: `gh api user` meldet `noah04091-agent`, PR #39 wurde damit erstellt |
| A1 Härten | A1a und A1b umgesetzt | Tests wie in Abschnitt 7, vorher rot, nachher grün |
| A2 Konsolidieren | Probe-Workflows zu einem kostenlosen Trockenlauf zusammengeführt, der Job 2 und 3 ohne Claude prüft | jede Prüfung der alten Proben ist im Trockenlauf oder einem Unit-Test nachweisbar (Zuordnungsliste im PR); alte Proben werden erst nach A5 entfernt |
| A3 Auf main | PR #37 durch Noah gemergt, Sperren noch aktiv | Workflow auf main, alle Checks grün |
| A4 Entsperren | kleiner PR, nur die vier Aktivierungsstellen | Diff zeigt nur diese Stellen |
| A5 Erster Lauf | Label an #38, Noah bestätigt | Draft-PR der App mit genau `src/rechne.js` und `test/rechne.test.js`, CI grün, Kosten höchstens 1,50 $ |

### Phase 3: Ziel A vollständig
| Paket | Ergebnis | Abnahme |
|---|---|---|
| A6 Auftragsprofile | erlaubte Dateien, Prompt, Abnahmetest je Auftragsart aus einer Datei auf main | zwei neue Aufträge ohne Workflow-Änderung |
| A7 Negativfälle | verbotene Datei, falscher Code, entzogenes Label | jeweils kein PR, Grund im Issue |
| A8 Aufräumen | alter Agent und `claude-bot.yml` stillgelegt, Issues #28 und #35 geschlossen, Proben nach Zuordnungsliste entfernt | ein einziger Agenten-Workflow |

### Phase 4: Ziel B
B1 Zentrale: Board automatisch, Sitzungsübersicht liest auch dieses Repo und die Agentenläufe ·
B2 Prüfer-Agent, nur lesend, kommentiert jeden Draft-PR · B3 mehrere Aufträge parallel ·
B4 Fehlerbehandlung und Neustart per Label, begrenzte Versuche · B5 Kosten: Konto-Limit,
Budget je Lauf, Monatsauswertung · B6 längere Läufe, Nachtbetrieb erst nach B4 und B5 ·
B7 Übertrag auf ein echtes Projekt mit eigener App und eigenem Environment, nur nach Noahs Freigabe.

## 9. Fertig ist es, wenn

**Ziel A:** drei verschiedene Code-Aufträge echt bis zum Draft-PR mit grüner CI, drei Negativfälle
ohne PR und mit Grund, kein Lauf ohne Noahs Bestätigung, ein einziger Agenten-Workflow, diese Datei aktuell.

**Ziel B:** zwei Wochen Betrieb mit mindestens zehn Aufträgen, davon mindestens zwei parallel,
Prüfer-Kommentar auf jedem PR, Board ohne Handpflege aktuell, Kosten je Auftrag sichtbar, jeder
Fehlschlag mit Grund im Issue, Wiederaufnahme mindestens einmal echt erprobt.

## 10. Entscheidungen

| Datum | Entscheidung | Grund |
|---|---|---|
| 02.11. | Bot nutzt Noahs Claude-Konto, kein zweites Anthropic-Konto | Plan C3, Entscheidung M0 |
| 02.11. | Bot-Token klassisch statt fine-grained | fine-grained Tokens können als eingeladener Mitarbeiter in fremden Repos nicht schreiben |
| 02.11. | Board-Automatik „Item closed“ aus, Status von Hand | GitHub unterscheidet „gemergt“ nicht von „von Hand erledigt“ |
| 02.11. bis 06.11. | Agent läuft in GitHub Actions mit GitHub-App statt mit dauerhaftem Token | kurzlebige, eng begrenzte Rechte |
| 09.11. | Umsetzung in Claude Code statt Kopieren über den Web-Editor; ChatGPT prüft gegen | Tempo und weniger Übertragungsfehler |
| 09.11. | Lokales Windows-Bot-Konto geparkt, Agenten laufen in Actions | Windows-Claude ohne Sandbox, Runner-Isolation stärker |
| 09.11. | Erlaubte Dateien kommen nie aus dem Issue-Text | ein Issue ist kein vertrauenswürdiger Ort für Rechte |
| 09.11. | Schreibvorgänge auf GitHub nur mit dem Bot-Konto, nie mit Noahs Admin-Zugang | die Admin-Ausnahme darf nie von einer Claude-Sitzung genutzt werden |
| 09.11. | Probe-Workflows werden nicht pauschal entfernt, erst nach Zuordnungsliste und A5 | ihre Prüfungen dürfen nicht unbemerkt verloren gehen |
| 09.11. | Automatisches Aufräumen löscht nur den eigenen, eindeutig belegten Branch | kein unkontrolliertes Löschen |

## 11. Offene Entscheidungen für Noah

1. Die lokale Skill-Regel „Den Zweig aktualisiert immer der Agent, nie Noah“ (liegt als Patch im Archiv) aktiv übernehmen?
2. ~~Laufzeit des neuen Bot-Tokens~~ entschieden 09.11.: 30 Tage, siehe R7.

## 12. Einstieg für eine neue Claude-Code-Sitzung

1. Diese Datei vollständig lesen, danach `CLAUDE.md` im Repo und `~/.claude/CLAUDE.md`.
2. Ort prüfen: Entwicklung nur in `Documents/agenten-probe-agent`, gestartet über
   `Documents/claude-werkzeuge/agent-fenster.ps1`. `gh api user --jq .login` muss `noah04091-agent` melden.
   Meldet es `noah04091`, wird nichts geschrieben.
3. Stand holen: `git fetch origin`, dann gegen `origin/main` arbeiten, nie gegen einen alten lokalen Stand.
4. Offene Arbeit finden: Abschnitt 8 (erstes Paket ohne Haken), offene PRs, Issue #26.
5. Arbeiten nur auf einem eigenen Branch `wp/<issue>-<thema>`, am Ende Draft-PR, nie Merge.
6. Verboten ohne Noahs ausdrückliche Freigabe im laufenden Block: Merge, Änderungen an Rulesets,
   Environments, Secrets, Labels oder Einstellungen, Entfernen der `false &&`-Sperren, Start eines
   Claude-Laufs, jede Arbeit an Contract AI oder FORDERA, laufende Sitzungen beenden.
7. Am Ende eines Blocks: diese Datei aktualisieren (Meilensteine, Ist-Zustand, Risiken, Entscheidungen).

## 13. Historie und Quellen

Ausführlich in den Issues #13, #15, #26 und den PRs #2 bis #37. Ältere Konzepte bleiben unverändert erhalten:
`docs/agent-issue-routing.md`, in PR #37 zusätzlich `docs/agent-code-pilot.md`, `docs/agent-code-isolation.md`,
`docs/code-pilot-auftrag-38.md`. Lokale Vorschläge vom 02.11. in `docs/archiv/2026-11-02-lokal/`.
Planungsunterlagen außerhalb des Repos in `Documents/claude-werkzeuge/`: `C1-naechste-schritte.md`,
`C1-testprotokoll.md` (Testfälle T1 bis T20), `C3-migrationsplan.md`, `c3-stufe0/`.
