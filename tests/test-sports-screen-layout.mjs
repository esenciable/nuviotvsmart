// Layout contract for the lightweight Sports screen (source contract, like
// tests/test-live-screen-layout.mjs). node --test runs fully offline: pure
// helpers are imported, everything else is pinned against the SOURCE TEXT.
//
// Rules inherited from Live TV: fixed geometry (no resize on focus), native
// focus (class toggle + focus()), no per-keypress DOM measurement, no focus
// animations, NO images (Samsung 120 MB cap — we removed channel images for
// exactly this reason), and NO background polling loops.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SPORTS_ROW_HEIGHT,
  buildMatchRows,
  matchRowTitle,
  pendingNoticeText,
  probeFailedNoticeText
} from "../js/ui/screens/sports/sportsScreenMethods-02-render.js";
// Namespace access for the NEW picker helpers: a missing export must fail
// exactly the picker tests, not load-fail the whole file.
import * as sportsRenderNS from "../js/ui/screens/sports/sportsScreenMethods-02-render.js";
import { parseEvents, buildSections } from "../js/core/sports/sportsFeed.js";

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

describe("screen structure: header, day chips, sport chips, Actualizar", () => {
  test("header carries the title, the Ayer/Hoy/Mañana day chips (default Hoy) and the Actualizar action", () => {
    assert.match(renderSource, /Deportes/);
    assert.match(renderSource, /Ayer/);
    assert.match(renderSource, /Hoy/);
    assert.match(renderSource, /Mañana/);
    assert.match(renderSource, /Actualizar/);
    // Default day is Hoy, applied on mount.
    assert.match(mountSource, /dayKey\s*=\s*"today"/);
  });

  test("sport chips: Todos plus one chip per sportType present today", () => {
    assert.match(renderSource, /Todos/);
    assert.match(mountSource + renderSource, /sportChips|chipsForEvents/);
  });

  test("the day change triggers a refresh; there is NO polling interval anywhere", () => {
    assert.match(mountSource, /changeDay|selectDay/);
    assert.doesNotMatch(allScreenSource, /setInterval/);
  });
});

describe("vertical sections: EN VIVO, PRÓXIMOS, FINALIZADOS (collapsed by default)", () => {
  test("the sections render in the fixed order with the honest labels", () => {
    const liveIdx = renderSource.indexOf("EN VIVO");
    const upcomingIdx = renderSource.indexOf("PRÓXIMOS");
    const finishedIdx = renderSource.indexOf("FINALIZADOS");
    assert.ok(liveIdx >= 0, "EN VIVO section exists");
    assert.ok(upcomingIdx > liveIdx, "PRÓXIMOS follows EN VIVO");
    assert.ok(finishedIdx > upcomingIdx, "FINALIZADOS comes last");
  });

  test("FINALIZADOS starts collapsed and its header toggles it", () => {
    assert.match(mountSource, /finishedExpanded\s*=\s*false/);
    assert.match(interactSource, /toggleFinished|finishedExpanded\s*=/);
  });
});

