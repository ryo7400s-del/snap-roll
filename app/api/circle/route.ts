import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SECRET_KEY as string
);

const CIRCLE_BASE_URL = "https://api.circle.com";
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY as string;
const FACTORY_ADDRESS = "0xD1bc85bFED447d2EfF2AF484592a1f5eFF555bd4";
const SCHEDULER_REGISTRY_ADDRESS = "0x2E533d62cd6fC613D7a7c309Cd84D3072e733325";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

// EscrowVault verifier: a dedicated Circle Developer-Controlled Wallet whose
// sole purpose is signing "this wallet owns this email" attestations for
// escrow claims. See EscrowVault.sol's contract-level NatSpec for the full
// trust model this depends on -- in short, this signature is the *only*
// authorization check claimEscrow performs, so it must only ever be issued
// after genuine email verification.
const VERIFIER_WALLET_ID = process.env.VERIFIER_WALLET_ID as string;

let developerWalletsClient: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;
function getDeveloperWalletsClient() {
  if (!developerWalletsClient) {
    developerWalletsClient = initiateDeveloperControlledWalletsClient({
      apiKey: CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET as string,
    });
  }
  return developerWalletsClient;
}

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

          const cacheKey = schedulerAddress.toLowerCase();
          const { data: cached } = await supabase
            .from("whitelist_cache")
            .select("*")
            .eq("scheduler_address", cacheKey)
            .maybeSingle();

          const latestBlock = await provider.getBlockNumber();
          const CHUNK_SIZE = 9000;
          const startBlock = cached ? Number(cached.last_scanned_block) + 1 : 52000000;

          const latestStatus = new Map<string, boolean>(
            (cached?.addresses || []).map((a: string) => [a.toLowerCase(), true])
          );

          if (startBlock <= latestBlock) {
            let allEvents: any[] = [];
            for (let from = startBlock; from <= latestBlock; from += CHUNK_SIZE) {
              const to = Math.min(from + CHUNK_SIZE - 1, latestBlock);
              const chunkEvents = await contract.queryFilter(filter, from, to);
              allEvents = allEvents.concat(chunkEvents);
            }

            for (const ev of allEvents) {
              const args = (ev as any).args;
              if (!args) continue;
              latestStatus.set(args.account.toLowerCase(), args.status);
            }

            const whitelist = Array.from(latestStatus.entries())
              .filter(([, status]) => status)
              .map(([address]) => address);

            await supabase.from("whitelist_cache").upsert({
              scheduler_address: cacheKey,
              addresses: whitelist,
              last_scanned_block: latestBlock,
              updated_at: new Date().toISOString(),
            });

            return NextResponse.json({ whitelist }, { status: 200 });
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


      case "getWhitelistLabels": {
        try {
          const { schedulerAddress } = params;
          const { data, error } = await supabase
            .from("whitelist_labels")
            .select("wallet_address, label")
            .eq("scheduler_address", schedulerAddress.toLowerCase());
          if (error) throw error;
          const labels: Record<string, string> = {};
          for (const row of data || []) {
            labels[row.wallet_address.toLowerCase()] = row.label;
          }
          return NextResponse.json({ labels }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "getEmailsForAddresses": {
        try {
          const { addresses } = params;
          const lowerAddresses = (addresses || []).map((a: string) => a.toLowerCase());
          const { data } = await supabase
            .from("user_emails")
            .select("wallet_address, email")
            .in("wallet_address", lowerAddresses);
          const emails: Record<string, string> = {};
          for (const row of data || []) {
            emails[row.wallet_address.toLowerCase()] = row.email;
          }
          return NextResponse.json({ emails }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }
      case "saveWhitelistLabels": {

        try {
          const { schedulerAddress, entries } = params;
          const rows = (entries || [])
            .filter((e: { address: string; label?: string }) => e.label && e.label.trim())
            .map((e: { address: string; label?: string }) => ({
              scheduler_address: schedulerAddress.toLowerCase(),
              wallet_address: e.address.toLowerCase(),
              label: e.label,
            }));
          if (rows.length > 0) {
            const { error } = await supabase
              .from("whitelist_labels")
              .upsert(rows, { onConflict: "scheduler_address,wallet_address" });
            if (error) throw error;
          }
          return NextResponse.json({ success: true }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }


      case "quoteEurcToUsdc": {
        // Reverse-direction Curve get_dy() quote (EURC -> USDC) used to
        // convert a wallet's EURC balance into a USDC-equivalent figure
        // for the home screen's combined Total Balance. This is the
        // pool's current exchange rate, not a real-world FX rate.
        try {
          const { amountEurc } = params;
          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const curveAbi = ["function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)"];
          const curve = new ethers.Contract(
            "0x2D84D79C852f6842AbE0304b70bBaA1506AdD457",
            curveAbi,
            provider
          );
          const dy = await curve.get_dy(1, 0, BigInt(amountEurc));
          return NextResponse.json({ estimatedUsdc: dy.toString() }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "quoteEurc": {
        // Read-only Curve get_dy() quote so the approve screen can show
        // "≈ X EURC" for pending EURC schedules. This intentionally mirrors
        // the on-chain quote path in PaymentSchedulerV2._createSchedule, but
        // reading it here is just for display -- the actual min_dy used at
        // execution time is still computed on-chain against the live rate.
        try {
          const { amountUsdc } = params;
          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const curveAbi = ["function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)"];
          const curve = new ethers.Contract(
            "0x2D84D79C852f6842AbE0304b70bBaA1506AdD457",
            curveAbi,
            provider
          );
          const dy = await curve.get_dy(0, 1, BigInt(amountUsdc));
          return NextResponse.json({ estimatedEurc: dy.toString() }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      // Issues a verifier signature authorizing `claimantAddress` to claim
      // `escrowId` from a specific EscrowVault contract, and logs the
      // issuance to verifier_signatures for audit purposes (see
      // EscrowVault.sol's NatSpec: this signature is the entire security
      // boundary for claimEscrow, so every issuance is recorded so the
      // stated policy -- only sign after confirmed email verification --
      // can be checked after the fact).
      //
      // IMPORTANT: this action itself does NOT verify email ownership. The
      // caller of this endpoint is responsible for having already confirmed
      // (e.g. via Circle's OAuth/email flow) that claimantAddress is
      // controlled by whoever owns recipientEmail before calling this.
      case "issueEscrowClaimSignature": {
        try {
          const { escrowVaultAddress, escrowId, claimantAddress, recipientEmail } = params;
          if (!escrowVaultAddress || escrowId === undefined || !claimantAddress || !recipientEmail) {
            return NextResponse.json(
              { error: "Missing escrowVaultAddress, escrowId, claimantAddress, or recipientEmail" },
              { status: 400 }
            );
          }

          const { ethers } = await import("ethers");
          const messageHash = ethers.solidityPackedKeccak256(
            ["uint256", "address", "address"],
            [escrowId, ethers.getAddress(claimantAddress.toLowerCase()), ethers.getAddress(escrowVaultAddress.toLowerCase())]
          );

          const client = getDeveloperWalletsClient();
          const signResponse = await client.signMessage({
            walletId: VERIFIER_WALLET_ID,
            message: messageHash,
            encodedByHex: true,
          });

          const signature = signResponse.data?.signature;
          if (!signature) {
            return NextResponse.json({ error: "Verifier signing failed" }, { status: 500 });
          }

          const recipientEmailHash = ethers.keccak256(ethers.toUtf8Bytes(recipientEmail.toLowerCase()));

          const { error: logError } = await supabase.from("verifier_signatures").insert({
            escrow_id: escrowId,
            claimant_address: claimantAddress,
            recipient_email_hash: recipientEmailHash,
            signature,
          });
          if (logError) {
            // Log failure is a problem worth knowing about (it breaks the
            // audit trail), but shouldn't block the user's claim -- the
            // signature itself is already valid on-chain regardless.
            console.error("Failed to log verifier signature issuance:", logError.message);
          }

          return NextResponse.json({ signature, recipientEmailHash }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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

      case "checkContractVersion": {
        try {
          const { schedulerAddress, ownerAddress } = params;
          const currentFactory = FACTORY_ADDRESS;

          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const abi = ["function computeAddress(address expectedDeployer) view returns (address)"];
          const factory = new ethers.Contract(currentFactory, abi, provider);

          const expectedAddress = await factory.computeAddress(
            ethers.getAddress(ownerAddress.toLowerCase())
          );

          const isCurrent =
            expectedAddress.toLowerCase() === schedulerAddress.toLowerCase();

          return NextResponse.json(
            {
              isCurrent,
              currentFactoryAddress: currentFactory,
              expectedContractAddress: expectedAddress,
            },
            { status: 200 }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "computeAddress": {
        try {
          const { ownerAddress } = params;
          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const abi = ["function computeAddress(address expectedDeployer) view returns (address)", "function hasDeployed(address) view returns (bool)"];
          const normalizedAddress = ethers.getAddress(ownerAddress.toLowerCase());
          const factory = new ethers.Contract(FACTORY_ADDRESS, abi, provider);
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
              contractAddress: FACTORY_ADDRESS,
              abiFunctionSignature: "deploy()",
              abiParameters: [],
              feeLevel: "MEDIUM",
              // Explicit gasLimit override: deploy() uses CREATE2 to deploy the
              // full PaymentSchedulerV2 bytecode (~15KB), which can cause Circle's
              // automatic gas estimation to fail (ESTIMATION_ERROR) now that the
              // contract includes the EURC/Curve swap logic. A generous fixed
              // limit avoids relying on estimation for this specific call.
              gasLimit: "5000000",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "checkTransactionStatus": {
        const { userToken, walletId } = params;
        const res = await fetch(
          `${CIRCLE_BASE_URL}/v1/w3s/transactions?walletIds=${walletId}&pageSize=1`,
          {
            headers: {
              Authorization: `Bearer ${CIRCLE_API_KEY}`,
              "X-User-Token": userToken,
            },
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        const latestTx = data.data?.transactions?.[0];
        return NextResponse.json(
          {
            state: latestTx?.state,
            errorReason: latestTx?.errorReason,
            errorDetails: latestTx?.errorDetails,
            txId: latestTx?.id,
          },
          { status: 200 }
        );
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

      case "registerScheduler": {
        const { userToken, walletId, schedulerAddress, name } = params;
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
              contractAddress: SCHEDULER_REGISTRY_ADDRESS,
              abiFunctionSignature: "register(address,string)",
              abiParameters: [schedulerAddress, name || ""],
              feeLevel: "MEDIUM",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      // Needed before re-registering after a contract migration: the
      // registry only allows one scheduler per owner at a time
      // (AlreadyRegistered), so switching to a new PaymentSchedulerV2
      // requires unregistering the old one first.
      case "unregisterScheduler": {
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
              contractAddress: SCHEDULER_REGISTRY_ADDRESS,
              abiFunctionSignature: "unregister()",
              abiParameters: [],
              feeLevel: "MEDIUM",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "getRegistryStatus": {
        try {
          const { ownerAddress, schedulerAddress } = params;
          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const abi = ["function schedulerOf(address) view returns (address)"];
          const normalizedAddress = ethers.getAddress(ownerAddress.toLowerCase());
          const registry = new ethers.Contract(SCHEDULER_REGISTRY_ADDRESS, abi, provider);
          const registered = await registry.schedulerOf(normalizedAddress);

          // schedulerOf returns whichever contract this owner last registered,
          // which after a contract migration is likely the OLD scheduler
          // address, not the current one. Checking only "is it non-zero"
          // (the previous behavior) incorrectly showed "registered" forever
          // once any contract had ever been registered, even after switching
          // to a brand new one that was never actually registered itself.
          const isRegistered = schedulerAddress
            ? registered.toLowerCase() === schedulerAddress.toLowerCase()
            : registered !== ethers.ZeroAddress;

          return NextResponse.json({ isRegistered, registeredScheduler: registered }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "findScheduleId": {
        try {
          const { schedulerAddress, requestId } = params;
          const { ethers } = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://arc-testnet.drpc.org");
          const abi = [
            "function scheduleCount() view returns (uint256)",
            "function getSchedule(uint256) view returns (tuple(address recipient, uint256 amount, uint64 executeAfter, uint64 intervalSeconds, bool active, bool useEURC, uint16 slippageBps, bytes32 requestId))",
          ];
          const contract = new ethers.Contract(schedulerAddress, abi, provider);
          const count = await contract.scheduleCount();
          let foundId: number | null = null;
          for (let i = 0; i < Number(count); i++) {
            const s = await contract.getSchedule(i);
            if (s.requestId.toLowerCase() === requestId.toLowerCase()) {
              foundId = i;
              break;
            }
          }
          if (foundId === null) {
            return NextResponse.json({ error: "Schedule not found on-chain" }, { status: 404 });
          }
          return NextResponse.json({ scheduleId: foundId }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "updateScheduleAmount": {
        const { userToken, walletId, schedulerAddress, scheduleId, newAmount } = params;
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
              abiFunctionSignature: "updateScheduleAmount(uint256,uint256)",
              abiParameters: [scheduleId, newAmount],
              feeLevel: "MEDIUM",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "toggleSchedule": {
        const { userToken, walletId, schedulerAddress, scheduleId, active } = params;
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
              abiFunctionSignature: "toggleSchedule(uint256,bool)",
              abiParameters: [scheduleId, active],
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
        const {
          userToken,
          walletId,
          schedulerAddress,
          recipient,
          amount,
          executeAfter,
          requestId,
          intervalSeconds,
          useEURC,
          slippageBps,
        } = params;

        // Route to the correct on-chain function based on whether this is a
        // recurring schedule and/or an EURC auto-swap schedule. Previously
        // this always called the one-time createScheduleFor, which silently
        // dropped interval_seconds even for schedules marked as recurring in
        // the DB - the on-chain schedule was created as one-time regardless.
        const isRecurring = !!intervalSeconds && intervalSeconds > 0;

        let abiFunctionSignature: string;
        let abiParameters: unknown[];

        if (useEURC) {
          abiFunctionSignature =
            "createRecurringScheduleWithEURC(address,uint256,uint64,uint64,bool,uint16,bytes32)";
          abiParameters = [
            recipient,
            amount,
            executeAfter,
            intervalSeconds || 0,
            true,
            slippageBps ?? 100,
            requestId,
          ];
        } else if (isRecurring) {
          abiFunctionSignature = "createRecurringScheduleFor(address,uint256,uint64,uint64,bytes32)";
          abiParameters = [recipient, amount, executeAfter, intervalSeconds, requestId];
        } else {
          abiFunctionSignature = "createScheduleFor(address,uint256,uint64,bytes32)";
          abiParameters = [recipient, amount, executeAfter, requestId];
        }

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
              abiFunctionSignature,
              abiParameters,
              feeLevel: "MEDIUM",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "approveSchedulesBatch": {
        const {
          userToken,
          walletId,
          schedulerAddress,
          recipients,
          amounts,
          executeAfters,
          intervalSecondsArr,
          useEURCArr,
          slippageBpsArr,
          requestIds,
        } = params;
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
              // Switched from createSchedulesForBatch (one-time only, no EURC)
              // to createRecurringSchedulesForBatchWithEURC so a single batch
              // approval can mix one-time/recurring and USDC/EURC schedules.
              abiFunctionSignature:
                "createRecurringSchedulesForBatchWithEURC(address[],uint256[],uint64[],uint64[],bool[],uint16[],bytes32[])",
              abiParameters: [
                recipients,
                amounts,
                executeAfters,
                intervalSecondsArr,
                useEURCArr,
                slippageBpsArr,
                requestIds,
              ],
              feeLevel: "MEDIUM",
              // This now deploys the same per-item EURC/Curve-swap logic used
              // by single-schedule approval, so give it the same generous
              // fixed gas limit rather than relying on estimation.
              gasLimit: "5000000",
            }),
          }
        );
        const data = await res.json();
        if (!res.ok) return NextResponse.json(data, { status: res.status });
        return NextResponse.json(data.data, { status: 200 });
      }

      case "checkInstantSendLimit": {
        try {
          const { walletAddress, amount } = params;
          const { data: limits } = await supabase
            .from("instant_send_limits")
            .select("*")
            .eq("wallet_address", walletAddress.toLowerCase())
            .maybeSingle();
          const perTxLimit = limits?.per_tx_limit ?? 500;
          const dailyLimit = limits?.daily_limit ?? 2000;

          if (Number(amount) > perTxLimit) {
            return NextResponse.json(
              { allowed: false, reason: `Exceeds per-transaction limit of $${perTxLimit}` },
              { status: 200 }
            );
          }

          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: history } = await supabase
            .from("instant_send_history")
            .select("amount")
            .eq("wallet_address", walletAddress.toLowerCase())
            .gte("created_at", since);

          const spentToday = (history || []).reduce((sum, r) => sum + Number(r.amount), 0);
          if (spentToday + Number(amount) > dailyLimit) {
            return NextResponse.json(
              {
                allowed: false,
                reason: `Exceeds daily limit of $${dailyLimit} (already sent $${spentToday} today)`,
              },
              { status: 200 }
            );
          }

          return NextResponse.json({ allowed: true }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "instantSend": {
        try {
          const { userToken, walletId, recipient, amount, currency } = params;
          // Sends whatever the wallet already holds -- USDC or EURC -- with
          // no swap involved. Unlike scheduled EURC payments (which convert
          // USDC -> EURC on-chain via PaymentSchedulerV2 + Curve), instant
          // send goes straight through Circle's transfer API, so the wallet
          // must already hold EURC for a "EURC" instant send to succeed.
          const tokenAddress = currency === "EURC" ? EURC_ADDRESS : USDC_ADDRESS;

          const balanceRes = await fetch(
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
          const balanceData = await balanceRes.json();
          const matchedToken = (balanceData.data?.tokenBalances || []).find(
            (t: any) =>
              t.token?.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase()
          );

          if (!matchedToken) {
            return NextResponse.json(
              { error: `${currency === "EURC" ? "EURC" : "USDC"} token not found in this wallet` },
              { status: 404 }
            );
          }

          const res = await fetch(
            `${CIRCLE_BASE_URL}/v1/w3s/user/transactions/transfer`,
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
                tokenId: matchedToken.token.id,
                destinationAddress: recipient,
                amounts: [amount],
                feeLevel: "MEDIUM",
              }),
            }
          );
          const data = await res.json();
          if (!res.ok) return NextResponse.json(data, { status: res.status });
          return NextResponse.json(data.data, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      case "recordInstantSend": {
        try {
          const { walletAddress, recipient, amount, txHash } = params;
          await supabase.from("instant_send_history").insert({
            wallet_address: walletAddress.toLowerCase(),
            recipient,
            amount,
            tx_hash: txHash || null,
          });
          return NextResponse.json({ success: true }, { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("Circle API route error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
