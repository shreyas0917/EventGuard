CREATE TYPE "EventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'RETRYING', 'DUPLICATE');

CREATE TABLE events (
    id TEXT PRIMARY KEY,
    eventId TEXT NOT NULL UNIQUE,
    eventType TEXT NOT NULL,
    payload JSONB NOT NULL,
    status "EventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX events_status_idx ON events(status);
CREATE INDEX events_createdAt_idx ON events("createdAt");

CREATE TABLE event_logs (
    id SERIAL PRIMARY KEY,
    eventId TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (eventId) REFERENCES events(eventId) ON DELETE CASCADE
);

CREATE INDEX event_logs_eventId_idx ON event_logs(eventId);
CREATE INDEX event_logs_createdAt_idx ON event_logs("createdAt");
