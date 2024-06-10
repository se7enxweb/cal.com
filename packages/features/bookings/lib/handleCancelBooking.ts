import type { Prisma, WorkflowReminder } from "@prisma/client";
import type { NextApiRequest } from "next";

import { FAKE_DAILY_CREDENTIAL } from "@calcom/app-store/dailyvideo/lib/VideoApiAdapter";
import { DailyLocationType } from "@calcom/app-store/locations";
import EventManager from "@calcom/core/EventManager";
import dayjs from "@calcom/dayjs";
import { sendCancelledEmails } from "@calcom/emails";
import { getCalEventResponses } from "@calcom/features/bookings/lib/getCalEventResponses";
import { workflowSelect, getAllWorkflows } from "@calcom/features/ee/workflows/lib/getAllWorkflows";
import { sendCancelledReminders } from "@calcom/features/ee/workflows/lib/reminders/reminderScheduler";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import { deleteWebhookScheduledTriggers } from "@calcom/features/webhooks/lib/scheduleTrigger";
import sendPayload from "@calcom/features/webhooks/lib/sendOrSchedulePayload";
import type { EventTypeInfo } from "@calcom/features/webhooks/lib/sendPayload";
import { isPrismaObjOrUndefined, parseRecurringEvent } from "@calcom/lib";
import getOrgIdFromMemberOrTeamId from "@calcom/lib/getOrgIdFromMemberOrTeamId";
import { getTeamIdFromEventType } from "@calcom/lib/getTeamIdFromEventType";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { getTranslation } from "@calcom/lib/server/i18n";
import { getTimeFormatStringFromUserTimeFormat } from "@calcom/lib/timeFormat";
import prisma, { bookingMinimalSelect } from "@calcom/prisma";
import type { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { BookingStatus } from "@calcom/prisma/enums";
import { credentialForCalendarServiceSelect } from "@calcom/prisma/selects/credential";
import { EventTypeMetaDataSchema, schemaBookingCancelParams } from "@calcom/prisma/zod-utils";
import { deleteAllWorkflowReminders } from "@calcom/trpc/server/routers/viewer/workflows/util";
import type { CalendarEvent } from "@calcom/types/Calendar";

import { getAllCredentials } from "./getAllCredentialsForUsersOnEvent/getAllCredentials";
import cancelAttendeeSeat from "./handleSeats/cancel/cancelAttendeeSeat";

const log = logger.getSubLogger({ prefix: ["handleCancelBooking"] });

async function getBookingToDelete(id: number | undefined, uid: string | undefined) {
  return await prisma.booking.findUnique({
    where: {
      id,
      uid,
    },
    select: {
      ...bookingMinimalSelect,
      recurringEventId: true,
      userId: true,
      user: {
        select: {
          id: true,
          username: true,
          credentials: { select: credentialForCalendarServiceSelect }, // Not leaking at the moment, be careful with
          email: true,
          timeZone: true,
          timeFormat: true,
          name: true,
          destinationCalendar: true,
        },
      },
      location: true,
      references: {
        select: {
          uid: true,
          type: true,
          externalCalendarId: true,
          credentialId: true,
          thirdPartyRecurringEventId: true,
        },
      },
      payment: true,
      paid: true,
      eventType: {
        select: {
          slug: true,
          owner: {
            select: {
              id: true,
              hideBranding: true,
            },
          },
          team: {
            select: {
              id: true,
              name: true,
              parentId: true,
            },
          },
          parentId: true,
          userId: true,
          recurringEvent: true,
          title: true,
          eventName: true,
          description: true,
          requiresConfirmation: true,
          price: true,
          currency: true,
          length: true,
          seatsPerTimeSlot: true,
          bookingFields: true,
          seatsShowAttendees: true,
          metadata: true,
          hosts: {
            select: {
              user: true,
            },
          },
          workflows: {
            select: {
              workflow: {
                select: workflowSelect,
              },
            },
          },
        },
      },
      uid: true,
      id: true,
      eventTypeId: true,
      destinationCalendar: true,
      smsReminderNumber: true,
      workflowReminders: true,
      seatsReferences: true,
      responses: true,
      iCalUID: true,
      iCalSequence: true,
    },
  });
}

export type CustomRequest = NextApiRequest & {
  userId?: number;
  bookingToDelete?: Awaited<ReturnType<typeof getBookingToDelete>>;
  platformClientId?: string;
  platformRescheduleUrl?: string;
  platformCancelUrl?: string;
  platformBookingUrl?: string;
  arePlatformEmailsEnabled?: boolean;
};

async function handler(req: CustomRequest) {
  const { id, uid, allRemainingBookings, cancellationReason, seatReferenceUid } =
    schemaBookingCancelParams.parse(req.body);
  req.bookingToDelete = await getBookingToDelete(id, uid);
  const {
    bookingToDelete,
    userId,
    platformBookingUrl,
    platformCancelUrl,
    platformClientId,
    platformRescheduleUrl,
    arePlatformEmailsEnabled,
  } = req;

  if (!bookingToDelete || !bookingToDelete.user) {
    throw new HttpError({ statusCode: 400, message: "Booking not found" });
  }

  if (!bookingToDelete.userId) {
    throw new HttpError({ statusCode: 400, message: "User not found" });
  }

  // If the booking is a seated event and there is no seatReferenceUid we should validate that logged in user is host
  if (bookingToDelete.eventType?.seatsPerTimeSlot && !seatReferenceUid) {
    const userIsHost = bookingToDelete.eventType.hosts.find((host) => {
      if (host.user.id === userId) return true;
    });

    const userIsOwnerOfEventType = bookingToDelete.eventType.owner?.id === userId;

    if (!userIsHost && !userIsOwnerOfEventType) {
      throw new HttpError({ statusCode: 401, message: "User not a host of this event" });
    }
  }

  // get webhooks
  const eventTrigger: WebhookTriggerEvents = "BOOKING_CANCELLED";

  const teamId = await getTeamIdFromEventType({
    eventType: {
      team: { id: bookingToDelete.eventType?.team?.id ?? null },
      parentId: bookingToDelete?.eventType?.parentId ?? null,
    },
  });
  const triggerForUser = !teamId || (teamId && bookingToDelete.eventType?.parentId);
  const organizerUserId = triggerForUser ? bookingToDelete.userId : null;

  const orgId = await getOrgIdFromMemberOrTeamId({ memberId: organizerUserId, teamId });

  const subscriberOptions = {
    userId: organizerUserId,
    eventTypeId: bookingToDelete.eventTypeId as number,
    triggerEvent: eventTrigger,
    teamId,
    orgId,
  };
  const eventTypeInfo: EventTypeInfo = {
    eventTitle: bookingToDelete?.eventType?.title || null,
    eventDescription: bookingToDelete?.eventType?.description || null,
    requiresConfirmation: bookingToDelete?.eventType?.requiresConfirmation || null,
    price: bookingToDelete?.eventType?.price || null,
    currency: bookingToDelete?.eventType?.currency || null,
    length: bookingToDelete?.eventType?.length || null,
  };

  const webhooks = await getWebhooks(subscriberOptions);

  const organizer = await prisma.user.findFirstOrThrow({
    where: {
      id: bookingToDelete.userId,
    },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      timeZone: true,
      timeFormat: true,
      locale: true,
    },
  });

  const teamMembersPromises = [];
  const attendeesListPromises = [];
  const hostsPresent = !!bookingToDelete.eventType?.hosts;

  for (const attendee of bookingToDelete.attendees) {
    const attendeeObject = {
      name: attendee.name,
      email: attendee.email,
      timeZone: attendee.timeZone,
      language: {
        translate: await getTranslation(attendee.locale ?? "en", "common"),
        locale: attendee.locale ?? "en",
      },
    };

    // Check for the presence of hosts to determine if it is a team event type
    if (hostsPresent) {
      // If the attendee is a host then they are a team member
      const teamMember = bookingToDelete.eventType?.hosts.some((host) => host.user.email === attendee.email);
      if (teamMember) {
        teamMembersPromises.push(attendeeObject);
        // If not then they are an attendee
      } else {
        attendeesListPromises.push(attendeeObject);
      }
    } else {
      attendeesListPromises.push(attendeeObject);
    }
  }

  const attendeesList = await Promise.all(attendeesListPromises);
  const teamMembers = await Promise.all(teamMembersPromises);
  const tOrganizer = await getTranslation(organizer.locale ?? "en", "common");

  const evt: CalendarEvent = {
    title: bookingToDelete?.title,
    type: bookingToDelete?.eventType?.title as string,
    description: bookingToDelete?.description || "",
    customInputs: isPrismaObjOrUndefined(bookingToDelete.customInputs),
    eventTypeId: bookingToDelete.eventTypeId as number,
    ...getCalEventResponses({
      bookingFields: bookingToDelete.eventType?.bookingFields ?? null,
      booking: bookingToDelete,
    }),
    startTime: bookingToDelete?.startTime ? dayjs(bookingToDelete.startTime).format() : "",
    endTime: bookingToDelete?.endTime ? dayjs(bookingToDelete.endTime).format() : "",
    organizer: {
      id: organizer.id,
      username: organizer.username || undefined,
      email: bookingToDelete?.userPrimaryEmail ?? organizer.email,
      name: organizer.name ?? "Nameless",
      timeZone: organizer.timeZone,
      timeFormat: getTimeFormatStringFromUserTimeFormat(organizer.timeFormat),
      language: { translate: tOrganizer, locale: organizer.locale ?? "en" },
    },
    attendees: attendeesList,
    uid: bookingToDelete?.uid,
    bookingId: bookingToDelete?.id,
    /* Include recurringEvent information only when cancelling all bookings */
    recurringEvent: allRemainingBookings
      ? parseRecurringEvent(bookingToDelete.eventType?.recurringEvent)
      : undefined,
    location: bookingToDelete?.location,
    destinationCalendar: bookingToDelete?.destinationCalendar
      ? [bookingToDelete?.destinationCalendar]
      : bookingToDelete?.user.destinationCalendar
      ? [bookingToDelete?.user.destinationCalendar]
      : [],
    cancellationReason: cancellationReason,
    ...(teamMembers && {
      team: { name: bookingToDelete?.eventType?.team?.name || "Nameless", members: teamMembers, id: teamId! },
    }),
    seatsPerTimeSlot: bookingToDelete.eventType?.seatsPerTimeSlot,
    seatsShowAttendees: bookingToDelete.eventType?.seatsShowAttendees,
    iCalUID: bookingToDelete.iCalUID,
    iCalSequence: bookingToDelete.iCalSequence + 1,
    platformClientId,
    platformRescheduleUrl,
    platformCancelUrl,
    platformBookingUrl,
  };

  const dataForWebhooks = { evt, webhooks, eventTypeInfo };

  // If it's just an attendee of a booking then just remove them from that booking
  const result = await cancelAttendeeSeat(req, dataForWebhooks);
  if (result) return { success: true };

  const promises = webhooks.map((webhook) =>
    sendPayload(webhook.secret, eventTrigger, new Date().toISOString(), webhook, {
      ...evt,
      ...eventTypeInfo,
      status: "CANCELLED",
      smsReminderNumber: bookingToDelete.smsReminderNumber || undefined,
    }).catch((e) => {
      logger.error(
        `Error executing webhook for event: ${eventTrigger}, URL: ${webhook.subscriberUrl}, bookingId: ${evt.bookingId}, bookingUid: ${evt.uid}`,
        safeStringify(e)
      );
    })
  );
  await Promise.all(promises);

  if (bookingToDelete.eventType) {
    const eventTypeWorkflows =
      bookingToDelete.eventType?.workflows.map((workflowRel) => workflowRel.workflow) ?? [];

    const workflows = await getAllWorkflows(eventTypeWorkflows, organizerUserId, teamId, orgId);

    await sendCancelledReminders({
      workflows,
      smsReminderNumber: bookingToDelete.smsReminderNumber,
      evt: {
        ...evt,
        ...{ eventType: { slug: bookingToDelete.eventType.slug } },
      },
      hideBranding: !!bookingToDelete.eventType.owner?.hideBranding,
    });
  }

  let updatedBookings: {
    id: number;
    uid: string;
    workflowReminders: WorkflowReminder[];
    references: {
      type: string;
      credentialId: number | null;
      uid: string;
      externalCalendarId: string | null;
    }[];
    startTime: Date;
    endTime: Date;
  }[] = [];

  // by cancelling first, and blocking whilst doing so; we can ensure a cancel
  // action always succeeds even if subsequent integrations fail cancellation.
  if (bookingToDelete.eventType?.recurringEvent && bookingToDelete.recurringEventId && allRemainingBookings) {
    const recurringEventId = bookingToDelete.recurringEventId;
    // Proceed to mark as cancelled all remaining recurring events instances (greater than or equal to right now)
    await prisma.booking.updateMany({
      where: {
        recurringEventId,
        startTime: {
          gte: new Date(),
        },
      },
      data: {
        status: BookingStatus.CANCELLED,
        cancellationReason: cancellationReason,
      },
    });
    const allUpdatedBookings = await prisma.booking.findMany({
      where: {
        recurringEventId: bookingToDelete.recurringEventId,
        startTime: {
          gte: new Date(),
        },
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        references: {
          select: {
            uid: true,
            type: true,
            externalCalendarId: true,
            credentialId: true,
          },
        },
        workflowReminders: true,
        uid: true,
      },
    });
    updatedBookings = updatedBookings.concat(allUpdatedBookings);
  } else {
    if (bookingToDelete?.eventType?.seatsPerTimeSlot) {
      await prisma.attendee.deleteMany({
        where: {
          bookingId: bookingToDelete.id,
        },
      });
    }

    const where: Prisma.BookingWhereUniqueInput = uid ? { uid } : { id };

    const updatedBooking = await prisma.booking.update({
      where,
      data: {
        status: BookingStatus.CANCELLED,
        cancellationReason: cancellationReason,
        // Assume that canceling the booking is the last action
        iCalSequence: evt.iCalSequence || 100,
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        references: {
          select: {
            uid: true,
            type: true,
            externalCalendarId: true,
            credentialId: true,
          },
        },
        workflowReminders: true,
        uid: true,
      },
    });
    updatedBookings.push(updatedBooking);
  }

  /** TODO: Remove this without breaking functionality */
  if (bookingToDelete.location === DailyLocationType) {
    bookingToDelete.user.credentials.push({
      ...FAKE_DAILY_CREDENTIAL,
      teamId: bookingToDelete.eventType?.team?.id || null,
    });
  }

  const isBookingInRecurringSeries = !!(
    bookingToDelete.eventType?.recurringEvent &&
    bookingToDelete.recurringEventId &&
    allRemainingBookings
  );

  const bookingToDeleteEventTypeMetadata = EventTypeMetaDataSchema.parse(
    bookingToDelete.eventType?.metadata || null
  );

  const credentials = await getAllCredentials(bookingToDelete.user, {
    ...bookingToDelete.eventType,
    metadata: bookingToDeleteEventTypeMetadata,
  });

  const eventManager = new EventManager({ ...bookingToDelete.user, credentials });

  await eventManager.cancelEvent(evt, bookingToDelete.references, isBookingInRecurringSeries);

  const bookingReferenceDeletes = prisma.bookingReference.deleteMany({
    where: {
      bookingId: bookingToDelete.id,
    },
  });

  const webhookTriggerPromises = [];
  const workflowReminderPromises = [];

  for (const booking of updatedBookings) {
    // delete scheduled webhook triggers of cancelled bookings
    webhookTriggerPromises.push(deleteWebhookScheduledTriggers({ booking }));

    //Workflows - cancel all reminders for cancelled bookings
    workflowReminderPromises.push(deleteAllWorkflowReminders(booking.workflowReminders));
  }

  await Promise.all([...webhookTriggerPromises, ...workflowReminderPromises]).catch((error) => {
    log.error("An error occurred when deleting workflow reminders and webhook triggers", error);
  });

  const prismaPromises: Promise<unknown>[] = [bookingReferenceDeletes];

  try {
    // TODO: if emails fail try to requeue them
    if (!platformClientId || (platformClientId && arePlatformEmailsEnabled))
      await sendCancelledEmails(evt, { eventName: bookingToDelete?.eventType?.eventName });
  } catch (error) {
    console.error("Error deleting event", error);
  }
  req.statusCode = 200;
  return { message: "Booking successfully cancelled." };
}

export default handler;
