// A6 P-1: Vorlademodul der Generalprobe. Nur fuer die Probe, nie im Live-Pfad.
//
// Wird ausschliesslich ueber den Kommandozeilenschalter --import vor einen unveraenderten Job-Einstieg
// geladen (Job 0, Job 1a, Job 3). Es ersetzt https.request durch einen nachgebauten GitHub-Server im
// Speicher und sperrt jeden echten Netzweg (Socket, TLS, http, fetch). Der Einstieg selbst, sein
// Transportmodul und alle Pruefungen bleiben unveraendert; ersetzt wird nur die Gegenstelle.
//
// Zustand und Protokoll liegen fest unter RUNNER_TEMP/a6-probe-github:
// - zustand.json: Issue, Ereignisse, Lauf, PR-Liste, Branches, naechste PR-Nummer
// - anfragen.jsonl: eine Zeile je Anfrage (Methode, Host, Pfad, ob ein Token mitkam), nie ein Tokenwert
// - repo.git: Git-Lager, in dem Schreibaufrufe (Blobs, Baeume, Commits) echte Objekte anlegen
//
// Gelesen wird nur RUNNER_TEMP. Das Modul setzt keine Umgebungsvariable und schreibt nichts auf stdout
// oder stderr, damit die Ausgabe des Einstiegs unveraendert bleibt.

import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';

const EXEC = cp.execFileSync;
const REPO_NAME = 'noah04091/agenten-probe';
const P = `/repos/${REPO_NAME}/`;
const DIR = join(String(process.env.RUNNER_TEMP), 'a6-probe-github');
const ZUSTAND = join(DIR, 'zustand.json');
const LOG = join(DIR, 'anfragen.jsonl');
const REPO_GIT = join(DIR, 'repo.git');

const sim = JSON.parse(readFileSync(ZUSTAND, 'utf8'));

function protokoll(eintrag) {
  appendFileSync(LOG, `${JSON.stringify(eintrag)}\n`);
}

function speichern() {
  writeFileSync(`${ZUSTAND}.neu`, `${JSON.stringify(sim, null, 2)}\n`);
  renameSync(`${ZUSTAND}.neu`, ZUSTAND);
}

// Jeder echte Netzweg wirft und wird protokolliert.
function verboten(art) {
  return function gesperrt() {
    protokoll({ verboten: art });
    throw new Error(`Netz in der Generalprobe verboten (${art})`);
  };
}

net.Socket.prototype.connect = verboten('socket');
tls.connect = verboten('tls');
http.request = verboten('http');
http.get = verboten('http');
https.get = verboten('https-get');
globalThis.fetch = verboten('fetch');

const GIT_ENV = {
  PATH: String(process.env.PATH),
  HOME: DIR,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Generalprobe',
  GIT_AUTHOR_EMAIL: 'generalprobe@example.invalid',
  GIT_COMMITTER_NAME: 'Generalprobe',
  GIT_COMMITTER_EMAIL: 'generalprobe@example.invalid',
  GIT_AUTHOR_DATE: '2026-11-17T09:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-17T09:00:00Z',
};

function git(args, input) {
  return EXEC('git', ['--git-dir', REPO_GIT, ...args], {
    env: { ...GIT_ENV, GIT_INDEX_FILE: join(DIR, 'sim-index') },
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

const ok = json => ({ status: 200, body: JSON.stringify(json) });
const created = json => ({ status: 201, body: JSON.stringify(json) });
const notFound = () => ({ status: 404, body: '{"message":"Not Found"}' });

function readTreeObject(sha) {
  try {
    if (!/^[0-9a-f]{40}$/.test(sha) || git(['cat-file', '-t', sha]) !== 'tree') {
      return notFound();
    }
  } catch {
    return notFound();
  }

  const tree = git(['ls-tree', '-r', '-t', '-z', sha]).split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s.exec(line);
    return { path: match[4], mode: match[1], type: match[2], sha: match[3], url: 'x' };
  });
  return ok({ sha, url: 'x', tree, truncated: false });
}

function readCommitObject(sha) {
  let raw;

  try {
    raw = git(['cat-file', 'commit', sha]);
  } catch {
    return notFound();
  }

  const [head, ...rest] = raw.split('\n\n');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)[1];
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(match => ({ sha: match[1], url: 'x', html_url: 'x' }));
  return ok({ sha, url: 'x', tree: { sha: tree, url: 'x' }, parents, message: rest.join('\n\n'), author: { name: 'Generalprobe' } });
}

