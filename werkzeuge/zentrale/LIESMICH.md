# Zentrale (B1.1 Command Center v1)

Eine lokale Seite mit vier Bereichen, darüber seit B1.3 der Bereich „0 Fristen“:
1. offene Agenten-Aufträge;
2. Agentenläufe mit Fehlergrund und Draft-PR;
3. wartende Freigaben mit Frist;
4. Kosten und laufende Claude-Code-Sitzungen.

Jeder Wert ist belegt oder steht als „unbekannt“ da. Die Zentrale schreibt nie auf GitHub und ändert nichts an der
Agenten-Pipeline.

## Start

```
node werkzeuge/zentrale/zentrale.mjs              einmal erzeugen
node werkzeuge/zentrale/zentrale.mjs --schleife   alle 120 Sekunden neu erzeugen, Ende mit Strg+C
```

Die Seite liegt danach in `%USERPROFILE%\.zentrale\zentrale.html`, außerhalb jedes Repositorys. Sie ist eine
**Momentaufnahme** und sagt das oben mit Datum und Uhrzeit (UTC). Neu erzeugt wird sie nur durch den Befehl oben.

- **Ohne `--schleife`:** kein Neuladen im Browser. Die Seite sagt, dass sie sich nicht von selbst erneuert.
- **Mit `--schleife`:** der Browser lädt alle 60 Sekunden neu, und die Seite nennt die Uhrzeit, bis zu der die nächste
  Momentaufnahme fällig ist. Steht danach noch dieselbe Erzeugungszeit da, läuft die Schleife nicht mehr.
- **Ende der Schleife** (Strg+C oder gescheiterter Durchlauf): Die letzte Seite wird ohne Neuladen und mit dem Hinweis
  „Die Schleife wurde … beendet“ neu geschrieben. Wird der Prozess hart beendet, bleibt die Fälligkeitszeit der Beleg.

## Lese-Token einrichten (nur Noah)

1. **Token anlegen:** Auf GitHub ein Fine-grained-Token anlegen (Präfix `github_pat_`), Ablauf höchstens 90 Tage, nur
   für `noah04091/agenten-probe`.
2. **Rechte, nur Lesen:** Metadata, Contents, Issues, Pull requests, Actions, Deployments und **Checks**. Die Pflichtchecks
   brauchen `Checks: read`. Keine Schreibrechte.
3. **Speichern:** Den Wert selbst in `%USERPROFILE%\.zentrale\lese-token` ablegen. Kein Claude sieht, kopiert oder
   speichert ihn.

Die Zentrale bricht mit Exitcode 1 und ohne Seite ab, wenn die Datei:
- fehlt, leer ist oder ein Link ist;
- größer als 512 Bytes ist;
- in einem Git-Arbeitsbaum liegt;
- nicht mit `github_pat_` beginnt. `gho_`, `ghp_`, `ghs_` und `ghu_` werden ausdrücklich abgelehnt.

Danach muss `GET /repos/noah04091/agenten-probe` mit 200 antworten. Die Zentrale liest kein `gh`, keine
Umgebungsvariable und keinen Git-Credential-Helper, ein Rückfall auf eine andere Anmeldung ist also ausgeschlossen.
Fehlen dem Token Rechte, steht im betroffenen Bereich „keine Berechtigung (403), Token-Rechte prüfen“.

## Was die Seite zeigt und was nicht

- **Antwortklassen:** `ok`, `fehlt` und `unbekannt`. „fehlt“ gibt es nur bei 404 mit `"message": "Not Found"`, und nur
  für die Abnahme-Datei. Alles andere ist „unbekannt“. Ein ganz gescheiterter Bereich zeigt „Abruf fehlgeschlagen
  um …“ und keine alten Werte. Einzelne gescheiterte Abrufe stehen als „unbekannt“ da, mit dem Hinweis „Abruf
  fehlgeschlagen (teilweise)“.
- **Stand:** je Bereich „Stand: HH:MM UTC“. Stammt ein Bereich aus einem Abruf, der zur Erzeugungszeit älter als
  10 Minuten war: grau und „veraltet“.
- **Logs:** Sie werden nur über die 302-Weiterleitung von GitHub geladen, nur von
  `https://productionresultssa<n>.blob.core.windows.net`, ohne Token. Daraus werden nur der Fehlercode
  (`A6-FEHLER …`), die Runden und die Kosten (`Claude beendet: …`) gelesen. Der Logtext wird verworfen.
  `%USERPROFILE%\.zentrale\cache.json` enthält nur diese drei Werte je abgeschlossenem Job.
