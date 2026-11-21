// B1.1 Command Center: github-lesen.mjs. Antwortklassen (W4), nur GET, Seiten, Log-Weiterleitung ohne Token.
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GRENZE_LOG, MAX_SEITEN, erzeugeLeser } from '../werkzeuge/zentrale/github-lesen.mjs';

const TOKEN = 'github_pat_TESTNURATTRAPPE_0000000000';
const antwort = (status, koerper = '', kopf = {}) => ({
  status,
  headers: { get: k => kopf[k.toLowerCase()] ?? null },
  text: async () => (typeof koerper === 'string' ? koerper : JSON.stringify(koerper)),
});

// Attrappe: protokolliert jeden Aufruf; Antwort aus einer Funktion der URL.
function attrappe(antworten) {
  const aufrufe = [];
  const f = async (url, opt) => {
    aufrufe.push({ url, opt });
    const r = antworten(new URL(url), opt);

    if (r instanceof Error) {
      throw r;
    }

    return r;
  };

  return { f, aufrufe };
}

const leser = antworten => {
  const a = attrappe(antworten);
  return { l: erzeugeLeser({ token: TOKEN, fetchImpl: a.f }), aufrufe: a.aufrufe };
};

test('Antwortklassen (W4): nur 404 mit "Not Found" ist fehlt, alles andere ausser 200 mit JSON ist unbekannt', async () => {
  const fall = async (r, erwartet, grund) => {
    const { l } = leser(() => r);
    const e = await l.holeJson('/repos/noah04091/agenten-probe');
    assert.equal(e.klasse, erwartet, `${erwartet} ${grund ?? ''}`);

    if (grund) {
      assert.match(e.grund, grund);
    }

    return e;
  };

  assert.deepEqual((await fall(antwort(200, { a: 1 }), 'ok')).daten, { a: 1 });
  await fall(antwort(200, '{kein json'), 'unbekannt', /ungültiges JSON/);
  await fall(antwort(404, { message: 'Not Found', documentation_url: 'x' }), 'fehlt');
  await fall(antwort(404, { message: 'Branch not found' }), 'unbekannt', /404/);
  await fall(antwort(404, 'Not Found'), 'unbekannt', /404/);
  await fall(antwort(404, ''), 'unbekannt', /404/);
  await fall(antwort(401, { message: 'Bad credentials' }), 'unbekannt', /401/);
  await fall(antwort(403, { message: 'Resource not accessible' }), 'unbekannt', /Berechtigung/);
  await fall(antwort(403, {}, { 'x-ratelimit-remaining': '0' }), 'unbekannt', /Rate-Limit/);
  await fall(antwort(429, {}, { 'x-ratelimit-remaining': '0' }), 'unbekannt', /Rate-Limit/);
  await fall(antwort(409, {}), 'unbekannt', /409/);
  await fall(antwort(500, {}), 'unbekannt', /500/);
  await fall(antwort(502, '<html>'), 'unbekannt', /502/);
  await fall(antwort(301, '', { location: 'https://api.github.com/x' }), 'unbekannt', /301/);
  await fall(antwort(200, 'x', { 'content-length': String(30 * 1024 * 1024) }), 'unbekannt', /zu groß/);
  await fall(Object.assign(new Error('t'), { name: 'TimeoutError' }), 'unbekannt', /Zeitlimit/);
  await fall(new TypeError('fetch failed'), 'unbekannt', /Netzfehler/);
});

test('Nur GET auf api.github.com mit festen Kopfzeilen, ohne Weiterleitung, mit Zeitlimit', async () => {
  const { l, aufrufe } = leser(() => antwort(200, []));
  await l.holeJson('/repos/noah04091/agenten-probe/issues?state=open&per_page=100');
  assert.equal(aufrufe.length, 1);
  const { url, opt } = aufrufe[0];
  assert.equal(url, 'https://api.github.com/repos/noah04091/agenten-probe/issues?state=open&per_page=100');
  assert.equal(opt.method, 'GET');
  assert.equal(opt.redirect, 'manual');
  assert.ok(opt.signal instanceof AbortSignal);
  assert.deepEqual({ ...opt.headers }, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'zentrale-b1' });
  assert.equal(opt.body, undefined);

  // Ungueltige Pfade gehen nie ins Netz.
  for (const pfad of ['https://evil.example/x', '//evil.example/x', '/repos/../x', 'repos/x', '/a b', '/x?y=<z>', '']) {
    const r = await l.holeJson(pfad);
    assert.equal(r.klasse, 'unbekannt', pfad);
  }

  assert.equal(aufrufe.length, 1);
  assert.throws(() => erzeugeLeser({ token: '', fetchImpl: () => {} }), /ohne Token/);
});

