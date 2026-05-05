const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ASSISTANT_KEY = process.env.ASSISTANT_KEY || 'change-me-secret';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('service-worker.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('/helper', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'helper.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      note: 'Shopping list\n\n- Milk\n- Bread\n- Coffee',
      performer: null,
      assistant: null,
      clients: new Set()
    });
  }
  return rooms.get(roomId);
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload, except = null) {
  for (const client of room.clients) {
    if (client !== except) send(client, payload);
  }
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function presence(room) {
  return {
    type: 'presence',
    performerOnline: Boolean(room.performer && room.performer.readyState === WebSocket.OPEN),
    assistantOnline: Boolean(room.assistant && room.assistant.readyState === WebSocket.OPEN)
  };
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.role = null;

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (!msg || !msg.type) return;

    if (msg.type === 'join') {
      const roomId = String(msg.room || 'default').slice(0, 80);
      const role = msg.role === 'assistant' ? 'assistant' : 'performer';
      const room = getRoom(roomId);

      if (role === 'assistant' && msg.key !== ASSISTANT_KEY) {
        send(ws, { type: 'auth-error' });
        ws.close();
        return;
      }

      ws.roomId = roomId;
      ws.role = role;
      room.clients.add(ws);

      if (role === 'performer') room.performer = ws;
      if (role === 'assistant') room.assistant = ws;

      send(ws, {
        type: 'joined',
        role,
        room: roomId,
        note: room.note,
        performerOnline: Boolean(room.performer && room.performer.readyState === WebSocket.OPEN),
        assistantOnline: Boolean(room.assistant && room.assistant.readyState === WebSocket.OPEN)
      });

      broadcast(room, presence(room));
      return;
    }

    if (!ws.roomId) return;
    const room = getRoom(ws.roomId);

    if (msg.type === 'note-update' && ws.role === 'assistant') {
      room.note = String(msg.note ?? '').slice(0, 20000);
      broadcast(room, { type: 'note-update', note: room.note }, ws);
      return;
    }

    if (msg.type === 'prefill-note' && ws.role === 'performer') {
      room.note = String(msg.note ?? '').slice(0, 20000);
      broadcast(room, { type: 'note-update', note: room.note }, ws);
      return;
    }

    // WebRTC signalling for one-way private audio call.
    if (['call-offer', 'call-answer', 'call-candidate', 'call-ended', 'call-status'].includes(msg.type)) {
      const target = ws.role === 'performer' ? room.assistant : room.performer;
      send(target, { ...msg, from: ws.role });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = getRoom(ws.roomId);
    room.clients.delete(ws);
    if (room.performer === ws) room.performer = null;
    if (room.assistant === ws) room.assistant = null;
    broadcast(room, presence(room));
  });
});

server.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  console.log(`Assistant key: ${ASSISTANT_KEY}`);
});
