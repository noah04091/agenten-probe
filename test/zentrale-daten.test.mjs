// B1.1 Command Center: Abbildung der API-Antworten (daten.mjs) und der ganze Ablauf (zentrale.mjs) gegen eine
// nachgebaute GitHub-API aus test/fixtures/zentrale. Kein Netz.
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  freigabenAus, issueZuLauf, jobsAus, laeufeAus, monatsKosten, offeneAuftraege, pflichtchecks, prZuLauf, restMinuten, startfreigaben,
} from '../werkzeuge/zentrale/daten.mjs';
import { erzeugeLeser } from '../werkzeuge/zentrale/github-lesen.mjs';
import { durchlauf, sammle, zusammenfuehren } from '../werkzeuge/zentrale/zentrale.mjs';

const FIX = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'zentrale');
const api = name => JSON.parse(readFileSync(join(FIX, 'api', `${name}.json`), 'utf8'));
const LOGS = Object.freeze({ 136389814103: 'job1-live2', 136488370273: 'job1-nf2', 136489652497: 'job2-nf2', 136599633609: 'job1-nf3' });
const JETZT = Date.parse('2026-11-21T10:20:00Z');
const TOKEN = 'github_pat_TESTNURATTRAPPE_0000000000';
const P = '/repos/noah04091/agenten-probe';

const antwort = (status, koerper = '', kopf = {}) => ({
  status,
  headers: { get: k => kopf[k.toLowerCase()] ?? null },
  text: async () => (typeof koerper === 'string' ? koerper : JSON.stringify(koerper)),
});

// Nachgebaute API. stoerung(schluessel) kann jede Antwort ersetzen; Schluessel ist der Pfad ohne Basis.
function github(stoerung = () => null) {
  const aufrufe = [];
  const f = async url => {
    const u = new URL(url);
    aufrufe.push(u.pathname);
    const seite = Number(u.searchParams.get('page') ?? '1');
    const ersatz = stoerung(u.pathname, u);

    if (ersatz) {
      return ersatz;
    }

    if (u.hostname === 'productionresultssa1.blob.core.windows.net') {
      const id = u.pathname.split('/').at(-1);
      return antwort(200, LOGS[id] ? readFileSync(join(FIX, 'logs', `${LOGS[id]}.txt`), 'utf8') : '');
    }

    assert.equal(u.hostname, 'api.github.com');
    const p = u.pathname;
    const leer = feld => antwort(200, feld ? { total_count: 0, [feld]: [] } : []);
    let m;

    if (p === P) return antwort(200, api('repo'));
    if (p === '/rate_limit') return antwort(200, api('rate-limit'));
    if (p === `${P}/issues`) return seite > 1 ? leer() : antwort(200, api(u.searchParams.get('state') === 'open' ? 'issues-offen' : 'issues-alle'));
    if ((m = /^\/repos\/noah04091\/agenten-probe\/issues\/(\d+)\/events$/.exec(p))) {
      return seite > 1 ? leer() : antwort(200, ['79', '80', '81', '90', '91'].includes(m[1]) ? api(`events-${m[1]}`) : []);
    }
    if ((m = /^\/repos\/noah04091\/agenten-probe\/contents\/agent-acceptance\/issue-(\d+)\.mjs$/.exec(p))) {
      return m[1] === '91' ? antwort(200, { name: 'issue-91.mjs' }) : antwort(404, { message: 'Not Found' });
    }
    if (p === `${P}/actions/workflows/agent-auftrag.yml/runs`) {
      return u.searchParams.get('event') === 'issues' ? (seite > 1 ? leer('workflow_runs') : antwort(200, api('runs'))) : antwort(200, api('runs-generalprobe'));
    }
    if ((m = /\/actions\/runs\/(\d+)\/jobs$/.exec(p))) return seite > 1 ? leer('jobs') : antwort(200, api(`jobs-${m[1]}`));
    if ((m = /\/actions\/runs\/(\d+)\/pending_deployments$/.exec(p))) return antwort(200, api(`pending-${m[1]}`));
    if ((m = /\/actions\/jobs\/(\d+)\/logs$/.exec(p))) return antwort(302, '', { location: `https://productionresultssa1.blob.core.windows.net/log/${m[1]}` });
    if (p === `${P}/pulls`) return seite > 1 ? leer() : antwort(200, api('pulls'));
    if (p === `${P}/commits/32e7691ba585e4a2d74cc975f6117971f2933a9b/check-runs`) return seite > 1 ? leer('check_runs') : antwort(200, api('checks-32e7691b'));
    return antwort(404, { message: 'Not Found' });
  };

  return { f, aufrufe };
}

