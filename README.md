# Markdown Vault — Chrome Extension

Chrome Extension (MV3). Polls a Telegram bot for incoming messages and saves URLs as local Markdown files via the File System Access API. Zero backend, no build step.

## How It Works

```
Phone/any device → send URL to your Telegram bot
  → Chrome extension polls Telegram every N minutes (chrome.alarms)
  → fetches URL → Readability extraction → Markdown
  → saves .md file to local folder (File System Access API)
  → desktop notification
```

Non-URL Telegram messages are appended to a daily `YYYY-MM-DD.md` file. Images from Telegram are downloaded to a `YYYY-MM-DD/` subfolder and referenced in the daily file.

## File Structure

```
/
├── background.js           # Service worker. Core logic: polling, URL processing, message handling.
├── content-router.js       # classifyUrl(url, contentType) → type string
├── metadata.js             # extractMetadata(html, url) → og:/JSON-LD (regex, no DOM)
├── vtt-parser.js           # parseVttText(), parseJsonTranscriptText()
├── youtube-handler.js      # handleYouTube(url, dirHandle, settings)
├── media-handler.js        # handlePdf(), handleDirectMedia(), handleDirectImage()
├── rss-handler.js          # handleRss(url, dirHandle, settings, xmlText?)
├── podcast-handler.js      # handlePodcast(url, html, dirHandle, settings)
├── manifest.json           # MV3. No "type: module". Classic service worker.
├── libs/
│   ├── Readability.js      # Mozilla Readability 0.5.0 (bundled)
│   ├── turndown.js         # Turndown 7.2.0 (bundled)
│   └── turndown-plugin-gfm.js
└── pages/
    ├── offscreen/
    │   ├── offscreen.html
    │   └── offscreen.js    # DOMParser context. Handles parse_html, convert_html, parse_rss messages.
    ├── popup/
    │   ├── popup.html
    │   ├── popup.js
    │   └── popup.css
    ├── settings/
    │   ├── settings.html
    │   ├── settings.js
    │   └── settings.css
    └── onboarding/
        ├── onboarding.html
        └── onboarding.js
```

## Setup (no build step)

1. Open `chrome://extensions`, enable Developer mode
2. Click "Load unpacked" → select this folder
3. Click the extension icon → "Start Setup" → paste Telegram bot token → choose save folder

## Key Files

### background.js
Main service worker. Loads all handler modules via `importScripts()` at startup (classic SW, not ESM).

**Key functions:**
- `poll()` — calls Telegram `getUpdates`, dispatches each update via `processUpdate()`
- `processUpdate(update, token, settings)` — routes by message type (URL, photo, document, text)
- `processURLWithRetry(url, attemptIndex, messageCtx, settings)` — full URL processing pipeline
- `fetchURL(url)` → `{ html, finalUrl, binaryData, contentType, contentDisposition }`
- `fetchWithBackgroundTab(url)` — injects Readability into a live tab for JS-rendered pages
- `getDirHandle()` — returns FileSystemDirectoryHandle from IndexedDB, checks permissions
- `saveMarkdownFile(dirHandle, filename, content)` — deduplicates filenames with `-2`, `-3` etc.
- `appendToDaily(dirHandle, content, date)` — appends to YYYY-MM-DD.md
- `saveImageToFolder(dirHandle, date, filename, arrayBuffer)` — saves to date subfolder
- `setupContextMenu()` — creates/removes context menu based on `context_menu_enabled` setting
- `buildFrontmatter(fields)`, `buildFilename(title, pattern, date)`, `slugify(text, maxLen)`

**URL processing flow in `processURLWithRetry`:**
1. Pre-fetch: `classifyUrl(url)` → if `youtube`, call `handleYouTube()` and return
2. `fetchURL(url)` → returns HTML or binary
3. Post-fetch: `classifyUrl(effectiveUrl, contentType)` routes:
   - `rss` → `handleRss()`
   - `pdf` → `handlePdf()`
   - `direct-audio/video` → `handleDirectMedia()`
   - `direct-image` → `handleDirectImage()`
   - `podcast` → `handlePodcast()`
   - unknown binary → save to `YYYY-MM-DD/` subfolder + companion `.md` with metadata
