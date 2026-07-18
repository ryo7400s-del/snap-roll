"use client";

import { useState, useEffect } from "react";
import { useCircleAuth } from "../components/useCircleAuth";

type ScheduleRow = {
  id: string;
  scheduler_address: string;
  recipient: string;
  amount: string;
  execute_after: number;
  status: string;
  label?: string;
  currency?: string;
};

function formatUsdc(amount: string) {
  const n = Number(amount) / 1_000_000;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function dateKey(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#F5A623",
  approved: "#2E5CFF",
  executed: "#16A34A",
  rejected: "#E5484D",
};

export default function DashboardPage() {
  const { loginResult, restoring, login } = useCircleAuth();

  const [schedulerAddress, setSchedulerAddress] = useState("");
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("myPayrollScheduler");
    if (saved) setSchedulerAddress(saved);
  }, []);

  useEffect(() => {
    (async () => {
      if (!schedulerAddress) return;
      setLoading(true);
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "listAll", schedulerAddress }),
      });
      const data = await res.json();
      setSchedules(data.schedules || []);
      setLoading(false);
    })();
  }, [schedulerAddress]);

  const schedulesByDate = new Map<string, ScheduleRow[]>();
  for (const s of schedules) {
    const key = dateKey(s.execute_after);
    if (!schedulesByDate.has(key)) schedulesByDate.set(key, []);
    schedulesByDate.get(key)!.push(s);
  }

  const firstDayOfMonth = new Date(viewMonth.year, viewMonth.month, 1);
  const daysInMonth = new Date(viewMonth.year, viewMonth.month + 1, 0).getDate();
  const startWeekday = firstDayOfMonth.getDay();

  const calendarCells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) calendarCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calendarCells.push(d);

  const monthLabel = firstDayOfMonth.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });

  const selectedSchedules = selectedDate ? schedulesByDate.get(selectedDate) || [] : [];

  // approved（承認済み）だがまだexecuted/rejectedになっていないもの＝
  // 実行待ちのスケジュール。GitHub Actionsの次回実行を待っている状態。
  const now = Math.floor(Date.now() / 1000);
  const awaitingExecution = schedules.filter((s) => s.status === "approved");
  const [awaitingOpen, setAwaitingOpen] = useState(false);

  const handleExportCsv = async () => {
    if (!schedulerAddress) return;
    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "exportCsv", schedulerAddress }),
    });
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "payroll-history.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: "20px 20px 8px", minHeight: "100%" }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#0B1220", marginBottom: 4 }}>
        Dashboard
      </div>
      <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 22 }}>
        Upcoming and past payroll schedules
      </div>

      {restoring ? null : !loginResult ? (
        <div style={{ textAlign: "center", marginTop: 60 }}>
          <p style={{ fontSize: 13, color: "#6B7688", marginBottom: 16 }}>
            Sign in to view your dashboard
          </p>
          <button
            onClick={login}
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <button
              onClick={() =>
                setViewMonth((prev) => {
                  const m = prev.month - 1;
                  return m < 0 ? { year: prev.year - 1, month: 11 } : { year: prev.year, month: m };
                })
              }
              style={{ border: "none", background: "none", fontSize: 16, color: "#2E5CFF", cursor: "pointer" }}
            >
              ‹
            </button>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0B1220" }}>{monthLabel}</div>
            <button
              onClick={() =>
                setViewMonth((prev) => {
                  const m = prev.month + 1;
                  return m > 11 ? { year: prev.year + 1, month: 0 } : { year: prev.year, month: m };
                })
              }
              style={{ border: "none", background: "none", fontSize: 16, color: "#2E5CFF", cursor: "pointer" }}
            >
              ›
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 4,
              marginBottom: 8,
              fontSize: 10,
              color: "#9AA3B2",
              textAlign: "center",
            }}
          >
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <div key={i}>{d}</div>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 4,
              marginBottom: 20,
            }}
          >
            {calendarCells.map((day, i) => {
              if (day === null) return <div key={i} />;
              const key = `${viewMonth.year}-${viewMonth.month}-${day}`;
              const dayItems = schedulesByDate.get(key) || [];
              const isSelected = selectedDate === key;

              return (
                <button
                  key={i}
                  onClick={() => setSelectedDate(dayItems.length > 0 ? key : null)}
                  style={{
                    aspectRatio: "1",
                    border: isSelected ? "2px solid #2E5CFF" : "1px solid #EEF1F6",
                    borderRadius: 10,
                    background: dayItems.length > 0 ? "#EAF0FF" : "#FFFFFF",
                    cursor: dayItems.length > 0 ? "pointer" : "default",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 2,
                  }}
                >
                  <span style={{ fontSize: 11, color: "#0B1220" }}>{day}</span>
                  {dayItems.length > 0 && (
                    <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
                      {dayItems.slice(0, 3).map((s, idx) => (
                        <div
                          key={idx}
                          style={{
                            width: 4,
                            height: 4,
                            borderRadius: "50%",
                            background: STATUS_COLORS[s.status] || "#9AA3B2",
                          }}
                        />
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>


          {/* 承認済み・未実行（GitHub Actionsの次回実行待ち） */}
          <button
            onClick={() => setAwaitingOpen(!awaitingOpen)}
            style={{
              width: "100%",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "#FFFFFF",
              border: "1px solid #EEF1F6",
              borderRadius: 14,
              padding: "12px 14px",
              marginBottom: awaitingOpen ? 0 : 16,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              color: "#0B1220",
            }}
          >
            <span>Approved, awaiting execution ({awaitingExecution.length})</span>
            <span style={{ color: "#9AA3B2", fontSize: 11 }}>{awaitingOpen ? "▲" : "▼"}</span>
          </button>
          {awaitingOpen && (
            <div
              style={{
                background: "#FFFFFF",
                border: "1px solid #EEF1F6",
                borderTop: "none",
                borderRadius: "0 0 14px 14px",
                padding: 12,
                marginBottom: 16,
              }}
            >
              {awaitingExecution.length === 0 ? (
                <div style={{ fontSize: 11, color: "#9AA3B2" }}>Nothing pending execution</div>
              ) : (
                awaitingExecution.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "8px 0",
                      borderBottom: "1px solid #F1F3F8",
                      fontSize: 11,
                    }}
                  >
                    <span>
                      {s.label || `${s.recipient.slice(0, 6)}...${s.recipient.slice(-4)}`}
                    </span>
                    <span style={{ color: "#6B7688" }}>
                      ${formatUsdc(s.amount)} ·{" "}
                      {s.execute_after <= now ? "Next run: within 6h" : new Date(s.execute_after * 1000).toLocaleDateString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
          {selectedDate && selectedSchedules.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220", marginBottom: 8 }}>
                Schedules on this day
              </div>
              {selectedSchedules.map((s) => (
                <div
                  key={s.id}
                  style={{
                    background: "#FFFFFF",
                    border: "1px solid #EEF1F6",
                    borderRadius: 14,
                    padding: 12,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220" }}>
                      {s.label || `${s.recipient.slice(0, 6)}...${s.recipient.slice(-4)}`}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#0B1220" }}>
                      ${formatUsdc(s.amount)}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: STATUS_COLORS[s.status] || "#9AA3B2",
                      textTransform: "uppercase",
                    }}
                  >
                    {s.status}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#9AA3B2", marginBottom: 20 }}>
            {Object.entries(STATUS_COLORS).map(([key, color]) => (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
                {key}
              </div>
            ))}
          </div>

          <button
            onClick={handleExportCsv}
            style={{
              width: "100%",
              background: "#0B1220",
              border: "none",
              borderRadius: 12,
              padding: "12px 0",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              marginBottom: 20,
            }}
          >
            Download History (CSV)
          </button>

          {loading && <div style={{ fontSize: 12, color: "#9AA3B2" }}>Loading...</div>}
        </>
      )}
    </div>
  );
}
