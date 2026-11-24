// B1.1 Command Center: Abbildung der API-Antworten (daten.mjs) und der ganze Ablauf (zentrale.mjs) gegen eine
// nachgebaute GitHub-API aus test/fixtures/zentrale. Kein Netz.
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_NICHT_GESTARTET, freigabenAus, issueZuLauf, jobsAus, kostenAusJob1, laeufeAus, monatsKosten, offeneAuftraege, pflichtchecks, prZuLauf,
  restMinuten, startfreigaben, fristStufe, fristenAusJson, fristDatum, laufwarnungen,
} from '../werkzeuge/zentrale/daten.mjs';
import {
  ECHTPROBE_SOLL, KOSTEN_TOLERANZ, MONAT_SOLL, REFERENZ_JETZT, SOLL, echtprobe, historischerAbruf, ladeSoll, referenzLeser, sollAusJson, unbelegteLaeufe, vergleicheLauf, vergleicheMonat,
} from '../werkzeuge/zentrale/echtprobe.mjs';
import { CSP, laufwarnungText, seite } from '../werkzeuge/zentrale/darstellung.mjs';
import { erzeugeLeser } from '../werkzeuge/zentrale/github-lesen.mjs';
import { cacheBereinigt, durchlauf, ladeFristen, main, notseiteSchreiben, sammle, schleifeBeenden, zusammenfuehren } from '../werkzeuge/zentrale/zentrale.mjs';

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

    // B1.3: GitHub sendet bei Personal Access Tokens das Ablaufdatum im Antwortkopf (Kopfprobe vom 22.11.2026).
    if (p === P) return antwort(200, api('repo'), { 'github-authentication-token-expiration': '2026-12-21 21:04:30 UTC' });
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

// Stoerungen fuer K1 und K2: Laufliste ohne bestimmte Laeufe; Antwort nur fuer einen Pfad ersetzen; mehrere verbinden.
const RUNS = `${P}/actions/workflows/agent-auftrag.yml/runs`;
function ohneLauf(...ids) {
  return (p, u) => {
    if (p !== RUNS || u.searchParams.get('event') !== 'issues' || (u.searchParams.get('page') ?? '1') !== '1') {
      return null;
    }

    const w = api('runs').workflow_runs.filter(x => !ids.includes(x.id));
    return antwort(200, { total_count: w.length, workflow_runs: w });
  };
}
const nur = (pfad, ersatz) => p => (p === pfad ? ersatz() : null);
const beide = (...s) => (p, u) => s.reduce((r, f) => r ?? f(p, u), null);
const eintrag = (r, id) => r.modell.bereiche.laeufe.eintraege.find(x => x.id === id);

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
  assert.equal(prZuLauf([...api('pulls'), api('pulls')[0]], 79, 44765669207), 'mehrdeutig', 'mehrdeutig');

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
  // Monatssumme: genau die Kostenzeilen der Laeufe im Monat. Der wartende Lauf hat noch keine belegten Kosten (Job 1
  // wartet), die Summe ist deshalb nur "mindestens". NF3 hat belegt keine Kosten (Code vor dem Claude-Start).
  // B1.1a: drei Zahlen; der wartende Lauf ist "ohne Kostenbeleg", kein Abruffehler.
  assert.deepEqual({ summe: b.kosten.summe, mitKosten: b.kosten.mitKosten, belegtOhneKosten: b.kosten.belegtOhneKosten, kostenUnbekannt: b.kosten.kostenUnbekannt,
    ohneBeleg: b.kosten.ohneBeleg, abrufOffen: b.kosten.abrufOffen, vollstaendig: b.kosten.vollstaendig, monat: b.kosten.monat },
  { summe: 0.047427800000000006 + 0.026869399999999998, mitKosten: 2, belegtOhneKosten: 1, kostenUnbekannt: 1, ohneBeleg: 1, abrufOffen: false, vollstaendig: false, monat: '2026-11' });
  assert.equal(b.kosten.teilFehler, null, 'wartender Lauf ist kein Abruffehler');
  assert.equal(l[44900000001].kostenOffen, true);
  assert.equal(l[44826212314].kostenOffen, false);
  assert.equal(l[44765669207].runden, 6);
  // Ohne den wartenden Lauf ist die Summe belegt vollstaendig (Muss-Treffer fuer "vollstaendig").
  const ohneWartend = await lauf(ohneLauf(44900000001));
  assert.equal(ohneWartend.modell.bereiche.kosten.vollstaendig, true);
  assert.equal(ohneWartend.modell.bereiche.kosten.teilFehler, null);

  // Logs: nur abgeschlossene Jobs 1 bis 3 (und Job 0 nur bei Rot); der Cache traegt nur die drei Werte.
  assert.equal(aufrufe.filter(p => p.endsWith('/logs')).length, 6);
  assert.ok(Object.values(cache).every(w => JSON.stringify(Object.keys(w).sort()) === '["code","kosten","runden"]'));
  assert.ok(!JSON.stringify(cache).includes('A6-') && !JSON.stringify(cache).includes('Claude beendet'));
  const zweiter = await lauf(() => null, cache);
  assert.equal(zweiter.aufrufe.filter(p => p.endsWith('/logs')).length, 0, 'abgeschlossene Jobs aus dem Cache');
  assert.deepEqual(zweiter.modell.bereiche.kosten.summe, b.kosten.summe);
  assert.equal(Object.fromEntries(zweiter.modell.bereiche.laeufe.eintraege.map(x => [x.id, x]))[44826212314].kostenOffen, false, 'Beleg auch aus dem Cache');
});

test('K1: gescheiterte oder unvollstaendige Jobliste: Jobs unbekannt statt "nicht gestartet", Kosten offen, Summe unvollstaendig', async () => {
  // Jobliste von Live 2 scheitert (500).
  let r = await lauf(beide(ohneLauf(44900000001), nur(`${P}/actions/runs/44765669207/jobs`, () => antwort(500, {}))));
  let e = eintrag(r, 44765669207);
  assert.deepEqual(e.jobs, [null, null, null, null]);
  assert.equal(e.kostenOffen, true);
  assert.equal(e.kosten, null);
  // Ohne Jobliste wird trotzdem gesucht: der PR steht in der vollstaendigen Liste und wird gefunden, nie "kein PR".
  assert.equal(e.pr.nummer, 104, 'ohne Jobliste trotzdem gesucht');
  r = await lauf(beide(nur(`${P}/actions/runs/44765669207/jobs`, () => antwort(500, {})), nur(`${P}/pulls`, () => antwort(500, {}))));
  assert.equal(eintrag(r, 44765669207).pr, 'unbekannt', 'ohne Jobliste und ohne PR-Liste: unbekannt, nie "kein PR"');
  r = await lauf(beide(ohneLauf(44900000001), nur(`${P}/actions/runs/44765669207/jobs`, () => antwort(500, {}))));
  assert.equal(r.modell.bereiche.kosten.vollstaendig, false);
  assert.ok(Number.isFinite(r.modell.bereiche.kosten.teilFehler));
  assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler));

  // Jobliste des wartenden Laufs unvollstaendig (total_count 4, nur Job 0 und 1 geliefert): Job 2 und 3 unbekannt.
  r = await lauf(nur(`${P}/actions/runs/44900000001/jobs`, () => antwort(200, { ...api('jobs-44900000001'), total_count: 4 })));
  e = eintrag(r, 44900000001);
  assert.deepEqual(e.jobs.map(j => (j ? j.status : 'unbekannt')), ['completed', 'waiting', 'unbekannt', 'unbekannt']);
  assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler));
  // Gegenprobe: vollstaendig geliefert heisst es "nicht gestartet".
  assert.deepEqual(eintrag(await lauf(), 44900000001).jobs.map(j => j.status), ['completed', 'waiting', 'nicht-gestartet', 'nicht-gestartet']);
});

test('K1: Kosten nur mit Beleg; gescheitertes Log oder Log ohne Kostenzeile und ohne Vor-Start-Code: unbekannt', async () => {
  // Log von Job 1 (NF3) nicht ladbar: Kosten unbekannt, nicht "keine".
  let r = await lauf(beide(ohneLauf(44900000001), nur('/log/136599633609', () => antwort(500, ''))));
  assert.equal(eintrag(r, 44826212314).kostenOffen, true);
  assert.equal(r.modell.bereiche.kosten.vollstaendig, false);

  // Log von Job 1 (NF2) gelesen, aber ohne Kostenzeile und ohne Vor-Start-Code: Claude kann gelaufen sein.
  r = await lauf(beide(ohneLauf(44900000001), nur('/log/136488370273', () => antwort(200, '2026-11-20T18:35:11.1234567Z irgendetwas\n'))));
  assert.equal(eintrag(r, 44793828526).kosten, null);
  assert.equal(eintrag(r, 44793828526).kostenOffen, true);
  assert.equal(r.modell.bereiche.kosten.vollstaendig, false);

  // Einheiten: jeder Zweig von kostenAusJob1.
  const fertig = { status: 'completed' };
  const job = (status, conclusion = null) => ({ id: 1, status, conclusion });
  assert.deepEqual(kostenAusJob1(fertig, null, undefined), { kosten: null, runden: null, offen: true, grund: 'abruf' }, 'Job 1 unbekannt');
  assert.equal(kostenAusJob1({ status: 'in_progress' }, job('nicht-gestartet'), undefined).offen, true, 'Lauf laeuft noch');
  assert.equal(kostenAusJob1(fertig, job('nicht-gestartet'), undefined).offen, false, 'abgeschlossen, Job 1 nie gestartet');
  assert.equal(kostenAusJob1(fertig, job('waiting'), undefined).offen, true, 'wartet');
  assert.equal(kostenAusJob1(fertig, job('in_progress'), undefined).offen, true, 'laeuft');
  assert.equal(kostenAusJob1(fertig, job('completed', 'skipped'), undefined).offen, false, 'uebersprungen');
  assert.equal(kostenAusJob1(fertig, job('completed', 'failure'), null).offen, true, 'Log gescheitert');
  assert.equal(kostenAusJob1(fertig, job('completed', 'failure'), { code: 'abnahme-exitcode', runden: null, kosten: null }).offen, true, 'anderer Code');
  assert.equal(kostenAusJob1(fertig, job('completed', 'failure'), { code: 'mehrdeutig', runden: null, kosten: null }).offen, true, 'mehrdeutig');
  for (const c of CLAUDE_NICHT_GESTARTET) {
    assert.equal(kostenAusJob1(fertig, job('completed', 'failure'), { code: c, runden: null, kosten: null }).offen, false, c);
  }
  assert.deepEqual(kostenAusJob1(fertig, job('completed', 'success'), { code: null, runden: 6, kosten: 0.04 }), { kosten: 0.04, runden: 6, offen: false, grund: null });
});

test('K1: PR-Liste gescheitert, unvollstaendig oder mehrdeutig: nie "kein PR"', async () => {
  // Liste gescheitert.
  let r = await lauf(nur(`${P}/pulls`, () => antwort(500, {})));
  assert.equal(eintrag(r, 44765669207).pr, 'unbekannt');
  assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler));
  // NF2 und NF3: Job 3 uebersprungen, belegt kein PR, auch ohne Liste.
  assert.equal(eintrag(r, 44793828526).pr, null);

  // Mehrere passende PRs.
  r = await lauf(nur(`${P}/pulls`, () => antwort(200, [...api('pulls'), { ...api('pulls')[0], number: 105 }])));
  assert.equal(eintrag(r, 44765669207).pr, 'mehrdeutig');
  assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler));

  // Unvollstaendige Liste (Seitengrenze erreicht): unbekannt, auch wenn ein Treffer darin steht.
  const voll = Array.from({ length: 100 }, (_, i) => ({ number: 2000 + i, head: { ref: `x-${i}` } }));
  r = await lauf((p, u) => (p === `${P}/pulls` ? antwort(200, u.searchParams.get('page') === '1' ? [api('pulls')[0], ...voll.slice(1)] : voll) : null));
  assert.equal(eintrag(r, 44765669207).pr, 'unbekannt');
  assert.equal(prZuLauf(api('pulls'), 79, 44765669207, false), 'unbekannt');
  assert.equal(prZuLauf(api('pulls'), 80, 44826212314, false), 'unbekannt', 'kein Treffer in unvollstaendiger Liste');
  assert.equal(prZuLauf(api('pulls'), 80, 44826212314, true), null, 'Gegenprobe: vollstaendig ohne Treffer');
  assert.equal(prZuLauf(null, 79, 44765669207), 'unbekannt');
});

test('K1: unvollstaendige Check- und Issue-Kandidatenlisten sichtbar gekennzeichnet', async () => {
  // Check-Liste unvollstaendig (total_count groesser): jeder Pflichtcheck sichtbar unbekannt.
  let r = await lauf(nur(`${P}/commits/32e7691ba585e4a2d74cc975f6117971f2933a9b/check-runs`, () => antwort(200, { ...api('checks-32e7691b'), total_count: 150 })));
  assert.deepEqual(eintrag(r, 44765669207).pr.checks.map(c => c.ergebnis), Array(4).fill('unbekannt (Liste unvollständig)'));
  assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler));
  assert.deepEqual(pflichtchecks(api('checks-32e7691b').check_runs, false).map(c => c.ergebnis), Array(4).fill('unbekannt (Liste unvollständig)'));

  // Issue-Liste unvollstaendig (Seitengrenze): keine Zuordnung, Bereich sagt es.
  const fuell = Array.from({ length: 100 }, (_, i) => ({ number: 5000 + i, title: `fuell ${i}` }));
  r = await lauf((p, u) => (p === `${P}/issues` && u.searchParams.get('state') === 'all'
    ? antwort(200, u.searchParams.get('page') === '1' ? [...api('issues-alle'), ...fuell].slice(0, 100) : fuell) : null));
  assert.equal(r.modell.bereiche.laeufe.kandidatenUnvollstaendig, true);
  assert.ok(r.modell.bereiche.laeufe.eintraege.every(x => x.issue === null));
  assert.equal(eintrag(r, 44765669207).pr, 'unbekannt');
  assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler));
  assert.equal((await lauf()).modell.bereiche.laeufe.kandidatenUnvollstaendig, false, 'Gegenprobe');

  // Ereignisse eines Kandidaten unvollstaendig: dieser Kandidat zaehlt als unbekannt, kein Raten auf den anderen.
  const l = { start: Date.parse('2026-11-20T22:07:07Z'), titel: 'T' };
  assert.equal(issueZuLauf(l, [{ nummer: 80, titel: 'T', freigaben: [Date.parse('2026-11-20T22:07:04Z')] }, { nummer: 81, titel: 'T', freigaben: null }]), null);
  // Erste Seite traegt das echte Startlabel, die Liste endet aber an der Seitengrenze: keine Zuordnung.
  const leer = Array.from({ length: 100 }, () => ({ event: 'commented' }));
  r = await lauf((p, u) => (p === `${P}/issues/80/events` ? antwort(200, u.searchParams.get('page') === '1' ? [...api('events-80'), ...leer].slice(0, 100) : leer) : null));
  assert.equal(eintrag(r, 44826212314).issue, null);
  assert.equal(eintrag(await lauf(), 44826212314).issue.nummer, 80, 'Gegenprobe: vollstaendige Ereignisse ordnen zu');
});

test('K1: Monatssumme nur vollstaendig mit Beleg (Lauf ohne Startzeit, Liste unvollstaendig)', () => {
  const l = (start, kosten, kostenOffen = false) => ({ start, kosten, kostenOffen });
  assert.equal(monatsKosten([l(Date.parse('2026-11-02T00:00:00Z'), 0.1)], JETZT, true).vollstaendig, true, 'Muss-Treffer');
  assert.equal(monatsKosten([l(Date.parse('2026-11-02T00:00:00Z'), 0.1), l(null, null)], JETZT, true).vollstaendig, false, 'Startzeit unbekannt');
  assert.equal(monatsKosten([{ start: Date.parse('2026-11-02T00:00:00Z'), kosten: null }], JETZT, true).vollstaendig, false, 'Beleg fehlt');
  assert.equal(monatsKosten([l(Date.parse('2026-11-02T00:00:00Z'), null, true)], JETZT, true).vollstaendig, false, 'Kosten offen');
  assert.equal(monatsKosten([l(Date.parse('2026-11-02T00:00:00Z'), null, false)], JETZT, true).vollstaendig, true, 'belegt keine Kosten');
  assert.equal(monatsKosten([l(Date.parse('2026-11-02T00:00:00Z'), 0.1)], JETZT, false).vollstaendig, false, 'Liste unvollstaendig');
});

