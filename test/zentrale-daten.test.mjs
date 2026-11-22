// B1.1 Command Center: Abbildung der API-Antworten (daten.mjs) und der ganze Ablauf (zentrale.mjs) gegen eine
// nachgebaute GitHub-API aus test/fixtures/zentrale. Kein Netz.
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_NICHT_GESTARTET, freigabenAus, issueZuLauf, jobsAus, kostenAusJob1, laeufeAus, monatsKosten, offeneAuftraege, pflichtchecks, prZuLauf,
  restMinuten, startfreigaben,
} from '../werkzeuge/zentrale/daten.mjs';
import {
  KOSTEN_TOLERANZ, MONAT_SOLL, REFERENZ_JETZT, SOLL, echtprobe, historischerAbruf, referenzLeser, unbelegteLaeufe, vergleicheLauf, vergleicheMonat,
} from '../werkzeuge/zentrale/echtprobe.mjs';
import { seite } from '../werkzeuge/zentrale/darstellung.mjs';
import { erzeugeLeser } from '../werkzeuge/zentrale/github-lesen.mjs';
import { durchlauf, main, sammle, schleifeBeenden, zusammenfuehren } from '../werkzeuge/zentrale/zentrale.mjs';

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
async function probe(stoerung = () => null, jetzt = JETZT) {
  const zeilen = [];
  const code = await echtprobe([], {
    tokenLaden: () => ({ ok: true, token: TOKEN }),
    leserBauen: ({ token }) => erzeugeLeser({ token, fetchImpl: github(beide(zweig, stoerung)).f }),
    ausgabe: t => zeilen.push(t),
    jetzt,
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
  const ende = fs2.dateien.get(html);
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
