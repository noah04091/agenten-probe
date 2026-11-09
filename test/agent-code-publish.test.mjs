
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishCodePilot } from '../scripts/agent-code-publish.mjs';
import { createCodePackage } from '../scripts/agent-code-package.mjs';

const REPO = 'noah04091/agenten-probe';
const API = `https://api.github.com/repos/${REPO}`;
const NEW_SHA = 'c'.repeat(40);
const FOREIGN_SHA = 'd'.repeat(40);
const BRANCH = 'wp/38-code-pilot-12345-1';
const FILES = ['src/rechne.js', 'test/rechne.test.js'];

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'code-pilot-publish-'));
  const temp = mkdtempSync(join(tmpdir(), 'code-pilot-runner-'));

  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));

  writeFileSync(join(root, 'src/rechne.js'), [
    'function addiere(a,b) { return a+b; }',
    'function subtrahiere(a,b) { return a-b; }',
    'module.exports = { addiere, subtrahiere };',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'test/rechne.test.js'), '// Basis-Test\n');

  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.name', 'Code Pilot Test');
  git(root, 'config', 'user.email', 'code-pilot@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Basis');

  const sha = git(root, 'rev-parse', 'HEAD');

  appendFileSync(
    join(root, 'src/rechne.js'),
    '\nfunction multipliziere(a,b) { return a*b; }\n'
  );

  appendFileSync(
    join(root, 'test/rechne.test.js'),
    '// Neue Tests\n'
  );

  // Das Paket entsteht wie in Job 1, Job 2 gibt seinen Hash weiter.
  const json = createCodePackage(root, sha);
  writeFileSync(join(temp, 'code-pilot-package.json'), json);

  // Unabhaengiges Orakel: Git selbst berechnet die Blob-SHAs.
  const blobs = Object.fromEntries(
    FILES.map(file => [
      file,
      git(root, 'hash-object', '--no-filters', file),
    ])
  );

  const event = {
    action: 'labeled',
    repository: { full_name: REPO },
    sender: { login: 'noah04091' },
    label: { name: 'bot-auftrag' },
    issue: {
      number: 38,
      state: 'open',
      user: { login: 'noah04091' },
      repository_url: API,
      labels: [
        { name: 'agent:code-pilot' },
        { name: 'bot-auftrag' },
      ],
    },
  };

  const env = {
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'noah04091',
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    GH_TOKEN: 'nur-ein-test-token',
    CODE_PILOT_PUBLISH_ENABLED: 'true',
    CODE_PILOT_PUBLISH_CONFIRM: 'issue-38-draft-only',
    RUNNER_TEMP: temp,
    CODE_PILOT_PACKAGE_SHA256:
      createHash('sha256').update(json).digest('hex'),
  };

  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  };

  return { root, temp, sha, event, env, blobs, cleanup };
}

function blobOfText(text) {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');
}

