// Markdown Vault — Telegram API + Polling
// Dynamically imported — only loaded when poll() or verify_token is called.

import {
  getStorage, setStorage, getDirHandle, dateString, appendToDaily, saveImageToFolder,
} from './shared.js';

const TELEGRAM_BASE = 'https://api.telegram.org/bot';

// ─── Telegram API ─────────────────────────────────────────────────────────────
async function telegramCall(token, method, params = {}) {
  const resp = await fetch(`${TELEGRAM_BASE}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (resp.status === 401) {
    const err = new Error('Bot token is invalid or revoked. Update your token in Settings.');
    err.retryable = false;
    throw err;
  }
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
    const err = new Error(`Telegram rate limit — retry after ${retryAfter}s`);
    err.retryable = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} calling Telegram ${method}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(`Telegram error: ${data.description}`);
  return data.result;
}

export async function getMe(token) {
  return telegramCall(token, 'getMe');
}

async function getUpdates(token, offset) {
  return telegramCall(token, 'getUpdates', {
    offset,
    timeout: 0,
    allowed_updates: ['message'],
  });
}

async function getTelegramFileInfo(token, fileId) {
  return telegramCall(token, 'getFile', { file_id: fileId });
}

// ─── URL Detection ────────────────────────────────────────────────────────────
function extractURLsFromMessage(message) {
  const text = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  const urls = [];

  for (const entity of entities) {
    if (entity.type === 'url') {
      urls.push(text.slice(entity.offset, entity.offset + entity.length));
    } else if (entity.type === 'text_link') {
      urls.push(entity.url);
    }
  }

  if (urls.length === 0) {
    const matches = text.match(/https?:\/\/[^\s<>"]+/g) || [];
    urls.push(...matches);
  }

  return [...new Set(urls)];
}

// ─── Text Message Processing ──────────────────────────────────────────────────
async function processTextMessage(text, date, dirHandle) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const entry = `**${timestamp}** — ${text}`;
  await appendToDaily(dirHandle, entry, date);
}

// ─── Image Message Processing ─────────────────────────────────────────────────
async function processImageMessage(message, token, date, dirHandle) {
  try {
    const photos = message.photo || [];
    const doc = message.document;
    let fileId, rawFilename;

    if (doc && doc.mime_type?.startsWith('image/')) {
      fileId = doc.file_id;
      rawFilename = doc.file_name || null;
    } else if (photos.length > 0) {
      const largest = photos.reduce((a, b) => ((a.file_size || 0) > (b.file_size || 0) ? a : b));
      fileId = largest.file_id;
    }

    if (!fileId) {
      const caption = message.caption || '';
      if (caption) {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        await appendToDaily(dirHandle, `**${timestamp}** — ${caption}`, date);
        return;
      }
      return;
    }

    const fileInfo = await getTelegramFileInfo(token, fileId);
    const filePath = fileInfo.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

    const resp = await fetch(downloadUrl);
    if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
    const arrayBuffer = await resp.arrayBuffer();

    let ext = 'jpg';
    if (rawFilename) {
      const dot = rawFilename.lastIndexOf('.');
      if (dot >= 0) ext = rawFilename.slice(dot + 1).toLowerCase();
    } else if (filePath) {
      const dot = filePath.lastIndexOf('.');
      if (dot >= 0) ext = filePath.slice(dot + 1).toLowerCase();
    }

    const imgFilename = rawFilename || `${Date.now()}.${ext}`;
    const savedPath = await saveImageToFolder(dirHandle, date, imgFilename, arrayBuffer);

    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const caption = message.caption ? `\n${message.caption}` : '';
    await appendToDaily(dirHandle, `**${timestamp}** — Telegram image${caption}\n\n![Image](./${savedPath})`, date);
  } catch (err) {
    console.error('[markdown-vault] Image processing error:', err);
    const entry = `*Failed to save image: ${err.message}*`;
    await appendToDaily(dirHandle, entry, date);
  }
}

// ─── Document Message Processing ──────────────────────────────────────────────
async function processDocumentMessage(message, token, date, dirHandle) {
  try {
    const doc = message.document;
    if (!doc) return;

    const fileInfo = await getTelegramFileInfo(token, doc.file_id);
    const filePath = fileInfo.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

    const resp = await fetch(downloadUrl);
    if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
    const arrayBuffer = await resp.arrayBuffer();

    const filename = doc.file_name || `${Date.now()}-document`;
    let dayDir;
    try {
      dayDir = await dirHandle.getDirectoryHandle(date, { create: true });
    } catch {
      dayDir = dirHandle;
    }

    const fh = await dayDir.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(arrayBuffer);
    await writable.close();

    const savedPath = `${date}/${filename}`;
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const caption = message.caption ? `\n${message.caption}` : '';
    await appendToDaily(dirHandle, `**${timestamp}** — Document: \`./${savedPath}\`${caption}`, date);
  } catch (err) {
    console.error('[markdown-vault] Document processing error:', err);
    const entry = `*Failed to save document: ${err.message}*`;
    await appendToDaily(dirHandle, entry, date);
  }
}

