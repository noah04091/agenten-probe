// A6.4-2b: Offline-Tests des sicheren GitHub-REST-Transports.
//
// Keine echte GitHub-Anfrage, kein echtes Token, kein Socket. https.request wird fuer jeden Test
// durch eine Attrappe ersetzt, die den Lebenszyklus einer Anfrage im Speicher nachspielt und jeden
// Aufruf protokolliert. Zusaetzlich wirft jeder Versuch, einen Socket zu verbinden (net.Socket), und
// ein eigener Test belegt am Ende, dass es keinen gab. Zeitgrenzen laufen ueber mock.timers.
//
// Was diese Tests nicht belegen: eine produktive TLS-Verbindung zu GitHub, echte Tokenherkunft und
// Rechte, echte Rate-Limits und einen vollstaendigen publishOrderDraft-Lauf ueber diesen Transport
// (Integration in A6.4-2c und A6.4-4).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, afterEach, test } from 'node:test';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { gzipSync } from 'node:zlib';

import { MAX_BODY_BYTES, checkApiRequest, readLiveState } from '../scripts/agent-code-auftrag-live.mjs';
import { branchName, checkPublishRequest } from '../scripts/agent-code-auftrag-publish.mjs';
import { createPublishTransport, createReadTransport } from '../scripts/agent-code-auftrag-transport.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_PATH = join(ROOT, 'scripts', 'agent-code-auftrag-transport.mjs');
const SOURCE = readFileSync(MODULE_PATH, 'utf8');
const REPO = 'noah04091/agenten-probe';
const P = `/repos/${REPO}/`;
const ISSUE = 26;
const RUN = '4242424242';
// Erfundenes Token nur fuer diese Tests, ohne Wirkung. Es wird in keiner Ausgabe erwartet.
const TOKEN = 'ghs_NurTestOhneWirkung_0123456789abcdefXYZ';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BRANCH = `wp/${ISSUE}-agent-${RUN}-1`;
const TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 64 * 1024;

const input = (overrides = {}) => ({ token: TOKEN, issueNumber: ISSUE, runId: RUN, ...overrides });
const lese = (overrides) => createReadTransport(input(overrides));
const schreibe = (overrides) => createPublishTransport(input(overrides));

// ---------------------------------------------------------------------------
// Socket-Waechter und Attrappe fuer https.request
// ---------------------------------------------------------------------------

const ORIGINAL_REQUEST = https.request;
const ORIGINAL_CONNECT = net.Socket.prototype.connect;
let socketVersuche = 0;

net.Socket.prototype.connect = function verboten() {
  socketVersuche += 1;
  throw new Error('Socket im Transporttest verboten');
};

after(() => {
  net.Socket.prototype.connect = ORIGINAL_CONNECT;
  https.request = ORIGINAL_REQUEST;
});

afterEach(() => {
  https.request = ORIGINAL_REQUEST;
});

class FakeRequest extends EventEmitter {
  constructor(options, onResponse, szenario) {
    super();
    this.options = options;
    this.onResponse = onResponse;
    this.szenario = szenario;
    this.geschrieben = [];
    this.beendet = false;
    this.zerstoert = 0;
    this.antwort = null;
  }

  write(chunk, encoding) {
    this.geschrieben.push(Buffer.from(chunk, encoding));
    return true;
  }

  end(chunk, encoding) {
    if (chunk !== undefined) {
      this.geschrieben.push(Buffer.from(chunk, encoding));
    }

    this.beendet = true;
    queueMicrotask(() => this.szenario(this));
    return this;
  }

  // Wie ein echter Abbruch: spaetes error- und close-Ereignis. Ohne Listener wuerde error werfen.
  destroy() {
    this.zerstoert += 1;

    if (this.zerstoert === 1) {
      process.nextTick(() => {
        this.emit('error', Object.assign(new Error(`socket hang up ${TOKEN}`), { code: 'ECONNRESET' }));
        this.emit('close');
      });
    }

    return this;
  }
}

// Installiert die Attrappe. szenario(req) bestimmt, was nach end() passiert. Liefert das Protokoll.
function attrappe(szenario) {
  const aufrufe = [];

  https.request = (options, onResponse) => {
    const req = new FakeRequest(options, onResponse, szenario);
    aufrufe.push(req);
    return req;
  };

  return aufrufe;
}

// Spielt eine Antwort ab. ende: 'end' (vollstaendig), 'abbruch' (Fehler mitten im Text),
// 'schliessen' (close ohne end), 'haengen' (nichts mehr).
function antworte(req, { status = 200, kopf = [], teile = [], ende = 'end', nodeHeaders } = {}) {
  const res = new Readable({ read() {} });
  res.statusCode = status;
  res.rawHeaders = kopf;
  // So fasst Node doppelte Kopfzeilen zusammen. Das Modul darf diese Sicht nicht verwenden.
  res.headers = nodeHeaders ?? {};
  res.complete = false;
  req.antwort = res;
  req.onResponse(res);

  for (const teil of teile) {
    res.push(Buffer.isBuffer(teil) ? teil : Buffer.from(teil, 'utf8'));
  }

  if (ende === 'end') {
    res.complete = true;
    res.push(null);
  } else if (ende === 'abbruch') {
    res.destroy(Object.assign(new Error(`aborted ${TOKEN}`), { code: 'ECONNRESET' }));
  } else if (ende === 'schliessen') {
    res.emit('close');
  }

  return res;
}

const json = (status, value, kopf = []) => req => antworte(req, { status, kopf, teile: [JSON.stringify(value)] });
const leer204 = req => antworte(req, { status: 204 });
const netzfehler = (code = 'ECONNREFUSED') => req => req.emit('error', Object.assign(new Error(`${code} mit ${TOKEN} im Text`), { code }));

async function zustand(promise) {
  let ergebnis = 'offen';
  promise.then(() => { ergebnis = 'erfuellt'; }, () => { ergebnis = 'abgelehnt'; });

  for (let index = 0; index < 8; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }

  return ergebnis;
}

async function abgelehnt(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.name, 'OrderError', String(error));
    assert.equal(error.code, code, error.message);
    keinToken(error);
    return true;
  });
}

function keinToken(value) {
  const texte = [inspect(value, { depth: 10, showHidden: true }), String(value?.stack ?? ''), String(value?.message ?? '')];

  try {
    texte.push(String(JSON.stringify(value)));
  } catch {
    // nicht serialisierbar ist hier kein Befund
  }

  for (const text of texte) {
    assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN.slice(4)), 'Token offengelegt');
  }
}

function synchronAbgelehnt(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.name, 'OrderError', String(error));
    assert.equal(error.code, code, error.message);
    keinToken(error);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Fabriken: Eingabe und Token
// ---------------------------------------------------------------------------

test('Eingabe: genau token, issueNumber und runId als einfache sichtbare Dateneigenschaften', () => {
  for (const make of [createReadTransport, createPublishTransport]) {
    assert.equal(typeof make(input()), 'function');
    assert.equal(typeof make(Object.assign(Object.create(null), input())), 'function');

    const getter = input();
    delete getter.token;
    Object.defineProperty(getter, 'token', { get: () => TOKEN, enumerable: true });
    const versteckt = input();
    Object.defineProperty(versteckt, 'zusatz', { value: 1, enumerable: false });
    const unsichtbar = input();
    Object.defineProperty(unsichtbar, 'token', { value: TOKEN, enumerable: false });
    const symbol = input();
    symbol[Symbol('x')] = 1;

    const faelle = [
      undefined, null, 'x', [], new Map(), new (class Eingabe {})(), new Proxy(input(), {}),
      { issueNumber: ISSUE, runId: RUN }, { token: TOKEN, runId: RUN }, { token: TOKEN, issueNumber: ISSUE },
      input({ repository: REPO }), input({ path: '/x' }), getter, versteckt, unsichtbar, symbol,
    ];

    for (const fall of faelle) {
      synchronAbgelehnt(() => make(fall), 'transport-eingabe');
    }
  }
});

test('Eingabe: Issue-Nummer nach Auftragsvertrag, Lauf-ID nach sicherem Format', () => {
  for (const make of [createReadTransport, createPublishTransport]) {
    for (const issueNumber of [0, -1, 1.5, '26', 10_000_001, Number.NaN, Infinity, 2 ** 53, null]) {
      synchronAbgelehnt(() => make(input({ issueNumber })), 'transport-issue-nummer');
    }

    assert.equal(typeof make(input({ issueNumber: 10_000_000 })), 'function');
    assert.equal(typeof make(input({ issueNumber: 1 })), 'function');

    for (const runId of [4242, '', '0', '0123', '1e3', ' 1', '1 ', '12345678901234567', '9007199254740993', '-1', '１２']) {
      synchronAbgelehnt(() => make(input({ runId })), 'transport-lauf-id');
    }

    assert.equal(typeof make(input({ runId: '9007199254740991' })), 'function');
  }
});

