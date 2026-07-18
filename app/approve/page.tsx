"use client";

import { useEffect, useState } from "react";
import { useCircleAuth } from "../components/useCircleAuth";

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

function formatUsdc(amount: string) {
  const n = Number(amount) / 1_000_000;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export default function ApprovePage() {
  const { sdk, loginResult, wallet, restoring, login, logout } = useCircleAuth();

  const [schedulerAddress, setSchedulerAddress] = useState("");
  const [pendingList, setPendingList] = useState<PendingSchedule[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("scheduler");
    if (s) {
      setSchedulerAddress(s);
      window.localStorage.setItem("pendingSchedulerAddress", s);
    } else {
      const saved = window.localStorage.getItem("pendingSchedulerAddress");
      if (saved) setSchedulerAddress(saved);
    }
  }, []);

  const fetchPending = async (address: string) => {
    if (!address) return;
    setPendingLoading(true);
    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "listPending", schedulerAddress: address }),
    });
    const data = await res.json();
    setPendingList(data.pending || []);
    setPendingLoading(false);
  };

  // ログイン・ウォレット取得が完了したら、自動で保留一覧を取得する
  useEffect(() => {
    if (loginResult && wallet && schedulerAddress) {
      fetchPending(schedulerAddress);
    }
  }, [loginResult, wallet, schedulerAddress]);

  const handleApprove = async (item: PendingSchedule) => {
    if (!sdk || !loginResult || !wallet) {
      setStatus("Please sign in first");
      return;
    }

    setProcessingId(item.id);
    setStatus("Checking USDC allowance...");

    const allowanceRes = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "checkAllowance",
        ownerAddress: wallet.address,
        schedulerAddress: item.scheduler_address,
      }),
    });
    const allowanceData = await allowanceRes.json();
    const currentAllowance = BigInt(allowanceData.allowance || "0");
    const requiredAmount = BigInt(item.amount);

    if (currentAllowance < requiredAmount) {
      setStatus("Approving USDC spend limit...");

      const approveRes = await fetch("/api/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approveUsdc",
          userToken: loginResult.userToken,
          walletId: wallet.id,
          schedulerAddress: item.scheduler_address,
        }),
      });
      const approveData = await approveRes.json();

      if (!approveData.challengeId) {
        setStatus("Approve failed: " + JSON.stringify(approveData));
        setProcessingId(null);
        return;
      }

      sdk.setAuthentication({
        userToken: loginResult.userToken,
        encryptionKey: loginResult.encryptionKey,
      });

      const approveOk = await new Promise<boolean>((resolve) => {
        sdk.execute(approveData.challengeId, (error: unknown) => {
          if (error) {
            setStatus("Approve failed: " + JSON.stringify(error));
            resolve(false);
            return;
          }
          setStatus("Approved. Creating schedule...");
          resolve(true);
        });
      });

      if (!approveOk) {
        setProcessingId(null);
        return;
      }
    }

    const requestId = "0x" + item.id.replace(/-/g, "").padStart(64, "0");

    const res = await fetch("/api/circle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approveSchedule",
        userToken: loginResult.userToken,
        walletId: wallet.id,
        schedulerAddress: item.scheduler_address,
        recipient: item.recipient,
        amount: item.amount,
        executeAfter: item.execute_after,
        requestId,
      }),
    });
    const data = await res.json();

    if (!data.challengeId) {
      setStatus("Failed to create challenge: " + JSON.stringify(data));
      setProcessingId(null);
      return;
    }

    sdk.setAuthentication({
      userToken: loginResult.userToken,
      encryptionKey: loginResult.encryptionKey,
    });
    sdk.execute(data.challengeId, async (error: unknown, result: any) => {
      setProcessingId(null);
      if (error) {
        const errAny = error as any;
        if (errAny?.code === 155103 || errAny?.code === 155105) {
          setStatus("Your session has expired. Please sign in again.");
          logout();
          return;
        }
        setStatus("Approval failed: " + JSON.stringify(error));
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

      setStatus("Approved and scheduled successfully");
      fetchPending(schedulerAddress);
    });
  };

  const handleReject = async (item: PendingSchedule) => {
    setProcessingId(item.id);
    await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", id: item.id }),
    });
    setProcessingId(null);
    setStatus("Rejected");
    fetchPending(schedulerAddress);
  };

  return (
    <div style={{ padding: "20px 20px 8px", minHeight: "100%" }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#0B1220", marginBottom: 4 }}>
        Approvals
      </div>
      <div style={{ fontSize: 12, color: "#6B7688", marginBottom: 22 }}>
        Review and approve pending payroll schedules
      </div>

      {restoring ? null : !loginResult ? (
        <div style={{ textAlign: "center", marginTop: 60 }}>
          <p style={{ fontSize: 13, color: "#6B7688", marginBottom: 16 }}>
            Sign in to review approvals
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
          <div
            style={{
              background: "linear-gradient(135deg,#2E5CFF,#5B8CFF)",
              borderRadius: 20,
              padding: "16px 18px",
              marginBottom: 20,
              color: "#fff",
            }}
          >
            <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 4 }}>Contract</div>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace" }}>
              {schedulerAddress
                ? `${schedulerAddress.slice(0, 8)}...${schedulerAddress.slice(-6)}`
                : "not set"}
            </div>
          </div>

          {status && (
            <div
              style={{
                fontSize: 12,
                color: "#2E5CFF",
                background: "#EAF0FF",
                borderRadius: 12,
                padding: "10px 12px",
                marginBottom: 16,
              }}
            >
              {status}
            </div>
          )}

          <div style={{ fontSize: 15, fontWeight: 800, color: "#0B1220", marginBottom: 12 }}>
            Pending ({pendingList.length})
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
                  borderRadius: 16,
                  padding: 14,
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#0B1220" }}>
                    {item.label || `${item.recipient.slice(0, 6)}...${item.recipient.slice(-4)}`}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#0B1220" }}>
                    ${formatUsdc(item.amount)}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#9AA3B2", marginBottom: 12 }}>
                  {item.currency || "USDC"} ·{" "}
                  {new Date(item.execute_after * 1000).toLocaleDateString()}
                  {item.interval_seconds ? " · repeats" : ""}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => handleApprove(item)}
                    disabled={processingId === item.id}
                    style={{
                      flex: 1,
                      background: "#2E5CFF",
                      border: "none",
                      borderRadius: 10,
                      padding: "10px 0",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                      opacity: processingId === item.id ? 0.6 : 1,
                    }}
                  >
                    {processingId === item.id ? "Processing..." : "Approve"}
                  </button>
                  <button
                    onClick={() => handleReject(item)}
                    disabled={processingId === item.id}
                    style={{
                      flex: 1,
                      background: "#FDEDED",
                      border: "none",
                      borderRadius: 10,
                      padding: "10px 0",
                      color: "#E5484D",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                      opacity: processingId === item.id ? 0.6 : 1,
                    }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
