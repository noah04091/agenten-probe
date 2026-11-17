// A6 P-1: Ersatz fuer Claude in der Generalprobe. Nur fuer die Probe, nie im Live-Pfad.
//
// Laeuft im Workflow in genau dem Container, in dem spaeter Claude laeuft: nur am internen Docker-Netz,
// nur der Arbeitsordner beschreibbar eingebunden, dieselbe Haertung. Statt eines Modells schreibt er ein
// festes Testpaket. Vorher prueft er von innen, was der Container sieht (K1b) und was der
// API-Vorschaltcontainer antwortet (C). Nur node:-Module, kein Netz ausser zum Vorschaltcontainer.
//
//   node claude-ersatz.mjs isolation <arbeit> <proxy-url> <platzhalter>
//       K1b und C pruefen, dann das Testpaket schreiben. Exitcode 0 nur, wenn alles wie erwartet war.
//   node claude-ersatz.mjs gegenprobe <pfad>
//       Gegenprobe zu K1b: Exitcode 0 nur, wenn die zusaetzlich eingebundene Datei sichtbar ist.
//
// Ausgabe: je Pruefung eine Zeile "ERSATZ-OK ..." oder "ERSATZ-FEHLER ...". Kein Wert aus der Umgebung
// wird ausgegeben, nur Namen.

import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPORT_ALT = 'module.exports = { addiere, subtrahiere, multipliziere };';
const EXPORT_NEU = 'function quadrat(a) {\n  return a * a;\n}\n\nmodule.exports = { addiere, subtrahiere, multipliziere, quadrat };';
const TEST_NEU = "\ntest('quadrat (Generalprobe)', () => {\n  assert.strictEqual(require('../src/rechne.js').quadrat(3), 9);\n});\n";

// Das feste Testpaket: dieselbe Aenderung wie ein erfolgreicher Auftrag fuer quadrat(x).
export function schreibeTestpaket(arbeit) {
  const rechne = join(arbeit, 'src', 'rechne.js');
  const alt = readFileSync(rechne, 'utf8');

  if (!alt.includes(EXPORT_ALT)) {
    throw new Error('Generalprobe: Exportzeile in src/rechne.js nicht gefunden');
  }

  writeFileSync(rechne, alt.replace(EXPORT_ALT, EXPORT_NEU));
  const testDatei = join(arbeit, 'test', 'rechne.test.js');
  const testAlt = readFileSync(testDatei, 'utf8');

  if (!/require\('node:test'\)|from 'node:test'/.test(testAlt) || !testAlt.includes('assert')) {
    throw new Error('Generalprobe: test/rechne.test.js hat nicht die erwartete Form');
  }

  writeFileSync(testDatei, `${testAlt}${TEST_NEU}`);
}

function dateienUnter(dir, rel = '') {
  const liste = [];

  for (const eintrag of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const pfad = rel === '' ? eintrag.name : `${rel}/${eintrag.name}`;
    liste.push(...(eintrag.isDirectory() ? dateienUnter(dir, pfad) : [pfad]));
  }

  return liste.sort();
}

