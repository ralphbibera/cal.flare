import "reflect-metadata";

import { CalendarAppError } from "@calcom/platform-libraries/app-store";
import type { ArgumentsHost } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { FILTER_CATCH_EXCEPTIONS } from "@nestjs/common/constants";
import type { Request } from "express";
import { CalendarServiceExceptionFilter } from "./calendar-service-exception.filter";

function createHost(request: Request) {
  const response = {
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

describe("CalendarServiceExceptionFilter", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("catches calendar errors thrown from the Node platform-libraries build", () => {
    const error = new CalendarAppError("calendar broke");
    const catchTypes = Reflect.getMetadata(
      FILTER_CATCH_EXCEPTIONS,
      CalendarServiceExceptionFilter
    ) as unknown[];

    expect(catchTypes).toContain(CalendarAppError);
    expect(catchTypes.some((type) => typeof type === "function" && error instanceof type)).toBe(true);
  });

  it("writes the calendar error envelope for a platform-libraries error", () => {
    const request = {
      headers: { "X-Request-Id": "request-1" },
      body: {},
      url: "/v2/calendars",
      method: "GET",
    } as unknown as Request;
    const { host, response } = createHost(request);

    new CalendarServiceExceptionFilter().catch(new CalendarAppError("calendar broke"), host);

    expect(response.setHeader).toHaveBeenCalledWith("X-Request-Id", "request-1");
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      status: "error",
      timestamp: expect.any(String),
      path: "/v2/calendars",
      error: { code: "CalendarAppError", message: "calendar broke" },
    });
  });
});