test('Token: altes Format nur ghs_ mit [A-Za-z0-9_], begrenzte Laenge, geprueft vor jeder Anfrage', () => {
  const aufrufe = attrappe(json(200, {}));

  for (const make of [createReadTransport, createPublishTransport]) {
    const schlecht = [
      undefined, null, 1, '', 'ghs_', 'ghp_abc123', 'github_pat_11ABC_def', 'gho_abc', 'ghu_abc', 'ghr_abc', 'GHS_abc',
      'Bearer ghs_abc', 'ghs_abc\n', 'ghs_abc\r\nX-Boese: 1', 'ghs_ab c', 'ghs_abc\t', 'ghs_abc\u0000', 'ghs_abc:def',
      'ghs_abc-def', 'ghs_äbc', 'ghs_abc;', ` ${TOKEN}`, new String(TOKEN), `ghs_${'a'.repeat(1021)}`,
    ];

    for (const token of schlecht) {
      assert.throws(() => make(input({ token })), error => {
        assert.equal(error.code, 'transport-token');
        assert.ok(typeof token !== 'string' || token.length < 5 || !error.message.includes(token.slice(4)), 'Token im Fehlertext');
        keinToken(error);
        return true;
      });
    }

    assert.equal(typeof make(input({ token: `ghs_${'a'.repeat(1020)}` })), 'function');
    assert.equal(typeof make(input({ token: 'ghs_x' })), 'function');
  }

  assert.equal(aufrufe.length, 0, 'eine Anfrage vor der Tokenpruefung');
});

test('Rueckgabe: eingefrorene Funktion ohne eigene Zusatzeigenschaften, nur zwei Exporte', async () => {
  const modul = await import('../scripts/agent-code-auftrag-transport.mjs');
  assert.deepEqual(Object.keys(modul).sort(), ['createPublishTransport', 'createReadTransport']);

  for (const transport of [lese(), schreibe()]) {
    assert.equal(typeof transport, 'function');
    assert.ok(Object.isFrozen(transport));
    assert.deepEqual(Reflect.ownKeys(transport).sort(), ['length', 'name']);
    assert.throws(() => { transport.token = 'x'; }, TypeError);
  }
});

// ---------------------------------------------------------------------------
// Positive Faelle
// ---------------------------------------------------------------------------

const LIVE_GET = [
  `${P}issues/${ISSUE}`,
  `${P}issues/${ISSUE}/events?per_page=100&page=1`,
  `${P}issues/${ISSUE}/events?per_page=100&page=10`,
  `${P}actions/runs/${RUN}`,
  `${P}git/ref/heads/main`,
  `${P}git/matching-refs/heads/wp/${ISSUE}-`,
  `${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=1`,
  `${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=10`,
];

const PUBLISH_GET = [
  `${P}git/commits/${SHA_A}`,
  `${P}git/trees/${SHA_A}?recursive=1`,
  `${P}compare/${SHA_A}...${SHA_B}`,
  `${P}git/ref/heads/${BRANCH}`,
];

const POSTS = {
  'git/blobs': { content: 'aGFsbG8K', encoding: 'base64' },
  'git/trees': { base_tree: SHA_A, tree: [{ path: 'src/a.js', mode: '100644', type: 'blob', sha: SHA_B }] },
  'git/commits': { message: 'Agent: ä', tree: SHA_A, parents: [SHA_B] },
  'git/refs': { ref: `refs/heads/${BRANCH}`, sha: SHA_A },
  pulls: { title: 'Agent', head: BRANCH, base: 'main', body: 'x', draft: true },
};

const ERWARTETE_KOEPFE = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'noah04091-agenten-probe-a6-transport',
  'Accept-Encoding': 'identity',
};

function pruefeAufruf(req, method, path, body) {
  const o = req.options;
  assert.deepEqual(Object.keys(o).sort(), ['agent', 'headers', 'hostname', 'insecureHTTPParser', 'method', 'path', 'port', 'protocol']);
  assert.equal(o.protocol, 'https:');
  assert.equal(o.hostname, 'api.github.com');
  assert.equal(o.port, 443);
  assert.equal(o.method, method);
  assert.equal(o.path, path);
  assert.equal(o.insecureHTTPParser, false);
  assert.ok(o.agent instanceof https.Agent, 'eigener https.Agent fehlt');
  const koepfe = body === undefined
    ? ERWARTETE_KOEPFE
    : { ...ERWARTETE_KOEPFE, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body, 'utf8')) };
  assert.deepEqual(o.headers, koepfe);
  assert.ok(req.beendet);
  assert.deepEqual(Buffer.concat(req.geschrieben), Buffer.from(body ?? '', 'utf8'));
}

function pruefeAntwortform(antwort, status, body, headers = {}) {
  assert.ok(Object.isFrozen(antwort) && Object.isFrozen(antwort.headers));
  assert.deepEqual(Reflect.ownKeys(antwort), ['status', 'headers', 'body']);
  assert.equal(Object.getPrototypeOf(antwort.headers), Object.prototype);
  assert.equal(antwort.status, status);
  assert.equal(antwort.body, body);
  assert.deepEqual(antwort.headers, headers);
  keinToken(antwort);
}

test('Positiv: Live-GETs fuer eigenes Issue, Ereignisse, Lauf, main, Branchsuche und PR-Liste in beiden Modi', async () => {
  for (const make of [lese, schreibe]) {
    for (const path of LIVE_GET) {
      const aufrufe = attrappe(json(200, { ok: path }));
      const antwort = await make()({ method: 'GET', path });
      assert.equal(aufrufe.length, 1, path);
      pruefeAufruf(aufrufe[0], 'GET', path, undefined);
      pruefeAntwortform(antwort, 200, JSON.stringify({ ok: path }));
    }
  }
});

test('Positiv: GETs des Veroeffentlichers (Commit, Baum, Compare, eigener Branch)', async () => {
  for (const path of PUBLISH_GET) {
    const aufrufe = attrappe(json(200, { sha: SHA_A }));
    const antwort = await schreibe()({ method: 'GET', path });
    assert.equal(aufrufe.length, 1, path);
    pruefeAufruf(aufrufe[0], 'GET', path, undefined);
    pruefeAntwortform(antwort, 200, JSON.stringify({ sha: SHA_A }));
  }
});

test('Positiv: POST git/blobs, git/trees, git/commits, git/refs und pulls mit fester Byte-Laenge', async () => {
  for (const [rest, value] of Object.entries(POSTS)) {
    const aufrufe = attrappe(json(201, { sha: SHA_A }));
    const body = JSON.stringify(value);
    const antwort = await schreibe()({ method: 'POST', path: `${P}${rest}`, body });
    assert.equal(aufrufe.length, 1, rest);
    pruefeAufruf(aufrufe[0], 'POST', `${P}${rest}`, body);
    pruefeAntwortform(antwort, 201, JSON.stringify({ sha: SHA_A }));
  }

  // Byte-Laenge, nicht Zeichenlaenge.
  const aufrufe = attrappe(json(201, {}));
  await schreibe()({ method: 'POST', path: `${P}git/commits`, body: '{"m":"äöü€"}' });
  assert.equal(aufrufe[0].options.headers['Content-Length'], String(Buffer.byteLength('{"m":"äöü€"}', 'utf8')));
  assert.notEqual(aufrufe[0].options.headers['Content-Length'], String('{"m":"äöü€"}'.length));
});

test('Positiv: DELETE auf den eigenen Branch vor einer PR-Anfrage, danach weitere Anfragen moeglich', async () => {
  const aufrufe = attrappe(req => (req.options.method === 'DELETE' ? leer204(req) : json(200, {})(req)));
  const transport = schreibe();
  const antwort = await transport({ method: 'DELETE', path: `${P}git/refs/heads/${BRANCH}` });
  pruefeAufruf(aufrufe[0], 'DELETE', `${P}git/refs/heads/${BRANCH}`, undefined);
  pruefeAntwortform(antwort, 204, '');
  await transport({ method: 'GET', path: `${P}git/ref/heads/main` });
  assert.equal(aufrufe.length, 2);
});

test('Positiv: readLiveState liest ueber den Lesetransport, mit PR-Paginierung ueber link', async () => {
  const pulls1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, head: { ref: `feature/${i + 1}` } }));
  const pulls2 = [{ number: 101, head: { ref: 'wp/7-x' } }];
  const antworten = new Map([
    [`${P}actions/runs/${RUN}`, [{ id: Number(RUN) }]],
    [`${P}git/ref/heads/main`, [{ ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } }]],
    [`${P}issues/${ISSUE}`, [{ number: ISSUE, title: 't' }]],
    [`${P}issues/${ISSUE}/events?per_page=100&page=1`, [[{ id: 1, event: 'labeled' }]]],
    [`${P}git/matching-refs/heads/wp/${ISSUE}-`, [[]]],
    [`${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=1`, [pulls1, ['Link', '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=2>; rel="last"']]],
    [`${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=2`, [pulls2, ['link', '<https://api.github.com/repositories/1/pulls?page=1>; rel="prev", <https://api.github.com/repositories/1/pulls?page=1>; rel="first"']]],
  ]);
  const aufrufe = attrappe(req => {
    const [value, kopf] = antworten.get(req.options.path);
    json(200, value, kopf ?? [])(req);
  });

  const state = await readLiveState({ transport: lese(), repository: REPO, issueNumber: ISSUE, runId: RUN });
  assert.equal(aufrufe.length, 7);
  assert.deepEqual(aufrufe.map(req => req.options.path), [...antworten.keys()]);
  assert.equal(state.mainSha, SHA_A);
  assert.equal(state.pulls.length, 101);
  assert.deepEqual(state.events, [{ id: 1, event: 'labeled' }]);
});

