import { google } from "googleapis";
import { tool } from "ai";
import { z } from "zod";
import keys from "../creds/google.json" with { type: "json" };
import calendarConfig from "../creds/calendar-config.json" with { type: "json" };

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

const auth = new google.auth.JWT({
  email: keys.client_email,
  key: keys.private_key,
  scopes: SCOPES,
});

await auth.authorize();
console.log("Google Calendar: connected with service account");

const calendar = google.calendar({ version: "v3", auth });

let activeCalendar = calendarConfig.activeCalendar;
const TIMEZONE = calendarConfig.timezone;

function resolveCalendarId(calendarId) {
  return !calendarId || calendarId === "primary" ? activeCalendar : calendarId;
}

// Subscribe the service account to the user's calendar so calendarList.list() includes it
try {
  await calendar.calendarList.insert({ requestBody: { id: activeCalendar } });
} catch (e) {
  // 409 = already subscribed, which is fine
  if (e.code !== 409)
    console.warn("Could not subscribe to calendar:", e.message);
}

export const listCalendars = tool({
  description:
    "List all Google Calendars accessible by the service account. Shows calendar name, ID, and whether it is the currently active calendar.",
  inputSchema: z.object({}),
  execute: async () => {
    const res = await calendar.calendarList.list();
    const calendars = res.data.items || [];
    return calendars.map((c) => ({
      id: c.id,
      summary: c.summary,
      description: c.description,
      accessRole: c.accessRole,
      active: c.id === activeCalendar,
    }));
  },
});

export const setActiveCalendar = tool({
  description:
    "Switch the active Google Calendar. All subsequent calendar operations will use this calendar by default. Use listCalendars first to see available IDs.",
  inputSchema: z.object({
    calendarId: z
      .string()
      .describe("The calendar ID to set as active (e.g. an email address)"),
  }),
  execute: async ({ calendarId }) => {
    try {
      await calendar.calendarList.insert({ requestBody: { id: calendarId } });
    } catch (e) {
      if (e.code !== 409) throw e;
    }
    activeCalendar = calendarId;
    return { success: true, activeCalendar };
  },
});

export const listEvents = tool({
  description:
    "List upcoming events from Google Calendar. Use this to check what's on the calendar.",
  inputSchema: z.object({
    calendarId: z
      .string()
      .optional()
      .describe(
        "Calendar ID to list events from (defaults to active calendar)",
      ),
    maxResults: z
      .number()
      .default(10)
      .describe("Maximum number of events to return"),
    timeMin: z
      .string()
      .optional()
      .describe("ISO date string to filter events from (defaults to now)"),
  }),
  execute: async ({ calendarId, maxResults, timeMin }) => {
    const res = await calendar.events.list({
      calendarId: resolveCalendarId(calendarId),
      maxResults,
      timeMin:
        timeMin && !isNaN(Date.parse(timeMin))
          ? timeMin
          : new Date().toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    const events = res.data.items || [];
    return events.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location,
      status: e.status,
    }));
  },
});

