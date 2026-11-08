import { beforeEach, describe, expect, it, vi } from "vitest";
import famulorAdd from "../famulor/api/add";
import famulorConfig from "../famulor/config.json";
import linearAdd from "../linear/api/add";
import linearConfig from "../linear/config.json";
import qrCodeAdd from "../qr_code/api/add";
import qrCodeConfig from "../qr_code/config.json";
import weatherAdd from "../weather_in_your_calendar/api/add";
import weatherConfig from "../weather_in_your_calendar/config.json";

const { prisma } = vi.hoisted(() => ({
  prisma: { credential: { create: vi.fn() } },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

type CatalogHandler = {
  appType: string;
  slug: string;
  variant: string;
  supportsMultipleInstalls: boolean;
  redirect?: { newTab: boolean; url: string };
  createCredential: (args: { user: { id: number }; appType: string; slug: string }) => Promise<unknown>;
};

const apps = [
  {
    name: "Famulor",
    handler: famulorAdd as unknown as CatalogHandler,
    config: famulorConfig,
    redirectUrl: "https://docs.famulor.io/en/ai-assistants/cal-com-scheduling",
    configMatch: {
      slug: "famulor",
      type: "famulor_automation",
      variant: "automation",
      externalLink: { url: "https://www.famulor.io", newTab: true },
    },
  },
  {
    name: "Linear",
    handler: linearAdd as unknown as CatalogHandler,
    config: linearConfig,
    redirectUrl: "https://linear.app/settings/integrations/google-calendar",
    configMatch: {
      slug: "linear",
      type: "linear_other",
      variant: "other",
      dependencies: ["google-calendar"],
      externalLink: { url: "https://linear.app/settings/integrations/google-calendar", newTab: true },
    },
  },
  {
    name: "QR Code",
    handler: qrCodeAdd as unknown as CatalogHandler,
    config: qrCodeConfig,
    redirectUrl: undefined,
    configMatch: {
      slug: "qr_code",
      type: "qr_code_other",
      variant: "other",
      extendsFeature: "EventType",
      isOAuth: false,
    },
  },
  {
    name: "Weather in your Calendar",
    handler: weatherAdd as unknown as CatalogHandler,
    config: weatherConfig,
    redirectUrl: undefined,
    configMatch: {
      slug: "weather_in_your_calendar",
      type: "weather_in_your_calendar_other",
      variant: "other",
      isOAuth: false,
    },
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.create.mockResolvedValue({ id: 1 });
});

describe.each(apps)("$name catalog install", ({ handler, config, redirectUrl, configMatch }) => {
  it("installs the catalog app with an empty credential key", async () => {
    expect(handler).toMatchObject({
      appType: configMatch.type,
      slug: configMatch.slug,
      variant: configMatch.variant,
      supportsMultipleInstalls: false,
    });
    expect(handler.redirect?.url).toBe(redirectUrl);
    expect(config).toMatchObject(configMatch);

    await handler.createCredential({ user: { id: 1 }, appType: handler.appType, slug: handler.slug });

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: handler.appType, key: {}, userId: 1, appId: handler.slug },
    });
  });
});
