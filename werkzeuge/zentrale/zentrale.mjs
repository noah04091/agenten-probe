// B1.1 Command Center: Einstieg. Token laden, Daten nur lesend holen, Seite erzeugen, schreiben.
//
//   node werkzeuge/zentrale/zentrale.mjs              einmal erzeugen
//   node werkzeuge/zentrale/zentrale.mjs --schleife   alle 120 Sekunden neu erzeugen (Ende mit Strg+C)
//
// Ausgabe %USERPROFILE%\.zentrale\zentrale.html (ueber eine Nebendatei und Umbenennen). Cache
// %USERPROFILE%\.zentrale\cache.json nur mit ausgezogenen Werten abgeschlossener Jobs, nie Rohtext. Die Zentrale
// schreibt nie auf GitHub. Exitcode 1 ohne Seite bei Token-Fehler, gescheiterter Startpruefung oder Geheimnis-Treffer.
// Die Seite ist eine Momentaufnahme. Nur mit --schleife laedt der Browser sie neu; endet die Schleife (Strg+C oder
// gescheiterter Durchlauf), wird die letzte Seite ohne Neuladen und mit Hinweis auf das Ende neu geschrieben.

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  REPO, freigabenAus, issueZuLauf, jobsAus, kostenAusJob1, laeufeAus, monatsKosten, offeneAuftraege, pflichtchecks, prZuLauf, restMinuten,
  startfreigaben, wartenderJob,
} from './daten.mjs';
import { geheimnisTreffer, seite } from './darstellung.mjs';
import { erzeugeLeser } from './github-lesen.mjs';
import { logAuszug } from './log-auszug.mjs';
import { leseSitzungen } from './sitzungen-meta.mjs';
import { ladeToken } from './token.mjs';

export const ORDNER = join(homedir(), '.zentrale');
export const AUSGABE = join(ORDNER, 'zentrale.html');
export const CACHE = join(ORDNER, 'cache.json');
export const SITZUNGS_UEBERSICHT = join(homedir(), 'Documents', 'claude-werkzeuge', 'sitzungen.html');
export const SCHLEIFE_MS = 120_000;
const TAG_MS = 24 * 60 * 60 * 1000;
const R = `/repos/${REPO}`;

// Cache: nur { jobId: { code, runden, kosten } } mit festen Formen; alles andere wird verworfen.
export function cacheBereinigt(roh) {
  const sauber = {};

  if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) {
    return sauber;
  }

  for (const [id, w] of Object.entries(roh).slice(0, 5000)) {
    if (!/^\d{1,15}$/.test(id) || typeof w !== 'object' || w === null) {
      continue;
    }

    const code = w.code === null || (typeof w.code === 'string' && /^[a-z0-9-]{1,60}$/.test(w.code)) ? w.code : undefined;
    const runden = w.runden === null || (Number.isInteger(w.runden) && w.runden >= 0 && w.runden < 1000) ? w.runden : undefined;
    const kosten = w.kosten === null || (Number.isFinite(w.kosten) && w.kosten >= 0) ? w.kosten : undefined;

    if (code !== undefined && runden !== undefined && kosten !== undefined) {
      sauber[id] = { code, runden, kosten };
    }
  }

  return sauber;
}

function seitDatum(jetzt) {
  const d = new Date(jetzt);
  const monatsanfang = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return new Date(Math.min(jetzt - 30 * TAG_MS, monatsanfang)).toISOString().slice(0, 10);
}

