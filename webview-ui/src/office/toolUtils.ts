import { FIT_CONTENT_MARGIN, ZOOM_DEFAULT_DPR_FACTOR, ZOOM_MAX, ZOOM_MIN } from '../constants.js';
import { TILE_SIZE, TileType } from './types.js';

/** Map status prefixes back to tool names for animation selection */
const STATUS_TO_TOOL: Record<string, string> = {
  Reading: 'Read',
  Searching: 'Grep',
  Globbing: 'Glob',
  Fetching: 'WebFetch',
  'Searching web': 'WebSearch',
  Writing: 'Write',
  Editing: 'Edit',
  Running: 'Bash',
  Task: 'Task',
  Planning: 'Plan',
  Thinking: 'Think',
  Testing: 'Test',
  Waiting: 'Wait',
};

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool;
  }
  const first = status.split(/[\s:]/)[0];
  return first || null;
}

/** Compute a default integer zoom level (device pixels per sprite pixel) */
export function defaultZoom(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * dpr));
}

export interface FitViewResult {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Compute the initial fit-to-content view: zoom so the layout's non-VOID
 * content bounds occupy `FIT_CONTENT_MARGIN` (75%) of the viewport, and pan so
 * the content center sits at the viewport center. `viewportW`/`viewportH` are
 * in device pixels. Returns null when the layout has no content (all VOID).
 *
 * Zoom is rounded to an integer (the renderer + sprite cache assume integer
 * device-pixels-per-sprite-pixel). Pan centers the content within the map
 * (which the renderer centers in the viewport at pan = 0).
 */
export function computeFitView(
  layout: { cols: number; rows: number; tiles: number[] },
  viewportW: number,
  viewportH: number,
): FitViewResult | null {
  let minC = Infinity;
  let maxC = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      if (layout.tiles[r * layout.cols + c] === TileType.VOID) continue;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  if (maxC < minC || maxR < minR) return null;

  const contentW = (maxC - minC + 1) * TILE_SIZE;
  const contentH = (maxR - minR + 1) * TILE_SIZE;
  if (contentW <= 0 || contentH <= 0 || viewportW <= 0 || viewportH <= 0) return null;

  const raw = Math.min(viewportW / contentW, viewportH / contentH) * FIT_CONTENT_MARGIN;
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(raw)));

  // Center content: the map is centered in the viewport at pan = 0, so shift by
  // the offset between the content center and the map center, in device pixels.
  const contentCenterX = ((minC + maxC + 1) / 2) * TILE_SIZE;
  const contentCenterY = ((minR + maxR + 1) / 2) * TILE_SIZE;
  const panX = (layout.cols * TILE_SIZE) / 2 - contentCenterX;
  const panY = (layout.rows * TILE_SIZE) / 2 - contentCenterY;

  return { zoom, panX: panX * zoom, panY: panY * zoom };
}

// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated once by the `providerCapabilities` postMessage after `webviewReady`.
// Modules classifying tools (character animation, subagent creation gate) read
// from here instead of hardcoding Claude-specific tool names.

const providerCaps: {
  readingTools: Set<string>;
  subagentToolNames: Set<string>;
} = {
  readingTools: new Set(),
  subagentToolNames: new Set(),
};

export function setProviderCapabilities(caps: {
  readingTools: string[];
  subagentToolNames: string[];
}): void {
  providerCaps.readingTools = new Set(caps.readingTools);
  providerCaps.subagentToolNames = new Set(caps.subagentToolNames);
}

export function isReadingToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.readingTools.has(name);
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.subagentToolNames.has(name);
}
