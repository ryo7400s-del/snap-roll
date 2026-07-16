"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { setCookie, getCookie, deleteCookie } from "cookies-next";
import { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";
import type { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";

const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID as string;
const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID as string;

export type LoginResult = {
  userToken: string;
  encryptionKey: string;
};

export type Wallet = {
  id: string;
  address: string;
  blockchain: string;
  [key: string]: unknown;
};

const LOGIN_STORAGE_KEY = "circleLoginResult";
const WALLET_STORAGE_KEY = "circleWallet";

// 全ページ共通で使うCircleログイン状態フック。
// userToken/encryptionKey/walletをlocalStorageに永続化することで、
// タブ（ページ）を移動してもログイン状態が保たれるようにする。
// userTokenには約60分の有効期限があるため、期限切れの疑いがある場合は
// 呼び出し側でre-loginを促す（401/155105系エラー時にlogout()を呼ぶ運用）。
export function useCircleAuth() {
  const sdkRef = useRef<W3SSdk | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [deviceToken, setDeviceToken] = useState("");
  const [deviceEncryptionKey, setDeviceEncryptionKey] = useState("");
  const [loginResult, setLoginResultState] = useState<LoginResult | null>(null);
  const [wallet, setWalletState] = useState<Wallet | null>(null);
  const [restoring, setRestoring] = useState(true);

  const persistLoginResult = useCallback((result: LoginResult | null) => {
    setLoginResultState(result);
    if (typeof window === "undefined") return;
    if (result) {
      window.localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(result));
    } else {
      window.localStorage.removeItem(LOGIN_STORAGE_KEY);
    }
  }, []);

  const persistWallet = useCallback((w: Wallet | null) => {
    setWalletState(w);
    if (typeof window === "undefined") return;
    if (w) {
      window.localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(w));
    } else {
      window.localStorage.removeItem(WALLET_STORAGE_KEY);
    }
  }, []);

  const logout = useCallback(() => {
    persistLoginResult(null);
    persistWallet(null);
  }, [persistLoginResult, persistWallet]);

  // ルートページ経由のOAuthリダイレクト転送
  useEffect(() => {
    const redirect = getCookie("postLoginRedirect") as string | undefined;
    if (redirect && redirect !== "/" && window.location.pathname === "/") {
      deleteCookie("postLoginRedirect");
      window.location.href = redirect;
    }
  }, []);

  // localStorageからの復元（ページ遷移・リロード時）
  useEffect(() => {
    const savedLogin = window.localStorage.getItem(LOGIN_STORAGE_KEY);
    const savedWallet = window.localStorage.getItem(WALLET_STORAGE_KEY);
    if (savedLogin) {
      try {
        setLoginResultState(JSON.parse(savedLogin));
      } catch {}
    }
    if (savedWallet) {
      try {
        setWalletState(JSON.parse(savedWallet));
      } catch {}
    }
    setRestoring(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");

      const onLoginComplete = (error: unknown, result: any) => {
        alert("onLoginComplete fired. error=" + JSON.stringify(error) + " result=" + JSON.stringify(result));
        if (cancelled) return;
        if (error) {
          console.log("Login failed:", error);
          return;
        }

        // 他ページからログインを開始していた場合、そのページへ結果を引き継いで戻る
        const redirectTo = window.localStorage.getItem("postLoginRedirect");
        if (redirectTo && redirectTo !== "/") {
          window.localStorage.setItem("pendingLoginResult", JSON.stringify(result));
          window.localStorage.removeItem("postLoginRedirect");
          window.location.href = redirectTo;
          return;
        }

        persistLoginResult({
          userToken: result.userToken,
          encryptionKey: result.encryptionKey,
        });

        fetch("/api/circle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "initializeUser", userToken: result.userToken }),
        });
      };

      // 他ページで開始したログインの結果を引き継ぐ
      const pending = window.localStorage.getItem("pendingLoginResult");
      if (pending) {
        window.localStorage.removeItem("pendingLoginResult");
        const parsed = JSON.parse(pending);
        persistLoginResult({ userToken: parsed.userToken, encryptionKey: parsed.encryptionKey });
        fetch("/api/circle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "initializeUser", userToken: parsed.userToken }),
        });
      }

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

      if (!cancelled) setSdkReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [persistLoginResult]);

  useEffect(() => {
    (async () => {
      if (!sdkRef.current || !sdkReady) return;
      const cached = window.localStorage.getItem("deviceId");
      if (cached) {
        setDeviceId(cached);
        return;
      }
      const id = await sdkRef.current.getDeviceId();
      setDeviceId(id);
      window.localStorage.setItem("deviceId", id);
    })();
  }, [sdkReady]);

  const ensureDeviceToken = useCallback(async () => {
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
  }, [deviceToken, deviceId]);

  const login = useCallback(async () => {
    const sdk = sdkRef.current;
    if (!sdk) return;

    const token = await ensureDeviceToken();
    if (!token) return;

    setCookie("appId", appId);
    setCookie("google.clientId", googleClientId);
    window.localStorage.setItem("postLoginRedirect", window.location.pathname + window.location.search);

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
  }, [ensureDeviceToken, deviceEncryptionKey]);

  // ログイン済みならウォレットを自動取得（未取得の場合のみ）
  useEffect(() => {
    (async () => {
      if (!loginResult?.userToken || wallet) return;
      const res = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "listWallets", userToken: loginResult.userToken }),
      });
      const data = await res.json();

      // userToken切れ(155105)等の場合はログイン状態をクリアして再ログインを促す
      if (data.code === 155105 || res.status === 401 || res.status === 403) {
        logout();
        return;
      }

      const w = data.wallets?.[0];
      if (w) persistWallet(w);
    })();
  }, [loginResult, wallet, persistWallet, logout]);

  return {
    sdk: sdkRef.current,
    deviceId,
    loginResult,
    wallet,
    restoring,
    login,
    logout,
    persistWallet,
  };
}
