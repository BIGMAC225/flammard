# L10 export route

`GET /api/export/l10?team=<slug>` returns a team's current L10 working set as
one JSON document. It exists so the scheduled prep worker on the desktop can
build the weekly L10 packet from live data instead of stale files.

The route is **read-only**: it runs `select` statements only and never writes
to the database. It returns exactly five data sets and nothing else: the
team's Scorecard, its Rocks for the current quarter, its open Issues, its open
To-Dos, and a summary of the last meeting. It never returns People Analyzer
data, per-attendee rating rows, emails, sign-in data, steps, or any other
table. Teams are `leadership` and `management`.

## Authentication

No sign-in: the caller sends a shared token as a bearer header.

```
Authorization: Bearer <L10_EXPORT_TOKEN>
```

`L10_EXPORT_TOKEN` is an environment variable, compared with a timing-safe
equal. Anything else about the failure is never told to the caller:

| Request | Answer |
|---|---|
| Missing header, wrong token, or `L10_EXPORT_TOKEN` unset | `401 {"error":"unauthorized"}` |
| Unknown or missing `team` | `400 {"error":"unknown team"}` |
| Any method other than GET | `405 {"error":"method not allowed"}` |

The token and the header are never logged.

## Setting the token

Generate a long random token:

```
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

or the PowerShell equivalent:

```
powershell -Command "[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })).Replace('+','-').Replace('/','_').TrimEnd('=')"
```

Set it in Netlify (either way works):

```
netlify env:set L10_EXPORT_TOKEN <value>
```

or Site configuration → Environment variables → Add a variable, key
`L10_EXPORT_TOKEN`, in the main environment. **A redeploy is needed after
setting or changing it**: Netlify injects environment variables when a
function is deployed, so the running function keeps the old value until a new
deploy starts. Trigger one from the Deploys page ("Retry deploy" works if the
code has not changed).

Test it (expects the site's real domain):

```
curl -i -H "Authorization: Bearer <token>" "https://flammard.netlify.app/api/export/l10?team=leadership"
```

`401` means the token is wrong or the redeploy has not happened yet. To
revoke access: change or remove `L10_EXPORT_TOKEN` in Netlify and redeploy.

## The payload

```json
{
  "generated_at": "2026-10-24T13:45:00.000Z",
  "team": "leadership",
  "scorecard": [
    {
      "measurable": "Revenue invoiced",
      "owner": "Jennifer",
      "goal": 50000,
      "goal_type": ">=",
      "unit": "USD",
      "entries": [ { "week": "2026-10-19", "value": 51230, "met": true } ]
    }
  ],
  "rocks": [
    { "title": "Hire senior preparer", "owner": "Russell", "status": "on_track",
      "due": "2027-01-29", "quarter": "Q4 FY 2026", "updated_at": "2026-10-20T09:00:00.000Z" }
  ],
  "issues": [
    { "title": "Hiring bottleneck", "owner": "Russell", "priority": "high",
      "status": "open", "created_at": "2026-10-01T09:00:00.000Z" }
  ],
  "todos": [
    { "title": "Send AR list", "owner": "Jennifer", "due": "2026-10-27", "status": "open",
      "created_at": "2026-10-20T10:00:00.000Z", "meeting_date": "2026-10-20" }
  ],
  "last_meeting": {
    "date": "2026-10-20",
    "rating": 8.5,
    "cascading_messages": ["Great quarter ahead, to All staff, by Russell, via Friday huddle"]
  }
}
```

Scope rules:

- **scorecard**: the team's active metrics, in scorecard order. `goal` and
  `goal_type` are parsed from the metric's goal text ("≥ 50000" becomes
  `goal: 50000`, `goal_type: ">="`; a plain number is `"="`; no number gives
  both null). Entries are newest first, at most 13 weeks; `week` is the
  reporting period date, which for TaxDome imports is the report's production
  day (Chicago time). `met` is the stored on-track flag, null when unset.
- **rocks**: the team's rocks of the current firm quarter, all statuses
  (planned / on_track / off_track / complete / dropped). A rock belongs to the
  quarter its due date falls in, created date when it has none, the same rule
  as the Rocks page's "Quarter end" view.
- **issues**: open issues only. The short-term list in rank order first, then
  the long-term list, the same order as the Issues page.
- **todos**: open to-dos only, oldest first (the to-do review's order), with
  `meeting_date`, the date of the meeting a to-do came from, when there is one.
- **last_meeting**: the team's most recent meeting. `rating` is the average of
  the attendee ratings, falling back to the meeting's own stored rating; null
  when the team has no meetings, along with the whole `last_meeting` object.
- The response carries `Cache-Control: no-store`. If any list would exceed
  500 rows it is cut at 500 and a top-level `"truncated": true` is added.
