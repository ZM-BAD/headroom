import "./style.css";
import type { HeadroomMessage, UsageState } from "../../utils/messages";
import {
  DEFAULT_THRESHOLDS,
  levelFromRatio,
  pctToRatio,
  type Level,
  type Thresholds,
} from "../../utils/thresholds";
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  STORAGE_KEY,
  type ContextLimits,
  type Language,
  type Settings,
} from "../../utils/settings";
import { ADAPTERS, platformDisplayName } from "../../adapters";
import { setCloudSettings, toCloudSettings } from "../../utils/cloud-settings";
import type { UpstashCreds } from "../../utils/upstash";
import {
  DEFAULT_COEFFICIENTS,
  type TokenCoefficients,
} from "../../utils/estimate";

// Platform logo imports (SVGs from icon/ directory).
import defaultIcon from "../../icon/default.svg";
import chatgptIcon from "../../icon/openai.svg";
import deepseekIcon from "../../icon/deepseek.svg";
import doubaoIcon from "../../icon/doubao.svg";
import geminiIcon from "../../icon/gemini.svg";
import kimiIcon from "../../icon/kimi.svg";
import qianwenIcon from "../../icon/qianwen.svg";
import qwenIcon from "../../icon/qwen.svg";

const PLATFORM_ICON: Record<string, string> = {
  chatgpt: chatgptIcon,
  deepseek: deepseekIcon,
  doubao: doubaoIcon,
  gemini: geminiIcon,
  kimi: kimiIcon,
  qianwen: qianwenIcon,
  qwen: qwenIcon,
};

function platformIconImg(platformId: string): HTMLImageElement {
  const img = document.createElement("img");
  img.src = PLATFORM_ICON[platformId] ?? defaultIcon;
  img.className = "hd-platform-icon";
  img.width = 16;
  img.height = 16;
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  return img;
}

/**
 * Raw browser-locale lookup. WXT types `browser.i18n.getMessage` to accept
 * only literal message names (it generates the union from messages.json);
 * `t()` below needs a string-typed entry point, so alias it here.
 */
const getMessage = browser.i18n.getMessage as (messageName: string) => string;
// WXT types getURL's arg as a generated PublicPath union; we fetch a locale
// file by an arbitrary string, so alias it to `string`.
const getURL = browser.runtime.getURL as (path: string) => string;

const STATUS_KEYS: Record<Level, string> = {
  idle: "statusIdle",
  green: "statusGreen",
  yellow: "statusYellow",
  red: "statusRed",
};

const IDLE_STATE: UsageState = {
  platformId: null,
  dialogueId: null,
  dialogueTitle: null,
  contextLimit: null,
  totalTokens: 0,
  lastRoundTokens: null,
  roundCount: 0,
  rounds: [],
};

