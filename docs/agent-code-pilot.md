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

Erledigt mit Commit `f192b2a`: Hash aus Job 2, Kommentar-Token und die drei zusätzlichen Prüfungen
im Integrationstest. Beide `false &&`-Sperren sind unverändert. Pflichtprüfungen laufen nur bei
PRs gegen `main`; die CI für Arbeit am Code-Pilot entsteht deshalb auf PR #37.

### 7.4 Trockenlauf von Job 2 und Job 3 (A2)

`code-pilot-trockenlauf.yml` prüft bei jedem PR gegen `main` aus diesem Repository Job 2 und
Job 3 ohne Claude. Er hat `permissions: {}`, keine Secrets, kein Environment und kein Token und
kostet nichts (öffentliches Repository).

1. **Testpaket statt Claude:** `agent-code-dryrun.mjs prepare` spielt die feste Multiplikation
   ein (hat `main` sie nach A5 schon, nur je eine Kommentarzeile), `agent-code-package.mjs create`
   erzeugt das Paket, Upload als Artefakt.
2. **Job 2:** frische Kopie, Download per Artefaktname mit Digest-Prüfung wie im echten Job 2,
   `agent-code-package.mjs apply`, Docker ohne Netz mit `npm test`, Abnahmetest und Build, dann
   der Paket-Hash als Job-Ausgabe. Zusätzlich zum echten Job 2 wird der Image-Digest nach dem
   `docker pull` kontrolliert (aus der Isolationsprobe übernommen).
3. **Job 3 trocken:** frische Kopie, Paket erneut laden und prüfen, dann
   `agent-code-dryrun.mjs publish`. Das ruft den echten `publishCodePilot` mit dem Hash aus Job 2
   gegen ein strenges, nachgebautes GitHub im Speicher auf. Jeder Aufruf muss genau der nächste
   erwartete sein, und jeder Schreibaufruf muss genau den richtigen Inhalt tragen: Baum mit
   `base_tree` des Ausgangscommits und genau den zwei Dateien, Commit mit dem Ausgangscommit als
   einzigem Vorgänger, Branch mit dem berechneten Namen auf dem neuen Commit, PR als Entwurf von
   diesem Branch gegen `main`. Sonst wird der Aufruf nicht beantwortet und der Lauf bricht ab.
   Danach drei Gegenproben, die jeweils abbrechen müssen: falscher Hash (0 Anfragen),
   manipuliertes Byte im Paket (0 Anfragen), unerwarteter Aufruf direkt nach dem Anlegen des
   Branches (danach wird nichts mehr beantwortet, also kein PR und kein Löschen). Echte
   Netzaufrufe sind gesperrt, und mit einem Token im Umfeld verweigert das Skript den Lauf.

**Wachen:** `agent-code-dryrun.mjs guard` lässt den Trockenlauf rot werden, wenn sein Workflow
Secrets, Schreib- oder Leserechte über `{}` hinaus, ein Environment, Claude, ein App-Token, einen
Token-Ausdruck, `continue-on-error`, `exit`, `set +`, `|| true` oder eine zusätzliche
`if`-Bedingung (auch an einem Schritt) enthält, wenn `persist-credentials: false` fehlt, wenn ein
`run`-Block nicht mit `set -euo pipefail` beginnt, wenn ein Prüfschritt fehlt oder doppelt ist,
wenn er Dateien zurücksetzt, oder wenn Docker-Image, Docker-Aufruf, Hash-Berechnung oder
Paketprüfung vom echten Job 2 abweichen. Schreibaufrufe mit Zusatzfeldern (etwa ein fremder
`author`) weist der Nachbau ab. Nach dem Abbruch in der vierten Gegenprobe muss der
Veröffentlicher genau aufräumen wollen (Spitze lesen, Issue-Kommentar), ein `DELETE` ist dort ein
Fehler. Die Wache schützt vor Abweichung und Versehen. Eine
Sicherheitsgrenze ist sie nicht, denn ein PR kann den Workflow selbst ändern; diese Grenze bilden
`schutzdateien` und Noahs Freigabe. Die beiden `false &&`-Sperren zählt weiterhin der
Integrationstest in `code-pilot-claude-stufe.yml`, nicht diese Wache. A4 muss sie deshalb nicht
anfassen.

**Was der Trockenlauf nicht prüft:** den echten Start über das Issue-Ereignis, die Live-Prüfung
gegen das echte Issue #38, das App-Token, den Download per Name im echten Lauf, den Abbruchpfad
mit Aufräumen gegen echtes GitHub und echtes GitHub-Verhalten überhaupt. Das zeigt erst A5. Das
Aufräumen selbst ist durch die Unit-Tests in `test/agent-code-publish.test.mjs` belegt.

