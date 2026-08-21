import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PRIVATE_KEY = process.env.EXECUTOR_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "https://arc-testnet.drpc.org";

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !PRIVATE_KEY) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Matches the current on-chain Schedule struct (PaymentSchedulerV2.sol):
//   address recipient;
//   uint256 amount;
//   uint64  executeAfter;
//   uint64  intervalSeconds;
//   bool    active;
//   bool    useEURC;
//   uint16  slippageBps;
//   bytes32 requestId;
const SCHEDULER_ABI = [
  "function executeSchedule(uint256 scheduleId) external",
  "function scheduleCount() view returns (uint256)",
  "function getSchedule(uint256 scheduleId) view returns (tuple(address recipient, uint256 amount, uint64 executeAfter, uint64 intervalSeconds, bool active, bool useEURC, uint16 slippageBps, bytes32 requestId))",
];

const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// ScheduleExecuted only logs the pre-swap USDC amount (see
// PaymentSchedulerV2.executeSchedule), so for EURC schedules the actual
// post-swap amount the recipient received has to be recovered from the
// EURC token's own Transfer event in the same receipt. Returns the raw
// (6-decimal) EURC amount as a string, or null if not found/applicable.
function findActualEurcReceived(receipt, recipient) {
  const recipientTopic = ethers.zeroPadValue(ethers.getAddress(recipient.toLowerCase()), 32);
  const transferLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === EURC_ADDRESS.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[2]?.toLowerCase() === recipientTopic.toLowerCase()
  );
  if (!transferLog) return null;
  return BigInt(transferLog.data).toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findScheduleIdByRequestId(schedulerAddress, requestIdHex) {
  const contract = new ethers.Contract(schedulerAddress, SCHEDULER_ABI, provider);
  const count = await contract.scheduleCount();
  await sleep(500);

  for (let i = 0n; i < count; i++) {
    const s = await contract.getSchedule(i);
    await sleep(500);
    if (s.requestId.toLowerCase() === requestIdHex.toLowerCase()) {
      return { scheduleId: Number(i), schedule: s };
    }
  }
  return null;
}

// EscrowVault ABI subset needed here.
const ESCROW_VAULT_ABI = [
  "function createEscrow(bytes32 recipientEmailHash, uint256 amount, bool useEURC, uint16 slippageBps, uint64 expiresAt) external returns (uint256 escrowId)",
  "event EscrowCreated(uint256 indexed escrowId, address indexed sender, bytes32 recipientEmailHash, uint256 amount, bool useEURC, uint64 expiresAt)",
];
const escrowVaultInterface = new ethers.Interface(ESCROW_VAULT_ABI);

// createEscrow's return value isn't directly readable from a sent
// transaction (only from a static call or by decoding logs), and the
// claim flow needs to know exactly which escrowId was assigned on-chain
// to build the signature message later. Decode it from the EscrowCreated
// event in the receipt instead of re-deriving/guessing it.
function findEscrowIdFromReceipt(receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = escrowVaultInterface.parseLog(log);
      if (parsed?.name === "EscrowCreated") {
        return Number(parsed.args.escrowId);
      }
    } catch {
      // Not a log this ABI recognizes (e.g. a Transfer event from the
      // USDC transferFrom pull) -- skip it.
    }
  }
  return null;
}

// How long an escrow stays claimable before anyone can trigger a refund
// back to the company. 30 days gives a reasonable window for the
// recipient to register on SnapRoll and claim without funds sitting
// locked indefinitely if they never do.
const ESCROW_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

