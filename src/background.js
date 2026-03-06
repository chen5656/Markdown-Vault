// Markdown Vault — Background Service Worker
// Thin orchestrator — registers Chrome event listeners and delegates to dynamic imports.
// Cold start loads only this file + shared.js (~300 + ~250 lines).
// Heavy modules (telegram, url-processor, handlers) load on first use.

import { getStorage, setStorage, getDirHandle, setUpdateBadge,
  dateString, saveImageToFolder, appendToDaily } from './shared.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const ALARM_NAME = 'markdown-vault-poll';
const DEFAULT_POLL_INTERVAL = 300;

// ─── Badge Management ─────────────────────────────────────────────────────────
async function updateBadge() {
  const {
    is_polling_active, setup_complete,
    fs_permission_needed, last_telegram_error,
  } = await getStorage([
    'is_polling_active', 'setup_complete',
    'fs_permission_needed', 'last_telegram_error',
  ]);

  if (!setup_complete) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B35' });
    return;
  }

  if (fs_permission_needed || last_telegram_error) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#E53935' });
    return;
  }

  if (!is_polling_active) {
    chrome.action.setBadgeText({ text: '■' });
    chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E' });
    return;
  }

  chrome.action.setBadgeText({ text: '' });
}

// Wire badge into shared.js getDirHandle()
setUpdateBadge(updateBadge);

// ─── Alarm Management ─────────────────────────────────────────────────────────
async function setupAlarm(intervalSeconds) {
  await chrome.alarms.clear(ALARM_NAME);
  const periodInMinutes = Math.max(1, intervalSeconds / 60);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
  await setStorage({ poll_interval: intervalSeconds });
}

// ─── Lazy poll wrapper ────────────────────────────────────────────────────────
async function doPoll() {
  const { poll } = await import('./telegram.js');
  await poll(updateBadge);
}

// ─── Context Menu ─────────────────────────────────────────────────────────────
async function setupContextMenu() {
  await chrome.contextMenus.removeAll();
  const { context_menu_enabled = true } = await getStorage(['context_menu_enabled']);
  if (!context_menu_enabled) return;
  chrome.contextMenus.create({
    id: 'save-to-vault',
    title: 'Save to Markdown Vault',
    contexts: ['link', 'page'],
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.linkUrl || info.pageUrl;
  if (!url || !/^https?:\/\//.test(url)) return;
  const settings = await getStorage([
    'bot_token', 'include_frontmatter', 'use_gfm', 'poll_interval', 'bot_username',
  ]);
  const { processURLWithRetry } = await import('./url-processor.js');
  await processURLWithRetry(url, 0, settings);
});

// ─── Event Listeners ──────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  await setupContextMenu();
});

chrome.runtime.onInstalled.addListener(async details => {
  const { setup_complete } = await getStorage(['setup_complete']);

  if (details.reason === 'install' && !setup_complete) {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding/onboarding.html') });
  }

  const defaults = {
    is_polling_active: true,
    poll_interval: DEFAULT_POLL_INTERVAL,
    include_frontmatter: true,
    use_gfm: true,
    recent_saves: [],
    pending_retries: [],
    last_update_id: 0,
    fs_permission_needed: false,
    folder_status: 'unknown',
    last_telegram_error: null,
    context_menu_enabled: true,
  };

  const existing = await getStorage(Object.keys(defaults));
  const toSet = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (existing[k] === undefined) toSet[k] = v;
  }
  if (Object.keys(toSet).length) await setStorage(toSet);

  const { poll_interval = DEFAULT_POLL_INTERVAL } = await getStorage(['poll_interval']);
  await setupAlarm(poll_interval);

  if (details.reason === 'update' && setup_complete) {
    await getDirHandle();
  }

  await setupContextMenu();
  await updateBadge();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_NAME) {
    await doPoll();
  }
});

