
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import {
  createCodePackage,
  applyCodePackage,
} from '../scripts/agent-code-package.mjs';

const REPO = 'noah04091/agenten-probe';
const SCRIPT = fileURLToPath(
  new URL('../scripts/agent-code-package.mjs', import.meta.url)
);

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'code-package-test-'));
  const seed = join(temp, 'seed');
  const source = join(temp, 'source');
  const target = join(temp, 'target');
  const artifactDir = join(temp, 'artifacts');
  mkdirSync(seed);
  mkdirSync(artifactDir);
  mkdirSync(join(seed, 'src'));
  mkdirSync(join(seed, 'test'));

  writeFileSync(join(seed, 'src/rechne.js'),
    'function addiere(a, b) { return a + b; }\n');
  writeFileSync(join(seed, 'test/rechne.test.js'),
    "const assert = require('node:assert');\n");
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n');

  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'Initial');

  git(temp, 'clone', '-q', seed, source);
  git(temp, 'clone', '-q', seed, target);
  const sha = git(source, 'rev-parse', 'HEAD');

  appendFileSync(join(source, 'src/rechne.js'),
    'function multipliziere(a,b) { return a*b; }\n');
  appendFileSync(join(source, 'test/rechne.test.js'),
    '// Test fuer Multiplikation\n');

  return { temp, source, target, artifactDir, sha };
}

function withFixture(name, fn) {
  test(name, () => {
    const f = fixture();
    try {
      fn(f);
    } finally {
      rmSync(f.temp, { recursive: true, force: true });
    }
  });
}

function packageData(f) {
  return JSON.parse(createCodePackage(f.source, f.sha));
}

function replaceBytes(entry, bytes) {
  entry.base64 = bytes.toString('base64');
  entry.sha256 = hash(bytes);
}

function assertClean(f) {
  assert.equal(git(f.target, 'status', '--porcelain=v1'), '');
}

// Positive Kontrollfaelle

withFixture('Erlaubtes Code-Paket wird korrekt erzeugt', f => {
  const json = createCodePackage(f.source, f.sha);
  const obj = JSON.parse(json);

  assert.ok(Buffer.byteLength(json) < 60_000);

  assert.deepEqual(Object.keys(obj).sort(),
    ['schema', 'repository', 'issue', 'baseSha', 'files'].sort());

  assert.equal(obj.schema, 'agent-code-pilot-v1');
  assert.equal(obj.repository, REPO);
  assert.equal(obj.issue, 38);
  assert.equal(obj.baseSha, f.sha);

  assert.deepEqual(obj.files.map(x => x.path), [
    'src/rechne.js',
    'test/rechne.test.js',
  ]);

  for (const entry of obj.files) {
    assert.equal(
      hash(Buffer.from(entry.base64, 'base64')),
      entry.sha256
    );
  }
});

withFixture('Gueltiger Paket-Roundtrip in frischer Arbeitskopie', f => {
  const result = applyCodePackage(
    f.target,
    f.sha,
    createCodePackage(f.source, f.sha)
  );

  assert.deepEqual([...result.files].sort(), [
    'src/rechne.js',
    'test/rechne.test.js',
  ].sort());

  assert.ok(result.changedLines > 0);

  for (const path of result.files) {
    assert.deepEqual(
      readFileSync(join(f.target, path)),
      readFileSync(join(f.source, path))
    );
  }
});

// Manipulierte Pakete

const badPackets = [
  ['Falsches Schema', p => {
    p.schema = 'other';
  }],
  ['Falsches Repository', p => {
    p.repository = 'attacker/repo';
  }],
  ['Falsche Issue-Nummer', p => {
    p.issue = 39;
  }],
  ['Falscher Ausgangscommit', p => {
    p.baseSha = 'b'.repeat(40);
  }],
  ['Zusaetzliches Metadatenfeld', p => {
    p.admin = true;
  }],
  ['Fehlendes Metadatenfeld', p => {
    delete p.issue;
  }],
  ['Zu wenige Dateien', p => {
    p.files.pop();
  }],
  ['Zu viele Dateien', p => {
    p.files.push({ ...p.files[0] });
  }],
  ['Vertauschte Dateireihenfolge', p => {
    p.files.reverse();
  }],
  ['Manipulierter Dateipfad', p => {
    p.files[0].path = 'README.md';
  }],
  ['Pfad-Traversal', p => {
    p.files[0].path = '../outside.js';
  }],
  ['Zusaetzliches Dateifeld', p => {
    p.files[0].mode = '100755';
  }],
  ['Fehlendes Dateifeld', p => {
    delete p.files[0].sha256;
  }],
  ['Manipulierter Hash', p => {
    p.files[0].sha256 = 'f'.repeat(64);
  }],
  ['Manipulierter Dateiinhalt', p => {
    p.files[0].base64 = 'YWJj';
  }],
  ['Nichtkanonisches Base64', p => {
    p.files[0].base64 += '\n';
  }],
  ['Leerer Dateiinhalt', p => {
    replaceBytes(p.files[0], Buffer.alloc(0));
  }],
  ['NUL-Byte', p => {
    replaceBytes(p.files[0], Buffer.from([65, 0, 66]));
  }],
  ['Ungueltiges UTF-8', p => {
    replaceBytes(p.files[0], Buffer.from([0xc3, 0x28]));
  }],
  ['Datei ueber 20 KB', p => {
    replaceBytes(p.files[0], Buffer.from('x'.repeat(20_001)));
  }],
];

