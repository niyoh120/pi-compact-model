# pi-compact-model

Use a custom model for [pi](https://pi.dev) compaction instead of the active conversation model.

By default pi summarizes long conversations with the current model. This extension lets you point compaction at a cheaper/faster model (for example Gemini Flash) while keeping the exact same structured summary format — it reuses pi's own `compact()` and `generateBranchSummary()` functions and only swaps the model.

## What it covers

- Auto-compaction (when context exceeds the threshold)
- `/compact` manual compaction
- `/tree` branch summarization (only when you choose to summarize)

If anything goes wrong (no config, model not found, no API key, LLM error), the extension silently falls back to pi's default compaction, so it is safe to leave installed.

## Install

```bash
# from a git remote (after you publish)
pi install git:github.com/<you>/pi-compact-model

# or try locally without installing
pi -e ./extensions/compact-model.ts
```

## Usage

Open the settings-style menu:

```
/compact-model
```

The menu shows:

- `Effective model` — read-only; project config overrides global config
- `Project model` — saved in `.pi/compact-model.json`
- `Global model` — saved in `~/.pi/agent/compact-model.json`

Use Enter/Space to change the selected setting. Choose `pi default` to clear that scope. Press Esc to exit.

## Configuration

The extension reads `compact-model.json` with this precedence:

1. Project: `<cwd>/.pi/compact-model.json`
2. Global: `~/.pi/agent/compact-model.json`
3. If neither exists, pi's default compaction is used.

Format:

```json
{ "provider": "google", "model": "gemini-2.5-flash" }
```

`provider` and `model` are matched against pi's model registry (`provider/modelId`). The model must have auth configured (API key) the same way you would use it as a conversation model.

## How it works

- `session_before_compact` → calls pi's `compact(preparation, model, apiKey, headers, customInstructions, signal)` with your configured model and returns the result.
- `session_before_tree` → when you opt into a branch summary, calls pi's `generateBranchSummary(entries, { model, ... })` with your configured model.

Both produce pi's standard summary format (Goal / Constraints / Progress / Next Steps + tracked read/modified files). The only difference is which model runs the summarization.

A short notification is shown when a custom model is used, and a warning is shown (with fallback to default) on any failure.

## Notes

- Requires pi 0.78+ (relies on `compact` and `generateBranchSummary` being exported from `@earendil-works/pi-coding-agent`).
- Reentrancy is guarded so the extension never re-enters its own handlers.