// Processes email_scheduled_payments: schedules created against a
// recipient email rather than a wallet address, because the recipient
// hadn't registered on SnapRoll yet at schedule-creation time. This
// re-checks registration status now, at the scheduled execution time,
// rather than trusting whatever was true when the schedule was created --
// the recipient may have joined SnapRoll any time in between.
async function processEmailScheduledPayments(now) {
  const { data: dueEmailSchedules, error } = await supabase
    .from("email_scheduled_payments")
    .select("*")
    .eq("status", "approved")
    .lte("execute_after", now);

  if (error) {
    console.error("Failed to fetch due email-scheduled payments:", error.message);
    return;
  }

  console.log(`Found ${dueEmailSchedules.length} email-scheduled payment(s) due`);

  for (const row of dueEmailSchedules) {
    console.log(`\nProcessing email-scheduled payment ${row.id} (recipient: ${row.recipient_email})`);

    try {
      const { data: userRow } = await supabase
        .from("user_emails")
        .select("wallet_address")
        .eq("email", row.recipient_email.toLowerCase())
        .maybeSingle();

      if (userRow) {
        // Now registered: hand off to the normal scheduled-payment flow.
        // Inserted as an already-approved pending_schedules row so the
        // main loop below picks it up and executes it in this same run
        // (it queries pending_schedules after this function is called).
        const { error: insertError } = await supabase.from("pending_schedules").insert({
          scheduler_address: row.scheduler_address,
          recipient: userRow.wallet_address,
          amount: row.amount,
          execute_after: row.execute_after,
          status: "approved",
          currency: row.currency,
          slippage_bps: row.slippage_bps,
          label: row.label,
        });

        if (insertError) {
          console.error(`  Failed to migrate to pending_schedules: ${insertError.message}`);
          continue;
        }

        await supabase.from("email_scheduled_payments").update({ status: "migrated" }).eq("id", row.id);
        console.log(`  Recipient now registered (${userRow.wallet_address}); migrated to pending_schedules for normal execution`);
      } else {
        // Still not registered: lock funds in escrow instead.
        const recipientEmailHash = ethers.keccak256(ethers.toUtf8Bytes(row.recipient_email.toLowerCase()));
        const expiresAt = Math.floor(Date.now() / 1000) + ESCROW_EXPIRY_SECONDS;

        const vault = new ethers.Contract(row.escrow_vault_address, ESCROW_VAULT_ABI, wallet);
        const tx = await vault.createEscrow(
          recipientEmailHash,
          row.amount,
          row.currency === "EURC",
          row.slippage_bps ?? 0,
          expiresAt
        );
        console.log(`  Creating escrow... tx: ${tx.hash}`);
        const escrowReceipt = await tx.wait();
        const escrowId = findEscrowIdFromReceipt(escrowReceipt);
        console.log(`  Escrow created: ${tx.hash} (escrowId: ${escrowId})`);

        if (escrowId === null) {
          console.error(`  Could not find EscrowCreated event in receipt -- escrow_id will be unset, claiming will not work until this is fixed manually`);
        }

        const { error: updateError } = await supabase
          .from("email_scheduled_payments")
          .update({ status: "escrowed", tx_hash: tx.hash, escrow_id: escrowId })
          .eq("id", row.id);

        if (updateError) {
          console.error(`  Failed to update status to escrowed: ${updateError.message}`);
        }
      }
    } catch (err) {
      console.error(`  Error processing email-scheduled payment ${row.id}:`, err.message);
    }

    await sleep(1000);
  }
}

// EscrowVault ABI subset needed for refund processing.
const ESCROW_VAULT_REFUND_ABI = [
  "function refundExpiredEscrow(uint256 escrowId) external",
  "function getEscrow(uint256 escrowId) view returns (tuple(address sender, bytes32 recipientEmailHash, uint256 amount, bool useEURC, uint16 slippageBps, uint64 createdAt, uint64 expiresAt, bool claimed, bool refunded))",
];