const els = {
  viewMain: document.querySelector<HTMLElement>("#view-main")!,
  viewSettings: document.querySelector<HTMLElement>("#view-settings")!,
  modelName: document.querySelector<HTMLElement>("#model-name")!,
  contextLimit: document.querySelector<HTMLElement>("#context-limit")!,
  dialogueIdentity: document.querySelector<HTMLElement>("#dialogue-identity")!,
  dialogueTitle: document.querySelector<HTMLElement>("#dialogue-title")!,
  dialogueId: document.querySelector<HTMLElement>("#dialogue-id")!,
  percent: document.querySelector<HTMLElement>("#percent")!,
  barFill: document.querySelector<HTMLElement>("#bar-fill")!,
  tokenUsed: document.querySelector<HTMLElement>("#token-used")!,
  tokenLimit: document.querySelector<HTMLElement>("#token-limit")!,
  statusDot: document.querySelector<HTMLElement>("#status-dot")!,
  statusText: document.querySelector<HTMLElement>("#status-text")!,
  roundCount: document.querySelector<HTMLElement>("#round-count")!,
  lastRound: document.querySelector<HTMLElement>("#last-round")!,
  settingsBtn: document.querySelector<HTMLButtonElement>("#settings-btn")!,
  settingsBack: document.querySelector<HTMLButtonElement>("#settings-back")!,
  thrYellow: document.querySelector<HTMLInputElement>("#thr-yellow")!,
  thrYellowVal: document.querySelector<HTMLOutputElement>("#thr-yellow-val")!,
  thrRed: document.querySelector<HTMLInputElement>("#thr-red")!,
  thrRedVal: document.querySelector<HTMLOutputElement>("#thr-red-val")!,
  thrReset: document.querySelector<HTMLButtonElement>("#thr-reset")!,
  thrBar: document.querySelector<HTMLElement>("#thr-bar")!,
  langSelect: document.querySelector<HTMLSelectElement>("#lang-select")!,
  upstashUrl: document.querySelector<HTMLInputElement>("#upstash-url")!,
  upstashToken: document.querySelector<HTMLInputElement>("#upstash-token")!,
  upstashToggle: document.querySelector<HTMLButtonElement>("#upstash-toggle")!,
  upstashTest: document.querySelector<HTMLButtonElement>("#upstash-test")!,
  upstashClear: document.querySelector<HTMLButtonElement>("#upstash-clear")!,
  upstashStatus: document.querySelector<HTMLElement>("#upstash-status")!,
  settingsSave: document.querySelector<HTMLButtonElement>("#settings-save")!,
  ctxReset: document.querySelector<HTMLButtonElement>("#ctx-reset")!,
  coeffResetAll: document.querySelector<HTMLButtonElement>("#coeff-reset-all")!,
  coeffHint: document.querySelector<HTMLOutputElement>("#coeff-hint")!,
  roundsList: document.querySelector<HTMLElement>("#rounds-list")!,
};

// Authoritative in-memory working copies. Settings are explicit-save now:
// every input mutates these copies (thresholds preview the main view live),
// and the bottom "Save" button persists all of them as one write.
let currentThresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
let currentState: UsageState = IDLE_STATE;
let currentLanguage: Language = "auto";
let currentUpstash: UpstashCreds = { url: "", token: "" };
let currentContextLimits: ContextLimits = { ...DEFAULT_SETTINGS.contextLimits };
let currentTokenCoefficients: Record<string, Partial<TokenCoefficients>> = {};

/** Loaded message tables for a manual locale override. "auto" uses browser i18n. */
const localeTables: Partial<
  Record<Exclude<Language, "auto">, Record<string, string>>
> = {};

async function loadLocaleTable(lang: Exclude<Language, "auto">): Promise<void> {
  if (localeTables[lang]) return;
  try {
    const res = await fetch(getURL(`_locales/${lang}/messages.json`));
    const raw = (await res.json()) as Record<string, { message: string }>;
    localeTables[lang] = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, v.message]),
    );
  } catch {
    // Table load failed — `t()` falls back to browser i18n for this locale.
  }
}

/** Override-aware translator: manual language → in-memory table; else browser locale. */
function t(key: string): string {
  if (currentLanguage !== "auto") {
    const msg = localeTables[currentLanguage]?.[key];
    if (msg != null) return msg;
  }
  return getMessage(key);
}

function statusText(level: Level): string {
  return t(STATUS_KEYS[level]);
}

/** Localize every [data-i18n] element/attr from messages. */
function applyI18n(root: ParentNode = document.body): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel!));
  });
}

// ---------- main view rendering ----------

