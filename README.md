# SnapRoll

**SnapRoll** is a cross-border payroll app built on Circle User-Controlled Wallets, deployed on the **Arc testnet**. It lets a company schedule USDC/EURC payroll payments, have them approved by a responsible party via Telegram, and track everything on an on-chain-verified dashboard.

Repo: https://github.com/ryo7400s-del/snap-roll

---

## Feature Overview

| Feature | Description |
|---|---|
| **Circle Wallets (User-Controlled)** | Login via Google OAuth; each user gets a Circle-managed wallet on Arc testnet. |
| **Payroll Scheduler Contract** | Per-owner `PaymentSchedulerV2` contract, deployed once per wallet (factory pattern with deterministic address). |
| **Whitelist Management** | Manual entry or CSV bulk upload of approved recipient addresses, with optional labels. |
| **Payroll Scheduling** | Manual entry or CSV bulk upload of payroll schedules (one-time or recurring: weekly/monthly). Currently USDC only — EURC is not yet supported despite appearing as a CSV/UI option. |
| **Batch Approval** | Approvers can select multiple pending schedules and approve them in a single transaction (one USDC allowance check + one batched on-chain call), up to 50 recipients per batch. |
| **Telegram Approval Flow** | Registered approvers receive a Telegram notification with an inline "Approve/Reject" button and a deep link into the Approve page. |
| **Passkey Lock (WebAuthn)** | Optional biometric/PIN confirmation required immediately before approving a transaction. |
| **Whitelist Enforcement on Approval** | The Approve page blocks approval of any schedule whose recipient is not on the whitelist, both in the UI and as a server-side guard. |
| **Dashboard & History** | Calendar-style view of pending/approved/executed/rejected schedules, plus CSV export of executed payments with on-chain verification status. |

---

## How to Use

### 1. Setup
1. Deploy (or reuse) your `PaymentSchedulerV2` contract from the **Setting** page (`+ Deploy New Payroll Contract`). On a brand-new deployment, this triggers two PIN confirmations: one to deploy the contract, and a second to register it in `SchedulerRegistry` (an on-chain wallet ↔ scheduler lookup). Reusing an already-deployed contract only requires the usual sign-in — no extra step.
2. Register recipient addresses to the **Whitelist** (Manual or CSV upload, with optional labels).
3. Tap **Connect Telegram** and open the generated link to link your Telegram account as an approver.
4. (Optional) Toggle **Passkey Lock** on to require biometric/PIN confirmation before every approval.

### 2. Create a Payroll Schedule
1. Go to the **Schedule** page.
2. Add entries manually, or upload a CSV (`label, address, amount, currency, interval, date`).
3. Submit — this notifies all registered approvers via Telegram.

### 3. Approve via Telegram
1. Approvers receive a Telegram message with an inline **Approve/Reject** button.
2. Tapping it opens the **Approve** page (`/approve?scheduler=0x...`) with the scheduler contract pre-filled.
3. If the recipient is not whitelisted, the Approve button is disabled and a warning is shown.
4. If Passkey Lock is enabled, biometric/PIN confirmation is required before the transaction is signed and sent.

### 4. Track & Export
1. The **Dashboard** page shows a calendar of all schedules by status (pending / approved / executed / rejected).
2. Executed payments can be exported as a CSV, which includes an on-chain verification column (see below).

---

## Architecture

```
┌─────────────┐        Google OAuth        ┌──────────────────────┐
│   Browser    │ ─────────────────────────▶ │ Circle User-Controlled│
│ (Next.js UI) │ ◀───────────────────────── │      Wallets API      │
└──────┬───────┘      userToken/wallet       └──────────┬───────────┘
       │                                                │ contractExecution
       │  fetch (Next.js API routes)                    ▼
       ▼                                     ┌──────────────────────────────┐
┌─────────────┐                              │       Arc Testnet (EVM)       │
│  /api/circle │ ── ethers.js (read) ───────▶│  PayrollFactory (create2)      │
│  /api/schedule│                            │        │ deploys              │
│  /api/approver│                            │        ▼                      │
│  /api/passkey│                             │  PaymentSchedulerV2            │
│  /api/telegram/webhook│                    │  (one per company/owner)       │
└──────┬───────┘                             │  - whitelist                   │
       │                                     │  - schedules                   │
       ▼                                     │  - executeSchedule() [public]  │
┌─────────────┐        notify        ┌──────┴──────────────────┐
│  Supabase    │ ────────────────────▶│  Telegram Bot API │
│ (Postgres)   │ ◀──── webhook ───────│ (approval buttons)│
└─────────────┘                       └──────────────────┘
       ▲
       │ executeSchedule(id) — every 6h
┌─────────────────────┐
│ GitHub Actions        │
│ (disposable executor  │
│  wallet, see below)   │
└─────────────────────┘
```

