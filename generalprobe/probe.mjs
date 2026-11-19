// A6 P-1: Harness der Generalprobe. Nur fuer die Probe, nie im Live-Pfad.
//
// Baut aus dem vertrauenswuerdigen Checkout ein synthetisches Repository mit festem Ausgangscommit
// (gleicher Baum wie HEAD, der Rechner aus der festen Vorlage generalprobe/vorlage/, dazu zwei
// synthetische v2-Abnahmen), legt fuer jeden Job einen eigenen
// RUNNER_TEMP mit Ereignisdatei, Ausgabedatei und nachgebautem GitHub an und startet die
// UNVERAENDERTEN Job-Einstiege aus scripts/. Jeder Einstieg bekommt ausschliesslich seinen
// Umgebungsvertrag; nichts wird aus der Umgebung des Harness geerbt.
//
// Ersetzt werden nur zwei Dinge, beide ausdruecklich:
// - die Gegenstelle GitHub (Vorlademodul github-attrappe.mjs, nur fuer Job 0, 1a und 3);
// - Claude: ein festes Testpaket wird in den Arbeitsordner geschrieben (claudeErsatz).
//
// Verwendung im Workflow und in den Tests:
//   node generalprobe/probe.mjs kette <ordner>            ganze Kette positiv, ein Prozessbaum
//   node generalprobe/probe.mjs negativ <ordner> [fall]   alle oder ein Negativfall
//   node generalprobe/probe.mjs vorbereiten <job> <ordner> [...]  Vorbereitung fuer einen Workflow-Schritt
// Jeder Befehl endet nur mit Exitcode 0, wenn jede Erwartung eingetreten ist. Ausgabe: Klartextzeilen
// mit festen Praefixen, nie ein Token.
//
// Was dieser Harness NICHT zeigt: echte GitHub-Antworten, echte Rechte, echte Artefakte, echte
// Environment-Freigaben, Claude selbst. Die Container-, Netz- und Artefaktnachweise liefert der
// Workflow selbst.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { schreibeTestpaket } from './claude-ersatz.mjs';

export const REPO_NAME = 'noah04091/agenten-probe';
export const WORKFLOW_PATH = '.github/workflows/agent-auftrag.yml';
export const WORKFLOW_REF = `${REPO_NAME}/${WORKFLOW_PATH}@refs/heads/main`;
export const ISSUE = 9001;
export const ISSUE_NF2 = 9002;
export const RUN_ID = '4242000001';
export const FREMDER_LAUF = '4242000002';
// Erfundene Werte ohne Wirkung. Sie oeffnen nichts und werden nie an GitHub gesendet.
export const LESE_TOKEN = 'ghs_GeneralprobeOhneWirkung_lese_0123456789ab';
export const APP_TOKEN = 'ghs_GeneralprobeOhneWirkung_app_0123456789abc';
export const VERGLEICH_ANTHROPIC = 'probe-vergleichswert-anthropic-0000000000';
export const VERGLEICH_LESE = 'probe-vergleichswert-lesetoken-000000000000';
export const ATTRAPPE = 'generalprobe/github-attrappe.mjs';
export const OUTPUT_NAME = 'set_output_probe';
export const WRITES_OK = Object.freeze(['POST git/blobs', 'POST git/blobs', 'POST git/trees', 'POST git/commits', 'POST git/refs', 'POST pulls']);
export const FEHLER_RE = /^A6-FEHLER ([a-z][a-z0-9-]{0,62}[a-z0-9])\n$/;

const HIER = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const OWNER = Object.freeze({ login: 'noah04091', id: 1, type: 'User', site_admin: false });
const PFAD_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SYSTEM_KEYS = Object.freeze(['SystemRoot', 'PATHEXT', 'ComSpec', 'windir']);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');

// ---------------------------------------------------------------------------
// Feste Testinhalte
// ---------------------------------------------------------------------------

const FORMAT = '// agent-abnahme-format: v2\n';

// Synthetische v2-Abnahme: Agentencode nur im Kindprozess, Bewertung im Treiber. Fuer ISSUE erwartet
// sie quadrat(x) = x * x, fuer ISSUE_NF2 bewusst x * x * x (fachlich falscher Code, NF2).
function abnahme(issue, ausdruck) {
  return `${FORMAT}${String.raw`// Synthetische v2-Abnahme der A6-Generalprobe (Issue ${issue}). Nie fuer einen Live-Lauf.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ziel = fileURLToPath(new URL('../src/rechne.js', import.meta.url));
const eingaben = [0, 3, -4, 0.5, -1.5, 12];
const sonde = [
  'const m = require(' + JSON.stringify(ziel) + ');',
  'const e = JSON.parse(require("node:fs").readFileSync(0, "utf8"));',
  'process.stdout.write(JSON.stringify({ typ: typeof m.quadrat, werte: e.map(x => m.quadrat(x)), summe: m.addiere(2, 3) }));',
].join('\n');
const out = spawnSync(process.execPath, ['-e', sonde], { input: JSON.stringify(eingaben), env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });

if (out.error !== undefined || out.status !== 0 || out.signal !== null) {
  throw new Error('Sonde fehlgeschlagen');
}

const antwort = JSON.parse(out.stdout);
assert.equal(antwort.typ, 'function');
assert.deepEqual(antwort.werte, eingaben.map(x => ${ausdruck}));
assert.equal(antwort.summe, 5);
process.stdout.write('A6-ABNAHME-BESTANDEN\n');
`}`;
}

export const ABNAHMEN = Object.freeze({
  [`agent-acceptance/issue-${ISSUE}.mjs`]: abnahme(ISSUE, 'x * x'),
  [`agent-acceptance/issue-${ISSUE_NF2}.mjs`]: abnahme(ISSUE_NF2, 'x * x * x'),
});

// Das feste Testpaket statt Claude stammt aus claude-ersatz.mjs, damit der Workflow im Claude-Container
// und dieser Harness genau dieselbe Aenderung schreiben.
export const claudeErsatz = schreibeTestpaket;

// ---------------------------------------------------------------------------
// Git und synthetisches Repository
// ---------------------------------------------------------------------------

function gitUmgebung(home) {
  return {
    ...systemEnv(),
    PATH: String(process.env.PATH),
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Generalprobe',
    GIT_AUTHOR_EMAIL: 'generalprobe@example.invalid',
    GIT_COMMITTER_NAME: 'Generalprobe',
    GIT_COMMITTER_EMAIL: 'generalprobe@example.invalid',
    GIT_AUTHOR_DATE: '2026-11-17T08:00:00Z',
    GIT_COMMITTER_DATE: '2026-11-17T08:00:00Z',
  };
}

function systemEnv() {
  return Object.fromEntries(SYSTEM_KEYS.map(key => [key, process.env[key]]).filter(([, value]) => typeof value === 'string'));
}