// Refunds escrows whose expiresAt has passed and were never claimed.
// Runs after processEmailScheduledPayments/the main schedule loop so any
// escrow just created this same run isn't immediately eligible (it won't
// be, since expiresAt is always set in the future at creation time, but
// this ordering also means status=escrowed rows created earlier in DB
// history get picked up here consistently).
async function processExpiredEscrowRefunds(now) {
  const { data: escrowedRows, error } = await supabase
    .from("email_scheduled_payments")
    .select("*")
    .eq("status", "escrowed")
    .not("escrow_id", "is", null);

  if (error) {
    console.error("Failed to fetch escrowed payments:", error.message);
    return;
  }

  console.log(`Checking ${escrowedRows.length} escrowed payment(s) for expiry`);

  for (const row of escrowedRows) {
    try {
      const vault = new ethers.Contract(row.escrow_vault_address, ESCROW_VAULT_REFUND_ABI, provider);
      const escrow = await vault.getEscrow(row.escrow_id);

      if (escrow.claimed || escrow.refunded) {
        // Already claimed by the recipient, or already refunded in a
        // previous run -- just sync the DB status if it's stale.
        if (escrow.claimed && row.status !== "claimed") {
          await supabase.from("email_scheduled_payments").update({ status: "claimed" }).eq("id", row.id);
        } else if (escrow.refunded && row.status !== "refunded") {
          await supabase.from("email_scheduled_payments").update({ status: "refunded" }).eq("id", row.id);
        }
        continue;
      }

      if (Number(escrow.expiresAt) > now) {
        // Not expired yet.
        continue;
      }

      console.log(`\nEscrow ${row.escrow_id} on ${row.escrow_vault_address} has expired, refunding...`);
      const walletWithSigner = new ethers.Contract(row.escrow_vault_address, ESCROW_VAULT_REFUND_ABI, wallet);
      const tx = await walletWithSigner.refundExpiredEscrow(row.escrow_id);
      console.log(`  Refunding... tx: ${tx.hash}`);
      await tx.wait();
      console.log(`  Refunded: ${tx.hash}`);

      const { error: updateError } = await supabase
        .from("email_scheduled_payments")
        .update({ status: "refunded", tx_hash: tx.hash })
        .eq("id", row.id);

      if (updateError) {
        console.error(`  Failed to update status to refunded: ${updateError.message}`);
      }
    } catch (err) {
      console.error(`  Error processing refund for row ${row.id}:`, err.message);
    }

    await sleep(1000);
  }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);

  await processEmailScheduledPayments(now);
  await processExpiredEscrowRefunds(now);

  const { data: dueSchedules, error } = await supabase
    .from("pending_schedules")
    .select("*")
    .eq("status", "approved")
    .lte("execute_after", now);

  if (error) {
    console.error("Failed to fetch due schedules:", error.message);
    process.exit(1);
  }

  console.log(`Found ${dueSchedules.length} schedule(s) due for execution`);

  // Known contracts from old Factory versions that don't have a compatible
  // executeSchedule/getSchedule ABI. Append here if an old deployment is
  // still referenced by leftover DB rows.
  const KNOWN_INVALID_CONTRACTS = new Set([
    "0x2478db80727ef7ad46337bd53c17c7b6fca16a4b",
  ]);

  for (const row of dueSchedules) {
    const requestId = "0x" + row.id.replace(/-/g, "").padStart(64, "0");

    console.log(`\nProcessing schedule ${row.id} (contract: ${row.scheduler_address})`);

    if (KNOWN_INVALID_CONTRACTS.has(row.scheduler_address.toLowerCase())) {
      console.log(`  Skipping: contract ${row.scheduler_address} is a known outdated contract (no executeSchedule)`);
      continue;
    }

    try {
      const found = await findScheduleIdByRequestId(row.scheduler_address, requestId);

      if (found === null) {
        console.log(`  Could not find on-chain scheduleId for requestId ${requestId}, skipping`);
        continue;
      }

      const { scheduleId } = found;

      const contract = new ethers.Contract(row.scheduler_address, SCHEDULER_ABI, wallet);
      const tx = await contract.executeSchedule(scheduleId);
      console.log(`  Executing... tx: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Success: ${tx.hash}`);

      // For EURC schedules, record the actual post-swap amount the
      // recipient received (from the EURC token's Transfer event) instead
      // of the pre-swap USDC amount in row.amount -- otherwise the
      // dashboard/history would show e.g. "0.30 EURC" when only 0.30 USDC
      // worth was swapped and the recipient actually got something else.
      const executionAmount =
        row.currency === "EURC" ? findActualEurcReceived(receipt, row.recipient) ?? row.amount : row.amount;

      // Record this execution permanently, independent of pending_schedules'
      // current execute_after/status. pending_schedules only tracks the
      // *next* upcoming cycle for a recurring schedule, so without a
      // separate log, past execution dates become unrecoverable once
      // execute_after is advanced. row.execute_after here is still the
      // pre-update value: the date this cycle was actually due/executed for.
      const { error: logError } = await supabase.from("schedule_executions").insert({
        schedule_id: row.id,
        scheduler_address: row.scheduler_address,
        recipient: row.recipient,
        amount: executionAmount,
        execute_after: row.execute_after,
        tx_hash: tx.hash,
        currency: row.currency,
      });
      if (logError) {
        console.error(`  Failed to log execution history: ${logError.message}`);
      }

      // Re-read the schedule after execution to get the contract's own
      // updated executeAfter/active state, rather than recomputing it
      // ourselves or duplicating the row in the DB. The contract is the
      // single source of truth for recurring schedules: it advances
      // executeAfter internally and keeps the same scheduleId/requestId
      // active for reuse on the next cycle.
      const after = await contract.getSchedule(scheduleId);

      if (after.active) {
        // Recurring schedule: stays "approved" so the next due-date check
        // picks it back up automatically under the same DB row. We only
        // sync execute_after here - if we don't, this row would look
        // "due" again immediately and every subsequent run would just
        // hit TooEarly on-chain until the real time catches up.
        const nextExecuteAfter = Number(after.executeAfter);
        const { error: updateError } = await supabase
          .from("pending_schedules")
          .update({
            execute_after: nextExecuteAfter,
            tx_hash: tx.hash,
          })
          .eq("id", row.id);

        if (updateError) {
          console.error(`  Failed to sync next execute_after: ${updateError.message}`);
        } else {
          console.log(`  Recurring schedule advanced on-chain; next run at ${new Date(nextExecuteAfter * 1000).toISOString()}`);
        }
      } else {
        // One-time schedule: mark as executed, nothing further to do.
        const { error: updateError } = await supabase
          .from("pending_schedules")
          .update({ status: "executed", tx_hash: tx.hash })
          .eq("id", row.id);

        if (updateError) {
          console.error(`  Failed to update status: ${updateError.message}`);
        }
      }
    } catch (err) {
      console.error(`  Error executing schedule ${row.id}:`, err.message);
    }

    await sleep(1000);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
