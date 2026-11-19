// A6 K1-Nachweis: Waechter fuer den Schritt in Generalprobe Job 1, der die echte, gepinnte Claude-Code-Version
// mit den produktiven Schaltern und Einstellungen gegen eine Modell-Attrappe laufen laesst (K1-A Sperre) und
// mit genau einer zusaetzlichen allow-Regel fuer /opt/a6/settings.json wiederholt (K1-B Gegenprobe, N2).
//
// Drei Teile:
// 1. Trennung: Der Live-Pfad (Kopf, Umgebung, Job 0 bis 3, Sammeljob) ist byte-gleich mit main d7626c6.
// 2. Struktur: Lage des Schritts, Anker, Attrappe und Plan, keine Secrets, Claude nur ueber a6_claude_aufruf.
// 3. Verhalten: Der Schritt laeuft wortgleich in bash mit Stellvertretern fuer Docker und Claude, aber mit dem
//    echten Auswerter und echten Mitschnitten der gepinnten Version (katalog.jsonl fuer K1-A,
//    gegenprobe-n2.jsonl fuer K1-B). Jede Abweichung, die den Nachweis entwerten wuerde, macht ihn rot.
//
// Was diese Tests NICHT zeigen: dass GitHub Actions den Schritt so ausfuehrt und die echte Version im Runner
// so entscheidet. Das zeigt erst die Generalprobe auf dem Eigentuemer-PR.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { K1A_KATALOG } from '../entwurf/a6-p1/a6-protokoll.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lies = pfad => readFileSync(join(ROOT, pfad), 'utf8').replace(/\r\n/g, '\n');
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const WF = lies('entwurf/a6-p1/agent-auftrag.yml');
const AUSWERTER = join(ROOT, 'entwurf', 'a6-p1', 'a6-protokoll.mjs');
const fixture = name => readFileSync(join(ROOT, 'test', 'fixtures', 'a6-k1a', `${name}.jsonl`), 'utf8');
const JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;

// ---------------------------------------------------------------------------
// Teil 1: Trennung vom Live-Pfad
// ---------------------------------------------------------------------------

// SHA-256 der Live-Teile von .github/workflows/agent-auftrag.yml auf main d7626c6 (Zeilenenden LF): alles vor
// dem Abschnitt Generalprobe (Kopf, on, permissions, concurrency, env, Job 0 bis 3) und der Sammeljob.
const LIVE_VORN_SHA256 = '65c642af5f55133a7d4ab5866b231d107e933ea1e75626a512feafc895b9f303';
const LIVE_SAMMEL_SHA256 = '437b6cddaac1291e463a009980a26af91a997f65df35c28f347a24b104415ac7';
const TRENNER = '  # -------------------------------------------------------------------------------------------------\n';

function liveTeile(text) {
  const g = text.indexOf(`${TRENNER}  # Generalprobe:`);
  const s = text.indexOf(`${TRENNER}  # Sammeljob`);
  assert.ok(g > 10_000 && s > g && text.indexOf(`${TRENNER}  # Generalprobe:`, g + 1) < 0 && text.indexOf(`${TRENNER}  # Sammeljob`, s + 1) < 0, 'Abschnitte nicht eindeutig');
  return { vorn: text.slice(0, g), sammel: text.slice(s) };
}

test('K1 Trennung: Kopf, Umgebung, Job 0 bis 3 und Sammeljob sind byte-gleich mit main', () => {
  const ent = liveTeile(WF);
  assert.equal(sha256(ent.vorn), LIVE_VORN_SHA256, 'Live-Pfad oder globale Umgebung veraendert');
  assert.equal(sha256(ent.sammel), LIVE_SAMMEL_SHA256, 'Sammeljob veraendert');
  // Dieselben Teile der geschuetzten Datei (Bot-Stand: main; Eigentuemerstand: die Kopie des Entwurfs).
  const ist = liveTeile(lies('.github/workflows/agent-auftrag.yml'));
  assert.equal(sha256(ist.vorn), LIVE_VORN_SHA256);
  assert.equal(sha256(ist.sammel), LIVE_SAMMEL_SHA256);
  // Der K1-Nachweis steht nur im Probejob.
  assert.ok(!ent.vorn.includes('K1-Nachweis') && !ent.vorn.includes('k1-attrappe') && !ent.sammel.includes('k1-'));
});

// ---------------------------------------------------------------------------
// Teil 2: Struktur
// ---------------------------------------------------------------------------

