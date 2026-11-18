const STATE_KEY = "skimit.state";
const VIEW_KEY = "skimit.view";
const TOKEN_KEY = "skimit.dispatchToken";
const WORKFLOW_FILE = "fetch.yml";
const STATE_LIMIT = 2000;
const POLL_MS = 15000;
const POLL_MAX_MS = 300000;

const listEl = document.getElementById("list");
const swipeEl = document.getElementById("swipe");
const metaEl = document.getElementById("meta");
const liveEl = document.getElementById("live");
const tabList = document.getElementById("tab-list");
const tabSwipe = document.getElementById("tab-swipe");
const refreshBtn = document.getElementById("reload");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const GLYPHS = {
  video: '<polygon points="8,5 19,12 8,19" fill="currentColor" stroke="none"/>',
  audio: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  image: '<path d="M4 5h16v14H4z"/><path d="M4 16l5-5 4 4 3-3 4 4"/>',
  text: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  link: '<path d="M7 17L17 7M9 7h8v8"/>',
};
const ICONS = {
  dismiss: '<path d="M6 6l12 12M18 6L6 18"/>',
  keep: '<path d="M5 12l5 5 9-10"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
};

let items = [];
let updatedAt = "";
let state = {};
let view = "list";
let detailId = null;
let busy = false;
let refreshing = false;
const undoStack = [];

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    /* storage unavailable, state lasts for this page load only */
  }
}

function trimState() {
  const ids = Object.keys(state);
  if (ids.length <= STATE_LIMIT) return;
  ids.slice(0, ids.length - STATE_LIMIT).forEach((id) => delete state[id]);
  writeStore(STATE_KEY, state);
}

function setState(id, value) {
  if (value === undefined) {
    delete state[id];
  } else {
    state[id] = value;
  }
  writeStore(STATE_KEY, state);
}

function stateClass(id) {
  if (state[id] === "d") return " dismissed";
  if (state[id] === "r") return " read";
  return "";
}

function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 3600) return Math.max(1, Math.floor(seconds / 60)) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeUrl(url) {
  return /^https?:\/\//i.test(url || "") ? url : "";
}

function announce(text) {
  liveEl.textContent = text;
}

function svgIcon(inner) {
  const wrap = document.createElement("span");
  wrap.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    inner + "</svg>";
  return wrap;
}

function glyph(type) {
  const node = svgIcon(GLYPHS[type] || GLYPHS.link);
  node.className = "glyph";
  return node;
}

function makeMedia(item, className, withExcerpt) {
  const box = make("div", className);
  const fallback = () => {
    box.textContent = "";
    box.classList.add("noimg");
    box.appendChild(glyph(item.type));
    if (withExcerpt && item.excerpt) box.appendChild(make("p", "media-excerpt", item.excerpt));
  };
  const href = safeUrl(item.thumb);
  if (!href) {
    fallback();
    return box;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", fallback);
  img.addEventListener("load", () => {
    if (img.naturalWidth < 20 || img.naturalHeight < 20) fallback();
  });
  img.src = href;
  box.appendChild(img);
  return box;
}

function addChips(parent, item) {
  parent.appendChild(make("span", "chip", item.source));
  if (item.label) parent.appendChild(make("span", "chip label", item.label));
}

function markRead(id, row) {
  if (state[id] !== "r") setState(id, "r");
  if (row) row.className = "row" + stateClass(id);
}

function wireRead(node, id, row) {
  node.addEventListener("click", () => markRead(id, row));
  node.addEventListener("auxclick", () => markRead(id, row));
}

function renderRow(item) {
  const row = make("div", "row" + stateClass(item.id));
  const hasScore = item.score !== null && item.score !== undefined;
  row.appendChild(make("div", hasScore ? "score" : "score none", hasScore ? String(item.score) : "\u2013"));
  row.appendChild(makeMedia(item, "thumb", false));

  const main = make("div", "main");
  const titleLine = make("div", "titleline");
  const title = make("a", "title", item.title);
  const href = safeUrl(item.link);
  if (href) {
    title.href = href;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    wireRead(title, item.id, row);
  }
  titleLine.appendChild(title);
  if (item.domain) titleLine.appendChild(make("span", "domain", "(" + item.domain + ")"));
  main.appendChild(titleLine);

  const sub = make("div", "sub");
  addChips(sub, item);
  sub.appendChild(make("span", "", timeAgo(item.published)));
  const commentHref = safeUrl(item.comment_link);
  if (commentHref) {
    const comments = make("a", "", "comments");
    comments.href = commentHref;
    comments.target = "_blank";
    comments.rel = "noopener noreferrer";
    wireRead(comments, item.id, row);
    sub.appendChild(comments);
  }
  main.appendChild(sub);
  row.appendChild(main);
  return row;
}

function renderList() {
  listEl.textContent = "";
  if (!items.length) {
    listEl.appendChild(make("div", "empty", "No items yet."));
    metaEl.textContent = "";
    return;
  }
  items.forEach((item) => listEl.appendChild(renderRow(item)));
  metaEl.textContent = items.length + " items, updated " + timeAgo(updatedAt);
}

function queue() {
  return items.filter((item) => !state[item.id]);
}

function preload(upcoming) {
  upcoming.slice(1, 4).forEach((item) => {
    const href = safeUrl(item.thumb);
    if (!href) return;
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.src = href;
  });
}

function dismissCurrent() {
  const item = queue()[0];
  if (!item) return;
  undoStack.push({ id: item.id, previous: state[item.id] });
  setState(item.id, "d");
  announce("Dismissed: " + item.title);
  renderSwipe();
}

function keepCurrent() {
  const item = queue()[0];
  if (!item) return;
  undoStack.push({ id: item.id, previous: state[item.id] });
  setState(item.id, "r");
  detailId = item.id;
  announce("Opened: " + item.title);
  renderSwipe();
  window.scrollTo(0, 0);
}

function undo() {
  const last = undoStack.pop();
  if (!last) {
    announce("Nothing to undo");
    return;
  }
  setState(last.id, last.previous);
  detailId = null;
  announce("Undone");
  renderSwipe();
}

function closeDetail() {
  detailId = null;
  renderSwipe();
}

function fling(direction) {
  const card = swipeEl.querySelector(".card");
  if (!card || busy) return;
  busy = true;
  const finish = () => {
    busy = false;
    if (direction < 0) {
      dismissCurrent();
    } else {
      keepCurrent();
    }
  };
  if (reduceMotion) {
    finish();
    return;
  }
  card.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out";
  card.style.transform = "translateX(" + direction * window.innerWidth + "px) rotate(" + direction * 20 + "deg)";
  card.style.opacity = "0";
  setTimeout(finish, 200);
}

function attachSwipe(card) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let dragging = false;

  card.addEventListener("pointerdown", (event) => {
    if (event.button > 0 || busy) return;
    tracking = true;
    dragging = false;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
  });

  card.addEventListener("pointermove", (event) => {
    if (!tracking) return;
    dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        dragging = true;
        card.setPointerCapture(event.pointerId);
        card.classList.add("dragging");
      } else {
        return;
      }
    }
    card.style.transform = "translateX(" + dx + "px) rotate(" + dx / 25 + "deg)";
    card.classList.toggle("hint-no", dx < -40);
    card.classList.toggle("hint-yes", dx > 40);
  });

  const finish = () => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    card.classList.remove("dragging", "hint-no", "hint-yes");
    const limit = Math.min(120, card.offsetWidth * 0.3);
    if (dx <= -limit) {
      fling(-1);
    } else if (dx >= limit) {
      fling(1);
    } else {
      card.style.transform = "";
    }
  };
  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
}

