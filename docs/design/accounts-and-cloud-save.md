# Design: Accounts and cloud save

_Status: proposed · Size: XL · Depends on: nothing (settings model from the Goal tab
design is folded in here)_

## Summary

Add optional sign-in so a user's processed dashboard follows them across devices and
survives a cleared browser. Supabase provides auth (Google + email magic link), a
private storage bucket for the processed bundle, and one Postgres table for settings.
We write no IAM code: no password handling, no session tokens of our own, no server
except one tiny Edge Function for account deletion.

Not signing in keeps working exactly as today (IndexedDB only).

## Goals

- A signed-in user can import on a laptop and open the dashboard on a phone.
- Signing in on a fresh device with a saved bundle renders without re-uploading the export.
- The raw Strava export never leaves the browser. Only derived data is stored.
- Fits Supabase's free tier at a few hundred users.
- Delete-my-data is one click and complete.

## Non-goals

- Sharing dashboards with other people.
- Server-side processing (the browser pipeline stays the only pipeline for the public site).
- Client-side encryption of the stored bundle (listed as a follow-up).
- Conflict merging. Two devices importing different exports is resolved by "newest wins"
  with a prompt, not a merge.

## Current state

- `web/build/store.js` keeps one dataset in IndexedDB: a `meta` record (`summary`,
  `runs`, `routes`, `segments`, `buildVersion`, `builtAt`), a `streams` store keyed by
  activity id, and a `photos` store of Blobs.
- `web/app.js#boot` prefers the IndexedDB build, then falls back to `../data/clean/*`,
  then redirects to `import.html`.
- Measured on the 50-run sample: ~68 KB per stream JSON, ~15 KB per route, 53 KB summary.
  Extrapolated to a 230-run history: ~15 MB streams + 3.5 MB routes + <1 MB rest,
  uncompressed. Gzip on this JSON is roughly 4:1, so 5–6 MB per user. Photos add ~20 MB
  for a heavy photographer.

## Why Supabase

| Need | Supabase | Firebase | Roll our own (Workers + R2) |
|---|---|---|---|
| Google + magic-link auth, no code | yes | yes | no, must implement OAuth |
| Per-user private objects | Storage + RLS policies | Storage rules | must write auth checks |
| Small settings row per user | Postgres + RLS | Firestore | KV/D1, must write API |
| Free tier | 1 GB storage, 500 MB DB, 50k MAU | 5 GB storage, 1 GiB DB | 10 GB R2 |
| Static-host friendly | anon key in client, RLS enforces | same | n/a |
| Vendor lock-in | Postgres + S3-compatible | proprietary | none |

Firebase has more free storage. Supabase wins on Postgres (settings and future plan data
are relational-ish), S3-compatible storage (portable), and a cleaner client. If the 1 GB
ceiling is hit (~150 heavy users), the bundle bucket can move to R2 behind the same
Supabase auth with a small Worker; the client shape below is designed so that swap is
contained to `cloud.js`.

## Architecture

```
GitHub Pages (static web/)
  index.html / import.html
  build/store.js       IndexedDB (unchanged role: local cache, source of truth for render)
  build/cloud.js       NEW: supabase-js client, auth state, upload/download, manifest logic
  build/bundle.js      NEW: serialize/deserialize a build to/from shards (also "download my data")

Supabase project
  Auth: Google, email OTP (magic link)
  Storage bucket `bundles` (private)
      {user_id}/builds/{build_id}/manifest.json
      {user_id}/builds/{build_id}/meta.json.gz        summary, runs, routes, segments, regions
      {user_id}/builds/{build_id}/streams-000.json.gz  ~1 MB gz shards, ~15 runs each
      {user_id}/builds/{build_id}/streams-001.json.gz
      {user_id}/builds/{build_id}/photos/{file}         opt-in
      {user_id}/current.json                            { build_id, built_at, build_version }
  Postgres table `user_settings`
      user_id uuid pk references auth.users, settings jsonb, updated_at timestamptz
      RLS: user_id = auth.uid() for select/insert/update/delete
  Edge Function `delete-account` (service role): empties {user_id}/ prefix, deletes the
      settings row, deletes the auth user. The only server code in the project.
```

`build_id` is `builtAt` in ms. Writing a new build is: upload every object under a new
`builds/{build_id}/` prefix, then overwrite `current.json`, then delete older prefixes.
A reader always starts from `current.json`, so a half-finished upload is invisible.

## Bundle format

One JSON document per shard, gzip-compressed with `CompressionStream("gzip")` (native in
all current browsers, no library). Shards are cut by run order so a run's stream lives in
exactly one shard; the manifest carries `{ shard_index: { activity_id: shard_no } }`.

`manifest.json`:
```json
{
  "build_version": 3,
  "built_at": 1758000000000,
  "runs": 231, "miles": 1377.4, "first": "2024-02-10", "last": "2026-09-14",
  "shards": ["streams-000.json.gz", "streams-001.json.gz"],
  "shard_index": { "18986137160": 0, "19029617209": 1 },
  "photos": false,
  "app_version": "2026-09-16"
}
```

`build_version` is `store.js`'s `BUILD_VERSION`. A cloud bundle older than the app's
`BUILD_VERSION` is treated like a stale IndexedDB build: the user is asked to re-import.
This is the same rule the local cache already uses, so there is one compatibility story.