test('Seiten: vollstaendig nur mit kurzer letzter Seite und passendem total_count; Grenze und Fehler', async () => {
  const seite = (n, gross) => Array.from({ length: gross }, (_, i) => ({ id: n * 1000 + i }));
  let { l, aufrufe } = leser(u => antwort(200, { total_count: 150, jobs: u.searchParams.get('page') === '1' ? seite(1, 100) : seite(2, 50) }));
  let r = await l.holeAlleSeiten('/repos/noah04091/agenten-probe/actions/runs/1/jobs?per_page=100', { feld: 'jobs' });
  assert.deepEqual([r.klasse, r.daten.length, r.vollstaendig, aufrufe.length], ['ok', 150, true, 2]);
  assert.ok(aufrufe[1].url.endsWith('per_page=100&page=2'));

  ({ l } = leser(() => antwort(200, { total_count: 999, jobs: seite(1, 10) })));
  r = await l.holeAlleSeiten('/x/y', { feld: 'jobs' });
  assert.equal(r.vollstaendig, false, 'total_count passt nicht');

  ({ l, aufrufe } = leser(() => antwort(200, seite(1, 100))));
  r = await l.holeAlleSeiten('/x/y');
  assert.deepEqual([r.klasse, r.vollstaendig, aufrufe.length, r.daten.length], ['ok', false, MAX_SEITEN, 100 * MAX_SEITEN]);

  ({ l } = leser(u => (u.searchParams.get('page') === '1' ? antwort(200, seite(1, 100)) : antwort(500, {}))));
  assert.equal((await l.holeAlleSeiten('/x/y')).klasse, 'unbekannt', 'Fehler auf Seite 2');
  ({ l } = leser(() => antwort(404, { message: 'Not Found' })));
  assert.equal((await l.holeAlleSeiten('/x/y')).klasse, 'unbekannt', 'Listen kennen kein fehlt');
  ({ l } = leser(() => antwort(200, { anders: [] })));
  assert.equal((await l.holeAlleSeiten('/x/y', { feld: 'jobs' })).klasse, 'unbekannt');
});

test('Logs: 302 nur auf productionresultssa<n>.blob.core.windows.net per HTTPS, Download ohne Token', async () => {
  const ziel = 'https://productionresultssa17.blob.core.windows.net/actions-results/x?sig=abc';
  let { l, aufrufe } = leser(u => (u.hostname === 'api.github.com' ? antwort(302, '', { location: ziel }) : antwort(200, 'A6-FEHLER abnahme-exitcode\n')));
  const r = await l.holeLog(136489652497);
  assert.deepEqual(r, { klasse: 'ok', text: 'A6-FEHLER abnahme-exitcode\n' });
  assert.equal(aufrufe.length, 2);
  assert.equal(aufrufe[0].url, 'https://api.github.com/repos/noah04091/agenten-probe/actions/jobs/136489652497/logs');
  assert.equal(aufrufe[0].opt.redirect, 'manual');
  assert.equal(aufrufe[1].url, ziel);
  assert.equal(aufrufe[1].opt.method, 'GET');
  assert.equal(aufrufe[1].opt.redirect, 'error');
  assert.ok(!JSON.stringify(aufrufe[1].opt.headers).includes(TOKEN), 'Token an fremden Host');
  assert.ok(!Object.keys(aufrufe[1].opt.headers).some(k => k.toLowerCase() === 'authorization'));

  // Unerwartete Ziele: kein zweiter Aufruf, unbekannt.
  for (const location of ['http://productionresultssa1.blob.core.windows.net/x', 'https://evil.example/x', 'https://productionresultssa1.blob.core.windows.net.evil.example/x',
    'https://productionresultssa1.blob.core.windows.net:8443/x', 'https://u:p@productionresultssa1.blob.core.windows.net/x', 'https://api.github.com/x', 'kein url', null]) {
    ({ l, aufrufe } = leser(() => antwort(302, '', location === null ? {} : { location })));
    assert.equal((await l.holeLog(1)).klasse, 'unbekannt', String(location));
    assert.equal(aufrufe.length, 1, String(location));
  }

  // Andere Statuscodes der API und Downloadfehler.
  for (const [api, download, grund] of [[antwort(200, 'log'), null, /ohne Weiterleitung/], [antwort(403, {}), null, /Berechtigung/], [antwort(410, {}), null, /410/],
    [antwort(302, '', { location: ziel }), antwort(403, ''), /Download HTTP 403/], [antwort(302, '', { location: ziel }), new TypeError('redirect'), /Downloadfehler/],
    [antwort(302, '', { location: ziel }), antwort(200, 'x', { 'content-length': String(GRENZE_LOG + 1) }), /zu groß/]]) {
    ({ l } = leser(u => (u.hostname === 'api.github.com' ? api : download)));
    const e = await l.holeLog(1);
    assert.equal(e.klasse, 'unbekannt');
    assert.match(e.grund, grund);
  }

  ({ l, aufrufe } = leser(() => antwort(200, '')));
  assert.equal((await l.holeLog(-1)).klasse, 'unbekannt');
  assert.equal(aufrufe.length, 0);
});

test('Der Token-Wert steht in keinem Ergebnis und keiner Meldung', async () => {
  const ergebnisse = [];

  for (const r of [antwort(401, { message: TOKEN }), antwort(500, TOKEN), new Error(TOKEN), antwort(404, { message: TOKEN })]) {
    const { l } = leser(() => r);
    ergebnisse.push(await l.holeJson('/x'), await l.holeLog(1));
  }

  assert.ok(!JSON.stringify(ergebnisse).includes(TOKEN));
  assert.ok(!JSON.stringify(ergebnisse).includes('TESTNURATTRAPPE'));
});
