"""Fetch rss feeds listed in feeds.yml and write data/items.json and data/status.json."""

import calendar
import hashlib
import html
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import feedparser
import requests
import yaml

KEEP_DAYS = 14
MAX_ITEMS = 3000
PER_FEED = 100
TIMEOUT = 25
OG_CAP = 40
OG_TIMEOUT = 10
OG_WORKERS = 8
OG_MAX_BYTES = 262144
EXCERPT_LEN = 250
USER_AGENT = "Mozilla/5.0 (compatible; Skim-it feed fetcher)"
PAGE_HEADERS = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
ITEMS_PATH = "data/items.json"
STATUS_PATH = "data/status.json"
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
TRACKING_KEYS = {"fbclid", "gclid", "ref", "ref_src"}
VIDEO_HOSTS = {"youtube.com", "youtu.be", "vimeo.com", "dailymotion.com"}
AUDIO_HOSTS = {"soundcloud.com", "bandcamp.com", "spotify.com"}
IMAGE_HOSTS = {"flickr.com"}
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif")


def iso(moment):
    """Format a datetime as an ISO UTC string."""
    return moment.strftime(TIME_FORMAT)


def parse_iso(text):
    """Parse an ISO UTC string back to a datetime."""
    return datetime.strptime(text, TIME_FORMAT).replace(tzinfo=timezone.utc)


def load_json(path, default):
    """Read a JSON file, returning default if missing or broken."""
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def normalize_link(link):
    """Lowercase host, drop tracking params, fragment and trailing slash."""
    parts = urlsplit(link.strip())
    query = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_KEYS
    ]
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), urlencode(query), "")
    )


def make_id(entry, link, feed_name):
    """Build a 16 character id from the normalized link (or guid fallback)."""
    if link:
        key = normalize_link(link)
    else:
        key = feed_name + "|" + (entry.get("id") or entry.get("title") or "")
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def get_domain(link):
    """Return the host without a leading www."""
    host = urlsplit(link).netloc.lower() if link else ""
    return host[4:] if host.startswith("www.") else host


def get_published(entry, fetched):
    """Return the entry date, never later than fetch time, or fetch time if missing."""
    for key in ("published_parsed", "updated_parsed"):
        stamp = entry.get(key)
        if stamp:
            moment = datetime.fromtimestamp(calendar.timegm(stamp), timezone.utc)
            return min(moment, fetched)
    return fetched


def get_tags(entry):
    """Return up to 10 unique native tags."""
    tags = []
    for tag in entry.get("tags", []) or []:
        term = (tag.get("term") or "").strip()
        if term and term not in tags:
            tags.append(term)
    return tags[:10]


def base_domain(host):
    """Return the last two labels of a host name."""
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def host_matches(host, names):
    """Return True if the host or its base domain is in names."""
    return host in names or base_domain(host) in names


def youtube_id(link):
    """Return the YouTube video id in a link, or None."""
    parts = urlsplit(link)
    host = parts.netloc.lower()
    if host == "youtu.be":
        return parts.path.strip("/").split("/")[0] or None
    if base_domain(host) == "youtube.com":
        if parts.path == "/watch":
            return dict(parse_qsl(parts.query)).get("v")
        match = re.match(r"^/(?:shorts|embed|live)/([\w-]{6,})", parts.path)
        if match:
            return match.group(1)
    return None


def detect_type(entry, link, feed_url):
    """Classify an entry as video, audio, image, text or link."""
    host = urlsplit(link).netloc.lower() if link else ""
    path = urlsplit(link).path.lower() if link else ""
    kinds = []
    for attachment in (entry.get("enclosures") or []) + (entry.get("media_content") or []):
        kinds.append((attachment.get("type") or attachment.get("medium") or "").lower())
    if host_matches(host, VIDEO_HOSTS) or any(kind.startswith("video") for kind in kinds):
        return "video"
    if host_matches(host, AUDIO_HOSTS) or any(kind.startswith("audio") for kind in kinds):
        return "audio"
    if path.endswith(IMAGE_EXTENSIONS) or host_matches(host, IMAGE_HOSTS):
        return "image"
    if host and base_domain(host) == base_domain(urlsplit(feed_url).netloc.lower()):
        return "text"
    return "link"


def clean_url(url):
    """Return an http(s) url trimmed to 500 characters, or None."""
    url = (url or "").strip()
    if url.lower().startswith(("http://", "https://")):
        return url[:500]
    return None


