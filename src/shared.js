// Markdown Vault — Shared Utilities
// Common functions used by background.js and handler modules.
// Kept in a separate file so the service worker's cold-start footprint stays small.

// ─── IndexedDB (for FileSystemDirectoryHandle) ────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('markdown-vault', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

export async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror = e => reject(e.target.error);
  });
}

// ─── Chrome Storage Helpers ───────────────────────────────────────────────────
export async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

export async function setStorage(obj) {
  return chrome.storage.local.set(obj);
}

// ─── Text Utilities ──────────────────────────────────────────────────────────
export function slugify(text, maxLen = 60) {
  return (text || 'untitled')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'untitled';
}

export function dateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function sanitizeTitle(title) {
  return (title || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildFilename(title, date) {
  return `${date || dateString()}-${slugify(title)}.md`;
}

export function escapeMarkdownHeading(text) {
  return (text || '').replace(/([\\`*_{}[\]()#+\-.!|~>])/g, '\\$&');
}

export function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') {
      const escaped = v
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '');
      lines.push(`${k}: "${escaped}"`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

export function buildArticleMarkdown({ title, url, savedAt, markdown, includeFrontmatter }) {
  const cleanTitle = sanitizeTitle(title);
  const fm = includeFrontmatter
    ? buildFrontmatter({ title: cleanTitle, url, saved_at: savedAt, source: 'markdown-vault' })
    : '';
  return `${fm}# ${escapeMarkdownHeading(cleanTitle)}\n\n${markdown}\n`;
}

export function buildErrorMarkdown({ url, error, savedAt, includeFrontmatter }) {
  const fm = includeFrontmatter
    ? buildFrontmatter({ url, saved_at: savedAt, source: 'markdown-vault', status: 'error' })
    : '';
  return `${fm}# Save Error\n\nFailed to save: ${url}\n\n**Error:** ${error}\n\n**Time:** ${savedAt}\n`;
}

// ─── File System ──────────────────────────────────────────────────────────────

// Badge callback — set by background.js at startup to avoid circular imports
let _updateBadge = null;
export function setUpdateBadge(fn) { _updateBadge = fn; }

export async function getDirHandle() {
  const handle = await idbGet('save_dir_handle');
  if (!handle) return null;

  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    await setStorage({ fs_permission_needed: true, folder_status: 'permission_needed' });
    if (_updateBadge) await _updateBadge();
    return null;
  }

  try {
    const iter = handle.values();
    await iter.next();
  } catch (e) {
    if (e.name === 'NotFoundError') {
      await setStorage({ fs_permission_needed: true, folder_status: 'missing' });
      if (_updateBadge) await _updateBadge();
      chrome.notifications.create({
        type: 'basic', iconUrl: 'docs/icon_64.png',
        title: 'Markdown Vault — Save Folder Missing',
        message: 'Your save folder no longer exists. Open Settings and select a new folder.',
      });
      return null;
    }
    throw e;
  }

  await setStorage({ fs_permission_needed: false, folder_status: 'ok' });
  return handle;
}

export async function getUniqueFileHandle(dirHandle, filename) {
  const ext = filename.endsWith('.md') ? '.md' : '';
  const base = ext ? filename.slice(0, -3) : filename;

  try {
    await dirHandle.getFileHandle(filename, { create: false });
    for (let i = 2; i <= 99; i++) {
      const candidate = `${base}-${i}${ext}`;
      try {
        await dirHandle.getFileHandle(candidate, { create: false });
      } catch {
        return dirHandle.getFileHandle(candidate, { create: true });
      }
    }
  } catch {
    return dirHandle.getFileHandle(filename, { create: true });
  }
}

export async function writeFile(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function readFile(fileHandle) {
  const file = await fileHandle.getFile();
  return file.text();
}

export async function saveMarkdownFile(dirHandle, filename, content) {
  const fileHandle = await getUniqueFileHandle(dirHandle, filename);
  await writeFile(fileHandle, content);
  return fileHandle.name;
}

export async function appendToDaily(dirHandle, content, date) {
  const filename = `${date}.md`;
  let existing = '';

  try {
    const fh = await dirHandle.getFileHandle(filename, { create: false });
    existing = await readFile(fh);
  } catch {
    // File doesn't exist yet
  }

  const separator = existing ? '\n\n---\n\n' : '';
  const newContent = existing + separator + content;

  const fh = await dirHandle.getFileHandle(filename, { create: true });
  await writeFile(fh, newContent);
}

export async function saveImageToFolder(dirHandle, date, filename, arrayBuffer) {
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
  return `${date}/${filename}`;
}

export async function downloadImagesToFolder(dirHandle, folderName, imageUrls) {
  let subDir;
  try {
    subDir = await dirHandle.getDirectoryHandle(folderName, { create: true });
  } catch {
    console.warn('[markdown-vault] Cannot create image folder:', folderName);
    return imageUrls.map(() => null);
  }

  const paths = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const remoteUrl = imageUrls[i];
    try {
      const resp = await fetch(remoteUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();

      let ext = 'jpg';
      const imgContentType = (resp.headers.get('content-type') || '').split(';')[0].trim();
      if (imgContentType.startsWith('image/')) {
        const ctExt = imgContentType.split('/')[1];
        if (ctExt === 'jpeg') ext = 'jpg';
        else if (ctExt === 'svg+xml') ext = 'svg';
        else if (ctExt) ext = ctExt;
      } else {
        try {
          const urlPath = new URL(remoteUrl).pathname;
          const parts = urlPath.split('.');
          if (parts.length > 1) ext = parts.pop().split('?')[0].toLowerCase() || 'jpg';
        } catch { /* use default */ }
      }

      const imgFilename = `${String(i + 1).padStart(2, '0')}.${ext}`;
      const fh = await subDir.getFileHandle(imgFilename, { create: true });
      const writable = await fh.createWritable();
      await writable.write(buffer);
      await writable.close();
      paths.push(imgFilename);
    } catch (err) {
      console.warn(`[markdown-vault] Failed to download image ${i + 1} (${remoteUrl}):`, err);
      paths.push(null);
    }
  }
  return paths;
}
