# Firebase Removal Migration Plan

**Goal:** AppBeg runs 100% on VPS PostgreSQL. No Firestore in browser runtime. No Firestore reads/writes when SQL authority flags are on.

**Status:** Phase 2 client hard-block in place. Phases 3–7 in progress.

---

## Phase 1 — Audit inventory

Run:

```bash
npm run audit:firebase-inventory
npm run audit:client-firestore
npm run audit:firestore
npm run audit:sql-full-runtime
```

Logs:

- `[FIREBASE_USAGE_AUDIT]` — every server Firestore touch via `logFirestoreTouch`
- `[FIREBASE_INVENTORY_AUDIT]` — static repo scan summary
- `[SQL_RUNTIME_READY]` — startup + `audit:sql-full-runtime`

### Classification legend

| Layer | Meaning |
|-------|---------|
| `client-runtime` | Browser bundle (`app/`, `components/`, `features/`) |
| `server-runtime` | API routes + `lib/server/` |
| `admin-sdk` | `lib/firebase/admin.ts` |
| `auth-bootstrap` | Login page (temporary Firebase Auth) |
| `cold` | Scripts, backfill, one-off migrations |

### Client runtime — remove Phase 3

| File | Feature | Firebase usage | SQL replacement | Action |
|------|---------|----------------|-----------------|--------|
| `app/player/page.tsx` | Player dashboard | `onSnapshot` users/requests (guarded) | `playerProfileSqlPoll`, `playerRequestSqlRead` SSE | Remove Firestore imports |
| `app/player/chat/page.tsx` | Player chat | `playerChat` listeners (guarded) | **Gap:** no `playerConversations` SQL API yet | Disable or add SQL API |
| `features/messages/playerChat.ts` | Direct player chat | `onSnapshot`, `setDoc` | `conversations_cache` + `chat_messages_cache` (staff path exists) | Migrate Phase 3 |
| `features/messages/chatMessages.ts` | Staff/coadmin chat | `onSnapshot` (guarded) | `/api/chat/*` + `chatSqlRead` poll | Remove Firestore |
| `features/bonusEvents/bonusEvents.ts` | Bonus events | `onSnapshot` (guarded) | `/api/bonus-events/list` poll | Remove Firestore |
| `features/games/playerGameRequests.ts` | Game requests | `onSnapshot` (guarded) | SSE + `player_game_requests_cache` | Remove Firestore |
| `features/presence/userPresence.ts` | Presence | `onSnapshot` (guarded) | `/api/presence/batch` + heartbeat | Remove Firestore |
| `features/games/playerCashoutTasks.ts` | Cashouts | `onSnapshot` (guarded) | `playerCashoutSqlRead` | Remove Firestore |
| `features/games/playerGameLogins.ts` | Game logins | `onSnapshot` (guarded) | `playerGameLoginsSqlRead` | Remove Firestore |
| `features/games/carerTasks.ts` | Carer tasks | `onSnapshot` (guarded) | `carerTaskSqlRead` SSE | Remove Firestore |
| `components/auth/ProtectedRoute.tsx` | Route guard | `onAuthStateChanged`, `getDoc(users)` | `session/me` + SQL player gate | Remove Firebase auth dependency |
| `components/presence/UserPresenceSync.tsx` | Heartbeat | Firebase uid fallback | `/api/presence/heartbeat` + `session/me` | Done (SQL path) |
| `app/login/page.tsx` | Login | `signInWithEmailAndPassword` | `/api/auth/login-sql` + `user_credentials` | Phase 5 |

### Server runtime — migrate Phase 4

Every `adminDb` / `adminAuth` call in `app/api/**` must either:

1. Use `lib/sql/authority*.ts` transaction when `AUTHORITY_SQL_WRITE=1`, or
2. Log `[FIRESTORE_TOUCH]` with `skipped: true` and never call Firestore.

Priority routes (authority writes still on Firestore):

- User CRUD / password reset
- Player archive/restore
- Referral codes
- Carer creation requests
- Chat message writes
- Maintenance flags
- Presence writes
- Conversation metadata

Run `FAIL_ON_UNGATED=1 npm run audit:firestore` to list ungated routes.

### Cold / admin — keep temporarily

