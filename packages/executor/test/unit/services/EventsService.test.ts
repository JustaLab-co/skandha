import { describe, it, expect, vi } from "vitest";
import { PublicClient } from "viem";
import { EntryPointV8EventsService } from "../../../src/services/EventsService/versions/0.0.8";
import { logger } from "../../mocks";

const ENTRY_POINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

type GetLogsArgs = { fromBlock: bigint; toBlock?: bigint };

function createService(head: () => bigint, range = 100) {
  const fakeClient = {
    getBlockNumber: vi.fn(async () => head()),
    getLogs: vi.fn(async (_args: GetLogsArgs): Promise<unknown[]> => []),
  };
  const client = fakeClient as unknown as PublicClient;
  const unused = {} as never;
  const service = new EntryPointV8EventsService(
    ENTRY_POINT,
    1,
    unused,
    client,
    unused,
    unused,
    unused,
    unused,
    logger,
    4000,
    true,
    range
  );
  const poll = (): Promise<void> => service.pollEvents(client);
  const lastRange = (): [bigint, bigint | undefined] => {
    const args = fakeClient.getLogs.mock.calls.at(-1)![0];
    return [args.fromBlock, args.toBlock];
  };
  return { fakeClient, poll, lastRange };
}

describe("EntryPointV8EventsService polling (eventsPollingRange unset)", () => {
  it("keeps the original open-ended query and cursor logic", async () => {
    let head = 1000n;
    const { fakeClient, poll, lastRange } = createService(() => head, 0);
    await poll();
    expect(lastRange()).toEqual([999n, undefined]);
    expect(fakeClient.getLogs.mock.calls.at(-1)![0]).not.toHaveProperty(
      "toBlock"
    );

    // no events: cursor jumps to the head fetched before getLogs
    head = 300000n;
    await poll();
    expect(lastRange()).toEqual([1001n, undefined]);
    await poll();
    expect(lastRange()).toEqual([300001n, undefined]);

    // events returned: cursor moves to the last event's block
    head = 300100n;
    fakeClient.getLogs.mockResolvedValueOnce([
      { eventName: "SignatureAggregatorChanged", blockNumber: 300050n, args: {} },
    ]);
    await poll();
    await poll();
    expect(lastRange()).toEqual([300051n, undefined]);

    // failure: cursor not advanced, same fromBlock is retried
    fakeClient.getLogs.mockRejectedValueOnce(new Error("upstream error"));
    await poll();
    expect(lastRange()).toEqual([300101n, undefined]);
    await poll();
    expect(lastRange()).toEqual([300101n, undefined]);
  });

  it("does not guard against overlapping polls", async () => {
    const { fakeClient, poll } = createService(() => 1000n, 0);
    let release: (logs: unknown[]) => void = () => {};
    fakeClient.getLogs.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    );
    const first = poll();
    while (fakeClient.getLogs.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await poll();
    release([]);
    await first;
    expect(fakeClient.getLogs).toHaveBeenCalledTimes(2);
  });
});

describe("EntryPointV8EventsService polling (eventsPollingRange set)", () => {
  it("starts from head - 1 and always passes an explicit toBlock", async () => {
    const { poll, lastRange } = createService(() => 1000n);
    await poll();
    expect(lastRange()).toEqual([999n, 1000n]);
  });

  it("queries bounded chunks and catches up to head when no events are returned", async () => {
    let head = 1000n;
    const { poll, lastRange } = createService(() => head, 100);
    await poll();

    head = 1250n;
    await poll();
    expect(lastRange()).toEqual([1001n, 1100n]);
    await poll();
    expect(lastRange()).toEqual([1101n, 1200n]);
    await poll();
    expect(lastRange()).toEqual([1201n, 1250n]);
  });

  it("retries the same range when getLogs fails, then advances", async () => {
    let head = 1000n;
    const { fakeClient, poll, lastRange } = createService(() => head, 100);
    await poll();

    head = 1050n;
    fakeClient.getLogs.mockRejectedValueOnce(new Error("upstream error"));
    await poll();
    expect(lastRange()).toEqual([1001n, 1050n]);
    await poll();
    expect(lastRange()).toEqual([1001n, 1050n]);

    head = 1060n;
    await poll();
    expect(lastRange()).toEqual([1051n, 1060n]);
  });

  it("skips the cycle instead of sending an inverted range when head is behind the cursor", async () => {
    let head = 1000n;
    const { fakeClient, poll, lastRange } = createService(() => head);
    await poll();
    expect(fakeClient.getLogs).toHaveBeenCalledTimes(1);

    // a lagging rpc node reports an older head, then head has not moved yet
    head = 990n;
    await poll();
    head = 1000n;
    await poll();
    expect(fakeClient.getLogs).toHaveBeenCalledTimes(1);

    head = 1001n;
    await poll();
    expect(lastRange()).toEqual([1001n, 1001n]);
  });

  it("does not run overlapping polls", async () => {
    const { fakeClient, poll } = createService(() => 1000n);
    let release: (logs: unknown[]) => void = () => {};
    fakeClient.getLogs.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    );
    const first = poll();
    while (fakeClient.getLogs.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await poll();
    release([]);
    await first;
    expect(fakeClient.getLogs).toHaveBeenCalledTimes(1);
    expect(fakeClient.getBlockNumber).toHaveBeenCalledTimes(1);
  });
});
