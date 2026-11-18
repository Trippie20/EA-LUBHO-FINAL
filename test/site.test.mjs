// Site configuration: headers, robots, sitemap, middleware, wrangler.toml, migrations.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { onRequest } from '../functions/_middleware.js';
import { CSP, SECURITY_HEADERS, robotsTxt, sitemapXml, fillOrigin } from '../src/site.js';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n, d); } };
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

console.log('Site: headers, robots, sitemap');
check('CSP forbids framing, objects and remote scripts', CSP.includes("frame-ancestors 'none'") && CSP.includes("object-src 'none'") && CSP.includes("script-src 'self'") && !/script-src[^;]*unsafe/.test(CSP));
const hdr = read('public/_headers');
check('_headers file carries the same CSP as the code', hdr.includes(`Content-Security-Policy: ${CSP}`));
check('_headers sets nosniff, frame, referrer, HSTS', /X-Content-Type-Options: nosniff/.test(hdr) && /X-Frame-Options: DENY/.test(hdr) && /Referrer-Policy/.test(hdr) && /Strict-Transport-Security/.test(hdr));
const robots = robotsTxt('https://example.test');
check('robots.txt blocks /api/ and points to the sitemap', robots.includes('Disallow: /api/') && robots.includes('Sitemap: https://example.test/sitemap.xml'));
const sm = sitemapXml('https://example.test');
check('sitemap lists the landing page with the real origin', sm.includes('<loc>https://example.test/home</loc>') && !sm.includes('/api'));
check('fillOrigin replaces every placeholder', !fillOrigin(read('public/home.html'), 'https://x.test').includes('__ORIGIN__') && fillOrigin(read('public/index.html'), 'https://x.test').includes('href="https://x.test/"'));
check('landing page has title, description, canonical, og and twitter tags', ['<title>', 'name="description"', 'rel="canonical"', 'og:title', 'og:image', 'twitter:card'].every((t) => read('public/home.html').includes(t)));
check('landing page says it does not trade', /does not trade/i.test(read('public/home.html')));
check('OG image exists', existsSync(new URL('../public/icons/og-image.png', import.meta.url)));

console.log('Middleware (as Cloudflare calls it)');
const mk = (path, next) => ({ request: new Request('https://lubho.example' + path), next });
let r = await onRequest(mk('/robots.txt', async () => { throw new Error('no'); }));
check('serves robots.txt as text', r.status === 200 && (await r.text()).includes('lubho.example/sitemap.xml') && r.headers.get('content-type').startsWith('text/plain'));
r = await onRequest(mk('/sitemap.xml', async () => { throw new Error('no'); }));
check('serves sitemap.xml as xml', r.headers.get('content-type').startsWith('application/xml') && (await r.text()).includes('https://lubho.example/home'));
r = await onRequest(mk('/home', async () => new Response(read('public/home.html'), { headers: { 'content-type': 'text/html; charset=utf-8' } })));
const html = await r.text();
check('HTML gets the real origin in canonical tags', html.includes('<link rel="canonical" href="https://lubho.example/home">') && !html.includes('__ORIGIN__'));
check('HTML response has every security header', Object.keys(SECURITY_HEADERS).every((k) => r.headers.get(k)));
r = await onRequest(mk('/api/x', async () => new Response('{}', { headers: { 'content-type': 'application/json' } })));
check('API response also gets security headers and is not rewritten', r.headers.get('x-frame-options') === 'DENY' && (await r.text()) === '{}');

console.log('Cloudflare configuration files');
const toml = read('wrangler.toml');
check('wrangler.toml: pages output dir, D1 binding DB, safe defaults', /pages_build_output_dir = "public"/.test(toml) && /binding = "DB"/.test(toml) && /ALLOW_LIVE_ACCOUNTS = "false"/.test(toml));
check('wrangler.toml has no secrets', !/SETUP_TOKEN\s*=|CREDENTIAL_KEY\s*=/.test(toml));
check('wrangler.toml still has the database placeholder (user fills it in)', toml.includes('REPLACE-WITH-YOUR-D1-DATABASE-ID'));
const routes = JSON.parse(read('public/_routes.json'));
check('_routes.json routes API, pages, robots and sitemap to functions', ['/api/*', '/robots.txt', '/sitemap.xml', '/home', '/'].every((p) => routes.include.includes(p)));
const sha = (s) => createHash('sha256').update(s).digest('hex');
check('migrations/0001_init.sql is identical to schema.sql', sha(read('schema.sql')) === sha(read('migrations/0001_init.sql')));
check('only one migration file (no outdated ones)', readdirSync(new URL('../migrations', import.meta.url)).filter((f) => f.endsWith('.sql')).length === 1);
check('original backup untouched', sha(read('backup/original/index.html')) === '01e03f0466de5459349a6d4d0b86a94270115f2e69aa387d0b4569f48baf6efa');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
