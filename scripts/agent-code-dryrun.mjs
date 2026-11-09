// Code-Pilot Trockenlauf (A2): Job 2 und Job 3 ohne Claude und ohne Schreibrechte.
// prepare: spielt die feste Testaenderung ein (statt Claude in Job 1).
// publish: fuehrt den echten Veroeffentlicher gegen ein strenges, nachgebautes
//          GitHub im Speicher aus. Kein Netz, kein Token, keine Schreiboperation.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishCodePilot } from './agent-code-publish.mjs';

const REPO = 'noah04091/agenten-probe';
const API = `https://api.github.com/repos/${REPO}`;
const FILES = ['src/rechne.js', 'test/rechne.test.js'];
const PACKAGE_NAME = 'code-pilot-package.json';
const DRY_TOKEN = 'trockenlauf-ohne-rechte';
const BASE_TREE = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const COMMIT_SHA = 'c'.repeat(40);

function fail(message) {
  throw new Error(`Trockenlauf abgebrochen: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function blobOfText(text) {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

// Feste Testaenderung. Vor A5: die Multiplikation wie in der Abnahme-Transferprobe.
// Hat main sie schon (nach A5), nur je eine Kommentarzeile wie in der Transferprobe,
// damit der Trockenlauf nicht vom Stand von main abhaengt.
export function prepareFixedChange(root) {
  const file = join(root, 'src/rechne.js');
  const original = readFileSync(file, 'utf8');
  const marker = 'module.exports = { addiere, subtrahiere };';
  const done = 'module.exports = { addiere, subtrahiere, multipliziere };';

  if (
    original.split(done).length === 2 &&
    original.split('function multipliziere(').length === 2
  ) {
    for (const path of FILES) {
      writeFileSync(
        join(root, path),
        readFileSync(join(root, path), 'utf8') + '\n// Code-Pilot Trockenlauf\n'
      );
    }
    return 'kommentar';
  }

  if (
    original.split(marker).length !== 2 ||
    original.includes('function multipliziere(')
  ) {
    fail('unerwarteter Ausgangsstand von src/rechne.js');
  }

  writeFileSync(file, original.replace(marker, [
    'function multipliziere(a, b) {',
    '  return a * b;',
    '}',
    '',
    'module.exports = { addiere, subtrahiere, multipliziere };',
  ].join('\n')));

  writeFileSync(
    join(root, 'test/rechne.test.js'),
    readFileSync(join(root, 'test/rechne.test.js'), 'utf8') + [
      '',
      "test('Multiplikation funktioniert', () => {",
      "  const { multipliziere } = require('../src/rechne');",
      '  assert.strictEqual(multipliziere(3, -4), -12);',
      '});',
      '',
    ].join('\n')
  );
  return 'multiplikation';
}

// Was ein korrekter Veroeffentlicher bei den vier Schreibaufrufen senden muss.
function checkBody(key, body, baseSha, branch) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Genau diese Felder, keine zusaetzlichen (etwa author, force, maintainer_can_modify).
  const keys = (value, list) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    same(Object.keys(value).sort(), [...list].sort());

  if (key.startsWith('GET ')) {
    return body === undefined;
  }

  if (key === 'POST git/trees') {
    return (
      keys(body, ['base_tree', 'tree']) &&
      body.tree?.every?.(entry => keys(entry, ['path', 'mode', 'type', 'content'])) &&
      body?.base_tree === BASE_TREE &&
      Array.isArray(body?.tree) &&
      body.tree.length === FILES.length &&
      body.tree.every((entry, i) =>
        entry?.path === FILES[i] &&
        entry.mode === '100644' &&
        entry.type === 'blob' &&
        typeof entry.content === 'string' &&
        entry.sha === undefined)
    );
  }

  if (key === 'POST git/commits') {
    return (
      keys(body, ['message', 'tree', 'parents']) &&
      body?.tree === TREE_SHA &&
      same(body?.parents, [baseSha]) &&
      typeof body?.message === 'string'
    );
  }

  if (key === 'POST git/refs') {
    return same(body, { ref: `refs/heads/${branch}`, sha: COMMIT_SHA });
  }

  if (key === 'POST pulls') {
    return (
      keys(body, ['title', 'head', 'base', 'draft', 'body']) &&
      body?.draft === true &&
      body?.base === 'main' &&
      body?.head === branch &&
      typeof body?.title === 'string'
    );
  }

  return false;
}

// Strenges GitHub: jeder Aufruf muss genau der naechste erwartete sein, und
// jeder Schreibaufruf muss genau den richtigen Inhalt tragen. Alles andere ist
// ein unerwarteter Aufruf, wird nicht beantwortet und bricht den Lauf ab.
// Antworten werden aus dem Gesendeten abgeleitet, nicht fest vorgegeben.
export function createStrictGitHub(baseSha, branch, expected) {
  const calls = [];
  const answered = [];
  const sent = {};
  let unexpected = null;
  const issue = {
    number: 38,
    state: 'open',
    user: { login: 'noah04091' },
    repository_url: API,
    labels: [{ name: 'agent:code-pilot' }, { name: 'bot-auftrag' }],
  };

  const answers = {
    'GET issues/38': () => issue,
    'GET branches/main': () => ({ commit: { sha: baseSha } }),
    [`GET git/commits/${baseSha}`]: () => ({ tree: { sha: BASE_TREE } }),
    'POST git/trees': body => {
      for (const entry of body?.tree ?? []) {
        sent[entry.path] = blobOfText(entry.content);
      }
      return { sha: TREE_SHA };
    },
    [`GET git/trees/${TREE_SHA}?recursive=1`]: () => ({
      sha: TREE_SHA,
      truncated: false,
      tree: FILES.map(path => ({
        path, mode: '100644', type: 'blob', sha: sent[path],
      })),
    }),
    'POST git/commits': () => ({ sha: COMMIT_SHA }),
    'POST git/refs': body => ({ ref: body.ref, object: { sha: body.sha } }),
    [`GET git/ref/heads/${branch}`]: () => ({
      ref: `refs/heads/${branch}`, object: { sha: COMMIT_SHA },
    }),
    [`GET compare/${baseSha}...${COMMIT_SHA}`]: () => ({
      ahead_by: 1,
      files: FILES.map(filename => ({
        filename, status: 'modified', sha: sent[filename],
      })),
    }),
    'POST pulls': body => ({
      draft: body.draft,
      base: { ref: body.base },
      head: { ref: body.head },
      html_url: `https://github.com/${REPO}/pull/0`,
    }),
  };

  async function request(url, options = {}) {
    const method = options.method ?? 'GET';
    const path = String(url).startsWith(`${API}/`)
      ? String(url).slice(API.length + 1)
      : String(url);
    const key = `${method} ${path}`;
    const body = options.body ? JSON.parse(options.body) : undefined;
    const auth = options.headers?.Authorization;

    calls.push({ key, auth, body });

    if (
      unexpected ||
      key !== expected[calls.length - 1] ||
      !checkBody(key, body, baseSha, branch) ||
      auth !== `Bearer ${DRY_TOKEN}` ||
      options.redirect !== 'error'
    ) {
      unexpected ??= key;
      throw new Error(`Unerwarteter GitHub-Aufruf: ${key}`);
    }

    answered.push(key);
    const value = answers[key](body);
    return { ok: true, status: 200, json: async () => value };
  }

  return {
    request,
    calls,
    answered,
    sent,
    get unexpected() {
      return unexpected;
    },
  };
}

