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

export async function POST(request: Request) {
  try {
    const update = await request.json();

    const message = update.message;
    if (!message || !message.text) {
      return NextResponse.json({ ok: true });
    }

    const chatId = message.chat.id.toString();
    const text: string = message.text;

    // "/start <approverId>" 形式のDeep Linkを処理
    if (text.startsWith("/start")) {
      const parts = text.split(" ");
      const approverId = parts[1];

      if (!approverId) {
        await sendTelegramMessage(
          chatId,
          "このBotはArc Payrollの承認通知専用です。アプリ内の登録リンクからアクセスしてください。"
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
        await sendTelegramMessage(chatId, "登録に失敗しました。もう一度お試しください。");
        return NextResponse.json({ ok: true });
      }

      await sendTelegramMessage(
        chatId,
        "✅ 通知登録が完了しました。給与スケジュールの承認依頼が届くとここに通知します。"
      );
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ ok: true }); // Telegramには常に200を返す
  }
}