// K2: Echt-Probe gegen die nachgebaute API. Geloeschter Zweig antwortet wie GitHub mit "Branch not found".
const zweig = nur(`${P}/branches/wp/78-agent-44536520447-1`, () => antwort(404, { message: 'Branch not found' }));
// B1.3a: Sollwert aus einer Referenzdatei in einer Datei-Attrappe, geladen ueber das echte ladeSoll. Simulierte Uhrzeit,
// Sollwert und simulierter Antwortkopf bleiben zueinander passend: bis zum 21.12.2026 gilt der echte Wert der Kopfprobe
// (2026-12-21T21:04:30Z), danach (K2b, K2c im Januar 2027) ein Token, das 30 Tage nach jetzt ablaeuft, eingetragen am
// Tag von jetzt. Der Kopf der Attrappe wird dann passend gesetzt; eine ausdrueckliche Stoerung des Kopfs geht vor.
const LESE_SOLL = Date.parse('2026-12-21T21:04:30Z');
const SOLL_DATEI = join('Z', '.zentrale', 'echtprobe-soll.json');
const sollText = (ablauf, eingetragen, extra = {}) => JSON.stringify({ schema: 'zentrale-echtprobe-soll-v1', leseTokenAblauf: ablauf, eingetragen, quelle: 'noah', ...extra });
const kopfWert = ms => `${new Date(ms).toISOString().slice(0, 10)} ${new Date(ms).toISOString().slice(11, 19)} UTC`;
const sollFs = text => { const fs = speicher(); if (text !== null) fs.dateien.set(SOLL_DATEI, text); return fs; };
function passenderSoll(jetzt) {
  if (jetzt < LESE_SOLL) {
    return { ablauf: LESE_SOLL, text: sollText('2026-12-21T21:04:30Z', new Date(Math.min(jetzt, Date.parse('2026-11-23T00:00:00Z'))).toISOString().slice(0, 10)) };
  }

  const ablauf = Math.floor(jetzt / 1000) * 1000 + 30 * 24 * 3600 * 1000;
  return { ablauf, text: sollText(new Date(ablauf).toISOString().replace('.000Z', 'Z'), new Date(jetzt).toISOString().slice(0, 10)) };
}
async function probe(stoerung = () => null, jetzt = JETZT, { soll = undefined, sollLaden = undefined } = {}) {
  const zeilen = [];
  const p = passenderSoll(jetzt);
  const text = soll === undefined ? p.text : soll;
  const kopf = p.ablauf === LESE_SOLL ? () => null : nur(P, () => antwort(200, api('repo'), { 'github-authentication-token-expiration': kopfWert(p.ablauf) }));
  const code = await echtprobe([], {
    tokenLaden: () => ({ ok: true, token: TOKEN }),
    leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: github(beide(zweig, stoerung, kopf)).f }),
    ausgabe: t => zeilen.push(t),
    jetzt,
    sollLaden: sollLaden ?? (a => ladeSoll({ ...a, datei: SOLL_DATEI, fsImpl: sollFs(text) })),
  });
  return { code, text: zeilen.join('\n') };
}

// K2b: nachgestellter November 2026 wie in der Referenz. Zu Live 2 (0,0474278) und NF2 (0,0268694) kommen vier weitere
// Kostenlaeufe (zusammen 0,102046), also 6 Kostenlaeufe mit 0,1763432; dazu der unbelegte Lauf 44620884909 (Job 1 rot,
// im Log weder Kostenzeile noch Vor-Start-Code) und zwei Laeufe ohne Job 1. Der wartende Lauf ist nicht dabei.
const NOVEMBER = Object.freeze([
  { id: 44600000001, start: '2026-11-03T09:00:00Z', art: 'kosten', kosten: 0.03 },
  { id: 44600000002, start: '2026-11-04T09:00:00Z', art: 'kosten', kosten: 0.03 },
  { id: 44600000003, start: '2026-11-05T09:00:00Z', art: 'kosten', kosten: 0.03 },
  { id: 44600000004, start: '2026-11-06T09:00:00Z', art: 'kosten', kosten: 0.012046 },
  { id: 44620884909, start: '2026-11-10T09:00:00Z', art: 'unbelegt' },
  { id: 44610000001, start: '2026-11-11T09:00:00Z', art: 'ohneJob1' },
  { id: 44610000002, start: '2026-11-12T09:00:00Z', art: 'ohneJob1' },
]);
const synthLauf = s => ({ id: s.id, status: 'completed', conclusion: s.art === 'kosten' ? 'success' : 'failure', created_at: s.start,
  display_title: `Synth ${s.id}`, html_url: `https://github.com/noah04091/agenten-probe/actions/runs/${s.id}` });
function synthJobs(s) {
  const c = s.art === 'kosten' ? ['success', 'success', 'skipped', 'skipped'] : s.art === 'unbelegt' ? ['success', 'failure', 'skipped', 'skipped'] : ['failure', 'skipped', 'skipped', 'skipped'];
  return { total_count: 4, jobs: c.map((k, n) => ({ id: s.id * 10 + n, name: `Job ${n} synth`, status: 'completed', conclusion: k })) };
}
function synthLog(s, n) {
  if (n === 1 && s.art === 'kosten') return `2026-11-03T09:01:00.0000000Z Claude beendet: Runden 4, Kosten ${s.kosten} USD\n`;
  if (n === 1 && s.art === 'unbelegt') return '2026-11-10T09:01:00.0000000Z A6-CLAUDE aufruf-fehlgeschlagen\n';
  return '';
}
// created-Filter wie bei GitHub: ">=TAG" oder "VON..BIS" (beide Tage einschliesslich, UTC). Anderes: Fehler.
function imZeitraum(created, filter) {
  const tag = created.slice(0, 10);
  let m = /^>=(\d{4}-\d{2}-\d{2})$/.exec(filter ?? '');

  if (m) {
    return tag >= m[1];
  }

  m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(filter ?? '');
  assert.ok(m, `unerwarteter created-Filter: ${filter}`);
  return tag >= m[1] && tag <= m[2];
}
const runsAbrufe = [];
// verfaelschen(liste, u): optional, aendert die gefilterte Liste vor dem Seitenschnitt (unvollstaendige Antworten).
function november({ ohne = [44900000001], mehr = [], verfaelschen = null } = {}) {
  const synth = [...NOVEMBER, ...mehr].filter(s => !ohne.includes(s.id));
  return (p, u) => {
    if (p === RUNS && u.searchParams.get('event') === 'issues') {
      runsAbrufe.push(u.searchParams.get('created'));
      const alle = [...api('runs').workflow_runs.filter(x => !ohne.includes(x.id)), ...synth.map(synthLauf)];
      let w = alle.filter(x => imZeitraum(x.created_at, u.searchParams.get('created')));
      let gesamt = w.length;

      if (verfaelschen) {
        ({ w, gesamt } = verfaelschen(w, u));
      }

      const seite = Number(u.searchParams.get('page') ?? '1');
      return antwort(200, { total_count: gesamt, workflow_runs: w.slice((seite - 1) * 100, seite * 100) });
    }

    let m = /\/actions\/runs\/(\d+)\/jobs$/.exec(p);
    const s1 = m ? synth.find(x => x.id === Number(m[1])) : undefined;

    if (s1) {
      return antwort(200, synthJobs(s1));
    }

    m = /^\/log\/(\d+)$/.exec(p);
    const s2 = m ? synth.find(x => x.id === Math.floor(Number(m[1]) / 10)) : undefined;
    return s2 ? antwort(200, synthLog(s2, Number(m[1]) % 10)) : null;
  };
}
// Generalprobe-Zaehler scheitert nur im historischen (Fenster ab 2026-10-31) oder nur im laufenden Abruf.
const generalprobeKaputt = tag => (p, u) => (p === RUNS && u.searchParams.get('event') === 'pull_request' && u.searchParams.get('created') === `>=${tag}` ? antwort(500, {}) : null);

test('K2: Echt-Probe besteht nur mit allen Sollwerten, der November-Referenz und streng belegtem laufendem Monat', async () => {
  const gut = await probe(november());
  assert.equal(gut.code, 0, gut.text);
  assert.match(gut.text, /ECHTPROBE BESTANDEN/);
  assert.match(gut.text, /lauf Live 2 44765669207: issue 79 .* kosten 0\.047427800000000006 runden 6 pr #104 gemergt build=success .* OK/);
  assert.match(gut.text, /lauf NF3 44826212314: issue 80 .* code auftrag-label-start-fehlt kosten keine .* OK/);
  assert.match(gut.text, /historisch-monat 2026-11: summe 0\.17634\d* mit Kosten 6 unbelegt \{44620884909\} vollstaendig false OK/);
  assert.match(gut.text, /laufend-monat 2026-11: .*unbelegt \{44620884909\} .*OK/);
  assert.equal(SOLL.length, 3);
  assert.deepEqual(SOLL.map(s => s.id), [44765669207, 44793828526, 44826212314]);
  assert.deepEqual({ ...MONAT_SOLL, unbelegt: [...MONAT_SOLL.unbelegt] }, { monat: '2026-11', summe: 0.1763432, mitKosten: 6, unbelegt: [44620884909], vollstaendig: false });
  assert.equal(new Date(REFERENZ_JETZT).toISOString(), '2026-11-30T23:59:59.000Z');

  const faelle = [
    ['falsche November-Kosten', beide(nur('/log/446000000011', () => antwort(200, 'Claude beendet: Runden 4, Kosten 0.0301 USD\n')), november()), /historisch-monat 2026-11: .*Abweichung: summe 0\.17644\d* statt 0\.1763432/],
    ['niedrigere November-Kosten (Kostenlauf fehlt)', november({ ohne: [44900000001, 44600000004] }), /historisch-monat 2026-11: .*Abweichung: summe .* statt 0\.1763432 .*; mit Kosten 5 statt 6/],
    ['Referenzlauf fehlt', november({ ohne: [44900000001, 44620884909] }), /historisch-monat 2026-11: .*Abweichung: unbelegt \{\} statt \{44620884909\}; vollstaendig true statt false/],
    ['zusaetzlicher unbelegter Lauf im November', november({ mehr: [{ id: 44630000001, start: '2026-11-15T09:00:00Z', art: 'unbelegt' }] }), /historisch-monat 2026-11: .*unbelegt \{44620884909,44630000001\} statt \{44620884909\}/],
    ['wartender Lauf ohne Kostenbeleg', november({ ohne: [] }), /laufend-monat 2026-11: .*davon nicht als Sonderfall belegt \{44900000001\} .*ABWEICHUNG/],
    ['Kosten weichen ab', beide(nur('/log/136488370273', () => antwort(200, 'Claude beendet: Runden 5, Kosten 0.0269 USD\n')), november()), /NF2 .*Abweichung: kosten 0\.0269 statt 0\.0268694/],
    ['Code weicht ab', beide(nur('/log/136489652497', () => antwort(200, 'A6-FEHLER abnahme-ausgabe\n')), november()), /code abnahme-ausgabe statt abnahme-exitcode/],
    ['Lauf fehlt', november({ ohne: [44900000001, 44826212314] }), /NF3 44826212314: fehlt in der Laufliste/],
    ['Log nicht ladbar', beide(nur('/log/136389814103', () => antwort(500, '')), november()), /Live 2 .*kosten unbekannt statt 0\.0474278/],
    ['Teilfehler nur im historischen Abruf', beide(generalprobeKaputt('2026-10-31'), november()), /historisch-laeufe: .*Teilfehler ja ABWEICHUNG/],
    ['Teilfehler nur im laufenden Abruf', beide(generalprobeKaputt('2026-10-22'), november()), /laufend-laeufe: .*Teilfehler ja ABWEICHUNG/],
    ['Laufliste gescheitert', p => (p === RUNS ? antwort(500, {}) : null), /nicht pruefbar, Laufliste fehlgeschlagen/],
    ['PR fehlt', beide(nur(`${P}/pulls`, () => antwort(200, [])), november()), /Live 2 .*pr kein PR statt #104/],
    ['Jobzustand weicht ab', beide(nur(`${P}/actions/runs/44793828526/jobs`, () => {
      const j = api('jobs-44793828526');
      return antwort(200, { ...j, jobs: j.jobs.map(x => (x.name.startsWith('Job 3 ') ? { ...x, conclusion: 'cancelled' } : x)) });
    }), november()), /NF2 .*Abweichung: jobs .*completed\/cancelled statt/],
    ['Issue weicht ab', beide(nur(`${P}/issues/81/events`, () => antwort(200, [])), november()), /NF2 .*Abweichung: issue unbekannt statt 81/],
  ];

  for (const [name, stoerung, muster] of faelle) {
    const r = await probe(stoerung);
    assert.equal(r.code, 1, `${name}: ${r.text}`);
    assert.match(r.text, muster, name);
    assert.match(r.text, /ECHTPROBE NICHT BESTANDEN/, name);
  }
});

test('K2b: Monatswechsel: historischer Teil bleibt gueltig, kein Gruen durch das Datum, neuer Monat streng', async () => {
  // Januar 2027: das alte 30-Tage-Fenster ist laengst vorbei, der historische Teil prueft trotzdem voll.
  const jan = Date.parse('2027-01-15T10:00:00Z');
  const gut = await probe(november(), jan);
  assert.equal(gut.code, 0, gut.text);
  assert.match(gut.text, /lauf Live 2 44765669207: .* OK/);
  assert.match(gut.text, /historisch-monat 2026-11: summe 0\.17634\d* mit Kosten 6 unbelegt \{44620884909\} vollstaendig false OK/);
  assert.match(gut.text, /laufend-monat 2027-01: summe 0 mit Kosten 0 vollstaendig true unbelegt \{\} .*OK/);

  // Im Januar faellt jede Abweichung im November weiter auf.
  for (const [name, stoerung, muster] of [
    ['falsche November-Kosten', beide(nur('/log/446000000011', () => antwort(200, 'Claude beendet: Runden 4, Kosten 0.0301 USD\n')), november()), /historisch-monat 2026-11: .*Abweichung: summe/],
    ['Referenzlauf fehlt', november({ ohne: [44900000001, 44620884909] }), /historisch-monat 2026-11: .*Abweichung: unbelegt \{\}/],
    ['zusaetzlicher unbelegter Lauf im November', november({ mehr: [{ id: 44630000001, start: '2026-11-15T09:00:00Z', art: 'unbelegt' }] }), /unbelegt \{44620884909,44630000001\} statt/],
    ['Lauf fehlt', november({ ohne: [44900000001, 44793828526] }), /NF2 44793828526: fehlt in der Laufliste/],
  ]) {
    const r = await probe(stoerung, jan);
    assert.equal(r.code, 1, `${name}: ${r.text}`);
    assert.match(r.text, muster, name);
  }

  // Dezember: ein unbelegter Lauf im laufenden Monat ist kein Sonderfall, auch nicht mit der November-Ausnahme.
  const dez = Date.parse('2026-12-05T10:00:00Z');
  const r = await probe(november({ mehr: [{ id: 44640000001, start: '2026-12-03T09:00:00Z', art: 'unbelegt' }] }), dez);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /laufend-monat 2026-12: .*vollstaendig false unbelegt \{44640000001\} davon nicht als Sonderfall belegt \{44640000001\} .*ABWEICHUNG/);
  assert.match(r.text, /historisch-monat 2026-11: .* OK/);
  // Gegenprobe: derselbe Dezember mit belegtem Kostenlauf besteht.
  const ok = await probe(november({ mehr: [{ id: 44640000002, start: '2026-12-03T09:00:00Z', art: 'kosten', kosten: 0.01 }] }), dez);
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /laufend-monat 2026-12: summe 0\.01 mit Kosten 1 vollstaendig true unbelegt \{\} .*OK/);
});

test('K2c: historischer Abruf serverseitig bis 2026-11-20 begrenzt, laufender Abruf unveraendert', async () => {
  // Muss-Treffer: der wartende Lauf vom 21.11. erscheint im laufenden Teil, im historischen nicht.
  runsAbrufe.length = 0;
  const r = await probe(november({ ohne: [] }));
  assert.deepEqual(runsAbrufe.filter(f => f.includes('..')), ['2026-10-31..2026-11-20'], 'historisch genau ein begrenzter Abruf');
  assert.deepEqual(runsAbrufe.filter(f => f.startsWith('>=')), ['>=2026-10-22'], 'laufend unveraendert offen');
  assert.match(r.text, /historisch-zeitraum: Laufliste 2026-10-31 bis 2026-11-20 \(serverseitig begrenzt\) OK/);
  assert.match(r.text, /historisch-laeufe: 10 Laeufe, .* OK/);
  assert.match(r.text, /historisch-monat 2026-11: summe 0\.17634\d* mit Kosten 6 unbelegt \{44620884909\} vollstaendig false OK/);
  assert.match(r.text, /laufend-laeufe: 11 Laeufe/);
  assert.match(r.text, /laufend-monat 2026-11: .*davon nicht als Sonderfall belegt \{44900000001\} .*ABWEICHUNG/);
  assert.equal(r.code, 1);

  // Zusaetzliche November-Laeufe nach dem 20.11.: historisch unberuehrt; laufend streng (unbelegt rot, belegt gruen).
  const spaeterNov = Date.parse('2026-11-28T12:00:00Z');
  const unbelegt = await probe(november({ mehr: [{ id: 44650000001, start: '2026-11-25T09:00:00Z', art: 'unbelegt' }] }), spaeterNov);
  assert.equal(unbelegt.code, 1, unbelegt.text);
  assert.match(unbelegt.text, /historisch-monat 2026-11: summe 0\.17634\d* mit Kosten 6 unbelegt \{44620884909\} vollstaendig false OK/);
  assert.match(unbelegt.text, /laufend-monat 2026-11: .*unbelegt \{44620884909,44650000001\} davon nicht als Sonderfall belegt \{44650000001\} .*ABWEICHUNG/);
  const belegt = await probe(november({ mehr: [{ id: 44650000002, start: '2026-11-25T09:00:00Z', art: 'kosten', kosten: 0.05 }] }), spaeterNov);
  assert.equal(belegt.code, 0, belegt.text);
  assert.match(belegt.text, /historisch-monat 2026-11: summe 0\.17634\d* mit Kosten 6 /);
  assert.match(belegt.text, /laufend-monat 2026-11: summe 0\.22634\d* mit Kosten 7 /);

  // Viele spaetere Laeufe (150, ueber zwei Seiten) im Dezember und Januar: der historische Teil sieht keinen davon.
  const viele = Array.from({ length: 150 }, (_, i) => ({ id: 44700000000 + i, start: new Date(Date.parse('2026-12-20T00:00:00Z') + i * 3 * 3600 * 1000).toISOString(), art: i % 2 ? 'kosten' : 'ohneJob1', kosten: 0.001 }));
  runsAbrufe.length = 0;
  const jan = await probe(november({ mehr: viele }), Date.parse('2027-01-10T12:00:00Z'));
  assert.equal(jan.code, 0, jan.text);
  assert.match(jan.text, /historisch-laeufe: 10 Laeufe, Liste vollstaendig/);
  assert.match(jan.text, /historisch-monat 2026-11: summe 0\.17634\d* mit Kosten 6 unbelegt \{44620884909\} vollstaendig false OK/);
  assert.match(jan.text, /laufend-laeufe: 150 Laeufe, Liste vollstaendig/, 'Muss-Treffer: der laufende Teil sieht die spaeteren Laeufe');
  assert.deepEqual(runsAbrufe.filter(f => f.includes('..')), ['2026-10-31..2026-11-20']);
});

