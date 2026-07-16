"use client";

import { useEffect, useRef, useState } from "react";
import { setCookie, getCookie } from "cookies-next";
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

type PendingSchedule = {
  id: string;
  scheduler_address: string;
  recipient: string;
  amount: string;
  execute_after: number;
  status: string;
};

export default function ApprovePage() {
  const sdkRef = useRef<W3SSdk | null>(null);

  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [deviceToken, setDeviceToken] = useState("");
  const [deviceEncryptionKey, setDeviceEncryptionKey] = useState("");
  const [loginResult, setLoginResult] = useState<LoginResult | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [status, setStatus] = useState("初期化前");
  const [pendingList, setPendingList] = useState<PendingSchedule[]>([]);
  const [schedulerAddress, setSchedulerAddress] = useState("");

  // URLのscheduler paramをCookieに保存し、リダイレクト後も維持する
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("scheduler");
    if (s) {
      setSchedulerAddress(s);
      setCookie("pendingSchedulerAddress", s);
    } else {
      const saved = getCookie("pendingSchedulerAddress") as string | undefined;
      if (saved) setSchedulerAddress(saved);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");

      const onLoginComplete = (error: unknown, result: any) => {
        alert("onLoginComplete called. error=" + JSON.stringify(error) + " result=" + JSON.stringify(result));
        if (cancelled) return;
        if (error) {
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
            // オリジンのみに統一（クエリ付きURLはGoogle OAuth側で個別登録が必要になるため）
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
      const id = await sdkRef.current.getDeviceId();
      setDeviceId(id);
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

    setCookie("postLoginRedirect", window.location.pathname + window.location.search);
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

  const handleLoadPending = async () => {
    if (!schedulerAddress) return setStatus("schedulerAddressが指定されていません");
    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "listPending", schedulerAddress }),
    });
    const data = await res.json();
    if (data.pending) {
      setPendingList(data.pending);
      setStatus(`保留中 ${data.pending.length} 件`);
    } else {
      setStatus("取得失敗: " + JSON.stringify(data));
    }
  };

  const handleApprove = async (item: PendingSchedule) => {
    const sdk = sdkRef.current;
    if (!sdk || !loginResult || wallets.length === 0) {
      setStatus("ログイン・ウォレット取得が先に必要です");
      return;
    }

    const walletId = wallets[0].id;
    const requestId = "0x" + item.id.replace(/-/g, "").padStart(64, "0");

    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approveSchedule",
        userToken: loginResult.userToken,
        walletId,
        schedulerAddress: item.scheduler_address,
        recipient: item.recipient,
        amount: item.amount,
        executeAfter: item.execute_after,
        requestId,
      }),
    });
    const data = await res.json();

    if (!data.challengeId) {
      setStatus("チャレンジ作成失敗: " + JSON.stringify(data));
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(data.challengeId, async (error, result) => {
      if (error) {
        setStatus("承認実行失敗: " + JSON.stringify(error));
        return;
      }

      await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "markApproved",
          id: item.id,
          txHash: (result as any)?.txHash || null,
        }),
      });

      setStatus(`承認完了: ${item.recipient} (${item.amount})`);
      handleLoadPending();
    });
  };

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>給与スケジュール承認</h1>
      <p>ステータス: {status}</p>
      <p>対象コントラクト: {schedulerAddress || "（URLにscheduler未指定）"}</p>

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
        <button onClick={handleLoadPending} disabled={!schedulerAddress}>
          ④ 保留中スケジュール一覧を取得
        </button>
      </div>

      {pendingList.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3>保留中のスケジュール</h3>
          {pendingList.map((item) => (
            <div
              key={item.id}
              style={{
                border: "1px solid #ccc",
                padding: 12,
                marginBottom: 8,
                maxWidth: 400,
              }}
            >
              <p>受取人: {item.recipient}</p>
              <p>金額: {item.amount}</p>
              <p>
                実行可能時刻:{" "}
                {new Date(item.execute_after * 1000).toLocaleString()}
              </p>
              <button
                onClick={() => handleApprove(item)}
                disabled={wallets.length === 0}
              >
                承認して実行
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
