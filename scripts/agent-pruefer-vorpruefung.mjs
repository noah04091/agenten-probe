// B2.1 Vorpruefung ohne Claude: Einstieg. Umgebung, Transport, Ablauf, Logzeile, Ergebnisdatei.
//
// Laeuft nur im festen Node-Image nach dem Integritaetspruefer (Workflow agent-pruefer.yml). Liest ausschliesslich
// ueber GET an eine feste Liste von GitHub-Endpunkten; jede andere Methode, jeder andere Host und jeder andere Pfad
// bricht den Lauf ab (Transport-Wache). PR-Inhalte sind nur Daten: es wird nichts aus dem PR ausgefuehrt, kein Git,
// kein Prozessstart, keine Datei ausser der einen Ergebnisdatei geschrieben.
//
// Umgebung (Stolperdraht): genau A6_LESE_TOKEN, GITHUB_REPOSITORY, A6_PRUEFER_LAUF und PATH (fester Wert); dazu
// duerfen nur die von Docker selbst gesetzten HOME, HOSTNAME und PWD stehen. Jede weitere Variable, jede NODE_-
// Variable: Abbruch vor jeder Bewertung.
//
// Ausgabe: genau eine Logzeile A6-PRUEFER (Abschnitt 7) auf stdout, der Bericht in /a6/ergebnis.md. Ein
// Schreibfehler am Bericht aendert das Ergebnis nicht und erzeugt eine feste Warnung. Exitcode 0 fuer jedes der vier
// Ergebnisse; 1 nur bei Abbruch (Umgebung, Transport-Wache).

import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from 'node:fs';

import {
  CHECK_ABSTAND_MS, CHECK_WIEDERHOLUNGEN, MAX_INHALT_BYTES, NichtPruefbar, REPO, abnahmeBefunde, auftragsBindung, bericht, commitPruefung, dateiBefunde,
  dateienDaten, ergebnis, geheimnisTreffer, herkunft, herkunftJobs, kopfGleich, laufId, logzeile, musterHinweise, nichtPruefbar, nutzlastAusLog,
  pflichtchecks, policyAus, profilDateien, profilId, startlabel, testBefunde, zuordnung,
} from './agent-pruefer-gate.mjs';

export const API = 'https://api.github.com';
export const ERGEBNIS_DATEI = '/a6/ergebnis.md';
export const FESTER_PATH = '/usr/local/bin:/usr/bin:/bin';
export const ZEITLIMIT_MS = 20_000;
export const GRENZE_JSON = 8 * 1024 * 1024;
export const GRENZE_LOG = 16 * 1024 * 1024;
export const MAX_SEITEN = 10;
export const PRO_SEITE = 100;
export const UMGEBUNG_PFLICHT = Object.freeze(['A6_LESE_TOKEN', 'A6_PRUEFER_LAUF', 'GITHUB_REPOSITORY', 'PATH']);
export const UMGEBUNG_DOCKER = Object.freeze(['HOME', 'HOSTNAME', 'PWD']);

const R = `/repos/${REPO}`;
const r = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Feste Liste der Endpunkte (nur Pfad, ohne Abfrage). Alles andere bricht ab.
export const ENDPUNKTE = Object.freeze([
  new RegExp(`^${r(R)}/actions/runs/[1-9][0-9]{0,15}$`),
  new RegExp(`^${r(R)}/actions/runs/[1-9][0-9]{0,15}/jobs$`),
  new RegExp(`^${r(R)}/actions/jobs/[1-9][0-9]{0,15}/logs$`),
  new RegExp(`^${r(R)}/pulls$`),
  new RegExp(`^${r(R)}/pulls/[1-9][0-9]{0,7}$`),
  new RegExp(`^${r(R)}/pulls/[1-9][0-9]{0,7}/files$`),
  new RegExp(`^${r(R)}/pulls/[1-9][0-9]{0,7}/commits$`),
  new RegExp(`^${r(R)}/issues/[1-9][0-9]{0,7}$`),
  new RegExp(`^${r(R)}/issues/[1-9][0-9]{0,7}/events$`),
  new RegExp(`^${r(R)}/contents/(?:\\.github/agent/policy\\.json|agent-profiles/[a-z][a-z0-9-]{1,38}[a-z0-9]\\.json|agent-acceptance/issue-[1-9][0-9]{0,7}\\.mjs|test/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99})$`),
  new RegExp(`^${r(R)}/commits/[0-9a-f]{40}/check-runs$`),
]);
// Erlaubte Abfrageparameter und ihre Werte.
const ABFRAGE = Object.freeze({
  per_page: /^100$/,
  page: /^(?:[1-9]|10)$/,
  state: /^all$/,
  base: /^main$/,
  ref: /^[0-9a-f]{40}$/,
});
const LOG_HOST = /^productionresultssa\d{1,3}\.blob\.core\.windows\.net$/;

