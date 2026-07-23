"use client";

import { useState, useRef, useEffect } from "react";
import Papa from "papaparse";
import { useCircleAuth } from "../components/useCircleAuth";
import { usePasskey } from "../components/usePasskey";

const FACTORY_ADDRESS = "0x48c2A4571C8a7A2074AD153C08488734f3A3411E";

// 一度デプロイしたPaymentSchedulerV2のアドレスを保持する場所。
// 本来はユーザーごとにSchedulerRegistry等から取得すべきだが、
// 現状は単一テスト用インスタンスをlocalStorageに保存して使い回す。
const SCHEDULER_STORAGE_KEY = "myPayrollScheduler";

type WhitelistEntry = {
  address: string;
  name: string;
};

export default function SettingPage() {
  const { sdk, deviceId, loginResult, wallet, restoring, login } = useCircleAuth();

  const { enabled: passkeyEnabled, loading: passkeyLoading, registerPasskey, setPasskeyEnabled } =
    usePasskey(wallet?.address);

  const handleTogglePasskey = async () => {
    if (!passkeyEnabled) {
      const ok = await registerPasskey();
      if (!ok) {
        alert("Failed to register passkey. Please try again.");
      }
    } else {
      await setPasskeyEnabled(false);
    }
  };

  const [schedulerAddress, setSchedulerAddress] = useState<string>(
    typeof window !== "undefined"
      ? window.localStorage.getItem(SCHEDULER_STORAGE_KEY) || ""
      : ""
  );
  const [outdatedInfo, setOutdatedInfo] = useState<{
    isCurrent: boolean;
    expectedContractAddress: string;
  } | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<string | null>(null);

  const [whitelistMode, setWhitelistMode] = useState<"manual" | "csv">("manual");
  const [manualAddress, setManualAddress] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [csvEntries, setCsvEntries] = useState<WhitelistEntry[]>([]);
  const [whitelisted, setWhitelisted] = useState<WhitelistEntry[]>([]);
  const [whitelistStatus, setWhitelistStatus] = useState<string | null>(null);
  const [whitelistList, setWhitelistList] = useState<string[]>([]);
  const [whitelistLabels, setWhitelistLabels] = useState<Record<string, string>>({});
  const [whitelistListOpen, setWhitelistListOpen] = useState(false);
  const [whitelistListLoading, setWhitelistListLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [telegramLink, setTelegramLink] = useState<string | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);

  const persistScheduler = (addr: string) => {
    setSchedulerAddress(addr);
    window.localStorage.setItem(SCHEDULER_STORAGE_KEY, addr);
  };

  const handleManualSchedulerSave = (addr: string) => {
    persistScheduler(addr);
  };

  // コントラクトのデプロイ＆レジスター。
  // 「一ウォレット一コントラクト」制約があるため、まずcomputeAddress+hasDeployedで
  // 既にデプロイ済みかどうかを確認する。既にあればそのアドレスをそのまま使い、
  // 未デプロイならdeploy()を実行してからレジスターまで自動で進める。
  const handleDeploy = async () => {
    if (!loginResult || !wallet) {
      setDeployStatus("Please sign in first");
      return;
    }
    setDeploying(true);
    setDeployStatus("Checking...");

    const checkRes = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "computeAddress", ownerAddress: wallet.address }),
    });
    const checkData = await checkRes.json();

    if (checkData.alreadyDeployed) {
      persistScheduler(checkData.predicted);
      setDeployStatus("Using already deployed contract. Registering as approver...");
      await handleRegisterApprover(checkData.predicted);
      setDeploying(false);
      return;
    }

    setDeployStatus("Deploying...");

    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deployFactory",
        userToken: loginResult.userToken,
        walletId: wallet.id,
      }),
    });
    const data = await res.json();

    if (!data.challengeId) {
      setDeployStatus("Deploy failed: " + JSON.stringify(data));
      setDeploying(false);
      return;
    }

    if (!sdk) {
      setDeployStatus("SDK not initialized. Please reload the page.");
      setDeploying(false);
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(data.challengeId, async (error: unknown, result: any) => {
      if (error) {
        setDeploying(false);
        setDeployStatus("Deploy failed: " + JSON.stringify(error));
        return;
      }
      setDeployStatus("Deploy successful. Confirming address...");
      persistScheduler(checkData.predicted);
      setDeployStatus("Registering contract...");
      await handleRegisterApprover(checkData.predicted);
      setDeployStatus("Registering in SchedulerRegistry...");
      const registryRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "registerScheduler",
          userToken: loginResult.userToken,
          walletId: wallet.id,
          schedulerAddress: checkData.predicted,
          name: "",
        }),
      });
      const registryData = await registryRes.json();
      if (registryData.challengeId) {
        sdk.setAuthentication({
          userToken: loginResult.userToken,
          encryptionKey: loginResult.encryptionKey,
        });
        sdk.execute(registryData.challengeId, (regError: unknown) => {
          if (regError) {
            console.error("SchedulerRegistry registration failed:", regError);
          }
        });
      }
      setDeploying(false);
    });
  };

  // --- ホワイトリスト登録 ---------------------------------------------
  const handleAddManual = () => {
    if (!manualAddress) return;
    setWhitelisted((prev) => [...prev, { address: manualAddress, name: manualLabel }]);
    setManualAddress("");
    setManualLabel("");
  };

  // CSVヘッダーの表記ゆれ（Address/address、Label/name等）を吸収するため、
  // すべてのキーを小文字化してから複数の候補名でマッチさせる。
  const handleCsvFile = (file: File) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim().toLowerCase(),
      complete: (results) => {
        const rows = (results.data as any[])
          .map((r) => ({
            address: r.address || r.wallet || r.recipient || "",
            name: r.name || r.label || "",
          }))
          .filter((r) => r.address);
        setCsvEntries(rows);
      },
    });
  };



  // ホワイトリスト一覧を取得（イベントログから最新状態を集計）。
  // 折りたたみパネルを開いたとき・登録成功後に呼ぶ。
  const fetchWhitelist = async () => {
    if (!schedulerAddress) return;
    setWhitelistListLoading(true);
    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "getWhitelist", schedulerAddress }),
    });
    const data = await res.json();
    setWhitelistList(data.whitelist || []);

    const labelRes = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "getWhitelistLabels", schedulerAddress }),
    });
    const labelData = await labelRes.json();
    setWhitelistLabels(labelData.labels || {});

    setWhitelistListLoading(false);
  };

  const toggleWhitelistList = () => {
    const next = !whitelistListOpen;
    setWhitelistListOpen(next);
    if (next && whitelistList.length === 0) {
      fetchWhitelist();
    }
  };

  const handleSubmitWhitelist = async () => {
    if (!loginResult || !wallet || !schedulerAddress) {
      setWhitelistStatus("Sign-in and contract address setup required");
      return;
    }

    const entries = whitelistMode === "manual" ? whitelisted : csvEntries;
    if (entries.length === 0) {
      setWhitelistStatus("No addresses to register");
      return;
    }

    setWhitelistStatus("Registering...");

    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "whitelistBatch",
        userToken: loginResult.userToken,
        walletId: wallet.id,
        schedulerAddress,
        accounts: entries.map((e) => e.address),
      }),
    });
    const data = await res.json();

    if (!data.challengeId) {
      setWhitelistStatus("Challenge creation failed: " + JSON.stringify(data));
      return;
    }

    if (!sdk) {
      setWhitelistStatus("SDK not initialized. Please reload the page.");
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(data.challengeId, async (error: unknown, result: any) => {
      if (error) {
        setWhitelistStatus("Registration failed: " + JSON.stringify(error));
        return;
      }
      setWhitelistStatus(`Registered successfully (${entries.length} item(s))`);
      await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "saveWhitelistLabels",
          schedulerAddress,
          entries: entries.map((e) => ({ address: e.address, label: e.name })),
        }),
      });
      setCsvEntries([]);
      setWhitelisted([]);
      fetchWhitelist();
    });
  };

  // --- Telegram連携 -----------------------------------------------------
  const handleRegisterApprover = async (addressOverride?: string) => {
    const targetAddress = addressOverride ?? schedulerAddress;
    if (!wallet || !targetAddress) {
      setTelegramStatus("Wallet and contract setup required first");
      return;
    }

    const res = await fetch("/api/approver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "register",
        walletAddress: wallet.address,
        schedulerAddress: targetAddress,
      }),
    });
    const data = await res.json();

    if (!data.id) {
      setTelegramStatus("Registration failed: " + JSON.stringify(data));
      return;
    }

    const link = `https://t.me/arc_payroll_approval_bot?start=${data.id}`;
    setTelegramLink(link);
    setTelegramStatus("Enable Telegram notifications using the link below");
  };

  useEffect(() => {
    if (schedulerAddress) fetchWhitelist();
  }, [schedulerAddress]);

  useEffect(() => {
    (async () => {
      if (!schedulerAddress || !wallet) return;
      const res = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "checkContractVersion",
          schedulerAddress,
          ownerAddress: wallet.address,
        }),
      });
      const data = await res.json();
      if (typeof data.isCurrent === "boolean" && !data.isCurrent) {
        setOutdatedInfo({
          isCurrent: false,
          expectedContractAddress: data.expectedContractAddress,
        });
      } else {
        setOutdatedInfo(null);
      }
    })();
  }, [schedulerAddress, wallet]);

  return (
    <div style={{ padding: "20px 20px 8px", minHeight: "100%" }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#0B1220", marginBottom: 4 }}>
        Setting
      </div>
      <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 22 }}>
        Set up your payroll contract and team access
      </div>

      {restoring ? null : !loginResult ? (
        <div style={{ textAlign: "center", marginTop: 60 }}>
          <p style={{ fontSize: 13, color: "#6B7688", marginBottom: 16 }}>
            Sign in to manage settings
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
          {/* Contract card */}
          {outdatedInfo && !outdatedInfo.isCurrent && (
            <div
              style={{
                background: "#FFF4E5",
                border: "1px solid #F5A623",
                borderRadius: 14,
                padding: "12px 14px",
                marginBottom: 16,
                fontSize: 12,
                color: "#8A5A00",
              }}
            >
              <strong>Contract update available.</strong> A newer version of the payroll
              contract is available with additional features. Deploy a new one below to
              upgrade (your whitelist and history will need to be re-created).
            </div>
          )}
          <div
            style={{
              background: "linear-gradient(135deg,#2E5CFF,#5B8CFF)",
              borderRadius: 20,
              padding: "18px 18px 20px",
              marginBottom: 20,
              color: "#fff",
            }}
          >
            <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>Your Contract</div>
            <input
              value={schedulerAddress}
              onChange={(e) => handleManualSchedulerSave(e.target.value)}
              placeholder="0x... (paste deployed scheduler address)"
              style={{
                width: "100%",
                fontSize: 13,
                fontWeight: 700,
                marginBottom: 14,
                fontFamily: "monospace",
                background: "rgba(255,255,255,0.15)",
                border: "none",
                borderRadius: 8,
                padding: "8px 10px",
                color: "#fff",
              }}
            />
            <button
              onClick={handleDeploy}
              disabled={deploying}
              style={{
                background: "rgba(255,255,255,0.2)",
                border: "none",
                borderRadius: 12,
                padding: "10px 16px",
                color: "#fff",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {deploying ? "Deploying..." : "+ Deploy New Payroll Contract"}
            </button>
            {deployStatus && (
              <div style={{ fontSize: 11, marginTop: 10, opacity: 0.9 }}>{deployStatus}</div>
            )}
          </div>

          {/* Whitelist */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0B1220" strokeWidth={2}>
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span style={{ fontSize: 15, fontWeight: 800, color: "#0B1220" }}>Whitelist</span>
          </div>
          <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 14 }}>
            Add wallets manually, or upload a CSV to register many at once.
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              marginBottom: 14,
              background: "#F1F3F8",
              padding: 4,
              borderRadius: 14,
            }}
          >
            <button
              onClick={() => setWhitelistMode("manual")}
              style={{
                flex: 1,
                padding: "9px 0",
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                background: whitelistMode === "manual" ? "#FFFFFF" : "transparent",
                color: whitelistMode === "manual" ? "#2E5CFF" : "#9AA3B2",
                boxShadow: whitelistMode === "manual" ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              }}
            >
              Manual
            </button>
            <button
              onClick={() => setWhitelistMode("csv")}
              style={{
                flex: 1,
                padding: "9px 0",
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                background: whitelistMode === "csv" ? "#FFFFFF" : "transparent",
                color: whitelistMode === "csv" ? "#2E5CFF" : "#9AA3B2",
                boxShadow: whitelistMode === "csv" ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              }}
            >
              CSV Upload
            </button>
          </div>

          {whitelistMode === "manual" ? (
            <div
              style={{
                background: "#FFFFFF",
                border: "1px solid #EEF1F6",
                borderRadius: 16,
                padding: 14,
                marginBottom: 12,
              }}
            >
              <input
                value={manualAddress}
                onChange={(e) => setManualAddress(e.target.value)}
                placeholder="Paste wallet address (0x...)"
                style={{
                  width: "100%",
                  border: "1px solid #EEF1F6",
                  borderRadius: 12,
                  padding: "12px 14px",
                  fontSize: 13,
                  marginBottom: 10,
                  background: "#F7F9FC",
                  boxSizing: "border-box",
                }}
              />
              <input
                value={manualLabel}
                onChange={(e) => setManualLabel(e.target.value)}
                placeholder="Label (optional, e.g. John Smith)"
                style={{
                  width: "100%",
                  border: "1px solid #EEF1F6",
                  borderRadius: 12,
                  padding: "12px 14px",
                  fontSize: 13,
                  marginBottom: 10,
                  background: "#F7F9FC",
                  boxSizing: "border-box",
                }}
              />
              <button
                onClick={handleAddManual}
                style={{
                  width: "100%",
                  background: "#2E5CFF",
                  border: "none",
                  borderRadius: 12,
                  padding: "12px 0",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Add to list
              </button>
              {whitelisted.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {whitelisted.map((w, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#6B7688", fontFamily: "monospace" }}>
                      {w.address}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                background: "#FFFFFF",
                border: "1px solid #EEF1F6",
                borderRadius: 16,
                padding: 14,
                marginBottom: 12,
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleCsvFile(file);
                }}
                style={{ marginBottom: 10, fontSize: 12 }}
              />
              <div style={{ fontSize: 11, color: "#9AA3B2", marginBottom: 8 }}>
                CSV columns: address, name (optional)
              </div>
              {csvEntries.length > 0 && (
                <div style={{ overflowX: "auto", marginTop: 4 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#9AA3B2" }}>
                        <th style={{ padding: "4px 6px" }}>Label</th>
                        <th style={{ padding: "4px 6px" }}>Address</th>
                      </tr>
                    </thead>
                    <tbody>
                      {csvEntries.map((e, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #F1F3F8" }}>
                          <td style={{ padding: "4px 6px" }}>{e.name || "—"}</td>
                          <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>
                            {e.address.slice(0, 6)}...{e.address.slice(-4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 10, color: "#9AA3B2", marginTop: 6 }}>
                    {csvEntries.length} entries loaded
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleSubmitWhitelist}
            style={{
              width: "100%",
              background: "#2E5CFF",
              border: "none",
              borderRadius: 12,
              padding: "12px 0",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              marginBottom: 8,
            }}
          >
            Submit to Whitelist
          </button>
          {whitelistStatus && (
            <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 20 }}>{whitelistStatus}</div>
          )}

          {/* ホワイトリスト一覧（折りたたみ） */}
          <button
            onClick={toggleWhitelistList}
            style={{
              width: "100%",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "#FFFFFF",
              border: "1px solid #EEF1F6",
              borderRadius: 14,
              padding: "12px 14px",
              marginBottom: whitelistListOpen ? 0 : 20,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              color: "#0B1220",
            }}
          >
            <span>View whitelisted addresses ({whitelistList.length})</span>
            <span style={{ color: "#9AA3B2", fontSize: 11 }}>
              {whitelistListOpen ? "▲" : "▼"}
            </span>
          </button>
          {whitelistListOpen && (
            <div
              style={{
                background: "#FFFFFF",
                border: "1px solid #EEF1F6",
                borderTop: "none",
                borderRadius: "0 0 14px 14px",
                padding: 12,
                marginBottom: 20,
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              {whitelistListLoading ? (
                <div style={{ fontSize: 11, color: "#9AA3B2" }}>Loading...</div>
              ) : whitelistList.length === 0 ? (
                <div style={{ fontSize: 11, color: "#9AA3B2" }}>No addresses yet</div>
              ) : (
                whitelistList.map((addr, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 11,
                      fontFamily: "monospace",
                      color: "#6B7688",
                      padding: "6px 0",
                      borderBottom:
                        i < whitelistList.length - 1 ? "1px solid #F1F3F8" : "none",
                    }}
                  >
                    {whitelistLabels[addr.toLowerCase()] && (
                      <div style={{ fontWeight: 700, color: "#0B1220", marginBottom: 2 }}>
                        {whitelistLabels[addr.toLowerCase()]}
                      </div>
                    )}
                    {addr}
                  </div>
                ))
              )}
            </div>
          )}

          {/* パスキー（生体認証/PIN）による送金前確認 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, marginTop: 24 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0B1220" strokeWidth={2}>
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span style={{ fontSize: 15, fontWeight: 800, color: "#0B1220" }}>Passkey Lock</span>
          </div>
          <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 14 }}>
            Require biometric or PIN verification before approving payments.
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "#FFFFFF",
              border: "1px solid #EEF1F6",
              borderRadius: 16,
              padding: 14,
              marginBottom: 20,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220" }}>
              {passkeyEnabled ? "Enabled" : "Disabled"}
            </div>
            <button
              onClick={handleTogglePasskey}
              disabled={passkeyLoading}
              style={{
                width: 48,
                height: 28,
                borderRadius: 14,
                border: "none",
                cursor: "pointer",
                background: passkeyEnabled ? "#2E5CFF" : "#E3E7EF",
                position: "relative",
                opacity: passkeyLoading ? 0.6 : 1,
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "#fff",
                  position: "absolute",
                  top: 3,
                  left: passkeyEnabled ? 23 : 3,
                  transition: "left 0.15s",
                }}
              />
            </button>
          </div>

          {/* Telegram連携 */}
          <div style={{ fontSize: 15, fontWeight: 800, color: "#0B1220", marginBottom: 4 }}>
            Two-Step Approval (Telegram)
          </div>
          <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 14 }}>
            Get notified on Telegram when a payroll schedule needs your approval.
          </div>
          <button
            onClick={() => handleRegisterApprover()}
            style={{
              width: "100%",
              background: "#2E5CFF",
              border: "none",
              borderRadius: 12,
              padding: "12px 0",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              marginBottom: 8,
            }}
          >
            Connect Telegram
          </button>
          {telegramStatus && (
            <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 8 }}>{telegramStatus}</div>
          )}
          {telegramLink && (
            <a
              href={telegramLink}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: "#2E5CFF", wordBreak: "break-all" }}
            >
              {telegramLink}
            </a>
          )}
        </>
      )}
    </div>
  );
}
