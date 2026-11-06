import { describe, expect, it, vi } from "vitest";
import { findMatchingKeysetRows, scanKeysetBatches } from "./keyset-scan";

const fetchFrom = (rows: number[]) =>
  vi.fn(async ({ after, take }: { after?: number; take: number }) =>
    rows.filter((row) => after === undefined || row > after).slice(0, take)
  );

describe("keyset scan", () => {
  it("resumes after the previous key and stops on a short batch", async () => {
    const fetchRows = fetchFrom([1, 2, 3, 4, 5]);
    const batches: number[][] = [];
    for await (const rows of scanKeysetBatches({ fetchRows, getKey: (row) => row, after: 1, take: 2 })) {
      batches.push(rows);
    }
    expect(batches).toEqual([[2, 3], [4, 5], []]);
  });

  it("fetches nothing further when the consumer breaks", async () => {
    const fetchRows = fetchFrom([1, 2, 3, 4, 5]);
    for await (const _rows of scanKeysetBatches({ fetchRows, getKey: (row) => row, take: 2 })) break;
    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it("collects matches across every batch", async () => {
    const fetchRows = fetchFrom([1, 2, 3, 4, 5, 6]);
    const matches = (row: number) => row % 2 === 0;
    const matched = await findMatchingKeysetRows({ fetchRows, getKey: (row) => row, take: 4, matches });
    expect(matched).toEqual([2, 4, 6]);
  });
});
