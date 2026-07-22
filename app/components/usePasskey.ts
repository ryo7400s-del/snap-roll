"use client";

import { useState, useEffect, useCallback } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

export function usePasskey(walletAddress: string | undefined) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!walletAddress) return;
    const res = await fetch("/api/passkey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "getStatus", walletAddress }),
    });
    const data = await res.json();
    setEnabled(!!data.enabled);
  }, [walletAddress]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // パスキー新規登録（初回オン時に呼ぶ）
  const registerPasskey = useCallback(async () => {
    if (!walletAddress) return false;
    setLoading(true);
    try {
      const optRes = await fetch("/api/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "registerStart", walletAddress }),
      });
      const options = await optRes.json();

      const attestation = await startRegistration({ optionsJSON: options });

      const finishRes = await fetch("/api/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "registerFinish", walletAddress, attestation }),
      });
      const finishData = await finishRes.json();
      if (finishData.success) {
        setEnabled(true);
        return true;
      }
      return false;
    } catch (e) {
      console.error("Passkey registration failed:", e);
      return false;
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  // 送金直前の認証（handleApprove等から呼ぶ）
  const verifyPasskey = useCallback(async () => {
    if (!walletAddress) return false;
    try {
      const optRes = await fetch("/api/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "authStart", walletAddress }),
      });
      if (!optRes.ok) return false;
      const options = await optRes.json();

      const assertion = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "authFinish", walletAddress, assertion }),
      });
      const verifyData = await verifyRes.json();
      return !!verifyData.verified;
    } catch (e) {
      console.error("Passkey verification failed:", e);
      return false;
    }
  }, [walletAddress]);

  const setPasskeyEnabled = useCallback(
    async (value: boolean) => {
      if (!walletAddress) return;
      await fetch("/api/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setEnabled", walletAddress, enabled: value }),
      });
      setEnabled(value);
    },
    [walletAddress]
  );

  return { enabled, loading, registerPasskey, verifyPasskey, setPasskeyEnabled };
}