export class TransportFehler extends Error {
  constructor(code) {
    super(code);
    this.name = 'TransportFehler';
    this.code = code;
  }
}

class UmgebungFehler extends Error {
  constructor(code) {
    super(code);
    this.name = 'UmgebungFehler';
    this.code = code;
  }
}

// Transport-Wache: nur GET an api.github.com auf einen Pfad der festen Liste mit erlaubter Abfrage.
export function pruefeAnfrage(methode, url) {
  if (methode !== 'GET') {
    throw new TransportFehler('pruefer-transport-methode');
  }

  let u;

  try {
    u = new URL(url);
  } catch {
    throw new TransportFehler('pruefer-transport-pfad');
  }

  if (u.origin !== API || u.username !== '' || u.password !== '' || u.hash !== '' || !ENDPUNKTE.some(re => re.test(u.pathname))) {
    throw new TransportFehler('pruefer-transport-pfad');
  }

  const schluessel = [...u.searchParams.keys()];

  if (new Set(schluessel).size !== schluessel.length || !schluessel.every(k => Object.hasOwn(ABFRAGE, k) && ABFRAGE[k].test(u.searchParams.get(k)))) {
    throw new TransportFehler('pruefer-transport-pfad');
  }

  return u;
}

async function begrenzterText(res, grenze) {
  const laenge = Number(res.headers.get('content-length'));

  if (Number.isFinite(laenge) && laenge > grenze) {
    return null;
  }

  const t = await res.text();
  return t.length > grenze ? null : t;
}

