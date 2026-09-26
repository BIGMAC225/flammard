# Automation setup

Two automated flows feed Flammard:

1. **Meeting session** — record in the browser → transcribe in Vibe → Claude drafts the EOS sections and minutes → you review and accept.
2. **TaxDome scorecard import** — TaxDome emails a scheduled report → Zapier forwards the PDF to Flammard → Claude reads the numbers into the scorecard.

## 1. One-time setup

Database, storage and sign-in are all on Netlify — see `docs/SETUP.md`. The two extra variables these flows need:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Transcript analysis and report extraction. Create at console.anthropic.com. |
| `TAXDOME_WEBHOOK_SECRET` | Shared secret Zapier sends with each report. Generate with `openssl rand -hex 32`. |

## 2. Meeting session flow

On a meeting page the **Session** tab walks through three steps:

1. **Start meeting** records from the microphone. Keep the tab open for the whole meeting. **End meeting** uploads the audio to Netlify Blobs in 4 MB chunks (a single serverless request is capped at 6 MB) and shows **Download audio for Vibe**.
2. **One click, if the Vibe bridge is running on that computer** (`docs/VIBE.md`): *Transcribe with Vibe on this computer* streams the recording through Vibe and saves the transcript. Otherwise: open the downloaded file in [Vibe](https://thewh1teagle.github.io/vibe/), transcribe it, and export. Any of `.txt`, `.srt`, `.vtt` or `.json` works — drop it into step 2. (You can also paste text.)
   - Turn on **speaker diarization** in Vibe before transcribing: the exports then carry "Speaker 1 / Speaker 2" labels, which makes owner attribution for to-dos noticeably better.
   - Vibe can also record directly (microphone or system audio, for Zoom/Teams calls). If you'd rather do that, skip step 1 and just upload Vibe's export.
   - Vibe's local server sends no CORS headers, so the browser can't call it directly; the bridge script in `bridge/` adds that. Details in `docs/VIBE.md`.
3. **Analyze transcript** sends it to Claude with the current rocks, open to-dos and open issues as context so misheard names line up with real items. It returns headlines, rock statuses, reviewed and new to-dos, solved and new issues, decisions, action items, discussion and a summary. Untick anything wrong and **Accept**. Everything ticked is written to the EOS sections and the minutes draft; you can still edit each item afterwards.

Approving the minutes now includes the EOS sections and the scorecard (latest value per metric as of the meeting date) in the sealed PDF.

Notes:
- Analysis normally takes 30–90 seconds. The response is streamed (with heartbeats) so it isn't subject to Netlify's 10-second synchronous function limit, and the result is saved to the database as soon as it's ready. If the browser's connection is cut anyway, the page polls for the saved analysis for up to ~100 seconds before reporting a failure.
- **Check this on the first real meeting.** If analyses consistently fail while a shorter transcript works, Netlify is ending the function early; the fix is either raising the function timeout (Netlify support, paid plans) or moving the analysis to a Netlify Background Function — say so and it can be done.
- Re-running the analysis after accepting and accepting again *replaces* the headlines, rock reviews, to-dos and issues that the earlier acceptance added to this meeting, so nothing is duplicated. Status changes made to older to-dos/issues are not reverted.

## Roadmap

**Roadmap** lays out the multi-year plan for the active team: **periods** (any date range with a name — teams here plan in spans like *Aug–Nov 2026*, not calendar quarters), the 2–3 **rocks** in each, and each rock's **steps** with progress. The current period is highlighted; past ones are dimmed; future rocks are *Planned* and only become *On track* when their period starts (or when a meeting reviews them). Analysis and the L10 context only look at on-track / off-track rocks, so planned ones don't clutter meetings.

**Import a plan** takes the deck or document the plan lives in (`.pptx`, `.docx`, `.txt`, `.md`, `.csv`) or pasted text. Claude lays it out as periods → rocks → steps; you untick anything wrong and add it. Periods that already exist (same name) are reused, so importing an updated deck adds rather than duplicates periods — it will, however, add rocks again if they're in the file, so untick ones you already have.

## Breaking items down

Every open to-do, issue and rock on its list page has a **Steps** section (click "Break it down"). Add steps and sub-steps by hand, tick them off, or pick a level of detail and click **Break down with AI** — Claude proposes steps (with sub-steps at the normal and detailed levels), you untick anything you don't want, and they're added. "Suggest more" on an item that already has steps avoids repeating them. Ticking a step ticks its sub-steps.

## 3. TaxDome → Zapier → Flammard

### In Flammard

Go to **Scorecard** and add the metrics you want tracked (revenue invoiced, AR outstanding, jobs completed, hours logged, …). For each, fill in **Where to find it in the TaxDome report** — this is the hint the extractor uses to match a number in the PDF, so be specific ("Total of the *Amount paid* column in the Invoices report").

### In TaxDome

Reporting → open the dashboard/report → schedule an email export (PDF) to the address Zapier gives you below, at the cadence you review it (weekly for the L10).

Each team (Leadership / Management) has its own scorecard, so the webhook URL carries a `?team=` parameter — copy it from the Scorecard page while that team is selected in the header. If both teams get a TaxDome report, make one Zap per team.

### In Zapier

Create a Zap:

1. **Trigger — Email by Zapier: New Inbound Email.** Zapier gives you an address like `something.abc123@zapiermail.com`. Use that as the TaxDome recipient. (If you'd rather keep it in your own mailbox, use the **Gmail: New Attachment** trigger with a label/filter for the TaxDome sender instead.)
2. **Action — Webhooks by Zapier: POST.**
   - **URL:** `https://<your-site>/api/integrations/taxdome?team=leadership` (shown on the Scorecard page; `management` for the other team)
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
