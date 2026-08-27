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
  slippageBps: number; // only meaningful when currency === "EURC"
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

type PendingEmailSchedule = {
  id: string;
  scheduler_address: string;
  recipient_email: string;
  amount: string;
  execute_after: number;
  status: string;
  label?: string;
  currency?: string;
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
  const { sdk, loginResult, wallet, restoring, login, deviceId } = useCircleAuth();

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
    slippageBps: 100,
    interval: "",
    date: "today",
  });
  const [manualList, setManualList] = useState<ScheduleEntry[]>([]);
  const [csvEntries, setCsvEntries] = useState<ScheduleEntry[]>([]);
  const [addressBook, setAddressBook] = useState<
    { address: string; display: string; name: string }[]
  >([]);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [pendingList, setPendingList] = useState<PendingSchedule[]>([]);
  const [pendingEmailList, setPendingEmailList] = useState<PendingEmailSchedule[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);

  const handleResend = async (id: string) => {
    setResendingId(id);
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resendNotification", id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert("Failed to resend: " + (data.error || "unknown error"));
      }
    } catch {
      alert("Failed to resend notification.");
    } finally {
      setResendingId(null);
    }
  };

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

    const emailRes = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "listPendingEmailScheduled", schedulerAddress }),
    });
    const emailData = await emailRes.json();
    setPendingEmailList(emailData.pending || []);
  };

  useEffect(() => {
    if (schedulerAddress) fetchPending();
  }, [schedulerAddress]);

  useEffect(() => {
    (async () => {
      if (!schedulerAddress) return;
      const wlRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getWhitelist", schedulerAddress }),
      });
      const wlData = await wlRes.json();
      const addresses: string[] = wlData.whitelist || [];

      const labelRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getWhitelistLabels", schedulerAddress }),
      });
      const labelData = await labelRes.json();

      const emailRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getEmailsForAddresses", addresses }),
      });
      const emailData = await emailRes.json();

      const book = addresses.map((addr) => {
        const lower = addr.toLowerCase();
        const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
        const label = labelData.labels?.[lower];
        const email = emailData.emails?.[lower];
        const name = label || email;
        const combinedLabel = label && email ? `${label} / ${email}` : label || email || "";
        const display = name ? `${name} (${short})` : short;
        return { address: addr, display, name: combinedLabel };
      });
      setAddressBook(book);
    })();
  }, [schedulerAddress]);

  const handleAddManual = () => {
    if (!manualEntry.address || !manualEntry.amount) return;
    setManualList((prev) => [...prev, manualEntry]);
    setManualEntry({
      label: "",
      address: "",
      amount: "",
      currency: "USDC",
      slippageBps: 100,
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
          .map((r) => {
            const currency = (r.currency || "USDC").toUpperCase();
            const parsedSlippage = parseFloat(r.slippage || r.slippage_bps || "");
            return {
              label: r.label || "",
              address: r.address || r.wallet || r.recipient || "",
              amount: r.amount || "",
              currency,
              // CSV "slippage" column is interpreted as a percentage (e.g. "1" = 1%),
              // matching the manual-entry UI's 0.5% / 1% / 2% buttons.
              slippageBps:
                currency === "EURC"
                  ? Number.isFinite(parsedSlippage) && parsedSlippage > 0
                    ? Math.round(parsedSlippage * 100)
                    : 100
                  : 100,
              interval: (r.interval || "").toLowerCase() as "" | "weekly" | "monthly",
              date: r.date || "today",
              whitelisted: null,
            };
          })
          .filter((r) => r.address && r.amount);

        setCsvEntries(rows);


        const resolvedRows = await Promise.all(
          rows.map(async (r) => {
            if (r.address.startsWith("0x")) return r;
            const resolveRes = await fetch("/api/schedule", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "resolveEmail", email: r.address }),
            });
            const resolveData = await resolveRes.json();
            return { ...r, address: resolveData.walletAddress || r.address };
          })
        );
        setCsvEntries(resolvedRows);
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

        const withStatus = resolvedRows.map((r) => ({
          ...r,
          whitelisted: whitelistSet.has(r.address.toLowerCase()),
        }));
        setCsvEntries(withStatus);
      },
    });
  };
  const handleSubmit = async () => {
    if (!schedulerAddress) {
      setSubmitStatus("Please set up the contract in Settings first");
      return;
    }
    const entries = mode === "manual" ? manualList : csvEntries;
    if (entries.length === 0) {
      setSubmitStatus("No schedules to register");
      return;
    }

    // Recipients found on SnapRoll go through the normal path
    // (pending_schedules -> PaymentSchedulerV2). Recipients not yet
    // registered are collected separately -- rather than blocking
    // submission entirely, they're scheduled against email_scheduled_payments
    // so auto-execute.mjs can re-check at execution time and fall back to
    // an EscrowVault escrow if the recipient still hasn't registered by then.
    const resolvedEntries = [];
    const emailScheduledEntries = [];
    for (const e of entries) {
      if (e.address.startsWith("0x")) {
        resolvedEntries.push({
          recipient: e.address,
          amount: toUsdcUnits(e.amount),
          executeAfter: parseDateField(e.date),
          label: e.label || null,
          currency: e.currency || "USDC",
          slippageBps: e.currency === "EURC" ? (e.slippageBps ?? 100) : null,
          intervalSeconds: e.interval ? INTERVAL_SECONDS[e.interval] : null,
        });
        continue;
      }

      const resolveRes = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveEmail", email: e.address }),
      });
      const resolveData = await resolveRes.json();

      if (resolveData.walletAddress) {
        resolvedEntries.push({
          recipient: resolveData.walletAddress,
          amount: toUsdcUnits(e.amount),
          executeAfter: parseDateField(e.date),
          label: e.label || null,
          currency: e.currency || "USDC",
          slippageBps: e.currency === "EURC" ? (e.slippageBps ?? 100) : null,
          intervalSeconds: e.interval ? INTERVAL_SECONDS[e.interval] : null,
        });
      } else {
        // Not registered yet -- schedule via the email path instead of
        // failing the whole submission.
        emailScheduledEntries.push({
          recipientEmail: e.address,
          amount: toUsdcUnits(e.amount),
          executeAfter: parseDateField(e.date),
          label: e.label || null,
          currency: e.currency || "USDC",
          slippageBps: e.currency === "EURC" ? (e.slippageBps ?? 100) : null,
        });
      }
    }
    let submittedCount = 0;

    if (resolvedEntries.length > 0) {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          schedulerAddress,
          entries: resolvedEntries,
        }),
      });
      const data = await res.json();

      if (data.error) {
        setSubmitStatus("Submission failed: " + JSON.stringify(data));
        return;
      }
      submittedCount += data.submitted.length;
    }

    if (emailScheduledEntries.length > 0) {
      const escrowVaultAddress = window.localStorage.getItem("myEscrowVault");
      if (!escrowVaultAddress) {
        setSubmitStatus(
          "Some recipients aren't registered on SnapRoll yet, but no escrow vault address " +
            "was found -- please redeploy your contracts in Settings to get an escrow vault."
        );
        return;
      }

      // USDC approval for the EscrowVault happens at approval time (in
      // approve/page.tsx), not here -- mirrors how pending_schedules works:
      // the creator just records intent in the DB, and whoever approves
      // (which may be a different person) is the one who actually grants
      // the on-chain USDC allowance and, eventually, triggers the escrow.
      const emailRes = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submitEmailScheduled",
          schedulerAddress,
          escrowVaultAddress,
          entries: emailScheduledEntries,
        }),
      });
      const emailData = await emailRes.json();

      if (emailData.error) {
        setSubmitStatus("Submission failed: " + JSON.stringify(emailData));
        return;
      }
      submittedCount += emailData.submitted.length;
    }

    const emailNote =
      emailScheduledEntries.length > 0
        ? ` (${emailScheduledEntries.length} to unregistered recipient(s), held via escrow if they haven't joined by execution time)`
        : "";
    setSubmitStatus(`Submitted (${submittedCount} item(s))${emailNote}. Approvers have been notified.`);
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
                placeholder="Recipient address or SnapRoll email"
                style={{ width: "100%", border: "1px solid #EEF1F6", borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 8, background: "#F7F9FC", boxSizing: "border-box" }}
              />
              {addressBook.length > 0 && (
                <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 8, paddingBottom: 2 }}>
                  {addressBook.map((ab) => (
                    <button
                      key={ab.address}
                      type="button"
                      onClick={() => setManualEntry({ ...manualEntry, address: ab.address, label: ab.name || manualEntry.label })}
                      style={{
                        flexShrink: 0,
                        background: "#EAF0FF",
                        border: "none",
                        borderRadius: 20,
                        padding: "6px 12px",
                        color: "#2E5CFF",
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ab.display}
                    </button>
                  ))}
                </div>
              )}
              <input
                value={manualEntry.amount}
                onChange={(e) => setManualEntry({ ...manualEntry, amount: e.target.value })}
                placeholder="Amount"
                style={{ width: "100%", border: "1px solid #EEF1F6", borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 8, background: "#F7F9FC", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button
                  type="button"
                  onClick={() => setManualEntry({ ...manualEntry, currency: "USDC" })}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    borderRadius: 8,
                    border: manualEntry.currency === "USDC" ? "1px solid #2E5CFF" : "1px solid #EEF1F6",
                    background: manualEntry.currency === "USDC" ? "#EAF0FF" : "#F7F9FC",
                    color: manualEntry.currency === "USDC" ? "#2E5CFF" : "#6B7688",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  USDC
                </button>
                <button
                  type="button"
                  onClick={() => setManualEntry({ ...manualEntry, currency: "EURC" })}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    borderRadius: 8,
                    border: manualEntry.currency === "EURC" ? "1px solid #2E5CFF" : "1px solid #EEF1F6",
                    background: manualEntry.currency === "EURC" ? "#EAF0FF" : "#F7F9FC",
                    color: manualEntry.currency === "EURC" ? "#2E5CFF" : "#6B7688",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  EURC (auto-swap from USDC)
                </button>
              </div>
              {manualEntry.currency === "EURC" && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: "#9AA3B2", marginBottom: 6 }}>
                    Max slippage for the USDC→EURC swap:
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[50, 100, 200].map((bps) => (
                      <button
                        key={bps}
                        type="button"
                        onClick={() => setManualEntry({ ...manualEntry, slippageBps: bps })}
                        style={{
                          flex: 1,
                          padding: "8px 0",
                          borderRadius: 8,
                          border: manualEntry.slippageBps === bps ? "1px solid #2E5CFF" : "1px solid #EEF1F6",
                          background: manualEntry.slippageBps === bps ? "#EAF0FF" : "#F7F9FC",
                          color: manualEntry.slippageBps === bps ? "#2E5CFF" : "#6B7688",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        {(bps / 100).toFixed(1)}%
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {(() => {
                const isEmailRecipient =
                  manualEntry.address.length > 0 && !manualEntry.address.trim().toLowerCase().startsWith("0x");
                return (
                  <>
                    <select
                      value={isEmailRecipient ? "" : manualEntry.interval}
                      disabled={isEmailRecipient}
                      onChange={(e) => setManualEntry({ ...manualEntry, interval: e.target.value as any })}
                      style={{
                        width: "100%",
                        border: "1px solid #EEF1F6",
                        borderRadius: 10,
                        padding: 10,
                        fontSize: 13,
                        marginBottom: isEmailRecipient ? 4 : 8,
                        background: isEmailRecipient ? "#F0F1F4" : "#F7F9FC",
                        color: isEmailRecipient ? "#9AA3B2" : undefined,
                      }}
                    >
                      <option value="">One-time</option>
                      <option value="weekly">Repeat weekly</option>
                      <option value="monthly">Repeat monthly</option>
                    </select>
                    {isEmailRecipient && (
                      <div style={{ fontSize: 11, color: "#9AA3B2", marginBottom: 8 }}>
                        Recurring payments aren't supported yet for recipients who haven't registered on SnapRoll. This will be sent as a one-time payment.
                      </div>
                    )}
                  </>
                );
              })()}
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
                          <td style={{ padding: "4px 6px" }}>{e.interval ? `🔁 ${e.interval}` : "one-time"}</td>
                          <td style={{ padding: "4px 6px" }}>{e.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 10, color: "#9AA3B2", marginTop: 6 }}>
                    {csvEntries.length} entries loaded ·{" "}
                    {csvEntries.filter((e) => e.whitelisted === false).length} not whitelisted ·{" "}
                    {csvEntries.filter((e) => e.interval).length} recurring (🔁 repeats automatically)
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
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 6,
                  }}
                >
                  <div style={{ fontSize: 10, color: "#2E5CFF" }}>
                    Status: {item.status}
                  </div>
                  {item.status === "pending" && (
                    <button
                      onClick={() => handleResend(item.id)}
                      disabled={resendingId === item.id}
                      style={{
                        background: "#F1F3F8",
                        border: "none",
                        borderRadius: 8,
                        padding: "4px 10px",
                        color: "#6B7688",
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: "pointer",
                        opacity: resendingId === item.id ? 0.6 : 1,
                      }}
                    >
                      {resendingId === item.id ? "Sending..." : "Resend notification"}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}

          {pendingEmailList.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220", marginTop: 20, marginBottom: 10 }}>
                Pending (unregistered recipients) ({pendingEmailList.length})
              </div>
              {pendingEmailList.map((item) => (
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
                    {item.label || item.recipient_email}
                  </div>
                  <div style={{ fontSize: 11, color: "#9AA3B2" }}>
                    {fromUsdcUnits(item.amount)} {item.currency || "USDC"} ·{" "}
                    {new Date(item.execute_after * 1000).toLocaleDateString()}
                  </div>
                  <div style={{ fontSize: 10, color: "#8A5A00", marginTop: 6 }}>
                    Status: {item.status}
                    {item.status === "pending" && " (not yet registered on SnapRoll)"}
                    {item.status === "escrowed" && " (funds locked in escrow, awaiting registration)"}
                    {item.status === "migrated" && " (recipient registered, sent normally)"}
                    {item.status === "refunded" && " (expired, refunded to you)"}
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
