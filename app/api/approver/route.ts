import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SECRET_KEY as string
);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, ...params } = body ?? {};

    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }

    switch (action) {
      // 責任者を登録（Telegram連携前の下準備。walletAddressとschedulerAddressのみ）
      case "register": {
        const { walletAddress, schedulerAddress } = params;
        if (!walletAddress || !schedulerAddress) {
          return NextResponse.json(
            { error: "Missing walletAddress or schedulerAddress" },
            { status: 400 }
          );
        }

        const { data, error } = await supabase
          .from("approvers")
          .insert({
            wallet_address: walletAddress,
            scheduler_address: schedulerAddress,
          })
          .select()
          .single();

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data, { status: 200 });
      }

      // Telegram連携完了時にchat_idを紐付け（後述のBot Webhookから呼ばれる想定）
      case "linkTelegram": {
        const { approverId, telegramChatId } = params;
        if (!approverId || !telegramChatId) {
          return NextResponse.json(
            { error: "Missing approverId or telegramChatId" },
            { status: 400 }
          );
        }

        const { data, error } = await supabase
          .from("approvers")
          .update({ telegram_chat_id: telegramChatId })
          .eq("id", approverId)
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
    console.error("Approver API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
