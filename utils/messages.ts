/**
 * Shared message protocol: content scripts ↔ background ↔ side panel.
 */

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
 * Content script reports a completed AI reply. The background pairs this with
 * the pending prompt (captured at send time via webRequest) to record a round.
 */
export interface RoundCompleteMessage {
  type: "ROUND_COMPLETE";
  platformId: string;
  dialogueId: string | null;
  /**
   * 1-based round id = the count of distinct assistant messages on the page.
   * Stable while a given message streams (so the background UPSERTS that round
   * instead of appending a new one each time the text settles mid-stream);
   * increments when a new message appears.
   */
  roundId: number;
  answerText: string;
  /** DOM-scraped prompt; fallback when the request body is unparseable. */
  promptText?: string;
}

export type HeadroomMessage =
  | PageReadyMessage
  | GetStateMessage
  | StateUpdateMessage
  | RoundCompleteMessage;

/**
 * Live usage state rendered by the side panel — a projection of the active
 * dialogue's totals. `platformId` null = not on a supported page / no round
 * detected yet.
 */
export interface UsageState {
  platformId: string | null;
  contextLimit: number | null;
  totalTokens: number;
  lastRoundTokens: number | null;
  roundCount: number;
  /**
   * The dialogue the gauge is currently displaying (derived from the active
   * tab's URL). Tracked so starting / switching a conversation WITHIN the same
   * platform resets the tally — it's NOT rendered by the panel.
   */
  dialogueId: string | null;
}
