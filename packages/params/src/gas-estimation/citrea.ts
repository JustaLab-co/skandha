import { UserOperation } from "@skandha/types/lib/contracts/UserOperation";
import { IPVGEstimator, IPVGEstimatorWrapper } from "../types/IPVGEstimator.js";

type BigNumberish = bigint | number | `0x${string}` | `${number}` | string;

/**
 * Citrea charges the tx sender (the bundler's relayer) an L1 fee of
 * l1FeeRate (wei/byte, from the block header) * l1DiffSize, deducted from
 * balance outside of EVM gas. The EntryPoint doesn't see it, so it has to be
 * folded into preVerificationGas.
 *
 * eth_estimateDiffSize can't be used: it binary-searches the gas limit and
 * returns the diff size of the last probe (reverted or not), which for
 * EntryPoint calls is an arbitrary partial execution. Instead the diff size
 * is computed from prestate traces of the simulation, using the formula from
 * citrea's calc_diff_size (crates/evm/src/evm/handler.rs).
 */

const DB_ACCOUNT_SIZE_EOA = 41;
const DB_ACCOUNT_SIZE_CONTRACT = 73;
const DB_ACCOUNT_KEY_SIZE = 12;
const STORAGE_SLOT_SIZE = 36 + 32; // key + value
const NEW_ACCOUNT_SIZE = 24 + 8; // account index key + value
const ACCOUNT_DISCOUNTED_PERCENTAGE = 32;
const STORAGE_DISCOUNTED_PERCENTAGE = 66;
const BROTLI_COMPRESSION_PERCENTAGE = 48;
const L1_FEE_OVERHEAD = 2;

// fee vaults (citrea crates/evm/src/evm/mod.rs) are credited without a journal
// entry, so they are not part of the diff
const FEE_VAULTS = [
  "0x3100000000000000000000000000000000000003",
  "0x3100000000000000000000000000000000000004",
  "0x3100000000000000000000000000000000000005",
];

// Citrea counts every slot written during the tx, even if it's restored before the
// end (locks, allowances, swaps), which a prestate diff can't see. Over 135 mainnet
// handleOps the net diff was exact for 96 and at most 78 bytes short, never over.
export const CITREA_DIFF_SIZE_MARGIN = 80;

type PrestateAccount = {
  balance?: string;
  nonce?: number;
  code?: string;
  storage?: Record<string, string>;
};
export type Prestate = Record<string, PrestateAccount>;
export type PrestateDiff = { pre: Prestate; post: Prestate };

export type CitreaDiffSizeOptions = {
  // address the trace was run from, replaced by the relayer (always counted as an EOA)
  traceFrom?: string;
  // slots written by the simulation only (e.g. EntryPointSimulations bookkeeping)
  ignoredStorage?: Record<string, string[]>;
  // 7702 authority: counted as changed, and its code in the trace is an override
  eip7702Authority?: string;
  // block beneficiary, credited without a journal entry like the fee vaults
  coinbase?: string;
  // bytes added to the net diff to cover slots written and restored within the tx
  margin?: number;
};

function calcDiffSize(
  accountBytes: number,
  slots: number,
  newAccounts: number
): number {
  const uncompressed =
    Math.floor((accountBytes * ACCOUNT_DISCOUNTED_PERCENTAGE) / 100) +
    Math.floor(
      (slots * STORAGE_SLOT_SIZE * STORAGE_DISCOUNTED_PERCENTAGE) / 100
    ) +
    newAccounts * NEW_ACCOUNT_SIZE;
  return (
    Math.floor((uncompressed * BROTLI_COMPRESSION_PERCENTAGE) / 100) +
    L1_FEE_OVERHEAD
  );
}

const hasCode = (code?: string): boolean => !!code && code !== "0x";
const isZero = (value?: string): boolean =>
  !value || BigInt(value) === BigInt(0);

/**
 * Returns lower (net state diff) and upper (every touched slot) bounds of the
 * l1DiffSize citrea will charge, and the estimate min(upper, lower + margin)
 */
