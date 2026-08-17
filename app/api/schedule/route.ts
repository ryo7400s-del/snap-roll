import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SECRET_KEY as string
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_BASE_URL as string;

// USDC(6桁精度)の最小単位を人間が読める小数表記に変換する。
// 例: "100000" -> "0.1"
function fromUsdcUnits(units: string | number): string {
  const str = units.toString();
  const padded = str.padStart(7, "0");
  const intPart = padded.slice(0, -6).replace(/^0+(?=\d)/, "") || "0";
  const decPart = padded.slice(-6).replace(/0+$/, "");
  return decPart ? `${intPart}.${decPart}` : intPart;
}

async function sendTelegramMessage(
  chatId: string,
  text: string,
  inlineKeyboard?: { text: string; url?: string; callback_data?: string }[][]
) {
  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (inlineKeyboard) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, ...params } = body ?? {};

    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }

    switch (action) {
      // 社員がスケジュールをまとめて申請（CSV相当、配列で受け取る）
      case "saveUserEmail": {
        const { walletAddress, email } = params;
        if (!walletAddress || !email) {
          return NextResponse.json({ error: "Missing walletAddress or email" }, { status: 400 });
        }
        const { error } = await supabase
          .from("user_emails")
          .upsert({ wallet_address: walletAddress.toLowerCase(), email: email.toLowerCase() });
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json({ success: true }, { status: 200 });
      }

      case "resolveEmail": {
        const { email } = params;
        if (!email) {
          return NextResponse.json({ error: "Missing email" }, { status: 400 });
        }
        const { data } = await supabase
          .from("user_emails")
          .select("wallet_address")
          .eq("email", email.toLowerCase())
          .maybeSingle();
        if (!data) {
          return NextResponse.json({ error: "This email is not registered on SnapRoll" }, { status: 404 });
        }
        return NextResponse.json({ walletAddress: data.wallet_address }, { status: 200 });
      }
      case "submit": {
        const { schedulerAddress, entries } = params;
        // entries: [{ recipient, amount, executeAfter }, ...]

        if (!schedulerAddress || !Array.isArray(entries) || entries.length === 0) {
          return NextResponse.json(
            { error: "Missing schedulerAddress or entries" },
            { status: 400 }
          );
        }
        const rows = entries.map((e: any) => ({
          scheduler_address: schedulerAddress,
          recipient: e.recipient,
          amount: e.amount,
          execute_after: e.executeAfter,
          status: "pending",
          interval_seconds: e.intervalSeconds ?? null,
          currency: e.currency ?? "USDC",
          slippage_bps: e.currency === "EURC" ? (e.slippageBps ?? 100) : null,
          label: e.label ?? null,
        }));

        const { data, error } = await supabase
          .from("pending_schedules")
          .insert(rows)
          .select();

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // このschedulerAddressに紐づく責任者全員に通知
        const { data: approvers } = await supabase
          .from("approvers")
          .select("telegram_chat_id")
          .eq("scheduler_address", schedulerAddress)
          .not("telegram_chat_id", "is", null);

        if (approvers && approvers.length > 0) {
          const csvLines = data
            .map(
              (row: any) =>
                `${row.label ?? row.recipient},${fromUsdcUnits(row.amount)} ${row.currency ?? "USDC"},${new Date(
                  row.execute_after * 1000
                ).toISOString()}${row.interval_seconds ? ` (repeats every ${row.interval_seconds}s)` : ""}${
                  row.currency === "EURC" ? ` [auto-swap, max slippage ${(row.slippage_bps ?? 100) / 100}%]` : ""
                }`
            )
            .join("\n");

          const approvalUrl = `${APP_BASE_URL}/approve?scheduler=${schedulerAddress}`;

          const message =
            `📋 New payroll schedule approval request\n\n` +
            `label,amount,executeAfter\n${csvLines}`;

          // 申請ごとに1件ずつボタンを出す（拒否は個別に処理するため）
          for (const approver of approvers) {
            if (!approver.telegram_chat_id) continue;

            await sendTelegramMessage(approver.telegram_chat_id, message);

            for (const row of data) {
              const rowText =
                `Recipient: ${row.recipient}\n` +
                `Amount: ${fromUsdcUnits(row.amount)} ${row.currency ?? "USDC"}\n` +
                `Execute after: ${new Date(row.execute_after * 1000).toISOString()}` +
                (row.currency === "EURC"
                  ? `\n⚠ Will auto-swap USDC → EURC on-chain (max slippage ${(row.slippage_bps ?? 100) / 100}%)`
                  : "");

              await sendTelegramMessage(approver.telegram_chat_id, rowText, [
                [
                  { text: "✅ Open approval page", url: approvalUrl },
                  { text: "❌ Reject", callback_data: `reject:${row.id}` },
                ],
              ]);
            }
          }
        }

        return NextResponse.json({ submitted: data }, { status: 200 });
      }

      // 承認ページで一覧を表示するための、保留中スケジュール取得
      case "listPending": {
        const { schedulerAddress } = params;
        if (!schedulerAddress) {
          return NextResponse.json({ error: "Missing schedulerAddress" }, { status: 400 });
        }

        const { data, error } = await supabase
          .from("pending_schedules")
          .select("*")
          .eq("scheduler_address", schedulerAddress)
          .eq("status", "pending")
          .order("created_at", { ascending: true });

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ pending: data }, { status: 200 });
      }

      // 承認処理：ステータス更新＋tx_hash記録（オンチェーン実行自体はフロントで実施済みの前提）
      case "markApproved": {
        const { id, txHash } = params;
        if (!id) {
          return NextResponse.json({ error: "Missing id" }, { status: 400 });
        }

        const { data, error } = await supabase
          .from("pending_schedules")
          .update({
            status: "approved",
            approved_at: new Date().toISOString(),
            tx_hash: txHash || null,
          })
          .eq("id", id)
          .select()
          .single();

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        if (data) {
          const { data: approvers } = await supabase
            .from("approvers")
            .select("telegram_chat_id")
            .eq("scheduler_address", data.scheduler_address)
            .not("telegram_chat_id", "is", null);

          if (approvers && approvers.length > 0) {
            const message =
              `✅ Schedule approved and executed\n\n` +
              `${data.label ?? data.recipient}\n` +
              `${fromUsdcUnits(data.amount)} ${data.currency ?? "USDC"}\n` +
              (txHash ? `Tx: ${txHash}` : "");

            for (const approver of approvers) {
              if (approver.telegram_chat_id) {
                await sendTelegramMessage(approver.telegram_chat_id, message);
              }
            }
          }
        }

        return NextResponse.json(data, { status: 200 });
      }


      case "markPaused": {
        const { id } = params;
        if (!id) {
          return NextResponse.json({ error: "Missing id" }, { status: 400 });
        }
        const { data, error } = await supabase
          .from("pending_schedules")
          .update({ status: "paused" })
          .eq("id", id)
          .select()
          .single();
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json(data, { status: 200 });
      }

      // ダッシュボードのカレンダー表示用: 全ステータス（pending/approved/executed/rejected）の
      // スケジュールを日付ごとに使えるよう取得する。
      case "listAll": {
        const { schedulerAddress } = params;
        if (!schedulerAddress) {
          return NextResponse.json({ error: "Missing schedulerAddress" }, { status: 400 });
        }

        const { data, error } = await supabase
          .from("pending_schedules")
          .select("*")
          .eq("scheduler_address", schedulerAddress)
          .order("execute_after", { ascending: true });

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ schedules: data }, { status: 200 });
      }

      // ダッシュボードのカレンダー表示用: schedule_executionsから過去の
      // 実行履歴を取得する。pending_schedulesのexecute_afterは繰り返し
      // スケジュールの「次回予定日」しか保持していないため、過去に
      // 実際に実行された日付を表示するにはこちらを別途参照する必要がある。
      case "listExecutions": {
        const { schedulerAddress } = params;
        if (!schedulerAddress) {
          return NextResponse.json({ error: "Missing schedulerAddress" }, { status: 400 });
        }

        const { data, error } = await supabase
          .from("schedule_executions")
          .select("*")
          .eq("scheduler_address", schedulerAddress)
          .order("execute_after", { ascending: true });

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ executions: data }, { status: 200 });
      }

      // 履歴CSVダウンロード用。executedステータスのもののみ対象とし、
      // オンチェーンのtx_hashも含めて出力する。
      case "exportCsv": {
        const { schedulerAddress } = params;
        if (!schedulerAddress) {
          return NextResponse.json({ error: "Missing schedulerAddress" }, { status: 400 });
        }

        const { data, error } = await supabase
          .from("pending_schedules")
          .select("*")
          .eq("scheduler_address", schedulerAddress)
          .eq("status", "executed")
          .order("execute_after", { ascending: true });

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const { ethers } = await import("ethers");
        const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
        const EXECUTED_TOPIC = ethers.id("ScheduleExecuted(uint256,address,uint256)");
        const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
        const EURC_ADDR = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

        const rows: string[] = [];
        for (const row of data || []) {
          const amountReadable = (Number(row.amount) / 1_000_000).toString();
          const dateStr = new Date(row.execute_after * 1000).toISOString();
          let verified = "no_tx_hash";
          // Only meaningful for EURC rows: the actual EURC amount the
          // recipient received on-chain, read from the EURC token's own
          // Transfer event rather than trusting the DB's `amount` column
          // (which is always the pre-swap USDC amount the owner approved --
          // ScheduleExecuted doesn't log the post-swap amount, see
          // PaymentSchedulerV2.executeSchedule).
          let actualEurcReceived = "";

          if (row.tx_hash) {
            try {
              const receipt = await provider.getTransactionReceipt(row.tx_hash);
              if (!receipt) {
                verified = "not_found";
              } else if (receipt.status !== 1) {
                verified = "failed";
              } else if (
                receipt.to?.toLowerCase() !== row.scheduler_address.toLowerCase()
              ) {
                verified = "wrong_contract";
              } else {
                const hasEvent = receipt.logs.some(
                  (log: any) => log.topics[0] === EXECUTED_TOPIC
                );
                verified = hasEvent ? "verified" : "no_event";

                if (row.currency === "EURC" && verified === "verified") {
                  const recipientTopic = ethers.zeroPadValue(
                    ethers.getAddress(row.recipient.toLowerCase()),
                    32
                  );
                  const transferLog = receipt.logs.find(
                    (log: any) =>
                      log.address.toLowerCase() === EURC_ADDR.toLowerCase() &&
                      log.topics[0] === TRANSFER_TOPIC &&
                      log.topics[2]?.toLowerCase() === recipientTopic.toLowerCase()
                  );
                  if (transferLog) {
                    const receivedRaw = BigInt(transferLog.data);
                    actualEurcReceived = (Number(receivedRaw) / 1_000_000).toString();
                  } else {
                    verified = "eurc_transfer_not_found";
                  }
                }
              }
            } catch (e) {
              verified = "verify_error";
            }
          }

          rows.push(
            [
              row.label || "",
              row.recipient,
              amountReadable,
              row.currency || "USDC",
              dateStr,
              row.status,
              row.tx_hash || "",
              verified,
              actualEurcReceived,
            ].join(",")
          );
        }

        const header =
          "label,recipient,amount,currency,execute_after,status,tx_hash,onchain_verified,actual_eurc_received\n";
        const csv = header + rows.join("\n");

        return new NextResponse(csv, {
          status: 200,
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": "attachment; filename=payroll-history.csv",
          },
        });
      }

      // 拒否処理：署名不要のためTelegramのボタンから直接呼べる
      case "reject": {
        const { id } = params;
        if (!id) {
          return NextResponse.json({ error: "Missing id" }, { status: 400 });
        }

        const { data, error } = await supabase
          .from("pending_schedules")
          .update({ status: "rejected" })
          .eq("id", id)
          .select()
          .single();

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data, { status: 200 });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("Schedule API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
