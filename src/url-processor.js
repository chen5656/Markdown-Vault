// Markdown Vault — URL Processing Pipeline
// Dynamically imported — only loaded when a URL needs to be saved.

import {
  getStorage, setStorage, getDirHandle,
  slugify, dateString, sanitizeTitle, buildFilename, buildFrontmatter,
  escapeMarkdownHeading, buildArticleMarkdown, buildErrorMarkdown,
  getUniqueFileHandle, writeFile, saveMarkdownFile,
  downloadImagesToFolder,
} from './shared.js';
import { classifyUrl } from './content-router.js';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [30, 120, 300];
const MIN_ARTICLE_LENGTH = 500;
const MAX_PAGE_SIZE = 5 * 1024 * 1024;

// ─── Offscreen Document ───────────────────────────────────────────────────────
async function ensureOffscreen() {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: 'pages/offscreen/offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Parse HTML with Readability for article extraction',
    });
  } catch (e) {
    if (!e.message?.includes('single offscreen') && !e.message?.includes('already')) {
      throw e;
    }
  }
}

async function offscreenMessage(payload) {
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Offscreen timeout')), 30000);

    chrome.runtime.sendMessage(
      { target: 'offscreen', ...payload },
      response => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.success) {
          resolve(response);
        } else {
          reject(new Error(response?.error || 'Offscreen operation failed'));
        }
      }
    );
  });
}

async function parseHtmlViaOffscreen(html, url, useGFM) {
  return offscreenMessage({ type: 'parse_html', html, url, useGFM });
}

async function convertHtmlToMarkdown(title, html, url, useGFM) {
  return offscreenMessage({ type: 'convert_html', title, html, url, useGFM });
}

// ─── Content Fetch ────────────────────────────────────────────────────────────
async function fetchURL(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      err.status = resp.status;
      err.retryable = resp.status >= 500;
      throw err;
    }

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const contentDisposition = resp.headers.get('content-disposition') || '';
    const isHTML = contentType.includes('text/html') || contentType.includes('application/xhtml');
    const isXmlFeed = contentType.includes('application/rss+xml') ||
      contentType.includes('application/atom+xml') ||
      contentType.includes('application/xml');

    if (!isHTML && !isXmlFeed && !contentType.includes('text/')) {
      const buffer = await resp.arrayBuffer();
      return { html: null, finalUrl: resp.url, contentType, contentDisposition, binaryData: buffer };
    }

    const html = await resp.text();
    return {
      html: html.length > MAX_PAGE_SIZE ? html.slice(0, MAX_PAGE_SIZE) : html,
      finalUrl: resp.url,
      contentType,
      contentDisposition,
    };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      const err = new Error('Request timed out after 30s');
      err.retryable = true;
      throw err;
    }
    if (e.message?.includes('redirect')) {
      e.retryable = false;
      throw e;
    }
    if (!e.status) e.retryable = true;
    throw e;
  }
}

// ─── Recent Saves ─────────────────────────────────────────────────────────────
async function addRecentSave(info) {
  const { recent_saves = [] } = await getStorage(['recent_saves']);
  recent_saves.unshift(info);
  if (recent_saves.length > 20) recent_saves.length = 20;
  await setStorage({ recent_saves });
}

// ─── Retry Mechanism ──────────────────────────────────────────────────────────
async function schedulePendingRetry(url, attempt) {
  const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
  const { pending_retries = [] } = await getStorage(['pending_retries']);

  const filtered = pending_retries.filter(r => r.url !== url);
  filtered.push({
    url,
    attempt,
    next_retry_at: Date.now() + delay * 1000,
  });

  await setStorage({ pending_retries: filtered });
}

async function clearPendingRetry(url) {
  const { pending_retries = [] } = await getStorage(['pending_retries']);
  await setStorage({ pending_retries: pending_retries.filter(r => r.url !== url) });
}

export async function processRetries() {
  const { pending_retries = [] } = await getStorage(['pending_retries']);
  if (!pending_retries.length) return;

  const now = Date.now();
  const due = pending_retries.filter(r => r.next_retry_at <= now);
  if (!due.length) return;

  const remaining = pending_retries.filter(r => r.next_retry_at > now);
  await setStorage({ pending_retries: remaining });

  const settings = await getStorage([
    'bot_token', 'include_frontmatter', 'use_gfm',
    'poll_interval', 'bot_username',
  ]);

  for (const retry of due) {
    await processURLWithRetry(retry.url, retry.attempt, settings);
  }
}

