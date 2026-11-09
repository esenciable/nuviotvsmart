// Lightweight Sports screen: one vertical list of the day's matches FROM ESPN
// (site.api.espn.com scoreboard per visible day and league) — EN VIVO,
// PRÓXIMOS, FINALIZADOS (collapsed by default) — with day chips (Ayer/Hoy/
// Mañana), a single filter pill and an Actualizar action. Every match renders
// the SAME card: league column, two team bands (team-coloured gradient, logo,
// name, record, big score) and a right status column. The Esencial Sport
// addon is ONLY the stream source: its events are never rendered, they resolve
// an ESPN match to a /stream/tv/<id>.json call. No polling loops.
import { Router } from "../../navigation/routerState.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { Environment } from "../../../platform/environment.js";

import { sportsRepository } from "../../../data/repository/sportsRepository.js";
import { buildSections, formatKickoffTime } from "../../../core/sports/sportsFeed.js";

import { createSportsScreenMethods01 } from "./sportsScreenMethods-01-mount-and-load.js";
import { createSportsScreenMethods02 } from "./sportsScreenMethods-02-render.js";
import { createSportsScreenMethods03 } from "./sportsScreenMethods-03-interact.js";

export { Router, ScreenUtils, Environment, sportsRepository, buildSections, formatKickoffTime };

// The pure layout helpers live in the render module and are re-exported here
// so the sibling method modules reach them through `internals` and the layout
// tests can pin them directly.
export {
  SPORTS_ROW_HEIGHT,
  SPORTS_ROW_GAP,
  SPORTS_DAY_CHIPS,
  SPORTS_REFRESH_LABEL,
  SPORTS_FILTER_PILL_LABEL,
  SPORTS_LOADING_TEXT,
  SPORTS_EMPTY_TEXT,
  SPORTS_LOAD_ERROR_TEXT,
  SPORTS_NO_SIGNAL_TEXT,
  SPORTS_NO_LINK_TEXT,
  SPORTS_RESOLVING_TEXT,
  SPORTS_SCORES_REFRESH_MS,
  pendingNoticeText,
  matchRowTitle,
  periodOrdinal,
  formatPeriodClock,
  countdownText,
  scoreStatusView,
  liveProgressFraction,
  bandBaseColor,
  bandGradient,
  teamInitials,
  renderMatchCard,
  buildMatchRows
} from "./sportsScreenMethods-02-render.js";

export function isBackEvent(event) {
  return Environment.isBackEvent(event);
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const SportsScreen = {
  ...createSportsScreenMethods01(),
  ...createSportsScreenMethods02(),
  ...createSportsScreenMethods03(),
  isBackEvent,
  escapeHtml
};
