import { describe, it, expect } from "vitest";
import { Eth } from "../../../src/modules/eth";

// the Citrea L1 fee estimation must not change anything on other chains
describe("Citrea PVG estimation isolation", () => {
  const entryPoint = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
  const userOp = {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: BigInt(0),
    callData: "0x",
    callGasLimit: BigInt(1),
    verificationGasLimit: BigInt(1),
    preVerificationGas: BigInt(0),
    maxFeePerGas: BigInt(1),
    maxPriorityFeePerGas: BigInt(1),
    signature: "0x",
  };
  const estimates = {
    executionResult: {
      preOpGas: BigInt(100000),
      paid: BigInt(200000),
      paymasterPostOpGasLimit: BigInt(0),
      paymasterVerificationGasLimit: BigInt(0),
    },
    callGasLimit: BigInt(50000),
    verificationGasLimit: BigInt(60000),
    paymasterVerificationGasLimit: BigInt(0),
  };
  const config = {
    cglMarkupPercent: 0,
    cglMarkup: 0,
    vglMarkupPercent: 0,
    vglMarkup: 0,
    pvgMarkupPercent: 0,
    pvgMarkup: 0,
    paymasterVglMarkupPercent: 0,
    paymasterVglMarkup: 0,
    paymasterPoglMarkupPercent: 0,
    paymasterPoglMarkup: 0,
    citreaDiffSizeMargin: 80,
  };

  const run = async (
    chainId: number
  ): Promise<{ options: string | null; simulationEncodes: number }> => {
    let simulationEncodes = 0;
    let options: string | null = null;
    const entryPointService = {
      calcPreverificationGas: () => 50000,
      encodeHandleOps: () => "0xdead",
      encodeSimulateHandleOp: () => {
        simulationEncodes++;
        return ["0xbeef", {}];
      },
    };
    const skandha = {
      getGasPrice: async () => ({
        maxFeePerGas: BigInt(2),
        maxPriorityFeePerGas: BigInt(1),
      }),
    };
    const eth = new Eth(
      chainId,
      {} as any,
      entryPointService as any,
      {} as any,
      {} as any,
      skandha as any,
      config as any,
      { debug: () => {}, error: () => {} } as any,
      null
    ) as any;
    if (eth.pvgEstimator) {
      eth.pvgEstimator = async (
        _ep: string,
        _data: string,
        initial: bigint,
        opts: Record<string, unknown>
      ) => {
        options = Object.keys(opts).sort().join(",");
        return BigInt(initial);
      };
    }
    await eth.handleSimulationResults(entryPoint, estimates, { ...userOp }, {});
    return { options, simulationEncodes };
  };

  it("passes the same options as before to other L2 estimators", async () => {
    for (const chainId of [10, 8453, 42161, 5000]) {
      expect(await run(chainId)).toEqual({
        options: "contractCreation,userOp",
        simulationEncodes: 0,
      });
    }
  });

  it("does nothing extra on chains without a PVG estimator", async () => {
    for (const chainId of [1, 137, 56]) {
      expect(await run(chainId)).toEqual({
        options: null,
        simulationEncodes: 0,
      });
    }
  });

  it("builds the diff size call only on Citrea", async () => {
    for (const chainId of [4114, 5115]) {
      expect(await run(chainId)).toEqual({
        options: "contractCreation,l1DiffSizeCall,userOp",
        simulationEncodes: 1,
      });
    }
  });
});
