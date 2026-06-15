import { defineConfig } from "wxt";

export default defineConfig({
  // MV3 only — Chrome, Edge, and Firefox. MV2 is not supported.
  // WXT defaults Firefox to MV2, so force MV3 across all browsers.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "Headroom",
    description: "A browser extension built with WXT",
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
