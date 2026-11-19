// A6 K1-Nachweis (Generalprobe): Modell-Attrappe statt Anthropic fuer die echte, gepinnte Claude-Code-Version.
// Laeuft nur im Probejob als eigener Container im internen Netz ohne Ausgang, unter dem Alias a6-proxy auf
// Port 8080, also genau dort, wo a6_claude_aufruf das Modell erwartet. Nur lesbar eingebunden, an
// A6_K1_ATTRAPPE_SHA256 gebunden. Kein Schluessel, kein Schreibzugriff, keine Kindprozesse.
//
// Antwortet auf POST /v1/messages des Hauptlaufs (Anfrage mit dem Werkzeug Read) Schritt fuer Schritt mit den
// festen tool_use-Bloecken aus dem Plan (Schritt = Zahl der bisherigen assistant-Nachrichten). Ob ein Aufruf
// erlaubt, verweigert oder nicht verfuegbar ist, entscheidet allein Claude Code; die Attrappe sieht die
// Ergebnisse nicht an und weicht nie vom Plan ab.
//
// Ausgabe auf stdout je Anfrage genau eine Zeile mit festen Kennungen, nie Inhalte:
//   A6-ATTRAPPE anfrage <messages|count_tokens|andere> schritt=<n> werkzeuge=<Name,...|keine>
//   node k1-attrappe.mjs PLAN.json
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PLAN = JSON.parse(readFileSync(process.argv[2], 'utf8'));

if (!Array.isArray(PLAN) || PLAN.length < 1 || !PLAN.every(s => Array.isArray(s) && s.length >= 1)) {
  throw new Error('A6-ATTRAPPE plan');
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
let nummer = 0;

function zeile(art, schritt, werkzeuge) {
  const namen = werkzeuge.map(w => (NAME.test(w) ? w : 'anderes')).sort();
  process.stdout.write(`A6-ATTRAPPE anfrage ${art} schritt=${schritt} werkzeuge=${namen.length ? namen.join(',') : 'keine'}\n`);
}

function sse(res, bloecke, stop) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  nummer += 1;
  send('message_start', { type: 'message_start', message: { id: `msg_a6_k1_${nummer}`, type: 'message', role: 'assistant', model: 'claude-sonnet-attrappe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  bloecke.forEach((b, i) => {
    if (b.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
    } else {
      send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    send('content_block_stop', { type: 'content_block_stop', index: i });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', c => {
    body += c;
  });
  req.on('end', () => {
    let j = {};

    try {
      j = JSON.parse(body || '{}');
    } catch {
      j = {};
    }

    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const schritt = msgs.filter(m => m?.role === 'assistant').length;
    const werkzeuge = Array.isArray(j.tools) ? j.tools.map(t => String(t?.name ?? '')) : [];
    const pfad = String(req.url ?? '');
    const art = pfad.startsWith('/v1/messages/count_tokens') ? 'count_tokens' : pfad.startsWith('/v1/messages') ? 'messages' : 'andere';
    zeile(art, schritt, werkzeuge);

    if (req.method !== 'POST' || art === 'andere') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (art === 'count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":10}');
      return;
    }

    const hauptlauf = werkzeuge.includes('Read');
    const bloecke = hauptlauf ? (PLAN[schritt] ?? [{ type: 'text', text: 'Attrappe fertig.' }]) : [{ type: 'text', text: 'Nebenanfrage.' }];
    const stop = bloecke.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';

    if (j.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_a6_k1_ns', type: 'message', role: 'assistant', model: 'claude-sonnet-attrappe', content: bloecke.map(b => (b.type === 'text' ? b : { type: 'tool_use', id: b.id, name: b.name, input: b.input })), stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
      return;
    }

    sse(res, bloecke, stop);
  });
}).listen(8080);