test('Positiv: Antwort genau an der Grenze von MAX_BODY_BYTES wird angenommen', async () => {
  assert.equal(MAX_BODY_BYTES, 16 * 1024 * 1024);
  const mib = Buffer.alloc(1024 * 1024, 0x61);
  const aufrufe = attrappe(req => antworte(req, { teile: Array.from({ length: 16 }, () => mib) }));
  const antwort = await lese()({ method: 'GET', path: LIVE_GET[0] });
  assert.equal(aufrufe.length, 1);
  assert.equal(antwort.body.length, MAX_BODY_BYTES);
});

// ---------------------------------------------------------------------------
// Vertrag: zweite Schranke gleich den bestehenden Regeln
// ---------------------------------------------------------------------------

test('Vertrag: eigene Branchbildung entspricht exakt branchName()', async () => {
  for (const [issueNumber, runId] of [[1, '1'], [ISSUE, RUN], [10_000_000, '9007199254740991'], [38, '43589522182']]) {
    const branch = branchName(issueNumber, runId);
    const aufrufe = attrappe(req => (req.options.method === 'DELETE' ? leer204(req) : json(200, {})(req)));
    const transport = createPublishTransport(input({ issueNumber, runId }));
    await transport({ method: 'GET', path: `${P}git/ref/heads/${branch}` });
    await transport({ method: 'DELETE', path: `${P}git/refs/heads/${branch}` });
    assert.equal(aufrufe.length, 2, branch);
  }
});

const RESTE = [
  `issues/${ISSUE}`, 'issues/27', `issues/${ISSUE}/comments`, `issues/${ISSUE}/labels`,
  ...['0', '1', '10', '11'].map(page => `issues/${ISSUE}/events?per_page=100&page=${page}`),
  'issues/27/events?per_page=100&page=1', `issues/${ISSUE}/events?per_page=50&page=1`,
  'git/ref/heads/main', `git/matching-refs/heads/wp/${ISSUE}-`, 'git/matching-refs/heads/wp/27-', 'git/matching-refs/heads/wp/',
  ...['0', '1', '10', '11'].map(page => `pulls?state=all&sort=created&direction=asc&per_page=100&page=${page}`),
  'pulls?state=open&sort=created&direction=asc&per_page=100&page=1',
  `actions/runs/${RUN}`, 'actions/runs/1', `actions/runs/${RUN}/rerun`, 'actions/workflows/x.yml/dispatches',
  `git/commits/${SHA_A}`, `git/commits/${SHA_A.toUpperCase()}`, 'git/commits/abc',
  `git/trees/${SHA_A}?recursive=1`, `git/trees/${SHA_A}`, `git/trees/${SHA_A}?recursive=0`,
  `compare/${SHA_A}...${SHA_B}`, `compare/${SHA_A}..${SHA_B}`, `compare/main...${SHA_B}`,
  `git/ref/heads/${BRANCH}`, 'git/ref/heads/wp/26-agent-1-1', `git/ref/heads/wp/27-agent-${RUN}-1`,
  `git/refs/heads/${BRANCH}`, 'git/refs/heads/main', `git/refs/heads/wp/27-agent-${RUN}-1`, 'git/refs/heads/wp/26-agent-1-1',
  'git/blobs', 'git/trees', 'git/commits', 'git/refs', 'pulls', 'git/tags', 'merges', 'contents/x', `git/blobs/${SHA_A}`,
  'pulls/1', 'pulls/1/merge', 'pulls/1/reviews', 'issues', 'releases',
];
const METHODEN = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD'];

