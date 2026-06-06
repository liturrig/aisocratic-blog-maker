# AI Socratic Blog Maker

Browser editor for AI Socratic blog posts built with React, TypeScript, and Vite.

## Local development

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run lint
npm run build
```

## Storage model

- Projects are stored locally in the browser with IndexedDB.
- The working copy is auto-saved after a short debounce.
- Export creates a JSON backup that can be imported on the same or another device.
- No remote storage or Supabase configuration is required.

## Typical workflow

1. Load an `aisocratic.org` blog post
2. Edit sections and stories
3. Let the browser autosave locally, or click **Save**
4. Export a JSON backup when you want a portable copy

## Deployment

The GitHub Pages workflow builds the static app and deploys `dist/`.
No repository secrets are required for the current local-only setup.
