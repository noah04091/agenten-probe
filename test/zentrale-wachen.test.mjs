// B1.1 Command Center: statische Wachen ueber werkzeuge/zentrale/ und die Zentrale-Tests.
//   W1  nur github-lesen.mjs ruft fetch, Methode fest GET, keine schreibende Methode
//   W2  kein Kindprozess, kein gh, keine Umgebungsvariable mit Token, kein Credential-Helper
//   W10 jeder Zentrale-Test ersetzt fetch durch eine Attrappe, die bei echtem Aufruf wirft
//   W11 jeder Code in fehlercodes.mjs (beide Listen) steht woertlich in ausfuehrbarem Code in scripts/ oder .github/agent/
//   W12 zentrale.mjs liest ausser lese-token, cache.json, fristen.json und dem Sitzungsordner keine Datei (B1.3)
//   W13 echtprobe.mjs liest ausser dem Token (token.mjs) nur echtprobe-soll.json und schreibt keine Datei (B1.3a)
// Dazu: werkzeuge/zentrale/ enthaelt genau die vereinbarten Dateien, keine Links.
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BEKANNTE_CODES, FEHLERCODES } from '../werkzeuge/zentrale/fehlercodes.mjs';
import { erzeugeLeser } from '../werkzeuge/zentrale/github-lesen.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ZENTRALE = join(ROOT, 'werkzeuge', 'zentrale');
const DATEIEN = Object.freeze(['LIESMICH.md', 'darstellung.mjs', 'daten.mjs', 'echtprobe.mjs', 'fehlercodes.mjs', 'github-lesen.mjs', 'log-auszug.mjs', 'sitzungen-meta.mjs', 'token.mjs', 'zentrale.mjs']);
const TESTS = Object.freeze(['zentrale-darstellung', 'zentrale-daten', 'zentrale-github-lesen', 'zentrale-log-auszug', 'zentrale-sitzungen', 'zentrale-token', 'zentrale-wachen'].map(n => `${n}.test.mjs`));
const ATTRAPPE = "globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };";
const lies = datei => readFileSync(join(ZENTRALE, datei), 'utf8');
const module = () => DATEIEN.filter(d => d.endsWith('.mjs'));
// Kommentare entfernen, damit Erklaerungen im Kopf nicht zaehlen (Code-Zeilen mit // in Zeichenketten bleiben).
const code = text => text.split('\n').filter(z => !/^\s*\/\//.test(z)).join('\n');

test('Dateigrenze: werkzeuge/zentrale enthaelt genau die vereinbarten Dateien, keine Links, keine Unterordner', () => {
  assert.deepEqual(readdirSync(ZENTRALE).sort(), [...DATEIEN].sort());

  for (const d of DATEIEN) {
    const st = lstatSync(join(ZENTRALE, d));
    assert.ok(st.isFile() && !st.isSymbolicLink(), d);
  }

  const fixtures = [];
  const geh = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!e.isSymbolicLink(), e.name);
      e.isDirectory() ? geh(join(dir, e.name)) : fixtures.push(e.name);
    }
  };
  geh(join(ROOT, 'test', 'fixtures', 'zentrale'));
  assert.ok(fixtures.length >= 10, 'Muss-Treffer: Fixtures vorhanden');
  assert.ok(fixtures.every(f => /\.(json|txt)$/.test(f)), 'Fixtures nur .json und .txt (nie als Test ausgefuehrt)');
});

test('W1: nur github-lesen.mjs ruft fetch; dort jede Methode GET; nirgends POST, PATCH, PUT, DELETE', () => {
  const g = code(lies('github-lesen.mjs'));
  const methoden = [...g.matchAll(/method\s*:\s*([^,}\n]+)/g)].map(m => m[1].trim());
  assert.ok(methoden.length >= 2, 'Muss-Treffer: Methoden in github-lesen.mjs');
  assert.ok(methoden.every(m => m === "'GET'"), methoden.join(' '));
  assert.ok((g.match(/fetchImpl\(/g) ?? []).length >= 2, 'Muss-Treffer: Aufrufe ueber fetchImpl');

  for (const d of module()) {
    const t = code(lies(d));
    assert.ok(!/\b(POST|PATCH|PUT|DELETE)\b/.test(t), `${d}: schreibende Methode`);
    assert.ok(!/\bmethod\s*:/.test(t) || d === 'github-lesen.mjs', `${d}: method ausserhalb von github-lesen.mjs`);
    assert.ok(!/\bfetch\b|fetchImpl|XMLHttpRequest|node:https?|node:net|node:dns|node:tls|WebSocket/.test(t) || d === 'github-lesen.mjs', `${d}: Netzzugriff`);
  }
});