function erlaubt(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

// Unabhaengige Bindung an Issue und Lauf, hier im Test eigens formuliert.
function gebunden(path) {
  const rest = path.slice(P.length);
  return !/^issues\/(?!26(?:$|\/))/.test(rest) && !/^git\/matching-refs\/heads\/wp\/(?!26-$)/.test(rest) && !/^actions\/runs\/(?!4242424242$)/.test(rest);
}

async function transportErlaubt(make, method, path) {
  const aufrufe = attrappe(req => (req.options.method === 'DELETE' ? leer204(req) : json(200, {})(req)));
  const request = method === 'POST' ? { method, path, body: '{"a":1}' } : { method, path };

  try {
    await make()(request);
  } catch (error) {
    assert.equal(error.name, 'OrderError');
    assert.ok(error.code.startsWith('transport-'), error.code);
    assert.equal(aufrufe.length, 0, `${method} ${path}: Anfrage trotz Ablehnung`);
    return false;
  }

  assert.equal(aufrufe.length, 1, `${method} ${path}`);
  return true;
}

test('Vertrag: Schreibmodus erlaubt genau checkPublishRequest() plus die gebundenen Live-GETs', async () => {
  const angenommen = [];

  for (const method of METHODEN) {
    for (const rest of RESTE) {
      const path = `${P}${rest}`;
      const publish = erlaubt(() => checkPublishRequest(method, path, BRANCH));
      const live = method === 'GET' && erlaubt(() => checkApiRequest(method, path)) && gebunden(path);
      const tatsaechlich = await transportErlaubt(schreibe, method, path);
      assert.equal(tatsaechlich, publish || live, `${method} ${rest}: Transport ${tatsaechlich}, Regeln ${publish || live}`);

      if (tatsaechlich) {
        angenommen.push(`${method} ${rest}`);
      }
    }
  }

  // Ausdrueckliche Liste: aendert sich eine der beiden Schranken, faellt es hier auf.
  assert.deepEqual(angenommen, [
    `GET issues/${ISSUE}`,
    `GET issues/${ISSUE}/events?per_page=100&page=1`,
    `GET issues/${ISSUE}/events?per_page=100&page=10`,
    'GET git/ref/heads/main',
    `GET git/matching-refs/heads/wp/${ISSUE}-`,
    'GET pulls?state=all&sort=created&direction=asc&per_page=100&page=1',
    'GET pulls?state=all&sort=created&direction=asc&per_page=100&page=10',
    `GET actions/runs/${RUN}`,
    `GET git/commits/${SHA_A}`,
    `GET git/trees/${SHA_A}?recursive=1`,
    `GET compare/${SHA_A}...${SHA_B}`,
    `GET git/ref/heads/${BRANCH}`,
    'POST git/blobs',
    'POST git/trees',
    'POST git/commits',
    'POST git/refs',
    'POST pulls',
    `DELETE git/refs/heads/${BRANCH}`,
  ]);
});

test('Vertrag: Lesemodus erlaubt genau die gebundenen GETs aus checkApiRequest()', async () => {
  const angenommen = [];

  for (const method of METHODEN) {
    for (const rest of RESTE) {
      const path = `${P}${rest}`;
      const live = erlaubt(() => checkApiRequest(method, path)) && gebunden(path);
      const tatsaechlich = await transportErlaubt(lese, method, path);
      assert.equal(tatsaechlich, live, `${method} ${rest}`);

      if (tatsaechlich) {
        angenommen.push(`${method} ${rest}`);
      }
    }
  }

  assert.equal(angenommen.length, 8);
  assert.ok(angenommen.every(entry => entry.startsWith('GET ')));
});

// ---------------------------------------------------------------------------
// Negative Faelle: Endpunkte, Pfade und Anfrageform
// ---------------------------------------------------------------------------

async function keineAnfrage(transport, request, code) {
  const aufrufe = attrappe(json(200, {}));
  await abgelehnt(transport(request), code);
  assert.equal(aufrufe.length, 0, `Anfrage trotz Ablehnung: ${inspect(request)}`);
}

test('Endpunkte: fremdes Repository, fremdes Issue, fremder Lauf, Schreiben im Lesemodus, PATCH, PUT, Kommentare, Merge, Workflow', async () => {
  const faelle = [
    [lese, 'GET', '/repos/someone/other/issues/26', 'transport-pfad'],
    [lese, 'GET', '/repos/Noah04091/agenten-probe/issues/26', 'transport-pfad'],
    [lese, 'GET', `${P}issues/27`, 'transport-endpunkt'],
    [lese, 'GET', `${P}issues/27/events?per_page=100&page=1`, 'transport-endpunkt'],
    [lese, 'GET', `${P}git/matching-refs/heads/wp/27-`, 'transport-endpunkt'],
    [lese, 'GET', `${P}actions/runs/1`, 'transport-endpunkt'],
    [schreibe, 'GET', `${P}actions/runs/4242424243`, 'transport-endpunkt'],
    [lese, 'GET', `${P}git/commits/${SHA_A}`, 'transport-endpunkt'],
    [lese, 'POST', `${P}git/blobs`, 'transport-methode'],
    [lese, 'POST', `${P}pulls`, 'transport-methode'],
    [lese, 'DELETE', `${P}git/refs/heads/${BRANCH}`, 'transport-methode'],
    [schreibe, 'PATCH', `${P}pulls/1`, 'transport-methode'],
    [schreibe, 'PUT', `${P}pulls/1/merge`, 'transport-methode'],
    [schreibe, 'HEAD', `${P}issues/${ISSUE}`, 'transport-methode'],
    [schreibe, 'get', `${P}issues/${ISSUE}`, 'transport-methode'],
    [schreibe, 'DELETE', `${P}git/refs/heads/main`, 'transport-endpunkt'],
    [schreibe, 'DELETE', `${P}git/refs/heads/wp/27-agent-${RUN}-1`, 'transport-endpunkt'],
    [schreibe, 'DELETE', `${P}git/refs/heads/wp/26-agent-1-1`, 'transport-endpunkt'],
    [schreibe, 'GET', `${P}git/ref/heads/wp/26-agent-1-1`, 'transport-endpunkt'],
    [schreibe, 'POST', `${P}issues/${ISSUE}/comments`, 'transport-endpunkt'],
    [schreibe, 'POST', `${P}actions/workflows/code-pilot-claude-stufe.yml/dispatches`, 'transport-endpunkt'],
    [schreibe, 'POST', `${P}git/tags`, 'transport-endpunkt'],
    [schreibe, 'GET', `${P}contents/x`, 'transport-endpunkt'],
  ];

  for (const [make, method, path, code] of faelle) {
    const request = method === 'POST' ? { method, path, body: '{}' } : { method, path };
    await keineAnfrage(make(), request, code);
  }
});

test('Pfade: absolute URL, fremde Domain, Zugangsdaten, Port, Fragment, Kodierung, Traversierung, Backslash, Steuerzeichen, Unicode, Query', async () => {
  const faelle = [
    [`https://api.github.com${P}issues/26`, 'transport-pfad'],
    [`//evil.example${P}issues/26`, 'transport-pfad'],
    [`https://user:pw@api.github.com${P}issues/26`, 'transport-pfad'],
    [`${P}issues/26@evil.example`, 'transport-pfad'],
    [`api.github.com:444${P}issues/26`, 'transport-pfad'],
    [`${P}issues/26#frag`, 'transport-pfad'],
    [`${P}issues/%32%36`, 'transport-pfad'],
    [`${P}issues/2%36`, 'transport-pfad'],
    [`${P}issues/27/../26`, 'transport-pfad'],
    [`${P}issues/./26`, 'transport-pfad'],
    [`/repos/${REPO}//issues/26`, 'transport-pfad'],
    [`${P}issues/26/`, 'transport-pfad'],
    [`${P}issues\\26`, 'transport-pfad'],
    [`${P}issues/26\n`, 'transport-pfad'],
    [`${P}issues/26\r\nX-Boese: 1`, 'transport-pfad'],
    [`${P}issues/26\u0000`, 'transport-pfad'],
    [`${P}issues/26 `, 'transport-pfad'],
    [`${P}issues/２６`, 'transport-pfad'],
    [`/repos/noah04091/agenten-probeı/issues/26`, 'transport-pfad'],
    [`${P}issues/26?x=1`, 'transport-endpunkt'],
    [`${P}issues/26/events?per_page=100&page=1&x=1`, 'transport-endpunkt'],
    [`${P}issues/26/events?per_page=100&page=1?page=2`, 'transport-pfad'],
    [`${P}issues/26?`, 'transport-url'],
    [`${P}pulls?state=all&sort=created&direction=asc&per_page=100&page=11`, 'transport-endpunkt'],
    [`${P}${'a/'.repeat(300)}x`, 'transport-pfad'],
    [`/repos/${REPO}`, 'transport-pfad'],
    ['', 'transport-pfad'],
    [42, 'transport-pfad'],
    [null, 'transport-pfad'],
  ];

  for (const make of [lese, schreibe]) {
    for (const [path, code] of faelle) {
      await keineAnfrage(make(), { method: 'GET', path }, code);
    }
  }
});

test('Anfrage: Form, Getter, Proxy, Zusatzfelder, Text bei GET und DELETE, POST-Text gross, kein JSON, kein Objekt', async () => {
  const getter = { method: 'GET' };
  Object.defineProperty(getter, 'path', { get: () => LIVE_GET[0], enumerable: true });
  const versteckt = { method: 'GET', path: LIVE_GET[0] };
  Object.defineProperty(versteckt, 'headers', { value: {}, enumerable: false });
  const anfragen = [
    [undefined, 'transport-anfrage'],
    ['GET', 'transport-anfrage'],
    [new Proxy({ method: 'GET', path: LIVE_GET[0] }, {}), 'transport-anfrage'],
    [getter, 'transport-anfrage'],
    [versteckt, 'transport-anfrage'],
    [{ method: 'GET' }, 'transport-anfrage'],
    [{ path: LIVE_GET[0] }, 'transport-anfrage'],
    [{ method: 'GET', path: LIVE_GET[0], headers: { 'X-Boese': '1' } }, 'transport-anfrage'],
    [{ method: 'GET', path: LIVE_GET[0], host: 'evil.example' }, 'transport-anfrage'],
    [{ method: 'GET', path: LIVE_GET[0], agent: false }, 'transport-anfrage'],
    [{ method: 'GET', path: LIVE_GET[0], timeout: 0 }, 'transport-anfrage'],
    [{ method: 'GET', path: LIVE_GET[0], body: '' }, 'transport-anfrage'],
    [{ method: 'DELETE', path: `${P}git/refs/heads/${BRANCH}`, body: '{}' }, 'transport-anfrage'],
    [{ method: 'POST', path: `${P}git/blobs` }, 'transport-anfrage'],
    [{ method: 'POST', path: `${P}git/blobs`, body: { content: 'x' } }, 'transport-anfrage'],
    [{ method: 'POST', path: `${P}git/blobs`, body: Buffer.from('{}') }, 'transport-anfrage'],
    [{ method: 'POST', path: `${P}git/blobs`, body: '{"a":"\uD800"}' }, 'transport-anfrage'],
    [{ method: 'POST', path: `${P}git/blobs`, body: `{"a":"${'x'.repeat(MAX_REQUEST_BYTES)}"}` }, 'transport-anfrage-gross'],
    [{ method: 'POST', path: `${P}git/blobs`, body: `{"a":"${'ä'.repeat(MAX_REQUEST_BYTES / 2)}"}` }, 'transport-anfrage-gross'],
    [{ method: 'POST', path: `${P}git/blobs`, body: '{"a":' }, 'transport-anfrage-json'],
    [{ method: 'POST', path: `${P}git/blobs`, body: '[1]' }, 'transport-anfrage-json'],
    [{ method: 'POST', path: `${P}git/blobs`, body: 'null' }, 'transport-anfrage-json'],
    [{ method: 'POST', path: `${P}git/blobs`, body: '"x"' }, 'transport-anfrage-json'],
  ];

  for (const [request, code] of anfragen) {
    await keineAnfrage(schreibe(), request, code);
  }

  // Grenze: genau 64 KiB werden angenommen.
  const aufrufe = attrappe(json(201, {}));
  const body = `{"a":"${'x'.repeat(MAX_REQUEST_BYTES - 8)}"}`;
  assert.equal(Buffer.byteLength(body), MAX_REQUEST_BYTES);
  await schreibe()({ method: 'POST', path: `${P}git/blobs`, body });
  assert.equal(aufrufe.length, 1);
});

test('Parallel: eine zweite Anfrage waehrend einer laufenden wird ohne HTTP-Aufruf abgelehnt', async () => {
  let offen = null;
  // Die erste Anfrage bleibt offen, bis der Test antwortet; jede spaetere wird sofort beantwortet.
  const aufrufe = attrappe(req => (offen === null ? (offen = req) : json(200, {})(req)));
  const transport = schreibe();
  const erste = transport({ method: 'GET', path: LIVE_GET[0] });
  await abgelehnt(transport({ method: 'GET', path: LIVE_GET[1] }), 'transport-parallel');
  assert.equal(aufrufe.length, 1);
  await zustand(erste);
  json(200, {})(offen);
  await erste;
  await transport({ method: 'GET', path: LIVE_GET[1] });
  assert.equal(aufrufe.length, 2);
});

// ---------------------------------------------------------------------------
// HTTP: Status, Weiterleitung, Netz- und TLS-Fehler
// ---------------------------------------------------------------------------

test('HTTP: Weiterleitungen werden nicht verfolgt, Status kommt zurueck, Location faellt weg; readLiveState lehnt ab', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const aufrufe = attrappe(req => antworte(req, { status, kopf: ['Location', 'https://evil.example/x', 'Content-Length', '0'] }));
    const antwort = await schreibe()({ method: 'GET', path: LIVE_GET[0] });
    assert.equal(aufrufe.length, 1, `Weiterleitung ${status} verfolgt`);
    pruefeAntwortform(antwort, status, '');

    const zweite = attrappe(req => antworte(req, { status, kopf: ['Location', `${P}issues/1`] }));
    await assert.rejects(readLiveState({ transport: lese(), repository: REPO, issueNumber: ISSUE, runId: RUN }), error => error.code === 'live-umleitung');
    assert.equal(zweite.length, 1);
  }
});

