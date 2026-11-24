// B2.1 Vorpruefung ohne Claude: reine Logik. Kein Netz, keine Dateien, keine Prozessumgebung, kein Prozessstart.
//
// Eingabe sind ausschliesslich bereits gelesene API-Antworten (Objekte). Ausgabe sind feste Codes, Kategorien,
// Belegstellen aus festen Bausteinen und geprueften Zahlen oder SHAs, nie Rohtext aus GitHub. Der Einstieg
// scripts/agent-pruefer-vorpruefung.mjs holt die Daten und ruft diese Funktionen in fester Reihenfolge auf.
//
// Ergebniswerte (Auftrag Abschnitt 1): auffaelligkeiten, keine-auffaelligkeiten, ausstehend, nicht-pruefbar.
// Der Bericht ist nie eine Freigabe. Die Woerter fuer ein positives Pruefurteil kommen in Bericht und Logzeile nicht
// vor (Wache im Test).

import { createHash } from 'node:crypto';

export const REPO = 'noah04091/agenten-probe';
export const AUFTRAG_PFAD = '.github/workflows/agent-auftrag.yml';
export const EIGENTUEMER = 'noah04091';
export const STARTLABEL = 'bot-auftrag';
export const BOT_LOGIN = 'noah04091-agenten-probe-cloud-bot[bot]';
export const ACTIONS_APP_ID = 15368;
export const PFLICHTCHECKS = Object.freeze(['build', 'tests', 'schutzdateien', 'agent-auftrag-sammel']);
// Genau die Jobnamen des genehmigten Auftrags-Workflows auf main.
export const JOBNAMEN = Object.freeze(['Job 0 Auftrag festlegen', 'Job 1 Claude im Container', 'Job 2 Abnahme ohne Netz', 'Job 3 Draft-PR veroeffentlichen']);
export const ERGEBNISSE = Object.freeze(['auffaelligkeiten', 'keine-auffaelligkeiten', 'ausstehend', 'nicht-pruefbar']);
export const KATEGORIEN = Object.freeze(['datei', 'commit', 'richtlinie', 'abnahme', 'ci', 'muster', 'integritaet']);
export const ZUORDNUNG_MS = 60_000;
// Pflichtchecks: bis zu 12 Wiederholungen im Abstand von 30 Sekunden (hoechstens 6 Minuten Warten).
export const CHECK_WIEDERHOLUNGEN = 12;
export const CHECK_ABSTAND_MS = 30_000;
// Datengrenzen des PR (nicht pruefbar, wenn ueberschritten).
export const MAX_DATEIEN = 20;
export const MAX_AENDERUNGEN = 2000;
export const MAX_PATCH_ZEICHEN = 200_000;
export const MAX_INHALT_BYTES = 262_144;
export const SATZ_KEINE_FREIGABE = 'Dieser Bericht ist keine Freigabe. Über den Merge entscheidet Noah.';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LAUF_ID = /^[1-9][0-9]{0,15}$/;
const CODE = /^[a-z][a-z0-9-]{0,58}[a-z0-9]$/;
const PROFIL_ID = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const PROFIL_DATEI = /^(src|test)\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const ZWEIG = /^wp\/([1-9][0-9]{0,7})-agent-([1-9][0-9]{0,15})-1$/;
const ZEITSTEMPEL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z /;
const NUTZLAST = /^A6-NUTZLAST (title|body|updated_at) ([0-9a-f]{64})$/;
const ISO_ZEIT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// ---------------------------------------------------------------------------------------------------------------
// Fehler und kleine Helfer
// ---------------------------------------------------------------------------------------------------------------

export class NichtPruefbar extends Error {
  constructor(code) {
    super(code);
    this.name = 'NichtPruefbar';
    this.code = CODE.test(code) ? code : 'unerwartet';
  }
}

export function nichtPruefbar(code) {
  throw new NichtPruefbar(code);
}

const istObjekt = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const ganzzahl = x => Number.isSafeInteger(x) && x > 0;

export function strengeZeit(x) {
  if (typeof x !== 'string' || !ISO_ZEIT.test(x)) {
    return null;
  }

  const ms = Date.parse(x);
  return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2200, 0, 1) ? ms : null;
}

