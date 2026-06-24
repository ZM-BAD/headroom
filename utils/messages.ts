/**
 * Shared message protocol: content scripts ↔ background ↔ side panel.
 *
 * Round capture is driven by the ROOT CAUSE of "model finished": the streaming
 * completion response closing (webRequest onCompleted in the background). The
 * platform's history API (adapter.fetchHistory) is the SOLE authority for round
 * identity — it returns every message's stable `message_id`, unaffected by the
 * virtual list (which keeps only visible messages in the DOM). So both "open a
 * conversation" and "a round finished" trigger the same thing: the content
 * script fetches history → HISTORY_PARSED → the background rebuilds the record.
 */

import type { RoundRecord } from "./dialogue-record";
import type { HistoryRound } from "./platform-adapter";

/** Content script announces a supported page is open (for panel scoping). */
export interface PageReadyMessage {
  type: "PAGE_READY";
  platformId: string;
  url: string;
}

/** Side panel asks the background for the current usage state. */
export interface GetStateMessage {
  type: "GET_STATE";
}

/** Background pushes a usage-state update to the side panel. */
export interface StateUpdateMessage {
  type: "STATE_UPDATE";
  state: UsageState;
}

/**
 * Background → content script: the SSE completion stream just closed (the model
 * finished this round). The content script re-fetches the conversation's full
 * history (the new round is already in it — verified, no lag) and ships
 * HISTORY_PARSED. The background then REPLACES the record with the
 * message_id-authoritative view.
 */
export interface RefreshHistoryMessage {
  type: "REFRESH_HISTORY";
}

/**
 * Content → background: the full history of the conversation, parsed from the
 * platform's history API (adapter.fetchHistory), ascending by message_id. The
 * background estimates each round's tokens and REPLACES the local record — the
 * "history is the sole authority" model. Sent on open, SPA switch, and after a
 * round finishes (REFRESH_HISTORY).
 */
export interface HistoryParsedMessage {
  type: "HISTORY_PARSED";
  platformId: string;
  url: string;
  rounds: HistoryRound[];
}

export type HeadroomMessage =
  | PageReadyMessage
  | GetStateMessage
  | StateUpdateMessage
  | RefreshHistoryMessage
  | HistoryParsedMessage;

/**
 * Live usage state rendered by the side panel — a pure DISPLAY projection of
 * the active dialogue's totals (spec 001: platform name + context + ratio +
 * round count, no conversation title/id — v1 shows the platform, not the
 * model or chat identity). `platformId` null = not on a supported page.
 *
 * The conversation identity (dialogueId) stays internal to the background
 * (it keys the local record); it is not shipped to the panel.
 */
export interface UsageState {
  platformId: string | null;
  contextLimit: number | null;
  totalTokens: number;
  lastRoundTokens: number | null;
  roundCount: number;
  /** Recent rounds (trimmed) for the per-round input/output breakdown in the panel. */
  rounds: RoundRecord[];
}