function gitIn(cwd, args, { input, binary = false, home = cwd } = {}) {
  const out = execFileSync('git', args, {
    cwd,
    env: gitUmgebung(home),
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return binary ? out : out.toString('utf8').trim();
}

// Der Quell-Checkout wird nur gelesen (ls-tree, cat-file). Gehoert er einem anderen Nutzer (etwa im
// Testcontainer von Trockenlauf Job 2), verweigert Git das Lesen; fuer genau diesen Pfad und nur fuer diese
// zwei reinen Lesebefehle wird er deshalb ausdruecklich zugelassen, ohne fsmonitor.
const NUR_LESEN = quelle => ['-c', `safe.directory=${resolve(quelle)}`, '-c', 'core.fsmonitor=false'];

// Liest alle Blobs von HEAD^{tree} in einem Aufruf.
function blobsVon(quelle, shas) {
  const out = gitIn(quelle, [...NUR_LESEN(quelle), 'cat-file', '--batch'], { input: `${shas.join('\n')}\n`, binary: true });
  const inhalte = new Map();
  let pos = 0;

  for (const sha of shas) {
    const ende = out.indexOf(0x0a, pos);
    const [kopfSha, typ, groesse] = out.subarray(pos, ende).toString('utf8').split(' ');

    if (kopfSha !== sha || typ !== 'blob') {
      throw new Error('Generalprobe: unerwartetes Objekt im Baum');
    }

    const start = ende + 1;
    inhalte.set(sha, out.subarray(start, start + Number(groesse)));
    pos = start + Number(groesse) + 1;
  }

  return inhalte;
}

// Feste Rechner-Vorlage: Ausgangsstand von src/rechne.js und test/rechne.test.js im synthetischen
// Repository. Damit haengt das feste Testpaket nicht vom Rechner auf main ab, den echte Agentenauftraege
// weiterentwickeln. Gelesen aus dem Commit HEAD von quelle, nie aus dem Arbeitsordner, und nur mit
// genau diesem SHA-256 angenommen. Nur fuer die Generalprobe, nie im Live-Pfad.
export const VORLAGE = Object.freeze({
  'src/rechne.js': Object.freeze({ quelle: 'generalprobe/vorlage/rechne.js.vorlage', sha256: '0429f96116843b95fedfbe17babf60b87fbf2df8262688e5e120eaeaf121de3e' }),
  'test/rechne.test.js': Object.freeze({ quelle: 'generalprobe/vorlage/rechne.test.js.vorlage', sha256: '392167a28763bb5ccb31bb2a2503e798b8b866642bf198749095e75d9f76cc10' }),
});

// Synthetisches Repository: Baum von HEAD aus quelle, der Rechner ersetzt durch die VORLAGE,
// ueberschrieben bzw. ergaenzt um ABNAHMEN, als einziger Commit ohne Eltern mit festen Daten.
// Gleicher Ausgangsbaum ergibt immer denselben Commit.
export function baueRepo(quelle, ziel, extra = ABNAHMEN) {
  const zeilen = gitIn(quelle, [...NUR_LESEN(quelle), 'ls-tree', '-r', '-z', '--full-tree', 'HEAD']).split('\0').filter(Boolean);
  const eintraege = new Map();

  for (const zeile of zeilen) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$/s.exec(zeile);

    if (!match || !PFAD_RE.test(match[3])) {
      throw new Error('Generalprobe: unerwarteter Eintrag im Baum');
    }

    eintraege.set(match[3], { modus: match[1], sha: match[2] });
  }

  const inhalte = blobsVon(quelle, [...new Set([...eintraege.values()].map(e => e.sha))]);
  const dateien = new Map([...eintraege].map(([pfad, e]) => [pfad, { modus: e.modus, bytes: inhalte.get(e.sha) }]));

  for (const [pfad, { quelle: vorlage, sha256: erwartet }] of Object.entries(VORLAGE)) {
    const datei = dateien.get(vorlage);

    if (datei === undefined) {
      throw new Error(`Generalprobe: Vorlage ${vorlage} fehlt im Commit`);
    }

    if (datei.modus !== '100644') {
      throw new Error(`Generalprobe: Vorlage ${vorlage} hat nicht den Modus 100644`);
    }

    if (sha256(datei.bytes) !== erwartet) {
      throw new Error(`Generalprobe: Vorlage ${vorlage} weicht vom festen SHA-256 ab`);
    }

    if (!dateien.has(pfad)) {
      throw new Error(`Generalprobe: ${pfad} fehlt im Commit`);
    }

    dateien.set(pfad, { modus: '100644', bytes: datei.bytes });
  }

  for (const [pfad, text] of Object.entries(extra)) {
    dateien.set(pfad, { modus: '100644', bytes: Buffer.from(text, 'utf8') });
  }

  const nachricht = Buffer.from('Generalprobe: synthetischer Ausgangscommit\n');
  const teile = [Buffer.from(
    'commit refs/heads/main\n' +
    'author Generalprobe <generalprobe@example.invalid> 1763366400 +0000\n' +
    'committer Generalprobe <generalprobe@example.invalid> 1763366400 +0000\n' +
    `data ${nachricht.length}\n`), nachricht];

  for (const [pfad, { modus, bytes }] of [...dateien].sort(([a], [b]) => (a < b ? -1 : 1))) {
    teile.push(Buffer.from(`M ${modus} inline ${pfad}\ndata ${bytes.length}\n`), bytes, Buffer.from('\n'));
  }

  teile.push(Buffer.from('done\n'));
  mkdirSync(ziel, { recursive: true });
  gitIn(ziel, ['init', '-q', '-b', 'main']);
  gitIn(ziel, ['fast-import', '--quiet', '--done'], { input: Buffer.concat(teile) });
  gitIn(ziel, ['reset', '-q', '--hard', 'main']);
  return gitIn(ziel, ['rev-parse', 'HEAD']);
}

// Getrennter Pruef-Checkout fuer Job 3, mit denselben Befehlen wie der Live-Workflow.
export function pruefCheckout(checkout, temp, basis) {
  const ziel = join(temp, 'a6-veroeffentlichung-pruefung');
  gitIn(temp, ['clone', '-q', '--no-local', '--no-checkout', checkout, ziel], { home: temp });
  gitIn(ziel, ['checkout', '-q', '--detach', basis], { home: temp });
  return ziel;
}

// ---------------------------------------------------------------------------
// Nachgebautes GitHub und RUNNER_TEMP je Job
// ---------------------------------------------------------------------------

const label = name => ({ id: 1000 + name.length, node_id: 'LA_probe', name, color: 'ededed', default: false });
const pullRecord = (number, ref) => ({
  number, state: 'closed', draft: false, html_url: `https://github.com/${REPO_NAME}/pull/${number}`,
  head: { ref, sha: 'c'.repeat(40), repo: { full_name: REPO_NAME } }, base: { ref: 'main', repo: { full_name: REPO_NAME } },
});

// Ein Auftrag mit Freigabe approvalMs. Ergebnis: GitHub-Zustand und Ereignisnutzlast.
export function szenario({ issue = ISSUE, basis, approvalMs, runId = RUN_ID }) {
  const approval = iso(approvalMs);
  const titel = `Generalprobe A6 P-1: Funktion quadrat (${issue})`;
  const text = 'Ergaenze in src/rechne.js die Funktion quadrat(x), die x mit sich selbst multipliziert, und einen Test.';
  const issueDaten = {
    url: `https://api.github.com/repos/${REPO_NAME}/issues/${issue}`, id: 5_000_000 + issue, node_id: 'I_probe', number: issue, title: titel,
    user: { ...OWNER }, labels: [label('bot-auftrag'), label('agent:js-rechner')], state: 'open', locked: false, assignee: null, comments: 0,
    created_at: iso(approvalMs - 10 * MIN), updated_at: approval, closed_at: null, author_association: 'OWNER', body: text,
    reactions: { total_count: 0 }, performed_via_github_app: null,
  };
  const zustand = {
    issue: issueDaten,
    events: [
      { id: issue * 100 + 1, node_id: 'IE_1', event: 'labeled', created_at: iso(approvalMs - MIN), actor: { ...OWNER }, label: label('agent:js-rechner'), performed_via_github_app: null },
      { id: issue * 100 + 2, node_id: 'IE_2', event: 'labeled', created_at: approval, actor: { ...OWNER }, label: label('bot-auftrag'), performed_via_github_app: null },
    ],
    run: {
      id: Number(runId), name: 'Agent-Auftrag', event: 'issues', path: WORKFLOW_PATH, head_branch: 'main', head_sha: basis, run_attempt: 1,
      created_at: iso(approvalMs + 2000), status: 'in_progress', repository: { full_name: REPO_NAME }, head_repository: { full_name: REPO_NAME },
      actor: { ...OWNER }, triggering_actor: { ...OWNER },
    },
    pulls: [pullRecord(60, 'wp/26-a6-4-2b-transport')],
    refs: {},
    mainSha: basis,
    nextPr: 9101,
  };
  const payload = {
    action: 'labeled',
    issue: structuredClone(issueDaten),
    label: label('bot-auftrag'),
    repository: { id: 42, name: 'agenten-probe', full_name: REPO_NAME, owner: { ...OWNER }, private: false },
    sender: { ...OWNER },
  };
  return { zustand, payload };
}

// Legt einen frischen RUNNER_TEMP an: Ereignisdatei, leere Ausgabedatei, optional GitHub-Zustand.
export function neuerTemp(temp, { zustand, payload, gitLager } = {}) {
  mkdirSync(join(temp, '_github_workflow'), { recursive: true });
  mkdirSync(join(temp, '_runner_file_commands'), { recursive: true });
  writeFileSync(join(temp, '_runner_file_commands', OUTPUT_NAME), '');

  if (payload !== undefined) {
    writeFileSync(join(temp, '_github_workflow', 'event.json'), JSON.stringify(payload));
  }

  if (zustand !== undefined) {
    mkdirSync(join(temp, 'a6-probe-github'), { recursive: true });
    writeFileSync(join(temp, 'a6-probe-github', 'zustand.json'), `${JSON.stringify(zustand, null, 2)}\n`);
    writeFileSync(join(temp, 'a6-probe-github', 'anfragen.jsonl'), '');
  }

  if (gitLager !== undefined) {
    gitIn(temp, ['clone', '-q', '--bare', '--no-local', gitLager, join(temp, 'a6-probe-github', 'repo.git')], { home: temp });
  }

  return temp;
}

export function ausgabe(temp) {
  return readFileSync(join(temp, '_runner_file_commands', OUTPUT_NAME), 'utf8');
}

export function anfragen(temp) {
  const datei = join(temp, 'a6-probe-github', 'anfragen.jsonl');
  return existsSync(datei) ? readFileSync(datei, 'utf8').split('\n').filter(Boolean).map(zeile => JSON.parse(zeile)) : [];
}

// ---------------------------------------------------------------------------
// Umgebungsvertraege, genau wie der Workflow sie setzt
// ---------------------------------------------------------------------------

function gemeinsam({ checkout, temp, basis, runId = RUN_ID }) {
  return {
    ...systemEnv(),
    GITHUB_REPOSITORY: REPO_NAME,
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: basis,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_WORKSPACE: checkout,
    RUNNER_TEMP: temp,
    PATH: String(process.env.PATH),
  };
}

export const VERTRAG = Object.freeze({
  auftrag: k => ({ ...gemeinsam(k), GITHUB_EVENT_PATH: join(k.temp, '_github_workflow', 'event.json'), GITHUB_OUTPUT: join(k.temp, '_runner_file_commands', OUTPUT_NAME), A6_LESE_TOKEN: LESE_TOKEN }),
  claudeVor: k => ({ ...gemeinsam(k), GITHUB_OUTPUT: join(k.temp, '_runner_file_commands', OUTPUT_NAME), A6_AUFTRAG_SHA256: k.auftrag, A6_SCHNAPPSCHUSS_SHA256: k.schnappschuss, A6_LESE_TOKEN: LESE_TOKEN }),
  claudeNach: k => ({ ...gemeinsam(k), GITHUB_OUTPUT: join(k.temp, '_runner_file_commands', OUTPUT_NAME), A6_AUFTRAG_SHA256: k.auftrag, A6_SCHNAPPSCHUSS_SHA256: k.schnappschuss, A6_VERGLEICH_ANTHROPIC: VERGLEICH_ANTHROPIC, A6_VERGLEICH_LESE_TOKEN: VERGLEICH_LESE }),
  abnahme: k => ({ ...gemeinsam(k), A6_AUFTRAG_SHA256: k.auftrag, A6_SCHNAPPSCHUSS_SHA256: k.schnappschuss, A6_PAKET_SHA256: k.paket }),
  veroeffentlichen: k => ({ ...gemeinsam(k), GITHUB_EVENT_PATH: join(k.temp, '_github_workflow', 'event.json'), A6_AUFTRAG_SHA256: k.auftrag, A6_PAKET_SHA256: k.paket, A6_APP_TOKEN: APP_TOKEN }),
});

export const SKRIPTE = Object.freeze({
  auftrag: 'agent-code-job-auftrag.mjs',
  claudeVor: 'agent-code-job-claude-vor.mjs',
  claudeNach: 'agent-code-job-claude-nach.mjs',
  abnahme: 'agent-code-job-abnahme.mjs',
  veroeffentlichen: 'agent-code-job-veroeffentlichen.mjs',
});

const MIT_ATTRAPPE = Object.freeze(['auftrag', 'claudeVor', 'veroeffentlichen']);

// ---------------------------------------------------------------------------
// Start eines Einstiegs: dieselben drei Stufen wie der Startblock des Workflows
// ---------------------------------------------------------------------------

// 1. Aeusserer Anker: SHA-256 des Integritaetspruefers gegen den genehmigten Wert.
// 2. Integritaetspruefer im Checkout.
// 3. Einstieg mit genau seinem Vertrag (env ersetzt die Umgebung vollstaendig).
export function starte(job, env, { anker, checkout = env.GITHUB_WORKSPACE, zusatzArgs = [] } = {}) {
  const pruefer = readFileSync(join(checkout, 'scripts', 'agent-code-integritaet.mjs'));

  if (sha256(pruefer) !== anker) {
    return { status: 1, stdout: '', stderr: 'A6-FEHLER anker-pruefer\n', stufe: 'anker' };
  }

  const integ = spawnSync(process.execPath, ['scripts/agent-code-integritaet.mjs'], { cwd: checkout, env: { ...systemEnv(), PATH: String(process.env.PATH) }, encoding: 'utf8', timeout: 60_000 });

  if (integ.status !== 0 || integ.stdout !== '' || integ.stderr !== '') {
    return { status: integ.status ?? 1, stdout: integ.stdout, stderr: integ.stderr, stufe: 'integritaet' };
  }

  // Das Vorlademodul stammt aus dem Ordner dieses Harness, nie aus dem gepruefen Checkout.
  const vorladen = MIT_ATTRAPPE.includes(job) ? ['--import', pathToFileURL(join(HIER, 'github-attrappe.mjs')).href] : [];
  const r = spawnSync(process.execPath, [...zusatzArgs, ...vorladen, join('scripts', SKRIPTE[job])], { cwd: checkout, env, encoding: 'utf8', timeout: 180_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal, stufe: 'einstieg' };
}

export function fehlercode(r) {
  return FEHLER_RE.exec(r.stderr)?.[1] ?? null;
}

function erfolg(r, was) {
  if (r.status !== 0 || r.stdout !== '' || r.stderr !== '') {
    throw new Error(`Generalprobe: ${was} nicht erfolgreich (Status ${r.status}, Stufe ${r.stufe}, ${JSON.stringify(r.stderr.slice(0, 200))})`);
  }
}

function leseHashes(text, schluessel) {
  const werte = {};

  for (const zeile of text.split('\n').filter(Boolean)) {
    const match = /^([a-z0-9_]+)=([0-9a-f]{64})$/.exec(zeile);

    if (!match || !schluessel.includes(match[1]) || Object.hasOwn(werte, match[1])) {
      throw new Error('Generalprobe: unerwartete Ausgabezeile');
    }

    werte[match[1]] = match[2];
  }

  if (schluessel.some(key => !Object.hasOwn(werte, key))) {
    throw new Error('Generalprobe: Ausgabe unvollstaendig');
  }

  return werte;
}

// ---------------------------------------------------------------------------
// Positive Kette
// ---------------------------------------------------------------------------

export function genehmigterAnker(quelle) {
  return sha256(readFileSync(join(quelle, 'scripts', 'agent-code-integritaet.mjs')));
}

// Baut Checkout und die vier RUNNER_TEMP-Ordner. Job 0 bis Job 3 laufen nacheinander, jeder mit eigenem
// Temp-Ordner; Schnappschuss, Paket und GitHub-Zustand werden wie Artefakte kopiert.
export function kette(ordner, { quelle, anker, issue = ISSUE, bis = 'veroeffentlichen', approvalMs = Math.floor((Date.now() - 2 * MIN) / 1000) * 1000 } = {}) {
  const checkout = join(ordner, 'checkout');
  const basis = baueRepo(quelle, checkout);
  const { zustand, payload } = szenario({ issue, basis, approvalMs });
  const k = { checkout, basis, anker };

  // Job 0
  const t0 = neuerTemp(join(ordner, 't0'), { zustand, payload });
  const r0 = starte('auftrag', VERTRAG.auftrag({ ...k, temp: t0 }), { anker });
  erfolg(r0, 'Job 0');
  const h0 = leseHashes(ausgabe(t0), ['auftrag_sha256', 'schnappschuss_sha256']);
  k.auftrag = h0.auftrag_sha256;
  k.schnappschuss = h0.schnappschuss_sha256;
  const schnappschuss = readFileSync(join(t0, 'a6-auftrag', 'schnappschuss.json'));

  if (sha256(schnappschuss) !== k.schnappschuss) {
    throw new Error('Generalprobe: Schnappschuss passt nicht zur Ausgabe');
  }

  const ergebnis = { ordner, checkout, basis, issue, auftrag: k.auftrag, schnappschussSha: k.schnappschuss, anfragen0: anfragen(t0), zustand, payload };

  // Job 1a, Ersatz statt Claude, Job 1b
  const t1 = neuerTemp(join(ordner, 't1'), { zustand });
  mkdirSync(join(t1, 'a6-auftrag'));
  writeFileSync(join(t1, 'a6-auftrag', 'schnappschuss.json'), schnappschuss);
  const r1a = starte('claudeVor', VERTRAG.claudeVor({ ...k, temp: t1 }), { anker });
  erfolg(r1a, 'Job 1a');
  ergebnis.prompt = ausgabe(t1);
  ergebnis.anfragen1 = anfragen(t1);
  claudeErsatz(join(t1, 'a6-claude-arbeit'));
  writeFileSync(join(t1, '_runner_file_commands', OUTPUT_NAME), '');
  const r1b = starte('claudeNach', VERTRAG.claudeNach({ ...k, temp: t1 }), { anker });
  erfolg(r1b, 'Job 1b');
  k.paket = leseHashes(ausgabe(t1), ['paket_sha256']).paket_sha256;
  const paket = readFileSync(join(t1, 'a6-paket', 'paket-v2.json'));
  ergebnis.paket = k.paket;
  ergebnis.paketBytes = paket;
  ergebnis.t1 = t1;

  if (bis === 'claude') {
    return ergebnis;
  }

  // Job 2
  const t2 = neuerTemp(join(ordner, 't2'));
  mkdirSync(join(t2, 'a6-auftrag'));
  mkdirSync(join(t2, 'a6-paket'));
  writeFileSync(join(t2, 'a6-auftrag', 'schnappschuss.json'), schnappschuss);
  writeFileSync(join(t2, 'a6-paket', 'paket-v2.json'), paket);
  ergebnis.r2 = starte('abnahme', VERTRAG.abnahme({ ...k, temp: t2 }), { anker });
  ergebnis.t2 = t2;

  if (bis === 'abnahme') {
    return ergebnis;
  }

  erfolg(ergebnis.r2, 'Job 2');

  // Job 3
  const t3 = neuerTemp(join(ordner, 't3'), { zustand, payload, gitLager: checkout });
  mkdirSync(join(t3, 'a6-paket'));
  writeFileSync(join(t3, 'a6-paket', 'paket-v2.json'), paket);
  pruefCheckout(checkout, t3, basis);
  const r3 = starte('veroeffentlichen', VERTRAG.veroeffentlichen({ ...k, temp: t3 }), { anker });
  erfolg(r3, 'Job 3');
  ergebnis.t3 = t3;
  ergebnis.anfragen3 = anfragen(t3);
  ergebnis.k = k;
  return ergebnis;
}

// Pruefung der Anfrageprotokolle: nur der nachgebaute Host, kein gesperrter Netzweg, Lesen mit Token,
// Job 3 genau die erwarteten Schreibaufrufe und ein Draft-PR auf genau dem eigenen Commit.
export function pruefeAnfragen(e) {
  const fehler = [];
  const alle = [...e.anfragen0, ...e.anfragen1, ...(e.anfragen3 ?? [])];

  if (alle.some(a => a.verboten !== undefined)) {
    fehler.push('gesperrter Netzweg versucht');
  }

  if (alle.some(a => a.host !== 'api.github.com' || a.token !== 'ja')) {
    fehler.push('Anfrage an fremden Host oder ohne Token');
  }

  if ([...e.anfragen0, ...e.anfragen1].some(a => a.methode !== 'GET')) {
    fehler.push('Job 0 oder 1a hat geschrieben');
  }

  if (e.anfragen3 !== undefined) {
    const p = `/repos/${REPO_NAME}/`;
    const writes = e.anfragen3.filter(a => a.methode !== 'GET').map(a => `${a.methode} ${a.pfad.slice(p.length)}`);

    if (JSON.stringify(writes) !== JSON.stringify(WRITES_OK)) {
      fehler.push(`Job 3 Schreibaufrufe abweichend: ${writes.join(', ')}`);
    }

    const zustand = JSON.parse(readFileSync(join(e.t3, 'a6-probe-github', 'zustand.json'), 'utf8'));
    const pr = zustand.pulls.at(-1);
    const branch = `wp/${e.issue}-agent-${RUN_ID}-1`;

    if (pr?.draft !== true || pr.head?.ref !== branch || zustand.refs[`refs/heads/${branch}`] !== pr.head.sha) {
      fehler.push('kein Draft-PR auf dem eigenen Branch');
    }
  }

  return fehler;
}

// ---------------------------------------------------------------------------
// Negativfaelle: jeder muss an genau seinem Mechanismus scheitern
// ---------------------------------------------------------------------------

// Kopie des RUNNER_TEMP von Job 1 im Zustand nach Claude und vor Job 1b: ohne Paket und ohne den
// HOME-Ordner, den Job 1b selbst neu anlegt.
function vorJob1b(quelleTemp, ziel) {
  cpSync(quelleTemp, ziel, { recursive: true });
  rmSync(join(ziel, 'a6-paket'), { recursive: true, force: true });
  rmSync(join(ziel, 'a6-claude-nach-home'), { recursive: true, force: true });
  writeFileSync(join(ziel, '_runner_file_commands', OUTPUT_NAME), '');
  return ziel;
}

// Arbeitskopie eines Checkouts mit eigener Git-Ablage.
function checkoutKopie(e, ziel) {
  mkdirSync(dirname(ziel), { recursive: true });
  gitIn(dirname(ziel), ['clone', '-q', '--no-local', e.checkout, ziel], { home: dirname(ziel) });
  gitIn(ziel, ['checkout', '-q', '--detach', e.basis], { home: dirname(ziel) });
  return ziel;
}

function zweiterCommit(checkout) {
  writeFileSync(join(checkout, 'README.md'), `${readFileSync(join(checkout, 'README.md'), 'utf8')}\nGeneralprobe: zweiter Commit\n`);
  gitIn(checkout, ['add', 'README.md']);
  gitIn(checkout, ['commit', '-q', '-m', 'Generalprobe: anderer Commit']);
  return gitIn(checkout, ['rev-parse', 'HEAD']);
}

function paketTemp(e, ziel, paket = e.paketBytes) {
  const temp = neuerTemp(ziel);
  mkdirSync(join(temp, 'a6-auftrag'));
  mkdirSync(join(temp, 'a6-paket'));
  writeFileSync(join(temp, 'a6-auftrag', 'schnappschuss.json'), readFileSync(join(e.t1, 'a6-auftrag', 'schnappschuss.json')));
  writeFileSync(join(temp, 'a6-paket', 'paket-v2.json'), paket);
  return temp;
}

// P4: gleich langer Eingriff in src/rechne.js im Paket, Paket-Hash immer nachgezogen, optional auch der
// SHA-256 der Datei.
function p4(e, dir, dateiHashNachziehen) {
  const paket = JSON.parse(e.paketBytes.toString('utf8'));
  const datei = paket.dateien.find(d => d.pfad === 'src/rechne.js');

  if (datei === undefined || typeof datei.base64 !== 'string' || !/^[0-9a-f]{64}$/.test(datei.sha256)) {
    throw new Error('Generalprobe: Paketform unerwartet');
  }

  const alt = Buffer.from(datei.base64, 'base64').toString('utf8');

  if (!alt.includes('return a * a;')) {
    throw new Error('Generalprobe: Mutationsstelle im Paket nicht gefunden');
  }

  const neu = Buffer.from(alt.replace('return a * a;', 'return a + a;'));
  datei.base64 = neu.toString('base64');

  if (dateiHashNachziehen) {
    datei.sha256 = sha256(neu);
  }

  const bytes = Buffer.from(`${JSON.stringify(paket, null, 2)}\n`, 'utf8');
  return { r: starte('abnahme', { ...VERTRAG.abnahme({ ...e.k, temp: paketTemp(e, join(dir, 't'), bytes) }), A6_PAKET_SHA256: sha256(bytes) }, { anker: e.k.anker }) };
}

// Jeder Fall: Mechanismus (Klartext), erwarteter Code und Ausfuehrung. lauf(e, dir) liefert
// { r, zusatz } mit optionaler Zusatzpruefung, die bei Erfolg null liefert.
export const FAELLE = Object.freeze({
  'P5-paket-manipuliert': {
    mechanismus: 'Job 2 rechnet den Paket-Hash selbst nach und vergleicht ihn mit dem Hash aus Job 1b',
    code: 'job-paket-hash',
    lauf: (e, dir) => {
      const bytes = Buffer.from(e.paketBytes);
      bytes[bytes.length - 2] ^= 0x01;
      return { r: starte('abnahme', VERTRAG.abnahme({ ...e.k, temp: paketTemp(e, join(dir, 't'), bytes) }), { anker: e.k.anker }) };
    },
  },
  'P5-ungueltiger-hash': {
    mechanismus: 'Job 2 verlangt fuer jeden uebergebenen Hash genau 64 kleine Hexzeichen',
    code: 'job-hash-format',
    lauf: (e, dir) => ({ r: starte('abnahme', { ...VERTRAG.abnahme({ ...e.k, temp: paketTemp(e, join(dir, 't')) }), A6_PAKET_SHA256: e.k.paket.toUpperCase() }, { anker: e.k.anker }) }),
  },
  'P5-fremder-lauf': {
    mechanismus: 'Der Schnappschuss ist an die Lauf-ID gebunden; ein anderer Lauf wird abgelehnt',
    code: 'job-schnappschuss-lauf',
    lauf: (e, dir) => ({ r: starte('abnahme', VERTRAG.abnahme({ ...e.k, runId: FREMDER_LAUF, temp: paketTemp(e, join(dir, 't')) }), { anker: e.k.anker }) }),
  },
  'P5-falscher-ausgangscommit': {
    mechanismus: 'Der Auftrag bindet den Ausgangscommit; ein anderer GITHUB_SHA ergibt einen anderen Auftrags-Hash',
    code: 'auftrag-abweichung',
    lauf: (e, dir) => {
      const checkout = checkoutKopie(e, join(dir, 'checkout'));
      const anderer = zweiterCommit(checkout);
      return { r: starte('abnahme', VERTRAG.abnahme({ ...e.k, checkout, basis: anderer, temp: paketTemp(e, join(dir, 't')) }), { anker: e.k.anker }) };
    },
  },
  'P5-checkout-nicht-auf-basis': {
    mechanismus: 'Job 1b verlangt, dass der Checkout genau auf GITHUB_SHA steht',
    code: 'job-checkout-head',
    lauf: (e, dir) => {
      const checkout = checkoutKopie(e, join(dir, 'checkout'));
      zweiterCommit(checkout);
      const temp = vorJob1b(e.t1, join(dir, 't'));
      return { r: starte('claudeNach', VERTRAG.claudeNach({ ...e.k, checkout, temp }), { anker: e.k.anker }) };
    },
  },
  'P7-skriptbytes-veraendert': {
    mechanismus: 'Der Integritaetspruefer vergleicht jedes Skript mit der Hashliste der Policy, vor jedem Einstieg',
    code: 'integritaet-skript-hash',
    lauf: (e, dir) => {
      const checkout = checkoutKopie(e, join(dir, 'checkout'));
      const datei = join(checkout, 'scripts', 'agent-code-job-abnahme.mjs');
      writeFileSync(datei, `${readFileSync(datei, 'utf8')}// veraendert\n`);
      return { r: starte('abnahme', VERTRAG.abnahme({ ...e.k, checkout, temp: paketTemp(e, join(dir, 't')) }), { anker: e.k.anker, checkout }) };
    },
  },
  'N1N2-pruefer-und-policy-veraendert': {
    mechanismus: 'Aeusserer Anker im Workflow: SHA-256 des Integritaetspruefers stammt nie aus dem Checkout',
    code: 'anker-pruefer',
    lauf: (e, dir) => {
      const checkout = checkoutKopie(e, join(dir, 'checkout'));
      const datei = join(checkout, 'scripts', 'agent-code-integritaet.mjs');
      const neu = readFileSync(datei, 'utf8').replace('export function main() {\n  try {\n    pruefeIntegritaet();', 'export function main() {\n  try {\n    // N1/N2: Pruefung uebersprungen');

      if (!neu.includes('N1/N2')) {
        throw new Error('Generalprobe: Mutationsstelle im Pruefer nicht gefunden');
      }

      writeFileSync(datei, neu);
      // Policy passend nachgezogen: die Selbstpruefung allein haette nichts bemerkt.
      const policyPfad = join(checkout, '.github', 'agent', 'policy.json');
      const policy = JSON.parse(readFileSync(policyPfad, 'utf8'));
      policy.skript_hashes['scripts/agent-code-integritaet.mjs'] = sha256(Buffer.from(neu, 'utf8'));
      writeFileSync(policyPfad, `${JSON.stringify(policy, null, 2)}\n`);
      const ohneAnker = spawnSync(process.execPath, ['scripts/agent-code-integritaet.mjs'], { cwd: checkout, env: { ...systemEnv(), PATH: String(process.env.PATH) }, encoding: 'utf8' });
      const r = starte('abnahme', VERTRAG.abnahme({ ...e.k, checkout, temp: paketTemp(e, join(dir, 't')) }), { anker: e.k.anker, checkout });
      // Gegenprobe: ohne aeusseren Anker haette der veraenderte Pruefer bestanden.
      return { r, zusatz: ohneAnker.status === 0 && ohneAnker.stderr === '' ? null : 'Gegenprobe: veraenderter Pruefer haette ohne Anker nicht bestanden' };
    },
  },
  'S4-node-options-im-vertrag': {
    mechanismus: 'Stolperdraht im Einstieg lehnt NODE_-Variablen ab; der Vorlader lief aber schon, deshalb startet der Workflow Node nie mit geerbter Umgebung',
    code: 'job-umgebung-node',
    lauf: (e, dir) => {
      mkdirSync(dir, { recursive: true });
      const marker = join(dir, 'vorlader-lief');
      const vorlader = join(dir, 'vorlader.cjs');
      writeFileSync(vorlader, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
      const r = starte('abnahme', { ...VERTRAG.abnahme({ ...e.k, temp: paketTemp(e, join(dir, 't')) }), NODE_OPTIONS: `--require ${vorlader}` }, { anker: e.k.anker });
      return { r, zusatz: existsSync(marker) ? null : 'Gegenprobe: Vorlader lief nicht, der Fall belegt dann nichts' };
    },
  },
  'K2-git-config-im-arbeitsordner': {
    mechanismus: 'Job 1b durchsucht den Arbeitsordner und lehnt jeden .git-Eintrag ab; Git laeuft nie im Arbeitsordner, der Marker darf nie entstehen',
    code: 'paket-git-ordner',
    lauf: (e, dir) => {
      const temp = vorJob1b(e.t1, join(dir, 't'));
      const marker = join(dir, 'fsmonitor-lief');
      const arbeit = join(temp, 'a6-claude-arbeit');
      mkdirSync(join(arbeit, '.git'), { recursive: true });
      writeFileSync(join(arbeit, 'hilfe.sh'), `#!/bin/sh\ntouch ${marker}\n`);
      writeFileSync(join(arbeit, '.git', 'config'), `[core]\n\tfsmonitor = sh ${join(arbeit, 'hilfe.sh')}\n`);
      const r = starte('claudeNach', VERTRAG.claudeNach({ ...e.k, temp }), { anker: e.k.anker });
      return { r, zusatz: existsSync(marker) ? 'Marker entstanden: Code aus dem Arbeitsordner lief' : null };
    },
  },
  'P4-code-veraendert-hash-nachgezogen': {
    mechanismus: 'Paket v2 bindet jede Datei an ihren SHA-256; ein gleich langer, veraenderter Inhalt mit nachgezogenem Paket-Hash wird erkannt',
    code: 'paket-sha256',
    lauf: (e, dir) => p4(e, dir, false),
  },
  'P4-code-veraendert-sha256-nachgezogen': {
    mechanismus: 'Paket v2 bindet jede Datei zusaetzlich an ihre Git-Blob-ID; auch mit nachgezogenem Datei- und Paket-Hash wird der Inhalt erkannt',
    code: 'paket-git-blob',
    lauf: (e, dir) => p4(e, dir, true),
  },
  'P3-abnahme-im-arbeitsbaum-wirkungslos': {
    mechanismus: 'Die Abnahme laeuft aus dem Git-Baum des gebundenen Ausgangscommits; eine scheiternde Fassung im Arbeitsbaum des Checkouts wird nie ausgefuehrt',
    code: null,
    lauf: (e, dir) => {
      const checkout = checkoutKopie(e, join(dir, 'checkout'));
      const datei = join(checkout, 'agent-acceptance', `issue-${e.issue}.mjs`);
      writeFileSync(datei, `${FORMAT}process.exitCode = 3;\n`);
      return { r: starte('abnahme', VERTRAG.abnahme({ ...e.k, checkout, temp: paketTemp(e, join(dir, 't')) }), { anker: e.k.anker, checkout }) };
    },
  },
  'E1-freigabe-zweimal-branch': {
    mechanismus: 'Live-Pruefung in Job 0: ein Branch eines frueheren Laufs fuer dieses Issue sperrt jeden weiteren Lauf',
    code: 'live-branch-vorhanden',
    lauf: (e, dir) => {
      const zustand = structuredClone(e.zustand);
      zustand.refs[`refs/heads/wp/${e.issue}-agent-${FREMDER_LAUF}-1`] = 'd'.repeat(40);
      const temp = neuerTemp(join(dir, 't'), { zustand, payload: e.payload });
      return { r: starte('auftrag', VERTRAG.auftrag({ ...e.k, temp }), { anker: e.k.anker }) };
    },
  },
  'E2-freigabe-zweimal-pr': {
    mechanismus: 'Live-Pruefung in Job 0: ein frueherer PR fuer dieses Issue sperrt jeden weiteren Lauf, auch ohne Branch',
    code: 'live-pr-vorhanden',
    lauf: (e, dir) => {
      const zustand = structuredClone(e.zustand);
      zustand.pulls.push(pullRecord(77, `wp/${e.issue}-agent-${FREMDER_LAUF}-1`));
      const temp = neuerTemp(join(dir, 't'), { zustand, payload: e.payload });
      return { r: starte('auftrag', VERTRAG.auftrag({ ...e.k, temp }), { anker: e.k.anker }) };
    },
  },
  'L2-ausgabedatei-als-symlink': {
    mechanismus: 'Job 1b schreibt seine Ausgabe nur in eine gewoehnliche Datei, nie durch einen Symlink',
    code: 'job-ausgabe-datei',
    lauf: (e, dir) => {
      const temp = vorJob1b(e.t1, join(dir, 't'));
      const ziel = join(dir, 'ziel.txt');
      writeFileSync(ziel, 'unveraendert\n');
      const ausgabeDatei = join(temp, '_runner_file_commands', OUTPUT_NAME);
      rmSync(ausgabeDatei);
      symlinkSync(ziel, ausgabeDatei);
      const r = starte('claudeNach', VERTRAG.claudeNach({ ...e.k, temp }), { anker: e.k.anker });
      return { r, zusatz: readFileSync(ziel, 'utf8') === 'unveraendert\n' ? null : 'Ziel des Symlinks wurde beschrieben' };
    },
  },
  'L1-job3-zweiter-versuch': {
    mechanismus: 'Ein zweiter Veroeffentlichungsversuch fuer denselben Auftrag scheitert an der Live-Pruefung (eigener Branch existiert)',
    code: 'live-branch-vorhanden',
    lauf: (e, dir) => {
      const temp = neuerTemp(join(dir, 't'), { payload: e.payload });
      cpSync(join(e.t3, 'a6-probe-github'), join(temp, 'a6-probe-github'), { recursive: true });
      writeFileSync(join(temp, 'a6-probe-github', 'anfragen.jsonl'), '');
      mkdirSync(join(temp, 'a6-paket'));
      writeFileSync(join(temp, 'a6-paket', 'paket-v2.json'), e.paketBytes);
      pruefCheckout(e.checkout, temp, e.basis);
      const r = starte('veroeffentlichen', VERTRAG.veroeffentlichen({ ...e.k, temp }), { anker: e.k.anker });
      const writes = anfragen(temp).filter(a => a.methode !== 'GET');
      return { r, zusatz: writes.length === 0 ? null : `zweiter Versuch hat geschrieben: ${writes.length}` };
    },
  },
});

// NF2 synthetisch: eigener Auftrag, dessen Abnahme bewusst etwas anderes verlangt als der Auftragstext.
export function nf2(ordner, { quelle, anker }) {
  const e = kette(ordner, { quelle, anker, issue: ISSUE_NF2, bis: 'abnahme' });
  return { r: e.r2, code: fehlercode(e.r2) };
}

export function negativ(ordner, { quelle, anker, nur } = {}) {
  const e = kette(join(ordner, 'basis'), { quelle, anker });
  const fehler = pruefeAnfragen(e);

  if (fehler.length > 0) {
    throw new Error(`Generalprobe: positive Basis fehlerhaft: ${fehler.join('; ')}`);
  }

  const ergebnisse = [];

  for (const [name, fall] of Object.entries(FAELLE)) {
    if (nur !== undefined && nur !== name) {
      continue;
    }

    const dir = join(ordner, name);
    const { r, zusatz = null } = fall.lauf(e, dir);
    const code = fehlercode(r);
    // code null: der Fall muss bestehen, weil die Manipulation am vorgesehenen Ort nicht wirkt.
    const ok = fall.code === null
      ? r.status === 0 && r.stdout === '' && r.stderr === '' && zusatz === null
      : r.status === 1 && r.stdout === '' && code === fall.code && zusatz === null;
    const erhalten = code ?? (r.status === 0 ? 'bestanden' : `Status ${r.status}`);
    ergebnisse.push({ name, erwartet: fall.code ?? 'bestanden', erhalten, stufe: r.stufe, zusatz, ok });
  }

  if (nur === undefined || nur === 'NF2-abnahme-fachlich-falsch') {
    const n = nf2(join(ordner, 'nf2'), { quelle, anker });
    ergebnisse.push({ name: 'NF2-abnahme-fachlich-falsch', erwartet: 'abnahme-exitcode', erhalten: n.code ?? `Status ${n.r.status}`, stufe: n.r.stufe, zusatz: null, ok: n.r.status === 1 && n.code === 'abnahme-exitcode' });
  }

  return ergebnisse;
}

// ---------------------------------------------------------------------------
// Einzelschritte fuer die Probejobs des Workflows
// ---------------------------------------------------------------------------
//
// Jeder Probejob des Workflows ist ein eigener Actions-Job. Der Harness bereitet nur vor (synthetischer
// Checkout, RUNNER_TEMP, nachgebautes GitHub, kontrakt.env) und wertet aus. Den Einstieg startet der
// Workflow selbst, mit demselben Startblock wie im Live-Pfad. Uebergaben zwischen den Jobs laufen ueber
// echte Artefakte; jeder Schritt rechnet die Hashes neu nach.

const KONTRAKT_WERT_RE = /^[A-Za-z0-9_./:@=+-]{1,4096}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function schreibeKontrakt(ordner, env) {
  const zeilen = [];

  for (const [name, wert] of Object.entries(env)) {
    if (name === 'PATH' || SYSTEM_KEYS.includes(name)) {
      continue;
    }

    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !KONTRAKT_WERT_RE.test(wert)) {
      throw new Error(`Generalprobe: Vertragswert ${name} ungueltig`);
    }

    zeilen.push(`${name}=${wert}`);
  }

  writeFileSync(join(ordner, 'kontrakt.env'), `${zeilen.join('\n')}\n`);
}

function pruefeHex(wert, re, was) {
  if (typeof wert !== 'string' || !re.test(wert)) {
    throw new Error(`Generalprobe: ${was} ungueltig`);
  }

  return wert;
}

function kopiereGeprueft(quelle, ziel, hash) {
  const bytes = readFileSync(quelle);

  if (hash !== undefined && sha256(bytes) !== hash) {
    throw new Error('Generalprobe: Artefakt passt nicht zum uebergebenen Hash');
  }

  mkdirSync(dirname(ziel), { recursive: true });
  writeFileSync(ziel, bytes);
  return bytes;
}

// Frischer synthetischer Checkout; er muss genau den Ausgangscommit aus Job 0 ergeben.
function frischerCheckout(ordner, quelle, basis) {
  const checkout = join(ordner, 'checkout');
  rmSync(checkout, { recursive: true, force: true });

  if (baueRepo(quelle, checkout) !== basis) {
    throw new Error('Generalprobe: synthetischer Ausgangscommit weicht von Job 0 ab');
  }

  return checkout;
}

function nurLesend(liste, was) {
  if (liste.length === 0 || liste.some(a => a.verboten !== undefined || a.host !== 'api.github.com' || a.token !== 'ja' || a.methode !== 'GET')) {
    throw new Error(`Generalprobe: ${was} hat nicht nur lesend den nachgebauten Host gefragt`);
  }
}

export function schritt(name, ordner, args, { quelle, anker }) {
  const zeile = (key, wert) => `${key}=${wert}\n`;

  if (name === 'auftrag-vorbereiten') {
    const checkout = join(ordner, 'checkout');
    const basis = baueRepo(quelle, checkout);
    const { zustand, payload } = szenario({ basis, approvalMs: Math.floor((Date.now() - 2 * MIN) / 1000) * 1000 });
    const temp = neuerTemp(join(ordner, 't'), { zustand, payload });
    schreibeKontrakt(ordner, VERTRAG.auftrag({ checkout, temp, basis }));
    writeFileSync(join(ordner, 'basis'), basis);
    return '';
  }

  if (name === 'auftrag-auswerten') {
    const temp = join(ordner, 't');
    const h = leseHashes(ausgabe(temp), ['auftrag_sha256', 'schnappschuss_sha256']);
    nurLesend(anfragen(temp), 'Job 0');
    const art = join(ordner, 'artefakt');
    kopiereGeprueft(join(temp, 'a6-auftrag', 'schnappschuss.json'), join(art, 'schnappschuss.json'), h.schnappschuss_sha256);
    kopiereGeprueft(join(temp, 'a6-probe-github', 'zustand.json'), join(art, 'zustand.json'));
    kopiereGeprueft(join(temp, '_github_workflow', 'event.json'), join(art, 'event.json'));
    const basis = pruefeHex(readFileSync(join(ordner, 'basis'), 'utf8'), HEX40, 'Ausgangscommit');
    return zeile('basis_sha', basis) + zeile('auftrag_sha256', h.auftrag_sha256) + zeile('schnappschuss_sha256', h.schnappschuss_sha256);
  }

  if (name === 'claude-auswerten') {
    const temp = join(ordner, 't');
    const h = leseHashes(ausgabe(temp), ['paket_sha256']);
    kopiereGeprueft(join(temp, 'a6-paket', 'paket-v2.json'), join(ordner, 'artefakt', 'paket-v2.json'), h.paket_sha256);
    return zeile('paket_sha256', h.paket_sha256);
  }

  if (name === 'veroeffentlichen-auswerten') {
    const temp = join(ordner, 't');
    const issue = Number(readFileSync(join(ordner, 'issue'), 'utf8'));
    const fehler = pruefeAnfragen({ issue, t3: temp, anfragen0: [], anfragen1: [], anfragen3: anfragen(temp) });

    if (fehler.length > 0) {
      throw new Error(`Generalprobe: Job 3 abweichend: ${fehler.join('; ')}`);
    }

    return zeile('anfragen_job3', String(anfragen(temp).length));
  }

  const [artefakt, basisArg, auftragArg, schnappschussArg, paketArg, paketArtefakt] = args;
  const basis = pruefeHex(basisArg, HEX40, 'Ausgangscommit');
  const auftrag = pruefeHex(auftragArg, HEX64, 'Auftrags-Hash');

  if (name === 'claude-vorbereiten') {
    const schnappschuss = pruefeHex(schnappschussArg, HEX64, 'Schnappschuss-Hash');
    const checkout = frischerCheckout(ordner, quelle, basis);
    const zustand = JSON.parse(readFileSync(join(artefakt, 'zustand.json'), 'utf8'));
    const temp = neuerTemp(join(ordner, 't'), { zustand });
    kopiereGeprueft(join(artefakt, 'schnappschuss.json'), join(temp, 'a6-auftrag', 'schnappschuss.json'), schnappschuss);
    schreibeKontrakt(ordner, VERTRAG.claudeVor({ checkout, temp, basis, auftrag, schnappschuss }));
    return '';
  }

  if (name === 'claude-nach-vorbereiten') {
    // Nach dem Ersatz fuer Claude: frischer Checkout, Ausgabedatei neu, Prompt nur auf Form geprueft.
    const schnappschuss = pruefeHex(schnappschussArg, HEX64, 'Schnappschuss-Hash');
    const temp = join(ordner, 't');
    nurLesend(anfragen(temp), 'Job 1a');

    if (!/^prompt<<[A-Za-z0-9_]+\n[\s\S]+\n[A-Za-z0-9_]+\n$/.test(ausgabe(temp))) {
      throw new Error('Generalprobe: Job 1a hat keine Prompt-Ausgabe in der erwarteten Form geschrieben');
    }

    writeFileSync(join(temp, '_runner_file_commands', OUTPUT_NAME), '');
    const checkout = frischerCheckout(ordner, quelle, basis);
    schreibeKontrakt(ordner, VERTRAG.claudeNach({ checkout, temp, basis, auftrag, schnappschuss }));
    return '';
  }

  if (name === 'abnahme-vorbereiten') {
    const schnappschuss = pruefeHex(schnappschussArg, HEX64, 'Schnappschuss-Hash');
    const paket = pruefeHex(paketArg, HEX64, 'Paket-Hash');
    const checkout = frischerCheckout(ordner, quelle, basis);
    const temp = neuerTemp(join(ordner, 't'));
    kopiereGeprueft(join(artefakt, 'schnappschuss.json'), join(temp, 'a6-auftrag', 'schnappschuss.json'), schnappschuss);
    kopiereGeprueft(join(paketArtefakt, 'paket-v2.json'), join(temp, 'a6-paket', 'paket-v2.json'), paket);
    schreibeKontrakt(ordner, VERTRAG.abnahme({ checkout, temp, basis, auftrag, schnappschuss, paket }));
    return '';
  }

  if (name === 'veroeffentlichen-vorbereiten') {
    const paket = pruefeHex(paketArg, HEX64, 'Paket-Hash');
    const checkout = frischerCheckout(ordner, quelle, basis);
    const zustand = JSON.parse(readFileSync(join(artefakt, 'zustand.json'), 'utf8'));
    const payload = JSON.parse(readFileSync(join(artefakt, 'event.json'), 'utf8'));
    const temp = neuerTemp(join(ordner, 't'), { zustand, payload, gitLager: checkout });
    kopiereGeprueft(join(paketArtefakt, 'paket-v2.json'), join(temp, 'a6-paket', 'paket-v2.json'), paket);
    pruefCheckout(checkout, temp, basis);
    schreibeKontrakt(ordner, VERTRAG.veroeffentlichen({ checkout, temp, basis, auftrag, paket }));
    writeFileSync(join(ordner, 'issue'), String(zustand.issue.number));
    return '';
  }

  throw new Error('Generalprobe: unbekannter Schritt');
}

// ---------------------------------------------------------------------------
// Kommandozeile
// ---------------------------------------------------------------------------

async function cli(argv) {
  if (argv[0] === 'schritt') {
    const [, name, ordnerArg, ...rest] = argv;
    const anker = process.env.A6_INTEGRITAET_SHA256;

    if (typeof anker !== 'string' || !HEX64.test(anker) || ordnerArg === undefined) {
      process.stderr.write('Generalprobe: Aufruf braucht A6_INTEGRITAET_SHA256 und einen Ordner\n');
      return 2;
    }

    const ordner = resolve(ordnerArg);
    mkdirSync(ordner, { recursive: true });
    process.stdout.write(schritt(name, ordner, rest, { quelle: resolve(process.cwd()), anker }));
    return 0;
  }

  const [befehl, ordnerArg, nur] = argv;
  const quelle = resolve(process.cwd());
  const anker = process.env.A6_INTEGRITAET_SHA256;

  if (typeof anker !== 'string' || !/^[0-9a-f]{64}$/.test(anker) || ordnerArg === undefined) {
    process.stderr.write('Generalprobe: Aufruf braucht A6_INTEGRITAET_SHA256 und einen Ordner\n');
    return 2;
  }

  const ordner = resolve(ordnerArg);

  if (existsSync(ordner) && readdirSync(ordner).length > 0) {
    process.stderr.write('Generalprobe: Ordner muss leer sein\n');
    return 2;
  }

  if (befehl === 'kette') {
    const e = kette(ordner, { quelle, anker });
    const fehler = pruefeAnfragen(e);
    process.stdout.write(`PROBE basis=${e.basis}\nPROBE auftrag_sha256=${e.auftrag}\nPROBE paket_sha256=${e.paket}\nPROBE anfragen_job3=${e.anfragen3.length}\n`);
    fehler.forEach(f => process.stdout.write(`PROBE-FEHLER ${f}\n`));
    return fehler.length === 0 ? 0 : 1;
  }

  if (befehl === 'negativ') {
    const ergebnisse = negativ(ordner, { quelle, anker, nur });

    for (const x of ergebnisse) {
      process.stdout.write(`${x.ok ? 'FALL-OK    ' : 'FALL-ROT   '} ${x.name}: erwartet ${x.erwartet}, erhalten ${x.erhalten} (Stufe ${x.stufe})${x.zusatz ? `, ${x.zusatz}` : ''}\n`);
    }

    const erwartet = nur === undefined ? Object.keys(FAELLE).length + 1 : 1;
    return ergebnisse.length === erwartet && ergebnisse.every(x => x.ok) ? 0 : 1;
  }

  process.stderr.write('Generalprobe: unbekannter Befehl\n');
  return 2;
}

if (import.meta.main === true) {
  process.exitCode = await cli(process.argv.slice(2));
}

