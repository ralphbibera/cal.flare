import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  viewerId: 0,
  cache: new Map<string, Promise<unknown>>(),
  cacheConfigs: [] as Array<{ keyParts: unknown; options: unknown }>,
  // Mirrors the request objects passed by the pages: both serialize to "{}".
  headers: new Headers(),
  cookies: { get: () => undefined },
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>, keyParts: unknown, options: unknown) => {
    state.cacheConfigs.push({ keyParts, options });
    return (...args: unknown[]) => {
      const key = JSON.stringify([keyParts, args]);
      const existing = state.cache.get(key);
      if (existing) return existing;
      const result = fn(...args);
      state.cache.set(key, result);
      return result;
    };
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  cookies: async () => state.cookies,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: async () => ({
    user: { id: state.viewerId, profile: { organizationId: null } },
  }),
}));

vi.mock("@calcom/features/auth/lib/onboardingUtils", () => ({
  checkOnboardingRedirect: async () => null,
}));

vi.mock("@calcom/features/filters/lib/getTeamsFiltersFromQuery", () => ({
  getTeamsFiltersFromQuery: () => undefined,
}));

vi.mock("@calcom/trpc/server/routers/viewer/eventTypes/_router", () => ({
  eventTypesRouter: {},
}));

const caller = vi.hoisted(() => ({
  getUserEventGroups: async () => ({ viewerId: state.viewerId }),
  get: async () => ({ eventType: { id: 99, viewerId: state.viewerId } }),
}));

vi.mock("app/_trpc/context", () => ({
  createRouterCaller: async () => caller,
  getTRPCContext: async () => ({}),
}));

vi.mock("app/_utils", () => ({
  _generateMetadata: async () => ({}),
  getTranslate: async () => (key: string) => key,
}));

vi.mock("@lib/buildLegacyCtx", () => ({
  buildLegacyRequest: () => ({}),
}));

vi.mock("../(main-nav)/event-types/EventTypesWrapper", () => ({
  EventTypesWrapper: () => null,
}));

vi.mock("@calcom/web/modules/event-types/components/EventTypeWebWrapper", () => ({
  EventTypeWebWrapper: () => null,
}));

import EventTypesPage from "../(main-nav)/event-types/page";
import EventTypeEditorPage from "./[type]/page";

const pageProps = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };

type EventTypesElementProps = { userEventGroupsData: { viewerId: number } };
type EventTypeEditorElementProps = { data: { eventType: { viewerId: number } } };

describe("event type pages cache key", () => {
  beforeEach(() => {
    state.viewerId = 0;
    state.cache.clear();
  });

  it("never serves one viewer's event type list to another", async () => {
    state.viewerId = 101;
    const firstPage = (await EventTypesPage(pageProps)) as ReactElement<EventTypesElementProps>;
    state.viewerId = 202;
    const secondPage = (await EventTypesPage(pageProps)) as ReactElement<EventTypesElementProps>;

    expect(firstPage.props.userEventGroupsData.viewerId).toBe(101);
    expect(secondPage.props.userEventGroupsData.viewerId).toBe(202);
    expect(state.cacheConfigs).toContainEqual({
      keyParts: ["viewer.eventTypes.getUserEventGroups"],
      options: { revalidate: 3600 },
    });
  });

  it("never serves one viewer's event type to another", async () => {
    const editorProps = { ...pageProps, params: Promise.resolve({ type: "99" }) };
    state.viewerId = 303;
    const firstPage = (await EventTypeEditorPage(editorProps)) as ReactElement<EventTypeEditorElementProps>;
    state.viewerId = 404;
    const secondPage = (await EventTypeEditorPage(editorProps)) as ReactElement<EventTypeEditorElementProps>;

    expect(firstPage.props.data.eventType.viewerId).toBe(303);
    expect(secondPage.props.data.eventType.viewerId).toBe(404);
    expect(state.cacheConfigs).toContainEqual({
      keyParts: ["viewer.eventTypes.get"],
      options: { revalidate: 3600 },
    });
  });
});
