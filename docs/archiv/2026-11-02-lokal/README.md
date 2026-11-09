# Archiv: lokale Vorschläge vom 02.11.2026

Diese Dateien lagen nur lokal in `Documents/agenten-probe` (Ordner `vorschlag/` und eine uncommittete
Änderung an `.claude/skills/paket-fertig/SKILL.md`). Sie werden hier **unverändert** aufbewahrt,
damit die Historie nicht verloren geht. **Nichts davon ist aktiv.** Workflows wirken nur unter
`.github/workflows/`, hier liegen sie als Text.

| Datei | Was es ist | Heutiger Stand |
|---|---|---|
| `ANLEITUNG.md` | Anleitung zum Einspielen von `build.yml` und `tests.yml` über den Web-Editor | umgesetzt in PR #4, später durch PR #14 weiterentwickelt |
| `build.yml`, `tests.yml` | Workflows Version 2026-11-02-b ohne Überspringen im Entwurf | überholt, `main` weicht inzwischen deutlich ab |
| `plan-b-pruefung.yml` | Alternative: ein Workflow mit einziger Pflichtprüfung `pruefung-ok` | nie eingeführt |
| `nachweis.js` | lesendes Werkzeug: welche Workflow-Version lief für einen PR wirklich | nie eingecheckt, weiter nutzbar |
| `FREIGABE-PFLICHT.md`, `schutz-mit-freigabe.json` | Vorschlag Freigabe-Pflicht über klassischen Branch-Schutz | überholt durch die Rulesets `main-pruefungen` und `main-freigabe` |
| `paket-fertig-SKILL.md.patch` | Regel „Den Zweig aktualisiert immer der Agent, nie Noah“ | **nicht angewendet**, offene Entscheidung im Masterplan Abschnitt 11 |

Prüfsummen (SHA-256) der Dateien in diesem Ordner. Sie sind gleich mit den lokalen Originalen in
`Documents/agenten-probe-sicherung_2026-11-09/`, außer bei `ANLEITUNG.md`: Dort sind für die
öffentliche Fassung zwei lokale Windows-Pfade durch `<lokaler Ordner>` ersetzt. Das Original hat die
Prüfsumme `fa4db094dbdd96b04a7c03d7c6effb58e81cc71c3a2217124c93b49c900856a5` und liegt unverändert in der Sicherung.

```
4e19b21d77bacf96de13786af6b326e05392fb5876283b4f41ba9328a3608499  ANLEITUNG.md
723e05c8017ca77a970fb17586af0976366950748ea9bf8f1660842d731e9014  FREIGABE-PFLICHT.md
19ed371a65976647136bbe54bc35bb72609e101946d3bca38f08bd8db996c17f  build.yml
4c21c8280c058e59891488b2da99006eac6ddac6f2667cf8d1770df0261915c3  nachweis.js
0eecbef1eb8ef36242a04ff3b95c2b17cc2e3a5758ee634582bc522e6411b693  paket-fertig-SKILL.md.patch
5a810084ddd9caaafe046c89f65405569b111daf4f80b785fa6b6c47988a1899  plan-b-pruefung.yml
b4371df062fd0e5ba6835022451dd880f801a653935ac6e0cd90d3152e69bae9  schutz-mit-freigabe.json
32eb9ece0f3f1154086aa6fda7976d76fc123ccd9161c655bd9024344af82291  tests.yml
```

Der Patch gilt für `.claude/skills/paket-fertig/SKILL.md` auf Commit-Stand `3dc73fe` der Datei.
