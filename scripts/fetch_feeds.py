"""Fetch rss feeds listed in feeds.yml and write data/items.json and data/status.json."""

import calendar
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import feedparser
import requests
import yaml

KEEP_DAYS = 14
MAX_ITEMS = 3000
PER_FEED = 100
TIMEOUT = 25
USER_AGENT = "Mozilla/5.0 (compatible; Skim-it feed fetcher)"
ITEMS_PATH = "data/items.json"
STATUS_PATH = "data/status.json"
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
TRACKING_KEYS = {"fbclid", "gclid", "ref", "ref_src"}


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

    os.makedirs("data", exist_ok=True)
    with open(ITEMS_PATH, "w", encoding="utf-8") as handle:
        json.dump({"updated": iso(now), "items": kept}, handle, ensure_ascii=False,
                  separators=(",", ":"))
    with open(STATUS_PATH, "w", encoding="utf-8") as handle:
        json.dump({"updated": iso(now), "feeds": status}, handle, ensure_ascii=False, indent=2)
    print("Wrote", len(kept), "items")


if __name__ == "__main__":
    main()