async function scheitert(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function anfrage(url, methode, platzhalter) {
  const antwort = await fetch(url, {
    method: methode,
    headers: methode === 'POST' ? { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'client-darf-keinen-schluessel-setzen' } : {},
    body: methode === 'POST' ? JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await antwort.text();
  const koepfe = JSON.stringify([...antwort.headers]);
  return { status: antwort.status, text, leck: text.includes(platzhalter) || koepfe.includes(platzhalter) };
}

async function isolation(arbeit, proxy, platzhalter) {
  const fehler = [];
  const melde = (ok, text) => {
    process.stdout.write(`${ok ? 'ERSATZ-OK' : 'ERSATZ-FEHLER'} ${text}\n`);

    if (!ok) {
      fehler.push(text);
    }
  };

  // K1b: Dateisystem
  // Physische Trennung: Der Container sieht nur die Sicht mit genau den Profildateien. Der volle
  // Ausgangsbaum (a6-claude-arbeit) mit Abnahmen, .github/ und scripts/ liegt ausserhalb.
  const dateien = dateienUnter(arbeit);
  melde(JSON.stringify(dateien) === JSON.stringify(['src/rechne.js', 'test/rechne.test.js']), `Sicht enthaelt genau die Profildateien (${dateien.join(', ')})`);

  for (const pfad of ['agent-acceptance', '.github', 'scripts', 'agent-profiles', 'package.json', '.git']) {
    melde(!existsSync(join(arbeit, pfad)), `nicht sichtbar in der Sicht: ${pfad}`);
  }

  for (const pfad of ['/home/runner', '/github', '/__w', '/var/run/docker.sock', '/run/docker.sock', '/opt/hostedtoolcache']) {
    melde(!existsSync(pfad), `nicht sichtbar: ${pfad}`);
  }

  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).map(zeile => zeile.split(' ')[4]);
  const eigene = mounts.filter(punkt => !['/', '/proc', '/dev', '/sys', '/tmp', '/dev/shm', '/dev/pts', '/dev/mqueue', '/sys/fs/cgroup', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf'].includes(punkt) && !punkt.startsWith('/proc/') && !punkt.startsWith('/sys/') && !punkt.startsWith('/dev/'));
  melde(eigene.length > 0 && eigene.every(punkt => punkt === arbeit || punkt.startsWith('/opt/a6/') || punkt === '/opt/a6' || punkt === '/opt/claude-code'), `nur erlaubte Einhaengepunkte (${eigene.join(', ')})`);

  // K1b: Umgebung ohne Geheimnis, ohne Zugang zu GitHub
  const namen = Object.keys(process.env);
  melde(!namen.some(name => /^(GITHUB_|RUNNER_|ACTIONS_)/.test(name)), 'keine GitHub- oder Runner-Variablen');
  melde(namen.filter(name => /TOKEN|SECRET|PASSWORD|PRIVATE|API_?KEY|CREDENTIAL/i.test(name)).every(name => name === 'ANTHROPIC_API_KEY'), 'kein geheimer Name ausser dem Platzhalter');
  melde(process.env.ANTHROPIC_API_KEY !== undefined && !/^sk-ant-/.test(process.env.ANTHROPIC_API_KEY), 'Schluesselvariable ist nur ein Platzhalter');

  // K1b: Netz nur zum Vorschaltcontainer
  melde(await scheitert(() => lookup('github.com')), 'github.com nicht aufloesbar');
  melde(await scheitert(() => fetch('https://api.github.com/', { signal: AbortSignal.timeout(10_000) })), 'api.github.com nicht erreichbar');
  melde(await scheitert(() => fetch('https://api.anthropic.com/', { signal: AbortSignal.timeout(10_000) })), 'api.anthropic.com direkt nicht erreichbar');

  // C: Vorschaltcontainer
  for (const [pfad, methode, erwartet] of [
    ['/v1/messages', 'POST', 401],
    ['/v1/messages/count_tokens', 'POST', 401],
    ['/v1/messages', 'GET', 403],
    ['/v1/models', 'GET', 403],
    ['/v1/models', 'POST', 403],
    ['/v1/complete', 'POST', 403],
    ['/v1/messages/../models', 'POST', 403],
    ['/', 'GET', 403],
  ]) {
    try {
      const a = await anfrage(`${proxy}${pfad}`, methode, platzhalter);
      melde(a.status === erwartet && !a.leck, `Vorschaltcontainer ${methode} ${pfad}: ${a.status} (erwartet ${erwartet})${a.leck ? ', Platzhalter in der Antwort' : ''}`);
    } catch {
      melde(false, `Vorschaltcontainer ${methode} ${pfad}: keine Antwort`);
    }
  }

  if (fehler.length === 0) {
    schreibeTestpaket(arbeit);
    melde(true, 'Testpaket geschrieben');
  }

  return fehler.length === 0 ? 0 : 1;
}

async function cli([befehl, ...args]) {
  if (befehl === 'isolation' && args.length === 3) {
    return isolation(...args);
  }

  if (befehl === 'gegenprobe' && args.length === 1) {
    const sichtbar = existsSync(args[0]);
    process.stdout.write(`${sichtbar ? 'ERSATZ-OK' : 'ERSATZ-FEHLER'} Gegenprobe: zusaetzlich eingebundene Datei ${sichtbar ? 'sichtbar' : 'nicht sichtbar'}\n`);
    return sichtbar ? 0 : 1;
  }

  process.stderr.write('Generalprobe: unbekannter Aufruf\n');
  return 2;
}

if (import.meta.main === true) {
  process.exitCode = await cli(process.argv.slice(2));
}
