---
name: paket-fertig
description: Schließt ein Arbeitspaket ab. Prüft das Fertig-Kriterium mit Belegen, füllt den PR aus, stellt ihn auf "bereit" und markiert ihn für Noahs Freigabe. Aufruf mit /paket-fertig.
disable-model-invocation: true
---

# /paket-fertig

1. **Fertig-Kriterium prüfen:** das Issue zum PR öffnen (`gh pr view --json body,number` liefert "Closes #<n>"). Jeden Punkt des Fertig-Kriteriums mit Beleg erfüllen: Test, Ausgabe oder Messung. Ein Punkt ohne Beleg ist nicht erfüllt.
2. **Lokal testen:** `npm test`. Bei kritischem Pfad zusätzlich Rot-Beweis (Fehler einbauen, Test rot, zurückbauen, Prüfsumme).
3. **PR-Text ausfüllen** nach der Vorlage: Was ist für den Nutzer besser, Belege, was NICHT geprüft werden konnte, Risiko und Rückweg, Sitzungsname.
   `gh pr edit --body-file <datei>`
4. **Bereit stellen:** `gh pr ready`. Jetzt laufen Build und Tests.
5. **Auf die Prüfungen warten:** `gh pr checks --watch`. Rot: Ursache beheben, erneut pushen, nicht weiter zu Schritt 6.
6. **Zur Freigabe markieren:** `gh pr edit --add-label wartet-auf-noah` und am Issue kurz melden: "PR #<n> bereit zur Freigabe".
7. Danach **nichts mehr pushen**, außer Noah verlangt eine Änderung. Jeder neue Push macht eine Freigabe ungültig.

**Niemals:** selbst mergen oder freigeben.
