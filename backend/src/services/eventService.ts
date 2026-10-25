import { prisma } from "../lib/prisma.js";

export interface CreateEventInput {
  eventId: string;
  eventType: string;
  payload: Record<string, any>;
}

export async function createEvent(input: CreateEventInput) {
  const { eventId, eventType, payload } = input;

  return prisma.$transaction(async (tx: any) => {
    // Create Event
    const event = await tx.event.create({
      data: {
        eventId,
        eventType,
        payload,
        status: "RECEIVED",
        attemptCount: 0,
      },
    });

    // Create EventLog entry
    await tx.eventLog.create({
      data: {
        eventId: event.eventId,
        status: "RECEIVED",
        message: "Event received",
      },
    });

    // Create OutboxEvent - this is the key to the Transactional Outbox pattern
    await tx.outboxEvent.create({
      data: {
        eventId: event.eventId,
        eventType: eventType,
        payload: payload,
        status: "PENDING",
        attemptCount: 0,
      },
    });

    return event;
  });
}

export async function getEventByEventId(eventId: string) {
  return prisma.event.findUnique({
    where: { eventId },
  });
}

export async function getAllEvents(page: number = 1, limit: number = 20) {
  const skip = (page - 1) * limit;

  const [events, total] = await Promise.all([
    prisma.event.findMany({
      skip,
      take: limit,
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.event.count(),
  ]);

  return {
    events,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

export async function getEventHistory(eventId: string) {
  return prisma.eventLog.findMany({
    where: { eventId },
    orderBy: {
      createdAt: "asc",
    },
  });
}

export async function getPendingOutboxEvents(limit: number = 10) {
  return prisma.outboxEvent.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

export async function getOutboxEventByEventId(eventId: string) {
  return prisma.outboxEvent.findUnique({
    where: { eventId },
  });
}

export async function getAllOutboxEvents(page: number = 1, limit: number = 20) {
  const skip = (page - 1) * limit;

  const [events, total] = await Promise.all([
    prisma.outboxEvent.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.outboxEvent.count(),
  ]);

  return {
    events,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

export async function markOutboxAsPublished(eventId: string) {
  return prisma.outboxEvent.update({
    where: { eventId },
    data: {
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });
}

export async function recordOutboxPublishingFailure(
  eventId: string,
  error: string
) {
  return prisma.outboxEvent.update({
    where: { eventId },
    data: {
      attemptCount: {
        increment: 1,
      },
      lastError: error,
      status: "PENDING", // Keep as PENDING for retry
    },
  });
}