function mockGitHub(sha, blobs, options = {}) {
  const {
    wrongMain = false,
    badDiff = false,
    badBlob = false,
    foreignTip = false,
    failPr = false,
    existingPr = false,
    refCreateFails = false,
    listPrFails = false,
    commentFails = false,
    truncated = false,
    duplicateEntry = false,
    tipRefWrong = false,
  } = options;

  const calls = [];
  let branchExists = false;

  // Blob-SHAs aus dem tatsaechlich GESENDETEN Inhalt, unabhaengig vom Skript.
  const sent = {};

  const ok = value => ({ ok: true, status: 200, json: async () => value });
  const fail = status => ({
    ok: false,
    status,
    json: async () => ({ message: 'abgelehnt' }),
  });

  async function request(url, options = {}) {
    assert.ok(url.startsWith(API + '/'), 'Nur GitHub-Testendpunkte');

    const path = url.slice(API.length + 1);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;

    calls.push({
      method,
      path,
      body,
      auth: options.headers?.Authorization,
    });

    if (method === 'GET' && path === 'issues/38') {
      return ok({
        number: 38,
        state: 'open',
        user: { login: 'noah04091' },
        repository_url: API,
        labels: [
          { name: 'bot-auftrag' },
          { name: 'agent:code-pilot' },
        ],
      });
    }

    if (method === 'GET' && path === 'branches/main') {
      return ok({ commit: { sha: wrongMain ? 'f'.repeat(40) : sha } });
    }

    if (method === 'GET' && path === `git/commits/${sha}`) {
      return ok({ tree: { sha: 'a'.repeat(40) } });
    }

    if (method === 'POST' && path === 'git/trees') {
      for (const entry of body.tree) {
        sent[entry.path] = blobOfText(entry.content);
      }

      return ok({ sha: 'b'.repeat(40) });
    }

    if (
      method === 'GET' &&
      path === `git/trees/${'b'.repeat(40)}?recursive=1`
    ) {
      return ok({
        sha: 'b'.repeat(40),
        truncated,
        tree: [
          ...(duplicateEntry
            ? [{
                path: 'src/rechne.js',
                mode: '100644',
                type: 'blob',
                sha: sent['src/rechne.js'],
              }]
            : []),
          { path: 'src', mode: '040000', type: 'tree', sha: '1'.repeat(40) },
          {
            path: 'src/rechne.js',
            mode: '100644',
            type: 'blob',
            sha: badBlob ? 'e'.repeat(40) : sent['src/rechne.js'],
          },
          { path: 'test', mode: '040000', type: 'tree', sha: '2'.repeat(40) },
          {
            path: 'test/rechne.test.js',
            mode: '100644',
            type: 'blob',
            sha: sent['test/rechne.test.js'],
          },
        ],
      });
    }

    if (method === 'POST' && path === 'git/commits') {
      return ok({ sha: NEW_SHA });
    }

    if (method === 'POST' && path === 'git/refs') {
      if (refCreateFails) {
        // Schlimmster Fall: der Ref existiert schon, sogar mit derselben
        // Spitze, und es gibt keinen PR. Trotzdem ist er nicht aus diesem Lauf.
        branchExists = true;
        return fail(422);
      }

      branchExists = true;

      return ok({
        ref: `refs/heads/${BRANCH}`,
        object: { sha: NEW_SHA },
      });
    }

    if (method === 'GET' && path === `git/ref/heads/${BRANCH}`) {
      if (!branchExists) {
        return fail(404);
      }

      return ok({
        ref: tipRefWrong
          ? `refs/heads/${BRANCH}-anders`
          : `refs/heads/${BRANCH}`,
        object: { sha: foreignTip ? FOREIGN_SHA : NEW_SHA },
      });
    }

    if (method === 'GET' && path === `compare/${sha}...${NEW_SHA}`) {
      return ok({
        ahead_by: 1,
        files: badDiff
          ? [{ filename: '.github/workflows/unsafe.yml', status: 'modified' }]
          : FILES.map(filename => ({
              filename,
              status: 'modified',
              sha: sent[filename],
            })),
      });
    }

    if (method === 'POST' && path === 'pulls') {
      if (failPr) {
        return fail(500);
      }

      return ok({
        draft: true,
        base: { ref: 'main' },
        head: { ref: BRANCH },
        html_url: `https://github.com/${REPO}/pull/999`,
      });
    }

    if (method === 'GET' && path.startsWith('pulls?')) {
      const query = new URL(url).searchParams;

      assert.equal(query.get('state'), 'all');
      assert.equal(query.get('head'), `noah04091:${BRANCH}`);

      if (listPrFails) {
        return fail(500);
      }

      return ok(
        existingPr
          ? [{ number: 1000, head: { ref: BRANCH } }]
          : []
      );
    }

    if (method === 'DELETE' && path === `git/refs/heads/${BRANCH}`) {
      branchExists = false;

      return {
        ok: true,
        status: 204,
        json: async () => {
          throw new Error('204 hat keinen Inhalt');
        },
      };
    }

    if (method === 'POST' && path === 'issues/38/comments') {
      return commentFails ? fail(403) : ok({ id: 1 });
    }

    throw new Error(`Unbekannter Mock-Aufruf: ${method} ${path}`);
  }

  return { request, calls };
}

async function run(options, mutate = f => f.env) {
  const f = fixture();
  const lines = [];

  try {
    const env = mutate(f);
    const mock = mockGitHub(f.sha, f.blobs, options);
    let error = null;
    let result = null;

    try {
      result = await publishCodePilot(
        f.event,
        env,
        mock.request,
        f.root,
        line => lines.push(String(line))
      );
    } catch (caught) {
      error = caught;
    }

    const deletes = mock.calls.filter(x => x.method === 'DELETE');
    const comments = mock.calls.filter(
      x => x.method === 'POST' && x.path === 'issues/38/comments'
    );

    return {
      result,
      error,
      calls: mock.calls,
      deletes,
      comments,
      lines,
      blobs: f.blobs,
    };
  } finally {
    f.cleanup();
  }
}

test('Ohne Aktivierung sind alle GitHub-Aufrufe gesperrt', async () => {
  const r = await run({}, f => ({
    ...f.env,
    CODE_PILOT_PUBLISH_ENABLED: 'false',
  }));

  assert.match(r.error?.message ?? '', /nicht freigeschaltet/);
  assert.equal(r.calls.length, 0);
});

