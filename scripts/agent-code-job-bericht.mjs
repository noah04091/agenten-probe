// B1.2: Berichtsskript fuer die Job-Zusammenfassung von agent-auftrag.yml.
//
// Aufruf nur ueber a6_bericht (.github/agent/a6-funktionen.sh) im festen Image, ohne Netz, ohne Secrets:
//   node scripts/agent-code-job-bericht.mjs
// ohne Argumente. Eingaben, und nur diese:
//   - Umgebung A6_BERICHT_JOB (feste Jobnamen) und A6_JOB_STATUS (job.status);
//   - /a6/bericht/status, /a6/bericht/fehler und /a6/bericht/claude (je hoechstens 1 KB, gewoehnliche
//     Datei, kein Link) sowie die Namen in /a6/bericht (liegengebliebene lauf.*-Ordner eines
//     abgebrochenen Aufrufs, nur der Name zaehlt).
// Ausgabe: Anhaengen an /a6/zusammenfassung, sonst nichts.
//
// Der Bericht besteht nur aus festen Texten dieses Skripts, Codes aus den festen Listen unten und selbst
// formatierten Zahlen. Kein Rohtext aus Eingaben erreicht die Ausgabe. Geheimnis-Filter: ein Treffer in
// einer Eingabe oder im fertigen Text verwirft die ganze Zusammenfassung.
// Exitcode 0 nur, wenn die Zusammenfassung geschrieben wurde; sonst 1 ohne Ausgabe (die Warnung setzt
// a6_bericht). Kein Netz, kein Kindprozess, kein Import ausser node:fs.

import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, writeSync, constants } from 'node:fs';

export const BERICHT_ORDNER = '/a6/bericht';
export const ZIEL = '/a6/zusammenfassung';
export const GRENZE_BYTES = 1024;

// Deckungsgleich mit werkzeuge/zentrale/fehlercodes.mjs (FEHLERCODES und BEKANNTE_CODES, Test T17).
// Kein Import aus werkzeuge/: das Berichtsskript steht unter dem Integritaetspruefer, werkzeuge/ nicht.
// Die Codes stehen in doppelten Anfuehrungszeichen: W11 (test/zentrale-wachen.test.mjs) zaehlt nur die Form
// 'code' und soll weiter nur Code finden, der die Fehlerzeile erzeugt. Geprueft im Berichtstest.
export const FEHLERCODES = Object.freeze({
  "auftrag-label-profil-fehlt": 'Auftrag nicht angenommen: kein Profil-Label am Issue.',
  "auftrag-profil-inaktiv": 'Auftrag nicht angenommen: das Profil ist nicht aktiv.',
  "auftrag-freigabe-fremd": 'Auftrag nicht angenommen: das Startlabel kam nicht von Noah.',
  "auftrag-freigaben-grenze": 'Auftrag nicht angenommen: mehr als drei Startfreigaben für dieses Issue.',
  "auftrag-issue-pr": 'Auftrag nicht angenommen: das Issue ist ein Pull Request.',
  "auftrag-abnahme": 'Auftrag nicht angenommen: die Abnahme-Datei fehlt oder ist ungültig.',
  "auftrag-label-start-fehlt": 'Claude nicht gestartet: das Startlabel wurde entfernt.',
  "auftrag-freigabe-entzogen": 'Claude nicht gestartet: die Startfreigabe wurde entzogen.',
  "auftrag-freigabe-abgelaufen": 'Abgebrochen: mehr als 60 Minuten seit dem Startlabel.',
  "auftrag-issue-geaendert": 'Abgebrochen: das Issue wurde nach dem Startlabel geändert.',
  "auftrag-profil-label-geaendert": 'Abgebrochen: das Profil-Label wurde geändert.',
  "auftrag-lauf-versuch": 'Abgebrochen: nur Laufversuch 1 ist erlaubt (Re-run).',
  "live-main-geaendert": 'Abgebrochen: main hat sich seit dem Start geändert.',
  "live-branch-vorhanden": 'Abgebrochen: der Zielbranch existiert schon.',
  "live-pr-vorhanden": 'Abgebrochen: es gibt schon einen PR für diesen Lauf.',
  "job-live-bindung": 'Abgebrochen: der Auftrag passt nicht mehr zum Stand aus Job 0.',
  "job-lauf-versuch": 'Abgebrochen: nur Laufversuch 1 ist erlaubt (Re-run).',
  "paket-unveraendert": 'Kein Paket: mindestens eine Profildatei wurde nicht geändert.',
  "abnahme-exitcode": 'Abnahme nicht bestanden.',
  "abnahme-ausgabe": 'Abnahme mit unerwarteter Ausgabe.',
  "publish-freigabe-reserve": 'Job 3: weniger als 2 Minuten Restfrist vor dem Anlegen des Branches.',
  "publish-freigabe-abgelaufen": 'Job 3: Freigabe nach Ablauf der 60 Minuten.',
});

