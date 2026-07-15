import type {
  ConversationListMessage,
  HeadroomMessage,
  HistoryParsedMessage,
} from "../utils/messages";
import { ADAPTERS } from "../adapters";
import { answerStreamSignature } from "../utils/dom-signature";
import {
  historySettled,
  SETTLE_RETRY_DELAYS_MS,
} from "../utils/history-settle";
import { adapterForHost } from "../utils/match-host";

/**
 * The ONE content script for every supported platform. WXT injects it on any
 * adapter's matchPattern; it finds its adapter by hostname, then fetches the
 * conversation's full history (adapter.fetchHistory — the platform's history
 * API, the SOLE authority for round identity via stable `message_id`) and ships
 * it as HISTORY_PARSED. Three triggers:
 *   - PAGE_READY (open / reload),
 *   - SPA conversation switch (URL-change poll),
 *   - REFRESH_HISTORY (the background detected the SSE completion stream closed
 *     = the model finished this round; the new round is already in history).
 *
 * It reads NOTHING from the DOM for round identity — DeepSeek's virtual list
 * keeps only visible messages in the DOM, so the DOM count is unreliable. The
 * history API returns every message regardless of the virtual list.
 */
export default defineContentScript({
  matches: ADAPTERS.map((a) => a.matchPattern),
  main(ctx) {
    const adapter = adapterForHost(location.hostname);
    if (!adapter) return;

    const TAG = `[Headroom|${adapter.platformId}]`;
    const log = (...args: unknown[]) => {
      if (import.meta.env.DEV) console.log(TAG, ...args);
    };

    log(
      "content script started, host=",
      location.hostname,
      "url=",
      location.href,
    );

    const send = (msg: HeadroomMessage): void => {
      try {
        log("send →", msg.type);
        void browser.runtime.sendMessage(msg).catch(() => {});
      } catch {
        // Context invalidated — ctx.setInterval will stop the poll shortly.
      }
    };

    const sendPageReady = (): void =>
      send({
        type: "PAGE_READY",
        platformId: adapter.platformId,
        url: location.href,
        dialogueTitle: adapter.dialogueTitleFromDoc?.(document) ?? null,
      });

    // Fetch the conversation's full history (text + message_id-ordered rounds)
    // and ship it. No-op when the adapter has no fetchHistory or the URL has no
    // dialogue id (e.g. the home page). The background REPLACES the record with
    // this authoritative view.
    //
    // When provisional=true (set only by the DOM poll detector during streaming
    // — Gemini is the sole needsDomPollDetection platform), the background
    // broadcasts locally and stops: no cloud read/write. The final settled ship
    // (non-provisional) writes the cloud in one GET+SET pair — exactly the
    // design baseline regardless of answer length. Other platforms always ship
    // non-provisional (provisional defaults to false).
    //
    // Guarded against concurrent calls: the DOM poll, SPA-switch, and
    // REFRESH_HISTORY paths can all trigger fetchAndShipHistory in quick
    // succession during streaming — only one in-flight fetch at a time.
    let fetchInProgress = false;
    const fetchAndShipHistory = async (provisional = false): Promise<void> => {
      if (fetchInProgress) {
        log("fetchAndShipHistory SKIP — already in progress");
        return;
      }
      if (!adapter.fetchHistory) {
        log("fetchAndShipHistory SKIP — no fetchHistory on adapter");
        return;
      }
      const dialogueId = adapter.dialogueIdFromUrl?.(location.href) ?? null;
      if (!dialogueId) {
        log(
          "fetchAndShipHistory SKIP — no dialogueId in URL href=",
          location.href,
        );
        return;
      }
      fetchInProgress = true;
      log("fetchAndShipHistory START dialogueId=", dialogueId);
      const t0 = performance.now();
      try {
        let rounds = await adapter.fetchHistory(dialogueId);
        // Eventually-consistent history store (adapter-declared — Doubao):
        // the newest round's answer may not be persisted yet. Re-fetch with
        // bounded backoff instead of shipping a 0-output-token round. Runs
        // inside the fetchInProgress guard, so concurrent triggers stay out.
        if (adapter.historyNeedsSettleRetry) {
          for (const delay of SETTLE_RETRY_DELAYS_MS) {
            if (historySettled(rounds)) break;
            log(
              `history unsettled (newest round has empty answer) — retrying in ${delay}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
            const retry = await adapter.fetchHistory(dialogueId);
            // A retry that errored to [] must not clobber the earlier result.
            if (retry.length > 0) rounds = retry;
          }
        }
        const elapsed = (performance.now() - t0).toFixed(0);
        if (rounds.length === 0) {
          log(
            `fetchAndShipHistory DONE 0 rounds (${elapsed}ms) → NOT sending HISTORY_PARSED`,
          );
          return;
        }
        log(
          `fetchAndShipHistory DONE ${rounds.length} rounds (${elapsed}ms) → sending HISTORY_PARSED${provisional ? " (provisional)" : ""}`,
        );
        send({
          type: "HISTORY_PARSED",
          platformId: adapter.platformId,
          url: location.href,
          rounds,
          // Re-scrape the title on every history ship — cheap, and catches a
          // rename (the SPA may have updated the tab title since PAGE_READY).
          dialogueTitle: adapter.dialogueTitleFromDoc?.(document) ?? null,
          ...(provisional ? { provisional: true as const } : {}),
        } satisfies HistoryParsedMessage);
      } catch (err) {
        log("fetchAndShipHistory ERROR:", err);
        // fetch failed — the next trigger (open / switch / round-complete) re-fetches
      } finally {
        fetchInProgress = false;
      }
    };

    // On the platform HOME page (no dialogue id), fetch the conversation
    // list and ship it for zombie cleanup (spec 003). When force=true
    // (alarm-triggered FETCH_CONVERSATION_LIST), skip the dialogueId gate
    // — the alarm needs the list regardless of which page the user is on.
    //
    // 30 s throttle on non-forced calls prevents hammering the platform API
    // during rapid SPA toggling between home ↔ conversation.  force=true
    // (alarm, every 60 min) and first-ever call are never throttled.
    let lastFetchConvListTs = 0;
    const FETCH_CONV_LIST_THROTTLE_MS = 30_000;
    const fetchAndShipConversationList = async (
      opts: { force?: boolean } = {},
    ): Promise<void> => {
      if (!adapter.fetchConversationList) return;
      if (!opts.force) {
        const dialogueId = adapter.dialogueIdFromUrl?.(location.href) ?? null;
        if (dialogueId) return; // a conversation is open, not the home page
        const now = Date.now();
        if (now - lastFetchConvListTs < FETCH_CONV_LIST_THROTTLE_MS) return;
        lastFetchConvListTs = now;
      }
      try {
        const ids = await adapter.fetchConversationList();
        if (ids.length === 0) return;
        send({
          type: "CONVERSATION_LIST",
          platformId: adapter.platformId,
          url: location.href,
          ids,
        } satisfies ConversationListMessage);
      } catch (e) {
        console.warn("[Headroom] fetchConversationList failed:", e);
      }
    };

    // Background asks us to re-fetch history when the SSE completion stream
    // closes (a round finished). The new round is already in history by then.
    // GET_TITLE: lightweight query — respond with the current dialogue title
    // so tab-switch shows the right title instantly (no polling delay).
    browser.runtime.onMessage.addListener(
      (message: HeadroomMessage, _sender, sendResponse) => {
        if (message.type === "REFRESH_HISTORY") {
          log("← REFRESH_HISTORY received from background");
          void fetchAndShipHistory();
        }
        if (message.type === "FETCH_CONVERSATION_LIST")
          void fetchAndShipConversationList({ force: true });
        if (message.type === "GET_TITLE") {
          sendResponse({
            dialogueTitle: adapter.dialogueTitleFromDoc?.(document) ?? null,
          });
        }
        if (message.type === "GET_STOP_ROUND") {
          void (async () => {
            // Find last AI reply (partial answer after stop).
            const answerEls = document.querySelectorAll(adapter.answerSelector);
            const lastAnswer = answerEls[answerEls.length - 1];
            const answerText = (
              lastAnswer as HTMLElement | undefined
            )?.innerText?.trim();
            if (!answerText) return;
            // Find last user prompt — use adapter.userSelector if defined,
            // otherwise walk backwards from the answer element.
            let promptText = "";
            if (adapter.userSelector) {
              const userEls = document.querySelectorAll(adapter.userSelector);
              const lastUser = userEls[userEls.length - 1];
              promptText =
                (lastUser as HTMLElement | undefined)?.innerText?.trim() ?? "";
            }
            if (!promptText) {
              // Fallback: walk backwards from the answer element to find
              // the preceding user message.
              let walker: Element | null = lastAnswer;
              for (let i = 0; i < 20 && walker; i++) {
                const sib: Element | null = walker.previousElementSibling;
                if (sib) {
                  const text = (sib as HTMLElement).innerText?.trim();
                  if (text && text !== answerText) {
                    promptText = text;
                    break;
                  }
                  walker = sib;
                } else {
                  walker = walker.parentElement;
                }
              }
            }
            if (!promptText) return;
            send({
              type: "STOP_ROUND_DATA",
              promptText,
              answerText,
            } satisfies HeadroomMessage);
          })();
        }
      },
    );

    // Initial load — always immediate, no debounce (user opened/reloaded the
    // page; the gauge must show the current conversation right away).
    log("INITIAL LOAD — sending PAGE_READY + fetchAndShipHistory");
    sendPageReady();
    void fetchAndShipHistory();
    void fetchAndShipConversationList();

    // SPA conversation switches change the URL WITHOUT reloading (DeepSeek is a
    // React SPA), so PAGE_READY doesn't re-fire. Poll the URL lightly and, when
    // the conversation changes, re-announce + re-fetch its history. Use the
    // content-script CONTEXT's interval (not window.setInterval) so it
    // AUTO-CLEARS when the context is invalidated (extension reload) — otherwise
    // the dead context throws "Extension context invalidated" every tick.
    //
    // spec 003 P1 — debounce history fetches on SPA switches: rapid tab-through
    // triggers immediate gauge reset (sendPageReady, from cache) but defers the
    // full history fetch + union merge until the user settles on a conversation
    // for ≥ DEBOUNCE_MS. Round-complete (REFRESH_HISTORY) and initial load are
    // NOT debounced — only SPA switches are.
    const DEBOUNCE_MS = 2000;
    let lastHref = location.href;
    let lastTitle = document.title;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const debouncedFetch = (): void => {
      if (debounceTimer != null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fetchAndShipHistory();
        void fetchAndShipConversationList();
      }, DEBOUNCE_MS);
    };

    // DOM-based turn detector: when the answer DOM changes — a new answer
    // element mounting OR the last answer's text still growing — re-arm the
    // debounce; fetch only after a full quiet second. Primary mechanism for
    // Gemini (whose webRequest onCompleted doesn't fire for StreamGenerate).
    //
    // The signature folds in the LAST answer's text length because Gemini
    // mounts <model-response> at stream START and fills it for many seconds:
    // a count-only signature stabilised immediately and the old detector
    // scraped mid-stream (measured 2026-07: fired at 180 of 983 chars) with
    // no later trigger to correct it. Text growth now keeps the debounce
    // armed; an early fire on a >1s mid-stream pause self-corrects — the
    // next growth re-triggers and the re-scrape replaces the round in place.
    const answerSignature = (): string => {
      const els = document.querySelectorAll(adapter.answerSelector);
      const last = els[els.length - 1];
      return answerStreamSignature(
        els.length,
        last ? (last.textContent ?? "").length : 0,
      );
    };
    let lastAnswerSig = answerSignature();
    let domChangeTimer: ReturnType<typeof setTimeout> | null = null;

    ctx.setInterval(() => {
      if (location.href !== lastHref) {
        log("SPA SWITCH detected: old=", lastHref, "→ new=", location.href);
        // When switching from a page with no dialogueId (home) to one
        // with a dialogueId (conversation), fetch immediately — this is
        // a new-conversation event, not a rapid tab-through.
        const hadId = adapter.dialogueIdFromUrl?.(lastHref) != null;
        const hasId = adapter.dialogueIdFromUrl?.(location.href) != null;
        lastHref = location.href;
        lastTitle = document.title;
        // Reset the answer signature for the new page so the DOM detector
        // starts from the new conversation's baseline.
        lastAnswerSig = answerSignature();
        sendPageReady(); // instant UX — gauge resets to cached/new record
        if (!hadId && hasId) {
          // Home → conversation: immediate fetch (cf. initial load).
          log("SPA SWITCH home→conversation — immediate fetch");
          void fetchAndShipHistory();
          void fetchAndShipConversationList();
        } else {
          debouncedFetch();
        }
      } else if (document.title !== lastTitle) {
        lastTitle = document.title;
        sendPageReady(); // title-only — rename detected, no history refetch needed
      } else if (adapter.needsDomPollDetection) {
        // DOM-based detection: any answer-DOM activity (new element OR text
        // still streaming) ships a PROVISIONAL update (local broadcast only,
        // no cloud write). A 2s settle timer runs alongside — when it fires
        // without being re-armed, the final NON-provisional ship writes the
        // cloud in exactly one GET+SET pair. 2s > 1.5s poll ⇒ ensures the
        // poll sees quiescence and lets the timer fire before the next tick.
        // Cost: real-time UI at 1.5s cadence (free, local broadcast),
        // exactly 2 cloud commands per round (design baseline).
        const currentSig = answerSignature();
        if (currentSig !== lastAnswerSig) {
          log(
            `DOM CHANGE: answer signature ${lastAnswerSig} → ${currentSig} — shipping provisional`,
          );
          lastAnswerSig = currentSig;
          void fetchAndShipHistory(true); // provisional — local only
          if (domChangeTimer != null) clearTimeout(domChangeTimer);
          domChangeTimer = setTimeout(() => {
            domChangeTimer = null;
            log("DOM settled for 2s — shipping final non-provisional");
            void fetchAndShipHistory(false);
          }, 2000);
        }
      }
    }, 1500);
  },
});