const keineSitzungen = () => ({ ok: true, eintraege: [] });
const lauf = async (stoerung, cache = {}) => {
  const g = github(stoerung);
  const r = await sammle({ leser: erzeugeLeser({ token: TOKEN, fetchImpl: g.f }), jetzt: JETZT, cache, sitzungen: keineSitzungen });
  return { ...r, aufrufe: g.aufrufe };
};

test('Abbildung: offene Auftraege nur mit genau einem agent:-Label, ohne PRs', () => {
  const a = offeneAuftraege(api('issues-offen'));
  assert.deepEqual(a.map(x => [x.nummer, x.profil, x.startlabel]), [[90, 'js-text', true], [91, 'js-rechner', false]]);
  assert.equal(offeneAuftraege({}), null);
});

test('Abbildung: Startfreigaben zaehlen nur bot-auftrag von noah04091', () => {
  assert.deepEqual(startfreigaben(api('events-90')), [Date.parse('2026-11-21T10:00:00Z')]);
  assert.equal(startfreigaben(api('events-79')).length, 2);
  assert.equal(startfreigaben(api('events-80')).length, 2);
  assert.equal(startfreigaben(null), null);
});

test('Abbildung: Issue zum Lauf nur bei eindeutigem Startlabel hoechstens 60 Sekunden vorher', () => {
  const l = { start: Date.parse('2026-11-20T22:07:07Z'), titel: 'T' };
  const k = (nummer, ...zeiten) => ({ nummer, titel: 'T', freigaben: zeiten.map(z => Date.parse(z)) });
  assert.equal(issueZuLauf(l, [k(80, '2026-11-20T22:07:04Z')]).nummer, 80);
  assert.equal(issueZuLauf(l, [k(80, '2026-11-20T22:06:07Z')]).nummer, 80, 'genau 60 Sekunden');
  assert.equal(issueZuLauf(l, [k(80, '2026-11-20T22:06:06Z')]), null, '61 Sekunden');
  assert.equal(issueZuLauf(l, [k(80, '2026-11-20T22:07:08Z')]), null, 'nach dem Lauf');
  assert.equal(issueZuLauf(l, [k(80, '2026-11-20T22:07:04Z'), k(81, '2026-11-20T22:07:05Z')]), null, 'mehrdeutig');
  assert.equal(issueZuLauf(l, [{ ...k(80, '2026-11-20T22:07:04Z'), titel: 'anders' }]), null, 'anderer Titel');
  assert.equal(issueZuLauf(l, [{ nummer: 80, titel: 'T', freigaben: null }]), null, 'Ereignisse unbekannt');
});