test('K2c: unvollstaendige historische Antwort und Umschreibung nicht genau einmal: Exitcode 1', async () => {
  const nurHistorisch = f => november({ verfaelschen: (w, u) => (u.searchParams.get('created').includes('..') ? f(w) : { w, gesamt: w.length }) });
  // total_count groesser als geliefert.
  let r = await probe(nurHistorisch(w => ({ w, gesamt: w.length + 5 })));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /historisch-laeufe: .*Liste unvollstaendig.* ABWEICHUNG/);
  assert.match(r.text, /laufend-laeufe: .*Liste vollstaendig.* OK/);
  // Ein Lauf fehlt in der Antwort, total_count nennt ihn aber.
  r = await probe(nurHistorisch(w => ({ w: w.filter(x => x.id !== 44620884909), gesamt: w.length })));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /historisch-laeufe: .*Liste unvollstaendig.* ABWEICHUNG/);
  // Historische Laufliste scheitert (500), die laufende nicht.
  r = await probe(beide((p, u) => (p === RUNS && (u.searchParams.get('created') ?? '').includes('..') ? antwort(500, {}) : null), november()));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /historisch-laeufe: Laufliste fehlgeschlagen .* ABWEICHUNG/);
  assert.match(r.text, /lauf Live 2 44765669207: nicht pruefbar, Laufliste fehlgeschlagen ABWEICHUNG/);

  // Umschreibung greift zweimal oder nie: kein Beleg.
  const zeilen = [];
  const code = await echtprobe([], {
    tokenLaden: () => ({ ok: true, token: TOKEN }),
    leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: github(beide(zweig, november())).f }),
    ausgabe: t => zeilen.push(t), jetzt: JETZT,
    sollLaden: a => ladeSoll({ ...a, datei: SOLL_DATEI, fsImpl: sollFs(passenderSoll(JETZT).text) }),
    historisch: l => historischerAbruf(l, async a => { await sammle(a); return sammle(a); }),
  });
  assert.equal(code, 1);
  assert.match(zeilen.join('\n'), /historisch-zeitraum: Begrenzung auf 2026-10-31 bis 2026-11-20 griff 2-mal statt genau einmal ABWEICHUNG/);

  const leerLeser = { holeJson: async () => ({ klasse: 'unbekannt' }), holeAlleSeiten: async () => ({ klasse: 'unbekannt' }), holeLog: async () => ({ klasse: 'unbekannt' }) };
  const nie = await historischerAbruf(leerLeser, async () => ({ modell: { bereiche: {} } }));
  assert.equal(nie.fehler, 'Begrenzung auf 2026-10-31 bis 2026-11-20 griff 0-mal statt genau einmal');
  const einmal = await historischerAbruf(leerLeser, async ({ leser }) => { await leser.holeAlleSeiten(`${RUNS}?event=issues&per_page=100&created=%3E%3D2026-10-31`); return { modell: { bereiche: {} } }; });
  assert.equal(einmal.fehler, null);

  // Nur die Issue-Laufliste wird umgeschrieben; Generalprobe und andere Pfade gehen unveraendert durch.
  const gesehen = [];
  const rl = referenzLeser({ holeJson: async p => { gesehen.push(p); return {}; }, holeAlleSeiten: async p => { gesehen.push(p); return {}; }, holeLog: async () => ({}) });
  await rl.leser.holeJson(`${RUNS}?event=pull_request&per_page=1&created=%3E%3D2026-10-31`);
  await rl.leser.holeAlleSeiten(`${P}/issues?state=all&per_page=100`);
  await rl.leser.holeAlleSeiten(`${RUNS}?event=issues&per_page=100&created=%3E%3D2026-10-31`, { feld: 'workflow_runs' });
  assert.deepEqual(gesehen, [`${RUNS}?event=pull_request&per_page=1&created=%3E%3D2026-10-31`, `${P}/issues?state=all&per_page=100`, `${RUNS}?event=issues&per_page=100&created=2026-10-31%2E%2E2026-11-20`]);
  assert.equal(rl.zaehler.umschreibungen, 1);
});

test('K2b: Monatsvergleich und unbelegte Laeufe als Einheit', () => {
  const k = { monat: '2026-11', summe: 0.1763432, mitKosten: 6, vollstaendig: false };
  const e = [{ id: 44620884909, start: Date.parse('2026-11-10T09:00:00Z'), kosten: null, kostenOffen: true },
    { id: 1, start: Date.parse('2026-11-11T09:00:00Z'), kosten: null, kostenOffen: false },
    { id: 2, start: Date.parse('2026-10-30T09:00:00Z'), kosten: null, kostenOffen: true }];
  assert.deepEqual(vergleicheMonat(k, e), []);
  assert.deepEqual(vergleicheMonat({ ...k, summe: 0.1763432 + 5e-7 }, e), []);
  assert.equal(vergleicheMonat({ ...k, summe: 0.1763432 + 2e-6 }, e).length, 1);
  assert.equal(vergleicheMonat({ ...k, summe: 0.1763432 - 2e-6 }, e).length, 1);
  assert.equal(vergleicheMonat({ ...k, mitKosten: 7 }, e).length, 1);
  assert.equal(vergleicheMonat({ ...k, monat: '2026-12' }, e).length, 1);
  assert.equal(vergleicheMonat({ ...k, vollstaendig: true }, e).length, 1);
  assert.deepEqual(unbelegteLaeufe(e, '2026-11'), [44620884909]);
  assert.deepEqual(unbelegteLaeufe([...e, { id: 3, start: null, kosten: null }], '2026-11'), [3, 44620884909], 'ohne Startzeit zaehlt mit');
  assert.equal(vergleicheMonat(k, [...e, { id: 4, start: Date.parse('2026-11-12T00:00:00Z'), kosten: null, kostenOffen: true }]).length, 1);
});

test('K2: Kostenvergleich mit Toleranz, Sollwerte nicht aus dem Programm', () => {
  const live2 = SOLL[0];
  const basis = { issue: { nummer: 79 }, jobs: Array(4).fill({ status: 'completed', conclusion: 'success' }), code: null, runden: 6, kostenOffen: false,
    pr: { nummer: 104, zustand: 'gemergt', checks: ['build', 'tests', 'schutzdateien', 'agent-auftrag-sammel'].map(name => ({ name, ergebnis: 'success' })) } };
  assert.deepEqual(vergleicheLauf({ ...basis, kosten: 0.047427800000000006 }, live2), []);
  assert.deepEqual(vergleicheLauf({ ...basis, kosten: 0.0474278 + 5e-7 }, live2), []);
  assert.equal(vergleicheLauf({ ...basis, kosten: 0.0474278 + 2e-6 }, live2).length, 1);
  assert.equal(vergleicheLauf({ ...basis, kosten: null, kostenOffen: true }, live2).length, 1);
  assert.equal(KOSTEN_TOLERANZ, 1e-6);
  assert.equal(live2.kosten, 0.0474278);
});

test('K3: Schleifenbetrieb schreibt Neuladen; endet die Schleife, traegt die letzte Seite den Hinweis und kein Neuladen', async () => {
  const REFRESH = '<meta http-equiv="refresh" content="60">';
  const ordner = join('Z', '.zentrale');
  const html = join(ordner, 'zentrale.html');

  // Einmalbetrieb: kein Neuladen.
  const fs1 = speicher();
  assert.equal(await main([], { tokenLaden: () => ({ ok: true, token: TOKEN }), leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: github().f }), jetzt: () => JETZT, fsImpl: fs1, ordner, sitzungen: keineSitzungen, ausgabe: () => {}, beiAbbruch: () => assert.fail('kein Handler ohne Schleife') }), 0);
  assert.ok(!fs1.dateien.get(html).includes(REFRESH));
  assert.ok(fs1.dateien.get(html).includes('Momentaufnahme: erzeugt am 21.11.2026 um 10:20 UTC.'));

  // Schleife: erster Durchlauf gut, zweiter scheitert an der Startpruefung.
  const fs2 = speicher();
  let n = 0;
  const stoer = p => (p === P && n >= 2 ? antwort(401, { message: 'Bad credentials' }) : null);
  const zaehl = { f: async (url, o) => { if (new URL(url).pathname === P) n += 1; return github(stoer).f(url, o); } };
  let zeit = JETZT;
  const code = await main(['--schleife'], {
    tokenLaden: () => ({ ok: true, token: TOKEN }), leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: zaehl.f }),
    jetzt: () => zeit, warte: async () => { assert.ok(fs2.dateien.get(html).includes(REFRESH), 'Muss-Treffer: Neuladen in der Schleife'); zeit += 120_000; },
    fsImpl: fs2, ordner, sitzungen: keineSitzungen, ausgabe: () => {}, beiAbbruch: () => {},
  });
  assert.equal(code, 1);
  // B1.3: Bei 401 ersetzt die Notseite die letzte Seite (keine alten GitHub-Daten, kein Neuladen). Der erste Durchlauf
  // hat den Ablauf 21.12.2026 gemeldet, er liegt in der Zukunft: abgelehnt, obwohl laut letzter Meldung gueltig.
  const not = fs2.dateien.get(html);
  assert.ok(!not.includes(REFRESH), 'Neuladen nach dem Abbruch');
  assert.ok(not.includes('Notseite: erzeugt am 21.11.2026 um 10:22 UTC.'));
  assert.ok(not.includes('obwohl es laut letzter Meldung von GitHub am 21.11.2026 um 10:20 UTC bis 21.12.2026 um 21:04 UTC gültig ist. Wurde es widerrufen oder geändert?'), not);
  assert.ok(!not.includes('abnahme-exitcode') && !not.includes('<table'), 'keine GitHub-Daten auf der Notseite');

  // Gescheiterter Durchlauf aus anderem Grund (Geheimnis-Treffer, keine Seite): die letzte Seite wird mit Vermerk neu
  // geschrieben, wie bisher.
  const fs2b = speicher();
  let m = 0;
  const stoerB = (p, u) => (p === `${P}/issues` && u.searchParams.get('state') === 'open' && m >= 2
    ? antwort(200, [{ number: 5, title: 'enthaelt ghp_ABC', labels: [{ name: 'agent:js-text' }] }]) : null);
  const zaehlB = { f: async (url, o) => { if (new URL(url).pathname === P) m += 1; return github(stoerB).f(url, o); } };
  zeit = JETZT;
  assert.equal(await main(['--schleife'], {
    tokenLaden: () => ({ ok: true, token: TOKEN }), leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: zaehlB.f }),
    jetzt: () => zeit, warte: async () => { zeit += 120_000; }, fsImpl: fs2b, ordner, sitzungen: keineSitzungen, ausgabe: () => {}, beiAbbruch: () => {},
  }), 1);
  const ende = fs2b.dateien.get(html);
  assert.ok(!ende.includes(REFRESH), 'Neuladen nach dem Abbruch');
  assert.ok(ende.includes('Die Schleife wurde am 21.11.2026 um 10:22 UTC beendet (Durchlauf gescheitert).'));
  assert.ok(ende.includes('Momentaufnahme: erzeugt am 21.11.2026 um 10:20 UTC.'));

  // Strg+C waehrend der Schleife: Handler schreibt die Endseite und beendet mit 130.
  const fs3 = speicher();
  let handler = null;
  let beendet = null;
  await main(['--schleife'], {
    tokenLaden: () => ({ ok: true, token: TOKEN }), leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: github().f }),
    jetzt: () => JETZT, warte: async () => { handler(); throw new Error('Ende'); },
    fsImpl: fs3, ordner, sitzungen: keineSitzungen, ausgabe: () => {}, beiAbbruch: h => { handler = h; }, beenden: c => { beendet = c; },
  }).catch(e => assert.equal(e.message, 'Ende'));
  assert.equal(beendet, 130);
  assert.ok(!fs3.dateien.get(html).includes(REFRESH));
  assert.ok(fs3.dateien.get(html).includes('beendet (Strg+C)'));
});

test('K3: Endseite geht durch den Geheimnis-Filter und schreibt ohne Modell nichts', () => {
  const fs = speicher();
  assert.equal(schleifeBeenden({ modell: null, token: TOKEN, um: JETZT, grund: 'x', fsImpl: fs, ordner: 'Z' }), false);
  assert.equal(fs.dateien.size, 0);
  const modell = { erzeugt: JETZT, bereiche: { auftraege: { stand: JETZT, fehlschlag: null, eintraege: [{ nummer: 1, titel: 'ghp_ABC', profil: 'p', startlabel: true, freigaben: 1, abnahme: 'fehlt' }] } } };
  assert.equal(schleifeBeenden({ modell, token: TOKEN, um: JETZT, grund: 'x', fsImpl: fs, ordner: 'Z' }), false);
  assert.equal(fs.dateien.size, 0);
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
    // B1.3: fuer fristen.json (wie ein echtes Dateisystem: fehlt heisst ENOENT).
    lstatSync: p => { if (!dateien.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isSymbolicLink: () => false, isFile: () => true, size: Buffer.byteLength(dateien.get(p)) }; },
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

  // Startpruefung scheitert (401): Exitcode 1, Meldung ohne Token. B1.3: statt keiner Seite eine Notseite ohne
  // GitHub-Daten (ersetzt die alte Seite); kein Cache geschrieben, kein weiterer Abruf.
  const fs2 = speicher();
  const g2 = github(p => (p === P ? antwort(401, { message: 'Bad credentials' }) : null));
  const r2 = await durchlauf({ token: TOKEN, leser: erzeugeLeser({ token: TOKEN, fetchImpl: g2.f }), jetzt: JETZT, fsImpl: fs2, ordner, sitzungen: keineSitzungen });
  assert.equal(r2.exitcode, 1);
  assert.match(r2.meldung, /Startprüfung fehlgeschlagen.*401/);
  assert.deepEqual([...fs2.dateien.keys()], [html]);
  assert.ok(fs2.dateien.get(html).includes('Notseite') && !fs2.dateien.get(html).includes(TOKEN));
  assert.equal(g2.aufrufe.length, 1);
});