// SHA-256 genau wie im Auftrags-Workflow: Ausgabe von jq -c samt Zeilenende. jq schreibt Zeichen unter 0x20 und
// DEL als \u00xx mit kleinen Hexziffern, sonst wie JSON.stringify. Werte ausser Text und null sind nicht vorgesehen.
export function jqHash(wert) {
  if (wert !== null && typeof wert !== 'string') {
    return null;
  }

  const json = JSON.stringify(wert).replace(/\u007f/g, '\\u007f');
  return createHash('sha256').update(`${json}\n`, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------
// Abschnitt 2: Herkunft (aus der API, nie aus der Ereignisnutzlast)
// ---------------------------------------------------------------------------------------------------------------

// Lauf-ID aus Umgebung oder Eingabe: nur Ziffern ohne fuehrende Null.
export function laufId(text) {
  return typeof text === 'string' && LAUF_ID.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

// Prueft den gelesenen Lauf. Ein Lauf aus einem anderen Ereignis als issues ist kein Agenten-Auftrag
// (quelle-kein-auftrag, ohne Bericht). Alles andere, das nicht passt, ist nicht pruefbar.
export function herkunft(run, erwarteteId) {
  if (!istObjekt(run) || !ganzzahl(run.id)) {
    nichtPruefbar('herkunft-antwort');
  }

  if (run.id !== erwarteteId) {
    nichtPruefbar('herkunft-lauf-id');
  }

  if (!istObjekt(run.repository) || run.repository.full_name !== REPO) {
    nichtPruefbar('herkunft-repository');
  }

  if (run.path !== AUFTRAG_PFAD) {
    nichtPruefbar('herkunft-workflow');
  }

  if (run.event !== 'issues') {
    nichtPruefbar('quelle-kein-auftrag');
  }

  if (run.head_branch !== 'main') {
    nichtPruefbar('herkunft-zweig');
  }

  if (run.run_attempt !== 1) {
    nichtPruefbar('herkunft-versuch');
  }

  if (run.status !== 'completed' || run.conclusion !== 'success') {
    nichtPruefbar('herkunft-nicht-erfolgreich');
  }

  if (typeof run.head_sha !== 'string' || !HEX40.test(run.head_sha)) {
    nichtPruefbar('herkunft-antwort');
  }

  const start = strengeZeit(run.created_at);

  if (start === null) {
    nichtPruefbar('herkunft-antwort');
  }

  return Object.freeze({ id: run.id, headSha: run.head_sha, start });
}

// Jobs 0 bis 3 je genau einmal und success. Liefert die Job-ID von Job 0 (fuer die Nutzlastzeilen).
export function herkunftJobs(jobs, vollstaendig) {
  if (!Array.isArray(jobs) || vollstaendig !== true) {
    nichtPruefbar('herkunft-jobs-unvollstaendig');
  }

  const ids = [];

  for (const name of JOBNAMEN) {
    const treffer = jobs.filter(j => istObjekt(j) && j.name === name);

    if (treffer.length !== 1 || !ganzzahl(treffer[0].id)) {
      nichtPruefbar('herkunft-jobs');
    }

    if (treffer[0].status !== 'completed' || treffer[0].conclusion !== 'success') {
      nichtPruefbar('herkunft-jobs');
    }

    ids.push(treffer[0].id);
  }

  return ids[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Abschnitt 3: Zuordnung zum PR, nur aus festen Werten
// ---------------------------------------------------------------------------------------------------------------

export function zuordnung(pulls, vollstaendig, lauf) {
  if (!Array.isArray(pulls) || vollstaendig !== true) {
    nichtPruefbar('daten-unvollstaendig');
  }

  const treffer = [];

  for (const p of pulls) {
    if (!istObjekt(p) || !istObjekt(p.head) || !istObjekt(p.base) || typeof p.head.ref !== 'string') {
      nichtPruefbar('daten-antwort');
    }

    const m = ZWEIG.exec(p.head.ref);

    if (m && Number(m[2]) === lauf.id && p.base.ref === 'main') {
      treffer.push({ p, issue: Number(m[1]) });
    }
  }

  if (treffer.length === 0) {
    nichtPruefbar('zuordnung-keiner');
  }

  if (treffer.length > 1) {
    nichtPruefbar('zuordnung-mehrdeutig');
  }

  const { p, issue } = treffer[0];

  if (!ganzzahl(p.number) || typeof p.head.sha !== 'string' || !HEX40.test(p.head.sha)) {
    nichtPruefbar('daten-antwort');
  }

  if (p.state !== 'open' || p.merged_at !== null) {
    nichtPruefbar('pr-nicht-offen');
  }

  if (p.draft !== true) {
    nichtPruefbar('pr-kein-draft');
  }

  if (!istObjekt(p.head.repo) || p.head.repo.full_name !== REPO || !istObjekt(p.base.repo) || p.base.repo.full_name !== REPO) {
    nichtPruefbar('pr-quelle');
  }

  if (!istObjekt(p.user) || p.user.login !== BOT_LOGIN || p.user.type !== 'Bot') {
    nichtPruefbar('pr-autor');
  }

  return Object.freeze({ nummer: p.number, issue, kopf: p.head.sha });
}

// Genau ein Commit, Elternteil der head_sha des Quelllaufs, SHA gleich dem Kopf. Der Autor ist ein Befund.
export function commitPruefung(commits, vollstaendig, kopf, basis) {
  if (!Array.isArray(commits) || vollstaendig !== true) {
    nichtPruefbar('daten-unvollstaendig');
  }

  if (commits.length !== 1) {
    nichtPruefbar('zuordnung-commits');
  }

  const c = commits[0];

  if (!istObjekt(c) || c.sha !== kopf) {
    nichtPruefbar('zuordnung-commits');
  }

  if (!Array.isArray(c.parents) || c.parents.length !== 1 || !istObjekt(c.parents[0]) || c.parents[0].sha !== basis) {
    nichtPruefbar('zuordnung-eltern');
  }

  return istObjekt(c.author) && c.author.login === BOT_LOGIN ? [] : [befund('commit-autor', 'commit', 'API pulls/commits (author)')];
}

// Kopf unmittelbar vor dem Bericht erneut gelesen.
export function kopfGleich(pull, kopf) {
  if (!istObjekt(pull) || !istObjekt(pull.head) || pull.head.sha !== kopf) {
    nichtPruefbar('kopf-geaendert');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Abschnitt 4: Auftragsbindung
// ---------------------------------------------------------------------------------------------------------------

// Nur Zeilen, die nach dem Zeitstempel vollstaendig auf das feste Muster passen. Jede genau einmal.
export function nutzlastAusLog(text) {
  if (typeof text !== 'string') {
    nichtPruefbar('auftrag-unbelegt');
  }

  const funde = { title: [], body: [], updated_at: [] };

  for (const roh of text.replace(/^\uFEFF/, '').split('\n')) {
    const m = NUTZLAST.exec(roh.replace(/\r$/, '').replace(ZEITSTEMPEL, ''));

    if (m) {
      funde[m[1]].push(m[2]);
    }
  }

  if (Object.values(funde).some(liste => liste.length !== 1)) {
    nichtPruefbar('auftrag-nutzlast');
  }

  return Object.freeze({ title: funde.title[0], body: funde.body[0], updatedAt: funde.updated_at[0] });
}

// Titel und Text muessen den Zeilen gleichen. Nur updated_at abweichend: Hinweis.
export function auftragsBindung(issue, nutzlast, issueNummer) {
  if (!istObjekt(issue) || issue.number !== issueNummer || issue.pull_request !== undefined) {
    nichtPruefbar('daten-antwort');
  }

  const t = jqHash(issue.title);
  const b = jqHash(issue.body);
  const u = jqHash(issue.updated_at);

  if (t === null || b === null || u === null || ![nutzlast.title, nutzlast.body, nutzlast.updatedAt].every(h => HEX64.test(h))) {
    nichtPruefbar('auftrag-unbelegt');
  }

  if (t !== nutzlast.title || b !== nutzlast.body) {
    nichtPruefbar('auftrag-geaendert');
  }

  return u === nutzlast.updatedAt ? [] : [befund('auftrag-bearbeitet', 'integritaet', 'API issues (updated_at)')];
}

// Startlabel bot-auftrag durch den Eigentuemer hoechstens 60 Sekunden vor dem Laufstart.
export function startlabel(ereignisse, vollstaendig, start) {
  if (!Array.isArray(ereignisse) || vollstaendig !== true) {
    nichtPruefbar('daten-unvollstaendig');
  }

  const ok = ereignisse.some(e => {
    if (!istObjekt(e) || e.event !== 'labeled' || !istObjekt(e.label) || e.label.name !== STARTLABEL || !istObjekt(e.actor) || e.actor.login !== EIGENTUEMER) {
      return false;
    }

    const ms = strengeZeit(e.created_at);
    return ms !== null && ms <= start && start - ms <= ZUORDNUNG_MS;
  });

  if (!ok) {
    nichtPruefbar('auftrag-startlabel');
  }
}

// Profil aus den Labels des Issues: genau ein agent:-Label mit gueltiger ID.
export function profilId(issue) {
  const labels = istObjekt(issue) && Array.isArray(issue.labels) ? issue.labels : null;

  if (labels === null) {
    nichtPruefbar('daten-antwort');
  }

  const ids = labels.filter(l => istObjekt(l) && typeof l.name === 'string' && l.name.startsWith('agent:')).map(l => l.name.slice(6));

  if (ids.length !== 1 || !PROFIL_ID.test(ids[0])) {
    nichtPruefbar('auftrag-profil');
  }

  return ids[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Abschnitt 5: Gate
// ---------------------------------------------------------------------------------------------------------------

export function befund(code, kategorie, beleg) {
  return Object.freeze({ code, kategorie, beleg });
}

// Profil und Policy an der Basis-SHA (Text aus der Contents-API, bereits dekodiert).
export function profilDateien(text, policy) {
  let p;

  try {
    p = JSON.parse(text);
  } catch {
    nichtPruefbar('auftrag-profil');
  }

  const max = istObjekt(policy) && Number.isSafeInteger(policy.max_dateien) ? policy.max_dateien : 0;

  if (!istObjekt(p) || !Array.isArray(p.dateien) || p.dateien.length < 1 || p.dateien.length > max
    || !p.dateien.every(d => typeof d === 'string' && PROFIL_DATEI.test(d) && !d.includes('..'))
    || new Set(p.dateien).size !== p.dateien.length) {
    nichtPruefbar('auftrag-profil');
  }

  return Object.freeze([...p.dateien].sort());
}

export function policyAus(text) {
  let p;

  try {
    p = JSON.parse(text);
  } catch {
    nichtPruefbar('daten-policy');
  }

  const liste = x => Array.isArray(x) && x.length > 0 && x.every(e => typeof e === 'string' && e.length > 0 && e.length <= 100);

  if (!istObjekt(p) || p.schema !== 'agent-policy-v1' || !liste(p.gesperrte_praefixe) || !liste(p.gesperrte_dateien) || !Number.isSafeInteger(p.max_dateien)) {
    nichtPruefbar('daten-policy');
  }

  return Object.freeze({ praefixe: [...p.gesperrte_praefixe], dateien: [...p.gesperrte_dateien], maxDateien: p.max_dateien });
}

export function gesperrt(pfad, policy) {
  return policy.dateien.some(d => pfad === d || pfad.endsWith(`/${d}`))
    || policy.praefixe.some(pr => pfad.startsWith(pr) || pfad.includes(`/${pr}`));
}

// Datengrenzen: Anzahl, Groesse, Binaer, Nicht-UTF-8. Jeder Verstoss: nicht pruefbar.
export function dateienDaten(files, vollstaendig) {
  if (!Array.isArray(files) || vollstaendig !== true) {
    nichtPruefbar('daten-unvollstaendig');
  }

  if (files.length > MAX_DATEIEN) {
    nichtPruefbar('daten-groesse');
  }

  let aenderungen = 0;
  let zeichen = 0;

  for (const f of files) {
    if (!istObjekt(f) || typeof f.filename !== 'string' || f.filename.length === 0 || f.filename.length > 300 || !Number.isSafeInteger(f.changes) || f.changes < 0) {
      nichtPruefbar('daten-antwort');
    }

    aenderungen += f.changes;

    if (f.changes === 0 && f.patch === undefined) {
      // Umbenennung ohne Inhalt oder Modusaenderung: kein Patch, keine Aenderung im Inhalt.
      continue;
    }

    if (typeof f.patch !== 'string') {
      nichtPruefbar('daten-binaer');
    }

    if (f.patch.includes('\u0000')) {
      nichtPruefbar('daten-binaer');
    }

    if (f.patch.includes('\uFFFD')) {
      nichtPruefbar('daten-utf8');
    }

    zeichen += f.patch.length;
  }

  if (aenderungen > MAX_AENDERUNGEN || zeichen > MAX_PATCH_ZEICHEN) {
    nichtPruefbar('daten-groesse');
  }
}

// Dateien gegen Profil und Policy. Dateinamen aus dem PR erscheinen nie im Bericht; genannt werden nur Profildateien.
export function dateiBefunde(files, profil, policy) {
  const befunde = [];
  const namen = files.map(f => f.filename);
  const geaendert = new Set(files.flatMap(f => (typeof f.previous_filename === 'string' ? [f.filename, f.previous_filename] : [f.filename])));

  for (const name of geaendert) {
    if (!profil.includes(name)) {
      befunde.push(befund('datei-zusaetzlich', 'datei', 'API pulls/files (Datei außerhalb der Profilliste)'));
      break;
    }
  }

  for (const d of profil) {
    if (!namen.includes(d)) {
      befunde.push(befund('datei-fehlt', 'datei', d));
    }
  }

  for (const name of geaendert) {
    if (gesperrt(name, policy)) {
      befunde.push(befund('richtlinie-gesperrt', 'richtlinie', '.github/agent/policy.json (gesperrte Präfixe und Dateien)'));
      break;
    }
  }

  for (const f of files) {
    if (profil.includes(f.filename) && f.status !== 'modified' && f.status !== 'added') {
      befunde.push(befund('datei-status', 'datei', f.filename));
    }
  }

  return befunde;
}

export function abnahmeBefunde({ abnahmeVorhanden, issue }) {
  return abnahmeVorhanden ? [] : [befund('abnahme-fehlt', 'abnahme', `agent-acceptance/issue-${issue}.mjs`)];
}

const TESTAUFRUF = /\btest\s*\(/g;

export function testAufrufe(text) {
  return typeof text === 'string' ? (text.match(TESTAUFRUF) ?? []).length : null;
}

// Testdatei des Profils geaendert und mehr test(-Aufrufe als an der Basis.
export function testBefunde({ profil, files, basisText, kopfText }) {
  const testdatei = profil.find(d => d.startsWith('test/'));

  if (testdatei === undefined) {
    return [befund('abnahme-keine-testdatei', 'abnahme', 'agent-profiles (dateien)')];
  }

  if (!files.some(f => f.filename === testdatei)) {
    return [befund('abnahme-test-unveraendert', 'abnahme', testdatei)];
  }

  const vorher = basisText === null ? 0 : testAufrufe(basisText);
  const nachher = testAufrufe(kopfText);

  if (vorher === null || nachher === null) {
    nichtPruefbar('daten-antwort');
  }

  return nachher > vorher ? [] : [befund('abnahme-tests-nicht-mehr', 'abnahme', testdatei)];
}

// Muster nur in hinzugefuegten Zeilen der Quelldateien des Profils (nicht test/). Hinweise, nie Befunde.
const MODULE = ['fs', 'child_process', 'net', 'http', 'https', 'dgram', 'worker_threads'];
export const MUSTER = Object.freeze([
  ...MODULE.map(m => [`muster-${m.replace('_', '-')}`, new RegExp(`(?:\\brequire\\s*\\(\\s*|\\bimport\\b[^'"\`]*|\\bfrom\\s*)['"\`](?:node:)?${m}(?:/[a-z]+)?['"\`]`)]),
  ['muster-process-env', /\bprocess\s*\.\s*env\b|\bprocess\s*\[\s*['"`]env['"`]\s*\]/],
  ['muster-eval', /\beval\s*\(/],
  ['muster-function', /\bFunction\s*\(/],
  ['muster-url', /\bhttps?:\/\//i],
]);
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function musterHinweise(files, profil) {
  const hinweise = [];

  for (const f of files) {
    if (!profil.includes(f.filename) || f.filename.startsWith('test/') || typeof f.patch !== 'string') {
      continue;
    }

    let zeile = 0;

    for (const z of f.patch.split('\n')) {
      const h = HUNK.exec(z);

      if (h) {
        zeile = Number(h[1]);
        continue;
      }

      if (z.startsWith('+')) {
        for (const [code, re] of MUSTER) {
          if (re.test(z.slice(1))) {
            hinweise.push(befund(code, 'muster', `${f.filename} Zeile ${zeile}`));
          }
        }

        zeile += 1;
      } else if (!z.startsWith('-') && !z.startsWith('\\')) {
        zeile += 1;
      }
    }
  }

  return hinweise;
}

// Pflichtchecks am Kopf: je Name genau ein Check der App 15368. Laufend oder fehlend: offen (Wiederholung).
// failure, cancelled, timed_out, action_required, doppelt oder von anderer App: Befund ci.
export function pflichtchecks(checkRuns, vollstaendig) {
  if (!Array.isArray(checkRuns) || vollstaendig !== true) {
    nichtPruefbar('daten-unvollstaendig');
  }

  const befunde = [];
  const zustand = [];
  let offen = false;

  for (const name of PFLICHTCHECKS) {
    const gleich = checkRuns.filter(c => istObjekt(c) && c.name === name);
    const fremd = gleich.filter(c => !istObjekt(c.app) || c.app.id !== ACTIONS_APP_ID);
    const eigene = gleich.filter(c => istObjekt(c.app) && c.app.id === ACTIONS_APP_ID);

    if (fremd.length > 0) {
      befunde.push(befund('ci-fremde-app', 'ci', name));
      zustand.push([name, 'fremde App']);
      continue;
    }

    if (eigene.length > 1) {
      befunde.push(befund('ci-doppelt', 'ci', name));
      zustand.push([name, 'doppelt']);
      continue;
    }

    if (eigene.length === 0) {
      offen = true;
      zustand.push([name, 'fehlt']);
      continue;
    }

    const c = eigene[0];

    if (c.status !== 'completed') {
      offen = true;
      zustand.push([name, 'läuft']);
      continue;
    }

    if (c.conclusion === 'success') {
      zustand.push([name, 'erfolgreich']);
      continue;
    }

    befunde.push(befund('ci-fehlgeschlagen', 'ci', name));
    zustand.push([name, ['failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'neutral', 'stale'].includes(c.conclusion) ? c.conclusion : 'unbekannt']);
  }

  return Object.freeze({ befunde, offen, zustand });
}

// ---------------------------------------------------------------------------------------------------------------
// Ergebnis, Logzeile, Bericht
// ---------------------------------------------------------------------------------------------------------------

// Vorrang: nicht pruefbar vor Auffaelligkeit vor ausstehend vor keine Auffaelligkeit.
export function ergebnis({ code = null, befunde = [], hinweise = [], checksOffen = false }) {
  if (code !== null) {
    return 'nicht-pruefbar';
  }

  if (befunde.length > 0 || hinweise.length > 0) {
    return 'auffaelligkeiten';
  }

  return checksOffen ? 'ausstehend' : 'keine-auffaelligkeiten';
}

const wert = (x, re) => (typeof x === 'string' && re.test(x) ? x : 'unbekannt');
const zahl = x => (Number.isSafeInteger(x) && x > 0 ? String(x) : 'unbekannt');

export function logzeile({ pr, kopf, basis, lauf, ergebnis: e, befunde = [], hinweise = [] }) {
  if (!ERGEBNISSE.includes(e)) {
    throw new Error('ergebnis');
  }

  return `A6-PRUEFER repo ${REPO} pr ${zahl(pr)} kopf ${wert(kopf, HEX40)} basis ${wert(basis, HEX40)} lauf ${zahl(lauf)} ergebnis ${e} befunde ${befunde.length} hinweise ${hinweise.length}`;
}

// Feste Saetze je Code. Ein unbekannter Code bekommt einen festen allgemeinen Satz.
export const SAETZE = Object.freeze({
  'quelle-kein-auftrag': 'Der Lauf ist kein Agenten-Auftrag aus einem Issue.',
  'herkunft-antwort': 'Die Laufdaten sind unvollständig oder unbrauchbar.',
  'herkunft-lauf-id': 'Die Lauf-ID der Anfrage ist ungültig oder gleicht nicht dem gelesenen Lauf.',
  'herkunft-lauf-fehlt': 'Einen Lauf mit dieser ID gibt es nicht.',
  'herkunft-repository': 'Der Lauf gehört zu einem anderen Repository.',
  'herkunft-workflow': 'Der Lauf stammt nicht aus dem Auftrags-Workflow.',
  'herkunft-zweig': 'Der Lauf lief nicht auf main.',
  'herkunft-versuch': 'Der Lauf ist nicht der erste Versuch.',
  'herkunft-nicht-erfolgreich': 'Der Lauf ist nicht erfolgreich abgeschlossen.',
  'herkunft-jobs': 'Job 0 bis 3 des Laufs sind nicht je genau einmal erfolgreich.',
  'herkunft-jobs-unvollstaendig': 'Die Jobliste des Laufs ist nicht vollständig lesbar.',
  'zuordnung-keiner': 'Zum Lauf gibt es keinen PR nach main mit dem festen Zweigmuster.',
  'zuordnung-mehrdeutig': 'Zum Lauf gibt es mehr als einen PR mit dem festen Zweigmuster.',
  'zuordnung-commits': 'Der PR hat nicht genau einen Commit am Kopf.',
  'zuordnung-eltern': 'Der Commit baut nicht auf dem Ausgangsstand des Laufs auf.',
  'pr-nicht-offen': 'Der PR ist nicht offen.',
  'pr-kein-draft': 'Der PR ist kein Draft.',
  'pr-quelle': 'Der PR kommt nicht aus diesem Repository.',
  'pr-autor': 'Der PR stammt nicht vom Bot des Auftrags.',
  'kopf-geaendert': 'Der Kopf des PR hat sich während der Prüfung geändert.',
  'auftrag-unbelegt': 'Der Auftrag des Laufs ist nicht mehr belegbar.',
  'auftrag-nutzlast': 'Die Hashzeilen des Auftrags fehlen im Log oder sind mehrfach vorhanden.',
  'auftrag-geaendert': 'Titel oder Text des Issues weichen vom Auftrag des Laufs ab.',
  'auftrag-startlabel': 'Das Startlabel des Eigentümers vor dem Laufstart ist nicht belegt.',
  'auftrag-profil': 'Das Profil des Auftrags ist nicht eindeutig oder ungültig.',
  'auftrag-bearbeitet': 'Issue seit dem Lauf bearbeitet (Inhalt gleich).',
  'daten-unvollstaendig': 'Eine Liste aus der API ist nicht vollständig lesbar.',
  'daten-antwort': 'Eine Antwort der API ist unbrauchbar.',
  'daten-policy': 'Die Policy an der Basis ist nicht lesbar.',
  'daten-groesse': 'Der Diff überschreitet die feste Größengrenze.',
  'daten-binaer': 'Der PR enthält Binärinhalt oder einen Diff ohne Text.',
  'daten-utf8': 'Der PR enthält Inhalt, der kein gültiges UTF-8 ist.',
  'datei-zusaetzlich': 'Der PR ändert eine Datei außerhalb der Profilliste.',
  'datei-fehlt': 'Eine Profildatei ist im PR nicht geändert.',
  'datei-status': 'Eine Profildatei ist nicht geändert oder neu, sondern umbenannt oder gelöscht.',
  'richtlinie-gesperrt': 'Der PR berührt einen gesperrten Pfad der Policy.',
  'abnahme-fehlt': 'Die Abnahmedatei des Issues fehlt an der Basis.',
  'abnahme-keine-testdatei': 'Das Profil nennt keine Testdatei.',
  'abnahme-test-unveraendert': 'Die Testdatei des Profils ist nicht geändert.',
  'abnahme-tests-nicht-mehr': 'Die Testdatei hat nicht mehr Testaufrufe als an der Basis.',
  'commit-autor': 'Der Commit stammt nicht vom Bot des Auftrags.',
  'ci-fehlgeschlagen': 'Ein Pflichtcheck ist nicht erfolgreich.',
  'ci-doppelt': 'Ein Pflichtcheck liegt mehrfach vor.',
  'ci-fremde-app': 'Ein Check mit dem Namen eines Pflichtchecks stammt von einer anderen App.',
  'muster-fs': 'Hinweis: Zugriff auf das Dateisystem (fs) in der Quelldatei.',
  'muster-child-process': 'Hinweis: Prozessstart (child_process) in der Quelldatei.',
  'muster-net': 'Hinweis: Netzmodul (net) in der Quelldatei.',
  'muster-http': 'Hinweis: Netzmodul (http) in der Quelldatei.',
  'muster-https': 'Hinweis: Netzmodul (https) in der Quelldatei.',
  'muster-dgram': 'Hinweis: Netzmodul (dgram) in der Quelldatei.',
  'muster-worker-threads': 'Hinweis: Worker-Threads in der Quelldatei.',
  'muster-process-env': 'Hinweis: Zugriff auf die Prozessumgebung in der Quelldatei.',
  'muster-eval': 'Hinweis: eval in der Quelldatei.',
  'muster-function': 'Hinweis: Function-Konstruktor in der Quelldatei.',
  'muster-url': 'Hinweis: Netzadresse in der Quelldatei.',
  unerwartet: 'Die Prüfung brach unerwartet ab.',
});

const ANZEIGE_ERGEBNIS = Object.freeze({
  auffaelligkeiten: 'Auffälligkeiten',
  'keine-auffaelligkeiten': 'keine Auffälligkeiten im geprüften Umfang (keine Freigabe)',
  ausstehend: 'ausstehend: Pflichtchecks am Kopf noch nicht fertig',
  'nicht-pruefbar': 'nicht prüfbar',
});

// Zellen nur aus festen Bausteinen; trotzdem jedes Zeichen ausserhalb einer engen Liste ersetzt.
const zelle = t => String(t).replace(/[^A-Za-z0-9 ._:/()#,äöüÄÖÜß-]/g, '?').slice(0, 200);

export function bericht(e) {
  const satz = code => SAETZE[code] ?? SAETZE.unerwartet;
  const zeilen = [
    '## Vorprüfung Agenten-PR (ohne Claude)',
    '',
    '| Feld | Wert |',
    '|---|---|',
    `| Repository | ${REPO} |`,
    `| PR | ${zahl(e.pr) === 'unbekannt' ? 'unbekannt' : `#${zahl(e.pr)}`} |`,
    `| Kopf | ${wert(e.kopf, HEX40)} |`,
    `| Basis | ${wert(e.basis, HEX40)} |`,
    `| Lauf | ${zahl(e.lauf)} |`,
    `| Ergebnis | ${e.ergebnis} (${ANZEIGE_ERGEBNIS[e.ergebnis]}) |`,
    `| Befunde | ${e.befunde.length} |`,
    `| Hinweise | ${e.hinweise.length} |`,
    '',
  ];

  if (e.code !== null) {
    zeilen.push(`Grund: ${zelle(e.code)}. ${zelle(satz(e.code))}`, '');
  }

  if (e.befunde.length + e.hinweise.length > 0) {
    zeilen.push('| Art | Code | Kategorie | Belegstelle | Bedeutung |', '|---|---|---|---|---|');

    for (const [art, liste] of [['Befund', e.befunde], ['Hinweis', e.hinweise]]) {
      for (const b of liste) {
        zeilen.push(`| ${art} | ${zelle(b.code)} | ${zelle(b.kategorie)} | ${zelle(b.beleg)} | ${zelle(satz(b.code))} |`);
      }
    }

    zeilen.push('');
  }

  if (Array.isArray(e.checks) && e.checks.length > 0) {
    zeilen.push('| Pflichtcheck | Zustand |', '|---|---|');

    for (const [name, z] of e.checks) {
      zeilen.push(`| ${zelle(name)} | ${zelle(z)} |`);
    }

    zeilen.push('');
  }

  zeilen.push(SATZ_KEINE_FREIGABE, '');
  return zeilen.join('\n');
}

// Geheimnis-Filter wie B1.2: feste Muster und, wenn bekannt, der Tokenwert selbst.
export const GEHEIM_MUSTER = Object.freeze(['github_pat_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'sk-ant', '-----BEGIN', '/home/runner/']);

export function geheimnisTreffer(text, token = null) {
  const treffer = GEHEIM_MUSTER.filter(m => text.includes(m));

  if (typeof token === 'string' && token.length >= 8 && text.includes(token)) {
    treffer.push('token');
  }

  return treffer;
}
