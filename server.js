import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Missing Supabase env vars. Add SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const liveRooms = new Map();
function getLiveRoom(roomId) {
  if (!liveRooms.has(roomId)) {
    liveRooms.set(roomId, { performers: new Set(), helpers: new Set(), note: '', audioOn: false });
  }
  return liveRooms.get(roomId);
}

function randCode(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('base64url').toUpperCase();
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    current_note: room.current_note || '',
    performer_code: room.performer_code,
    helper_code: room.helper_code,
    performer_url: `${APP_BASE_URL}/performer.html?room=${encodeURIComponent(room.performer_code)}`,
    helper_url: `${APP_BASE_URL}/helper.html?room=${encodeURIComponent(room.helper_code)}`,
    created_at: room.created_at
  };
}

async function getUserFromReq(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing login token.' });
    return null;
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: 'Invalid login token.' });
    return null;
  }
  return data.user;
}

app.get('/config', (req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

app.get('/api/me', async (req, res) => {
  const user = await getUserFromReq(req, res);
  if (!user) return;
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  const { data: rooms, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('owner_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: { id: user.id, email: user.email }, profile, rooms: (rooms || []).map(publicRoom) });
});

app.post('/api/activate', async (req, res) => {
  const user = await getUserFromReq(req, res);
  if (!user) return;
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter an activation code.' });

  const { data: activation, error: codeErr } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', code)
    .eq('active', true)
    .maybeSingle();

  if (codeErr) return res.status(500).json({ error: codeErr.message });
  if (!activation) return res.status(400).json({ error: 'That code is not valid.' });
  if (activation.current_uses >= activation.max_uses) return res.status(400).json({ error: 'That code has no uses left.' });

  const { data: existing } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (existing?.activated) {
    return res.json({ ok: true, message: 'Account already activated.' });
  }

  const { error: profileErr } = await supabase
    .from('user_profiles')
    .upsert({ id: user.id, email: user.email, activated: true, activation_code: code }, { onConflict: 'id' });
  if (profileErr) return res.status(500).json({ error: profileErr.message });

  const { error: useErr } = await supabase
    .from('activation_codes')
    .update({ current_uses: activation.current_uses + 1 })
    .eq('id', activation.id);
  if (useErr) return res.status(500).json({ error: useErr.message });

  res.json({ ok: true });
});

async function requireActivated(req, res) {
  const user = await getUserFromReq(req, res);
  if (!user) return null;
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile?.activated) {
    res.status(403).json({ error: 'Account not activated yet.' });
    return null;
  }
  return user;
}

app.post('/api/rooms', async (req, res) => {
  const user = await requireActivated(req, res);
  if (!user) return;
  const name = String(req.body.name || 'Performance Room').trim().slice(0, 80) || 'Performance Room';
  const room = {
    owner_id: user.id,
    name,
    performer_code: randCode('P-'),
    helper_code: randCode('H-'),
    current_note: ''
  };
  const { data, error } = await supabase.from('rooms').insert(room).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: publicRoom(data) });
});

app.post('/api/rooms/:id/reset-codes', async (req, res) => {
  const user = await requireActivated(req, res);
  if (!user) return;
  const { data, error } = await supabase
    .from('rooms')
    .update({ performer_code: randCode('P-'), helper_code: randCode('H-') })
    .eq('id', req.params.id)
    .eq('owner_id', user.id)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: publicRoom(data) });
});

app.delete('/api/rooms/:id', async (req, res) => {
  const user = await requireActivated(req, res);
  if (!user) return;
  const { error } = await supabase
    .from('rooms')
    .update({ active: false })
    .eq('id', req.params.id)
    .eq('owner_id', user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

async function findRoomByCode(code, role) {
  const col = role === 'performer' ? 'performer_code' : 'helper_code';
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq(col, code)
    .eq('active', true)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(roomState, obj, except = null) {
  for (const ws of [...roomState.performers, ...roomState.helpers]) {
    if (ws !== except) send(ws, obj);
  }
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.role = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      const role = msg.role === 'helper' ? 'helper' : 'performer';
      const code = String(msg.code || '').trim();
      const room = await findRoomByCode(code, role);
      if (!room) {
        send(ws, { type: 'error', error: 'Invalid or inactive room link.' });
        ws.close();
        return;
      }
      ws.roomId = room.id;
      ws.role = role;
      const state = getLiveRoom(room.id);
      state.note = room.current_note || state.note || '';
      if (role === 'helper') state.helpers.add(ws); else state.performers.add(ws);
      send(ws, { type: 'joined', role, room: { name: room.name, current_note: state.note } });
      broadcast(state, { type: 'presence', performers: state.performers.size, helpers: state.helpers.size, audioOn: state.audioOn });
      return;
    }

    if (!ws.roomId || !ws.role) return;
    const state = getLiveRoom(ws.roomId);

    if (msg.type === 'note-update') {
      const note = String(msg.note || '').slice(0, 20000);
      state.note = note;
      broadcast(state, { type: 'note-update', note });
      supabase.from('rooms').update({ current_note: note }).eq('id', ws.roomId).then(() => {});
      return;
    }

    if (msg.type === 'audio-status' && ws.role === 'performer') {
      state.audioOn = !!msg.on;
      broadcast(state, { type: 'audio-status', on: state.audioOn }, ws);
      return;
    }

    if (msg.type === 'audio-pcm' && ws.role === 'performer') {
      for (const helper of state.helpers) send(helper, { type: 'audio-pcm', sampleRate: msg.sampleRate || 16000, data: msg.data });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const state = getLiveRoom(ws.roomId);
    state.performers.delete(ws);
    state.helpers.delete(ws);
    broadcast(state, { type: 'presence', performers: state.performers.size, helpers: state.helpers.size, audioOn: state.audioOn });
  });
});

server.listen(PORT, () => {
  console.log(`Notes Performance App running on ${PORT}`);
});
