// Scans the project for things that must never reach GitHub or the ZIP.
// Usage: node tools/secret-scan.mjs        (exit code 1 if anything suspicious is found)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const skipDirs = new Set(['node_modules', '.git']);
const textExt = new Set(['.js', '.mjs', '.json', '.toml', '.md', '.txt', '.html', '.css', '.sql', '.py', '.bat', '.cfg', '.webmanifest', '.svg', '.example', '']);
const badNames = [/^\.dev\.vars$/, /^\.env/, /\.secret$/, /\.pem$/, /\.key$/, /\.ex5$/i, /\.sqlite3?$/, /\.db$/];
const patterns = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Cloudflare/API token assignment', /(api[_-]?token|auth[_-]?token|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i],
  ['base64 32-byte key assigned to CREDENTIAL_KEY', /CREDENTIAL_KEY\s*[:=]\s*["'][A-Za-z0-9+/]{43}=["']/],
  ['SETUP_TOKEN with a value', /SETUP_TOKEN\s*[:=]\s*["'][^"']{8,}["']/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['AWS-style key', /\bAKIA[0-9A-Z]{16}\b/],
];
const allowFiles = new Set(['test/helpers.mjs', 'tools/devserver.mjs', 'tools/secret-scan.mjs']); // throw-away test values only

const problems = [];
let files = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!skipDirs.has(name)) walk(p); continue; }
    const rel = relative(root, p).replaceAll('\\', '/');
    files++;
    if (badNames.some((re) => re.test(name))) problems.push(`${rel}: file type must not be committed`);
    if (!textExt.has(extname(name)) || st.size > 2_000_000 || allowFiles.has(rel)) continue;
    const text = readFileSync(p, 'utf8');
    for (const [label, re] of patterns) if (re.test(text)) problems.push(`${rel}: ${label}`);
  }
})(root);

console.log(`Scanned ${files} files.`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((x) => '  - ' + x).join('\n')); process.exit(1); }
console.log('No secrets, keys, .env files, EX5 files or databases found.');
