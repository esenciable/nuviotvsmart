// Sports repository: the single UI-facing seam for the Sports screen, on the
// same pattern as liveRepository.js. It wraps ONE shared sportsFeed instance
// (module-level, so the 60 s TTL cache survives leaving and re-entering the
// screen) and exposes the day/sport grouping the screen renders — the screen
// never touches the feed URL, the payload or the fetch itself.
import {
  buildSections,
  createSportsFeed,
  groupEventsByDay,
  sportChips
} from "../../core/sports/sportsFeed.js";

export function createSportsRepository({ feed = null, now } = {}) {
  const feedInstance = feed || createSportsFeed({ ...(now ? { now } : {}) });

  return {
    // {status:"ok", events} | {status:"error", detail} — TTL-cached.
    getEvents() {
      return feedInstance.getEvents();
    },

    // Manual Actualizar: forces the refetch (one call, TTL ignored).
    refresh() {
      return feedInstance.refresh();
    },

    // {status:"ok", streams} | {status:"pending", retryAfterMs} |
    // {status:"error", detail} — one attempt, no retries.
    resolveStreams(eventId) {
      return feedInstance.resolveStreams(eventId);
    },

    // Ayer/Hoy/Mañana buckets over the parsed events.
    groupsForDay(events, nowTs) {
      return groupEventsByDay(events, nowTs);
    },

    // Todos + one chip per sportType present in the events.
    chipsForEvents(events) {
      return sportChips(events);
    },

    // The screen's sections for ONE day chip + ONE sport chip: buildSections
    // (partition + fixed EN VIVO/PRÓXIMOS/FINALIZADOS order) applied to the
    // already day- and sport-filtered events.
    sectionsForDay({ events, dayKey, sportType, now: nowTs }) {
      const groups = groupEventsByDay(events, nowTs);
      const dayEvents = groups[dayKey] || [];
      const filtered = sportType
        ? dayEvents.filter((event) => String(event?.sportType ?? "") === String(sportType))
        : dayEvents;
      return buildSections(filtered);
    }
  };
}

// One repository instance per app: the feed's TTL cache lives at module level
// exactly like the Live TV catalog caches. The default feed arms its fetch
// only in a real browser/TV context, so importing this module in node --test
// never touches the network.
export const sportsRepository = createSportsRepository();
