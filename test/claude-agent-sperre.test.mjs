import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Waechter A6.4-S: Der alte Claude-Agent (.github/workflows/claude-agent.yml, Job agentenlauf)
// bleibt bis zu einer gesonderten Entscheidung dauerhaft gesperrt. Die Sperre ist ein boolesches
// `false &&` am Anfang der Job-Bedingung: GitHub ueberspringt den Job, bevor das Environment
// claude-bot angefordert wird. Alle bisherigen Bedingungen bleiben unveraendert erhalten.
//
// Zwei Schichten:
// 1. Strukturpruefung: Jobliste, genau ein Job agentenlauf, genau eine Bedingung auf Job-Ebene,
//    die Zeile fuer Zeile der genehmigten Fassung entspricht und mit `false &&` beginnt.
// 2. Fingerabdruck: SHA-256 der LF-normalisierten Datei. Jede nicht ausdruecklich genehmigte
//    Aenderung an der Workflow-Datei macht diesen Test rot. Wer die Datei aendern darf, zieht den
//    Wert nur nach ausdruecklicher Freigabe durch Noah nach.

const WORKFLOW = fileURLToPath(new URL('../.github/workflows/claude-agent.yml', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

// Genehmigte Fassung nach A6.4-S (main a8d2052 plus genau die Zeile `      false &&`).
const GENEHMIGT_SHA256 = 'f70161345ee123a570adc27e229b5b3370401917b718015080690fc98247f461';
// Fassung auf main a8d2052c86d965153c264c9a326fc5a1fa5719fd vor der Sperre.
const VORHER_SHA256 = 'e76451e411f5691103d41e970aa7d33f3b786c1ec7cd584c2c2935f95e8df2a4';

const SPERRZEILE = '      false &&\n';
const JOB = 'agentenlauf';
const ERWARTETE_JOBS = ['konfigurationstest', 'agentenlauf'];
const ERWARTETE_BEDINGUNG = [
  'false &&',
  "github.event_name == 'issues' &&",
  "github.repository == 'noah04091/agenten-probe' &&",
  "github.ref == 'refs/heads/main' &&",
  "github.actor == 'noah04091' &&",
  "github.event.label.name == 'bot-auftrag' &&",
  "github.event.issue.state == 'open' &&",
  "contains(github.event.issue.labels.*.name, 'agent:test-note')",
];
const ERWARTETE_JOB_SCHLUESSEL = ['name', 'if', 'runs-on', 'timeout-minutes', 'environment', 'permissions', 'steps'];

const sha256 = data => createHash('sha256').update(data).digest('hex');

// Entfernt nur CR direkt vor LF, alle anderen Bytes bleiben unveraendert.
function lfBytes(bytes) {
  const out = [];

  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      continue;
    }

    out.push(bytes[i]);
  }

  return Buffer.from(out);
}

function echteBytes() {
  return lfBytes(readFileSync(WORKFLOW));
}

function fail(message) {
  throw new Error(`claude-agent-sperre: ${message}`);
}

const einrueckung = line => line.length - line.trimStart().length;
const leerOderKommentar = line => line.trim() === '' || line.trimStart().startsWith('#');

// Liefert die Jobs unter dem einzigen Top-Level-Schluessel `jobs:` mit ihren Zeilen.
// Bewusst streng: jede Zeile mit Einrueckung 2 muss ein Job-Schluessel ohne Inline-Wert sein.
function jobs(text) {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, i) => (/^jobs:\s*$/.test(line) ? [i] : []));

  if (starts.length !== 1 || lines.some(line => /^jobs\s*:/.test(line) && !/^jobs:\s*$/.test(line))) {
    fail('genau ein Top-Level-Schluessel jobs: erwartet');
  }

  const result = [];
  let current = null;

  for (let i = starts[0] + 1; i < lines.length; i += 1) {
    const line = lines[i];

    if (leerOderKommentar(line)) {
      current?.lines.push(line);
      continue;
    }

    const indent = einrueckung(line);

    if (indent === 0) {
      fail(`unerwarteter Top-Level-Schluessel nach jobs: ${line}`);
    }

    if (indent === 2) {
      const match = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):$/.exec(line);

      if (!match) {
        fail(`unerwartete Zeile auf Job-Ebene: ${line}`);
      }

      current = { name: match[1], lines: [] };
      result.push(current);
      continue;
    }

    if (current === null || indent < 4 || line.includes('\t')) {
      fail(`unerwartete Einrueckung: ${line}`);
    }

    current.lines.push(line);
  }

  return result;
}

