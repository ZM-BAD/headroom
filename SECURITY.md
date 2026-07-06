# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Headroom, please report it privately
rather than opening a public issue.

**Contact:** Use [GitHub's private vulnerability reporting](https://github.com/badlogic/headroom/security/advisories/new)
to report security issues confidentially. Only the maintainer can see your report.

Please include:

- A clear description of the vulnerability
- Steps to reproduce
- Affected versions (or commit hash)
- Any suggested mitigations

You should receive a response within 72 hours. After the vulnerability is
confirmed and a fix is prepared, we will coordinate disclosure timing.

## Security Design

Headroom is designed with these security properties:

### No conversation text stored

Headroom reads conversation text **only to count tokens in memory**. The
extension stores **only token counts per round** — never the text of your
prompts or AI responses. Neither `browser.storage.local` nor Upstash Redis
ever contains your conversation content.

This is a structural guarantee, not a policy: the `DialogueRecord` / `RoundRecord`
data types have no fields for text, only `promptTokens` / `answerTokens` counters.

### Credentials stay local

Your Upstash REST URL and token are stored in `browser.storage.local` only.
When settings are synced to Upstash (`headroom:settings` key), credentials are
stripped — the cloud copy contains only thresholds, language preference, and
context limit overrides. This is enforced by `toCloudSettings()` in
`utils/cloud-settings.ts`, verified by the probe script
(`scripts/probe-upstash.mjs`), and covered by unit tests.

### Your data, your storage

Headroom uses a **Bring Your Own Key (BYOK)** model. There is no
Headroom-operated server. Your token counts live in your personal Upstash Redis
instance, under your own account. Headroom never phones home and has no
third-party analytics or tracking.

### Minimal permissions

The extension requests only the permissions it needs:

| Permission         | Purpose                                               |
| ------------------ | ----------------------------------------------------- |
| `storage`          | Local settings + conversation cache                   |
| `webRequest`       | Detect round completion + conversation deletion       |
| `alarms`           | Periodic zombie conversation cleanup                  |
| `sidePanel`        | Browser-native side panel UI                          |
| `host_permissions` | Access conversation history on supported AI platforms |

Headroom does NOT request `cookies`, `tabs`, `unlimitedStorage`, or any
permission that would allow it to read data beyond the supported AI chat
platforms.

### Manifest V3

Headroom is Manifest V3 only. MV3 enforces a stricter security model than MV2:
service workers (not persistent background pages), declarative net request
rules, and no remotely-hosted code.

## Supported Versions

Only the latest released version receives security patches. There are no LTS
releases or backport branches at this stage of the project.
