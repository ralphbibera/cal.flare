CREATE TABLE "HolidayCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "countryCode" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "year" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')),
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "HolidayCache_countryCode_eventId_key" ON "HolidayCache"("countryCode", "eventId");
CREATE INDEX "HolidayCache_countryCode_year_idx" ON "HolidayCache"("countryCode", "year");
CREATE INDEX "HolidayCache_countryCode_date_idx" ON "HolidayCache"("countryCode", "date");
