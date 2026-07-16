import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SECRET_KEY as string
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;

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

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    }),
  });
}

export async function POST(request: Request) {
  try {
    const update = await request.json();

    // ボタン（Inline Keyboard）が押された場合
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id?.toString();
      const data: string = cq.data || "";

      if (data.startsWith("reject:")) {
        const scheduleId = data.split(":")[1];

        const { error } = await supabase
          .from("pending_schedules")
          .update({ status: "rejected" })
          .eq("id", scheduleId);

        if (error) {
          await answerCallbackQuery(cq.id, "Failed to reject. Please try again.");
        } else {
          await answerCallbackQuery(cq.id, "Rejected.");
          if (chatId) {
            await sendTelegramMessage(chatId, `❌ Schedule ${scheduleId} has been rejected.`);
          }
        }
      } else {
        await answerCallbackQuery(cq.id, "Unknown action.");
      }

      return NextResponse.json({ ok: true });
    }

    // 通常メッセージ（/start等）の場合
    const message = update.message;
    if (!message || !message.text) {
      return NextResponse.json({ ok: true });
    }

    const chatId = message.chat.id.toString();
    const text: string = message.text;

    if (text.startsWith("/start")) {
      const parts = text.split(" ");
      const approverId = parts[1];

      if (!approverId) {
        await sendTelegramMessage(
          chatId,
          "This bot is for Arc Payroll approval notifications only. Please access it via the registration link inside the app."
        );
        return NextResponse.json({ ok: true });
      }

      const { data, error } = await supabase
        .from("approvers")
        .update({ telegram_chat_id: chatId })
        .eq("id", approverId)
        .select()
        .single();

      if (error || !data) {
        await sendTelegramMessage(chatId, "Registration failed. Please try again.");
        return NextResponse.json({ ok: true });
      }

      await sendTelegramMessage(
        chatId,
        "✅ Notification registration complete. You will be notified here when a payroll schedule needs approval."
      );
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ ok: true });
  }
}