function compareObjects(base, head) {
  const commits = git(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
  const behind = Number(git(['rev-list', '--count', `${head}..${base}`]));
  const raw = git(['diff-tree', '-r', '-z', '--no-renames', '--raw', base, head]).split('\0').filter(Boolean);
  const files = [];

  for (let i = 0; i < raw.length; i += 2) {
    const [, , , newSha, letter] = raw[i].split(' ');
    files.push({ sha: newSha, filename: raw[i + 1], status: { M: 'modified', A: 'added', D: 'removed' }[letter], additions: 1, deletions: 0 });
  }

  return ok({
    status: behind === 0 ? (commits.length > 0 ? 'ahead' : 'identical') : 'diverged',
    ahead_by: commits.length, behind_by: behind, total_commits: commits.length, commits: commits.map(sha => ({ sha, url: 'x' })), files,
  });
}

const refObject = (ref, sha) => ({ ref, node_id: 'x', url: 'x', object: { sha, type: 'commit', url: 'x' } });

function handle(req) {
  if (req.host !== 'api.github.com' || !req.path.startsWith(P)) {
    return notFound();
  }

  const rest = req.path.slice(P.length);
  const issue = sim.issue.number;

  if (req.method === 'GET') {
    if (rest === `actions/runs/${sim.run.id}`) {
      return ok(sim.run);
    }

    if (rest === 'git/ref/heads/main') {
      return ok(refObject('refs/heads/main', sim.mainSha));
    }

    if (rest === `issues/${issue}`) {
      return ok(sim.issue);
    }

    if (rest === `issues/${issue}/events?per_page=100&page=1`) {
      return ok(sim.events);
    }

    if (rest === `git/matching-refs/heads/wp/${issue}-`) {
      return ok(Object.entries(sim.refs).filter(([name]) => name.startsWith(`refs/heads/wp/${issue}-`)).map(([ref, sha]) => refObject(ref, sha)));
    }

    if (rest === 'pulls?state=all&sort=created&direction=asc&per_page=100&page=1') {
      return ok(sim.pulls);
    }

    if (rest.startsWith('git/ref/heads/')) {
      const ref = `refs/heads/${rest.slice('git/ref/heads/'.length)}`;
      return Object.hasOwn(sim.refs, ref) ? ok(refObject(ref, sim.refs[ref])) : notFound();
    }

    if (rest.startsWith('git/commits/')) {
      return readCommitObject(rest.slice('git/commits/'.length));
    }

    const treeMatch = /^git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(rest);

    if (treeMatch) {
      return readTreeObject(treeMatch[1]);
    }

    const compareMatch = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest);
    return compareMatch ? compareObjects(compareMatch[1], compareMatch[2]) : notFound();
  }

  const body = req.body === undefined ? undefined : JSON.parse(req.body);

  if (req.method === 'POST' && rest === 'git/blobs') {
    return created({ sha: git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')), url: 'x' });
  }

  if (req.method === 'POST' && rest === 'git/trees') {
    git(['read-tree', body.base_tree]);

    for (const entry of body.tree) {
      git(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`]);
    }

    return created({ sha: git(['write-tree']), url: 'x', tree: [], truncated: false });
  }

  if (req.method === 'POST' && rest === 'git/commits') {
    const sha = git(['commit-tree', body.tree, ...body.parents.flatMap(parent => ['-p', parent]), '-m', body.message]);
    return created({ sha, url: 'x', tree: { sha: body.tree }, parents: body.parents.map(parent => ({ sha: parent })), message: body.message });
  }

  if (req.method === 'POST' && rest === 'git/refs') {
    if (Object.hasOwn(sim.refs, body.ref)) {
      return { status: 422, body: '{"message":"Reference already exists"}' };
    }

    sim.refs[body.ref] = body.sha;
    speichern();
    return created(refObject(body.ref, body.sha));
  }

  if (req.method === 'POST' && rest === 'pulls') {
    const number = sim.nextPr;
    sim.nextPr += 1;
    const record = {
      number, state: 'open', draft: body.draft, title: body.title, body: body.body,
      html_url: `https://github.com/${REPO_NAME}/pull/${number}`,
      head: { ref: body.head, sha: sim.refs[`refs/heads/${body.head}`], repo: { full_name: REPO_NAME } },
      base: { ref: 'main', repo: { full_name: REPO_NAME } },
    };
    sim.pulls.push(record);
    speichern();
    return created(record);
  }

  if (req.method === 'DELETE' && rest.startsWith('git/refs/heads/')) {
    const ref = `refs/heads/${rest.slice('git/refs/heads/'.length)}`;

    if (!Object.hasOwn(sim.refs, ref)) {
      return { status: 422, body: '{"message":"Reference does not exist"}' };
    }

    delete sim.refs[ref];
    speichern();
    return { status: 204, body: '' };
  }

  return notFound();
}

class FakeRequest extends EventEmitter {
  constructor(options, onResponse) {
    super();
    this.options = options;
    this.onResponse = onResponse;
  }

  write() {
    return true;
  }

  end(body) {
    queueMicrotask(() => {
      const headers = this.options.headers ?? {};
      const auth = Object.keys(headers).some(name => name.toLowerCase() === 'authorization');
      const req = { method: this.options.method, host: this.options.hostname, path: this.options.path, body };
      protokoll({ methode: req.method, host: req.host, pfad: req.path, token: auth ? 'ja' : 'nein' });
      const antwort = handle(req);
      const res = new Readable({ read() {} });
      res.statusCode = antwort.status;
      res.rawHeaders = [];
      res.headers = {};
      res.complete = true;
      this.onResponse(res);

      if (antwort.body !== '') {
        res.push(Buffer.from(antwort.body, 'utf8'));
      }

      res.push(null);
    });
    return this;
  }

  destroy() {
    return this;
  }
}

https.request = (options, onResponse) => new FakeRequest(options, onResponse);
syncBuiltinESMExports();
