import { createHash } from 'node:crypto';
import http from 'node:http';

/*
 * A fake panel speaking the bots wire, protocol v1, exactly as the plan's §2c states it —
 * so that `test/helper.test.js` proves the helper against the contract rather than against
 * whatever the panel's real routes (built separately) turn out to do. It is not named
 * `*.test.js`, so `npm test` loads it only through the tests that import it.
 *
 * The rules, each one a line below:
 *
 *   every request     `Authorization: Bearer <token>`; an unknown bot and a wrong token get
 *                     the same `401`
 *   POST  …/hello     JSON `{v:1, instance, helperVersion, host, roots, files}` → `200 {ok}`;
 *                     `426 {supported:[1]}` for any other `v`; `409 {since}` when a different
 *                     `instance` said hello within the last `instanceWindowMs` (90 s)
 *   GET   …/manifest  `200 {v:1, files:[{root, project, session, agent, size, headLen, head}]}`,
 *                     `head` = sha256 hex of the copy's first `headLen = min(size, 4096)` bytes
 *   POST  …/append    `?root=&project=&session=&agent=&offset=&reset=`, octet-stream, ≤ 4 MiB:
 *                     `400` a bad component · `413` too big · `409 {size}` offset ≠ the copy's
 *                     size · `200 {size}`. `reset=1` (offset 0 only) starts a new copy and
 *                     keeps the old one as a generation, never truncating it.
 *
 * Two things the plan leaves open are decided here, and the helper's report says so:
 * a session id already held under a *different* root is refused as `409 {error}` — no
 * `size`, so it can never be read as "resume from here" — and a body that ends mid-line
 * without being a full 4 MiB piece is a contract violation the fake refuses with `400` and
 * records, so a test can assert that none happened.
 */

export const FAKE = Object.freeze({
  ROOT_RE: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
  PROJECT_RE: /^[A-Za-z0-9-]{1,255}$/,
  SESSION_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  AGENT_RE: /^agent-[A-Za-z0-9]{1,64}$/,
  CHUNK_MAX: 4 * 1024 * 1024,
  HEAD_MAX: 4096,
});

export function fileKey({ root, project, session, agent }) {
  return `${root}/${project}/${session}${agent ? `/${agent}` : ''}`;
}

const sha = buf => createHash('sha256').update(buf).digest('hex');

