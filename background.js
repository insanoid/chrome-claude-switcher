// Service worker: owns all cookie work so a switch finishes even if the popup closes.

const CLAUDE_DOMAIN = "claude.ai";
const CLAUDE_ORIGINS = ["https://claude.ai", "https://a.claude.ai"];
const CLAUDE_TAB_PATTERNS = ["https://claude.ai/*", "https://*.claude.ai/*"];
const CLAUDE_HOME = "https://claude.ai/";
const SESSION_COOKIE = "sessionKey";
// Host-only and domain cookies can share a name, so one remove() pass may leave a twin behind.
const MAX_CLEAR_PASSES = 3;
const FINGERPRINT_BYTES = 4;
// Long enough for claude.ai to boot and make its first API calls after the reload.
const POST_RELOAD_CHECK_MS = 8000;

const OPEN_COMMAND = "open-switcher";
const EXTENSION_ORIGIN = chrome.runtime.getURL("");
const OVERLAY_URL = chrome.runtime.getURL("switcher.html?mode=overlay");
const WINDOW_URL = chrome.runtime.getURL("switcher.html?mode=window");
const WINDOW_SIZE = { width: 520, height: 560 };
// switcher.html is web-accessible, so any site could frame it. Only frames in a tab
// where the shortcut just opened the overlay may act, and only for this long.
const OVERLAY_GRANT_MS = 10 * 60 * 1000;

class SwitcherError extends Error {
  constructor(message) {
    super(message);
    this.name = "SwitcherError";
  }
}

// ---------- cookies ----------

