// Static-site helpers: security headers, robots.txt, sitemap.xml and canonical-URL filling.
// Pure functions so they are tested in Node and used by functions/_middleware.js on Cloudflare.

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=31536000',
};

// Pages that Google may index. Everything else (the app itself, the API) is not listed.
export const PUBLIC_PATHS = ['/home', '/'];

export const robotsTxt = (origin) =>
  `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`;

export const sitemapXml = (origin) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  PUBLIC_PATHS.map((p) => `  <url><loc>${origin}${p === '/' ? '/' : p}</loc></url>`).join('\n') +
  `\n</urlset>\n`;

// HTML files carry the placeholder __ORIGIN__ in canonical / social tags; it is replaced
// with the real address the visitor used, so no domain is hard-coded.
export const fillOrigin = (html, origin) => html.replaceAll('__ORIGIN__', origin);

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