export const BEKANNTE_CODES = Object.freeze([
  "abnahme-bindung", "abnahme-code-blob", "abnahme-code-datei", "abnahme-code-modus", "abnahme-datei",
  "abnahme-datei-blob", "abnahme-datei-hash", "abnahme-eingabe", "abnahme-format", "abnahme-fremde-aenderung",
  "abnahme-git-baum", "abnahme-git-config", "abnahme-git-head", "abnahme-git-index", "abnahme-git-status",
  "abnahme-git-struktur", "abnahme-git-umgebung", "abnahme-prozess-fehler", "abnahme-pruefordner",
  "abnahme-pruefordner-benutzt", "abnahme-quelle-head", "abnahme-signal", "abnahme-sitzung", "abnahme-stderr",
  "abnahme-ungeprueft", "auftrag-abnahme-inhalt", "auftrag-abweichung", "auftrag-basis",
  "auftrag-basis-kein-commit", "auftrag-eingabe", "auftrag-ereignis-doppelt", "auftrag-ereignis-format",
  "auftrag-ereignis-id", "auftrag-ereignis-label", "auftrag-ereignis-reihenfolge", "auftrag-ereignis-typ",
  "auftrag-ereignis-zeit", "auftrag-ereignis-zukunft", "auftrag-ereignisse-umfang", "auftrag-freigabe-fehlt",
  "auftrag-freigabe-mehrdeutig", "auftrag-git-umgebung", "auftrag-git-wurzel", "auftrag-groesse",
  "auftrag-hash-format", "auftrag-issue-abweichung", "auftrag-issue-autor", "auftrag-issue-format",
  "auftrag-issue-geschlossen", "auftrag-issue-nummer", "auftrag-issue-veraltet", "auftrag-issue-zeit",
  "auftrag-label-profil-mehrdeutig", "auftrag-label-profil-ungueltig", "auftrag-label-reserviert",
  "auftrag-labels-doppelt", "auftrag-labels-format", "auftrag-labels-fremd", "auftrag-lauf-format",
  "auftrag-lauf-id", "auftrag-lauf-ueberholt", "auftrag-lauf-zeit", "auftrag-lauf-zukunft",
  "auftrag-objekt-baum", "auftrag-objekt-commit", "auftrag-policy-ungeprueft", "auftrag-profil-label-fremd",
  "auftrag-profil-label-herkunft", "auftrag-repository", "auftrag-start-art", "auftrag-start-issue",
  "auftrag-start-repository", "auftrag-start-sender", "auftrag-start-zeit", "auftrag-start-zuordnung",
  "auftrag-titel-fremd", "auftrag-ungeprueft", "auftrag-wurzel", "auftrag-zeit", "baum-doppelt", "baum-eingabe",
  "baum-fehlt", "baum-format", "baum-git", "baum-konflikt", "baum-modus", "baum-sha", "baum-umgebung",
  "einstellungen-allow", "einstellungen-deny", "einstellungen-felder", "einstellungen-profil",
  "geheimnis-eingabe", "geheimnis-wert-kurz", "geheimnis-werte-leer", "job-auftrag-bindung", "job-ausgabe-datei",
  "job-ausgabe-format", "job-ausgabe-pfad", "job-basis", "job-checkout", "job-checkout-head",
  "job-datei-schreiben", "job-ereignis-art", "job-ereignis-datei", "job-ereignis-issue", "job-ereignis-pfad",
  "job-geheimnis-muster", "job-geheimnis-wert", "job-hash-format", "job-lauf-id", "job-nachweis-bindung",
  "job-ordner", "job-paket-bindung", "job-paket-bytes", "job-paket-hash", "job-paket-rueckgelesen",
  "job-repository", "job-rundweg", "job-schnappschuss-format", "job-schnappschuss-hash",
  "job-schnappschuss-lauf", "job-schnappschuss-rueckgelesen", "job-schnappschuss-utf8", "job-umgebung",
  "job-umgebung-fehlt", "job-umgebung-geheimnis", "job-umgebung-node", "job-unbekannt", "job-vergleich-wert",
  "job-workflow", "json-bom", "json-eingabe", "json-grenze", "json-groesse", "json-kanonisch", "json-leer",
  "json-objekt", "json-syntax", "json-tiefe", "json-utf8", "json-zeichen", "json-zeilenende",
  "live-antwort-format", "live-antwort-gross", "live-antwort-json", "live-eingabe", "live-ereignis-doppelt",
  "live-ereignis-id", "live-hash-format", "live-header-doppelt", "live-http-status", "live-issue-abweichung",
  "live-issue-format", "live-issue-nummer", "live-lauf-akteur", "live-lauf-branch", "live-lauf-ereignis",
  "live-lauf-format", "live-lauf-id", "live-lauf-id-abweichung", "live-lauf-repository", "live-lauf-sha",
  "live-lauf-workflow", "live-lauf-zuordnung", "live-link-format", "live-liste-format", "live-main-format",
  "live-methode", "live-pfad", "live-pfad-lauf-id", "live-pr-doppelt", "live-pr-format", "live-ref-format",
  "live-ref-link", "live-repository", "live-seite-widerspruch", "live-seiten-grenze", "live-transport",
  "live-transport-fehler", "live-umleitung", "live-zustand-ungeprueft", "paket-base64", "paket-basis-blob",
  "paket-baum-modus", "paket-baum-pfad", "paket-baum-umfang", "paket-bindung", "paket-bytes",
  "paket-datei-fehlt", "paket-datei-groesse", "paket-datei-leer", "paket-datei-neu", "paket-dateiliste",
  "paket-dateityp", "paket-eingabe", "paket-felder", "paket-format", "paket-fremde-aenderung", "paket-geheimnis",
  "paket-git-blob", "paket-git-ordner", "paket-git-wurzel", "paket-groesse", "paket-hardlink", "paket-hash",
  "paket-hash-format", "paket-head", "paket-index", "paket-kopie", "paket-lesen", "paket-manipuliert",
  "paket-nachpruefung-art", "paket-nachpruefung-gestaged", "paket-nachpruefung-inhalt",
  "paket-nachpruefung-modus", "paket-nachpruefung-summary", "paket-nachpruefung-umfang", "paket-nul",
  "paket-ordner-fehlt", "paket-ordner-neu", "paket-patch", "paket-pfad", "paket-quelle", "paket-schema",
  "paket-schreiben", "paket-sha256", "paket-sonderdatei", "paket-status", "paket-symlink",
  "paket-ueberschneidung", "paket-ungeprueft", "paket-utf8", "paket-zeilen", "paket-ziel",
  "paket-ziel-nicht-leer", "policy-budget", "policy-felder", "policy-grenze", "policy-hashes",
  "policy-hashes-fehlen", "policy-modelle", "policy-praefixe", "policy-reserviert", "policy-schema",
  "policy-sperrliste", "policy-werkzeuge", "profil-abnahme", "profil-aktiv", "profil-budget", "profil-dateiname",
  "profil-dateizahl", "profil-doppelt", "profil-felder", "profil-gesperrt", "profil-id", "profil-id-reserviert",
  "profil-laufzeit", "profil-modell", "profil-ohne-src", "profil-pfad", "profil-pfad-typ", "profil-praefix",
  "profil-rahmen", "profil-rahmen-zeichen", "profil-runden", "profil-schema", "prompt-eingabe",
  "prompt-issue-abweichung", "prompt-nonce-kollision", "prompt-profil-bytes", "prompt-profil-hash",
  "prompt-profil-id", "publish-abgeschlossen", "publish-antwort-format", "publish-antwort-gross",
  "publish-antwort-json", "publish-antwort-unvollstaendig", "publish-auftrag-zuordnung", "publish-basis-baum",
  "publish-baum-abweichung", "publish-baum-datei", "publish-baum-unvollstaendig", "publish-blob-abweichung",
  "publish-blob-lokal", "publish-branch-antwort", "publish-branch-name", "publish-commit-abweichung",
  "publish-compare-blob", "publish-compare-commits", "publish-compare-dateien", "publish-compare-status",
  "publish-dateiliste", "publish-eingabe", "publish-freigabe-zeit", "publish-http-status", "publish-methode",
  "publish-pfad", "publish-pfad-eingabe", "publish-pr-antwort", "publish-pruef-checkout-verbraucht",
  "publish-ref-abweichung", "publish-ref-format", "publish-root-veraendert", "publish-schreiben-gesperrt",
  "publish-transport-fehler", "publish-uhr", "publish-uhr-rueckwaerts", "publish-umleitung",
  "publish-unveraendert-branches", "publish-unveraendert-ereignisse", "publish-unveraendert-issue",
  "publish-unveraendert-lauf", "publish-unveraendert-main", "publish-unveraendert-pr",
  "publish-unveraendert-zuordnung", "publish-verzeichnis-geaendert", "publish-verzeichnis-ueberschneidung",
  "publish-zeitklammer", "transport-abgeschlossen", "transport-anfrage", "transport-anfrage-gross",
  "transport-anfrage-json", "transport-antwort-format", "transport-antwort-gross", "transport-branch",
  "transport-endpunkt", "transport-header-mehrdeutig", "transport-issue-nummer", "transport-komprimiert",
  "transport-laenge", "transport-lauf-id", "transport-methode", "transport-parallel", "transport-pfad",
  "transport-tls", "transport-token", "transport-url",
]);

