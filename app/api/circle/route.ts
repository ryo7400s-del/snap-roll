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

      case "getBalance": {
        const { userToken, walletId } = params;
        const res = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/wallets/${walletId}/balances`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });

      }

      case "getWhitelist": {
        try {
          const { schedulerAddress } = params;
          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const abi = ["event WhitelistUpdated(address indexed account, bool status)"];
          const contract = new ethers.Contract(schedulerAddress, abi, provider);
          const filter = contract.filters.WhitelistUpdated();

          const latestBlock = await provider.getBlockNumber();
          const CHUNK_SIZE = 9000;
          const deployBlock = 52000000;
          let allEvents: any[] = [];

          for (let from = deployBlock; from <= latestBlock; from += CHUNK_SIZE) {
            const to = Math.min(from + CHUNK_SIZE - 1, latestBlock);
            const chunkEvents = await contract.queryFilter(filter, from, to);
            allEvents = allEvents.concat(chunkEvents);
          }

          const latestStatus = new Map<string, boolean>();
          for (const ev of allEvents) {
            const args = (ev as any).args;
            if (!args) continue;
            latestStatus.set(args.account.toLowerCase(), args.status);
          }

          const whitelist = Array.from(latestStatus.entries())
            .filter(([, status]) => status)
            .map(([address]) => address);

          return NextResponse.json({ whitelist }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("getWhitelist error:", message);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "checkAllowance": {
        try {
          const { ownerAddress, schedulerAddress } = params;
          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const usdcAbi = ["function allowance(address owner, address spender) view returns (uint256)"];
          const usdc = new ethers.Contract("0x3600000000000000000000000000000000000000", usdcAbi, provider);
          const allowance = await usdc.allowance(
            ethers.getAddress(ownerAddress.toLowerCase()),
            ethers.getAddress(schedulerAddress.toLowerCase())
          );
          return NextResponse.json({ allowance: allowance.toString() }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "approveUsdc": {
        const { userToken, walletId, schedulerAddress } = params;
        const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
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
              contractAddress: "0x3600000000000000000000000000000000000000",
              abiFunctionSignature: "approve(address,uint256)",
              abiParameters: [schedulerAddress, MAX_UINT256],
              feeLevel: "MEDIUM",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "computeAddress": {
        try {
          const { ownerAddress } = params;
          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const abi = ["function computeAddress(address expectedDeployer) view returns (address)", "function hasDeployed(address) view returns (bool)"];
          const normalizedAddress = ethers.getAddress(ownerAddress.toLowerCase());
          const factory = new ethers.Contract("0x48c2A4571C8a7A2074AD153C08488734f3A3411E", abi, provider);
          const predicted = await factory.computeAddress(normalizedAddress);
          const alreadyDeployed = await factory.hasDeployed(normalizedAddress);
          return NextResponse.json({ predicted, alreadyDeployed }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("computeAddress error:", message);
          return NextResponse.json({ error: message }, { status: 500 });
        }
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
              contractAddress: "0x48c2A4571C8a7A2074AD153C08488734f3A3411E",
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

            case "approveSchedule": {
        const { userToken, walletId, schedulerAddress, recipient, amount, executeAfter, requestId } = params;
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
              abiFunctionSignature: "createScheduleFor(address,uint256,uint64,bytes32)",
              abiParameters: [recipient, amount, executeAfter, requestId],
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
