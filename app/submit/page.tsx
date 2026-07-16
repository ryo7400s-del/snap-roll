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
    setStatus("送信中...");

    const payload = entries
      .filter((e) => e.recipient && e.amount && e.executeAfter)
      .map((e) => ({
        recipient: e.recipient,
        amount: e.amount,
        executeAfter: Math.floor(new Date(e.executeAfter).getTime() / 1000),
      }));

    if (payload.length === 0) {
      setStatus("有効な入力がありません");
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
      setStatus("送信失敗: " + JSON.stringify(data));
      return;
    }

    setStatus(
      `申請完了（${data.submitted.length}件）。責任者への通知を送信しました。責任者の承認をお待ちください。`
    );
    setEntries([{ recipient: "", amount: "", executeAfter: "" }]);
  };

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>給与スケジュール申請</h1>
      <p>入力した内容は責任者の承認後にオンチェーンへ登録されます。</p>

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
            受取人アドレス
            <input
              type="text"
              value={entry.recipient}
              onChange={(e) => updateEntry(i, "recipient", e.target.value)}
              placeholder="0x..."
              style={{ width: "100%" }}
            />
          </label>
          <label>
            金額（USDC最小単位）
            <input
              type="text"
              value={entry.amount}
              onChange={(e) => updateEntry(i, "amount", e.target.value)}
              placeholder="1000000"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            実行可能時刻
            <input
              type="datetime-local"
              value={entry.executeAfter}
              onChange={(e) => updateEntry(i, "executeAfter", e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          {entries.length > 1 && (
            <button onClick={() => removeRow(i)}>この行を削除</button>
          )}
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={addRow}>+ 行を追加</button>
        <button onClick={handleSubmit}>申請を送信</button>
      </div>

      {status && <p style={{ marginTop: 16 }}>{status}</p>}
    </main>
  );
}
