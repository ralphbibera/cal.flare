import { prepareLocalD1 } from "./localD1";

// Migrate and seed the preview Worker's local D1 before any test worker opens it.
export default async function globalSetup() {
  await prepareLocalD1();
}