test('Abbildung: Jobs, Draft-PR, Pflichtchecks, Freigaben, Frist', () => {
  const jobs = jobsAus(api('jobs-44793828526').jobs);
  assert.deepEqual(jobs.map(j => j.conclusion), ['success', 'success', 'failure', 'skipped']);
  assert.deepEqual(jobsAus([{ id: 1, name: 'Job 1 a', status: 'completed', conclusion: 'success' }, { id: 2, name: 'Job 1 b', status: 'completed', conclusion: 'failure' }])[1], null, 'doppelt');
  assert.deepEqual(jobsAus(api('jobs-44900000001').jobs).map(j => j.status), ['completed', 'waiting', 'nicht-gestartet', 'nicht-gestartet']);
  assert.deepEqual(jobsAus(null), [null, null, null, null], 'Abruf gescheitert: unbekannt');
  assert.deepEqual(laeufeAus(api('runs').workflow_runs).map(l => l.id), [44900000001, 44826212314, 44793828526, 44765669207]);

  const pr = prZuLauf(api('pulls'), 79, 44765669207);
  assert.deepEqual(pr, { nummer: 104, url: 'https://github.com/noah04091/agenten-probe/pull/104', zustand: 'gemergt', sha: '32e7691ba585e4a2d74cc975f6117971f2933a9b' });
  assert.equal(prZuLauf(api('pulls'), 79, 4476566920), null, 'Praefix reicht nicht');
  assert.equal(prZuLauf([...api('pulls'), api('pulls')[0]], 79, 44765669207), null, 'mehrdeutig');

  assert.deepEqual(pflichtchecks(api('checks-32e7691b').check_runs), ['build', 'tests', 'schutzdateien', 'agent-auftrag-sammel'].map(name => ({ name, ergebnis: 'success' })));
  const gemischt = pflichtchecks([{ name: 'tests', status: 'completed', conclusion: 'success', app: { id: 15368 } }, { name: 'tests', status: 'completed', conclusion: 'failure', app: { id: 15368 } }, { name: 'build', status: 'in_progress', conclusion: null, app: { id: 15368 } }]);
  assert.deepEqual(gemischt.map(c => c.ergebnis), ['in_progress', 'uneinheitlich', 'fehlt', 'fehlt']);
  assert.deepEqual(freigabenAus(api('pending-44900000001')), [{ environment: 'claude-bot', kannFreigeben: false }]);
  assert.equal(restMinuten(Date.parse('2026-11-21T10:00:00Z'), JETZT), 40);
  assert.equal(restMinuten(Date.parse('2026-11-21T09:00:00Z'), JETZT), 0);
  assert.equal(restMinuten(undefined, JETZT), null);
});

test('Ablauf: Laeufe Live 2, NF2, NF3 und eine wartende Freigabe wie in der Abnahme', async () => {
  const { modell, cache, aufrufe } = await lauf();
  const b = modell.bereiche;

  assert.deepEqual(b.auftraege.eintraege.map(a => [a.nummer, a.freigaben, a.abnahme]), [[90, 1, 'fehlt'], [91, 0, 'vorhanden']]);
  assert.equal(b.auftraege.teilFehler, null);

  const l = Object.fromEntries(b.laeufe.eintraege.map(x => [x.id, x]));
  assert.equal(b.laeufe.teilFehler, null);
  assert.equal(b.laeufe.generalprobe, 37);
  // Live 2: Job 0 bis 3 gruen, PR #104 gemergt, alle vier Pflichtchecks gruen, Kosten 0,047 $.
  assert.deepEqual(l[44765669207].jobs.map(j => j.conclusion), ['success', 'success', 'success', 'success']);
  assert.equal(l[44765669207].issue.nummer, 79);
  assert.equal(l[44765669207].pr.zustand, 'gemergt');
  assert.equal(l[44765669207].pr.nummer, 104);
  assert.deepEqual(l[44765669207].pr.checks.map(c => c.ergebnis), ['success', 'success', 'success', 'success']);
  assert.equal(l[44765669207].kosten, 0.047427800000000006);
  assert.equal(l[44765669207].code, null);
  // NF2: abnahme-exitcode in Job 2, Kosten aus Job 1.
  assert.deepEqual([l[44793828526].issue.nummer, l[44793828526].code, l[44793828526].kosten, l[44793828526].pr], [81, 'abnahme-exitcode', 0.026869399999999998, null]);
  // NF3: auftrag-label-start-fehlt in Job 1, keine Kosten.
  assert.deepEqual([l[44826212314].issue.nummer, l[44826212314].code, l[44826212314].kosten], [80, 'auftrag-label-start-fehlt', null]);
  // Wartende Freigabe: Job 1, claude-bot, 40 Minuten Restfrist.
  assert.deepEqual(b.freigaben.eintraege, [{ laufId: 44900000001, url: 'https://github.com/noah04091/agenten-probe/actions/runs/44900000001', environment: 'claude-bot', job: 1, restMinuten: 40 }]);
  // Monatssumme: genau die Kostenzeilen der Laeufe im Monat.
  assert.deepEqual({ summe: b.kosten.summe, mitKosten: b.kosten.mitKosten, ohneKosten: b.kosten.ohneKosten, vollstaendig: b.kosten.vollstaendig, monat: b.kosten.monat },
    { summe: 0.047427800000000006 + 0.026869399999999998, mitKosten: 2, ohneKosten: 2, vollstaendig: true, monat: '2026-11' });

  // Logs: nur abgeschlossene Jobs 1 bis 3 (und Job 0 nur bei Rot); der Cache traegt nur die drei Werte.
  assert.equal(aufrufe.filter(p => p.endsWith('/logs')).length, 6);
  assert.ok(Object.values(cache).every(w => JSON.stringify(Object.keys(w).sort()) === '["code","kosten","runden"]'));
  assert.ok(!JSON.stringify(cache).includes('A6-') && !JSON.stringify(cache).includes('Claude beendet'));
  const zweiter = await lauf(() => null, cache);
  assert.equal(zweiter.aufrufe.filter(p => p.endsWith('/logs')).length, 0, 'abgeschlossene Jobs aus dem Cache');
  assert.deepEqual(zweiter.modell.bereiche.kosten.summe, b.kosten.summe);
});

