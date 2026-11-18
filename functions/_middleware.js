// Runs for the routes listed in public/_routes.json (the pages, the API, robots and sitemap).
// Adds security headers and fills in the site address in canonical / social tags.
import { withSecurityHeaders, fillOrigin, robotsTxt, sitemapXml } from '../src/site.js';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = url.origin;

  if (url.pathname === '/robots.txt') {
    return withSecurityHeaders(new Response(robotsTxt(origin), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } }));
  }
  if (url.pathname === '/sitemap.xml') {
    return withSecurityHeaders(new Response(sitemapXml(origin), { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } }));
  }

  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/html') && response.ok) {
    const html = fillOrigin(await response.text(), origin);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('cache-control', 'no-cache');
    return withSecurityHeaders(new Response(html, { status: response.status, headers }));
  }
  return withSecurityHeaders(response);
}
