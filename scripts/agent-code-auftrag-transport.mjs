// A6.4-2b: Sicherer GitHub-REST-Transport fuer die Auftragsmodule.
//
// Wirkungslos bis A6.4: Kein Workflow und kein anderes Skript ruft dieses Modul auf. Es hat keinen
// Einstiegspunkt und liest keine Prozessumgebung. Das Token kommt ausschliesslich als Argument.
//
// Oeffentlich sind genau zwei Fabriken:
// - createReadTransport({ token, issueNumber, runId }): nur GET auf die sechs Live-Endpunkte, und
//   zwar nur fuer genau dieses Issue und genau diesen Lauf. Jede Anfrage muss zusaetzlich
//   checkApiRequest aus dem Live-Modul bestehen.
// - createPublishTransport({ token, issueNumber, runId }): dieselben Live-Endpunkte und zusaetzlich
//   die Anfragen des Veroeffentlichers (POST git/blobs, git/trees, git/commits, git/refs, pulls; GET
//   git/commits/<sha>, git/trees/<sha>?recursive=1, compare/<sha>...<sha>, git/ref/heads/<eigener
//   Branch>; DELETE git/refs/heads/<eigener Branch>). Das ist eine zweite, unabhaengige Schranke: Der
//   Veroeffentlicher wird bewusst nicht importiert (seine Wache verbietet das), der eigene Branch wird
//   hier selbst aus Issue und Lauf berechnet. Ein Vertragstest haelt beide Schranken gleich.
// Beide liefern eine eingefrorene Funktion transport(request) mit dem Vertrag der Live- und
// Veroeffentlichungsmodule: request ist { method, path } oder { method, path, body } (nur POST, body
// als fertiger JSON-Text), Ergebnis ist { status, headers, body } mit headers als neuem einfachem
// Objekt, das hoechstens link enthaelt.
//
// Verbindliche Eigenschaften jeder Anfrage:
// - Genau ein Aufruf von https.request, kein Retry, kein Folgen von Weiterleitungen (3xx kommt als
//   Status zurueck und wird vom Fachmodul abgelehnt), keine Token-Erneuerung.
// - Feste Herkunft https://api.github.com:443. Der Pfad wird vorab streng geprueft und danach ueber
//   URL bestaetigt: pathname plus search muessen exakt dem geprueften Pfad entsprechen.
// - Eigener https.Agent: keepAlive aus, ein Socket, ausdruecklich gesetzte Mozilla-Wurzeln aus
//   tls.rootCertificates (ersetzt damit NODE_EXTRA_CA_CERTS und System-Wurzeln), Zertifikats- und
//   Hostnamenpruefung an, kein Proxy (proxyEnv ausdruecklich leer). Die Agent-Optionen ueberschreiben
//   in Node die Optionen der einzelnen Anfrage.
// - Ein einziger Zeitgeber von 20 Sekunden ab vor https.request bis zur vollstaendigen Antwort.
// - Hoechstens MAX_BODY_BYTES empfangene Bytes, gezaehlt beim Lesen; keine Komprimierung
//   (Accept-Encoding: identity, jede Content-Encoding-Zeile wird abgelehnt); strenges UTF-8.
// - Doppelte link-, content-encoding- und content-length-Zeilen werden ueber rawHeaders erkannt, weil
//   Node sie in headers still zusammenfasst.
// - Ab dem Abschicken von POST pulls ist der Transport endgueltig gesperrt: keine weitere Anfrage
//   jeder Art, unabhaengig vom Ausgang. Der Veroeffentlicher behaelt zusaetzlich seine eigenen Sperren.
// - Fehler tragen feste Codes und feste Texte. Kein Text aus Netzfehlern, keine Kopfzeilen, kein Token.
//
// Grenzen, die dieses Modul nicht schliessen kann:
// - Die Tokenpruefung ist nur eine Form- und Verwechslungssperre (ghs_). Herkunft, App-Installation,
//   Repository-Begrenzung und Rechte des Tokens muessen A6.4-2c und A6.4-4 belegen.
// - Die produktive TLS-Verbindung zu GitHub, echte Rate-Limits, Workflow-Einstieg, Job- und
//   Laufbindung, Prozessbaum-Isolation und das Entfernen unerlaubter Node- und Proxy-Variablen aus
//   der Job-Umgebung sind hier nicht belegt.
// - Ein Zeitlimit oder Abbruch nach einem schreibenden Aufruf laesst offen, ob GitHub ihn ausgefuehrt
//   hat. Der Transport wiederholt nie; die Entscheidung bleibt beim Fachmodul.