export function expectedCalls(baseSha, branch) {
  const live = ['GET issues/38', 'GET branches/main'];
  return [
    ...live,
    `GET git/commits/${baseSha}`,
    'POST git/trees',
    `GET git/trees/${TREE_SHA}?recursive=1`,
    'POST git/commits',
    ...live,
    'POST git/refs',
    `GET git/ref/heads/${branch}`,
    `GET compare/${baseSha}...${COMMIT_SHA}`,
    ...live,
    `GET git/ref/heads/${branch}`,
    'POST pulls',
  ];
}

function dryEnv(input, temp, packageSha256) {
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'noah04091',
    GITHUB_SHA: input.baseSha,
    GITHUB_RUN_ID: input.runId,
    GITHUB_RUN_ATTEMPT: input.runAttempt,
    GH_TOKEN: DRY_TOKEN,
    CODE_PILOT_PUBLISH_ENABLED: 'true',
    CODE_PILOT_PUBLISH_CONFIRM: 'issue-38-draft-only',
    CODE_PILOT_PACKAGE_SHA256: packageSha256,
    RUNNER_TEMP: temp,
  };
}

const EVENT = Object.freeze({
  action: 'labeled',
  repository: { full_name: REPO },
  sender: { login: 'noah04091' },
  label: { name: 'bot-auftrag' },
  issue: {
    number: 38,
    state: 'open',
    user: { login: 'noah04091' },
    repository_url: API,
    labels: [{ name: 'agent:code-pilot' }, { name: 'bot-auftrag' }],
  },
});