/** Format a context limit: 1M+ → "1M context", else "NK context" (binary K/M). */
function formatContext(limit: number): string {
  const suffix = t("contextSuffix");
  if (limit >= 1_048_576) {
    const m = limit / 1_048_576;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M ${suffix}`;
  }
  return `${Math.round(limit / 1024)}K ${suffix}`;
}

function render(state: UsageState, th: Thresholds): void {
  const limit = state.contextLimit ?? 0;
  const used = state.totalTokens;
  const ratio = limit > 0 ? used / limit : 0;
  const level: Level = limit > 0 ? levelFromRatio(ratio, th) : "idle";

  els.modelName.textContent = state.platformId
    ? platformDisplayName(state.platformId)
    : t("detectingPlatform");
  els.contextLimit.textContent =
    limit > 0 ? formatContext(limit) : t("noContext");

  // Conversation identity: show the title (primary) + full dialogueId
  // (secondary, small/grey) so the user can anchor "this gauge = this chat".
  // Hidden entirely when no dialogue is open (home / non-platform page) so the
  // card stays clean in the idle state.
  if (state.dialogueId) {
    els.dialogueIdentity.hidden = false;
    els.dialogueTitle.textContent =
      state.dialogueTitle ?? t("untitledDialogue");
    els.dialogueId.textContent = state.dialogueId;
    els.dialogueId.title = state.dialogueId; // full id on hover for copy/verify
  } else {
    els.dialogueIdentity.hidden = true;
  }

  els.percent.textContent = `${(ratio * 100).toFixed(1)}%`;
  els.barFill.style.width = `${ratio * 100}%`;
  els.barFill.dataset.level = level;

  els.tokenUsed.textContent = used.toLocaleString();
  els.tokenLimit.textContent = limit > 0 ? limit.toLocaleString() : "—";

  els.statusDot.dataset.level = level;
  els.statusText.textContent = statusText(level);

  els.roundCount.textContent = String(state.roundCount);
  els.lastRound.textContent =
    state.lastRoundTokens != null
      ? state.lastRoundTokens.toLocaleString()
      : "—";
  renderRounds(state.rounds);
}

/** Render the per-round input/output breakdown (↑prompt / ↓answer tokens + cumulative). */
function renderRounds(rounds: UsageState["rounds"]): void {
  const list = els.roundsList;
  list.replaceChildren();
  for (const r of rounds) {
    const row = document.createElement("div");
    row.className = "hd-round-row";
    const n = document.createElement("span");
    n.className = "hd-round-n";
    n.textContent = `#${r.n}`;
    const pin = document.createElement("span");
    pin.className = "hd-round-in";
    pin.textContent = `↑${r.promptTokens.toLocaleString()}`;
    const pout = document.createElement("span");
    pout.className = "hd-round-out";
    pout.textContent = `↓${r.answerTokens.toLocaleString()}`;
    const cum = document.createElement("span");
    cum.className = "hd-round-cum";
    // Cumulative = prompt + answer, computed locally — no extra Upstash field.
    cum.textContent = (r.promptTokens + r.answerTokens).toLocaleString();
    row.append(n, pin, pout, cum);
    list.append(row);
  }
}

// ---------- view switching (main ↔ settings) ----------

function showView(view: "main" | "settings"): void {
  els.viewMain.hidden = view !== "main";
  els.viewSettings.hidden = view !== "settings";
}

els.settingsBtn.addEventListener("click", () => showView("settings"));
// Back discards unsaved working-copy edits (no confirm) — fine while there's
// a single writer; revisit (dirty check) if a second writer ever appears.
els.settingsBack.addEventListener("click", () => showView("main"));

// ---------- thresholds ----------

function applyThresholdsToSliders(th: Thresholds): void {
  const y = Math.round(th.yellow * 100);
  const r = Math.round(th.red * 100);
  els.thrYellow.value = String(y);
  els.thrRed.value = String(r);
  els.thrYellowVal.value = `${y}%`;
  els.thrRedVal.value = `${r}%`;
  // Drive the 3-zone gradient so the colored bands line up under each thumb.
  els.thrBar.style.setProperty("--thr-yellow", `${y}%`);
  els.thrBar.style.setProperty("--thr-red", `${r}%`);
}

