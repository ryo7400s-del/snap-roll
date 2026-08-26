"use client";

import { useEffect, useState } from "react";
import { useCircleAuth } from "./components/useCircleAuth";
import SnapRollLanding from "./components/SnapRollLanding";

type TokenBalance = {
  amount: string;
  token: { symbol?: string; name?: string };
};

function formatAmount(amount: string, digits = 2) {
  const n = Number(amount);
  if (Number.isNaN(n)) return "0.00";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

type PendingEscrow = {
  id: string;
  escrow_vault_address: string;
  escrow_id: number;
  amount: string;
  currency?: string;
  label?: string;
};

export default function Home() {
  const { sdk, deviceId, loginResult, wallet, restoring, login } = useCircleAuth();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [eurcToUsdcRate, setEurcToUsdcRate] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingEscrows, setPendingEscrows] = useState<PendingEscrow[]>([]);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimStatus, setClaimStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!loginResult?.email) return;
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "listMyEscrows", email: loginResult.email }),
      });
      const data = await res.json();
      setPendingEscrows(data.escrows || []);
    })();
  }, [loginResult]);

  const handleClaim = async (escrow: PendingEscrow) => {
    if (!sdk || !loginResult || !wallet) return;
    setClaimingId(escrow.id);
    setClaimStatus("Requesting verifier signature...");

    try {
      const sigRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "issueEscrowClaimSignature",
          escrowVaultAddress: escrow.escrow_vault_address,
          escrowId: escrow.escrow_id,
          claimantAddress: wallet.address,
          recipientEmail: loginResult.email,
        }),
      });
      const sigData = await sigRes.json();
      if (!sigData.signature) {
        setClaimStatus("Failed to get verifier signature: " + JSON.stringify(sigData));
        setClaimingId(null);
        return;
      }

      setClaimStatus("Claiming...");
      const claimRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "claimEscrow",
          userToken: loginResult.userToken,
          walletId: wallet.id,
          escrowVaultAddress: escrow.escrow_vault_address,
          escrowId: escrow.escrow_id,
          signature: sigData.signature,
        }),
      });
      const claimData = await claimRes.json();
      if (!claimData.challengeId) {
        setClaimStatus("Claim failed: " + JSON.stringify(claimData));
        setClaimingId(null);
        return;
      }

      sdk.setAuthentication({
        userToken: loginResult.userToken,
        encryptionKey: loginResult.encryptionKey,
      });
      sdk.execute(claimData.challengeId, async (error: unknown, result?: any) => {
        if (error) {
          setClaimStatus("Claim failed: " + JSON.stringify(error));
          setClaimingId(null);
          return;
        }

        // TEMP DEBUG: send sdk.execute result to server log
        fetch("/api/circle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "debugLog", payload: result }),
        }).catch(() => {});

        // Same reasoning as elsewhere: the signing callback only confirms
        // the challenge was signed, not that claimEscrow succeeded
        // on-chain. Verify before removing it from the pending list.
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
        setClaimingId(null);

        if (statusData.state === "FAILED") {
          setClaimStatus(
            `Claim failed on-chain: ${statusData.errorReason || "unknown"} (${statusData.errorDetails || ""})`
          );
          return;
        }

        if (statusData.state !== "COMPLETE" && statusData.state !== "CONFIRMED") {
          setClaimStatus(`Claim status unclear: ${statusData.state || "unknown"}. Please check ArcScan before assuming it worked.`);
          return;
        }

        setClaimStatus("Claimed successfully!");
        setPendingEscrows((prev) => prev.filter((e) => e.id !== escrow.id));
      });
    } catch (err) {
      setClaimStatus("Claim failed: " + String(err));
      setClaimingId(null);
    }
  };

  useEffect(() => {
    (async () => {
      if (!loginResult?.userToken || !wallet?.id) return;
      setLoading(true);
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
      const fetchedBalances: TokenBalance[] = data.tokenBalances || [];
      setBalances(fetchedBalances);
      setLoading(false);

      // For the combined Total Balance figure, convert the EURC balance to
      // its USDC-equivalent value using the same on-chain Curve pool rate
      // used elsewhere (e.g. approve screen's "≈ X EURC" estimate). This is
      // the pool's current exchange rate, not a real-world FX rate, so the
      // figure is an approximation rather than an authoritative USD value.
      const eurc = fetchedBalances.find((b) => b.token?.symbol === "EURC");
      if (eurc && Number(eurc.amount) > 0) {
        try {
          // Circle's getBalance returns amount as a human-readable decimal
          // string (e.g. "19.00"), but quoteEurcToUsdc expects the raw
          // 6-decimal on-chain integer (e.g. "19000000") since it calls
          // the Curve pool's get_dy directly. Convert before sending.
          const eurcRaw = Math.round(Number(eurc.amount) * 1_000_000).toString();
          const quoteRes = await fetch("/api/circle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "quoteEurcToUsdc", amountEurc: eurcRaw }),
          });
          const quoteData = await quoteRes.json();
          if (quoteData.estimatedUsdc) {
            // estimatedUsdc is also a raw 6-decimal integer, so divide by
            // eurcRaw (not eurc.amount) to get a dimensionless rate.
            setEurcToUsdcRate(Number(quoteData.estimatedUsdc) / Number(eurcRaw));
          }
        } catch {
          // Leave eurcToUsdcRate as null; Total Balance falls back to
          // USDC-only rather than showing a stale or wrong conversion.
        }
      }
    })();
  }, [loginResult, wallet]);

  const usdcBalance = balances.find((b) => b.token?.symbol === "USDC");
  const eurcBalance = balances.find((b) => b.token?.symbol === "EURC");

  const handleCopyAddress = () => {
    if (!wallet?.address) return;
    navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const truncatedAddress = wallet
    ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
    : "";

  return (
    <div style={{ padding: "20px 20px 8px", minHeight: "100%" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 12,
              background: "linear-gradient(135deg,#2E5CFF,#5B8CFF)",
            }}
          />
          <span style={{ fontSize: 17, fontWeight: 700, color: "#0B1220" }}>
            Payroll Wallet
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#2E5CFF",
            background: "#EAF0FF",
            padding: "5px 10px",
            borderRadius: 20,
          }}
        >
          Arc Testnet
        </div>
      </div>
      {restoring ? null : !loginResult ? (
        <SnapRollLanding onSignIn={login} signInDisabled={!deviceId} />
      ) : (
        <>
          {/* Balance */}
          <div style={{ textAlign: "center", marginBottom: 26 }}>
            <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 6 }}>
              Total Balance
            </div>
            <div
              style={{
                fontSize: 42,
                fontWeight: 800,
                color: "#0B1220",
                letterSpacing: "-0.02em",
              }}
            >
              {loading
                ? "..."
                : `$${formatAmount(
                    (
                      Number(usdcBalance?.amount ?? "0") +
                      (eurcBalance && eurcToUsdcRate !== null
                        ? Number(eurcBalance.amount) * eurcToUsdcRate
                        : 0)
                    ).toString()
                  )}`}
            </div>
          </div>

          {pendingEscrows.length > 0 && (
            <div
              style={{
                background: "#EAF0FF",
                border: "1px solid #C9D9FF",
                borderRadius: 16,
                padding: 16,
                marginBottom: 20,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220", marginBottom: 4 }}>
                💰 You have {pendingEscrows.length} pending payment{pendingEscrows.length > 1 ? "s" : ""} waiting
              </div>
              <div style={{ fontSize: 11, color: "#6B7688", marginBottom: 12 }}>
                Someone sent you a payment before you joined SnapRoll. Claim it now to receive the funds in your wallet.
              </div>
              {pendingEscrows.map((escrow) => (
                <div
                  key={escrow.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    background: "#FFFFFF",
                    borderRadius: 12,
                    padding: "10px 12px",
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220" }}>
                      {formatAmount(escrow.amount)} {escrow.currency || "USDC"}
                    </div>
                    {escrow.label && (
                      <div style={{ fontSize: 10, color: "#9AA3B2" }}>{escrow.label}</div>
                    )}
                  </div>
                  <button
                    onClick={() => handleClaim(escrow)}
                    disabled={claimingId === escrow.id}
                    style={{
                      background: "#2E5CFF",
                      border: "none",
                      borderRadius: 10,
                      padding: "8px 16px",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                      opacity: claimingId === escrow.id ? 0.6 : 1,
                    }}
                  >
                    {claimingId === escrow.id ? "Claiming..." : "Claim"}
                  </button>
                </div>
              ))}
              {claimStatus && (
                <div style={{ fontSize: 11, color: "#6B7688", marginTop: 4 }}>{claimStatus}</div>
              )}
            </div>
          )}

          {/* Actions */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
              marginBottom: 30,
            }}
          >
            <button
              onClick={() => (window.location.href = "/send")}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "16px 0",
                background: "#EAF0FF",
                border: "none",
                borderRadius: 18,
                cursor: "pointer",
                
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "#2E5CFF",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5}>
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#2E5CFF" }}>Send</span>
              <span style={{ fontSize: 9, color: "#9AA3B2" }}>Instant</span>
            </button>

            <button
              onClick={handleCopyAddress}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "16px 0",
                background: "#EAF0FF",
                border: "none",
                borderRadius: 18,
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "#2E5CFF",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#2E5CFF" }}>
                {copied ? "Copied!" : "Receive"}
              </span>
              <span style={{ fontSize: 9, color: "#9AA3B2" }}>
                {truncatedAddress || "..."}
              </span>
            </button>
            <button
              onClick={() => window.open("https://faucet.circle.com/", "_blank")}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "16px 0",
                background: "#EAF0FF",
                border: "none",
                borderRadius: 18,
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "#2E5CFF",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5}>
                  <path d="M12 2v6" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <path d="M8 22h8" />
                  <path d="M12 18v4" />
                </svg>
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#2E5CFF" }}>
                Faucet
              </span>
              <span style={{ fontSize: 9, color: "#9AA3B2" }}>
                Get testnet USDC
              </span>
            </button>
          </div>

          {/* Coins */}
          <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220", marginBottom: 12 }}>
            Coins
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 14px",
                background: "#FFFFFF",
                border: "1px solid #EEF1F6",
                borderRadius: 16,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: "50%",
                    background: "#2775CA",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  US
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#0B1220" }}>
                    USD Coin
                  </div>
                  <div style={{ fontSize: 11, color: "#9AA3B2" }}>
                    {formatAmount(usdcBalance?.amount ?? "0")} USDC
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#0B1220" }}>
                ${formatAmount(usdcBalance?.amount ?? "0")}
              </div>
            </div>
            {eurcBalance && Number(eurcBalance.amount) > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 14px",
                  background: "#FFFFFF",
                  border: "1px solid #EEF1F6",
                  borderRadius: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: "50%",
                      background: "#003399",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 800,
                    }}
                  >
                    EU
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#0B1220" }}>
                      Euro Coin
                    </div>
                    <div style={{ fontSize: 11, color: "#9AA3B2" }}>
                      {formatAmount(eurcBalance.amount)} EURC
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#0B1220" }}>
                  €{formatAmount(eurcBalance.amount)}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
