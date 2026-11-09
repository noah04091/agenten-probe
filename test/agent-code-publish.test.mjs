
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishCodePilot } from '../scripts/agent-code-publish.mjs';

const REPO = 'noah04091/agenten-probe';
const API = `https://api.github.com/repos/${REPO}`;
const NEW_SHA = 'c'.repeat(40);

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'code-pilot-publish-'));

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
  };

  return { root, sha, event, env };
}

function mockGitHub(sha, { wrongMain = false, badDiff = false } = {}) {
  const calls = [];
  const branch = 'wp/38-code-pilot-12345-1';

  async function request(url, options = {}) {
    assert.ok(url.startsWith(API + '/'), 'Nur GitHub-Testendpunkte');

    const path = url.slice(API.length + 1);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;

    calls.push({ method, path, body });

    let value;

    if (method === 'GET' && path === 'issues/38') {
      value = {
        number: 38,
        state: 'open',
        user: { login: 'noah04091' },
        repository_url: API,
        labels: [
          { name: 'bot-auftrag' },
          { name: 'agent:code-pilot' },
        ],
      };
    } else if (method === 'GET' && path === 'branches/main') {
      value = {
        commit: {
          sha: wrongMain ? 'f'.repeat(40) : sha,
        },
      };
    } else if (method === 'GET' && path === `git/commits/${sha}`) {
      value = { tree: { sha: 'a'.repeat(40) } };
    } else if (method === 'POST' && path === 'git/trees') {
      value = { sha: 'b'.repeat(40) };
    } else if (method === 'POST' && path === 'git/commits') {
      value = { sha: NEW_SHA };
    } else if (method === 'POST' && path === 'git/refs') {
      value = {
        ref: `refs/heads/${branch}`,
        object: { sha: NEW_SHA },
      };
    } else if (
      method === 'GET' &&
      path === `git/ref/heads/${branch}`
    ) {
      value = {
        ref: `refs/heads/${branch}`,
        object: { sha: NEW_SHA },
      };
    } else if (
      method === 'GET' &&
      path === `compare/${sha}...${NEW_SHA}`
    ) {
      value = {
        ahead_by: 1,
        files: badDiff
          ? [
              {
                filename: '.github/workflows/unsafe.yml',
                status: 'modified',
              },
            ]
          : [
              {
                filename: 'src/rechne.js',
                status: 'modified',
              },
              {
                filename: 'test/rechne.test.js',
                status: 'modified',
              },
            ],
      };
    } else if (method === 'POST' && path === 'pulls') {
      value = {
        draft: true,
        base: { ref: 'main' },
        head: { ref: branch },
        html_url: `https://github.com/${REPO}/pull/999`,
      };
    } else {
      throw new Error(`Unbekannter Mock-Aufruf: ${method} ${path}`);
    }

    return { ok: true, json: async () => value };
  }

  return { request, calls };
}

test('Ohne Aktivierung sind alle GitHub-Aufrufe gesperrt', async () => {
  const f = fixture();

  try {
    const mock = mockGitHub(f.sha);

    await assert.rejects(
      publishCodePilot(
        f.event,
        { ...f.env, CODE_PILOT_PUBLISH_ENABLED: 'false' },
        mock.request,
        f.root
      ),
      /nicht freigeschaltet/
    );

    assert.equal(mock.calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Veraendertes main blockiert jeden Schreibaufruf', async () => {
  const f = fixture();

  try {
    const mock = mockGitHub(f.sha, { wrongMain: true });

    await assert.rejects(
      publishCodePilot(f.event, f.env, mock.request, f.root),
      /main wurde seit dem Auftrag veraendert/
    );

    assert.ok(mock.calls.length > 0);

    assert.equal(
      mock.calls.filter(x => x.method !== 'GET').length,
      0
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Gueltiges Paket erzeugt simulierten Draft-PR', async () => {
  const f = fixture();

  try {
    const mock = mockGitHub(f.sha);

    const result = await publishCodePilot(
      f.event,
      f.env,
      mock.request,
      f.root
    );

    assert.equal(
      result.branch,
      'wp/38-code-pilot-12345-1'
    );

    assert.equal(
      result.url,
      `https://github.com/${REPO}/pull/999`
    );

    const writes = mock.calls.filter(x => x.method === 'POST');

    assert.deepEqual(
      writes.map(x => x.path),
      ['git/trees', 'git/commits', 'git/refs', 'pulls']
    );

    assert.equal(writes[3].body.draft, true);
    assert.equal(writes[3].body.base, 'main');

    assert.deepEqual(
      writes[0].body.tree.map(x => x.path),
      ['src/rechne.js', 'test/rechne.test.js']
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Unerlaubter Remote-Diff verhindert Draft-PR', async () => {
  const f = fixture();

  try {
    const mock = mockGitHub(f.sha, { badDiff: true });

    await assert.rejects(
      publishCodePilot(f.event, f.env, mock.request, f.root),
      /Remote-Diff verletzt die Dateigrenzen/
    );

    assert.equal(
      mock.calls.filter(
        x => x.path === 'pulls' && x.method === 'POST'
      ).length,
      0
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
