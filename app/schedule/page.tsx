"use client";

import { useState, useRef, useEffect } from "react";
import Papa from "papaparse";
import { useCircleAuth } from "../components/useCircleAuth";
import { toUsdcUnits, fromUsdcUnits } from "../components/usdc";

const SCHEDULER_STORAGE_KEY = "myPayrollScheduler";

type ScheduleEntry = {
  label: string;
  address: string;
  amount: string;
  currency: string;
  interval: "" | "weekly" | "monthly";
  date: string; // "today" | "tomorrow" | "YYYY/MM/DD"
  whitelisted?: boolean | null; // null = 未確認
};

type PendingSchedule = {
  id: string;
  scheduler_address: string;
  recipient: string;
  amount: string;
  execute_after: number;
  status: string;
  label?: string;
  currency?: string;
  interval_seconds?: number | null;
};

const INTERVAL_SECONDS: Record<string, number> = {
  weekly: 7 * 24 * 60 * 60,
  monthly: 30 * 24 * 60 * 60,
};

function parseDateField(value: string): number {
  const now = new Date();
  if (value === "today") {
    return Math.floor(now.getTime() / 1000);
  }
  if (value === "tomorrow") {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    return Math.floor(t.getTime() / 1000);
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return Math.floor(parsed.getTime() / 1000);
  }
  return Math.floor(now.getTime() / 1000);
}

