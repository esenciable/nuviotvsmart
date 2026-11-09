// Layout contract for the rebuilt Sports screen (source contract, like
// tests/test-live-screen-layout.mjs). node --test runs fully offline: pure
// helpers are imported, everything else is pinned against the SOURCE TEXT.
//
// MEASURED SPEC (Android TV reference, dp × 1.5): card 129px, radius 21px,
// glass bg rgba(30,33,44,0.678) on page #0B0B0B, league column 72px, status
// column 177px, team bands with the team's colour gradient, logo 45px, score
// 33px tabular, live red #E53935. NO YELLOW anywhere. The schedule comes from
// ESPN; the addon is ONLY the stream source. node --test runs offline.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SPORTS_ROW_HEIGHT,
  SPORTS_NO_LINK_TEXT,
  buildMatchRows,
  matchRowTitle,
  pendingNoticeText,
  probeFailedNoticeText,
  periodOrdinal,
  formatPeriodClock,
  countdownText,
  scoreStatusView,
  liveProgressFraction,
  bandBaseColor,
  bandGradient,
  teamInitials,
  renderMatchCard
} from "../js/ui/screens/sports/sportsScreenMethods-02-render.js";
// Namespace access for the remaining helpers: a missing export must fail
// exactly the tests that need it, not load-fail the whole file.
import * as sportsRenderNS from "../js/ui/screens/sports/sportsScreenMethods-02-render.js";
import * as sportsFeedSections from "../js/core/sports/sportsFeed.js";
import { buildSections } from "../js/core/sports/sportsFeed.js";

const screenSource = readFileSync(
  new URL("../js/ui/screens/sports/sportsScreen.js", import.meta.url),
  "utf8"
);
const mountSource = readFileSync(
  new URL("../js/ui/screens/sports/sportsScreenMethods-01-mount-and-load.js", import.meta.url),
  "utf8"
);
const renderSource = readFileSync(
  new URL("../js/ui/screens/sports/sportsScreenMethods-02-render.js", import.meta.url),
  "utf8"
);
const interactSource = readFileSync(
  new URL("../js/ui/screens/sports/sportsScreenMethods-03-interact.js", import.meta.url),
  "utf8"
);
const allScreenSource = screenSource + mountSource + renderSource + interactSource;

