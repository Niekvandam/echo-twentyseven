# Twentyseven on Vercel

## Deployment layout

| Project | Source | Runtime |
| --- | --- | --- |
| twentyseven-echo | `echo/frontend` | Vite dashboard |
| twentyseven-echo-portal | `echo/frontend` | Vite participant portal, selected by hostname |
| twentyseven-echo-api | `echo/server` | Python 3.11 container, FastAPI |
| twentyseven-echo-directus | `echo/vercel/directus` | Directus 11.13.4 container |
| twentyseven-echo-jobs | `echo/vercel/jobs` | Node 22, Vercel Queues and Cron |

Storage: a dedicated Frankfurt Neon Postgres database with pgvector, Upstash
Redis (database 0), and private Vercel Blob. Nothing uses the inspiration
project's database. Secrets are configured in Vercel and ignored local env files.

Both frontends proxy `/api/*` to FastAPI and `/directus/*` to Directus. This
keeps Directus session cookies on the frontend origin. The explicit
`/api/:path*/` rewrite preserves trailing-slash presentation URLs such as
Popcorn; without it those pages fall through to the dashboard SPA. The backend connects
to Directus with its static admin token and an automation bypass secret;
otherwise Vercel system mitigations can challenge server-to-server SEARCH calls.
The bypass does not replace application authentication.

## Required credentials

On `twentyseven-echo-api`, set:

- `ELEVENLABS_API_KEY`: valid key with Scribe realtime access.
- `GOOGLE_GENERATIVE_AI_API_KEY`: shared Gemini key for the three configured
  model groups and embeddings. Explicit per-group keys override this fallback.

The inspiration project's exported values were **`[Sensitive]` placeholders**.
Those placeholders have been removed. The real values cannot be recovered
with `vercel env pull`. After setting credentials, redeploy the API.
The user supplied both real credentials in Vercel; the API was redeployed and
both integrations were verified on 2026-09-15 without exporting the keys.

The initial administrator's email/password are in the ignored root
`.env.twentyseven.local`. Do not commit or publish that file.

Other API env variables are documented in `echo/server/.env.sample`; the
provisioned non-credential deployment configuration is in the Vercel project.
Jobs requires `ECHO_API_URL`, `ECHO_JOBS_SECRET`, `CRON_SECRET` (same value), and
`BLOB_READ_WRITE_TOKEN`. Directus requires `DATABASE_URL`, `DIRECTUS_SECRET`,
`VERCEL_JOBS_URL`, and `ECHO_JOBS_SECRET`.

## Single-administrator operation

The only provisioned account is `nvdam@handpickedagencies.com`. Login at
https://twentyseven-echo.vercel.app/en-US/login. Its initial password is
`ADMIN_PASSWORD` in the ignored root `.env.twentyseven.local`; keep it in a
password manager. Change it under Settings → Account & security after login.
Changing the password does not update the local initial-password record.
No email verification or email service is needed for this account.

Public signup is disabled in both layers: API `ENABLE_PUBLIC_REGISTRATION=false`
and Directus settings `public_registration=false`. The Twentyseven frontend
hides signup/email-reset actions and sends their routes to login. Do not enable
Directus public registration when applying future settings migrations.
Participants use a project link or QR code, without a dashboard account.

Without email, forgotten-password recovery is an operator action: use the
private Directus admin token to PATCH the existing user through `/users/{id}`
with a new password, then verify login. Never put a fixed password, an admin
token, or an authentication bypass into frontend source. Preserve access to
Vercel and the private recovery credentials independently of the dashboard.

### Run a session

1. Log in, open Twentyseven and its workspace, and create a project.
2. Configure the participant instructions, conversation language and portal.
   Keep anonymized mode off until a realtime redaction flow is implemented.
3. Open collection for that project and copy its participant link or download
   its QR code. Share the project-specific link, not the dashboard login or
   the bare portal homepage.
4. Participants open the link, allow microphone access, record and finish.
   Their committed transcript is saved; the background queue produces a summary.
5. Review conversations in the project dashboard. Close collection when done.

Start with a small pilot and verify a complete conversation on the actual
phones/browsers you will use. The technical audio-to-summary chain is verified;
real-device recording, interruption/reconnection and all analysis features are
not yet fully validated. Before broader rollout, settle participant information
and retention/deletion policy, check backup/restore and queue failure handling,
and wire Git-based deployments. See the remaining scope below. Mail is optional
for this single-admin workflow; invitation and email-reset features need it.

