import prismaMock from "../../../../../tests/libs/__mocks__/prisma";

import type { WebhookTriggerEvents, Booking, BookingReference, DestinationCalendar } from "@prisma/client";
import type { VEvent } from "node-ical";
import ical from "node-ical";
import { expect } from "vitest";
import "vitest-fetch-mock";

import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { BookingStatus } from "@calcom/prisma/enums";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { Fixtures } from "@calcom/web/test/fixtures/fixtures";

import type { InputEventType } from "./bookingScenario";

type Recurrence = {
  freq: number;
  interval: number;
  count: number;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHaveEmail(
        expectedEmail: {
          //TODO: Support email HTML parsing to target specific elements
          htmlToContain?: string | string[];
          to: string;
          noIcs?: true;
          ics?: {
            filename: string;
            iCalUID: string;
            recurrence?: Recurrence;
          };
        },
        to: string
      ): R;
    }
  }
}

expect.extend({
  toHaveEmail(
    emails: Fixtures["emails"],
    expectedEmail: {
      //TODO: Support email HTML parsing to target specific elements
      htmlToContain?: string | string[];
      to: string;
      ics?: {
        filename: string;
        iCalUID: string;
        recurrence?: Recurrence;
        noIcs: true;
      };
    },
    to: string
  ) {
    const expectedHtmlsToContain =
      expectedEmail.htmlToContain instanceof Array
        ? expectedEmail.htmlToContain
        : expectedEmail.htmlToContain
        ? [expectedEmail.htmlToContain]
        : [];
    const testEmail = emails.get().find((email) => email.to.includes(to));
    const emailsToLog = emails
      .get()
      .map((email) => ({ to: email.to, html: email.html, ics: email.icalEvent }));
    if (!testEmail) {
      logger.silly("All Emails", JSON.stringify({ numEmails: emailsToLog.length, emailsToLog }));
      return {
        pass: false,
        message: () => `No email sent to ${to}`,
      };
    }
    const ics = testEmail.icalEvent;
    const icsObject = ics?.content ? ical.sync.parseICS(ics?.content) : null;
    let isHtmlContained = true;
    let isToAddressExpected = true;
    const isIcsFilenameExpected = expectedEmail.ics ? ics?.filename === expectedEmail.ics.filename : true;
    const iCalUidData = icsObject ? icsObject[expectedEmail.ics?.iCalUID || ""] : null;
    const isIcsUIDExpected = expectedEmail.ics ? !!iCalUidData : true;
    assertHasRecurrence(expectedEmail.ics?.recurrence, (iCalUidData as VEvent)?.rrule?.toString() || "");
    isHtmlContained = expectedHtmlsToContain.every((expectedHtmlToContain) => {
      return testEmail.html.includes(expectedHtmlToContain);
    });

    isToAddressExpected = expectedEmail.to === testEmail.to;

    if (!isHtmlContained || !isToAddressExpected) {
      logger.silly("All Emails", JSON.stringify({ numEmails: emailsToLog.length, emailsToLog }));
    }

    return {
      pass:
        isHtmlContained &&
        isToAddressExpected &&
        (expectedEmail.noIcs ? true : isIcsFilenameExpected && isIcsUIDExpected),
      message: () => {
        if (!isHtmlContained) {
          return `Email HTML is not as expected. Expected:"${expectedEmail.htmlToContain}" isn't contained in "${testEmail.html}"`;
        }

        if (!isToAddressExpected) {
          return `Email To address is not as expected. Expected:${expectedEmail.to} isn't equal to ${testEmail.to}`;
        }

        if (!isIcsFilenameExpected) {
          return `ICS Filename is not as expected. Expected:${expectedEmail.ics.filename} isn't equal to ${ics?.filename}`;
        }

        if (!isIcsUIDExpected) {
          return `ICS UID is not as expected. Expected:${
            expectedEmail.ics.iCalUID
          } isn't present in ${JSON.stringify(icsObject)}`;
        }
        throw new Error("Unknown error");
      },
    };

    function assertHasRecurrence(expectedRecurrence: Recurrence | null | undefined, rrule: string) {
      if (!expectedRecurrence) {
        return;
      }

      const expectedRrule = `FREQ=${
        expectedRecurrence.freq === 0 ? "YEARLY" : expectedRecurrence.freq === 1 ? "MONTHLY" : "WEEKLY"
      };COUNT=${expectedRecurrence.count};INTERVAL=${expectedRecurrence.interval}`;

      logger.silly({
        expectedRrule,
        rrule,
      });
      expect(rrule).toContain(expectedRrule);
    }
  },
});

