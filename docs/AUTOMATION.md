# Automation setup

Two automated flows feed Flammard:

1. **Meeting session** — record in the browser → transcribe in Vibe → Claude drafts the EOS sections and minutes → you review and accept.
2. **TaxDome scorecard import** — TaxDome emails a scheduled report → Zapier forwards the PDF to Flammard → Claude reads the numbers into the scorecard.

## 1. One-time setup

### Database

Run `supabase/migrations/003_automation.sql` in the Supabase SQL editor. It adds the session columns on `meetings`, the `taxdome_imports` table, period-based scorecard entries, and the `recordings` storage bucket with its policies.

### Environment variables (Netlify → Site settings → Environment variables)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Transcript analysis and report extraction. Create at console.anthropic.com. |
| `TAXDOME_WEBHOOK_SECRET` | Shared secret Zapier sends with each report. Generate with `openssl rand -hex 32`. |
| `PUBLIC_APP_URL` | Your site URL, e.g. `https://flammard.netlify.app`. Shown on the Scorecard page as the webhook URL. |

Redeploy after adding them.

## 2. Meeting session flow

On a meeting page the **Session** tab walks through three steps:

1. **Start meeting** records from the microphone. Keep the tab open for the whole meeting. **End meeting** uploads the audio straight to Supabase Storage (bypassing the serverless size limit) and shows **Download audio for Vibe**.
2. Open the downloaded file in [Vibe](https://thewh1teagle.github.io/vibe/), transcribe it, and export. Any of `.txt`, `.srt`, `.vtt` or `.json` works — drop it into step 2. (You can also paste text.)
   - Turn on **speaker diarization** in Vibe before transcribing: the exports then carry "Speaker 1 / Speaker 2" labels, which makes owner attribution for to-dos noticeably better.
   - Vibe can also record directly (microphone or system audio, for Zoom/Teams calls). If you'd rather do that, skip step 1 and just upload Vibe's export.
   - Vibe ships a local `vibe-server` with an OpenAI-style HTTP API, but it doesn't send CORS headers, so the browser can't call it directly. That's why the hand-off is a file rather than a button.
3. **Analyze transcript** sends it to Claude with the current rocks, open to-dos and open issues as context so misheard names line up with real items. It returns headlines, rock statuses, reviewed and new to-dos, solved and new issues, decisions, action items, discussion and a summary. Untick anything wrong and **Accept**. Everything ticked is written to the EOS sections and the minutes draft; you can still edit each item afterwards.

Approving the minutes now includes the EOS sections and the scorecard (latest value per metric as of the meeting date) in the sealed PDF.

Notes:
- Analysis normally takes 30–90 seconds. The response is streamed so it is not cut off by Netlify's 10-second synchronous function limit.
- Re-running the analysis after accepting will create duplicate headlines/to-dos if you accept the same items twice — untick what already exists.

## 3. TaxDome → Zapier → Flammard

### In Flammard

Go to **Scorecard** and add the metrics you want tracked (revenue invoiced, AR outstanding, jobs completed, hours logged, …). For each, fill in **Where to find it in the TaxDome report** — this is the hint the extractor uses to match a number in the PDF, so be specific ("Total of the *Amount paid* column in the Invoices report").

### In TaxDome

Reporting → open the dashboard/report → schedule an email export (PDF) to the address Zapier gives you below, at the cadence you review it (weekly for the L10).

### In Zapier

Create a Zap:

1. **Trigger — Email by Zapier: New Inbound Email.** Zapier gives you an address like `something.abc123@zapiermail.com`. Use that as the TaxDome recipient. (If you'd rather keep it in your own mailbox, use the **Gmail: New Attachment** trigger with a label/filter for the TaxDome sender instead.)
2. **Action — Webhooks by Zapier: POST.**
   - **URL:** `https://<your-site>/api/integrations/taxdome` (shown on the Scorecard page)
   - **Payload Type:** `form`
   - **File:** map the email's **Attachment** field
   - **Headers:** `Authorization` = `Bearer <TAXDOME_WEBHOOK_SECRET>`
   - Leave "Wrap request in array" off.
3. Test the step with a real TaxDome email. The response looks like:

   ```json
   { "ok": true, "period_date": "2026-09-19", "entries_written": 4, "unmatched": [{ "label": "Open jobs", "value": "37" }] }
   ```

   `unmatched` lists figures found in the report that didn't map to any metric — if one belongs on the scorecard, add a metric for it and the next import will fill it.

The webhook also accepts JSON bodies (`{ "file_url": "…" }`, `{ "file_base64": "…" }` or `{ "text": "…" }`) if the Zap can't send a file part.

Every import is logged on the Scorecard page with its status, period and any extraction error. Values land in the scorecard grid under the report's period-end date; a re-sent report for the same period overwrites rather than duplicates.

### Timing

Zapier waits up to 30 seconds for the webhook. Extraction on a typical one-to-three-page report finishes well inside that; if a very long report times out on Zapier's side, the import still completes and appears on the Scorecard page — the Zap just shows an error.