function cookieUrl(cookie) {
  return `https://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
}

async function readCookies() {
  const cookies = await chrome.cookies.getAll({ domain: CLAUDE_DOMAIN });
  return cookies.map(({ partitionKey, storeId, ...rest }) => rest);
}

function cookieValue(cookies, name) {
  return cookies.find((c) => c.name === name)?.value ?? null;
}

// Short hash of sessionKey: tells sessions apart without exposing the token.
async function fingerprint(cookies) {
  const key = cookieValue(cookies, SESSION_COOKIE);
  if (!key) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest).slice(0, FINGERPRINT_BYTES)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Partitioned (CHIPS) cookies are out of scope: getAll() without partitionKey skips them,
// and claude.ai does not keep its login in one.
async function clearClaude() {
  const cleared = await readCookies();
  for (let pass = 0; pass < MAX_CLEAR_PASSES; pass++) {
    const remaining = await readCookies();
    if (remaining.length === 0) break;
    await Promise.all(remaining.map((c) => chrome.cookies.remove({ url: cookieUrl(c), name: c.name })));
  }
  const leftover = await readCookies();
  if (leftover.length > 0) {
    throw new SwitcherError(`Could not clear cookies: ${leftover.map((c) => c.name).join(", ")}`);
  }
  // Cached app data belongs to the old account; without this the UI can show stale chats.
  // Every host that held a cookie is cleared too, not only the two known origins.
  const hosts = cleared.map((c) => `https://${c.domain.replace(/^\./, "")}`);
  await chrome.browsingData.remove(
    { origins: [...new Set([...CLAUDE_ORIGINS, ...hosts])] },
    { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
  );
}

function toSetDetails(cookie) {
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
  // __Host- cookies and other host-only cookies must not carry a domain attribute.
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (!cookie.session) details.expirationDate = cookie.expirationDate;
  return details;
}

function liveCookies(cookies) {
  const nowSeconds = Date.now() / 1000;
  return cookies.filter((c) => c.session || c.expirationDate > nowSeconds);
}

// Called before anything is cleared, so an expired target never leaves you logged out.
function assertRestorable(cookies) {
  if (!liveCookies(cookies).some((c) => c.name === SESSION_COOKIE)) {
    throw new SwitcherError("Saved session has expired. Log in again and re-save it.");
  }
}

async function restoreCookies(cookies) {
  assertRestorable(cookies);
  const live = liveCookies(cookies);
  // One bad tracking cookie must not abort the switch; only sessionKey is fatal.
  const results = await Promise.all(
    live.map(async (c) => {
      try {
        return { name: c.name, ok: (await chrome.cookies.set(toSetDetails(c))) !== null };
      } catch (err) {
        console.warn(`Cookie ${c.name} rejected:`, err);
        return { name: c.name, ok: false };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (failed.includes(SESSION_COOKIE)) {
    throw new SwitcherError("Could not restore the sessionKey cookie.");
  }
  if (failed.length > 0) console.warn("Cookies not restored:", failed);
}

// ---------- state ----------

async function loadState() {
  const { sessions = [], activeId = null, lastCheck = null } = await chrome.storage.local.get([
    "sessions",
    "activeId",
    "lastCheck",
  ]);
  return { sessions, activeId, lastCheck };
}

async function saveState(state) {
  await chrome.storage.local.set(state);
}

// The saved session the browser is logged in as, or null when signed out or unsaved.
// Only an exact sessionKey match counts. Cookies such as lastActiveOrg are shared by every
// account in a Team org, so they cannot tell two of your accounts apart.
function findCurrentSession({ sessions }, current) {
  const key = cookieValue(current, SESSION_COOKIE);
  if (!key) return null;
  return sessions.find((s) => cookieValue(s.cookies, SESSION_COOKIE) === key) ?? null;
}

// Re-saves the logged-in session's other cookies (Cloudflare, routing) so they stay fresh.
// A different login never overwrites a slot: the match is on the exact sessionKey.
async function refreshCurrent(state) {
  const current = await readCookies();
  const session = findCurrentSession(state, current);
  if (!session) return;
  session.cookies = current;
  session.savedAt = Date.now();
  await saveState(state);
}

// ---------- account identity: colour + initials ----------

// White text stays legible on all of these, in the toolbar badge and in the switcher.
const ACCOUNT_COLOURS = ["#4F7CAC", "#5E8C61", "#9A6BB8", "#C2577A", "#2F8F8A", "#B7882F", "#6B6B9A", "#7A7F3A"];
const UNSAVED_COLOUR = "#8A877E";
const BADGE_TEXT_COLOUR = "#FFFFFF";
const MAX_INITIALS = 2;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Hashes the session id, not the name or key, so the colour survives renames and key rotation.
function colourFor(id) {
  let hash = FNV_OFFSET;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), FNV_PRIME) >>> 0;
  return ACCOUNT_COLOURS[hash % ACCOUNT_COLOURS.length];
}

// "Lumen Prosperity" → "LP", "Personal" → "P", "Prosperity (work)" → "PW".
function initialsFor(name) {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? ["?"];
  return words
    .slice(0, MAX_INITIALS)
    .map((w) => w[0].toUpperCase())
    .join("");
}

async function updateBadge() {
  const state = await loadState();
  const current = await readCookies();
  const session = findCurrentSession(state, current);
  const signedIn = cookieValue(current, SESSION_COOKIE) !== null;

  let text = "";
  let colour = UNSAVED_COLOUR;
  let title = "Claude sessions: signed out";
  if (session) {
    text = initialsFor(session.name);
    colour = colourFor(session.id);
    title = `Claude sessions: ${session.name}`;
  } else if (signedIn) {
    text = "?";
    title = "Claude sessions: unsaved login";
  }
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color: colour }),
    chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOUR }),
    chrome.action.setTitle({ title }),
  ]);
}

async function reloadClaudeTabs() {
  const tabs = await chrome.tabs.query({ url: CLAUDE_TAB_PATTERNS });
  if (tabs.length === 0) {
    await chrome.tabs.create({ url: CLAUDE_HOME });
    return;
  }
  await Promise.all(tabs.map((t) => chrome.tabs.update(t.id, { url: CLAUDE_HOME })));
}

// ---------- actions ----------

async function view() {
  const state = await loadState();
  const current = await readCookies();
  return {
    sessions: await Promise.all(
      state.sessions.map(async ({ id, name, savedAt, cookies }) => ({
        id,
        name,
        savedAt,
        fingerprint: await fingerprint(cookies),
        colour: colourFor(id),
        initials: initialsFor(name),
      })),
    ),
    currentId: findCurrentSession(state, current)?.id ?? null,
    signedIn: cookieValue(current, SESSION_COOKIE) !== null,
    lastCheck: state.lastCheck,
  };
}

// Bumped by every switch, so a check from an older switch knows it is stale.
let switchGeneration = 0;

