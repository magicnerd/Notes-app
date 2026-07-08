const code = new URLSearchParams(location.search).get('room') || '';
let ws, mediaStream, audioCtx, processor, micOn = false;
let realNoteCache = localStorage.getItem('lastNote') || '';
let viewingReal = true;

const $ = s => document.querySelector(s);
const fakeNotes = {
  ideas: 'Ideas\n\n- Opening line for walkaround\n- New card handling\n- Test this at dinner\n- Record quick demo later',
  shopping: 'Shopping\n\n- Milk\n- Bread\n- Coffee\n- Eggs'
};

$('#startNote').value = realNoteCache;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', role: 'performer', code }));

  ws.onmessage = e => {
    const m = JSON.parse(e.data);

    if (m.type === 'joined') {
      setConn('Connected', true);
      if (m.room.current_note) {
        receiveRealNote(m.room.current_note);
      } else if ($('#startNote').value.trim()) {
        sendNote($('#startNote').value);
      }
    }

    if (m.type === 'note-update') receiveRealNote(m.note);
    if (m.type === 'presence') setConn('', true);
    if (m.type === 'error') setConn(m.error, false);
  };

  ws.onclose = () => {
    setConn('Reconnecting...', false);
    setTimeout(connect, 1000);
  };
}

function setConn(t, ok) {
  const conn = $('#conn');
  conn.textContent = t;
  conn.className = ok ? 'status ok' : 'status bad';
  conn.style.display = 'none';
  $('#setupStatus').textContent = t;
}

function receiveRealNote(t) {
  realNoteCache = t || '';
  localStorage.setItem('lastNote', realNoteCache);
  if (viewingReal) $('#note').value = realNoteCache;
}

function showRealNote() {
  viewingReal = true;
  $('#note').value = realNoteCache;
  $('#list').classList.add('hidden');
  $('#noteView').classList.remove('hidden');
}

function showFakeNote(which) {
  viewingReal = false;
  $('#note').value = fakeNotes[which] || '';
  $('#list').classList.add('hidden');
  $('#noteView').classList.remove('hidden');
}

function sendNote(t) {
  receiveRealNote(t);
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'note-update', note: t }));
}

async function start(withMic) {
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  receiveRealNote($('#startNote').value || realNoteCache || '');
  connect();
  if (withMic) await startMic();
}

async function startMic() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(mediaStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = e => {
      if (!micOn || ws?.readyState !== 1) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = downsample(input, audioCtx.sampleRate, 16000);
      ws.send(JSON.stringify({
        type: 'audio-pcm',
        sampleRate: 16000,
        data: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)))
      }));
    };

    src.connect(processor);
    processor.connect(audioCtx.destination);
    micOn = true;
    sendAudioStatus();
  } catch (e) {
    setConn('Mic blocked or unavailable', false);
  }
}

function downsample(buffer, from, to) {
  if (from === to) {
    const out = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) out[i] = Math.max(-1, Math.min(1, buffer[i])) * 32767;
    return out;
  }

  const ratio = from / to;
  const len = Math.round(buffer.length / ratio);
  const out = new Int16Array(len);
  let pos = 0;

  for (let i = 0; i < len; i++) {
    const next = Math.round((i + 1) * ratio);
    let sum = 0, c = 0;
    for (; pos < next && pos < buffer.length; pos++) {
      sum += buffer[pos];
      c++;
    }
    out[i] = Math.max(-1, Math.min(1, sum / (c || 1))) * 32767;
  }
  return out;
}

function sendAudioStatus() {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'audio-status', on: micOn }));
}

function stopMic() {
  micOn = false;
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
  sendAudioStatus();
}

$('#startBtn').onclick = () => start(true);
$('#noMicBtn').onclick = () => start(false);

$('#note').oninput = e => {
  if (viewingReal) sendNote(e.target.value);
};

$('#doneBtn').onclick = async () => {
  if (micOn) {
    stopMic();
    $('#doneBtn').textContent = 'Edit';
  } else {
    await startMic();
    $('#doneBtn').textContent = 'Done';
  }
};

$('#backBtn').onclick = () => {
  $('#noteView').classList.add('hidden');
  $('#list').classList.remove('hidden');
};

$('#openReal').onclick = showRealNote;
$('#openIdeas').onclick = () => showFakeNote('ideas');
$('#openShopping').onclick = () => showFakeNote('shopping');

let taps = 0;
document.body.addEventListener('click', e => {
  if (e.target.closest('button,textarea')) return;
  taps++;
  setTimeout(() => taps = 0, 500);
  if (taps >= 3) {
    $('#black').classList.toggle('hidden');
    taps = 0;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ws?.readyState !== 1) connect();
});
