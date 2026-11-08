import { Router } from "../../navigation/routerState.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { Environment } from "../../../platform/environment.js";
import { I18n } from "../../../i18n/index.js";
import { focusWithoutAutoScroll } from "../../components/sidebarNavigation.js";
import { renderLoadingIndicator } from "../../components/loadingIndicator.js";
import { liveRepository } from "../../../data/repository/liveRepository.js";

import { createLiveScreenMethods01 } from "./liveScreenMethods-01-mount-and-load.js";
import { createLiveScreenMethods02 } from "./liveScreenMethods-02-render.js";
import { createLiveScreenMethods03 } from "./liveScreenMethods-03-tune-in.js";

export {
  Router,
  ScreenUtils,
  Environment,
  focusWithoutAutoScroll,
  renderLoadingIndicator,
  liveRepository,
  isBackEvent,
  escapeHtml,
  t
};

function isBackEvent(event) {
  return Environment.isBackEvent(event);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function t(key, params = {}, fallback = key) {
  return I18n.t(key, params, { fallback });
}

export const LiveScreen = {
  ...createLiveScreenMethods01(),
  ...createLiveScreenMethods02(),
  ...createLiveScreenMethods03()
};