test('Ablauf: Teilfehler machen Werte unbekannt und die Summe unvollstaendig, nie vollstaendig behauptet', async () => {
  // Log von Job 1 (Live 2) nicht ladbar: Kosten offen, Summe unvollstaendig.
  let r = await lauf(p => (p === '/log/136389814103' ? antwort(500, '') : null));
  assert.equal(r.modell.bereiche.kosten.vollstaendig, false);
  assert.ok(Number.isFinite(r.modell.bereiche.kosten.teilFehler));
  assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler));
  assert.ok(!Object.hasOwn(r.cache, '136389814103'), 'gescheiterter Abruf nicht im Cache');

  // Laufliste unvollstaendig (total_count groesser): Summe unvollstaendig.
  r = await lauf((p, u) => (p.endsWith('/agent-auftrag.yml/runs') && u.searchParams.get('event') === 'issues' && u.searchParams.get('page') === '1' ? antwort(200, { ...api('runs'), total_count: 250 }) : null));
  assert.equal(r.modell.bereiche.kosten.vollstaendig, false);
  assert.equal(r.modell.bereiche.laeufe.unvollstaendig, true);

  // Fehlende Rechte fuer Checks (403): Pflichtchecks unbekannt, Bereich mit Teilfehler, kein Rueckfall.
  r = await lauf(p => (p.endsWith('/check-runs') ? antwort(403, { message: 'Resource not accessible by personal access token' }) : null));
  const live2 = r.modell.bereiche.laeufe.eintraege.find(x => x.id === 44765669207);
  assert.deepEqual(live2.pr.checks, [{ name: 'Pflichtchecks', ergebnis: 'unbekannt' }]);
  assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler));

  // Abnahme-Datei 404 ohne "Not Found": unbekannt, nicht fehlt.
  r = await lauf(p => (p.endsWith('/issue-90.mjs') ? antwort(404, { message: 'anders' }) : null));
  assert.equal(r.modell.bereiche.auftraege.eintraege[0].abnahme, 'unbekannt');
  assert.ok(Number.isFinite(r.modell.bereiche.auftraege.teilFehler));

  // Laufliste ganz gescheitert: Bereiche 2, 3 und Kosten "Abruf fehlgeschlagen", Bereich 1 unberuehrt.
  r = await lauf(p => (p.endsWith('/agent-auftrag.yml/runs') ? antwort(500, {}) : null));
  for (const k of ['laeufe', 'freigaben', 'kosten']) {
    assert.equal(r.modell.bereiche[k].stand, null, k);
    assert.equal(r.modell.bereiche[k].fehlschlag, JETZT, k);
  }
  assert.equal(r.modell.bereiche.auftraege.stand, JETZT);
});