for (const [name, change] of badPackets) {
  withFixture(`Paket ablehnen: ${name}`, f => {
    const obj = packageData(f);
    change(obj);

    assert.throws(
      () => applyCodePackage(
        f.target,
        f.sha,
        JSON.stringify(obj)
      ),
      /abgelehnt/
    );

    // Fehlerhafte Paketmetadaten duerfen keine
    // Aenderungen im Ziel hinterlassen.
    assertClean(f);
  });
}

withFixture('Ungueltiges JSON wird ohne Dateiaenderung abgelehnt', f => {
  assert.throws(
    () => applyCodePackage(f.target, f.sha, '{'),
    /Code-Paket abgelehnt/
  );

  assertClean(f);
});

withFixture('Paket ueber 60 KB wird abgelehnt', f => {
  assert.throws(
    () => applyCodePackage(f.target, f.sha, 'x'.repeat(60_001)),
    /Code-Paket abgelehnt/
  );

  assertClean(f);
});

// Sicherheit der Ziel-Arbeitskopie

withFixture('Bereits veraendertes Ziel wird abgelehnt', f => {
  appendFileSync(join(f.target, 'src/rechne.js'),
    '// unerlaubt\n');

  assert.throws(
    () => applyCodePackage(
      f.target,
      f.sha,
      createCodePackage(f.source, f.sha)
    ),
    /Code-Paket abgelehnt/
  );
});

withFixture('Ignorierte Zusatzdatei im Ziel wird abgelehnt', f => {
  mkdirSync(join(f.target, 'node_modules'));

  writeFileSync(
    join(f.target, 'node_modules', 'inject.js'),
    'x'
  );

  assert.throws(
    () => applyCodePackage(
      f.target,
      f.sha,
      createCodePackage(f.source, f.sha)
    ),
    /Code-Paket abgelehnt/
  );
});

withFixture('Falscher Ziel-HEAD wird abgelehnt', f => {
  const wrong = 'c'.repeat(40);

  assert.throws(
    () => applyCodePackage(
      f.target,
      wrong,
      createCodePackage(f.source, f.sha)
    ),
    /Code-Paket abgelehnt/
  );

  assertClean(f);
});

// Sicherheit beim Erstellen

withFixture('Paket-Erstellung verweigert weitere unversionierte Dateien',
  f => {
    writeFileSync(join(f.source, 'evil.txt'), 'unerlaubt');

    assert.throws(
      () => createCodePackage(f.source, f.sha),
      /abgelehnt/
    );
  }
);

withFixture('Paket-Erstellung verweigert nur eine geaenderte Datei',
  f => {
    writeFileSync(
      join(f.source, 'test/rechne.test.js'),
      "const assert = require('node:assert');\n"
    );

    assert.throws(
      () => createCodePackage(f.source, f.sha),
      /abgelehnt/
    );
  }
);

withFixture('Paket-Erstellung verweigert falschen SHA', f => {
  assert.throws(
    () => createCodePackage(f.source, 'b'.repeat(40)),
    /abgelehnt/
  );
});

// Nachpruefung muss auch nach dem Schreiben ablehnen.

withFixture('Nachpruefung verweigert leere Aenderung einer Datei',
  f => {
    const p = packageData(f);

    replaceBytes(
      p.files[1],
      readFileSync(join(f.target, 'test/rechne.test.js'))
    );

    assert.throws(
      () => applyCodePackage(
        f.target,
        f.sha,
        JSON.stringify(p)
      ),
      /abgelehnt/
    );

    // Nach dieser Ablehnung ist das Ziel nicht
    // transaktional zurueckgesetzt.
    // Der Workflow muss deshalb sofort abbrechen.
  }
);

// Kommandozeilenmodus wie spaeter in GitHub Actions

withFixture('CLI erstellt und uebernimmt ein Code-Paket', f => {
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: REPO,
    RUNNER_TEMP: f.artifactDir,
  };

  const create = spawnSync(
    process.execPath,
    [SCRIPT, 'create', f.sha],
    {
      cwd: f.source,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    }
  );

  assert.equal(create.status, 0, create.stderr);

  assert.ok(
    readFileSync(
      join(f.artifactDir, 'code-pilot-package.json')
    ).length > 0
  );

  const apply = spawnSync(
    process.execPath,
    [SCRIPT, 'apply', f.sha],
    {
      cwd: f.target,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    }
  );

  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Paket uebernommen/);
});

withFixture('CLI verweigert eine bereits vorhandene Paketdatei', f => {
  writeFileSync(
    join(f.artifactDir, 'code-pilot-package.json'),
    'bestehend'
  );

  const run = spawnSync(
    process.execPath,
    [SCRIPT, 'create', f.sha],
    {
      cwd: f.source,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: REPO,
        RUNNER_TEMP: f.artifactDir,
      },
      encoding: 'utf8',
      timeout: 10_000,
    }
  );

  assert.notEqual(run.status, 0);

  assert.equal(
    readFileSync(
      join(f.artifactDir, 'code-pilot-package.json'),
      'utf8'
    ),
    'bestehend'
  );
});

withFixture('CLI verweigert ein anderes Repository', f => {
  const run = spawnSync(
    process.execPath,
    [SCRIPT, 'create', f.sha],
    {
      cwd: f.source,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'anderes/repo',
        RUNNER_TEMP: f.artifactDir,
      },
      encoding: 'utf8',
      timeout: 10_000,
    }
  );

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Code-Paket abgelehnt/);
});
