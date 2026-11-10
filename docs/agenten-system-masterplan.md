# Agenten-System: Masterplan

> Verbindlicher Projektstand für `noah04091/agenten-probe`. Wer neu einsteigt (neues Terminal,
> neuer Chat, anderes Modell), liest zuerst diese Datei und arbeitet dann Abschnitt 12 ab.
> Jede Änderung am System aktualisiert diese Datei im selben Pull Request. Stand: 09.11.2026,
> nach A3 (PR #37 auf `main`, Commit `aa3646d`).

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
| 09.11. | Wechsel der Umsetzung zu Claude Code, Bestandsaufnahme, dieser Masterplan | PR #39 (gemergt per Admin-Ausnahme, siehe Abschnitt 10) |
| 09.11. | **A1 Härten:** geprüftes Paket ist gleich veröffentlichtes (Hash aus Job 2, Blob-SHAs), kein verwaister Branch, im Zweifel nie löschen | PR #40, Workflow-Verdrahtung `f192b2a` |
| 09.11. | **A2 Trockenlauf:** Job 2 und Job 3 ohne Claude bei jedem PR gegen `main`; auf GitHub grün, gleicher Paket-Hash in Job 2 und 3, 190/190 Tests im Container, 0 Anfragen an echtes GitHub | PR #41, Workflow `92a9fc6`, Lauf 42691955117 |
| 09.11. | **A3:** Code-Pilot auf `main`, beide `false &&`-Sperren aktiv, `build` und `tests` auf `main` grün | PR #37, Commit `aa3646d` (gemergt per Admin-Ausnahme, siehe Abschnitt 10) |
| 09.11. | **A4:** Prüfskript, Tests und Patch regulär von Noah freigegeben; Workflow mit Schalter statt `false &&` von Noah angewendet; Label-Probe bei ausgeschaltetem Schalter übersprungen | PR #43 (Review „Approved“), PR #44 (`05e0267`, gemergt per Admin-Ausnahme, siehe Abschnitt 10), Lauf 42705575901 |
| 10.11. | **A5 Versuch 1 gescheitert:** Claude lief echt (Sonnet, 6 Runden, gemeldete Kosten **0,04 $**), die Abnahme in Job 2 lehnte das Paket ab, Job 3 wurde übersprungen, kein Branch, kein PR | Lauf 42778651853, Abschnitt 6 |
| 10.11. | Vorgabe zu `-0` als Kommentar in `src/rechne.js`, Abnahme unverändert | PR #46 (Autor Bot, regulär freigegeben, `21b9b56`) |
| 10.11. | **A5 abgeschlossen: erster echter Code-Lauf bis zum gemergten PR.** Claude schrieb die Multiplikation, Job 2 bestand die unabhängige Abnahme, die App öffnete einen Draft-PR mit genau den zwei Dateien, Noah gab ihn regulär frei. Gemeldete Kosten 0,04 $ (beide Versuche zusammen rund 0,08 $) | Lauf 42783596004, PR #47 (`a64cab3`), Abschnitt 6 |

## 6. Ist-Zustand (10.11.2026, nach A5)

| Baustein | Stand | Ort |
|---|---|---|
| CI und Schutz | funktioniert | `build.yml`, `tests.yml`, `schutz.yml`, `CODEOWNERS`, Rulesets |
| Bot-Konto | funktioniert, Token am 09.11. erneuert, Anmeldung als `noah04091-agent` geprüft (R7) | `noah04091-agent` |
| GitHub-App, kurzlebige Tokens | funktioniert | `noah04091-agenten-probe-cloud-bot` |
| Agent für Markdown-Testdateien | funktioniert echt (PR #32, #36) | `claude-agent.yml` auf main, Label `agent:test-note` |
| Code-Pilot (3 Jobs) | auf `main`, gehärtet (A1), Schalter `CODE_PILOT_ENABLED` (A4) nach A5 wieder nicht gesetzt; zweimal echt gelaufen, einmal bis zum gemergten PR (A5). Auftrag noch fest auf Issue #38 (R3) | `code-pilot-claude-stufe.yml` |
| Anthropic-API-Schlüssel | Secret `ANTHROPIC_API_KEY` im Environment `claude-bot`, läuft laut Noah am **02.12.2026** ab | Wartungspunkt W1 in Abschnitt 7 |
| Trockenlauf | läuft bei jedem PR gegen `main` aus diesem Repo, prüft Job 2 und Job 3 ohne Claude, ohne Secrets, ohne Kosten | `code-pilot-trockenlauf.yml`, `scripts/agent-code-dryrun.mjs` |
| Probe-Workflows | auf `main`, laufen nur noch für den gemergten Branch `wp/26-agent-code-pilot` und damit praktisch nicht mehr; Zuordnung zum Trockenlauf in `docs/agent-code-pilot.md` 7.4 | `code-pilot-transfer`, `-abnahme-transferprobe`, `-isolation`, `-auftrag-probe`, `-issue-startprobe` |
| Lokales Windows-Bot-Konto (Plan C3) | nicht umgesetzt, geparkt | `claude-werkzeuge/C3-migrationsplan.md` |
| Sitzungsübersicht | vorhanden, seit 01.11. nicht erneuert, liest nur Contract AI | `claude-werkzeuge/sitzungen.js` |

**Aktivierung des Code-Pilots (A4), nachgemessen am 09.11. auf `aa3646d`:** Es sind **drei** Stellen in
`code-pilot-claude-stufe.yml`: `false &&` in Job 1 (Zeile 118) und Job 3 (Zeile 358) sowie die Prüfung
`hardGate` im Integrationstest (Zeilen 75 bis 80). Die zwei Freigabevariablen `CODE_PILOT_PUBLISH_*` in
Job 3 (Zeilen 490 und 491) sind bereits gesetzt und keine Aktivierungsstelle mehr. Der Workflow liegt
auf `main`, wie für Issue-Ereignisse nötig. Danach bleibt die menschliche Freigabe im Environment
`claude-bot` (Reviewer `noah04091`, nur Branch `main`). Job 1 und Job 3 nutzen beide dieses
Environment. In A5 belegt: GitHub verlangt dafür **zwei getrennte Freigaben**, eine vor Job 1 und
eine vor Job 3 (Lauf 42783596004).

**A4 vorbereitet:** Die beiden `false &&` werden durch den Schalter `vars.CODE_PILOT_ENABLED == 'true' &&`
ersetzt, der Integrationstest läuft bei jedem PR aus diesem Repository und ruft
`scripts/agent-code-activation-check.mjs --switch` auf. Dieselbe Prüfung läuft in `npm test`. Patch,
Ablauf, Prüfung des Schalters und Notabschaltung: `docs/agent-code-pilot.md` Abschnitt 7.5.
Umgesetzt mit PR #43 und PR #44.

**A5 Versuch 1 (10.11., Lauf 42778651853):** Noah setzte das Label `bot-auftrag` an #38 um 07:54:59 UTC
und gab das Environment `claude-bot` frei (eine Freigabe, vor Job 1). Job 1 lief mit Erfolg: Claude
änderte genau `src/rechne.js` und `test/rechne.test.js`, die Änderungsprüfung bestand. Gemeldete Kosten
laut Ergebnis von Claude Code: `total_cost_usd` 0,0414 (rund 0,04 $), 6 Runden. Job 2 lehnte das Paket
in der unabhängigen Abnahme (`scripts/agent-code-acceptance.mjs`) ab:
`multipliziere(0, -9) liefert ein falsches Ergebnis`, erwartet `-0`, geliefert `0`. Ursache im Paket:
Claude schrieb `return a * b + 0;` mit dem Kommentar „normalisiert -0 zu 0“ und einen eigenen Test, der
für `multipliziere(-5, 0)` den Wert `0` erwartet. `assert.strictEqual` unterscheidet `0` und `-0`, ohne
die Normalisierung wäre also Claudes eigener Test rot gewesen. Job 3 wurde übersprungen, es entstand
kein Branch und kein PR, ins Issue wurde nichts geschrieben. Das Label ist seit 08:01:10 UTC entfernt.
**Die Kette hat damit wie geplant gehalten:** Ein falsches Ergebnis kam nicht bis zur Veröffentlichung.
Nicht geklärt durch diesen Lauf: ob Job 3 eine eigene Environment-Freigabe anfordert (Job 3 lief nicht).

**Befund aus Versuch 1: Claude sieht den Issue-Text nicht.** Die Action meldete
`Auto-detected mode: agent for event: issues` und als Kontext nur den festen Prompt aus Job 1. Claude
hat nur `Read`, `Edit` und `Write`, also keinen Zugriff auf GitHub. Eine Präzisierung nur im Text von
#38 erreicht Claude deshalb nicht.

**Vorbereitung für Versuch 2:** Die Abnahme wurde nicht abgeschwächt. Stattdessen kam die Vorgabe
„exakt `a * b`, einschließlich `-0`, keine Normalisierung, auch eigene Tests unterscheiden `0` und `-0`“
als Kommentar in `src/rechne.js` (PR #46, Autor Bot, regulär freigegeben). Diese Datei liest Claude vor
dem Ändern zwangsläufig; eine garantierte Übermittlung ist das nicht. ChatGPT prüfte Vorschlag und PR
vorab unabhängig.

**A5 Versuch 2 (10.11., Lauf 42783596004), erfolgreich:**
- Label `bot-auftrag` von Noah um 08:33:39 UTC gesetzt, um 08:40:15 UTC wieder entfernt.
- **Zwei Environment-Freigaben** durch `noah04091`, beide `approved`: vor Job 1 und vor Job 3. Job 2
  endete 08:35:42 UTC, Job 3 startete erst 08:37:50 UTC nach der zweiten Freigabe.
- Job 1: Claude (Agent-Modus, 6 Runden, gemeldete Kosten `total_cost_usd` 0,0425, rund 0,04 $) schrieb
  `return a * b;`. Änderungsprüfung bestanden: genau `src/rechne.js` und `test/rechne.test.js`,
  27 geänderte Zeilen.
- Job 2: Tests, Build und die unveränderte Abnahme bestanden (110 unabhängige Rechenfälle).
- Job 3: Die App öffnete PR #47 von `wp/38-code-pilot-42783596004-1`. Commit `bb2ded1` mit Autor
  `noah04091-agenten-probe-cloud-bot[bot]`, von GitHub als verifiziert signiert.
- PR #47: auf GitHub `build`, `tests`, `schutzdateien`, Integrationstest und Trockenlauf grün. ChatGPT
  prüfte PR und GitHub-Stand unabhängig. Noah gab regulär frei (Review „Approved“) und mergte um
  09:21:32 UTC (`a64cab3`), ohne Admin-Ausnahme. Der Agenten-Branch ist gelöscht, Issue #38 ist als
  erledigt geschlossen.
- **Kosten A5 gesamt:** rund 0,08 $ laut den Ergebnissen von Claude Code (0,0414 + 0,0425), weit unter
  dem Deckel von 1,50 $ je Lauf.
- Nicht in A5 geprüft: ob das Bot-Konto Repository-Variablen schreiben, also den Schalter setzen kann.
  Das bleibt offen (Abschnitt 10, A4-Schalter).

## 7. Offene Risiken und technische Schulden

| # | Punkt | Gewicht | Geplante Lösung |
|---|---|---|---|
| R1 | ~~Abbruch nach Branch-Erstellung hinterlässt Branch ohne PR~~ | erledigt | A1a (PR #40): gelöscht wird nur ein belegt eigener Branch vor der PR-Anfrage, sonst bleibt er stehen und der Grund steht im Issue |
| R2 | ~~Bindung geprüftes Paket zu veröffentlichtem Inhalt nur indirekt~~ | erledigt | A1b (PR #40, `f192b2a`): Hash aus Job 2, Bytevergleich, Blob-SHAs im Baum und im Diff; auf GitHub im Trockenlauf belegt |
| R3 | **Offen.** Alles fest auf Issue #38 verdrahtet (Workflow, Prompt, Paket, Plan, Publisher, Abnahmetest), die Auftragsbeschreibung eingeschlossen. Der Issue-Text erreicht Claude nicht (belegt in A5 Versuch 1, Abschnitt 6); die Vorgabe für Versuch 2 kam nur als Kommentar im Code | hoch für Ziel A | Auftragsprofile in einer vertrauenswürdigen Datei auf `main` (A6) |
| R4 | Zwei Agenten-Workflows lauschen auf dieselben Label-Ereignisse | niedrig | alten Agenten nach Ziel A stilllegen (A8) |
| R5 | Sitzungen mit Noahs Admin-Token können die Freigaberegel umgehen | mittel | Schreiben nur im Bot-Terminal, Repo-Terminal nur lesend |
| R6 | Admin-Ausnahme in `main-freigabe` | bewusst | nötig, weil Noah einziger Code-Owner ist und eigene PRs nicht selbst freigeben kann. Bisher dreimal genutzt (PR #39, PR #37, PR #44), siehe Abschnitt 10 |
| R8 | Jede Änderung an `.github/`, `CODEOWNERS`, `package.json` oder `CLAUDE.md` lässt sich nur per Admin-Ausnahme mergen: Ein Bot-PR scheitert an `schutzdateien`, ein PR von Noah an der Code-Owner-Freigabe (er kann den eigenen PR nicht freigeben). Gewöhnliche Agenten-PRs (nur Code) sind davon nicht betroffen, die gibt Noah regulär frei | hoch für Ziel B | entschieden: Weg A jetzt, Weg B vor B7 (Abschnitt 10). Plattform so bauen, dass Agentenarbeit nie geschützte Dateien braucht, etwa Auftragsprofile (A6) in einem eigenen Ordner unter `CODEOWNERS`, aber außerhalb von `schutzdateien` |
| R7 | Bot-Token ist ein klassisches Token (nur `public_repo`) mit begrenzter Laufzeit. Das erste vom 02.11. lief am 09.11. ab; erneuert am 09.11., läuft laut GitHub am 09.12.2026 um 14:43 UTC ab | mittel | rechtzeitig vor Ablauf erneuern; langfristig auch das Bot-Terminal über kurzlebige App-Tokens |
| W1 | **Wartung:** Der Anthropic-API-Schlüssel (`ANTHROPIC_API_KEY` im Environment `claude-bot`) läuft laut Noah am **02.12.2026** ab. Danach scheitert Job 1 | mittel | Noah erneuert den Schlüssel vor dem 02.12.2026 und hinterlegt ihn im Environment; Claude-Sitzungen fassen Secrets nicht an |

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

**Beide Aufgaben sind erledigt** (PR #40 und `f192b2a`), mit Rot-Beweis per Mutation. Zusätzlich gilt
seit der Nachbesserung: Sobald die PR-Anfrage abgeschickt ist, wird nie mehr gelöscht.

## 8. Roadmap

### Phase 1: Übergabe sichern ✅ wenn diese Datei auf main liegt
Lokale Vorschläge archiviert (`docs/archiv/2026-11-02-lokal/`), lokale Sicherung
`Documents/agenten-probe-sicherung_2026-11-09/`, Arbeitsplatz festgelegt, Masterplan auf main.

### Phase 2: Erster echter Code-Lauf (Ziel A, MVP) ✅ abgeschlossen am 10.11.
A0 bis A5 sind erfüllt. **Ziel A ist damit noch nicht erreicht:** A6 bis A8 und die Kriterien aus
Abschnitt 9 sind offen. Nächstes Paket ist **A6 Auftragsprofile**.

| Paket | Ergebnis | Abnahme |
|---|---|---|
| A0 Bot-Zugang ✅ 09.11. | neues Bot-Token, Ablaufdatum in R7 | erfüllt: `gh api user` meldet `noah04091-agent`, PR #39 wurde damit erstellt |
| A1 Härten ✅ 09.11. | A1a und A1b umgesetzt | erfüllt: PR #40 und `f192b2a`, neue Tests vorher rot, 19 Mutationen rot, CI auf PR #37 grün |
| A2 Konsolidieren ✅ 09.11. | Trockenlauf prüft Job 2 und 3 ohne Claude | erfüllt: PR #41 und `92a9fc6`, auf GitHub grün (Lauf 42691955117), Zuordnungsliste in `docs/agent-code-pilot.md` 7.4; alte Proben werden erst nach A5 entfernt |
| A3 Auf main ✅ 09.11. | PR #37 gemergt, Sperren aktiv | erfüllt: `aa3646d`, `build` und `tests` auf `main` grün, Issue #38 nicht gestartet |
| A4 Entsperren ✅ 09.11. | Schalter statt `false &&`, Integrationstest bei jedem PR, Prüfung auch in `npm test`; Patch von Noah per dokumentierter Admin-Ausnahme | Diff nur in `code-pilot-claude-stufe.yml` an Integrationstest und den zwei Sperren; Integrationstest läuft auf dem A4-PR und ist grün; Claude-Jobs übersprungen; `CODE_PILOT_ENABLED` vor und nach dem Merge nicht gesetzt |
| A5 Erster Lauf ✅ 10.11. | Label an #38, Noah bestätigt | erfüllt: Draft-PR #47 der App mit genau `src/rechne.js` und `test/rechne.test.js`, CI grün, regulär freigegeben und gemergt (`a64cab3`); zwei getrennte Environment-Freigaben belegt; Kosten rund 0,08 $ für beide Versuche. Versuch 1 scheiterte an der Abnahme (`-0`), Versuch 2 bestand. Nicht geprüft: Schreibrechte des Bot-Kontos auf Repository-Variablen |

### Phase 3: Ziel A vollständig
| Paket | Ergebnis | Abnahme |
|---|---|---|
| A6 Auftragsprofile (nächstes Paket) | erlaubte Dateien, Prompt mit Auftragsbeschreibung, Abnahmetest je Auftragsart aus einer vertrauenswürdigen Datei auf main statt fest auf #38 (löst R3) | zwei neue Aufträge ohne Workflow-Änderung |
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
| 09.11. | Im Zweifel wird nie gelöscht: nach abgeschickter PR-Anfrage bleibt der Branch immer stehen | GitHub kann den PR trotz Fehler angelegt haben |
| 09.11. | **Ausnahme-Merge PR #39** (Masterplan, Autor Bot) durch Noah über die Admin-Ausnahme von `main-freigabe`, ohne hinterlegtes Review | einmalig; regulär wäre hier eine Freigabe durch Noah als Code-Owner möglich gewesen, da der Bot Autor war |
| 09.11. | **Ausnahme-Merge PR #37** (Code-Pilot, Autor Noah, ändert `.github/`) durch Noah über die Admin-Ausnahme, ohne hinterlegtes Review | einmalig und unvermeidbar: Noah ist Autor und einziger Code-Owner und kann den eigenen PR nicht freigeben (R8) |
| 09.11. | Workflow-Änderungen aus Agentenarbeit liefert der Bot als Patch, Noah wendet sie mit eigenem Konto an | Agenten ändern `.github/` nie selbst (`schutzdateien`, Repo-`CLAUDE.md`) |
| 09.11. | **Freigabeweg (R8), Weg A:** Änderungen an geschützten Dateien per dokumentierter Admin-Ausnahme, nur für genau diese Änderung, nach Prüfung durch ChatGPT und einen unabhängigen Claude-Prüfer, mit Eintrag in dieser Tabelle. Keine Abschwächung von `schutzdateien`, keine künstlichen Freigaben | Noah ist einziger Code-Owner; ein regulärer Weg existiert für diese Dateien nicht |
| 09.11. | **Langfristig Weg B:** eine zweite, tatsächlich unabhängige Person als Code-Owner für geschützte Dateien, vor dem produktiven Einsatz (spätestens B7) | echte Vier-Augen-Prüfung statt Ausnahmen |
| 09.11. | **A4-Schalter:** `vars.CODE_PILOT_ENABLED == 'true'` statt `false &&`; nach dem Merge bleibt die Variable ungesetzt | Abschalten ohne Merge und ohne Ausnahme. Der Schalter ist ein Betriebsschalter, keine Autorisierung: dass nur Noah ihn setzen kann, ist nicht belegt (Schreibrechte des Bot-Kontos vor A5 prüfen). Autorisierung bleibt die Freigabe im Environment. Der Fingerabdruck im Prüfskript erkennt Abweichungen, ersetzt aber nicht Noahs Codeprüfung |
| 09.11. | **Ausnahme-Merge PR #44** (A4-Workflow, Autor Noah, ändert `.github/`) durch Noah über die Admin-Ausnahme, ohne hinterlegtes Review | Weg A, wie für A4 entschieden; Inhalt vorher als PR #43 regulär freigegeben |
| 10.11. | **Die Abnahme wird nach Versuch 1 nicht abgeschwächt.** `scripts/agent-code-acceptance.mjs` vergleicht weiter exakt mit `a * b`, einschließlich `-0` | geprüft wird, ob der Agent die unabhängigen Anforderungen erfüllt, nicht die Prüfung an den Agenten angepasst |

## 11. Offene Entscheidungen für Noah

1. Die lokale Skill-Regel „Den Zweig aktualisiert immer der Agent, nie Noah“ (liegt als Patch im Archiv) aktiv übernehmen?
2. ~~Laufzeit des neuen Bot-Tokens~~ entschieden 09.11.: 30 Tage, siehe R7.
3. ~~Freigabeweg für geschützte Dateien (R8)~~ entschieden 09.11., siehe Abschnitt 10.
4. ~~A4-Schalter~~ entschieden 09.11.: Repository-Variable `CODE_PILOT_ENABLED`, siehe Abschnitt 10.
5. Wer wird die zweite unabhängige Review-Person (Weg B), und bis wann? Spätestens vor B7.

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

Ausführlich in den Issues #13, #15, #26 und den PRs #2 bis #41. Ältere Konzepte bleiben unverändert erhalten:
`docs/agent-issue-routing.md`, in PR #37 zusätzlich `docs/agent-code-pilot.md`, `docs/agent-code-isolation.md`,
`docs/code-pilot-auftrag-38.md`. Lokale Vorschläge vom 02.11. in `docs/archiv/2026-11-02-lokal/`.
Planungsunterlagen außerhalb des Repos in `Documents/claude-werkzeuge/`: `C1-naechste-schritte.md`,
`C1-testprotokoll.md` (Testfälle T1 bis T20), `C3-migrationsplan.md`, `c3-stufe0/`.