def entry_html(entry):
    """Return the summary and content markup of an entry as one string."""
    parts = [entry.get("summary") or ""]
    for block in entry.get("content") or []:
        parts.append(block.get("value") or "")
    return " ".join(parts)


def extract_thumb(entry, link):
    """Find a thumbnail url from the feed entry without fetching anything."""
    video = youtube_id(link) if link else None
    if video:
        return "https://i.ytimg.com/vi/" + video + "/hqdefault.jpg"
    for attachment in entry.get("media_thumbnail") or []:
        url = clean_url(attachment.get("url"))
        if url:
            return url
    for attachment in entry.get("media_content") or []:
        kind = (attachment.get("type") or attachment.get("medium") or "").lower()
        if kind.startswith("image"):
            url = clean_url(attachment.get("url"))
            if url:
                return url
    for attachment in entry.get("enclosures") or []:
        if (attachment.get("type") or "").lower().startswith("image"):
            url = clean_url(attachment.get("href"))
            if url:
                return url
    for tag in re.findall(r"<img\b[^>]*>", entry_html(entry), re.I):
        if re.search(r'(?:width|height)=["\']?1["\']?[\s/>]', tag, re.I):
            continue
        source = re.search(r'src=["\']([^"\']+)["\']', tag, re.I)
        if source:
            url = clean_url(html.unescape(source.group(1)))
            if url:
                return url
    return None


def text_from_html(markup):
    """Strip tags from markup and collapse whitespace."""
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", markup, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def shorten(text, limit=EXCERPT_LEN):
    """Cut text at a word boundary and add an ellipsis if it was shortened."""
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:.-") + "\u2026"


def extract_excerpt(entry, title):
    """Return a short plain text excerpt from the entry, or None."""
    contents = " ".join(block.get("value") or "" for block in entry.get("content") or [])
    for markup in (entry.get("summary") or "", contents):
        text = text_from_html(markup)
        if text and text != title:
            return shorten(text)
    return None


def merge_existing(existing, entry, link, title, feed_url, feed_name):
    """Fill missing fields on a known item and count extra feeds that carry it."""
    if "type" not in existing:
        existing["type"] = detect_type(entry, link, feed_url)
    if "thumb" not in existing:
        existing["thumb"] = extract_thumb(entry, link)
    if "excerpt" not in existing:
        existing["excerpt"] = extract_excerpt(entry, title)
    also_in = existing.setdefault("also_in", [])
    if feed_name != existing["source"] and feed_name not in also_in:
        also_in.append(feed_name)
    existing["mentions"] = 1 + len(also_in)


class MetaParser(HTMLParser):
    """Collect meta tags from a page so the preview image and description can be read."""

    def __init__(self):
        super().__init__()
        self.found = {}

    def handle_starttag(self, tag, attrs):
        """Store each meta tag's content under its property or name."""
        if tag != "meta":
            return
        values = {key.lower(): (value or "") for key, value in attrs if key}
        name = (values.get("property") or values.get("name") or "").lower()
        content = values.get("content", "").strip()
        if content and name not in self.found:
            self.found[name] = content

    @property
    def image(self):
        """Return the best preview image url found, or None."""
        for name in ("og:image", "og:image:url", "twitter:image", "twitter:image:src"):
            if self.found.get(name):
                return self.found[name]
        return None

    @property
    def description(self):
        """Return the best page description found, or None."""
        for name in ("og:description", "twitter:description", "description"):
            if self.found.get(name):
                return self.found[name]
        return None


def fetch_page_meta(item):
    """Fetch one page and return its preview image and description."""
    result = {"id": item["id"], "image": None, "description": None, "error": None}
    try:
        response = requests.get(item["link"], headers=PAGE_HEADERS, timeout=OG_TIMEOUT, stream=True)
        response.raise_for_status()
        if "html" not in response.headers.get("content-type", "").lower():
            raise ValueError("not html")
        raw = b""
        for chunk in response.iter_content(16384):
            raw += chunk
            if len(raw) >= OG_MAX_BYTES:
                break
        response.close()
        parser = MetaParser()
        parser.feed(raw.decode("utf-8", errors="replace"))
        if parser.image:
            result["image"] = clean_url(urljoin(response.url, parser.image))
        if parser.description:
            result["description"] = shorten(re.sub(r"\s+", " ", parser.description).strip())
    except Exception as error:  # a failing page must never stop the run
        result["error"] = str(error)[:200]
    return result


