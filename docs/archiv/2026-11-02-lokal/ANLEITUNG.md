# Workflows ohne Entwurfs-Überspringen einspielen (Test-Repo agenten-probe)

Ein Pull Request mit beiden Dateien. Die Schutzregel bleibt unverändert, `main` wird erst durch deinen Merge geändert.

## Schritt 1: build.yml ersetzen und Entwurfs-PR anlegen
1. Datei `C:\Users\liebo\Documents\agenten-probe\vorschlag\build.yml` im Editor öffnen, `Strg+A`, `Strg+C`.
2. Im Browser öffnen: https://github.com/noah04091/agenten-probe/edit/main/.github/workflows/build.yml
3. Im Editorfeld `Strg+A`, dann `Strg+V`.
4. Oben rechts **Commit changes…** → **Create a new branch for this commit and start a pull request** → Zweigname `wf/ohne-entwurf-skip` → **Propose changes**.
5. Auf der folgenden Seite beim grünen Knopf den Pfeil wählen: **Create draft pull request**.
   (Absichtlich als Entwurf: so prüft der PR gleich mit, dass im Entwurf nicht mehr übersprungen wird.)

## Schritt 2: tests.yml auf demselben Zweig ersetzen
1. Datei `C:\Users\liebo\Documents\agenten-probe\vorschlag\tests.yml` im Editor öffnen, `Strg+A`, `Strg+C`.
2. Im Browser öffnen: https://github.com/noah04091/agenten-probe/edit/wf/ohne-entwurf-skip/.github/workflows/tests.yml
3. `Strg+A`, `Strg+V`, **Commit changes…** → **Commit directly to the `wf/ohne-entwurf-skip` branch** → **Commit changes**.

## Schritt 3: Bescheid geben
PR-Nummer an Claude. Claude prüft nur lesend und meldet das Ergebnis.

## Schritt 4: auf "bereit" stellen
Erst wenn Claude meldet, dass alles stimmt: im PR **Ready for review** klicken. Claude beobachtet dabei nur lesend den Merge-Zustand.

## Schritt 5: mergen
Erst nach Claudes Meldung: **Squash and merge**. Danach prüft Claude den Lauf auf `main`.

## Rückweg
Jederzeit: PR schließen ohne Merge (dann bleibt alles wie vorher), oder nach dem Merge ein PR mit der alten Fassung.

## Woran der Nachweis hängt (nicht nur grüner Haken)
- Im Protokoll jedes Laufs steht `Workflow-Version: build.yml 2026-11-02-b` bzw. `tests.yml 2026-11-02-b`.
- Daneben die SHA-256-Prüfsumme der Datei, die der Lauf tatsächlich benutzt hat. Sie muss gleich sein mit der Prüfsumme derselben Datei im geprüften Commit (per GitHub-API gelesen).
  Erwartete Werte bei unverändertem Einfügen:
  - build.yml: `19ed371a65976647136bbe54bc35bb72609e101946d3bca38f08bd8db996c17f`
  - tests.yml: `32eb9ece0f3f1154086aa6fda7976d76fc123ccd9161c655bd9024344af82291`
- Der Job muss im Entwurf **gelaufen** sein (Ergebnis success oder failure), nie "skipped", und der Schritt "Tests" bzw. "Build" muss ausgeführt worden sein.
