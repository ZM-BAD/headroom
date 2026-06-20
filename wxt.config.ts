import { defineConfig } from "wxt";

export default defineConfig({
  // MV3 only — Chrome, Edge, and Firefox. MV2 is not supported.
  // WXT defaults Firefox to MV2, so force MV3 across all browsers.
  manifestVersion: 3,
  // Dev mode: don't auto-launch a browser. The extension is loaded manually
  // into the developer's own Chrome (see the debug workflow in AGENTS.md);
  // auto-reload still reaches that instance via the dev server's reload client.
  // Ignored by `wxt build`.
  webExt: {
    disabled: true,
  },
  manifest: ({ browser }) => ({
    name: "Headroom",
    description: "A browser extension built with WXT",
    // Persisted settings (warning thresholds, later Upstash creds) live in
    // local storage; the side panel + background both read/write them.
    permissions: ["storage", "webRequest"],
    // Host access for every supported platform's page (content script) AND
    // send-request host (webRequest body read). 通义千问 serves its page from
    // www.qianwen.com but POSTs to chat2.qianwen.com — both needed.
    // Adding host permissions may gray the unpacked card on reload pending
    // re-grant — click to allow each.
    host_permissions: [
      "*://chat.deepseek.com/*",
      "*://chatgpt.com/*",
      "*://gemini.google.com/*",
      "*://www.kimi.com/*",
      "*://chat.qwen.ai/*",
      "*://www.qianwen.com/*",
      "*://chat2.qianwen.com/*",
      "*://www.doubao.com/*",
    ],
    // Firefox-only: built-in data collection consent (required for new
    // extensions since 2025-11-03; supported on Firefox ≥140). Headroom
    // reads AI chat conversation text (websiteContent) and syncs metadata
    // to the user's own Upstash KV, so websiteContent is required — there
    // is no opt-out path because reading the conversation is core function.
    // TODO(before AMO submit): add a permanent add-on `id` to gecko.
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          strict_min_version: "151.0",
          data_collection_permissions: {
            required: ["websiteContent"],
          },
        },
      },
    }),
  }),
});
