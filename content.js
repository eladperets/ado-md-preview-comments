// ADO PR Markdown Preview Comments: content script.
//
// On an Azure DevOps pull request "Files" view of a markdown file, shows the PR's comment threads
// on top of the rendered Preview, and lets the user reply, like comments, change thread status,
// and add new comments.
//
// Notes for reviewers:
// - All network access is in ado-api.js, which only talks to the page's own origin.
// - Text from ADO (comments, names, statuses) is inserted with textContent, never parsed as HTML.
// - Writes start only from clicks or key presses in the extension's own popover and panel.
// - Changes to ADO's own page: a badge button and a CSS class on rendered markdown blocks, and a
//   click on ADO's "Raw content" button to switch to Preview. Everything else is in elements the
//   extension adds to <body>, all marked with the class "admc-root".
// - An unexpected error disables the extension for the current file; it does not retry in a loop.
(() => {
  const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,tr,dt,dd';
  const ROOT_CLASS = 'admc-root';

  let state = { key: null, ctx: null, data: null, error: null, container: null, broken: false };
  let panel = null;
  let popover = null;
  let popoverView = null; // { threads, focusId } shown in the open popover
  const drafts = new Map(); // thread id -> unsent reply text; survives re-renders

  // ---------------------------------------------------------------------------- Page detection

  // Returns the PR and file for a PR "Files" URL that shows a markdown file, otherwise null.
  // dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}?path=/doc.md
  // {org}.visualstudio.com[/DefaultCollection]/{project}/_git/{repo}/pullrequest/{id}?path=/doc.md
  // A URL without a project segment means the project has the repo's name.
  function parseUrl() {
    const url = new URL(location.href);
    const m = url.pathname.match(/^(.*?)\/_git\/([^/]+)\/pullrequest\/(\d+)/i);
    const path = url.searchParams.get('path');
    if (!m || !path || !/\.(md|markdown)$/i.test(path)) return null;

    const segments = m[1].split('/').filter(Boolean);
    const orgSegments = url.hostname === 'dev.azure.com' ? 1 : (segments[0] === 'DefaultCollection' ? 1 : 0);
    const collectionUrl = [url.origin, ...segments.slice(0, orgSegments)].join('/');
    if (segments.length === orgSegments) segments.push(m[2]);

    return {
      collectionUrl,
      apiBase: `${url.origin}/${segments.join('/')}/_apis/git/repositories/${m[2]}`,
      prUrl: `${url.origin}${m[0]}`,
      prId: m[3],
      path,
      iteration: url.searchParams.get('iteration'),
      base: url.searchParams.get('base'),
    };
  }

  // ---------------------------------------------------------------------------- Thread data

  // Lower rank needs more attention. Statuses not listed (byDesign, unknown) count as resolved.
  const STATUS_RANK = { active: 0, pending: 1, fixed: 2, wontFix: 2, closed: 3 };
  const STATUSES = [
    ['active', 'Active'], ['pending', 'Pending'], ['fixed', 'Resolved'],
    ['wontFix', "Won't fix"], ['closed', 'Closed'], ['byDesign', 'By design'],
  ];

  function statusRank(thread) {
    return STATUS_RANK[thread.status] ?? 2;
  }

  function threadLine(thread) {
    return thread.threadContext.rightFileStart?.line;
  }

  function compareThreads(a, b) {
    return statusRank(a) - statusRank(b) || (threadLine(a) || 0) - (threadLine(b) || 0);
  }

  function isLiked(comment) {
    return !!state.data.me && (comment.usersLiked || []).some((u) => u.id === state.data.me);
  }

  function withVisibleComments(thread) {
    return { ...thread, comments: (thread.comments || []).filter((c) => !c.isDeleted && c.commentType !== 'system') };
  }

  async function load(ctx) {
    const { threads, source, iterationId, me } = await AdmcApi.loadFile(ctx);
    return {
      threads: threads
        .filter((t) => !t.isDeleted && t.threadContext?.filePath === ctx.path)
        .map(withVisibleComments)
        .filter((t) => t.comments.length > 0)
        .sort(compareThreads),
      source,
      sourceText: AdmcAnchor.sourceText(source),
      iterationId,
      me,
    };
  }

  // ---------------------------------------------------------------------------- Writes

  // Runs a write started by the user in the extension's UI, then redraws with the new state.
  // Returns false if the write failed; the error is shown in the thread.
  async function write(box, action) {
    box.classList.add('admc-busy');
    try {
      await action();
    } catch (e) {
      box.querySelector('.admc-error').textContent = `Failed: ${e.message}`;
      return false;
    } finally {
      box.classList.remove('admc-busy');
    }
    state.data.threads.sort(compareThreads);
    if (state.container?.isConnected) render(state.ctx, state.container);
    if (popoverView) fillPopover();
    return true;
  }

  async function setStatus(ctx, thread, status) {
    thread.status = (await AdmcApi.setThreadStatus(ctx, thread.id, status)).status;
  }

  async function reply(ctx, thread, content) {
    thread.comments.push(await AdmcApi.addReply(ctx, thread.id, thread.comments[0].id, content));
    drafts.delete(thread.id);
  }

  async function toggleLike(ctx, thread, comment) {
    const liked = isLiked(comment);
    await AdmcApi.setLike(ctx, thread.id, comment.id, !liked);
    const others = (comment.usersLiked || []).filter((u) => u.id !== state.data.me);
    comment.usersLiked = liked ? others : [...others, { id: state.data.me }];
  }

  // New thread covering whole source lines first..last. Returns the thread.
  async function addThread(ctx, first, last, content) {
    const lastLine = state.data.source.split(/\r?\n/)[last - 1] || '';
    const thread = withVisibleComments(await AdmcApi.addThread(
      ctx, state.data.iterationId, { line: first, offset: 1 }, { line: last, offset: lastLine.length + 1 }, content));
    state.data.threads.push(thread);
    return thread;
  }

  // ---------------------------------------------------------------------------- Finding the preview

  function isOurs(node) {
    return !!node.closest(`.${ROOT_CLASS}`);
  }

  // The rendered preview is the largest visible element whose class mentions "markdown" and whose
  // text comes from this file (other rendered markdown on the page, such as comment bodies, does
  // not). If ADO renames its classes, fall back to finding the preview by content alone.
  function findPreview() {
    let best = null;
    for (const node of document.querySelectorAll('[class*="markdown"]')) {
      if (isOurs(node) || !node.offsetParent || !node.querySelector(BLOCK_SELECTOR) || !isFromFile(node)) continue;
      if (!best || node.textContent.length > best.textContent.length) best = node;
    }
    return best || findPreviewByContent();
  }

  // Text of a heading, paragraph, or list item, if it is long enough to identify the file.
  function sampleText(node) {
    const text = AdmcAnchor.normalize(node.textContent).slice(0, 20);
    return text.length >= 10 ? text : null;
  }

  // True if at least three (or all, if fewer) of the node's identifiable blocks come from this file.
  function isFromFile(node) {
    if (!state.data) return true; // load failed; nothing to compare, only the error panel is shown
    let checked = 0;
    let matched = 0;
    for (const block of node.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li')) {
      const text = sampleText(block);
      if (!text || isOurs(block)) continue;
      checked++;
      if (state.data.sourceText.includes(text)) matched++;
    }
    return matched > 0 && matched >= Math.min(3, checked);
  }

  // Closest common ancestor of visible headings and paragraphs whose text comes from this file.
  // Code views (raw content, diff) use neither element, so they do not match.
  function findPreviewByContent() {
    if (!state.data) return null;
    const hits = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p')].filter((node) => {
      if (isOurs(node) || !node.offsetParent) return false;
      const text = sampleText(node);
      return text && state.data.sourceText.includes(text);
    });
    if (hits.length < 3) return null;
    let root = hits[0].parentElement;
    while (root && !hits.every((h) => root.contains(h))) root = root.parentElement;
    return root && root !== document.body && root !== document.documentElement ? root : null;
  }

  // Text of each block without the text of blocks nested inside it.
  function ownTexts(container, blocks) {
    const texts = new Map(blocks.map((b) => [b, '']));
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement.closest(BLOCK_SELECTOR);
      if (texts.has(owner)) texts.set(owner, texts.get(owner) + node.data);
    }
    return blocks.map((b) => texts.get(b));
  }

  // ---------------------------------------------------------------------------- UI

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderThread(ctx, thread) {
    const box = el('div', 'admc-thread');
    const head = el('div', 'admc-thread-head');
    const status = el('select', `admc-status admc-rank-${statusRank(thread)}`);
    status.title = 'Thread status';
    const known = STATUSES.some(([value]) => value === thread.status);
    for (const [value, label] of known ? STATUSES : [[thread.status || '', thread.status || 'unknown'], ...STATUSES]) {
      const option = el('option', null, label);
      option.value = value;
      status.append(option);
    }
    status.value = thread.status || '';
    status.addEventListener('change', async () => {
      if (!(await write(box, () => setStatus(ctx, thread, status.value)))) status.value = thread.status || '';
    });
    head.append(status);
    const line = threadLine(thread);
    head.append(el('span', 'admc-muted', line ? `line ${line}` : 'deleted line'));
    const link = el('a', 'admc-link', 'Open in PR');
    link.href = `${ctx.prUrl}?_a=files&path=${encodeURIComponent(ctx.path)}&discussionId=${thread.id}`;
    head.append(link);
    box.append(head);

    for (const c of thread.comments) {
      const comment = el('div', 'admc-comment');
      const meta = el('div', 'admc-comment-meta admc-muted');
      meta.append(el('strong', null, c.author?.displayName || 'Unknown'), ` · ${new Date(c.publishedDate).toLocaleString()}`);
      const likes = `👍 ${c.usersLiked?.length || 0}`;
      if (state.data.me) {
        const like = el('button', `admc-like${isLiked(c) ? ' admc-liked' : ''}`, likes);
        like.type = 'button';
        like.title = isLiked(c) ? 'Unlike' : 'Like';
        like.addEventListener('click', () => write(box, () => toggleLike(ctx, thread, c)));
        meta.append(like);
      } else {
        // Without the user's ID it is unknown whether they already liked the comment.
        meta.append(el('span', 'admc-like', likes));
      }
      comment.append(meta, el('div', 'admc-content', c.content || ''));
      box.append(comment);
    }

    const input = el('textarea', 'admc-reply');
    input.value = drafts.get(thread.id) || '';
    input.addEventListener('input', () => drafts.set(thread.id, input.value));
    box.append(composer(input, 'Reply', (text) => write(box, () => reply(ctx, thread, text))), el('div', 'admc-error'));
    return box;
  }

  // Text box with a send button; Ctrl+Enter also sends. onSend gets the trimmed, non-empty text.
  function composer(input, label, onSend) {
    input.rows = 2;
    input.placeholder = `${label} (Ctrl+Enter to send)`;
    const send = el('button', 'admc-send', label);
    send.type = 'button';
    const submit = () => {
      const text = input.value.trim();
      if (text) onSend(text);
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keeps ADO keyboard shortcuts from firing while typing
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    });
    const row = el('div', 'admc-reply-row');
    row.append(input, send);
    return row;
  }

  function closePopover() {
    popover?.remove();
    popover = null;
    popoverView = null;
  }

  function fillPopover() {
    popoverView.threads.sort(compareThreads);
    popover.replaceChildren();
    for (const t of popoverView.threads) {
      const box = renderThread(state.ctx, t);
      if (t.id === popoverView.focusId) box.classList.add('admc-focus');
      popover.append(box);
    }
  }

  function openPopover(anchor, threads, focusId) {
    closePopover();
    popover = el('div', `${ROOT_CLASS} admc-popover`);
    popover.dataset.owner = String(threads[0].id);
    popoverView = { threads, focusId };
    fillPopover();
    document.body.append(popover);
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8);
    popover.style.left = `${Math.max(8, left)}px`;
    popover.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - popover.offsetHeight - 8)}px`;
    popover.querySelector('.admc-focus')?.scrollIntoView({ block: 'nearest' });
  }

  // Scrolls to the thread's badge and opens its popover. Returns false if the thread is not placed.
  function showThread(thread) {
    const hit = state.badgeByThread?.get(thread.id);
    if (!hit?.badge.isConnected) return false;
    hit.badge.scrollIntoView({ block: 'center' });
    openPopover(hit.badge, hit.threads, thread.id);
    return true;
  }

  // Leaves the popover open so re-renders caused by ADO or by writes keep the user's place.
  function clearMarks() {
    document.querySelectorAll('.admc-badge').forEach((n) => n.remove());
    document.querySelectorAll('.admc-anchored').forEach((n) => n.classList.remove('admc-anchored'));
  }

  function render(ctx, container) {
    clearMarks();
    const blocks = [...container.querySelectorAll(BLOCK_SELECTOR)].filter((b) => !isOurs(b));
    const lineMap = AdmcAnchor.mapLines(state.data.source, ownTexts(container, blocks));
    state.blocks = blocks;
    state.lineMap = lineMap;
    const byBlock = new Map();
    const placed = [];
    const unanchored = [];

    // state.data.threads is sorted by status rank, so per-block lists and the panel keep that order.
    for (const thread of state.data.threads) {
      const line = threadLine(thread);
      const index = line ? AdmcAnchor.blockForLine(lineMap, line) : -1;
      if (index === -1) {
        unanchored.push(thread);
        continue;
      }
      placed.push(thread);
      byBlock.set(blocks[index], [...(byBlock.get(blocks[index]) || []), thread]);
    }

    state.badgeByThread = new Map();
    for (const [block, threads] of byBlock) {
      block.classList.add('admc-anchored');
      const badge = el('button', `${ROOT_CLASS} admc-badge admc-rank-${Math.min(...threads.map(statusRank))}`, `💬 ${threads.length}`);
      badge.type = 'button';
      badge.dataset.lines = threads.map(threadLine).join(',');
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popover?.dataset.owner === String(threads[0].id)) return closePopover();
        openPopover(badge, threads);
      });
      (block.tagName === 'TR' ? block.lastElementChild || block : block).append(badge);
      threads.forEach((t) => state.badgeByThread.set(t.id, { badge, threads }));
    }

    state.anchored = byBlock.size;
    renderPanel(ctx, placed, unanchored);
  }

  function renderPanel(ctx, placed, unanchored) {
    if (!panel) {
      panel = el('div', `${ROOT_CLASS} admc-panel`);
      document.body.append(panel);
    }
    const open = panel.classList.contains('admc-open');
    panel.replaceChildren();

    const header = el('div', 'admc-panel-head');
    const toggle = el('button', 'admc-panel-toggle', state.error
      ? 'PR comments: failed to load'
      : `PR comments: ${placed.length + unanchored.length}${unanchored.length ? ` (${unanchored.length} not placed)` : ''}`);
    toggle.type = 'button';
    toggle.addEventListener('click', () => panel.classList.toggle('admc-open'));
    const refresh = el('button', 'admc-panel-refresh', '↻');
    refresh.type = 'button';
    refresh.title = 'Reload comments';
    refresh.addEventListener('click', () => { state.key = null; schedule(); });
    header.append(toggle, refresh);
    panel.append(header);

    const body = el('div', 'admc-panel-body');
    if (state.error) body.append(el('div', 'admc-content', state.error));
    for (const t of placed) {
      const item = el('button', 'admc-panel-item', `${t.status || 'unknown'} · line ${threadLine(t)} · ${t.comments[0].content || ''}`);
      item.type = 'button';
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        showThread(t);
      });
      body.append(item);
    }
    if (unanchored.length) {
      body.append(el('div', 'admc-muted admc-panel-section', 'Not placed in preview'));
      unanchored.forEach((t) => body.append(renderThread(ctx, t)));
    }
    panel.append(body);
    if (open) panel.classList.add('admc-open');
  }

  function teardown() {
    clearMarks();
    closePopover();
    hideAddButton();
    panel?.remove();
    panel = null;
    state.container = null;
  }

  // ---------------------------------------------------------------------------- New threads

  // Selecting text in the preview shows a "Comment" button. The new thread covers the whole
  // source lines of the rendered block where the selection starts.
  let addButton = null;

  function hideAddButton() {
    addButton?.remove();
    addButton = null;
  }

  // [first, last] source lines (1-based) mapped to the block, or null if none are.
  function linesForBlock(block) {
    const index = state.blocks?.indexOf(block) ?? -1;
    if (index === -1) return null;
    const lines = [];
    state.lineMap.forEach((b, i) => {
      if (b === index) lines.push(i + 1);
    });
    return lines.length ? [lines[0], lines[lines.length - 1]] : null;
  }

  function selectedBlock() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !state.container?.isConnected) return null;
    const start = selection.getRangeAt(0).startContainer;
    const block = (start instanceof Element ? start : start.parentElement)?.closest(BLOCK_SELECTOR);
    return block && state.container.contains(block) && !isOurs(block) ? block : null;
  }

  function onSelectionEnd(e) {
    if (e.target instanceof Element && isOurs(e.target)) return;
    hideAddButton();
    const block = state.data && selectedBlock();
    const lines = block && linesForBlock(block);
    if (!lines) return;
    const rect = getSelection().getRangeAt(0).getBoundingClientRect();
    addButton = el('button', `${ROOT_CLASS} admc-add`, '💬 Comment');
    addButton.type = 'button';
    addButton.style.left = `${Math.min(rect.right + 4, window.innerWidth - 120)}px`;
    addButton.style.top = `${Math.max(rect.top - 4, 8)}px`;
    addButton.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openNewThread(addButton, lines);
    });
    document.body.append(addButton);
  }

  function openNewThread(anchor, [first, last]) {
    closePopover();
    popover = el('div', `${ROOT_CLASS} admc-popover`);
    const box = el('div', 'admc-thread');
    box.append(el('div', 'admc-thread-head admc-muted', first === last ? `New comment on line ${first}` : `New comment on lines ${first}-${last}`));
    const input = el('textarea', 'admc-reply');
    box.append(composer(input, 'Comment', async (text) => {
      let thread;
      if (!(await write(box, async () => { thread = await addThread(state.ctx, first, last, text); }))) return;
      hideAddButton();
      closePopover();
      showThread(thread);
    }), el('div', 'admc-error'));
    popover.append(box);
    document.body.append(popover);
    const rect = anchor.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8))}px`;
    popover.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - popover.offsetHeight - 8)}px`;
    input.focus();
  }

  // ---------------------------------------------------------------------------- ADO file tree

  // ADO's file tree lists each thread as a row under its file row. Rows carry no thread ID, so a
  // row is matched by its text against this file's placed threads. Uses ARIA tree roles rather
  // than CSS classes.
  function threadForTreeRow(target) {
    const row = target instanceof Element && target.closest('[role="row"][aria-level]');
    if (!row || !row.closest('[role="treegrid"], [role="tree"]') || isOurs(row)) return null;
    if (!state.data || !state.container?.isConnected) return null;

    const level = Number(row.getAttribute('aria-level'));
    let fileRow = row.previousElementSibling;
    while (fileRow && Number(fileRow.getAttribute('aria-level')) >= level) fileRow = fileRow.previousElementSibling;
    if (!fileRow || !fileRow.textContent.includes(state.ctx.path.split('/').pop())) return null;

    const placed = state.data.threads.filter((t) => state.badgeByThread?.has(t.id));
    const index = AdmcAnchor.matchTreeRow(row.textContent, placed.map((t) => t.comments[0].content || ''));
    return index === -1 ? null : placed[index];
  }

  // Runs in the capture phase on window so ADO never sees the event and stays in Preview.
  // Threads that are not placed fall through to ADO's default diff view.
  function onTreeEvent(e) {
    const thread = threadForTreeRow(e.target);
    if (!thread) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click') showThread(thread);
  }

  // ---------------------------------------------------------------------------- Auto-preview

  // ADO's view split button reads "Raw content" or "Preview", and clicking it switches between the
  // two. While it reads "Raw content", click it. ADO can reset the view while the file loads, so
  // retry a few times. Stop for a file once the user clicks the split button themselves.
  // Only ADO's own toolbar button is clicked, never anything inside the author-controlled preview.
  const PREVIEW_ATTEMPTS = 5;
  const previewAttempts = new Map();
  const userPickedView = new Set();
  let lastPreviewClick = 0;

  function fileKeyOf(ctx) {
    return `${ctx.prUrl}|${ctx.path}`;
  }

  function autoPreview(ctx) {
    const fileKey = fileKeyOf(ctx);
    const attempts = previewAttempts.get(fileKey) || 0;
    if (userPickedView.has(fileKey) || attempts >= PREVIEW_ATTEMPTS || Date.now() - lastPreviewClick < 1000) return;
    const raw = [...document.querySelectorAll('.bolt-split-button button[aria-label="Raw content"]')]
      .find((b) => !isOurs(b) && !b.closest('[class*="markdown"]') && !state.container?.contains(b));
    if (!raw) return;
    previewAttempts.set(fileKey, attempts + 1);
    lastPreviewClick = Date.now();
    raw.click();
    setTimeout(schedule, 1100); // re-check even if ADO's reset causes no DOM mutation we observe
  }

  function onViewButtonClick(e) {
    if (!e.isTrusted || !(e.target instanceof Element) || !e.target.closest('.bolt-split-button')) return;
    const ctx = parseUrl();
    if (ctx) userPickedView.add(fileKeyOf(ctx));
  }

  // ---------------------------------------------------------------------------- Main loop

  async function tick() {
    const ctx = parseUrl();
    if (!ctx) return teardown();
    const key = JSON.stringify(ctx);
    if (key === state.key && state.broken) return;
    autoPreview(ctx);

    if (key !== state.key) {
      teardown();
      state = { key, ctx, data: null, error: null, container: null, broken: false };
      try {
        state.data = await load(ctx);
      } catch (e) {
        if (state.key !== key) return;
        state.error = String(e.message || e);
        console.warn('[ado-md-preview-comments]', e);
      }
      if (state.key !== key) return;
    }
    if (!state.data && !state.error) return; // load in flight

    const container = findPreview();
    if (!container) return teardown();
    // Skip when our marks are already in place; this also absorbs mutations caused by render().
    if (container === state.container && panel?.isConnected &&
        (!state.anchored || container.querySelector('.admc-badge'))) return;

    state.container = container;
    if (state.data) render(ctx, container);
    else renderPanel(ctx, [], []);
  }

  // Disables the extension for the current file after an unexpected error, leaving ADO untouched.
  function fail(e) {
    console.warn('[ado-md-preview-comments] disabled for this file after an error:', e);
    state.broken = true;
    try {
      teardown();
    } catch {
      // nothing left to clean up safely
    }
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(fail), 300);
  }

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(type, onTreeEvent, true);
  }
  document.addEventListener('click', onViewButtonClick, true);
  document.addEventListener('click', (e) => {
    if (popover && !popover.contains(e.target)) closePopover();
  });
  document.addEventListener('mouseup', (e) => setTimeout(() => {
    try {
      onSelectionEnd(e);
    } catch (err) {
      fail(err);
    }
  }));
  window.addEventListener('scroll', hideAddButton, true);
  // ADO is a single-page app; URL changes via pushState fire no event a content script can see.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      schedule();
    }
  }, 500);
  schedule();
})();
