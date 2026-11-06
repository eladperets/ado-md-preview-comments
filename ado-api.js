// All network access of the extension lives in this file.
//
// - Every request goes to the current page's own origin (enforced in request()) and uses the
//   user's existing ADO session cookie. The extension never reads tokens and never sends data
//   anywhere else.
// - Reads:  PR iterations, PR comment threads, the markdown file's content, and the signed-in
//           user's ID (only used to show which comments they liked).
// - Writes: thread status, replies, comment likes, and new threads. content.js calls these only
//           from clicks or key presses in the extension's own UI.
// Uses the versioned Azure DevOps REST API 7.1 (Git pull request threads, iterations, items).
(function (root) {
  const API_VERSION = '7.1';

  async function request(url, method = 'GET', body) {
    if (new URL(url).origin !== location.origin) throw new Error(`Blocked request to another origin: ${url}`);
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      // Makes ADO return 401 instead of redirecting to the sign-in page.
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${method} ${new URL(url).pathname.split('/_apis/')[1]}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  function gitUrl(ctx, resource, params = {}) {
    return `${ctx.apiBase}/${resource}?${new URLSearchParams({ ...params, 'api-version': API_VERSION })}`;
  }

  function threadUrl(ctx, threadId, suffix = '') {
    return gitUrl(ctx, `pullRequests/${ctx.prId}/threads/${threadId}${suffix}`);
  }

  // Returns all PR threads (positions tracked to the iteration on screen), the file's source at
  // that iteration, and the signed-in user's ID (null if unavailable).
  async function loadFile(ctx) {
    const me = request(`${ctx.collectionUrl}/_apis/connectionData`).then((d) => d.authenticatedUser.id, () => null);
    const iterations = (await request(gitUrl(ctx, `pullRequests/${ctx.prId}/iterations`))).value;
    const iteration = iterations.find((i) => String(i.id) === ctx.iteration) || iterations[iterations.length - 1];

    const threadParams = { $iteration: iteration.id };
    if (ctx.base) threadParams.$baseIteration = ctx.base;
    const [threads, file] = await Promise.all([
      request(gitUrl(ctx, `pullRequests/${ctx.prId}/threads`, threadParams)),
      request(gitUrl(ctx, 'items', {
        path: ctx.path,
        'versionDescriptor.version': iteration.sourceRefCommit.commitId,
        'versionDescriptor.versionType': 'commit',
        includeContent: 'true',
      })),
    ]);
    return { threads: threads.value, source: file.content || '', iterationId: iteration.id, me: await me };
  }

  function setThreadStatus(ctx, threadId, status) {
    return request(threadUrl(ctx, threadId), 'PATCH', { status });
  }

  function addReply(ctx, threadId, parentCommentId, content) {
    return request(threadUrl(ctx, threadId, '/comments'), 'POST', { content, parentCommentId, commentType: 1 });
  }

  function setLike(ctx, threadId, commentId, liked) {
    return request(threadUrl(ctx, threadId, `/comments/${commentId}/likes`), liked ? 'POST' : 'DELETE');
  }

  // Creates an active thread on the file between start and end ({ line, offset }, 1-based) of the
  // given iteration. The iteration context and the file's change tracking ID let ADO show the
  // thread in its diff view and track it to later iterations.
  async function addThread(ctx, iterationId, start, end, content) {
    const changes = await request(gitUrl(ctx, `pullRequests/${ctx.prId}/iterations/${iterationId}/changes`, { $top: 2000 }));
    const change = changes.changeEntries.find((c) => c.item?.path === ctx.path);
    return request(gitUrl(ctx, `pullRequests/${ctx.prId}/threads`), 'POST', {
      comments: [{ parentCommentId: 0, content, commentType: 1 }],
      status: 1, // active
      threadContext: { filePath: ctx.path, rightFileStart: start, rightFileEnd: end },
      pullRequestThreadContext: change && {
        changeTrackingId: change.changeTrackingId,
        iterationContext: { firstComparingIteration: Number(ctx.base) || 1, secondComparingIteration: iterationId },
      },
    });
  }

  root.AdmcApi = { loadFile, setThreadStatus, addReply, setLike, addThread };
})(this);
