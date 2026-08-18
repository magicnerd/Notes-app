const code = new URLSearchParams(location.search).get('room') || '';

let ws;
let mediaStream = null;
let audioCtx = null;
let sourceNode = null;
let processor = null;
let micOn = false;
let noteCache = localStorage.getItem('lastNote') || '';
let showingFake = false;

const fakeNotes = {
  ideas: 'Ideas\n\n- Film a clean close-up performance\n- Practice the opener slower\n- Update business card wording\n- Try one routine with no cards',
  shopping: 'Shopping\n\n- Milk\n- Bread\n- Coffee\n- Eggs'
};

const $ = (s) => document.querySelector(s);

$('#startNote').value = noteCache;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', role: 'performer', code }));
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);

    if (m.type === 'joined') {
      setConn('Connected', true);
      if (m.room.current_note) {
        setRealNote(m.room.current_note);
      } else if ($('#startNote').value.trim()) {
        sendNote($('#startNote').value);
      }
    }

    if (m.type === 'note-update') {
      setRealNote(m.note);
      if (!showingFake) $('#note').value = m.note;
    }

    if (m.type === 'presence') {
      // Kept internally for debugging, but hidden from the performer screen.
      setConn(`P:${m.performers} H:${m.helpers}`, true);
    }

    if (m.type === 'error') setConn(m.error, false);
  };

  ws.onclose = () => {
    setConn('Reconnecting...', false);
    setTimeout(connect, 1000);
  };
}

function setConn(t, ok) {
  $('#conn').textContent = t;
  $('#conn').className = ok ? 'status ok' : 'status bad';
  $('#setupStatus').textContent = t;
}

function setRealNote(t) {
  noteCache = t;
  localStorage.setItem('lastNote', t);
}

function sendNote(t) {
  showingFake = false;
  setRealNote(t);
  $('#note').value = t;
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'note-update', note: t }));
}

async function start(withMic) {
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  showRealNote();
  connect();
  if (withMic) await startMic();
}

async function startMic() {
  try {
    await stopMic(false);

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!micOn || ws?.readyState !== 1 || !audioCtx) return;

      const input = e.inputBuffer.getChannelData(0);
      const pcm = downsample(input, audioCtx.sampleRate, 16000);
      const bytes = new Uint8Array(pcm.buffer);
      let binary = '';
      const chunk = 0x8000;

      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }

      ws.send(JSON.stringify({
        type: 'audio-pcm',
        sampleRate: 16000,
        data: btoa(binary)
      }));
    };

    sourceNode.connect(processor);
    processor.connect(audioCtx.destination);

    micOn = true;
    $('#doneBtn').textContent = 'Done';
    sendAudioStatus(true);
  } catch (e) {
    setConn('Mic blocked or unavailable', false);
    await stopMic(true);
  }
}

function downsample(buffer, from, to) {
  if (from === to) {
    const out = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      out[i] = Math.max(-1, Math.min(1, buffer[i])) * 32767;
    }
    return out;
  }

  const ratio = from / to;
  const len = Math.round(buffer.length / ratio);
  const out = new Int16Array(len);
  let pos = 0;

  for (let i = 0; i < len; i++) {
    const next = Math.round((i + 1) * ratio);
    let sum = 0;
    let c = 0;

    for (; pos < next && pos < buffer.length; pos++) {
      sum += buffer[pos];
      c++;
    }

    out[i] = Math.max(-1, Math.min(1, sum / (c || 1))) * 32767;
  }

  return out;
}

function sendAudioStatus(on = micOn) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'audio-status', on: !!on }));
}

async function stopMic(notify = true) {
  micOn = false;

  try {
    if (processor) processor.disconnect();
  } catch {}
  try {
    if (sourceNode) sourceNode.disconnect();
  } catch {}

  processor = null;
  sourceNode = null;

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  if (audioCtx) {
    const oldCtx = audioCtx;
    audioCtx = null;
    try {
      if (oldCtx.state !== 'closed') await oldCtx.close();
    } catch {}
  }

  $('#doneBtn').textContent = 'Edit';
  if (notify) sendAudioStatus(false);
}

function showRealNote() {
  showingFake = false;
  $('#list').classList.add('hidden');
  $('#noteView').classList.remove('hidden');
  $('#note').readOnly = false;
  $('#note').value = noteCache;
  $('#doneBtn').style.visibility = 'visible';
}

function showFakeNote(which) {
  showingFake = true;
  $('#list').classList.add('hidden');
  $('#noteView').classList.remove('hidden');
  $('#note').readOnly = true;
  $('#note').value = fakeNotes[which] || '';
  $('#doneBtn').style.visibility = 'hidden';
}

$('#startBtn').onclick = () => start(true);
$('#noMicBtn').onclick = () => start(false);

$('#note').oninput = (e) => {
  if (!showingFake) sendNote(e.target.value);
};

$('#doneBtn').onclick = async () => {
  if (micOn) {
    await stopMic(true);
  } else {
    await startMic();
  }
};

$('#backBtn').onclick = () => {
  showingFake = false;
  $('#noteView').classList.add('hidden');
  $('#list').classList.remove('hidden');
  $('#doneBtn').style.visibility = 'visible';
};

$('#openReal').onclick = showRealNote;
$('#openIdeas').onclick = () => showFakeNote('ideas');
$('#openShopping').onclick = () => showFakeNote('shopping');

let taps = 0;
document.body.addEventListener('click', (e) => {
  if (e.target.closest('button,textarea,.listItem')) return;
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

window.addEventListener('beforeunload', () => {
  stopMic(true);
});
