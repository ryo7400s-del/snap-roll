"use client";

import { useState, useEffect } from "react";
import { useCircleAuth } from "../components/useCircleAuth";
import { usePasskey } from "../components/usePasskey";

// Arc testnet gas is paid in USDC (not a separate native token), so a MAX
// send in USDC must hold back some balance for future transaction fees --
// otherwise the very next tx (even another instant send) could fail with
// insufficient gas. EURC isn't used for gas, so its MAX can be the full
// balance. This is a flat reserve rather than a real gas estimate since
// instant sends here don't set an explicit gasLimit (see approveSchedulesBatch
// / deployFactory, which do set one for heavier CREATE2/batch operations).
const USDC_GAS_RESERVE = 0.5;

export default function SendPage() {
  const { sdk, loginResult, wallet, restoring, login } = useCircleAuth();
  const { enabled: passkeyEnabled, verifyPasskey } = usePasskey(wallet?.address);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"USDC" | "EURC">("USDC");
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [eurcBalance, setEurcBalance] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      if (!loginResult?.userToken || !wallet?.id) return;
      const res = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "getBalance",
          userToken: loginResult.userToken,
          walletId: wallet.id,
        }),
      });
      const data = await res.json();
      const balances: { amount: string; token: { symbol?: string } }[] = data.tokenBalances || [];
      const usdc = balances.find((b) => b.token?.symbol === "USDC");
      const eurc = balances.find((b) => b.token?.symbol === "EURC");
      setUsdcBalance(usdc ? Number(usdc.amount) : 0);
      setEurcBalance(eurc ? Number(eurc.amount) : 0);
    })();
  }, [loginResult, wallet]);

  const handleMax = () => {
    if (currency === "USDC") {
      if (usdcBalance === null) return;
      const max = Math.max(0, usdcBalance - USDC_GAS_RESERVE);
      setAmount(max.toFixed(2));
    } else {
      if (eurcBalance === null) return;
      setAmount(eurcBalance.toFixed(2));
    }
  };

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


    const sendRes = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "instantSend",
        userToken: loginResult.userToken,
        walletId: wallet.id,
        recipient: finalRecipient,
        amount,
        currency,
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
      if (error) {
        setSending(false);
        setStatus("Send failed: " + JSON.stringify(error));
        return;
      }

      // sdk.execute's callback only confirms the signing challenge
      // completed, not that the transfer succeeded on-chain. Verify
      // before recording the send as successful, otherwise a reverted
      // instant send would be logged as if the funds actually moved.
      await new Promise((r) => setTimeout(r, 3000));

      const statusRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "checkTransactionStatus",
          userToken: loginResult.userToken,
          walletId: wallet.id,
        }),
      });
      const statusData = await statusRes.json();
      setSending(false);

      if (statusData.state === "FAILED") {
        setStatus(
          `Send failed on-chain: ${statusData.errorReason || "unknown"} (${statusData.errorDetails || ""})`
        );
        return;
      }

      if (statusData.state !== "COMPLETE" && statusData.state !== "CONFIRMED") {
        setStatus(`Send status unclear: ${statusData.state || "unknown"}. Please check ArcScan before assuming it worked.`);
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
            <div style={{ position: "relative" }}>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={`Amount (${currency})`}
                inputMode="decimal"
                style={{
                  width: "100%",
                  border: "1px solid #EEF1F6",
                  borderRadius: 10,
                  padding: "10px 56px 10px 10px",
                  fontSize: 13,
                  background: "#F7F9FC",
                  boxSizing: "border-box",
                }}
              />
              <button
                type="button"
                onClick={handleMax}
                style={{
                  position: "absolute",
                  right: 6,
                  top: "50%",
                  transform: "translateY(-50%)",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 10px",
                  background: "#EAF0FF",
                  color: "#2E5CFF",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                MAX
              </button>
            </div>
            {currency === "USDC" && usdcBalance !== null && (
              <div style={{ fontSize: 10, color: "#9AA3B2", marginTop: 4 }}>
                Balance: {usdcBalance.toFixed(2)} USDC (MAX reserves {USDC_GAS_RESERVE.toFixed(2)} for gas)
              </div>
            )}
            {currency === "EURC" && eurcBalance !== null && (
              <div style={{ fontSize: 10, color: "#9AA3B2", marginTop: 4 }}>
                Balance: {eurcBalance.toFixed(2)} EURC
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            <button
              type="button"
              onClick={() => setCurrency("USDC")}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: 8,
                border: currency === "USDC" ? "1px solid #2E5CFF" : "1px solid #EEF1F6",
                background: currency === "USDC" ? "#EAF0FF" : "#F7F9FC",
                color: currency === "USDC" ? "#2E5CFF" : "#6B7688",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              USDC
            </button>
            <button
              type="button"
              onClick={() => setCurrency("EURC")}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: 8,
                border: currency === "EURC" ? "1px solid #2E5CFF" : "1px solid #EEF1F6",
                background: currency === "EURC" ? "#EAF0FF" : "#F7F9FC",
                color: currency === "EURC" ? "#2E5CFF" : "#6B7688",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              EURC
            </button>
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
