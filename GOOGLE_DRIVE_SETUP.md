# Setting up Google Drive sync

This is a one-time setup, done once per person (not per device). Takes about 10 minutes.

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com
2. Click the project dropdown at the top → **New Project**
3. Name it anything (e.g. "Brainly Sync") → Create

## 2. Enable the Google Drive API

1. In the search bar at the top, search for **Google Drive API**
2. Click it, then click **Enable**

## 3. Configure the OAuth consent screen

1. In the left sidebar: **APIs & Services** → **OAuth consent screen**
2. User type: **External** → Create
3. Fill in: App name ("Brainly"), your email as User support email, your email again as Developer contact
4. Click through **Save and Continue** on the Scopes page (no changes needed)
5. On the **Test users** page, click **Add users** and add your own Gmail address
6. Save and Continue through the rest

**Important:** while your app is in "Testing" mode (the default, and totally fine for personal use), Google requires you to sign in again every 7 days. If that becomes annoying, you can later submit for verification — since this app only requests the low-risk `drive.file` scope, it's a light review, not the full security process.

## 4. Create the OAuth Client ID

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Name it anything
4. Under **Authorized JavaScript origins**, add the exact URL where you host Brainly, e.g. `https://yourusername.github.io` (no trailing slash, no path after it)
5. Click **Create**
6. Copy the **Client ID** shown (looks like `123456-abc.apps.googleusercontent.com`) — you don't need the client secret

## 5. Add the Client ID to the app

Open `app.js`, find this line near the top:

```js
const GOOGLE_CLIENT_ID = "YOUR_CLIENT_ID_HERE.apps.googleusercontent.com";
```

Replace the placeholder with your real Client ID, save, and redeploy.

## 6. Use it

Open Brainly on your first device → sidebar → **☁ Connect Google Drive** → sign in and approve. Do the same on your other device. From then on, saves happen locally instantly and also quietly push to a private file in your Drive (named `brainly-sync-data.json`) named `drive.file` scope — meaning this app can only ever see files it created itself, never anything else in your Drive.

**One real limitation to know:** if you edit the same note on two devices before they've had a chance to sync, whichever one saves *last* wins — there's no merging. The app will warn you if it detects another device made changes since your last sync, but it can't merge them for you.