- **Kosten:** Summe im laufenden Kalendermonat (UTC). „keine“ steht nur mit Beleg da: Job 1 übersprungen, Job 1 in einem
  abgeschlossenen Lauf nie gestartet, oder im gelesenen Log von Job 1 ein Code vor dem Claude-Start
  (`auftrag-label-start-fehlt`, `auftrag-freigabe-entzogen`) ohne Kostenzeile. Sonst, auch bei wartendem oder laufendem
  Job 1, steht „unbekannt“ da. Vollständig ist die Summe nur, wenn die Laufliste vollständig ist und jeder Lauf des
  Monats einen Beleg hat; sonst steht „mindestens … (unvollständig)“ da.
  Der Bereich nennt drei Zahlen, die sich nicht überschneiden: „mit Kosten“, „belegt ohne Kosten“ und „Kosten
  unbekannt“. Ein Lauf ohne Kostenbeleg (Log gelesen, aber keine Kostenzeile; Job noch nicht abgeschlossen) ist kein
  Abruffehler: Er steht als Hinweis „n Lauf/Läufe ohne Kostenbeleg, Monatssumme unvollständig“ da. „Abruf
  fehlgeschlagen (teilweise)“ zeigt der Kostenbereich nur bei einer unvollständigen Laufliste oder wenn Jobliste oder
  Job-1-Log eines Laufs nicht geladen werden konnten, nie wegen Fehlern anderer Bereiche. Gemeint sind nur die Kosten
  der Agent-Aufträge (Workflow `agent-auftrag.yml`), nicht der Gesamtverbrauch des Anthropic-Workspace; der steht in
  der Anthropic-Konsole.
- **Fehlercodes:** Codes mit Klartext stehen mit Text da. Codes, die nur dem Namen nach aus der Pipeline bekannt sind
  (`BEKANNTE_CODES` in `fehlercodes.mjs`), stehen als „`<code>` (keine Beschreibung hinterlegt)“ da. Jeder andere Code
  bleibt „unbekannter Code“, sein Name erscheint nie. Mehrere Fehlerzeilen ergeben „mehrere Fehlercodes im Log“. Die
  Spalte heißt „Fehler laut Log“: Ein Treffer ist ein Protokolleintrag, kein bestätigter Befund.
- **Unsichere Zuordnungen:** Jobs aus einer unvollständigen Jobliste, PRs aus einer gescheiterten oder unvollständigen
  PR-Liste und Issues aus einer unvollständigen Issue-Liste stehen als „unbekannt“ da. Mehrere passende PRs: „mehrere
  passende PRs“. Eine unvollständige Check-Liste zeigt jeden Pflichtcheck als „unbekannt (Liste unvollständig)“.
- **Sitzungen:** nur `name`, `cwd`, Start, letzte Aktivität, `status`, `kind` und die ersten 8 Zeichen der Sitzungs-ID aus
  `%USERPROFILE%\.claude\sessions\*.json`. Keine `.key`-Dateien, keine Links, keine Gesprächsinhalte. Für die Tiefe
  verlinkt die Seite die bestehende Sitzungsübersicht `Documents/claude-werkzeuge/sitzungen.html`, falls vorhanden.
