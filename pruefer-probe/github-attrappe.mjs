// B2.1 Generalprobe der Vorpruefung: nachgebautes GitHub, ohne Netz, ohne Geheimnisse.
//
// Zwei Verwendungen:
// 1. Tests importieren erzeugeGithub() und bekommen eine fetch-Attrappe mit Stoerungen je Pfad.
// 2. Die Generalprobe im Workflow laedt diese Datei mit node --import vor dem Pruefskript (Anker im Workflow). Nur
//    dann, also wenn das Hauptskript scripts/agent-pruefer-vorpruefung.mjs ist, ersetzt sie fetch und verkuerzt das
//    Warten zwischen den Check-Versuchen (30 Sekunden) auf null. Der Fall ergibt sich aus der Lauf-ID.
//
// Die Daten sind PR #113 (Lauf 45061471286, Issue #111) nachgebaut, mit eigenen Lauf-IDs je Fall.

import { createHash } from 'node:crypto';

export const REPO = 'noah04091/agenten-probe';
export const BASIS = '6fbebf1ee853996878cc4876d216538eae50e85d';
export const KOPF = 'd633a2984dd6c23fb70967dfa57b77204495dc9b';
export const BOT = 'noah04091-agenten-probe-cloud-bot[bot]';
export const PR = 113;
export const ISSUE = 111;
export const JOB0 = 137328127529;
export const LAUF_START = '2026-11-22T19:33:56Z';
// Faelle der Generalprobe nach Lauf-ID.
export const FAELLE = Object.freeze({
  45000000001: 'keine-auffaelligkeiten',
  45000000002: 'auffaelligkeiten',
  45000000003: 'ausstehend',
  45000000004: 'nicht-pruefbar',
});