## Schema and files

The existing `echo/directus/sync` schema, permissions and policies were applied
with directus-sync 3.5.1 against the new database, using Directus 11.13.4.
Do not run bootstrap or schema migrations on every container cold start.
Follow the existing Directus migration workflow when the schema changes.

Directus uses a Blob driver registered before startup. It relies on the pinned
Directus storage registry: validate this integration before upgrading Directus.
Files are streamed through signed URLs issued by the jobs service. No durable
files are written to a container's local filesystem. Driver directory listing
and resumable TUS uploads are not implemented; normal multipart upload,
read, stat, copy, move and delete are supported.

## Live transcription

The browser waits for the provider session-start acknowledgement before sending
audio, reuses the recording microphone stream, and converts it to 16 kHz mono
PCM, and connects directly to ElevenLabs Scribe v2 Realtime using a single-use
token. The long-lived ElevenLabs key stays on the API. Committed text is sent
to the API with a conversation-scoped JWT. Segment IDs produce deterministic
chunk IDs, so a network retry does not duplicate a transcript.

Storage requests time out after 15 seconds; queued text is retried every five
seconds while recording. Continuous partial speech is committed every 15 seconds.
A 45-second absence of transcript progress after audible input opens the
interruption flow, as do transport failures. Audio worklet send exceptions are
contained. Session startup and token requests are bounded to 20 seconds each.

Pending committed text is held in session storage until the API accepts it.
Keep the same browser tab open when recovering from a connection failure.
Partial text is not a confirmed transcript; after a disconnect, the final
sentence can require repetition. Stop/finish waits for final confirmation and
storage. Live mode stores text only, so it does not provide audio replay.
Anonymized conversations are rejected by this live route rather than silently
storing unredacted text.

## Task runtime

Existing Dramatiq actors use an HTTP broker when `VERCEL_JOBS_URL` is set.
The Node gateway enqueues messages and Vercel delivers them to a queue consumer.
The consumer calls the authenticated internal API, which executes the actor and
uses Redis locks/completion records to suppress simultaneous and completed
replays. Delivery is at least once: actors with external side effects still
need their own idempotency. This is not a guarantee of exactly-once execution.

The consumer waits up to 750 seconds, with a 900-second visibility/lock window.
API/container functions have an 800-second limit. This is not suitable for
unbounded or longer-running actors without splitting their work.
A two-minute cron enqueues the four conversation reconciliation actors, the
Popcorn tick reconciler, and the durable task runner scoped to `popcorn_tick`.
This advances live Popcorn sessions without a manual refresh.
It does not migrate the entire original billing, canvas and monitoring scheduler.

### Sleeping when nobody is here

The API and Directus run as container services. Vercel scales a container down
after five minutes without traffic and bills provisioned memory for as long as an
instance lives, so a two-minute cron that runs unconditionally keeps both awake
around the clock: an idle night cost the same as a working day.

The cron is therefore gated. The API refreshes `twentyseven:active` in Redis on
every request under `/api`, except `/api/internal/*`, with a twenty-minute expiry
(`dembrane/activity.py`). `/api/reconcile` reads that key and enqueues nothing
while it is gone, which costs one Redis read per run and never wakes a container.

What counts is an allowlist, not everything-but-the-queue. Vercel probes a
container's port when it starts, and that probe is not a person: counting it made
the probe refresh the key, the cron wake the container two minutes later, and its
probe refresh the key again, so nothing ever slept. The queue is excluded for the
same reason - it is the cron's own work coming back. Every refresh is logged with
the path that caused it, so anything unexpectedly holding the containers awake
can be found rather than guessed at.

The gate fails open. Without `REDIS_URL`, or when Redis is unreachable, the cron
enqueues as before, because a broken gate should cost money rather than
correctness. `REDIS_URL` must therefore be set on `twentyseven-echo-jobs`,
pointing at the same Upstash database the API uses.

`/api/sweep` runs at 04:00 UTC without the gate, so work stranded after the last
person left is picked up within a day instead of waiting for the next visit.

The first request after a quiet period pays a container cold start. A dashboard
tab left open holds a streaming connection, which keeps the API awake and the
heartbeat fresh, so close it when you are done for the day.

