# Notes Performance App

Render-ready Notes-style PWA with live helper editing and WebSocket audio.

Changes in this build:
- Default note is blank.
- Performer note persists locally and is pushed back after restart.
- Audio attempts to recover after returning to the app.
- iOS may still pause browser audio if the screen locks or the app is backgrounded. The app will try to recover when foregrounded, but for performance reliability keep Low Power Mode off and Auto-Lock set to Never.
