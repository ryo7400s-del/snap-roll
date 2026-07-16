"use client";

import { useEffect, useState } from "react";
import { useCircleAuth } from "./components/useCircleAuth";

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

export default function Home() {
  const { deviceId, loginResult, wallet, restoring, login } = useCircleAuth();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

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
      setBalances(data.tokenBalances || []);
      setLoading(false);
    })();
  }, [loginResult, wallet]);

  const usdcBalance = balances.find((b) => b.token?.symbol === "USDC");

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
        <div style={{ textAlign: "center", marginTop: 60 }}>
          <p style={{ fontSize: 13, color: "#6B7688", marginBottom: 16 }}>
            Sign in to view your payroll wallet
          </p>
          <button
            onClick={login}
            disabled={!deviceId}
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
              {loading ? "..." : `$${formatAmount(usdcBalance?.amount ?? "0")}`}
            </div>
          </div>

          {/* Actions */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 30,
            }}
          >
            <button
              disabled
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "16px 0",
                background: "#EAF0FF",
                border: "none",
                borderRadius: 18,
                cursor: "not-allowed",
                opacity: 0.6,
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
              <span style={{ fontSize: 9, color: "#9AA3B2" }}>Coming soon</span>
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
          </div>
        </>
      )}
    </div>
  );
}