test('Monatskosten: nur Laeufe im laufenden UTC-Monat', () => {
  const l = (start, kosten, kostenOffen = false) => ({ start: Date.parse(start), kosten, kostenOffen });
  const k = monatsKosten([l('2026-11-01T00:00:00Z', 0.1), l('2026-10-31T23:59:59Z', 5), l('2026-11-20T00:00:00Z', null), l('2026-11-20T00:00:00Z', null, true)], JETZT, true);
  // Ohne kostenGrund zaehlt ein offener Lauf vorsichtig als Abruffehler (abrufOffen).
  assert.deepEqual(k, { monat: '2026-11', summe: 0.1, mitKosten: 1, belegtOhneKosten: 1, kostenUnbekannt: 1, ohneBeleg: 0, abrufOffen: true, vollstaendig: false });
  assert.equal(monatsKosten([], JETZT, false).vollstaendig, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// B1.1a: eingefrorener November 2026 (Stand 22.11.2026, 19 Laeufe aus Issue-Ereignissen). Die Jobzustaende folgen den
// echten Laeufen; Kosten und Logzeilen sind nachgestellt. Live 2, NF2 und NF3 kommen aus den Fixtures. Erwartet sind
// 7 Laeufe mit Kosten, 11 belegt ohne Kosten und 1 mit unbekannten Kosten (44620884909, Log ohne Beleg).
const S = 'success';
const F = 'failure';
const K = 'skipped';
const NOV22 = Object.freeze([
  { id: 45061471286, start: '2026-11-22T19:33:56Z', jobs: [S, S, S, S], logs: { 1: 'Claude beendet: Runden 3, Kosten 0.011 USD' } },
  { id: 45061278924, start: '2026-11-22T19:31:58Z', jobs: [K, K, K, K] },
  { id: 44826212314, fixture: true },
  { id: 44793828526, fixture: true },
  { id: 44793200931, start: '2026-11-20T18:29:12Z', jobs: [K, K, K, K] },
  { id: 44788592290, start: '2026-11-20T18:00:05Z', jobs: [S, S, S, S], logs: { 1: 'Claude beendet: Runden 4, Kosten 0.012 USD' } },
  { id: 44788378732, start: '2026-11-20T17:58:42Z', jobs: [K, K, K, K] },
  { id: 44765669207, fixture: true },
  { id: 44620884909, start: '2026-11-19T21:39:00Z', jobs: [S, F, K, K], logs: { 1: 'A6-CLAUDE aufruf-fehlgeschlagen' } },
  { id: 44620481483, start: '2026-11-19T21:36:34Z', jobs: [K, K, K, K] },
  { id: 44536520447, start: '2026-11-19T13:44:52Z', jobs: [S, S, S, S], logs: { 1: 'Claude beendet: Runden 5, Kosten 0.013 USD' } },
  { id: 44509846928, start: '2026-11-19T10:53:41Z', jobs: [S, S, F, K], logs: { 1: 'Claude beendet: Runden 6, Kosten 0.014 USD', 2: 'A6-FEHLER abnahme-git-struktur' } },
  { id: 44509400479, start: '2026-11-19T10:50:44Z', jobs: [K, K, K, K] },
  { id: 44409459526, start: '2026-11-18T22:13:25Z', jobs: [S, F, K, K], logs: { 1: 'Claude beendet: Runden 7, Kosten 0.015 USD' } },
  { id: 44408808756, start: '2026-11-18T22:09:32Z', jobs: [K, K, K, K] },
  { id: 44271380015, start: '2026-11-18T08:56:55Z', jobs: [F, K, K, K], logs: { 0: 'A6-FEHLER auftrag-abnahme' } },
  { id: 44270231335, start: '2026-11-18T08:48:57Z', jobs: [S, K, K, K] },
  { id: 44182706381, start: '2026-11-17T21:43:04Z', jobs: [F, K, K, K], logs: { 0: 'A6-FEHLER transport-token' } },
  { id: 44182660173, start: '2026-11-17T21:42:47Z', jobs: [K, K, K, K] },
]);
const NOV22_JETZT = Date.parse('2026-11-22T20:00:00Z');

// Ersetzt die Issue-Laufliste durch die eingefrorenen Laeufe. mehr: zusaetzliche Laeufe; ohne: Laeufe weglassen;
// logs: Antwort fuer einzelne Job-Logs ersetzen (Schluessel Job-ID); gesamt: total_count ueberschreiben.
function november22({ mehr = [], ohne = [], logs = {}, gesamt = null } = {}) {
  const liste = [...NOV22, ...mehr].filter(s => !ohne.includes(s.id));
  const fix = Object.fromEntries(api('runs').workflow_runs.map(w => [w.id, w]));
  const synth = liste.filter(s => !s.fixture);
  return (p, u) => {
    if (p === RUNS && u.searchParams.get('event') === 'issues') {
      const w = liste.map(s => (s.fixture ? fix[s.id] : { id: s.id, status: 'completed', conclusion: s.jobs.includes(F) ? F : S, created_at: s.start,
        display_title: `Synth ${s.id}`, html_url: `https://github.com/noah04091/agenten-probe/actions/runs/${s.id}` }));
      return antwort(200, { total_count: gesamt ?? w.length, workflow_runs: w });
    }

    let m = /\/actions\/runs\/(\d+)\/jobs$/.exec(p);
    const s1 = m ? synth.find(x => x.id === Number(m[1])) : undefined;

    if (s1) {
      return antwort(200, { total_count: 4, jobs: s1.jobs.map((k, n) => ({ id: s1.id * 10 + n, name: `Job ${n} synth`, status: 'completed', conclusion: k })) });
    }

    m = /^\/log\/(\d+)$/.exec(p);

    if (m && Object.hasOwn(logs, m[1])) {
      return logs[m[1]]();
    }

    const s2 = m ? synth.find(x => x.id === Math.floor(Number(m[1]) / 10)) : undefined;
    const zeile = s2?.logs?.[Number(m?.[1]) % 10];
    return s2 ? antwort(200, zeile ? `2026-11-17T00:00:00.0000000Z ${zeile}\n` : '') : null;
  };
}
const nov22 = async (opts, cache = {}) => {
  const g = github(november22(opts));
  const r = await sammle({ leser: erzeugeLeser({ token: TOKEN, fetchImpl: g.f }), jetzt: NOV22_JETZT, cache, sitzungen: keineSitzungen });
  return { ...r, aufrufe: g.aufrufe };
};
const nov22Mit = async stoerung => {
  const g = github(beide(stoerung, november22()));
  return sammle({ leser: erzeugeLeser({ token: TOKEN, fetchImpl: g.f }), jetzt: NOV22_JETZT, cache: {}, sitzungen: keineSitzungen });
};
const kostenSektion = html => /<section class="[a-z]+"><h2>4 Kosten<\/h2>.*?<\/section>/.exec(html)[0];
const NOV22_SUMME = 0.011 + 0.012 + 0.013 + 0.014 + 0.015 + 0.047427800000000006 + 0.026869399999999998;

test('B1.1a P3: eingefrorener November (22.11.): 7 mit Kosten, 11 belegt ohne Kosten, 1 unbekannt', async () => {
  const { modell } = await nov22();
  const k = modell.bereiche.kosten;
  assert.equal(modell.bereiche.laeufe.eintraege.length, 19, 'Muss-Treffer: alle 19 Laeufe geladen');
  assert.equal(modell.bereiche.laeufe.unvollstaendig, false);
  assert.deepEqual([k.mitKosten, k.belegtOhneKosten, k.kostenUnbekannt], [7, 11, 1]);
  assert.equal(k.mitKosten + k.belegtOhneKosten + k.kostenUnbekannt, 19, 'ueberschneidungsfrei und vollstaendig gezaehlt');
  assert.ok(Math.abs(k.summe - NOV22_SUMME) < 1e-12, String(k.summe));
  assert.deepEqual([k.ohneBeleg, k.abrufOffen, k.vollstaendig, k.teilFehler], [1, false, false, null]);
  assert.deepEqual(modell.bereiche.laeufe.eintraege.filter(e => e.kostenOffen).map(e => [e.id, e.kostenGrund]), [[44620884909, 'beleg']]);

  // Die Seite wie beim echten Start erwartet.
  const html = seite(modell, NOV22_JETZT);
  const ks = kostenSektion(html);
  assert.ok(ks.includes('Läufe mit Kosten: 7, belegt ohne Kosten: 11, Kosten unbekannt: 1'), ks);
  assert.ok(ks.includes('1 Lauf ohne Kostenbeleg, Monatssumme unvollständig.'));
  assert.ok(ks.includes('mindestens 0,'));
  assert.ok(!ks.includes('Abruf fehlgeschlagen'), 'Kostenbereich ohne Abruffehler');
  assert.ok(html.includes('<td>abnahme-git-struktur (keine Beschreibung hinterlegt)</td>'), 'Lauf 44509846928');
  assert.ok(html.includes('<td>transport-token (keine Beschreibung hinterlegt)</td>'), 'Lauf 44182706381');

  // Die Zahlen entstehen aus den Daten, nicht fest: ein weiterer Kostenlauf, ein weiterer uebersprungener und ein
  // weiterer ohne Beleg verschieben genau die passende Zahl.
  const plus = await nov22({ mehr: [
    { id: 45100000001, start: '2026-11-22T19:40:00Z', jobs: [S, S, S, S], logs: { 1: 'Claude beendet: Runden 1, Kosten 0.001 USD' } },
    { id: 45100000002, start: '2026-11-22T19:41:00Z', jobs: [K, K, K, K] },
    { id: 45100000003, start: '2026-11-22T19:42:00Z', jobs: [S, F, K, K], logs: { 1: 'irgendetwas' } },
  ] });
  const kp = plus.modell.bereiche.kosten;
  assert.deepEqual([kp.mitKosten, kp.belegtOhneKosten, kp.kostenUnbekannt, kp.ohneBeleg], [8, 12, 2, 2]);
  assert.ok(kostenSektion(seite(plus.modell, NOV22_JETZT)).includes('2 Läufe ohne Kostenbeleg'));
  const ohne = (await nov22({ ohne: [44620884909, 44409459526] })).modell.bereiche.kosten;
  assert.deepEqual([ohne.mitKosten, ohne.belegtOhneKosten, ohne.kostenUnbekannt, ohne.vollstaendig, ohne.teilFehler], [6, 11, 0, true, null]);
  // Ein Lauf vom Oktober zaehlt nicht mit.
  const okt = (await nov22({ mehr: [{ id: 44000000001, start: '2026-10-31T23:59:59Z', jobs: [S, S, S, S], logs: { 1: 'Claude beendet: Runden 1, Kosten 5 USD' } }] })).modell.bereiche.kosten;
  assert.deepEqual([okt.mitKosten, okt.belegtOhneKosten, okt.kostenUnbekannt], [7, 11, 1]);
});

test('B1.1a P2: Log ohne Beleg ist kein Abruffehler; gescheiterter Abruf und unvollstaendige Laufliste bleiben einer', async () => {
  // Log gelesen, ohne Beleg: kein Teilfehler im Kostenbereich, Summe unvollstaendig (siehe P3).
  let r = await nov22();
  assert.equal(r.modell.bereiche.kosten.teilFehler, null);
  assert.equal(r.modell.bereiche.kosten.vollstaendig, false);

  // Log von Job 1 desselben Laufs nicht ladbar: Abruffehler, kein Hinweis ohne Beleg.
  r = await nov22({ logs: { 446208849091: () => antwort(500, '') } });
  let k = r.modell.bereiche.kosten;
  assert.equal(eintrag(r, 44620884909).kostenGrund, 'abruf');
  assert.deepEqual([k.kostenUnbekannt, k.ohneBeleg, k.abrufOffen, k.vollstaendig], [1, 0, true, false]);
  assert.ok(Number.isFinite(k.teilFehler));
  const ks = kostenSektion(seite(r.modell, NOV22_JETZT));
  assert.ok(ks.includes('Abruf fehlgeschlagen um 20:00 UTC (teilweise)') && !ks.includes('ohne Kostenbeleg') && ks.includes('mindestens'));

  // Log eines Kostenlaufs nicht ladbar: aus "mit Kosten" wird "unbekannt", Abruffehler.
  r = await nov22({ logs: { 445365204471: () => antwort(500, '') } });
  k = r.modell.bereiche.kosten;
  assert.deepEqual([k.mitKosten, k.kostenUnbekannt, k.ohneBeleg, k.abrufOffen], [6, 2, 1, true]);
  assert.ok(Number.isFinite(k.teilFehler));

  // Jobliste eines Laufs gescheitert: Job 1 unbekannt, Abruffehler.
  r = await nov22Mit(nur(`${P}/actions/runs/44536520447/jobs`, () => antwort(500, {})));
  assert.equal(eintrag(r, 44536520447).kostenGrund, 'abruf');
  assert.ok(Number.isFinite(r.modell.bereiche.kosten.teilFehler));
  // Jobliste unvollstaendig ohne Job 1: ebenfalls Abruffehler.
  r = await nov22Mit(nur(`${P}/actions/runs/44536520447/jobs`, () => antwort(200, { total_count: 4, jobs: [{ id: 1, name: 'Job 0 synth', status: 'completed', conclusion: S }] })));
  assert.equal(eintrag(r, 44536520447).kostenGrund, 'abruf');
  assert.ok(Number.isFinite(r.modell.bereiche.kosten.teilFehler));

  // Laufliste unvollstaendig (total_count groesser), jeder geladene Lauf belegt: Abruffehler allein aus der Liste.
  r = await nov22({ ohne: [44620884909], gesamt: 250 });
  assert.equal(r.modell.bereiche.laeufe.unvollstaendig, true);
  assert.equal(r.modell.bereiche.kosten.kostenUnbekannt, 0, 'Muss-Treffer: kein offener Lauf');
  assert.ok(Number.isFinite(r.modell.bereiche.kosten.teilFehler));
  assert.equal(r.modell.bereiche.kosten.vollstaendig, false);
  // Gegenprobe: dieselbe Liste vollstaendig ist belegt vollstaendig, ohne Abruffehler.
  r = await nov22({ ohne: [44620884909] });
  assert.deepEqual([r.modell.bereiche.kosten.vollstaendig, r.modell.bereiche.kosten.teilFehler], [true, null]);
});

test('B1.1a P2: Fehler anderer Bereiche loesen keinen Kosten-Abruffehler aus; wartende Jobs sind nie kostenfrei', async () => {
  // Wartender Lauf (Fixture 44900000001): Kosten offen mit Grund "beleg", nie "keine".
  let r = await lauf();
  const w = eintrag(r, 44900000001);
  assert.deepEqual([w.kostenOffen, w.kostenGrund, w.kosten], [true, 'beleg', null]);
  assert.equal(r.modell.bereiche.kosten.belegtOhneKosten, 1, 'nur NF3, nicht der wartende Lauf');
  // Auch ein noch laufender Lauf ohne gestarteten Job 1 oder ein Job 1 in der Warteschlange gilt nicht als kostenfrei.
  assert.deepEqual(kostenAusJob1({ status: 'in_progress' }, { id: null, status: 'nicht-gestartet', conclusion: null }, undefined), { kosten: null, runden: null, offen: true, grund: 'beleg' });
  assert.deepEqual(kostenAusJob1({ status: 'completed' }, { id: 1, status: 'queued', conclusion: null }, undefined), { kosten: null, runden: null, offen: true, grund: 'beleg' });
  assert.deepEqual(kostenAusJob1({ status: 'completed' }, { id: 1, status: 'completed', conclusion: 'failure' }, null), { kosten: null, runden: null, offen: true, grund: 'abruf' });
  assert.deepEqual(kostenAusJob1({ status: 'completed' }, { id: 1, status: 'completed', conclusion: 'failure' }, { code: 'abnahme-exitcode', runden: null, kosten: null }).grund, 'beleg');

  // Je ein Fehler in einem anderen Bereich: Laeufe-Bereich mit Teilfehler, Kostenbereich ohne.
  const andere = [
    ['PR-Liste', nur(`${P}/pulls`, () => antwort(500, {}))],
    ['Generalprobe', (p, u) => (p === RUNS && u.searchParams.get('event') === 'pull_request' ? antwort(500, {}) : null)],
    ['Checks', p => (p.endsWith('/check-runs') ? antwort(403, { message: 'Resource not accessible by personal access token' }) : null)],
    ['Environments', p => (p.endsWith('/pending_deployments') ? antwort(500, {}) : null)],
    ['Log Job 2', nur('/log/136489652497', () => antwort(500, ''))],
    ['Issue-Ereignisse', nur(`${P}/issues/79/events`, () => antwort(500, {}))],
  ];

  for (const [name, stoerung] of andere) {
    r = await lauf(stoerung);
    assert.ok(Number.isFinite(r.modell.bereiche.laeufe.teilFehler), `Muss-Treffer: ${name} ist ein Teilfehler der Laeufe`);
    assert.equal(r.modell.bereiche.kosten.teilFehler, null, `${name} darf keinen Kosten-Abruffehler ausloesen`);
    assert.equal(r.modell.bereiche.kosten.mitKosten, 2, name);
  }
});

test('B1.1a P1: mehrfach auftretende Codes bleiben "mehrere Fehlercodes im Log", eingeschleuste bleiben unbekannt', async () => {
  // Zwei bekannte Codes im selben Log (Job 2 von NF2).
  let r = await lauf(nur('/log/136489652497', () => antwort(200, 'A6-FEHLER transport-token\nA6-FEHLER abnahme-git-struktur\n')));
  assert.equal(eintrag(r, 44793828526).code, 'mehrdeutig');
  assert.ok(seite(r.modell, JETZT).includes('<td>mehrere Fehlercodes im Log</td>'));
  // Zwei bekannte Codes in zwei Jobs desselben Laufs.
  r = await nov22({ logs: { 445098469281: () => antwort(200, 'A6-FEHLER transport-token\n') } });
  assert.equal(eintrag(r, 44509846928).code, 'mehrdeutig');
  // Dieselbe Zeile zweimal ist ebenfalls mehrdeutig (nicht raten).
  r = await lauf(nur('/log/136489652497', () => antwort(200, 'A6-FEHLER abnahme-exitcode\nA6-FEHLER abnahme-exitcode\n')));
  assert.equal(eintrag(r, 44793828526).code, 'mehrdeutig');
  // Eine eingeschleuste Zeile mit erfundenem Code erscheint als unbekannt, ihr Name nie.
  r = await lauf(nur('/log/136489652497', () => antwort(200, 'A6-FEHLER irgendwas\n')));
  assert.equal(eintrag(r, 44793828526).code, 'irgendwas');
  const html = seite(r.modell, JETZT);
  assert.ok(html.includes('<td>unbekannter Code</td>') && !html.includes('irgendwas'));
});

// ---------------------------------------------------------------------------------------------------------------------
// B1.3 Ablaufwarnungen
// ---------------------------------------------------------------------------------------------------------------------
const STD = 60 * 60 * 1000;
const TG = 24 * STD;
const LESE_ABLAUF = Date.parse('2026-12-21T21:04:30Z');
const KOPF_GUELTIG = { 'github-authentication-token-expiration': '2026-12-21 21:04:30 UTC' };
const FRISTEN_OK = JSON.stringify({ schema: 'zentrale-fristen-v1', fristen: [
  { zugang: 'bot-token', name: 'Bot-Token noah04091-agent', ablauf: '2026-12-22T11:26:44Z', eingetragen: '2026-11-22' },
  { zugang: 'anthropic-schluessel', name: 'Anthropic-Schlüssel github-testbot', ablauf: '2027-01-31', eingetragen: '2026-11-22' },
] });

test('B1.3 Schwellen: genau an 14, 8, 7 und 2 Tagen und an 0 Sekunden, je eine Sekunde davor und danach', () => {
  const st = (rest, quelle = 'github') => fristStufe(LESE_ABLAUF, LESE_ABLAUF - rest, quelle, null).stufe;
  assert.equal(st(3650 * TG), 'ok', 'weit in der Zukunft');
  assert.equal(st(14 * TG + 1000), 'ok');
  assert.equal(st(14 * TG), 'hinweis');
  assert.equal(st(14 * TG - 1000), 'hinweis');
  assert.equal(st(8 * TG + 1000), 'hinweis');
  assert.equal(st(8 * TG), 'hinweis');
  assert.equal(st(8 * TG - 1000), 'hinweis');
  assert.equal(st(7 * TG + 1000), 'hinweis');
  assert.equal(st(7 * TG), 'warnung');
  assert.equal(st(7 * TG - 1000), 'warnung');
  assert.equal(st(2 * TG + 1000), 'warnung');
  assert.equal(st(2 * TG), 'warnung');
  assert.equal(st(2 * TG - 1000), 'dringend');
  assert.equal(st(1000), 'dringend');
  assert.equal(st(0), 'abgelaufen');
  assert.equal(st(-1000), 'abgelaufen');
  assert.equal(st(-400 * TG), 'abgelaufen');
  assert.deepEqual(fristStufe(null, LESE_ABLAUF, 'github', null), { stufe: 'unbekannt', restMs: null, pruefen: false });
  assert.equal(fristStufe(NaN, LESE_ABLAUF, 'manuell', LESE_ABLAUF).stufe, 'unbekannt');
  // Mit heutigen Daten: Hinweis ab 07.12. 21:04:30 UTC, rot ab 14.12. 21:04:30 UTC (Lese-Token).
  assert.equal(fristStufe(LESE_ABLAUF, Date.parse('2026-12-07T21:04:29Z'), 'github', null).stufe, 'ok');
  assert.equal(fristStufe(LESE_ABLAUF, Date.parse('2026-12-07T21:04:30Z'), 'github', null).stufe, 'hinweis');
  assert.equal(fristStufe(LESE_ABLAUF, Date.parse('2026-12-14T21:04:30Z'), 'github', null).stufe, 'warnung');
  const bot = Date.parse('2026-12-22T11:26:44Z');
  assert.equal(fristStufe(bot, Date.parse('2026-12-08T11:26:44Z'), 'manuell', null).stufe, 'hinweis');
  assert.equal(fristStufe(bot, Date.parse('2026-12-15T11:26:44Z'), 'manuell', null).stufe, 'warnung');
});

test('B1.3 Herkunft: manuelle Angabe aelter als 45 Tage bekommt den Pruefhinweis, automatische nie', () => {
  const ein = Date.parse('2026-11-22T00:00:00Z');
  const ab = Date.parse('2027-06-01T00:00:00Z');
  assert.equal(fristStufe(ab, ein + 45 * TG, 'manuell', ein).pruefen, false, 'genau 45 Tage');
  assert.equal(fristStufe(ab, ein + 45 * TG + 1000, 'manuell', ein).pruefen, true);
  assert.equal(fristStufe(ab, ein + 400 * TG, 'github', ein).pruefen, false, 'automatische Angabe');
  assert.equal(fristStufe(null, ein + 46 * TG, 'manuell', ein).pruefen, true, 'auch bei unbekanntem Ablauf');
});

test('B1.3 fristen.json: Schema streng, Datum mit und ohne Uhrzeit, jede Abweichung lehnt die ganze Datei ab', () => {
  const ok = fristenAusJson(FRISTEN_OK);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.fristen['bot-token'], { name: 'Bot-Token noah04091-agent', ablauf: Date.parse('2026-12-22T11:26:44Z'), tagesgenau: false, eingetragenAm: Date.parse('2026-11-22T00:00:00Z') });
  assert.deepEqual(ok.fristen['anthropic-schluessel'], { name: 'Anthropic-Schlüssel github-testbot', ablauf: Date.parse('2027-01-31T00:00:00Z'), tagesgenau: true, eingetragenAm: Date.parse('2026-11-22T00:00:00Z') });
  assert.deepEqual(fristenAusJson('{"schema":"zentrale-fristen-v1","fristen":[]}'), { ok: true, fristen: {} });
  assert.deepEqual(fristDatum('2027-01-31'), { ms: Date.parse('2027-01-31T00:00:00Z'), tagesgenau: true });
  assert.equal(fristDatum('2026-11-22T00:00:00Z', { nurTag: true }), null);

  const roh = JSON.parse(FRISTEN_OK);
  const mit = f => JSON.stringify(f(structuredClone(roh)));
  const eintrag = (n, aenderung) => mit(r => { Object.assign(r.fristen[n], aenderung); return r; });
  const faelle = [
    ['kein JSON', '{schema:', 'kein gültiges JSON'],
    ['Liste statt Objekt', '[]', 'falsches Schema'],
    ['falsches Schema', mit(r => ({ ...r, schema: 'zentrale-fristen-v2' })), 'falsches Schema'],
    ['Zusatzfeld oben', mit(r => ({ ...r, extra: 1 })), 'falsches Schema'],
    ['fristen kein Array', mit(r => ({ ...r, fristen: {} })), 'höchstens 10 Einträge'],
    ['11 Eintraege', mit(r => ({ ...r, fristen: Array.from({ length: 11 }, () => r.fristen[0]) })), 'höchstens 10 Einträge'],
    ['Zusatzfeld im Eintrag', eintrag(0, { token: 'x' }), 'Eintrag mit fehlenden oder zusätzlichen Feldern'],
    ['Feld fehlt', mit(r => { delete r.fristen[0].eingetragen; return r; }), 'Eintrag mit fehlenden oder zusätzlichen Feldern'],
    ['unbekannter Zugang', eintrag(0, { zugang: 'lese-token' }), 'unbekannter Zugang'],
    ['Zugang doppelt', mit(r => ({ ...r, fristen: [r.fristen[0], { ...r.fristen[0], name: 'zweiter' }] })), 'Zugang doppelt'],
    ['Name zu lang', eintrag(0, { name: 'x'.repeat(61) }), 'ungültiger Name'],
    ['Name leer', eintrag(0, { name: '' }), 'ungültiger Name'],
    ['Name mit Steuerzeichen', eintrag(0, { name: 'a\nb' }), 'ungültiger Name'],
    ['Name keine Zeichenkette', eintrag(0, { name: 5 }), 'ungültiger Name'],
    ['Datum 31.02.', eintrag(0, { ablauf: '2027-02-31' }), 'ungültiges Datum'],
    ['Datum mit Zeitzone', eintrag(0, { ablauf: '2026-12-22T11:26:44+01:00' }), 'ungültiges Datum'],
    ['Datum ohne Z', eintrag(0, { ablauf: '2026-12-22T11:26:44' }), 'ungültiges Datum'],
    ['Datum als Zahl', eintrag(0, { ablauf: 1766402804000 }), 'ungültiges Datum'],
    ['eingetragen mit Uhrzeit', eintrag(0, { eingetragen: '2026-11-22T00:00:00Z' }), 'ungültiges Datum'],
    ['Prototyp-Trick', '{"schema":"zentrale-fristen-v1","fristen":[{"__proto__":{"x":1},"zugang":"bot-token","name":"a","ablauf":"2027-01-01","eingetragen":"2026-11-22"}]}', 'Eintrag mit fehlenden oder zusätzlichen Feldern'],
  ];

  for (const [name, text, grund] of faelle) {
    assert.deepEqual(fristenAusJson(text), { ok: false, grund }, name);
  }

  // Name mit HTML ist erlaubt und wird bei der Anzeige maskiert (siehe Darstellung).
  assert.equal(fristenAusJson(eintrag(0, { name: '<b>Bot</b>' })).fristen['bot-token'].name, '<b>Bot</b>');
});

// Dateisystem-Attrappe nur fuer fristen.json: Inhalt, Art, Groesse, Git-Arbeitsbaum.
function fristenFs({ inhalt = FRISTEN_OK, art = 'datei', groesse, git = false, datei = join('Z', '.zentrale', 'fristen.json') } = {}) {
  const gelesen = [];
  return {
    gelesen,
    lstatSync(p) {
      if (p !== datei || art === 'fehlt') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }

      if (art === 'kaputt') {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }

      return { isSymbolicLink: () => art === 'link', isFile: () => art === 'datei', size: groesse ?? Buffer.byteLength(inhalt) };
    },
    existsSync: p => git && p.endsWith('.git'),
    readFileSync(p) {
      gelesen.push(p);
      return inhalt;
    },
  };
}

test('B1.3 fristen.json laden: fehlt ist kein Fehler; Link, Verzeichnis, zu gross, Git-Arbeitsbaum, Geheimnis lehnen ab', () => {
  const D = join('Z', '.zentrale', 'fristen.json');
  const lade = (opt, token = TOKEN) => ladeFristen({ datei: D, fsImpl: fristenFs(opt), token });
  assert.equal(lade().status, 'ok');
  assert.deepEqual(lade({ art: 'fehlt' }), { status: 'fehlt' });
  assert.deepEqual(lade({ art: 'kaputt' }), { status: 'ungueltig', grund: 'nicht lesbar' });
  assert.deepEqual(lade({ art: 'link' }), { status: 'ungueltig', grund: 'ist ein Link' });
  assert.deepEqual(lade({ art: 'verzeichnis' }), { status: 'ungueltig', grund: 'ist keine Datei' });
  assert.deepEqual(lade({ groesse: 4097 }), { status: 'ungueltig', grund: 'zu groß' });
  assert.deepEqual(lade({ inhalt: `${FRISTEN_OK}${' '.repeat(4096)}`, groesse: 10 }), { status: 'ungueltig', grund: 'zu groß' }, 'Groesse nachgemessen');
  assert.deepEqual(lade({ git: true }), { status: 'ungueltig', grund: 'liegt in einem Git-Arbeitsbaum' });
  assert.deepEqual(lade({ inhalt: '{' }), { status: 'ungueltig', grund: 'kein gültiges JSON' });
  // Ein Eintrag mit Tokenwert im Namen: ganze Datei abgelehnt, der Wert erscheint im Ergebnis nirgends.
  for (const wert of ['ghp_ABCDEFGHIJ1234567890', 'github_pat_ABCDEFGHIJ1234567890', 'sk-ant-api03-xyz']) {
    const inhalt = FRISTEN_OK.replace('Bot-Token noah04091-agent', wert);
    const r = lade({ inhalt });
    assert.deepEqual(r, { status: 'ungueltig', grund: 'enthält ein Geheimnis-Muster' }, wert);
    assert.ok(!JSON.stringify(r).includes(wert));
  }
  // Der Wert des eigenen Lese-Tokens im Inhalt (auch ohne bekanntes Praefix im Treffer): abgelehnt.
  const eigen = 'TESTNURATTRAPPE_0000000000';
  assert.deepEqual(ladeFristen({ datei: D, fsImpl: fristenFs({ inhalt: FRISTEN_OK.replace('Bot-Token noah04091-agent', eigen) }), token: eigen }), { status: 'ungueltig', grund: 'enthält ein Geheimnis-Muster' });
  // Muss-Treffer: gelesen wird nur fristen.json.
  const fs1 = fristenFs();
  ladeFristen({ datei: D, fsImpl: fs1, token: TOKEN });
  assert.deepEqual(fs1.gelesen, [D]);
});

test('B1.3 Cache: leseTokenAblauf ueberlebt Schreiben und Laden, alte Caches laden weiter, falsche Formen fallen weg', () => {
  const alt = { 136389814103: { code: null, runden: 6, kosten: 0.04 } };
  assert.deepEqual(cacheBereinigt(alt), alt, 'alter Cache ohne Feld');
  const lt = { ablauf: LESE_ABLAUF, gemeldetAm: JETZT };
  assert.deepEqual(cacheBereinigt(JSON.parse(JSON.stringify({ ...alt, leseTokenAblauf: lt }))), { ...alt, leseTokenAblauf: lt });

  for (const falsch of [null, 5, 'x', [], {}, { ablauf: LESE_ABLAUF }, { ablauf: LESE_ABLAUF, gemeldetAm: JETZT, token: 'ghp_x' }, { ablauf: '2026-12-21', gemeldetAm: JETZT },
    { ablauf: LESE_ABLAUF + 0.5, gemeldetAm: JETZT }, { ablauf: 5, gemeldetAm: JETZT }, { ablauf: Date.parse('2300-01-01T00:00:00Z'), gemeldetAm: JETZT }]) {
    assert.deepEqual(cacheBereinigt({ ...alt, leseTokenAblauf: falsch }), alt, JSON.stringify(falsch));
  }

  assert.deepEqual(cacheBereinigt({ ...alt, andereFeld: { ablauf: LESE_ABLAUF, gemeldetAm: JETZT } }), alt, 'unbekannte Felder verworfen');
});

// Durchlauf mit Speicher-Attrappe und optionaler fristen.json.
async function fristenLauf({ stoerung = () => null, fristen = null, cache = null, jetzt = JETZT } = {}) {
  const fs = speicher();
  const ordner = join('Z', '.zentrale');

  if (fristen !== null) {
    fs.dateien.set(join(ordner, 'fristen.json'), fristen);
  }

  if (cache !== null) {
    fs.dateien.set(join(ordner, 'cache.json'), JSON.stringify(cache));
  }

  const g = github(stoerung);
  const r = await durchlauf({ token: TOKEN, leser: erzeugeLeser({ token: TOKEN, fetchImpl: g.f }), jetzt, fsImpl: fs, ordner, sitzungen: keineSitzungen });
  return { r, fs, html: fs.dateien.get(join(ordner, 'zentrale.html')), cache: fs.dateien.has(join(ordner, 'cache.json')) ? JSON.parse(fs.dateien.get(join(ordner, 'cache.json'))) : null };
}

test('B1.3 Durchlauf: drei Zugaenge mit Herkunft; Ablauf aus dem Kopf landet im Cache; ohne fristen.json nie ok', async () => {
  let x = await fristenLauf({ fristen: FRISTEN_OK });
  assert.equal(x.r.exitcode, 0, x.r.meldung);
  assert.deepEqual(x.r.modell.fristen.eintraege.map(e => [e.zugang, e.stufe, e.quelle]), [['lese-token', 'ok', 'github'], ['bot-token', 'ok', 'manuell'], ['anthropic-schluessel', 'ok', 'manuell']]);
  assert.deepEqual(x.cache.leseTokenAblauf, { ablauf: LESE_ABLAUF, gemeldetAm: JETZT });
  assert.ok(x.html.includes('<h2>0 Fristen</h2>'));
  assert.ok(x.html.indexOf('<h2>0 Fristen</h2>') < x.html.indexOf('<h2>1 Offene Aufträge</h2>'), 'ganz oben');
  assert.ok(x.html.includes('läuft am 21.12.2026 um 21:04 UTC ab (noch 30 Tage)'));
  assert.ok(x.html.includes('von GitHub gemeldet am 21.11.2026 um 10:20 UTC'));
  assert.ok(x.html.includes('läuft am 31.01.2027 ab (noch 70 Tage)'), 'tagesgenau ohne Uhrzeit');
  assert.ok(x.html.includes('manuell eingetragen am 22.11.2026, nicht von der Zentrale geprüft'));
  assert.ok(!x.html.includes('class="banner"'), 'kein Banner, alles ok');

  // fristen.json fehlt: Bot-Token und Anthropic "Ablauf unbekannt", nie ok; Bereich sagt "keine manuellen Fristen".
  x = await fristenLauf();
  assert.deepEqual(x.r.modell.fristen.eintraege.map(e => e.stufe), ['ok', 'unbekannt', 'unbekannt']);
  assert.ok(x.html.includes('Ablauf unbekannt: keine manuellen Fristen (fristen.json fehlt).'));
  // fristen.json ungueltig: keine ihrer Werte, die uebrigen Bereiche unberuehrt.
  x = await fristenLauf({ fristen: FRISTEN_OK.replace('"bot-token"', '"lese-token"') });
  assert.equal(x.r.exitcode, 0);
  assert.ok(x.html.includes('Ablauf unbekannt: fristen.json ungültig: unbekannter Zugang.'));
  assert.ok(!x.html.includes('31.01.2027') && !x.html.includes('Anthropic-Schlüssel github-testbot'));
  assert.ok(x.html.includes('abnahme-exitcode'), 'Laeufe-Bereich unberuehrt');
  // Ein Eintrag fehlt: dieser Zugang unbekannt.
  x = await fristenLauf({ fristen: JSON.stringify({ schema: 'zentrale-fristen-v1', fristen: [JSON.parse(FRISTEN_OK).fristen[0]] }) });
  assert.deepEqual(x.r.modell.fristen.eintraege.map(e => e.stufe), ['ok', 'ok', 'unbekannt']);
  assert.ok(x.html.includes('Ablauf unbekannt: kein Eintrag in fristen.json.'));
  // Name mit HTML: maskiert.
  x = await fristenLauf({ fristen: FRISTEN_OK.replace('Bot-Token noah04091-agent', '<img src=x onerror=alert(1)>') });
  assert.ok(x.html.includes('&lt;img src=x onerror=alert(1)&gt;') && !x.html.includes('<img src=x'));
  // Geheimnis im Namen: Datei abgelehnt, Wert nirgends, Seite trotzdem geschrieben.
  x = await fristenLauf({ fristen: FRISTEN_OK.replace('Bot-Token noah04091-agent', 'ghp_ABCDEFGHIJ1234567890') });
  assert.equal(x.r.exitcode, 0);
  assert.ok(x.html.includes('fristen.json ungültig: enthält ein Geheimnis-Muster') && !x.html.includes('ghp_'));
});

test('B1.3 Durchlauf: Kopf fehlt oder ungueltig, dann aktuell unbekannt, letzter Wert nur als historische Angabe', async () => {
  const ohneKopf = p => (p === P ? antwort(200, api('repo')) : null);
  const alt = { leseTokenAblauf: { ablauf: LESE_ABLAUF, gemeldetAm: Date.parse('2026-11-20T08:00:00Z') } };
  let x = await fristenLauf({ stoerung: ohneKopf, cache: alt });
  const e = x.r.modell.fristen.eintraege[0];
  assert.deepEqual([e.stufe, e.ablauf, e.historisch], ['unbekannt', null, alt.leseTokenAblauf]);
  assert.ok(x.html.includes('Ablauf unbekannt: GitHub hat in der Startprüfung kein Ablaufdatum gemeldet. Zuletzt von GitHub gemeldet am 20.11.2026 um 08:00 UTC: Ablauf 21.12.2026 um 21:04 UTC (historische Angabe).'));
  assert.deepEqual(x.cache.leseTokenAblauf, alt.leseTokenAblauf, 'letzte Meldung bleibt im Cache');
  // Ungueltiger Kopf: wie fehlend, Rohwert nirgends.
  x = await fristenLauf({ stoerung: p => (p === P ? antwort(200, api('repo'), { 'github-authentication-token-expiration': '<b>2026-12-21</b>' }) : null) });
  assert.equal(x.r.modell.fristen.eintraege[0].stufe, 'unbekannt');
  assert.ok(!x.html.includes('<b>2026-12-21</b>') && !x.html.includes('historische Angabe'));
  // Kurz vor Ablauf: rotes Banner ganz oben mit Handgriff.
  x = await fristenLauf({ jetzt: LESE_ABLAUF - 30 * STD });
  assert.ok(x.html.includes('class="banner"'));
  assert.ok(x.html.indexOf('class="banner"') < x.html.indexOf('<h2>0 Fristen</h2>'));
  assert.ok(x.html.includes('Lese-Token der Zentrale:</strong> läuft in 30 Stunden ab (am 21.12.2026 um 21:04 UTC), jetzt erneuern.'));
  assert.ok(x.html.includes('Neues Lese-Token auf GitHub anlegen'));
});

test('B1.3 Notseite bei 401: wahrscheinlich abgelaufen, abgelehnt obwohl gueltig, Ablauf unbekannt', async () => {
  const abgelehnt = p => (p === P ? antwort(401, { message: 'Bad credentials' }, KOPF_GUELTIG) : null);
  const meldung = { ablauf: LESE_ABLAUF, gemeldetAm: Date.parse('2026-11-20T08:00:00Z') };
  const pruefe = x => {
    assert.equal(x.r.exitcode, 1);
    assert.equal(x.r.notseite, true);
    assert.deepEqual([...x.fs.dateien.keys()].filter(k => k.endsWith('.html')), [join('Z', '.zentrale', 'zentrale.html')]);
    assert.ok(x.html.includes('Notseite: erzeugt'));
    assert.ok(!/http-equiv="refresh"/.test(x.html) && !/<script/i.test(x.html) && x.html.includes(`content="${CSP}"`));
    assert.ok(!x.html.includes('<table') && !x.html.includes('abnahme-exitcode') && !x.html.includes('#104'), 'keine GitHub-Daten');
    assert.ok(!x.html.includes(TOKEN));
    assert.match(x.r.meldung, /^Das Lese-Token wird von GitHub abgelehnt \(401\)\. Startprüfung fehlgeschlagen/);
  };

  // (a) letzte Meldung in der Vergangenheit.
  let x = await fristenLauf({ stoerung: abgelehnt, cache: { leseTokenAblauf: meldung }, jetzt: LESE_ABLAUF + 5 * STD });
  pruefe(x);
  assert.ok(x.html.includes('Das Lese-Token wird von GitHub abgelehnt (401). Es ist wahrscheinlich abgelaufen am 21.12.2026 um 21:04 UTC (laut letzter Meldung von GitHub am 20.11.2026 um 08:00 UTC).'));
  // (b) letzte Meldung in der Zukunft.
  x = await fristenLauf({ stoerung: abgelehnt, cache: { leseTokenAblauf: meldung } });
  pruefe(x);
  assert.ok(x.html.includes('obwohl es laut letzter Meldung von GitHub am 20.11.2026 um 08:00 UTC bis 21.12.2026 um 21:04 UTC gültig ist. Wurde es widerrufen oder geändert?'));
  assert.ok(!x.html.includes('abgelaufen'), 'nicht pauschal abgelaufen');
  // (c) ohne Cache.
  x = await fristenLauf({ stoerung: abgelehnt });
  pruefe(x);
  assert.ok(x.html.includes('Das Lese-Token wird von GitHub abgelehnt (401). Ablauf unbekannt.'));
  assert.ok(!x.html.includes('abgelaufen'));
  // Der Ablaufkopf einer abgelehnten Antwort zaehlt nicht: kein Cache geschrieben.
  assert.ok(!x.fs.dateien.has(join('Z', '.zentrale', 'cache.json')));
});

test('B1.3 Andere Fehler der Startpruefung: allgemeine Fehlerseite, nie "abgelaufen", nie eine Token-Ablehnung', async () => {
  const faelle = [
    ['403', () => antwort(403, { message: 'Forbidden' }), 'keine Berechtigung (403), Token-Rechte prüfen'],
    ['429 Rate-Limit', () => antwort(429, {}, { 'x-ratelimit-remaining': '0' }), 'Rate-Limit erschöpft'],
    ['500', () => antwort(500, {}), 'HTTP 500'],
    ['503', () => antwort(503, {}), 'HTTP 503'],
    ['Netzfehler', () => new Error('weg'), 'Netzfehler'],
    ['Zeitlimit', () => Object.assign(new Error('zu spaet'), { name: 'TimeoutError' }), 'Zeitlimit'],
  ];

  for (const [name, wie, grund] of faelle) {
    const fs = speicher();
    const ordner = join('Z', '.zentrale');
    fs.dateien.set(join(ordner, 'cache.json'), JSON.stringify({ leseTokenAblauf: { ablauf: JETZT - TG, gemeldetAm: JETZT - 30 * TG } }));
    const f = async url => {
      if (new URL(url).pathname === P) {
        const a = wie();
        if (a instanceof Error) throw a;
        return a;
      }
      return github().f(url);
    };
    const r = await durchlauf({ token: TOKEN, leser: erzeugeLeser({ token: TOKEN, fetchImpl: f }), jetzt: JETZT, fsImpl: fs, ordner, sitzungen: keineSitzungen });
    const html = fs.dateien.get(join(ordner, 'zentrale.html'));
    assert.equal(r.exitcode, 1, name);
    assert.ok(html.includes(`Die Startprüfung bei GitHub ist fehlgeschlagen: ${grund}. Das ist keine Ablehnung der Anmeldung (401).`), `${name}: ${html}`);
    assert.ok(!/abgelaufen/i.test(html) && !html.includes('abgelehnt (401)') && !html.includes('<table'), name);
    assert.ok(!r.meldung.includes('abgelehnt'), name);
  }
});

test('B1.3 Notseite: Geheimnis-Filter aktiv, Schleife laesst die Notseite stehen', async () => {
  // Ein Grund mit Geheimnis-Muster: keine Seite.
  const fs = speicher();
  assert.equal(notseiteSchreiben({ art: 'start', grund: 'sk-ant-xyz', jetzt: JETZT, token: TOKEN, fsImpl: fs, ordner: 'Z' }), false);
  assert.equal(fs.dateien.size, 0);
  assert.equal(notseiteSchreiben({ art: 'start', grund: 'HTTP 500', jetzt: JETZT, token: TOKEN, fsImpl: fs, ordner: 'Z' }), true);
  // Schleife: erster Durchlauf gut, zweiter 403. Die allgemeine Fehlerseite bleibt, kein "Durchlauf gescheitert"-Neuschreiben.
  const fs2 = speicher();
  let n = 0;
  let zeit = JETZT;
  const f = async (url, o) => { if (new URL(url).pathname === P) { n += 1; if (n >= 2) return antwort(403, { message: 'x' }); } return github().f(url, o); };
  assert.equal(await main(['--schleife'], {
    tokenLaden: () => ({ ok: true, token: TOKEN }), leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: f }),
    jetzt: () => zeit, warte: async () => { zeit += 120_000; }, fsImpl: fs2, ordner: 'Z', sitzungen: keineSitzungen, ausgabe: () => {}, beiAbbruch: () => {},
  }), 1);
  const html = fs2.dateien.get(join('Z', 'zentrale.html'));
  assert.ok(html.includes('Die Startprüfung bei GitHub ist fehlgeschlagen: keine Berechtigung (403)'));
  assert.ok(!html.includes('Durchlauf gescheitert') && !html.includes('<table') && !/http-equiv="refresh"/.test(html));
});

