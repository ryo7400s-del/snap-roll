import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SECRET_KEY as string
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_BASE_URL as string;

async function sendTelegramMessage(chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
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
                `${row.recipient},${row.amount},${new Date(
                  row.execute_after * 1000
                ).toISOString()}`
            )
            .join("\n");

          const approvalUrl = `${APP_BASE_URL}/approve?scheduler=${schedulerAddress}`;

          const message =
            `📋 New payroll schedule approval request\n\n` +
            `recipient,amount,executeAfter\n${csvLines}\n\n` +
            `Approve here: ${approvalUrl}`;

          for (const approver of approvers) {
            if (approver.telegram_chat_id) {
              await sendTelegramMessage(approver.telegram_chat_id, message);
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
