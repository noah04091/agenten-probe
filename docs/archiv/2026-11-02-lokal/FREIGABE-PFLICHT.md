# Freigabe-Pflicht im Test-Repo agenten-probe (Vorschlag, nicht angewendet)

## Änderung 1: Schutzregel main (Datei schutz-mit-freigabe.json)
Gegenüber heute kommt NUR der Review-Teil dazu; alles andere ist identisch mit der aktiven Regel
(Pflichtprüfungen build + tests, Stand aktuell, gilt für Admins, kein Force-Push, kein Löschen, Diskussionen erledigt).
- required_approving_review_count: 1
- dismiss_stale_reviews: true
- require_last_push_approval: true
- require_code_owner_reviews: false

Anwenden (Claude, erst nach Freigabe):
  gh api -X PUT repos/noah04091/agenten-probe/branches/main/protection --input schutz-mit-freigabe.json
Zurücklesen und vergleichen über die GESAMTE Regel (nicht über den Unterendpunkt, siehe Hinweis unten).

## Änderung 2 (optional): nur Squash-Merge erlauben
  gh api -X PATCH repos/noah04091/agenten-probe -F allow_merge_commit=false -F allow_rebase_merge=false -F allow_squash_merge=true

## Rückweg
- Nur den Review-Teil entfernen (Admin-Recht, Noah hat admin=true):
  gh api -X DELETE repos/noah04091/agenten-probe/branches/main/protection/required_pull_request_reviews
- Oder im Browser: Settings -> Branches -> Regel für main -> "Require a pull request before merging" aus.
- "Gilt auch für Admins" sperrt Pushes und Merges, nicht die Einstellungen: als Inhaber bleibt die Regel jederzeit änderbar.

## Prüfung gegen Aussperren
| Fall | Folge mit neuer Regel | Ausweg |
|---|---|---|
| Bot-PR, Noah gibt frei | Merge möglich | normaler Weg |
| Noahs eigener PR (z. B. Workflow) | braucht Freigabe von jemand anderem, im Test nur der Bot | Bot gibt frei, NUR auf Noahs ausdrückliche Anweisung (Weg a) |
| Noah klickt "Update branch" an einem Bot-PR | Noah wird zum letzten Pusher; seine eigene Freigabe zählt dann für diesen Push NICHT mehr ("letzter Push von jemand anderem"). Nur der Bot könnte noch freigeben | Regel: Den Zweig aktualisiert immer der Agent (er holt main und pusht), nie Noah per Knopf. Wird als Testfall T19 geprüft |
| offener PR #3 (von Noah) | braucht danach eine Freigabe von jemand anderem | Bot gibt auf Anweisung frei oder Noah schließt #3 |
| Regel versehentlich zu streng | PRs hängen | Rückweg oben, wirkt sofort |

## Hinweis zur Messung
Der Unterendpunkt .../protection/required_pull_request_reviews liefert schon HEUTE eine Antwort mit "1 Freigabe",
obwohl die Gesamtregel "keine Review-Pflicht" meldet und PR #2 und #4 ohne Freigabe gemergt wurden.
Maßgeblich sind deshalb die Gesamtregel und das tatsächliche Verhalten im Test, nicht dieser Unterendpunkt.

## Abgrenzung Test-Repo und Contract AI
- Im Test darf der Bot Noahs EIGENE PRs auf ausdrückliche Anweisung freigeben (Weg a). Für Contract AI ist das NICHT beschlossen.
- Bot-PRs kann der Bot nie selbst freigeben (Autor). Solange ALLE Agenten dieselbe Bot-Identität nutzen, kann also kein Agent
  die Arbeit eines anderen Agenten freigeben. Regel für Contract AI: genau EINE Agenten-Identität, keine zweite.
- Die fachliche Endfreigabe liegt bei Noah. Für Contract AI ist offen, wie Noahs eigene PRs (Workflows) freigegeben werden,
  ohne dass der Bot Freigabeinstanz wird. Kandidaten: Code Owner = Noah plus kurzzeitiges, protokolliertes Abschalten des
  Admin-Schutzes für genau diesen PR; oder eine Organisation mit Ausnahmeliste "nur per PR". Entscheidung vor Contract AI.

## Merge und Deployment getrennt
Im Test-Repo gibt es kein Deployment. Für Contract AI gilt heute: Render deployt das Backend bei jedem Commit auf main
automatisch ("Auto-Deploy: On Commit"), Vercel nach der Git-Anbindung ebenso. Ein Merge wäre dort also sofort live.
Um Merge (fachliche Freigabe) und Live-Gang (zweite Freigabe) zu trennen, braucht es vor Contract AI:
- Vercel: automatische Zuweisung der Produktions-Domain aus, Live-Gang per "Promote" durch Noah
- Render: Auto-Deploy aus, Deploy manuell durch Noah
Board: "Gemergt, noch nicht live" und "Live" bilden genau diese zwei Freigaben ab.
