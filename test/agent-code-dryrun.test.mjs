import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodePackage } from '../scripts/agent-code-package.mjs';
import {
  checkWorkflowGuards,
  createStrictGitHub,
  expectedCalls,
  prepareFixedChange,
  runDryRun,
} from '../scripts/agent-code-dryrun.mjs';

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Arbeitskopie wie in Job 2 und 3: Ausgangscommit plus feste Testaenderung.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'code-pilot-dry-'));
  const temp = mkdtempSync(join(tmpdir(), 'code-pilot-dry-runner-'));

  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src/rechne.js'), [
    'function addiere(a, b) {',
    '  return a + b;',
    '}',
    '',
    'module.exports = { addiere, subtrahiere };',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'test/rechne.test.js'), '// Basis\n');

  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'user.name', 'Trockenlauf Test');
  git(root, 'config', 'user.email', 'trockenlauf@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Basis');

  const baseSha = git(root, 'rev-parse', 'HEAD');
  prepareFixedChange(root);

  const json = createCodePackage(root, baseSha);
  writeFileSync(join(temp, 'code-pilot-package.json'), json);

  const input = {
    root,
    temp,
    baseSha,
    packageSha256: createHash('sha256').update(json).digest('hex'),
    runId: '777',
    runAttempt: '1',
    env: {},
  };

  return {
    input,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

async function withFixture(fn) {
  const f = fixture();
  try {
    return await fn(f.input);
  } finally {
    f.cleanup();
  }
}

test('Trockenlauf: Gutfall und alle Gegenproben bestehen', async () => {
  await withFixture(async input => {
    const lines = [];
    const result = await runDryRun(input, line => lines.push(line));

    assert.deepEqual(
      result.calls,
      expectedCalls(input.baseSha, 'wp/38-code-pilot-777-1')
    );
    assert.ok(lines.includes('Gegenprobe falscher Paket-Hash: abgelehnt, 0 Anfragen'));
    assert.ok(lines.includes('Gegenprobe manipulierte Datei: abgelehnt, 0 Anfragen'));
    assert.ok(lines.some(line => /unerwarteter GitHub-Aufruf nach dem Anlegen des Branches: abgebrochen, danach nichts beantwortet/.test(line)));
    assert.ok(lines.includes('0 Anfragen an echtes GitHub. Trockenlauf bestanden.'));
    assert.equal(lines.filter(line => /gesendet = geprueft/.test(line)).length, 2);
  });
});

test('Trockenlauf: Hash aus Job 2 passt nicht zum Paket', async () => {
  await withFixture(async input => {
    await assert.rejects(
      runDryRun({ ...input, packageSha256: 'f'.repeat(64) }, () => {}),
      /Paket-Hash aus Job 2 passt nicht/
    );
  });
});

test('Trockenlauf: echte Zugangsdaten im Umfeld werden verweigert', async () => {
  await withFixture(async input => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'BOT_APP_PRIVATE_KEY']) {
      await assert.rejects(
        runDryRun({ ...input, env: { [name]: 'x' } }, () => {}),
        new RegExp(`Zugangsdaten ${name}`)
      );
    }
  });
});

test('Trockenlauf: Paket zu einem anderen Ausgangscommit scheitert', async () => {
  await withFixture(async input => {
    await assert.rejects(
      runDryRun({ ...input, baseSha: 'e'.repeat(40) }, () => {}),
      /Gutfall gescheitert/
    );
  });
});

test('Trockenlauf: Arbeitskopie nach der Pruefung veraendert', async () => {
  await withFixture(async input => {
    appendFileSync(join(input.root, 'src/rechne.js'), '// spaeter\n');
    await assert.rejects(runDryRun(input, () => {}), /Gutfall gescheitert/);
  });
});

test('Trockenlauf: echter Netzaufruf ist gesperrt und fetch wird zurueckgesetzt', async () => {
  await withFixture(async input => {
    const before = globalThis.fetch;
    await runDryRun(input, () => {});
    assert.equal(globalThis.fetch, before);
  });
});

