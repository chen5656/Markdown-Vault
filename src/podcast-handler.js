// Markdown Vault — Podcast Episode Handler
// Handles podcast platform pages (Apple Podcasts, Spotify, etc.).
// Tries to find transcripts via Podcasting 2.0 RSS <podcast:transcript> tags.

import {
  sanitizeTitle, buildFilename, buildFrontmatter, escapeMarkdownHeading,
  saveMarkdownFile,
} from './shared.js';
import { extractMetadata } from './metadata.js';
import { parseVttText, parseJsonTranscriptText } from './vtt-parser.js';

function findRssLinkInHtml(html, pageUrl) {
  const re = /<link[^>]+type=["']application\/rss\+xml["'][^>]*href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    if (!/^https?:\/\//i.test(href)) {
      try { href = new URL(href, pageUrl).toString(); } catch { continue; }
    }
    return href;
  }
  const re2 = /<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/rss\+xml["']/gi;
  while ((m = re2.exec(html)) !== null) {
    let href = m[1];
    if (!/^https?:\/\//i.test(href)) {
      try { href = new URL(href, pageUrl).toString(); } catch { continue; }
    }
    return href;
  }
  return null;
}

function findMatchingEpisode(items, pageUrl) {
  const normalised = pageUrl.replace(/\/$/, '');
  for (const item of items) {
    if (item.link && item.link.replace(/\/$/, '') === normalised) return item;
  }
  for (const item of items) {
    if (item.enclosureUrl) {
      const base = item.enclosureUrl.split('/').pop()?.split('?')[0] || '';
      if (base && pageUrl.includes(base)) return item;
    }
  }
  return items[0] || null;
}

export async function handlePodcast(url, html, dirHandle, settings, offscreenMessage) {
  const { include_frontmatter = true } = settings;
  const savedAt = new Date().toISOString();

  const meta       = extractMetadata(html, url);
  const title      = meta.title || url;
  const showNotes  = meta.description || null;

  let transcript       = null;
  let transcriptSource = null;

  const rssUrl = findRssLinkInHtml(html, url);
  if (rssUrl) {
    try {
      const rssResp = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarkdownVault/1.0)' },
      });
      if (rssResp.ok) {
        const xmlText = await rssResp.text();
        const parsed  = await offscreenMessage({ type: 'parse_rss', xml: xmlText, url: rssUrl });
        const episode = findMatchingEpisode(parsed.items || [], url);

        if (episode?.transcriptUrl) {
          try {
            const tResp = await fetch(episode.transcriptUrl);
            if (tResp.ok) {
              const tText = await tResp.text();
              if (episode.transcriptType?.includes('json')) {
                transcript = parseJsonTranscriptText(tText);
                if (transcript) transcriptSource = 'podcasting20-json';
              } else {
                transcript = parseVttText(tText);
                if (transcript) transcriptSource = 'podcasting20-vtt';
              }
            }
          } catch { /* transcript fetch failed */ }
        }
      }
    } catch { /* RSS unavailable */ }
  }

  const fmFields = {
    title:    sanitizeTitle(title),
    url:      url,
    saved_at: savedAt,
    source:   'markdown-vault',
    type:     'podcast',
  };
  if (meta.published)    fmFields.published         = meta.published;
  if (transcriptSource)  fmFields.transcript_source = transcriptSource;

  const fm = include_frontmatter ? buildFrontmatter(fmFields) : '';

  const lines = [`# ${escapeMarkdownHeading(sanitizeTitle(title))}`, ''];
  if (showNotes) lines.push('## Show Notes', '', showNotes, '');
  if (transcript) {
    lines.push('## Transcript', '', transcript, '');
  } else {
    lines.push('> No transcript available for this episode.', '');
  }
  lines.push(`Source: ${url}`);

  const content    = fm + lines.join('\n');
  const cleanTitle = sanitizeTitle(title);
  const filename   = buildFilename(cleanTitle);
  const savedName  = await saveMarkdownFile(dirHandle, filename, content);

  return { title: cleanTitle, filename: savedName };
}