// Records whether the target sessionKey survived the reload, for the popup to show next time.
async function checkAfterReload(generation, name, expected) {
  await new Promise((resolve) => setTimeout(resolve, POST_RELOAD_CHECK_MS));
  await serialized(async () => {
    if (generation !== switchGeneration) return;
    const actual = await fingerprint(await readCookies());
    const lastCheck = { name, expected, actual, ok: actual === expected, at: Date.now() };
    if (!lastCheck.ok) console.warn("sessionKey changed after reload", lastCheck);
    await chrome.storage.local.set({ lastCheck });
  });
}

async function saveCurrent(name) {
  const trimmed = name?.trim();
  if (!trimmed) throw new SwitcherError("Name is required.");
  const cookies = await readCookies();
  const key = cookieValue(cookies, SESSION_COOKIE);
  if (!key) throw new SwitcherError("Not logged in to claude.ai.");

  const state = await loadState();
  const sameName = state.sessions.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  // Re-saving the same login under its own name is fine; taking another account's name is not.
  if (sameName && cookieValue(sameName.cookies, SESSION_COOKIE) !== key) {
    throw new SwitcherError(`“${sameName.name}” is another account. Pick a different name.`);
  }
  const session = findCurrentSession(state, cookies) ?? { id: crypto.randomUUID() };
  Object.assign(session, { name: trimmed, cookies, savedAt: Date.now() });
  if (!state.sessions.includes(session)) state.sessions.push(session);
  state.activeId = session.id;
  await saveState(state);
}

async function switchTo(id) {
  const state = await loadState();
  const target = state.sessions.find((s) => s.id === id);
  if (!target) throw new SwitcherError("Session not found.");
  assertRestorable(target.cookies);

  // Persisted before the clear: if anything below fails, the current login is still saved.
  await refreshCurrent(state);
  await clearClaude();
  await restoreCookies(target.cookies);

  const expected = await fingerprint(target.cookies);
  const restored = await fingerprint(await readCookies());
  if (restored !== expected) {
    throw new SwitcherError(`sessionKey did not stick: expected ${expected}, browser has ${restored}.`);
  }

  state.activeId = target.id;
  state.lastCheck = null;
  await saveState(state);
  await reloadClaudeTabs();
  // Not awaited: the popup closes now; the result shows the next time it opens.
  const generation = ++switchGeneration;
  checkAfterReload(generation, target.name, expected).catch((err) => console.error("Post-reload check failed", err));
}

// Clears cookies without hitting /logout, so every saved session stays valid on the server.
async function newLogin() {
  const state = await loadState();
  await refreshCurrent(state);
  switchGeneration++;
  await clearClaude();
  state.activeId = null;
  await saveState(state);
  await reloadClaudeTabs();
}

async function remove(id) {
  const state = await loadState();
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeId === id) state.activeId = null;
  await saveState(state);
}

// Actions that can change who the browser is logged in as, or what is saved.
const BADGE_AFFECTING = new Set(["save", "switch", "newLogin", "remove"]);
// Must not wait behind a running switch, or Esc would not close the overlay until it ends.
const UNQUEUED = new Set(["closeOverlay"]);

const ACTIONS = {
  view: () => view(),
  save: (msg) => saveCurrent(msg.name),
  switch: (msg) => switchTo(msg.id),
  newLogin: () => newLogin(),
  remove: (msg) => remove(msg.id),
  closeOverlay: (_msg, sender) => revokeOverlay(sender.tab?.id),
};

// ---------- shortcut: centred switcher ----------

async function loadOverlayGrants() {
  const { overlayGrants = {} } = await chrome.storage.session.get("overlayGrants");
  return overlayGrants;
}

async function grantOverlay(tabId) {
  const grants = await loadOverlayGrants();
  grants[tabId] = Date.now() + OVERLAY_GRANT_MS;
  await chrome.storage.session.set({ overlayGrants: grants });
}

async function revokeOverlay(tabId) {
  if (tabId === undefined) return;
  const grants = await loadOverlayGrants();
  delete grants[tabId];
  await chrome.storage.session.set({ overlayGrants: grants });
}

// Content scripts are excluded: only extension pages may drive the switcher.
async function isTrustedSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(EXTENSION_ORIGIN)) return false;
  // Toolbar popup (no tab) or the fallback window (top frame of its own tab).
  if (!sender.tab || sender.frameId === 0) return true;
  const grants = await loadOverlayGrants();
  return (grants[sender.tab.id] ?? 0) > Date.now();
}

