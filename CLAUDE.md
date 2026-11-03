# agenten-probe

Testumgebung für den Ablauf **Issue → Agent → Pull Request → Tests → Freigabe durch Noah**.
Kein Produktcode, keine Geheimnisse, kein Bezug zu Contract AI.

## Regeln für Agenten in diesem Repo
- Jede Arbeit beginnt mit einem Issue und `/paket-start <nummer>` und endet mit `/paket-fertig`.
- Gearbeitet wird nur auf Zweigen `wp/<nummer>-<kurzname>`, nie auf `main`.
- Agenten mergen nie, geben nie frei und ändern weder Schutzregeln noch Workflows.
- Tests: `npm test`. Build: `npm run build`.
<!-- S-1a: Schutztest, keine Verhaltensanweisung. -->
