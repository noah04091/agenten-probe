# Zentrale (B1.1 Command Center v1)

Eine lokale Seite mit vier Bereichen:
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

Die Seite liegt danach in `%USERPROFILE%\.zentrale\zentrale.html`, außerhalb jedes Repositorys. Der Browser lädt sie alle
60 Sekunden neu. Neu erzeugt wird sie nur durch den Befehl oben.

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
- **Stand:** je Bereich „Stand: HH:MM UTC“. Älter als 10 Minuten: grau und „veraltet“.
- **Logs:** Sie werden nur über die 302-Weiterleitung von GitHub geladen, nur von
  `https://productionresultssa<n>.blob.core.windows.net`, ohne Token. Daraus werden nur der Fehlercode
  (`A6-FEHLER …`), die Runden und die Kosten (`Claude beendet: …`) gelesen. Der Logtext wird verworfen.
  `%USERPROFILE%\.zentrale\cache.json` enthält nur diese drei Werte je abgeschlossenem Job.
- **Kosten:** Summe im laufenden Kalendermonat (UTC). Ist die Laufliste unvollständig oder ein Kostenwert nicht abrufbar,
  steht „mindestens … (unvollständig)“ da.
- **Sitzungen:** nur `name`, `cwd`, Start, letzte Aktivität, `status`, `kind` und die ersten 8 Zeichen der Sitzungs-ID aus
  `%USERPROFILE%\.claude\sessions\*.json`. Keine `.key`-Dateien, keine Links, keine Gesprächsinhalte. Für die Tiefe
  verlinkt die Seite die bestehende Sitzungsübersicht `Documents/claude-werkzeuge/sitzungen.html`, falls vorhanden.
- **Nicht in v1:**
  - Schreibaktionen jeder Art;
  - Freigaben aus der Zentrale (maßgeblich ist GitHub);
  - Benachrichtigungen;
  - Gesprächsinhalte;
  - Kosten lokaler Sitzungen.

## Echt-Proben (von Hand, nur lesend)

```
node werkzeuge/zentrale/echtprobe.mjs
```

Prüft die Antwortklassen an echten 404, zeigt die Werte der bekannten Läufe 44765669207, 44793828526 und 44826212314 und
die Monatssumme. Eine Schreibprobe gibt es in B1.1 nicht.

## Tests

`test/zentrale-*.test.mjs` laufen in `npm test`, ohne Netz: In jedem Test ersetzt eine Attrappe `fetch` und wirft bei
einem echten Aufruf.