function buildCard(item) {
  const card = make("article", "card");
  card.appendChild(makeMedia(item, "media", true));
  const sub = make("div", "sub");
  addChips(sub, item);
  card.appendChild(sub);
  card.appendChild(make("h2", "card-title", item.title));
  const info = [item.domain, timeAgo(item.published)].filter(Boolean).join(", ");
  card.appendChild(make("div", "card-info", info));
  attachSwipe(card);
  return card;
}

function buildEmpty() {
  const box = make("div", "empty-card");
  box.appendChild(make("p", "", "Nothing new in the queue."));
  box.appendChild(make("p", "", "Last update: " + (updatedAt ? timeAgo(updatedAt) : "unknown") + "."));
  return box;
}

function roundButton(className, label, icon, handler) {
  const button = make("button", "round " + className);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.appendChild(svgIcon(icon));
  button.addEventListener("click", handler);
  return button;
}

function buildControls() {
  const controls = make("div", "controls");
  controls.appendChild(roundButton("big", "Dismiss", ICONS.dismiss, () => fling(-1)));
  controls.appendChild(roundButton("mid", "Undo", ICONS.undo, undo));
  controls.appendChild(roundButton("big yes", "Keep and see more", ICONS.keep, () => fling(1)));
  return controls;
}

function buildDetail(item) {
  const box = make("article", "detail");
  const back = make("button", "back-btn", "\u2190 Back to cards");
  back.type = "button";
  back.addEventListener("click", closeDetail);
  box.appendChild(back);
  box.appendChild(makeMedia(item, "media small", false));
  const sub = make("div", "sub");
  addChips(sub, item);
  box.appendChild(sub);
  box.appendChild(make("h2", "card-title", item.title));
  box.appendChild(make("p", "detail-excerpt", item.excerpt || "No excerpt available for this item."));
  const info = [item.domain, timeAgo(item.published)].filter(Boolean).join(", ");
  box.appendChild(make("div", "card-info", info));

  const actions = make("div", "actions");
  const href = safeUrl(item.link);
  if (href) {
    const open = make("a", "btn primary", "Open page");
    open.href = href;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    actions.appendChild(open);
  }
  const commentHref = safeUrl(item.comment_link);
  if (commentHref) {
    const comments = make("a", "btn", "Comments");
    comments.href = commentHref;
    comments.target = "_blank";
    comments.rel = "noopener noreferrer";
    actions.appendChild(comments);
  }
  box.appendChild(actions);
  return box;
}

