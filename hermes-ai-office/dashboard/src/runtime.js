export const SDK = window.__HERMES_PLUGIN_SDK__;
export const registry = window.__HERMES_PLUGINS__;
export const runtimeReady = Boolean(SDK && registry && typeof registry.register === "function" && typeof SDK.fetchJSON === "function");
export const React = runtimeReady ? SDK.React : null;
export const h = React ? React.createElement : null;
const fetchJSON = runtimeReady ? SDK.fetchJSON : null;
const API_ROOT = "/api/plugins/hermes-ai-office";
export const DASHBOARD_SCHEMA_VERSION = 8;

export function useLocale() {
  const hook = SDK && SDK.useI18n;
  if (hook) {
    const value = hook();
    return String(value && value.locale ? value.locale : "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  return "en";
}

export function api(path, init) {
  return fetchJSON(API_ROOT + path, init);
}

export function assertDashboardContract(value) {
  if (!value || value.schemaVersion !== DASHBOARD_SCHEMA_VERSION) {
    const actual = value && value.schemaVersion != null ? value.schemaVersion : "missing";
    throw new Error("AI Office dashboard contract mismatch: expected v" + DASHBOARD_SCHEMA_VERSION + ", received v" + actual);
  }
  return value;
}

export function assertPlanDetailContract(value) {
  if (!value || value.schemaVersion !== DASHBOARD_SCHEMA_VERSION || !value.plan || !Array.isArray(value.batches)) {
    throw new Error("AI Office plan detail contract mismatch");
  }
  return value;
}

function parseRgb(value) {
  const text = String(value || "").trim();
  let match = text.match(/^#([0-9a-f]{6})$/i);
  if (match) {
    const hex = match[1];
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  match = text.match(/^#([0-9a-f]{3})$/i);
  if (match) {
    return match[1].split("").map(function (digit) { return parseInt(digit + digit, 16); });
  }
  match = text.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function detectThemeMode() {
  const root = window.getComputedStyle(document.documentElement);
  const rgb = parseRgb(root.getPropertyValue("--background-base") || root.getPropertyValue("--background"));
  if (rgb) {
    const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return luminance > 0.55 ? "light" : "dark";
  }
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useThemeMode() {
  const [mode, setMode] = React.useState(detectThemeMode);
  React.useEffect(function () {
    let frame = 0;
    function update() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(function () { setMode(detectThemeMode()); });
    }
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    if (document.head) observer.observe(document.head, { childList: true, subtree: true, attributes: true });
    const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
    if (media && media.addEventListener) media.addEventListener("change", update);
    update();
    return function () {
      observer.disconnect();
      if (media && media.removeEventListener) media.removeEventListener("change", update);
      window.cancelAnimationFrame(frame);
    };
  }, []);
  return mode;
}