test('HTTP: Fehlerstatus 401 bis 503 kommen genau einmal zurueck, ohne Wiederholung', async () => {
  for (const status of [401, 403, 404, 409, 422, 429, 500, 502, 503]) {
    const aufrufe = attrappe(json(status, { message: 'nein' }, ['Retry-After', '1', 'X-RateLimit-Remaining', '0']));
    const antwort = await schreibe()({ method: 'GET', path: LIVE_GET[0] });
    assert.equal(aufrufe.length, 1, `Status ${status} wiederholt`);
    pruefeAntwortform(antwort, status, '{"message":"nein"}');

    const zweite = attrappe(json(status, {}));
    await assert.rejects(readLiveState({ transport: lese(), repository: REPO, issueNumber: ISSUE, runId: RUN }), error => error.code === 'live-http-status');
    assert.equal(zweite.length, 1);
  }
});

test('HTTP: Verbindungs-, DNS- und TLS-Fehler ergeben einen festen Fehler ohne Wiederholung und ohne Token', async () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    const aufrufe = attrappe(netzfehler(code));
    await abgelehnt(schreibe()({ method: 'GET', path: LIVE_GET[0] }), 'transport-netz');
    assert.equal(aufrufe.length, 1, code);
    assert.equal(aufrufe[0].zerstoert, 1, `${code}: Anfrage nicht zerstoert`);
  }

  // https.request wirft selbst (etwa ungueltige Option): fester Fehler, kein Text uebernommen.
  https.request = () => {
    throw new Error(`kaputt ${TOKEN}`);
  };
  await abgelehnt(schreibe()({ method: 'GET', path: LIVE_GET[0] }), 'transport-netz');
});

test('HTTP: unvollstaendige Antwort, vorzeitiger Abbruch und Schliessen ohne Ende', async () => {
  for (const ende of ['abbruch', 'schliessen']) {
    const aufrufe = attrappe(req => antworte(req, { teile: ['{"a":'], ende }));
    await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-abbruch');
    assert.equal(aufrufe.length, 1);
  }

  // end, aber Node meldet die Nachricht als unvollstaendig.
  const aufrufe = attrappe(req => {
    const res = antworte(req, { teile: ['{}'], ende: 'haengen' });
    res.push(null);
  });
  await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-abbruch');
  assert.equal(aufrufe.length, 1);
});

test('HTTP: ungueltiger Status der Antwort wird abgelehnt', async () => {
  for (const status of [null, 99, 600, 200.5, '200']) {
    attrappe(req => antworte(req, { status, teile: ['{}'] }));
    await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-antwort-format');
  }
});

// ---------------------------------------------------------------------------
// Zeitgrenze (mock.timers, keine echten 20 Sekunden)
// ---------------------------------------------------------------------------

test('Zeit: keine Antwort, Antwort erst nach 20 s, Kopfzeilen ohne Text und haengender Text werden genau bei 20 s abgebrochen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const faelle = {
    'vor den Kopfzeilen': () => {},
    'waehrend des Textes': req => antworte(req, { teile: ['{"a":'], ende: 'haengen' }),
    'nach den Kopfzeilen ohne Text': req => antworte(req, { ende: 'haengen' }),
  };

  for (const [name, szenario] of Object.entries(faelle)) {
    const aufrufe = attrappe(szenario);
    const laufend = schreibe()({ method: 'GET', path: LIVE_GET[0] });
    assert.equal(await zustand(laufend), 'offen', name);
    t.mock.timers.tick(TIMEOUT_MS - 1);
    assert.equal(await zustand(laufend), 'offen', `${name}: zu frueh abgebrochen`);
    t.mock.timers.tick(1);
    assert.equal(await zustand(laufend), 'abgelehnt', `${name}: kein Abbruch nach 20 s`);
    await abgelehnt(laufend, 'transport-zeitlimit');
    assert.equal(aufrufe.length, 1, `${name}: Wiederholung nach Zeitlimit`);
    assert.equal(aufrufe[0].zerstoert, 1, `${name}: Anfrage nicht zerstoert`);

    if (aufrufe[0].antwort !== null) {
      assert.ok(aufrufe[0].antwort.destroyed, `${name}: Antwortstrom nicht zerstoert`);
    }

    // Eine spaete Antwort aendert nichts mehr und wird sofort verworfen.
    const spaet = antworte(aufrufe[0], { teile: ['{}'] });
    assert.ok(spaet.destroyed);
    await abgelehnt(laufend, 'transport-zeitlimit');
    t.mock.timers.tick(10 * TIMEOUT_MS);
    assert.equal(aufrufe.length, 1);
  }
});

test('Zeit: ein Zeitgeber fuer die ganze Anfrage, nach Erfolg geloescht', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let req = null;
  const aufrufe = attrappe(r => { req = r; });
  const laufend = schreibe()({ method: 'GET', path: LIVE_GET[0] });
  await zustand(laufend);
  t.mock.timers.tick(TIMEOUT_MS - 5);
  // Die Antwort beginnt spaet: der Zeitgeber laeuft weiter und wird nicht neu gestartet.
  const res = antworte(req, { teile: ['{"a":'], ende: 'haengen' });
  t.mock.timers.tick(4);
  assert.equal(await zustand(laufend), 'offen');
  t.mock.timers.tick(1);
  await abgelehnt(laufend, 'transport-zeitlimit');
  assert.ok(res.destroyed);

  // Nach einer erfolgreichen Antwort loest der Zeitgeber nichts mehr aus.
  const zweite = attrappe(json(200, {}));
  await schreibe()({ method: 'GET', path: LIVE_GET[0] });
  t.mock.timers.tick(10 * TIMEOUT_MS);
  assert.equal(zweite[0].zerstoert, 0, 'Zeitgeber nach Erfolg nicht geloescht');
  assert.equal(aufrufe.length, 1);
});

// ---------------------------------------------------------------------------
// Antwortgroesse, Laenge, UTF-8
// ---------------------------------------------------------------------------

test('Groesse: ueber 16 MiB wird beim Lesen abgebrochen, auch erst im letzten Teil und ohne Content-Length', async () => {
  const mib = Buffer.alloc(1024 * 1024, 0x61);

  // Ueberschreitung im letzten Teil, Strom endet nie: Abbruch sofort, nicht erst am Ende.
  const aufrufe = attrappe(req => antworte(req, { teile: [...Array.from({ length: 16 }, () => mib), Buffer.from('a')], ende: 'haengen' }));
  const laufend = lese()({ method: 'GET', path: LIVE_GET[0] });
  assert.equal(await zustand(laufend), 'abgelehnt', 'Groesse erst nach dem Ende geprueft');
  await abgelehnt(laufend, 'transport-antwort-gross');
  assert.ok(aufrufe[0].antwort.destroyed, 'Antwortstrom nicht zerstoert');
  assert.equal(aufrufe[0].zerstoert, 1);

  // Mit Ende, ohne Laengenangabe.
  attrappe(req => antworte(req, { teile: [...Array.from({ length: 16 }, () => mib), Buffer.from('a')] }));
  await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-antwort-gross');
});

test('Laenge: zu grosse Ankuendigung frueh, zu kleine, zu grosse oder falsche Content-Length, doppelte Angabe', async () => {
  // Ankuendigung ueber der Grenze: Abbruch vor jedem Text.
  const frueh = attrappe(req => antworte(req, { kopf: ['Content-Length', String(MAX_BODY_BYTES + 1)], ende: 'haengen' }));
  const laufend = lese()({ method: 'GET', path: LIVE_GET[0] });
  assert.equal(await zustand(laufend), 'abgelehnt');
  await abgelehnt(laufend, 'transport-antwort-gross');
  assert.ok(frueh[0].antwort.destroyed);

  const faelle = [
    [['Content-Length', '1'], ['{}'], 'transport-laenge'],
    [['Content-Length', '5'], ['{}'], 'transport-laenge'],
    [['Content-Length', 'abc'], ['{}'], 'transport-laenge'],
    [['Content-Length', '-2'], ['{}'], 'transport-laenge'],
    [['Content-Length', '02'], ['{}'], 'transport-laenge'],
    [['Content-Length', '2', 'content-length', '2'], ['{}'], 'transport-laenge'],
  ];

  for (const [kopf, teile, code] of faelle) {
    const aufrufe = attrappe(req => antworte(req, { kopf, teile }));
    await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), code);
    assert.equal(aufrufe.length, 1);
  }

  // Passende Laenge wird angenommen.
  attrappe(req => antworte(req, { kopf: ['Content-Length', '2'], teile: ['{}'] }));
  assert.equal((await lese()({ method: 'GET', path: LIVE_GET[0] })).body, '{}');
});