test('Veraendertes main blockiert jeden Schreibaufruf', async () => {
  const r = await run({ wrongMain: true });

  assert.match(r.error?.message ?? '', /main wurde seit dem Auftrag veraendert/);
  assert.ok(r.calls.length > 0);
  assert.equal(r.calls.filter(x => x.method !== 'GET').length, 0);
});

test('Gueltiges Paket erzeugt simulierten Draft-PR', async () => {
  const r = await run({});

  assert.equal(r.error, null);
  assert.equal(r.result.branch, BRANCH);
  assert.equal(r.result.url, `https://github.com/${REPO}/pull/999`);

  const writes = r.calls.filter(x => x.method !== 'GET');

  assert.deepEqual(
    writes.map(x => `${x.method} ${x.path}`),
    ['POST git/trees', 'POST git/commits', 'POST git/refs', 'POST pulls']
  );

  assert.equal(writes[3].body.draft, true);
  assert.equal(writes[3].body.base, 'main');
  assert.deepEqual(writes[0].body.tree.map(x => x.path), FILES);

  // Gesendet wird genau, was Git fuer die gepruefte Arbeitskopie rechnet.
  for (const entry of writes[0].body.tree) {
    assert.equal(blobOfText(entry.content), r.blobs[entry.path]);
  }
});

test('Unerlaubter Remote-Diff verhindert Draft-PR', async () => {
  const r = await run({ badDiff: true });

  assert.match(r.error?.message ?? '', /Remote-Diff verletzt die Dateigrenzen/);
  assert.equal(
    r.calls.filter(x => x.path === 'pulls' && x.method === 'POST').length,
    0
  );
});

// A1b: gepruefter Inhalt ist gleich veroeffentlichter Inhalt.

test('A1b: abweichender Paket-Hash blockiert jeden GitHub-Aufruf', async () => {
  const r = await run({}, f => ({
    ...f.env,
    CODE_PILOT_PACKAGE_SHA256: 'e'.repeat(64),
  }));

  assert.match(r.error?.message ?? '', /Paket-Hash weicht ab/);
  assert.equal(r.calls.length, 0);
});

test('A1b: fehlender Paket-Hash aus Job 2 blockiert jeden GitHub-Aufruf', async () => {
  const r = await run({}, f => {
    const env = { ...f.env };
    delete env.CODE_PILOT_PACKAGE_SHA256;
    return env;
  });

  assert.match(r.error?.message ?? '', /Paket-Hash/);
  assert.equal(r.calls.length, 0);
});

test('A1b: Arbeitskopie weicht vom geprueften Paket ab', async () => {
  const r = await run({}, f => {
    appendFileSync(join(f.root, 'src/rechne.js'), '// nachtraeglich\n');
    return f.env;
  });

  assert.match(r.error?.message ?? '', /Paketinhalt/);
  assert.equal(r.calls.length, 0);
});

test('A1b: abweichender Blob im neuen Baum verhindert Commit und Branch', async () => {
  const r = await run({ badBlob: true });

  assert.match(r.error?.message ?? '', /Blob/);

  assert.deepEqual(
    r.calls.filter(x => x.method !== 'GET').map(x => x.path),
    ['git/trees']
  );
});

test('A1b: Remote-Diff mit fremdem Blob verhindert Draft-PR', async () => {
  const f = fixture();

  try {
    const mock = mockGitHub(f.sha, f.blobs);
    const inner = mock.request;

    const request = async (url, options) => {
      const response = await inner(url, options);

      if (url.endsWith(`compare/${f.sha}...${NEW_SHA}`)) {
        const value = await response.json();
        value.files[1].sha = 'e'.repeat(40);
        return { ok: true, status: 200, json: async () => value };
      }

      return response;
    };

    await assert.rejects(
      publishCodePilot(f.event, f.env, request, f.root, () => {}),
      /Remote-Diff verletzt die Dateigrenzen/
    );

    assert.equal(
      mock.calls.filter(x => x.path === 'pulls' && x.method === 'POST').length,
      0
    );
  } finally {
    f.cleanup();
  }
});

test('A1b: gekuerzter Baum auf GitHub verhindert Commit', async () => {
  const r = await run({ truncated: true });

  assert.match(r.error?.message ?? '', /nicht vollstaendig lesbar/);
  assert.deepEqual(
    r.calls.filter(x => x.method !== 'GET').map(x => x.path),
    ['git/trees']
  );
});

