"use strict";

// Shared UI for the toolbar popup, the in-page overlay and the fallback window.

const MODE = new URLSearchParams(location.search).get("mode") ?? "popup";
const MAX_HOTKEY_SLOTS = 9;
const CLOSE_MESSAGE = { type: "claude-switcher:close" };
const TIME_UNITS = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const ICONS = {
  login: '<svg viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

const els = {
  backdrop: document.getElementById("backdrop"),
  current: document.getElementById("current"),
  save: document.getElementById("save"),
  savePrompt: document.getElementById("save-prompt"),
  saveOpen: document.getElementById("save-open"),
  saveForm: document.getElementById("save-form"),
  saveName: document.getElementById("save-name"),
  list: document.getElementById("list"),
  banner: document.getElementById("banner"),
};

const state = {
  sessions: [],
  currentId: null,
  signedIn: false,
  lastCheck: null,
  selected: 0,
  editingName: false,
  pendingKey: null,
  confirmDeleteId: null,
  message: null, // { text, tone: "error" | "ok" | "info" }
};

document.documentElement.dataset.mode = MODE;

// ---------- background ----------

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? "No response from background worker.");
  return res.data;
}

async function refresh() {
  Object.assign(state, await send("view"));
  render();
}

async function close() {
  if (MODE !== "overlay") {
    window.close();
    return;
  }
  try {
    await send("closeOverlay");
  } catch (err) {
    console.warn("Could not revoke overlay grant; it expires on its own.", err);
  }
  window.parent.postMessage(CLOSE_MESSAGE, "*");
}

// ---------- derived state ----------

function isUnsavedLogin() {
  return state.signedIn && !state.currentId;
}

function buildItems() {
  const items = state.sessions.map((session, slot) => ({ kind: "session", key: session.id, session, slot }));
  items.push({ kind: "newLogin", key: "newLogin" });
  return items;
}

function relativeTime(timestamp) {
  const elapsed = timestamp - Date.now();
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, ms] of TIME_UNITS) {
    if (Math.abs(elapsed) >= ms) return format.format(Math.round(elapsed / ms), unit);
  }
  return "just now";
}

// ---------- rendering ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function textBlock(title, meta, metaClass = "meta") {
  const text = el("span", "text");
  text.append(el("div", "title", title), meta instanceof Node ? meta : el("div", metaClass, meta));
  return text;
}

function renderSession(item, li) {
  const { session, slot } = item;
  const duplicate = state.sessions.find((s) => s.id !== session.id && s.fingerprint === session.fingerprint);

  const avatar = el("span", "avatar", session.initials);
  avatar.style.background = session.colour;

  let meta;
  if (duplicate) {
    meta = el("div", "meta warn", `Same login as “${duplicate.name}”. Re-save one of them.`);
  } else {
    meta = el("div", "meta");
    meta.append(`Saved ${relativeTime(session.savedAt)} · `, el("code", "", session.fingerprint ?? "no key"));
  }

  const trail = el("span", "trail");
  if (state.pendingKey === item.key) {
    trail.append(el("span", "spinner"));
  } else {
    if (session.id === state.currentId) trail.append(el("span", "pill", "Current"));
    else if (slot < MAX_HOTKEY_SLOTS) trail.append(el("kbd", "", String(slot + 1)));
    trail.append(renderDeleteButton(session));
  }

  li.append(avatar, textBlock(session.name, meta), trail);
}

// Two clicks to delete; confirm() is unreliable inside extension popups.
function renderDeleteButton(session) {
  const confirming = state.confirmDeleteId === session.id;
  const button = el("button", confirming ? "action confirm" : "action");
  button.type = "button";
  button.title = "Delete saved session";
  if (confirming) button.textContent = "Delete?";
  else button.innerHTML = ICONS.close;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    requestDelete(session);
  });
  return button;
}

function renderNewLogin(item, li) {
  const glyph = el("span", "glyph");
  glyph.innerHTML = ICONS.login;
  const trail = el("span", "trail");
  if (state.pendingKey === item.key) trail.append(el("span", "spinner"));
  else trail.append(el("kbd", "", "N"));
  li.append(glyph, textBlock("Log in to another account", "Saved sessions stay valid."), trail);
}

function renderItem(item, index) {
  const li = el("li", "item");
  li.id = `item-${index}`;
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", String(index === state.selected));
  if (item.kind === "session") renderSession(item, li);
  else renderNewLogin(item, li);
  li.addEventListener("pointermove", () => select(index));
  li.addEventListener("click", () => activate(item));
  return li;
}

function renderHeader() {
  const session = state.sessions.find((s) => s.id === state.currentId);
  els.current.textContent = session?.name ?? (state.signedIn ? "Unsaved login" : "Signed out");
  els.current.style.setProperty("--dot", session?.colour ?? "var(--muted)");
}

