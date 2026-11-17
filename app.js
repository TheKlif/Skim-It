const list = document.getElementById("list");
const meta = document.getElementById("meta");

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

function renderRow(item, index) {
  const row = make("div", "row");
  row.appendChild(make("div", "rank", String(index + 1)));

  const hasScore = item.score !== null && item.score !== undefined;
  row.appendChild(make("div", hasScore ? "score" : "score none", hasScore ? String(item.score) : "\u2013"));

  const main = make("div", "main");
  const titleLine = make("div", "titleline");
  const title = make("a", "title", item.title);
  const href = safeUrl(item.link);
  if (href) {
    title.href = href;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
  }
  titleLine.appendChild(title);
  if (item.domain) titleLine.appendChild(make("span", "domain", "(" + item.domain + ")"));
  main.appendChild(titleLine);

  const sub = make("div", "sub");
  sub.appendChild(make("span", "chip", item.source));
  if (item.label) sub.appendChild(make("span", "chip label", item.label));
  sub.appendChild(make("span", "", timeAgo(item.published)));
  const commentHref = safeUrl(item.comment_link);
  if (commentHref) {
    const comments = make("a", "", "comments");
    comments.href = commentHref;
    comments.target = "_blank";
    comments.rel = "noopener noreferrer";
    sub.appendChild(comments);
  }
  main.appendChild(sub);

  row.appendChild(main);
  return row;
}

async function load() {
  try {
    const response = await fetch("data/items.json", { cache: "no-cache" });
    const data = await response.json();
    const items = (data.items || []).slice().sort((a, b) => b.published.localeCompare(a.published));
    if (!items.length) {
      list.appendChild(make("div", "empty", "No items yet."));
      return;
    }
    items.forEach((item, index) => list.appendChild(renderRow(item, index)));
    meta.textContent = items.length + " items, updated " + timeAgo(data.updated);
  } catch (error) {
    list.appendChild(make("div", "empty", "Could not load data/items.json."));
  }
}

load();