export function expectWebhookToHaveBeenCalledWith(
  subscriberUrl: string,
  data: {
    triggerEvent: WebhookTriggerEvents;
    payload: Record<string, unknown> | null;
  }
) {
  const fetchCalls = fetchMock.mock.calls;
  const webhooksToSubscriberUrl = fetchCalls.filter((call) => {
    return call[0] === subscriberUrl;
  });
  logger.silly("Scanning fetchCalls for webhook", safeStringify(fetchCalls));
  const webhookFetchCall = webhooksToSubscriberUrl.find((call) => {
    const body = call[1]?.body;
    const parsedBody = JSON.parse((body as string) || "{}");
    return parsedBody.triggerEvent === data.triggerEvent;
  });

  if (!webhookFetchCall) {
    throw new Error(
      `Webhook not sent to ${subscriberUrl} for ${data.triggerEvent}. All webhooks: ${JSON.stringify(
        webhooksToSubscriberUrl
      )}`
    );
  }
  expect(webhookFetchCall[0]).toBe(subscriberUrl);
  const body = webhookFetchCall[1]?.body;
  const parsedBody = JSON.parse((body as string) || "{}");

  expect(parsedBody.triggerEvent).toBe(data.triggerEvent);
  if (parsedBody.payload.metadata?.videoCallUrl) {
    parsedBody.payload.metadata.videoCallUrl = parsedBody.payload.metadata.videoCallUrl
      ? parsedBody.payload.metadata.videoCallUrl.replace(/\/video\/[a-zA-Z0-9]{22}/, "/video/DYNAMIC_UID")
      : parsedBody.payload.metadata.videoCallUrl;
  }
  if (data.payload) {
    if (data.payload.metadata !== undefined) {
      expect(parsedBody.payload.metadata).toEqual(expect.objectContaining(data.payload.metadata));
    }
    if (data.payload.responses !== undefined)
      expect(parsedBody.payload.responses).toEqual(expect.objectContaining(data.payload.responses));
    const { responses: _1, metadata: _2, ...remainingPayload } = data.payload;
    expect(parsedBody.payload).toEqual(expect.objectContaining(remainingPayload));
  }
}

export function expectWorkflowToBeTriggered() {
  // TODO: Implement this.
}

export async function expectBookingToBeInDatabase(
  booking: Partial<Booking> & Pick<Booking, "uid"> & { references?: Partial<BookingReference>[] }
) {
  const actualBooking = await prismaMock.booking.findUnique({
    where: {
      uid: booking.uid,
    },
    include: {
      references: true,
    },
  });

  const { references, ...remainingBooking } = booking;
  expect(actualBooking).toEqual(expect.objectContaining(remainingBooking));
  expect(actualBooking?.references).toEqual(
    expect.arrayContaining((references || []).map((reference) => expect.objectContaining(reference)))
  );
}

