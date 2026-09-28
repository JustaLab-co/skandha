import { UserOperation } from "@skandha/types/lib/contracts/UserOperation";
import { PublicClient, Transport, Chain, Account, RpcSchema } from "viem";

type BigNumberish = bigint | number | `0x${string}` | `${number}` | string;

export type IPVGEstimatorWrapper = (
  publicClient: PublicClient<
    Transport,
    Chain | undefined,
    Account | undefined,
    RpcSchema | undefined
  >
) => IPVGEstimator;

export type IPVGEstimator = (
  contractAddr: string,
  data: string,
  initial: BigNumberish, // initial amount of gas. It will be added to the estimated gas
  options?: {
    contractCreation?: boolean;
    userOp?: UserOperation;
    // non-reverting call that performs the userop's state writes (used for state-diff based L1 fees, e.g. Citrea)
    l1DiffSizeCall?: {
      to: string;
      data: string;
      stateOverride?: Record<string, unknown>;
      // slots the call writes that the real handleOps doesn't
      ignoredStorage?: Record<string, string[]>;
    };
  }
) => Promise<bigint>;
