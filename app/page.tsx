"use client";

import { useEffect, useRef, useState } from "react";
import { setCookie, getCookie, deleteCookie } from "cookies-next";
import { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";
import type { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";

const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID as string;
const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID as string;

type LoginResult = {
  userToken: string;
  encryptionKey: string;
};

type Wallet = {
  id: string;
  address: string;
  blockchain: string;
  [key: string]: unknown;
};

type TokenBalance = {
  amount: string;
  token: { symbol?: string; name?: string };
};

export default function Home() {
  const sdkRef = useRef<W3SSdk | null>(null);

  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [deviceToken, setDeviceToken] = useState("");
  const [deviceEncryptionKey, setDeviceEncryptionKey] = useState("");
  const [loginResult, setLoginResult] = useState<LoginResult | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // ルートリダイレクト転送（Google OAuthが他ページからでも一度ここを経由するため）
  useEffect(() => {
    const redirect = getCookie("postLoginRedirect") as string | undefined;
    if (redirect && redirect !== "/" && window.location.pathname === "/") {
      deleteCookie("postLoginRedirect");
      window.location.href = redirect;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");

      const onLoginComplete = (error: unknown, result: any) => {
        if (cancelled) return;
        if (error) {
          console.log("Login failed:", error);
          return;
        }
        setLoginResult({
          userToken: result.userToken,
          encryptionKey: result.encryptionKey,
        });

        {
          const redirectTo = window.localStorage.getItem("postLoginRedirect");
          if (redirectTo && redirectTo !== "/") {
            window.localStorage.setItem("pendingLoginResult", JSON.stringify(result));
            window.localStorage.removeItem("postLoginRedirect");
            window.location.href = redirectTo;
            return;
          }
        }

        fetch("/api/circle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "initializeUser",
            userToken: result.userToken,
          }),
        });
      };

      const restoredAppId = (getCookie("appId") as string) || appId || "";
      const restoredGoogleClientId =
        (getCookie("google.clientId") as string) || googleClientId || "";
      const restoredDeviceToken = (getCookie("deviceToken") as string) || "";
      const restoredDeviceEncryptionKey =
        (getCookie("deviceEncryptionKey") as string) || "";

      if (restoredDeviceToken) setDeviceToken(restoredDeviceToken);
      if (restoredDeviceEncryptionKey) setDeviceEncryptionKey(restoredDeviceEncryptionKey);

      const initialConfig = {
        appSettings: { appId: restoredAppId },
        loginConfigs: {
          deviceToken: restoredDeviceToken,
          deviceEncryptionKey: restoredDeviceEncryptionKey,
          google: {
            clientId: restoredGoogleClientId,
            redirectUri: typeof window !== "undefined" ? window.location.origin : "",
            selectAccountPrompt: true,
          },
        },
      };

      const sdk = new W3SSdk(initialConfig, onLoginComplete);
      sdkRef.current = sdk;

      if (!cancelled) {
        setSdkReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // deviceId取得
  useEffect(() => {
    (async () => {
      if (!sdkRef.current || !sdkReady) return;
      const cached =
        typeof window !== "undefined" ? window.localStorage.getItem("deviceId") : null;
      if (cached) {
        setDeviceId(cached);
        return;
      }
      const id = await sdkRef.current.getDeviceId();
      setDeviceId(id);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("deviceId", id);
      }
    })();
  }, [sdkReady]);

  // deviceId取得後、自動でデバイストークン発行→ログイン導線を用意
  const ensureDeviceToken = async () => {
    if (deviceToken) return deviceToken;
    if (!deviceId) return null;
    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "createDeviceToken", deviceId }),
    });
    const data = await res.json();
    setDeviceToken(data.deviceToken);
    setDeviceEncryptionKey(data.deviceEncryptionKey);
    setCookie("deviceToken", data.deviceToken);
    setCookie("deviceEncryptionKey", data.deviceEncryptionKey);
    return data.deviceToken as string;
  };

  const handleLogin = async () => {
    const sdk = sdkRef.current;
    if (!sdk) return;

    const token = await ensureDeviceToken();
    if (!token) return;

    setCookie("appId", appId);
    setCookie("google.clientId", googleClientId);

    sdk.updateConfigs({
      appSettings: { appId },
      loginConfigs: {
        deviceToken: token,
        deviceEncryptionKey,
        google: {
          clientId: googleClientId,
          redirectUri: window.location.origin,
          selectAccountPrompt: true,
        },
      },
    });

    sdk.performLogin(SocialLoginProvider.GOOGLE);
  };

  // ログイン結果が入ったら自動でウォレット・残高取得
  useEffect(() => {
    (async () => {
      if (!loginResult?.userToken) return;
      setLoading(true);

      const walletsRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "listWallets", userToken: loginResult.userToken }),
      });
      const walletsData = await walletsRes.json();
      const w = walletsData.wallets?.[0];
      if (!w) {
        setLoading(false);
        return;
      }
      setWallet(w);

      const balanceRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "getBalance",
          userToken: loginResult.userToken,
          walletId: w.id,
        }),
      });
      const balanceData = await balanceRes.json();
      setBalances(balanceData.tokenBalances || []);
      setLoading(false);
    })();
  }, [loginResult]);

  const usdcBalance = balances.find(
    (b) => b.token?.symbol === "USDC"
  );

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

      {!loginResult ? (
        // 未ログイン状態
        <div style={{ textAlign: "center", marginTop: 60 }}>
          <p style={{ fontSize: 13, color: "#6B7688", marginBottom: 16 }}>
            Sign in to view your payroll wallet
          </p>
          <button
            onClick={handleLogin}
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
              {loading
                ? "..."
                : usdcBalance
                ? `$${Number(usdcBalance.amount).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : "$0.00"}
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
                    {usdcBalance ? `${usdcBalance.amount} USDC` : "0 USDC"}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#0B1220" }}>
                {usdcBalance ? `$${usdcBalance.amount}` : "$0.00"}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
