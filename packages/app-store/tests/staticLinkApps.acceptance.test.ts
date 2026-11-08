import type { AppDeclarativeHandler } from "@calcom/types/AppHandler";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addCampfire from "../campfire/api/add";
import campfireConfig from "../campfire/config.json";
import addDemodesk from "../demodesk/api/add";
import demodeskConfig from "../demodesk/config.json";
import addDialpad from "../dialpad/api/add";
import dialpadConfig from "../dialpad/config.json";
import addDiscord from "../discord/api/add";
import discordConfig from "../discord/config.json";
import addEightxeight from "../eightxeight/api/add";
import eightxeightConfig from "../eightxeight/config.json";
import addElementCall from "../element-call/api/add";
import elementCallConfig from "../element-call/config.json";
import addFacetime from "../facetime/api/add";
import facetimeConfig from "../facetime/config.json";
import addHorizonWorkrooms from "../horizon-workrooms/api/add";
import horizonWorkroomsConfig from "../horizon-workrooms/config.json";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    credential: { create: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

vi.mock("@calcom/lib/logger", () => {
  const getSubLogger = () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    getSubLogger,
  });
  return { default: { ...getSubLogger(), getSubLogger } };
});

type StaticLinkApp = {
  name: string;
  handler: AppDeclarativeHandler;
  config: {
    slug: string;
    type: string;
    variant: string;
    categories: string[];
    appData: { location: { linkType: string; urlRegExp: string } };
  };
  acceptedUrl: string;
  rejectedUrl: string;
};

const STATIC_LINK_APPS: StaticLinkApp[] = [
  {
    name: "Campfire",
    handler: addCampfire,
    config: campfireConfig,
    acceptedUrl: "https://party.campfire.to/your-team",
    rejectedUrl: "https://party.campfire.to.evil.example/your-team",
  },
  {
    name: "Demodesk",
    handler: addDemodesk,
    config: demodeskConfig,
    acceptedUrl: "https://demodesk.com/meet/mylink",
    rejectedUrl: "https://demodesk.com.evil.example/meet",
  },
  {
    name: "Dialpad",
    handler: addDialpad,
    config: dialpadConfig,
    acceptedUrl: "https://meetings.dialpad.com/adb2002",
    rejectedUrl: "http://meetings.dialpad.com/adb2002",
  },
  {
    name: "Discord",
    handler: addDiscord,
    config: discordConfig,
    acceptedUrl: "https://discord.gg/420gg69",
    rejectedUrl: "https://discord.gg.evil.example/420",
  },
  {
    name: "8x8",
    handler: addEightxeight,
    config: eightxeightConfig,
    acceptedUrl: "https://8x8.vc/company",
    rejectedUrl: "https://8x8.vc.evil.example/company",
  },
  {
    name: "Element Call",
    handler: addElementCall,
    config: elementCallConfig,
    acceptedUrl: "https://call.element.io/room",
    rejectedUrl: "https://call.element.io.evil.example/room",
  },
  {
    name: "FaceTime",
    handler: addFacetime,
    config: facetimeConfig,
    acceptedUrl: "https://facetime.apple.com/join?lang=en",
    rejectedUrl: "https://facetime.apple.com.evil.example/join",
  },
  {
    name: "Horizon Workrooms",
    handler: addHorizonWorkrooms,
    config: horizonWorkroomsConfig,
    acceptedUrl: "https://workrooms.workplace.com/groupcall/LINK:uALeBBTZbdBowT",
    rejectedUrl: "https://workrooms.workplace.com.evil.example/groupcall",
  },
];

const install = (handler: AppDeclarativeHandler) =>
  handler.createCredential({
    user: { id: 7 } as never,
    appType: handler.appType,
    slug: handler.slug,
  });

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.create.mockResolvedValue({ id: 3 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(STATIC_LINK_APPS)("$name link app", ({ handler, config, acceptedUrl, rejectedUrl }) => {
  it("declares the static conferencing link without extra install steps", () => {
    expect(config).toMatchObject({
      slug: handler.slug,
      type: handler.appType,
      variant: handler.variant,
      appData: { location: { linkType: "static" } },
    });
    expect(config.categories).toContain(handler.variant);
    expect(handler).toMatchObject({
      appType: config.type,
      slug: config.slug,
      variant: config.variant,
      supportsMultipleInstalls: false,
      handlerType: "add",
    });
    expect(handler.redirect).toBeUndefined();
  });

  it("accepts its meeting links and rejects lookalike domains", () => {
    const urlPattern = new RegExp(config.appData.location.urlRegExp);

    expect(urlPattern.test(acceptedUrl)).toBe(true);
    expect(urlPattern.test(rejectedUrl)).toBe(false);
  });

  it("installs an empty credential without calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await install(handler);

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: {
        type: config.type,
        key: {},
        userId: 7,
        appId: config.slug,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