function renderSaveBlock() {
  els.save.hidden = !isUnsavedLogin();
  els.savePrompt.hidden = state.editingName;
  els.saveForm.hidden = !state.editingName;
  const saving = state.pendingKey === "save";
  for (const control of els.saveForm.elements) control.disabled = saving;
}

function renderBanner() {
  let message = state.message;
  if (!message && state.lastCheck?.ok === false) {
    const { name, expected, actual } = state.lastCheck;
    message = {
      tone: "error",
      text: `After switching to ${name}, claude.ai replaced the session (${expected} → ${actual ?? "none"}).`,
    };
  }
  if (!message && state.sessions.length === 0 && !state.signedIn) {
    message = { tone: "info", text: "Log in on claude.ai, then save that login here." };
  }
  els.banner.hidden = !message;
  els.banner.className = `banner ${message?.tone ?? ""}`;
  els.banner.textContent = message?.text ?? "";
}

function render() {
  const items = buildItems();
  state.selected = Math.min(state.selected, items.length - 1);

  const nodes = [];
  items.forEach((item, index) => {
    if (item.kind === "newLogin" && index > 0) nodes.push(el("li", "divider"));
    nodes.push(renderItem(item, index));
  });
  els.list.replaceChildren(...nodes);
  els.list.setAttribute("aria-activedescendant", `item-${state.selected}`);
  document.getElementById(`item-${state.selected}`)?.scrollIntoView({ block: "nearest" });

  renderHeader();
  renderSaveBlock();
  renderBanner();
}

// ---------- actions ----------

function select(index) {
  if (index === state.selected) return;
  state.selected = index;
  render();
}

async function run(key, fn) {
  if (state.pendingKey) return;
  state.pendingKey = key;
  state.message = null;
  render();
  try {
    await fn();
  } catch (err) {
    state.message = { tone: "error", text: err.message };
  } finally {
    state.pendingKey = null;
    render();
  }
}

function activate(item) {
  if (item.kind === "session") return switchTo(item);
  return run(item.key, async () => {
    await send("newLogin");
    await close();
  });
}

function switchTo(item) {
  if (item.session.id === state.currentId) return close();
  return run(item.key, async () => {
    await send("switch", { id: item.session.id });
    await close();
  });
}

function setEditingName(editing) {
  state.editingName = editing;
  state.message = null;
  render();
  if (editing) els.saveName.focus();
  else els.list.focus();
}

function saveCurrent() {
  const name = els.saveName.value.trim();
  if (!name) {
    els.saveName.focus();
    return;
  }
  run("save", async () => {
    await send("save", { name });
    els.saveName.value = "";
    state.editingName = false;
    await refresh();
    state.message = { tone: "ok", text: `Saved “${name}”.` };
    els.list.focus();
  });
}

function requestDelete(session) {
  if (state.confirmDeleteId !== session.id) {
    state.confirmDeleteId = session.id;
    render();
    return;
  }
  state.confirmDeleteId = null;
  run(session.id, async () => {
    await send("remove", { id: session.id });
    await refresh();
  });
}

// ---------- input ----------

function onListKey(event) {
  const items = buildItems();
  const selectedItem = items[state.selected];
  const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const step = event.key === "ArrowDown" ? 1 : -1;
    select((state.selected + step + items.length) % items.length);
  } else if (event.key === "Enter") {
    if (selectedItem) activate(selectedItem);
  } else if (event.key === "Escape") {
    close();
  } else if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && selectedItem?.kind === "session") {
    requestDelete(selectedItem.session);
  } else if (plainKey && /^[1-9]$/.test(event.key)) {
    const item = items.find((i) => i.kind === "session" && i.slot === Number(event.key) - 1);
    if (!item) return;
    switchTo(item);
  } else if (plainKey && event.key.toLowerCase() === "n") {
    activate(items.find((i) => i.kind === "newLogin"));
  } else if (plainKey && event.key.toLowerCase() === "s" && isUnsavedLogin()) {
    setEditingName(true);
  } else {
    return;
  }
  event.preventDefault();
}

document.addEventListener("keydown", (event) => {
  if (event.target === els.saveName) {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditingName(false);
    }
    return;
  }
  // A focused button handles Enter and Space itself; list keys would fire a second action.
  if (event.target instanceof HTMLButtonElement && event.key !== "Escape") return;
  onListKey(event);
});

els.saveOpen.addEventListener("click", () => setEditingName(true));
els.saveForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveCurrent();
});
els.backdrop.addEventListener("click", () => close());

els.list.focus();
refresh().catch((err) => {
  state.message = { tone: "error", text: err.message };
  render();
});