// Only the dragged thumb is clamped (keep yellow < red). The two thumbs share
// one track; never rescale the other — just clamp the one being dragged.
// Dragging updates the working copy + previews the main view; nothing
// persists until the global "Save" button is pressed.
function syncThresholdsFromInputs(dragged: "yellow" | "red"): void {
  let y = Number(els.thrYellow.value);
  let r = Number(els.thrRed.value);
  if (dragged === "yellow" && y >= r) {
    y = r - 1;
    els.thrYellow.value = String(y);
  } else if (dragged === "red" && r <= y) {
    r = y + 1;
    els.thrRed.value = String(r);
  }
  els.thrYellowVal.value = `${y}%`;
  els.thrRedVal.value = `${r}%`;
  els.thrBar.style.setProperty("--thr-yellow", `${y}%`);
  els.thrBar.style.setProperty("--thr-red", `${r}%`);
  currentThresholds = { yellow: pctToRatio(y), red: pctToRatio(r) };
  render(currentState, currentThresholds);
}

els.thrYellow.addEventListener("input", () =>
  syncThresholdsFromInputs("yellow"),
);
els.thrRed.addEventListener("input", () => syncThresholdsFromInputs("red"));

els.thrReset.addEventListener("click", () => {
  currentThresholds = { ...DEFAULT_SETTINGS.thresholds };
  applyThresholdsToSliders(currentThresholds);
  render(currentState, currentThresholds);
});

// ---------- language ----------

// Switching the language just updates the working copy + re-localizes;
// persisting happens on the global "Save".
els.langSelect.addEventListener("change", () => {
  currentLanguage = els.langSelect.value as Language;
  applyI18n();
  // Rebuild programmatically-localized sections so labels, units, and
  // descriptions reflect the new language.
  buildContextLimitRows();
  buildCoefficientRows();
  render(currentState, currentThresholds);
});

// ---------- context limits (per-platform override of the auto-detected limit) ----------

const ctxInputs: Record<string, HTMLInputElement> = {};

// Context limits are authored in K tokens (1K = 1024) — the unit shown beside
// each input; the stored value is raw tokens, so convert on display and on edit.
const toKilo = (tokens: number): number => Math.round(tokens / 1024);
const fromKilo = (k: number): number => Math.round(k * 1024);

/**
 * Render one number-input row per adapter, seeded from currentContextLimits.
 * Defaults come from each adapter's contextLimit; the user overrides here.
 */
function buildContextLimitRows(): void {
  const list = document.querySelector<HTMLElement>("#context-limits-list");
  if (!list) return;
  list.innerHTML = "";
  for (const a of ADAPTERS) {
    const id = `ctx-${a.platformId}`;
    const row = document.createElement("div");
    row.className = "hd-settings-row hd-settings-row--field";
    const label = document.createElement("label");
    label.className = "hd-settings-label";
    label.htmlFor = id;
    label.append(
      platformIconImg(a.platformId),
      Object.assign(document.createElement("span"), {
        textContent: a.displayName,
      }),
    );
    const input = document.createElement("input");
    input.className = "hd-input hd-input--num";
    input.id = id;
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.inputMode = "numeric";
    input.value = String(
      toKilo(currentContextLimits[a.platformId] ?? a.contextLimit),
    );
    const errSpan = document.createElement("span");
    errSpan.className = "hd-input-err";
    errSpan.textContent = t("ctxLimitInvalid");
    errSpan.hidden = true;
    const syncSave = () => {
      const anyInvalid = Object.values(ctxInputs).some(
        (inp) => inp.dataset.invalid,
      );
      if (anyInvalid) {
        els.settingsSave.classList.add("hd-btn--has-errors");
      } else {
        els.settingsSave.classList.remove("hd-btn--has-errors");
      }
    };
    const markInvalid = () => {
      input.dataset.invalid = "true";
      errSpan.hidden = false;
      syncSave();
    };
    const clearInvalid = () => {
      delete input.dataset.invalid;
      errSpan.hidden = true;
      syncSave();
    };
    input.addEventListener("input", () => {
      const n = Number(input.value);
      if (Number.isFinite(n) && n > 0) {
        currentContextLimits[a.platformId] = fromKilo(n);
        clearInvalid();
      } else {
        markInvalid();
      }
    });
    const field = document.createElement("span");
    field.className = "hd-input-field";
    field.append(input, errSpan);
    const unit = document.createElement("span");
    unit.className = "hd-context-unit";
    unit.textContent = "K tokens";
    row.append(label, field, unit);
    list.append(row);
    ctxInputs[a.platformId] = input;
  }
}

