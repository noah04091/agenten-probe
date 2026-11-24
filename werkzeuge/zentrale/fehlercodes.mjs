// B1.1 Command Center: bekannte Fehlercodes der Agenten-Pipeline.
//
// FEHLERCODES: Codes mit Klartext. Quelle: docs/agent-auftrag-betrieb.md, Abschnitt 4.
// BEKANNTE_CODES (B1.1a): weitere Codes nur mit Namen, ohne Klartext. Es sind die woertlichen Codes aus
// fail('<code>', ...) und jobFail('<code>') in scripts/agent-code-auftrag*.mjs, scripts/agent-code-job-*.mjs und
// scripts/agent-profile.mjs, dazu der Sammelcode job-unbekannt (scripts/agent-code-job-gemeinsam.mjs). Zusammengesetzte
// Codes (etwa integritaet-<code>) stehen nicht darin und bleiben "unbekannter Code".
// Jeder Code beider Listen steht woertlich in ausfuehrbarem Code (nicht nur im Kommentar) unter scripts/ oder
// .github/agent/ (geprueft in test/zentrale-wachen.test.mjs, W11). Ein Code, der in keiner Liste steht, wird als
// "unbekannter Code" angezeigt, nie mit seinem Namen.
// Die Listen authentifizieren keine Logzeile: Sie sagen nur, dass es den Namen in der Pipeline gibt.

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
  'auftrag-issue-geschlossen': 'Abgebrochen: das Issue ist geschlossen.',
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

