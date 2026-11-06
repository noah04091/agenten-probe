
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCodeChanges } from '../scripts/agent-code-change-check.mjs';

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Jeder Test verwendet ein eigenes temporaeres Repository.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'code-agent-check-'));
  const source = join(root, 'src/rechne.js');
  const tests = join(root, 'test/rechne.test.js');

  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));

  writeFileSync(source,
    'function addiere(a, b) { return a + b; }\n');
  writeFileSync(tests,
    "const assert = require('node:assert');\n");
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root,
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'Initial');

  const sha = git(root, 'rev-parse', 'HEAD');

  appendFileSync(source, '// neue Rechenfunktion\n');
  appendFileSync(tests, '// neuer Test\n');

  return { root, sha, source, tests };
}

function checkCase(name, change, expectedSuccess = false) {
  test(name, () => {
    const f = fixture();

    try {
      change(f);

      if (expectedSuccess) {
        const result = checkCodeChanges(f.root, f.sha);

        assert.deepEqual(
          [...result.files].sort(),
          ['src/rechne.js', 'test/rechne.test.js'].sort()
        );

        assert.ok(result.changedLines > 0);
      } else {
        assert.throws(
          () => checkCodeChanges(f.root, f.sha),
          /Code-Pruefung abgelehnt/
        );
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

// Erfolgreicher Kontrollfall.
checkCase('Genau zwei erlaubte Codeaenderungen werden akzeptiert',
  () => {}, true);

// Unerlaubte Dateiaenderungen.
checkCase('Nur eine geaenderte Datei wird abgelehnt', f => {
  writeFileSync(f.tests,
    "const assert = require('node:assert');\n");
});

checkCase('Zusaetzliche unversionierte Datei wird abgelehnt', f => {
  writeFileSync(join(f.root, 'extra.txt'), 'nicht erlaubt\n');
});

checkCase('Ignorierte Datei unter node_modules wird abgelehnt', f => {
  mkdirSync(join(f.root, 'node_modules'));
  writeFileSync(
    join(f.root, 'node_modules', 'bypass.js'),
    'nicht erlaubt\n'
  );
});

checkCase('Gestagte Aenderung wird abgelehnt', f => {
  git(f.root, 'add', 'src/rechne.js');
});

checkCase('Geloeschte Datei wird abgelehnt', f => {
  rmSync(f.tests);
});

checkCase('Umbenannte Datei wird abgelehnt', f => {
  renameSync(f.tests, join(f.root, 'test/anders.js'));
});

checkCase('Geaenderter Commit wird abgelehnt', f => {
  git(f.root,
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-qm', 'Nachtraeglich'
  );
});

checkCase('Unerlaubter Workflow wird abgelehnt', f => {
  mkdirSync(join(f.root, '.github/workflows'), {
    recursive: true,
  });

  writeFileSync(
    join(f.root, '.github/workflows/unsafe.yml'),
    'name: unsafe\n'
  );
});

// Inhalt und Groesse.
checkCase('NUL-Byte in JavaScript wird abgelehnt', f => {
  writeFileSync(f.source, Buffer.from([65, 0, 66]));
});

checkCase('Ungueltiges UTF-8 wird abgelehnt', f => {
  writeFileSync(f.source, Buffer.from([0xc3, 0x28]));
});

checkCase('Uebergrosse Datei wird abgelehnt', f => {
  writeFileSync(f.source, 'x'.repeat(20_001));
});

checkCase('Mehr als 200 geaenderte Zeilen werden abgelehnt', f => {
  appendFileSync(
    f.source,
    Array(201).fill('// Zeile').join('\n') + '\n'
  );
});

checkCase('Whitespacefehler in Diff wird abgelehnt', f => {
  appendFileSync(f.source, 'const x = 1;    \n');
});

// Betriebssystemabhaengige Dateikontrollen.
if (process.platform !== 'win32') {
  checkCase('Symbolischer Link wird abgelehnt', f => {
    rmSync(f.tests);
    symlinkSync(f.source, f.tests);
  });

  checkCase('Dateimodus-Aenderung wird abgelehnt', f => {
    chmodSync(f.source, 0o755);
  });
}

test('Falscher SHA-Wert wird abgelehnt', () => {
  const f = fixture();

  try {
    assert.throws(
      () => checkCodeChanges(f.root, 'b'.repeat(40)),
      /Code-Pruefung abgelehnt/
    );

    assert.throws(
      () => checkCodeChanges(f.root, 'ungueltig'),
      /Code-Pruefung abgelehnt/
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Aufruf ausserhalb des Repository-Hauptverzeichnisses wird abgelehnt',
  () => {
    const f = fixture();

    try {
      assert.throws(
        () => checkCodeChanges(join(f.root, 'src'), f.sha),
        /Code-Pruefung abgelehnt/
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
);
