// B1.1 Command Center: bekannte Fehlercodes der Agenten-Pipeline mit Klartext.
// Quelle: docs/agent-auftrag-betrieb.md, Abschnitt 4. Jeder Code steht woertlich in scripts/ oder .github/agent/
// (geprueft in test/zentrale-wachen.test.mjs, W11). Ein Code, der hier fehlt, wird als "unbekannter Code" angezeigt,
// nie mit seinem Text.

export const FEHLERCODES = Object.freeze({
  'auftrag-label-profil-fehlt': 'Auftrag nicht angenommen: kein Profil-Label am Issue.',
  'auftrag-profil-inaktiv': 'Auftrag nicht angenommen: das Profil ist nicht aktiv.',
  'auftrag-freigabe-fremd': 'Auftrag nicht angenommen: das Startlabel kam nicht von Noah.',
  'auftrag-freigaben-grenze': 'Auftrag nicht angenommen: mehr als drei Startfreigaben für dieses Issue.',
  'auftrag-issue-pr': 'Auftrag nicht angenommen: das Issue ist ein Pull Request.',
  'auftrag-abnahme': 'Auftrag nicht angenommen: die Abnahme-Datei fehlt oder ist ungültig.',
  'auftrag-label-start-fehlt': 'Claude nicht gestartet: das Startlabel wurde entfernt.',
  'auftrag-freigabe-entzogen': 'Claude nicht gestartet: die Startfreigabe wurde entzogen.',
  'auftrag-freigabe-abgelaufen': 'Abgebrochen: mehr als 60 Minuten seit dem Startlabel.',
  'auftrag-issue-geaendert': 'Abgebrochen: das Issue wurde nach dem Startlabel geändert.',
  'auftrag-profil-label-geaendert': 'Abgebrochen: das Profil-Label wurde geändert.',
  'auftrag-lauf-versuch': 'Abgebrochen: nur Laufversuch 1 ist erlaubt (Re-run).',
  'live-main-geaendert': 'Abgebrochen: main hat sich seit dem Start geändert.',
  'live-branch-vorhanden': 'Abgebrochen: der Zielbranch existiert schon.',
  'live-pr-vorhanden': 'Abgebrochen: es gibt schon einen PR für diesen Lauf.',
  'job-live-bindung': 'Abgebrochen: der Auftrag passt nicht mehr zum Stand aus Job 0.',
  'job-lauf-versuch': 'Abgebrochen: nur Laufversuch 1 ist erlaubt (Re-run).',
  'paket-unveraendert': 'Kein Paket: mindestens eine Profildatei wurde nicht geändert.',
  'abnahme-exitcode': 'Abnahme nicht bestanden.',
  'abnahme-ausgabe': 'Abnahme mit unerwarteter Ausgabe.',
  'publish-freigabe-reserve': 'Job 3: weniger als 2 Minuten Restfrist vor dem Anlegen des Branches.',
  'publish-freigabe-abgelaufen': 'Job 3: Freigabe nach Ablauf der 60 Minuten.',
});

// Klartext zu einem Code oder null, wenn der Code nicht bekannt ist.
export function klartext(code) {
  return typeof code === 'string' && Object.hasOwn(FEHLERCODES, code) ? FEHLERCODES[code] : null;
}
