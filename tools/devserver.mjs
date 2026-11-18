// LOCAL TESTING ONLY. Serves public/ and the API with a throw-away in-memory database.
// Never use this for the real site: the real site runs on Cloudflare Pages.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/handler.js';
import { withSecurityHeaders, fillOrigin, robotsTxt, sitemapXml } from '../src/site.js';
import { makeD1, randomKeyBase64 } from '../test/helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
export async function startDevServer({ port = 0, setupToken = 'dev-setup-token' } = {}) {
  const env = { DB: makeD1(), SETUP_TOKEN: setupToken, CREDENTIAL_KEY: randomKeyBase64() };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; for await (const c of req) chunks.push(c);
        const r = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
        const headers = {}; r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
        // the dev server is plain http, so drop "Secure" from cookies, or browsers would refuse them
        headers['set-cookie'] = (r.headers.getSetCookie?.() ?? []).map((c) => c.replace(/;\s*Secure/i, ''));
        res.writeHead(r.status, headers); return res.end(Buffer.from(await r.arrayBuffer()));
      }
      // Mirrors functions/_middleware.js and Cloudflare's clean URLs, so the tests see the real headers.
      const origin = `http://${req.headers.host}`;
      let send = (status, headers, body) => { const r = withSecurityHeaders(new Response(body, { status, headers })); const h = {}; r.headers.forEach((v, k) => { h[k] = v; }); res.writeHead(status, h); return r.arrayBuffer().then((b) => res.end(Buffer.from(b))); };
      if (url.pathname === '/robots.txt') return send(200, { 'content-type': 'text/plain; charset=utf-8' }, robotsTxt(origin));
      if (url.pathname === '/sitemap.xml') return send(200, { 'content-type': 'application/xml; charset=utf-8' }, sitemapXml(origin));
      let name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
      if (name === '/home') name = '/home.html';
      let p = join(root, name);
      if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      const type = types[extname(p)] || 'application/octet-stream';
      const data = readFileSync(p);
      return send(200, { 'content-type': type }, type.startsWith('text/html') ? fillOrigin(data.toString('utf8'), origin) : data);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { server, env, url: `http://127.0.0.1:${server.address().port}`, setupToken };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startDevServer({ port: Number(process.argv[2]) || 8788 });
  console.log(`dev server ${s.url}  setup token: ${s.setupToken}`);
}
