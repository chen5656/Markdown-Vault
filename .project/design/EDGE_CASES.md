# Markdown Vault — Edge Cases

Only items with dedicated code or meaningful design decisions. Generic try/catch coverage and "by design" notes are not listed.

---

## Critical — Prevents data loss or breakage

- **Folder deleted while running** — `getDirHandle()` checks `NotFoundError`, shows notification, sets badge.
- **Bot token revoked (401)** — `telegramCall()` detects HTTP 401, throws non-retryable error with clear message.
- **Rate limiting (429)** — `telegramCall()` reads `Retry-After` header, marks error as retryable.
- **Duplicate messages on crash** — `last_update_id` saved after *each* message, not after the batch.
- **Large page (5MB cap)** — `fetchURL()` truncates text responses to `MAX_PAGE_SIZE` (5MB).
- **Poll mutex** — `_pollLock` boolean prevents concurrent `poll()` executions.
- **Service worker state** — All persistent state in `chrome.storage.local` / IndexedDB. No global variables hold state across wake cycles.
- **YAML injection in frontmatter** — `buildFrontmatter()` escapes `\`, `"`, `\n`, `\r` in string values.
- **Retry bounds** — Max 3 retries with exponential backoff `[30s, 120s, 300s]`, then error `.md` saved.
- **Retry classification** — `retryable` flag on errors: 5xx/timeout/network = retry; 401/403/404/redirect loops = no retry.

## Important — Real value with dedicated code

- **Long filenames** — `slugify()` caps at 60 chars. Total filename stays well under 255-byte OS limit.
- **CJK/unicode filenames** — `slugify()` uses `\p{L}\p{N}` (unicode-aware), preserves non-Latin characters.
- **Unsupported Telegram message types** — Stickers, voice, video notes, etc. logged to daily file with type label.
- **Telegram file size >20MB** — Checked before download in both image and document handlers; logs warning instead.
- **Non-HTML content routing** — `fetchURL()` checks `Content-Type`; binary content (PDF, image, audio, video) routed to appropriate handler.
- **Redirect loops not retryable** — Redirect errors marked `retryable: false` to avoid wasting retry budget.
- **Markdown special chars in heading** — `escapeMarkdownHeading()` escapes 19 characters that could break formatting.
- **Newlines in title** — `sanitizeTitle()` strips `\r\n`, collapses whitespace.
- **XSS in popup** — `esc()` escapes `&`, `<`, `>`, `"` for all dynamic content inserted via `innerHTML`.
- **Path traversal** — `slugify()` strips all non-letter/number chars. File System Access API confines writes to selected directory.
- **Duplicate filenames** — `getUniqueFileHandle()` tries `-2` through `-99` suffix variants.
- **Empty content** — `!parsed.content.trim()` check prevents saving blank markdown files.
- **Image extension from Content-Type** — `downloadImagesToFolder()` uses response header, not URL path, for file extension.
- **Telegram update filtering** — `allowed_updates: ['message']` set server-side to skip edits, channel posts, etc.
- **Offscreen document lifecycle** — `ensureOffscreen()` recreates if closed; 30s timeout catches mid-parse failures.
- **XHS video detection** — Returns `hasVideo` flag; markdown includes note about unsaved video content.
