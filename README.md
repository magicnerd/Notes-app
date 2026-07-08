# Notes Performance App, sellable version

This is a multi-user version of the Notes performance app.

## What it includes

- Email/password auth using Supabase
- Activation code system
- Buyer dashboard
- User-owned rooms
- Performer links
- Helper links
- WebSocket live note sync
- WebSocket audio from performer to helper

## Required Render environment variables

SUPABASE_URL=your Supabase project URL
SUPABASE_ANON_KEY=your Supabase publishable key
SUPABASE_SERVICE_ROLE_KEY=your Supabase secret/service key
SESSION_SECRET=any long random string
APP_BASE_URL=https://your-render-url.onrender.com

## Render setup

Build command:

npm install

Start command:

npm start

## Default activation code

The SQL creates this shared code:

SEAL2026

You can change it in Supabase later.
