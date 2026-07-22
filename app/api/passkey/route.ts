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

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