// ─── Message Handler (from popup/settings/onboarding) ────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === 'offscreen') return false;

  const handle = async () => {
    switch (message.type) {
      case 'poll_now': {
        await doPoll();
        return { success: true };
      }

      case 'set_interval': {
        await setupAlarm(message.intervalSeconds);
        const { is_polling_active } = await getStorage(['is_polling_active']);
        if (is_polling_active === false) {
          await setStorage({ is_polling_active: true });
        }
        return { success: true };
      }

      case 'stop_polling': {
        await chrome.alarms.clear(ALARM_NAME);
        await setStorage({ is_polling_active: false });
        await updateBadge();
        return { success: true };
      }

      case 'start_polling': {
        const { poll_interval = DEFAULT_POLL_INTERVAL } = await getStorage(['poll_interval']);
        await setupAlarm(poll_interval);
        await setStorage({ is_polling_active: true });
        await updateBadge();
        return { success: true };
      }

      case 'get_state': {
        const state = await getStorage([
          'bot_token', 'bot_username', 'last_successful_poll', 'recent_saves',
          'is_polling_active', 'poll_interval',
          'setup_complete', 'fs_permission_needed',
          'folder_status', 'last_telegram_error', 'pending_retries', 'last_update_id',
          'include_frontmatter', 'use_gfm', 'context_menu_enabled',
        ]);
        const hasToken = !!state.bot_token;
        delete state.bot_token;
        const alarm = await chrome.alarms.get(ALARM_NAME);
        const next_poll_time = alarm?.scheduledTime || null;
        return { ...state, has_token: hasToken, next_poll_time };
      }

      case 'save_settings': {
        const { settings } = message;
        const toSave = {};
        if (settings.bot_token !== undefined) toSave.bot_token = settings.bot_token;
        if (settings.bot_username !== undefined) toSave.bot_username = settings.bot_username;
        if (settings.include_frontmatter !== undefined) toSave.include_frontmatter = settings.include_frontmatter;
        if (settings.use_gfm !== undefined) toSave.use_gfm = settings.use_gfm;
        if (settings.poll_interval !== undefined) {
          toSave.poll_interval = settings.poll_interval;
          const { is_polling_active } = await getStorage(['is_polling_active']);
          if (is_polling_active !== false) {
            await setupAlarm(settings.poll_interval);
          }
        }
        if (settings.last_update_id !== undefined) toSave.last_update_id = settings.last_update_id;
        if (settings.setup_complete !== undefined) toSave.setup_complete = settings.setup_complete;
        if (settings.context_menu_enabled !== undefined) toSave.context_menu_enabled = settings.context_menu_enabled;
        await setStorage(toSave);
        if (settings.context_menu_enabled !== undefined) await setupContextMenu();
        await updateBadge();
        return { success: true };
      }

      case 'fs_permission_granted': {
        await setStorage({ fs_permission_needed: false, folder_status: 'ok' });
        await updateBadge();
        return { success: true };
      }

      case 'save_url': {
        const settings = await getStorage([
          'bot_token', 'include_frontmatter', 'use_gfm', 'poll_interval', 'bot_username',
        ]);
        const { processURLWithRetry } = await import('./url-processor.js');
        await processURLWithRetry(message.url, 0, settings);
        return { success: true };
      }

      case 'save_clipboard_image': {
        const dirHandle = await getDirHandle();
        if (!dirHandle) throw new Error('No save folder configured');
        const { dataUrl, mimeType } = message;
        const ext = (mimeType || 'image/png').split('/')[1]?.split('+')[0] || 'png';
        const d = dateString();
        const imgFilename = `${d}-${Date.now()}.${ext}`;
        const base64 = dataUrl.split(',')[1] || '';
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const savedPath = await saveImageToFolder(dirHandle, d, imgFilename, bytes.buffer);
        await appendToDaily(dirHandle, `![Clipboard image](./${savedPath})`, d);
        const { recent_saves = [] } = await getStorage(['recent_saves']);
        recent_saves.unshift({ title: 'Clipboard image', filename: imgFilename, url: 'clipboard', saved_at: new Date().toISOString() });
        if (recent_saves.length > 20) recent_saves.length = 20;
        await setStorage({ recent_saves });
        return { success: true };
      }

      case 'save_clipboard_text': {
        const dirHandle = await getDirHandle();
        if (!dirHandle) throw new Error('No save folder configured');
        const d = dateString();
        await appendToDaily(dirHandle, message.text, d);
        const { recent_saves = [] } = await getStorage(['recent_saves']);
        recent_saves.unshift({ title: message.text.slice(0, 60), filename: `${d}.md`, url: 'clipboard', saved_at: new Date().toISOString() });
        if (recent_saves.length > 20) recent_saves.length = 20;
        await setStorage({ recent_saves });
        return { success: true };
      }

      case 'verify_token': {
        try {
          const { getMe } = await import('./telegram.js');
          const bot = await getMe(message.token);
          await setStorage({
            bot_token: message.token,
            bot_username: bot.username,
            last_telegram_error: null,
          });
          return { success: true, username: bot.username };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      default:
        return { error: `Unknown message type: ${message.type}` };
    }
  };

  handle().then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

// Kick off first poll on browser start
chrome.runtime.onStartup.addListener(async () => {
  const { setup_complete, is_polling_active, poll_interval = DEFAULT_POLL_INTERVAL } = await getStorage([
    'setup_complete', 'is_polling_active', 'poll_interval',
  ]);
  if (setup_complete) {
    await getDirHandle();
    if (is_polling_active !== false) {
      await setupAlarm(poll_interval);
      await doPoll();
    }
  }
  await updateBadge();
});
