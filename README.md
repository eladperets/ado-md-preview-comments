# ADO PR Markdown Preview Comments

Chrome/Edge extension for Azure DevOps pull requests. ADO does not show comment threads when a markdown file is in **Preview**. This extension shows them there, and lets you reply, like comments, change thread status, and add comments.

## Install

The extension is not in the browser stores. Load it from source:

1. Clone or download this repository.
2. Open `edge://extensions` or `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and select the repository folder.

To update: get the latest files, select **Reload** on the extension card, and refresh the ADO tab.

## Use

Open a PR, go to **Files**, and select a `.md` file.

- **Auto-preview**: when a `.md` file opens in **Raw content** view (ADO does this for new files), the extension clicks ADO's view button to switch to **Preview**. If you switch back to Raw content, it stays. Edited files open in ADO's default view; select **Preview** yourself.
- A `💬 n` badge shows on each block that has threads. The color is the most urgent status in the block: red = active, yellow = pending, gray = resolved / won't fix / other, green = closed.
- Select a badge to see its threads. In each thread you can change the status, like a comment (👍), and reply (Ctrl+Enter to send).
- The panel at the bottom right lists the threads for the file. Threads that cannot be placed in the preview (for example, on lines that no longer exist) show in full in the panel. **↻** reloads the comments.
- Selecting a thread on ADO's file tree opens it in the preview.
- To add a comment, select text in the preview and select **💬 Comment**. The comment is added to the source lines of the block where the selection starts.

## How it works

- The extension runs only on `https://dev.azure.com/*` and `https://*.visualstudio.com/*`. It requests no other permissions.
- It calls the ADO REST API (7.1) on the same origin as the page, with your existing ADO session. It does not use tokens.
  - Reads: PR iterations, PR threads, the file content, the changed files of the iteration (when you add a comment), and your user ID (to show your likes).
  - Writes: thread status, replies, likes, and new threads. Only when you select or type in the extension's popover or panel.
- It matches each thread's line in the markdown source to a rendered block in the preview, and adds a badge to that block.
- It inserts text from ADO as plain text, not HTML.
- The only ADO control it clicks is the view button (auto-preview). It does not click anything in the rendered markdown.
- On an error, it removes its UI for the file and stops.

## Code

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest. |
| `ado-api.js` | All network requests. |
| `content.js` | Finds the preview, adds the badges, popover, and panel. |
| `anchor.js` | Text matching: markdown source lines to rendered blocks, and file tree rows to threads. |
| `content.css` | Styles. |

## Limits

- Comments are placed per block (paragraph, list item, heading, table row, code block), not per word.
- Comment text is shown as plain text, not rendered markdown.
- Auto-preview needs the English ADO UI.
- New comments cover the whole source lines of a block, not the exact selected text.

## Tests

```
node --test test
```

## License

MIT. See [LICENSE](LICENSE).

This is a personal project. It is not affiliated with or endorsed by Microsoft. Azure DevOps is a trademark of Microsoft Corporation.
