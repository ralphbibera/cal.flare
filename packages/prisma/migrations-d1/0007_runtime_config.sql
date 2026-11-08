-- Workers have no Vercel Edge Config. Runtime flags move to D1 with the same missing-key and
-- unreadable-value behavior in packages/lib/server/runtimeConfig.ts.

CREATE TABLE "RuntimeConfig" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "valueJson" TEXT NOT NULL
);

INSERT INTO "RuntimeConfig" ("key", "valueJson") VALUES ('isSignupDisabled', 'false')
ON CONFLICT ("key") DO NOTHING;