const YELLOW_PATTERN = /F5C400|FFD700|FFD54A|FFC107|FFB300|FFC400|FFA000|FDB927|amber|rgba\(\s*245\s*,\s*196/i;

// A unified ESPN SportsEvent as parseScoreboard produces it.
const gameEvent = (over = {}) => ({
  id: "401772515",
  slug: "football/nfl",
  sportType: "football",
  leagueName: "National Football League",
  leagueAbbr: "nfl",
  leagueLogo: "https://a.espncdn.com/i/leaguelogos/nfl.png",
  state: "in",
  kickoffMs: Date.UTC(2026, 0, 15, 18, 0, 0),
  statusText: "3:01 - 4th",
  period: 4,
  clock: "3:01",
  situation: "2nd & 6 at NE 40",
  status: "live",
  live: true,
  home: {
    name: "Green Bay Packers",
    shortName: "Packers",
    abbr: "GB",
    color: "#17851E",
    logo: "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png",
    score: 45,
    record: "8-2-2"
  },
  away: {
    name: "New England Patriots",
    shortName: "Patriots",
    abbr: "NE",
    color: "#C60C30",
    logo: "https://a.espncdn.com/i/teamlogos/nfl/500/ne.png",
    score: 27,
    record: "8-2"
  },
  ...over
});

describe("data flow: ESPN is the schedule, the addon is only the streams", () => {
  test("the schedule round feeds the screen: espnScheduleForDay replaces scoresForDay", () => {
    assert.match(mountSource, /espnScheduleForDay/);
    assert.doesNotMatch(allScreenSource, /scoresForDay|matchScore/);
  });

  test("the addon feed result is stored only as the stream pool and is never the rendered list", () => {
    assert.match(mountSource, /this\.addonEvents\s*=/);
    // The sections are built from the ESPN schedule events, not the addon's.
    assert.match(mountSource, /buildSections\(this\.scheduleEvents\)/);
  });

  test("Enter resolves the stream through resolveStreamsForEvent (name+time match) against the addon pool", () => {
    assert.match(interactSource, /resolveStreamsForEvent/);
    assert.match(interactSource, /this\.addonEvents/);
  });

  test("no addon match -> the honest 'no link' notice, no player", () => {
    assert.equal(SPORTS_NO_LINK_TEXT, "No hay enlace para este partido");
    assert.match(renderSource, /No hay enlace para este partido/);
    assert.match(interactSource, /SPORTS_NO_LINK_TEXT/);
    // The notice comes BEFORE any probe or navigation in resolveMatch.
    const resolveIdx = interactSource.indexOf("resolveMatch(event)");
    const noLinkIdx = interactSource.indexOf("SPORTS_NO_LINK_TEXT");
    const probeIdx = interactSource.indexOf("probePlayableStreams(candidates)");
    assert.ok(resolveIdx >= 0 && noLinkIdx > resolveIdx && noLinkIdx < probeIdx, "the no-link gate precedes probing");
  });
});

describe("screen structure: header, day chips, filter pill", () => {
  test("header carries the title, the Ayer/Hoy/Mañana day chips (default Hoy) and the Actualizar action", () => {
    assert.match(renderSource, /Deportes/);
    assert.match(renderSource, /Ayer/);
    assert.match(renderSource, /Hoy/);
    assert.match(renderSource, /Mañana/);
    assert.match(renderSource, /Actualizar/);
    assert.match(mountSource, /dayKey\s*=\s*"today"/);
  });

  test("the selected day chip: bg #F5F5F5@0.14, border #F5F5F5, white text — measured spec", () => {
    assert.match(renderSource, /\.sports-chip\.is-selected\s*\{[^}]*background:\s*rgba\(245,245,245,0\.14\)/);
    assert.match(renderSource, /\.sports-chip\.is-selected\s*\{[^}]*color:\s*#FFFFFF/);
  });

  test("a single filter pill shows Todos los eventos and the live count — no sport chips row", () => {
    assert.match(renderSource, /Todos los eventos/);
    assert.match(renderSource, /en vivo/);
    assert.match(renderSource, /sports-filter-pill/);
    assert.match(renderSource, /\.sports-filter-pill\s*\{[^}]*height:\s*48px/);
    assert.doesNotMatch(renderSource, /renderSportChip/);
    assert.doesNotMatch(allScreenSource, /sportChips/);
  });

  test("the day change triggers a refresh; there is NO polling interval anywhere", () => {
    assert.match(mountSource, /changeDay|selectDay/);
    assert.doesNotMatch(allScreenSource, /setInterval/);
  });
});

describe("palette: no yellow anywhere, only the measured colours", () => {
  test("no yellow hex, no amber, no yellow rgba anywhere in the screen source", () => {
    assert.doesNotMatch(allScreenSource, YELLOW_PATTERN);
  });

  test("the measured palette is present: page, glass card, text, muted and live red", () => {
    assert.match(renderSource, /#0B0B0B/); // page
    assert.match(renderSource, /rgba\(30,33,44,0\.678\)/); // glass card
    assert.match(renderSource, /#FFFFFF/); // text
    assert.match(renderSource, /#8B90A0/); // muted
    assert.match(renderSource, /#E53935/); // live red
  });

  test("the old salmon accent #FF6B5E is gone; the live badge is #E53935", () => {
    assert.doesNotMatch(allScreenSource, /FF6B5E/i);
    assert.match(renderSource, /\.sports-status-badge\.is-live\s*\{[^}]*background:\s*#E53935/);
  });
});

describe("ONE card for every state: pre, in and post render the same structure", () => {
  test("rows have a fixed 129px height constant and CSS", () => {
    assert.equal(SPORTS_ROW_HEIGHT, 129);
    assert.match(renderSource, /SPORTS_ROW_HEIGHT\s*=\s*129/);
    assert.match(renderSource, /\.sports-row\s*\{[^}]*height:\s*129px/);
  });

  test("every state renders the SAME card: league col + team bands + status col + chevron", () => {
    for (const state of ["pre", "in", "post"]) {
      const html = renderMatchCard(gameEvent({ state }));
      assert.match(html, /sports-team-band/, `${state}: team bands exist`);
      assert.match(html, /sports-row-status/, `${state}: status column exists`);
      assert.match(html, /sports-team-logo-box/, `${state}: logo box exists`);
      assert.match(html, /sports-team-score/, `${state}: score slot exists`);
      assert.match(html, /sports-row-chevron/, `${state}: chevron exists`);
      assert.match(html, /sports-league-col/, `${state}: league column exists`);
      assert.match(html, /sports-league-logo|sports-league-abbr/, `${state}: league mark exists`);
    }
  });

  test("the renderer has exactly one match-card markup path (no legacy alternate row)", () => {
    assert.doesNotMatch(renderSource, /if \(row\.score\)/);
    assert.match(renderSource, /renderMatchCard\(row\.event, index\)/);
    assert.doesNotMatch(renderSource, /class="sports-row-league"/);
    assert.doesNotMatch(renderSource, /class="sports-row-teams"/);
    assert.doesNotMatch(renderSource, /class="sports-row-time"/);
  });

  test("the HOME team band comes first (top), derived from homeAway, in every state", () => {
    for (const state of ["pre", "in", "post"]) {
      const html = renderMatchCard(gameEvent({ state }));
      assert.ok(html.indexOf("Green Bay Packers") < html.indexOf("New England Patriots"), `${state}: home on top`);
    }
  });

  test("band gradient: the team base colour at alpha .92/.28/.05 — never yellow, never NaN", () => {
    const html = renderMatchCard(gameEvent());
    assert.match(html, /linear-gradient\(90deg,\s*rgba\(\d+,\s*\d+,\s*\d+,\s*0\.92\)\s*0%,\s*rgba\(\d+,\s*\d+,\s*\d+,\s*0\.28\)\s*70%,\s*rgba\(\d+,\s*\d+,\s*\d+,\s*0\.05\)\s*100%\)/);
    assert.doesNotMatch(html, /NaN/);
    assert.doesNotMatch(html, YELLOW_PATTERN);
  });

  test("bandBaseColor: the team colour lerped toward #0B0C10 by luminance; fallback #3A4150", () => {
    // Dark-mid colour (green #17851E, lum ~0.40): t = 0.25.
    assert.equal(bandBaseColor("#17851E"), "#14671B");
    // Light colour: t = 0.5 (halfway to the dark anchor).
    assert.equal(bandBaseColor("#FFFFFF"), "#858688");
    // Dark colour (crimson #C60C30, lum ~0.21): t = 0.08.
    assert.equal(bandBaseColor("#C60C30"), "#B70C2D");
    // Invalid or missing: the measured fallback.
    assert.equal(bandBaseColor("GGGGGG"), "#3A4150");
    assert.equal(bandBaseColor(""), "#3A4150");
  });

  test("a card whose teams have no colour renders the #3A4150 fallback base, no yellow, no NaN", () => {
    const html = renderMatchCard(
      gameEvent({ home: { name: "H", color: "GGGGGG", score: 1 }, away: { name: "A", color: "", score: 0 } })
    );
    // The gradient still applies — its base is the fallback colour.
    assert.match(html, /rgba\(58,\s*65,\s*80,\s*0\.92\)/);
    assert.doesNotMatch(html, /NaN/);
    assert.doesNotMatch(html, YELLOW_PATTERN);
  });

  test("the trailing team's name and score dim (never the leader, never a tied game)", () => {
    const html = renderMatchCard(gameEvent()); // 45 vs 27: away trails
    assert.match(html, /sports-team-name is-trailing[^>]*>New England Patriots</);
    assert.match(html, /sports-team-score is-trailing[^>]*>27</);
    const tied = renderMatchCard(gameEvent({ away: { name: "Tied", score: 45 } }));
    assert.doesNotMatch(tied, /is-trailing/, "a tied game has no trailing side");
  });
});

describe("the score slot: numbers only when they exist", () => {
  test("live and post rows show the numeric score in the big tabular figure", () => {
    const live = renderMatchCard(gameEvent({ state: "in" }));
    assert.match(live, /sports-team-score[^<]*>45</);
    const post = renderMatchCard(gameEvent({ state: "post" }));
    assert.match(post, /sports-team-score[^<]*>27</);
  });

  test("a pre row leaves the score slot EMPTY — never a 0, never a placeholder", () => {
    const pre = renderMatchCard(
      gameEvent({ state: "pre", home: { name: "H", score: 0 }, away: { name: "A", score: 0 } })
    );
    assert.match(pre, /<span class="sports-team-score"><\/span>/, "the slot is empty, same geometry");
    assert.doesNotMatch(pre, /sports-team-score">\d/, "no digit ever renders in a pre-game slot");
    assert.doesNotMatch(pre, />–</, "never the old en-dash placeholder");
  });

  test("the kickoff time honours the viewer's local timezone via formatKickoffTime", () => {
    assert.match(renderSource, /formatKickoffTime\(/);
  });
});

describe("team logos: fixed boxes, object-fit contain, initials fallback, no reflow", () => {
  test("the team logo box is a fixed 45px box and the image uses object-fit: contain", () => {
    assert.match(renderSource, /\.sports-team-logo-box\s*\{[^}]*width:\s*45px/);
    assert.match(renderSource, /\.sports-team-logo-box\s*\{[^}]*height:\s*45px/);
    assert.match(renderSource, /\.sports-team-logo\s*\{[^}]*object-fit:\s*contain/);
  });

  test("each band renders an <img> logo; a broken logo hides itself, the box keeps its size", () => {
    const html = renderMatchCard(gameEvent());
    assert.match(html, /<img[^>]*sports-team-logo[^>]*src="https:\/\/a\.espncdn\.com\/i\/teamlogos\/nfl\/500\/gb\.png"/);
    assert.match(html, /onerror=/);
  });

  test("a team without a logo gets the initials fallback (circle + ring, weight 900)", () => {
    const html = renderMatchCard(gameEvent({ home: { name: "Green Bay Packers", logo: "", score: 1 } }));
    assert.match(html, /sports-team-logo-box/);
    // Only the away band still carries a real logo image; the home band uses
    // the initials fallback.
    assert.equal((html.match(/class="sports-team-logo"/g) || []).length, 1);
    assert.match(html, /sports-team-logo-fallback[^>]*>GB</);
    assert.match(renderSource, /\.sports-team-logo-fallback\s*\{[^}]*border-radius:\s*50%/);
  });

  test("teamInitials: up to two uppercase initials", () => {
    assert.equal(teamInitials("Green Bay Packers"), "GB");
    assert.equal(teamInitials("Lakers"), "L");
    assert.equal(teamInitials(""), "");
  });

  test("the league column holds the league logo or the league abbreviation", () => {
    const withLogo = renderMatchCard(gameEvent());
    assert.match(withLogo, /sports-league-logo/);
    const withoutLogo = renderMatchCard(gameEvent({ leagueLogo: "" }));
    assert.match(withoutLogo, /sports-league-abbr/);
    assert.match(withoutLogo, /nfl/, "the abbreviation text fills the panel");
  });
});

describe("records: shown only when ESPN provides them, always labelled", () => {
  test("the record renders inline and muted as 'récord 8-2-2'", () => {
    const html = renderMatchCard(gameEvent());
    assert.match(html, /récord 8-2-2/);
    assert.match(html, /sports-team-record/);
    assert.match(renderSource, /\.sports-team-record\s*\{[^}]*rgba\(255,255,255,0\.6\)/);
  });

  test("no record from ESPN -> no record element at all", () => {
    const html = renderMatchCard(
      gameEvent({ home: { name: "H", record: "", score: 1 }, away: { name: "A", record: "", score: 0 } })
    );
    assert.doesNotMatch(html, /récord/);
  });
});

describe("status column: badge, clock, situation, progress", () => {
  test("period and clock format like the reference: 4º · 3:01 (Spanish ordinal)", () => {
    assert.equal(periodOrdinal(1), "1º");
    assert.equal(periodOrdinal(4), "4º");
    assert.equal(periodOrdinal(12), "12º");
    assert.equal(periodOrdinal(0), "");
    assert.equal(formatPeriodClock(4, "3:01"), "4º · 3:01");
    assert.equal(formatPeriodClock(2, ""), "2º");
    assert.equal(formatPeriodClock(0, "8:03"), "8:03");
    assert.equal(formatPeriodClock(0, ""), "");
  });

  test("live: red ● EN VIVO badge with the period · clock under it", () => {
    const html = renderMatchCard(gameEvent({ state: "in" }));
    assert.match(html, /● EN VIVO/);
    assert.match(html, /sports-status-badge is-live/);
    assert.match(html, /4º · 3:01/);
  });

  test("post: FINAL badge with the kickoff time under it; pre: kickoff time badge with the countdown", () => {
    const post = renderMatchCard(gameEvent({ state: "post" }));
    assert.match(post, /FINAL/);
    assert.match(post, /sports-status-badge is-final/);
    assert.match(post, /\d{2}:\d{2}/, "the kickoff time sits under the FINAL badge");
    const pre = renderMatchCard(gameEvent({ state: "pre" }));
    assert.match(pre, /sports-status-badge is-time/);
    const view = scoreStatusView(gameEvent({ state: "pre" }), Date.UTC(2026, 0, 15, 17, 48, 0));
    const kickoffDate = new Date(Date.UTC(2026, 0, 15, 18, 0, 0));
    const expectedTime = `${String(kickoffDate.getHours()).padStart(2, "0")}:${String(kickoffDate.getMinutes()).padStart(2, "0")}`;
    assert.equal(view.badge, expectedTime, "the badge shows the LOCAL kickoff time");
    assert.equal(view.main, "en 12 min");
  });

  test("countdownText: only under 6 hours, minutes then hours+minutes", () => {
    const kickoff = Date.UTC(2026, 0, 15, 18, 0, 0);
    assert.equal(countdownText(kickoff, kickoff - 12 * 60000), "en 12 min");
    assert.equal(countdownText(kickoff, kickoff - 111 * 60000), "en 1 h 51");
    assert.equal(countdownText(kickoff, kickoff - 120 * 60000), "en 2 h");
    assert.equal(countdownText(kickoff, kickoff - 7 * 60 * 60000), "", "over 6 h away: nothing");
    assert.equal(countdownText(kickoff, kickoff + 60000), "", "already started: nothing");
  });

  test("the situation line renders ONLY for live football", () => {
    assert.match(renderMatchCard(gameEvent({ state: "in" })), /2nd (&amp;) 6 at NE 40/);
    assert.doesNotMatch(renderMatchCard(gameEvent({ state: "pre" })), /sports-status-situation/);
    assert.doesNotMatch(renderMatchCard(gameEvent({ state: "post" })), /sports-status-situation/);
    assert.doesNotMatch(renderMatchCard(gameEvent({ state: "in", situation: "" })), /sports-status-situation/);
    // Live basketball: no situation either (ESPN only provides it for football).
    assert.doesNotMatch(renderMatchCard(gameEvent({ state: "in", sportType: "basketball", situation: "BONUS" })), /sports-status-situation/);
  });

  test("the thin red progress bar renders only when a fraction is honestly computable", () => {
    assert.match(renderSource, /sports-status-progress/);
    const live = renderMatchCard(gameEvent({ state: "in" })); // NFL: period 4 of 4 -> 100%
    assert.match(live, /sports-status-progress-fill" style="width:\s*100%/);
    const soccer = renderMatchCard(
      gameEvent({ state: "in", slug: "soccer/eng.1", sportType: "soccer", period: 1 })
    );
    assert.match(soccer, /width:\s*50%/, "soccer is halves: period 1 of 2");
    assert.equal(liveProgressFraction(gameEvent({ state: "pre" })), null);
    assert.equal(liveProgressFraction(gameEvent({ state: "post" })), null);
    assert.equal(liveProgressFraction(gameEvent({ state: "in", slug: "golf/pga", sportType: "golf", period: 3 })), null, "no invented progress for golf");
    assert.doesNotMatch(renderMatchCard(gameEvent({ state: "pre" })), /sports-status-progress-fill/);
  });

  test("an ESPN postponed/suspended status renders the off badge in #FF8A80", () => {
    const view = scoreStatusView(gameEvent({ state: "pre", statusText: "Postponed" }));
    assert.equal(view.kind, "off");
    assert.equal(view.badge, "POSTPONED");
    const html = renderMatchCard(gameEvent({ state: "pre", statusText: "Postponed" }));
    assert.match(html, /sports-status-badge is-off/);
    // The off colours live in the style block, not the inline markup.
    assert.match(renderSource, /\.sports-status-badge\.is-off\s*\{[^}]*background:\s*rgba\(255,138,128,0\.20\)/);
    assert.match(renderSource, /\.sports-status-badge\.is-off\s*\{[^}]*color:\s*#FF8A80/);
  });
});

describe("focus: 1.02 scale + solid white border, instant", () => {
  test("the focused card paints a solid white border and scales 1.02 — no transition, no size change", () => {
    assert.match(renderSource, /\.sports-row\.focused\s*\{[^}]*border-color:\s*#FFFFFF[^}]*\}/);
    const focused = renderSource.match(/\.sports-row\.focused\s*\{[^}]*\}/)[0];
    assert.match(focused, /transform:\s*scale\(1\.02\)/);
    assert.doesNotMatch(focused, /transition/);
    // The border is ALWAYS painted on the card (so focus never changes size).
    assert.match(renderSource, /\.sports-row\s*\{[^}]*border:\s*1\.5px solid rgba\(255,255,255,0\.20\)/);
  });

  test("focus is a class toggle plus native focus() — no per-keypress measurement", () => {
    const applyStart = renderSource.indexOf("applyFocusState()");
    assert.ok(applyStart >= 0, "applyFocusState exists");
    const applyBody = renderSource.slice(applyStart, applyStart + 2400);
    assert.match(applyBody, /\.focus\(/);
    assert.doesNotMatch(applyBody, /getBoundingClientRect|offsetTop|offsetHeight/);
    assert.doesNotMatch(interactSource, /getBoundingClientRect/);
    assert.doesNotMatch(allScreenSource, /behavior:\s*["']smooth["']/);
  });
});

describe("the flat row model and the sections", () => {
  test("the sections render in the fixed order with the honest labels", () => {
    // The labels and their order live in sportsFeed.js (SPORTS_SECTION_*);
    // the renderer paints them verbatim via buildSections.
    assert.deepEqual(sportsFeedSections.SPORTS_SECTION_ORDER, ["live", "upcoming", "finished"]);
    assert.equal(sportsFeedSections.SPORTS_SECTION_LABELS.live, "EN VIVO");
    assert.equal(sportsFeedSections.SPORTS_SECTION_LABELS.upcoming, "PRÓXIMOS");
    assert.equal(sportsFeedSections.SPORTS_SECTION_LABELS.finished, "FINALIZADOS");
    assert.match(renderSource, /row\.label/);
  });

  test("the live section header carries the red dot; counts read 'N partidos'", () => {
    assert.match(renderSource, /sports-live-dot/);
    assert.match(renderSource, /partidos/);
  });

  test("FINALIZADOS starts collapsed and its header toggles it", () => {
    assert.match(mountSource, /finishedExpanded\s*=\s*false/);
    assert.match(interactSource, /toggleFinished|finishedExpanded\s*=/);
  });

  test("the flat row model only exposes finished rows once the section is expanded", () => {
    const sections = [
      { key: "live", events: [gameEvent({ id: "l1" })] },
      { key: "upcoming", events: [gameEvent({ id: "u1" }), gameEvent({ id: "u2" })] },
      { key: "finished", events: [gameEvent({ id: "f1", state: "post", status: "finished", live: false })] }
    ];
    const collapsed = buildMatchRows(sections, false);
    assert.deepEqual(
      collapsed.map((r) => r.event?.id ?? `header:${r.sectionKey}`),
      ["header:live", "l1", "header:upcoming", "u1", "u2", "header:finished"]
    );
    const expanded = buildMatchRows(sections, true);
    assert.deepEqual(
      expanded.map((r) => r.event?.id ?? `header:${r.sectionKey}`),
      ["header:live", "l1", "header:upcoming", "u1", "u2", "header:finished", "f1"]
    );
  });

  test("matchRowTitle renders the two ESPN team names", () => {
    assert.equal(matchRowTitle(gameEvent()), "Green Bay Packers vs New England Patriots");
    assert.equal(matchRowTitle({ home: { name: "Solo" } }), "Solo");
    assert.equal(matchRowTitle({}), "Partido");
  });
});

describe("the ESPN schedule timer: visible-only 60 s rounds", () => {
  test("the 60 s round only exists while the screen is mounted and document is visible", () => {
    assert.equal(sportsRenderNS.SPORTS_SCORES_REFRESH_MS, 60000);
    assert.match(mountSource, /visibilityState\s*===\s*"visible"/);
    assert.match(mountSource, /startScoresTimer/);
    assert.match(mountSource, /SPORTS_SCORES_REFRESH_MS/);
    assert.match(mountSource, /addEventListener\(\s*"visibilitychange"/);
    assert.match(mountSource, /removeEventListener\(\s*"visibilitychange"/);
    assert.match(mountSource, /stopScoresTimer/);
    const visibilityIdx = mountSource.indexOf("handleScoresVisibilityChange() {");
    assert.ok(visibilityIdx >= 0, "the visibility handler exists");
    const visibilityBody = mountSource.slice(visibilityIdx, mountSource.indexOf("},", visibilityIdx));
    assert.match(visibilityBody, /stopScoresTimer|startScoresTimer/);
  });

  test("day change and Actualizar also refresh the ESPN schedule for the visible day", () => {
    assert.match(mountSource, /changeDay[\s\S]{0,800}loadSchedule/);
    assert.match(mountSource + interactSource, /loadSchedule/);
    assert.match(interactSource, /loadSchedule\(\{\s*force:\s*true\s*\}\)/);
    assert.match(mountSource + interactSource, /refresh/);
  });
});

describe("resolve -> probe -> player handoff (unchanged contract, new feed)", () => {
  test("Enter probes the resolved streams BEFORE navigating; the hand-off only follows a successful probe", () => {
    const probeIdx = interactSource.indexOf("probePlayableStreams");
    const navIdx = interactSource.indexOf('Router.navigate("player"');
    assert.ok(probeIdx > 0, "the resolved streams are probed before the hand-off");
    assert.ok(navIdx > probeIdx, "the player navigation happens only after the probe answers");
    assert.match(interactSource, /if \(!probe\.playable\.length\)/, "a failed probe must not navigate");
  });

  test("the player hand-off payload is unchanged: live engine payload and returnRoute sports", () => {
    assert.match(interactSource, /Router\.navigate\(\s*"player"/);
    assert.match(interactSource, /itemType:\s*"channel"/);
    assert.match(interactSource, /returnRoute:\s*"sports"/);
    assert.match(interactSource, /streamCandidates/);
    assert.match(interactSource, /proxyHeaders:\s*\{\s*request:\s*\{\s*\}\s*\}/);
  });

  test("a pending addon answer shows the retry hint rounded to seconds and keeps the row", () => {
    assert.equal(pendingNoticeText(31000), "Señal no lista. Reintenta en 31 s");
    assert.equal(pendingNoticeText(999), "Señal no lista. Reintenta en 1 s");
    assert.equal(pendingNoticeText(0), "Señal no lista. Inténtalo de nuevo en un momento");
    assert.match(interactSource, /pendingNoticeText|status === "pending"/);
  });

  test("resolve errors and empty streams surface the honest failure copy", () => {
    assert.match(renderSource, /No hay señal para este partido/);
    assert.match(interactSource, /SPORTS_NO_SIGNAL_TEXT/);
  });

  test("a probe that finds no live signal shows the honest copy with the count tried", () => {
    assert.equal(probeFailedNoticeText(3), "La señal del addon no responde (3 señales probadas)");
    assert.equal(probeFailedNoticeText(1), "La señal del addon no responde (1 señal probada)");
    assert.equal(probeFailedNoticeText(0), "La señal del addon no responde");
  });

  test("the player exit contract honours returnRoute sports: failed playback returns to Sports, not Home", () => {
    const playerSource = readFileSync(
      new URL("../js/ui/screens/player/playerScreenMethods-70-on-pointer-activate.js", import.meta.url),
      "utf8"
    );
    const exitStart = playerSource.indexOf("exitPlayerOnBack()");
    const exitEnd = playerSource.indexOf("consumeBackRequest()");
    const exitBody = playerSource.slice(exitStart, exitEnd);
    assert.ok(exitStart >= 0 && exitEnd > exitStart, "exitPlayerOnBack exists");
    assert.match(exitBody, /"live"/, "the existing live return route is kept");
    assert.match(exitBody, /"sports"/, "the sports return route is honoured");
    assert.match(exitBody, /popToExistingRoute/, "the exit consumes the player entry, no re-open loop");
    assert.match(exitBody, /Router\.navigate\(\s*returnRoute/, "the fallback exits to the declared route");
    assert.match(exitBody, /navigateBackToStreamScreen\(\)/, "every other case keeps the stream-screen exit");
  });
});

describe("source picker: every playable stream is offered, never silently the first", () => {
  const { sourcePickerOptionLabel, buildSourcePickerRows } = sportsRenderNS;

  test("labels come from the stream's name and resolution", () => {
    assert.equal(sourcePickerOptionLabel({ name: "LaLiga HD", resolution: "1080p" }, 0), "LaLiga HD · 1080p");
    assert.equal(sourcePickerOptionLabel({ name: "Backup", resolution: "720p", verified: false }, 1), "Backup · 720p · no verificada");
  });

  test("a stream without a name falls back to its title, then a numbered Señal", () => {
    assert.equal(sourcePickerOptionLabel({ title: "Canal 2", resolution: "720p" }, 1), "Canal 2 · 720p");
    assert.equal(sourcePickerOptionLabel({ url: "https://x.example/s.m3u8" }, 1), "Señal 2");
  });

  test("one row per playable source, in the addon's stable order, with its label", () => {
    const rows = buildSourcePickerRows([
      { name: "LaLiga HD", resolution: "1080p", url: "https://a.example/s.m3u8" },
      { name: "Backup", resolution: "720p", verified: false, url: "https://b.example/s.m3u8" }
    ]);
    assert.deepEqual(rows.map((r) => r.label), ["LaLiga HD · 1080p", "Backup · 720p · no verificada"]);
    assert.deepEqual(rows.map((r) => r.index), [0, 1]);
  });

  test("the picker is a fixed-geometry panel with native focus and no yellow", () => {
    assert.match(renderSource, /SPORTS_PICKER_TITLE/);
    assert.match(renderSource, /\.sports-picker-option\s*\{[^}]*height:\s*\d+px/);
    assert.match(renderSource, /sports-picker-option focusable/);
    assert.match(renderSource, /data-picker-index=/);
    assert.doesNotMatch(renderSource, /\.sports-picker[\s\S]{0,600}?transition/);
    assert.doesNotMatch(renderSource, /\.sports-picker[\s\S]{0,900}?<img/i);
    assert.doesNotMatch(
      renderSource.slice(renderSource.indexOf(".sports-picker"), renderSource.indexOf(".sports-picker") + 4000),
      YELLOW_PATTERN
    );
  });

  test("one playable stream plays directly — no picker step; several open the picker; none keeps the honest notice", () => {
    const singleIdx = interactSource.indexOf("probe.playable.length === 1");
    assert.ok(singleIdx > 0, "a single candidate plays directly with no extra step");
    const pickerIdx = interactSource.indexOf("openSourcePicker");
    assert.ok(pickerIdx > singleIdx, "the picker is only for the multi-source case");
    assert.match(interactSource, /probeFailedNoticeText\(probe\.tried\)/, "none playable keeps the honest notice");
  });

  test("picker focus/close contract: arrows only move the highlight, Enter plays it, Back closes and refocuses the match row", () => {
    const gateIdx = interactSource.indexOf("if (this.sourcePicker)");
    const dirIdx = interactSource.indexOf("code === 37");
    assert.ok(gateIdx > 0 && dirIdx > gateIdx, "the picker intercepts keys before list navigation");
    const gateBody = interactSource.slice(gateIdx, dirIdx);
    assert.match(gateBody, /playPickedSource/);
    assert.match(gateBody, /movePickerIndex/);
    assert.doesNotMatch(gateBody, /Router\.navigate/, "no player navigation from the picker without Enter");
    const backIdx = interactSource.indexOf("isBackEvent(event)");
    const closeIdx = interactSource.indexOf("closeSourcePicker");
    const routerBackIdx = interactSource.indexOf("Router.back()");
    assert.ok(closeIdx > backIdx && closeIdx < routerBackIdx, "Back closes the picker before Router.back()");
    assert.match(interactSource, /this\.sourcePicker\s*=\s*null/, "closing clears the picker state");
  });

  test("applyFocusState focuses the highlighted picker row while it is open", () => {
    const applyStart = renderSource.indexOf("applyFocusState()");
    const applyBody = renderSource.slice(applyStart, applyStart + 2400);
    assert.match(applyBody, /data-picker-index/);
    assert.match(applyBody, /\.focus\(/);
  });

  test("the resolved playable streams reach the picker with their labels intact", () => {
    assert.match(interactSource, /openSourcePicker\(probe\.playable/, "the picker receives the playable streams");
  });
});

describe("honest states and lifecycle", () => {
  test("loading, empty and error states have visible copy — never a blank panel", () => {
    assert.match(renderSource + mountSource, /Cargando partidos/);
    assert.match(renderSource, /No hay partidos hoy/);
    assert.match(renderSource + mountSource, /No se pudieron cargar los partidos/);
  });

  test("an empty slate renders the honest empty copy, never a black area", () => {
    const rows = buildMatchRows(buildSections([]), false);
    assert.equal(rows.some((row) => row.type === "match"), false);
    assert.match(renderSource, /hasMatches[\s\S]{0,200}SPORTS_EMPTY_TEXT/);
  });

  test("cleanup hides the screen and clears pending state (no leaked timers)", () => {
    assert.match(mountSource, /cleanup\(\)/);
    assert.match(mountSource, /ScreenUtils\.hide/);
    assert.match(mountSource, /clearTimeout|clearNoticeTimer|noticeTimer\s*=\s*0/);
  });
});

// Regression: the sibling method modules reach every helper through `internals`
// (the screen module). A helper that exists but is not exported makes the first
// render throw, which on the TV looks like a black screen and nothing else.
test("every helper the sibling modules destructure is exported by the screen module", async () => {
  const screen = await import("../js/ui/screens/sports/sportsScreen.js");
  const required = [
    "Router",
    "ScreenUtils",
    "Environment",
    "sportsRepository",
    "buildSections",
    "formatKickoffTime",
    "escapeHtml",
    "isBackEvent"
  ];
  const missing = required.filter((name) => screen[name] === undefined);
  assert.deepEqual(missing, [], `the screen module does not export: ${missing.join(", ")}`);
  for (const name of ["escapeHtml", "isBackEvent", "formatKickoffTime", "buildSections"]) {
    assert.equal(typeof screen[name], "function", `${name} must be callable`);
  }
});