import https from 'node:https';
import tls from 'node:tls';
import { types } from 'node:util';

import { MAX_ISSUE_NUMBER, OrderError, REPOSITORY } from './agent-code-auftrag.mjs';
import { MAX_BODY_BYTES, checkApiRequest } from './agent-code-auftrag-live.mjs';

const API_ORIGIN = 'https://api.github.com';
const API_HOST = 'api.github.com';
const API_PORT = 443;
const API_PREFIX = `/repos/${REPOSITORY}/`;
const TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 64 * 1024;
// Grosszuegige Obergrenze gegen uebergrosse Kopfzeilen, keine Annahme ueber das GitHub-Format.
const MAX_TOKEN_LENGTH = 1024;
const MAX_PATH_LENGTH = 512;
const MAX_LINK_LENGTH = 8192;
const USER_AGENT = 'noah04091-agenten-probe-a6-transport';
const API_VERSION = '2022-11-28';
const TOKEN_RE = /^ghs_[A-Za-z0-9_]+$/;
const RUN_ID_RE = /^[1-9][0-9]{0,15}$/;
const BRANCH_RE = /^wp\/[1-9][0-9]{0,7}-agent-[1-9][0-9]{0,15}-1$/;
const PATH_CHARS_RE = /^[A-Za-z0-9/._?=&-]+$/;
const CONTENT_LENGTH_RE = /^(?:0|[1-9][0-9]{0,15})$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PAGES = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
const POST_PATHS = Object.freeze(['git/blobs', 'git/trees', 'git/commits', 'git/refs', 'pulls']);
const PUBLISH_GET_PATTERNS = Object.freeze([
  /^git\/commits\/[0-9a-f]{40}$/,
  /^git\/trees\/[0-9a-f]{40}\?recursive=1$/,
  /^compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/,
]);
const INPUT_KEYS = Object.freeze(['token', 'issueNumber', 'runId']);
const REQUEST_KEYS = Object.freeze(['method', 'path', 'body']);
const ROOT_CERTIFICATES = tls.rootCertificates;
const NO_PROXY_ENV = Object.freeze({});

function fail(code, message) {
  throw new OrderError(code, `Transport abgelehnt: ${message}`);
}

function transportError(code, message) {
  return new OrderError(code, `Transport abgelehnt: ${message}`);
}

// Wie in den anderen Auftragsmodulen: nur einfache Objekte ohne Proxy.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Liest genau die erlaubten Schluessel als sichtbare, eigene Dateneigenschaften. Getter, versteckte,
// zusaetzliche und Symbol-Schluessel scheitern.
function readFields(value, allowed, required, code, what) {
  if (!isPlainObject(value)) {
    fail(code, `${what} ist kein einfaches Objekt`);
  }

  const keys = Reflect.ownKeys(value);
  const fields = {};

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptor) || !descriptor.enumerable) {
      fail(code, `${what} enthaelt ein unerlaubtes Feld`);
    }

    fields[key] = descriptor.value;
  }

  if (!required.every(key => keys.includes(key))) {
    fail(code, `${what} ist unvollstaendig`);
  }

  return fields;
}

function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId) && Number.isSafeInteger(Number(runId));
}

function readInput(input) {
  const fields = readFields(input, INPUT_KEYS, INPUT_KEYS, 'transport-eingabe', 'Eingabe');

  if (
    typeof fields.token !== 'string' ||
    fields.token.length > MAX_TOKEN_LENGTH ||
    !TOKEN_RE.test(fields.token)
  ) {
    fail('transport-token', 'Token fehlt oder ist kein Installationstoken (ghs_)');
  }

  if (!Number.isSafeInteger(fields.issueNumber) || fields.issueNumber < 1 || fields.issueNumber > MAX_ISSUE_NUMBER) {
    fail('transport-issue-nummer', 'Issue-Nummer ungueltig');
  }

  if (!isValidRunId(fields.runId)) {
    fail('transport-lauf-id', 'Lauf-ID ungueltig');
  }

  return fields;
}

