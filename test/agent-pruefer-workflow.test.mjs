// B2.1 Vorpruefung: Wachen fuer den geschuetzten Workflow .github/workflows/agent-pruefer.yml (Eigentuemer-PR).
// Ohne den Eigentuemer-PR fehlt die Datei; dann sind die Tests, die sie lesen, bewusst rot.
//   - Anker gleich agent-auftrag.yml (Funktionsdatei, Integritaetspruefer, Node-Image, Node-Version), Anker der Attrappe
//   - Ausloeser, Bedingungen, Rechte, Checkout nur github.sha
//   - Containergrenzen jedes docker run (Nachtrag B2.1 Punkt 1 bis 4) mit Muss-Treffern je Regel
//   - echte Ausfuehrung des Startskripts im Container-Ablauf: veraendertes Gate, Pruefskript oder Policy bricht vor
//     jeder Bewertung ab
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WF_PFAD = join(ROOT, '.github', 'workflows', 'agent-pruefer.yml');
const lies = p => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha256 = b => createHash('sha256').update(b).digest('hex');
// SHA-256 des genehmigten agent-pruefer.yml (Zeilenenden LF). Jede andere Fassung ist rot.
const A6_PRUEFER_WORKFLOW_SHA256 = '80dbc2cdfbe356531332ebfcf72185bc5bbcdc4368ffd52e13564fe7fd8fc493';
const WF = () => lies(WF_PFAD);

const envWert = (text, name) => {
  const m = [...text.matchAll(new RegExp(`^ {2}${name}: (\\S+)$`, 'gm'))];
  assert.equal(m.length, 1, `${name} nicht genau einmal`);
  return m[0][1];
};

// Jobs: Bloecke unter "jobs:" mit genau zwei Leerzeichen Einzug.
function jobs(text) {
  const teil = text.split('\njobs:\n');
  assert.equal(teil.length, 2);
  const bloecke = {};
  for (const b of teil[1].split(/\n(?= {2}[a-z_]+:\n)/)) {
    const m = /^ {2}([a-z_]+):\n/.exec(b.startsWith('  ') ? b : `${b}`);
    if (m) bloecke[m[1]] = b;
  }
  return bloecke;
}

// Jeder docker run bis zur Argumentzeile "' a6 ...". Liefert { optionen, skript, argumente }.
function dockerLaeufe(text) {
  const laeufe = [];
  let rest = text;
  for (;;) {
    const i = rest.indexOf('docker run ');
    if (i < 0) break;
    rest = rest.slice(i);
    const start = rest.indexOf("/bin/sh -euc '");
    const ende = rest.indexOf("' a6 ", start);
    assert.ok(start > 0 && ende > start, 'docker run ohne festes Startskript');
    const optionen = rest.slice('docker run '.length, start).replace(/\\\n/g, ' ');
    const skript = rest.slice(start + "/bin/sh -euc '".length, ende);
    const argumente = rest.slice(ende + 2, rest.indexOf('\n', ende)).trim();
    laeufe.push({ optionen, skript, argumente });
    rest = rest.slice(ende);
  }
  return laeufe;
}

