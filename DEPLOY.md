# MMS Library — Installable App

This folder is a complete, installable Progressive Web App (PWA). It talks to your
existing Google Sheet through your Apps Script project's new JSON API — it does not
store or duplicate any data itself.

## 1. Deploy the updated Apps Script backend first

Use the files from `MMS_LIBRARIAN_updated.zip`:

1. Replace the files in `D:\MMS LIBRARIAN` with these.
2. `clasp push` from that folder.
3. In the Apps Script editor: **Deploy → Manage deployments → Edit (pencil) → New version → Deploy**.
4. Copy the Web App URL shown (it ends in `/exec`).

## 2. Connect the app to your backend

Open `config.js` in this folder and replace the placeholder:

```js
const API_URL = "PASTE_YOUR_DEPLOYED_WEB_APP_URL_HERE";
```

with the URL you copied, e.g.:

```js
const API_URL = "https://script.google.com/macros/s/AKfycb.../exec";
```

## 3. Publish to GitHub Pages

1. Create a new GitHub repository (e.g. `mms-library-app`).
2. Push everything in this folder to it (`index.html`, `app.js`, `styles.css`,
   `config.js`, `manifest.json`, `service-worker.js`, and the `icons/` folder).
3. In the repo: **Settings → Pages → Deploy from a branch → main → / (root)**.
4. GitHub gives you a URL like `https://<your-username>.github.io/mms-library-app/`.

## 4. Install it

Open that URL on a phone or laptop:

- **Android (Chrome):** menu (⋮) → **Install app** / **Add to Home screen**.
- **iPhone (Safari):** Share icon → **Add to Home Screen**.
- **Desktop (Chrome/Edge):** an **install icon** appears in the address bar → **Install**.

It will then open in its own window with its own icon, with no browser bar — like a
normal installed app.

## Notes

- The app works offline for its own screens (shell), but attendance/reports/reading
  data always needs a live connection, since that lives in your Google Sheet.
- If you ever redeploy the Apps Script backend and get a **new** Web App URL, update
  `config.js` and push again — the app itself doesn't need to change.