4. HTML: `parseHtmlViaOffscreen()` → Readability + Turndown
5. If content < 500 chars: `fetchWithBackgroundTab()` fallback (injects Readability into live DOM; if Readability returns null, tries common CSS selectors: `main article`, `article`, `[role="main"]`, etc.)

### offscreen.js
Handles `parse_html` (Readability + Turndown), `convert_html` (Turndown only), `parse_rss` (DOMParser for RSS/Atom XML).

### content-router.js
`classifyUrl(url, contentType?)` returns: `'youtube' | 'rss' | 'pdf' | 'direct-audio' | 'direct-video' | 'direct-image' | 'podcast' | 'html'`

## Storage Keys (`chrome.storage.local`)

| Key | Type | Description |
|-----|------|-------------|
| `bot_token` | string | Telegram bot token |
| `bot_username` | string | Bot @username |
| `setup_complete` | boolean | Onboarding done |
| `last_update_id` | number | Telegram offset (dedup) |
| `last_successful_poll` | ISO string | Last successful Telegram API call |
| `pending_retries` | array | `{ url, attempt, next_retry_at, messageCtx }` |
| `connection_warnings` | array | Disconnect events `{ id, start, end, duration, acknowledged }` |
| `recent_saves` | array | Last 20 saves `{ title, filename, url, saved_at }` |
| `is_polling_active` | boolean | Whether alarm is running |
| `poll_interval` | number | Seconds between polls (default: 300) |
| `include_frontmatter` | boolean | YAML header in .md files |
| `use_gfm` | boolean | GitHub-Flavored Markdown |
| `file_naming_pattern` | string | `'YYYY-MM-DD-slug'` (default), `'slug-YYYY-MM-DD'`, `'slug'` |
| `has_disconnect_warning` | boolean | Unacknowledged disconnect exists |
| `fs_permission_needed` | boolean | Folder permission revoked |
| `folder_status` | string | `'ok'` \| `'missing'` \| `'permission_needed'` \| `'unknown'` |
| `last_telegram_error` | string \| null | Last Telegram API error |
| `context_menu_enabled` | boolean | Right-click "Save to Markdown Vault" menu item |

## IndexedDB

Key: `save_dir_handle` — stores the `FileSystemDirectoryHandle` (can't be stored in chrome.storage).

## Message Types (popup/settings → background)

| Type | Payload | Response |
|------|---------|----------|
| `get_state` | — | Full state object (no raw token; includes `next_poll_time`) |
| `poll_now` | — | `{ success }` |
| `save_url` | `{ url }` | `{ success }` |
| `save_settings` | `{ settings }` | `{ success }` |
| `start_polling` | — | `{ success }` |
| `stop_polling` | — | `{ success }` |
| `set_interval` | `{ intervalSeconds }` | `{ success }` |
| `fs_permission_granted` | — | `{ success }` |
| `verify_token` | `{ token }` | `{ success, username }` or `{ success: false, error }` |
| `dismiss_warning` | `{ warningId }` | `{ success }` |
| `clear_history` | — | `{ success }` |

## Permissions

```json
["alarms", "storage", "notifications", "tabs", "scripting", "offscreen", "contextMenus"]
+ host_permissions: ["<all_urls>"]
```

## File Naming

Default: `YYYY-MM-DD-slug.md`
Binary files (PDF, audio, video, unknown): saved to `YYYY-MM-DD/<filename>` + companion `.md` metadata file at root.
Telegram images: `YYYY-MM-DD/<date>-<timestamp>.<ext>` in the date subfolder.

## Retry Logic

- Up to 3 retries: 30s → 120s → 300s delays
- 401/403/404: immediate failure, saves error `.md`
- State survives service worker restarts (stored in chrome.storage)

## Context Menu

Right-click "Save to Markdown Vault" on pages/links. Toggleable via Settings. Recreated on `onInstalled` and `onStartup`.

## Dependencies (bundled, no npm)

- Mozilla Readability.js 0.5.0
- Turndown 7.2.0
- turndown-plugin-gfm 1.0.2
