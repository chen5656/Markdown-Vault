// Markdown Vault — Settings Page

'use strict';

// ─── IndexedDB Helper (for folder handle) ─────────────────────────────────────
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

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror = e => reject(e.target.error);
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

function showToast(msg = '✓ Saved') {
  const toast = $('save-toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

function setTokenStatus(msg, type = '') {
  const el = $('token-status');
  el.textContent = msg;
  el.className = `field-status ${type}`;
}

// ─── Load State ───────────────────────────────────────────────────────────────
async function loadSettings() {
  const state = await sendMsg('get_state');

  // Bot token (masked — server never returns raw token)
  if (state.has_token) {
    $('bot-token').placeholder = '••••••••••• (token saved)';
  }

  // Bot username
  const usernameEl = $('bot-username-display');
  if (state.bot_username) {
    usernameEl.textContent = `@${state.bot_username}`;
    usernameEl.classList.remove('muted');
  } else {
    usernameEl.textContent = 'Not connected';
    usernameEl.classList.add('muted');
  }

  // Offset
  $('update-offset').value = state.last_update_id ?? 0;

  // Folder
  const dirHandle = await idbGet('save_dir_handle');
  if (dirHandle) {
    $('current-folder-name').textContent = dirHandle.name;
    $('current-folder-display').classList.remove('hidden');
    // Show folder status icon
    const statusEl = $('folder-status-icon');
    const folderStatus = state.folder_status || 'unknown';
    if (folderStatus === 'ok') {
      statusEl.textContent = '✓';
      statusEl.className = 'folder-status-icon ok';
      statusEl.title = 'Folder is accessible';
    } else if (folderStatus === 'missing') {
      statusEl.textContent = '!';
      statusEl.className = 'folder-status-icon error';
      statusEl.title = 'Folder was deleted — please select a new folder';
    } else {
      statusEl.textContent = '?';
      statusEl.className = 'folder-status-icon warn';
      statusEl.title = 'Folder access needs to be re-granted';
    }
  }

  // Poll interval
  const interval = state.poll_interval ?? 300;
  const radio = document.querySelector(`input[name="interval"][value="${interval}"]`);
  if (radio) radio.checked = true;

  // Toggles
  $('include-frontmatter').checked = state.include_frontmatter !== false;
  $('use-gfm').checked = state.use_gfm !== false;
  $('context-menu-enabled').checked = state.context_menu_enabled !== false;

  // Scroll to #folder anchor if needed
  if (window.location.hash === '#folder') {
    setTimeout(() => {
      const el = document.getElementById('folder');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 300);
  }
}

// ─── Save Settings ────────────────────────────────────────────────────────────
async function saveSettings() {
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const settings = {};

    // Bot token (only save if user entered something)
    const tokenInput = $('bot-token').value.trim();
    if (tokenInput) {
      settings.bot_token = tokenInput;
    }

    // Offset
    const offsetVal = parseInt($('update-offset').value);
    if (!isNaN(offsetVal) && offsetVal >= 0) {
      settings.last_update_id = offsetVal;
    }

    // Poll interval
    const checkedInterval = document.querySelector('input[name="interval"]:checked');
    if (checkedInterval) {
      settings.poll_interval = parseInt(checkedInterval.value);
    }

    // Toggles
    settings.include_frontmatter = $('include-frontmatter').checked;
    settings.use_gfm = $('use-gfm').checked;
    settings.context_menu_enabled = $('context-menu-enabled').checked;

    await sendMsg('save_settings', { settings });
    showToast('✓ Settings saved');
  } catch (e) {
    showToast(`❌ ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();

  // Show/hide token
  $('show-token-btn').addEventListener('click', () => {
    const input = $('bot-token');
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    $('show-token-btn').textContent = isPassword ? '🙈' : '👁';
  });

  // Verify token
  $('verify-token-btn').addEventListener('click', async () => {
    const token = $('bot-token').value.trim();
    if (!token) {
      setTokenStatus('Paste your bot token first.', 'error');
      return;
    }

    $('verify-token-btn').disabled = true;
    setTokenStatus('Verifying…');

    try {
      const resp = await sendMsg('verify_token', { token });
      if (resp?.success) {
        setTokenStatus(`✓ @${resp.username}`, 'success');
        $('bot-username-display').textContent = `@${resp.username}`;
        $('bot-username-display').classList.remove('muted');
      } else {
        setTokenStatus(`❌ ${resp?.error || 'Invalid token'}`, 'error');
      }
    } catch (e) {
      setTokenStatus(`❌ ${e.message}`, 'error');
    } finally {
      $('verify-token-btn').disabled = false;
    }
  });

  // Choose folder
  $('choose-folder-btn').addEventListener('click', async () => {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

      // Test write access
      try {
        const testFh = await dirHandle.getFileHandle('.markdown-vault-test', { create: true });
        const w = await testFh.createWritable();
        await w.write('test');
        await w.close();
        await dirHandle.removeEntry('.markdown-vault-test').catch(() => { });
      } catch (we) {
        $('folder-msg').textContent = `Write test failed: ${we.message}`;
        $('folder-msg').className = 'field-status error';
        return;
      }

      await idbSet('save_dir_handle', dirHandle);
      await sendMsg('fs_permission_granted');

      $('current-folder-name').textContent = dirHandle.name;
      $('current-folder-display').classList.remove('hidden');
      const si = $('folder-status-icon');
      si.textContent = '✓';
      si.className = 'folder-status-icon ok';
      si.title = 'Folder is accessible';
      $('folder-msg').textContent = '✓ Folder saved';
      $('folder-msg').className = 'field-status success';

    } catch (e) {
      if (e.name !== 'AbortError') {
        $('folder-msg').textContent = `Error: ${e.message}`;
        $('folder-msg').className = 'field-status error';
      }
    }
  });

  // Save settings
  $('save-btn').addEventListener('click', saveSettings);

  // Reset to defaults
  $('reset-btn').addEventListener('click', async () => {
    if (!confirm('Reset all settings to defaults?')) return;
    await sendMsg('save_settings', {
      settings: {
        include_frontmatter: true,
        use_gfm: true,
        poll_interval: 300,
        context_menu_enabled: true,
      },
    });
    await loadSettings();
    showToast('✓ Reset to defaults');
  });

  // Reset setup (danger zone)
  $('reset-setup-btn').addEventListener('click', async () => {
    if (!confirm('This will reset all setup. You\'ll need to re-enter your bot token and choose a folder. Continue?')) return;

    await sendMsg('save_settings', {
      settings: {
        setup_complete: false,
        bot_token: '',
        bot_username: '',
        last_update_id: 0,
      },
    });

    chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding/onboarding.html') });
    window.close();
  });
});
