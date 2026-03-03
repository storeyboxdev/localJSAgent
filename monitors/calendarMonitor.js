import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "..", ".monitor-state.json");

const DEFAULT_POLL_INTERVAL_MS = parseInt(process.env.CALENDAR_POLL_INTERVAL_MS ?? "60000");
const DEFAULT_LOOKAHEAD_MINUTES = parseInt(process.env.CALENDAR_LOOKAHEAD_MINUTES ?? "15");

function loadFiredEvents() {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    const now = new Date();
    // Drop any entries whose event start time is already past
    return new Map(
      (data.firedEvents ?? []).filter(([, startTime]) => new Date(startTime) >= now)
    );
  } catch {
    return new Map();
  }
}

function saveFiredEvents(firedEvents) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ firedEvents: [...firedEvents.entries()] }));
  } catch (e) {
    console.error("[calendarMonitor] state save error:", e.message);
  }
}

/**
 * Create a calendar monitor that polls Google Calendar for upcoming events.
 *
 * @param {object} opts
 * @param {object} opts.calendar - Authorized Google Calendar API client (from tools/gcalendar.js)
 * @param {string} opts.calendarId - Calendar ID to monitor
 * @returns {{ onEvent, start, stop, getUpcoming }}
 */
export function createCalendarMonitor({ calendar, calendarId }) {
  let timer = null;
  // Map<"eventId::startTime", startTime> — persisted across restarts
  const firedEvents = loadFiredEvents();
  const handlers = [];

  async function poll() {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + DEFAULT_LOOKAHEAD_MINUTES * 60 * 1000);

    try {
      const res = await calendar.events.list({
        calendarId,
        timeMin: now.toISOString(),
        timeMax: windowEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = res.data.items ?? [];

      for (const event of events) {
        const startTime = event.start?.dateTime ?? event.start?.date;
        const key = `${event.id}::${startTime}`;

        if (!firedEvents.has(key)) {
          firedEvents.set(key, startTime);
          saveFiredEvents(firedEvents);

          const payload = {
            id: event.id,
            summary: event.summary,
            start: startTime,
            end: event.end?.dateTime ?? event.end?.date,
            location: event.location ?? null,
            agentId: event.extendedProperties?.private?.agentId ?? null,
          };

          console.log(`[calendarMonitor] upcoming: "${event.summary}" at ${startTime}`);

          for (const handler of handlers) {
            try {
              handler(payload);
            } catch (e) {
              console.error("[calendarMonitor] handler error:", e);
            }
          }
        }
      }

      // Prune stale entries (events whose start time is now in the past)
      let pruned = false;
      for (const [key, startTime] of firedEvents) {
        if (new Date(startTime) < now) { firedEvents.delete(key); pruned = true; }
      }
      if (pruned) saveFiredEvents(firedEvents);
    } catch (err) {
      console.error("[calendarMonitor] poll error:", err.message);
      // Non-fatal — log and continue polling
    }
  }

  return {
    /** Register a callback that receives event payloads */
    onEvent(handler) {
      handlers.push(handler);
    },

    /** Start polling. Fires an immediate poll, then at intervalMs intervals. */
    start(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
      if (timer) return;
      console.log(
        `[calendarMonitor] starting — poll every ${intervalMs / 1000}s, lookahead ${DEFAULT_LOOKAHEAD_MINUTES}min`
      );
      poll();
      timer = setInterval(poll, intervalMs);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        console.log("[calendarMonitor] stopped");
      }
    },

    /** Return upcoming events within the lookahead window (snapshot for /api/monitors) */
    async getUpcoming() {
      const now = new Date();
      const windowEnd = new Date(now.getTime() + DEFAULT_LOOKAHEAD_MINUTES * 60 * 1000);
      try {
        const res = await calendar.events.list({
          calendarId,
          timeMin: now.toISOString(),
          timeMax: windowEnd.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
        });
        return (res.data.items ?? []).map((e) => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime ?? e.start?.date,
          end: e.end?.dateTime ?? e.end?.date,
          location: e.location ?? null,
          agentId: e.extendedProperties?.private?.agentId ?? null,
        }));
      } catch (err) {
        console.error("[calendarMonitor] getUpcoming error:", err.message);
        return [];
      }
    },
  };
}