The same shard format is what "Download my data" produces (a single zip of the prefix)
and what "Import a bundle" reads. So the backup path for people who never sign in is
free once this exists.

## Client flow

### Boot (`app.js`)
1. Load local build from IndexedDB (unchanged).
2. If `cloud.js` has a session: fetch `current.json` (one small GET).
   - No local, cloud exists → download meta + shard 0 lazily, render. Remaining shards
     download in the background into IndexedDB `streams`.
   - Local and cloud both exist, same `built_at` → nothing.
   - Different `built_at` → non-blocking banner: "A newer dashboard was imported on
     another device on {date}. Use it / keep this one." "Use it" downloads; "keep this"
     uploads local as the new current (after confirm).
3. No session → render local, as today. Header shows "Sign in to sync".

### Import (`import.html`)
1. `buildAll` → `saveBuild` (unchanged).
2. If signed in: `bundle.serialize(build)` → `cloud.upload(shards)` with a progress
   bar ("Backing up 3 / 14"). Failure is non-fatal: the dashboard opens, a "backup
   didn't finish, retry" chip sits in the header and retries on next load.
3. If not signed in: after the success card, one line: "Sign in to keep this across devices."

### Opening a run (`openRun`)
`loadStream(id)` order: IndexedDB → cloud shard via `shard_index` (then cache the whole
shard's streams into IndexedDB) → `../data/clean/streams/` (local mode).

### Settings
`cloud.settings.get()` on boot merges into the local settings object (server wins on
`updated_at`). Writes go local first, then debounce-upsert to the row. Settings holds:
goal(s), hr_max, region names, the training plan, unit preference if we add one.

### Sign-in UI
- Header button → small sheet: "Continue with Google" / email field for magic link.
- After sign-in Supabase redirects back to the same page. On GitHub Pages the callback
  URL is `https://<user>.github.io/strava-stats/web/index.html`; add both index and
  import pages to the project's allowed redirect list.
- Signed in: avatar initial + menu (Sync now, Download my data, Delete account, Sign out).

## Security and privacy

- The anon key ships in the client by design; every object and row is guarded by RLS.
  Storage policies: `bucket_id = 'bundles' and (storage.foldername(name))[1] = auth.uid()::text`
  for select/insert/update/delete.
- The bundle contains GPS routes, so it's location history. Bucket is private, objects
  are only reachable with the user's JWT. No public URLs, ever.
- Raw export bytes are never uploaded. Photos are opt-in and off by default.
- Sign-out clears the Supabase session but keeps IndexedDB (it's their device). "Sign out
  and clear this device" is a second option.
- Delete account calls the Edge Function, then clears IndexedDB, then signs out.
- Supabase Auth handles email verification, token refresh, and revocation.

## Quotas and cost

| Scale | Storage | DB | Egress |
|---|---|---|---|
| 100 users, 6 MB each, no photos | 600 MB | ~1 MB | trivial |
| 150 users | 900 MB — free-tier ceiling | | |
| 100 users, half with photos | 1.6 GB — over | | |

Mitigations, in order: photos opt-in (done by default), delete old build prefixes
promptly (done), a soft cap on photo backup (e.g. 25 MB), then move the bucket to R2.
A `storage_bytes` column on `user_settings`, updated after each upload, lets the app show
the user their own footprint and lets us see the total in the dashboard.

## Failure modes

| Case | Behaviour |
|---|---|
| Upload dies mid-way | `current.json` untouched; retry chip; orphan prefix cleaned on next successful upload |
| Quota exceeded (Supabase returns 413/507) | Keep local, show "backup failed: storage full", never block the dashboard |
| Offline on a device with a cached build | Renders from IndexedDB; sync banner suppressed |
| Session expired | supabase-js refreshes silently; if refresh fails, treat as signed out |
| Cloud `build_version` < app's | Same message as local stale cache: re-import |
| Cloud `build_version` > app's (stale deployed page) | Prompt to reload the page |
| Two tabs importing at once | Last `current.json` write wins; both are valid builds |

## Testing

- Unit (Node `--test`): `bundle.js` round-trip (serialize → gzip → parse) equals the
  original build; shard cutting and `shard_index` correctness.
- Integration: Supabase CLI local stack in CI (`supabase start`), a Playwright run that
  signs in with a seeded email OTP user, imports the fixture export, reloads with a cleared
  IndexedDB, and asserts the dashboard renders the same totals.
- Manual: Google sign-in on the deployed page (can't automate the consent screen).

## Rollout

1. Land `bundle.js` + "Download / import my data" with no cloud at all. Useful alone.
2. Create the Supabase project, bucket, policies, table, and the delete function. Keep
   the SQL in `supabase/migrations/` in the repo.
3. Land `cloud.js` behind a `?cloud=1` flag; dogfood with your own export.
4. Remove the flag; add the privacy paragraph to the import page.

## Open questions

- Google only vs. Google + magic link (roadmap decision 3).
- Photos opt-in default (roadmap decision 4).
- Client-side encryption: a passphrase-derived key (PBKDF2 → AES-GCM via WebCrypto) would
  make the bucket contents opaque to Supabase and to us. Cost: a forgotten passphrase
  loses the backup, and the settings row would need the same treatment. Proposed as a
  later opt-in, not v1.
