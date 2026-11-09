
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkCodeChanges,
} from './agent-code-change-check.mjs';

const REPO = 'noah04091/agenten-probe';

const FILES = [
  'src/rechne.js',
  'test/rechne.test.js',
];

const MAX_BYTES = 20_000;
const MAX_PACKAGE = 60_000;
const SCHEMA = 'agent-code-pilot-v1';

function refuse(message) {
  throw new Error(`Code-Paket abgelehnt: ${message}`);
}

function git(root, ...args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    refuse('Git-Pruefung fehlgeschlagen');
  }
}

function verifyCheckout(root, sha, mustBeClean) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) {
    refuse('Ungueltiger SHA');
  }

  const gitRoot = git(
    root,
    'rev-parse',
    '--show-toplevel'
  );

  if (realpathSync(root) !== realpathSync(gitRoot)) {
    refuse('Falsches Repository-Verzeichnis');
  }

  if (git(root, 'rev-parse', 'HEAD') !== sha) {
    refuse('Ausgangscommit stimmt nicht');
  }

  if (
    mustBeClean &&
    git(
      root,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching'
    ) !== ''
  ) {
    refuse('Ziel-Arbeitskopie ist nicht sauber');
  }
}

function sha256(bytes) {
  return createHash('sha256')
    .update(bytes)
    .digest('hex');
}

function exactKeys(object, expected) {
  return (
    object &&
    typeof object === 'object' &&
    !Array.isArray(object) &&
    JSON.stringify(Object.keys(object).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

export function createCodePackage(root, sha) {
  root = resolve(root);

  verifyCheckout(root, sha, false);

  // Nur genau zwei erlaubte lokale Aenderungen.
  checkCodeChanges(root, sha);

  const files = FILES.map(path => {
    const bytes = readFileSync(join(root, path));

    return {
      path,
      sha256: sha256(bytes),
      base64: bytes.toString('base64'),
    };
  });

  const json = JSON.stringify({
    schema: SCHEMA,
    repository: REPO,
    issue: 38,
    baseSha: sha,
    files,
  }) + '\n';

  if (Buffer.byteLength(json) > MAX_PACKAGE) {
    refuse('Paket zu gross');
  }

  return json;
}

export function applyCodePackage(root, sha, json) {
  root = resolve(root);

  // Empfang nur in einer frischen Arbeitskopie.
  verifyCheckout(root, sha, true);

  if (
    typeof json !== 'string' ||
    Buffer.byteLength(json) > MAX_PACKAGE
  ) {
    refuse('Paketformat oder Groesse unzulaessig');
  }

  let data;

  try {
    data = JSON.parse(json);
  } catch {
    refuse('Ungueltiges JSON');
  }

  if (
    !exactKeys(data, [
      'schema',
      'repository',
      'issue',
      'baseSha',
      'files',
    ]) ||
    data.schema !== SCHEMA ||
    data.repository !== REPO ||
    data.issue !== 38 ||
    data.baseSha !== sha ||
    !Array.isArray(data.files) ||
    data.files.length !== FILES.length
  ) {
    refuse('Paket-Metadaten ungueltig');
  }

  // Zuerst alle Inhalte pruefen.
  // Noch keine einzige Datei schreiben.
  const decoded = data.files.map((entry, index) => {
    if (
      !exactKeys(entry, [
        'path',
        'sha256',
        'base64',
      ]) ||
      entry.path !== FILES[index] ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') ||
      typeof entry.base64 !== 'string'
    ) {
      refuse('Unzulaessiger Dateieintrag');
    }

    const bytes = Buffer.from(
      entry.base64,
      'base64'
    );

    if (
      bytes.toString('base64') !== entry.base64 ||
      bytes.length === 0 ||
      bytes.length > MAX_BYTES ||
      bytes.includes(0) ||
      sha256(bytes) !== entry.sha256
    ) {
      refuse('Dateiinhalt oder Hash ungueltig');
    }

    try {
      new TextDecoder('utf-8', {
        fatal: true,
      }).decode(bytes);
    } catch {
      refuse('Ungueltiges UTF-8');
    }

    const target = join(root, entry.path);
    const stat = lstatSync(target);

    if (
      !stat.isFile() ||
      stat.isSymbolicLink()
    ) {
      refuse('Unzulaessiger Zieldateityp');
    }

    return { target, bytes };
  });

  // Erst nach vollstaendiger Vorpruefung schreiben.
  for (const { target, bytes } of decoded) {
    writeFileSync(target, bytes);
  }

  // Unabhaengige Git-Dateipruefung erneut ausfuehren.
  return checkCodeChanges(root, sha);
}

// Direkter Aufruf in GitHub Actions.
// Das JSON-Artefakt liegt ausserhalb des Git-Repositories.
if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  try {
    const [mode, sha] = process.argv.slice(2);

    const temp = process.env.RUNNER_TEMP;

    if (
      process.env.GITHUB_REPOSITORY !== REPO ||
      !temp ||
      !isAbsolute(temp)
    ) {
      refuse('GitHub-Actions-Umgebung fehlt');
    }

    const artifact = join(
      temp,
      'code-pilot-package.json'
    );

    if (mode === 'create') {
      writeFileSync(
        artifact,
        createCodePackage(process.cwd(), sha),
        {
          flag: 'wx',
          mode: 0o600,
        }
      );

      console.log(
        'Geprueftes Code-Paket erstellt.'
      );
    } else if (mode === 'apply') {
      if (statSync(artifact).size > MAX_PACKAGE) {
        refuse('Artefakt zu gross');
      }

      const result = applyCodePackage(
        process.cwd(),
        sha,
        readFileSync(artifact, 'utf8')
      );

      console.log(
        `Paket uebernommen: ${result.changedLines} geaenderte Zeilen.`
      );
    } else {
      refuse('Ungueltiger Modus');
    }
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : String(error)
    );

    process.exitCode = 1;
  }
}
