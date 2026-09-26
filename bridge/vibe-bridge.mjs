#!/usr/bin/env node
/**
 * Vibe bridge — lets the Flammard web app transcribe on this computer.
 *
 * The Vibe desktop app runs a local transcription server (vibe-server) with
 * an OpenAI-style API, but it sends no CORS headers, so a web page can't talk
 * to it. This script sits in front of it on a fixed port and adds exactly
 * that: CORS (including Chrome's private-network preflight), discovery of
 * Vibe's current URL from its config file, and loading the model Vibe is
 * configured with. Everything else is passed straight through.
 *
 *   node vibe-bridge.mjs                       # uses Vibe's running server
 *   node vibe-bridge.mjs --origin https://flammard.netlify.app
 *
 * Requirements: Node 18+, the Vibe desktop app open with
 * Settings → API & Agents turned on. No npm install needed.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Options ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(opt('port', process.env.VIBE_BRIDGE_PORT || 47111));
const ORIGINS = args.flatMap((a, i) => (a === '--origin' && args[i + 1] ? [args[i + 1]] : []));
const VIBE_URL_OVERRIDE = opt('vibe', process.env.VIBE_URL);
const MODEL_OVERRIDE = opt('model', process.env.VIBE_MODEL);
const DIARIZE_OVERRIDE = opt('diarize', process.env.VIBE_DIARIZE_MODEL);

// ── Vibe's config file (where it publishes the live server URL) ──────────
function configPath() {
  const id = 'github.com.thewh1teagle.vibe';
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', id, 'app_config.json');
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), id, 'app_config.json');
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), id, 'app_config.json');
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

// Keys are dotted names; support both a flat file and a nested one
function cfg(config, key) {
  if (key in config) return config[key];
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), config);
}

// ── Talking to vibe-server ───────────────────────────────────────────────
async function findVibe() {
  const config = readConfig();
  const candidates = [VIBE_URL_OVERRIDE, cfg(config, 'api.baseUrl')].filter(Boolean);
  for (const base of candidates) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { base: base.replace(/\/$/, ''), config };
    } catch {
      /* try next */
    }
  }
  return { base: null, config };
}

function findDiarizeModel(config, modelPath) {
  if (DIARIZE_OVERRIDE) return DIARIZE_OVERRIDE;
  if (!cfg(config, 'transcription.recognizeSpeakers') || !modelPath) return null;
  // Vibe keeps the Sortformer diarization model next to the whisper model
  try {
    const dir = path.dirname(modelPath);
    const file = fs.readdirSync(dir).find((f) => /sortformer/i.test(f) && f.endsWith('.gguf'));
    return file ? path.join(dir, file) : null;
  } catch {
    return null;
  }
}

async function ensureModel(base, config) {
  const ready = await fetch(`${base}/ready`).catch(() => null);
  if (ready?.ok) return (await ready.json()).model ?? 'loaded';

  const modelPath = MODEL_OVERRIDE || cfg(config, 'model.path');
  if (!modelPath) throw new Error('No model loaded and none configured — pick a model in Vibe once, or pass --model <path>');
  const res = await fetch(`${base}/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: modelPath }),
  });
  if (!res.ok) throw new Error(`Model load failed: ${await res.text()}`);
  return path.basename(modelPath);
}

// ── CORS ─────────────────────────────────────────────────────────────────
function allowOrigin(origin) {
  if (!origin) return null;
  if (!ORIGINS.length) return origin; // no allow-list given: any site may use this machine
  if (ORIGINS.includes(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function cors(req, res) {
  const origin = allowOrigin(req.headers.origin);
  if (!origin) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome: public site → local network
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

// ── Server ───────────────────────────────────────────────────────────────
let vibe = { base: null, model: null, diarizeModel: null, error: null };

async function refresh() {
  const { base, config } = await findVibe();
  if (!base) {
    vibe = { base: null, model: null, diarizeModel: null, error: 'Vibe is not running its API. Open Vibe → Settings → API & Agents and turn it on.' };
    return;
  }
  try {
    const model = await ensureModel(base, config);
    const modelPath = MODEL_OVERRIDE || cfg(config, 'model.path');
    vibe = { base, model, diarizeModel: findDiarizeModel(config, modelPath), error: null };
  } catch (err) {
    vibe = { base, model: null, diarizeModel: null, error: err.message };
  }
}

const server = http.createServer(async (req, res) => {
  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(allowed ? 204 : 403);
    return res.end();
  }
  if (req.headers.origin && !allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Origin ${req.headers.origin} is not allowed. Restart the bridge with --origin ${req.headers.origin}` }));
  }

  const url = new URL(req.url, 'http://bridge');

  // What the web app asks first: is Vibe here, and what should it send?
  if (req.method === 'GET' && (url.pathname === '/info' || url.pathname === '/health')) {
    if (!vibe.base || vibe.error) await refresh();
    res.writeHead(vibe.error ? 503 : 200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: !vibe.error, ...vibe, bridge: 'flammard-vibe-bridge/1' }));
  }

  // Everything under /v1 is proxied to vibe-server as-is (bodies stream both ways)
  if (url.pathname.startsWith('/v1/')) {
    if (!vibe.base) await refresh();
    if (!vibe.base) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: vibe.error }));
    }
    const target = new URL(vibe.base + url.pathname + url.search);
    const headers = { ...req.headers, host: target.host };
    delete headers.origin;
    const upstream = http.request(
      target,
      { method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      vibe.base = null; // Vibe restarted on a new port — rediscover next time
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Vibe did not answer: ${err.message}` }));
    });
    req.pipe(upstream);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Flammard Vibe bridge listening on http://127.0.0.1:${PORT}`);
  console.log(ORIGINS.length ? `Allowed sites: ${ORIGINS.join(', ')}` : 'Allowed sites: any (pass --origin https://your-site to restrict)');
  await refresh();
  if (vibe.error) console.log(`⚠ ${vibe.error}`);
  else console.log(`Vibe at ${vibe.base} · model ${vibe.model}${vibe.diarizeModel ? ' · speaker labels on' : ''}`);
  console.log('Leave this window open during meetings. Ctrl+C to stop.');
});
