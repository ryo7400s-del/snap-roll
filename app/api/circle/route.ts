import { NextResponse } from "next/server";

const CIRCLE_BASE_URL = "https://api.circle.com";
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY as string;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, ...params } = body ?? {};

    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }

    switch (action) {
      case "createDeviceToken": {
        const { deviceId } = params;
        const res = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/users/social/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CIRCLE_API_KEY}`,
          },
          body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), deviceId }),
        });
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "initializeUser": {
        const { userToken } = params;
        const res = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/user/initialize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CIRCLE_API_KEY}`,
            "X-User-Token": userToken,
          },
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            accountType: "EOA",
            blockchains: ["ARC-TESTNET"],
          }),
        });
        const data = await res.json();
        if (data.code === 155106) {
          return NextResponse.json({ alreadyInitialized: true }, { status: 200 });
        }
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "listWallets": {
        const { userToken } = params;
        const res = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/wallets`, {
          method: "GET",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            Authorization: `Bearer ${CIRCLE_API_KEY}`,
            "X-User-Token": userToken,
          },
        });
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "deployFactory": {
        const { userToken, walletId } = params;
        const res = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/user/transactions/contractExecution`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
            body: JSON.stringify({
              idempotencyKey: crypto.randomUUID(),
              walletId,
              contractAddress: "0x0BECA7A71062830C0De5320c3EB6892099DDF9D2",
              abiFunctionSignature: "deploy()",
              abiParameters: [],
              feeLevel: "MEDIUM",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "whitelistBatch": {
        const { userToken, walletId, schedulerAddress, accounts } = params;
        const res = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/user/transactions/contractExecution`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
            body: JSON.stringify({
              idempotencyKey: crypto.randomUUID(),
              walletId,
              contractAddress: schedulerAddress,
              abiFunctionSignature: "addToWhitelistBatch(address[])",
              abiParameters: [accounts],
              feeLevel: "MEDIUM",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "createSchedulesBatch": {
        const { userToken, walletId, schedulerAddress, recipients, amounts, executeAfters } = params;
        const res = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/user/transactions/contractExecution`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
            body: JSON.stringify({
              idempotencyKey: crypto.randomUUID(),
              walletId,
              contractAddress: schedulerAddress,
              abiFunctionSignature: "createSchedulesBatch(address[],uint256[],uint64[])",
              abiParameters: [recipients, amounts, executeAfters],
              feeLevel: "MEDIUM",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("Circle API route error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
