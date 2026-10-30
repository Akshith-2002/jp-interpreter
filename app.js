import Anthropic from './vendor/anthropic.js';

const MODEL = 'claude-haiku-5-5';
const LANGS = {
  en: { code: 'en-US', name: 'English', speaker: 'Visitor (English)' },
  ja: { code: 'ja-JP', name: 'Japanese', speaker: 'Japanese guest' },
};
const SYSTEM = `You are a live interpreter at a trade expo in Japan. One side is a senior executive of a travel and tourism company speaking English; the other side is a Japanese business contact (exhibitor, partner, or visitor).

Translate the text you are given into the requested target language. Rules:
- Output ONLY the translation. No quotes, notes, romaji, or explanations.
- Japanese output: natural, polite business Japanese (です／ます, with appropriate 敬語), warm but not stiff, as a professional interpreter would say it aloud.
- English output: natural, clear, concise English.
- The input comes from speech recognition and may contain mis-heard words or missing punctuation; translate what the speaker most likely meant.
- Keep names, company names, numbers, prices, dates and times exact.
- Earlier conversation is provided only as context for pronouns and terminology; translate only the new text.`;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const settings = {
  key: store.get('apiKey', ''),
  speak: store.get('autoSpeak', true),
  rate: store.get('rate', 0.95),
};
let history = store.get('history', []);
let client = null;
let typeLang = 'en';

function getClient() {
  if (!settings.key) throw new Error('Add your API key in Settings (⚙︎).');
  if (!client) client = new Anthropic({ apiKey: settings.key, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 20000 });
  return client;
}

