# P0 Task A handoff: interfaces for Tasks B, C and D

Task A is merged into `p0-foundation`. Build these interfaces as written. Read the code for the details.

## src/lib/password.ts
- `hashPassword(pw): Promise<string>`
- `verifyPassword(pw, stored | null): Promise<{ ok, needsRehash }>`
- `passwordProblem(pw, email?): string | null`
- `newToken(): { token, hash }`
- `hashToken(t): string`

## src/lib/auth.ts
- `SESSION_COOKIE`, `TEAM_LABEL`
- `sharedLoginEnabled()`, `sharedLoginRole()`, `passwordMatches(pw)`
- `startPersonSession(cookies, { id, session_version })`
- `startSharedSession(cookies)`
- `startSession` (alias)
- `endSession(cookies)`, `readSession(cookies)`, `isAuthenticated(cookies)`
- `parseSessionValue(raw)`

## src/lib/people.ts
- `OWNER_COLUMNS` (7 entries)
- `loadPrincipal(cookies)`
- `listPeopleOptions(includeInactive?)`
- `resolveOwner({ owner_id?, owner? }, { match? })`
  - An empty or null `owner_id` falls back to the owner text.
  - A bad or inactive `owner_id` returns `{ error }`.
  - A non-string text value returns `{ error }`.
- `resolveOwnerNames(names): Map<key, { id, name }>`
  - The key is `nameKey(text)`, which trims and lowercases the text.
- `syncOwnerNameQueries(id, name)`
  - Returns an array of queries to run inside `sql().transaction`.
- `backfillOwnerQueries()`
  - Each query uses `returning x.id`.
  - `results[i].length` is the number of rows updated for `OWNER_COLUMNS[i]`.
- `bootstrapOpen()`

## src/lib/permissions.ts
- `ROLES`, `ROLE_LABELS`, `isRole`, `Permission`
- `can(p, perm)`, `allowedTeams(p)`, `canAccessTeam(p, team)`
- `checkRoute(method, path, p, ctx?)`
  - `ctx.bootstrapOpen` is used for `/api/people/bootstrap` and `/dashboard/people` under the shared login.
- `canManagePerson(actor, { role }, newRole?)`

## src/lib/api.ts (additions)
- `principal(locals): Principal`, which throws if the principal is unset
- `requirePermission(locals, perm): Response | null`

## src/lib/settings.ts
- `getSettings(): Promise<ServerSettings>`
  - Includes `recap_webhook_secret` and `text_only_owner_names`.
- `publicSettings(s): CompanySettings`

## src/lib/throttle.ts
- `ipKey(request, addr?)`, `emailKey(email)`, `safeClientAddress(ctx)`
- `reserveAttempt(key)`, `tooManyAttempts(keys): Promise<boolean>`, `clearAttempts(keys)`, `failDelay()`
- `MAX_FAILURES`, `WINDOW_MS`, `FAIL_DELAY_MS`

## src/types.ts
- `Role`, `Person`, `PersonOption`, `Principal`, `CompanySettings`, `ImportBatch`, `RockLevel`
- The new item fields from spec §2.6.

## src/components/OwnerPicker.tsx
- Default export `OwnerPicker(props)`. Props are those in §5.2, plus `initialPeople?` and `className?`.
- `OwnerValue`, `usePeople(initialPeople?)`, `primePeople(list)` (browser only).
- It always loads inactive people so it can label them "(inactive)".

## Routes
- `GET /api/people/options?include_inactive=1` returns `{ people: PersonOption[] }`.

## Where Task A differs from the spec
- **Shared login env var:** `SHARED_PASSWORD_LOGIN`. Unset or `on` means enabled, and `off` disables it.
- **Bootstrap:** GET and POST `/api/people/bootstrap` are both allowed for the shared login while bootstrap is open.
  - The Task C handler must still return 409 once `bootstrapOpen()` is false.
- **`/api/settings`:** any non-GET method needs `settings.manage`.
- **`/api/team`:** returns 400 for an unknown team and 403 for a team the person isn't on.
- **Header nav:** already links People, Settings, Import and My account. Those pages belong to C and D.
