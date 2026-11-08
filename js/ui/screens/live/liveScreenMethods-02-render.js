/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

// Rendering. The shell is a categories rail on the left and the selected
// category's channel grid on the right. Each panel shows a quiet loading
// state while its data arrives and never goes blank on an error. The styles
// are inlined here because the screen ships without a dedicated stylesheet.
export function createLiveScreenMethods02() {
  const { ScreenUtils, renderLoadingIndicator, escapeHtml, t } = internals;

  const STYLE = `
    <style id="live-screen-style">
      .live-shell { position: absolute; inset: 0; display: flex; background: #101014; color: #f5f5f5; overflow: hidden; }
      .live-rail { width: 26%; min-width: 240px; height: 100%; overflow-y: auto; padding: 24px 0; background: rgba(0,0,0,0.35); box-sizing: border-box; }
      .live-rail-title { font-size: 28px; font-weight: 700; padding: 0 24px 16px; margin: 0; }
      .live-category { display: block; width: 100%; text-align: left; background: transparent; border: 0; color: #cfcfd6; font-size: 20px; padding: 12px 24px; box-sizing: border-box; outline: none; cursor: pointer; }
      .live-category.selected { color: #ffffff; font-weight: 700; border-left: 4px solid var(--secondary-color, #f5f5f5); }
      .live-category.focused, .live-channel-card.focused { outline: 3px solid var(--secondary-color, #f5f5f5); outline-offset: -3px; background: rgba(255,255,255,0.10); }
      .live-channel-card.focused { transform: scale(1.04); box-shadow: 0 0 0 6px rgba(255,255,255,0.18); }
      .live-main { flex: 1; height: 100%; display: flex; flex-direction: column; box-sizing: border-box; padding: 24px 32px; }
      .live-main-header { font-size: 24px; font-weight: 700; margin: 0 0 16px; }
      .live-main-count { font-size: 16px; font-weight: 400; color: #9a9aa4; margin-left: 12px; }
      .live-grid { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 16px; align-content: start; }
      .live-channel-card { background: rgba(255,255,255,0.06); border-radius: 12px; padding: 12px; outline: none; cursor: pointer; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; transition: transform 100ms ease; }
      .live-channel-logo { width: 100%; height: 84px; object-fit: contain; border-radius: 8px; background: rgba(0,0,0,0.35); }
      .live-channel-logo.placeholder { display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 700; color: #cfcfd6; }
      .live-channel-name { font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-channel-number { font-size: 13px; color: #9a9aa4; }
      .live-channel-tuning { font-size: 13px; color: var(--secondary-color, #f5f5f5); }
      .live-panel-state { display: flex; align-items: center; gap: 12px; color: #9a9aa4; font-size: 17px; padding: 16px 0; }
      .live-panel-error { color: #ffb4a8; font-size: 16px; padding: 16px 0; overflow-wrap: anywhere; }
      .live-notice { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; background: rgba(20,20,26,0.95); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; padding: 12px 18px; font-size: 15px; color: #f5f5f5; overflow-wrap: anywhere; }
    </style>
  `;

  return {
    render({ preserveFocus = true } = {}) {
      const focusKey = preserveFocus ? this.lastFocusedKey : null;
      const railMarkup = this.renderCategoriesRail();
      const gridMarkup = this.renderChannelGrid();
      const noticeMarkup = this.notice ? `<div class="live-notice" role="status">${escapeHtml(this.notice)}</div>` : "";

      this.container.innerHTML = `
        ${STYLE}
        <div class="live-shell">
          <aside class="live-rail">${railMarkup}</aside>
          <section class="live-main">${gridMarkup}</section>
          ${noticeMarkup}
        </div>
      `;

      ScreenUtils.indexFocusables(this.container);
      if (focusKey) {
        const target = this.container.querySelector(`[data-focus-key="${focusKey}"]`);
        if (target) {
          this.container.querySelectorAll(".focusable.focused").forEach((node) => {
            if (node !== target) node.classList.remove("focused");
          });
          target.classList.add("focused");
          focusWithoutAutoScrollSafe(target);
          this.ensureFocusVisible?.({ smooth: false });
          return;
        }
      }
      ScreenUtils.setInitialFocus(this.container);
      this.ensureFocusVisible?.({ smooth: false });
    },

    renderCategoriesRail() {
      const title = escapeHtml(t("sidebar.live", {}, "Live TV"));
      if (this.categoriesLoading) {
        return `
          <h2 class="live-rail-title">${title}</h2>
          <div class="live-panel-state">
            ${renderLoadingIndicator()}
            <span>${escapeHtml(t("live_categories_loading", {}, "Loading categories..."))}</span>
          </div>
        `;
      }
      if (this.categoriesError) {
        return `
          <h2 class="live-rail-title">${title}</h2>
          <div class="live-panel-error">${escapeHtml(
            `${t("live_categories_error", {}, "Could not load Live TV")}: ${this.categoriesError}`
          )}</div>
        `;
      }
      const items = this.categories
        .map((category, index) => {
          const selected = String(category?.columnId) === String(this.selectedColumnId);
          return `
            <button class="live-category focusable${selected ? " selected" : ""}"
                    data-action="selectCategory"
                    data-column-id="${escapeHtml(String(category?.columnId ?? ""))}"
                    data-focus-key="category:${index}">
              ${escapeHtml(category?.name || t("live_category_unnamed", {}, "Unnamed category"))}
            </button>
          `;
        })
        .join("");
      return `
        <h2 class="live-rail-title">${title}</h2>
        ${items || `<div class="live-panel-error">${escapeHtml(t("live_categories_empty", {}, "No categories available"))}</div>`}
      `;
    },

    renderChannelGrid() {
      const category = this.categories.find((category) => String(category?.columnId) === String(this.selectedColumnId));
      const channelCount = Array.isArray(this.channels) ? this.channels.length : 0;
      const countLabel = this.channelsLoading
        ? ""
        : `<span class="live-main-count">${escapeHtml(t("live_channel_count", { count: channelCount }, "{{count}} channels"))}</span>`;
      const header = `<h2 class="live-main-header">${escapeHtml(
        category?.name || t("live_channels_title", {}, "Channels")
      )}${countLabel}</h2>`;

      if (this.channelsLoading) {
        return `
          ${header}
          <div class="live-panel-state">
            ${renderLoadingIndicator()}
            <span>${escapeHtml(t("live_channels_loading", {}, "Loading channels..."))}</span>
          </div>
        `;
      }
      if (this.channelsError) {
        return `
          ${header}
          <div class="live-panel-error">${escapeHtml(
            `${t("live_channels_error", {}, "Could not load channels")}: ${this.channelsError}`
          )}</div>
        `;
      }
      const channels = Array.isArray(this.channels) ? this.channels : [];
      if (!channels.length) {
        return `
          ${header}
          <div class="live-panel-error">${escapeHtml(t("live_channels_empty", {}, "No channels available"))}</div>
        `;
      }
      const cards = channels
        .map((channel, index) => {
          const tuning = this.tuningChannelId && this.tuningChannelId === String(channel.id);
          return `
            <article class="live-channel-card focusable"
                     data-action="tuneIn"
                     data-channel-id="${escapeHtml(String(channel.id || ""))}"
                     data-channel-title="${escapeHtml(channel.name || t("live_channel_fallback_title", {}, "Live channel"))}"
                     data-focus-key="channel:${index}">
              ${
                channel.logo
                  ? `<img class="live-channel-logo" src="${escapeHtml(channel.logo)}" alt="${escapeHtml(channel.name || "channel")}" loading="lazy" decoding="async" />`
                  : `<div class="live-channel-logo placeholder">${escapeHtml((channel.name || "?").charAt(0).toUpperCase())}</div>`
              }
              <div class="live-channel-name">${escapeHtml(channel.name || "")}</div>
              ${tuning ? `<div class="live-channel-tuning">${escapeHtml(t("live_tuning", {}, "Tuning..."))}</div>` : `<div class="live-channel-number">${escapeHtml(channel.number != null ? String(channel.number) : "")}</div>`}
            </article>
          `;
        })
        .join("");
      return `${header}<div class="live-grid">${cards}</div>`;
    }
  };
}

function focusWithoutAutoScrollSafe(node) {
  try {
    internals.focusWithoutAutoScroll(node);
  } catch (_) {
    try {
      node?.focus?.();
    } catch (_) {
      // Focus is best effort on constrained TV engines.
    }
  }
}
