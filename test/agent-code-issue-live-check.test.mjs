
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCurrentCodeIssue,
  validateLiveCodeEvent,
} from '../scripts/agent-code-issue-live-check.mjs';

const REPO = 'noah04091/agenten-probe';
const API = `https://api.github.com/repos/${REPO}`;
const SHA = 'a'.repeat(40);

function event() {
  return {
    action: 'labeled',
    repository: { full_name: REPO },
    sender: { login: 'noah04091' },
    label: { name: 'bot-auftrag' },
    issue: {
      number: 38,
      state: 'open',
      repository_url: API,
      user: { login: 'noah04091' },
      labels: [
        { name: 'agent:code-pilot' },
        { name: 'bot-auftrag' },
      ],
    },
  };
}

function currentIssue() {
  return {
    number: 38,
    state: 'open',
    repository_url: API,
    user: { login: 'noah04091' },
    labels: [
      { name: 'agent:code-pilot' },
      { name: 'bot-auftrag' },
    ],
  };
}

function environment() {
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_ACTOR: 'noah04091',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: SHA,
    GH_TOKEN: 'fake-test-token',
  };
}

function mockGitHub(issue = currentIssue(), mainSha = SHA) {
  const calls = [];

  const request = async (url, options) => {
    calls.push({ url, options });

    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');

    assert.equal(
      options.headers.Authorization,
      'Bearer fake-test-token'
    );

    if (url === `${API}/issues/38`) {
      return {
        ok: true,
        json: async () => issue,
      };
    }

    if (url === `${API}/branches/main`) {
      return {
        ok: true,
        json: async () => ({
          commit: { sha: mainSha },
        }),
      };
    }

    throw new Error(`Unerwarteter API-Pfad: ${url}`);
  };

  return { request, calls };
}

test('Gueltiger Live-Auftrag wird akzeptiert', async () => {
  const api = mockGitHub();

  const result = await validateLiveCodeEvent(
    event(),
    environment(),
    api.request
  );

  assert.equal(result.issueNumber, '38');
  assert.equal(result.taskType, 'code-pilot');

  assert.deepEqual(result.allowedFiles, [
    'src/rechne.js',
    'test/rechne.test.js',
  ]);

  assert.deepEqual(
    api.calls.map(call => call.url),
    [
      `${API}/issues/38`,
      `${API}/branches/main`,
    ]
  );
});

test('Live-Pruefung akzeptiert aktuelles Issue #38', () => {
  assert.doesNotThrow(() => {
    validateCurrentCodeIssue(currentIssue(), 38);
  });
});

const invalidIssues = [
  [
    'Geschlossenes Issue',
    issue => { issue.state = 'closed'; },
  ],
  [
    'Falsche Issue-Nummer',
    issue => { issue.number = 39; },
  ],
  [
    'Pull Request statt Issue',
    issue => {
      issue.pull_request = {
        url: `${API}/pulls/38`,
      };
    },
  ],
  [
    'Falsches Repository',
    issue => {
      issue.repository_url =
        'https://api.github.com/repos/andere/firma';
    },
  ],
  [
    'Falscher Issue-Ersteller',
    issue => {
      issue.user.login = 'fremder-user';
    },
  ],
  [
    'Startlabel entfernt',
    issue => {
      issue.labels = [
        { name: 'agent:code-pilot' },
      ];
    },
  ],
  [
    'Code-Aufgabentyp entfernt',
    issue => {
      issue.labels = [
        { name: 'bot-auftrag' },
      ];
    },
  ],
  [
    'Falscher Aufgabentyp',
    issue => {
      issue.labels[0].name = 'agent:test-note';
    },
  ],
  [
    'Zusaetzlicher Aufgabentyp',
    issue => {
      issue.labels.push({
        name: 'agent:test-note',
      });
    },
  ],
  [
    'Doppeltes Startlabel',
    issue => {
      issue.labels.push({
        name: 'bot-auftrag',
      });
    },
  ],
  [
    'Doppelter Code-Aufgabentyp',
    issue => {
      issue.labels.push({
        name: 'agent:code-pilot',
      });
    },
  ],
  [
    'Fehlende Label-Liste',
    issue => {
      issue.labels = null;
    },
  ],
  [
    'Ungueltige Label-Struktur',
    issue => {
      issue.labels = [{ name: 123 }];
    },
  ],
];

