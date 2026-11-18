# Mitschnitte der gepinnten Claude-Code-Version (K1a)

Echte stream-json-Ausgabe von Claude Code 2.1.326 (Sperrdatei `entwurf/a6-p1/claude-code/`), erzeugt am
18.11.2026 offline. Kein Schlüssel, kein Anthropic, kein GitHub, keine Kosten.

- Claude lief mit genau den Schaltern aus `a6_claude_aufruf` im gepinnten Node-Image: `--tools "Read,Edit"`,
  `--settings` mit der aus `.github/agent/claude-settings.json` erzeugten Datei (allow nur
  `Read`/`Edit` der Profildateien von `js-rechner`), `--setting-sources ""`, `--strict-mcp-config`,
  `--permission-mode dontAsk`, `--model sonnet`, `--max-turns 8`, `--max-budget-usd 1.5`,
  `--output-format stream-json --verbose`. Arbeitsordner `/arbeit` mit genau `src/rechne.js` und
  `test/rechne.test.js`.
- Das Modell ersetzte eine lokale Attrappe (`docs/a6-k1a-erfassung/attrappe.mjs`) in einem internen Docker-Netz ohne
  Ausgang. Sie antwortet mit festen `tool_use`-Blöcken aus einem Plan (`docs/a6-k1a-erfassung/plan-*.json`). Alles
  ausser den Modellantworten stammt von Claude Code selbst: Ereignisse, Erlaubnisentscheidungen,
  Ablehnungen, Ergebnisse.

| Datei | Plan | Besonderheit |
|---|---|---|
| `katalog.jsonl` | `plan-katalog.json` | alle neun K1a-Fälle |
| `gemischt.jsonl` | `plan-gemischt.json` | zusätzlich eine fehlende Datei im Arbeitsordner (fehler) |
| `max-runden.jsonl` | `plan-gemischt.json` | `--max-turns 2`, Abbruch mit `error_max_turns` |
| `max-budget.jsonl` | `plan-gemischt.json` | Attrappe meldet hohen Verbrauch, Abbruch mit `error_max_budget_usd`, ein Aufruf ohne Ergebnis |
| `api-401.jsonl` | keiner | Attrappe antwortet 401, `api_retry`-Ereignisse, `terminal_reason` `api_error` |

Was die Mitschnitte nicht zeigen: wie sich ein echtes Modell verhält. Es könnte Pfade abwandeln oder
Aufrufe unterlassen. Und ob eine andere Claude-Code-Version dasselbe Format schreibt.
