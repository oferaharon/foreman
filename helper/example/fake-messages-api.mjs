#!/usr/bin/env node
/*
 * A fake Anthropic Messages API — BENCH ONLY.
 *
 * It exists so the reference container in this directory can run a real `claude -p` loop,
 * writing real transcripts for the helper to ship, without any account inside the
 * container. Claude Code is pointed at it with `ANTHROPIC_BASE_URL`; nothing it answers
 * comes from a model. A real deployment never runs this file.
 *
 * What it answers, per request to `POST /v1/messages` (any query string):
 *
 *   - a prompt with no tool result yet → one `tool_use` of `Bash`: `sleep N` when the prompt
 *     says `sleep N` (so a run stays open long enough to watch it grow), else `npm test`;
 *   - a tool result → a short text reply quoting the first lines of what the tool printed;
 *   - a request for anything else (a title, a summary) → a short text reply.
 *
 * Streamed requests get the Messages API's SSE sequence — `message_start` →
 * `content_block_start` / `content_block_delta` / `content_block_stop` → `message_delta` →
 * `message_stop` — and the rest get the same message as one JSON body. The model is echoed
 * from the request, so `--model` decides what the transcript records. Usage is an estimate
 * (a quarter of the request's bytes, as input), which is enough to give the panel a context
 * figure that grows with the conversation; it is not a measurement of anything.
 *
 * `POST /v1/messages/count_tokens` answers the same estimate. Every other path is a 404 and a
 * stderr line, so a call nobody expected is visible in `docker logs`.
 *
 *   FAKE_API_PORT   the port on 127.0.0.1 (default 8790; 0 for any free one, which it logs)
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = /^\d+$/.test(process.env.FAKE_API_PORT ?? '') ? Number(process.env.FAKE_API_PORT) : 8790;

const log = (line) => process.stderr.write(`fake-api ${new Date().toISOString()} ${line}\n`);
const id = (prefix) => `${prefix}_bench${randomBytes(9).toString('hex')}`;

/** The text of a content field, whether a string or an array of blocks. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'tool_result' ? textOf(b.content) : '')).join('\n');
}

/** What to say next, from the conversation so far. */
function reply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  // The last *user* message: Claude Code may append a `system`-role message after it.
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  const blocks = Array.isArray(last?.content) ? last.content : [];
  const result = blocks.find((b) => b?.type === 'tool_result');
  if (result) {
    const printed = textOf(result.content).split('\n').filter((l) => l.trim()).slice(0, 6);
    const text = result.is_error
      ? `The command did not run: ${printed[0] || 'no output'}.`
      : `Done. The command printed:\n\n\`\`\`\n${printed.join('\n') || '(nothing)'}\n\`\`\`\n\nThis reply came from the bench's fake Messages API, not from a model.`;
    return { kind: 'text', text };
  }
  const prompt = textOf(last?.content);
  const hasBash = Array.isArray(body?.tools) && body.tools.some((t) => t?.name === 'Bash');
  if (last && hasBash) {
    const sleep = /\bsleep (\d{1,3})\b/.exec(prompt);
    const command = sleep ? `sleep ${sleep[1]}` : 'npm test';
    return { kind: 'tool', input: { command, description: sleep ? 'Wait, so the run stays open' : 'Run the tests' } };
  }
  return { kind: 'text', text: 'Bench reply from the fake Messages API.' };
}

function usageFor(bytes) {
  return { input_tokens: Math.ceil(bytes / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function message(body, bytes) {
  const r = reply(body);
  const content = r.kind === 'tool'
    ? [{ type: 'tool_use', id: id('toolu'), name: 'Bash', input: r.input }]
    : [{ type: 'text', text: r.text }];
  return {
    id: id('msg'),
    type: 'message',
    role: 'assistant',
    model: String(body?.model || 'claude-sonnet-5-5'),
    content,
    stop_reason: r.kind === 'tool' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { ...usageFor(bytes), output_tokens: 24 },
  };
}

function sse(res, msg) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const { content, stop_reason, usage, ...head } = msg;
  send('message_start', { type: 'message_start', message: { ...head, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const path = (req.url || '').split('?')[0];
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* answered below */ }
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: usageFor(raw.length).input_tokens }));
    }
    if (req.method === 'POST' && path === '/v1/messages' && body) {
      const msg = message(body, raw.length);
      log(`${body.stream ? 'stream' : 'json'} ${msg.model} → ${msg.stop_reason}`);
      if (body.stream) return sse(res, msg);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(msg));
    }
    log(`404 ${req.method} ${path}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'the bench fake answers /v1/messages only' } }));
  });
});

server.listen(PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${server.address().port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