export const addEvent = tool({
  description:
    "Create a new event on Google Calendar. Use allDay=true with startDate/endDate for all-day events, or startDateTime/endDateTime for timed events. Use recurrence for repeating events.",
  inputSchema: z.object({
    calendarId: z
      .string()
      .optional()
      .describe(
        "Calendar ID to add the event to (defaults to active calendar)",
      ),
    summary: z.string().describe("Title of the event"),
    description: z.string().optional().describe("Description of the event"),
    allDay: z
      .boolean()
      .optional()
      .describe(
        "Set true for all-day events (use startDate/endDate instead of startDateTime/endDateTime)",
      ),
    startDate: z
      .string()
      .optional()
      .describe("Start date for all-day events in YYYY-MM-DD format"),
    endDate: z
      .string()
      .optional()
      .describe(
        "End date for all-day events in YYYY-MM-DD format (exclusive, so use the next day)",
      ),
    startDateTime: z
      .string()
      .optional()
      .describe(
        "Start time for timed events as ISO 8601 string (e.g. 2026-06-15T10:00:00-05:00)",
      ),
    endDateTime: z
      .string()
      .optional()
      .describe(
        "End time for timed events as ISO 8601 string (e.g. 2026-06-15T10:30:00-05:00)",
      ),
    location: z.string().optional().describe("Location of the event"),
    recurrence: z
      .array(z.string())
      .optional()
      .describe(
        'Recurrence rules, e.g. ["RRULE:FREQ=YEARLY"] or ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]',
      ),
  }),
  execute: async ({
    calendarId,
    summary,
    description,
    allDay,
    startDate,
    endDate,
    startDateTime,
    endDateTime,
    location,
    recurrence,
  }) => {
    const body = { summary, description, location };
    if (allDay || startDate) {
      body.start = { date: startDate };
      body.end = { date: endDate || startDate };
    } else {
      body.start = { dateTime: startDateTime, timeZone: TIMEZONE };
      body.end = { dateTime: endDateTime, timeZone: TIMEZONE };
    }
    if (recurrence) body.recurrence = recurrence;

    const res = await calendar.events.insert({
      calendarId: resolveCalendarId(calendarId),
      requestBody: body,
    });
    return {
      id: res.data.id,
      summary: res.data.summary,
      link: res.data.htmlLink,
    };
  },
});

export const editEvent = tool({
  description:
    "Update an existing Google Calendar event. Only the provided fields will be changed. Supports switching between all-day and timed, and updating recurrence.",
  inputSchema: z.object({
    calendarId: z
      .string()
      .optional()
      .describe(
        "Calendar ID containing the event (defaults to active calendar)",
      ),
    eventId: z.string().describe("ID of the event to update"),
    summary: z.string().optional().describe("New title for the event"),
    description: z.string().optional().describe("New description"),
    allDay: z
      .boolean()
      .optional()
      .describe("Set true to change to all-day event (use startDate/endDate)"),
    startDate: z
      .string()
      .optional()
      .describe("New start date (YYYY-MM-DD) for all-day events"),
    endDate: z
      .string()
      .optional()
      .describe("New end date (YYYY-MM-DD, exclusive) for all-day events"),
    startDateTime: z
      .string()
      .optional()
      .describe("New start time as ISO 8601 string"),
    endDateTime: z
      .string()
      .optional()
      .describe("New end time as ISO 8601 string"),
    location: z.string().optional().describe("New location"),
    recurrence: z
      .array(z.string())
      .optional()
      .describe('Recurrence rules, e.g. ["RRULE:FREQ=YEARLY"]'),
  }),
  execute: async ({
    calendarId,
    eventId,
    summary,
    description,
    allDay,
    startDate,
    endDate,
    startDateTime,
    endDateTime,
    location,
    recurrence,
  }) => {
    const body = {};
    if (summary !== undefined) body.summary = summary;
    if (description !== undefined) body.description = description;
    if (location !== undefined) body.location = location;
    if (allDay || startDate) {
      body.start = { date: startDate };
      body.end = { date: endDate || startDate };
    } else {
      if (startDateTime !== undefined)
        body.start = { dateTime: startDateTime, timeZone: TIMEZONE };
      if (endDateTime !== undefined)
        body.end = { dateTime: endDateTime, timeZone: TIMEZONE };
    }
    if (recurrence !== undefined) body.recurrence = recurrence;

    const res = await calendar.events.patch({
      calendarId: resolveCalendarId(calendarId),
      eventId,
      requestBody: body,
    });
    return {
      id: res.data.id,
      summary: res.data.summary,
      link: res.data.htmlLink,
    };
  },
});

export const deleteEvent = tool({
  description: "Delete an event from Google Calendar by its event ID.",
  inputSchema: z.object({
    calendarId: z
      .string()
      .optional()
      .describe(
        "Calendar ID containing the event (defaults to active calendar)",
      ),
    eventId: z.string().describe("ID of the event to delete"),
  }),
  execute: async ({ calendarId, eventId }) => {
    await calendar.events.delete({
      calendarId: resolveCalendarId(calendarId),
      eventId,
    });
    return { success: true, message: `Event ${eventId} deleted.` };
  },
});

// Export internals for calendar monitor reuse (avoids re-auth)
export { calendar, activeCalendar, TIMEZONE };