test('W2: kein Kindprozess, kein gh, keine Token-Umgebungsvariable, kein Credential-Helper', () => {
  for (const d of module()) {
    const t = code(lies(d));
    assert.ok(!/child_process|node:worker_threads|node:vm|(?<!\.)\b(spawn|exec|execFile|execSync|fork)\s*\(/.test(t), `${d}: Kindprozess`);
    assert.ok(!/GH_TOKEN|GITHUB_TOKEN|process\.env|\bgh\s+auth\b|hosts\.yml|\.config[\\/]gh|credential/i.test(t), `${d}: andere Anmeldung`);
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(t), `${d}: dynamischer Code`);
  }

  // Muss-Treffer: das Muster erkennt den verbotenen Rueckfall.
  assert.ok(/(?<!\.)\b(spawn|exec|execFile|execSync|fork)\s*\(/.test("const t = execSync('gh auth token')"));
  assert.ok(/\bgh\s+auth\b/i.test('gh auth token'));
});

test('W10: jeder Zentrale-Test ersetzt fetch durch eine werfende Attrappe, und sie wirkt', async () => {
  const vorhanden = readdirSync(join(ROOT, 'test')).filter(n => n.startsWith('zentrale-')).sort();
  assert.deepEqual(vorhanden, [...TESTS].sort());

  for (const t of TESTS) {
    const text = readFileSync(join(ROOT, 'test', t), 'utf8');
    const zeilen = text.split('\n').filter(z => z.trim() !== '' && !z.startsWith('//'));
    assert.equal(zeilen[0], ATTRAPPE, `${t}: Attrappe nicht als erste Anweisung`);
    assert.equal(text.split('\n').filter(z => /^\s*(globalThis|global|window)\s*\.\s*fetch\s*=/.test(z)).length, 1, `${t}: fetch wird spaeter ueberschrieben`);
    assert.ok(!/delete\s+globalThis\.fetch|Reflect\.(set|deleteProperty)\(\s*globalThis/.test(text), `${t}: Attrappe entfernt`);
  }

  assert.throws(() => globalThis.fetch('https://api.github.com/'), /W10/);
  // Ohne fetchImpl nutzt der Leser globalThis.fetch: die Attrappe wirft, das Ergebnis ist unbekannt, kein Netz.
  const r = await erzeugeLeser({ token: 'github_pat_TESTNURATTRAPPE_0000000000' }).holeJson('/repos/noah04091/agenten-probe');
  assert.deepEqual(r, { klasse: 'unbekannt', grund: 'Netzfehler' });
});

// Ausfuehrbarer Code: Blockkommentare, ganze Kommentarzeilen (// und bei Shell #) und angehaengte " // ..." entfernt.
function ausfuehrbar(text, shell = false) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(z => !/^\s*\/\//.test(z) && !(shell && /^\s*#/.test(z)))
    .map(z => z.replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

test('W11: jeder Code in fehlercodes.mjs (beide Listen) steht woertlich in ausfuehrbarem Code unter scripts/ oder .github/agent/', () => {
  const texte = [];
  const geh = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') geh(join(dir, e.name));
      } else if (/\.(mjs|js|sh|json)$/.test(e.name)) {
        texte.push(ausfuehrbar(readFileSync(join(dir, e.name), 'utf8'), e.name.endsWith('.sh')));
      }
    }
  };
  geh(join(ROOT, 'scripts'));
  geh(join(ROOT, '.github', 'agent'));
  assert.ok(texte.length >= 10, 'Muss-Treffer: Quellen gelesen');
  const alles = texte.join('\n');
  const codes = Object.keys(FEHLERCODES);
  assert.ok(codes.length >= 20);
  assert.ok(BEKANNTE_CODES.length >= 300, 'Muss-Treffer: Namensliste vorhanden');

  for (const c of [...codes, ...BEKANNTE_CODES]) {
    assert.ok(alles.includes(`'${c}'`), `Code ${c} kommt in ausfuehrbarem Code unter scripts/ und .github/agent/ nicht vor`);
  }

  // Form wie im Log lesbar, ohne Doppel, sortiert, keine Ueberschneidung mit den Klartext-Codes, nie das Sonderwort.
  assert.ok(BEKANNTE_CODES.every(c => /^[a-z0-9-]{1,60}$/.test(c)), 'Form');
  assert.deepEqual([...BEKANNTE_CODES], [...new Set(BEKANNTE_CODES)].sort(), 'doppelt oder unsortiert');
  assert.ok(BEKANNTE_CODES.every(c => !Object.hasOwn(FEHLERCODES, c)), 'Ueberschneidung mit FEHLERCODES');
  assert.ok(!BEKANNTE_CODES.includes('mehrdeutig') && !Object.hasOwn(FEHLERCODES, 'mehrdeutig'), 'Sonderwort mehrdeutig');
  assert.ok(Object.isFrozen(BEKANNTE_CODES) && Object.isFrozen(FEHLERCODES));

  assert.ok(!alles.includes("'gibt-es-nicht-zentrale'"), 'Gegenprobe');
  // Gegenprobe: ein Code nur im Kommentar zaehlt nicht; Code daneben bleibt.
  const probe = ausfuehrbar("// fail('nur-kommentar')\nconst a = 'echt-code'; // 'angehaengt-kommentar'\n/* 'block-kommentar' */\n  * 'stern-zeile'");
  assert.ok(probe.includes("'echt-code'"), 'Muss-Treffer: Code bleibt');
  for (const k of ['nur-kommentar', 'angehaengt-kommentar', 'block-kommentar']) {
    assert.ok(!probe.includes(`'${k}'`), k);
  }
  assert.ok(!ausfuehrbar("# 'shell-kommentar'\nX='shell-code'", true).includes("'shell-kommentar'"));
  // Muss-Treffer: ein Kommentar in scripts/ mit Codewort wird tatsaechlich entfernt.
  assert.ok(readFileSync(join(ROOT, 'scripts', 'agent-code-integritaet.mjs'), 'utf8').includes('A6-FEHLER integritaet-<code>'));
  assert.ok(!alles.includes('A6-FEHLER integritaet-<code>'));
});

// B1.3: zentrale.mjs liest ausser lese-token (token.mjs), cache.json, fristen.json und dem Sitzungsordner
// (sitzungen-meta.mjs) keine Datei. Statisch im Quelltext und im Ablauf mit einer protokollierenden Attrappe.
test('W12: zentrale.mjs liest nur cache.json und fristen.json (Token und Sitzungen ueber ihre eigenen Module)', async () => {
  const t = code(lies('zentrale.mjs'));
  assert.ok(!/readdirSync|opendir|openSync|createReadStream|\breadFile\(|fs\.promises|node:fs\/promises|\bstatSync\(|readlinkSync|realpathSync/.test(t), 'weitere Lesewege');
  const lesen = [...t.matchAll(/(\w+)\.(readFileSync|lstatSync)\(([^,)]*)/g)].map(m => `${m[1]}.${m[2]}(${m[3].trim()})`);
  // Genau drei Lesestellen: cacheLaden und ladeFristen, beide ueber fsImpl und den uebergebenen Pfad.
  assert.deepEqual(lesen.sort(), ['fsImpl.lstatSync(datei)', 'fsImpl.readFileSync(datei)', 'fsImpl.readFileSync(datei)']);
  const dateinamen = [...t.matchAll(/'([^'\s/\\]+\.[a-z]{2,4})'/g)].map(m => m[1]);
  assert.ok(dateinamen.length >= 3, 'Muss-Treffer: Dateinamen gefunden');
  assert.deepEqual([...new Set(dateinamen)].sort(), ['cache.json', 'fristen.json', 'sitzungen.html', 'zentrale.html']);

  // Ablauf: jede Lese-Methode der Attrappe wird protokolliert; unbekannte Methoden zaehlen ebenfalls.
  const { main } = await import('../werkzeuge/zentrale/zentrale.mjs');
  const ordner = join('Z', '.zentrale');
  const erlaubt = [join(ordner, 'cache.json'), join(ordner, 'fristen.json')];
  const fake = () => {
    const protokoll = [];
    const dateien = new Map([[join(ordner, 'cache.json'), '{}'], [join(ordner, 'fristen.json'), '{"schema":"zentrale-fristen-v1","fristen":[]}']]);
    const ziel = {
      lstatSync: p => { protokoll.push(['lstatSync', p]); if (!dateien.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isSymbolicLink: () => false, isFile: () => true, size: dateien.get(p).length }; },
      readFileSync: p => { protokoll.push(['readFileSync', p]); if (!dateien.has(p)) throw new Error('ENOENT'); return dateien.get(p); },
      existsSync: p => { protokoll.push(['existsSync', p]); return false; },
      writeFileSync: (p, inhalt) => { dateien.set(p, inhalt); },
      renameSync: (a, b) => { dateien.set(b, dateien.get(a)); dateien.delete(a); },
      mkdirSync: () => {},
    };
    return { protokoll, fsImpl: new Proxy(ziel, { get: (o, k) => (k in o ? o[k] : (...a) => { protokoll.push([String(k), a[0]]); throw new Error(`unerwartet ${String(k)}`); }) }) };
  };
  const leserMit = status => () => ({
    holeJson: async (p, o) => (o?.start ? (status === 200 ? { klasse: 'ok', daten: {}, status: 200, tokenAblauf: null } : { klasse: 'unbekannt', grund: 'x', status, tokenAblauf: null }) : { klasse: 'unbekannt', grund: 'x' }),
    holeAlleSeiten: async () => ({ klasse: 'unbekannt', grund: 'x' }),
    holeLog: async () => ({ klasse: 'unbekannt', grund: 'x' }),
  });

  for (const [name, status, tokenOk] of [['normal', 200, true], ['401', 401, true], ['500', 500, true], ['Token-Datei', 200, false]]) {
    const f = fake();
    await main([], {
      tokenLaden: () => (tokenOk ? { ok: true, token: 'github_pat_TESTNURATTRAPPE_0000000000' } : { ok: false, grund: 'Token fehlt' }),
      leserBauen: leserMit(status), jetzt: () => Date.parse('2026-11-22T12:00:00Z'), ausgabe: () => {}, fsImpl: f.fsImpl, ordner,
      sitzungen: () => ({ ok: true, eintraege: [] }), uebersicht: join('Z', 'sitzungen.html'), beiAbbruch: () => {},
    });
    const gelesen = f.protokoll.filter(([m]) => m !== 'existsSync');
    assert.ok(gelesen.length >= 1, `${name}: Muss-Treffer, cache.json gelesen`);
    assert.ok(gelesen.every(([m, p]) => ['lstatSync', 'readFileSync'].includes(m) && erlaubt.includes(p)), `${name}: ${JSON.stringify(gelesen)}`);
    // existsSync nur fuer die Sitzungsuebersicht und die Suche nach .git (Git-Arbeitsbaum-Pruefung von fristen.json).
    assert.ok(f.protokoll.filter(([m]) => m === 'existsSync').every(([, p]) => p === join('Z', 'sitzungen.html') || p.endsWith('.git')), name);
  }
});

// B1.3a: echtprobe.mjs liest ausser dem Token (ueber token.mjs) nur echtprobe-soll.json und schreibt keine Datei.
// Statisch im Quelltext und im Ablauf mit einer protokollierenden Attrappe (gueltig, fehlt, Git-Arbeitsbaum, ungueltig).
test('W13: echtprobe.mjs liest nur echtprobe-soll.json und schreibt keine Datei', async () => {
  const t = code(lies('echtprobe.mjs'));
  const SCHREIBEN = /writeFileSync|\bwriteFile\b|renameSync|\brename\(|appendFile|mkdir|createWriteStream|copyFile|\bcp\(|cpSync|unlink|rmSync|\brm\(|rmdir|truncate|symlink|\blink\(|linkSync|chmod|chown|utimes|openSync|fs\.promises|node:fs\/promises/;
  assert.ok(!SCHREIBEN.test(t), 'Schreibweg in echtprobe.mjs');
  assert.ok(!/readdirSync|opendir|createReadStream|\breadFile\(|\bstatSync\(|readlinkSync|realpathSync|existsSync|\bfs\.\w+\(/.test(t), 'weitere Lesewege');
  const lesen = [...t.matchAll(/(\w+)\.(readFileSync|lstatSync)\(([^,)]*)/g)].map(m => `${m[1]}.${m[2]}(${m[3].trim()})`);
  assert.deepEqual(lesen.sort(), ['fsImpl.lstatSync(datei)', 'fsImpl.readFileSync(datei)']);
  const dateinamen = [...t.matchAll(/'([^'\s/\\]+\.[a-z]{2,4})'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(dateinamen)], ['echtprobe-soll.json'], 'Muss-Treffer und einziger Dateiname');
  assert.deepEqual([...t.matchAll(/from '(node:[^']+)'/g)].map(m => m[1]).sort(), ['node:fs', 'node:os', 'node:path']);

  const { ECHTPROBE_SOLL, echtprobe, ladeSoll } = await import('../werkzeuge/zentrale/echtprobe.mjs');
  const gueltig = JSON.stringify({ schema: 'zentrale-echtprobe-soll-v1', leseTokenAblauf: '2026-12-21T21:04:30Z', eingetragen: '2026-11-21', quelle: 'noah' });
  const fake = (inhalt, git = false) => {
    const protokoll = [];
    const ziel = {
      lstatSync: p => { protokoll.push(['lstatSync', p]); if (inhalt === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isSymbolicLink: () => false, isFile: () => true, size: inhalt.length }; },
      readFileSync: p => { protokoll.push(['readFileSync', p]); return inhalt; },
      existsSync: p => { protokoll.push(['existsSync', p]); return git; },
    };
    return { protokoll, fsImpl: new Proxy(ziel, { get: (o, k) => (k in o ? o[k] : (...a) => { protokoll.push([String(k), a[0]]); throw new Error(`unerwartet ${String(k)}`); }) }) };
  };
  const leser = () => ({
    holeJson: async (p, o) => (o?.start ? { klasse: 'ok', daten: {}, status: 200, tokenAblauf: Date.parse('2026-12-21T21:04:30Z') } : { klasse: 'unbekannt', grund: 'x' }),
    holeAlleSeiten: async () => ({ klasse: 'unbekannt', grund: 'x' }),
    holeLog: async () => ({ klasse: 'unbekannt', grund: 'x' }),
  });

  for (const [name, inhalt, git, muster] of [
    ['gueltig', gueltig, false, /frist-lese-token: 2026-12-21T21:04:30\.000Z .* OK/],
    ['fehlt', null, false, /frist-lese-token: Sollwert nicht pruefbar: Referenzdatei fehlt/],
    ['Git-Arbeitsbaum', gueltig, true, /frist-lese-token: Sollwert nicht pruefbar: Referenzdatei liegt in einem Git-Arbeitsbaum/],
    ['ungueltig', '{"schema":1}', false, /frist-lese-token: Sollwert nicht pruefbar: /],
  ]) {
    const f = fake(inhalt, git);
    const zeilen = [];
    await echtprobe([], {
      tokenLaden: () => ({ ok: true, token: 'github_pat_TESTNURATTRAPPE_0000000000' }), leserBauen: leser, ausgabe: z => zeilen.push(z),
      jetzt: Date.parse('2026-11-22T12:00:00Z'), sollLaden: a => ladeSoll({ ...a, fsImpl: f.fsImpl }),
    });
    assert.match(zeilen.join('\n'), muster, name);
    const gelesen = f.protokoll.filter(([m]) => m !== 'existsSync');
    assert.ok(gelesen.length >= 1, `${name}: Muss-Treffer, Referenzdatei angefasst`);
    assert.ok(gelesen.every(([m, p]) => ['lstatSync', 'readFileSync'].includes(m) && p === ECHTPROBE_SOLL), `${name}: ${JSON.stringify(gelesen)}`);
    assert.ok(f.protokoll.filter(([m]) => m === 'existsSync').every(([, p]) => p.endsWith('.git')), name);
  }
});
