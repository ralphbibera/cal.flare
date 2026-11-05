const DEFAULT_SCAN_BATCH_SIZE = 500;

export type KeysetPage<Key> = { after?: Key; take: number };

type KeysetScan<Row, Key> = {
  fetchRows: (page: KeysetPage<Key>) => Promise<Row[]>;
  getKey: (row: Row) => Key;
  after?: Key;
  take?: number;
};

export async function* scanKeysetBatches<Row, Key>({
  fetchRows,
  getKey,
  after,
  take = DEFAULT_SCAN_BATCH_SIZE,
}: KeysetScan<Row, Key>): AsyncGenerator<Row[]> {
  let cursor = after;
  while (true) {
    const rows = await fetchRows({ after: cursor, take });
    yield rows;
    if (rows.length < take) return;
    cursor = getKey(rows[rows.length - 1]);
  }
}

export async function findMatchingKeysetRows<Row, Key>({
  matches,
  ...scan
}: KeysetScan<Row, Key> & { matches: (row: Row) => boolean }): Promise<Row[]> {
  const matched: Row[] = [];
  for await (const rows of scanKeysetBatches(scan)) {
    for (const row of rows) {
      if (matches(row)) matched.push(row);
    }
  }
  return matched;
}