// Jobnamen und ihre Ueberschrift. Die Sammeltabelle schreibt a6_bericht_sammel ohne dieses Skript.
export const JOBS = Object.freeze({
  auftrag: 'Job 0 Auftrag festlegen',
  claude: 'Job 1 Claude im Container',
  abnahme: 'Job 2 Abnahme ohne Netz',
  veroeffentlichen: 'Job 3 Draft-PR veröffentlichen',
  probe_auftrag: 'Generalprobe Job 0',
  probe_claude: 'Generalprobe Job 1 mit Ersatz statt Claude',
  probe_abnahme: 'Generalprobe Job 2',
  probe_veroeffentlichen: 'Generalprobe Job 3 gegen nachgebautes GitHub',
});

export const GEHEIM_MUSTER = Object.freeze(['github_pat_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'sk-ant', '-----BEGIN', '/home/runner/']);

const FEHLER_ZEILE = /^A6-FEHLER ([a-z0-9-]{1,60})$/;
const RUNDEN = /^[0-9]{1,3}$/;
const ZAHL = /^[0-9]{1,4}(?:\.[0-9]{1,30})?(?:[eE][-+]?[0-9]{1,3})?$/;

// Zeilen einer Eingabe ohne leeres Ende; null bleibt null.
function zeilen(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const teile = text.split('\n');

  if (teile.at(-1) === '') {
    teile.pop();
  }

  return teile;
}

// Erfassung aus Statusdatei, Fehlerdatei und liegengebliebenen Ordnern: erfasst, unvollstaendig oder
// nicht-erfasst. Erfasst nur, wenn jede Statuszeile genau "erfasst" ist und nichts liegengeblieben ist.
// Eine vorhandene, aber unlesbare Fehlerdatei (false) gilt als unvollstaendig.
export function erfassung({ status, fehler, rest }) {
  const liste = zeilen(status);

  if (liste === null || liste.length === 0) {
    return rest === true || fehler === false || typeof fehler === 'string' ? 'unvollstaendig' : 'nicht-erfasst';
  }

  if (rest === true || fehler === false || !liste.every(z => z === 'erfasst')) {
    return 'unvollstaendig';
  }

  return 'erfasst';
}

// Eintraege der Fehlerdatei: je Zeile der Code oder null (Zeile passt nicht zum Muster).
export function fehlerEintraege(fehler) {
  const liste = zeilen(fehler) ?? [];
  return liste.map(z => {
    const m = FEHLER_ZEILE.exec(z);
    return m ? m[1] : null;
  });
}

// Runden und Kosten aus der Datei claude: "<runden> <kosten>". Sonst null.
export function rundenKosten(text) {
  const liste = zeilen(text);

  if (liste === null || liste.length !== 1) {
    return null;
  }

  const teile = liste[0].split(' ');

  if (teile.length !== 2 || !RUNDEN.test(teile[0]) || !ZAHL.test(teile[1])) {
    return null;
  }

  const runden = Number(teile[0]);
  const kosten = Number(teile[1]);

  if (!Number.isInteger(runden) || runden < 0 || runden > 999 || !Number.isFinite(kosten) || kosten < 0 || kosten > 1000) {
    return null;
  }

  return { runden, kosten };
}

// Kosten ohne Exponentialschreibweise, hoechstens sechs Nachkommastellen, ohne Rohtext.
function kostenText(kosten) {
  if (kosten === 0) {
    return '0 $';
  }

  const gerundet = Math.round(kosten * 1e6) / 1e6;
  return `${gerundet === 0 ? 'unter 0.000001' : gerundet.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} $`;
}

function erfassungText(wert) {
  return { erfasst: 'erfasst', unvollstaendig: 'unvollständig', 'nicht-erfasst': 'nicht erfasst' }[wert];
}

// Ergebniszeile eines Jobs nach K4.
export function ergebnis({ job, status, eintraege, erfasst }) {
  if (status === 'success') {
    if (eintraege.length > 0) {
      return { text: 'erfolgreich, aber Fehlerzeile erfasst (Widerspruch, bitte Log prüfen)', code: null };
    }

    return { text: job === 'veroeffentlichen' ? 'erfolgreich: Draft-PR veröffentlicht' : 'erfolgreich', code: null };
  }

  if (status === 'cancelled') {
    return { text: 'abgebrochen', code: null };
  }

  if (status !== 'failure') {
    return { text: 'Status unbekannt', code: null };
  }

  if (erfasst !== 'erfasst') {
    return { text: 'fehlgeschlagen, Ursache unbekannt', code: null };
  }

  if (eintraege.length > 1) {
    return { text: 'fehlgeschlagen, Ursache mehrdeutig (mehrere Fehlerzeilen)', code: null };
  }

  if (eintraege.length === 0) {
    return { text: 'fehlgeschlagen, Ursache unbekannt', code: null };
  }

  const code = eintraege[0];

  if (code !== null && Object.hasOwn(FEHLERCODES, code)) {
    return { text: 'fehlgeschlagen', code, klartext: FEHLERCODES[code] };
  }

  if (code !== null && BEKANNTE_CODES.includes(code)) {
    return { text: 'fehlgeschlagen', code, klartext: 'Für diesen Code ist kein Klartext hinterlegt.' };
  }

  return { text: 'fehlgeschlagen, Ursache unbekannt (unbekannter Code)', code: null };
}

// Reine Funktion: fertiger Markdown-Text aus festen Bausteinen. Wirft nie; ein unbekannter Job ergibt null.
export function bericht({ job, status, fehler = null, statusDatei = null, rest = false, claude = null }) {
  if (typeof job !== 'string' || !Object.hasOwn(JOBS, job)) {
    return null;
  }

  const zeilenAus = [`### Bericht: ${JOBS[job]}`, ''];

  const erfasst = erfassung({ status: statusDatei, fehler, rest });
  const eintraege = typeof fehler === 'string' ? fehlerEintraege(fehler) : [];
  const e = ergebnis({ job, status, eintraege, erfasst });
  zeilenAus.push(`- Ergebnis: ${e.text}`);

  if (e.code) {
    zeilenAus.push(`- Fehlercode: \`${e.code}\``, `- Bedeutung: ${e.klartext}`);
  }

  zeilenAus.push(`- Fehlerdaten: ${erfassungText(erfasst)}`);

  if (job === 'claude') {
    const rk = rundenKosten(claude);
    zeilenAus.push(rk ? `- Runden: ${rk.runden}, Kosten: ${kostenText(rk.kosten)}` : '- Runden und Kosten unbekannt');
  }

  return `${zeilenAus.join('\n')}\n\n`;
}

// Geheimnis-Filter (Muster wie werkzeuge/zentrale/darstellung.mjs): Liste der Treffer, nie Werte.
export function geheimnisTreffer(...texte) {
  return GEHEIM_MUSTER.filter(m => texte.some(t => typeof t === 'string' && t.includes(m)));
}

// Liest eine Eingabe: null wenn sie fehlt, false wenn sie keine gewoehnliche Datei bis GRENZE_BYTES ist,
// sonst den Text. Nie ein Link, nie ein Ordner.
export function leseEingabe(pfad, fsImpl = { lstatSync, openSync, fstatSync, readSync, closeSync }) {
  let stat;

  try {
    stat = fsImpl.lstatSync(pfad);
  } catch (error) {
    return error?.code === 'ENOENT' ? null : false;
  }

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GRENZE_BYTES) {
    return false;
  }

  let fd;

  try {
    fd = fsImpl.openSync(pfad, constants.O_RDONLY | constants.O_NOFOLLOW);
    const offen = fsImpl.fstatSync(fd);

    if (!offen.isFile() || offen.size > GRENZE_BYTES) {
      return false;
    }

    const puffer = Buffer.alloc(GRENZE_BYTES + 1);
    let gelesen = 0;
    let n;

    while ((n = fsImpl.readSync(fd, puffer, gelesen, puffer.length - gelesen, null)) > 0) {
      gelesen += n;

      if (gelesen > GRENZE_BYTES) {
        return false;
      }
    }

    return puffer.subarray(0, gelesen).toString('utf8');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        // nichts
      }
    }
  }
}