export function expectSuccessfulBookingCreationEmails({
  emails,
  organizer,
  booker,
  guests,
  otherTeamMembers,
  iCalUID,
  recurrence,
}: {
  emails: Fixtures["emails"];
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
  guests?: { email: string; name: string }[];
  otherTeamMembers?: { email: string; name: string }[];
  iCalUID: string;
  recurrence?: Recurrence;
}) {
  expect(emails).toHaveEmail(
    {
      htmlToContain: [
        "<title>confirmed_event_type_subject</title>",
        ...(recurrence ? ["new_event_scheduled_recurring"] : []),
      ],
      to: `${organizer.email}`,
      ics: {
        filename: "event.ics",
        iCalUID: `${iCalUID}`,
        recurrence,
      },
    },
    `${organizer.email}`
  );

  expect(emails).toHaveEmail(
    {
      htmlToContain: [
        "<title>confirmed_event_type_subject</title>",
        ...(recurrence ? ["your_event_has_been_scheduled_recurring"] : []),
      ],
      to: `${booker.name} <${booker.email}>`,
      ics: {
        filename: "event.ics",
        iCalUID: iCalUID,
        recurrence,
      },
    },
    `${booker.name} <${booker.email}>`
  );

  if (otherTeamMembers) {
    otherTeamMembers.forEach((otherTeamMember) => {
      expect(emails).toHaveEmail(
        {
          htmlToContain: "<title>confirmed_event_type_subject</title>",
          // Don't know why but organizer and team members of the eventType don'thave their name here like Booker
          to: `${otherTeamMember.email}`,
          ics: {
            filename: "event.ics",
            iCalUID: iCalUID,
          },
        },
        `${otherTeamMember.email}`
      );
    });
  }

  if (guests) {
    guests.forEach((guest) => {
      expect(emails).toHaveEmail(
        {
          htmlToContain: "<title>confirmed_event_type_subject</title>",
          to: `${guest.email}`,
          ics: {
            filename: "event.ics",
            iCalUID: iCalUID,
          },
        },
        `${guest.name} <${guest.email}`
      );
    });
  }
}

export function expectBrokenIntegrationEmails({
  emails,
  organizer,
}: {
  emails: Fixtures["emails"];
  organizer: { email: string; name: string };
}) {
  // Broken Integration email is only sent to the Organizer
  expect(emails).toHaveEmail(
    {
      htmlToContain: "<title>broken_integration</title>",
      to: `${organizer.email}`,
      // No ics goes in case of broken integration email it seems
      // ics: {
      //   filename: "event.ics",
      //   iCalUID: iCalUID,
      // },
    },
    `${organizer.email}`
  );

  // expect(emails).toHaveEmail(
  //   {
  //     htmlToContain: "<title>confirmed_event_type_subject</title>",
  //     to: `${booker.name} <${booker.email}>`,
  //   },
  //   `${booker.name} <${booker.email}>`
  // );
}

export function expectCalendarEventCreationFailureEmails({
  emails,
  organizer,
  booker,
  iCalUID,
}: {
  emails: Fixtures["emails"];
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
  iCalUID: string;
}) {
  expect(emails).toHaveEmail(
    {
      htmlToContain: "<title>broken_integration</title>",
      to: `${organizer.email}`,
      ics: {
        filename: "event.ics",
        iCalUID,
      },
    },
    `${organizer.email}`
  );

  expect(emails).toHaveEmail(
    {
      htmlToContain: "<title>calendar_event_creation_failure_subject</title>",
      to: `${booker.name} <${booker.email}>`,
      ics: {
        filename: "event.ics",
        iCalUID,
      },
    },
    `${booker.name} <${booker.email}>`
  );
}

export function expectSuccessfulBookingRescheduledEmails({
  emails,
  organizer,
  booker,
  iCalUID,
}: {
  emails: Fixtures["emails"];
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
  iCalUID: string;
}) {
  expect(emails).toHaveEmail(
    {
      htmlToContain: "<title>event_type_has_been_rescheduled_on_time_date</title>",
      to: `${organizer.email}`,
      ics: {
        filename: "event.ics",
        iCalUID,
      },
    },
    `${organizer.email}`
  );

  expect(emails).toHaveEmail(
    {
      htmlToContain: "<title>event_type_has_been_rescheduled_on_time_date</title>",
      to: `${booker.name} <${booker.email}>`,
      ics: {
        filename: "event.ics",
        iCalUID,
      },
    },
    `${booker.name} <${booker.email}>`
  );
}
export function expectAwaitingPaymentEmails({
  emails,
  booker,
}: {
  emails: Fixtures["emails"];
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
}) {
  expect(emails).toHaveEmail(
    {
      htmlToContain: "<title>awaiting_payment_subject</title>",
      to: `${booker.name} <${booker.email}>`,
      noIcs: true,
    },
    `${booker.email}`
  );
}