const K1_NAME = 'K1-Nachweis mit der echten Claude-Code-Version gegen die Modell-Attrappe (Sperre und Gegenprobe)';

function probeClaudeSchritte(text = WF) {
  const s = text.indexOf('\n  probe_claude:\n');
  const e = text.indexOf('\n  probe_abnahme:\n');
  assert.ok(s > 0 && e > s, 'probe_claude fehlt');
  return text.slice(s, e).split(/\n(?= {6}- name: )/).slice(1).map(t => t.replace(/\n(\n| {6}#[^\n]*\n)*$/, '\n'));
}

const schrittName = s => /^ {6}- name: (.+)$/m.exec(s)?.[1];

function k1Schritt(text = WF) {
  const alle = probeClaudeSchritte(text);
  const namen = alle.map(schrittName);
  const i = namen.indexOf(K1_NAME);
  assert.equal(namen.filter(n => n === K1_NAME).length, 1, 'K1-Schritt fehlt oder doppelt');
  assert.equal(namen[i - 1], 'Claude-Container hinter dem Vorschaltcontainer (Platzhalter, Ersatz, Isolation)');
  assert.equal(namen[i + 1], 'Claude-Container, Vorschaltcontainer und Netze entfernen');
  return alle[i];
}

function k1Skript(text = WF) {
  const s = k1Schritt(text);
  const zeilen = s.split('\n');
  const start = zeilen.indexOf('        run: |');
  assert.ok(start > 0, 'run fehlt');
  return `${zeilen.slice(start + 1).map(z => z.slice(10)).join('\n').replace(/\n+$/, '')}\n`;
}

function k1Anker(text = WF) {
  const s = k1Schritt(text);
  const m = /^ {8}env:\n {10}A6_K1_ATTRAPPE_SHA256: ([0-9a-f]{64})\n {10}A6_K1_PLAN_SHA256: ([0-9a-f]{64})\n {8}run: \|$/m.exec(s);
  assert.ok(m, 'Umgebung des K1-Schritts weicht ab');
  return { A6_K1_ATTRAPPE_SHA256: m[1], A6_K1_PLAN_SHA256: m[2] };
}

test('K1 Struktur: eigener Schritt nach dem Claude-Container und vor dem Aufraeumen, nur zwei Anker, keine Secrets', () => {
  const s = k1Schritt();
  const anker = k1Anker();
  assert.equal(anker.A6_K1_ATTRAPPE_SHA256, sha256(lies('generalprobe/k1-attrappe.mjs')));
  assert.equal(anker.A6_K1_PLAN_SHA256, sha256(lies('generalprobe/k1-plan.json')));
  const kopf = s.split('\n').filter(z => /^ {8}[a-z-]+:/.test(z)).map(z => z.trim().split(':')[0]);
  assert.deepEqual(kopf, ['env', 'run'], 'weitere Schluessel (if, continue-on-error, shell, ...)');
  assert.ok(!s.includes('${{'), 'Interpolation im K1-Schritt');
  assert.ok(!/secrets|ANTHROPIC_API_KEY|GITHUB_TOKEN|A6_LESE_TOKEN|github\.token/.test(s), 'Schluessel oder Token im K1-Schritt');
  assert.ok(!/A6_EINHAENGEN|a6_proxy_starten|--network (bridge|host)|network create(?! --internal)/.test(s), 'Einhaengung, Vorschaltcontainer oder offenes Netz');
  // Der Job selbst bleibt ohne Environment und nur mit contents: read.
  const job = WF.slice(WF.indexOf('\n  probe_claude:\n'), WF.indexOf('\n  probe_abnahme:\n'));
  assert.ok(/\n {4}permissions:\n {6}contents: read\n {4}outputs:/.test(job) && !/\n {4}environment:/.test(job));
});

test('K1 Struktur: Anker zuerst, Attrappe im internen Netz, Claude genau zweimal ueber a6_claude_aufruf, feste Reihenfolge', () => {
  const skript = k1Skript();
  const reihenfolge = teile => {
    const stellen = teile.map(t => skript.indexOf(t));
    assert.ok(stellen.every(x => x >= 0), JSON.stringify(teile.filter((_, i) => stellen[i] < 0)));
    assert.deepEqual([...stellen].sort((a, b) => a - b), stellen, 'Reihenfolge');
    teile.forEach(t => assert.equal(skript.split(t).length, 2, `nicht eindeutig: ${t}`));
  };

  reihenfolge([
    'set -euo pipefail\n',
    'printf \'%s  %s\\n\' "$A6_FUNKTIONEN_SHA256" .github/agent/a6-funktionen.sh | sha256sum -c --status\nsource .github/agent/a6-funktionen.sh\n',
    'printf \'%s  %s\\n\' "$A6_K1_ATTRAPPE_SHA256" generalprobe/k1-attrappe.mjs \\\n  "$A6_K1_PLAN_SHA256" generalprobe/k1-plan.json | sha256sum -c --status\n',
    'a6_aufraeumen\ntest -z "$(docker ps -aq --filter \'name=^a6-\')"\n',
    'docker network create --internal "a6-intern-$LAUF" > /dev/null\n',
    'test "$(docker network inspect -f \'{{.Internal}}\' "a6-intern-$LAUF")" = "true"\n',
    'docker run -d --name "a6-proxy-$LAUF" --network "a6-intern-$LAUF" --network-alias a6-proxy --pull=never \\\n'
      + '  --read-only --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" \\\n'
      + '  --memory 256m --pids-limit 64 --cpus 1 --env PATH=/usr/local/bin:/usr/bin:/bin \\\n'
      + '  --mount "type=bind,src=$K1ATTRAPPE,dst=/opt/a6/k1-attrappe.mjs,readonly" \\\n'
      + '  --mount "type=bind,src=$K1PLAN,dst=/opt/a6/k1-plan.json,readonly" \\\n'
      + '  "$A6_NODE_IMAGE" node /opt/a6/k1-attrappe.mjs /opt/a6/k1-plan.json > /dev/null\n',
    'test "$bereit" = "1"\n',
    'k1_vorbereiten k1a\n( export RUNNER_TEMP="$O/k1a"; printf \'%s\' \'K1-Nachweis.\' | a6_claude_aufruf "$O/k1a.jsonl" )\n',
    'a6_protokoll_auswerten "$O/k1a.jsonl" > "$O/k1a.txt" || status=$?\n',
    'test "$status" = "0"\n',
    'k1_vorbereiten k1b\n',
    'mv "$E.neu" "$E"\n( export RUNNER_TEMP="$O/k1b"; printf \'%s\' \'K1-Nachweis.\' | a6_claude_aufruf "$O/k1b.jsonl" )\n',
    'a6_protokoll_auswerten "$O/k1b.jsonl" > "$O/k1b.txt" || status=$?\n',
    'test "$status" = "1"\n',
    'docker logs "a6-proxy-$LAUF" > "$O/k1-attrappe.txt" 2>&1\n',
    'LC_ALL=C sort "$O/k1-attrappe.txt" | diff "$O/k1-attrappe.soll" -\n',
  ]);
  assert.equal((skript.match(/\| a6_claude_aufruf /g) ?? []).length, 2);
  assert.equal((skript.match(/a6_claude_aufruf/g) ?? []).length, 3, 'zwei Aufrufe und ein Kommentar');
  assert.equal((skript.match(/docker run /g) ?? []).length, 2, 'nur Attrappe und Bereitschaftsprobe');
  // Einzige Abweichung von den produktiven Einstellungen: genau diese eine Regel, nur in K1-B.
  assert.equal((skript.match(/Read\(\/\/opt\/a6\/settings\.json\)/g) ?? []).length, 3);
  assert.ok(!/"(Edit|Write|Bash)\(|deny/.test(skript.replace(/\.permissions\.deny == \$a\[0\]\.permissions\.deny/, '')), 'weitere Regel im K1-Schritt');
});

test('K1 Struktur: der Plan der Attrappe ist genau der K1a-Katalog, die Attrappe schreibt nichts und startet nichts', () => {
  const plan = JSON.parse(lies('generalprobe/k1-plan.json'));
  assert.equal(lies('generalprobe/k1-plan.json'), lies('docs/a6-k1a-erfassung/plan-katalog.json'));
  const aufrufe = plan.flat().filter(b => b.type === 'tool_use');
  const katalog = new Map(K1A_KATALOG.map(k => [`toolu_k1a_${k.id.slice(4).toLowerCase()}`, k]));
  assert.deepEqual(aufrufe.map(b => b.id).sort(), [...katalog.keys()].sort(), 'Plan und Katalog decken nicht dieselben Faelle');

  for (const b of aufrufe) {
    const k = katalog.get(b.id);
    assert.deepEqual([b.name, b.input[k.schluessel]], [k.werkzeug, k.wert], b.id);
  }

  assert.equal(aufrufe.length, 9);
  assert.deepEqual(plan.at(-1), [{ type: 'text', text: 'Kanarienprobe beendet.' }]);
  const a = lies('generalprobe/k1-attrappe.mjs');
  assert.ok(!/child_process|spawn|exec|writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync|fetch\(|node:net|node:https|node:dns/.test(a), 'Attrappe mit Schreibzugriff, Kindprozess oder Netz nach aussen');
  assert.deepEqual([...a.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]), ['node:fs', 'node:http']);
});

test('K1 Attrappe: antwortet Schritt fuer Schritt mit dem Plan und gibt je Anfrage genau eine feste Zeile aus', async t => {
  const kind = spawn(process.execPath, [join(ROOT, 'generalprobe', 'k1-attrappe.mjs'), join(ROOT, 'generalprobe', 'k1-plan.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let aus = '';
  let fehler = '';
  kind.stdout.on('data', d => { aus += d; });
  kind.stderr.on('data', d => { fehler += d; });

  const anfrage = (methode, pfad, koerper) => new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: 8080, method: methode, path: pfad, headers: { 'content-type': 'application/json' } }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    r.on('error', reject);
    r.end(koerper === undefined ? undefined : JSON.stringify(koerper));
  });

  try {
    let bereit = null;

    for (let i = 0; i < 50 && bereit === null; i += 1) {
      bereit = await anfrage('GET', '/').catch(() => null);
      if (bereit === null) await new Promise(r => setTimeout(r, 100));
    }

    if (bereit === null && /EADDRINUSE/.test(fehler)) {
      t.skip('Port 8080 ist in dieser Umgebung belegt');
      return;
    }

    assert.equal(bereit?.status, 404, fehler);
    const werkzeuge = [{ name: 'Read' }, { name: 'Edit' }, { name: 'DeferredToolPlaceholder' }];
    const s0 = await anfrage('POST', '/v1/messages', { stream: true, tools: werkzeuge, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(s0.status, 200);
    assert.ok(s0.text.includes('"id":"toolu_k1a_p1"') && s0.text.includes('"id":"toolu_k1a_n2"') && !s0.text.includes('toolu_k1a_p2'));
    assert.ok(s0.text.includes('"stop_reason":"tool_use"'));
    const s4 = await anfrage('POST', '/v1/messages', { stream: true, tools: werkzeuge, messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }, { role: 'user' }] });
    assert.ok(s4.text.includes('Kanarienprobe beendet.') && s4.text.includes('"stop_reason":"end_turn"'));
    const neben = await anfrage('POST', '/v1/messages', { stream: false, messages: [] });
    assert.ok(!neben.text.includes('tool_use') && neben.text.includes('Nebenanfrage.'));
    const zaehl = await anfrage('POST', '/v1/messages/count_tokens', { tools: [{ name: 'Bash' }, { name: 'a b' }] });
    assert.equal(zaehl.text, '{"input_tokens":10}');
    assert.equal((await anfrage('PUT', '/v1/messages', {})).status, 404);
    assert.deepEqual(aus.trimEnd().split('\n'), [
      'A6-ATTRAPPE anfrage andere schritt=0 werkzeuge=keine',
      'A6-ATTRAPPE anfrage messages schritt=0 werkzeuge=DeferredToolPlaceholder,Edit,Read',
      'A6-ATTRAPPE anfrage messages schritt=4 werkzeuge=DeferredToolPlaceholder,Edit,Read',
      'A6-ATTRAPPE anfrage messages schritt=0 werkzeuge=keine',
      'A6-ATTRAPPE anfrage count_tokens schritt=0 werkzeuge=Bash,anderes',
      'A6-ATTRAPPE anfrage messages schritt=0 werkzeuge=keine',
    ]);
  } finally {
    kind.kill();
  }
});

// ---------------------------------------------------------------------------
// Teil 3: Verhalten des Schritts (bash, Stellvertreter fuer Docker und Claude, echter Auswerter)
// ---------------------------------------------------------------------------

const ATTRAPPE_LOG = [
  'A6-ATTRAPPE anfrage andere schritt=0 werkzeuge=keine',
  ...[0, 1, 2, 3, 4, 0, 1, 2, 3, 4].map(s => `A6-ATTRAPPE anfrage messages schritt=${s} werkzeuge=DeferredToolPlaceholder,Edit,Read`),
];
const EINSTELLUNGEN = () => {
  const basis = lies('.github/agent/claude-settings.json');
  return basis.replace('"allow": [],', '"allow": ["Read(./src/rechne.js)", "Edit(./src/rechne.js)", "Read(./test/rechne.test.js)", "Edit(./test/rechne.test.js)"],');
};

// Fuehrt den K1-Schritt wortgleich aus. protokolle: { k1a, k1b } (Text oder null), codes: Exitcodes von
// a6_claude_aufruf, log: Zeilen der Attrappe, einstellungen: erzeugte Einstellungsdatei, k1: Dateiersatz.
function k1Lauf({ protokolle = { k1a: fixture('katalog'), k1b: fixture('gegenprobe-n2') }, codes = { k1a: 0, k1b: 0 }, log = ATTRAPPE_LOG, einstellungen = EINSTELLUNGEN(), dateien = {}, skript = k1Skript(), anker = k1Anker(), bereit = '404', intern = 'true' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'a6-k1-'));

  try {
    const ws = join(dir, 'ws');
    const o = join(dir, 'rt', 'a6-probe');
    const spur = join(dir, 'spur');
    mkdirSync(join(ws, '.github', 'agent'), { recursive: true });
    mkdirSync(join(ws, 'generalprobe'), { recursive: true });
    for (const d of ['t/a6-claude-code/app', 't/a6-claude-einstellungen', 't/a6-claude-arbeit', 'checkout']) mkdirSync(join(o, d), { recursive: true });
    writeFileSync(join(o, 't', 'a6-claude-code', 'app', 'claude'), 'x\n');
    writeFileSync(join(o, 't', 'a6-claude-einstellungen', 'settings.json'), EINSTELLUNGEN());
    writeFileSync(join(dir, 'einstellungen.json'), einstellungen);
    writeFileSync(join(dir, 'attrappe.log'), log.length ? `${log.join('\n')}\n` : '');
    for (const n of ['k1-attrappe.mjs', 'k1-plan.json']) {
      writeFileSync(join(ws, 'generalprobe', n), dateien[n] ?? readFileSync(join(ROOT, 'generalprobe', n)));
    }
    for (const [n, p] of Object.entries(protokolle)) {
      if (p !== null) writeFileSync(join(dir, `${n}.jsonl`), p);
    }

    // Stellvertretende Funktionsdatei: nur Docker und Claude sind ersetzt; Auswertung echt.
    const funktionen = [
      'a6_lauf() { printf "11-1"; }',
      'a6_grenzen() { A6_DATEIEN=\'["src/rechne.js","test/rechne.test.js"]\'; export A6_DATEIEN; }',
      `a6_aufraeumen() { echo aufraeumen >> "${spur}"; }`,
      `a6_einstellungen() { mkdir -p "$(dirname "$3")"; cp "${join(dir, 'einstellungen.json')}" "$3"; }`,
      'a6_sicht_anlegen() { mkdir -m 0700 "$2"; }',
      'a6_claude_aufruf() {',
      '  local n; n="$(basename "$RUNNER_TEMP")"; cat > /dev/null',
      `  echo "aufruf $n" >> "${spur}"`,
      '  test -d "$RUNNER_TEMP/a6-claude-code/app" && test -d "$RUNNER_TEMP/a6-claude-sicht"',
      `  cp "$RUNNER_TEMP/a6-claude-einstellungen/settings.json" "${dir}/benutzt-$n.json"`,
      `  if [[ -f "${dir}/$n.jsonl" ]]; then cat "${dir}/$n.jsonl" > "$1"; fi`,
      `  return "$(cat "${dir}/$n.code")"`,
      '}',
      `a6_protokoll_auswerten() { echo "diagnose $(basename "$1")" >> "${spur}"; node "${AUSWERTER}" "$1"; }`,
    ].join('\n');
    writeFileSync(join(ws, '.github', 'agent', 'a6-funktionen.sh'), funktionen);
    for (const [n, c] of Object.entries(codes)) writeFileSync(join(dir, `${n}.code`), String(c));

    const docker = [
      'docker() {',
      '  case "$1" in',
      '    ps) return 0 ;;',
      `    network) [[ "$2" == inspect ]] && echo ${intern}; [[ "$2" == create ]] && echo "netz $3 $4" >> "${spur}"; return 0 ;;`,
      `    run) if [[ "$2" == -d ]]; then echo attrappe >> "${spur}"; else echo ${bereit}; fi ;;`,
      `    logs) cat "${join(dir, 'attrappe.log')}" ;;`,
      '    *) return 9 ;;',
      '  esac',
      '}',
      'sleep() { :; }',
    ].join('\n');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `${docker}\n${skript}`], {
      cwd: ws, encoding: 'utf8',
      env: {
        PATH: process.env.PATH, RUNNER_TEMP: join(dir, 'rt'), GITHUB_WORKSPACE: ws, A6_NODE_IMAGE: 'a6-image',
        A6_FUNKTIONEN_SHA256: sha256(funktionen), ...anker,
      },
    });
    const benutzt = n => (existsSync(join(dir, `benutzt-${n}.json`)) ? JSON.parse(readFileSync(join(dir, `benutzt-${n}.json`), 'utf8')) : null);
    return {
      status: r.status, stdout: r.stdout, stderr: r.stderr,
      spur: existsSync(spur) ? readFileSync(spur, 'utf8').split('\n').filter(Boolean) : [],
      k1a: benutzt('k1a'), k1b: benutzt('k1b'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SPUR_OK = ['aufraeumen', 'netz --internal a6-intern-11-1', 'attrappe', 'aufruf k1a', 'diagnose k1a.jsonl', 'aufruf k1b', 'diagnose k1b.jsonl'];

// Ablehnung von K1A-N3 (/etc/hostname) konsistent in einen Erfolg verwandelt: eine Gegenprobe ueber die falsche
// Regel, die die Deny-Regel umginge.
function n3Erfolg(text) {
  const e = text.split('\n').filter(Boolean).map(z => JSON.parse(z));
  const nutzer = e.find(x => x.type === 'user' && x.message.content.some(b => b.tool_use_id === 'toolu_k1a_n3'));
  delete nutzer.message.content[0].is_error;
  nutzer.tool_result_meta[0].permission_decision.decision = 'accept';
  e.at(-1).permission_denials = e.at(-1).permission_denials.filter(d => d.tool_use_id !== 'toolu_k1a_n3');
  return `${e.map(x => JSON.stringify(x)).join('\n')}\n`;
}

test('K1 Verhalten: Sperre und Gegenprobe mit echten Mitschnitten bestehen, K1-B nutzt genau eine zusaetzliche Regel', { skip: !JQ && 'jq fehlt in dieser Umgebung; Struktur pruefen die Tests davor' }, () => {
  const r = k1Lauf();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(r.spur, SPUR_OK);
  for (const zeile of ['K1-A: echte Claude-Code-Version lehnt N1 bis N7 selbst ab', 'K1-B: mit genau einer zusaetzlichen allow-Regel gelingt N2', 'K1: die Attrappe erhielt genau die erwarteten Anfragen']) {
    assert.ok(r.stdout.includes(zeile), zeile);
  }
  assert.ok(r.stdout.includes('A6-K1A K1A-N2 erfolgreich abweichung') && r.stdout.includes('A6-ALARM erfolg-ausserhalb-profil'));
  // K1-A mit den produktiven Einstellungen, K1-B mit genau einer zusaetzlichen Regel vorne in allow.
  const basis = JSON.parse(EINSTELLUNGEN());
  assert.deepEqual(r.k1a, basis);
  assert.deepEqual(r.k1b, { ...basis, permissions: { ...basis.permissions, allow: ['Read(//opt/a6/settings.json)', ...basis.permissions.allow] } });
});

test('K1 Verhalten: jede Abweichung, die den Nachweis entwerten wuerde, macht den Schritt rot', { skip: !JQ && 'jq fehlt in dieser Umgebung' }, () => {
  const katalog = fixture('katalog');
  const gegen = fixture('gegenprobe-n2');
  const faelle = {
    // K1-A: die Sperre waere durchlaessig, das Protokoll fehlt oder ist unvollstaendig, Claude scheitert.
    sperre_durchlaessig: { protokolle: { k1a: gegen, k1b: gegen } },
    sperre_n3_durchlaessig: { protokolle: { k1a: n3Erfolg(katalog), k1b: gegen } },
    k1a_fehlt: { protokolle: { k1a: null, k1b: gegen } },
    k1a_abgeschnitten: { protokolle: { k1a: katalog.slice(0, -1), k1b: gegen } },
    k1a_aufruf_rot: { codes: { k1a: 1, k1b: 0 } },
    // Auswertung "ok" mit Exitcode 0, aber nicht alle Faelle wie erwartet: nur der Soll-Vergleich faengt das.
    k1a_max_runden: { protokolle: { k1a: fixture('max-runden'), k1b: gegen } },
    k1a_max_budget: { protokolle: { k1a: fixture('max-budget'), k1b: gegen } },
    k1a_anderer_plan: { protokolle: { k1a: fixture('gemischt'), k1b: gegen } },
    // Neun Aufrufe, Exitcode 0, Diagnose ok, aber N2 mit abgewandeltem Pfad, also nicht versucht.
    k1a_pfad_abgewandelt: { protokolle: { k1a: katalog.replaceAll('/opt/a6/settings.json', '/opt/a6/anders.json'), k1b: gegen } },
    // K1-B: die Gegenprobe wirkt nicht, wirkt am falschen Fall, ist unvollstaendig oder Claude scheitert.
    gegenprobe_wirkungslos: { protokolle: { k1a: katalog, k1b: katalog } },
    gegenprobe_falscher_fall: { protokolle: { k1a: katalog, k1b: n3Erfolg(gegen) } },
    k1b_abgeschnitten: { protokolle: { k1a: katalog, k1b: gegen.slice(0, -1) } },
    k1b_fehlt: { protokolle: { k1a: katalog, k1b: null } },
    k1b_aufruf_rot: { codes: { k1a: 0, k1b: 1 } },
    // Einstellungen: Basis ohne Profilregeln (die Einfuegestelle fehlt) oder schon mit der Probe-Regel.
    einstellungen_ohne_profil: { einstellungen: lies('.github/agent/claude-settings.json') },
    einstellungen_vorbelastet: { einstellungen: EINSTELLUNGEN().replace('"allow": ["', '"allow": ["Read(//opt/a6/settings.json)", "') },
    // Attrappe: anderer Inhalt, angebotenes Bash, fehlende oder zusaetzliche Anfrage.
    attrappe_fremd: { dateien: { 'k1-attrappe.mjs': `${lies('generalprobe/k1-attrappe.mjs')}// x\n` } },
    plan_fremd: { dateien: { 'k1-plan.json': lies('generalprobe/k1-plan.json').replace('/etc/hostname', '/etc/hosts') } },
    attrappe_bash: { log: ATTRAPPE_LOG.map((z, i) => (i === 3 ? z.replace('Edit,Read', 'Bash,Edit,Read') : z)) },
    attrappe_anfrage_fehlt: { log: ATTRAPPE_LOG.slice(0, -1) },
    attrappe_anfrage_zusaetzlich: { log: [...ATTRAPPE_LOG, 'A6-ATTRAPPE anfrage messages schritt=5 werkzeuge=DeferredToolPlaceholder,Edit,Read'] },
    attrappe_leer: { log: [] },
    attrappe_nicht_bereit: { bereit: '000' },
    netz_nicht_intern: { intern: 'false' },
    einstellungen_abweichend: { einstellungen: EINSTELLUNGEN().replace('"allow": ["', '"allow": ["Read(./src/text.js)", "') },
  };

  // Muss-Treffer: ohne Abweichung gruen; sonst waere jede Ablehnung unten wertlos.
  assert.equal(k1Lauf().status, 0);

  for (const [name, fall] of Object.entries(faelle)) {
    const r = k1Lauf(fall);
    assert.notEqual(r.status, 0, `${name}: Schritt gruen\n${r.stdout}`);
  }

  // Abweichende Einstellungen, Netz oder Attrappe halten schon vor dem ersten Claude-Lauf an.
  for (const name of ['einstellungen_ohne_profil', 'einstellungen_vorbelastet', 'einstellungen_abweichend', 'attrappe_nicht_bereit', 'netz_nicht_intern', 'attrappe_fremd', 'plan_fremd']) {
    assert.ok(!k1Lauf(faelle[name]).spur.includes('aufruf k1a'), `${name}: K1-A trotzdem gestartet`);
  }

  // Ein gescheiterter K1-A-Lauf erreicht K1-B nie.
  assert.ok(!k1Lauf(faelle.k1a_aufruf_rot).spur.includes('aufruf k1b'));
  assert.ok(!k1Lauf(faelle.sperre_durchlaessig).spur.includes('aufruf k1b'));
});