export async function startFakePanel({ bot = 'alpha-bot', token = 'fake-token-alpha', instanceWindowMs = 90_000 } = {}) {
  /** key → {root, project, session, agent, data: Buffer} */
  const copies = new Map();
  /** key → [Buffer] — copies a reset set aside */
  const generations = new Map();
  const log = [];
  const hellos = [];
  const appends = [];
  const violations = [];
  /** [{route, status, body}] — answered instead of the real thing, first match wins, once */
  const inject = [];
  let lastInstance = null;

  function send(res, status, body) {
    const text = JSON.stringify(body ?? {});
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  async function readBody(req) {
    const parts = [];
    for await (const part of req) parts.push(part);
    return Buffer.concat(parts);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake');
    const m = /^\/api\/bots\/([^/]+)\/(hello|manifest|append)$/.exec(url.pathname);
    const body = await readBody(req);
    const entry = { method: req.method, route: m?.[2] ?? url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, bytes: body.length };
    log.push(entry);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, botId, route] = m;
    const auth = req.headers.authorization;
    if (decodeURIComponent(botId) !== bot || auth !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });

    const injected = inject.findIndex(i => i.route === route);
    if (injected >= 0) {
      const [i] = inject.splice(injected, 1);
      return send(res, i.status, i.body);
    }

    if (route === 'hello') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      let hello;
      try { hello = JSON.parse(body.toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      if (hello?.v !== 1) return send(res, 426, { supported: [1] });
      const now = Date.now();
      if (lastInstance && lastInstance.instance !== hello.instance && now - lastInstance.at < instanceWindowMs) {
        return send(res, 409, { since: new Date(lastInstance.since).toISOString() });
      }
      const since = lastInstance?.instance === hello.instance ? lastInstance.since : now;
      lastInstance = { instance: hello.instance, at: now, since };
      hellos.push({ ...hello, contentType: req.headers['content-type'] });
      return send(res, 200, { ok: true });
    }

    if (route === 'manifest') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method' });
      const files = [...copies.values()].map(c => {
        const headLen = Math.min(c.data.length, FAKE.HEAD_MAX);
        return { root: c.root, project: c.project, session: c.session, agent: c.agent, size: c.data.length, headLen, head: sha(c.data.subarray(0, headLen)) };
      });
      return send(res, 200, { v: 1, files });
    }

    // append
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const q = url.searchParams;
    const ids = { root: q.get('root'), project: q.get('project'), session: q.get('session'), agent: q.get('agent') || null };
    if (!ids.root || ids.root === '.' || ids.root === '..' || !FAKE.ROOT_RE.test(ids.root)
      || !FAKE.PROJECT_RE.test(ids.project ?? '') || !FAKE.SESSION_RE.test(ids.session ?? '')
      || (ids.agent && !FAKE.AGENT_RE.test(ids.agent))) {
      return send(res, 400, { error: 'bad component' });
    }
    if (req.headers['content-type'] !== 'application/octet-stream') return send(res, 400, { error: 'not octet-stream' });
    const offset = Number(q.get('offset'));
    if (!q.has('offset') || !Number.isSafeInteger(offset) || offset < 0) return send(res, 400, { error: 'bad offset' });
    const reset = q.get('reset') === '1';
    if (body.length > FAKE.CHUNK_MAX) return send(res, 413, { error: 'too big' });
    if (!body.length || (body[body.length - 1] !== 10 && body.length !== FAKE.CHUNK_MAX)) {
      violations.push({ ...ids, offset, bytes: body.length, why: 'chunk does not end on a newline' });
      return send(res, 400, { error: 'chunk must end on a newline' });
    }
    const key = fileKey(ids);
    if (!ids.agent) {
      const elsewhere = [...copies.values()].find(c => !c.agent && c.session === ids.session && fileKey(c) !== key);
      if (elsewhere) return send(res, 409, { error: 'this conversation is already held under another root' });
    }
    let copy = copies.get(key);
    if (reset) {
      if (offset !== 0) return send(res, 400, { error: 'reset needs offset 0' });
      if (copy) {
        if (!generations.has(key)) generations.set(key, []);
        generations.get(key).push(copy.data);
      }
      copy = { ...ids, data: Buffer.alloc(0) };
      copies.set(key, copy);
    }
    const size = copy?.data.length ?? 0;
    if (offset !== size) return send(res, 409, { size });
    if (!copy) {
      copy = { ...ids, data: Buffer.alloc(0) };
      copies.set(key, copy);
    }
    copy.data = Buffer.concat([copy.data, body]);
    appends.push({ key, offset, bytes: body.length, reset, endsOnNewline: body[body.length - 1] === 10 });
    return send(res, 200, { size: copy.data.length });
  }

  let server = http.createServer((req, res) => {
    handle(req, res).catch(err => send(res, 500, { error: String(err) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    bot,
    token,
    copies,
    generations,
    log,
    hellos,
    appends,
    violations,
    inject,
    copy(key) { return copies.get(key)?.data ?? null; },
    /** Replace a copy's bytes behind the helper's back, as a panel restored from an older backup would. */
    setCopy(key, data) { copies.get(key).data = Buffer.from(data); },
    forgetInstance() { lastInstance = null; },
    /** Stop answering: the port is closed, so the helper sees ECONNREFUSED. */
    async down() {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
    /** Answer again, on the same port. */
    async up() {
      server = http.createServer((req, res) => {
        handle(req, res).catch(err => send(res, 500, { error: String(err) }));
      });
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    },
    async close() {
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