// B1.3a: Sollwert aus der Referenzdatei. Kopf der Startpruefung ueberschreiben.
const mitKopf = wert => beide(p => (p === P ? antwort(200, api('repo'), wert === null ? {} : { 'github-authentication-token-expiration': wert }) : null), november());
const FRIST_OK = /PROBE frist-lese-token: 2026-12-21T21:04:30\.000Z \(erwartet 2026-12-21T21:04:30\.000Z, eingetragen 2026-11-21 von noah\) OK/;
const nurFrist = r => (r.text.match(/^PROBE frist-lese-token: .*$/m) ?? [''])[0];
const SEK = 1000;
const TAG = 24 * 3600 * SEK;

test('B1.3a Echt-Probe (1): Kopf gleich Referenzdatei ist OK, eine Sekunde daneben eine Abweichung; uebrige Proben laufen weiter', async () => {
  assert.equal(ECHTPROBE_SOLL, join(homedir(), '.zentrale', 'echtprobe-soll.json'));
  const gut = await probe(november());
  assert.equal(gut.code, 0, gut.text);
  assert.match(gut.text, FRIST_OK);
  assert.match(gut.text, /historisch-monat 2026-11: .* OK/, 'historische Proben unveraendert');

  for (const [name, r, muster] of [
    ['Kopf eine Sekunde frueher', await probe(mitKopf('2026-12-21 21:04:29 UTC')), /frist-lese-token: 2026-12-21T21:04:29\.000Z \(erwartet 2026-12-21T21:04:30\.000Z, eingetragen 2026-11-21 von noah\) ABWEICHUNG/],
    ['Kopf eine Sekunde spaeter', await probe(mitKopf('2026-12-21 21:04:31 UTC')), /frist-lese-token: 2026-12-21T21:04:31\.000Z .*ABWEICHUNG/],
    ['Soll eine Sekunde spaeter', await probe(november(), JETZT, { soll: sollText('2026-12-21T21:04:31Z', '2026-11-21') }), /frist-lese-token: 2026-12-21T21:04:30\.000Z \(erwartet 2026-12-21T21:04:31\.000Z, .*ABWEICHUNG/],
    ['Soll eine Sekunde frueher', await probe(november(), JETZT, { soll: sollText('2026-12-21T21:04:29Z', '2026-11-21') }), /frist-lese-token: .*\(erwartet 2026-12-21T21:04:29\.000Z, .*ABWEICHUNG/],
    ['Kopf fehlt', await probe(mitKopf(null)), /frist-lese-token: kein gueltiges Ablaufdatum im Kopf \(erwartet 2026-12-21T21:04:30\.000Z, .*ABWEICHUNG/],
    ['anderes Datum', await probe(mitKopf('2026-12-22 21:04:30 UTC')), /frist-lese-token: 2026-12-22T21:04:30\.000Z .*ABWEICHUNG/],
    ['ungueltiger Kopf', await probe(mitKopf('<b>2026-12-21 21:04:30 UTC</b>')), /frist-lese-token: kein gueltiges Ablaufdatum im Kopf .*ABWEICHUNG/],
  ]) {
    assert.equal(r.code, 1, `${name}: ${r.text}`);
    assert.match(r.text, muster, name);
    assert.match(r.text, /ECHTPROBE NICHT BESTANDEN: 1 Abweichungen/, `${name}: genau diese eine Probe weicht ab`);
    assert.ok(!r.text.includes('<b>'), 'Rohwert ausgegeben');
  }
});

test('B1.3a Echt-Probe (2): Datei fehlt, Link, Verzeichnis, Groesse, Git, Form und Felder; je eigener Grund, Exitcode 1', async () => {
  const lade = (fs, jetzt = JETZT, token = TOKEN) => ladeSoll({ datei: SOLL_DATEI, fsImpl: fs, jetzt, token });
  const gueltig = sollText('2026-12-21T21:04:30Z', '2026-11-21');
  assert.deepEqual(lade(sollFs(gueltig)), { ok: true, soll: LESE_SOLL, eingetragen: '2026-11-21', quelle: 'noah' }, 'Muss-Treffer');
  assert.equal(lade(sollFs(`﻿${gueltig}`)).ok, true, 'BOM erlaubt');

  const mitStat = (st, text = gueltig) => { const fs = sollFs(text); fs.lstatSync = () => st; return fs; };
  const lesefehler = (() => { const fs = sollFs(gueltig); fs.readFileSync = () => { throw new Error('EACCES'); }; return fs; })();
  const statfehler = (() => { const fs = sollFs(gueltig); fs.lstatSync = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }; return fs; })();
  const git = (() => { const fs = sollFs(gueltig); fs.dateien.set(join(resolve('Z'), '.git'), ''); return fs; })();
  const auffuellen = n => { const t = gueltig.replace(/\}$/, ''); return `${t}${' '.repeat(n - Buffer.byteLength(t) - 1)}}`; };
  assert.equal(Buffer.byteLength(auffuellen(4096)), 4096);
  assert.equal(lade(sollFs(auffuellen(4096))).ok, true, 'genau 4 KB ist erlaubt');
  const ohne = feld => { const j = JSON.parse(gueltig); delete j[feld]; return JSON.stringify(j); };

  const faelle = [
    ['fehlt', sollFs(null), 'Referenzdatei fehlt, bitte anlegen (siehe LIESMICH)'],
    ['nicht lesbar (lstat)', statfehler, 'Referenzdatei nicht lesbar'],
    ['nicht lesbar (read)', lesefehler, 'Referenzdatei nicht lesbar'],
    ['Link', mitStat({ isSymbolicLink: () => true, isFile: () => true, size: 10 }), 'Referenzdatei ist ein Link'],
    ['Verzeichnis', mitStat({ isSymbolicLink: () => false, isFile: () => false, size: 0 }), 'Referenzdatei ist keine Datei'],
    ['ueber 4 KB laut lstat', mitStat({ isSymbolicLink: () => false, isFile: () => true, size: 4097 }), 'Referenzdatei zu gross'],
    ['ueber 4 KB gelesen', mitStat({ isSymbolicLink: () => false, isFile: () => true, size: 10 }, auffuellen(4097)), 'Referenzdatei zu gross'],
    ['im Git-Arbeitsbaum', git, 'Referenzdatei liegt in einem Git-Arbeitsbaum'],
    ['kein JSON', sollFs('{"schema": '), 'kein JSON'],
    ['kein Objekt', sollFs('["zentrale-echtprobe-soll-v1"]'), 'kein JSON-Objekt'],
    ['null', sollFs('null'), 'kein JSON-Objekt'],
    ['falsches Schema', sollFs(sollText('2026-12-21T21:04:30Z', '2026-11-21', { schema: 'zentrale-echtprobe-soll-v2' })), 'falsches Schema'],
    ['Zusatzfeld', sollFs(sollText('2026-12-21T21:04:30Z', '2026-11-21', { kommentar: 'x' })), 'unbekanntes Zusatzfeld'],
    ['schema fehlt', sollFs(ohne('schema')), 'Feld schema fehlt'],
    ['leseTokenAblauf fehlt', sollFs(ohne('leseTokenAblauf')), 'Feld leseTokenAblauf fehlt'],
    ['eingetragen fehlt', sollFs(ohne('eingetragen')), 'Feld eingetragen fehlt'],
    ['quelle fehlt', sollFs(ohne('quelle')), 'Feld quelle fehlt'],
    ['quelle anders', sollFs(sollText('2026-12-21T21:04:30Z', '2026-11-21', { quelle: 'zentrale' })), 'quelle ist nicht noah'],
    ['quelle gross', sollFs(sollText('2026-12-21T21:04:30Z', '2026-11-21', { quelle: 'Noah' })), 'quelle ist nicht noah'],
  ];
  assert.equal(new Set(faelle.map(f => f[2])).size, 15, 'eigene Gruende');

  for (const [name, fs, grund] of faelle) {
    assert.deepEqual(lade(fs), { ok: false, grund }, name);
  }

  // Durch die Echt-Probe: Abweichung mit dem Grund, Exitcode 1, uebrige Proben laufen weiter, keine Datei geschrieben.
  for (const [name, fs, grund] of faelle) {
    const r = await probe(november(), JETZT, { sollLaden: a => ladeSoll({ ...a, datei: SOLL_DATEI, fsImpl: fs }) });
    assert.equal(r.code, 1, name);
    assert.equal(nurFrist(r), `PROBE frist-lese-token: Sollwert nicht pruefbar: ${grund} ABWEICHUNG`, name);
    assert.match(r.text, /PROBE repo: ok .*OK/, name);
    assert.match(r.text, /lauf Live 2 44765669207: .* OK/, name);
    assert.match(r.text, /historisch-monat 2026-11: .* OK/, name);
    assert.match(r.text, /ECHTPROBE NICHT BESTANDEN: 1 Abweichungen/, name);
    assert.deepEqual(fs.log, [], `${name}: keine Datei geschrieben`);
  }
});

test('B1.3a Echt-Probe (3, 6): ungueltiger Ablauf und Geheimnisse; kein Rohwert in der Ausgabe', async () => {
  for (const wert of ['2026-02-31T10:00:00Z', '2026-12-21T21:04:30', '2026-12-21T21:04:30+01:00', '2026-12-21T21:04:30.000Z', '<b>2026-12-21T21:04:30Z</b>',
    '2026-12-21T24:00:00Z', '2026-12-21 21:04:30Z', ' 2026-12-21T21:04:30Z', '2026-12-21T21:04:30Z\n', 1797282270000, null]) {
    const r = await probe(november(), JETZT, { soll: sollText(wert, '2026-11-21') });
    assert.equal(r.code, 1, String(wert));
    assert.equal(nurFrist(r), 'PROBE frist-lese-token: Sollwert nicht pruefbar: leseTokenAblauf ungueltig (erwartet JJJJ-MM-TTThh:mm:ssZ, echtes Datum) ABWEICHUNG', String(wert));
    assert.ok(typeof wert !== 'string' || !r.text.includes(wert), `Rohwert ausgegeben: ${wert}`);
    assert.ok(!r.text.includes('<b>'));
  }

  for (const wert of ['2026-02-30', '2026-11-21T00:00:00Z', '21.11.2026', '2026-11-1', 20261121]) {
    assert.deepEqual(sollAusJson(sollText('2026-12-21T21:04:30Z', wert), JETZT), { ok: false, grund: 'eingetragen ungueltig (erwartet JJJJ-MM-TT, echtes Datum)' }, String(wert));
  }

  // Geheimnisse in jedem Feld, auch in einem Zusatzfeld und als Tokenwert ohne Muster: abgelehnt, Wert erscheint nirgends.
  const geheim = ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'sk-ant-api03-ABCDEFGHIJKLMNOP'];
  for (const g of geheim) {
    for (const extra of [{ quelle: g }, { eingetragen: g }, { schema: g }, { leseTokenAblauf: g }, { notiz: g }]) {
      const r = await probe(november(), JETZT, { soll: sollText('2026-12-21T21:04:30Z', '2026-11-21', extra) });
      assert.equal(r.code, 1, g);
      assert.equal(nurFrist(r), 'PROBE frist-lese-token: Sollwert nicht pruefbar: Referenzdatei enthaelt ein Geheimnis-Muster ABWEICHUNG', `${g} ${Object.keys(extra)}`);
      assert.ok(!r.text.includes(g) && !r.text.includes(g.slice(0, 8)), 'Wert ausgegeben');
    }
  }
  const tok = 'abcdefgh12345678TOKEN';
  assert.deepEqual(ladeSoll({ datei: SOLL_DATEI, fsImpl: sollFs(sollText('2026-12-21T21:04:30Z', '2026-11-21', { notiz: tok })), jetzt: JETZT, token: tok }),
    { ok: false, grund: 'Referenzdatei enthaelt ein Geheimnis-Muster' }, 'Tokenwert ohne Muster');
  // Durch die Echt-Probe: der geladene Tokenwert erreicht den Filter.
  const zeilen = [];
  const code = await echtprobe([], {
    tokenLaden: () => ({ ok: true, token: tok }),
    leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: github(beide(zweig, november())).f }),
    ausgabe: t => zeilen.push(t), jetzt: JETZT,
    sollLaden: a => ladeSoll({ ...a, datei: SOLL_DATEI, fsImpl: sollFs(sollText('2026-12-21T21:04:30Z', '2026-11-21', { notiz: tok })) }),
  });
  assert.equal(code, 1);
  assert.ok(zeilen.includes('PROBE frist-lese-token: Sollwert nicht pruefbar: Referenzdatei enthaelt ein Geheimnis-Muster ABWEICHUNG'), zeilen.join('\n'));
  assert.ok(!zeilen.join('\n').includes(tok));
});

