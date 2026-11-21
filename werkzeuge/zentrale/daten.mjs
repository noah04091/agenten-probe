// B1.1 Command Center: API-Antworten auf das Anzeigemodell abbilden. Rein, ohne Netz, ohne Dateien.
// Uebernommen werden nur die Felder der Positivliste aus dem Entwicklungsauftrag, Abschnitt 5.

export const REPO = 'noah04091/agenten-probe';
export const EIGENTUEMER = 'noah04091';
export const STARTLABEL = 'bot-auftrag';
export const FRIST_MS = 60 * 60 * 1000;
export const ZUORDNUNG_MS = 60 * 1000;
export const PFLICHTCHECKS = Object.freeze(['build', 'tests', 'schutzdateien', 'agent-auftrag-sammel']);
export const ACTIONS_APP_ID = 15368;

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

  const treffer = kandidaten.filter(k => k.titel === lauf.titel && Array.isArray(k.freigaben)
    && k.freigaben.some(ms => ms <= lauf.start && lauf.start - ms <= ZUORDNUNG_MS));
  return treffer.length === 1 ? treffer[0] : null;
}

// Jobs 0 bis 3 nach Namen "Job <n> ...". Fehlt ein Job in der (vollstaendig geladenen) Liste: nicht gestartet.
// Doppelte Namen ergeben fuer diesen Job "unbekannt" (null).
export function jobsAus(jobs) {
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

  return ergebnis.map((j, n) => (gesehen[n] === 1 ? j : gesehen[n] === 0 ? { id: null, status: 'nicht-gestartet', conclusion: null } : null));
}

// Draft-PR zum Lauf: head.ref genau wp/<issue>-agent-<lauf>-1. Mehrere Treffer: null.
export function prZuLauf(pulls, issueNummer, laufId) {
  if (!Array.isArray(pulls) || !Number.isInteger(issueNummer)) {
    return null;
  }

  const ref = `wp/${issueNummer}-agent-${laufId}-1`;
  const treffer = pulls.filter(p => istObjekt(p) && istObjekt(p.head) && p.head.ref === ref && Number.isInteger(p.number));

  if (treffer.length !== 1) {
    return null;
  }

  const p = treffer[0];
  const zustand = typeof p.merged_at === 'string' ? 'gemergt' : p.state === 'open' ? (p.draft === true ? 'Draft offen' : 'offen') : p.state === 'closed' ? 'geschlossen' : 'unbekannt';
  return { nummer: p.number, url: text(p.html_url, 300), zustand, sha: /^[0-9a-f]{40}$/.test(p.head.sha ?? '') ? p.head.sha : null };
}

// Die vier Pflichtchecks am PR-Kopf, nur von GitHub Actions (app.id 15368). Fehlend: "fehlt"; mehrere
// Ergebnisse mit unterschiedlichem Ausgang: "uneinheitlich".
export function pflichtchecks(checkRuns) {
  if (!Array.isArray(checkRuns)) {
    return null;
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

// Monatssumme (UTC) aus den Laeufen. vollstaendig nur, wenn die Laufliste vollstaendig ist und fuer jeden Lauf
// mit gelaufenem Job 1 feststeht, ob es Kosten gibt.
export function monatsKosten(laeufe, jetzt, listeVollstaendig) {
  const m = monat(jetzt);
  let summe = 0;
  let mitKosten = 0;
  let ohneKosten = 0;
  let offen = false;

  for (const l of laeufe) {
    if (l.start === null || monat(l.start) !== m) {
      continue;
    }

    if (Number.isFinite(l.kosten)) {
      summe += l.kosten;
      mitKosten += 1;
    } else {
      ohneKosten += 1;

      if (l.kostenOffen) {
        offen = true;
      }
    }
  }

  return { monat: m, summe, mitKosten, ohneKosten, vollstaendig: listeVollstaendig === true && !offen };
}