test('Strenges GitHub: unerwarteter Aufruf bricht ab, auch jeder weitere', async () => {
  // Der zweite Aufruf waere fuer sich passend, muss nach dem Fehler aber gesperrt bleiben.
  const gh = createStrictGitHub('a'.repeat(40), 'wp/38-code-pilot-1-1', ['GET issues/38', 'GET issues/38']);
  const opts = {
    redirect: 'error',
    headers: { Authorization: 'Bearer trockenlauf-ohne-rechte' },
  };

  await assert.rejects(
    gh.request('https://api.github.com/repos/noah04091/agenten-probe/branches/main', opts),
    /Unerwarteter GitHub-Aufruf: GET branches\/main/
  );
  await assert.rejects(
    gh.request('https://api.github.com/repos/noah04091/agenten-probe/issues/38', opts),
    /Unerwarteter GitHub-Aufruf/
  );
  assert.equal(gh.unexpected, 'GET branches/main');
});

test('Strenges GitHub: fremdes Token oder Weiterleitung wird abgelehnt', async () => {
  const url = 'https://api.github.com/repos/noah04091/agenten-probe/issues/38';

  const tokenGh = createStrictGitHub('a'.repeat(40), 'b', ['GET issues/38']);
  await assert.rejects(
    tokenGh.request(url, { redirect: 'error', headers: { Authorization: 'Bearer echt' } }),
    /Unerwarteter GitHub-Aufruf/
  );

  const redirectGh = createStrictGitHub('a'.repeat(40), 'b', ['GET issues/38']);
  await assert.rejects(
    redirectGh.request(url, { headers: { Authorization: 'Bearer trockenlauf-ohne-rechte' } }),
    /Unerwarteter GitHub-Aufruf/
  );
});