test('B1.3a Echt-Probe (4, 5): Zeitregeln, jeder Grenzfall einzeln', async () => {
  const pruef = (ablaufMs, eingetragen, jetzt) => sollAusJson(sollText(new Date(ablaufMs).toISOString().replace('.000Z', 'Z'), eingetragen), jetzt);
  const VERALTET = 'Sollwert abgelaufen, Referenzdatei nach der Token-Erneuerung neu eintragen';
  const ZU_WEIT = 'leseTokenAblauf mehr als 366 Tage in der Zukunft, nicht plausibel';

  // (4) Veraltet: Soll gleich jetzt und eine Sekunde davor; eine Sekunde danach geht in den Vergleich.
  assert.deepEqual(pruef(LESE_SOLL, '2026-11-23', LESE_SOLL), { ok: false, grund: VERALTET });
  assert.deepEqual(pruef(LESE_SOLL, '2026-11-23', LESE_SOLL + SEK), { ok: false, grund: VERALTET });
  assert.deepEqual(pruef(LESE_SOLL, '2026-11-23', LESE_SOLL - SEK), { ok: true, soll: LESE_SOLL, eingetragen: '2026-11-23', quelle: 'noah' });
  const vorher = await probe(november(), LESE_SOLL - SEK, { soll: sollText('2026-12-21T21:04:30Z', '2026-11-23') });
  assert.match(nurFrist(vorher), /2026-12-21T21:04:30\.000Z \(erwartet 2026-12-21T21:04:30\.000Z, eingetragen 2026-11-23 von noah\) OK$/);
  for (const jetzt of [LESE_SOLL, LESE_SOLL + SEK]) {
    const r = await probe(november(), jetzt, { soll: sollText('2026-12-21T21:04:30Z', '2026-11-23') });
    assert.equal(r.code, 1);
    assert.equal(nurFrist(r), `PROBE frist-lese-token: Sollwert nicht pruefbar: ${VERALTET} ABWEICHUNG`);
  }

  // (5) Plausibel: genau 366 Tage geht in den Vergleich, eine Sekunde mehr nicht.
  assert.deepEqual(pruef(JETZT + 366 * TAG + SEK, '2026-11-21', JETZT), { ok: false, grund: ZU_WEIT });
  assert.equal(pruef(JETZT + 366 * TAG, '2026-11-21', JETZT).ok, true);
  const weit = await probe(beide(nur(P, () => antwort(200, api('repo'), { 'github-authentication-token-expiration': kopfWert(JETZT + 366 * TAG) })), november()), JETZT,
    { soll: sollText(new Date(JETZT + 366 * TAG).toISOString().replace('.000Z', 'Z'), '2026-11-21') });
  assert.equal(weit.code, 0, weit.text);
  assert.match(nurFrist(weit), /2027-11-22T10:20:00\.000Z \(erwartet 2027-11-22T10:20:00\.000Z, eingetragen 2026-11-21 von noah\) OK$/);
  const zuWeit = await probe(november(), JETZT, { soll: sollText(new Date(JETZT + 366 * TAG + SEK).toISOString().replace('.000Z', 'Z'), '2026-11-21') });
  assert.equal(nurFrist(zuWeit), `PROBE frist-lese-token: Sollwert nicht pruefbar: ${ZU_WEIT} ABWEICHUNG`);

  // Ablauf vor dem Eintragungstag (eigener Grund); genau 00:00 des Eintragungstags ist nicht "vor", aber veraltet.
  assert.deepEqual(pruef(Date.parse('2026-11-20T23:59:59Z'), '2026-11-21', JETZT), { ok: false, grund: 'leseTokenAblauf liegt vor dem Eintragungstag, nicht plausibel' });
  assert.deepEqual(pruef(Date.parse('2026-11-21T00:00:00Z'), '2026-11-21', JETZT), { ok: false, grund: VERALTET });

  // eingetragen: heute gilt zu jeder Uhrzeit, morgen ist Zukunft (auch eine Sekunde vor Mitternacht).
  const ZUKUNFT = { ok: false, grund: 'eingetragen liegt in der Zukunft' };
  assert.equal(pruef(LESE_SOLL, '2026-11-21', Date.parse('2026-11-21T00:00:00Z')).ok, true);
  assert.equal(pruef(LESE_SOLL, '2026-11-21', Date.parse('2026-11-21T23:59:59Z')).ok, true);
  assert.deepEqual(pruef(LESE_SOLL, '2026-11-22', Date.parse('2026-11-21T23:59:59Z')), ZUKUNFT);
  assert.deepEqual(pruef(LESE_SOLL, '2027-01-01', JETZT), ZUKUNFT);
  const zukunft = await probe(november(), JETZT, { soll: sollText('2026-12-21T21:04:30Z', '2026-11-22') });
  assert.equal(nurFrist(zukunft), 'PROBE frist-lese-token: Sollwert nicht pruefbar: eingetragen liegt in der Zukunft ABWEICHUNG');

  // Unbekannte Zeit: kein Vergleich.
  assert.deepEqual(sollAusJson(sollText('2026-12-21T21:04:30Z', '2026-11-21'), Number.NaN), { ok: false, grund: 'aktuelle Zeit unbekannt' });
});