test('UTF-8: ungueltige, ueberlange und abgeschnittene Folgen werden abgelehnt, BOM bleibt erhalten', async () => {
  for (const bytes of [[0xff], [0xc3, 0x28], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0x7b, 0xc3]]) {
    attrappe(req => antworte(req, { teile: [Buffer.from(bytes)] }));
    await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-utf8');
  }

  // Ein Mehrbytezeichen ueber zwei Teile ist gueltig.
  attrappe(req => antworte(req, { teile: [Buffer.from([0x22, 0xc3]), Buffer.from([0xa4, 0x22])] }));
  assert.equal((await lese()({ method: 'GET', path: LIVE_GET[0] })).body, '"ä"');

  attrappe(req => antworte(req, { teile: [Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])] }));
  assert.equal((await lese()({ method: 'GET', path: LIVE_GET[0] })).body, '﻿{}');
});

test('Komprimierung: jede Content-Encoding-Zeile wird abgelehnt, ohne zu entpacken, auch eine kleine Bombe', async () => {
  const bombe = gzipSync(Buffer.alloc(20 * 1024 * 1024));
  assert.ok(bombe.length < 64 * 1024, 'Gegenprobe: die Bombe ist klein');

  const faelle = [
    [['Content-Encoding', 'gzip'], [bombe]],
    [['content-encoding', 'br'], ['x']],
    [['CONTENT-ENCODING', 'deflate'], ['x']],
    [['Content-Encoding', 'identity'], ['{}']],
    [['Content-Encoding', ''], ['{}']],
  ];

  for (const [kopf, teile] of faelle) {
    const aufrufe = attrappe(req => antworte(req, { kopf, teile, ende: 'haengen' }));
    const laufend = lese()({ method: 'GET', path: LIVE_GET[0] });
    assert.equal(await zustand(laufend), 'abgelehnt', kopf.join(' '));
    await abgelehnt(laufend, 'transport-komprimiert');
    assert.ok(aufrufe[0].antwort.destroyed);
    assert.equal(aufrufe.length, 1);
  }
});

test('Kopfzeilen: doppelte link- und content-encoding-Zeilen werden ueber rawHeaders erkannt, nicht ueber headers', async () => {
  // Node fasst doppelte Zeilen in headers still mit Komma zusammen; die Attrappe zeigt genau das.
  const zweiLinks = ['Link', '<https://api.github.com/x?page=2>; rel="next"', 'link', '<https://api.github.com/x?page=3>; rel="last"'];
  attrappe(req => antworte(req, { kopf: zweiLinks, teile: ['[]'], nodeHeaders: { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=3>; rel="last"' } }));
  await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-header-mehrdeutig');

  const zweiCodierungen = ['Content-Encoding', 'identity', 'content-encoding', 'identity'];
  attrappe(req => antworte(req, { kopf: zweiCodierungen, teile: ['{}'], nodeHeaders: { 'content-encoding': 'identity, identity' } }));
  await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-komprimiert');

  // headers ohne Befund, rawHeaders mit Befund: das Modul liest rawHeaders.
  attrappe(req => antworte(req, { kopf: ['Content-Encoding', 'gzip'], teile: ['{}'], nodeHeaders: {} }));
  await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-komprimiert');

  for (const link of ['a\u0000b', 'x'.repeat(8193)]) {
    attrappe(req => antworte(req, { kopf: ['Link', link], teile: ['[]'] }));
    await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-header-mehrdeutig');
  }

  for (const kopf of [['Link'], ['Link', 1], 'x']) {
    attrappe(req => antworte(req, { kopf, teile: ['[]'] }));
    await abgelehnt(lese()({ method: 'GET', path: LIVE_GET[0] }), 'transport-antwort-format');
  }
});

test('Kopfzeilen: nur link wird uebernommen, alle anderen fallen weg', async () => {
  const kopf = [
    'Link', '<https://api.github.com/x?page=2>; rel="next"',
    'Set-Cookie', 'a=b', 'Server', 'GitHub.com', 'Authorization', `Bearer ${TOKEN}`, 'X-GitHub-Token', TOKEN,
    'X-GitHub-Request-Id', 'ABC', 'X-Debug', '1', 'traceparent', '00-1', 'Location', 'https://evil.example',
    'Content-Type', 'application/json', 'Content-Length', '2', 'X-RateLimit-Remaining', '1',
  ];
  attrappe(req => antworte(req, { kopf, teile: ['[]'] }));
  const antwort = await lese()({ method: 'GET', path: LIVE_GET[0] });
  pruefeAntwortform(antwort, 200, '[]', { link: '<https://api.github.com/x?page=2>; rel="next"' });

  attrappe(req => antworte(req, { kopf: kopf.slice(2), teile: ['[]'] }));
  pruefeAntwortform(await lese()({ method: 'GET', path: LIVE_GET[0] }), 200, '[]', {});
});

// ---------------------------------------------------------------------------
// Schreiboperationen und Sperre nach POST pulls
// ---------------------------------------------------------------------------

const GIT_REFS = { method: 'POST', path: `${P}git/refs`, body: JSON.stringify(POSTS['git/refs']) };
const PULLS = { method: 'POST', path: `${P}pulls`, body: JSON.stringify(POSTS.pulls) };
const LOESCHEN = { method: 'DELETE', path: `${P}git/refs/heads/${BRANCH}` };

test('Schreiben: Fehler oder Zeitlimit nach POST git/refs ohne Wiederholung; Loeschen bleibt dem Veroeffentlicher ueberlassen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const faelle = [
    ['Verbindung getrennt', netzfehler('ECONNRESET'), 'transport-netz'],
    ['Antwort abgebrochen', req => antworte(req, { status: 201, teile: ['{"r'], ende: 'abbruch' }), 'transport-abbruch'],
    ['HTTP 500', json(500, {}), null],
    ['Zeitlimit', () => {}, 'transport-zeitlimit'],
  ];

  for (const [name, szenario, code] of faelle) {
    const aufrufe = attrappe(szenario);
    const transport = schreibe();
    const laufend = transport(GIT_REFS);

    if (name === 'Zeitlimit') {
      await zustand(laufend);
      t.mock.timers.tick(TIMEOUT_MS);
    }

    if (code === null) {
      assert.equal((await laufend).status, 500);
    } else {
      await abgelehnt(laufend, code);
    }

    t.mock.timers.tick(10 * TIMEOUT_MS);
    await zustand(laufend);
    assert.equal(aufrufe.length, 1, `${name}: POST git/refs wiederholt`);

    // Der Transport sperrt nach git/refs nicht: die Bereinigung entscheidet der Veroeffentlicher.
    https.request = ORIGINAL_REQUEST;
    const danach = attrappe(leer204);
    await transport(LOESCHEN);
    assert.equal(danach.length, 1);
  }
});

test('Sperre: nach POST pulls keine Anfrage mehr, egal ob Erfolg, Fehlerstatus, Abbruch, verlorene Antwort oder Zeitlimit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const ausgaenge = {
    'Erfolg 201': [json(201, { number: 1 }), null],
    'HTTP 500': [json(500, { message: 'x' }), null],
    'HTTP 422': [json(422, { message: 'x' }), null],
    'Verbindung getrennt': [netzfehler('ECONNRESET'), 'transport-netz'],
    'Antwort verloren': [req => antworte(req, { status: 201, teile: ['{"num'], ende: 'abbruch' }), 'transport-abbruch'],
    'unvollstaendige Antwort': [req => antworte(req, { status: 201, teile: ['{"num'], ende: 'schliessen' }), 'transport-abbruch'],
    Zeitlimit: [() => {}, 'transport-zeitlimit'],
  };

  for (const [name, [szenario, code]] of Object.entries(ausgaenge)) {
    const aufrufe = attrappe(szenario);
    const transport = schreibe();
    const laufend = transport(PULLS);

    if (name === 'Zeitlimit') {
      await zustand(laufend);
      t.mock.timers.tick(TIMEOUT_MS);
    }

    if (code === null) {
      await laufend;
    } else {
      await abgelehnt(laufend, code);
    }

    t.mock.timers.tick(10 * TIMEOUT_MS);

    for (const request of [PULLS, { method: 'GET', path: LIVE_GET[0] }, { method: 'GET', path: PUBLISH_GET[3] }, GIT_REFS, LOESCHEN, { method: 'GET', path: '/x' }]) {
      await abgelehnt(transport(request), 'transport-abgeschlossen');
    }

    assert.equal(aufrufe.length, 1, `${name}: weitere Anfrage nach POST pulls`);
  }
});