// ─── Main Message Dispatcher ──────────────────────────────────────────────────
async function processUpdate(update, token, settings) {
  const message = update.message;
  if (!message) return;

  const urls = extractURLsFromMessage(message);
  if (urls.length > 0) {
    const { processURLWithRetry } = await import('./url-processor.js');
    for (const url of urls) {
      await processURLWithRetry(url, 0, settings);
    }
    return;
  }

  const dirHandle = await getDirHandle();
  if (!dirHandle) return;

  const date = dateString();

  if (message.photo || message.document?.mime_type?.startsWith('image/')) {
    await processImageMessage(message, token, date, dirHandle);
  } else if (message.document) {
    await processDocumentMessage(message, token, date, dirHandle);
  } else if (message.text || message.caption) {
    await processTextMessage(message.text || message.caption, date, dirHandle);
  } else if (message.sticker || message.voice || message.video_note || message.video || message.audio || message.location || message.contact) {
    const msgType = message.sticker ? 'sticker' : message.voice ? 'voice message' :
      message.video_note ? 'video note' : message.video ? 'video' :
        message.audio ? 'audio' : message.location ? 'location' : 'contact';
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    await appendToDaily(dirHandle, `**${timestamp}** — *Received ${msgType} (not supported for saving)*`, date);
  }
}

// ─── Main Poll ────────────────────────────────────────────────────────────────
let _pollLock = false;

export async function poll(updateBadge) {
  if (_pollLock) return;
  _pollLock = true;
  try {
    const { bot_token, setup_complete, is_polling_active } = await getStorage([
      'bot_token', 'setup_complete', 'is_polling_active',
    ]);

    if (!setup_complete || !bot_token) return;
    if (is_polling_active === false) return;

    const folderHandle = await getDirHandle();
    if (!folderHandle) {
      await updateBadge();
      return;
    }

    let { last_update_id = 0 } = await getStorage(['last_update_id']);

    try {
      const updates = await getUpdates(bot_token, last_update_id);
      const settings = await getStorage([
        'bot_token', 'include_frontmatter', 'use_gfm',
        'poll_interval', 'bot_username',
      ]);

      await setStorage({ last_telegram_error: null });

      if (updates && updates.length > 0) {
        for (const update of updates) {
          await processUpdate(update, bot_token, settings);
          last_update_id = update.update_id + 1;
          await setStorage({ last_update_id });
        }
      }

      await setStorage({ last_successful_poll: new Date().toISOString() });
      await updateBadge();

    } catch (err) {
      console.error('[markdown-vault] Poll error:', err);
      await setStorage({ last_telegram_error: err.message });
      await updateBadge();
    }

    // Process pending retries
    const { processRetries } = await import('./url-processor.js');
    await processRetries();

  } finally { _pollLock = false; }
}
