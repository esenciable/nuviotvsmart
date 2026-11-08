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
  pendingNoticeText
} from "../js/ui/screens/sports/sportsScreenMethods-02-render.js";

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