// Holt alles fuer die Seite. Liefert das Modell und den neuen Cache. Wirft nie wegen GitHub-Antworten.
export async function sammle({ leser, jetzt, cache = {}, sitzungen }) {
  const neuerCache = { ...cache };
  const b = {};
  const fehl = grund => ({ stand: null, fehlschlag: jetzt, grund, eintraege: [] });

  // --- Bereich 1: offene Auftraege -----------------------------------------------------------------------------
  const offen = await leser.holeAlleSeiten(`${R}/issues?state=open&per_page=100`);
  const offeneListe = offen.klasse === 'ok' ? offeneAuftraege(offen.daten) : null;

  if (offeneListe === null) {
    b.auftraege = fehl(offen.grund ?? 'unerwartete Antwort');
  } else {
    let teil = !offen.vollstaendig;

    for (const a of offeneListe) {
      const ev = await leser.holeAlleSeiten(`${R}/issues/${a.nummer}/events?per_page=100`);
      const f = ev.klasse === 'ok' && ev.vollstaendig ? startfreigaben(ev.daten) : null;
      a.freigaben = f === null ? null : f.length;
      const abn = await leser.holeJson(`${R}/contents/agent-acceptance/issue-${a.nummer}.mjs?ref=main`);
      a.abnahme = abn.klasse === 'ok' ? 'vorhanden' : abn.klasse === 'fehlt' ? 'fehlt' : 'unbekannt';
      teil ||= f === null || a.abnahme === 'unbekannt';
    }

    b.auftraege = { stand: jetzt, fehlschlag: null, teilFehler: teil ? jetzt : null, eintraege: offeneListe };
  }

  // --- Bereich 2 und 3: Laeufe, Freigaben ----------------------------------------------------------------------
  const seit = seitDatum(jetzt);
  const runs = await leser.holeAlleSeiten(`${R}/actions/workflows/agent-auftrag.yml/runs?event=issues&per_page=100&created=%3E%3D${seit}`, { feld: 'workflow_runs' });
  const laeufe = runs.klasse === 'ok' ? laeufeAus(runs.daten) : null;
  const probe = await leser.holeJson(`${R}/actions/workflows/agent-auftrag.yml/runs?event=pull_request&per_page=1&created=%3E%3D${new Date(jetzt - 30 * TAG_MS).toISOString().slice(0, 10)}`);
  const generalprobe = probe.klasse === 'ok' && Number.isInteger(probe.daten?.total_count) ? probe.daten.total_count : null;

  if (laeufe === null) {
    b.laeufe = fehl(runs.grund ?? 'unerwartete Antwort');
    b.freigaben = fehl(runs.grund ?? 'unerwartete Antwort');
    b.kosten = fehl(runs.grund ?? 'unerwartete Antwort');
  } else {
    let teil = !runs.vollstaendig || generalprobe === null;

    // Kandidaten fuer die Issue-Zuordnung: alle Issues, deren Titel einem Lauftitel gleicht. Nur eine vollstaendige
    // Kandidatenliste traegt eine Zuordnung; sonst bleibt jedes Issue "unbekannt" und der Bereich sagt es.
    const alle = await leser.holeAlleSeiten(`${R}/issues?state=all&per_page=100`);
    const titel = new Set(laeufe.map(l => l.titel));
    const kandidaten = [];
    const kandidatenVollstaendig = alle.klasse === 'ok' && alle.vollstaendig === true;

    if (alle.klasse === 'ok') {
      for (const i of alle.daten) {
        if (i && i.pull_request === undefined && Number.isInteger(i.number) && titel.has(i.title)) {
          const ev = await leser.holeAlleSeiten(`${R}/issues/${i.number}/events?per_page=100`);
          const evOk = ev.klasse === 'ok' && ev.vollstaendig === true;
          kandidaten.push({ nummer: i.number, titel: i.title, url: typeof i.html_url === 'string' ? i.html_url : null, freigaben: evOk ? startfreigaben(ev.daten) : null });
          teil ||= !evOk;
        }
      }
    }

    teil ||= !kandidatenVollstaendig;
    const pulls = await leser.holeAlleSeiten(`${R}/pulls?state=all&per_page=100`);
    const pullsVollstaendig = pulls.klasse === 'ok' && pulls.vollstaendig === true;
    const freigaben = [];
    const eintraege = [];

    for (const l of laeufe) {
      const jr = await leser.holeAlleSeiten(`${R}/actions/runs/${l.id}/jobs?per_page=100`, { feld: 'jobs' });
      const jobs = jr.klasse === 'ok' ? jobsAus(jr.daten, jr.vollstaendig === true) : [null, null, null, null];
      teil ||= jr.klasse !== 'ok' || jr.vollstaendig !== true;
      const codes = [];
      let auszug1;

      for (const [n, j] of jobs.entries()) {
        // Job 0 nur, wenn er rot endete (sonst hat er keinen Fehlercode); Jobs 1 bis 3, wenn abgeschlossen.
        if (j === null || j.status !== 'completed' || j.conclusion === 'skipped' || (n === 0 && j.conclusion !== 'failure')) {
          continue;
        }

        let auszug = neuerCache[String(j.id)];

        if (auszug === undefined) {
          const log = await leser.holeLog(j.id);

          if (log.klasse === 'ok') {
            auszug = logAuszug(log.text);
            neuerCache[String(j.id)] = { code: auszug.code, runden: auszug.runden, kosten: auszug.kosten };
          } else {
            auszug = null;
            teil = true;
          }
        }

        if (auszug && auszug.code !== null) {
          codes.push(auszug.code);
        }

        if (n === 1) {
          auszug1 = auszug;
        }
      }

      // Kosten nur mit Beleg; ein gescheiterter Abruf, ein laufender oder unbekannter Job 1 lassen sie offen.
      const k1 = kostenAusJob1(l, jobs[1], auszug1);
      const issue = kandidatenVollstaendig ? issueZuLauf(l, kandidaten) : null;
      let pr = null;

      // "Kein PR" nur, wenn Job 3 belegt nie lief (uebersprungen oder nie gestartet). Sonst wird gesucht, und jede
      // Unsicherheit (Issue, Liste, mehrere Treffer) bleibt sichtbar.
      const j3 = jobs[3];
      const ohneJob3 = j3 !== null && (j3.status === 'nicht-gestartet' || j3.conclusion === 'skipped');

      if (!ohneJob3) {
        const p = issue === null || pulls.klasse !== 'ok' ? 'unbekannt' : prZuLauf(pulls.daten, issue.nummer, l.id, pullsVollstaendig);

        if (p !== null && typeof p === 'object') {
          const cr = p.sha ? await leser.holeAlleSeiten(`${R}/commits/${p.sha}/check-runs?per_page=100`, { feld: 'check_runs' }) : { klasse: 'unbekannt' };
          pr = { ...p, checks: cr.klasse === 'ok' ? pflichtchecks(cr.daten, cr.vollstaendig === true) : [{ name: 'Pflichtchecks', ergebnis: 'unbekannt' }] };
          teil ||= cr.klasse !== 'ok' || cr.vollstaendig !== true;
        } else {
          pr = p;
          teil ||= p !== null;
        }
      }

      if (l.status === 'waiting') {
        const pd = await leser.holeJson(`${R}/actions/runs/${l.id}/pending_deployments`);
        const envs = pd.klasse === 'ok' ? freigabenAus(pd.daten) : null;
        const label = issue?.freigaben?.filter(ms => ms <= l.start).at(-1);
        const job = wartenderJob(jobs);
        teil ||= envs === null;

        for (const e of envs ?? [{ environment: 'unbekannt' }]) {
          freigaben.push({ laufId: l.id, url: l.url, environment: e.environment, job, restMinuten: restMinuten(label, jetzt) });
        }
      }

      eintraege.push({
        id: l.id, url: l.url, start: l.start, issue: issue ? { nummer: issue.nummer, url: issue.url } : null, jobs,
        code: codes.length === 0 ? null : codes.length === 1 ? codes[0] : 'mehrdeutig', kosten: k1.kosten, runden: k1.runden, pr, kostenOffen: k1.offen,
      });
    }

    const stempel = teil ? jetzt : null;
    const summe = monatsKosten(eintraege, jetzt, runs.vollstaendig === true);
    b.laeufe = { stand: jetzt, fehlschlag: null, teilFehler: stempel, eintraege, generalprobe, unvollstaendig: runs.vollstaendig !== true, kandidatenUnvollstaendig: !kandidatenVollstaendig };
    b.freigaben = { stand: jetzt, fehlschlag: null, teilFehler: stempel, eintraege: freigaben };
    b.kosten = { stand: jetzt, fehlschlag: null, teilFehler: summe.vollstaendig ? null : jetzt, ...summe };
  }

  // --- Bereich 4: Sitzungen -------------------------------------------------------------------------------------
  const s = sitzungen();
  b.sitzungen = s.ok ? { stand: jetzt, fehlschlag: null, eintraege: s.eintraege } : fehl(s.grund);
  return { modell: { erzeugt: jetzt, bereiche: b }, cache: neuerCache };
}