**Frontend**: Next.js (App Router) + React, pages under `app/` (`setting`, `schedule`, `approve`, `dashboard`, `submit`).

**Wallet & signing**: `@circle-fin/w3s-pw-web-sdk` — handles Google login, wallet creation, and PIN-based challenge execution (`sdk.execute`) for every on-chain transaction (deploy, whitelist, approve).

**Chain interaction**:
- **Writes** (deploy contract, whitelist batch, approve schedule) go through Circle's `contractExecution` API, authenticated with the user's `userToken` and executed after PIN/passkey confirmation.
- **Reads** (whitelist state, USDC allowance, contract version) go directly through `ethers.js` against the Arc testnet RPC (`https://arc-testnet.drpc.org`).

**Database (Supabase/Postgres)**: source of truth for off-chain state that doesn't belong on-chain — pending schedule requests, approver registrations, Telegram chat links, whitelist label metadata, an event-scan cache for the whitelist, and WebAuthn credentials/challenges.

**Notifications**: a Telegram bot (`/api/telegram/webhook`) sends approval requests with inline buttons and receives button-press callbacks, which map back to a `scheduler_address` → registered approvers via Supabase.

---

## Smart Contracts

| Contract | Role |
|---|---|
| `PayrollFactory` | Deploys a `PaymentSchedulerV2` per company via `CREATE2`, called as a contract-execution (not a raw deployment tx) so it works with Circle's `contractExecution` API. `computeAddress()` predicts the deterministic address before deploying, so the app can detect an already-deployed contract and skip redeploying. Each `msg.sender` (owner wallet) can deploy at most once (`hasDeployed`). |
| `PaymentSchedulerV2` | The core payroll contract, one per company/owner. Holds the whitelist, the schedule list, and the execution logic. |
| `SchedulerRegistry` | An on-chain reverse-lookup registry (wallet ↔ scheduler address), guarded so only the verified `owner()` of a scheduler can register it. Deployed on Arc testnet at `0x2E533d62cd6fC613D7a7c309Cd84D3072e733325` and wired into the deploy flow: on a brand-new contract deployment, the app automatically calls `register()` right after the owner claims their new scheduler (a second PIN confirmation). Existing/previously-deployed contracts are unaffected — registration only fires once, at first deploy. |
| `ISchedulerOwnable` | Minimal interface (`owner()`, `ownerClaimed()`) that `SchedulerRegistry` uses to verify ownership without depending on the full `PaymentSchedulerV2` ABI. |

**`PaymentSchedulerV2` highlights:**

