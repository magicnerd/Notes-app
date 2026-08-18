const code = new URLSearchParams(location.search).get('room') || '';

let ws;
let audioCtx = null;
let nextTime = 0;
let audioEnabled = false;
let activeSources = new Set();
let lastAudioStatus = false;

const MAX_LEAD_SECONDS = 0.45;
const START_BUFFER_SECONDS = 0.035;

const $ = (s) => document.querySelector(s);

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', role: 'helper', code }));
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);

    if (m.type === 'joined') {
      status(`Connected to ${m.room.name}`, true);
      $('#note').value = m.room.current_note || '';
    }

    if (m.type === 'presence') {
      status(`Performer ${m.performers ? 'online' : 'offline'} · Helpers ${m.helpers}`, !!m.performers);
    }

    if (m.type === 'note-update') {
      $('#note').value = m.note;
    }

    if (m.type === 'audio-status') {
      lastAudioStatus = !!m.on;
      $('#light').classList.toggle('on', lastAudioStatus);

      // Critical latency fix:
      // whenever the performer mutes or unmutes, dump anything queued.
      resetAudioQueue();
    }

    if (m.type === 'audio-pcm') {
      play(m);
    }

    if (m.type === 'error') status(m.error, false);
  };

  ws.onclose = () => {
    status('Reconnecting...', false);
    resetAudioQueue();
    setTimeout(connect, 1000);
  };
}

function status(t, ok) {
  $('#status').textContent = t;
  $('#status').className = ok ? 'status ok' : 'status bad';
}

function sendNote() {
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'note-update', note: $('#note').value }));
  }
}

$('#note').addEventListener('input', sendNote);

$('#clearBtn').onclick = () => {
  $('#note').value = '';
  sendNote();
};

document.querySelectorAll('[data-t]').forEach((b) => {
  b.onclick = () => {
    $('#note').value = b.dataset.t;
    $('#note').focus();
    sendNote();
  };
});

$('#audioBtn').onclick = async () => {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  audioEnabled = true;
  resetAudioQueue();
  $('#audioBtn').textContent = 'Audio enabled';
};

function resetAudioQueue() {
  if (audioCtx) nextTime = audioCtx.currentTime + START_BUFFER_SECONDS;
  else nextTime = 0;

  for (const src of activeSources) {
    try { src.stop(0); } catch {}
    try { src.disconnect(); } catch {}
  }

  activeSources.clear();
}

async function play(m) {
  if (!audioEnabled || !audioCtx) return;

  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { return; }
  }

  // If the performer is muted, never let leftover chunks build a queue.
  if (!lastAudioStatus) {
    resetAudioQueue();
    return;
  }

  const now = audioCtx.currentTime;

  // If audio has drifted into a delayed queue, kill the queue and restart near-live.
  if (!nextTime || nextTime < now || nextTime - now > MAX_LEAD_SECONDS) {
    resetAudioQueue();
  }

  const bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer);
  const buf = audioCtx.createBuffer(1, pcm.length, m.sampleRate || 16000);
  const ch = buf.getChannelData(0);

  for (let i = 0; i < pcm.length; i++) {
    ch[i] = pcm[i] / 32768;
  }

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);

  activeSources.add(src);
  src.onended = () => {
    activeSources.delete(src);
    try { src.disconnect(); } catch {}
  };

  const startAt = Math.max(nextTime, audioCtx.currentTime + START_BUFFER_SECONDS);
  src.start(startAt);
  nextTime = startAt + buf.duration;

  // Hard cap: never let queue grow beyond near-live.
  if (nextTime - audioCtx.currentTime > MAX_LEAD_SECONDS) {
    resetAudioQueue();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audioCtx && audioEnabled) {
    audioCtx.resume().then(resetAudioQueue).catch(() => {});
  }
});

connect();
