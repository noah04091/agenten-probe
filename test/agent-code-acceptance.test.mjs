
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const acceptance = fileURLToPath(
  new URL('../scripts/agent-code-acceptance.mjs', import.meta.url)
);

function runFixture(multiplyBody, addBody = 'return a + b;') {
  const root = mkdtempSync(
    join(tmpdir(), 'code-pilot-acceptance-')
  );

  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'scripts'));

    copyFileSync(
      acceptance,
      join(root, 'scripts', 'agent-code-acceptance.mjs')
    );

    writeFileSync(join(root, 'src', 'rechne.js'), [
      `function addiere(a, b) { ${addBody} }`,
      'function subtrahiere(a, b) { return a - b; }',
      `function multipliziere(a, b) { ${multiplyBody} }`,
      'module.exports = { addiere, subtrahiere, multipliziere };',
    ].join('\n'));

    return spawnSync(
      process.execPath,
      [join(root, 'scripts', 'agent-code-acceptance.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Korrekte Multiplikation besteht die Abnahme', () => {
  const result = runFixture('return a * b;');

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /110 unabhaengige Rechenfaelle bestanden/
  );
});

test('Falsche Multiplikation wird abgelehnt', () => {
  const result = runFixture('return a + b;');

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /multipliziere\(2, 3\)/
  );
});

test('Beschaedigte Addition wird ebenfalls erkannt', () => {
  const result = runFixture(
    'return a * b;',
    'return a - b;'
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /addiere\(2, 3\)/
  );
});