- **Ownership**: deployed with a backend-controlled initial owner; the real owner calls `claimOwner()` once to take over (`onlyOwner` gates whitelist, schedule creation, and toggling from then on).
- **Whitelist-gated scheduling**: `createScheduleFor` / `createSchedulesForBatch` revert with `RecipientNotWhitelisted` if the recipient isn't whitelisted — enforced on-chain, not just in the UI.
- **Batch limits**: whitelist additions, schedule creation, schedule approval, and schedule toggling are all capped at `MAX_BATCH_SIZE = 50` per call (`BatchTooLarge` revert above that) — this is also the practical limit for how many recipients can be batch-approved in a single transaction from the Approve page.
- **Idempotent requests**: schedules created via the `...For`/`...ForBatch` variants carry a `requestId` (derived from the app's UUID) to avoid duplicate on-chain schedules for the same off-chain request.
- **Execution is public by design**: `executeSchedule(scheduleId)` has no `onlyOwner` modifier — anyone can call it (this is what lets the GitHub Actions bot trigger it). It's still safe because the USDC transfer is always `transferFrom(owner, recipient, amount)` — the caller can never redirect funds, only trigger a transfer that was already authorized by the owner's on-chain schedule and their prior `approve()` to the contract. It also re-checks `isWhitelisted[recipient]` at execution time, so revoking a whitelist entry after scheduling still blocks the payout.
- **Currency**: `USDC` is a hardcoded constant address; there is no EURC path in the contract despite it appearing as a UI/CSV option.

---

## On-Chain History Verification

Execution history isn't just read from the database — every "executed" row is **re-verified against the chain at export time** (`/api/schedule` → `exportCsv`, called from the Dashboard). For each executed schedule with a recorded `tx_hash`:

1. Fetch the transaction receipt from the Arc testnet RPC via `ethers.js`.
2. Check the result against several conditions, and label the row accordingly:

| Label | Meaning |
|---|---|
| `verified` | Receipt found, status succeeded, sent to the correct scheduler contract, and the `ScheduleExecuted` event is present in the logs. |
| `no_event` | Transaction succeeded but the expected `ScheduleExecuted` event topic wasn't found. |
| `wrong_contract` | Transaction receipt's `to` address doesn't match the recorded scheduler contract. |
| `failed` | Transaction was mined but reverted (`status !== 1`). |
| `not_found` | No receipt could be found for the recorded hash. |
| `no_tx_hash` | No transaction hash was ever recorded for this row. |
| `verify_error` | An error occurred while querying the chain. |

The exported CSV includes this as an `onchain_verified` column alongside `label, recipient, amount, currency, execute_after, status, tx_hash`, so the history can't silently drift from what actually happened on-chain — every claimed payment is independently checked against Arc testnet at the moment of export, rather than trusted from the database alone.

---

## Tech Stack

- **Framework**: Next.js 16 (App Router) + React 19
- **Chain**: Arc testnet (EVM-compatible), via `ethers.js` v6
- **Wallets**: Circle User-Controlled Wallets (`@circle-fin/w3s-pw-web-sdk`)
- **Auth**: Google OAuth (via Circle SDK) for wallet login; WebAuthn (`@simplewebauthn/server`, `@simplewebauthn/browser`) for optional passkey confirmation before approvals
- **Database**: Supabase (Postgres)
- **Notifications**: Telegram Bot API
- **CSV parsing**: PapaParse

---

## External Services & Environment Variables

### Circle (User-Controlled Wallets)
```
NEXT_PUBLIC_CIRCLE_APP_ID=
NEXT_PUBLIC_GOOGLE_CLIENT_ID=
CIRCLE_API_KEY=
```
Used for Google-login-based wallet creation and all on-chain writes (deploy, whitelist, schedule, approve) via Circle's `contractExecution` API.

### Supabase
```
SUPABASE_URL=
SUPABASE_SECRET_KEY=
```
Service-role key used server-side only, in all `/api/*` routes. Tables used:

| Table | Purpose |
|---|---|
| `pending_schedules` | Payroll schedule requests and their status/history |
| `approvers` | Wallet ↔ scheduler ↔ Telegram chat_id linkage |
| `whitelist_cache` | Cached on-chain whitelist state (event-scanned, to avoid re-scanning from genesis) |
| `whitelist_labels` | Optional human-readable labels for whitelisted addresses (off-chain only) |
| `passkey_credentials` | Registered WebAuthn credentials per wallet |
| `passkey_challenges` | Short-lived (5 min TTL) WebAuthn registration/authentication challenges |
| `passkey_settings` | Per-wallet Passkey Lock enabled/disabled flag |
| `app_config` | Misc app-level config (e.g. current factory contract address) |

### WebAuthn (Passkey Lock)
```
NEXT_PUBLIC_RP_ID=
NEXT_PUBLIC_ORIGIN=
```
`RP_ID`/`ORIGIN` must exactly match the domain serving the app (e.g. `localhost` / `http://localhost:3000` in dev, or the production domain over HTTPS) — WebAuthn registration and authentication will fail otherwise. Passkeys registered under one RP ID cannot be used under another.

### Telegram
Bot token and webhook configuration are used by `/api/telegram/webhook` and `/api/approver` to send approval notifications and handle inline button callbacks. The bot is referenced in-app as `@arc_payroll_approval_bot`.

### Auto-Execution Bot (GitHub Actions)
```
EXECUTOR_PRIVATE_KEY=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
```
A GitHub Actions workflow (`.github/workflows/auto-execute.yml`) runs `scripts/auto-execute.mjs` on a schedule (every 6 hours, plus manual dispatch) to execute payroll schedules once their `execute_after` time has passed.

This runs from a **disposable, single-purpose wallet** (`EXECUTOR_PRIVATE_KEY`) that exists solely to keep already-approved schedules moving on-chain. Its capabilities are intentionally minimal — it only ever calls `executeSchedule(scheduleId)` on schedules that are already `approved` in Supabase and whose execution time has arrived. It has:

- **No ability to create schedules** — it never calls `createScheduleFor`/`createSchedulesBatch`.
- **No ability to approve schedules** — it never signs an approval; that requires the owner's Circle wallet and PIN/passkey.
- **No ability to modify the whitelist** — it never calls `addToWhitelistBatch`.
- **No ability to change recipients or amounts** — those are fixed on-chain at approval time; the bot cannot alter what it executes, only trigger execution of what's already there.

In short, this key can only push forward transactions a human approver has already signed off on — it cannot touch any customer configuration (whitelist, contract ownership, recipients, or amounts). This isn't just an operational convention: `executeSchedule` is a public, unpermissioned function on the contract, and the USDC transfer inside it is hardcoded as `transferFrom(owner, recipient, amount)` — the executor's address never appears as a fund source or destination, so even a compromised executor key can only trigger already-authorized transfers, never redirect them.

### Chain
```
Arc testnet RPC: https://arc-testnet.drpc.org
Factory contract: 0x48c2A4571C8a7A2074AD153C08488734f3A3411E
```