export const BEKANNTE_CODES = Object.freeze([
  'abnahme-bindung', 'abnahme-code-blob', 'abnahme-code-datei', 'abnahme-code-modus', 'abnahme-datei',
  'abnahme-datei-blob', 'abnahme-datei-hash', 'abnahme-eingabe', 'abnahme-format', 'abnahme-fremde-aenderung',
  'abnahme-git-baum', 'abnahme-git-config', 'abnahme-git-head', 'abnahme-git-index', 'abnahme-git-status',
  'abnahme-git-struktur', 'abnahme-git-umgebung', 'abnahme-prozess-fehler', 'abnahme-pruefordner',
  'abnahme-pruefordner-benutzt', 'abnahme-quelle-head', 'abnahme-signal', 'abnahme-sitzung', 'abnahme-stderr',
  'abnahme-ungeprueft', 'auftrag-abnahme-inhalt', 'auftrag-abweichung', 'auftrag-basis',
  'auftrag-basis-kein-commit', 'auftrag-eingabe', 'auftrag-ereignis-doppelt', 'auftrag-ereignis-format',
  'auftrag-ereignis-id', 'auftrag-ereignis-label', 'auftrag-ereignis-reihenfolge', 'auftrag-ereignis-typ',
  'auftrag-ereignis-zeit', 'auftrag-ereignis-zukunft', 'auftrag-ereignisse-umfang', 'auftrag-freigabe-fehlt',
  'auftrag-freigabe-mehrdeutig', 'auftrag-git-umgebung', 'auftrag-git-wurzel', 'auftrag-groesse',
  'auftrag-hash-format', 'auftrag-issue-abweichung', 'auftrag-issue-autor', 'auftrag-issue-format',
  'auftrag-issue-nummer', 'auftrag-issue-veraltet', 'auftrag-issue-zeit',
  'auftrag-label-profil-mehrdeutig', 'auftrag-label-profil-ungueltig', 'auftrag-label-reserviert',
  'auftrag-labels-doppelt', 'auftrag-labels-format', 'auftrag-labels-fremd', 'auftrag-lauf-format',
  'auftrag-lauf-id', 'auftrag-lauf-ueberholt', 'auftrag-lauf-zeit', 'auftrag-lauf-zukunft',
  'auftrag-objekt-baum', 'auftrag-objekt-commit', 'auftrag-policy-ungeprueft', 'auftrag-profil-label-fremd',
  'auftrag-profil-label-herkunft', 'auftrag-repository', 'auftrag-start-art', 'auftrag-start-issue',
  'auftrag-start-repository', 'auftrag-start-sender', 'auftrag-start-zeit', 'auftrag-start-zuordnung',
  'auftrag-titel-fremd', 'auftrag-ungeprueft', 'auftrag-wurzel', 'auftrag-zeit', 'baum-doppelt', 'baum-eingabe',
  'baum-fehlt', 'baum-format', 'baum-git', 'baum-konflikt', 'baum-modus', 'baum-sha', 'baum-umgebung',
  'einstellungen-allow', 'einstellungen-deny', 'einstellungen-felder', 'einstellungen-profil',
  'geheimnis-eingabe', 'geheimnis-wert-kurz', 'geheimnis-werte-leer', 'job-auftrag-bindung', 'job-ausgabe-datei',
  'job-ausgabe-format', 'job-ausgabe-pfad', 'job-basis', 'job-checkout', 'job-checkout-head',
  'job-datei-schreiben', 'job-ereignis-art', 'job-ereignis-datei', 'job-ereignis-issue', 'job-ereignis-pfad',
  'job-geheimnis-muster', 'job-geheimnis-wert', 'job-hash-format', 'job-lauf-id', 'job-nachweis-bindung',
  'job-ordner', 'job-paket-bindung', 'job-paket-bytes', 'job-paket-hash', 'job-paket-rueckgelesen',
  'job-repository', 'job-rundweg', 'job-schnappschuss-format', 'job-schnappschuss-hash',
  'job-schnappschuss-lauf', 'job-schnappschuss-rueckgelesen', 'job-schnappschuss-utf8', 'job-umgebung',
  'job-umgebung-fehlt', 'job-umgebung-geheimnis', 'job-umgebung-node', 'job-unbekannt', 'job-vergleich-wert',
  'job-workflow', 'json-bom', 'json-eingabe', 'json-grenze', 'json-groesse', 'json-kanonisch', 'json-leer',
  'json-objekt', 'json-syntax', 'json-tiefe', 'json-utf8', 'json-zeichen', 'json-zeilenende',
  'live-antwort-format', 'live-antwort-gross', 'live-antwort-json', 'live-eingabe', 'live-ereignis-doppelt',
  'live-ereignis-id', 'live-hash-format', 'live-header-doppelt', 'live-http-status', 'live-issue-abweichung',
  'live-issue-format', 'live-issue-nummer', 'live-lauf-akteur', 'live-lauf-branch', 'live-lauf-ereignis',
  'live-lauf-format', 'live-lauf-id', 'live-lauf-id-abweichung', 'live-lauf-repository', 'live-lauf-sha',
  'live-lauf-workflow', 'live-lauf-zuordnung', 'live-link-format', 'live-liste-format', 'live-main-format',
  'live-methode', 'live-pfad', 'live-pfad-lauf-id', 'live-pr-doppelt', 'live-pr-format', 'live-ref-format',
  'live-ref-link', 'live-repository', 'live-seite-widerspruch', 'live-seiten-grenze', 'live-transport',
  'live-transport-fehler', 'live-umleitung', 'live-zustand-ungeprueft', 'paket-base64', 'paket-basis-blob',
  'paket-baum-modus', 'paket-baum-pfad', 'paket-baum-umfang', 'paket-bindung', 'paket-bytes',
  'paket-datei-fehlt', 'paket-datei-groesse', 'paket-datei-leer', 'paket-datei-neu', 'paket-dateiliste',
  'paket-dateityp', 'paket-eingabe', 'paket-felder', 'paket-format', 'paket-fremde-aenderung', 'paket-geheimnis',
  'paket-git-blob', 'paket-git-ordner', 'paket-git-wurzel', 'paket-groesse', 'paket-hardlink', 'paket-hash',
  'paket-hash-format', 'paket-head', 'paket-index', 'paket-kopie', 'paket-lesen', 'paket-manipuliert',
  'paket-nachpruefung-art', 'paket-nachpruefung-gestaged', 'paket-nachpruefung-inhalt',
  'paket-nachpruefung-modus', 'paket-nachpruefung-summary', 'paket-nachpruefung-umfang', 'paket-nul',
  'paket-ordner-fehlt', 'paket-ordner-neu', 'paket-patch', 'paket-pfad', 'paket-quelle', 'paket-schema',
  'paket-schreiben', 'paket-sha256', 'paket-sonderdatei', 'paket-status', 'paket-symlink',
  'paket-ueberschneidung', 'paket-ungeprueft', 'paket-utf8', 'paket-zeilen', 'paket-ziel',
  'paket-ziel-nicht-leer', 'policy-budget', 'policy-felder', 'policy-grenze', 'policy-hashes',
  'policy-hashes-fehlen', 'policy-modelle', 'policy-praefixe', 'policy-reserviert', 'policy-schema',
  'policy-sperrliste', 'policy-werkzeuge', 'profil-abnahme', 'profil-aktiv', 'profil-budget', 'profil-dateiname',
  'profil-dateizahl', 'profil-doppelt', 'profil-felder', 'profil-gesperrt', 'profil-id', 'profil-id-reserviert',
  'profil-laufzeit', 'profil-modell', 'profil-ohne-src', 'profil-pfad', 'profil-pfad-typ', 'profil-praefix',
  'profil-rahmen', 'profil-rahmen-zeichen', 'profil-runden', 'profil-schema', 'prompt-eingabe',
  'prompt-issue-abweichung', 'prompt-nonce-kollision', 'prompt-profil-bytes', 'prompt-profil-hash',
  'prompt-profil-id', 'publish-abgeschlossen', 'publish-antwort-format', 'publish-antwort-gross',
  'publish-antwort-json', 'publish-antwort-unvollstaendig', 'publish-auftrag-zuordnung', 'publish-basis-baum',
  'publish-baum-abweichung', 'publish-baum-datei', 'publish-baum-unvollstaendig', 'publish-blob-abweichung',
  'publish-blob-lokal', 'publish-branch-antwort', 'publish-branch-name', 'publish-commit-abweichung',
  'publish-compare-blob', 'publish-compare-commits', 'publish-compare-dateien', 'publish-compare-status',
  'publish-dateiliste', 'publish-eingabe', 'publish-freigabe-zeit', 'publish-http-status', 'publish-methode',
  'publish-pfad', 'publish-pfad-eingabe', 'publish-pr-antwort', 'publish-pruef-checkout-verbraucht',
  'publish-ref-abweichung', 'publish-ref-format', 'publish-root-veraendert', 'publish-schreiben-gesperrt',
  'publish-transport-fehler', 'publish-uhr', 'publish-uhr-rueckwaerts', 'publish-umleitung',
  'publish-unveraendert-branches', 'publish-unveraendert-ereignisse', 'publish-unveraendert-issue',
  'publish-unveraendert-lauf', 'publish-unveraendert-main', 'publish-unveraendert-pr',
  'publish-unveraendert-zuordnung', 'publish-verzeichnis-geaendert', 'publish-verzeichnis-ueberschneidung',
  'publish-zeitklammer', 'transport-abgeschlossen', 'transport-anfrage', 'transport-anfrage-gross',
  'transport-anfrage-json', 'transport-antwort-format', 'transport-antwort-gross', 'transport-branch',
  'transport-endpunkt', 'transport-header-mehrdeutig', 'transport-issue-nummer', 'transport-komprimiert',
  'transport-laenge', 'transport-lauf-id', 'transport-methode', 'transport-parallel', 'transport-pfad',
  'transport-tls', 'transport-token', 'transport-url'
]);

// Klartext zu einem Code oder null, wenn der Code keinen Klartext hat.
export function klartext(code) {
  return typeof code === 'string' && Object.hasOwn(FEHLERCODES, code) ? FEHLERCODES[code] : null;
}

// true nur fuer einen Code aus BEKANNTE_CODES (Name bekannt, kein Klartext hinterlegt).
export function nurName(code) {
  return typeof code === 'string' && !Object.hasOwn(FEHLERCODES, code) && BEKANNTE_CODES.includes(code);
}
