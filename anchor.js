// Text matching: markdown source lines to rendered blocks, and ADO file tree rows to threads.
// Loaded as a content script (global `AdmcAnchor`) and by node tests (module.exports).
(function (root) {
  const SEARCH_RADIUS = 5;
  const PROBE_LENGTH = 40;
  // Shorter probes (e.g. `"effect": "deny"`) repeat too often to safely move the cursor forward.
  const CURSOR_PROBE_LENGTH = 20;

  // Lowercase text without whitespace or the characters that differ between source and rendering.
  function normalize(text) {
    return text.replace(/[\s*_`~]/g, '').toLowerCase();
  }

  function squash(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  // ADO's file tree shows each thread as a row with its first comment, followed by an optional
  // reply count. Returns the index of the comment that fills the whole row; else the index of the
  // only long comment (possibly truncated in the row) whose first 40 characters start the row;
  // else -1.
  function matchTreeRow(rowText, comments) {
    const row = squash(rowText);
    const texts = comments.map(squash);
    const exact = texts.findIndex((t) => t && row.startsWith(t) && /^\s*\d*$/.test(row.slice(t.length)));
    if (exact !== -1) return exact;
    const prefix = [];
    texts.forEach((t, i) => {
      if (t.length > 40 && row.startsWith(t.slice(0, 40))) prefix.push(i);
    });
    return prefix.length === 1 ? prefix[0] : -1;
  }

  function stripMarkdown(line) {
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')) return ''; // table separator / hr
    return line
      .replace(/^\s*(>\s*)+/, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
      .replace(/\|/g, ' ');
  }

  // Normalized text per source line with markdown syntax removed; fenced code is kept as-is.
  function lineTexts(source) {
    let inFence = false;
    return source.split(/\r?\n/).map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return '';
      }
      return normalize(inFence ? line : stripMarkdown(line));
    });
  }

  // Whole source as one normalized string, to check whether rendered text comes from this file.
  function sourceText(source) {
    return lineTexts(source).join('');
  }

  // Returns a probe string per source line ('' when the line has no usable text).
  function buildProbes(source) {
    return lineTexts(source).map((text) => (text.length >= 3 ? text.slice(0, PROBE_LENGTH) : ''));
  }

  // blockTexts: each block's own text (excluding nested blocks), in document order.
  // Walks source lines and blocks together so repeated text resolves to the block
  // that follows the previous match. Returns a block index (or -1) per source line.
  function mapLines(source, blockTexts) {
    const texts = blockTexts.map(normalize);
    let cursor = 0;
    return buildProbes(source).map((probe) => {
      if (!probe) return -1;
      let hit = -1;
      for (let i = cursor; i < texts.length && hit === -1; i++) {
        if (texts[i].includes(probe)) hit = i;
      }
      if (hit !== -1 && probe.length >= CURSOR_PROBE_LENGTH) cursor = hit;
      return hit;
    });
  }

  // lineNo is 1-based. Falls back to nearby lines for blank or unmatched lines.
  function blockForLine(lineMap, lineNo) {
    for (let d = 0; d <= SEARCH_RADIUS; d++) {
      for (const n of d === 0 ? [lineNo] : [lineNo - d, lineNo + d]) {
        const hit = lineMap[n - 1];
        if (hit !== undefined && hit !== -1) return hit;
      }
    }
    return -1;
  }

  const api = { normalize, stripMarkdown, sourceText, mapLines, blockForLine, matchTreeRow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdmcAnchor = api;
})(this);