els.ctxReset.addEventListener("click", () => {
  currentContextLimits = { ...DEFAULT_SETTINGS.contextLimits };
  for (const a of ADAPTERS) {
    const inp = ctxInputs[a.platformId];
    if (inp)
      inp.value = String(
        toKilo(currentContextLimits[a.platformId] ?? a.contextLimit),
      );
  }
});

// ---------- token coefficients (spec 004 — Advanced Settings) ----------

const COEFF_KEYS: (keyof TokenCoefficients)[] = [
  "cjk",
  "kana",
  "hangul",
  "cyrillic",
  "arabic",
  "latin",
];

const COEFF_I18N: Record<
  keyof TokenCoefficients,
  { label: string; unit: string }
> = {
  cjk: { label: "coeffCjk", unit: "coeffUnitChar" },
  kana: { label: "coeffKana", unit: "coeffUnitChar" },
  hangul: { label: "coeffHangul", unit: "coeffUnitChar" },
  cyrillic: { label: "coeffCyrillic", unit: "coeffUnitWord" },
  arabic: { label: "coeffArabic", unit: "coeffUnitWord" },
  latin: { label: "coeffLatin", unit: "coeffUnitWord" },
};

/** Per-platform coefficient input elements, keyed as `${platformId}:${field}`. */
const coeffInputs: Record<string, HTMLInputElement> = {};

function coeffInputKey(
  platformId: string,
  field: keyof TokenCoefficients,
): string {
  return `${platformId}:${field}`;
}

/** Build the coefficient-rows DOM for every platform, seeded from currentTokenCoefficients. */
function buildCoefficientRows(): void {
  const list = document.querySelector<HTMLElement>("#coeff-list");
  if (!list) return;
  // Drop stale DOM references before destroying elements (see Issue 4).
  for (const k of Object.keys(coeffInputs)) delete coeffInputs[k];
  list.innerHTML = "";

  // Section-level description: what the numbers mean
  const desc = document.createElement("p");
  desc.className = "hd-coeff-desc";
  desc.textContent = t("coeffDescription");
  list.append(desc);

  for (const a of ADAPTERS) {
    const defaults = a.tokenCoefficients;
    const overrides = currentTokenCoefficients[a.platformId] ?? {};

    const details = document.createElement("details");
    details.className = "hd-platform-coeff";

    const summary = document.createElement("summary");
    summary.append(
      platformIconImg(a.platformId),
      Object.assign(document.createElement("span"), {
        textContent: a.displayName,
      }),
    );
    details.append(summary);

    const fields = document.createElement("div");
    fields.className = "hd-coeff-fields";

    for (const f of COEFF_KEYS) {
      const field = document.createElement("div");
      field.className = "hd-coeff-field";

      const label = document.createElement("label");
      label.textContent = t(COEFF_I18N[f].label) || COEFF_I18N[f].label;

      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.01";
      input.inputMode = "decimal";
      const val =
        overrides[f] !== undefined
          ? overrides[f]
          : (defaults[f] ?? DEFAULT_COEFFICIENTS[f]);
      input.value = String(val);

      const unit = document.createElement("span");
      unit.className = "hd-coeff-unit";
      unit.textContent = t(COEFF_I18N[f].unit);

      const key = coeffInputKey(a.platformId, f);
      coeffInputs[key] = input;

      field.append(label, input, unit);
      fields.append(field);
    }

    const resetBtn = document.createElement("button");
    resetBtn.className = "hd-coeff-reset";
    resetBtn.type = "button";
    resetBtn.textContent = t("coeffReset");
    resetBtn.addEventListener("click", () => {
      for (const f of COEFF_KEYS) {
        const inp = coeffInputs[coeffInputKey(a.platformId, f)];
        if (inp) inp.value = String(defaults[f] ?? DEFAULT_COEFFICIENTS[f]);
      }
      delete currentTokenCoefficients[a.platformId];
    });

    const rowEnd = document.createElement("div");
    rowEnd.className = "hd-coeff-row-end";
    rowEnd.append(resetBtn);
    fields.append(rowEnd);
    details.append(fields);
    list.append(details);
  }
}

