# Notes Performance App, WebSocket Audio Version

This version uses WebSockets for both:

- live note syncing
- one-way microphone audio from performer to helper

It does **not** use WebRTC, so it avoids the call/ICE/TURN problems from the previous build.

## Render

Keep the same Render web service.

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

## Use

Performer:

```text
https://your-app.onrender.com
```

Helper:

```text
https://your-app.onrender.com/helper?key=YOUR_KEY
```

Recommended order:

1. Open helper and click Join Audio Room.
2. Open performer and arm microphone.
3. Helper should show chunks receiving and hear audio.
