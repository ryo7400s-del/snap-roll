"use client";

import { useState } from "react";

const SCHEDULER_ADDRESS = "0x2478DB80727eF7AD46337bd53c17c7b6fca16a4b";

type Entry = {
  recipient: string;
  amount: string;
  executeAfter: string; // datetime-local文字列
};

export default function SubmitPage() {
  const [entries, setEntries] = useState<Entry[]>([
    { recipient: "", amount: "", executeAfter: "" },
  ]);
  const [status, setStatus] = useState<string | null>(null);

  const updateEntry = (index: number, field: keyof Entry, value: string) => {
    setEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, [field]: value } : e))
    );
  };

  const addRow = () => {
    setEntries((prev) => [...prev, { recipient: "", amount: "", executeAfter: "" }]);
  };

  const removeRow = (index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    setStatus("Submitting...");

    const payload = entries
      .filter((e) => e.recipient && e.amount && e.executeAfter)
      .map((e) => ({
        recipient: e.recipient,
        amount: e.amount,
        executeAfter: Math.floor(new Date(e.executeAfter).getTime() / 1000),
      }));

    if (payload.length === 0) {
      setStatus("No valid entries");
      return;
    }

    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "submit",
        schedulerAddress: SCHEDULER_ADDRESS,
        entries: payload,
      }),
    });
    const data = await res.json();

    if (data.error) {
      setStatus("Submission failed: " + JSON.stringify(data));
      return;
    }

    setStatus(
      `Submitted (${data.submitted.length} item(s)). Approvers have been notified. Please wait for approval.`
    );
    setEntries([{ recipient: "", amount: "", executeAfter: "" }]);
  };

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Payroll Schedule Request</h1>
      <p>Entries will be recorded on-chain after approver confirmation.</p>

      {entries.map((entry, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            border: "1px solid #ccc",
            padding: 12,
            marginBottom: 8,
            maxWidth: 400,
          }}
        >
          <label>
            Recipient Address
            <input
              type="text"
              value={entry.recipient}
              onChange={(e) => updateEntry(i, "recipient", e.target.value)}
              placeholder="0x..."
              style={{ width: "100%" }}
            />
          </label>
          <label>
            Amount (USDC base units)
            <input
              type="text"
              value={entry.amount}
              onChange={(e) => updateEntry(i, "amount", e.target.value)}
              placeholder="1000000"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            Execution Time
            <input
              type="datetime-local"
              value={entry.executeAfter}
              onChange={(e) => updateEntry(i, "executeAfter", e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          {entries.length > 1 && (
            <button onClick={() => removeRow(i)}>Remove row</button>
          )}
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={addRow}>+ Add row</button>
        <button onClick={handleSubmit}>Submit Request</button>
      </div>

      {status && <p style={{ marginTop: 16 }}>{status}</p>}
    </main>
  );
}