test('B1.3a Echt-Probe (7): kein Selbstbefuellen, Referenzdatei wird einmal und vor jedem Netzabruf geladen', async () => {
  // Fehlt die Datei, darf der Kopf (der genau dem echten Wert entspricht) nie als Sollwert dienen.
  const ohne = await probe(november(), JETZT, { soll: null });
  assert.equal(ohne.code, 1, ohne.text);
  assert.equal(nurFrist(ohne), 'PROBE frist-lese-token: Sollwert nicht pruefbar: Referenzdatei fehlt, bitte anlegen (siehe LIESMICH) ABWEICHUNG');
  assert.ok(!ohne.text.includes('2026-12-21T21:04:30'), 'Kopfwert ausgegeben');

  // Reihenfolge: genau ein Ladevorgang, vor dem ersten Leser-Abruf; die Datei-Attrappe bleibt unveraendert.
  const ereignisse = [];
  const fs = sollFs(sollText('2026-12-21T21:04:30Z', '2026-11-21'));
  const vorher = new Map(fs.dateien);
  const zeilen = [];
  const code = await echtprobe([], {
    tokenLaden: () => ({ ok: true, token: TOKEN }),
    sollLaden: a => { ereignisse.push('soll'); return ladeSoll({ ...a, datei: SOLL_DATEI, fsImpl: fs }); },
    leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: async (u, o) => { ereignisse.push('netz'); return github(beide(zweig, november())).f(u, o); } }),
    ausgabe: t => zeilen.push(t), jetzt: JETZT,
  });
  assert.equal(code, 0, zeilen.join('\n'));
  assert.equal(ereignisse[0], 'soll');
  assert.equal(ereignisse.filter(e => e === 'soll').length, 1);
  assert.ok(ereignisse.filter(e => e === 'netz').length > 10, 'Muss-Treffer: Netzabrufe gezaehlt');
  assert.deepEqual(fs.log, []);
  assert.deepEqual(fs.dateien, vorher);
});

// ---------------------------------------------------------------------------------------------------------------------
// B1.3c Laufwarnungen (Auftrag Abschnitt 6, Faelle 1 bis 10a). Grundlage ist der nachgebaute laufende Lauf 44900000001
// an #90 (Status waiting, Start 2026-11-21T10:00:03Z). Geprueft werden das Modell und die erzeugte Seite.
// ---------------------------------------------------------------------------------------------------------------------

const LW_LAUF = 44900000001;
const LW_START = '2026-11-21T10:00:03Z';
const lwBanner = html => (/<div class="banner laufwarnungen">(.*?)<\/div>/.exec(html) ?? [null, ''])[1];
const lwAmLauf = html => [...html.matchAll(/<p class="laufwarnung">(.*?)<\/p>/g)].map(m => m[1]);
const evLabel = (event, name, created_at) => ({ event, label: { name }, actor: { login: 'noah04091' }, created_at });
const mitEreignissen = (...zusatz) => nur(`${P}/issues/90/events`, () => antwort(200, [...api('events-90'), ...zusatz]));
const mitPulls = (...zusatz) => nur(`${P}/pulls`, () => antwort(200, [...api('pulls'), ...zusatz]));
const pr = (number, extra = {}) => ({
  number, state: 'open', draft: false, merged_at: null, head: { ref: `wp/x-${number}`, sha: 'c'.repeat(40) }, base: { ref: 'main' },
  html_url: `https://github.com/noah04091/agenten-probe/pull/${number}`, ...extra,
});
// Laufliste mit geaendertem Lauf 44900000001.
const laufAendern = aendern => (p, u) => {
  if (p !== RUNS || u.searchParams.get('event') !== 'issues' || (u.searchParams.get('page') ?? '1') !== '1') {
    return null;
  }

  const w = api('runs').workflow_runs.map(x => (x.id === LW_LAUF ? aendern({ ...x }) : x));
  return antwort(200, { total_count: w.length, workflow_runs: w });
};

async function lw(stoerung = () => null) {
  const r = await lauf(stoerung);
  const html = seite(r.modell, JETZT);
  return { eintraege: r.modell.laufwarnungen.eintraege, html, banner: lwBanner(html), amLauf: lwAmLauf(html) };
}

// "nicht pruefbar": sichtbar oben, nie eine Entwarnung.
function nichtPruefbar(r, quelle, name) {
  assert.ok(r.eintraege.some(e => e.art === 'nicht-pruefbar' && e.quelle.includes(quelle)), `${name}: ${JSON.stringify(r.eintraege)}`);
  assert.ok(r.banner.includes('Laufwarnungen nicht prüfbar ('), name);
  assert.ok(!/keine (Lauf)?warnung/i.test(r.html), `${name}: Entwarnung`);
}

const LABEL_TEXT = 'Lauf 44900000001 an #90: während des Laufs wurde das Label bot-auftrag geändert (21.11. 10:00 UTC). '
  + 'Das kann den Lauf abbrechen. Nichts erneut setzen, erst das Ende abwarten.';

test('B1.3c (Grundlage): laufender Lauf ohne Labelaenderung und ohne offene PRs: keine Laufwarnung, kein Platzhalter', async () => {
  const r = await lw();
  assert.deepEqual(r.eintraege, []);
  assert.equal(r.banner, '');
  assert.ok(!r.html.includes('laufwarnung') && !r.html.includes('nicht prüfbar'));
});

test('B1.3c P1 (1): unlabeled bot-auftrag 1 s nach Laufstart: Warnung mit Lauf, Issue und Zeit, oben und am Lauf', async () => {
  const r = await lw(mitEreignissen(evLabel('unlabeled', 'bot-auftrag', '2026-11-21T10:00:04Z')));
  assert.deepEqual(r.eintraege, [{ art: 'label', laufId: LW_LAUF, issue: 90, zeit: Date.parse('2026-11-21T10:00:04Z'), label: 'bot-auftrag', weitere: 0 }]);
  assert.equal(r.banner, `<p>${LABEL_TEXT}</p>`);
  assert.deepEqual(r.amLauf, [LABEL_TEXT]);

  // Mehrere Aenderungen: die erste wird genannt, die weiteren gezaehlt.
  const zwei = await lw(mitEreignissen(evLabel('labeled', 'bot-auftrag', '2026-11-21T10:07:00Z'), evLabel('unlabeled', 'bot-auftrag', '2026-11-21T10:00:04Z')));
  assert.equal(zwei.eintraege[0].weitere, 1);
  assert.ok(zwei.banner.includes('(21.11. 10:00 UTC). Danach 1 weitere Labeländerung. Das kann den Lauf abbrechen.'));
});

test('B1.3c P1 (2, 3): Ereignis zur Startzeit oder davor und abgeschlossener Lauf: keine Warnung', async () => {
  for (const zeit of [LW_START, '2026-11-21T10:00:02Z', '2026-11-21T09:00:00Z']) {
    const r = await lw(mitEreignissen(evLabel('unlabeled', 'bot-auftrag', zeit)));
    assert.deepEqual(r.eintraege, [], zeit);
  }

  // Gegenprobe zur Grenze: eine Millisekunde danach zaehlt.
  assert.equal((await lw(mitEreignissen(evLabel('unlabeled', 'bot-auftrag', '2026-11-21T10:00:03.001Z')))).eintraege[0]?.art, 'label');

  const fertig = await lw(beide(laufAendern(x => ({ ...x, status: 'completed', conclusion: 'failure' })), mitEreignissen(evLabel('unlabeled', 'bot-auftrag', '2026-11-21T10:05:00Z'))));
  assert.deepEqual(fertig.eintraege, []);
  assert.equal(fertig.banner, '');
});

