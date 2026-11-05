import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  moduleFileExtensions: ["ts", "js", "json"],
  rootDir: ".",
  moduleNameMapper: {
    "@/(.*)": "<rootDir>/src/$1",
    "test/(.*)": "<rootDir>/test/$1",
  },
  testEnvironment: "node",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "[/\\\\]generated[/\\\\]prisma[/\\\\]internal[/\\\\](class\\.ts|query_compiler_bg\\.js)$":
      "<rootDir>/../../../packages/prisma/tooling/jest-transform.cjs",
    "[/\\\\]node_modules[/\\\\]ky[/\\\\].+\\.js$":
      "<rootDir>/../../../packages/prisma/tooling/jest-transform.cjs",
    "^.+\\.ts$": "ts-jest",
  },
  setupFiles: ["<rootDir>/test/setEnvVars.ts"],
  testPathIgnorePatterns: ["/dist/", "/node_modules/"],
  transformIgnorePatterns: ["/dist/", "/node_modules/(?!ky/)"],
};

export default config;