const P = `/repos/${REPO}`;
const jq = w => createHash('sha256').update(`${JSON.stringify(w)}\n`).digest('hex');
const b64 = t => Buffer.from(t, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');

export const ISSUE_DATEN = Object.freeze({
  number: ISSUE,
  title: 'feat: Potenz-Funktion im Rechner',
  body: 'Ergänze `potenz(a, b)` in src/rechne.js. Ergebnis wie `a ** b`.',
  updated_at: '2026-11-22T19:33:54Z',
  state: 'open',
  labels: [{ name: 'bot-auftrag' }, { name: 'agent:js-rechner' }],
});

export const POLICY = `${JSON.stringify({
  schema: 'agent-policy-v1',
  max_dateien: 4,
  gesperrte_praefixe: ['.git/', '.github/', '.claude/', 'scripts/', 'agent-profiles/', 'agent-acceptance/', 'node_modules/'],
  gesperrte_dateien: ['CODEOWNERS', 'package.json', 'package-lock.json', 'CLAUDE.md', '.mcp.json', '.gitmodules', '.gitattributes', '.gitignore', '.npmrc'],
}, null, 2)}\n`;

export const PROFIL = `${JSON.stringify({ schema: 'agent-profile-v1', id: 'js-rechner', aktiv: true, dateien: ['src/rechne.js', 'test/rechne.test.js'] }, null, 2)}\n`;

export const TEST_BASIS = "import { test } from 'node:test';\ntest('summe', () => {});\ntest('differenz', () => {});\n";
export const TEST_KOPF = `${TEST_BASIS}test('potenz', () => {});\n`;
export const PATCH_QUELLE = '@@ -10,3 +10,7 @@ export function differenz(a, b) {\n   return a - b;\n }\n+\n+export function potenz(a, b) {\n+  return a ** b;\n+}\n';
export const PATCH_TEST = "@@ -1,3 +1,4 @@\n import { test } from 'node:test';\n test('summe', () => {});\n test('differenz', () => {});\n+test('potenz', () => {});\n";

export function log(issue = ISSUE_DATEN) {
  const z = t => `2026-11-22T19:34:02.2416999Z ${t}`;
  return `\uFEFF${[
    z('##[group]Run set -euo pipefail'),
    z("\u001b[36;1mprintf 'A6-NUTZLAST title %s\\n' \"$title_sha256\"\u001b[0m"),
    z(`A6-NUTZLAST title ${jq(issue.title)}`),
    z(`A6-NUTZLAST body ${jq(issue.body)}`),
    z(`A6-NUTZLAST updated_at ${jq(issue.updated_at)}`),
    z('##[endgroup]'),
  ].join('\n')}\n`;
}

// Grunddaten eines Falls. Jede Funktion liefert ein frisches Objekt.
export function daten(lauf) {
  return {
    lauf: {
      id: lauf, name: 'Agent-Auftrag', path: '.github/workflows/agent-auftrag.yml', event: 'issues', head_branch: 'main', head_sha: BASIS,
      run_attempt: 1, status: 'completed', conclusion: 'success', created_at: LAUF_START, repository: { full_name: REPO },
    },
    jobs: [
      { id: JOB0, name: 'Job 0 Auftrag festlegen', status: 'completed', conclusion: 'success' },
      { id: 137328129048, name: 'Generalprobe Job 0', status: 'completed', conclusion: 'skipped' },
      { id: 137328258357, name: 'Job 1 Claude im Container', status: 'completed', conclusion: 'success' },
      { id: 137329583774, name: 'Job 2 Abnahme ohne Netz', status: 'completed', conclusion: 'success' },
      { id: 137329759647, name: 'Job 3 Draft-PR veroeffentlichen', status: 'completed', conclusion: 'success' },
      { id: 137331332692, name: 'agent-auftrag-sammel', status: 'completed', conclusion: 'success' },
    ],
    pulls: [
      {
        number: PR, state: 'open', draft: true, merged_at: null, user: { login: BOT, type: 'Bot' },
        head: { ref: `wp/${ISSUE}-agent-${lauf}-1`, sha: KOPF, repo: { full_name: REPO } },
        base: { ref: 'main', sha: BASIS, repo: { full_name: REPO } },
      },
      {
        number: 112, state: 'closed', draft: false, merged_at: '2026-11-22T18:00:00Z', user: { login: 'noah04091', type: 'User' },
        head: { ref: 'wp/26-irgendwas', sha: '1'.repeat(40), repo: { full_name: REPO } }, base: { ref: 'main', sha: BASIS, repo: { full_name: REPO } },
      },
    ],
    commits: [{ sha: KOPF, parents: [{ sha: BASIS }], author: { login: BOT } }],
    issue: { ...ISSUE_DATEN, labels: ISSUE_DATEN.labels.map(l => ({ ...l })) },
    ereignisse: [
      { event: 'labeled', label: { name: 'agent:js-rechner' }, actor: { login: 'noah04091' }, created_at: '2026-11-22T19:31:56Z' },
      { event: 'labeled', label: { name: 'bot-auftrag' }, actor: { login: 'noah04091' }, created_at: '2026-11-22T19:33:54Z' },
    ],
    inhalte: {
      [`.github/agent/policy.json@${BASIS}`]: POLICY,
      [`agent-profiles/js-rechner.json@${BASIS}`]: PROFIL,
      [`agent-acceptance/issue-${ISSUE}.mjs@${BASIS}`]: 'export default {};\n',
      [`test/rechne.test.js@${BASIS}`]: TEST_BASIS,
      [`test/rechne.test.js@${KOPF}`]: TEST_KOPF,
    },
    dateien: [
      { filename: 'src/rechne.js', status: 'modified', changes: 4, patch: PATCH_QUELLE },
      { filename: 'test/rechne.test.js', status: 'modified', changes: 1, patch: PATCH_TEST },
    ],
    checks: [
      ...['build', 'tests', 'schutzdateien', 'agent-auftrag-sammel'].map(name => ({ name, status: 'completed', conclusion: 'success', app: { id: 15368 } })),
      { name: 'Generalprobe Job 0', status: 'completed', conclusion: 'success', app: { id: 15368 } },
    ],
    log: null,
  };
}

// Abwandlungen fuer die Faelle der Generalprobe.
export function fallDaten(lauf) {
  const d = daten(lauf);
  const fall = FAELLE[lauf];

  if (fall === 'auffaelligkeiten') {
    d.dateien[0].patch += '+export const quelle = process.env.QUELLE;\n';
    d.dateien.push({ filename: 'README.md', status: 'modified', changes: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' });
  }

  if (fall === 'ausstehend') {
    d.checks[1] = { ...d.checks[1], status: 'in_progress', conclusion: null };
  }

  if (fall === 'nicht-pruefbar') {
    d.log = log({ ...ISSUE_DATEN, title: 'feat: ein anderer Auftrag' });
  }

  return d;
}

export const antwort = (status, koerper = '', kopf = {}) => ({
  status,
  headers: { get: k => kopf[k.toLowerCase()] ?? null },
  text: async () => (typeof koerper === 'string' ? koerper : JSON.stringify(koerper)),
});

// fetch-Attrappe. d: Daten (veraenderbar), stoerung(pfad, url, opt): Ersatzantwort oder null.
export function erzeugeGithub(d, stoerung = () => null) {
  const aufrufe = [];

  const f = async (url, opt = {}) => {
    const u = new URL(url);
    aufrufe.push({ url: u.href, methode: opt.method, auth: opt.headers?.Authorization !== undefined });
    const ersatz = stoerung(u.pathname, u, opt);

    if (ersatz) {
      return ersatz;
    }

    if (u.hostname === 'productionresultssa7.blob.core.windows.net') {
      return antwort(200, d.log ?? log(ISSUE_DATEN));
    }

    if (u.hostname !== 'api.github.com') {
      return antwort(599, 'fremder Host');
    }

    const p = u.pathname;
    const seite = Number(u.searchParams.get('page') ?? '1');
    const liste = (l, feld = null) => {
      const teil = l.slice((seite - 1) * 100, seite * 100);
      return antwort(200, feld === null ? teil : { total_count: l.length, [feld]: teil });
    };
    let m;

    if ((m = /^\/repos\/noah04091\/agenten-probe\/actions\/runs\/(\d+)$/.exec(p))) {
      return Number(m[1]) === d.lauf.id ? antwort(200, d.lauf) : antwort(404, { message: 'Not Found' });
    }

    if (/\/actions\/runs\/\d+\/jobs$/.test(p)) return liste(d.jobs, 'jobs');
    if ((m = /\/actions\/jobs\/(\d+)\/logs$/.exec(p))) return antwort(302, '', { location: `https://productionresultssa7.blob.core.windows.net/logs/${m[1]}?sig=probe` });
    if (p === `${P}/pulls`) return liste(d.pulls);
    if ((m = /^\/repos\/noah04091\/agenten-probe\/pulls\/(\d+)$/.exec(p))) {
      const pr = d.pulls.find(x => x.number === Number(m[1]));
      return pr ? antwort(200, pr) : antwort(404, { message: 'Not Found' });
    }
    if (/\/pulls\/\d+\/commits$/.test(p)) return liste(d.commits);
    if (/\/pulls\/\d+\/files$/.test(p)) return liste(d.dateien);
    if (p === `${P}/issues/${d.issue.number}`) return antwort(200, d.issue);
    if (/\/issues\/\d+\/events$/.test(p)) return liste(d.ereignisse);
    if ((m = /^\/repos\/noah04091\/agenten-probe\/contents\/(.+)$/.exec(p))) {
      const t = d.inhalte[`${m[1]}@${u.searchParams.get('ref')}`];
      return t === undefined ? antwort(404, { message: 'Not Found' }) : antwort(200, { type: 'file', encoding: 'base64', size: Buffer.byteLength(t), content: b64(t) });
    }
    if (p === `${P}/commits/${KOPF}/check-runs`) return liste(d.checks, 'check_runs');
    return antwort(404, { message: 'Not Found' });
  };

  return { f, aufrufe };
}

// Nur als Vorlademodul der Generalprobe: fetch ersetzen, 30 Sekunden Warten auf null.
if (typeof process.argv[1] === 'string' && process.argv[1].replace(/\\/g, '/').endsWith('/scripts/agent-pruefer-vorpruefung.mjs')) {
  const lauf = Number(process.env.A6_PRUEFER_LAUF);

  if (!Object.hasOwn(FAELLE, lauf)) {
    throw new Error('Generalprobe: unbekannter Fall');
  }

  globalThis.fetch = erzeugeGithub(fallDaten(lauf)).f;
  const warten = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => warten(fn, ms === 30_000 ? 0 : ms, ...rest);
}