// Runs in the page. Toggles a full-viewport iframe holding switcher.html.
function toggleOverlay(src) {
  const OVERLAY_ID = "claude-session-switcher";
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    existing.remove();
    return false;
  }
  const frame = document.createElement("iframe");
  frame.id = OVERLAY_ID;
  frame.src = src;
  frame.setAttribute("style", [
    "position:fixed", "inset:0", "width:100vw", "height:100vh", "margin:0", "padding:0",
    "border:0", "z-index:2147483647", "background:transparent", "color-scheme:normal",
  ].map((rule) => `${rule} !important`).join(";"));
  const onMessage = (event) => {
    if (event.source !== frame.contentWindow || event.data?.type !== "claude-switcher:close") return;
    frame.remove();
    window.removeEventListener("message", onMessage);
  };
  window.addEventListener("message", onMessage);
  frame.addEventListener("load", () => frame.focus());
  document.documentElement.append(frame);
  return true;
}

async function openSwitcherWindow() {
  const parent = await chrome.windows.getLastFocused();
  const left = Math.round((parent.left ?? 0) + ((parent.width ?? WINDOW_SIZE.width) - WINDOW_SIZE.width) / 2);
  const top = Math.round((parent.top ?? 0) + ((parent.height ?? WINDOW_SIZE.height) - WINDOW_SIZE.height) / 3);
  await chrome.windows.create({ url: WINDOW_URL, type: "popup", focused: true, left, top, ...WINDOW_SIZE });
}

async function openSwitcher(tab) {
  if (tab?.id === undefined) return openSwitcherWindow();
  try {
    // Granted before injection: the iframe can message before executeScript resolves.
    await grantOverlay(tab.id);
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: toggleOverlay,
      args: [OVERLAY_URL],
    });
    if (injection?.result !== true) await revokeOverlay(tab.id);
  } catch (err) {
    // chrome://, the Web Store and the new tab page refuse injection. A window works everywhere.
    console.info("Overlay not allowed on this page; opening a window instead.", err.message);
    await revokeOverlay(tab.id);
    await openSwitcherWindow();
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== OPEN_COMMAND) return;
  openSwitcher(tab).catch((err) => console.error("Could not open switcher", err));
});

// A navigation removes the overlay, so its grant must not carry over to the next page.
function revokeOnLeave(tabId) {
  revokeOverlay(tabId).catch((err) => console.error("Could not revoke overlay grant", err));
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") revokeOnLeave(tabId);
});
chrome.tabs.onRemoved.addListener(revokeOnLeave);

// Runs actions one at a time; two overlapping switches would interleave cookie writes.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn);
  // The chain only orders work; the caller still receives the rejection through `run`.
  queue = run.catch(() => undefined);
  return run;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const action = ACTIONS[msg?.type];
  if (!action) {
    sendResponse({ ok: false, error: `Unknown action: ${msg?.type}` });
    return false;
  }
  isTrustedSender(sender)
    .then((trusted) => {
      if (!trusted) throw new SwitcherError("Switcher was opened from an untrusted page.");
      if (UNQUEUED.has(msg.type)) return action(msg, sender);
      return serialized(async () => {
        const result = await action(msg, sender);
        // The action already succeeded; a badge failure must not report it as failed.
        if (BADGE_AFFECTING.has(msg.type)) await updateBadge().catch((err) => console.error("Badge update failed", err));
        return result;
      });
    })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.error(err);
      sendResponse({ ok: false, error: err.message });
    });
  return true;
});

// ---------- badge triggers outside the switcher ----------

// A login or logout on claude.ai itself changes sessionKey; a switch changes it several times.
const BADGE_DEBOUNCE_MS = 300;
let badgeTimer;

function scheduleBadgeUpdate() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    serialized(updateBadge).catch((err) => console.error("Badge update failed", err));
  }, BADGE_DEBOUNCE_MS);
}

chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.name === SESSION_COOKIE && cookie.domain.replace(/^\./, "").endsWith(CLAUDE_DOMAIN)) {
    scheduleBadgeUpdate();
  }
});
chrome.runtime.onStartup.addListener(scheduleBadgeUpdate);
chrome.runtime.onInstalled.addListener(scheduleBadgeUpdate);
