/** Local stand-in for api.openai.com/v1/images/*. Records what the Worker sent; never contacts OpenAI. */
import http from 'node:http';
import { makePng } from './png.mjs';
export function startMock(port = 8799) {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/__log') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(log)); }
      const raw = Buffer.concat(chunks).toString('latin1');
      const multipart = (req.headers['content-type'] || '').startsWith('multipart/');
      const field = (n) => (multipart ? (raw.match(new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`)) || [])[1] : (() => { try { return JSON.parse(raw)[n]; } catch { return undefined; } })());
      const entry = { path: req.url, auth: req.headers.authorization, multipart, model: field('model'), moderation: field('moderation'), quality: field('quality'), background: field('background'), size: field('size'),
        hasMask: raw.includes('name="mask"'), imageParts: multipart ? (raw.match(/name="image\[\]"/g) || []).length : 0, hasSafetyId: raw.includes('safety_identifier') };
      log.push(entry);
      const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (entry.auth !== 'Bearer mock-key') return send(401, { error: { message: 'bad key' } });
      if (raw.includes('FORCE_400')) return send(400, { error: { code: 'moderation_blocked', message: 'blocked by mock' } });
      if (raw.includes('FORCE_FACE') && raw.includes('Face-detail close-up')) return send(400, { error: { code: 'moderation_blocked', message: 'face half blocked by mock' } });
      if (raw.includes('FORCE_429')) return send(429, { error: { message: 'rate' } });
      setTimeout(() => send(200, {
        data: [{ b64_json: makePng(64, 96, [90 + log.length * 7 % 120, 120, 200]).toString('base64') }],
        usage: { input_tokens: 1500, output_tokens: 6200, input_tokens_details: { text_tokens: 700, image_tokens: 800 } }
      }), 150);
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, log })));
}
