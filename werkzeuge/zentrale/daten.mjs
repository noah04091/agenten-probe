// B1.1 Command Center: API-Antworten auf das Anzeigemodell abbilden. Rein, ohne Netz, ohne Dateien.
// Uebernommen werden nur die Felder der Positivliste aus dem Entwicklungsauftrag, Abschnitt 5.

export const REPO = 'noah04091/agenten-probe';
export const EIGENTUEMER = 'noah04091';
export const STARTLABEL = 'bot-auftrag';
export const FRIST_MS = 60 * 60 * 1000;
export const ZUORDNUNG_MS = 60 * 1000;
export const PFLICHTCHECKS = Object.freeze(['build', 'tests', 'schutzdateien', 'agent-auftrag-sammel']);
export const ACTIONS_APP_ID = 15368;
// Codes, die Job 1a vor dem Start von Claude ausgibt (scripts/agent-code-auftrag.mjs). Der Claude-Schritt druckt die
// Kostenzeile, sobald Claude erfolgreich lief; steht einer dieser Codes ohne Kostenzeile im gelesenen Log von Job 1,
// ist belegt, dass Claude nicht lief.
export const CLAUDE_NICHT_GESTARTET = Object.freeze(['auftrag-label-start-fehlt', 'auftrag-freigabe-entzogen']);

