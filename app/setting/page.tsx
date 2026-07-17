"use client";

import { useState, useRef, useEffect } from "react";
import Papa from "papaparse";
import { useCircleAuth } from "../components/useCircleAuth";

const FACTORY_ADDRESS = "0x0BECA7A71062830C0De5320c3EB6892099DDF9D2";

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

  const [schedulerAddress, setSchedulerAddress] = useState<string>(
    typeof window !== "undefined"
      ? window.localStorage.getItem(SCHEDULER_STORAGE_KEY) || ""
      : ""
  );
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<string | null>(null);

  const [whitelistMode, setWhitelistMode] = useState<"manual" | "csv">("manual");
  const [manualAddress, setManualAddress] = useState("");
  const [csvEntries, setCsvEntries] = useState<WhitelistEntry[]>([]);
  const [whitelisted, setWhitelisted] = useState<WhitelistEntry[]>([]);
  const [whitelistStatus, setWhitelistStatus] = useState<string | null>(null);
  const [whitelistList, setWhitelistList] = useState<string[]>([]);
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
      setDeployStatus("先にログインしてください");
      return;
    }
    setDeploying(true);
    setDeployStatus("確認中...");

    const checkRes = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "computeAddress", ownerAddress: wallet.address }),
    });
    const checkData = await checkRes.json();

    if (checkData.alreadyDeployed) {
      persistScheduler(checkData.predicted);
      setDeployStatus("既にデプロイ済みのコントラクトを使用します。責任者として登録します...");
      await handleRegisterApprover(checkData.predicted);
      setDeploying(false);
      return;
    }

    setDeployStatus("デプロイ中...");

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
      setDeployStatus("デプロイ失敗: " + JSON.stringify(data));
      setDeploying(false);
      return;
    }

    if (!sdk) {
      setDeployStatus("SDKが初期化されていません。ページを再読み込みしてください。");
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
        setDeployStatus("デプロイ失敗: " + JSON.stringify(error));
        return;
      }
      setDeployStatus("デプロイ成功。アドレスを確認しています...");
      persistScheduler(checkData.predicted);
      setDeployStatus("コントラクトを登録しています...");
      await handleRegisterApprover(checkData.predicted);
      setDeploying(false);
    });
  };

  // --- ホワイトリスト登録 ---------------------------------------------
  const handleAddManual = () => {
    if (!manualAddress) return;
    setWhitelisted((prev) => [...prev, { address: manualAddress, name: "" }]);
    setManualAddress("");
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
      setWhitelistStatus("ログイン・コントラクトアドレスの設定が必要です");
      return;
    }

    const entries = whitelistMode === "manual" ? whitelisted : csvEntries;
    if (entries.length === 0) {
      setWhitelistStatus("登録するアドレスがありません");
      return;
    }

    setWhitelistStatus("登録中...");

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
      setWhitelistStatus("チャレンジ作成失敗: " + JSON.stringify(data));
      return;
    }

    if (!sdk) {
      setWhitelistStatus("SDKが初期化されていません。ページを再読み込みしてください。");
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(data.challengeId, (error: unknown, result: any) => {
      if (error) {
        setWhitelistStatus("登録失敗: " + JSON.stringify(error));
        return;
      }
      setWhitelistStatus(`登録成功（${entries.length}件）`);
      setCsvEntries([]);
      setWhitelisted([]);
      fetchWhitelist();
    });
  };

  // --- Telegram連携 -----------------------------------------------------
  const handleRegisterApprover = async (addressOverride?: string) => {
    const targetAddress = addressOverride ?? schedulerAddress;
    if (!wallet || !targetAddress) {
      setTelegramStatus("先にウォレット取得・コントラクト設定が必要です");
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
      setTelegramStatus("登録失敗: " + JSON.stringify(data));
      return;
    }

    const link = `https://t.me/arc_payroll_approval_bot?start=${data.id}`;
    setTelegramLink(link);
    setTelegramStatus("下のリンクからTelegramで通知を有効化してください");
  };

  useEffect(() => {
    if (schedulerAddress) fetchWhitelist();
  }, [schedulerAddress]);

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
                <div style={{ fontSize: 11, color: "#6B7688" }}>
                  {csvEntries.length} entries loaded
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
                    {addr}
                  </div>
                ))
              )}
            </div>
          )}

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
