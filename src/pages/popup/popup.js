// Markdown Vault — Popup Script

'use strict';

// ─── IndexedDB Helper (for re-granting folder access inline) ──────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('markdown-vault', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function sendMsg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

function timeAgo(isoString) {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function timeUntil(msTimestamp) {
  if (!msTimestamp) return '—';
  const diff = msTimestamp - Date.now();
  if (diff <= 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.floor(secs / 60)}m`;
  return `in ${Math.floor(secs / 3600)}h`;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function showScreen(id) {
  ['setup-needed', 'permission-needed', 'main'].forEach(s => {
    const el = $(s);
    el.classList.toggle('hidden', s !== id);
  });
}

function renderState(state) {
  if (!state.setup_complete) {
    showScreen('setup-needed');
    return;
  }

  if (state.fs_permission_needed) {
    showScreen('permission-needed');
    // Set description based on why folder access is needed
    const desc = $('folder-access-desc');
    if (state.folder_status === 'missing') {
      desc.textContent = 'Your save folder was deleted. Click below to select a new folder — no other settings need to change.';
    } else {
      desc.textContent = 'Chrome revoked folder access (common after a browser restart). Click below to re-select your folder — no other settings need to change.';
    }
    // Auto-trigger the folder picker on the first render — the popup was opened
    // by a user click so we have user activation without requiring an extra button click.
    if (!autoRegrantAttempted) {
      autoRegrantAttempted = true;
      regrantFolderAccess();
    }
    return;
  }

  showScreen('main');

  // Bot name + status dot
  $('bot-name').textContent = state.bot_username ? `@${state.bot_username}` : 'Connected';
  const dot = $('status-dot');
  dot.className = 'status-dot';
  if (!state.is_polling_active) {
    dot.classList.add('grey');
  } else if (state.last_telegram_error) {
    dot.classList.add('red');
  } else if (state.last_successful_poll) {
    dot.classList.add('green');
  } else {
    dot.classList.add('grey');
  }

  // Last poll time (auto-refresh every 10s)
  $('last-poll').textContent = timeAgo(state.last_successful_poll);
  $('next-poll').textContent = state.is_polling_active === false ? 'Stopped' : timeUntil(state.next_poll_time);

  // Pending retries
  $('pending-count').textContent = (state.pending_retries || []).length;

  // Telegram error
  const errBanner = $('error-banner');
  if (state.last_telegram_error) {
    errBanner.classList.remove('hidden');
    $('error-text').textContent = `Telegram error: ${state.last_telegram_error}`;
  } else {
    errBanner.classList.add('hidden');
  }

  // Toggle polling button
  const toggleBtn = $('toggle-polling');
  if (state.is_polling_active === false) {
    toggleBtn.textContent = '▶ Start';
    toggleBtn.className = 'btn btn-sm btn-start';
  } else {
    toggleBtn.textContent = '■ Stop';
    toggleBtn.className = 'btn btn-sm btn-stop';
  }

  // Active interval
  const interval = state.poll_interval || 300;
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.seconds) === interval);
  });

  // Recent saves
  renderRecentSaves(state.recent_saves || []);

}

function renderRecentSaves(saves) {
  const list = $('recent-saves-list');
  if (!saves.length) {
    list.innerHTML = '<div class="empty-state">No saves yet</div>';
    return;
  }

  list.innerHTML = saves.slice(0, 5).map(s => `
    <div class="save-item">
      <div class="save-title" title="${esc(s.title || s.filename)}">${esc(s.title || s.filename)}</div>
      <div class="save-meta">
        <span>${esc(s.filename)}</span>
        <span>${timeAgo(s.saved_at)}</span>
      </div>
    </div>
  `).join('');
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Folder Re-grant ──────────────────────────────────────────────────────────
// Tracks whether we already auto-triggered the picker in this popup session.
let autoRegrantAttempted = false;

async function regrantFolderAccess() {
  const btn = $('regrant-permission');
  btn.disabled = true;
  btn.textContent = 'Selecting folder…';
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const testFh = await dirHandle.getFileHandle('.markdown-vault-test', { create: true });
    const w = await testFh.createWritable();
    await w.write('test');
    await w.close();
    await dirHandle.removeEntry('.markdown-vault-test').catch(() => {});
    await idbSet('save_dir_handle', dirHandle);
    await sendMsg('fs_permission_granted');
    await refresh();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Re-grant Folder Access';
    if (e.name !== 'AbortError') {
      alert(`Could not open folder: ${e.message}`);
    }
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const state = await sendMsg('get_state');
    renderState(state);
  } catch (e) {
    console.error('Popup refresh error:', e);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await refresh();

  // Auto-refresh last-poll time every 10s
  setInterval(() => {
    refresh();
  }, 10_000);

  // Setup screen: open onboarding
  $('open-onboarding').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding/onboarding.html') });
    window.close();
  });

  // Permission screen: re-grant folder access (also auto-triggered on popup open via renderState).
  $('regrant-permission').addEventListener('click', () => regrantFolderAccess());

  // Settings link
  $('open-settings').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings/settings.html') });
    window.close();
  });

  // Refresh now
  $('refresh-now').addEventListener('click', async () => {
    const btn = $('refresh-now');
    btn.disabled = true;
    btn.textContent = '↻ Polling…';
    try {
      await sendMsg('poll_now');
      await refresh();
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Refresh Now';
    }
  });

  // Stop / Start toggle
  $('toggle-polling').addEventListener('click', async () => {
    const { is_polling_active } = await sendMsg('get_state');
    if (is_polling_active === false) {
      await sendMsg('start_polling');
    } else {
      await sendMsg('stop_polling');
    }
    await refresh();
  });

  // Interval buttons
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const seconds = parseInt(btn.dataset.seconds);
      await sendMsg('set_interval', { intervalSeconds: seconds });
      await refresh();
    });
  });

  // Paste URL zone
  const pasteZone = $('paste-zone');
  const pasteLabel = $('paste-label');

  function setPasteState(state, msg) {
    pasteZone.className = 'paste-zone' + (state ? ` ${state}` : '');
    pasteLabel.textContent = msg;
  }

  const IDLE_LABEL = 'Paste a URL, image, or text to save it';

  const normalizeURL = t => /^https?:\/\//i.test(t) ? t : (/^(?:www\.)?(?:x|twitter)\.com\//i.test(t) ? 'https://' + t : t);
  const isHttpUrl = t => /^https?:\/\/[^\s]+$/i.test(t);

  function extractUrlsFromPastedText(text) {
    return text
      .split(/[\s,]+/)
      .map(token => normalizeURL(token.trim()))
      .filter(token => isHttpUrl(token));
  }

  async function handlePastedURL(url) {
    setPasteState('saving', 'Saving…');
    try {
      await sendMsg('save_url', { url });
      setPasteState('saving', 'Saved!');
      await refresh();
    } catch (e) {
      setPasteState('error', `Error: ${e.message}`);
    } finally {
      setTimeout(() => setPasteState('', IDLE_LABEL), 2500);
    }
  }

  async function handlePastedImage(dataUrl, mimeType) {
    setPasteState('saving', 'Saving image…');
    try {
      await sendMsg('save_clipboard_image', { dataUrl, mimeType });
      setPasteState('saving', 'Image saved!');
      await refresh();
    } catch (e) {
      setPasteState('error', `Error: ${e.message}`);
    } finally {
      setTimeout(() => setPasteState('', IDLE_LABEL), 2500);
    }
  }

  async function handlePastedText(text) {
    setPasteState('saving', 'Saving text…');
    try {
      await sendMsg('save_clipboard_text', { text });
      setPasteState('saving', 'Text saved!');
      await refresh();
    } catch (e) {
      setPasteState('error', `Error: ${e.message}`);
    } finally {
      setTimeout(() => setPasteState('', IDLE_LABEL), 2500);
    }
  }

  function onPaste(e) {
    // 1. Clipboard image (screenshot, copied image)
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = async () => handlePastedImage(reader.result, item.type);
        reader.readAsDataURL(file);
        return;
      }
    }

    // 2. Text: URLs or plain text
    const text = e.clipboardData.getData('text').trim();
    const urls = extractUrlsFromPastedText(text);
    if (urls.length > 0) {
      e.preventDefault();
      urls.reduce((chain, url) => chain.then(() => handlePastedURL(url)), Promise.resolve());
    } else if (text.length > 0) {
      e.preventDefault();
      handlePastedText(text);
    }
  }

  pasteZone.addEventListener('paste', onPaste);
  // Also catch paste anywhere in the popup when the main screen is visible,
  // but skip if the event already fired on pasteZone (prevents double-save).
  document.addEventListener('paste', e => {
    if (!$('main').classList.contains('hidden') && e.target !== pasteZone) onPaste(e);
  });
});
