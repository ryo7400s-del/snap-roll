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

const SCHEDULER_ABI = [
  "function executeSchedule(uint256 scheduleId) external",
  "function scheduleCount() view returns (uint256)",
  "function getSchedule(uint256 scheduleId) view returns (tuple(address recipient, uint256 amount, uint64 executeAfter, bool active, bytes32 requestId))",
];

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
      return Number(i);
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

  for (const row of dueSchedules) {
    const requestId = "0x" + row.id.replace(/-/g, "").padStart(64, "0");

    console.log(`\nProcessing schedule ${row.id} (contract: ${row.scheduler_address})`);

    try {
      const scheduleId = await findScheduleIdByRequestId(row.scheduler_address, requestId);

      if (scheduleId === null) {
        console.log(`  Could not find on-chain scheduleId for requestId ${requestId}, skipping`);
        continue;
      }

      const contract = new ethers.Contract(row.scheduler_address, SCHEDULER_ABI, wallet);
      const tx = await contract.executeSchedule(scheduleId);
      console.log(`  Executing... tx: ${tx.hash}`);
      await tx.wait();
      console.log(`  Success: ${tx.hash}`);

      const updates = { status: "executed", tx_hash: tx.hash };
      const { error: updateError } = await supabase
        .from("pending_schedules")
        .update(updates)
        .eq("id", row.id);

      if (updateError) {
        console.error(`  Failed to update status: ${updateError.message}`);
      }

      if (row.interval_seconds) {
        const nextExecuteAfter = row.execute_after + row.interval_seconds;
        const { error: insertError } = await supabase.from("pending_schedules").insert({
          scheduler_address: row.scheduler_address,
          recipient: row.recipient,
          amount: row.amount,
          execute_after: nextExecuteAfter,
          status: "approved",
          interval_seconds: row.interval_seconds,
          currency: row.currency,
          label: row.label,
        });

        if (insertError) {
          console.error(`  Failed to create next occurrence: ${insertError.message}`);
        } else {
          console.log(`  Next occurrence scheduled for ${new Date(nextExecuteAfter * 1000).toISOString()}`);
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