test('Feste Testaenderung verweigert einen unerwarteten Ausgangsstand', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-pilot-prep-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'src/rechne.js'), 'function multipliziere(a, b) {}\nmodule.exports = { addiere, subtrahiere };\n');
    writeFileSync(join(root, 'test/rechne.test.js'), '');
    assert.throws(() => prepareFixedChange(root), /unerwarteter Ausgangsstand/);
    assert.match(readFileSync(join(root, 'src/rechne.js'), 'utf8'), /^function multipliziere\(a, b\) \{\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Wachen gegen Rechte im Trockenlauf und Abweichung vom echten Job 2.
// Bis Noah den Patch anwendet, steht der Workflow nur im Patch.

function workflows() {
  const pilot = readFileSync('.github/workflows/code-pilot-claude-stufe.yml', 'utf8');
  const path = '.github/workflows/code-pilot-trockenlauf.yml';
  const dry = existsSync(path)
    ? readFileSync(path, 'utf8')
    : readFileSync('docs/a2-workflow-patch.diff', 'utf8')
        .split('\n')
        .filter(line => line.startsWith('+') && !line.startsWith('+++'))
        .map(line => line.slice(1))
        .join('\n') + '\n';
  return { pilot: pilot.replace(/\r\n/g, '\n'), dry: dry.replace(/\r\n/g, '\n') };
}

test('Wachen: echter Trockenlauf-Workflow besteht', () => {
  const { pilot, dry } = workflows();
  assert.equal(checkWorkflowGuards(pilot, dry), true);
});

test('Wachen: Secrets, Schreibrechte oder Claude im Trockenlauf werden abgelehnt', () => {
  const { pilot, dry } = workflows();
  for (const [extra, word] of [
    ['      X: ${{ secrets.ANTHROPIC_API_KEY }}\n', /Verbotenes: secrets/],
    ['    permissions:\n      contents: write\n', /: write/],
    ['    environment:\n      name: claude-bot\n', /environment:/],
    ['      - uses: anthropics/claude-code-action@x\n', /claude-code-action/],
    ['      - uses: actions/create-github-app-token@x\n', /create-github-app-token/],
    ['      GH_TOKEN: ${{ github.token }}\n', /github\.token/],
  ]) {
    assert.throws(() => checkWorkflowGuards(pilot, dry + extra), word);
  }
});

test('Wachen: fehlendes permissions {} wird abgelehnt', () => {
  const { pilot, dry } = workflows();
  assert.throws(
    () => checkWorkflowGuards(pilot, dry.replace('\npermissions: {}\n', '\n')),
    /permissions: \{\}/
  );
});

test('Wachen: abweichender Docker-Aufruf, Hash oder Paketpruefung wird erkannt', () => {
  const { pilot, dry } = workflows();
  for (const [from, to, what] of [
    ['--network none', '--network bridge', /Docker-Aufruf/],
    ['--cpus 1', '--cpus 4', /Docker-Aufruf/],
    ['^[a-f0-9]{64}$ ]]', '^.*$ ]]', /Hash-Berechnung/],
    ['apply "$GITHUB_SHA"\n\n          git diff', 'apply "$BASE_SHA"\n\n          git diff', /Paketpruefung/],
    ['IMAGE: node@sha256:8', 'IMAGE: node@sha256:9', /Docker-Image/],
  ]) {
    const section = dry.indexOf('\n  codepaket_pruefen:\n');
    const at = dry.indexOf(from, section);
    assert.ok(at > section, `Stelle fehlt: ${from}`);
    const changed = dry.slice(0, at) + to + dry.slice(at + from.length);
    assert.throws(() => checkWorkflowGuards(pilot, changed), what);
  }
});

test('Wachen: verdeckter Zugriff auf Secrets oder Token wird abgelehnt', () => {
  const { pilot, dry } = workflows();
  for (const extra of [
    "      X: ${{ secrets['ANTHROPIC_API_KEY'] }}\n",
    '      X: ${{ toJSON(secrets) }}\n',
    "      X: ${{ github['token'] }}\n",
    '    permissions: write-all\n',
  ]) {
    assert.throws(() => checkWorkflowGuards(pilot, dry + extra), /Trockenlauf/);
  }
});

test('Wachen: ausgehebelte oder fehlende Pruefschritte werden erkannt', () => {
  const { pilot, dry } = workflows();
  const job2 = dry.indexOf('\n  codepaket_pruefen:\n');
  const job3 = dry.indexOf('\n  veroeffentlichung_trocken:\n');
  const at = (text, from, to, start = 0) => {
    const i = text.indexOf(from, start);
    assert.ok(i >= 0, `Stelle fehlt: ${from}`);
    return text.slice(0, i) + to + text.slice(i + from.length);
  };

  for (const [changed, what] of [
    [at(dry, '    runs-on:', '    continue-on-error: true\n    runs-on:', job2), /continue-on-error/],
    [at(dry, '    runs-on:', '    if: false\n    runs-on:', job2), /if-Bedingung/],
    [at(dry, '          git diff --check\n', '', job2), /git diff --check/],
    [at(dry, '          node scripts/agent-code-package.mjs apply "$GITHUB_SHA"\n', '', job3), /Paketpruefung/],
    [at(dry, '          node scripts/agent-code-dryrun.mjs publish', '          echo ok', job3), /Veroeffentlicher-Trockenlauf/],
    [at(dry, '          node scripts/agent-code-dryrun.mjs guard', '          echo ok'), /Wachen-Schritt/],
    [at(dry, '          git diff --check\n', '          git diff --check\n          git checkout -- src test\n', job2), /setzt Dateien zurueck/],
    [at(dry, '    needs: testpaket_erzeugen\n', '', job2), /Abhaengigkeit Job 2/],
  ]) {
    assert.throws(() => checkWorkflowGuards(pilot, changed), what);
  }
});

test('Strenges GitHub: falscher Inhalt eines Schreibaufrufs wird abgewiesen', async () => {
  const base = 'a'.repeat(40);
  const branch = 'wp/38-code-pilot-1-1';
  const opts = body => ({
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: 'Bearer trockenlauf-ohne-rechte' },
    body: JSON.stringify(body),
  });
  const url = path => `https://api.github.com/repos/noah04091/agenten-probe/${path}`;
  const good = {
    'git/refs': { ref: `refs/heads/${branch}`, sha: 'c'.repeat(40) },
    pulls: { title: 't', head: branch, base: 'main', draft: true, body: 'b' },
    'git/commits': { message: 'm', tree: 'b'.repeat(40), parents: [base] },
  };

  for (const [path, body] of Object.entries(good)) {
    const gh = createStrictGitHub(base, branch, [`POST ${path}`]);
    const response = await gh.request(url(path), opts(body));
    assert.equal(response.ok, true, `Gutfall ${path}`);
  }

  for (const [path, body] of [
    ['git/refs', { ...good['git/refs'], ref: 'refs/heads/main' }],
    ['git/refs', { ...good['git/refs'], sha: base }],
    ['pulls', { ...good.pulls, draft: false }],
    ['pulls', { ...good.pulls, base: 'produktion' }],
    ['pulls', { ...good.pulls, head: 'fremd' }],
    ['git/commits', { ...good['git/commits'], parents: [] }],
    ['git/commits', { ...good['git/commits'], tree: 'e'.repeat(40) }],
    ['git/trees', { tree: [] }],
  ]) {
    const gh = createStrictGitHub(base, branch, [`POST ${path}`]);
    await assert.rejects(gh.request(url(path), opts(body)), /Unerwarteter GitHub-Aufruf/);
    assert.deepEqual(gh.answered, []);
  }
});

test('Feste Testaenderung: hat main die Multiplikation schon, nur Kommentarzeilen', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-pilot-prep-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    const src = 'function multipliziere(a, b) {\n  return a * b;\n}\n\nmodule.exports = { addiere, subtrahiere, multipliziere };\n';
    writeFileSync(join(root, 'src/rechne.js'), src);
    writeFileSync(join(root, 'test/rechne.test.js'), '// Basis\n');
    assert.equal(prepareFixedChange(root), 'kommentar');
    assert.equal(readFileSync(join(root, 'src/rechne.js'), 'utf8'), src + '\n// Code-Pilot Trockenlauf\n');
    assert.equal(readFileSync(join(root, 'test/rechne.test.js'), 'utf8'), '// Basis\n\n// Code-Pilot Trockenlauf\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Wachen: ausgehebelte Schritte und Rechte innerhalb eines Jobs werden erkannt', () => {
  const { pilot, dry } = workflows();
  const job3 = dry.indexOf('\n  veroeffentlichung_trocken:\n');
  const at = (from, to, start = 0) => {
    const i = dry.indexOf(from, start);
    assert.ok(i >= 0, `Stelle fehlt: ${from}`);
    return dry.slice(0, i) + to + dry.slice(i + from.length);
  };
  const publish = '          node scripts/agent-code-dryrun.mjs publish';
  const step = '      - name: Echten Veroeffentlicher gegen nachgebautes GitHub ausfuehren\n';

  for (const [changed, what] of [
    [at(step, step + '        if: false\n', job3), /if-Bedingung/],
    [at(publish, '          exit 0\n' + publish, job3), /Verbotenes: exit/],
    [at(publish, '          set +e\n' + publish + ' || true', job3), /Verbotenes/],
    [at('    permissions: {}\n', "    permissions:\n      contents: 'write'\n", job3), /Verbotenes: write/],
    [at('    permissions: {}\n', '    permissions: read-all\n', job3), /Verbotenes: read-all/],
    [at('          persist-credentials: false\n', '', job3), /persist-credentials/],
    [dry + "      X: ${{ github[format('{0}en', 'tok')] }}\n", /Verbotenes: format\(/],
    [at('        run: |\n          set -euo pipefail\n', '        run: |\n          echo los\n', job3), /set -euo pipefail am Anfang/],
  ]) {
    assert.throws(() => checkWorkflowGuards(pilot, changed), what);
  }
});

test('Strenges GitHub: Zusatzfelder in Schreibaufrufen werden abgewiesen', async () => {
  const base = 'a'.repeat(40);
  const branch = 'wp/38-code-pilot-1-1';
  const opts = body => ({
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: 'Bearer trockenlauf-ohne-rechte' },
    body: JSON.stringify(body),
  });
  const url = path => `https://api.github.com/repos/noah04091/agenten-probe/${path}`;
  const entry = path => ({ path, mode: '100644', type: 'blob', content: 'x' });
  const tree = { base_tree: base, tree: [entry('src/rechne.js'), entry('test/rechne.test.js')] };
  const commit = { message: 'm', tree: 'b'.repeat(40), parents: [base] };
  const pull = { title: 't', head: branch, base: 'main', draft: true, body: 'b' };

  const ok = createStrictGitHub(base, branch, ['POST git/trees']);
  assert.equal((await ok.request(url('git/trees'), opts(tree))).ok, true);

  for (const [path, body] of [
    ['git/trees', { ...tree, force: true }],
    ['git/trees', { ...tree, tree: [{ ...entry('src/rechne.js'), extra: 1 }, entry('test/rechne.test.js')] }],
    ['git/commits', { ...commit, author: { name: 'fremd', email: 'f@example.invalid' } }],
    ['pulls', { ...pull, maintainer_can_modify: true }],
  ]) {
    const gh = createStrictGitHub(base, branch, [`POST ${path}`]);
    await assert.rejects(gh.request(url(path), opts(body)), /Unerwarteter GitHub-Aufruf/);
  }
});
