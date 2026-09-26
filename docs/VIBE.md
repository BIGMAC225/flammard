# Vibe: one-click transcription

Vibe (the desktop app) transcribes on your own machine. It runs a small local server with an OpenAI-style API — but that server can't be called from a web page (it sends no CORS headers), so Flammard ships a **bridge**: a ~200-line Node script that sits in front of Vibe on a fixed port and adds what the browser needs. Nothing to install beyond Node.

With the bridge running, step 2 of a meeting's Session tab shows **Transcribe with Vibe on this computer**. One click pulls the recording down, streams it through Vibe with live progress, and saves the transcript — no download, no export, no upload.

## Setup (once, on the meeting computer)

1. Install [Node.js](https://nodejs.org) 18 or newer if it isn't there (`node --version`).
2. Get the Flammard folder onto the machine (`git clone …`, or just copy `bridge/vibe-bridge.mjs` — it has no dependencies).
3. In Vibe: pick your model once (Settings → Model), turn on **Settings → API & Agents**, and, if you want speaker labels, **Settings → Recognize speakers**.
4. Start the bridge:

   ```bash
   node bridge/vibe-bridge.mjs --origin https://<your-site>.netlify.app
   ```

   It prints the Vibe URL it found and the model. Leave the window open during meetings. (`--origin` restricts which site may use this computer; omit it to allow any.)

Reload the meeting page — the Vibe button appears in step 2.

## How it works

- Vibe writes its current server URL into its config file (`app_config.json` → `api.baseUrl`) while the API toggle is on. The bridge reads that, health-checks it, and loads the model from `model.path` if none is loaded. If Vibe restarts on a new port, the bridge re-discovers it on the next request.
- The bridge listens on `http://127.0.0.1:47111` (change with `--port`). `GET /info` reports status; anything under `/v1/` is proxied to Vibe unchanged, with CORS and Chrome's private-network preflight handled.
- The page sends the audio as multipart with `stream=true`, reads Vibe's NDJSON stream (progress, segments, result), and turns the segments into text — `Speaker N:` prefixes when diarization is on.

## Limits and notes

- Browsers only allow an https page to reach `127.0.0.1` as a "potentially trustworthy" origin. Chrome, Edge and Firefox do; Safari may block it. Use Chrome for meetings if in doubt.
- Vibe handles one transcription at a time; a second request gets "busy" (429). Wait for the first to finish.
- The audio never leaves your network for transcription — only the resulting text goes to Flammard (and then to Claude for analysis).
- To restrict use to your site, keep `--origin`. There is no password on the bridge; it can only transcribe.
- The bridge can also be pointed at a standalone `vibe-server` (`--vibe http://127.0.0.1:PORT --model /path/to/ggml-model.bin`) if you'd rather not run the desktop app.

## Without the bridge

The manual route still works: **Download audio for Vibe**, transcribe in the app, export `.txt`/`.srt`/`.vtt`/`.json`, drop the file into step 2.