// Neuer Stand je Bereich; ist ein Bereich gescheitert, bleiben die alten Werte mit altem Stand erhalten und der
// Bereich zeigt "Abruf fehlgeschlagen" (darstellung.mjs zeigt dann keine Werte).
export function zusammenfuehren(vorher, neu) {
  if (!vorher) {
    return neu;
  }

  const bereiche = {};

  for (const [k, v] of Object.entries(neu.bereiche)) {
    bereiche[k] = v.stand === null && vorher.bereiche[k] ? { ...vorher.bereiche[k], fehlschlag: v.fehlschlag, grund: v.grund } : v;
  }

  return { ...neu, bereiche };
}

// Atomar schreiben: Nebendatei, dann Umbenennen.
export function schreibeAtomar(datei, inhalt, fsImpl = fs) {
  const neben = `${datei}.neu`;
  fsImpl.writeFileSync(neben, inhalt, { encoding: 'utf8', mode: 0o600 });
  fsImpl.renameSync(neben, datei);
}

function cacheLaden(fsImpl, datei) {
  try {
    return cacheBereinigt(JSON.parse(fsImpl.readFileSync(datei, 'utf8')));
  } catch {
    return {};
  }
}

// Seite pruefen und schreiben. Liefert null bei Erfolg, sonst die Liste der Geheimnis-Treffer.
function seiteSchreiben({ modell, jetzt, token, fsImpl, ordner, modus }) {
  const html = seite(modell, jetzt, modus);
  const treffer = geheimnisTreffer(html, token);

  if (treffer.length > 0) {
    return treffer;
  }

  fsImpl.mkdirSync(ordner, { recursive: true });
  schreibeAtomar(join(ordner, 'zentrale.html'), html, fsImpl);
  return null;
}

