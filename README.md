# Notes Performance App, Render Version

A consent-armed, Notes-style PWA with:

- iOS Notes dark-mode performer interface
- full black lock screen
- assistant page at `/helper`
- WebSocket note syncing
- WebRTC one-way audio after the performer confirms microphone setup
- Render-ready deployment

## Run locally

Install Node.js LTS first.

```bash
npm install
npm start
```

Open:

- Performer: `http://localhost:3000`
- Assistant: `http://localhost:3000/helper`

Default local assistant key:

```text
change-me-secret
```

## Deploy on Render

1. Make a GitHub repo and upload this folder.
2. Go to Render.
3. Create a new Web Service.
4. Connect the GitHub repo.
5. Use these settings:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
6. Add environment variable:
   - `ASSISTANT_KEY=your-secret-key`
7. Deploy.

After deployment, use:

- Performer: `https://your-app-name.onrender.com`
- Assistant: `https://your-app-name.onrender.com/helper`

The helper can also prefill fields from the URL:

```text
https://your-app-name.onrender.com/helper?room=abc123&key=your-secret-key
```

## iPhone PWA setup

1. Open the performer link in Safari on the iPhone.
2. Tap Share.
3. Tap Add to Home Screen.
4. Launch it from the new Notes icon.
5. Before performance, tap Confirm and arm so the microphone permission is already handled.

## Use during performance

1. Performer opens the PWA.
2. Performer confirms the audio setup before the routine.
3. Assistant opens `/helper`, enters the same room and secret key.
4. Assistant edits the note live.
5. Performer taps the hidden bottom-right zone, or triple-taps near the bottom-right, to enter black screen.
6. Tap the black screen to reveal the note.

## Important reliability notes

- Render free hosting can sleep after inactivity. Open both pages before performance so it wakes up.
- Paid Render is better for real shows.
- WebRTC may fail on some strict networks. Test with the exact devices and network before relying on it.