/** Read coefficient overrides from the DOM. Only stores values that differ from defaults. */
function readCoefficientOverrides(): Record<
  string,
  Partial<TokenCoefficients>
> {
  const result: Record<string, Partial<TokenCoefficients>> = {};
  for (const a of ADAPTERS) {
    const defaults = a.tokenCoefficients;
    const override: Partial<TokenCoefficients> = {};
    for (const f of COEFF_KEYS) {
      const inp = coeffInputs[coeffInputKey(a.platformId, f)];
      if (!inp) continue;
      const val = Number(inp.value);
      if (
        Number.isFinite(val) &&
        val > 0 &&
        Math.abs(val - (defaults[f] ?? DEFAULT_COEFFICIENTS[f])) > 0.001
      ) {
        override[f] = val;
      }
    }
    if (Object.keys(override).length > 0) {
      result[a.platformId] = override;
    }
  }
  return result;
}

els.coeffResetAll.addEventListener("click", () => {
  for (const a of ADAPTERS) {
    const defaults = a.tokenCoefficients;
    for (const f of COEFF_KEYS) {
      const inp = coeffInputs[coeffInputKey(a.platformId, f)];
      if (inp) inp.value = String(defaults[f] ?? DEFAULT_COEFFICIENTS[f]);
    }
  }
  currentTokenCoefficients = {};
});

// ---------- upstash (BYOK REST API) ----------

/** Read + normalize the Upstash fields straight from the inputs (testable pre-save). */
function readUpstashFromInputs(): UpstashCreds {
  return {
    url: els.upstashUrl.value.trim().replace(/\/+$/, ""),
    token: els.upstashToken.value,
  };
}

function setUpstashStatus(
  state: "ok" | "err" | "busy" | null,
  text: string,
): void {
  els.upstashStatus.textContent = text;
  if (state) els.upstashStatus.dataset.state = state;
  else delete els.upstashStatus.dataset.state;
}

// Stroke-based eye / eye-off icons (currentColor) replace the 👁 emoji so the
// toggle renders crisp and consistent across platforms instead of the bulky
// OS emoji. Eye = token hidden (click to reveal); eye-off = token shown.
const EYE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

/** Sync the toggle's icon + aria-label to the token field's reveal state. */
function renderTokenToggle(): void {
  const shown = els.upstashToken.type === "text";
  els.upstashToggle.innerHTML = shown ? EYE_OFF_SVG : EYE_SVG;
  const key = shown ? "hideToken" : "showToken";
  els.upstashToggle.dataset.i18nAriaLabel = key;
  els.upstashToggle.setAttribute("aria-label", t(key));
}

/**
 * Verify Upstash REST credentials with a PING. The Upstash REST API is
 * CORS-permissive (the @upstash/redis SDK runs in browsers), so the side
 * panel can fetch it directly with no host permission. Returns a localized
 * verdict rather than throwing.
 *
 * Fallback if CORS ever blocks at runtime: move this fetch into the
 * background service worker + add optional_host_permissions and request()
 * on Save (the explicit-save button provides the user gesture).
 */
async function testUpstashConnection(
  url: string,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  if (!url || !token) return { ok: false, message: t("upstashErrMissing") };
  if (!url.startsWith("https://")) {
    return { ok: false, message: t("upstashErrNotHttps") };
  }
  try {
    const res = await fetch(`${url}/PING`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: t("upstashErrAuth") };
    }
    if (!res.ok) {
      return { ok: false, message: `${t("upstashErrStatus")} (${res.status})` };
    }
    const data = (await res.json()) as { result?: unknown };
    return data.result === "PONG"
      ? { ok: true, message: t("upstashOk") }
      : { ok: false, message: t("upstashErrUnexpected") };
  } catch (err) {
    return {
      ok: false,
      message: `${t("upstashErrNetwork")} (${(err as Error).message})`,
    };
  }
}