// ─── Notification helper ──────────────────────────────────────────────────────
async function notifyAndRecord(title, filename, url, savedAt) {
  chrome.notifications.create({
    type: 'basic', iconUrl: 'docs/icon_64.png',
    title: 'Saved as Markdown',
    message: `"${title.slice(0, 60)}" → ${filename}`,
  });
  await addRecentSave({ title, filename, url, saved_at: savedAt });
}

// ─── URL Processing ───────────────────────────────────────────────────────────
export async function processURLWithRetry(url, attemptIndex, settings) {
  const dirHandle = await getDirHandle();
  if (!dirHandle) {
    console.warn('[markdown-vault] No directory handle — skipping URL save');
    return;
  }

  const { include_frontmatter = true, use_gfm = true } = settings;
  const savedAt = new Date().toISOString();

  try {
    // ── Pre-fetch routing: YouTube ───────────────────────────────────────────
    const preType = classifyUrl(url);
    if (preType === 'youtube') {
      console.log('[markdown-vault] YouTube detected:', url);
      const { handleYouTube } = await import('./youtube-handler.js');
      const result = await handleYouTube(url, dirHandle, settings);
      await notifyAndRecord(result.title, result.filename, url, savedAt);
      await clearPendingRetry(url);
      return;
    }

    // Step 1: Fetch the page
    let html, finalUrl, binaryData, contentType, contentDisposition;
    try {
      ({ html, finalUrl, binaryData, contentType, contentDisposition } = await fetchURL(url));
    } catch (fetchErr) {
      const isRetryable = fetchErr.retryable;
      const status = fetchErr.status;
      const isNonRetryable = status === 401 || status === 403 || status === 404;

      if (isNonRetryable || !isRetryable) {
        const errorMd = buildErrorMarkdown({
          url, error: fetchErr.message, savedAt, includeFrontmatter: include_frontmatter,
        });
        const filename = `${dateString()}-error-${slugify(url.replace(/https?:\/\//, '').slice(0, 40))}.md`;
        await saveMarkdownFile(dirHandle, filename, errorMd);
        chrome.notifications.create({
          type: 'basic', iconUrl: 'docs/icon_64.png',
          title: 'Markdown Vault — Save Failed',
          message: `Could not save: ${url}\nError: ${fetchErr.message}`,
        });
        return;
      }

      const nextAttempt = attemptIndex + 1;
      if (nextAttempt < MAX_RETRIES) {
        await schedulePendingRetry(url, nextAttempt);
        return;
      }

      const errorMd = buildErrorMarkdown({
        url, error: `${fetchErr.message} (after ${MAX_RETRIES} attempts)`,
        savedAt, includeFrontmatter: include_frontmatter,
      });
      const filename = `${dateString()}-error-${slugify(url.replace(/https?:\/\//, '').slice(0, 40))}.md`;
      await saveMarkdownFile(dirHandle, filename, errorMd);
      chrome.notifications.create({
        type: 'basic', iconUrl: 'docs/icon_64.png',
        title: 'Markdown Vault — Save Failed (all retries)',
        message: `Failed to save ${url} after ${MAX_RETRIES} attempts.\nLast error: ${fetchErr.message}`,
      });
      return;
    }

    // Step 1b: Route based on content type
    const effectiveUrl = finalUrl || url;
    const postType = classifyUrl(effectiveUrl, contentType);

    // RSS feeds
    if (postType === 'rss' || (html && (contentType || '').match(/rss|atom|feed/))) {
      console.log('[markdown-vault] RSS feed detected:', effectiveUrl);
      const { handleRss } = await import('./rss-handler.js');
      const result = await handleRss(effectiveUrl, dirHandle, settings, html, offscreenMessage);
      await notifyAndRecord(result.title, result.filename, url, savedAt);
      await clearPendingRetry(url);
      return;
    }

    if (binaryData) {
      const fetchResult = { binaryData, contentType, contentDisposition };
      const { handlePdf, handleDirectMedia, handleDirectImage } = await import('./media-handler.js');

      if (postType === 'pdf') {
        console.log('[markdown-vault] PDF detected:', effectiveUrl);
        const result = await handlePdf(effectiveUrl, dirHandle, settings, fetchResult);
        await notifyAndRecord(result.title, result.filename, url, savedAt);
        await clearPendingRetry(url);
        return;
      }

      if (postType === 'direct-audio') {
        console.log('[markdown-vault] Audio file detected:', effectiveUrl);
        const result = await handleDirectMedia(effectiveUrl, dirHandle, settings, fetchResult, 'audio');
        await notifyAndRecord(result.title, result.filename, url, savedAt);
        await clearPendingRetry(url);
        return;
      }

      if (postType === 'direct-video') {
        console.log('[markdown-vault] Video file detected:', effectiveUrl);
        const result = await handleDirectMedia(effectiveUrl, dirHandle, settings, fetchResult, 'video');
        await notifyAndRecord(result.title, result.filename, url, savedAt);
        await clearPendingRetry(url);
        return;
      }

      if (postType === 'direct-image') {
        console.log('[markdown-vault] Image URL detected:', effectiveUrl);
        await handleDirectImage(effectiveUrl, dirHandle, settings, fetchResult);
        await clearPendingRetry(url);
        return;
      }

      // Unknown binary — save to date subfolder + companion .md
      let ext = 'bin';
      if (contentType) {
        const ctParts = contentType.split('/');
        if (ctParts.length === 2) ext = ctParts[1].split(';')[0].trim();
        if (ext === 'jpeg') ext = 'jpg';
        if (ext === 'svg+xml') ext = 'svg';
      }
      try {
        const urlPath = new URL(url).pathname;
        const urlExt = urlPath.split('.').pop()?.toLowerCase();
        if (urlExt && urlExt.length <= 5 && /^[a-z0-9]+$/.test(urlExt)) ext = urlExt;
      } catch { /* use content-type ext */ }

      const date = dateString();
      const basename = slugify(new URL(url).pathname.split('/').pop()?.replace(/\.[^.]+$/, '') || 'download');
      const binaryFilename = `${date}-${basename}.${ext}`;
      let dayDir;
      try {
        dayDir = await dirHandle.getDirectoryHandle(date, { create: true });
      } catch {
        dayDir = dirHandle;
      }
      const fh = await dayDir.getFileHandle(binaryFilename, { create: true });
      const w = await fh.createWritable();
      await w.write(binaryData);
      await w.close();
      const savedPath = `${date}/${binaryFilename}`;

      const sizeMB = (binaryData.byteLength / 1024 / 1024).toFixed(2);
      const fmFields = {
        title: basename, url, saved_at: savedAt,
        source: 'markdown-vault', type: ext,
        file: `./${savedPath}`, size_mb: sizeMB,
      };
      const fm = include_frontmatter ? buildFrontmatter(fmFields) : '';
      const mdContent = (
        `${fm}# ${escapeMarkdownHeading(basename)}\n\n` +
        `> File saved to \`./${savedPath}\` (${sizeMB} MB)\n\n` +
        `Source: ${url}\n`
      );
      const mdFilename = buildFilename(basename);
      const savedMdName = await saveMarkdownFile(dirHandle, mdFilename, mdContent);

      chrome.notifications.create({
        type: 'basic', iconUrl: 'docs/icon_64.png',
        title: 'Saved File',
        message: `Downloaded: ${binaryFilename}`,
      });
      await addRecentSave({ title: basename, filename: savedMdName, url, saved_at: savedAt });
      await clearPendingRetry(url);
      return;
    }

    // Podcast pages
    if (postType === 'podcast') {
      console.log('[markdown-vault] Podcast page detected:', effectiveUrl);
      const { handlePodcast } = await import('./podcast-handler.js');
      const result = await handlePodcast(effectiveUrl, html, dirHandle, settings, offscreenMessage);
      await notifyAndRecord(result.title, result.filename, url, savedAt);
      await clearPendingRetry(url);
      return;
    }

    const { isTwitterStatusURL, isXiaohongshuURL } = await import('./tab-extractor.js');
    const useLiveDomFirst = isTwitterStatusURL(finalUrl || url) || isXiaohongshuURL(finalUrl || url);

    // Step 2: Parse HTML → Readability → Markdown
    let parsed = null;
    if (!useLiveDomFirst) {
      try {
        parsed = await parseHtmlViaOffscreen(html, finalUrl || url, use_gfm);
      } catch (parseErr) {
        console.warn('[markdown-vault] Offscreen parse failed:', parseErr);
      }
    }

    // Step 3: Background tab fallback
    if (useLiveDomFirst || !parsed || !parsed.content || parsed.content.length < MIN_ARTICLE_LENGTH) {
      console.log('[markdown-vault] Falling back to background tab for:', url);
      try {
        const { fetchWithBackgroundTab } = await import('./tab-extractor.js');
        const tabResult = await fetchWithBackgroundTab(url);
        if (tabResult?.content) {
          if (tabResult.markdownReady) {
            parsed = {
              title: tabResult.title || parsed?.title || url,
              content: tabResult.content,
              success: true,
              imageUrls: tabResult.imageUrls || [],
            };
          } else {
            try {
              const mdResult = await convertHtmlToMarkdown(
                tabResult.title || url, tabResult.content, url, use_gfm
              );
              if (mdResult?.success && mdResult.content) {
                parsed = { ...mdResult, title: tabResult.title || parsed?.title || url };
              }
            } catch {
              const stripped = tabResult.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              parsed = { title: tabResult.title || url, content: stripped, success: true };
            }
          }
        }
      } catch (tabErr) {
        console.warn('[markdown-vault] Background tab failed:', tabErr);
        if (html) {
          const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 8000);
          parsed = {
            title: url,
            content: `*Article extraction failed. Partial raw content:*\n\n${stripped}`,
            success: true,
          };
        }
      }
    }

    // If X/Twitter live DOM extraction fails, try generic parser
    if ((!parsed || !parsed.content) && useLiveDomFirst) {
      try {
        parsed = await parseHtmlViaOffscreen(html, finalUrl || url, use_gfm);
      } catch (parseErr) {
        console.warn('[markdown-vault] Offscreen fallback parse failed:', parseErr);
      }
    }

    if (!parsed?.content || !parsed.content.trim()) {
      const errorMd = buildErrorMarkdown({
        url, error: 'Could not extract any readable content from this page',
        savedAt, includeFrontmatter: include_frontmatter,
      });
      const filename = `${dateString()}-error-${slugify(url.replace(/https?:\/\//, '').slice(0, 40))}.md`;
      await saveMarkdownFile(dirHandle, filename, errorMd);
      return;
    }

    const title = sanitizeTitle(parsed.title || new URL(url).hostname);
    const mdFilename = buildFilename(title);

    const fileHandle = await getUniqueFileHandle(dirHandle, mdFilename);
    const savedName = fileHandle.name;

    let articleContent = parsed.content;
    const imageUrlsToDownload = parsed.imageUrls || [];
    if (imageUrlsToDownload.length > 0) {
      const folderName = savedName.replace(/\.md$/, '');
      try {
        const localPaths = await downloadImagesToFolder(dirHandle, folderName, imageUrlsToDownload);
        imageUrlsToDownload.forEach((remoteUrl, i) => {
          if (localPaths[i]) {
            articleContent = articleContent.split(remoteUrl).join(`./${folderName}/${localPaths[i]}`);
          }
        });
      } catch (imgErr) {
        console.warn('[markdown-vault] Failed to download XHS images:', imgErr);
      }
    }

    const markdown = buildArticleMarkdown({
      title, url, savedAt,
      markdown: articleContent,
      includeFrontmatter: include_frontmatter,
    });

    await writeFile(fileHandle, markdown);

    chrome.notifications.create({
      type: 'basic', iconUrl: 'docs/icon_64.png',
      title: 'Saved as Markdown',
      message: `"${title.slice(0, 60)}" → ${savedName}`,
    });

    await addRecentSave({ title, filename: savedName, url, saved_at: savedAt });
    await clearPendingRetry(url);

  } catch (err) {
    console.error('[markdown-vault] Unexpected error processing URL:', url, err);

    const nextAttempt = attemptIndex + 1;
    if (nextAttempt < MAX_RETRIES && err.retryable !== false) {
      await schedulePendingRetry(url, nextAttempt);
    } else {
      const dirH = await getDirHandle();
      if (dirH) {
        const errorMd = buildErrorMarkdown({
          url, error: err.message, savedAt, includeFrontmatter: true,
        });
        const filename = `${dateString()}-error-${slugify(url.slice(0, 40))}.md`;
        await saveMarkdownFile(dirH, filename, errorMd).catch(() => { });
      }
    }
  }
}