export function expectBookingRequestedEmails({
  emails,
  organizer,
  booker,
}: {
  emails: Fixtures["emails"];
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
}) {
  expect(emails).toHaveEmail(
    {
      htmlToContain: "<title>event_awaiting_approval_subject</title>",
      to: `${organizer.email}`,
      noIcs: true,
    },
    `${organizer.email}`
  );

  expect(emails).toHaveEmail(
    {
      htmlToContain: "<title>booking_submitted_subject</title>",
      to: `${booker.email}`,
      noIcs: true,
    },
    `${booker.email}`
  );
}

export function expectBookingRequestedWebhookToHaveBeenFired({
  booker,
  location,
  subscriberUrl,
  paidEvent,
  eventType,
}: {
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
  subscriberUrl: string;
  location: string;
  paidEvent?: boolean;
  eventType: InputEventType;
}) {
  // There is an inconsistency in the way we send the data to the webhook for paid events and unpaid events. Fix that and then remove this if statement.
  if (!paidEvent) {
    expectWebhookToHaveBeenCalledWith(subscriberUrl, {
      triggerEvent: "BOOKING_REQUESTED",
      payload: {
        eventTitle: eventType.title,
        eventDescription: eventType.description,
        metadata: {
          // In a Pending Booking Request, we don't send the video call url
        },
        responses: {
          name: { label: "your_name", value: booker.name },
          email: { label: "email_address", value: booker.email },
          location: {
            label: "location",
            value: { optionValue: "", value: location },
          },
        },
      },
    });
  } else {
    expectWebhookToHaveBeenCalledWith(subscriberUrl, {
      triggerEvent: "BOOKING_REQUESTED",
      payload: {
        eventTitle: eventType.title,
        eventDescription: eventType.description,
        metadata: {
          // In a Pending Booking Request, we don't send the video call url
        },
        responses: {
          name: { label: "name", value: booker.name },
          email: { label: "email", value: booker.email },
          location: {
            label: "location",
            value: { optionValue: "", value: location },
          },
        },
      },
    });
  }
}

export function expectBookingCreatedWebhookToHaveBeenFired({
  booker,
  location,
  subscriberUrl,
  paidEvent,
  videoCallUrl,
}: {
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
  subscriberUrl: string;
  location: string;
  paidEvent?: boolean;
  videoCallUrl?: string | null;
}) {
  if (!paidEvent) {
    expectWebhookToHaveBeenCalledWith(subscriberUrl, {
      triggerEvent: "BOOKING_CREATED",
      payload: {
        metadata: {
          ...(videoCallUrl ? { videoCallUrl } : null),
        },
        responses: {
          name: { label: "your_name", value: booker.name },
          email: { label: "email_address", value: booker.email },
          location: {
            label: "location",
            value: { optionValue: "", value: location },
          },
        },
      },
    });
  } else {
    expectWebhookToHaveBeenCalledWith(subscriberUrl, {
      triggerEvent: "BOOKING_CREATED",
      payload: {
        // FIXME: File this bug and link ticket here. This is a bug in the code. metadata must be sent here like other BOOKING_CREATED webhook
        metadata: null,
        responses: {
          name: { label: "name", value: booker.name },
          email: { label: "email", value: booker.email },
          location: {
            label: "location",
            value: { optionValue: "", value: location },
          },
        },
      },
    });
  }
}

export function expectBookingRescheduledWebhookToHaveBeenFired({
  booker,
  location,
  subscriberUrl,
  videoCallUrl,
}: {
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
  subscriberUrl: string;
  location: string;
  paidEvent?: boolean;
  videoCallUrl?: string;
}) {
  expectWebhookToHaveBeenCalledWith(subscriberUrl, {
    triggerEvent: "BOOKING_RESCHEDULED",
    payload: {
      metadata: {
        ...(videoCallUrl ? { videoCallUrl } : null),
      },
      responses: {
        name: { label: "your_name", value: booker.name },
        email: { label: "email_address", value: booker.email },
        location: {
          label: "location",
          value: { optionValue: "", value: location },
        },
      },
    },
  });
}