export function erzeugeTransport({ token, fetchImpl = globalThis.fetch, zeitlimitMs = ZEITLIMIT_MS }) {
  const kopf = Object.freeze({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agent-pruefer-b2-1',
  });

  async function abruf(pfad) {
    const u = pruefeAnfrage('GET', `${API}${pfad}`);

    try {
      return await fetchImpl(u.href, { method: 'GET', headers: kopf, redirect: 'manual', signal: AbortSignal.timeout(zeitlimitMs) });
    } catch {
      nichtPruefbar('daten-antwort');
    }
  }

  // JSON bei 200; null bei 404 nur, wenn fehltErlaubt; sonst nicht pruefbar.
  async function json(pfad, { fehltErlaubt = false } = {}) {
    const res = await abruf(pfad);

    if (res.status === 404 && fehltErlaubt) {
      return null;
    }

    if (res.status !== 200) {
      nichtPruefbar('daten-antwort');
    }

    const t = await begrenzterText(res, GRENZE_JSON);

    if (t === null) {
      nichtPruefbar('daten-groesse');
    }

    try {
      return JSON.parse(t);
    } catch {
      nichtPruefbar('daten-antwort');
    }
  }

  // Alle Seiten; vollstaendig nur, wenn die letzte Seite kuerzer war und total_count (falls vorhanden) passt.
  async function seiten(pfad, feld = null) {
    const daten = [];
    let gesamt = null;

    for (let seite = 1; seite <= MAX_SEITEN; seite += 1) {
      const antwort = await json(`${pfad}${pfad.includes('?') ? '&' : '?'}per_page=${PRO_SEITE}&page=${seite}`);
      const liste = feld === null ? antwort : antwort?.[feld];

      if (!Array.isArray(liste)) {
        nichtPruefbar('daten-antwort');
      }

      if (feld !== null && Number.isSafeInteger(antwort.total_count)) {
        gesamt = antwort.total_count;
      }

      daten.push(...liste);

      if (liste.length < PRO_SEITE) {
        return { daten, vollstaendig: gesamt === null || gesamt === daten.length };
      }
    }

    return { daten, vollstaendig: false };
  }

  // Dateiinhalt an fester SHA als Text (UTF-8 streng). 404: null.
  async function inhalt(pfad, sha) {
    const a = await json(`${R}/contents/${pfad}?ref=${sha}`, { fehltErlaubt: true });

    if (a === null) {
      return null;
    }

    if (typeof a !== 'object' || a.type !== 'file' || a.encoding !== 'base64' || typeof a.content !== 'string' || !Number.isSafeInteger(a.size) || a.size > MAX_INHALT_BYTES) {
      nichtPruefbar(Number.isSafeInteger(a?.size) && a.size > MAX_INHALT_BYTES ? 'daten-groesse' : 'daten-antwort');
    }

    const bytes = Buffer.from(a.content.replace(/\n/g, ''), 'base64');

    if (bytes.length !== a.size) {
      nichtPruefbar('daten-antwort');
    }

    if (bytes.includes(0)) {
      nichtPruefbar('daten-binaer');
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      nichtPruefbar('daten-utf8');
    }
  }

  // Job-Log: 302 auf einen festen Host, Download ohne Authorization und ohne weitere Weiterleitung.
  async function log(jobId) {
    const res = await abruf(`${R}/actions/jobs/${jobId}/logs`);

    if (res.status !== 302) {
      nichtPruefbar('auftrag-unbelegt');
    }

    let ziel;

    try {
      ziel = new URL(res.headers.get('location') ?? '');
    } catch {
      nichtPruefbar('auftrag-unbelegt');
    }

    if (ziel.protocol !== 'https:' || !LOG_HOST.test(ziel.hostname) || ziel.port !== '' || ziel.username !== '' || ziel.password !== '') {
      nichtPruefbar('auftrag-unbelegt');
    }

    let antwort;

    try {
      antwort = await fetchImpl(ziel.href, { method: 'GET', headers: { 'User-Agent': 'agent-pruefer-b2-1' }, redirect: 'error', signal: AbortSignal.timeout(zeitlimitMs) });
    } catch {
      nichtPruefbar('auftrag-unbelegt');
    }

    if (antwort.status !== 200) {
      nichtPruefbar('auftrag-unbelegt');
    }

    const t = await begrenzterText(antwort, GRENZE_LOG);

    if (t === null) {
      nichtPruefbar('auftrag-unbelegt');
    }

    return t;
  }

  return Object.freeze({ json, seiten, inhalt, log });
}

