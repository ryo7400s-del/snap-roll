"use client";

import { useEffect, useRef, useState } from "react";
import { setCookie, getCookie } from "cookies-next";
import { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";
import type { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";

const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID as string;
const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID as string;

const SCHEDULER_ADDRESS = "0x2478DB80727eF7AD46337bd53c17c7b6fca16a4b";
const TELEGRAM_BOT_USERNAME = "arc_payroll_approval_bot"; // 例: arc_payroll_approval_bot

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

export default function Home() {
  const sdkRef = useRef<W3SSdk | null>(null);

  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [deviceToken, setDeviceToken] = useState("");
  const [deviceEncryptionKey, setDeviceEncryptionKey] = useState("");
  const [loginResult, setLoginResult] = useState<LoginResult | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [status, setStatus] = useState("初期化前");
  const [deployResult, setDeployResult] = useState<string | null>(null);
  const [whitelistResult, setWhitelistResult] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [approverLink, setApproverLink] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");

      const onLoginComplete = (error: unknown, result: any) => {
        if (cancelled) return;
        if (error) {
          console.log("Login failed:", error);
          setStatus("ログイン結果なし（未ログイン状態）");
          return;
        }
        setLoginResult({
          userToken: result.userToken,
          encryptionKey: result.encryptionKey,
        });
        setStatus("ログイン成功。ユーザー初期化中...");

        fetch("/api/circle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "initializeUser",
            userToken: result.userToken,
          }),
        }).then(() => setStatus("ログイン成功。ウォレット一覧を取得できます"));
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
        setStatus("SDK初期化完了");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleCreateDeviceToken = async () => {
    if (!deviceId) return setStatus("deviceId未取得");
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
    setStatus("デバイストークン作成完了");
  };

  const handleLoginWithGoogle = () => {
    const sdk = sdkRef.current;
    if (!sdk || !deviceToken || !deviceEncryptionKey) {
      setStatus("先にデバイストークンを作成してください");
      return;
    }

    setCookie("appId", appId);
    setCookie("google.clientId", googleClientId);
    setCookie("deviceToken", deviceToken);
    setCookie("deviceEncryptionKey", deviceEncryptionKey);

    sdk.updateConfigs({
      appSettings: { appId },
      loginConfigs: {
        deviceToken,
        deviceEncryptionKey,
        google: {
          clientId: googleClientId,
          redirectUri: window.location.origin,
          selectAccountPrompt: true,
        },
      },
    });

    setStatus("Googleへリダイレクト中...");
    sdk.performLogin(SocialLoginProvider.GOOGLE);
  };

  const handleListWallets = async () => {
    if (!loginResult?.userToken) return setStatus("先にログインしてください");
    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "listWallets", userToken: loginResult.userToken }),
    });
    const data = await res.json();
    if (data.wallets) {
      setWallets(data.wallets);
      setStatus(`ウォレット ${data.wallets.length} 件取得`);
    } else {
      setStatus("ウォレット取得失敗: " + JSON.stringify(data));
    }
  };

  const handleDeployTest = async () => {
    const sdk = sdkRef.current;
    if (!sdk || !loginResult || wallets.length === 0) {
      setStatus("ログイン・ウォレット取得が先に必要です");
      return;
    }

    const walletId = wallets[0].id;

    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deployFactory",
        userToken: loginResult.userToken,
        walletId,
      }),
    });
    const data = await res.json();

    if (!data.challengeId) {
      setDeployResult("チャレンジ作成失敗: " + JSON.stringify(data));
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(data.challengeId, (error, result) => {
      if (error) {
        setDeployResult("デプロイ失敗: " + JSON.stringify(error));
        return;
      }
      setDeployResult("デプロイ成功: " + JSON.stringify(result));
    });
  };

  const handleWhitelistBatch = async () => {
    const sdk = sdkRef.current;
    if (!sdk || !loginResult || wallets.length === 0) {
      setStatus("ログイン・ウォレット取得が先に必要です");
      return;
    }

    const walletId = wallets[0].id;
    const myAddress = wallets[0].address;

    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "whitelistBatch",
        userToken: loginResult.userToken,
        walletId,
        schedulerAddress: SCHEDULER_ADDRESS,
        accounts: [myAddress],
      }),
    });
    const data = await res.json();

    if (!data.challengeId) {
      setWhitelistResult("チャレンジ作成失敗: " + JSON.stringify(data));
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(data.challengeId, (error, result) => {
      if (error) {
        setWhitelistResult("whitelist登録失敗: " + JSON.stringify(error));
        return;
      }
      setWhitelistResult("whitelist登録成功: " + JSON.stringify(result));
    });
  };

  const handleCreateSchedulesBatch = async () => {
    const sdk = sdkRef.current;
    if (!sdk || !loginResult || wallets.length === 0) {
      setStatus("ログイン・ウォレット取得が先に必要です");
      return;
    }

    const walletId = wallets[0].id;
    const myAddress = wallets[0].address;
    const now = Math.floor(Date.now() / 1000);

    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createSchedulesBatch",
        userToken: loginResult.userToken,
        walletId,
        schedulerAddress: SCHEDULER_ADDRESS,
        recipients: [myAddress, myAddress, myAddress],
        amounts: ["1000000", "2000000", "3000000"],
        executeAfters: [now, now + 60, now + 120],
      }),
    });
    const data = await res.json();

    if (!data.challengeId) {
      setBatchResult("チャレンジ作成失敗: " + JSON.stringify(data));
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(data.challengeId, (error, result) => {
      if (error) {
        setBatchResult("バッチ登録失敗: " + JSON.stringify(error));
        return;
      }
      setBatchResult("バッチ登録成功: " + JSON.stringify(result));
    });
  };

  // ③ 責任者としてTelegram通知を登録する（Deep Linkを発行）
  const handleRegisterApprover = async () => {
    if (wallets.length === 0) {
      setStatus("先にウォレットを取得してください");
      return;
    }

    const myAddress = wallets[0].address;

    const res = await fetch("/api/approver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "register",
        walletAddress: myAddress,
        schedulerAddress: SCHEDULER_ADDRESS,
      }),
    });
    const data = await res.json();

    if (!data.id) {
      setStatus("責任者登録失敗: " + JSON.stringify(data));
      return;
    }

    const link = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${data.id}`;
    setApproverLink(link);
    setStatus("責任者登録完了。下記リンクからTelegramで通知を有効化してください");
  };

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Circleウォレット接続テスト</h1>
      <p>ステータス: {status}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
        <button onClick={handleCreateDeviceToken} disabled={!deviceId}>
          ① デバイストークン作成
        </button>
        <button onClick={handleLoginWithGoogle} disabled={!deviceToken}>
          ② Googleでログイン
        </button>
        <button onClick={handleListWallets} disabled={!loginResult}>
          ③ ウォレット一覧取得
        </button>
        <button onClick={handleDeployTest} disabled={wallets.length === 0}>
          ④ Factory.deploy() 実行（テスト）
        </button>
        <button onClick={handleWhitelistBatch} disabled={wallets.length === 0}>
          ⑤ addToWhitelistBatch 実行
        </button>
        <button onClick={handleCreateSchedulesBatch} disabled={wallets.length === 0}>
          ⑥ createSchedulesBatch 実行
        </button>
        <button onClick={handleRegisterApprover} disabled={wallets.length === 0}>
          ⑦ 責任者としてTelegram通知登録
        </button>
      </div>

      {wallets.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3>ウォレット</h3>
          <pre>{JSON.stringify(wallets, null, 2)}</pre>
        </div>
      )}

      {deployResult && (
        <div style={{ marginTop: 16 }}>
          <h3>デプロイ結果</h3>
          <pre>{deployResult}</pre>
        </div>
      )}

      {whitelistResult && (
        <div style={{ marginTop: 16 }}>
          <h3>Whitelistバッチ結果</h3>
          <pre>{whitelistResult}</pre>
        </div>
      )}

      {batchResult && (
        <div style={{ marginTop: 16 }}>
          <h3>スケジュールバッチ結果</h3>
          <pre>{batchResult}</pre>
        </div>
      )}

      {approverLink && (
        <div style={{ marginTop: 16 }}>
          <h3>Telegram通知登録リンク</h3>
          <a href={approverLink} target="_blank" rel="noopener noreferrer">
            {approverLink}
          </a>
        </div>
      )}
    </main>
  );
}
