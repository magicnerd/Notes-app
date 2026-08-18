const code = new URLSearchParams(location.search).get('room') || '';

let ws;
let audioCtx;
let nextTime = 0;
let audioEnabled = false;
let lastAudioStatus = false;
let currentSessionId = null;
const activeSources = new Set();

const $ = s => document.querySelector(s);

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', role: 'helper', code }));
  };

  ws.onmessage = e => {
    const m = JSON.parse(e.data);

    if (m.type === 'joined') {
      status(`Connected to ${m.room.name}`, true);
      $('#note').value = m.room.current_note || '';
      resetAudioQueue('joined');
    }

    if (m.type === 'presence') {
      status(`Performer ${m.performers ? 'online' : 'offline'} · Helpers ${m.helpers}`, !!m.performers);
    }

    if (m.type === 'note-update') {
      $('#note').value = m.note;
    }

    if (m.type === 'audio-reset') {
      currentSessionId = m.sessionId || null;
      resetAudioQueue('reset');
    }

    if (m.type === 'audio-status') {
      $('#light').classList.toggle('on', m.on);

      if (m.sessionId && m.sessionId !== currentSessionId) {
        currentSessionId = m.sessionId;
        resetAudioQueue('new-session');
      }

      if (m.on !== lastAudioStatus) {
        resetAudioQueue(m.on ? 'unmuted' : 'muted');
      }

      lastAudioStatus = !!m.on;
    }

    if (m.type === 'audio-pcm') {
      play(m);
    }

    if (m.type === 'error') {
      status(m.error, false);
    }
  };

  ws.onclose = () => {
    status('Reconnecting...', false);
    resetAudioQueue('socket-close');
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

document.querySelectorAll('[data-t]').forEach(b => {
  b.onclick = () => {
    $('#note').value = b.dataset.t;
    $('#note').focus();
    sendNote();
  };
});

$('#audioBtn').onclick = async () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  }

  await audioCtx.resume();
  audioEnabled = true;
  resetAudioQueue('enable-audio');
  $('#audioBtn').textContent = 'Audio enabled';
};

function resetAudioQueue(reason = '') {
  for (const src of activeSources) {
    try { src.stop(0); } catch {}
    try { src.disconnect(); } catch {}
  }
  activeSources.clear();

  if (audioCtx) {
    nextTime = audioCtx.currentTime + 0.03;
  } else {
    nextTime = 0;
  }
}

function play(m) {
  if (!audioEnabled || !audioCtx) return;

  if (m.sessionId && m.sessionId !== currentSessionId) {
    currentSessionId = m.sessionId;
    resetAudioQueue('chunk-new-session');
  }

  const now = audioCtx.currentTime;

  // Never let queued audio build up. Snap back to live if it drifts.
  if (!nextTime || nextTime < now + 0.01 || nextTime > now + 0.35) {
    resetAudioQueue('latency-snap');
  }

  const bytes = Uint8Array.from(atob(m.data), c => c.charCodeAt(0));
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

  src.start(nextTime);
  nextTime += buf.duration;
}

connect();