// Direkte Schluessel eines Jobs (Einrueckung 4) mit ihren Folgezeilen.
function jobSchluessel(jobLines) {
  const result = [];

  for (const line of jobLines) {
    if (leerOderKommentar(line)) {
      continue;
    }

    if (einrueckung(line) === 4) {
      const match = /^ {4}([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);

      if (!match) {
        fail(`unerwartete Zeile im Job: ${line}`);
      }

      result.push({ key: match[1], value: match[2], lines: [] });
      continue;
    }

    result.at(-1).lines.push(line);
  }

  return result;
}

// Prueft die Sperre strukturell und liefert den von GitHub gefalteten Ausdruck (`>-`).
function pruefeSperre(text) {
  const liste = jobs(text);
  const namen = liste.map(job => job.name);

  if (namen.filter(name => name === JOB).length !== 1) {
    fail(`Job ${JOB} nicht genau einmal vorhanden: ${namen.join(', ')}`);
  }

  if (JSON.stringify(namen) !== JSON.stringify(ERWARTETE_JOBS)) {
    fail(`Jobliste weicht ab: ${namen.join(', ')}`);
  }

  const job = liste.find(entry => entry.name === JOB);
  const schluessel = jobSchluessel(job.lines);
  const bedingungen = schluessel.filter(entry => entry.key === 'if');

  if (bedingungen.length !== 1) {
    fail(`Job ${JOB} braucht genau eine Bedingung auf Job-Ebene, gefunden ${bedingungen.length}`);
  }

  if (JSON.stringify(schluessel.map(entry => entry.key)) !== JSON.stringify(ERWARTETE_JOB_SCHLUESSEL)) {
    fail(`Schluessel des Jobs ${JOB} weichen ab: ${schluessel.map(entry => entry.key).join(', ')}`);
  }

  const bedingung = bedingungen[0];

  if (bedingung.value !== ' >-') {
    fail(`Job-Bedingung muss ein gefalteter Block (>-) sein, gefunden: if:${bedingung.value}`);
  }

  const zeilen = bedingung.lines.map(line => {
    if (!line.startsWith('      ') || line.startsWith('       ')) {
      fail(`Zeile der Job-Bedingung nicht mit genau 6 Leerzeichen eingerueckt: ${line}`);
    }

    return line.slice(6);
  });

  if (zeilen[0] !== 'false &&') {
    fail(`Job-Bedingung beginnt nicht mit dem booleschen Ausdruck false &&: ${zeilen[0] ?? '(leer)'}`);
  }

  if (JSON.stringify(zeilen) !== JSON.stringify(ERWARTETE_BEDINGUNG)) {
    fail(`Job-Bedingung weicht von der genehmigten Fassung ab: ${JSON.stringify(zeilen)}`);
  }

  // Keine alternative Ausfuehrungsbedingung: keine weitere if-Zeile im Job, auch nicht in Schritten.
  const weitere = job.lines.filter(line => /^\s+(-\s+)?if\s*:/.test(line) && line !== '    if: >-');

  if (weitere.length > 0) {
    fail(`weitere Bedingung im Job ${JOB}: ${weitere.join(' | ')}`);
  }

  const ausdruck = zeilen.join(' ');

  if (!ausdruck.startsWith('false && ') || ausdruck.includes('||') || ausdruck.includes('${{')) {
    fail(`gefalteter Ausdruck ist nicht sicher gesperrt: ${ausdruck}`);
  }

  return ausdruck;
}

function change(text, from, to) {
  assert.equal(text.split(from).length, 2, `Stelle nicht genau einmal: ${from}`);
  return text.replace(from, () => to);
}

test('Sperre: die Workflow-Datei existiert als normale Datei', () => {
  assert.ok(existsSync(WORKFLOW), `${WORKFLOW} fehlt`);
  const stat = lstatSync(WORKFLOW);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Workflow ist keine normale Datei');
});

test('Sperre: der Fingerabdruck entspricht genau der genehmigten Fassung', () => {
  assert.equal(
    sha256(echteBytes()),
    GENEHMIGT_SHA256,
    'claude-agent.yml weicht von der genehmigten Fassung ab. Aenderungen nur nach ausdruecklicher Freigabe durch Noah.',
  );
});

test('Sperre: genehmigte Fassung ist die Fassung von main a8d2052 plus genau eine Zeile', () => {
  const text = echteBytes().toString('utf8');
  const vorher = change(text, `    if: >-\n${SPERRZEILE}`, '    if: >-\n');
  assert.equal(sha256(Buffer.from(vorher, 'utf8')), VORHER_SHA256);
  assert.equal(text.split('\n').length, vorher.split('\n').length + 1);
});

test('Sperre: Job agentenlauf genau einmal, Bedingung auf Job-Ebene beginnt mit false &&, alte Bedingungen erhalten', () => {
  const text = echteBytes().toString('utf8');
  const ausdruck = pruefeSperre(text);

  assert.equal(ausdruck, ERWARTETE_BEDINGUNG.join(' '));
  assert.ok(ausdruck.startsWith('false && '));
  // Die Bedingung steht vor `runs-on`, `environment` und `steps` direkt unter dem Job.
  assert.ok(text.includes(`  ${JOB}:\n    name: Claude starten nach Freigabe\n    if: >-\n${SPERRZEILE}      github.event_name == 'issues' &&\n`));
  // Der Konfigurationstest bleibt an Push-Ereignisse gebunden und ruft Claude nicht auf.
  assert.ok(text.includes("  konfigurationstest:\n    name: Konfiguration pruefen\n    if: github.event_name == 'push'\n"));
});

test('Sperre: Manipulationen werden erkannt', () => {
  const text = echteBytes().toString('utf8');
  const kopieJob = text.slice(text.indexOf(`  ${JOB}:\n`));

  const strukturell = [
    ['false && entfernt', change(text, SPERRZEILE, ''), /beginnt nicht mit dem booleschen Ausdruck false &&/],
    ['false && zu true &&', change(text, SPERRZEILE, '      true &&\n'), /beginnt nicht mit dem booleschen Ausdruck false &&/],
    ['false && zu false ||', change(text, SPERRZEILE, '      false ||\n'), /beginnt nicht mit dem booleschen Ausdruck false &&/],
    ['Sperre nur als Kommentar', change(text, `    if: >-\n${SPERRZEILE}`, '    # Sperre: false &&\n    if: >-\n'), /beginnt nicht mit dem booleschen Ausdruck false &&/],
    ['Sperre als Kommentar im Block', change(text, SPERRZEILE, '      # false &&\n'), /beginnt nicht mit dem booleschen Ausdruck false &&/],
    ['Sperre auf einen Schritt verschoben', change(change(text, SPERRZEILE, ''),
      '      - name: Repository ohne gespeicherte Zugangsdaten laden\n',
      '      - name: Repository ohne gespeicherte Zugangsdaten laden\n        if: false\n'), /beginnt nicht mit dem booleschen Ausdruck false &&/],
    ['zusaetzliche Bedingung in einem Schritt', change(text,
      '      - name: Repository ohne gespeicherte Zugangsdaten laden\n',
      '      - name: Repository ohne gespeicherte Zugangsdaten laden\n        if: always()\n'), /weitere Bedingung im Job/],
    ['zweite ausfuehrbare Variante des Jobs', `${text}\n${change(kopieJob, SPERRZEILE, '').replace(`  ${JOB}:\n`, `  ${JOB}_neu:\n`)}`, /Jobliste weicht ab/],
    ['Job agentenlauf doppelt', `${text}\n${change(kopieJob, SPERRZEILE, '')}`, /nicht genau einmal vorhanden/],
    ['zweite Bedingung auf Job-Ebene', change(text, '    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n', '    runs-on: ubuntu-24.04\n    if: true\n    timeout-minutes: 20\n'), /genau eine Bedingung auf Job-Ebene/],
    ['Alternative mit || angehaengt', change(text, "contains(github.event.issue.labels.*.name, 'agent:test-note')\n", "contains(github.event.issue.labels.*.name, 'agent:test-note') ||\n      true\n"), /weicht von der genehmigten Fassung ab/],
    ['Literal-Block statt gefaltet', change(text, `    if: >-\n${SPERRZEILE}`, `    if: |\n${SPERRZEILE}`), /gefalteter Block/],
    ['alte Bedingung entfernt', change(text, "      github.actor == 'noah04091' &&\n", ''), /weicht von der genehmigten Fassung ab/],
    ['Bedingung einzeilig ohne Sperre', change(text, `    if: >-\n${SPERRZEILE}`, "    if: github.event_name == 'issues'\n    # >-\n"), /gefalteter Block|unerwartete Zeile/],
  ];

  for (const [name, mutated, expected] of strukturell) {
    assert.notEqual(mutated, text, name);
    assert.throws(() => pruefeSperre(mutated), expected, name);
    assert.notEqual(sha256(Buffer.from(mutated, 'utf8')), GENEHMIGT_SHA256, name);
  }

  // Eine Aenderung an anderer Stelle laesst die Struktur gelten, nur der Fingerabdruck wacht.
  const nurFingerabdruck = [
    ['anderer Teil der Datei', change(text, 'echo "Konfigurationstest ohne Claude-Aufruf bestanden."', 'echo "geaendert"')],
    ['Trigger erweitert', change(text, '    types: [labeled]\n', '    types: [labeled, opened]\n')],
    ['Kommentar ergaenzt', `${text}# Nachtrag\n`],
    ['CR mitten in einer Zeile', change(text, 'name: Claude-Agent Kontrolllauf\n', 'name: Claude-Agent Kontrolllauf\r \n')],
  ];

  for (const [name, mutated] of nurFingerabdruck) {
    assert.doesNotThrow(() => pruefeSperre(mutated), name);
    assert.notEqual(sha256(lfBytes(Buffer.from(mutated, 'utf8'))), GENEHMIGT_SHA256, name);
  }

  // Reine CRLF-Zeilenenden (Windows-Checkout) aendern den normalisierten Fingerabdruck nicht.
  assert.equal(sha256(lfBytes(Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8'))), GENEHMIGT_SHA256);
});

test('Sperre: npm test erfasst diese Datei automatisch', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test');
  // Standardmuster von node --test ohne Argumente: **/*.test.{cjs,mjs,js}.
  assert.match(fileURLToPath(import.meta.url).replace(/\\/g, '/'), /\/test\/claude-agent-sperre\.test\.mjs$/);
});