function checkRootCertificates() {
  if (
    !Array.isArray(ROOT_CERTIFICATES) ||
    !Object.isFrozen(ROOT_CERTIFICATES) ||
    ROOT_CERTIFICATES.length === 0 ||
    !ROOT_CERTIFICATES.every(pem => typeof pem === 'string' && pem.startsWith('-----BEGIN CERTIFICATE-----'))
  ) {
    fail('transport-tls', 'gebuendelte Wurzelzertifikate fehlen');
  }
}

// Exakte Liste der Live-Pfade fuer genau dieses Issue und genau diesen Lauf.
function livePaths(issueNumber, runId) {
  return new Set([
    `${API_PREFIX}actions/runs/${runId}`,
    `${API_PREFIX}git/ref/heads/main`,
    `${API_PREFIX}issues/${issueNumber}`,
    ...PAGES.map(page => `${API_PREFIX}issues/${issueNumber}/events?per_page=100&page=${page}`),
    `${API_PREFIX}git/matching-refs/heads/wp/${issueNumber}-`,
    ...PAGES.map(page => `${API_PREFIX}pulls?state=all&sort=created&direction=asc&per_page=100&page=${page}`),
  ]);
}

// Eigene Branchbildung, unabhaengig vom Veroeffentlicher; der Vertragstest vergleicht sie mit ihm.
function ownBranch(issueNumber, runId) {
  const branch = `wp/${issueNumber}-agent-${runId}-1`;

  if (!BRANCH_RE.test(branch)) {
    fail('transport-branch', 'eigener Branch ungueltig');
  }

  return branch;
}

// Form des Pfads ohne Bezug zum Endpunkt: nur ASCII aus einer kleinen Zeichenliste, kein %, #, @, :,
// Backslash, Leerzeichen oder Steuerzeichen, keine leeren, "." oder ".." Segmente, hoechstens ein ?.
function checkPathForm(path) {
  if (
    typeof path !== 'string' ||
    path.length > MAX_PATH_LENGTH ||
    !PATH_CHARS_RE.test(path) ||
    !path.startsWith(API_PREFIX)
  ) {
    fail('transport-pfad', 'Pfad hat eine unerlaubte Form');
  }

  const query = path.indexOf('?');

  if (query !== path.lastIndexOf('?')) {
    fail('transport-pfad', 'Pfad hat mehr als eine Abfrage');
  }

  const segments = (query < 0 ? path : path.slice(0, query)).split('/').slice(1);

  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail('transport-pfad', 'Pfad hat leere oder relative Segmente');
  }

  let url;

  try {
    url = new URL(path, API_ORIGIN);
  } catch {
    fail('transport-url', 'Pfad ergibt keine gueltige Adresse');
  }

  // Keine Normalisierung darf einen Pfad veraendern: was abgeschickt wird, ist genau das Gepruefte.
  if (
    url.origin !== API_ORIGIN ||
    url.protocol !== 'https:' ||
    url.hostname !== API_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    `${url.pathname}${url.search}` !== path
  ) {
    fail('transport-url', 'Pfad gehoert nicht unveraendert zu https://api.github.com');
  }
}

function isLiveRequest(method, path, allowed) {
  if (method !== 'GET' || !allowed.has(path)) {
    return false;
  }

  // Zweite Schicht: die bestehende Request-Grenze des Live-Moduls.
  checkApiRequest(method, path);
  return true;
}

function isPublishRequest(method, path, branch) {
  const rest = path.slice(API_PREFIX.length);

  if (method === 'POST') {
    return POST_PATHS.includes(rest);
  }

  if (method === 'DELETE') {
    return rest === `git/refs/heads/${branch}`;
  }

  return method === 'GET' && (PUBLISH_GET_PATTERNS.some(pattern => pattern.test(rest)) || rest === `git/ref/heads/${branch}`);
}

