
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'noah04091/agenten-probe';

const ALLOWED = [
  'src/rechne.js',
  'test/rechne.test.js',
];

const MAX_FILE_BYTES = 20_000;
const MAX_CHANGED_LINES = 200;
const MAX_PATCH_BYTES = 24_000;

function refuse(message) {
  throw new Error(`Code-Pruefung abgelehnt: ${message}`);
}

function git(root, ...args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    refuse(`Git-Befehl fehlgeschlagen: ${args[0]}`);
  }
}

export function checkCodeChanges(root, expectedSha) {
  root = resolve(root);

  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '')) {
    refuse('Ungueltiger Ausgangscommit');
  }

  const gitRoot = git(root, 'rev-parse', '--show-toplevel').trim();

  if (realpathSync(root) !== realpathSync(gitRoot)) {
    refuse('Nicht das Repository-Hauptverzeichnis');
  }

  if (git(root, 'rev-parse', 'HEAD').trim() !== expectedSha) {
    refuse('Lokaler Ausgangscommit wurde veraendert');
  }

  const entries = git(
    root,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all'
  ).split('\0').filter(Boolean);

  // Fuer den ersten Pilot muessen genau beide Dateien
  // bearbeitet worden sein. Keine anderen Aenderungen.
  if (entries.length !== ALLOWED.length) {
    refuse('Unerwartete Anzahl geaenderter Dateien');
  }

  const paths = entries.map(entry => {
    // Nur ungestagte Modifikationen bestehender Dateien.
    // Keine neuen, geloeschten, umbenannten oder
    // gestagten Dateien.
    if (!entry.startsWith(' M ')) {
      refuse('Unerlaubte Art von Git-Aenderung');
    }
    return entry.slice(3);
  }).sort();

  if (JSON.stringify(paths) !==
      JSON.stringify([...ALLOWED].sort())) {
    refuse('Datei ausserhalb der Freigabeliste');
  }

  for (const path of ALLOWED) {
    const item = lstatSync(join(root, path));

    if (!item.isFile() || item.isSymbolicLink() ||
        item.size === 0 || item.size > MAX_FILE_BYTES) {
      refuse(`Unzulaessiger Dateityp oder Groesse: ${path}`);
    }

    const content = readFileSync(join(root, path));

    if (content.includes(0)) {
      refuse(`Binaerdatei unzulaessig: ${path}`);
    }

    try {
      new TextDecoder('utf-8', {
        fatal: true,
      }).decode(content);
    } catch {
      refuse(`Ungueltiges UTF-8: ${path}`);
    }

    const indexEntry = git(
      root, 'ls-files', '--stage', '--', path
    ).trim();

    if (!/^100644 [a-f0-9]{40} 0\t/.test(indexEntry) ||
        !indexEntry.endsWith(`\t${path}`)) {
      refuse(`Git-Dateimodus unzulaessig: ${path}`);
    }
  }

  if (git(root, 'diff', '--summary').trim() !== '') {
    refuse('Dateimodus oder Dateityp wurde veraendert');
  }

  git(root, 'diff', '--check');

  const numstats = git(
    root, 'diff', '--numstat', '--', ...ALLOWED
  ).trim().split('\n');

  if (numstats.length !== ALLOWED.length) {
    refuse('Aenderungsumfang nicht vollstaendig');
  }

  let changedLines = 0;

  for (const line of numstats) {
    const match = line.match(/^(\d+)\t(\d+)\t(.+)$/);

    if (!match || !ALLOWED.includes(match[3])) {
      refuse('Binaerer oder unerwarteter Git-Diff');
    }

    changedLines += Number(match[1]) + Number(match[2]);
  }

  if (changedLines === 0 ||
      changedLines > MAX_CHANGED_LINES) {
    refuse('Aenderungsumfang ausserhalb der Freigabe');
  }

  const patch = git(
    root, 'diff', '--binary', '--', ...ALLOWED
  );

  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    refuse('Patch ist zu gross');
  }

  return {
    files: ALLOWED,
    changedLines,
  };
}

// Direkter Aufruf im GitHub-Actions-Workflow.
if (process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.GITHUB_REPOSITORY !== REPO ||
        process.env.GITHUB_REF !== 'refs/heads/main') {
      refuse('Falsches Repository oder kein main-Workflow');
    }

    const result = checkCodeChanges(
      process.cwd(),
      process.env.GITHUB_SHA
    );

    console.log(
      `Code-Pruefung bestanden: ${result.files.join(', ')} ` +
      `(${result.changedLines} geaenderte Zeilen)`
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}