for (const [name, change] of invalidIssues) {
  test(`Live-Pruefung lehnt ab: ${name}`, async () => {
    const issue = currentIssue();
    change(issue);

    assert.throws(
      () => validateCurrentCodeIssue(issue, 38),
      /Code-Live-Pruefung abgelehnt/
    );

    const api = mockGitHub(issue);

    await assert.rejects(
      () => validateLiveCodeEvent(
        event(),
        environment(),
        api.request
      ),
      /Code-Live-Pruefung abgelehnt/
    );

    // Nach ungueltigem Issue darf main nicht mehr
    // fuer die Freigabe abgefragt werden.
    assert.equal(api.calls.length, 1);
  });
}

test('Falsche erwartete Issue-Nummer wird abgelehnt', () => {
  assert.throws(
    () => validateCurrentCodeIssue(currentIssue(), 39),
    /Code-Live-Pruefung abgelehnt/
  );
});

test('Veraenderter main-Commit wird abgelehnt', async () => {
  const api = mockGitHub(
    currentIssue(),
    'b'.repeat(40)
  );

  await assert.rejects(
    () => validateLiveCodeEvent(
      event(),
      environment(),
      api.request
    ),
    /main wurde seit dem Auftrag veraendert/
  );

  assert.equal(api.calls.length, 2);
});

test('Falscher GitHub-Branch wird abgelehnt', async () => {
  const env = environment();
  env.GITHUB_REF = 'refs/heads/andere';

  await assert.rejects(
    () => validateLiveCodeEvent(event(), env, mockGitHub().request),
    /Code-Live-Pruefung abgelehnt/
  );
});

test('Ungueltiger Ausgangs-SHA wird abgelehnt', async () => {
  const env = environment();
  env.GITHUB_SHA = 'ungueltig';

  await assert.rejects(
    () => validateLiveCodeEvent(event(), env, mockGitHub().request),
    /Code-Live-Pruefung abgelehnt/
  );
});

test('Fehlendes GitHub-Token wird abgelehnt', async () => {
  const env = environment();
  env.GH_TOKEN = '';

  await assert.rejects(
    () => validateLiveCodeEvent(event(), env, mockGitHub().request),
    /GitHub-Lesetoken fehlt/
  );
});

test('HTTP-Fehler fuehrt zum Abbruch', async () => {
  const request = async () => ({
    ok: false,
    status: 403,
  });

  await assert.rejects(
    () => validateLiveCodeEvent(event(), environment(), request),
    /Code-Live-Pruefung abgelehnt/
  );
});

test('Ungueltiges JSON fuehrt zum Abbruch', async () => {
  const request = async () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError('ungueltiges JSON');
    },
  });

  await assert.rejects(
    () => validateLiveCodeEvent(event(), environment(), request),
    /Code-Live-Pruefung abgelehnt/
  );
});

test('Netzwerkfehler fuehrt zum Abbruch', async () => {
  const request = async () => {
    throw new Error('Network unavailable');
  };

  await assert.rejects(
    () => validateLiveCodeEvent(event(), environment(), request),
    /Code-Live-Pruefung abgelehnt/
  );
});

test('Manipuliertes Startereignis wird vor API-Aufruf abgelehnt',
  async () => {
    const bad = event();
    bad.issue.number = 39;

    let requests = 0;

    const request = async () => {
      requests++;
      throw new Error('Darf nicht aufgerufen werden');
    };

    await assert.rejects(
      () => validateLiveCodeEvent(
        bad,
        environment(),
        request
      ),
      /Code-Auftrag abgelehnt/
    );

    assert.equal(requests, 0);
  }
);

test('Falscher GitHub-Akteur wird vor API-Aufruf abgelehnt',
  async () => {
    const env = environment();
    env.GITHUB_ACTOR = 'fremder-user';

    let requests = 0;

    const request = async () => {
      requests++;
      throw new Error('Darf nicht aufgerufen werden');
    };

    await assert.rejects(
      () => validateLiveCodeEvent(
        event(),
        env,
        request
      ),
      /Code-Auftrag abgelehnt/
    );

    assert.equal(requests, 0);
  }
);

test('Falsches Repository wird vor API-Aufruf abgelehnt',
  async () => {
    const env = environment();
    env.GITHUB_REPOSITORY = 'andere/firma';

    let requests = 0;

    const request = async () => {
      requests++;
      throw new Error('Darf nicht aufgerufen werden');
    };

    await assert.rejects(
      () => validateLiveCodeEvent(
        event(),
        env,
        request
      ),
      /Code-Auftrag abgelehnt/
    );

    assert.equal(requests, 0);
  }
);
