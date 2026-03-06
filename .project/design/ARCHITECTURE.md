# Markdown Vault — Architecture & Kept Components

What remains after two rounds of simplification, and why each piece earns its place.

---

## Core Files

### `background.js` (~1400 lines)
Service worker. Owns all extension lifecycle, Telegram polling, URL processing, file saving, and retry logic.

**Key functions kept:**

| Function | Why |
|---|---|
| `poll()` | Core loop — fetches Telegram updates, processes each, saves offset |
| `processUpdate()` | Dispatches message by type: URL, image, document, text, unsupported |
| `processURLWithRetry()` | Extraction pipeline with 3-level fallback and retry on transient errors |
| `fetchURL()` | Fetches page HTML with size cap (5 MB), content-type routing |
| `fetchWithBackgroundTab()` | Opens a background tab for JS-rendered pages when Readability fails |
| `telegramCall()` | Telegram API wrapper with 401/429 handling |
| `buildFrontmatter()` / `buildFilename()` / `slugify()` | Markdown file construction |
| `getDirHandle()` / `getUniqueFileHandle()` | File System Access API — directory retrieval and dedup naming |
| `downloadImagesToFolder()` | Downloads inline images to subfolder, rewrites markdown links |
| `classifyUrl()` | Routes URLs to specialized handlers (YouTube, RSS, X, XHS, etc.) |
| `getStorage()` / `setStorage()` | Thin wrappers over `chrome.storage.local` — used everywhere |
| `ensureOffscreen()` | Creates/manages offscreen document for Readability parsing |
| `scheduleAlarm()` / `onAlarm` | Chrome alarms API for periodic polling |
| `extractURLsFromMessage()` | Extracts URLs from Telegram message text and entities |

**Message handlers kept:**

| Handler | Used by |
|---|---|
| `verify_token` | Onboarding + Settings — token verification |
| `save_settings` | Onboarding + Settings — persist config |
| `get_status` | Popup — polling status display |
| `poll_now` | Popup — manual refresh button |
| `toggle_polling` | Popup — start/stop toggle |
| `set_interval` | Popup — interval selector buttons |
| `fs_permission_granted` | Onboarding — notifies SW after folder pick |

### `content-router.js`
`classifyUrl()` function. Routes URLs to specialized extractors based on hostname patterns. Kept because generic Readability fails on SPAs and API-gated content (X, YouTube, XHS).

### `metadata.js`
Extracts page metadata (title, description, author, date, image, language) from meta tags, Open Graph, JSON-LD. Injected into content script context. Needed for frontmatter generation.

### `vtt-parser.js`
Converts WebVTT subtitle format to plain text. Used by YouTube handler for transcript extraction. Small (~50 lines), single-purpose.

---

## Specialized Extractors

### `x-tweet-extractor.js`
Extracts single tweets via X's GraphQL API (`TweetResultByRestId`). Required because X blocks unauthenticated scraping and Readability gets nothing useful.

### `x-article-extractor.js`
Extracts X/Twitter articles (long-form "Notes" feature) by navigating the GraphQL response tree. Different data structure from tweets — needs its own logic.

### `xhs-extractor.js`
Extracts Xiaohongshu (Little Red Book) posts. Content is rendered client-side; DOM extraction via content script is the only viable approach. Detects video posts and flags them.

### `youtube-handler.js`
Extracts YouTube video metadata + transcript from `ytInitialPlayerResponse`. Falls back gracefully when captions unavailable. Readability produces garbage on YouTube pages.

### `media-handler.js`
Handles binary content: PDF, images, audio, video. Downloads file, saves binary + companion `.md` with metadata. Content-type detection determines routing.

### `podcast-handler.js`
Parses podcast RSS feeds, extracts episode list with audio URLs, dates, descriptions. Produces structured markdown with episode table.

### `rss-handler.js`
Parses generic RSS/Atom feeds into markdown with entry list. Distinct from podcast handler — different output format, no audio handling.

---

## Pages

### `popup/` (popup.js, popup.html, popup.css)
Extension popup. Shows polling status, last/next poll times, pending retries, manual refresh, interval selector, paste zone for URLs. Minimal — no history tracking, no disconnect warnings.

### `settings/` (settings.js, settings.html, settings.css)
Full settings page. Bot token, folder selection, poll interval, context menu toggle, frontmatter toggle, GFM toggle, reset. No file naming pattern selector (removed — single format is sufficient).

### `onboarding/` (onboarding.js, onboarding.html, onboarding.css)
3-step wizard: token → folder → done. Stores `FileSystemDirectoryHandle` in IndexedDB (must happen from page context, not service worker).

### `offscreen/` (offscreen.js, offscreen.html)
Offscreen document for Readability + Turndown parsing. Service workers can't access DOM APIs, so HTML-to-markdown conversion happens here.

---

## Libraries (vendored)

| Library | Purpose |
|---|---|
| `Readability.js` | Mozilla's article extraction — core of the generic pipeline |
| `turndown.js` | HTML → Markdown conversion |
| `turndown-plugin-gfm.js` | GFM tables, strikethrough, task lists for Turndown |

---

## Considered for Removal but Kept

| Item | Why kept |
|---|---|
| `context_menu_enabled` toggle | Has full settings UI, wired to `chrome.contextMenus` — functional feature |
| `set_interval` message handler | Used by popup interval buttons — removing breaks UI |
| `getStorage()`/`setStorage()` wrappers | Used 30+ times across codebase — removing adds noise not clarity |
| Duplicate `openDB()`/`idbSet()` in page scripts | IndexedDB must be accessed from page context (not service worker) — can't share |
| `ensureOffscreen()` with 30s timeout | Offscreen docs can silently close; timeout catches parse hangs — real failure mode |
| Site-specific extractors (X, XHS, YouTube) | These sites actively block or break generic extraction — no viable alternative |
| 3-level extraction fallback | Readability → background tab → raw HTML strip. Each level catches real failures the previous misses |
| Retry mechanism with `retryable` classification | Prevents wasting retries on permanent failures (401, 404) while recovering from transient ones (5xx, timeout) |

---

## What Was Removed (Rounds 1 + 2)

- `sanitizeUrlForDisplay()` — unused display function
- `fetchTweetViaOEmbed()` — 77-line dead code path (oEmbed blocked by X)
- `checkAndHandleDisconnect()` + `formatDateTime()` — disconnect detection feature (over-engineered)
- `file_naming_pattern` — settings/UI/logic for filename format selection (one format is enough)
- Connection history tracking — storage, rendering, clear button
- `normalizeURL()`, `isURL()`, `extractTweetId()`, `idbSet()` in background.js — dead code
- `x-article-dom-extractor.js` — weak fallback redundant with Readability
- 10-selector CSS fallback in extraction pipeline — redundant with raw HTML strip
- `request_fs_permission` handler — orphaned after earlier refactor
- `dismiss_warning` / `clear_history` handlers — removed with their features
- Retry in `sendMsg()` (popup/settings/onboarding) — unnecessary for local message passing