## Verification and remaining scope

Verified against the deployed services:

- Directus login, dashboard session login and onboarding.
- Single-administrator login with the configured owner email; API and native
  Directus public registration return 403. A regression test verifies disabled
  API registration cannot query accounts, create accounts or send email.
- Workspace creation and project/conversation records.
- Private Blob write/read and Directus multipart file write/read, including
  reading the same Directus file after a fresh deployment.
- Queue enqueue, delivery and persisted execution status, including the
  downstream finalization setting `is_all_chunks_transcribed=true`.
- Transcript ingestion, duplicate replay and unauthorized-request rejection.
- ElevenLabs single-use token issuance and a real Scribe realtime WebSocket
  session with synthetic spoken audio, followed by persisted transcript and
  duplicate replay without duplicate chunks.
- Conversation completion and a persisted Gemini summary of that transcript
  through the deployed background pipeline (2026-09-15).

Local checks: frontend TypeScript/build and translated catalogs, recorder/link/chat tests, four live
transcription hook tests, seven backend authorization/idempotency/transport
tests and two Node internal-auth tests (29 tests in total). The single-admin
change adds one passing backend registration test; the frontend TypeScript and
production build were rechecked.

Still required before real participant sessions:

- Browser microphone-to-transcript testing on desktop and mobile; the live
  provider integration test used synthetic PCM audio, bypassing browser capture.
- Gemini search/embedding validation; summary generation is verified.
- Audio-file batch transcription provider configuration; realtime is currently
  the only ElevenLabs integration.
- Agentic Ask service deployment (hidden for Twentyseven until configured).
- Remaining scheduler flows, transactional email, billing and custom domains.
- Full participant mobile/browser QA and review of remaining Dembrane help,
  policy and release copy. Typography/colors and primary logos are branded.
  The portal shows a factual test-environment notice instead of the original
  Dembrane processing and retention guarantees. Remaining third-party help
  and policy links still need review.

## Deploy

Link each source directory to the matching Vercel project, then:

```sh
vercel deploy --yes --prod --scope handpicked-lab --cwd echo/vercel/jobs
vercel deploy --yes --prod --scope handpicked-lab --cwd echo/vercel/directus
vercel deploy --yes --prod --scope handpicked-lab --cwd echo/server
vercel deploy --yes --prod --scope handpicked-lab --cwd echo/frontend
```

Deploy the same frontend sources to the portal project using a separate linked
checkout. Do not accidentally relink the dashboard to the portal project.
Deployments were made from the local workspace. Git-triggered CI is not wired.

## Popcorn output language

`POPCORN_OUTPUT_LANGUAGE=English` is configured on the API. All Popcorn model
passes receive this override; verbatim evidence remains in the original language.
The extractor prompt is versioned as `popcorn-v1.10` to permit faithful translation and surface a
single substantive idea during a growing recording; repetition or a finished
discussion is not required. Language participates in the extraction fingerprint so changed
settings trigger a new read. Saved historical versions retain their original text.

## Realtime stability verification

The health SSE subscription is keyed by conversation IDs rather than the
identity of the input array. This prevents new subscriptions on every partial
transcript and every heartbeat. Seventeen recorder/health/realtime tests and
one Popcorn-language test pass. A deployed browser test with synthetic speech
ran for over a minute, received four committed segments, persisted 163 words,
and reached the finish page. This does not substitute for mobile-device QA.

The English regeneration of the existing test session produced English analysis
text but no new Popcorn phrases; saved historical versions were not translated.

## Popcorn live scheduling verification

The Vercel cron now dispatches the Popcorn reconciler and a task-type-scoped
scheduled runner. Eleven backend scheduler/language tests pass. Production
verification reprocessed Demo woensdag from zero to six extracted English
phrases, five retained after grounding; the presenter displayed them. A separate
smoke session ran its next scheduled tick without refresh and advanced its next
read time, then was stopped. Live reads target a two-minute cadence; cron polling
and model runtime can add latency. Paused sessions still require starting Live.

## Popcorn capacity

Each conversation can produce up to twenty phrases. The extractor prompt,
response schema and deterministic shaping cap agree on this limit; extraction
has a 4,000-token answer budget. Grounding may retain fewer phrases. The
presentation continues rotating phrases rather than displaying twenty at once.
The change passed sixty model, shaping, enrichment, tick and presentation tests.