function readBody(method, fields) {
  const hasBody = Object.hasOwn(fields, 'body');

  if (method !== 'POST') {
    if (hasBody) {
      fail('transport-anfrage', `${method} hat keinen Anfragetext`);
    }

    return undefined;
  }

  const body = fields.body;

  if (typeof body !== 'string' || !body.isWellFormed()) {
    fail('transport-anfrage', 'POST braucht einen fertigen JSON-Text');
  }

  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    fail('transport-anfrage-gross', `Anfragetext groesser als ${MAX_REQUEST_BYTES} Bytes`);
  }

  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch {
    fail('transport-anfrage-json', 'Anfragetext ist kein JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('transport-anfrage-json', 'Anfragetext ist kein JSON-Objekt');
  }

  return body;
}

function readRequest(request, mode, allowedLive, branch) {
  const fields = readFields(request, REQUEST_KEYS, ['method', 'path'], 'transport-anfrage', 'Anfrage');
  const method = fields.method;
  const path = fields.path;
  const methods = mode === 'publish' ? ['GET', 'POST', 'DELETE'] : ['GET'];

  if (typeof method !== 'string' || !methods.includes(method)) {
    fail('transport-methode', mode === 'publish' ? 'nur GET, POST und DELETE sind erlaubt' : 'nur GET ist erlaubt');
  }

  checkPathForm(path);

  if (!isLiveRequest(method, path, allowedLive) && !(mode === 'publish' && isPublishRequest(method, path, branch))) {
    fail('transport-endpunkt', 'Endpunkt ist fuer diesen Auftrag nicht erlaubt');
  }

  return { method, path, body: readBody(method, fields) };
}

// ---------------------------------------------------------------------------
// Ein einzelner HTTP-Austausch
// ---------------------------------------------------------------------------

function readResponseHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    fail('transport-antwort-format', 'Kopfzeilen der Antwort unlesbar');
  }

  const links = [];
  const lengths = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];

    if (typeof name !== 'string' || typeof value !== 'string') {
      fail('transport-antwort-format', 'Kopfzeile der Antwort ist kein Text');
    }

    const lower = name.toLowerCase();

    if (lower === 'content-encoding') {
      fail('transport-komprimiert', 'komprimierte Antworten werden nicht angenommen');
    }

    if (lower === 'link') {
      links.push(value);
    }

    if (lower === 'content-length') {
      lengths.push(value);
    }
  }

  if (links.length > 1) {
    fail('transport-header-mehrdeutig', 'mehrere link-Kopfzeilen');
  }

  if (links.length === 1 && (links[0].length > MAX_LINK_LENGTH || CONTROL_RE.test(links[0]))) {
    fail('transport-header-mehrdeutig', 'link-Kopfzeile unzulaessig');
  }

  if (lengths.length > 1 || (lengths.length === 1 && !CONTENT_LENGTH_RE.test(lengths[0]))) {
    fail('transport-laenge', 'Content-Length mehrdeutig oder ungueltig');
  }

  const expected = lengths.length === 1 ? Number(lengths[0]) : undefined;

  if (expected !== undefined && expected > MAX_BODY_BYTES) {
    fail('transport-antwort-gross', `Antwort groesser als ${MAX_BODY_BYTES} Bytes angekuendigt`);
  }

  return { link: links.length === 1 ? links[0] : undefined, expected };
}