export function calcCitreaDiffSize(
  diff: PrestateDiff,
  prestate: Prestate,
  options: CitreaDiffSizeOptions = {}
): { lower: number; upper: number; estimate: number } {
  const traceFrom = options.traceFrom?.toLowerCase();
  const coinbase = options.coinbase?.toLowerCase();
  const margin = options.margin ?? CITREA_DIFF_SIZE_MARGIN;
  const authority = options.eip7702Authority?.toLowerCase();
  const ignored: Record<string, Set<bigint>> = {};
  for (const [address, slots] of Object.entries(options.ignoredStorage ?? {})) {
    ignored[address.toLowerCase()] = new Set(slots.map((slot) => BigInt(slot)));
  }

  // the relayer: its nonce always changes, and it's an existing EOA
  let accountBytes = DB_ACCOUNT_SIZE_EOA + DB_ACCOUNT_KEY_SIZE;
  let netSlots = 0;
  let touchedSlots = 0;
  let newAccounts = 0;

  const addresses = new Set(
    [
      ...Object.keys(prestate),
      ...Object.keys(diff.pre),
      ...Object.keys(diff.post),
    ].map((address) => address.toLowerCase())
  );
  const find = (state: Prestate, address: string): PrestateAccount =>
    state[address] ??
    Object.entries(state).find(([key]) => key.toLowerCase() === address)?.[1] ??
    {};

  for (const address of addresses) {
    if (
      address === traceFrom ||
      address === coinbase ||
      FEE_VAULTS.includes(address)
    )
      continue;
    const pre = find(diff.pre, address);
    const post = find(diff.post, address);
    const initial = find(prestate, address);

    const countSlots = (slots: string[]): number =>
      slots.filter((slot) => !ignored[address]?.has(BigInt(slot))).length;
    const net = new Set([
      ...Object.keys(post.storage ?? {}),
      ...Object.keys(pre.storage ?? {}),
    ]);
    const touched = new Set([...net, ...Object.keys(initial.storage ?? {})]);
    const slotsChanged = countSlots([...net]);
    netSlots += slotsChanged;
    touchedSlots += countSlots([...touched]);

    const accountChanged =
      address === authority ||
      post.balance !== undefined ||
      post.nonce !== undefined ||
      post.code !== undefined;
    if (accountChanged) {
      const code = post.code ?? initial.code ?? pre.code;
      accountBytes +=
        (address === authority || hasCode(code)
          ? DB_ACCOUNT_SIZE_CONTRACT
          : DB_ACCOUNT_SIZE_EOA) + DB_ACCOUNT_KEY_SIZE;
    }

    const isNew =
      isZero(initial.balance) &&
      !initial.nonce &&
      (address === authority || !hasCode(initial.code)) &&
      Object.keys(initial.storage ?? {}).length === 0;
    if ((accountChanged || slotsChanged > 0) && isNew) newAccounts++;
  }

  const lower = calcDiffSize(accountBytes, netSlots, newAccounts);
  const upper = calcDiffSize(accountBytes, touchedSlots, newAccounts);
  return {
    lower,
    upper,
    estimate: Math.min(upper, lower + margin),
  };
}

export const estimateCitreaPVG = (
  publicClient: Parameters<IPVGEstimatorWrapper>[0],
  diffSizeMargin: number = CITREA_DIFF_SIZE_MARGIN
): IPVGEstimator => {
  return async (
    _contractAddr: string,
    _data: string,
    initial: BigNumberish,
    options?: {
      contractCreation?: boolean;
      userOp?: UserOperation;
      l1DiffSizeCall?: {
        to: string;
        data: string;
        stateOverride?: Record<string, unknown>;
        ignoredStorage?: Record<string, string[]>;
      };
    }
  ): Promise<bigint> => {
    const userOp = options?.userOp;
    const diffCall = options?.l1DiffSizeCall;
    if (!userOp || !diffCall) {
      throw new Error(
        "Citrea PVG estimation requires userOp and l1DiffSizeCall"
      );
    }

    const trace = (
      tracer: string,
      tracerConfig: Record<string, boolean>
    ): Promise<unknown> =>
      publicClient.request({
        method: "debug_traceCall",
        params: [
          { to: diffCall.to, data: diffCall.data },
          "latest",
          {
            tracer,
            tracerConfig,
            ...(diffCall.stateOverride
              ? { stateOverrides: diffCall.stateOverride }
              : {}),
          },
        ],
      } as any);

    const [latestBlock, diff, prestate, topCall] = await Promise.all([
      publicClient.request({
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      } as any) as Promise<{
        baseFeePerGas?: string;
        l1FeeRate?: string;
        miner?: string;
      }>,
      trace("prestateTracer", { diffMode: true }) as Promise<PrestateDiff>,
      trace("prestateTracer", { diffMode: false }) as Promise<Prestate>,
      // prestate traces of a reverted call are empty instead of failing
      trace("callTracer", { onlyTopCall: true }) as Promise<{
        error?: string;
        revertReason?: string;
      }>,
    ]);
    if (topCall.error) {
      throw new Error(
        `Citrea L1 diff size simulation reverted: ${
          topCall.revertReason ?? topCall.error
        }`
      );
    }

    if (latestBlock.baseFeePerGas == null || latestBlock.l1FeeRate == null) {
      throw new Error("Citrea block is missing baseFeePerGas or l1FeeRate");
    }

    const { estimate } = calcCitreaDiffSize(diff, prestate, {
      // debug_traceCall without `from` runs from the zero address
      traceFrom: "0x0000000000000000000000000000000000000000",
      ignoredStorage: diffCall.ignoredStorage,
      eip7702Authority: userOp.eip7702Auth ? userOp.sender : undefined,
      coinbase: latestBlock.miner,
      margin: diffSizeMargin,
    });
    const l1Fee = BigInt(latestBlock.l1FeeRate) * BigInt(estimate);

    const l2MaxFee = BigInt(userOp.maxFeePerGas);
    const l2PriorityFee =
      BigInt(latestBlock.baseFeePerGas) + BigInt(userOp.maxPriorityFeePerGas);
    const l2Price = l2MaxFee < l2PriorityFee ? l2MaxFee : l2PriorityFee;
    if (l2Price <= BigInt(0)) {
      throw new Error("Citrea PVG estimation requires a non-zero gas price");
    }

    // ceil division so the bundler is never short by rounding
    const l1Gas = (l1Fee + l2Price - BigInt(1)) / l2Price;
    return l1Gas + BigInt(initial);
  };
};
