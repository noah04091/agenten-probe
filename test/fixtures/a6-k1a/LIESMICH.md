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
| `gegenprobe-n2.jsonl` | `generalprobe/k1-plan.json` | K1-B vom 19.11.2026: wortgleicher Schritt „K1-Nachweis“ der Generalprobe in der lokalen Emulation, Einstellungen mit genau einer zusätzlichen Regel `Read(//opt/a6/settings.json)` in `allow`; N2 gelingt |

Was die Mitschnitte nicht zeigen: wie sich ein echtes Modell verhält. Es könnte Pfade abwandeln oder
Aufrufe unterlassen. Und ob eine andere Claude-Code-Version dasselbe Format schreibt.

## Live-2-Nachbau mit js-text (`live2/`, 19.11.2026)

Gleiches Verfahren, aber mit den Einstellungen für `js-text`, wie `a6_einstellungen` sie erzeugt (allow nur
`Read`/`Edit` von `./src/text.js` und `./test/text.test.js`), `--max-budget-usd 1`, Arbeitsordner mit genau
`src/text.js` und `test/text.test.js` von main `42654a4`. Anlass: Live 2 (Lauf 44620884909) endete mit
`meta-fehlt`. Die Pläne stehen in `live2/plaene.json` (ein `tool_use` je Runde).

| Datei | Plan | `--max-turns` | Besonderheit |
|---|---|---|---|
| `d-kontrolle.jsonl` | D | 8 | 2 Read, 2 Edit, alles erfolgreich |
| `a-edit-fehler.jsonl` | A | 8 | wie D, ein Edit mit nicht vorhandenem `old_string` |
| `b-max-runden.jsonl` | B | 8 | wie D, Plan länger als 8 Runden, Abbruch `error_max_turns` |
| `c-edit-fehler-max-runden.jsonl` | C | 8 | B mit zwei fehlerhaften Edits, wie im Live-Lauf |
| `g-gegenproben.jsonl` | G | 20 | Edit-Eingabefehler (fehlt, mehrdeutig, keine Änderung), Regelablehnungen, Edits außerhalb auf fehlende oder ungelesene Dateien |
| `m-modus.jsonl` | M | 20 | Modusablehnungen (Edit neu anlegen außerhalb, Read `/opt/a6/settings.json`), Read fehlende Datei, Edit-Eingabefehler, Bash |

Befund: Ein Edit, der an der Eingabeprüfung scheitert, hat ein Fehlerergebnis, aber kein
`tool_result_meta`, keinen Eintrag in `permission_denials` und kein `system/permission_denied`. Die
Eingabeprüfung läuft nach den Ablehnungsregeln und vor der Modusprüfung.
