---
name: paket-start
description: Startet ein Arbeitspaket aus einem GitHub-Issue. Liest das Issue, prüft Arbeitsbaum und Zweig, öffnet einen Entwurfs-PR und vermerkt am Issue, wie die Sitzung fortgesetzt wird. Aufruf mit /paket-start <issue-nummer>.
disable-model-invocation: true
---

# /paket-start <nummer>

1. **Issue lesen:** `gh issue view <nummer> --comments`. Ziel, Fertig-Kriterium, Bereich und "Ausdrücklich NICHT angefasst" übernehmen. Fehlt das Fertig-Kriterium: am Issue nachfragen und stoppen.
2. **Ort prüfen:** `git rev-parse --abbrev-ref HEAD` muss `wp/<nummer>-<kurzname>` sein, abgezweigt von frischem `origin/main`. Stehst du auf `main`: neuen Zweig anlegen mit `git fetch origin && git switch -c wp/<nummer>-<kurzname> origin/main`. Nie auf `main` committen.
3. **Überschneidung prüfen:** `gh pr list --state open --json number,title,files` und mit dem Bereich vergleichen. Bei Überschneidung am Issue kommentieren und auf Noah warten.
4. **Erster Commit und Entwurfs-PR:** nach dem ersten sinnvollen Commit
   `git push -u origin HEAD` und
   `gh pr create --draft --title "<Issue-Titel>" --body "Closes #<nummer>"`
   (Die PR-Vorlage danach im PR ausfüllen.)
5. **Am Issue vermerken:** `gh issue comment <nummer> --body "..."` mit:
   Sitzungsname, PR-Nummer und "Fortsetzen mit `claude --resume <sitzungsname>` oder `claude --from-pr <pr-nummer>`".
6. Danach normal arbeiten. Im Entwurf laufen keine Prüfungen; gebündelt pushen. Fertig ist das Paket erst mit `/paket-fertig`.

**Niemals:** mergen, Freigaben erteilen, auf `main` pushen, Schutzregeln oder Workflows ändern.
