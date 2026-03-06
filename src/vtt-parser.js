// Markdown Vault — VTT / JSON Transcript Parser
// Parses WebVTT and JSON transcript formats (Podcasting 2.0, generic).
// Pure string/regex logic — no DOM, runs in service worker.

/**
 * Parse a WebVTT string to plain text.
 * Strips timecodes, tags, deduplicates consecutive identical lines.
 */
export function parseVttText(vttText) {
  if (!vttText) return null;
  const lines = vttText.replace(/\r\n/g, '\n').split('\n');
  const textLines = [];
  let i = 0;

  while (i < lines.length) {
    const line = (lines[i] || '').trim();

    if (!line || line.toUpperCase() === 'WEBVTT' || /^(NOTE|STYLE|REGION)\b/i.test(line)) {
      i++;
      continue;
    }

    if (line.includes('-->')) {
      i++;
      while (i < lines.length && (lines[i] || '').trim()) {
        const cueLine = (lines[i] || '').trim()
          .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
          .replace(/<c[^>]*>/g, '').replace(/<\/c>/g, '')
          .replace(/<[^>]+>/g, '');
        if (cueLine) textLines.push(cueLine);
        i++;
      }
      i++;
      continue;
    }

    i++;
  }

  const deduped = [];
  for (const line of textLines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }

  return deduped.join('\n').trim() || null;
}

/**
 * Parse a JSON transcript payload to plain text.
 * Handles common formats: array of segments, {segments: [...]}, {transcript: '...'}.
 */
export function parseJsonTranscriptText(jsonText) {
  if (!jsonText) return null;
  try {
    const data = JSON.parse(jsonText);

    if (Array.isArray(data)) {
      const lines = data
        .map(s => typeof s.text === 'string' ? s.text.trim() : typeof s.utf8 === 'string' ? s.utf8.trim() : '')
        .filter(Boolean);
      return lines.join('\n').trim() || null;
    }

    if (data && typeof data === 'object') {
      if (Array.isArray(data.segments)) {
        const lines = data.segments
          .map(s => typeof s.text === 'string' ? s.text.trim() : '')
          .filter(Boolean);
        return lines.join('\n').trim() || null;
      }
      if (typeof data.transcript === 'string') return data.transcript.trim() || null;
      if (typeof data.text === 'string') return data.text.trim() || null;
    }

    return null;
  } catch { return null; }
}
