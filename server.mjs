#!/usr/bin/env node
/**
 * Zero-dependency static server for ROSA VIVIDA.
 *
 *   node server.mjs             → http://localhost:5173
 *   node server.mjs --https     → https://localhost:8443 (self-signed)
 *
 * The HTTPS mode exists because phone browsers only expose getUserMedia()
 * in a secure context. See README.md for how to open it on a real phone.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARGS = new Set(process.argv.slice(2));
const USE_HTTPS = ARGS.has('--https') || process.env.HTTPS === '1';
const PORT = Number(process.env.PORT || (USE_HTTPS ? 8443 : 5173));
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pem': 'application/x-pem-file',
};

function networkAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function ensureCertificate() {
  const certDir = path.join(ROOT, 'certs');
  const keyPath = path.join(certDir, 'localhost-key.pem');
  const certPath = path.join(certDir, 'localhost-cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return { keyPath, certPath };

  fs.mkdirSync(certDir, { recursive: true });
  const ips = ['127.0.0.1', ...networkAddresses()];
  const altNames = [
    'DNS.1 = localhost',
    'DNS.2 = *.localhost',
    ...ips.map((ip, index) => `IP.${index + 1} = ${ip}`),
  ].join('\n');
  const configPath = path.join(certDir, 'openssl.cnf');
  fs.writeFileSync(
    configPath,
    `[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = localhost

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
${altNames}
`,
  );

  const result = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '825', '-config', configPath,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.error('\n  Could not generate a local HTTPS certificate with openssl.');
    console.error('  Run with plain HTTP instead: npm start\n');
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }
  console.log('  Generated a self-signed certificate in ./certs');
  return { keyPath, certPath };
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function handler(req, res) {
  const base = `http://${req.headers.host || 'localhost'}`;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, base).pathname);
  } catch {
    sendError(res, 400, 'Bad request');
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  let filePath = path.join(ROOT, pathname);

  // Never serve anything outside the project directory.
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      // A friendly 404 page inside the experience.
      if (req.headers.accept?.includes('text/html')) {
        filePath = path.join(ROOT, 'index.html');
      } else {
        sendError(res, 404, 'Not found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css'
        ? 'no-cache'
        : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      // Enable SharedArrayBuffer-based WASM acceleration where available.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    };

    fs.readFile(filePath, (readError, data) => {
      if (readError) {
        sendError(res, 500, 'Failed to read file');
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': data.length });
      res.end(data);
    });
  });
}

let server;
if (USE_HTTPS) {
  const { keyPath, certPath } = ensureCertificate();
  server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    handler,
  );
} else {
  server = http.createServer(handler);
}

server.listen(PORT, HOST, () => {
  const scheme = USE_HTTPS ? 'https' : 'http';
  console.log('\n  ROSA VIVIDA  ·  指尖玫瑰\n');
  console.log(`  Local      ${scheme}://localhost:${PORT}`);
  for (const ip of networkAddresses()) {
    console.log(`  Network    ${scheme}://${ip}:${PORT}`);
  }
  if (!USE_HTTPS && networkAddresses().length) {
    console.log('\n  Phone camera note: for a LAN address use  npm run dev:https');
  }
  console.log('\n  Ctrl+C to stop.\n');
});