async function attempt(input, temp, packageSha256, expected) {
  const branch = `wp/38-code-pilot-${input.runId}-${input.runAttempt}`;
  const github = createStrictGitHub(input.baseSha, branch, expected);
  const quiet = [];
  let result = null;
  let error = null;

  try {
    result = await publishCodePilot(
      EVENT,
      dryEnv(input, temp, packageSha256),
      github.request,
      input.root,
      line => quiet.push(String(line))
    );
  } catch (caught) {
    error = caught;
  }

  return { github, result, error, branch, quiet };
}

// Fuehrt den Gutfall und drei Gegenproben aus. Wirft bei jeder Abweichung.
export async function runDryRun(input, log = console.log) {
  for (const name of ['baseSha', 'packageSha256', 'root', 'temp']) {
    if (typeof input?.[name] !== 'string' || input[name] === '') {
      fail(`Eingabe ${name} fehlt`);
    }
  }

  if (!/^[a-f0-9]{40}$/.test(input.baseSha)) {
    fail('Ausgangscommit ungueltig');
  }

  // Der Trockenlauf darf keine echten Zugangsdaten sehen.
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'BOT_APP_PRIVATE_KEY']) {
    if (input.env?.[name]) {
      fail(`Zugangsdaten ${name} vorhanden, Trockenlauf verweigert`);
    }
  }

  const packagePath = join(input.temp, PACKAGE_NAME);
  const packageBytes = readFileSync(packagePath);

  if (sha256(packageBytes) !== input.packageSha256) {
    fail('Paket-Hash aus Job 2 passt nicht zum geladenen Paket');
  }

  // Jeder echte Netzaufruf bricht sofort ab.
  const realFetch = globalThis.fetch;
  let netCalls = 0;
  globalThis.fetch = async () => {
    netCalls += 1;
    throw new Error('Netzaufruf im Trockenlauf gesperrt');
  };

  const sandbox = mkdtempSync(join(tmpdir(), 'code-pilot-dryrun-'));

  try {
    const run = { ...input, root: resolve(input.root) };
    const expected = expectedCalls(run.baseSha, `wp/38-code-pilot-${run.runId}-${run.runAttempt}`);

    // 1. Gutfall mit dem Hash aus Job 2.
    const good = await attempt(run, input.temp, input.packageSha256, expected);

    if (good.error) {
      fail(`Gutfall gescheitert: ${good.error.message}`);
    }

    if (
      good.github.unexpected ||
      good.github.calls.length !== expected.length ||
      good.result?.branch !== good.branch ||
      good.result?.commit !== COMMIT_SHA
    ) {
      fail('Gutfall weicht vom erwarteten Ablauf ab');
    }

    // Unabhaengiges Orakel: Git selbst berechnet die Blob-SHAs der Arbeitskopie.
    for (const file of FILES) {
      const oracle = execFileSync(
        'git', ['hash-object', '--no-filters', file],
        { cwd: run.root, encoding: 'utf8' }
      ).trim();

      if (good.github.sent[file] !== oracle) {
        fail(`gesendeter Inhalt weicht von der geprueften Datei ab: ${file}`);
      }
      log(`Blob ${file}: ${oracle} (gesendet = geprueft)`);
    }

    log(`Paket-Hash aus Job 2: ${input.packageSha256}`);
    log(`Ausgangscommit: ${run.baseSha}`);
    for (const call of good.github.calls) {
      log(`Geplanter Aufruf: ${call.key}`);
    }

    // 2. Gegenprobe: falscher Hash, keine einzige Anfrage.
    const flipped = input.packageSha256.replace(/^./, c => (c === '0' ? '1' : '0'));
    const badHash = await attempt(run, input.temp, flipped, expected);

    if (!/Paket-Hash weicht ab/.test(badHash.error?.message ?? '') || badHash.github.calls.length !== 0) {
      fail('Gegenprobe falscher Hash hat nicht mit null Anfragen abgebrochen');
    }
    log('Gegenprobe falscher Paket-Hash: abgelehnt, 0 Anfragen');

    // 3. Gegenprobe: ein Byte im Paket manipuliert, Hash passend nachgerechnet.
    const data = JSON.parse(packageBytes.toString('utf8'));
    const bytes = Buffer.from(data.files[0].base64, 'base64');
    bytes[0] ^= 1;
    data.files[0].base64 = bytes.toString('base64');
    data.files[0].sha256 = sha256(bytes);
    const tampered = Buffer.from(JSON.stringify(data) + '\n');
    writeFileSync(join(sandbox, PACKAGE_NAME), tampered);

    const badFile = await attempt(run, sandbox, sha256(tampered), expected);

    if (!/weicht von der Arbeitskopie ab/.test(badFile.error?.message ?? '') || badFile.github.calls.length !== 0) {
      fail('Gegenprobe manipulierte Datei hat nicht mit null Anfragen abgebrochen');
    }
    log('Gegenprobe manipulierte Datei: abgelehnt, 0 Anfragen');

    // 4. Gegenprobe mitten im Ablauf: nach dem Anlegen des Branches ist der
    //    naechste Aufruf unerwartet. Der Lauf muss abbrechen, und danach darf
    //    kein Aufruf mehr beantwortet werden (kein PR, kein Loeschen).
    const cut = expected.indexOf('POST git/refs') + 1;
    const badApi = await attempt(run, input.temp, input.packageSha256, expected.slice(0, cut));

    // Nach dem Schnitt versucht der Veroeffentlicher genau: die Spitze lesen
    // (Hauptablauf), beim Aufraeumen die Spitze erneut lesen, dann den
    // Abbruchgrund ins Issue schreiben. Ein DELETE darf nicht vorkommen.
    const afterCut = [
      expected[cut],
      `GET git/ref/heads/${badApi.branch}`,
      'POST issues/38/comments',
    ];

    if (
      !badApi.error ||
      badApi.github.unexpected !== expected[cut] ||
      JSON.stringify(badApi.github.answered) !== JSON.stringify(expected.slice(0, cut)) ||
      JSON.stringify(badApi.github.calls.slice(cut).map(call => call.key)) !== JSON.stringify(afterCut)
    ) {
      fail('Gegenprobe unerwarteter Aufruf hat nicht abgebrochen');
    }
    log(`Gegenprobe unerwarteter GitHub-Aufruf nach dem Anlegen des Branches: abgebrochen, danach nichts beantwortet (${badApi.github.calls.length - cut} Aufrufe abgewiesen)`);

    if (netCalls !== 0) {
      fail(`${netCalls} echte Netzaufrufe versucht`);
    }

    log('0 Anfragen an echtes GitHub. Trockenlauf bestanden.');
    return { calls: good.github.calls.map(call => call.key) };
  } finally {
    globalThis.fetch = realFetch;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function jobSection(yaml, job) {
  const start = yaml.indexOf(`\n  ${job}:\n`);

  if (start < 0 || yaml.indexOf(`\n  ${job}:\n`, start + 1) >= 0) {
    fail(`Job ${job} nicht eindeutig gefunden`);
  }

  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function pick(section, pattern, what) {
  const found = section.match(pattern);

  if (!found || section.split(found[0]).length !== 2) {
    fail(`${what} nicht genau einmal gefunden`);
  }

  return found[0];
}

// Wachen gegen Abweichung vom echten Job 2 und gegen Rechte im Trockenlauf.
export function checkWorkflowGuards(pilotYaml, dryYaml) {
  pilotYaml = pilotYaml.replace(/\r\n/g, '\n');
  dryYaml = dryYaml.replace(/\r\n/g, '\n');

  const forbidden = [
    'secr' + 'ets',
    'continue-on-' + 'error',
    'wri' + 'te',
    'read' + '-all',
    'ex' + 'it ',
    'set ' + '+',
    '|| ' + 'true',
    'for' + 'mat(',
    'workflow_' + 'run',
    'environ' + 'ment:',
    'claude-code' + '-action',
    'create-github' + '-app-token',
    'github' + '.token',
    'GH_' + 'TOKEN: ',
    ': wr' + 'ite',
    'issu' + 'es:',
    'workflow_' + 'dispatch',
    'pull_request_' + 'target',
  ];

  for (const word of forbidden) {
    if (dryYaml.includes(word)) {
      fail(`Trockenlauf enthaelt Verbotenes: ${word}`);
    }
  }

  if ((dryYaml.match(/^permissions: \{\}$/gm) ?? []).length !== 1) {
    fail('Trockenlauf braucht permissions: {} auf Workflow-Ebene');
  }

  // Kein Ausdruck darf an ein Token kommen, auch nicht ueber github['token'].
  if (/\$\{\{[^}]*token/i.test(dryYaml)) {
    fail('Trockenlauf greift auf ein Token zu');
  }

  // Jeder Pruefschritt genau so oft wie geplant, nur der Fork-Filter als if.
  const required = [
    [/^ *if:/gm, 1, 'if-Bedingung'],
    [/^ *permissions:/gm, 4, 'permissions-Zeile'],
    [/^ *permissions: \{\}$/gm, 4, 'permissions: {}'],
    [/persist-credentials/g, 3, 'persist-credentials'],
    [/^ {10}persist-credentials: false$/gm, 3, 'persist-credentials: false'],
    [/run: \|/g, 8, 'run-Block'],
    [/run: \|\n {10}set -euo pipefail$/gm, 8, 'set -euo pipefail am Anfang jedes run-Blocks'],
    [/^ {10}node scripts\/agent-code-dryrun\.mjs guard$/gm, 1, 'Wachen-Schritt'],
    [/^ {10}node scripts\/agent-code-dryrun\.mjs prepare$/gm, 1, 'Testaenderung'],
    [/^ {10}node scripts\/agent-code-package\.mjs create "\$GITHUB_SHA"$/gm, 1, 'Paketerzeugung'],
    [/agent-code-package\.mjs (\\\n {12})?apply "\$GITHUB_SHA"$/gm, 2, 'Paketpruefung in Job 2 und 3'],
    [/^ {10}git diff --check$/gm, 2, 'git diff --check in Job 2 und 3'],
    [/^ {10}node scripts\/agent-code-dryrun\.mjs publish$/gm, 1, 'Veroeffentlicher-Trockenlauf'],
    [/^ {4}needs: testpaket_erzeugen$/gm, 1, 'Abhaengigkeit Job 2'],
    [/^ {6}- testpaket_erzeugen\n {6}- codepaket_pruefen$/gm, 1, 'Abhaengigkeit Job 3'],
  ];

  for (const [pattern, count, what] of required) {
    if ((dryYaml.match(pattern) ?? []).length !== count) {
      fail(`${what} nicht genau ${count}-mal vorhanden`);
    }
  }

  if (/^ {6}- (run|name|uses): [^\n]*(checkout --|git restore|git reset)/m.test(dryYaml) ||
      /^ {10}git (checkout|restore|reset|stash)\b/m.test(dryYaml)) {
    fail('Trockenlauf setzt Dateien zurueck');
  }

  const real = jobSection(pilotYaml, 'codepaket_pruefen');
  const dry = jobSection(dryYaml, 'codepaket_pruefen');
  const parts = [
    [/ {6}IMAGE: node@sha256:[a-f0-9]{64}\n/, 'Docker-Image'],
    [/ {10}docker run --rm \\\n[\s\S]*?\n {12}'\n/, 'Docker-Aufruf'],
    [/ {10}PAKET_HASH=.*\n.*\n.*\n/, 'Hash-Berechnung'],
    [/ {10}node scripts\/agent-code-package\.mjs \\\n {12}apply .*\n/, 'Paketpruefung'],
  ];

  for (const [pattern, what] of parts) {
    if (pick(real, pattern, what) !== pick(dry, pattern, what)) {
      fail(`${what} weicht vom echten Job 2 ab`);
    }
  }

  return true;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] === 'prepare') {
      const mode = prepareFixedChange(process.cwd());
      console.log(`Feste Testaenderung eingespielt (${mode}), kein Claude-Aufruf.`);
    } else if (process.argv[2] === 'guard') {
      checkWorkflowGuards(
        readFileSync('.github/workflows/code-pilot-claude-stufe.yml', 'utf8'),
        readFileSync('.github/workflows/code-pilot-trockenlauf.yml', 'utf8')
      );
      console.log('Trockenlauf ohne Rechte und gleich mit dem echten Job 2.');
    } else if (process.argv[2] === 'publish') {
      await runDryRun({
        root: process.cwd(),
        temp: process.env.RUNNER_TEMP,
        baseSha: process.env.BASE_SHA,
        packageSha256: process.env.CODE_PILOT_PACKAGE_SHA256,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        env: process.env,
      });
    } else {
      fail('Befehl prepare, guard oder publish fehlt');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
