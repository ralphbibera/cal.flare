import type { AppDeclarativeHandler } from "@calcom/types/AppHandler";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addMirotalk from "../mirotalk/api/add";
import mirotalkConfig from "../mirotalk/config.json";
import addRoam from "../roam/api/add";
import roamConfig from "../roam/config.json";
import addSalesroom from "../salesroom/api/add";
import salesroomConfig from "../salesroom/config.json";
import addSignal from "../signal/api/add";
import signalConfig from "../signal/config.json";
import addSiriusVideo from "../sirius_video/api/add";
import siriusVideoConfig from "../sirius_video/config.json";
import addSkype from "../skype/api/add";
import skypeConfig from "../skype/config.json";
import addTelegram from "../telegram/api/add";
import telegramConfig from "../telegram/config.json";
import addWhatsapp from "../whatsapp/api/add";
import whatsappConfig from "../whatsapp/config.json";

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
    name: "Mirotalk",
    handler: addMirotalk,
    config: mirotalkConfig,
    acceptedUrl: "https://p2p.mirotalk.com/join/80085ShinyPhone",
    rejectedUrl: "https://mirotalk.com/join/room",
  },
  {
    name: "Roam",
    handler: addRoam,
    config: roamConfig,
    acceptedUrl: "https://ro.am/r/#/p/yHwFBQrRTMuptqKYo_wu8A/huzRiHnR-np4RGYKV-c0pQ",
    rejectedUrl: "https://ro.am.evil.example/r",
  },
  {
    name: "Salesroom",
    handler: addSalesroom,
    config: salesroomConfig,
    acceptedUrl: "https://user.sr.chat",
    rejectedUrl: "http://user.sr.chat",
  },
  {
    name: "Signal",
    handler: addSignal,
    config: signalConfig,
    acceptedUrl: "https://signal.me/#p/+11234567890",
    rejectedUrl: "https://signal.me.evil.example/#p/+11234567890",
  },
  {
    name: "Sirius Video",
    handler: addSiriusVideo,
    config: siriusVideoConfig,
    acceptedUrl: "https://sirius.video/sebastian",
    rejectedUrl: "https://sirius.video.evil.example/sebastian",
  },
  {
    name: "Skype",
    handler: addSkype,
    config: skypeConfig,
    acceptedUrl: "https://join.skype.com/abc123",
    rejectedUrl: "http://join.skype.com/abc123",
  },
  {
    name: "Telegram",
    handler: addTelegram,
    config: telegramConfig,
    acceptedUrl: "https://t.me/MyUsername",
    rejectedUrl: "https://t.me.evil.example/MyUsername",
  },
  {
    name: "WhatsApp",
    handler: addWhatsapp,
    config: whatsappConfig,
    acceptedUrl: "https://wa.me/send?phone=1234567890",
    rejectedUrl: "https://wa.me.evil.example/send",
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
  it("declares the static link without extra install steps", () => {
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