// Ende des Schleifenbetriebs: die letzte Seite ohne Neuladen und mit Hinweis auf das Ende neu schreiben, damit die
// Datei nach dem Ende keine laufende Aktualisierung vortaeuscht. Wirft nie.
export function schleifeBeenden({ modell, token, um, grund, fsImpl = fs, ordner = ORDNER }) {
  if (!modell) {
    return false;
  }

  try {
    return seiteSchreiben({ modell, jetzt: um, token, fsImpl, ordner, modus: { schleife: true, beendet: { um, grund } } }) === null;
  } catch {
    return false;
  }
}

// Ein Durchlauf. Liefert { exitcode, meldung, modell }. schleife: Seite mit Neuladen und Faelligkeit (nur in --schleife).
export async function durchlauf({
  token, leser, jetzt, vorher = null, fsImpl = fs, ordner = ORDNER, sitzungen = () => leseSitzungen(), uebersicht = SITZUNGS_UEBERSICHT,
  schleife = false,
}) {
  const start = await leser.holeJson(`/repos/${REPO}`);

  if (start.klasse !== 'ok') {
    return { exitcode: 1, meldung: `Startprüfung fehlgeschlagen: GET /repos/${REPO} lieferte nicht 200 (${start.grund ?? start.klasse})` };
  }

  const cacheDatei = join(ordner, 'cache.json');
  const { modell: neu, cache } = await sammle({ leser, jetzt, cache: cacheLaden(fsImpl, cacheDatei), sitzungen });
  const modell = zusammenfuehren(vorher, neu);
  modell.sitzungsUebersicht = fsImpl.existsSync(uebersicht) ? pathToFileURL(uebersicht).href : null;
  const treffer = seiteSchreiben({ modell, jetzt, token, fsImpl, ordner, modus: { schleife } });

  if (treffer !== null) {
    return { exitcode: 1, meldung: `Seite nicht geschrieben: Geheimnis-Muster gefunden (${treffer.join(', ')})` };
  }

  schreibeAtomar(cacheDatei, `${JSON.stringify(cacheBereinigt(cache))}\n`, fsImpl);
  return { exitcode: 0, meldung: `Zentrale geschrieben: ${join(ordner, 'zentrale.html')}`, modell };
}

const STRG_C = handler => {
  process.once('SIGINT', handler);
};

export async function main(argv, {
  tokenLaden = ladeToken, leserBauen = erzeugeLeser, jetzt = () => Date.now(), warte = ms => new Promise(r => setTimeout(r, ms)),
  ausgabe = t => process.stdout.write(`${t}\n`), beiAbbruch = STRG_C, beenden = code => process.exit(code), ...rest
} = {}) {
  const schleife = argv.includes('--schleife');

  if (argv.some(a => a !== '--schleife')) {
    ausgabe('Aufruf: node werkzeuge/zentrale/zentrale.mjs [--schleife]');
    return 2;
  }

  const t = tokenLaden();

  if (!t.ok) {
    ausgabe(`Abbruch: ${t.grund}. Keine Seite geschrieben.`);
    return 1;
  }

  const leser = leserBauen({ token: t.token });
  let vorher = null;
  // Wo beim Abschluss geschrieben wird: dieselben Werte wie im Durchlauf.
  const ziel = { fsImpl: rest.fsImpl ?? fs, ordner: rest.ordner ?? ORDNER };

  if (schleife) {
    beiAbbruch(() => {
      schleifeBeenden({ modell: vorher, token: t.token, um: jetzt(), grund: 'Strg+C', ...ziel });
      ausgabe('Schleife beendet (Strg+C). Die Seite trägt den Hinweis auf das Ende.');
      beenden(130);
    });
  }

  for (;;) {
    const r = await durchlauf({ token: t.token, leser, jetzt: jetzt(), vorher, schleife, ...rest });
    ausgabe(r.meldung);

    if (!schleife) {
      return r.exitcode;
    }

    if (r.exitcode !== 0) {
      // Die zuletzt geschriebene Seite darf nach dem Abbruch kein Neuladen mehr versprechen.
      schleifeBeenden({ modell: vorher, token: t.token, um: jetzt(), grund: 'Durchlauf gescheitert', ...ziel });
      return r.exitcode;
    }

    vorher = r.modell;
    await warte(SCHLEIFE_MS);
  }
}

if (import.meta.main === true) {
  process.exitCode = await main(process.argv.slice(2));
}