test('Sperre: greift vor dem Abschicken; ein parallel wartendes POST pulls schliesst sofort', async () => {
  let req = null;
  const aufrufe = attrappe(r => { req = r; });
  const transport = schreibe();
  const laufend = transport(PULLS);
  await abgelehnt(transport({ method: 'GET', path: LIVE_GET[0] }), 'transport-abgeschlossen');
  await abgelehnt(transport(PULLS), 'transport-abgeschlossen');
  assert.equal(aufrufe.length, 1);
  json(201, {})(req);
  await laufend;
  await abgelehnt(transport(LOESCHEN), 'transport-abgeschlossen');
  assert.equal(aufrufe.length, 1);
});

test('Sperre: eine abgelehnte PR-Anfrage (ungueltige Form) sperrt nicht, eine andere Transportinstanz bleibt frei', async () => {
  const aufrufe = attrappe(json(201, {}));
  const transport = schreibe();
  await abgelehnt(transport({ method: 'POST', path: `${P}pulls`, body: '[]' }), 'transport-anfrage-json');
  await transport({ method: 'GET', path: LIVE_GET[0] });
  await transport(PULLS);
  await abgelehnt(transport(PULLS), 'transport-abgeschlossen');
  await schreibe()({ method: 'GET', path: LIVE_GET[0] });
  assert.equal(aufrufe.length, 3);
});

// ---------------------------------------------------------------------------
// Token nie offengelegt
// ---------------------------------------------------------------------------

test('Token: in keinem Fehler, keiner Antwort und keinem Fehlerpfad sichtbar; nur im Authorization-Kopf', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pfade = [
    [netzfehler('ECONNREFUSED'), 'transport-netz'],
    [req => antworte(req, { teile: ['{'], ende: 'abbruch' }), 'transport-abbruch'],
    [req => antworte(req, { kopf: ['Content-Encoding', 'gzip'] }), 'transport-komprimiert'],
    [req => antworte(req, { teile: [Buffer.from([0xff])] }), 'transport-utf8'],
    [req => antworte(req, { kopf: ['Content-Length', '9'], teile: ['{}'] }), 'transport-laenge'],
    [req => antworte(req, { kopf: ['Content-Length', String(MAX_BODY_BYTES + 1)] }), 'transport-antwort-gross'],
    [req => antworte(req, { kopf: ['Link', 'a', 'Link', 'b'] }), 'transport-header-mehrdeutig'],
    [req => antworte(req, { status: 7 }), 'transport-antwort-format'],
  ];

  for (const [szenario, code] of pfade) {
    const aufrufe = attrappe(szenario);
    await abgelehnt(schreibe()({ method: 'GET', path: LIVE_GET[0] }), code);
    assert.equal(aufrufe[0].options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!aufrufe[0].options.path.includes(TOKEN));
  }

  const zeit = attrappe(() => {});
  const laufend = schreibe()({ method: 'GET', path: LIVE_GET[0] });
  await zustand(laufend);
  t.mock.timers.tick(TIMEOUT_MS);
  await abgelehnt(laufend, 'transport-zeitlimit');
  assert.equal(zeit.length, 1);

  const transport = schreibe();
  await abgelehnt(transport({ method: 'GET', path: `${P}issues/${TOKEN}` }), 'transport-endpunkt');
  await abgelehnt(transport({ method: 'POST', path: `${P}git/blobs`, body: `{"x":"${TOKEN}"` }), 'transport-anfrage-json');
  keinToken(transport);
  keinToken(createReadTransport);

  // Antworttext ist Sache des Fachmoduls; Kopfzeilen mit Token fallen weg.
  attrappe(req => antworte(req, { kopf: ['X-Token', TOKEN, 'Authorization', TOKEN], teile: ['{}'] }));
  keinToken(await schreibe()({ method: 'GET', path: LIVE_GET[0] }));
});

// Zustandsloses Installationstoken ghs_APPID_JWT (GitHub, voreingestellt seit 02.10.2026). Alle Werte
// sind synthetisch: Kopf und Nutzlast sind base64url aus festen Testtexten, die Signatur ist erfunden.
const b64url = text => Buffer.from(text, 'utf8').toString('base64url');
const JWT_KOPF = b64url('{"alg":"RS256","typ":"JWT","test":"ohne-wirkung"}');
const JWT_NUTZLAST = b64url('{"nur":"test","ohne":"wirkung","n":123456789}');
const JWT_SIGNATUR = 'NurTest-Signatur_ohne-Wirkung-0123456789';
const jwtToken = (appId = '123456', signatur = JWT_SIGNATUR) => `ghs_${appId}_${JWT_KOPF}.${JWT_NUTZLAST}.${signatur}`;
const TOKEN_JWT = jwtToken();

// Kein Teil des Tokens nach dem Praefix darf in Fehlern, Ergebnissen oder Funktionen auftauchen.
function keinJwtTeil(value, token) {
  const texte = [inspect(value, { depth: 10, showHidden: true }), String(value?.stack ?? ''), String(value?.message ?? '')];

  try {
    texte.push(String(JSON.stringify(value)));
  } catch {
    // nicht serialisierbar ist hier kein Befund
  }

  const teile = [token, token.slice(4), ...token.slice(4).split(/[._]/).filter(teil => teil.length >= 8)];

  for (const text of texte) {
    for (const teil of teile) {
      assert.ok(!text.includes(teil), 'Tokenteil offengelegt');
    }
  }
}

test('Token: zustandsloses Format ghs_APPID_JWT wird angenommen, mit Grenzen und nur im Authorization-Kopf', async () => {
  // Gegenprobe: der Kopf ist wirklich base64url mit Bindestrich oder Unterstrich, sonst prueft der Test sie nicht.
  assert.ok(TOKEN_JWT.length > 100 && TOKEN_JWT.split('.').length === 3);
  assert.ok(/[-]/.test(TOKEN_JWT.slice(4)) && /_/.test(TOKEN_JWT.slice(4)));

  const gut = [
    TOKEN_JWT,
    jwtToken('1'),
    jwtToken('12'),
    jwtToken('9'.repeat(20)),
    'ghs_1_a.b.c',
    'ghs_7_-.-._',
    'ghs_42_ab-cd_ef.gh-ij_kl.mn-op_qr',
  ];
  const kopfUndNutzlast = `ghs_123456_${JWT_KOPF}.${JWT_NUTZLAST}.`;
  const genau1024 = kopfUndNutzlast + 's'.repeat(1024 - kopfUndNutzlast.length);
  assert.equal(genau1024.length, 1024);
  gut.push(genau1024);

  for (const make of [createReadTransport, createPublishTransport]) {
    for (const token of gut) {
      assert.equal(typeof make(input({ token })), 'function', token.length);
    }
  }

  const schlecht = [
    `${genau1024}s`,
    jwtToken('0'),
    jwtToken('0123'),
    jwtToken('9'.repeat(21)),
    jwtToken('12a'),
    jwtToken(''),
    `ghs_123456_${JWT_KOPF}.${JWT_NUTZLAST}`,
    `ghs_123456_${JWT_KOPF}.${JWT_NUTZLAST}.${JWT_SIGNATUR}.x`,
    `ghs_123456_${JWT_KOPF}..${JWT_SIGNATUR}`,
    `ghs_123456_.${JWT_NUTZLAST}.${JWT_SIGNATUR}`,
    `ghs_123456_${JWT_KOPF}.${JWT_NUTZLAST}.`,
    `ghs_123456.${JWT_KOPF}.${JWT_NUTZLAST}.${JWT_SIGNATUR}`,
    'ghs_1_a.b.c=',
    'ghs_1_a+b.c.d',
    'ghs_1_a/b.c.d',
    'ghs_1_a.b.c:d',
    'ghs_1_a.b.c;',
    'ghs_1_ä.b.c',
    'ghs_1_a.b.c ',
    ' ghs_1_a.b.c',
    'ghs_1_a.b c.d',
    'ghs_1_a.b.c\n',
    'ghs_1_a.b.c\r\nX-Boese: 1',
    'ghs_1_a.b.c\t',
    'ghs_1_a.b\u0000.c',
    'ghs_1_a.b\u007f.c',
    'ghp_123456_a.b.c',
    'gho_123456_a.b.c',
    'ghu_123456_a.b.c',
    'ghr_123456_a.b.c',
    'GHS_123456_a.b.c',
    'github_pat_123456_a.b.c',
    `Bearer ${TOKEN_JWT}`,
    `${TOKEN_JWT}\n`,
    TOKEN_JWT.replace('ghs_', 'ghp_'),
    new String(TOKEN_JWT),
    undefined,
    '',
  ];

  const aufrufe = attrappe(json(200, {}));

  for (const make of [createReadTransport, createPublishTransport]) {
    for (const token of schlecht) {
      assert.throws(() => make(input({ token })), error => {
        assert.equal(error.name, 'OrderError', String(error));
        assert.equal(error.code, 'transport-token');
        keinToken(error);

        if (typeof token === 'string' && token.length > 12) {
          keinJwtTeil(error, token.trim());
        }

        return true;
      });
    }
  }

  assert.equal(aufrufe.length, 0, 'eine Anfrage vor der Tokenpruefung');

  // Im Lauf steht das zustandslose Token nur im Authorization-Kopf, nie im Pfad, Ergebnis oder Fehler.
  for (const make of [lese, schreibe]) {
    const ok = attrappe(json(200, { ok: true }));
    const transport = make({ token: TOKEN_JWT });
    const ergebnis = await transport({ method: 'GET', path: LIVE_GET[0] });
    assert.equal(ok.length, 1);
    assert.equal(ok[0].options.headers.Authorization, `Bearer ${TOKEN_JWT}`);
    assert.ok(!ok[0].options.path.includes(TOKEN_JWT.slice(4)));
    keinJwtTeil(ergebnis, TOKEN_JWT);
    keinJwtTeil(transport, TOKEN_JWT);

    attrappe(netzfehler('ECONNREFUSED'));
    const fehler = await make({ token: TOKEN_JWT })({ method: 'GET', path: LIVE_GET[0] }).then(() => null, error => error);
    assert.equal(fehler?.code, 'transport-netz');
    keinJwtTeil(fehler, TOKEN_JWT);
  }
});