- **Fristen (B1.3):** Ganz oben steht der Bereich „0 Fristen“ mit immer drei Zugängen: Lese-Token der Zentrale,
  Bot-Token `noah04091-agent` und Anthropic-Schlüssel. Gerechnet wird in UTC ab der Erzeugungszeit. Stufen: mehr als
  14 Tage „ok“; 14 bis 8 Tage gelb, „bald erneuern“; 7 bis 2 Tage rot, „jetzt erneuern“; darunter „läuft in n Stunden
  ab“; danach „abgelaufen seit …“. Warnung, dringend und abgelaufen stehen zusätzlich als rotes Banner ganz oben. Jede
  Zeile nennt einen Handgriff, nie einen Tokenwert oder einen Pfad zu einem Geheimnis.
  - **Lese-Token:** automatisch aus dem Antwortkopf `github-authentication-token-expiration` der erfolgreichen
    Startprüfung („von GitHub gemeldet am …“). Nur das Datum wird gelesen, streng in der Form
    `JJJJ-MM-TT hh:mm:ss UTC`, sonst „Ablauf unbekannt“. Das zuletzt gemeldete Datum steht in `cache.json`
    (`leseTokenAblauf`); fehlt der Kopf, erscheint es nur als historische Angabe mit Meldezeit.
  - **Bot-Token und Anthropic-Schlüssel:** manuell aus `%USERPROFILE%\.zentrale\fristen.json` („manuell eingetragen am
    …, nicht von der Zentrale geprüft“; älter als 45 Tage zusätzlich „bitte prüfen“). Fehlt die Datei oder ein
    Eintrag, steht „Ablauf unbekannt“, nie „ok“. Eine ungültige Datei wird ganz verworfen, die übrigen Bereiche
    bleiben unberührt. Die Datei ist kein Link, höchstens 4 KB groß, liegt nicht in einem Git-Arbeitsbaum und enthält
    kein Geheimnis-Muster. Format (höchstens 10 Einträge, `zugang` je höchstens einmal, keine weiteren Felder;
    `ablauf` als `JJJJ-MM-TT` gilt ab 00:00 UTC und wird ohne Uhrzeit angezeigt):

    ```json
    { "schema": "zentrale-fristen-v1",
      "fristen": [
        { "zugang": "bot-token", "name": "Bot-Token noah04091-agent", "ablauf": "2026-12-22T11:26:44Z", "eingetragen": "2026-11-22" },
        { "zugang": "anthropic-schluessel", "name": "Anthropic-Schlüssel github-testbot", "ablauf": "2027-01-31", "eingetragen": "2026-11-22" } ] }
    ```
- **Notseite (B1.3):** Scheitert die Startprüfung oder fehlt die Token-Datei, ersetzt eine Notseite ohne GitHub-Daten
  und ohne Neuladen die alte Seite; der Exitcode bleibt 1. Bei 401 heißt es „abgelehnt“, nie pauschal „abgelaufen“: je
  nach letzter Meldung „wahrscheinlich abgelaufen am …“, „abgelehnt, obwohl laut letzter Meldung gültig bis …“ oder
  „Ablauf unbekannt“. Bei 403, 429, 5xx, Zeitlimit oder Netzfehler steht eine allgemeine Fehlerseite mit dem Grund da,
  ohne Hinweis auf das Token.
- **Gelesene Dateien:** `zentrale.mjs` liest nur `cache.json` und `fristen.json`; das Lese-Token liest `token.mjs`, die
  Sitzungen liest `sitzungen-meta.mjs` (Wache W12).
- **Nicht in v1:**
  - Schreibaktionen jeder Art;
  - automatische Erneuerung von Tokens oder Schlüsseln;
  - Freigaben aus der Zentrale (maßgeblich ist GitHub);
  - Benachrichtigungen;
  - Gesprächsinhalte;
  - Kosten lokaler Sitzungen.

## Echt-Proben (von Hand, nur lesend)

```
node werkzeuge/zentrale/echtprobe.mjs
```

Prüft die Antwortklassen an echten 404 und vergleicht die Läufe Live 2 (44765669207), NF2 (44793828526) und NF3
(44826212314) mit festen Sollwerten: Issue, Jobzustände, Fehlercode, Runden, Kosten (Toleranz 0,000001 $) und Draft-PR.
Exitcode 0 nur, wenn alles stimmt und die Daten vollständig sind. Jede Abweichung, ein fehlender oder außerhalb des
Zeitfensters liegender Lauf, ein Teilfehler oder eine unvollständige Monatssumme ergibt Exitcode 1. Eine Schreibprobe
gibt es in B1.1 nicht.

B1.3: Die Probe `frist-lese-token` verlangt im Antwortkopf der Startprüfung ein gültiges Ablaufdatum, und zwar genau
2026-12-21 21:04:30 UTC (`LESE_TOKEN_ABLAUF_SOLL_MS` in `echtprobe.mjs`). Ausgegeben wird nur das gelesene Datum, nie
der Rohwert. Nach einer Erneuerung des Lese-Tokens ist dieser Sollwert anzupassen.

## Tests

`test/zentrale-*.test.mjs` laufen in `npm test`, ohne Netz: In jedem Test ersetzt eine Attrappe `fetch` und wirft bei
einem echten Aufruf.