function exchange(agent, token, method, path, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    let response = null;

    // Einziger Abschluss. Nach dem ersten Ergebnis bleiben alle Listener wirkungslos, damit spaete
    // error-Ereignisse zerstoerter Streams abgefangen bleiben und nichts zweimal entschieden wird.
    const finish = (error, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error === null) {
        resolve(value);
        return;
      }

      if (response !== null) {
        response.destroy();
      }

      if (request !== null) {
        request.destroy();
      }

      reject(error);
    };
    const abort = (code, message) => finish(transportError(code, message), undefined);

    // Ein einziger aeusserer Zeitgeber: Verbindung, TLS, Kopfzeilen und Antworttext zusammen.
    const timer = setTimeout(() => abort('transport-zeitlimit', `keine vollstaendige Antwort innerhalb von ${TIMEOUT_MS} ms`), TIMEOUT_MS);

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'identity',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
    }

    const onResponse = incoming => {
      response = incoming;
      incoming.on('error', () => abort('transport-abbruch', 'Antwort abgebrochen'));

      if (settled) {
        incoming.destroy();
        return;
      }

      const status = incoming.statusCode;

      if (!Number.isInteger(status) || status < 100 || status > 599) {
        abort('transport-antwort-format', 'Status der Antwort ungueltig');
        return;
      }

      let meta;

      try {
        meta = readResponseHeaders(incoming.rawHeaders);
      } catch (error) {
        finish(error, undefined);
        return;
      }

      const chunks = [];
      let received = 0;
      let ended = false;

      incoming.on('data', chunk => {
        if (settled) {
          return;
        }

        if (!Buffer.isBuffer(chunk)) {
          abort('transport-antwort-format', 'Antwortteil ist kein Byteblock');
          return;
        }

        received += chunk.length;

        if (received > MAX_BODY_BYTES) {
          abort('transport-antwort-gross', `Antwort groesser als ${MAX_BODY_BYTES} Bytes`);
          return;
        }

        if (meta.expected !== undefined && received > meta.expected) {
          abort('transport-laenge', 'Antwort laenger als Content-Length');
          return;
        }

        chunks.push(chunk);
      });

      incoming.on('end', () => {
        ended = true;

        if (settled) {
          return;
        }

        if (incoming.complete !== true) {
          abort('transport-abbruch', 'Antwort unvollstaendig');
          return;
        }

        if (meta.expected !== undefined && received !== meta.expected) {
          abort('transport-laenge', 'Antwort kuerzer als Content-Length');
          return;
        }

        let text;

        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, received));
        } catch {
          abort('transport-utf8', 'Antwort ist kein gueltiges UTF-8');
          return;
        }

        const result = {};

        if (meta.link !== undefined) {
          result.link = meta.link;
        }

        finish(null, Object.freeze({ status, headers: Object.freeze(result), body: text }));
      });

      incoming.on('close', () => {
        if (!ended) {
          abort('transport-abbruch', 'Verbindung vor dem Ende der Antwort geschlossen');
        }
      });
    };

    try {
      request = https.request({
        protocol: 'https:',
        hostname: API_HOST,
        port: API_PORT,
        method,
        path,
        headers,
        agent,
        insecureHTTPParser: false,
      }, onResponse);
    } catch {
      abort('transport-netz', 'Anfrage konnte nicht gestartet werden');
      return;
    }

    request.on('error', () => abort('transport-netz', 'Verbindung, TLS oder Uebertragung gescheitert'));

    try {
      if (body === undefined) {
        request.end();
      } else {
        request.end(body, 'utf8');
      }
    } catch {
      abort('transport-netz', 'Anfrage konnte nicht gesendet werden');
    }
  });
}

// ---------------------------------------------------------------------------
// Fabriken
// ---------------------------------------------------------------------------

function createTransport(mode, input) {
  const { token, issueNumber, runId } = readInput(input);
  checkRootCertificates();
  const branch = ownBranch(issueNumber, runId);
  const allowedLive = livePaths(issueNumber, runId);
  const agent = new https.Agent({
    keepAlive: false,
    maxSockets: 1,
    maxTotalSockets: 1,
    ca: ROOT_CERTIFICATES,
    rejectUnauthorized: true,
    proxyEnv: NO_PROXY_ENV,
  });
  const state = { closed: false, prRequested: false, busy: false };

  const transport = async request => {
    if (state.closed) {
      fail('transport-abgeschlossen', 'nach der PR-Anfrage sind keine weiteren Anfragen erlaubt');
    }

    if (state.busy) {
      fail('transport-parallel', 'es laeuft bereits eine Anfrage');
    }

    const checked = readRequest(request, mode, allowedLive, branch);

    if (checked.method === 'POST' && checked.path === `${API_PREFIX}pulls`) {
      // Vor dem Abschicken und endgueltig: ob GitHub den PR anlegt, ist ab hier offen.
      state.prRequested = true;
      state.closed = true;
    }

    state.busy = true;

    try {
      return await exchange(agent, token, checked.method, checked.path, checked.body);
    } finally {
      state.busy = false;
    }
  };

  return Object.freeze(transport);
}

export function createReadTransport(input) {
  return createTransport('read', input);
}

export function createPublishTransport(input) {
  return createTransport('publish', input);
}