// Der Ablauf in fester Reihenfolge. Liefert das Ergebnisobjekt; wirft nur TransportFehler.
export async function pruefe({ transport, laufText, schlafe = ms => new Promise(res => setTimeout(res, ms)) }) {
  const e = { pr: null, kopf: null, basis: null, lauf: null, code: null, befunde: [], hinweise: [], checks: [] };

  try {
    const id = laufId(laufText);

    if (id === null) {
      nichtPruefbar('herkunft-lauf-id');
    }

    e.lauf = id;
    const run = await transport.json(`${R}/actions/runs/${id}`, { fehltErlaubt: true });

    if (run === null) {
      nichtPruefbar('herkunft-lauf-fehlt');
    }

    const lauf = herkunft(run, id);
    e.basis = lauf.headSha;
    const jobs = await transport.seiten(`${R}/actions/runs/${id}/jobs`, 'jobs');
    const job0 = herkunftJobs(jobs.daten, jobs.vollstaendig);

    const pulls = await transport.seiten(`${R}/pulls?state=all&base=main`);
    const pr = zuordnung(pulls.daten, pulls.vollstaendig, lauf);
    e.pr = pr.nummer;
    e.kopf = pr.kopf;
    const commits = await transport.seiten(`${R}/pulls/${pr.nummer}/commits`);
    e.befunde.push(...commitPruefung(commits.daten, commits.vollstaendig, pr.kopf, lauf.headSha));

    const nutzlast = nutzlastAusLog(await transport.log(job0));
    const issue = await transport.json(`${R}/issues/${pr.issue}`);
    e.hinweise.push(...auftragsBindung(issue, nutzlast, pr.issue));
    const ereignisse = await transport.seiten(`${R}/issues/${pr.issue}/events`);
    startlabel(ereignisse.daten, ereignisse.vollstaendig, lauf.start);
    const profilName = profilId(issue);

    const policyText = await transport.inhalt('.github/agent/policy.json', lauf.headSha);

    if (policyText === null) {
      nichtPruefbar('daten-policy');
    }

    const policy = policyAus(policyText);
    const profilText = await transport.inhalt(`agent-profiles/${profilName}.json`, lauf.headSha);

    if (profilText === null) {
      nichtPruefbar('auftrag-profil');
    }

    const profil = profilDateien(profilText, { max_dateien: policy.maxDateien });
    const abnahmeVorhanden = (await transport.inhalt(`agent-acceptance/issue-${pr.issue}.mjs`, lauf.headSha)) !== null;

    const files = await transport.seiten(`${R}/pulls/${pr.nummer}/files`);
    dateienDaten(files.daten, files.vollstaendig);
    e.befunde.push(...dateiBefunde(files.daten, profil, policy));
    e.befunde.push(...abnahmeBefunde({ abnahmeVorhanden, issue: pr.issue }));

    const testdatei = profil.find(d => d.startsWith('test/'));

    if (testdatei !== undefined && files.daten.some(f => f.filename === testdatei)) {
      const basisText = await transport.inhalt(testdatei, lauf.headSha);
      const kopfText = await transport.inhalt(testdatei, pr.kopf);

      if (kopfText === null) {
        nichtPruefbar('daten-antwort');
      }

      e.befunde.push(...testBefunde({ profil, files: files.daten, basisText, kopfText }));
    } else {
      e.befunde.push(...testBefunde({ profil, files: files.daten, basisText: null, kopfText: null }));
    }

    e.hinweise.push(...musterHinweise(files.daten, profil));

    // Pflichtchecks: erster Versuch plus bis zu 12 Wiederholungen; jedes Mal zuerst der Kopf.
    let checks;

    for (let versuch = 0; ; versuch += 1) {
      kopfGleich(await transport.json(`${R}/pulls/${pr.nummer}`), pr.kopf);
      const cr = await transport.seiten(`${R}/commits/${pr.kopf}/check-runs`, 'check_runs');
      checks = pflichtchecks(cr.daten, cr.vollstaendig);

      if (!checks.offen || versuch >= CHECK_WIEDERHOLUNGEN) {
        break;
      }

      await schlafe(CHECK_ABSTAND_MS);
    }

    e.befunde.push(...checks.befunde);
    e.checks = checks.zustand;
    // Unmittelbar vor dem Bericht: Kopf erneut.
    kopfGleich(await transport.json(`${R}/pulls/${pr.nummer}`), pr.kopf);
    e.ergebnis = ergebnis({ befunde: e.befunde, hinweise: e.hinweise, checksOffen: checks.offen });
    return e;
  } catch (fehler) {
    if (fehler instanceof TransportFehler) {
      throw fehler;
    }

    e.code = fehler instanceof NichtPruefbar ? fehler.code : 'unerwartet';
    e.befunde = [];
    e.hinweise = [];
    e.ergebnis = 'nicht-pruefbar';
    return e;
  }
}

