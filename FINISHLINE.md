# FINISHLINE — v0.6.0 ship checklist

Everything is built, reviewed, tested, and on `main` (`9a4fcb6` + this file).
The ONLY remaining step is the npm publish, which needs credentials this
environment didn't have. Status of everything else: **done**.

## State (verify before touching anything)

- `main` == the release: v0.6.0 version bump, README + CHANGELOG updated,
  HANDOFF.md deleted, plus a post-release review-hardening commit (15 audited
  fixes, see `d9243c7` and the "Review hardening" section of the changelog).
- Gates green as of the last push: `npm run build:all`, 116 unit tests
  (`npm run test:unit`), 21 e2e phases (`node test/e2e.js`), Next.js UI build.
- Tarball verified with `npm pack --dry-run`: `@robzilla1738/agentswarm@0.6.0`,
  69 files (dist, bin, ui/out), ~697 kB packed / 1.8 MB unpacked.

## To finish

1. ```bash
   git pull origin main && npm install
   ```
2. Publish (must be logged in: `npm whoami` should print the account):
   ```bash
   npm publish
   ```
   - `prepublishOnly` re-runs `build:all` + the e2e suite automatically (~4
     min) — let it; it's the final gate.
   - 2FA note: `npm publish --otp=<6-digit code>` if the account enforces it.
     The OTP is checked at the registry call AFTER prepublishOnly finishes,
     so grab a fresh code when the build output stops scrolling — or use an
     Automation-type access token, which skips OTP.
   - Token gotcha that burned us twice: the npm website shows the real token
     (`npm_…`) ONLY in the banner at creation time. The 64-hex strings in the
     token list afterwards are digests and will 401.
3. Verify it's live:
   ```bash
   npm view @robzilla1738/agentswarm version    # → 0.6.0
   ```
4. Optional smoke (needs a real API key configured):
   ```bash
   npx -y @robzilla1738/agentswarm@0.6.0 demo
   ```
5. Housekeeping:
   - Revoke any npm tokens created/pasted during this release (two token
     digests were pasted into a Claude session on 2026-06-11; the real tokens
     were never exposed, but revoke if unsure).
   - Repo convention: no git tags, no GitHub Releases — commits on main ARE
     the release record. Don't add a tag unless you mean to start tagging.
6. Delete this FINISHLINE.md in a final commit once 0.6.0 is live.

## Known future work (deliberately NOT in 0.6.0)

- SwarmBoard buckets conductor commentary onto task waves by timestamp
  proximity (1s slack, `ui/components/SwarmBoard.tsx`). Right fix is engine-
  side: stamp `conductor.say`/`conductor.action` events with the wave number
  or spawned task ids (additive journal field — old journals must still
  reduce). Flagged during the v0.6.0 review; safe to ship without.
- `missionLedger()` (executor.ts) and `taskTable()` (prompts.ts) both render
  "wave N: X done (ids)" lines but implement DIFFERENT summarization policies
  (full history vs. recent-waves view). A reviewer will flag this as
  duplication — it isn't; don't merge them.

## Context for any follow-up agent

- The "do NOT fix" list from the v0.6.0 program still applies: budget wrap-up
  (agentStop), wait-stall guard, checkpoint injection on retry, team depth
  cap, journal-degraded abort, SSE heartbeat, thinking-mode cross-provider
  400 guard (deepseek.ts), in-place splices in addNote/finalizeTask (teams
  share the notes array by reference), parallel state.ts/ui-reducer pair.
- Claim notes are namespaced by `(teamId, taskId)` as of `d9243c7` — keep the
  teamId predicate if you touch checkClaim/finalizeTask.
- `swarm config unset <key>` now DELETES the key (defaults re-apply);
  `apiKey`/`baseUrl` are the exceptions (cleared to `""`, re-derived from
  provider creds). loadConfig also defends against empty `model`.
- Journal readers dedupe by seq (flushSync can race an in-flight drain and
  duplicate a chunk — that's by design, the dedupe is load-bearing).
