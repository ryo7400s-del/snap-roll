import { NextRequest, NextResponse } from "next/server";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { createClient } from "@supabase/supabase-js";
import { RP_ID, ORIGIN, RP_NAME } from "@/lib/webauthn-config";
const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SECRET_KEY as string
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;

async function sendTelegramMessage(
  chatId: string,
  text: string,
  inlineKeyboard?: { text: string; url?: string; callback_data?: string }[][]
) {
  const msgBody: any = { chat_id: chatId, text, parse_mode: "HTML" };
  if (inlineKeyboard) {
    msgBody.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msgBody),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action } = body;

  // --- 登録開始 ---
  if (action === "registerStart") {
    const { walletAddress } = body;
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: walletAddress,
      attestationType: "none",
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "preferred",
      },
    });

    await supabase.from("passkey_challenges").insert({
      wallet_address: walletAddress,
      challenge: options.challenge,
      type: "register",
    });

    return NextResponse.json(options);
  }

  // --- 登録完了 ---
  if (action === "registerFinish") {
    const { walletAddress, attestation, deviceName } = body;

    const { data: challengeRow } = await supabase
      .from("passkey_challenges")
      .select("*")
      .eq("wallet_address", walletAddress)
      .eq("type", "register")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!challengeRow) {
      return NextResponse.json({ error: "Challenge expired or not found" }, { status: 400 });
    }

    const verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: "Verification failed" }, { status: 400 });
    }

    const { credential } = verification.registrationInfo;

    await supabase.from("passkey_credentials").insert({
      wallet_address: walletAddress,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      device_name: deviceName || null,
    });

    await supabase.from("passkey_challenges").delete().eq("id", challengeRow.id);

    await supabase
      .from("passkey_settings")
      .upsert({ wallet_address: walletAddress, enabled: true, updated_at: new Date().toISOString() });

    return NextResponse.json({ success: true });
  }

  // --- 認証開始（送金前チェック時に呼ぶ） ---
  if (action === "authStart") {
    const { walletAddress } = body;

    const { data: creds } = await supabase
      .from("passkey_credentials")
      .select("credential_id")
      .eq("wallet_address", walletAddress);

    if (!creds || creds.length === 0) {
      return NextResponse.json({ error: "No passkey registered" }, { status: 400 });
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      allowCredentials: creds.map((c) => ({ id: c.credential_id })),
    });

    await supabase.from("passkey_challenges").insert({
      wallet_address: walletAddress,
      challenge: options.challenge,
      type: "authenticate",
    });

    return NextResponse.json(options);
  }

  // --- 認証完了 ---
  if (action === "authFinish") {
    const { walletAddress, assertion } = body;

    const { data: challengeRow } = await supabase
      .from("passkey_challenges")
      .select("*")
      .eq("wallet_address", walletAddress)
      .eq("type", "authenticate")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!challengeRow) {
      return NextResponse.json({ verified: false, error: "Challenge expired" }, { status: 400 });
    }

    const { data: credRow } = await supabase
      .from("passkey_credentials")
      .select("*")
      .eq("credential_id", assertion.id)
      .eq("wallet_address", walletAddress)
      .single();

    if (!credRow) {
      return NextResponse.json({ verified: false, error: "Credential not found" }, { status: 400 });
    }

    const verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: credRow.credential_id,
        publicKey: Buffer.from(credRow.public_key, "base64"),
        counter: credRow.counter,
      },
    });

    await supabase.from("passkey_challenges").delete().eq("id", challengeRow.id);

    if (!verification.verified) {
      return NextResponse.json({ verified: false }, { status: 400 });
    }

    await supabase
      .from("passkey_credentials")
      .update({ counter: verification.authenticationInfo.newCounter })
      .eq("id", credRow.id);

    return NextResponse.json({ verified: true });
  }

  // --- 有効/無効の取得・切替（Settingトグル用） ---
  if (action === "getStatus") {
    const { walletAddress } = body;
    const { data } = await supabase
      .from("passkey_settings")
      .select("enabled")
      .eq("wallet_address", walletAddress)
      .single();
    return NextResponse.json({ enabled: data?.enabled ?? false });
  }

  if (action === "setEnabled") {
    const { walletAddress, enabled } = body;
    await supabase
      .from("passkey_settings")
      .upsert({ wallet_address: walletAddress, enabled, updated_at: new Date().toISOString() });
    return NextResponse.json({ success: true });
  }


  if (action === "requestReset") {
    const { walletAddress, schedulerAddress } = body;

    const { data: reqRow, error: reqErr } = await supabase
      .from("passkey_reset_requests")
      .insert({ wallet_address: walletAddress, status: "pending" })
      .select()
      .single();

    if (reqErr || !reqRow) {
      return NextResponse.json({ error: "Failed to create reset request" }, { status: 500 });
    }

    const { data: approvers } = await supabase
      .from("approvers")
      .select("telegram_chat_id")
      .eq("scheduler_address", schedulerAddress)
      .not("telegram_chat_id", "is", null);

    if (approvers && approvers.length > 0) {
      for (const approver of approvers) {
        if (!approver.telegram_chat_id) continue;
        await sendTelegramMessage(
          approver.telegram_chat_id,
          `⚠️ Passkey reset requested for wallet ${walletAddress}.\n\nThis will remove all registered passkeys for this wallet, allowing a new device to be registered. Only approve this if you personally confirmed this request with the wallet owner.`,
          [[{ text: "✅ Approve Reset", callback_data: `approve_passkey_reset:${reqRow.id}` }]]
        );
      }
    }

    return NextResponse.json({ success: true, requestId: reqRow.id });
  }

  if (action === "getResetStatus") {
    const { requestId } = body;
    const { data } = await supabase
      .from("passkey_reset_requests")
      .select("status")
      .eq("id", requestId)
      .single();
    return NextResponse.json({ status: data?.status ?? "unknown" });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
