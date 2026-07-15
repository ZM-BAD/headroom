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
  /** Conversation title scraped from the DOM (adapter.dialogueTitleFromDoc), if available. */
  dialogueTitle: string | null;
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
  /** Conversation title scraped from the DOM, re-sent in case it changed (rename). */
  dialogueTitle: string | null;
  /**
   * When true, the background skips cloud read/write — this is a real-time
   * streaming update (local broadcast only). The final settled ship is
   * non-provisional and writes the cloud in one GET+SET pair. Absent ⇒
   * full path with cloud sync (legacy; every other platform).
   */
  provisional?: boolean;
}

/**
 * Content → background: the platform's full conversation-id list (adapter.
 * fetchConversationList on the home page). The background diffs it against
 * the cloud keys (SCAN) and DELs the orphans — zombie cleanup (spec 003).
 * Sent on home-page load (no dialogue id open).
 */
export interface ConversationListMessage {
  type: "CONVERSATION_LIST";
  platformId: string;
  url: string;
  ids: string[];
}

/**
 * Background → content script: the alarm fired and wants a fresh conversation
 * list for zombie cleanup. The content script fetches and replies with
 * CONVERSATION_LIST (separate message). No response payload — fire-and-forget.
 */
export interface FetchConversationListMessage {
  type: "FETCH_CONVERSATION_LIST";
}

/** Background → content script: return the current dialogue title synchronously. */
export interface GetTitleMessage {
  type: "GET_TITLE";
}

/**
 * Background → content script: the user clicked stop generating. Read the
 * last user prompt + partial AI reply from the DOM and send them back so the
 * gauge can display an immediate (temporary) round before the history API
 * catches up (001-17 stop-generation immediate feedback).
 */
export interface GetStopRoundMessage {
  type: "GET_STOP_ROUND";
}

/**
 * Content → background: DOM-scraped text from a stopped generation. The
 * background estimates tokens, adds a temporary local-only round (never
 * written to Upstash), and broadcasts the updated gauge immediately.
 */
export interface StopRoundDataMessage {
  type: "STOP_ROUND_DATA";
  /** The last user prompt text (from DOM). */
  promptText: string;
  /** The partial AI answer text visible in the page (from DOM). */
  answerText: string;
}

export type HeadroomMessage =
  | PageReadyMessage
  | GetStateMessage
  | GetTitleMessage
  | StateUpdateMessage
  | RefreshHistoryMessage
  | HistoryParsedMessage
  | ConversationListMessage
  | FetchConversationListMessage
  | GetStopRoundMessage
  | StopRoundDataMessage;

/**
 * Live usage state rendered by the side panel — a pure DISPLAY projection of
 * the active dialogue's identity + totals (spec 001: platform name + context
 * + ratio + round count + conversation title/id for the "this gauge = this
 * conversation" mental model). `platformId` null = not on a supported page.
 *
 * `dialogueId` keys the local/cloud record; `dialogueTitle` is the human label
 * scraped from the DOM (may lag a rename by one render). Both null on home/idle.
 */
export interface UsageState {
  platformId: string | null;
  /** Active dialogue id (URL-derived); null on home / non-platform pages. */
  dialogueId: string | null;
  /** Human-readable title (DOM-scraped); null when the platform hasn't rendered one yet. */
  dialogueTitle: string | null;
  contextLimit: number | null;
  totalTokens: number;
  lastRoundTokens: number | null;
  roundCount: number;
  /** Recent rounds (trimmed) for the per-round input/output breakdown in the panel. */
  rounds: RoundRecord[];
}