- `scripts/backfill-*.cjs` — one-off Firestore → SQL import
- `lib/firebase/admin.ts` — server SDK init (gated)
- `lib/server/*FirestoreMirror.ts` — disable when `shouldBlockFirestoreFallback()`

---

## Phase 2 — Client hard block ✅

- `lib/client/clientFirestoreGuard.ts` — `assertClientFirestoreDisabled()`
- `lib/firebase/client.ts` — lazy Firestore; proxy throws in SQL mode
- `npm run audit:client-firestore` — fails unguarded client imports

**Expected browser Network:** 0 requests to `firestore.googleapis.com`, 0 `Listen/channel`.

---

## Phase 3 — Replace client features with SQL

| Feature | SQL source | Client module | Status |
|---------|------------|---------------|--------|
| Player profile | `players_cache` poll | `playerProfileSqlPoll` | ✅ |
| Game requests | SSE + cache | `playerRequestSqlRead` | ✅ |
| Bonus events | cache poll | `bonusEvents` SQL branch | ✅ |
| Cashouts | cache poll | `playerCashoutSqlRead` | ✅ |
| Game logins | cache poll | `playerGameLoginsSqlRead` | ✅ |
| Presence | `/api/presence/*` | `userPresence` SQL branch | ✅ |
| Staff chat | `/api/chat/*` | `chatSqlRead` | ✅ |
| Carer tasks | SSE + cache | `carerTaskSqlRead` | ✅ |
| **Player direct chat** | — | `playerChat` | ❌ needs API |
| Session readiness | `app_sessions` | `session/me` | ✅ |
| Coadmin dashboard | various cache polls | per-feature SQL reads | partial |

---

## Phase 4 — Server Firestore authority removal

- All writes → SQL transaction via `authority_operations` ledger
- No Firestore fallback when `shouldBlockFirestoreFallback()` is true
- Mirror modules (`*FirestoreMirror.ts`) must early-return in SQL mode

---

## Phase 5 — Firebase Auth removal

**Preferred:** full SQL login

1. `POST /api/auth/login-sql` — verify `user_credentials.password_hash`
2. Issue `app_sessions` row + set `appbeg:appSessionId` cookie/header
3. Player pages use `session/me` only — no `onAuthStateChanged`
4. Remove `firebase/auth` from client bundle

**Temporary:** Firebase Auth password verify only at login; runtime never waits on `currentUser`.

---

## Phase 6 — Required SQL schema

`npm run audit:sql-full-runtime` checks:

**Core runtime tables:** `app_sessions`, `user_credentials`, `player_sessions_cache`, `live_outbox`

**Cache tables:** `players_cache`, `bonus_events_cache`, `conversations_cache`, `chat_messages_cache`, `user_presence_cache`, `player_game_requests_cache`, `player_game_logins_cache`, `player_cashout_tasks_cache`, `carer_tasks_cache`, …

**Authority:** `authority_operations`, `user_balance_events`

**Permissions:** current DB user must have SELECT/INSERT/UPDATE/DELETE on all required tables.

Set `FAIL_ON_MISSING=1` in CI/production checks.

---

## Phase 7 — Hard fail in production SQL mode

When `AUTHORITY_SQL_WRITE=1` (production default):

- Client: `getClientFirestore()` throws → `[CLIENT_FIRESTORE_BLOCKED]`
- Server: `logFirebaseUsageAudit` → `[FIREBASE_USAGE_BLOCKED]`; migrate to `assertFirebaseUsageBlockedInSqlMode` on hot paths
- Startup: `assertAuthoritySqlSchema` throws if tables missing
- No silent Firestore fallback

---

## Verification checklist

```bash
npx tsc --noEmit
git diff --check
npm run audit:client-firestore
npm run audit:firestore
npm run audit:sql-full-runtime
# optional: FAIL_ON_MISSING=1 DATABASE_URL=... npm run audit:sql-full-runtime
```

Manual:

1. Browser Network filter `firestore.googleapis.com` = **0**
2. Player / coadmin / carer pages load from SQL
3. Chat does not force logout
4. Bonus, play tables, cashout, requests load from SQL

**Do not debug individual UI bugs until this checklist passes.**
