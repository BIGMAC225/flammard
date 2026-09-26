#!/usr/bin/env node
/**
 * Vibe bridge — lets the Flammard web app transcribe on this computer.
 *
 * The Vibe desktop app runs a local transcription server (vibe-server) with
 * an OpenAI-style API, but it sends no CORS headers, so a web page can't talk
 * to it. This script sits in front of it on a fixed port and adds exactly
 * that: CORS (including Chrome's private-network preflight), discovery of
 * Vibe's current URL from its config file, and (re)loading the model Vibe is
 * configured with. Only the transcription endpoint is exposed.
 *
 *   node vibe-bridge.mjs --origin https://flammard.netlify.app
 *
 * Requirements: Node 18+, the Vibe desktop app open with
 * Settings → API & Agents turned on. No npm install needed.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';

// ── Options ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const PORT = Number.parseInt(opt('port', process.env.VIBE_BRIDGE_PORT || '47111'), 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail('--port must be a number between 1 and 65535');

// Sites allowed to use this computer. Compared by origin, so a trailing
// slash or path on the flag doesn't matter.
const ORIGINS = args
  .flatMap((a, i) => (a === '--origin' && args[i + 1] ? [args[i + 1]] : []))
  .map((o) => {
    try {
      return new URL(o).origin;
    } catch {
      return fail(`--origin ${o} is not a URL`);
    }
  });
const ALLOW_ANY = flag('allow-any-site');
const DEV = flag('dev'); // also allow http://localhost:* (a local Flammard dev server)
if (!ORIGINS.length && !ALLOW_ANY) {
  fail(
    'Pass the site that may use this computer, e.g.\n' +
      '  node bridge/vibe-bridge.mjs --origin https://flammard.netlify.app\n' +
      '(or --allow-any-site to let any website transcribe here — not recommended)'
  );
}

const VIBE_URL_OVERRIDE = opt('vibe', process.env.VIBE_URL);
const MODEL_OVERRIDE = opt('model', process.env.VIBE_MODEL);
const DIARIZE_OVERRIDE = opt('diarize', process.env.VIBE_DIARIZE_MODEL);

function fail(message) {
  console.error(message);
  process.exit(1);
}

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

// Vibe unloads its model after a few idle minutes, so this runs before every
// transcription, not just at startup.
async function ensureModel(base, config) {
  const ready = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
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

// ── CORS + host checks ───────────────────────────────────────────────────
function allowOrigin(origin) {
  if (!origin) return null;
  if (ALLOW_ANY || ORIGINS.includes(origin)) return origin;
  if (DEV && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

// DNS rebinding guard: only accept requests addressed to this loopback port
function hostOk(host) {
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`;
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
    return vibe;
  }
  try {
    const model = await ensureModel(base, config);
    const modelPath = MODEL_OVERRIDE || cfg(config, 'model.path');
    vibe = { base, model, diarizeModel: findDiarizeModel(config, modelPath), error: null };
  } catch (err) {
    vibe = { base, model: null, diarizeModel: null, error: err.message };
  }
  return vibe;
}

const sendJson = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  if (!hostOk(req.headers.host)) return sendJson(res, 421, { error: 'Wrong host' });

  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(allowed ? 204 : 403);
    return res.end();
  }
  if (req.headers.origin && !allowed) {
    return sendJson(res, 403, {
      error: `${req.headers.origin} is not allowed to use this bridge. Restart it with --origin ${req.headers.origin}`,
    });
  }

  const url = new URL(req.url, 'http://bridge');

  // What the web app asks first. Always re-checks Vibe: it may have restarted
  // on a new port or unloaded its model since the last call.
  if (req.method === 'GET' && (url.pathname === '/info' || url.pathname === '/health')) {
    const v = await refresh();
    return sendJson(res, v.error ? 503 : 200, {
      ok: !v.error,
      model: v.model,
      speakerLabels: !!v.diarizeModel,
      diarizeModel: v.diarizeModel, // the page sends this back as a form field
      error: v.error,
      bridge: 'flammard-vibe-bridge/2',
    });
  }

  // The one proxied endpoint: audio in, NDJSON out, streamed both ways.
  if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    const v = await refresh();
    if (v.error) return sendJson(res, 503, { error: v.error });

    const target = new URL(v.base + url.pathname + url.search);
    const headers = { ...req.headers, host: target.host };
    delete headers.origin;

    const upstream = http.request(target, { method: 'POST', headers }, (up) => {
      const outHeaders = { ...up.headers };
      delete outHeaders.vary; // keep our Vary: Origin
      res.writeHead(up.statusCode ?? 502, outHeaders);
      // pipeline ends/destroys `res` if Vibe dies mid-stream, so the page
      // sees an error instead of waiting forever
      pipeline(up, res, (err) => {
        if (err) vibe.base = null;
      });
    });
    upstream.on('error', (err) => {
      vibe.base = null; // Vibe restarted on a new port — rediscover next time
      if (!res.headersSent) sendJson(res, 502, { error: `Vibe did not answer: ${err.message}` });
      else res.destroy();
    });
    // Closing the tab must stop the transcription, or Vibe stays busy (429)
    // for everyone until an hour-long job finishes on its own
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    pipeline(req, upstream, () => {});
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') fail(`Port ${PORT} is already in use — is the bridge already running? (or pass --port)`);
  fail(`Could not start: ${err.message}`);
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Flammard Vibe bridge listening on http://127.0.0.1:${PORT}`);
  console.log(
    ALLOW_ANY ? 'Allowed sites: ANY (not recommended)' : `Allowed sites: ${ORIGINS.join(', ')}${DEV ? ' + localhost' : ''}`
  );
  const v = await refresh();
  if (v.error) console.log(`⚠ ${v.error}`);
  else console.log(`Vibe at ${v.base} · model ${v.model}${v.diarizeModel ? ' · speaker labels on' : ''}`);
  console.log('Leave this window open during meetings. Ctrl+C to stop.');
});