// Containergrenzen (Nachtrag B2.1, Punkte 1 bis 4). Liefert die Liste der Verstoesse.
function containerGrenzen({ optionen, skript }, netz) {
  const v = [];
  const tokens = optionen.match(/"[^"]*"|\S+/g) ?? [];
  const werte = name => tokens.flatMap((t, i) => (t === name ? [tokens[i + 1]] : t.startsWith(`${name}=`) ? [t.slice(name.length + 1)] : []));
  for (const pflicht of ['--rm', '--pull=never', '--read-only']) if (!tokens.includes(pflicht)) v.push(`fehlt ${pflicht}`);
  if (werte('--cap-drop').join() !== 'ALL') v.push('cap-drop');
  if (werte('--security-opt').join() !== 'no-new-privileges') v.push('security-opt');
  if (werte('--network').join() !== netz) v.push('network');
  if (werte('--user').join() !== '"$(id -u):$(id -g)"') v.push('user');
  if (tokens.some(t => /^(-v|--volume|--env-file|--privileged|--cap-add|--device|-e|--ipc|--pid|--userns|--entrypoint|--add-host)(=|$)/.test(t))) v.push('verbotene Option');
  const tmpfs = werte('--tmpfs');
  if (tmpfs.length !== 1 || !/^\/tmp:rw,nosuid,nodev,noexec,size=\d+m,mode=1777$/.test(tmpfs[0] ?? '')) v.push('tmpfs');
  const mounts = werte('--mount');
  const soll = ['"type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly"', '"type=bind,src=$ergebnis,dst=/a6/ergebnis.md"'];
  if (JSON.stringify(mounts) !== JSON.stringify(soll)) v.push('mount');
  const env = werte('--env');
  if (JSON.stringify(env) !== JSON.stringify(['PATH=/usr/local/bin:/usr/bin:/bin', 'A6_LESE_TOKEN', 'A6_PRUEFER_LAUF', 'GITHUB_REPOSITORY'])) v.push('env');
  if (tokens.filter(t => t === '"$A6_NODE_IMAGE"').length !== 1) v.push('image');
  // Startskript: Reihenfolge fest, Integritaet vor dem Pruefskript.
  const zeilen = skript.split('\n').map(z => z.trim()).filter(Boolean);
  const pos = re => zeilen.findIndex(z => re.test(z));
  const reihe = [
    /^unset NODE_VERSION YARN_VERSION$/,
    /^if env \| grep -q "\^NODE_"; then echo "A6-START node-umgebung" >&2; exit 3; fi$/,
    /^\[ "\$\(node --version\)" = "\$1" \]/,
    /^printf "%s {2}%s\\n" "\$2" scripts\/agent-code-integritaet\.mjs \| sha256sum -c --status \|\| \{ echo "A6-START anker" >&2; exit 4; \}$/,
    /^node scripts\/agent-code-integritaet\.mjs \|\| exit 4$/,
    /^exec node (--import \.\/pruefer-probe\/github-attrappe\.mjs )?scripts\/agent-pruefer-vorpruefung\.mjs$/,
  ];
  const stellen = reihe.map(pos);
  if (stellen.some(s => s < 0)) v.push('startskript-schritt-fehlt');
  else if (stellen.some((s, i) => i > 0 && s <= stellen[i - 1])) v.push('startskript-reihenfolge');
  // Node startet genau zweimal (Integritaet, Pruefskript); dazu nur die Versionsabfrage. Jeder weitere Aufruf ist rot.
  if (zeilen.filter(z => /(^|[;|&(]\s*|\bexec\s+)node\s/.test(z) && !/^\[ "\$\(node --version\)"/.test(z)).length !== 2) v.push('startskript-weiterer-node-aufruf');
  if (/--import/.test(skript) && !(pos(/^printf "%s {2}%s\\n" "\$3" pruefer-probe\/github-attrappe\.mjs \| sha256sum -c --status/) > stellen[4])) v.push('vorladen-ohne-anker');
  return v;
}

// ---------------------------------------------------------------------------------------------------------------

test('Workflow: genehmigter Stand und Anker gleich agent-auftrag.yml', () => {
  const wf = WF();
  assert.equal(sha256(Buffer.from(wf, 'utf8')), A6_PRUEFER_WORKFLOW_SHA256, 'agent-pruefer.yml ist nicht der genehmigte Stand');
  const auftrag = lies(join(ROOT, '.github', 'workflows', 'agent-auftrag.yml'));
  for (const name of ['A6_FUNKTIONEN_SHA256', 'A6_INTEGRITAET_SHA256', 'A6_NODE_IMAGE', 'A6_NODE_VERSION']) {
    assert.equal(envWert(wf, name), envWert(auftrag, name), name);
  }
  assert.equal(envWert(wf, 'A6_FUNKTIONEN_SHA256'), sha256(readFileSync(join(ROOT, '.github', 'agent', 'a6-funktionen.sh'))));
  assert.equal(envWert(wf, 'A6_INTEGRITAET_SHA256'), sha256(readFileSync(join(ROOT, 'scripts', 'agent-code-integritaet.mjs'))));
  assert.equal(envWert(wf, 'A6_PRUEFER_ATTRAPPE_SHA256'), sha256(readFileSync(join(ROOT, 'pruefer-probe', 'github-attrappe.mjs'))));
  assert.match(envWert(wf, 'A6_NODE_IMAGE'), /^node@sha256:[0-9a-f]{64}$/);
  // Genau diese fuenf Werte auf oberster Ebene.
  const env = wf.split('\nenv:\n')[1].split('\n\n')[0].split('\n').map(z => z.split(':')[0].trim());
  assert.deepEqual(env, ['A6_FUNKTIONEN_SHA256', 'A6_INTEGRITAET_SHA256', 'A6_PRUEFER_ATTRAPPE_SHA256', 'A6_NODE_IMAGE', 'A6_NODE_VERSION']);
});

test('Workflow: Ausloeser, Bedingungen und Rechte; Start nur durch noah04091, nie durch das Bot-Konto', () => {
  const wf = WF();
  const on = wf.split('\non:\n')[1].split('\n\n')[0];
  assert.equal(on, [
    '  workflow_run:', '    workflows: [Agent-Auftrag]', '    types: [completed]',
    '  workflow_dispatch:', '    inputs:', '      lauf:', '        description: Lauf-ID des Agenten-Auftrags', '        required: true', '        type: string',
    '  pull_request:', '    branches: [main]', '    types: [opened, synchronize, reopened]',
  ].join('\n'));
  assert.match(wf, /\npermissions: \{\}\n/);
  const j = jobs(wf);
  assert.deepEqual(Object.keys(j), ['vorpruefung', 'probe_vorpruefung']);

  const bedingung = b => /\n {4}if: >-\n((?: {6}.*\n)+)/.exec(b)[1].replace(/\s+/g, ' ').trim();
  assert.equal(bedingung(j.vorpruefung), "github.repository == 'noah04091/agenten-probe' && github.ref == 'refs/heads/main' && "
    + "((github.event_name == 'workflow_run' && github.event.workflow_run.event == 'issues' && github.event.workflow_run.conclusion == 'success') || "
    + "(github.event_name == 'workflow_dispatch' && github.actor == 'noah04091' && github.triggering_actor == 'noah04091'))");
  assert.equal(bedingung(j.probe_vorpruefung), "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository");

  const rechte = b => /\n {4}permissions:\n((?: {6}.*\n)+)/.exec(b)[1].trim().split('\n').map(z => z.trim());
  assert.deepEqual(rechte(j.vorpruefung), ['actions: read', 'checks: read', 'contents: read', 'issues: read', 'pull-requests: read']);
  assert.deepEqual(rechte(j.probe_vorpruefung), ['contents: read']);
  assert.doesNotMatch(wf, /:\s*write\b|write-all|read-all/);

  // Checkout: nur github.sha, ohne Zugangsdaten. Kein Ref oder SHA des PR.
  const checkouts = [...wf.matchAll(/uses: actions\/checkout@([0-9a-f]{40})\n {8}with:\n {10}persist-credentials: false\n {10}ref: \$\{\{ github\.sha \}\}\n/g)];
  assert.equal(checkouts.length, 2);
  assert.equal([...wf.matchAll(/uses: /g)].length, 2, 'keine weitere Action');
  assert.doesNotMatch(wf, /head_ref|pull_request\.head\.sha|head\.ref|refs\/pull/);
  // Lauf-ID nur aus der Nutzlast oder der Eingabe, gepruefte Form vor jeder Verwendung.
  assert.ok(j.vorpruefung.includes("A6_PRUEFER_LAUF: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.id || inputs.lauf }}"));
  assert.ok(j.vorpruefung.includes('[[ "$A6_PRUEFER_LAUF" =~ ^[1-9][0-9]{0,15}$ ]] || { echo "A6-START lauf" >&2; exit 1; }'));
  assert.equal([...wf.matchAll(/\$\{\{ github\.token \}\}/g)].length, 1, 'Token nur im echten Pruefjob');
  assert.ok(j.vorpruefung.includes('A6_LESE_TOKEN: ${{ github.token }}'));
});

test('Workflow: Funktionsdatei erst nach dem Hashvergleich, Image mit Digest, Integritaetsfehler endet mit nicht-pruefbar und rot', () => {
  const j = jobs(WF());

  for (const b of [j.vorpruefung, j.probe_vorpruefung]) {
    const schritte = ["printf '%s  %s\\n' \"$A6_FUNKTIONEN_SHA256\" .github/agent/a6-funktionen.sh | sha256sum -c --status", 'source .github/agent/a6-funktionen.sh', 'a6_image_laden "$A6_NODE_IMAGE"', 'docker run '];
    const pos = schritte.map(s => b.indexOf(s));
    assert.ok(pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), `Reihenfolge ${pos}`);
    assert.ok(b.indexOf('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"') < pos[0]);
  }

  assert.ok(j.vorpruefung.includes(`if [[ "$rc" == "4" ]]; then`));
  assert.ok(j.vorpruefung.includes('echo "A6-PRUEFER repo noah04091/agenten-probe pr unbekannt kopf unbekannt basis unbekannt lauf $A6_PRUEFER_LAUF ergebnis nicht-pruefbar befunde 0 hinweise 0"'));
  assert.ok(/echo "A6-FEHLER integritaet"[\s\S]*?exit 1\n {10}fi\n {10}exit "\$rc"/.test(j.vorpruefung));
  // Bericht nur ueber die geprueften Ziele; nie "bestanden" oder "freigegeben".
  assert.equal([...WF().matchAll(/a6_bericht_ziel "\$\{GITHUB_STEP_SUMMARY:-\}"/g)].length, 2);
  assert.doesNotMatch(WF(), /bestanden|freigegeben/i);
  assert.ok(WF().includes('Dieser Bericht ist keine Freigabe. Über den Merge entscheidet Noah.'));
});

test('Containergrenzen: jeder docker run haelt die Grenzen ein; jede Regel erkennt ihren Verstoss (Muss-Treffer)', () => {
  const laeufe = dockerLaeufe(WF());
  assert.equal(laeufe.length, 2);
  assert.deepEqual(containerGrenzen(laeufe[0], 'bridge'), []);
  assert.deepEqual(containerGrenzen(laeufe[1], 'none'), []);
  assert.doesNotMatch(laeufe[0].skript, /--import|attrappe/, 'der echte Pruefjob laedt nichts vor');
  assert.equal(laeufe[0].argumente, 'a6 "$A6_NODE_VERSION" "$A6_INTEGRITAET_SHA256" || rc=$?');
  assert.match(laeufe[1].argumente, /^a6 "\$A6_NODE_VERSION" "\$A6_INTEGRITAET_SHA256" "\$A6_PRUEFER_ATTRAPPE_SHA256"\)"/);

  const l = laeufe[0];
  const ersetze = (a, b, feld = 'optionen') => ({ ...l, [feld]: l[feld].replace(a, b) });
  const rot = [
    ['zusaetzliche --env', ersetze('--env GITHUB_REPOSITORY', '--env GITHUB_REPOSITORY --env HOME'), 'env'],
    ['--env-file', ersetze('--env GITHUB_REPOSITORY', '--env GITHUB_REPOSITORY --env-file /tmp/x'), 'verbotene Option'],
    ['-e statt --env', ersetze('--env A6_PRUEFER_LAUF', '-e A6_PRUEFER_LAUF'), 'verbotene Option'],
    ['NODE_OPTIONS weitergereicht', ersetze('--env A6_PRUEFER_LAUF', '--env A6_PRUEFER_LAUF --env NODE_OPTIONS'), 'env'],
    ['Checkout beschreibbar', ersetze('dst=$GITHUB_WORKSPACE,readonly', 'dst=$GITHUB_WORKSPACE'), 'mount'],
    ['zweite beschreibbare Einhaengung', ersetze('--workdir', '--mount "type=bind,src=$RUNNER_TEMP,dst=$RUNNER_TEMP" --workdir'), 'mount'],
    ['-v', ersetze('--workdir', '-v /tmp:/x --workdir'), 'verbotene Option'],
    ['tmpfs ohne noexec', ersetze('nodev,noexec,', 'nodev,'), 'tmpfs'],
    ['zweites tmpfs', ersetze('--workdir', '--tmpfs /a6:rw --workdir'), 'tmpfs'],
    ['ohne --read-only', ersetze('--read-only ', ''), 'fehlt --read-only'],
    ['cap-drop fehlt', ersetze('--cap-drop ALL ', ''), 'cap-drop'],
    ['no-new-privileges fehlt', ersetze('--security-opt no-new-privileges ', ''), 'security-opt'],
    ['root', ersetze('--user "$(id -u):$(id -g)"', '--user 0:0'), 'user'],
    ['Netz host', ersetze('--network bridge', '--network host'), 'network'],
    ['privileged', ersetze('--rm ', '--rm --privileged '), 'verbotene Option'],
    ['Integritaet entfernt', ersetze('node scripts/agent-code-integritaet.mjs || exit 4\n', '', 'skript'), 'startskript-schritt-fehlt'],
    ['Anker entfernt', ersetze(/ *printf "%s {2}%s\\n" "\$2".*\n/, '', 'skript'), 'startskript-schritt-fehlt'],
    ['Integritaet nach dem Pruefskript', ersetze(/(node scripts\/agent-code-integritaet\.mjs \|\| exit 4)\n( *)(exec node scripts\/agent-pruefer-vorpruefung\.mjs)/, '$3\n$2$1', 'skript'), 'startskript'],
    ['Integritaet ohne Abbruch', ersetze('node scripts/agent-code-integritaet.mjs || exit 4', 'node scripts/agent-code-integritaet.mjs || true', 'skript'), 'startskript-schritt-fehlt'],
    ['NODE_-Pruefung entfernt', ersetze(/ *if env \| grep.*\n/, '', 'skript'), 'startskript-schritt-fehlt'],
    ['weiterer node-Aufruf', ersetze('exec node scripts/agent-pruefer-vorpruefung.mjs', 'node -e 1\n              exec node scripts/agent-pruefer-vorpruefung.mjs', 'skript'), 'startskript-weiterer-node-aufruf'],
    ['Vorladen im echten Job', ersetze('exec node scripts/', 'exec node --import ./pruefer-probe/github-attrappe.mjs scripts/', 'skript'), 'vorladen-ohne-anker'],
  ];

  for (const [was, lauf, erwartet] of rot) {
    const v = containerGrenzen(lauf, 'bridge');
    assert.ok(v.some(x => x.startsWith(erwartet)), `${was}: ${JSON.stringify(v)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Echte Ausfuehrung des Startskripts (ohne Docker): veraenderter Code bricht vor jeder Bewertung ab
// ---------------------------------------------------------------------------------------------------------------

const SH = spawnSync('sh', ['-c', 'command -v sha256sum >/dev/null && echo ja'], { encoding: 'utf8' });
const SH_DA = SH.status === 0 && SH.stdout.trim() === 'ja';

function kopie() {
  const dir = mkdtempSync(join(tmpdir(), 'a6-pruefer-start-'));
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'pruefer-probe'));
  cpSync(join(ROOT, 'pruefer-probe', 'github-attrappe.mjs'), join(dir, 'pruefer-probe', 'github-attrappe.mjs'));
  mkdirSync(join(dir, '.github', 'agent'), { recursive: true });
  // Policy mit genau den Hashes der Driftfixture (unabhaengig vom Eigentuemer-PR).
  const policy = JSON.parse(readFileSync(join(ROOT, '.github', 'agent', 'policy.json'), 'utf8'));
  policy.skript_hashes = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'agent-skript-hashes.json'), 'utf8'));
  writeFileSync(join(dir, '.github', 'agent', 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  return dir;
}

function starte(dir, lauf, extra = []) {
  const anker = sha256(readFileSync(join(ROOT, 'scripts', 'agent-code-integritaet.mjs')));
  return spawnSync('sh', ['-euc', lauf.skript, 'a6', process.version, anker, ...extra], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 60_000 });
}

test('Startskript echt: unveraendert erreicht es das Pruefskript; veraendertes Gate, Pruefskript oder Policy brechen mit Exitcode 4 vor jeder Bewertung ab', { skip: SH_DA ? false : 'sh oder sha256sum fehlt' }, () => {
  const [lauf, probe] = dockerLaeufe(WF());
  const faelle = [
    ['unveraendert', () => {}, 1, /^A6-FEHLER pruefer-umgebung/m],
    ['Gate-Modul veraendert', d => writeFileSync(join(d, 'scripts', 'agent-pruefer-gate.mjs'), `${readFileSync(join(d, 'scripts', 'agent-pruefer-gate.mjs'), 'utf8')}\n// x\n`), 4, /^A6-FEHLER integritaet-skript-hash$/m],
    ['Pruefskript veraendert', d => writeFileSync(join(d, 'scripts', 'agent-pruefer-vorpruefung.mjs'), `// x\n${readFileSync(join(d, 'scripts', 'agent-pruefer-vorpruefung.mjs'), 'utf8')}`), 4, /^A6-FEHLER integritaet-skript-hash$/m],
    ['Policy veraendert (Hash des Gate-Moduls)', d => {
      const p = join(d, '.github', 'agent', 'policy.json');
      const pol = JSON.parse(readFileSync(p, 'utf8'));
      pol.skript_hashes['scripts/agent-pruefer-gate.mjs'] = '0'.repeat(64);
      writeFileSync(p, `${JSON.stringify(pol, null, 2)}\n`);
    }, 4, /^A6-FEHLER integritaet-skript-hash$/m],
    ['Policy ohne Eintrag des Pruefskripts', d => {
      const p = join(d, '.github', 'agent', 'policy.json');
      const pol = JSON.parse(readFileSync(p, 'utf8'));
      delete pol.skript_hashes['scripts/agent-pruefer-vorpruefung.mjs'];
      writeFileSync(p, `${JSON.stringify(pol, null, 2)}\n`);
    }, 4, /^A6-FEHLER integritaet-skript-ohne-hash$/m],
    ['weiteres Skript unter scripts/', d => writeFileSync(join(d, 'scripts', 'agent-pruefer-hilfe.mjs'), 'export {};\n'), 4, /^A6-FEHLER integritaet-skript-ohne-hash$/m],
    ['Integritaetspruefer selbst veraendert', d => writeFileSync(join(d, 'scripts', 'agent-code-integritaet.mjs'), `${readFileSync(join(d, 'scripts', 'agent-code-integritaet.mjs'), 'utf8')}\n`), 4, /^A6-START anker$/m],
  ];

  for (const [was, aendern, code, meldung] of faelle) {
    const dir = kopie();
    try {
      aendern(dir);
      const r = starte(dir, lauf);
      assert.equal(r.status, code, `${was}: ${r.stderr}`);
      assert.match(r.stderr, meldung, was);
      assert.doesNotMatch(r.stdout, /A6-PRUEFER/, `${was}: keine Bewertung`);
      if (code === 4) assert.doesNotMatch(r.stderr, /pruefer-/, `${was}: Pruefskript nie gestartet`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Generalprobe: Anker der Attrappe falsch oder Attrappe veraendert: Abbruch nach der Integritaet, vor dem Start.
  const dir = kopie();
  try {
    writeFileSync(join(dir, 'pruefer-probe', 'github-attrappe.mjs'), `${readFileSync(join(dir, 'pruefer-probe', 'github-attrappe.mjs'), 'utf8')}\n`);
    const r = starte(dir, probe, [sha256(readFileSync(join(ROOT, 'pruefer-probe', 'github-attrappe.mjs')))]);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /^A6-START anker-attrappe$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
