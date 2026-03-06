// Markdown Vault — Background Tab Extractor
// Opens a background tab for JS-rendered pages when Readability fails.
// Includes site-specific extraction for X/Twitter and Xiaohongshu.
// Dynamically imported — only loaded when a background tab fallback is needed.

function isTwitterHostname(hostname) {
  const host = (hostname || '').toLowerCase().replace(/^www\./, '');
  return host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com');
}

function isTwitterStatusURL(input) {
  try {
    const u = new URL(input);
    return isTwitterHostname(u.hostname) && /\/status\/\d+/.test(u.pathname);
  } catch {
    return false;
  }
}

function isTwitterArticleURL(input) {
  try {
    const u = new URL(input);
    return isTwitterHostname(u.hostname) && /\/(?:i\/)?article\/\d+/.test(u.pathname);
  } catch {
    return false;
  }
}

function isXiaohongshuURL(input) {
  try {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'xiaohongshu.com' || host === 'xhslink.com';
  } catch {
    return false;
  }
}

export { isTwitterStatusURL, isXiaohongshuURL };

export async function fetchWithBackgroundTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab load timeout'));
      }, 30000);

      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // X/Twitter posts are highly dynamic; wait for tweet content to render,
    // then extract from live DOM directly, or via GraphQL API if article.
    if (isTwitterStatusURL(url) || isTwitterArticleURL(url)) {

      // X GraphQL API Extraction for Articles — runs in page context, not SW
      const xArticleResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['x-article-extractor.js'],
      });
      if (xArticleResults && xArticleResults[0]?.result) {
        return xArticleResults[0].result;
      }

      // Poll DOM until tweet content appears (X.com loads asynchronously after 'complete')
      const MAX_POLL_MS = 12000;
      const POLL_INTERVAL_MS = 500;
      const pollStart = Date.now();

      await new Promise((resolve) => {
        const check = async () => {
          if (Date.now() - pollStart > MAX_POLL_MS) { resolve(); return; }
          try {
            const probe = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                return !!(
                  document.querySelector('article[data-testid="tweet"], article[role="article"]') &&
                  document.querySelector('div[data-testid="tweetText"]')
                );
              },
            });
            if (probe[0]?.result) { resolve(); return; }
          } catch { /* tab not ready */ }
          setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
      });

      // X Tweet DOM extraction — runs in page context
      const xResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['x-tweet-extractor.js'],
      });

      const xPost = xResults[0]?.result || null;
      if (xPost?.content) return xPost;


    }

    // Xiaohongshu (小红书) — JS-rendered; extract note content and CDN images from live DOM
    if (isXiaohongshuURL(url)) {
      const MAX_POLL_MS = 15000;
      const POLL_INTERVAL_MS = 800;
      const pollStart = Date.now();

      // Wait until note images or text content appear in the DOM
      await new Promise((resolve) => {
        const check = async () => {
          if (Date.now() - pollStart > MAX_POLL_MS) { resolve(); return; }
          try {
            const probe = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const hasImages = Array.from(document.querySelectorAll('img'))
                  .some(img => /xhscdn|sns-img|ci\.xiaohongshu/.test(img.src || ''));
                const hasText = !!document.querySelector('#detail-desc, .note-content, .desc');
                return hasImages || hasText;
              },
            });
            if (probe[0]?.result) { resolve(); return; }
          } catch { /* tab not ready */ }
          setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
      });

      // XHS content extraction — runs in page context
      const xhsResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['xhs-extractor.js'],
      });

      const xhsData = xhsResults[0]?.result;
      if (xhsData && (xhsData.description || xhsData.imageUrls?.length > 0)) {
        const lines = [];
        if (xhsData.author) lines.push(`**Author:** ${xhsData.author}`, '');
        if (xhsData.description) lines.push(xhsData.description, '');
        if (xhsData.hasVideo) {
          lines.push('> *This post contains a video that could not be saved. Visit the original URL to view it.*', '');
        }
        if (xhsData.imageUrls?.length > 0) {
          lines.push('## Images', '');
          xhsData.imageUrls.forEach((src, idx) => lines.push(`![Image ${idx + 1}](${src})`));
          lines.push('');
        }
        const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        return {
          title: xhsData.title || 'Xiaohongshu Post',
          content,
          markdownReady: true,
          imageUrls: xhsData.imageUrls || [],
        };
      }
    }

    // Inject Readability
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['libs/Readability.js'],
    });

    // Extract content from live DOM
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          const reader = new Readability(document.cloneNode(true));
          const article = reader.parse();
          if (!article) return null;
          return {
            title: article.title,
            content: article.content,
            excerpt: article.excerpt,
            byline: article.byline,
            siteName: article.siteName,
          };
        } catch (e) {
          return null;
        }
      },
    });

    return results[0]?.result || null;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => { });
  }
}