**Zuordnung der bisherigen Probe-Workflows** (entfernt werden sie erst nach A5, Paket A8):

| Probe | Prüfung | Abgedeckt durch |
|---|---|---|
| `code-pilot-isolation` | Image per Digest, Docker ohne Netz und Rechte, keine Geheimnisse, `npm test`, Build | Trockenlauf Job 2 (gleicher Docker-Aufruf, Digest-Kontrolle übernommen) |
| `code-pilot-transfer` | Paket erzeugen, Upload, Download mit Digest-Prüfung, `apply`, `git diff --check`, Docker | Trockenlauf Job 1 und 2 (Download per Name wie im echten Job 2 statt per ID) |
| `code-pilot-transfer` (Sperrprobe) | Ausgangscommit gleich `GITHUB_SHA`, Artefakt vorhanden | Trockenlauf Job 2 und 3 (`BASE_SHA`-Prüfung, `apply` scheitert ohne Paket) |
| `code-pilot-abnahme-transferprobe` | feste Multiplikation, sauberer Ausgangsstand, Abnahmetest im Container | Trockenlauf Job 1 und 2 |
| `code-pilot-auftrag-probe` | Unit-Tests Auftragsannahme und Live-Prüfung | `npm test` (`tests.yml`) und Integrationstest |
| `code-pilot-auftrag-probe` | live: #38 offen, von Noah, `agent:code-pilot`, **noch kein** `bot-auftrag` | **bleibt separat** bis A5; wird mit A5 absichtlich falsch |
| `code-pilot-issue-startprobe` | Unit-Tests Ereignisprüfung | `npm test` |
| `code-pilot-issue-startprobe` | echtes `issues: labeled` auf `main` mit Live-Prüfung | **bleibt separat**; auf einem PR nicht nachstellbar. Derselbe Prüfschritt (`agent-code-issue-live-check.mjs`) steckt in Job 1 und Job 3 des Claude-Workflows |

### 7.5 Aktivierung über einen Schalter (A4)

Job 1 und Job 3 beginnen nach A4 mit `vars.CODE_PILOT_ENABLED == 'true' &&` statt `false &&`.
Ist die Repository-Variable nicht gesetzt oder nicht `true`, starten beide Jobs nicht. GitHub
vergleicht dabei ohne Rücksicht auf Groß- und Kleinschreibung, auch `TRUE` schaltet also ein.
Ist sie gesetzt, braucht jeder Lauf trotzdem Noahs Freigabe im Environment `claude-bot`.

**Was der Schalter ist und was nicht:** `CODE_PILOT_ENABLED` ist ein Betriebs- und Abschaltschalter.
Er ist **nicht** nachgewiesenermaßen nur von Noah änderbar: Das Bot-Konto hat Schreibrecht auf das
Repository, und ob es Repository-Variablen setzen kann, ist nicht geprüft. Das wird vor A5 geprüft.
Die entscheidende zusätzliche Autorisierung bleibt Noahs Freigabe im Environment `claude-bot`.

**Zwei Jobs, ein Environment:** Job 1 und Job 3 nutzen beide `claude-bot`. Daraus folgt noch nicht
belegt, dass GitHub dafür zwei getrennte Freigaben verlangt; das ist bisher nicht beobachtet. Ob
Job 3 eine eigene Freigabe anfordert, wird beim echten A5-Lauf kontrolliert. Bis dahin gilt nur die
Freigabe vor Job 1 als sicher.

