// A6 P-4, nur Dokumentation, nie im Workflow oder in Tests ausgefuehrt. Lokale Modell-Attrappe fuer die Formaterfassung: beantwortet POST /v1/messages mit festen tool_use-Bloecken.
// Nur im internen Docker-Netz, ohne Schluessel, ohne Anthropic. Schritt = Zahl der assistant-Nachrichten.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PLAN = JSON.parse(process.env.PLAN);
const FEHLER = Number(process.env.FEHLER || 0);
const NUTZUNG = Number(process.env.NUTZUNG || 10);
const LOG = '/log/anfragen.jsonl';
let n = 0;

function sse(res, bloecke, stop) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  n += 1;
  send('message_start', { type: 'message_start', message: { id: `msg_attrappe_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-attrappe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: NUTZUNG, output_tokens: 1 } } });
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
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch {}
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const schritt = msgs.filter(m => m.role === 'assistant').length;
    appendFileSync(LOG, `${JSON.stringify({ methode: req.method, pfad: req.url, modell: j.model, stream: j.stream, max_tokens: j.max_tokens, nachrichten: msgs.length, schritt, werkzeuge: (j.tools ?? []).map(t => t.name) })}\n`);
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end(); return; }
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
    if (FEHLER) { res.writeHead(FEHLER, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "attrappe" } })); return; }
    const hauptlauf = (j.tools ?? []).some(t => t.name === 'Read');
    const bloecke = hauptlauf ? (PLAN[schritt] ?? [{ type: 'text', text: 'Attrappe fertig.' }]) : [{ type: 'text', text: 'Nebenanfrage.' }];
    const stop = bloecke.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    if (j.stream === false || j.stream === undefined) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_attrappe_ns', type: 'message', role: 'assistant', model: 'claude-sonnet-attrappe', content: bloecke.map(b => (b.type === 'text' ? b : { type: 'tool_use', id: b.id, name: b.name, input: b.input })), stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
      return;
    }
    sse(res, bloecke, stop);
  });
}).listen(8080);