test('Ablauf: gescheiterter Bereich behaelt alten Stand, zeigt aber "Abruf fehlgeschlagen"', () => {
  const vorher = { erzeugt: 1, bereiche: { laeufe: { stand: 1000, fehlschlag: null, eintraege: [{ id: 1 }] } } };
  const neu = { erzeugt: 2, bereiche: { laeufe: { stand: null, fehlschlag: 2000, grund: 'HTTP 500', eintraege: [] } } };
  assert.deepEqual(zusammenfuehren(vorher, neu).bereiche.laeufe, { stand: 1000, fehlschlag: 2000, grund: 'HTTP 500', eintraege: [{ id: 1 }] });
  assert.equal(zusammenfuehren(null, neu), neu);
});

// Dateisystem-Attrappe im Speicher fuer durchlauf.
function speicher() {
  const dateien = new Map();
  const log = [];
  return {
    dateien,
    log,
    existsSync: p => dateien.has(p),
    readFileSync: p => { if (!dateien.has(p)) throw new Error('ENOENT'); return dateien.get(p); },
    writeFileSync: (p, inhalt) => { log.push(`schreibe ${p}`); dateien.set(p, inhalt); },
    renameSync: (a, b) => { log.push(`umbenennen ${a} ${b}`); dateien.set(b, dateien.get(a)); dateien.delete(a); },
    mkdirSync: () => {},
  };
}

test('Durchlauf: Startpruefung, atomares Schreiben, Cache ohne Rohtext', async () => {
  const fs = speicher();
  const ordner = join('Z', '.zentrale');
  const g = github();
  const r = await durchlauf({ token: TOKEN, leser: erzeugeLeser({ token: TOKEN, fetchImpl: g.f }), jetzt: JETZT, fsImpl: fs, ordner, sitzungen: keineSitzungen, uebersicht: join('Z', 'gibt-es-nicht.html') });
  assert.equal(r.exitcode, 0);
  const html = join(ordner, 'zentrale.html');
  assert.deepEqual(fs.log.slice(0, 2), [`schreibe ${html}.neu`, `umbenennen ${html}.neu ${html}`]);
  assert.ok(fs.dateien.get(html).includes('abnahme-exitcode'));
  assert.ok(!fs.dateien.has(`${html}.neu`));
  const cache = fs.dateien.get(join(ordner, 'cache.json'));
  assert.ok(!cache.includes('A6-') && !cache.includes('Claude') && !cache.includes(TOKEN));
  assert.ok(!fs.dateien.get(html).includes(TOKEN));

  // Startpruefung scheitert (401): Exitcode 1, keine Seite, Meldung ohne Token.
  const fs2 = speicher();
  const g2 = github(p => (p === P ? antwort(401, { message: 'Bad credentials' }) : null));
  const r2 = await durchlauf({ token: TOKEN, leser: erzeugeLeser({ token: TOKEN, fetchImpl: g2.f }), jetzt: JETZT, fsImpl: fs2, ordner, sitzungen: keineSitzungen });
  assert.equal(r2.exitcode, 1);
  assert.match(r2.meldung, /Startprüfung fehlgeschlagen.*401/);
  assert.equal(fs2.dateien.size, 0);
  assert.equal(g2.aufrufe.length, 1);
});

test('Monatskosten: nur Laeufe im laufenden UTC-Monat', () => {
  const l = (start, kosten, kostenOffen = false) => ({ start: Date.parse(start), kosten, kostenOffen });
  const k = monatsKosten([l('2026-11-01T00:00:00Z', 0.1), l('2026-10-31T23:59:59Z', 5), l('2026-11-20T00:00:00Z', null), l('2026-11-20T00:00:00Z', null, true)], JETZT, true);
  assert.deepEqual(k, { monat: '2026-11', summe: 0.1, mitKosten: 1, ohneKosten: 2, vollstaendig: false });
  assert.equal(monatsKosten([], JETZT, false).vollstaendig, false);
});