function renderSwipe() {
  swipeEl.textContent = "";
  metaEl.textContent = "";
  const detailItem = detailId ? items.find((entry) => entry.id === detailId) : null;
  if (detailId && !detailItem) detailId = null;

  const wrap = make("div", "swipe-wrap");
  const upcoming = queue();
  if (detailItem) {
    wrap.appendChild(buildDetail(detailItem));
  } else {
    wrap.appendChild(make("div", "swipe-top", upcoming.length + " left"));
    wrap.appendChild(upcoming.length ? buildCard(upcoming[0]) : buildEmpty());
    wrap.appendChild(buildControls());
    wrap.appendChild(make("p", "hint",
      "Swipe the card or use the buttons. Arrow keys also work: left dismisses, right keeps, Z undoes."));
    preload(upcoming);
  }
  swipeEl.appendChild(wrap);
}

function setView(name) {
  view = name;
  writeStore(VIEW_KEY, name);
  tabList.setAttribute("aria-pressed", String(name === "list"));
  tabSwipe.setAttribute("aria-pressed", String(name === "swipe"));
  listEl.hidden = name !== "list";
  swipeEl.hidden = name !== "swipe";
  if (name === "list") {
    renderList();
  } else {
    renderSwipe();
  }
}

document.addEventListener("keydown", (event) => {
  if (view !== "swipe" || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key;
  if (detailId) {
    if (key === "Escape" || key === "ArrowLeft") {
      event.preventDefault();
      closeDetail();
    }
    return;
  }
  if (key === "ArrowLeft") {
    event.preventDefault();
    fling(-1);
  } else if (key === "ArrowRight") {
    event.preventDefault();
    fling(1);
  } else if (key === "z" || key === "Z") {
    undo();
  }
});

tabList.addEventListener("click", () => setView("list"));
tabSwipe.addEventListener("click", () => setView("swipe"));

async function loadItems() {
  try {
    const response = await fetch("data/items.json?t=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    updatedAt = data.updated || "";
    items = (data.items || []).slice().sort((a, b) => b.published.localeCompare(a.published));
    return true;
  } catch (error) {
    return false;
  }
}

async function reloadData() {
  announce("Reloading");
  const ok = await loadItems();
  if (!ok) {
    announce("Could not reload");
    return;
  }
  detailId = null;
  setView(view);
  announce("Updated, " + items.length + " items");
}

function repoInfo() {
  const parts = location.pathname.split("/").filter(Boolean);
  const first = parts[0] || "";
  if (!location.hostname.endsWith(".github.io") || !first || first === "index.html") return null;
  return { owner: location.hostname.split(".")[0], repo: first };
}

async function dispatchWorkflow(token, info) {
  const url = "https://api.github.com/repos/" + info.owner + "/" + info.repo +
    "/actions/workflows/" + WORKFLOW_FILE + "/dispatches";
  for (const ref of ["main", "master"]) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: ref }),
    });
    if (response.status === 204) return { ok: true, status: 204 };
    if (response.status !== 422) return { ok: false, status: response.status };
  }
  return { ok: false, status: 422 };
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshData() {
  if (refreshing) return;
  const info = repoInfo();
  if (!info) {
    await reloadData();
    return;
  }
  let token = readStore(TOKEN_KEY, "");
  if (!token) {
    const entered = window.prompt(
      "Paste a GitHub token to enable Refresh on this device. Cancel to just reload the data.", "");
    if (!entered || !entered.trim()) {
      await reloadData();
      return;
    }
    token = entered.trim();
    writeStore(TOKEN_KEY, token);
  }

  refreshing = true;
  refreshBtn.textContent = "Refreshing\u2026";
  announce("Starting refresh");
  try {
    const before = updatedAt;
    let result;
    try {
      result = await dispatchWorkflow(token, info);
    } catch (error) {
      result = { ok: false, status: 0 };
    }
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) {
        writeStore(TOKEN_KEY, "");
        window.alert("GitHub rejected the token, so it was removed. Press Refresh to paste a new one.");
      } else if (result.status === 404) {
        window.alert("GitHub could not find the repo or the fetch workflow, or the token has no access to this repo.");
      } else if (result.status === 422) {
        window.alert("No fetch workflow was found on the main or master branch.");
      } else {
        window.alert("Could not reach GitHub.");
      }
      return;
    }
    const started = Date.now();
    while (Date.now() - started < POLL_MAX_MS) {
      await pause(POLL_MS);
      const ok = await loadItems();
      if (ok && updatedAt !== before) {
        detailId = null;
        setView(view);
        announce("Updated, " + items.length + " items");
        return;
      }
    }
    window.alert("The fetch was started, but new data has not appeared yet. Try Refresh again in a minute.");
  } finally {
    refreshing = false;
    refreshBtn.textContent = "Refresh";
  }
}

refreshBtn.addEventListener("click", refreshData);

async function load() {
  state = readStore(STATE_KEY, {});
  trimState();
  const ok = await loadItems();
  if (!ok) {
    listEl.appendChild(make("div", "empty", "Could not load data/items.json."));
    return;
  }
  setView(readStore(VIEW_KEY, "list") === "swipe" ? "swipe" : "list");
}

load();