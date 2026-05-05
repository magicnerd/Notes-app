# Notes Private Call App

A Render-ready Node app with:

- iOS Notes style dark performer UI
- private helper page at `/helper`
- live note syncing
- one-way WebRTC audio call from performer to helper
- explicit performer consent before microphone access
- PWA support for iPhone Add to Home Screen

## Local run

```bash
npm install
npm start
```

Open:

- Performer: http://localhost:3000
- Helper: http://localhost:3000/helper

## Render

Use the same existing Render Web Service.

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Environment variable:

```text
ASSISTANT_KEY=your-private-key
```

## Usage order

1. Open helper page.
2. Enter the same room code as performer.
3. Enter the assistant key.
4. Click Join Private Call.
5. Open performer page on iPhone.
6. Allow microphone and arm the performance.
7. Helper should hear audio. Helper can edit the note live.