// ---------------------------------------------------------------------------
// TLS-, Agent- und Proxy-Konfiguration
// ---------------------------------------------------------------------------

test('Konfiguration: eigener Agent mit keepAlive aus, einem Socket, Mozilla-Wurzeln, Pruefung an, ohne Proxy', async () => {
  assert.ok(Array.isArray(tls.rootCertificates) && Object.isFrozen(tls.rootCertificates));
  assert.ok(tls.rootCertificates.length > 50, 'gebuendelte Wurzeln fehlen');

  const agenten = new Set();

  for (const make of [lese, schreibe, lese]) {
    const aufrufe = attrappe(json(200, {}));
    const transport = make();
    await transport({ method: 'GET', path: LIVE_GET[0] });
    await transport({ method: 'GET', path: LIVE_GET[1] });
    const agent = aufrufe[0].options.agent;
    assert.equal(aufrufe[1].options.agent, agent, 'Agent je Anfrage gewechselt');
    agenten.add(agent);

    assert.ok(agent instanceof https.Agent);
    assert.equal(agent.keepAlive, false);
    assert.equal(agent.maxSockets, 1);
    assert.equal(agent.maxTotalSockets, 1);
    assert.equal(agent.options.keepAlive, false);
    assert.equal(agent.options.ca, tls.rootCertificates, 'CA-Liste nicht ausdruecklich die gebuendelte');
    assert.equal(agent.options.rejectUnauthorized, true);
    assert.deepEqual(agent.options.proxyEnv, {});
    assert.ok(Object.isFrozen(agent.options.proxyEnv));

    for (const key of ['checkServerIdentity', 'servername', 'lookup', 'host', 'hostname', 'cert', 'key', 'pfx', 'secureContext', 'minVersion', 'ciphers', 'proxy']) {
      assert.ok(!Object.hasOwn(agent.options, key) || agent.options[key] === undefined, `unerwartete Agent-Option ${key}`);
    }
  }

  assert.equal(agenten.size, 3, 'Transporte teilen sich einen Agent');
});

// ---------------------------------------------------------------------------
// Wachen auf den Quelltext und die anderen Skripte
// ---------------------------------------------------------------------------

test('Wache: nur die vorgesehenen Importe, kein Veroeffentlicher, keine Umgebung, kein fetch, ein Aufruf von https.request', () => {
  const imports = [...SOURCE.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./agent-code-auftrag-live.mjs', './agent-code-auftrag.mjs', 'node:https', 'node:tls', 'node:util']);
  assert.equal([...SOURCE.matchAll(/\bimport\b/g)].length, imports.length);
  assert.ok(SOURCE.includes("import { MAX_BODY_BYTES, checkApiRequest } from './agent-code-auftrag-live.mjs';"));
  assert.ok(SOURCE.includes("import { MAX_ISSUE_NUMBER, OrderError, REPOSITORY } from './agent-code-auftrag.mjs';"));
  assert.ok(!SOURCE.includes('agent-code-auftrag-publish'), 'Transport verweist auf den Veroeffentlicher');

  for (const forbidden of [/\bprocess\b/, /\bfetch\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bglobalThis\b/, /\brequire\b/, /\bconsole\b/, /GITHUB_/, /\beval\b/, /\bFunction\b/, /node:(?:http|net|dns|child_process|fs|zlib|vm|worker_threads)'/, /createGunzip|createInflate|createBrotli|zlib/, /\bresponse\.headers\b|\bincoming\.headers\b/, /\.text\(\)|arrayBuffer\(\)/, /keepAlive:\s*true/, /rejectUnauthorized:\s*false/, /checkServerIdentity/, /\bservername\b/, /NODE_TLS/, /setInterval/, /\bwhile\s*\(/, /\bfor\s*\(\s*;;/]) {
    assert.ok(!forbidden.test(SOURCE), `verbotenes Muster im Modul: ${forbidden}`);
  }

  // Muss-Treffer: dieselben Suchen finden etwas, wo es vorkommt.
  assert.ok(/\bprocess\b/.test(readFileSync(join(ROOT, 'scripts', 'agent-code-publish.mjs'), 'utf8')));
  assert.ok(/\bfetch\b/.test('await fetch(url)') && /keepAlive:\s*true/.test('keepAlive: true'));

  assert.equal([...SOURCE.matchAll(/https\.request\(/g)].length, 1, 'genau eine Stelle fuer HTTP');
  assert.equal([...SOURCE.matchAll(/\bsetTimeout\(/g)].length, 1, 'genau ein Zeitgeber');
  assert.equal([...SOURCE.matchAll(/new https\.Agent\(/g)].length, 1);
  assert.equal([...SOURCE.matchAll(/^export\b/gm)].length, 2, 'genau zwei Exporte');
  assert.ok(/^export function createReadTransport\(input\)/m.test(SOURCE) && /^export function createPublishTransport\(input\)/m.test(SOURCE));
  assert.ok(SOURCE.includes("const TIMEOUT_MS = 20_000;"), 'Zeitgrenze nicht fest');
  assert.ok(SOURCE.includes('const MAX_REQUEST_BYTES = 64 * 1024;'));
  assert.ok(SOURCE.includes("const API_ORIGIN = 'https://api.github.com';"));
  assert.ok(/keepAlive: false,\s+maxSockets: 1,\s+maxTotalSockets: 1,\s+ca: ROOT_CERTIFICATES,\s+rejectUnauthorized: true,\s+proxyEnv: NO_PROXY_ENV,/.test(SOURCE));
});

test('Wache: kein Workflow und kein anderes Skript verweist auf das Transportmodul', () => {
  const workflows = join(ROOT, '.github', 'workflows');
  const files = readdirSync(workflows).filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.length >= 10, 'Gegenprobe: zu wenige Workflows gefunden');
  assert.ok(files.every(name => !readFileSync(join(workflows, name), 'utf8').includes('agent-code-auftrag')), 'ein Workflow verweist auf ein Auftragsmodul');

  const scripts = join(ROOT, 'scripts');
  const names = readdirSync(scripts).filter(name => name.endsWith('.mjs'));
  assert.ok(names.includes('agent-code-auftrag-transport.mjs'), 'Gegenprobe: Modul fehlt');
  const others = names.filter(name => name !== 'agent-code-auftrag-transport.mjs' && name !== 'agent-code-job-auftrag.mjs' && name !== 'agent-code-job-claude-vor.mjs' && name !== 'agent-code-job-veroeffentlichen.mjs').map(name => readFileSync(join(scripts, name), 'utf8'));
  assert.ok(others.length >= 10, 'Gegenprobe: zu wenige Skripte gefunden');
  assert.ok(others.some(text => text.includes('agent-code-auftrag-live')), 'Gegenprobe ohne Treffer');
  assert.ok(others.every(text => !text.includes('agent-code-auftrag-transport')), 'ein Skript verweist auf das Transportmodul');
});

test('Wache: in dieser Testdatei wurde kein Socket verbunden', () => {
  assert.equal(socketVersuche, 0);
  // Muss-Treffer: der Waechter greift tatsaechlich.
  assert.throws(() => new net.Socket().connect(1, '127.0.0.1'), /Socket im Transporttest verboten/);
  assert.equal(socketVersuche, 1);
  socketVersuche = 0;
});