// Stolperdraht und Vertrag der Umgebung.
export function umgebung(env) {
  let schluessel;

  try {
    schluessel = Object.keys(env);
  } catch {
    throw new UmgebungFehler('pruefer-umgebung');
  }

  for (const k of schluessel) {
    if (/^NODE_/i.test(k)) {
      throw new UmgebungFehler('pruefer-umgebung-node');
    }

    if (!UMGEBUNG_PFLICHT.includes(k) && !UMGEBUNG_DOCKER.includes(k)) {
      throw new UmgebungFehler('pruefer-umgebung-fremd');
    }
  }

  const lies = k => {
    const d = Object.getOwnPropertyDescriptor(env, k);
    return d && typeof d.value === 'string' ? d.value : undefined;
  };

  if (!UMGEBUNG_PFLICHT.every(k => lies(k) !== undefined)) {
    throw new UmgebungFehler('pruefer-umgebung-fehlt');
  }

  if (lies('PATH') !== FESTER_PATH || lies('GITHUB_REPOSITORY') !== REPO) {
    throw new UmgebungFehler('pruefer-umgebung-wert');
  }

  const token = lies('A6_LESE_TOKEN');

  if (!/^[A-Za-z0-9_.-]{20,400}$/.test(token)) {
    throw new UmgebungFehler('pruefer-umgebung-token');
  }

  return Object.freeze({ token, laufText: lies('A6_PRUEFER_LAUF') });
}

// Ergebnisdatei: nur eine schon vorhandene, leere, gewoehnliche Datei ohne Link. Wirft bei jedem Problem.
export function schreibeErgebnis(text, pfad = ERGEBNIS_DATEI) {
  const vorher = lstatSync(pfad);

  if (!vorher.isFile() || vorher.size !== 0 || vorher.nlink !== 1) {
    throw new Error('ergebnisdatei');
  }

  const fd = openSync(pfad, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));

  try {
    const offen = fstatSync(fd);

    if (offen.ino !== vorher.ino || offen.dev !== vorher.dev) {
      throw new Error('ergebnisdatei');
    }

    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

// Liefert den Exitcode. ausgabe: stdout-Zeilen; fehler: stderr-Zeilen.
export async function main(env, {
  fetchImpl = globalThis.fetch, schlafe, ergebnisDatei = ERGEBNIS_DATEI, ausgabe = t => process.stdout.write(`${t}\n`),
  fehlerAusgabe = t => process.stderr.write(`${t}\n`), schreiben = schreibeErgebnis,
} = {}) {
  let u;

  try {
    u = umgebung(env);
  } catch (fehler) {
    fehlerAusgabe(`A6-FEHLER ${fehler instanceof UmgebungFehler ? fehler.code : 'pruefer-umgebung'}`);
    return 1;
  }

  let e;

  try {
    e = await pruefe({ transport: erzeugeTransport({ token: u.token, fetchImpl }), laufText: u.laufText, ...(schlafe ? { schlafe } : {}) });
  } catch (fehler) {
    fehlerAusgabe(`A6-FEHLER ${fehler instanceof TransportFehler ? fehler.code : 'pruefer-unerwartet'}`);
    return 1;
  }

  if (e.code === 'quelle-kein-auftrag') {
    ausgabe(`A6-PRUEFER kein Agenten-Auftrag lauf ${Number.isSafeInteger(e.lauf) ? e.lauf : 'unbekannt'} code quelle-kein-auftrag`);
    return 0;
  }

  const zeile = logzeile(e);
  const text = bericht(e);

  if (geheimnisTreffer(`${zeile}\n${text}`, u.token).length > 0) {
    // Kann aus festen Bausteinen nicht entstehen; dann weder Zeile noch Bericht.
    fehlerAusgabe('A6-FEHLER pruefer-geheimnis');
    return 1;
  }

  ausgabe(zeile);

  try {
    schreiben(text, ergebnisDatei);
  } catch {
    ausgabe('::warning title=A6-PRUEFER::bericht-nicht-geschrieben');
  }

  return 0;
}

// Ohne import.meta.main laesst sich Start und Import nicht unterscheiden: dann kontrolliert abbrechen.
if (import.meta.main === true) {
  process.exitCode = await main(process.env);
} else if (import.meta.main !== false) {
  process.stderr.write('A6-FEHLER pruefer-umgebung\n');
  process.exitCode = 1;
}