// Editing either field updates the working copy and clears any stale result.
for (const input of [els.upstashUrl, els.upstashToken]) {
  input.addEventListener("input", () => {
    currentUpstash = readUpstashFromInputs();
    setUpstashStatus(null, "");
  });
}

// Show / hide the token. renderTokenToggle() also mirrors the choice into
// data-i18n-aria-label so a later applyI18n() (e.g. language switch) keeps
// the correct label + icon.
els.upstashToggle.addEventListener("click", () => {
  els.upstashToken.type =
    els.upstashToken.type === "text" ? "password" : "text";
  renderTokenToggle();
});

// Test uses the current input values (not yet saved) so the user can verify
// before committing.
els.upstashTest.addEventListener("click", () => {
  void (async () => {
    const cfg = readUpstashFromInputs();
    els.upstashTest.disabled = true;
    setUpstashStatus("busy", t("testingConnection"));
    const { ok, message } = await testUpstashConnection(cfg.url, cfg.token);
    setUpstashStatus(ok ? "ok" : "err", message);
    els.upstashTest.disabled = false;
  })();
});

// Clear wipes the URL + Token inputs and the working copy (re-masked). Like
// the threshold reset, it is working-copy only — it persists on global Save.
els.upstashClear.addEventListener("click", () => {
  els.upstashUrl.value = "";
  els.upstashToken.value = "";
  els.upstashToken.type = "password";
  currentUpstash = { url: "", token: "" };
  setUpstashStatus(null, "");
  renderTokenToggle();
});

// Paint the initial eye icon synchronously (token is password by default).
renderTokenToggle();

// ---------- save (whole settings page) ----------

/** Brief "Saved ✓" flash on the save button to confirm the write landed. */
function flashSaved(): void {
  const btn = els.settingsSave;
  btn.textContent = `${t("settingsSaved")} ✓`;
  btn.classList.add("hd-btn--saved");
  window.setTimeout(() => {
    btn.textContent = t("saveSettings");
    btn.classList.remove("hd-btn--saved");
  }, 1200);
}

els.settingsSave.addEventListener("click", () => {
  void (async () => {
    currentUpstash = readUpstashFromInputs();
    // Refuse to persist a non-https Upstash URL — the REST token must never go
    // over http. Empty URL is fine (Upstash is optional). Mirrors the C-layer
    // guard in upstash.ts; this gives the user a visible reason.
    if (currentUpstash.url && !currentUpstash.url.startsWith("https://")) {
      setUpstashStatus("err", t("upstashErrNotHttps"));
      return;
    }
    // Refuse to save if any context-limit input is still invalid — flash the
    // save button red so the user sees why nothing happened.
    for (const inp of Object.values(ctxInputs)) {
      if (inp.dataset.invalid) {
        els.settingsSave.classList.add("hd-btn--error-flash");
        window.setTimeout(
          () => els.settingsSave.classList.remove("hd-btn--error-flash"),
          600,
        );
        return;
      }
    }
    const coeffOverrides = readCoefficientOverrides();
    const coeffChanged =
      JSON.stringify(coeffOverrides) !==
      JSON.stringify(currentTokenCoefficients);
    currentTokenCoefficients = coeffOverrides;

    const settings: Settings = {
      thresholds: currentThresholds,
      language: currentLanguage,
      upstash: currentUpstash,
      contextLimits: currentContextLimits,
      tokenCoefficients: currentTokenCoefficients,
    };
    await saveSettings(settings);
    flashSaved();
    if (coeffChanged) {
      els.coeffHint.textContent = t("coeffRefreshHint");
      els.coeffHint.hidden = false;
    }
    // Push a credentials-stripped snapshot to Upstash so settings follow the
    // user across devices. Best-effort, AFTER the local write + UI flash so a
    // slow Upstash never blocks the "Saved ✓" feedback. Offline buffering is a
    // 003 concern; here a failure just logs.
    if (settings.upstash.url && settings.upstash.token) {
      try {
        await setCloudSettings(
          settings.upstash,
          toCloudSettings(settings, Date.now()),
        );
      } catch (err) {
        console.warn("[Headroom] settings cloud sync skipped:", err);
      }
    }
    // Refresh the main view so the gauge re-scales to the (possibly new) limit.
    try {
      const state = (await browser.runtime.sendMessage({
        type: "GET_STATE",
      } satisfies HeadroomMessage)) as UsageState | undefined;
      if (state) {
        currentState = state;
        render(currentState, currentThresholds);
      }
    } catch {
      // Background asleep — the next PAGE_READY/round will refresh.
    }
  })();
});