export default function SchedulePage() {
  const { loginResult, wallet, restoring, login, deviceId } = useCircleAuth();

  const [schedulerAddress, setSchedulerAddress] = useState<string>(
    typeof window !== "undefined"
      ? window.localStorage.getItem(SCHEDULER_STORAGE_KEY) || ""
      : ""
  );

  const [mode, setMode] = useState<"manual" | "csv">("manual");
  const [manualEntry, setManualEntry] = useState<ScheduleEntry>({
    label: "",
    address: "",
    amount: "",
    currency: "USDC",
    interval: "",
    date: "today",
  });
  const [manualList, setManualList] = useState<ScheduleEntry[]>([]);
  const [csvEntries, setCsvEntries] = useState<ScheduleEntry[]>([]);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [pendingList, setPendingList] = useState<PendingSchedule[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);

  const fetchPending = async () => {
    if (!schedulerAddress) return;
    setPendingLoading(true);
    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "listPending", schedulerAddress }),
    });
    const data = await res.json();
    setPendingList(data.pending || []);
    setPendingLoading(false);
  };

  useEffect(() => {
    if (schedulerAddress) fetchPending();
  }, [schedulerAddress]);

  const handleAddManual = () => {
    if (!manualEntry.address || !manualEntry.amount) return;
    setManualList((prev) => [...prev, manualEntry]);
    setManualEntry({
      label: "",
      address: "",
      amount: "",
      currency: "USDC",
      interval: "",
      date: "today",
    });
  };
  const handleCsvFile = async (file: File) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim().toLowerCase(),
      complete: async (results) => {
        const rows: ScheduleEntry[] = (results.data as any[])
          .map((r) => ({
            label: r.label || "",
            address: r.address || r.wallet || r.recipient || "",
            amount: r.amount || "",
            currency: (r.currency || "USDC").toUpperCase(),
            interval: (r.interval || "").toLowerCase() as "" | "weekly" | "monthly",
            date: r.date || "today",
            whitelisted: null,
          }))
          .filter((r) => r.address && r.amount);

        setCsvEntries(rows);

        if (!schedulerAddress) return;
        const wlRes = await fetch("/api/circle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "getWhitelist", schedulerAddress }),
        });
        const wlData = await wlRes.json();
        const whitelistSet = new Set(
          (wlData.whitelist || []).map((a: string) => a.toLowerCase())
        );

        const withStatus = rows.map((r) => ({
          ...r,
          whitelisted: whitelistSet.has(r.address.toLowerCase()),
        }));
        setCsvEntries(withStatus);
      },
    });
  };


  const handleSubmit = async () => {
    if (!schedulerAddress) {
      setSubmitStatus("先にSettingでコントラクトを設定してください");
      return;
    }
    const entries = mode === "manual" ? manualList : csvEntries;
    if (entries.length === 0) {
      setSubmitStatus("登録するスケジュールがありません");
      return;
    }

    setSubmitStatus("送信中...");

    const payload = entries.map((e) => ({
      recipient: e.address,
      amount: toUsdcUnits(e.amount),
      executeAfter: parseDateField(e.date),
      label: e.label || null,
      currency: e.currency || "USDC",
      intervalSeconds: e.interval ? INTERVAL_SECONDS[e.interval] : null,
    }));

    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "submit",
        schedulerAddress,
        entries: payload,
      }),
    });
    const data = await res.json();

    if (data.error) {
      setSubmitStatus("送信失敗: " + JSON.stringify(data));
      return;
    }

    setSubmitStatus(
      `申請完了（${data.submitted.length}件）。責任者への通知を送信しました。`
    );
    setManualList([]);
    setCsvEntries([]);
    fetchPending();
  };

  return (
    <div style={{ padding: "20px 20px 8px", minHeight: "100%" }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#0B1220", marginBottom: 4 }}>
        Schedule
      </div>
      <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 22 }}>
        Create payroll schedules and track approvals
      </div>

      {restoring ? null : !loginResult ? (
        <div style={{ textAlign: "center", marginTop: 60 }}>
          <p style={{ fontSize: 13, color: "#6B7688", marginBottom: 16 }}>
            Sign in to manage schedules
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
              onClick={() => setMode("manual")}
              style={{
                flex: 1,
                padding: "9px 0",
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                background: mode === "manual" ? "#FFFFFF" : "transparent",
                color: mode === "manual" ? "#2E5CFF" : "#9AA3B2",
              }}
            >
              Manual
            </button>
            <button
              onClick={() => setMode("csv")}
              style={{
                flex: 1,
                padding: "9px 0",
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                background: mode === "csv" ? "#FFFFFF" : "transparent",
                color: mode === "csv" ? "#2E5CFF" : "#9AA3B2",
              }}
            >
              CSV Upload
            </button>
          </div>

          {mode === "manual" ? (
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
                value={manualEntry.label}
                onChange={(e) => setManualEntry({ ...manualEntry, label: e.target.value })}
                placeholder="Label (e.g. employee name)"
                style={{ width: "100%", border: "1px solid #EEF1F6", borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 8, background: "#F7F9FC", boxSizing: "border-box" }}
              />
              <input
                value={manualEntry.address}
                onChange={(e) => setManualEntry({ ...manualEntry, address: e.target.value })}
                placeholder="Recipient address (0x...)"
                style={{ width: "100%", border: "1px solid #EEF1F6", borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 8, background: "#F7F9FC", boxSizing: "border-box" }}
              />
              <input
                value={manualEntry.amount}
                onChange={(e) => setManualEntry({ ...manualEntry, amount: e.target.value })}
                placeholder="Amount"
                style={{ width: "100%", border: "1px solid #EEF1F6", borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 8, background: "#F7F9FC", boxSizing: "border-box" }}
              />
              <select
                value={manualEntry.interval}
                onChange={(e) => setManualEntry({ ...manualEntry, interval: e.target.value as any })}
                style={{ width: "100%", border: "1px solid #EEF1F6", borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 8, background: "#F7F9FC" }}
              >
                <option value="">One-time</option>
                <option value="weekly">Repeat weekly</option>
                <option value="monthly">Repeat monthly</option>
              </select>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button
                  type="button"
                  onClick={() => setManualEntry({ ...manualEntry, date: "today" })}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    borderRadius: 8,
                    border: manualEntry.date === "today" ? "1px solid #2E5CFF" : "1px solid #EEF1F6",
                    background: manualEntry.date === "today" ? "#EAF0FF" : "#F7F9FC",
                    color: manualEntry.date === "today" ? "#2E5CFF" : "#6B7688",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => setManualEntry({ ...manualEntry, date: "tomorrow" })}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    borderRadius: 8,
                    border: manualEntry.date === "tomorrow" ? "1px solid #2E5CFF" : "1px solid #EEF1F6",
                    background: manualEntry.date === "tomorrow" ? "#EAF0FF" : "#F7F9FC",
                    color: manualEntry.date === "tomorrow" ? "#2E5CFF" : "#6B7688",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Tomorrow
                </button>
              </div>
              <div style={{ fontSize: 11, color: "#9AA3B2", marginBottom: 6, marginTop: 4 }}>
                Or pick a specific start date:
              </div>
              <input
                type="date"
                value={manualEntry.date === "today" || manualEntry.date === "tomorrow" ? "" : manualEntry.date}
                onChange={(e) => setManualEntry({ ...manualEntry, date: e.target.value })}
                style={{ width: "100%", border: "1px solid #EEF1F6", borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 10, background: "#F7F9FC", boxSizing: "border-box" }}
              />
              <button
                onClick={handleAddManual}
                style={{ width: "100%", background: "#2E5CFF", border: "none", borderRadius: 12, padding: "12px 0", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >
                Add to list
              </button>
              {manualList.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {manualList.map((m, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#6B7688" }}>
                      {m.label || m.address} — {m.amount} {m.currency} ({m.date}{m.interval ? `, ${m.interval}` : ""})
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
                CSV columns: label, address, amount, currency, interval (weekly/monthly), date (today/tomorrow/YYYY-MM-DD)
              </div>
              {csvEntries.length > 0 && (
                <div style={{ overflowX: "auto", marginTop: 4 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#9AA3B2" }}>
                        <th style={{ padding: "4px 6px" }}>Label</th>
                        <th style={{ padding: "4px 6px" }}>Address</th>
                        <th style={{ padding: "4px 6px" }}>Whitelist</th>
                        <th style={{ padding: "4px 6px" }}>Amount</th>
                        <th style={{ padding: "4px 6px" }}>Currency</th>
                        <th style={{ padding: "4px 6px" }}>Interval</th>
                        <th style={{ padding: "4px 6px" }}>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {csvEntries.map((e, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #F1F3F8" }}>
                          <td style={{ padding: "4px 6px" }}>{e.label || "—"}</td>
                          <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>
                            {e.address.slice(0, 6)}...{e.address.slice(-4)}
                          </td>
                          <td style={{ padding: "4px 6px" }}>
                            {e.whitelisted === null ? (
                              <span style={{ color: "#9AA3B2" }}>?</span>
                            ) : e.whitelisted ? (
                              <span style={{ color: "#16A34A" }}>✓</span>
                            ) : (
                              <span style={{ color: "#E5484D" }}>✕</span>
                            )}
                          </td>
                          <td style={{ padding: "4px 6px" }}>{e.amount}</td>
                          <td style={{ padding: "4px 6px" }}>{e.currency}</td>
                          <td style={{ padding: "4px 6px" }}>{e.interval || "one-time"}</td>
                          <td style={{ padding: "4px 6px" }}>{e.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 10, color: "#9AA3B2", marginTop: 6 }}>
                    {csvEntries.length} entries loaded ·{" "}
                    {csvEntries.filter((e) => e.whitelisted === false).length} not whitelisted
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleSubmit}
            style={{ width: "100%", background: "#2E5CFF", border: "none", borderRadius: 12, padding: "12px 0", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}
          >
            Submit Schedule
          </button>
          {submitStatus && (
            <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 24 }}>{submitStatus}</div>
          )}

          <div style={{ fontSize: 15, fontWeight: 800, color: "#0B1220", marginBottom: 12 }}>
            Pending Approvals ({pendingList.length})
          </div>
          {pendingLoading ? (
            <div style={{ fontSize: 12, color: "#9AA3B2" }}>Loading...</div>
          ) : pendingList.length === 0 ? (
            <div style={{ fontSize: 12, color: "#9AA3B2" }}>No pending schedules</div>
          ) : (
            pendingList.map((item) => (
              <div
                key={item.id}
                style={{
                  background: "#FFFFFF",
                  border: "1px solid #EEF1F6",
                  borderRadius: 14,
                  padding: 12,
                  marginBottom: 8,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220" }}>
                  {item.label || item.recipient}
                </div>
                <div style={{ fontSize: 11, color: "#9AA3B2" }}>
                  {fromUsdcUnits(item.amount)} {item.currency || "USDC"} · {new Date(item.execute_after * 1000).toLocaleDateString()}
                  {item.interval_seconds ? " · repeats" : ""}
                </div>
                <div style={{ fontSize: 10, color: "#2E5CFF", marginTop: 4 }}>
                  Status: {item.status}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
