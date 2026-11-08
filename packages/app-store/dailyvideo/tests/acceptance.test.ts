import type { CalendarEvent } from "@calcom/types/Calendar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DailyVideoApiAdapter, {
  generateGuestMeetingTokenFromOwnerMeetingToken,
  getBatchProcessorJobAccessLink,
  getRoomNameFromRecordingId,
  setEnableRecordingUIAndUserIdForOrganizer,
  updateMeetingTokenIfExpired,
} from "../lib/VideoApiAdapter";
import type { batchProcessorBody } from "../zod";

const API_KEY = "daily-api-key";
const ROOM_NAME = "booking-room";
const ROOM_URL = `https://cal.daily.co/${ROOM_NAME}`;
const MEETING_TOKEN = "owner-meeting-token";
const END_TIME = "2024-01-15T09:00:00.000Z";
const END_SECONDS = 1705309200;
const ROOM_EXP = END_SECONDS + 14 * 24 * 60 * 60;
const INSTANT_EXP = END_SECONDS + 60 * 60;

// The adapter reads Daily app keys from the database, so the fake prisma app row is what a
// Workers install would read from D1; every outbound request still goes through the real fetcher.
const { prisma } = vi.hoisted(() => ({
  prisma: {
    app: { findUnique: vi.fn() },
    membership: { findFirst: vi.fn() },
    bookingReference: { update: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

type FetchCall = { url: string; method: string; headers: Headers; body: string | undefined };
type RoomRequest = { privacy: string; properties: Record<string, unknown> };

const calls: FetchCall[] = [];
const queuedResponses: Response[] = [];

const respondWith = (body: unknown, init: ResponseInit = {}) => {
  queuedResponses.push(
    new Response(JSON.stringify(body), {
      status: 200,
      ...init,
      headers: { "content-type": "application/json" },
    })
  );
};

const respondEmpty = (status: number) => {
  queuedResponses.push(new Response(null, { status }));
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : input.toString();
  calls.push({
    url,
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : undefined,
  });
  const response = queuedResponses.shift();
  if (!response) throw new Error(`Unexpected Daily API request: ${init?.method ?? "GET"} ${url}`);
  return response;
});

const bodyOf = <T>(call: FetchCall): T => {
  if (!call.body) throw new Error(`Expected a request body for ${call.method} ${call.url}`);
  return JSON.parse(call.body) as T;
};

const roomResponse = (overrides: { exp?: number } = {}) => ({
  id: "room-uuid",
  name: ROOM_NAME,
  api_created: true,
  privacy: "public",
  url: ROOM_URL,
  created_at: "2024-01-01T00:00:00.000Z",
  config: {
    exp: overrides.exp ?? ROOM_EXP,
    enable_chat: true,
    enable_knocking: true,
    enable_prejoin_ui: true,
    enable_transcription_storage: false,
    enable_pip_ui: true,
  },
});

const queueRoomAndToken = (overrides: { exp?: number } = {}) => {
  respondWith(roomResponse(overrides));
  respondWith({ token: MEETING_TOKEN });
};

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "daily_video",
  title: "Planning",
  startTime: "2024-01-15T09:00:00.000Z",
  endTime: END_TIME,
  uid: "booking-uid",
  organizer: {
    id: 1,
    name: "Jane",
    email: "jane@example.com",
    timeZone: "Europe/London",
    language: { translate: ((key: string) => key) as never, locale: "en" },
  },
  attendees: [],
  ...overrides,
});

const buildAdapter = () => {
  const adapter = DailyVideoApiAdapter();
  if (!adapter) throw new Error("Daily Video adapter was not created");
  return adapter;
};

const builtEvent = buildEvent();

beforeEach(() => {
  calls.length = 0;
  queuedResponses.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  prisma.app.findUnique.mockResolvedValue({
    keys: { api_key: API_KEY, scale_plan: "false" },
  });
  prisma.membership.findFirst.mockResolvedValue(null);
  prisma.bookingReference.update.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Daily room lifecycle", () => {
  it("creates a public room and returns its join URL with the owner token as the booking password", async () => {
    queueRoomAndToken();

    const result = await buildAdapter().createMeeting(builtEvent);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://api.daily.co/v1/rooms",
      method: "POST",
    });
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    expect(prisma.app.findUnique).toHaveBeenCalledWith({ where: { slug: "daily-video" } });

    const roomRequest = bodyOf<RoomRequest>(calls[0]);
    expect(roomRequest.privacy).toBe("public");
    expect(roomRequest.properties).toMatchObject({
      enable_prejoin_ui: true,
      enable_knocking: true,
      enable_screenshare: true,
      enable_chat: true,
      enable_pip_ui: true,
      exp: ROOM_EXP,
      enable_transcription_storage: false,
    });
    expect(roomRequest.properties).not.toHaveProperty("enable_recording");
    expect(roomRequest.properties).not.toHaveProperty("permissions");

    expect(bodyOf(calls[1])).toEqual({
      properties: {
        room_name: ROOM_NAME,
        exp: ROOM_EXP,
        is_owner: true,
        enable_recording_ui: false,
      },
    });
    expect(result).toEqual({
      type: "daily_video",
      id: ROOM_NAME,
      password: MEETING_TOKEN,
      url: ROOM_URL,
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("enables cloud recording and transcription storage for a scale-plan team host", async () => {
    prisma.app.findUnique.mockResolvedValue({
      keys: { api_key: API_KEY, scale_plan: "true" },
    });
    prisma.membership.findFirst.mockResolvedValue({ id: 9 });
    queueRoomAndToken();

    await buildAdapter().createMeeting(builtEvent);

    const roomRequest = bodyOf<RoomRequest>(calls[0]);
    expect(roomRequest.properties).toMatchObject({
      enable_recording: "cloud",
      enable_transcription_storage: true,
      permissions: { canAdmin: ["transcription"] },
    });
    // Recordings only move to the customer bucket when all CAL_VIDEO_BUCKET_* values exist.
    expect(roomRequest.properties).not.toHaveProperty("recordings_bucket");
    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: { userId: 1, team: { slug: { not: null } } },
    });
  });

  it("leaves recording and transcription off for a scale-plan host outside a team", async () => {
    prisma.app.findUnique.mockResolvedValue({
      keys: { api_key: API_KEY, scale_plan: "true" },
    });
    queueRoomAndToken();

    await buildAdapter().createMeeting(builtEvent);

    const roomRequest = bodyOf<RoomRequest>(calls[0]);
    expect(roomRequest.properties).not.toHaveProperty("enable_recording");
    expect(roomRequest.properties.enable_transcription_storage).toBe(false);
    expect(roomRequest.properties).not.toHaveProperty("permissions");
  });

  it("updates by booking reference UID and deletes by room name", async () => {
    const adapter = buildAdapter();
    queueRoomAndToken();

    await adapter.updateMeeting({ uid: ROOM_NAME }, builtEvent);
    expect(calls[0]).toMatchObject({
      url: `https://api.daily.co/v1/rooms/${ROOM_NAME}`,
      method: "POST",
    });
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);

    respondEmpty(204);
    await adapter.deleteMeeting(ROOM_NAME);
    expect(calls[2]).toMatchObject({
      url: `https://api.daily.co/v1/rooms/${ROOM_NAME}`,
      method: "DELETE",
    });
    expect(calls[2].body).toBeUndefined();
    expect(calls[2].headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("creates an instant room with a one-hour buffer and scale-plan recording", async () => {
    prisma.app.findUnique.mockResolvedValue({
      keys: { api_key: API_KEY, scale_plan: "true" },
    });
    queueRoomAndToken({ exp: INSTANT_EXP });

    const result = await buildAdapter().createInstantCalVideoRoom?.(END_TIME);

    const roomRequest = bodyOf<RoomRequest>(calls[0]);
    expect(roomRequest.properties).toMatchObject({
      exp: INSTANT_EXP,
      start_video_off: true,
      enable_recording: "cloud",
      enable_transcription_storage: true,
    });
    // Instant rooms only grant transcription admin when the S3 bucket env is configured.
    expect(roomRequest.properties).not.toHaveProperty("permissions");
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
    expect(bodyOf(calls[1])).toEqual({
      properties: {
        room_name: ROOM_NAME,
        exp: INSTANT_EXP,
        is_owner: true,
        enable_recording_ui: false,
      },
    });
    expect(result).toEqual({
      type: "daily_video",
      id: ROOM_NAME,
      password: MEETING_TOKEN,
      url: ROOM_URL,
    });
  });
});

describe("Daily meeting tokens", () => {
  it("reuses a valid owner token without writing to the booking reference", async () => {
    respondWith({ room_name: ROOM_NAME, exp: ROOM_EXP, enable_recording_ui: false });

    const token = await updateMeetingTokenIfExpired({
      bookingReferenceId: 42,
      meetingToken: MEETING_TOKEN,
      roomName: ROOM_NAME,
      exp: ROOM_EXP,
    });

    expect(token).toBe(MEETING_TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.daily.co/v1/meeting-tokens/${MEETING_TOKEN}`);
    expect(prisma.bookingReference.update).not.toHaveBeenCalled();
  });

  it("recreates an expired owner token and stores it on the booking reference", async () => {
    respondWith({ error: "not found" }, { status: 404, statusText: "Not Found" });
    respondWith({ token: "renewed-token" });

    const token = await updateMeetingTokenIfExpired({
      bookingReferenceId: 42,
      meetingToken: MEETING_TOKEN,
      roomName: ROOM_NAME,
      exp: ROOM_EXP,
    });

    expect(token).toBe("renewed-token");
    expect(calls[1]).toMatchObject({
      url: "https://api.daily.co/v1/meeting-tokens",
      method: "POST",
    });
    expect(bodyOf(calls[1])).toEqual({
      properties: {
        room_name: ROOM_NAME,
        exp: ROOM_EXP,
        enable_recording_ui: false,
        is_owner: true,
      },
    });
    expect(prisma.bookingReference.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { meetingPassword: "renewed-token" },
    });
    expect(JSON.stringify(prisma.bookingReference.update.mock.calls)).not.toContain(API_KEY);
  });

  it("creates a guest token from the owner token without owner privileges", async () => {
    respondWith({ room_name: ROOM_NAME, exp: ROOM_EXP });
    respondWith({ token: "guest-token" });

    const token = await generateGuestMeetingTokenFromOwnerMeetingToken({
      meetingToken: MEETING_TOKEN,
      userId: 7,
    });

    expect(token).toBe("guest-token");
    const request = bodyOf<{ properties: Record<string, unknown> }>(calls[1]);
    expect(request.properties).toEqual({
      room_name: ROOM_NAME,
      exp: ROOM_EXP,
      enable_recording_ui: false,
      user_id: 7,
    });
    expect(request.properties).not.toHaveProperty("is_owner");
  });

  it("does not call Daily when no meeting token exists", async () => {
    expect(
      await updateMeetingTokenIfExpired({
        bookingReferenceId: 42,
        meetingToken: null,
        roomName: ROOM_NAME,
        exp: ROOM_EXP,
      })
    ).toBeNull();
    expect(await generateGuestMeetingTokenFromOwnerMeetingToken({ meetingToken: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a token that already has the backward-compatible owner fields", async () => {
    respondWith({ room_name: ROOM_NAME, exp: ROOM_EXP, enable_recording_ui: false, user_id: 7 });

    const token = await setEnableRecordingUIAndUserIdForOrganizer(42, MEETING_TOKEN, 7);

    expect(token).toBeNull();
    expect(calls).toHaveLength(1);
    expect(prisma.bookingReference.update).not.toHaveBeenCalled();
  });
});

describe("Daily recording and webhook helpers", () => {
  it("resolves recording room names and finished transcription access links", async () => {
    respondWith({
      id: "recording-id",
      room_name: ROOM_NAME,
      start_ts: END_SECONDS,
      status: "finished",
      duration: 60,
      share_token: "share-token",
    });
    respondWith({
      id: "job-id",
      preset: "transcript",
      status: "finished",
      transcription: [
        { format: "vtt", link: "https://download.example.com/transcript.vtt" },
        { format: "txt", link: "https://download.example.com/transcript.txt" },
      ],
    });

    expect(await getRoomNameFromRecordingId("recording-id")).toBe(ROOM_NAME);
    expect(calls[0].url).toBe("https://api.daily.co/v1/recordings/recording-id");

    const job = await getBatchProcessorJobAccessLink("job-id");
    expect(calls[1].url).toBe("https://api.daily.co/v1/batch-processor/job-id/access-link");
    expect(job.transcription).toEqual([
      { format: "vtt", link: "https://download.example.com/transcript.vtt" },
      { format: "txt", link: "https://download.example.com/transcript.txt" },
    ]);
  });

  it("submits batch processor jobs and returns recording download links valid for 12 hours", async () => {
    const transcriptionJob = {
      preset: "transcript",
      inParams: { sourceType: "recordingId", recordingId: "recording-id" },
      outParams: { s3Config: { s3KeyTemplate: "transcript" } },
    } satisfies batchProcessorBody;
    respondWith({ id: "job-id" });
    respondWith({ download_link: "https://download.example.com/recording.mp4" });

    expect(await buildAdapter().submitBatchProcessorJob?.(transcriptionJob)).toEqual({ id: "job-id" });
    expect(bodyOf(calls[0])).toEqual(transcriptionJob);

    expect(await buildAdapter().getRecordingDownloadLink?.("recording-id")).toEqual({
      download_link: "https://download.example.com/recording.mp4",
    });
    expect(calls[1].url).toBe(
      "https://api.daily.co/v1/recordings/recording-id/access-link?valid_for_secs=43200"
    );
  });

  it("collects transcript links for a meeting session", async () => {
    respondWith({
      total_count: 2,
      data: [
        {
          transcriptId: "transcript-1",
          domainId: "domain",
          roomId: "room",
          mtgSessionId: "session-1",
          duration: 60,
          status: "finished",
        },
        {
          transcriptId: "transcript-2",
          domainId: "domain",
          roomId: "room",
          mtgSessionId: "session-1",
          duration: 60,
          status: "finished",
        },
      ],
    });
    respondWith({ link: "https://download.example.com/transcript-1.vtt" });
    respondWith({ link: "https://download.example.com/transcript-2.vtt" });

    const links = await buildAdapter().getAllTranscriptsAccessLinkFromMeetingId?.("session-1");

    expect(calls[0].url).toBe("https://api.daily.co/v1/transcript?mtgSessionId=session-1");
    expect(calls[1].url).toBe("https://api.daily.co/v1/transcript/transcript-1/access-link");
    expect(calls[2].url).toBe("https://api.daily.co/v1/transcript/transcript-2/access-link");
    expect(links).toEqual([
      "https://download.example.com/transcript-1.vtt",
      "https://download.example.com/transcript-2.vtt",
    ]);
  });
});

describe("Daily error handling", () => {
  it("rejects a booking without a UID before calling Daily", async () => {
    const adapter = buildAdapter();

    await expect(adapter.createMeeting(buildEvent({ uid: null }))).rejects.toThrow(
      "We need the booking uid to create the Daily reference in DB"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a rejected API key without echoing it", async () => {
    respondWith({ error: "invalid token" }, { status: 401, statusText: "Unauthorized" });

    const message = await buildAdapter()
      .createMeeting(builtEvent)
      .then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );

    expect(message).toBe("Unauthorized");
    expect(message).not.toContain(API_KEY);
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("maps recording lookup failures to the baseline message", async () => {
    respondWith({ error: "provider failure" }, { status: 500, statusText: "Internal Server Error" });

    await expect(buildAdapter().getRecordings?.(ROOM_NAME)).rejects.toThrow(
      "Something went wrong! Unable to get recording"
    );
  });

  it("maps transcription lookup failures to the baseline message", async () => {
    respondWith({ error: "provider failure" }, { status: 500, statusText: "Internal Server Error" });

    await expect(buildAdapter().getAllTranscriptsAccessLinkFromMeetingId?.("session-1")).rejects.toThrow(
      "Something went wrong! Unable to get transcription access link"
    );
  });
});
