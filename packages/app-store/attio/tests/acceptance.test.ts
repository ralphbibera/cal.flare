import type { CalServerSession } from "@calcom/features/auth/lib/cal-server-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { add } from "../api";
import attioApp from "../api/add";

const { createDefaultInstallation } = vi.hoisted(() => ({
  createDefaultInstallation: vi.fn(),
}));

vi.mock("@calcom/app-store/_utils/installation", () => ({ createDefaultInstallation }));

const user = { id: 1, email: "jane@example.com", name: "Jane" } as CalServerSession["user"];
const credential = { id: 7, type: "attio_crm", appId: "attio", userId: 1, key: {} };

beforeEach(() => {
  vi.resetAllMocks();
  createDefaultInstallation.mockResolvedValue(credential);
});

describe("Attio install", () => {
  it("declares a link-only CRM install that redirects to the installed app list", () => {
    expect(attioApp).toMatchObject({
      appType: "attio_crm",
      variant: "crm",
      slug: "attio",
      handlerType: "add",
      supportsMultipleInstalls: false,
      redirect: { newTab: false, url: "/apps/installed/crm" },
    });
    expect(add).toBe(attioApp);
    expect(attioApp.redirect).not.toHaveProperty("key");
  });

  it("creates the installation with an empty credential key", async () => {
    const created = await attioApp.createCredential({
      appType: attioApp.appType,
      user,
      slug: attioApp.slug,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: "attio_crm",
      user,
      slug: "attio",
      key: {},
      teamId: undefined,
    });
    expect(created).toBe(credential);
    expect(created.key).toEqual({});
    expect(attioApp.redirect).not.toHaveProperty("key");
  });

  it("installs for a team when a team id is supplied", async () => {
    await attioApp.createCredential({
      appType: attioApp.appType,
      user,
      slug: attioApp.slug,
      teamId: 12,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: "attio_crm",
      user,
      slug: "attio",
      key: {},
      teamId: 12,
    });
  });
});