describe("match rows: fixed height, no images, honest content", () => {
  test("rows have a fixed px height constant and CSS", () => {
    assert.equal(SPORTS_ROW_HEIGHT, 64);
    assert.match(renderSource, /SPORTS_ROW_HEIGHT\s*=\s*64/);
    assert.match(renderSource, /\.sports-row\s*\{[^}]*height:\s*64px/);
  });

  test("the screen never creates or loads an image: no <img>, no background-image, no logo plumbing", () => {
    assert.doesNotMatch(allScreenSource, /<img/i);
    assert.doesNotMatch(allScreenSource, /background-image/);
    assert.doesNotMatch(allScreenSource, /data:image/);
    assert.doesNotMatch(allScreenSource, /object-fit/);
    assert.doesNotMatch(allScreenSource, /\.logo\b/);
  });

  test("each row shows the leading time or EN VIVO badge, the muted league, the two team names and the live score", () => {
    assert.match(renderSource, /sports-row-time/);
    assert.match(renderSource, /EN VIVO/);
    assert.match(renderSource, /sports-row-league/);
    assert.match(renderSource, /matchRowTitle/);
    assert.match(renderSource, /sports-row-score/);
  });

  test("the flat row model only exposes finished rows once the section is expanded", () => {
    const sections = [
      { key: "live", events: [{ id: "l1" }] },
      { key: "upcoming", events: [{ id: "u1" }, { id: "u2" }] },
      { key: "finished", events: [{ id: "f1" }] }
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

  test("matchRowTitle renders the two team names without logos", () => {
    const event = { teams: [{ name: "Equipo A" }, { name: "Equipo B" }], title: "fallback" };
    assert.equal(matchRowTitle(event), "Equipo A vs Equipo B");
    assert.equal(matchRowTitle({ teams: [{ name: "Solo" }], title: "Titular" }), "Titular");
  });
});

describe("focus rules inherited from Live TV", () => {
  test("focus is a class toggle plus native focus() — no per-keypress measurement", () => {
    const applyStart = renderSource.indexOf("applyFocusState()");
    assert.ok(applyStart >= 0, "applyFocusState exists");
    const applyBody = renderSource.slice(applyStart, applyStart + 2400);
    assert.match(applyBody, /\.focus\(/);
    assert.doesNotMatch(applyBody, /getBoundingClientRect|offsetTop|offsetHeight/);
  });

  test("no focus animations: no transition on the focused state, no smooth scrolling, no scale", () => {
    assert.doesNotMatch(renderSource, /\.sports-row\.focused\s*\{[^}]*transition/);
    assert.doesNotMatch(allScreenSource, /behavior:\s*["']smooth["']/);
    assert.doesNotMatch(allScreenSource, /scale\(/);
  });

  test("key handling routes through onKeyDown without DOM measurement per keypress", () => {
    assert.match(interactSource, /onKeyDown\(/);
    assert.doesNotMatch(interactSource, /getBoundingClientRect/);
  });
});

describe("resolve -> player handoff", () => {
  test("Enter resolves the match and hands off to the player with the live engine payload and returnRoute sports", () => {
    assert.match(interactSource, /resolveStreams/);
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
    // The notice is patched in place — the list is not re-rendered away.
    assert.doesNotMatch(interactSource, /this\.render\(\).*pending/);
  });

  test("resolve errors and empty streams surface the honest failure copy", () => {
    assert.match(renderSource, /No hay señal para este partido/);
    assert.match(interactSource, /SPORTS_NO_SIGNAL_TEXT/);
  });
});

describe("probe before hand-off and player recovery", () => {
  const playerSource = readFileSync(
    new URL("../js/ui/screens/player/playerScreenMethods-70-on-pointer-activate.js", import.meta.url),
    "utf8"
  );
  const exitStart = playerSource.indexOf("exitPlayerOnBack()");
  const exitEnd = playerSource.indexOf("consumeBackRequest()");
  const exitBody = playerSource.slice(exitStart, exitEnd);

  test("Enter probes the resolved streams BEFORE navigating; the hand-off only follows a successful probe", () => {
    const probeIdx = interactSource.indexOf("probePlayableStreams");
    const navIdx = interactSource.indexOf('Router.navigate("player"');
    assert.ok(probeIdx > 0, "the resolved streams are probed before the hand-off");
    assert.ok(navIdx > probeIdx, "the player navigation happens only after the probe answers");
    assert.match(interactSource, /if \(!probe\.playable\.length\)/, "a failed probe must not navigate");
  });

  test("a probe that finds no live signal shows the honest copy with the count tried", () => {
    assert.equal(probeFailedNoticeText(3), "La señal del addon no responde (3 señales probadas)");
    assert.equal(probeFailedNoticeText(1), "La señal del addon no responde (1 señal probada)");
    assert.equal(probeFailedNoticeText(0), "La señal del addon no responde");
  });

  test("an empty day (real payload shape) renders the honest empty copy, never a black area", () => {
    const events = parseEvents({ generatedAt: "2026-01-15T10:00:00Z", count: 0, events: [] });
    const rows = buildMatchRows(buildSections(events), false);
    assert.equal(rows.some((row) => row.type === "match"), false);
    // The renderer's no-match branch shows the empty copy instead of nothing.
    assert.match(renderSource, /hasMatches[\s\S]{0,200}SPORTS_EMPTY_TEXT/);
  });

  test("the player exit contract honours returnRoute sports: failed playback returns to Sports, not Home", () => {
    assert.ok(exitStart >= 0 && exitEnd > exitStart, "exitPlayerOnBack exists");
    assert.match(exitBody, /"live"/, "the existing live return route is kept");
    assert.match(exitBody, /"sports"/, "the sports return route is honoured");
    assert.match(exitBody, /popToExistingRoute/, "the exit consumes the player entry, no re-open loop");
    assert.match(exitBody, /Router\.navigate\(\s*returnRoute/, "the fallback exits to the declared route");
    assert.match(exitBody, /navigateBackToStreamScreen\(\)/, "every other case keeps the stream-screen exit");
  });
});

// ESPN live scores on the row: the owner's reference layout — two team lines
// (name left, muted record, big right-aligned tabular figure) and a status
// block (red ● EN VIVO + period · clock, FINAL, or the local kickoff time),
// with the down/distance line only for live football. The scored round is a
// 60 s chained timer that ONLY runs while the screen is mounted and visible.
describe("ESPN live scores: scored row layout and the visible-only 60 s timer", () => {
  const {
    SPORTS_SCORES_REFRESH_MS,
    periodOrdinal,
    formatPeriodClock,
    scoreStatusView,
    renderScoredRowInner
  } = sportsRenderNS;

  const game = (over = {}) => ({
    slug: "football/nfl",
    kickoffMs: Date.UTC(2026, 0, 15, 18, 0, 0),
    state: "in",
    statusText: "Q4 15:00",
    period: 4,
    clock: "15:00",
    situation: "3rd & 7",
    home: { name: "Home Team", score: 24, record: "8-3" },
    away: { name: "Away Team", score: 17, record: "5-6" },
    ...over
  });

  test("period and clock format like the reference: 4th · 15:00", () => {
    assert.equal(periodOrdinal(1), "1st");
    assert.equal(periodOrdinal(2), "2nd");
    assert.equal(periodOrdinal(3), "3rd");
    assert.equal(periodOrdinal(4), "4th");
    assert.equal(periodOrdinal(12), "12th");
    assert.equal(periodOrdinal(0), "");
    assert.equal(formatPeriodClock(4, "15:00"), "4th · 15:00");
    assert.equal(formatPeriodClock(2, ""), "2nd");
    assert.equal(formatPeriodClock(0, "8:03"), "8:03");
    assert.equal(formatPeriodClock(0, ""), "");
  });

  test("a live scored row: two team lines with record and big right-aligned figure, red EN VIVO badge with period · clock under it", () => {
    const html = renderScoredRowInner(game());
    assert.match(html, /Home Team/);
    assert.match(html, /Away Team/);
    assert.match(html, /8-3/);
    assert.match(html, /sports-score-figure[^<]*>24</);
    assert.match(html, /● EN VIVO/);
    assert.match(html, /4th · 15:00/);
    assert.match(html, /sports-live-badge/);
    // No images anywhere, same rule as the whole screen.
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /background-image|data:image|object-fit|\.logo\b/);
  });

  test("the down/distance line renders only for LIVE football when ESPN provides it", () => {
    assert.match(renderScoredRowInner(game()), /3rd (&amp;) 7/, "& is escaped like every row");
    assert.doesNotMatch(renderScoredRowInner(game({ state: "pre" })), /3rd & 7/);
    assert.doesNotMatch(renderScoredRowInner(game({ situation: "" })), /sports-status-situation/);
  });

  test("FINAL rows and not-yet-started rows use the same status block", () => {
    assert.match(renderScoredRowInner(game({ state: "post" })), /FINAL/);
    assert.doesNotMatch(renderScoredRowInner(game({ state: "post" })), /EN VIVO/);
    const pre = renderScoredRowInner(game({ state: "pre", period: 0, clock: "" }));
    assert.match(pre, /\d{2}:\d{2}/, "pre rows show the local kickoff time");
    assert.equal(scoreStatusView(game({ state: "pre" })).kind, "time");
  });

  test("buildMatchRows merges the matched ESPN score into the row; rows without a counterpart stay null", () => {
    const sections = [
      {
        key: "live",
        events: [
          {
            id: "m1",
            kickoffMs: game().kickoffMs + 5 * 60 * 1000,
            teams: [{ name: "Home Team" }, { name: "Away Team" }]
          },
          { id: "m2", kickoffMs: game().kickoffMs, teams: [{ name: "Otro" }, { name: "Cualquiera" }] }
        ]
      }
 ];
    const rows = buildMatchRows(sections, false, [game()]);
    const matchRows = rows.filter((r) => r.type === "match");
    assert.equal(matchRows[0].score?.home.score, 24, "the matched score is merged into the row");
    assert.equal(matchRows[1].score, null, "no counterpart: no score, never a blank or a zero");
    // Without scores the rows are exactly today's rows.
    const legacy = buildMatchRows(sections, false);
    assert.equal(legacy.filter((r) => r.type === "match")[0].score, null);
  });

  test("renderMatchRow keeps the legacy row for rows without a score and uses the scored layout only when merged", () => {
    const branchIdx = renderSource.indexOf("if (row.score)");
    assert.ok(branchIdx >= 0, "the scored layout is guarded by the presence of a merged score");
    assert.match(renderSource, /renderScoredRowInner\(row\.score\)/);
    // The legacy branch (time lead, muted league, teams title, addon score)
    // is untouched below the guard.
    const legacyBody = renderSource.slice(branchIdx + 10);
    assert.match(legacyBody, /sports-row-league/);
    assert.match(legacyBody, /matchRowTitle\(/);
  });

  test("the 60 s scores timer only exists while the screen is mounted and document is visible", () => {
    assert.equal(SPORTS_SCORES_REFRESH_MS, 60000);
    // The timer arm is gated on visibility; it is a chained setTimeout (no
    // setInterval anywhere — asserted above) and it is cleared on unmount.
    assert.match(mountSource, /visibilityState\s*===\s*"visible"/);
    assert.match(mountSource, /startScoresTimer/);
    assert.match(mountSource, /SPORTS_SCORES_REFRESH_MS/);
    assert.match(mountSource, /addEventListener\(\s*"visibilitychange"/);
    assert.match(mountSource, /removeEventListener\(\s*"visibilitychange"/);
    assert.match(mountSource, /stopScoresTimer/);
    // Hiding stops the timer, showing restarts it (and scores again).
    const visibilityIdx = mountSource.indexOf("handleScoresVisibilityChange() {");
    assert.ok(visibilityIdx >= 0, "the visibility handler exists");
    const visibilityBody = mountSource.slice(visibilityIdx, mountSource.indexOf("},", visibilityIdx));
    assert.match(visibilityBody, /stopScoresTimer|startScoresTimer/);
  });

  test("day change and Actualizar also refresh the scores for the visible day", () => {
    assert.match(mountSource, /loadScores/);
    assert.match(mountSource + interactSource, /this\.scores\s*=\s*\[\]/);
  });
});

// The source picker: when a match resolves to MORE than one playable stream
// the screen offers every one of them instead of silently playing the first.
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

  test("verified:false is the addon's own marker: surfaced when declared, never invented", () => {
    assert.equal(sourcePickerOptionLabel({ name: "Ok", resolution: "1080p", verified: true }, 0), "Ok · 1080p");
    assert.equal(sourcePickerOptionLabel({ name: "Ok", resolution: "1080p" }, 0), "Ok · 1080p");
  });

  test("one row per playable source, in the addon's stable order, with its label", () => {
    const rows = buildSourcePickerRows([
      { name: "LaLiga HD", resolution: "1080p", url: "https://a.example/s.m3u8" },
      { name: "Backup", resolution: "720p", verified: false, url: "https://b.example/s.m3u8" }
    ]);
    assert.deepEqual(rows.map((r) => r.index), [0, 1]);
    assert.deepEqual(rows.map((r) => r.label), ["LaLiga HD · 1080p", "Backup · 720p · no verificada"]);
    assert.equal(rows[0].unverified, false);
    assert.equal(rows[1].unverified, true);
  });

  test("the picker is a fixed-geometry panel with native focus and no images", () => {
    assert.match(renderSource, /SPORTS_PICKER_TITLE/);
    assert.match(renderSource, /\.sports-picker-option\s*\{[^}]*height:\s*\d+px/);
    assert.match(renderSource, /sports-picker-option focusable/);
    assert.match(renderSource, /data-picker-index=/);
    // Same rules as the rest of the screen: no transition, no images.
    assert.doesNotMatch(renderSource, /\.sports-picker[\s\S]{0,600}?transition/);
    assert.doesNotMatch(renderSource, /\.sports-picker[\s\S]{0,900}?<img/i);
  });

  test("one playable stream plays directly — no picker step; several open the picker; none keeps the honest notice", () => {
    const singleIdx = interactSource.indexOf("probe.playable.length === 1");
    assert.ok(singleIdx > 0, "a single candidate plays directly with no extra step");
    const pickerIdx = interactSource.indexOf("openSourcePicker");
    assert.ok(pickerIdx > singleIdx, "the picker is only for the multi-source case");
    assert.match(interactSource, /probeFailedNoticeText\(probe\.tried\)/, "none playable keeps the honest notice");
  });

  test("picker focus/close contract: arrows only move the highlight, Enter plays it, Back closes and refocuses the match row", () => {
    // The picker gate answers keys BEFORE the normal list navigation handling.
    const gateIdx = interactSource.indexOf("if (this.sourcePicker)");
    const dirIdx = interactSource.indexOf("code === 37");
    assert.ok(gateIdx > 0 && dirIdx > gateIdx, "the picker intercepts keys before list navigation");
    const gateBody = interactSource.slice(gateIdx, dirIdx);
    assert.match(gateBody, /playPickedSource/);
    assert.match(gateBody, /movePickerIndex/);
    assert.doesNotMatch(gateBody, /Router\.navigate/, "no player navigation from the picker without Enter");
    // Back closes the picker instead of leaving the screen.
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
    assert.doesNotMatch(applyBody, /getBoundingClientRect|offsetTop|offsetHeight/);
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

  test("refresh happens on entry, on Actualizar and on day change — via the repository, not a loop", () => {
    assert.match(mountSource, /loadEvents/);
    assert.match(mountSource + interactSource, /refresh/);
    assert.match(mountSource + interactSource, /sportsRepository/);
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
    "sportChips",
    "formatKickoffTime",
    "escapeHtml",
    "isBackEvent"
  ];
  const missing = required.filter((name) => screen[name] === undefined);
  assert.deepEqual(missing, [], `the screen module does not export: ${missing.join(", ")}`);
  for (const name of ["escapeHtml", "isBackEvent", "formatKickoffTime", "buildSections", "sportChips"]) {
    assert.equal(typeof screen[name], "function", `${name} must be callable`);
  }
});
