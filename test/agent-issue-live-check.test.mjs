
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCurrentIssue,
  validateLiveEvent,
} from '../scripts/agent-issue-live-check.mjs';

const REPO = 'noah04091/agenten-probe';
const API = `https://api.github.com/repos/${REPO}`;
const SHA = 'a'.repeat(40);
const NUMBER = 44;

function event() {
  return {
    action: 'labeled',
    repository: { full_name: REPO },
    sender: { login: 'noah04091' },
    label: { name: 'bot-auftrag' },
    issue: {
      number: NUMBER,
      state: 'open',
      labels: [
        { name: 'bot-auftrag' },
        { name: 'agent:test-note' },
      ],
    },
  };
}

function liveIssue() {
  return {
    number: NUMBER,
    state: 'open',
    repository_url: API,
    labels: [
      { name: 'bot-auftrag' },
      { name: 'agent:test-note' },
    ],
  };
}

function environment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_ACTOR: 'noah04091',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: SHA,
    GH_TOKEN: 'test-token-ohne-echte-rechte',
    ...overrides,
  };
}

function mockGitHub({
  issue = liveIssue(),
  mainSha = SHA,
  error = null,
} = {}) {
  const calls = [];

  const request = async (url, options) => {
    calls.push({ url, options });

    if (error === 'network') throw new Error('Offline');
    if (error === 'http') return { ok: false };

    if (error === 'json') {
      return {
        ok: true,
        json: async () => { throw new Error('Invalid JSON'); },
      };
    }

    if (url === `${API}/issues/${NUMBER}`) {
      return { ok: true, json: async () => issue };
    }

    if (url === `${API}/branches/main`) {
      return {
        ok: true,
        json: async () => ({ commit: { sha: mainSha } }),
      };
    }

    throw new Error('Unerwartete API-Anfrage');
  };

  return { request, calls };
}

test('Gueltiger Live-Auftrag wird akzeptiert', async () => {
  const mock = mockGitHub();

  const result = await validateLiveEvent(
    event(), environment(), mock.request
  );

  assert.deepEqual(result, {
    issueNumber: '44',
    taskType: 'test-note',
    filePath: 'test/agent-issues/issue-44.md',
  });

  assert.deepEqual(mock.calls.map(c => c.url), [
    `${API}/issues/44`,
    `${API}/branches/main`,
  ]);

  for (const call of mock.calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(
      call.options.headers.Authorization,
      'Bearer test-token-ohne-echte-rechte'
    );
  }
});

const invalidIssues = [
  ['Geschlossenes Issue', i => { i.state = 'closed'; }],
  ['Falsche Issue-Nummer', i => { i.number = 45; }],
  ['Falsches Repository', i => {
    i.repository_url = 'https://api.github.com/repos/andere/repo';
  }],
  ['Pull Request statt Issue', i => {
    i.pull_request = { url: 'https://example.invalid' };
  }],
  ['Startlabel entfernt', i => {
    i.labels = [{ name: 'agent:test-note' }];
  }],
  ['Aufgabentyp entfernt', i => {
    i.labels = [{ name: 'bot-auftrag' }];
  }],
  ['Zusaetzlicher Aufgabentyp', i => {
    i.labels.push({ name: 'agent:code' });
  }],
  ['Doppeltes Startlabel', i => {
    i.labels.push({ name: 'bot-auftrag' });
  }],
  ['Ungueltige Label-Struktur', i => {
    i.labels.push(null);
  }],
];

for (const [name, mutate] of invalidIssues) {
  test(`Live-Pruefung lehnt ab: ${name}`, async () => {
    const issue = liveIssue();
    mutate(issue);

    assert.throws(
      () => validateCurrentIssue(issue, NUMBER),
      /Live-Pruefung abgelehnt/
    );

    const mock = mockGitHub({ issue });

    await assert.rejects(
      validateLiveEvent(event(), environment(), mock.request),
      /Live-Pruefung abgelehnt/
    );
  });
}

test('Veraenderter main-Commit wird abgelehnt', async () => {
  const mock = mockGitHub({ mainSha: 'b'.repeat(40) });

  await assert.rejects(
    validateLiveEvent(event(), environment(), mock.request),
    /main hat sich/
  );
});

test('Falscher GitHub-Branch wird abgelehnt', async () => {
  const mock = mockGitHub();

  await assert.rejects(
    validateLiveEvent(event(),
      environment({ GITHUB_REF: 'refs/heads/andere' }),
      mock.request),
    /Ungueltiger main-Ausgangspunkt/
  );

  assert.equal(mock.calls.length, 0);
});

test('Ungueltiger Commit-SHA wird abgelehnt', async () => {
  const mock = mockGitHub();

  await assert.rejects(
    validateLiveEvent(event(),
      environment({ GITHUB_SHA: 'ungueltig' }),
      mock.request),
    /Ungueltiger main-Ausgangspunkt/
  );

  assert.equal(mock.calls.length, 0);
});

test('Fehlendes GitHub-Token wird abgelehnt', async () => {
  const mock = mockGitHub();

  await assert.rejects(
    validateLiveEvent(event(),
      environment({ GH_TOKEN: '' }),
      mock.request),
    /GitHub-Lesetoken fehlt/
  );

  assert.equal(mock.calls.length, 0);
});

test('GitHub-API-Fehler fuehrt zum Abbruch', async () => {
  const mock = mockGitHub({ error: 'http' });

  await assert.rejects(
    validateLiveEvent(event(), environment(), mock.request),
    /GitHub-API antwortet nicht erfolgreich/
  );
});

test('Ungueltige API-Antwort fuehrt zum Abbruch', async () => {
  const mock = mockGitHub({ error: 'json' });

  await assert.rejects(
    validateLiveEvent(event(), environment(), mock.request),
    /ungueltiges JSON/
  );
});

test('Netzwerkfehler fuehrt zum Abbruch', async () => {
  const mock = mockGitHub({ error: 'network' });

  await assert.rejects(
    validateLiveEvent(event(), environment(), mock.request),
    /nicht erreichbar/
  );
});

test('Manipuliertes Start-Ereignis wird vor API-Aufruf abgelehnt',
  async () => {
    const mock = mockGitHub();
    const e = event();
    e.sender.login = 'fremder-user';

    await assert.rejects(
      validateLiveEvent(e, environment(), mock.request),
      /Auftrag abgelehnt/
    );

    assert.equal(mock.calls.length, 0);
  }
);