export function expectBookingPaymentIntiatedWebhookToHaveBeenFired({
  booker,
  location,
  subscriberUrl,
  paymentId,
}: {
  organizer: { email: string; name: string };
  booker: { email: string; name: string };
  subscriberUrl: string;
  location: string;
  paymentId: number;
}) {
  expectWebhookToHaveBeenCalledWith(subscriberUrl, {
    triggerEvent: "BOOKING_PAYMENT_INITIATED",
    payload: {
      paymentId: paymentId,
      metadata: {
        // In a Pending Booking Request, we don't send the video call url
      },
      responses: {
        name: { label: "your_name", value: booker.name },
        email: { label: "email_address", value: booker.email },
        location: {
          label: "location",
          value: { optionValue: "", value: location },
        },
      },
    },
  });
}

export function expectSuccessfulCalendarEventCreationInCalendar(
  calendarMock: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createEventCalls: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateEventCalls: any[];
  },
  expected: {
    calendarId?: string | null;
    videoCallUrl: string;
    destinationCalendars: Partial<DestinationCalendar>[];
  }
) {
  expect(calendarMock.createEventCalls.length).toBe(1);
  const call = calendarMock.createEventCalls[0];
  const calEvent = call[0];

  expect(calEvent).toEqual(
    expect.objectContaining({
      destinationCalendar: expected.calendarId
        ? [
            expect.objectContaining({
              externalId: expected.calendarId,
            }),
          ]
        : expected.destinationCalendars
        ? expect.arrayContaining(expected.destinationCalendars.map((cal) => expect.objectContaining(cal)))
        : null,
      videoCallData: expect.objectContaining({
        url: expected.videoCallUrl,
      }),
    })
  );
}

export function expectSuccessfulCalendarEventUpdationInCalendar(
  calendarMock: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createEventCalls: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateEventCalls: any[];
  },
  expected: {
    externalCalendarId: string;
    calEvent: Partial<CalendarEvent>;
    uid: string;
  }
) {
  expect(calendarMock.updateEventCalls.length).toBe(1);
  const call = calendarMock.updateEventCalls[0];
  const uid = call[0];
  const calendarEvent = call[1];
  const externalId = call[2];
  expect(uid).toBe(expected.uid);
  expect(calendarEvent).toEqual(expect.objectContaining(expected.calEvent));
  expect(externalId).toBe(expected.externalCalendarId);
}

export function expectSuccessfulVideoMeetingCreation(
  videoMock: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMeetingCalls: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMeetingCalls: any[];
  },
  expected: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credential: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    calEvent: any;
  }
) {
  expect(videoMock.createMeetingCalls.length).toBe(1);
  const call = videoMock.createMeetingCalls[0];
  const callArgs = call.args;
  const calEvent = callArgs[0];
  const credential = call.credential;

  expect(credential).toEqual(expected.credential);
  expect(calEvent).toEqual(expected.calEvent);
}

export function expectSuccessfulVideoMeetingUpdationInCalendar(
  videoMock: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMeetingCalls: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMeetingCalls: any[];
  },
  expected: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bookingRef: any;
    calEvent: Partial<CalendarEvent>;
  }
) {
  expect(videoMock.updateMeetingCalls.length).toBe(1);
  const call = videoMock.updateMeetingCalls[0];
  const bookingRef = call.args[0];
  const calendarEvent = call.args[1];
  expect(bookingRef).toEqual(expect.objectContaining(expected.bookingRef));
  expect(calendarEvent).toEqual(expect.objectContaining(expected.calEvent));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function expectBookingInDBToBeRescheduledFromTo({ from, to }: { from: any; to: any }) {
  // Expect previous booking to be cancelled
  await expectBookingToBeInDatabase({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ...from,
    status: BookingStatus.CANCELLED,
  });

  // Expect new booking to be created
  await expectBookingToBeInDatabase({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ...to,
    status: BookingStatus.ACCEPTED,
  });
}