test('B1.3c P1 (4): Labelname nur nach festem Muster, sonst "ein Label", nie Rohtext', async () => {
  const boese = ['bot auftrag', '<b>x</b>', '[klick](https://example.invalid)', 'a'.repeat(51), 'Bot-Auftrag', 'agent:js"text', 'x\ny'];

  for (const name of boese) {
    const r = await lw(mitEreignissen(evLabel('labeled', name, '2026-11-21T10:01:00Z')));
    assert.equal(r.eintraege[0].label, null, name);
    assert.ok(r.banner.includes('wurde ein Label geändert'), name);
    assert.ok(!r.html.includes(name), `${JSON.stringify(name)}: Rohtext`);
  }

  // Leerer Name, Label ohne Namen, Ereignis ohne label-Feld.
  for (const ev of [evLabel('labeled', '', '2026-11-21T10:01:00Z'), evLabel('labeled', undefined, '2026-11-21T10:01:00Z'), { event: 'labeled', created_at: '2026-11-21T10:01:00Z' }]) {
    assert.ok((await lw(mitEreignissen(ev))).banner.includes('wurde ein Label geändert'), JSON.stringify(ev));
  }

  // Gegenprobe: Namen nach Muster (50 Zeichen, mit Doppelpunkt) erscheinen.
  const genau = 'a'.repeat(50);
  assert.ok((await lw(mitEreignissen(evLabel('labeled', genau, '2026-11-21T10:01:00Z')))).banner.includes(`wurde das Label ${genau} geändert`));
  assert.ok((await lw(mitEreignissen(evLabel('labeled', 'agent:js-text', '2026-11-21T10:01:00Z')))).banner.includes('wurde das Label agent:js-text geändert'));
});

test('B1.3c P1 (5): Ereignisse nicht lesbar, nur teilweise gelesen, Lauf keinem oder mehreren Issues zugeordnet: nicht pruefbar', async () => {
  const spaet = evLabel('unlabeled', 'bot-auftrag', '2026-11-21T10:05:00Z');
  const voll = Array.from({ length: 100 }, (_, i) => evLabel('labeled', 'agent:js-text', `2026-11-21T09:${String(i % 60).padStart(2, '0')}:00Z`));
  const issue90 = api('issues-alle').find(i => i.number === 90);
  const faelle = {
    nicht_lesbar: beide(nur(`${P}/issues/90/events`, () => antwort(500, {}))),
    teilweise: (p, u) => (p === `${P}/issues/90/events` ? ((u.searchParams.get('page') ?? '1') === '1' ? antwort(200, [...voll.slice(1), spaet]) : antwort(500, {})) : null),
    issueliste_kaputt: beide((p, u) => (p === `${P}/issues` && u.searchParams.get('state') === 'all' ? antwort(500, {}) : null), mitEreignissen(spaet)),
    zwei_issues: beide(
      (p, u) => (p === `${P}/issues` && u.searchParams.get('state') === 'all' ? antwort(200, [...api('issues-alle'), { ...issue90, number: 92 }]) : null),
      nur(`${P}/issues/92/events`, () => antwort(200, api('events-90'))),
      mitEreignissen(spaet),
    ),
    kein_issue: beide(laufAendern(x => ({ ...x, display_title: 'Titel ohne Issue' })), mitEreignissen(spaet)),
  };

  for (const [name, stoerung] of Object.entries(faelle)) {
    const r = await lw(stoerung);
    nichtPruefbar(r, '', name);
    assert.ok(r.eintraege.some(e => e.art === 'nicht-pruefbar' && e.laufId === LW_LAUF && /Issue|Ereignisse/.test(e.quelle)), `${name}: ${JSON.stringify(r.eintraege)}`);
    assert.ok(!r.eintraege.some(e => e.art === 'label'), `${name}: konkrete Labelaussage`);
    assert.ok(!r.banner.includes('wurde ein Label') && !r.banner.includes('wurde das Label'), name);
  }

  // Ereignisse des zugeordneten Issues fehlen (reine Logik): nicht pruefbar.
  const lauf1 = { id: 1, status: 'in_progress', start: Date.parse(LW_START) };
  const ohneEv = laufwarnungen({ laeufe: [{ lauf: lauf1, issue: { nummer: 7, ereignisse: null } }], laeufeVollstaendig: true, pulls: [], pullsVollstaendig: true });
  assert.deepEqual(ohneEv, [{ art: 'nicht-pruefbar', laufId: 1, quelle: 'Ereignisse von #7 nicht vollständig lesbar' }]);
  // Laufliste nicht gelesen oder unvollstaendig, Status unbekannt: nicht pruefbar.
  nichtPruefbar(await lw(nur(RUNS, () => antwort(500, {}))), 'Läufe nicht gelesen', 'runs 500');
  assert.deepEqual(laufwarnungen({ laeufe: [], laeufeVollstaendig: false, pulls: [], pullsVollstaendig: true }), [{ art: 'nicht-pruefbar', laufId: null, quelle: 'Laufliste unvollständig' }]);
  nichtPruefbar(await lw(laufAendern(x => ({ ...x, status: 'irgendwas' }))), 'Status von Lauf 44900000001 unbekannt', 'status');
  // Seite ohne Laufwarnungsmodell (frueherer Stand): nicht pruefbar, nie leer.
  const alt = (await lauf()).modell;
  delete alt.laufwarnungen;
  assert.ok(lwBanner(seite(alt, JETZT)).includes('Laufwarnungen nicht prüfbar (nicht ermittelt).'));
});

test('B1.3c P1 (5a): Ereignis ohne gueltige Zeit, Laufstart fehlt oder ungueltig: nicht pruefbar', async () => {
  for (const zeit of [undefined, null, '', 'gestern', '2026-11-21 10:05:00', '2026-11-21T10:05:00+01:00', '2026-13-01T00:00:00Z', 1763719504000]) {
    const r = await lw(mitEreignissen(evLabel('unlabeled', 'bot-auftrag', zeit)));
    nichtPruefbar(r, 'Ereignisse von #90', String(zeit));
    assert.ok(!r.eintraege.some(e => e.art === 'label'), String(zeit));
  }

  // Unbrauchbarer Eintrag in der Ereignisliste.
  nichtPruefbar(await lw(mitEreignissen('kaputt')), 'Ereignisse von #90', 'Eintrag');
  // Gegenprobe: ein anderes Ereignis ohne Zeit (kein Labelereignis) stoert nicht.
  assert.deepEqual((await lw(mitEreignissen({ event: 'renamed', created_at: 'gestern' }))).eintraege, []);

  for (const start of [null, 'kaputt', '1999-12-31T23:59:59Z']) {
    const r = await lw(beide(laufAendern(x => ({ ...x, created_at: start })), mitEreignissen(evLabel('unlabeled', 'bot-auftrag', '2026-11-21T10:05:00Z')), mitPulls(pr(120))));
    assert.ok(r.eintraege.some(e => e.art === 'nicht-pruefbar' && e.laufId === LW_LAUF), String(start));
    assert.ok(!r.eintraege.some(e => e.art === 'label' || e.art === 'gemergt' || e.art === 'offen'), String(start));
    assert.ok(r.banner.includes('Laufwarnungen nicht prüfbar'), String(start));
  }
});

const OFFEN_TEXT = 'Lauf 44900000001 an #90 läuft. Ein Merge könnte den laufenden Auftrag ungültig machen. Offene PRs nach main: #120, #121.';
const GEMERGT_TEXT = 'Während Lauf 44900000001 wurde ein PR nach main gemergt (#120). Der Lauf könnte dadurch ungültig sein.';

test('B1.3c P2 (6, 7): offener PR nach main ergibt den Hinweis mit Nummern, andere Basis nicht', async () => {
  const r = await lw(mitPulls(pr(121), pr(120), pr(122, { base: { ref: 'wp/irgendwas' } })));
  assert.deepEqual(r.eintraege, [{ art: 'offen', laufId: LW_LAUF, issue: 90, prs: [120, 121] }]);
  assert.equal(r.banner, `<p>${OFFEN_TEXT}</p>`);
  assert.deepEqual(r.amLauf, [OFFEN_TEXT]);

  const andere = await lw(mitPulls(pr(122, { base: { ref: 'wp/irgendwas' } }), pr(123, { base: { ref: 'mainx' } })));
  assert.deepEqual(andere.eintraege, []);
  // Kein laufender Lauf: kein Hinweis trotz offener PRs.
  assert.deepEqual((await lw(beide(laufAendern(x => ({ ...x, status: 'completed' })), mitPulls(pr(120))))).eintraege, []);
});

test('B1.3c P2 (8, 9): Merge nach Laufstart ist eine Warnung mit Vorrang; davor oder genau zum Start keine', async () => {
  const r = await lw(mitPulls(pr(121), pr(120, { state: 'closed', merged_at: '2026-11-21T10:05:00Z' })));
  assert.deepEqual(r.eintraege, [{ art: 'gemergt', laufId: LW_LAUF, issue: 90, prs: [120] }]);
  assert.equal(r.banner, `<p>${GEMERGT_TEXT}</p>`);
  assert.deepEqual(r.amLauf, [GEMERGT_TEXT]);
  assert.ok(!r.banner.includes('Offene PRs'), 'Vorrang');

  for (const zeit of [LW_START, '2026-11-21T09:59:59Z']) {
    assert.deepEqual((await lw(mitPulls(pr(120, { state: 'closed', merged_at: zeit })))).eintraege, [], zeit);
  }

  // Gemergt nach Laufstart, aber auf andere Basis: keine Warnung.
  assert.deepEqual((await lw(mitPulls(pr(120, { state: 'closed', merged_at: '2026-11-21T10:05:00Z', base: { ref: 'wp/x' } })))).eintraege, []);
});

test('B1.3c P2 (10): PRs nicht lesbar oder unvollstaendig, Basis oder merged_at fehlt oder ungueltig: nicht pruefbar, keine Merge-Aussage', async () => {
  const spaet = { state: 'closed', merged_at: '2026-11-21T10:05:00Z' };
  const voll = Array.from({ length: 100 }, (_, i) => pr(200 + i, { state: 'closed' }));
  const faelle = {
    nicht_lesbar: nur(`${P}/pulls`, () => antwort(500, {})),
    unvollstaendig: (p, u) => (p === `${P}/pulls` ? ((u.searchParams.get('page') ?? '1') === '1' ? antwort(200, [pr(120, spaet), ...voll.slice(1)]) : antwort(500, {})) : null),
    basis_fehlt: mitPulls(pr(120, spaet), { ...pr(121), base: undefined }),
    basis_kein_text: mitPulls(pr(120, spaet), pr(121, { base: { ref: 7 } })),
    merged_at_fehlt: mitPulls(pr(120, spaet), { ...pr(121), merged_at: undefined }),
    merged_at_ungueltig: mitPulls(pr(120, { state: 'closed', merged_at: 'gestern' })),
    merged_at_zahl: mitPulls(pr(120, { state: 'closed', merged_at: 1763719504000 })),
    zustand_unbekannt: mitPulls(pr(121, { state: 'irgendwas' })),
    nummer_fehlt: mitPulls(pr(120, spaet), pr(undefined)),
  };

  for (const [name, stoerung] of Object.entries(faelle)) {
    const r = await lw(stoerung);
    nichtPruefbar(r, 'PRs nicht vollständig lesbar', name);
    assert.ok(!r.eintraege.some(e => e.art === 'gemergt' || e.art === 'offen'), name);
    assert.ok(!r.banner.includes('gemergt') && !r.banner.includes('Offene PRs'), name);
  }
});

test('B1.3c P2 (10a): kein Text der Seite behauptet einen Vergleich von main mit dem Ausgangsstand eines Laufs', async () => {
  const VERBOTEN = /SHA|weicht|Ausgangs|main hat sich|main wurde geändert|Stand von main|main ist neuer|Commit von main/i;
  const szenarien = [
    () => null,
    mitPulls(pr(120)),
    mitPulls(pr(120, { state: 'closed', merged_at: '2026-11-21T10:05:00Z' })),
    nur(`${P}/pulls`, () => antwort(500, {})),
    mitEreignissen(evLabel('unlabeled', 'bot-auftrag', '2026-11-21T10:00:04Z')),
    laufAendern(x => ({ ...x, created_at: null })),
  ];
  let saetze = 0;

  for (const s of szenarien) {
    const r = await lw(s);
    // Die ganze Seite ohne die Spalte "Fehler laut Log" (deren Klartexte stammen aus dem Log, nicht aus einem Vergleich).
    const ohneLogSpalte = r.html.replace(/<td>[a-z0-9-]+: [^<]*<\/td>/g, '');
    assert.ok(!VERBOTEN.test(ohneLogSpalte), ohneLogSpalte.match(VERBOTEN)?.[0]);
    saetze += r.eintraege.length;
  }

  assert.ok(saetze >= 5, 'Muss-Treffer: Warnsaetze erzeugt');

  for (const w of [{ art: 'label', laufId: 1, issue: 2, zeit: 0, label: null, weitere: 3 }, { art: 'gemergt', laufId: 1, issue: 2, prs: [3] }, { art: 'offen', laufId: 1, issue: null, prs: [3] }, { art: 'nicht-pruefbar', quelle: 'x' }]) {
    assert.ok(!VERBOTEN.test(laufwarnungText(w)), w.art);
  }

  // Gegenprobe: die Wache erkennt einen solchen Satz.
  assert.ok(VERBOTEN.test('Lauf 1: main weicht vom Ausgangscommit ab.'));
});

// B1.3c Nachbesserung (Befund ChatGPT, bestaetigt von T1).
test('B1.3c P2 (10b): merged_at zaehlt nur bei geschlossenem PR; offen oder unbekannter Zustand mit merged_at: nicht pruefbar', async () => {
  const spaet = '2026-11-21T10:05:00Z';

  for (const state of ['open', 'seltsam', undefined, null]) {
    const r = await lw(mitPulls(pr(120, { state, merged_at: spaet })));
    nichtPruefbar(r, 'PRs nicht vollständig lesbar', String(state));
    assert.ok(!r.eintraege.some(e => e.art === 'gemergt' || e.art === 'offen'), String(state));
    assert.ok(!r.banner.includes('gemergt') && !r.amLauf.some(t => t.includes('gemergt')), String(state));
  }

  // Gegenprobe: geschlossen mit gueltigem merged_at bleibt gemergt.
  const zu = await lw(mitPulls(pr(120, { state: 'closed', merged_at: spaet })));
  assert.deepEqual(zu.eintraege, [{ art: 'gemergt', laufId: LW_LAUF, issue: 90, prs: [120] }]);
});

test('B1.3c (Gesamtablauf): Laufliste gelesen, aber unvollstaendig (total_count groesser): "Laufliste unvollständig"', async () => {
  const unvollstaendig = (p, u) => {
    if (p !== RUNS || u.searchParams.get('event') !== 'issues') {
      return null;
    }

    const w = api('runs').workflow_runs;
    return antwort(200, { total_count: w.length + 5, workflow_runs: (u.searchParams.get('page') ?? '1') === '1' ? w : [] });
  };
  const r = await lw(unvollstaendig);
  assert.equal(r.eintraege[0]?.art, 'nicht-pruefbar');
  nichtPruefbar(r, 'Laufliste unvollständig', 'runs');
  assert.ok(r.banner.includes('Laufwarnungen nicht prüfbar (Laufliste unvollständig).'));
  // Gegenprobe: dieselbe Liste mit passendem total_count ergibt keine Laufwarnung.
  assert.deepEqual((await lw(laufAendern(x => x))).eintraege, []);
});

test('B1.3c (Gesamtablauf): PR-Liste gelesen, aber unvollstaendig (Seitengrenze erreicht): nicht pruefbar, keine Merge-Aussage', async () => {
  // Jede Seite voll (100 PRs): holeAlleSeiten liefert klasse ok mit vollstaendig false. Auf Seite 1 ein Merge nach dem
  // Laufstart und ein offener PR nach main.
  const seitenAbrufe = [];
  const voll = (p, u) => {
    if (p !== `${P}/pulls`) {
      return null;
    }

    const s = Number(u.searchParams.get('page') ?? '1');
    seitenAbrufe.push(s);
    const liste = Array.from({ length: 100 }, (_, i) => pr(1000 * s + i, { state: 'closed' }));
    if (s === 1) {
      liste[0] = pr(120, { state: 'closed', merged_at: '2026-11-21T10:05:00Z' });
      liste[1] = pr(121);
    }

    return antwort(200, liste);
  };
  const r = await lw(voll);
  assert.equal(Math.max(...seitenAbrufe), 10, 'Muss-Treffer: Seitengrenze erreicht');
  nichtPruefbar(r, 'PRs nicht vollständig lesbar', 'pulls');
  assert.ok(!r.eintraege.some(e => e.art === 'gemergt' || e.art === 'offen'));
  assert.ok(!r.banner.includes('gemergt') && !r.banner.includes('Offene PRs'));
});
