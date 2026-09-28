import { describe, it, expect } from "vitest";
import {
  calcCitreaDiffSize,
  estimateCitreaPVG,
  CITREA_DIFF_SIZE_MARGIN,
} from "@skandha/params/lib/gas-estimation/citrea.js";
import traces from "../../fixtures/citrea/handleOpsTraces.json";

// handleOps txs from Citrea mainnet (chain 4114) with their prestate traces and receipt l1DiffSize
describe("calcCitreaDiffSize", () => {
  for (const trace of traces as any[]) {
    it(`covers the l1DiffSize charged for ${trace.hash}`, () => {
      const { lower, upper, estimate } = calcCitreaDiffSize(
        trace.diff,
        trace.prestate,
        { traceFrom: trace.from, eip7702Authority: trace.authority }
      );
      expect(lower).toEqual(trace.lower);
      expect(lower).toBeLessThanOrEqual(trace.actual);
      expect(upper).toBeGreaterThanOrEqual(trace.actual);
      expect(estimate).toBeGreaterThanOrEqual(trace.actual);
      expect(estimate).toBeLessThanOrEqual(lower + CITREA_DIFF_SIZE_MARGIN);
    });
  }

  it("is exact when nothing is written and restored within the tx", () => {
    const exact = (traces as any[]).filter((t) => t.lower === t.actual);
    expect(exact.length).toBeGreaterThan(0);
  });

  it("ignores simulation-only slots and the trace sender", () => {
    const ep = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
    const from = "0x0000000000000000000000000000000000000000";
    const slot = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
    const diff = {
      pre: { [ep]: { storage: { [slot(1)]: slot(1), [slot(5)]: slot(0) } } },
      post: {
        [ep]: { storage: { [slot(1)]: slot(2), [slot(5)]: slot(7) } },
        [from]: { nonce: 1 },
      },
    };
    const prestate = {
      [ep]: { code: "0x60", balance: "0x1", storage: diff.pre[ep].storage },
    };
    const withSim = calcCitreaDiffSize(diff, prestate, {
      traceFrom: from,
      ignoredStorage: { [ep]: ["0x5"] },
    });
    const single = calcCitreaDiffSize(
      {
        pre: { [ep]: { storage: { [slot(1)]: slot(1) } } },
        post: { [ep]: { storage: { [slot(1)]: slot(2) } } },
      },
      {
        [ep]: { code: "0x60", balance: "0x1", storage: { [slot(1)]: slot(1) } },
      }
    );
    expect(withSim.lower).toEqual(single.lower);
  });

  it("uses the configured margin", () => {
    const trace = (traces as any[]).find((t) => t.lower !== t.actual);
    const opts = { traceFrom: trace.from, eip7702Authority: trace.authority };
    const { lower, upper } = calcCitreaDiffSize(
      trace.diff,
      trace.prestate,
      opts
    );
    const withMargin = (margin: number): number =>
      calcCitreaDiffSize(trace.diff, trace.prestate, { ...opts, margin })
        .estimate;
    expect(withMargin(0)).toEqual(lower);
    expect(withMargin(10)).toEqual(Math.min(upper, lower + 10));
    expect(withMargin(1e9)).toEqual(upper);
  });

  it("excludes the block coinbase like the fee vaults", () => {
    const coinbase = "0x00000000000000000000000000000000000c0ffe";
    const diff = {
      pre: { [coinbase]: { balance: "0x1" } },
      post: { [coinbase]: { balance: "0x2" } },
    };
    const prestate = { [coinbase]: { balance: "0x1" } };
    expect(calcCitreaDiffSize(diff, prestate, { coinbase }).lower).toEqual(
      calcCitreaDiffSize({ pre: {}, post: {} }, {}).lower
    );
    expect(calcCitreaDiffSize(diff, prestate).lower).toBeGreaterThan(
      calcCitreaDiffSize({ pre: {}, post: {} }, {}).lower
    );
  });

  describe("estimateCitreaPVG", () => {
    const trace = (traces as any[])[0];
    const client = (reverted: boolean) =>
      ({
        request: async ({ method, params }: any) => {
          if (method === "eth_getBlockByNumber")
            return {
              baseFeePerGas: "0xf4240",
              l1FeeRate: "0x119be6378",
              miner: "0x3100000000000000000000000000000000000005",
            };
          const { tracer, tracerConfig } = params[2];
          if (tracer === "callTracer")
            return reverted ? { error: "execution reverted" } : {};
          return tracerConfig.diffMode ? trace.diff : trace.prestate;
        },
      } as any);
    const options = {
      userOp: {
        sender: trace.from,
        maxFeePerGas: BigInt(2000000),
        maxPriorityFeePerGas: BigInt(100),
      } as any,
      l1DiffSizeCall: { to: "0x", data: "0x" },
    };

    it("throws when the traced simulation reverts", async () => {
      // prestate traces of a reverted call are empty, which would price the L1 fee at ~0
      await expect(
        estimateCitreaPVG(client(true))("0x", "0x", 0, options)
      ).rejects.toThrow("simulation reverted");
    });

    it("adds l1FeeRate * diff size, in gas at the userop gas price", async () => {
      const pvg = await estimateCitreaPVG(client(false), 0)(
        "0x",
        "0x",
        1000,
        options
      );
      const { lower } = calcCitreaDiffSize(trace.diff, trace.prestate, {
        traceFrom: "0x0000000000000000000000000000000000000000",
      });
      const l2Price = BigInt(1000000 + 100);
      const l1Fee = BigInt(0x119be6378) * BigInt(lower);
      expect(pvg).toEqual(
        (l1Fee + l2Price - BigInt(1)) / l2Price + BigInt(1000)
      );
    });
  });
});