test('A1b: doppelter Pfad im neuen Baum verhindert Commit', async () => {
  const r = await run({ duplicateEntry: true });

  assert.match(r.error?.message ?? '', /Blob im neuen Baum/);
  assert.deepEqual(
    r.calls.filter(x => x.method !== 'GET').map(x => x.path),
    ['git/trees']
  );
});

test('A1b: Paket fuer einen anderen Ausgangscommit wird abgelehnt', async () => {
  const r = await run({}, f => {
    const file = join(f.temp, 'code-pilot-package.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.baseSha = 'f'.repeat(40);
    const json = JSON.stringify(data) + '\n';
    writeFileSync(file, json);
    return {
      ...f.env,
      CODE_PILOT_PACKAGE_SHA256:
        createHash('sha256').update(json).digest('hex'),
    };
  });

  assert.match(r.error?.message ?? '', /Ausgangscommit/);
  assert.equal(r.calls.length, 0);
});

// A1a: keine verwaisten Branches.

test('A1a: Abbruch nach Branch-Erstellung loescht genau den eigenen Branch', async () => {
  const r = await run({ failPr: true });

  assert.match(r.error?.message ?? '', /GitHub hat Anfrage abgelehnt: POST pulls/);

  assert.deepEqual(
    r.deletes.map(x => x.path),
    [`git/refs/heads/${BRANCH}`]
  );

  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0].body.body, /geloescht/);
  assert.match(r.comments[0].body.body, new RegExp(BRANCH));
  assert.ok(r.lines.some(line => /geloescht/.test(line)));
});

test('A1a: unerlaubter Remote-Diff raeumt den eigenen Branch auf', async () => {
  const r = await run({ badDiff: true });

  assert.deepEqual(
    r.deletes.map(x => x.path),
    [`git/refs/heads/${BRANCH}`]
  );
});

test('A1a: fremde Branch-Spitze, Branch bleibt stehen', async () => {
  const r = await run({ foreignTip: true });

  assert.match(r.error?.message ?? '', /Branch zeigt nicht auf den geprueften Commit/);
  assert.equal(r.deletes.length, 0);
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0].body.body, /nicht geloescht/);
  assert.match(r.comments[0].body.body, /Spitze/);
  assert.ok(r.lines.some(line => /nicht geloescht.*Spitze/s.test(line)));
});

test('A1a: mehrdeutige Branch-Referenz, Branch bleibt stehen', async () => {
  const r = await run({ tipRefWrong: true });

  assert.match(r.error?.message ?? '', /Branch zeigt nicht auf den geprueften Commit/);
  assert.equal(r.deletes.length, 0);
  assert.match(r.comments[0]?.body.body ?? '', /nicht eindeutig/);
});

test('A1a: vorhandener PR, Branch bleibt stehen', async () => {
  const r = await run({ failPr: true, existingPr: true });

  assert.equal(r.deletes.length, 0);
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0].body.body, /nicht geloescht/);
  assert.match(r.comments[0].body.body, /Pull Request/);
});

test('A1a: PR-Liste nicht lesbar, Branch bleibt stehen', async () => {
  const r = await run({ failPr: true, listPrFails: true });

  assert.equal(r.deletes.length, 0);
  assert.match(r.comments[0]?.body.body ?? '', /nicht geloescht/);
});

test('A1a: Branch nicht in diesem Lauf angelegt, nichts wird geloescht', async () => {
  const r = await run({ refCreateFails: true });

  assert.match(r.error?.message ?? '', /POST git\/refs/);
  assert.equal(r.deletes.length, 0);
  assert.equal(
    r.calls.filter(x => x.method === 'GET' && x.path.startsWith('pulls?')).length,
    0
  );
});

test('A1a: Kommentar nutzt eigenes Token, alles andere das App-Token', async () => {
  const r = await run({ failPr: true }, f => ({
    ...f.env,
    CODE_PILOT_COMMENT_TOKEN: 'job-token-nur-issues',
  }));

  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0].auth, 'Bearer job-token-nur-issues');

  const others = r.calls.filter(
    x => !(x.method === 'POST' && x.path === 'issues/38/comments')
  );

  assert.ok(others.length > 0);
  assert.ok(others.every(x => x.auth === 'Bearer nur-ein-test-token'));
});

test('A1a: gescheiterter Kommentar aendert weder Aufraeumen noch Fehler', async () => {
  const r = await run({ failPr: true, commentFails: true });

  assert.match(r.error?.message ?? '', /GitHub hat Anfrage abgelehnt: POST pulls/);
  assert.equal(r.deletes.length, 1);
  assert.ok(r.lines.some(line => /Kommentar/.test(line)));
});
