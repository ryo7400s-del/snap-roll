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

async function main() {
  const now = Math.floor(Date.now() / 1000);

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
