import { vi } from "vitest";

// Shared map of mock calendar service constructors accessible to both the vi.mock factory and mockCalendar.
// Using a Proxy-based CalendarServiceMap ensures any calendar service key is automatically mocked,
// preventing real module imports (e.g., feishu/lark) that trigger async fetch calls during worker shutdown.
const calendarServiceConstructorMocks: Record<string, ReturnType<typeof vi.fn>> = {};

export function getOrCreateCalendarServiceMock(key: string): ReturnType<typeof vi.fn> {
  if (!calendarServiceConstructorMocks[key]) {
    calendarServiceConstructorMocks[key] = vi.fn();
  }
  return calendarServiceConstructorMocks[key];
}

vi.mock("@calcom/app-store/calendar.services.generated", () => ({
  CalendarServiceMap: new Proxy({} as Record<string, Promise<{ default: ReturnType<typeof vi.fn> }>>, {
    get(_target, prop: string) {
      if (typeof prop === "symbol") return undefined;
      return Promise.resolve({ default: getOrCreateCalendarServiceMock(prop) });
    },
  }),
}));

export const mockVideoAdapterRegistry: Record<string, unknown> = {};

vi.mock("@calcom/app-store/video.adapters.generated", () => ({
  VideoApiAdapterMap: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "string" && mockVideoAdapterRegistry[prop]) {
          return mockVideoAdapterRegistry[prop];
        }
        return Promise.resolve({ default: vi.fn() });
      },
    }
  ),
}));

vi.mock("@calcom/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/crypto")>();
  return {
    ...actual,
    symmetricEncrypt: vi.fn((serviceAccountKey) => serviceAccountKey),
    symmetricDecrypt: vi.fn((serviceAccountKey) => serviceAccountKey),
  };
});
