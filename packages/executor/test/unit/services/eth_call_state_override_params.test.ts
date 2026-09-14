import { describe, it, expect } from "vitest";
import { UserOperation } from "@skandha/types/lib/contracts/UserOperation";
import { EntryPointV7Service } from "../../../src/services/EntryPointService/versions/0.0.7";
import { EntryPointV8Service } from "../../../src/services/EntryPointService/versions/0.0.8";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const PIMLICO_SIMULATIONS = "0x000000000049883a1a4f4b3c1b1b0ed0c43e5e1e";
const EP_SIMULATIONS = "0x00000000009a9d4ba6ac9a1c0c67f2dd6a2c1a3f";

const userOp: UserOperation = {
  sender: "0x54E3d8E0F9800440581D6d82C7A85F1167090d98",
  nonce: "0x01",
  callData: "0x",
  callGasLimit: "0x3e93f",
  verificationGasLimit: "0x1aaf8",
  preVerificationGas: "0x10a2b",
  maxFeePerGas: "0xd59f80",
  maxPriorityFeePerGas: "0x1e8480",
  signature: "0x",
};

const networkConfig = {
  pimlicoSimulationsContract: PIMLICO_SIMULATIONS,
  epSimulationsContract: EP_SIMULATIONS,
  binarySearchMaxRetries: 3,
  gasFeeInSimulation: false,
} as any;

const logger = {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  debug: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  info: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  warn: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  error: () => {},
} as any;

/**
 * Records every eth_call params array, then fails the call so we never have to
 * mock a decodable return value - the shape of `params` is the whole point.
 */
function recordingClient(): { client: any; params: unknown[][] } {
  const params: unknown[][] = [];
  const client = {
    request: async (req: any) => {
      if (req.method === "eth_call") params.push(req.params);
      throw new Error("recorded");
    },
  };
  return { client, params };
}

type Service = EntryPointV7Service | EntryPointV8Service;

const versions: [string, (client: any) => Service][] = [
  [
    "EntryPoint v0.0.7",
    (client) =>
      new EntryPointV7Service(ENTRY_POINT, networkConfig, client, logger),
  ],
  [
    "EntryPoint v0.0.8",
    (client) =>
      new EntryPointV8Service(ENTRY_POINT, networkConfig, client, logger),
  ],
];

describe.each(versions)(
  "%s eth_call state override param",
  (_name, makeService) => {
    it("omits the third param entirely when no state override is supplied", async () => {
      const { client, params } = recordingClient();
      await makeService(client)
        .simulateHandleOpUsingSimulatorContracts(userOp)
        .catch(() => undefined);

      expect(params.length).toBeGreaterThan(0);
      for (const p of params) {
        // A trailing `undefined` JSON-serializes to `null`, which strict nodes
        // (e.g. Monad) reject with -32602 Invalid params before any execution.
        expect(p).toHaveLength(2);
        expect(p[1]).toEqual("latest");
        expect(JSON.stringify(p)).not.toContain("null");
      }
    });

    it("passes the override as the third param when one is supplied", async () => {
      const { client, params } = recordingClient();
      const overrides = {
        "0x00000000000000000000000000000000deadbeef": { balance: "0x1" },
      } as any;
      await makeService(client)
        .simulateHandleOpUsingSimulatorContracts(userOp, overrides)
        .catch(() => undefined);

      expect(params.length).toBeGreaterThan(0);
      for (const p of params) {
        expect(p).toHaveLength(3);
        expect(p[2]).toEqual(overrides);
      }
    });
  }
);