// Liegengebliebene lauf.*-Ordner eines abgebrochenen Aufrufs (nur Namen).
function restVorhanden(ordner) {
  try {
    return readdirSync(ordner).some(name => name.startsWith('lauf.'));
  } catch {
    return false;
  }
}

// Haengt den Text an das Ziel an: nur eine vorhandene gewoehnliche Datei, kein Link. true bei Erfolg.
function anhaengen(ziel, text) {
  let fd;

  try {
    const vorher = lstatSync(ziel);

    if (!vorher.isFile() || vorher.isSymbolicLink()) {
      return false;
    }

    fd = openSync(ziel, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);

    if (!fstatSync(fd).isFile()) {
      return false;
    }

    const bytes = Buffer.from(text, 'utf8');
    let geschrieben = 0;

    while (geschrieben < bytes.length) {
      geschrieben += writeSync(fd, bytes, geschrieben, bytes.length - geschrieben);
    }

    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nichts
      }
    }
  }
}

// Liefert den Exitcode. Wirft nie. Ordner und Ziel sind nur fuer Tests veraenderbar.
export function main(env, { ordner = BERICHT_ORDNER, ziel = ZIEL } = {}) {
  try {
    const job = env.A6_BERICHT_JOB;
    const eingaben = {
      statusDatei: leseEingabe(`${ordner}/status`),
      fehler: leseEingabe(`${ordner}/fehler`),
      claude: job === 'claude' ? leseEingabe(`${ordner}/claude`) : null,
      rest: restVorhanden(ordner),
    };
    const text = bericht({ job, status: env.A6_JOB_STATUS, ...eingaben });

    if (text === null) {
      return 1;
    }

    const roh = [job, env.A6_JOB_STATUS, eingaben.statusDatei, eingaben.fehler, eingaben.claude];

    if (geheimnisTreffer(text, ...roh).length > 0) {
      return 1;
    }

    return anhaengen(ziel, text) ? 0 : 1;
  } catch {
    return 1;
  }
}

if (import.meta.main === true) {
  process.exitCode = main(process.env);
} else if (import.meta.main !== false) {
  process.exitCode = 1;
}