// ---------- init ----------

// Instant first paint with defaults (browser locale), refined once settings load.
applyI18n();
render(currentState, currentThresholds);

void (async () => {
  const settings = await getSettings();
  currentThresholds = settings.thresholds;
  currentLanguage = settings.language;
  currentUpstash = settings.upstash;
  currentContextLimits = settings.contextLimits;
  currentTokenCoefficients = settings.tokenCoefficients;
  els.langSelect.value = currentLanguage;
  els.upstashUrl.value = currentUpstash.url;
  els.upstashToken.value = currentUpstash.token;
  buildContextLimitRows();
  buildCoefficientRows();
  // Preload tables for all supported locales so manual override is instant.
  await Promise.all(
    (
      [
        "en",
        "zh_CN",
        "ja",
        "ko",
        "ru",
        "es",
        "pt_BR",
        "fr",
        "de",
        "id",
      ] as const
    ).map((l) => loadLocaleTable(l)),
  );
  applyI18n();
  applyThresholdsToSliders(currentThresholds);
  render(currentState, currentThresholds);
})();

// Phase 2+: live usage updates from the background.
browser.runtime.onMessage.addListener((message: HeadroomMessage) => {
  if (message.type === "STATE_UPDATE") {
    currentState = message.state;
    render(currentState, currentThresholds);
  }
});

// Keep settings in sync if changed in another context (e.g. a future options page).
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const next = (changes[STORAGE_KEY]?.newValue ?? undefined) as
    | Partial<Settings>
    | undefined;
  if (!next) return;
  if (next.thresholds) {
    currentThresholds = {
      yellow: next.thresholds.yellow ?? DEFAULT_THRESHOLDS.yellow,
      red: next.thresholds.red ?? DEFAULT_THRESHOLDS.red,
    };
    applyThresholdsToSliders(currentThresholds);
  }
  if (next.language) {
    currentLanguage = next.language;
    els.langSelect.value = currentLanguage;
    applyI18n();
  }
  if (next.upstash) {
    currentUpstash = {
      url: next.upstash.url ?? "",
      token: next.upstash.token ?? "",
    };
    els.upstashUrl.value = currentUpstash.url;
    els.upstashToken.value = currentUpstash.token;
  }
  if (next.contextLimits) {
    currentContextLimits = {
      ...DEFAULT_SETTINGS.contextLimits,
      ...next.contextLimits,
    };
    for (const a of ADAPTERS) {
      const inp = ctxInputs[a.platformId];
      if (inp)
        inp.value = String(
          toKilo(currentContextLimits[a.platformId] ?? a.contextLimit),
        );
    }
  }
  if (next.tokenCoefficients) {
    currentTokenCoefficients = next.tokenCoefficients;
    buildCoefficientRows();
  }
  render(currentState, currentThresholds);
});

// Ask the background for the current state when the panel opens.
void (async () => {
  try {
    const state = (await browser.runtime.sendMessage({
      type: "GET_STATE",
    } satisfies HeadroomMessage)) as UsageState | undefined;
    if (state) {
      currentState = state;
      render(currentState, currentThresholds);
    }
  } catch {
    // Background service worker may be asleep; the idle render already shows.
  }
})();