def add_page_previews(kept):
    """Fetch preview data for a capped batch of the newest items that lack a thumbnail."""
    candidates = [
        item for item in kept
        if not item.get("thumb") and not item.get("og_tried") and item.get("link")
    ]
    candidates.sort(key=lambda item: item["published"], reverse=True)
    batch = candidates[:OG_CAP]
    by_id = {item["id"]: item for item in batch}
    found = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=OG_WORKERS) as pool:
        results = list(pool.map(fetch_page_meta, batch))
    for result in results:
        item = by_id[result["id"]]
        item["og_tried"] = True
        if result["error"]:
            failed += 1
        if result["image"]:
            item["thumb"] = result["image"]
            found += 1
        if result["description"] and not item.get("excerpt"):
            item["excerpt"] = result["description"]
    return {"attempted": len(batch), "found": found, "failed": failed,
            "remaining": len(candidates) - len(batch)}


def main():
    """Run one fetch pass."""
    now = datetime.now(timezone.utc)
    with open("feeds.yml", encoding="utf-8") as handle:
        feeds = yaml.safe_load(handle) or []

    items = {item["id"]: item for item in load_json(ITEMS_PATH, {}).get("items", [])}
    old_status = load_json(STATUS_PATH, {}).get("feeds", {})
    status = {}

    for feed in feeds:
        url = feed.get("url") or ""
        name = feed.get("name") or url
        last_success = old_status.get(name, {}).get("last_success")

        if feed.get("type") != "rss":
            status[name] = {"status": "skipped", "reason": "type is " + str(feed.get("type")),
                            "last_success": last_success}
            continue
        if "{" in url:
            status[name] = {"status": "skipped", "reason": "url has a placeholder",
                            "last_success": last_success}
            continue

        try:
            response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
            response.raise_for_status()
            parsed = feedparser.parse(response.content)
            if not parsed.entries:
                raise ValueError("no entries parsed")
            seen = 0
            new = 0
            for entry in parsed.entries[:PER_FEED]:
                link = (entry.get("link") or "").strip()
                title = re.sub(r"\s+", " ", entry.get("title") or "").strip() or link
                if not title:
                    continue
                seen += 1
                item_id = make_id(entry, link, name)
                if item_id in items:
                    merge_existing(items[item_id], entry, link, title, url, name)
                    continue
                items[item_id] = {
                    "id": item_id,
                    "title": title,
                    "link": link,
                    "domain": get_domain(link),
                    "source": name,
                    "label": feed.get("label") or "",
                    "published": iso(get_published(entry, now)),
                    "first_seen": iso(now),
                    "native_tags": get_tags(entry),
                    "container": None,
                    "score": None,
                    "comment_link": entry.get("comments") or None,
                    "type": detect_type(entry, link, url),
                    "thumb": extract_thumb(entry, link),
                    "excerpt": extract_excerpt(entry, title),
                    "mentions": 1,
                    "also_in": [],
                }
                new += 1
            status[name] = {"status": "ok", "items": seen, "new": new, "last_success": iso(now)}
            print("OK", name, seen, "items,", new, "new")
        except Exception as error:  # one failing feed must never stop the run
            status[name] = {"status": "failed", "error": str(error)[:200],
                            "last_success": last_success}
            print("FAILED", name, error)

    cutoff = now - timedelta(days=KEEP_DAYS)
    kept = [item for item in items.values() if parse_iso(item["first_seen"]) >= cutoff]
    kept.sort(key=lambda item: item["published"], reverse=True)
    kept = kept[:MAX_ITEMS]

    previews = add_page_previews(kept)
    print("Previews:", previews)

    for name, entry_status in status.items():
        if entry_status["status"] == "skipped":
            continue
        mine = [item for item in kept if item["source"] == name]
        entry_status["stored"] = len(mine)
        entry_status["with_thumb"] = sum(1 for item in mine if item.get("thumb"))

    os.makedirs("data", exist_ok=True)
    with open(ITEMS_PATH, "w", encoding="utf-8") as handle:
        json.dump({"updated": iso(now), "items": kept}, handle, ensure_ascii=False,
                  separators=(",", ":"))
    with open(STATUS_PATH, "w", encoding="utf-8") as handle:
        json.dump({"updated": iso(now), "previews": previews, "feeds": status}, handle,
                  ensure_ascii=False, indent=2)
    print("Wrote", len(kept), "items")


if __name__ == "__main__":
    main()