// ---------- Translation ----------
// Lowest latency: no thinking, low effort.
const FAST = { thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
let fast = true;

async function runStream(params, onDelta) {
  const stream = getClient().messages.stream(params);
  stream.on('text', onDelta);
  return stream.finalMessage();
}

async function translate(text, from, onDelta) {
  const to = from === 'en' ? 'ja' : 'en';
  const context = history.slice(-6).filter((h) => h.dst)
    .map((h) => `${LANGS[h.from].speaker}: ${h.src}`).join('\n');
  const prompt = (context ? `<earlier_conversation>\n${context}\n</earlier_conversation>\n\n` : '')
    + `Translate from ${LANGS[from].name} to ${LANGS[to].name}:\n<text>\n${text}\n</text>`;

  const params = {
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  };
  let msg;
  try {
    msg = await runStream(fast ? { ...params, ...FAST } : params, onDelta);
  } catch (err) {
    // If the API ever rejects the speed settings, fall back to defaults for the rest of the session.
    if (!(fast && err instanceof Anthropic.BadRequestError)) throw err;
    fast = false;
    msg = await runStream(params, onDelta);
  }
  if (msg.stop_reason === 'refusal') throw new Error('Could not translate this phrase. Please rephrase.');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function errorText(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'API key rejected. Check it in Settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Too many requests. Wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'No internet connection. Check Wi-Fi / mobile data.';
  if (err instanceof Anthropic.APIError) return `Translation service error (${err.status ?? '?'}). Try again.`;
  return err?.message || 'Something went wrong.';
}

// ---------- Speech output ----------
let voices = [];
const loadVoices = () => { voices = window.speechSynthesis?.getVoices() ?? []; };
loadVoices();
window.speechSynthesis?.addEventListener?.('voiceschanged', loadVoices);

function pickVoice(code) {
  const norm = (l) => l.replace('_', '-');
  const same = voices.filter((v) => norm(v.lang) === code);
  const family = voices.filter((v) => norm(v.lang).startsWith(code.slice(0, 2)));
  const good = (list) => list.find((v) => /premium|enhanced|siri/i.test(v.name));
  return good(same) || same[0] || good(family) || family[0] || null;
}

function speak(text, lang) {
  if (!window.speechSynthesis || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANGS[lang].code;
  const v = pickVoice(u.lang);
  if (v) u.voice = v;
  u.rate = settings.rate;
  speechSynthesis.speak(u);
}

let speechUnlocked = false;
function unlockSpeech() {
  // iOS only allows speech after a user gesture; prime it once.
  if (speechUnlocked || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
  speechUnlocked = true;
}

// ---------- Conversation log ----------
function renderCard(entry) {
  $('empty').classList.add('hidden');
  const to = entry.from === 'en' ? 'ja' : 'en';
  const card = document.createElement('div');
  card.className = `card from-${entry.from}`;
  card.innerHTML = '<div class="src"></div><div class="dst"></div><div class="row"><button data-a="show">Show</button><button data-a="speak">🔊</button></div>';
  card.querySelector('.src').textContent = entry.src;
  const dst = card.querySelector('.dst');
  dst.textContent = entry.dst || '';
  card.querySelector('[data-a=speak]').onclick = () => { unlockSpeech(); speak(entry.dst, to); };
  card.querySelector('[data-a=show]').onclick = () => openShow(entry);
  $('log').appendChild(card);
  scrollDown();
  return dst;
}
const scrollDown = () => { const log = $('log'); log.scrollTop = log.scrollHeight; };

function saveHistory() {
  history = history.slice(-60);
  store.set('history', history.filter((h) => h.dst));
}

async function handle(text, from) {
  const entry = { src: text, from, dst: '' };
  const dst = renderCard(entry);
  dst.classList.add('cursor');
  try {
    entry.dst = await translate(text, from, (delta) => {
      dst.textContent += delta;
      scrollDown();
    });
    dst.textContent = entry.dst;
    history.push(entry);
    saveHistory();
    if (settings.speak) speak(entry.dst, from === 'en' ? 'ja' : 'en');
  } catch (err) {
    dst.textContent = errorText(err);
    dst.classList.add('err');
    if (!settings.key) openSettings();
  } finally {
    dst.classList.remove('cursor');
  }
}

// ---------- Speech input ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let session = null;

const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
let helpLang = 'en';

function useKeyboard(lang) {
  setTypeLang(lang);
  const input = $('type-input');
  input.placeholder = lang === 'ja' ? '🌐で日本語キーボード → 🎤' : 'Tap the 🎤 on the keyboard…';
  input.focus();
}

function showMicHelp(lang, error) {
  helpLang = lang;
  let msg;
  if (error === 'no-speech') {
    msg = lang === 'ja' ? '聞き取れませんでした。もう一度どうぞ。' : "Didn't catch that. Tap the button and try again.";
  } else if (standalone) {
    msg = 'iPhone blocks voice input when this app is opened from the Home Screen icon.\n\nFix: tap “Copy link”, open Safari, paste it and use the app there (voice works in Safari). Or tap “Use keyboard” and press the 🎤 on the keyboard.';
  } else if (error === 'network') {
    msg = 'This browser blocks voice input (Brave and some others do).\n\nOn iPhone use Safari. On a computer use Chrome or Safari. Or tap “Use keyboard” and press the 🎤 on the keyboard.';
  } else if (error === 'not-allowed' || error === 'service-not-allowed') {
    msg = 'Voice input is turned off.\n\niPhone Settings → General → Keyboard → turn ON “Enable Dictation”. Also Settings → Apps → Safari → Microphone → Allow. Then reload this page.';
  } else {
    msg = `Voice input failed${error ? ` (${error})` : ''}.\n\nTry again, or tap “Use keyboard” and press the 🎤 on the keyboard.`;
  }
  $('help-text').textContent = msg;
  $('help-copy').classList.toggle('hidden', !standalone || error === 'no-speech');
  $('mic-help').classList.remove('hidden');
}

function startListening(lang) {
  window.speechSynthesis?.cancel();
  if (!SR) return useKeyboard(lang);
  let cancelled = false;
  let finalText = '';
  let interim = '';
  let error = '';
  let heard = false;
  rec = new SR();
  rec.lang = LANGS[lang].code;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  const box = $('listen').querySelector('.listen-box');
  box.classList.toggle('ja', lang === 'ja');
  $('listen-title').textContent = lang === 'ja' ? 'どうぞ、お話しください…' : 'Listening… speak now';
  $('listen-text').textContent = '';
  $('listen').classList.remove('hidden');

  const thisRec = rec;
  let done = false;
  let timer = null;
  // Recognition on iOS can fail to start, or start and then never deliver results or end.
  // These timers make sure the screen never just hangs.
  const arm = (ms, fn) => { clearTimeout(timer); timer = setTimeout(fn, ms); };
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    $('listen').classList.add('hidden');
    if (rec === thisRec) { rec = null; session = null; }
    try { thisRec.abort(); } catch {}
    const text = (finalText + interim).trim();
    if (cancelled) return;
    if (text) return handle(text, lang);
    showMicHelp(lang, error || (heard ? 'no-speech' : 'did-not-start'));
  };
  // Stop politely, and if iOS never reports the end, finish anyway.
  const stopSoon = () => { try { thisRec.stop(); } catch {} arm(600, finish); };
  session = { stop: stopSoon, cancel: () => { cancelled = true; finish(); } };

  rec.onresult = (e) => {
    finalText = '';
    interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $('listen-text').textContent = finalText + interim;
    if (finalText) stopSoon(); // iOS marked the phrase complete
    else arm(1200, stopSoon); // speaker paused → send it
  };
  rec.onaudiostart = () => { heard = true; arm(7000, stopSoon); }; // nobody spoke
  rec.onerror = (e) => { error = e.error; };
  rec.onend = finish;
  arm(3000, () => { if (!heard) { error = error || 'did-not-start'; finish(); } });
  try {
    rec.start();
  } catch (err) {
    error = err?.name || 'start-failed';
    finish();
  }
}

$('help-keyboard').onclick = () => { $('mic-help').classList.add('hidden'); useKeyboard(helpLang); };
$('help-close').onclick = () => $('mic-help').classList.add('hidden');
$('help-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $('help-copy').textContent = 'Copied ✓'; } catch { prompt('Copy this link:', location.href); }
};

// Prime speech output on the first tap that isn't a mic button (audio during mic start can stall recognition on iOS).
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.mic')) unlockSpeech(); }, { capture: true });

$('mic-en').onclick = () => startListening('en');
$('mic-ja').onclick = () => startListening('ja');
$('listen-done').onclick = () => session?.stop();
$('listen-cancel').onclick = () => session?.cancel();

// ---------- Typing ----------
function setTypeLang(lang) {
  typeLang = lang;
  const b = $('type-lang');
  b.textContent = lang === 'en' ? 'EN' : '日本';
  b.classList.toggle('ja', lang === 'ja');
}
$('type-lang').onclick = () => setTypeLang(typeLang === 'en' ? 'ja' : 'en');
$('type-form').onsubmit = (e) => {
  e.preventDefault();
  unlockSpeech();
  const input = $('type-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.blur();
  handle(text, typeLang);
};

// ---------- Show to guest ----------
let showing = null;
function openShow(entry) {
  if (!entry) return;
  showing = entry;
  $('show-text').textContent = entry.dst;
  $('show').classList.remove('hidden');
}
$('btn-show').onclick = () => openShow([...history].reverse().find((h) => h.dst));
$('show-close').onclick = () => $('show').classList.add('hidden');
$('show-flip').onclick = () => $('show-text').classList.toggle('flipped');
$('show-speak').onclick = () => showing && speak(showing.dst, showing.from === 'en' ? 'ja' : 'en');

$('btn-clear').onclick = () => {
  if (!confirm('Clear the conversation?')) return;
  history = [];
  saveHistory();
  $('log').querySelectorAll('.card').forEach((c) => c.remove());
  $('empty').classList.remove('hidden');
};

// ---------- Install ----------
// Android / desktop Chrome offer a real install prompt; iOS needs the manual Share-sheet steps.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => $('btn-install').classList.add('hidden'));

$('btn-install').onclick = async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    return;
  }
  const note = $('install-note');
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = ios && !/CriOS|FxiOS|EdgiOS|OPiOS|Brave/.test(navigator.userAgent);
  if (standalone) {
    note.textContent = 'You opened this from a Home Screen icon set to “Open as Web App”, which blocks voice. Delete that icon, open the link in Safari, and add it again with the steps below.';
  } else if (!ios) {
    note.textContent = 'Open this link on the iPhone in Safari, then follow these steps.';
  } else if (!safari) {
    note.textContent = 'Open this link in Safari first. Other iPhone browsers can’t add it properly.';
  }
  note.classList.toggle('hidden', !note.textContent);
  $('install-copy').textContent = 'Copy link';
  $('install').classList.remove('hidden');
};
$('install-close').onclick = () => $('install').classList.add('hidden');
$('install-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $('install-copy').textContent = 'Copied ✓'; } catch { prompt('Copy this link:', location.href); }
};

// ---------- Settings ----------
function openSettings() {
  $('set-key').value = settings.key;
  $('set-speak').checked = settings.speak;
  $('set-rate').value = settings.rate;
  $('set-rate-val').textContent = `${Number(settings.rate).toFixed(2)}×`;
  $('set-status').textContent = '';
  $('settings').classList.remove('hidden');
}
function readSettings() {
  const key = $('set-key').value.trim();
  if (key !== settings.key) client = null;
  settings.key = key;
  settings.speak = $('set-speak').checked;
  settings.rate = Number($('set-rate').value);
  store.set('apiKey', settings.key);
  store.set('autoSpeak', settings.speak);
  store.set('rate', settings.rate);
}
$('btn-settings').onclick = openSettings;
$('set-rate').oninput = (e) => { $('set-rate-val').textContent = `${Number(e.target.value).toFixed(2)}×`; };
$('set-save').onclick = () => { readSettings(); $('settings').classList.add('hidden'); };
$('set-test').onclick = async () => {
  readSettings();
  unlockSpeech();
  const status = $('set-status');
  status.className = 'status';
  status.textContent = 'Testing…';
  const t0 = performance.now();
  try {
    const out = await translate('Nice to meet you. Thank you for visiting our booth.', 'en', () => {});
    status.className = 'status ok';
    status.textContent = `✓ ${out} (${Math.round(performance.now() - t0)} ms)`;
    speak(out, 'ja');
  } catch (err) {
    status.className = 'status bad';
    status.textContent = errorText(err);
  }
};

// ---------- Boot ----------
history.forEach(renderCard);
if (!settings.key) openSettings();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
