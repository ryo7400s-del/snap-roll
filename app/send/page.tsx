"use client";

import { useState } from "react";
import { useCircleAuth } from "../components/useCircleAuth";
import { usePasskey } from "../components/usePasskey";

export default function SendPage() {
  const { sdk, loginResult, wallet, restoring, login } = useCircleAuth();
  const { enabled: passkeyEnabled, verifyPasskey } = usePasskey(wallet?.address);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!sdk || !loginResult || !wallet) {
      setStatus("Please sign in first");
      return;
    }
    if (!recipient || !amount) {
      setStatus("Enter a recipient and amount");
      return;
    }

    setSending(true);
    setStatus("Checking limits...");

    let finalRecipient = recipient;
    if (!recipient.startsWith("0x")) {
      const resolveRes = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveEmail", email: recipient }),
      });
      const resolveData = await resolveRes.json();
      if (!resolveData.walletAddress) {
        setStatus(`"${recipient}" is not registered on SnapRoll`);
        setSending(false);
        return;
      }
      finalRecipient = resolveData.walletAddress;
    }

    const limitRes = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "checkInstantSendLimit",
        walletAddress: wallet.address,
        amount,
      }),
    });
    const limitData = await limitRes.json();
    if (!limitData.allowed) {
      setStatus(limitData.reason || "This transfer exceeds your limits");
      setSending(false);
      return;
    }

    setStatus("Verifying passkey...");
    const verified = await verifyPasskey();
    if (!verified) {
      setStatus("Passkey verification failed or cancelled");
      setSending(false);
      return;
    }

    setStatus("Sending...");

    const amountUnits = Math.round(Number(amount) * 1_000_000).toString();

    const sendRes = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "instantSend",
        userToken: loginResult.userToken,
        walletId: wallet.id,
        recipient: finalRecipient,
        amount: amountUnits,
      }),
    });
    const sendData = await sendRes.json();

    if (!sendData.challengeId) {
      setStatus("Send failed: " + JSON.stringify(sendData));
      setSending(false);
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(sendData.challengeId, async (error: unknown, result: any) => {
      setSending(false);
      if (error) {
        setStatus("Send failed: " + JSON.stringify(error));
        return;
      }

      await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "recordInstantSend",
          walletAddress: wallet.address,
          recipient: finalRecipient,
          amount,
          txHash: (result as any)?.txHash || null,
        }),
      });

      setStatus("Sent successfully");
      setRecipient("");
      setAmount("");
    });
  };

  return (
    <div style={{ padding: "20px 20px 8px", minHeight: "100%" }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#0B1220", marginBottom: 4 }}>
        Send
      </div>
      <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 22 }}>
        Instantly send USDC to any wallet or SnapRoll email
      </div>

      {restoring ? null : !loginResult ? (
        <div style={{ textAlign: "center", marginTop: 60 }}>
          <p style={{ fontSize: 13, color: "#6B7688", marginBottom: 16 }}>
            Sign in to send funds
          </p>
          <button
            onClick={login}
            style={{
              background: "#2E5CFF",
              border: "none",
              borderRadius: 12,
              padding: "12px 24px",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Sign in with Google
          </button>
        </div>
      ) : !passkeyEnabled ? (
        <div
          style={{
            background: "#FFF4E5",
            border: "1px solid #F5A623",
            borderRadius: 14,
            padding: 16,
            marginTop: 20,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: "#8A5A00", marginBottom: 8 }}>
            Passkey required for instant send
          </div>
          <div style={{ fontSize: 12, color: "#8A5A00", marginBottom: 14 }}>
            Instant transfers move funds immediately with no approval step, so a passkey
            (biometric or device PIN) confirmation is required before you can use this feature.
          </div>
          <a
            href="/setting"
            style={{
              display: "inline-block",
              background: "#8A5A00",
              borderRadius: 10,
              padding: "10px 16px",
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            Set up Passkey Lock
          </a>
        </div>
      ) : (
        <>
          <div
            style={{
              background: "#FFFFFF",
              border: "1px solid #EEF1F6",
              borderRadius: 16,
              padding: 14,
              marginBottom: 16,
            }}
          >
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Recipient address or SnapRoll email"
              style={{
                width: "100%",
                border: "1px solid #EEF1F6",
                borderRadius: 10,
                padding: 10,
                fontSize: 13,
                marginBottom: 10,
                background: "#F7F9FC",
                boxSizing: "border-box",
              }}
            />
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount (USDC)"
              inputMode="decimal"
              style={{
                width: "100%",
                border: "1px solid #EEF1F6",
                borderRadius: 10,
                padding: 10,
                fontSize: 13,
                background: "#F7F9FC",
                boxSizing: "border-box",
              }}
            />
          </div>

          <button
            onClick={handleSend}
            disabled={sending}
            style={{
              width: "100%",
              background: "#2E5CFF",
              border: "none",
              borderRadius: 12,
              padding: "14px 0",
              color: "#fff",
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              opacity: sending ? 0.6 : 1,
            }}
          >
            {sending ? "Sending..." : "Send Now"}
          </button>

          {status && (
            <div
              style={{
                fontSize: 12,
                color: "#2E5CFF",
                background: "#EAF0FF",
                borderRadius: 12,
                padding: "10px 12px",
                marginTop: 16,
              }}
            >
              {status}
            </div>
          )}
        </>
      )}
    </div>
  );
}