**Prüfung:** `scripts/agent-code-activation-check.mjs` kennt zwei sichere Zustände: harte Sperre
(`false &&`) oder Schalter. Es prüft außerdem, dass Bedingungen, Rechte, Environment, Secrets,
Claude-Budget und Ablauf von Job 1 bis 3 unverändert sind, und dass der Integrationstest bei
**jedem** PR aus diesem Repository läuft (vorher nur für den Branch von PR #37). Es läuft zweimal:
im Integrationstest des Workflows mit `--switch` und in `npm test`, also in der Pflichtprüfung
`tests`. Ein übersprungener Integrationstest kann deshalb nie allein als Nachweis gelten.
Letzte Schranke ist ein Fingerabdruck (SHA-256) der ganzen Workflow-Datei: Erlaubt sind genau die
gesperrte Fassung und die Schalter-Fassung. Jede andere Änderung macht `tests` rot, bis der
Fingerabdruck im Prüfskript sichtbar angepasst und im Review geprüft ist. Der Fingerabdruck schützt
vor **unbemerkten** Abweichungen, ist aber **keine unabhängige Sicherheitsgrenze**: Wer in einem PR
zugleich Workflow und Prüfskript ändert, kann beide passend machen. `scripts/` ist nicht durch
`schutzdateien` geschützt. Noahs persönliche Codeprüfung jedes PR bleibt deshalb erforderlich.

**Ablauf A4:**
1. Bot-PR mit Prüfskript, Tests, Doku und `docs/a4-workflow-patch.diff`. Ändert keine
   geschützte Datei, Noah gibt ihn regulär als Code-Owner frei.
2. Noah prüft `CODE_PILOT_ENABLED` (siehe unten), wendet den Patch mit eigenem Konto auf einem
   eigenen Branch an, löscht die Patch-Datei und öffnet einen PR. Merge über die dokumentierte
   Admin-Ausnahme (Masterplan Abschnitt 10), weil Noah den eigenen PR nicht freigeben kann.
3. Nach dem Merge: Nachweis, dass die Pipeline aus ist (siehe unten). Eingeschaltet wird erst mit
   Noahs Go für A5.

**Vor dem Merge prüfen, dass der Schalter aus ist:**
Auf beiden Ebenen muss `404 Not Found` kommen:
- `gh api repos/noah04091/agenten-probe/actions/variables/CODE_PILOT_ENABLED`
- `gh api repos/noah04091/agenten-probe/environments/claude-bot/variables/CODE_PILOT_ENABLED`

Gegenprobe, dass die Abfrage überhaupt etwas sieht (muss einen Treffer liefern):
`gh api repos/noah04091/agenten-probe/environments/claude-bot/variables --jq '.variables[].name'`
nennt `BOT_APP_CLIENT_ID`.

**Nach dem Merge nachweisen, dass die Pipeline aus ist:**
- Auf `main` steht der Schalter genau zweimal und kein `false &&`:
  `node scripts/agent-code-activation-check.mjs --switch`.
- `CODE_PILOT_ENABLED` liefert weiter `404`.
- Live-Probe ohne Kosten, nur mit Noahs ausdrücklichem Go: Label `bot-auftrag` an #38 setzen.
  Erwartet: „Claude erzeugt Codepaket“ und „Sichere Code-Veröffentlichung“ übersprungen, keine
  Freigabeanfrage im Environment. Danach das Label wieder entfernen.

**Notabschaltung:**
1. Variable ausschalten:
   `gh variable set CODE_PILOT_ENABLED --body false --repo noah04091/agenten-probe`
   (oder löschen). Neue Läufe starten Job 1 nicht mehr. Die Variable nie im Environment
   `claude-bot` anlegen. Ob sie dort im Job-`if` wirken würde, ist nicht geprüft.
2. Laufende Läufe **separat abbrechen**, denn die Variable hält einen schon laufenden Job nicht an:
   `gh run list --repo noah04091/agenten-probe --workflow code-pilot-claude-stufe.yml --status in_progress`
   und `--status waiting`, dann `gh run cancel <run-id> --repo noah04091/agenten-probe`.
3. Wartet ein Lauf auf die Freigabe im Environment: ablehnen. Ob Job 3 eine eigene Freigabe
   anfordert, ist erst nach A5 belegt. Bis dahin nicht darauf verlassen, sondern den Lauf abbrechen.
4. Zusätzlich möglich: Label `bot-auftrag` an #38 entfernen. Die Live-Prüfung in Job 3 bricht
   dann vor jedem Schreiben ab.

Ob eine während eines Laufs geänderte Variable den späteren Start von Job 3 noch verhindert, ist
nicht geprüft. Verlässlich sind Abbruch und Ablehnung der Freigabe.

Der alte Markdown-Agent (`claude-agent.yml`, Label `agent:test-note`) hängt nicht an diesem
Schalter. Er bleibt bis A8 bestehen und braucht weiter Noahs Freigabe im Environment. Issue #38
trägt sein Label nicht.

## 8. Erfolgskriterien

Der Pilot ist erfolgreich, wenn:

- Claude eine vorgegebene Rechenfunktion korrekt implementiert.
- Ausschließlich die beiden freigegebenen Dateien verändert werden.
- Build und automatisierte Tests bestehen.
- Ein eigener Branch und Draft-PR erzeugt werden.
- `main` unverändert bleibt, bis eine ausdrückliche menschliche Merge-Freigabe erfolgt.

Die Übertragung auf produktive Projekte ist nicht Bestandteil dieses Piloten.
