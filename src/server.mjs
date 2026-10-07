import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Journal } from './journal.mjs';
import { configuration } from './sender.mjs';
import { createPipeline } from './pipeline.mjs';

export const DEMO_SECRET = 'demo-webhook-secret-not-for-production';
export const DEMO_TOKEN = 'demo-control-token-not-for-production';
export const BODY_LIMIT = 65536;

export function sign(body, secret = DEMO_SECRET) {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) {
      const error = new Error('Body too large'); error.status = 413; throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function reply(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

export async function createApp({
  journalPath = resolve('out/journal.jsonl'), config = configuration(),
  secret = DEMO_SECRET, controlToken = DEMO_TOKEN,
  clock = Date.now, transport, log = value => console.log(JSON.stringify(value)),
} = {}) {
  const journal = await Journal.open(journalPath);
  const processOrder = createPipeline({ journal, config, clock, transport, log });
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        return reply(response, 200, { status: 'ok', mode: config.mode });
      }
      if (request.method !== 'POST' || !['/webhooks/orders', '/demo/consent'].includes(request.url)) {
        return reply(response, 404, { error: 'not_found' });
      }
      if (!request.headers['content-type']?.startsWith('application/json')) {
        return reply(response, 415, { error: 'json_required' });
      }
      if (request.url === '/demo/consent' && !equal(request.headers.authorization, `Bearer ${controlToken}`)) {
        return reply(response, 401, { error: 'unauthorized' });
      }
      const raw = await readBody(request);
      if (request.url === '/webhooks/orders') {
        if (!equal(request.headers['x-shopify-hmac-sha256'], sign(raw, secret))) {
          return reply(response, 401, { error: 'invalid_signature' });
        }
        if (request.headers['x-shopify-shop-domain'] !== 'demo-store.example') {
          return reply(response, 400, { error: 'synthetic_shop_required' });
        }
        if (request.headers['x-shopify-topic'] !== 'orders/paid') {
          return reply(response, 200, { status: 'ignored_topic' });
        }
      }
      let body;
      try { body = JSON.parse(raw); }
      catch { return reply(response, 400, { error: 'invalid_json' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(response, 400, { error: 'object_required' });
      if (request.url === '/demo/consent') {
        try { return reply(response, 200, await journal.setConsent(body.session_id, body.state)); }
        catch (error) {
          if (error.code) throw error;
          return reply(response, 400, { error: 'invalid_consent' });
        }
      }
      let result;
      try { result = await processOrder(body); }
      catch (error) {
        if (error.code) throw error;
        return reply(response, 400, { error: 'invalid_order' });
      }
      reply(response, result.status === 'send_failed' ? 502 : 200, result);
    } catch (error) {
      if (!response.headersSent) reply(response, error.status === 413 ? 413 : 500, { error: error.status === 413 ? 'body_too_large' : 'internal_error' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return { server, journal };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = configuration(process.argv.slice(2), process.env);
    const port = Number(process.env.PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1-65535');
    const { server } = await createApp({ config,
      secret: process.env.DEMO_WEBHOOK_SECRET || DEMO_SECRET,
      controlToken: process.env.DEMO_CONTROL_TOKEN || DEMO_TOKEN,
    });
    server.on('error', () => { console.error('Server failed to listen'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Local sender: http://127.0.0.1:${port}; mode=${config.mode}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch { console.error('Cannot start: check flags, port and required send credentials'); process.exitCode = 1; }
}