const istObjekt = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (x, max = 300) => (typeof x === 'string' && x.length <= max ? x : null);
const zeit = x => {
  const ms = typeof x === 'string' ? Date.parse(x) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// Offene Issues mit genau einem agent:*-Label (PRs verworfen).
export function offeneAuftraege(issues) {
  if (!Array.isArray(issues)) {
    return null;
  }

  const ergebnis = [];

  for (const i of issues) {
    if (!istObjekt(i) || i.pull_request !== undefined || !Number.isInteger(i.number) || i.number < 1) {
      continue;
    }

    const labels = Array.isArray(i.labels) ? i.labels.map(l => (istObjekt(l) ? text(l.name, 100) : null)).filter(n => n !== null) : [];
    const profile = labels.filter(n => n.startsWith('agent:'));

    if (profile.length !== 1) {
      continue;
    }

    ergebnis.push({
      nummer: i.number,
      titel: text(i.title, 300) ?? '',
      url: text(i.html_url, 300),
      profil: profile[0].slice('agent:'.length),
      startlabel: labels.includes(STARTLABEL),
    });
  }

  return ergebnis;
}

// Startfreigaben: jedes labeled-Ereignis von bot-auftrag durch noah04091, aufsteigend nach Zeit.
export function startfreigaben(ereignisse) {
  if (!Array.isArray(ereignisse)) {
    return null;
  }

  return ereignisse
    .filter(e => istObjekt(e) && e.event === 'labeled' && istObjekt(e.label) && e.label.name === STARTLABEL
      && istObjekt(e.actor) && e.actor.login === EIGENTUEMER)
    .map(e => zeit(e.created_at))
    .filter(ms => ms !== null)
    .sort((a, b) => a - b);
}

// Laeufe aus Issue-Ereignissen: nur die Felder der Positivliste.
export function laeufeAus(runs) {
  if (!Array.isArray(runs)) {
    return null;
  }

  return runs.filter(r => istObjekt(r) && Number.isInteger(r.id) && r.id > 0).map(r => ({
    id: r.id,
    status: text(r.status, 40),
    conclusion: text(r.conclusion, 40),
    start: zeit(r.created_at),
    titel: text(r.display_title, 300),
    url: text(r.html_url, 300),
  }));
}

// Issue zum Lauf: Titel gleich display_title und genau ein Kandidat mit einem Startlabel-Ereignis von noah04091
// hoechstens 60 Sekunden vor dem Laufstart. Sonst null ("Issue unbekannt").
export function issueZuLauf(lauf, kandidaten) {
  if (!lauf || lauf.start === null || lauf.titel === null || !Array.isArray(kandidaten)) {
    return null;
  }

  const gleich = kandidaten.filter(k => k.titel === lauf.titel);

  // Ein Kandidat mit unbekannten Ereignissen koennte der richtige sein: dann nicht raten.
  if (gleich.some(k => !Array.isArray(k.freigaben))) {
    return null;
  }

  const treffer = gleich.filter(k => k.freigaben.some(ms => ms <= lauf.start && lauf.start - ms <= ZUORDNUNG_MS));
  return treffer.length === 1 ? treffer[0] : null;
}

// Jobs 0 bis 3 nach Namen "Job <n> ...". Fehlt ein Job in der vollstaendig geladenen Liste: nicht gestartet.
// Fehlt er in einer unvollstaendigen Liste, ist er unbekannt (null). Doppelte Namen ergeben ebenfalls null.
export function jobsAus(jobs, vollstaendig = true) {
  const ergebnis = [null, null, null, null];

  if (!Array.isArray(jobs)) {
    return ergebnis;
  }

  const gesehen = [0, 0, 0, 0];

  for (const j of jobs) {
    const m = istObjekt(j) && typeof j.name === 'string' ? /^Job ([0-3]) /.exec(j.name) : null;

    if (!m || !Number.isInteger(j.id)) {
      continue;
    }

    const n = Number(m[1]);
    gesehen[n] += 1;
    ergebnis[n] = { id: j.id, status: text(j.status, 40), conclusion: text(j.conclusion, 40) };
  }

  return ergebnis.map((j, n) => (gesehen[n] === 1 ? j : gesehen[n] === 0 && vollstaendig === true ? { id: null, status: 'nicht-gestartet', conclusion: null } : null));
}

// Draft-PR zum Lauf: head.ref genau wp/<issue>-agent-<lauf>-1. "Kein PR" (null) nur bei vollstaendiger Liste ohne
// Treffer. Mehrere Treffer: 'mehrdeutig'. Unvollstaendige oder unbrauchbare Liste: 'unbekannt' (ein Treffer oder ein
// zweiter koennte auf einer nicht geladenen Seite stehen).
export function prZuLauf(pulls, issueNummer, laufId, vollstaendig = true) {
  if (!Array.isArray(pulls) || !Number.isInteger(issueNummer)) {
    return 'unbekannt';
  }

  const ref = `wp/${issueNummer}-agent-${laufId}-1`;
  const treffer = pulls.filter(p => istObjekt(p) && istObjekt(p.head) && p.head.ref === ref && Number.isInteger(p.number));

  if (treffer.length > 1) {
    return 'mehrdeutig';
  }

  if (vollstaendig !== true) {
    return 'unbekannt';
  }

  if (treffer.length === 0) {
    return null;
  }

  const p = treffer[0];
  const zustand = typeof p.merged_at === 'string' ? 'gemergt' : p.state === 'open' ? (p.draft === true ? 'Draft offen' : 'offen') : p.state === 'closed' ? 'geschlossen' : 'unbekannt';
  return { nummer: p.number, url: text(p.html_url, 300), zustand, sha: /^[0-9a-f]{40}$/.test(p.head.sha ?? '') ? p.head.sha : null };
}

// Die vier Pflichtchecks am PR-Kopf, nur von GitHub Actions (app.id 15368). Fehlend: "fehlt"; mehrere
// Ergebnisse mit unterschiedlichem Ausgang: "uneinheitlich".
// Unvollstaendige Liste: jeder Check sichtbar unbekannt.
export function pflichtchecks(checkRuns, vollstaendig = true) {
  if (!Array.isArray(checkRuns)) {
    return null;
  }

  if (vollstaendig !== true) {
    return PFLICHTCHECKS.map(name => ({ name, ergebnis: 'unbekannt (Liste unvollständig)' }));
  }

  return PFLICHTCHECKS.map(name => {
    const eigene = checkRuns.filter(c => istObjekt(c) && c.name === name && istObjekt(c.app) && c.app.id === ACTIONS_APP_ID);
    const werte = [...new Set(eigene.map(c => (c.status === 'completed' ? (text(c.conclusion, 40) ?? 'unbekannt') : (text(c.status, 40) ?? 'unbekannt'))))];
    return { name, ergebnis: werte.length === 0 ? 'fehlt' : werte.length === 1 ? werte[0] : 'uneinheitlich' };
  });
}

// Restminuten bis 60 Minuten nach dem letzten Startlabel, abgerundet, nicht unter 0.
export function restMinuten(startlabelMs, jetzt) {
  if (!Number.isFinite(startlabelMs) || !Number.isFinite(jetzt)) {
    return null;
  }

  return Math.max(0, Math.floor((startlabelMs + FRIST_MS - jetzt) / 60000));
}

// Welcher Job wartet auf eine Environment-Freigabe: der erste Job 0 bis 3 mit Status waiting.
export function wartenderJob(jobs) {
  const n = jobs.findIndex(j => j !== null && j.status === 'waiting');
  return n >= 0 ? n : null;
}

// Wartende Freigaben eines Laufs aus pending_deployments.
export function freigabenAus(pending) {
  if (!Array.isArray(pending)) {
    return null;
  }

  return pending.filter(p => istObjekt(p) && istObjekt(p.environment)).map(p => ({
    environment: text(p.environment.name, 100) ?? 'unbekannt',
    kannFreigeben: p.current_user_can_approve === true,
  }));
}

export function monat(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Kosten eines Laufs aus Job 1: { kosten, runden, offen, grund }. offen heisst: nicht belegt, ob und wie viel Claude
// gekostet hat. "Keine Kosten" (kosten null, offen false) nur mit Beleg: Job 1 uebersprungen; Job 1 in der
// vollstaendigen Jobliste eines abgeschlossenen Laufs nie gestartet; oder Job-1-Log gelesen, ohne Kostenzeile, mit
// einem Code aus CLAUDE_NICHT_GESTARTET. auszug: Ergebnis von logAuszug, null bei gescheitertem Abruf.
// B1.1a, grund bei offen: 'abruf' (Job 1 unbekannt, weil die Jobliste fehlt oder unvollstaendig ist, oder das Log nicht
// ladbar war) oder 'beleg' (alles geladen, aber kein Kostenbeleg: Log ohne Kostenzeile, Job 1 oder Lauf noch nicht
// abgeschlossen). Bei belegten Werten ist grund null. Wartende oder laufende Jobs gelten nie als kostenfrei.
export function kostenAusJob1(lauf, job1, auszug) {
  const offen = grund => ({ kosten: null, runden: null, offen: true, grund });
  const keine = { kosten: null, runden: null, offen: false, grund: null };

  if (!istObjekt(job1)) {
    return offen('abruf');
  }

  if (job1.status === 'nicht-gestartet') {
    return istObjekt(lauf) && lauf.status === 'completed' ? keine : offen('beleg');
  }

  if (job1.status !== 'completed') {
    return offen('beleg');
  }

  if (job1.conclusion === 'skipped') {
    return keine;
  }

  if (!istObjekt(auszug)) {
    return offen('abruf');
  }

  if (Number.isFinite(auszug.kosten)) {
    return { kosten: auszug.kosten, runden: Number.isInteger(auszug.runden) ? auszug.runden : null, offen: false, grund: null };
  }

  return CLAUDE_NICHT_GESTARTET.includes(auszug.code) ? keine : offen('beleg');
}

// Monatssumme (UTC) aus den Laeufen. vollstaendig nur, wenn die Laufliste vollstaendig ist, jeder Lauf eine
// Startzeit hat und fuer jeden Lauf des Monats belegt ist, ob er Kosten hatte (kostenOffen === false).
// B1.1a: drei ueberschneidungsfreie Zahlen fuer die Laeufe des Monats: mitKosten (Kostenwert belegt),
// belegtOhneKosten (kostenOffen === false, kein Kostenwert) und kostenUnbekannt (alle uebrigen). Von den unbekannten
// zaehlt ohneBeleg die mit grund 'beleg'; abrufOffen ist true, wenn ein Lauf aus einem anderen Grund offen ist
// (Abruf, fehlender Grund) oder ohne Startzeit dasteht. Nur abrufOffen und eine unvollstaendige Laufliste sind
// Abruffehler; fehlende Belege machen die Summe unvollstaendig, aber nicht zum Abruffehler.
export function monatsKosten(laeufe, jetzt, listeVollstaendig) {
  const m = monat(jetzt);
  let summe = 0;
  let mitKosten = 0;
  let belegtOhneKosten = 0;
  let kostenUnbekannt = 0;
  let ohneBeleg = 0;
  let abrufOffen = false;

  for (const l of laeufe) {
    if (!Number.isFinite(l.start)) {
      abrufOffen = true;
      continue;
    }

    if (monat(l.start) !== m) {
      continue;
    }

    if (Number.isFinite(l.kosten)) {
      summe += l.kosten;
      mitKosten += 1;
    } else if (l.kostenOffen === false) {
      belegtOhneKosten += 1;
    } else {
      kostenUnbekannt += 1;

      if (l.kostenGrund === 'beleg') {
        ohneBeleg += 1;
      } else {
        abrufOffen = true;
      }
    }
  }

  return {
    monat: m, summe, mitKosten, belegtOhneKosten, kostenUnbekannt, ohneBeleg, abrufOffen,
    vollstaendig: listeVollstaendig === true && !abrufOffen && kostenUnbekannt === 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// B1.3 Ablaufwarnungen. Rein, ohne Netz, ohne Dateien. Gerechnet wird in UTC ab der Erzeugungszeit der Seite.
// ---------------------------------------------------------------------------------------------------------------------

const TAG = 24 * 60 * 60 * 1000;
export const FRIST_OK_MS = 14 * TAG;
export const FRIST_HINWEIS_MS = 7 * TAG;
export const FRIST_DRINGEND_MS = 2 * TAG;
export const MANUELL_PRUEFEN_MS = 45 * TAG;
export const FRISTEN_SCHEMA = 'zentrale-fristen-v1';
export const FRISTEN_MAX = 10;
export const FRIST_NAME_MAX = 60;

// Die drei Zugaenge, immer alle angezeigt. Der Handgriff ist ein Satz ohne Tokenwert und ohne Pfad zu einem Geheimnis.
export const ZUGAENGE = Object.freeze([
  Object.freeze({
    zugang: 'lese-token', name: 'Lese-Token der Zentrale', quelle: 'github',
    handgriff: 'Neues Lese-Token auf GitHub anlegen (nicht „Regenerate“), die Token-Datei der Zentrale ersetzen, Zentrale neu starten, danach das alte Token löschen.',
  }),
  Object.freeze({
    zugang: 'bot-token', name: 'Bot-Token noah04091-agent', quelle: 'manuell',
    handgriff: 'Neues Token für noah04091-agent anlegen (nicht „Regenerate“), in der Windows-Anmeldeinformationsverwaltung eintragen, Terminal 2 neu starten, danach das alte löschen und den Ablauf in fristen.json nachtragen.',
  }),
  Object.freeze({
    zugang: 'anthropic-schluessel', name: 'Anthropic-Schlüssel', quelle: 'manuell',
    handgriff: 'Neuen Schlüssel in der Anthropic-Konsole anlegen, bei GitHub als Secret hinterlegen, danach den alten löschen und den Ablauf in fristen.json nachtragen.',
  }),
]);

// Stufe einer Frist. ablauf und eingetragenAm in Millisekunden. Schwellen: mehr als 14 Tage ok; mehr als 7 Tage
// Hinweis; mindestens 2 Tage Warnung; darunter dringend; ab 0 abgelaufen. Ohne belegten Ablauf: unbekannt.
// pruefen: manuelle Angabe, deren Eintrag aelter als 45 Tage ist.
export function fristStufe(ablauf, jetzt, quelle, eingetragenAm) {
  const pruefen = quelle === 'manuell' && Number.isFinite(eingetragenAm) && Number.isFinite(jetzt) && jetzt - eingetragenAm > MANUELL_PRUEFEN_MS;

  if (!Number.isFinite(ablauf) || !Number.isFinite(jetzt)) {
    return { stufe: 'unbekannt', restMs: null, pruefen };
  }

  const rest = ablauf - jetzt;
  const stufe = rest <= 0 ? 'abgelaufen' : rest < FRIST_DRINGEND_MS ? 'dringend' : rest <= FRIST_HINWEIS_MS ? 'warnung' : rest <= FRIST_OK_MS ? 'hinweis' : 'ok';
  return { stufe, restMs: rest, pruefen };
}

// Datum aus fristen.json: "JJJJ-MM-TT" (Tagesgenauigkeit, gerechnet ab 00:00 UTC) oder "JJJJ-MM-TTThh:mm:ssZ".
// Ergebnis { ms, tagesgenau } oder null bei jeder anderen Form oder einem ungueltigen Kalenderdatum.
export function fristDatum(wert, { nurTag = false } = {}) {
  if (typeof wert !== 'string' || wert.length > 20) {
    return null;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z)?$/.exec(wert);

  if (!m || (nurTag && m[4] !== undefined)) {
    return null;
  }

  const [j, mo, t] = [m[1], m[2], m[3]].map(Number);
  const [h, mi, s] = m[4] === undefined ? [0, 0, 0] : [m[4], m[5], m[6]].map(Number);
  const ms = Date.UTC(j, mo - 1, t, h, mi, s);
  const d = new Date(ms);
  const gleich = d.getUTCFullYear() === j && d.getUTCMonth() === mo - 1 && d.getUTCDate() === t && d.getUTCHours() === h && d.getUTCMinutes() === mi && d.getUTCSeconds() === s;
  return gleich && j >= 2000 && j <= 2199 ? { ms, tagesgenau: m[4] === undefined } : null;
}

const istReinesObjekt = x => istObjekt(x) && Object.getPrototypeOf(x) === Object.prototype;
const genauSchluessel = (o, schluessel) => Object.keys(o).length === schluessel.length && schluessel.every(k => Object.hasOwn(o, k));

// Inhalt von fristen.json pruefen. Ergebnis { ok: true, fristen: { 'bot-token'?: {...}, 'anthropic-schluessel'?: {...} } }
// oder { ok: false, grund }. Jede Abweichung lehnt die ganze Datei ab; der Grund nennt nie einen Wert aus der Datei.
export function fristenAusJson(text) {
  const ab = grund => ({ ok: false, grund });
  let roh;

  try {
    roh = JSON.parse(text);
  } catch {
    return ab('kein gültiges JSON');
  }

  if (!istReinesObjekt(roh) || !genauSchluessel(roh, ['schema', 'fristen']) || roh.schema !== FRISTEN_SCHEMA) {
    return ab('falsches Schema');
  }

  if (!Array.isArray(roh.fristen) || roh.fristen.length > FRISTEN_MAX) {
    return ab(`höchstens ${FRISTEN_MAX} Einträge`);
  }

  const fristen = {};

  for (const f of roh.fristen) {
    if (!istReinesObjekt(f) || !genauSchluessel(f, ['zugang', 'name', 'ablauf', 'eingetragen'])) {
      return ab('Eintrag mit fehlenden oder zusätzlichen Feldern');
    }

    if (f.zugang !== 'bot-token' && f.zugang !== 'anthropic-schluessel') {
      return ab('unbekannter Zugang');
    }

    if (Object.hasOwn(fristen, f.zugang)) {
      return ab('Zugang doppelt');
    }

    if (typeof f.name !== 'string' || f.name.length === 0 || f.name.length > FRIST_NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(f.name)) {
      return ab('ungültiger Name');
    }

    const ablauf = fristDatum(f.ablauf);
    const eingetragen = fristDatum(f.eingetragen, { nurTag: true });

    if (ablauf === null || eingetragen === null) {
      return ab('ungültiges Datum');
    }

    fristen[f.zugang] = { name: f.name, ablauf: ablauf.ms, tagesgenau: ablauf.tagesgenau, eingetragenAm: eingetragen.ms };
  }

  return { ok: true, fristen };
}

// Fristen fuer die Seite: immer alle drei Zugaenge.
// leseToken: { ablauf, gemeldetAm } aus der erfolgreichen Startpruefung (ablauf null, wenn der Kopf fehlte).
// letzteMeldung: der zuletzt gespeicherte Wert aus dem Cache ({ ablauf, gemeldetAm }) oder null.
// datei: Ergebnis von ladeFristen ({ status: 'ok' | 'fehlt' | 'ungueltig', fristen?, grund? }).
export function fristenModell({ jetzt, leseToken, letzteMeldung = null, datei }) {
  const eintraege = ZUGAENGE.map(z => {
    const basis = { zugang: z.zugang, name: z.name, quelle: z.quelle, handgriff: z.handgriff };

    if (z.quelle === 'github') {
      const ablauf = Number.isFinite(leseToken?.ablauf) ? leseToken.ablauf : null;
      const s = fristStufe(ablauf, jetzt, 'github', null);
      const historisch = ablauf === null && Number.isFinite(letzteMeldung?.ablauf) && Number.isFinite(letzteMeldung?.gemeldetAm) ? { ...letzteMeldung } : null;
      return {
        ...basis, ...s, ablauf, tagesgenau: false, gemeldetAm: ablauf === null ? null : leseToken.gemeldetAm, historisch,
        grund: ablauf === null ? 'GitHub hat in der Startprüfung kein Ablaufdatum gemeldet' : null,
      };
    }

    const f = datei?.status === 'ok' ? datei.fristen?.[z.zugang] : undefined;

    if (!f) {
      const grund = datei?.status === 'ok' ? 'kein Eintrag in fristen.json'
        : datei?.status === 'fehlt' ? 'keine manuellen Fristen (fristen.json fehlt)' : `fristen.json ungültig${datei?.grund ? `: ${datei.grund}` : ''}`;
      return { ...basis, stufe: 'unbekannt', restMs: null, pruefen: false, ablauf: null, tagesgenau: false, eingetragenAm: null, grund };
    }

    return { ...basis, name: f.name, ...fristStufe(f.ablauf, jetzt, 'manuell', f.eingetragenAm), ablauf: f.ablauf, tagesgenau: f.tagesgenau, eingetragenAm: f.eingetragenAm, grund: null };
  });

  return { erzeugt: jetzt, datei: datei?.status ?? 'ungueltig', eintraege };
}

// ---------------------------------------------------------------------------------------------------------------------
// B1.3c Laufwarnungen. Rein, ohne Netz, ohne Dateien. Nur Daten, die die Zentrale ohnehin liest: Laeufe mit Status,
// Issue-Ereignisse der zugeordneten Issues, alle PRs. Fehlende oder widerspruechliche Daten sind nie eine Entwarnung,
// sondern ein Eintrag "nicht pruefbar". Die Zentrale vergleicht keinen main-Stand mit dem Ausgangscommit eines Laufs.
// ---------------------------------------------------------------------------------------------------------------------

export const LAUFEND = Object.freeze(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
export const LABEL_MUSTER = /^[a-z0-9:_-]{1,50}$/;
const ISO_ZEIT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// Zeitpunkt aus einem GitHub-Zeitstempel (nur ISO 8601 in UTC, Jahr 2000 bis 2199), sonst null.
export function strengeZeit(x) {
  if (typeof x !== 'string' || !ISO_ZEIT.test(x)) {
    return null;
  }

  const ms = Date.parse(x);
  return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2200, 0, 1) ? ms : null;
}

const gueltigerStart = ms => Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2200, 0, 1);

// P1: Labelaenderungen (labeled, unlabeled) strikt nach dem Laufstart, aufsteigend. Name nur nach LABEL_MUSTER, sonst
// null ("ein Label"). null, wenn die Ereignisliste fehlt, ein Eintrag unbrauchbar ist oder ein Labelereignis keine
// gueltige Zeit hat.
export function labelAenderungen(ereignisse, start) {
  if (!Array.isArray(ereignisse) || !gueltigerStart(start)) {
    return null;
  }

  const r = [];

  for (const e of ereignisse) {
    if (!istObjekt(e) || typeof e.event !== 'string') {
      return null;
    }

    if (e.event !== 'labeled' && e.event !== 'unlabeled') {
      continue;
    }

    const ms = strengeZeit(e.created_at);

    if (ms === null) {
      return null;
    }

    if (ms > start) {
      const name = istObjekt(e.label) && typeof e.label.name === 'string' && LABEL_MUSTER.test(e.label.name) ? e.label.name : null;
      r.push({ zeit: ms, label: name });
    }
  }

  return r.sort((a, b) => a.zeit - b.zeit);
}

// P2: PRs mit Basis main. { ok: false }, wenn die Liste fehlt oder unvollstaendig ist oder ein PR keine verlaessliche
// Basis, Nummer, keinen verlaesslichen Zustand oder kein verlaessliches merged_at hat (null oder gueltige Zeit).
// Sonst { ok: true, offen: [Nummern], gemergt: [{ nummer, zeit }] }.
export function prsNachMain(pulls, vollstaendig) {
  if (!Array.isArray(pulls) || vollstaendig !== true) {
    return { ok: false };
  }

  const offen = [];
  const gemergt = [];

  for (const p of pulls) {
    if (!istObjekt(p) || !Number.isInteger(p.number) || p.number < 1 || !istObjekt(p.base) || typeof p.base.ref !== 'string') {
      return { ok: false };
    }

    if (p.base.ref !== 'main') {
      continue;
    }

    if (p.merged_at !== null) {
      const ms = strengeZeit(p.merged_at);

      if (ms === null) {
        return { ok: false };
      }

      gemergt.push({ nummer: p.number, zeit: ms });
    } else if (p.state === 'open') {
      offen.push(p.number);
    } else if (p.state !== 'closed') {
      return { ok: false };
    }
  }

  return { ok: true, offen: offen.sort((a, b) => a - b), gemergt };
}

// Laufwarnungen fuer die Seite. laeufe: [{ lauf, issue }] mit lauf aus laeufeAus und issue als eindeutig zugeordnetem
// Issue ({ nummer, ereignisse }, ereignisse null, wenn nicht vollstaendig gelesen) oder null; null fuer laeufe heisst
// "Laufliste nicht gelesen". Ergebnis: Liste von Eintraegen
//   { art: 'label', laufId, issue, zeit, label, weitere }       P1, Risikohinweis
//   { art: 'gemergt', laufId, issue, prs }                      P2 eingetreten, hat Vorrang vor 'offen'
//   { art: 'offen', laufId, issue, prs }                        P2 moeglicher Konflikt
//   { art: 'nicht-pruefbar', laufId?, quelle }                  Daten fehlen oder widersprechen sich
// Kein laufender Lauf und alles gelesen: leere Liste.
export function laufwarnungen({ laeufe, laeufeVollstaendig, pulls, pullsVollstaendig }) {
  const nicht = (quelle, laufId = null) => ({ art: 'nicht-pruefbar', laufId, quelle });

  if (!Array.isArray(laeufe)) {
    return [nicht('Läufe nicht gelesen')];
  }

  const w = [];

  if (laeufeVollstaendig !== true) {
    w.push(nicht('Laufliste unvollständig'));
  }

  const laufend = [];

  for (const k of laeufe) {
    const l = k?.lauf;

    if (!istObjekt(l) || l.status === 'completed') {
      continue;
    }

    if (!LAUFEND.includes(l.status)) {
      w.push(nicht(`Status von Lauf ${l.id} unbekannt`, l.id));
      continue;
    }

    laufend.push({ lauf: l, issue: istObjekt(k.issue) ? k.issue : null });
  }

  if (laufend.length === 0) {
    return w;
  }

  const prs = prsNachMain(pulls, pullsVollstaendig);

  for (const { lauf: l, issue } of laufend) {
    const nummer = issue && Number.isInteger(issue.nummer) ? issue.nummer : null;

    if (!gueltigerStart(l.start)) {
      w.push(nicht(`Laufstart von Lauf ${l.id} fehlt oder ist ungültig`, l.id));
      continue;
    }

    // P1 nur bei eindeutiger Zuordnung und vollstaendig gelesenen Ereignissen.
    if (nummer === null) {
      w.push(nicht(`Lauf ${l.id} keinem Issue eindeutig zugeordnet`, l.id));
    } else {
      const aenderungen = labelAenderungen(issue.ereignisse, l.start);

      if (aenderungen === null) {
        w.push(nicht(`Ereignisse von #${nummer} nicht vollständig lesbar`, l.id));
      } else if (aenderungen.length > 0) {
        w.push({ art: 'label', laufId: l.id, issue: nummer, zeit: aenderungen[0].zeit, label: aenderungen[0].label, weitere: aenderungen.length - 1 });
      }
    }

    // P2
    if (!prs.ok) {
      w.push(nicht('PRs nicht vollständig lesbar', l.id));
      continue;
    }

    const danach = prs.gemergt.filter(p => p.zeit > l.start).map(p => p.nummer).sort((a, b) => a - b);

    if (danach.length > 0) {
      w.push({ art: 'gemergt', laufId: l.id, issue: nummer, prs: danach });
    } else if (prs.offen.length > 0) {
      w.push({ art: 'offen', laufId: l.id, issue: nummer, prs: [...prs.offen] });
    }
  }

  return w;
}
