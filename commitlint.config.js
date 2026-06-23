/**
 * Commitlint — mechanically enforces the Conventional Commits + 50/72 rules
 * documented in AGENTS.md → "Commit Messages". Runs:
 *   - locally: .husky/commit-msg hook (on every commit)
 *   - in CI:    .github/workflows/ci.yml → "Lint commit messages"
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // AGENTS.md: subject ≤50 (target) / 72 (hard). config-conventional defaults
    // header-max-length to 100 — tighten to our 72.
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [2, "always", 72],
  },
};
