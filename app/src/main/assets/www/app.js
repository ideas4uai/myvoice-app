// My Voice — on-device voice cloning + script-to-speech.
// Engine: Kyutai Pocket TTS via pocket-tts-js, running in a Web Worker on ONNX Runtime Web (WASM).
import { PocketTTS, StreamingPlayer, chunksToWavBlob, resampleLinear } from "./lib/index.js";

const SR = 24000;               // Pocket TTS sample rate
const MAX_REC_SEC = 12;         // auto-stop recording
const REF_SEC = 10;             // model uses up to 10 s of reference audio
const PARA_PAUSE_SEC = 0.5;     // extra pause between paragraphs
const MAX_TAKES = 30;

const $ = (id) => document.getElementById(id);
const toastEl = $("toast");
let toastTimer;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const NATIVE = window.AndroidBridge || null; // set when running inside the Android APK
if (NATIVE) document.documentElement.classList.add("native");

// ---------------------------------------------------------------- service worker (offline + multi-thread)
if ("serviceWorker" in navigator && !NATIVE) {
  navigator.serviceWorker.register("./sw.js").then(() => {
    // The SW adds cross-origin-isolation headers so ONNX can use all CPU cores.
    // The first visit isn't isolated yet: reload once when the SW takes control.
    if (!self.crossOriginIsolated && !sessionStorage.getItem("coiReloaded")) {
      const reload = () => { sessionStorage.setItem("coiReloaded", "1"); location.reload(); };
      if (navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
    }
  }).catch((e) => console.warn("SW failed", e));
}

let deferredInstall = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  $("installBtn").classList.remove("hidden");
});
$("installBtn").onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $("installBtn").classList.add("hidden");
};

// ---------------------------------------------------------------- IndexedDB
const dbP = new Promise((resolve, reject) => {
  const req = indexedDB.open("myvoice", 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("voices", { keyPath: "id" });
    db.createObjectStore("takes", { keyPath: "id" });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function idb(store, mode, fn) {
  const db = await dbP;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(out && "result" in out ? out.result : out);
    tx.onerror = () => reject(tx.error);
  });
}
const db = {
  all: (s) => idb(s, "readonly", (st) => st.getAll()),
  put: (s, v) => idb(s, "readwrite", (st) => st.put(v)),
  del: (s, k) => idb(s, "readwrite", (st) => st.delete(k)),
};
navigator.storage?.persist?.().catch(() => {});

// ---------------------------------------------------------------- tabs
document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => showView(b.dataset.view);
});
function showView(name) {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x.dataset.view === name));
  document.querySelectorAll("section.view").forEach((s) => s.classList.toggle("active", s.id === "view-" + name));
  if (name === "engine") refreshStorage();
  if (name === "takes") renderTakes();
  scrollTo(0, 0);
}

// ---------------------------------------------------------------- engine
let tts = null;
let engineState = "off"; // off | loading | ready
const clonedRefs = new Map(); // voiceId -> worker ref

function setPill() {
  const p = $("enginePill");
  const cores = self.crossOriginIsolated ? "multi-core" : "1 core";
  p.className = "pill " + (engineState === "ready" ? "ok" : engineState === "loading" ? "warn" : "");
  p.textContent = engineState === "ready" ? `Engine ready · ${cores}` : engineState === "loading" ? "Loading engine…" : "Engine off";
  $("st1").classList.toggle("done", engineState === "ready");
  updateOnboard();
}
function updateOnboard() {
  const done = engineState === "ready" && $("st2").classList.contains("done");
  $("onboard").classList.toggle("hidden", done);
}

$("quality").value = ls.get("quality", "int8");
$("quality").onchange = () => {
  ls.set("quality", $("quality").value);
  if (engineState === "ready") toast("Tap Download & start to switch quality");
  $("loadBtn").textContent = "Download & start engine";
  $("loadBtn").disabled = false;
};

function fmtMB(b) { return (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + " MB"; }

async function loadEngine() {
  if (engineState === "loading") return;
  const quantized = $("quality").value !== "fp32";
  if (tts) { tts.destroy(); tts = null; clonedRefs.clear(); }
  engineState = "loading"; setPill();
  $("loadBtn").disabled = true;
  $("dlBox").classList.remove("hidden");
  const files = new Map();
  let cachedAll = true;
  const onProgress = (p) => {
    if (p.type === "status") { $("dlStatus").textContent = statusText(p.status); return; }
    if (!p.label) return;
    if (!p.fromCache) cachedAll = false;
    files.set(p.label, { loaded: p.loaded || 0, total: p.total || 0 });
    let L = 0, T = 0;
    for (const f of files.values()) { L += f.loaded; T += f.total || f.loaded; }
    $("dlBar").style.width = (T ? Math.min(100, (L / T) * 100) : 5) + "%";
    $("dlStatus").textContent = `${p.fromCache ? "Loading from phone" : "Downloading"} ${p.label} · ${fmtMB(L)}${T ? " / " + fmtMB(T) : ""}`;
  };
  try {
    tts = new PocketTTS({
      language: "english_2026-04",
      quantized,
      voiceCloning: true,
      ortBaseUrl: new URL("./ort/", location.href).href,
      maxThreads: Math.min(navigator.hardwareConcurrency || 4, 6),
    });
    const t0 = performance.now();
    await tts.load(onProgress);
    engineState = "ready";
    ls.set("engineReady", quantized ? "int8" : "fp32");
    $("dlBar").style.width = "100%";
    $("dlStatus").textContent = `Ready in ${((performance.now() - t0) / 1000).toFixed(1)} s${cachedAll ? " (offline cache)" : ""}`;
    $("loadBtn").textContent = "Engine running ✓";
    $("engineInfo").textContent = `${quantized ? "INT8" : "Full precision"} · ${self.crossOriginIsolated ? `using up to ${Math.min(navigator.hardwareConcurrency || 4, 6)} CPU threads` : "single-thread mode"}`;
    toast("Voice engine ready");
  } catch (e) {
    console.error(e);
    engineState = "off";
    tts = null;
    $("loadBtn").disabled = false;
    $("dlStatus").textContent = "Failed: " + e.message + " — check your connection and try again.";
    toast("Engine failed to load");
  }
  setPill();
  refreshStorage();
}
function statusText(s) {
  return ({ "loading-runtime": "Starting ONNX runtime…", "loading-bundle": "Reading model info…" })[s] || s;
}
$("loadBtn").onclick = loadEngine;

$("clearCacheBtn").onclick = async () => {
  if (tts) { tts.destroy(); tts = null; clonedRefs.clear(); }
  engineState = "off"; setPill();
  await PocketTTS.clearCache();
  ls.del("engineReady");
  $("loadBtn").disabled = false;
  $("loadBtn").textContent = "Download & start engine";
  $("dlBox").classList.add("hidden");
  refreshStorage();
  toast("Engine files deleted");
};
async function refreshStorage() {
  const est = await PocketTTS.storageEstimate();
  $("storageInfo").textContent = est ? `This app uses ${fmtMB(est.usage)} on your phone.` : "Storage info not available.";
}

// ---------------------------------------------------------------- audio helpers
function toMono(buf) {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const a = buf.getChannelData(0), b = buf.getChannelData(1), out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}
async function decodeToMono24k(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(arrayBuffer);
    return resampleLinear(toMono(buf), buf.sampleRate, SR);
  } finally { ctx.close(); }
}
// Trim silence at both ends, cap to 10 s, peak-normalise.
function prepareReference(pcm) {
  const win = Math.round(SR * 0.02);
  const rms = [];
  for (let i = 0; i + win <= pcm.length; i += win) {
    let s = 0; for (let j = i; j < i + win; j++) s += pcm[j] * pcm[j];
    rms.push(Math.sqrt(s / win));
  }
  const peakRms = Math.max(...rms, 1e-6);
  const th = Math.max(0.006, peakRms * 0.08);
  let a = rms.findIndex((v) => v > th), b = rms.length - 1 - [...rms].reverse().findIndex((v) => v > th);
  if (a < 0) return { pcm: new Float32Array(0), speechSec: 0 };
  const pad = Math.round(0.15 * SR);
  let start = Math.max(0, a * win - pad), end = Math.min(pcm.length, (b + 1) * win + pad);
  end = Math.min(end, start + REF_SEC * SR);
  const out = pcm.slice(start, end);
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) { const g = 0.9 / peak; for (let i = 0; i < out.length; i++) out[i] *= g; }
  return { pcm: out, speechSec: out.length / SR, quiet: peakRms < 0.02 };
}

// ---------------------------------------------------------------- recording
let recorder = null, recStream = null, recChunks = [], recStart = 0, recTick = null, meterCtx = null;
let pendingRef = null;

$("micBtn").onclick = () => (recorder ? stopRecording() : startRecording());

async function startRecording() {
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    toast("Microphone permission is needed to record");
    return;
  }
  recChunks = [];
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
  recorder = new MediaRecorder(recStream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = onRecordingDone;
  recorder.start(250);
  recStart = performance.now();
  $("micBtn").classList.add("rec"); $("micBtn").textContent = "■";
  $("reviewBox").classList.add("hidden");
  // level meter
  meterCtx = new (window.AudioContext || window.webkitAudioContext)();
  const an = meterCtx.createAnalyser(); an.fftSize = 1024;
  meterCtx.createMediaStreamSource(recStream).connect(an);
  const data = new Float32Array(an.fftSize);
  recTick = setInterval(() => {
    const t = (performance.now() - recStart) / 1000;
    $("recTimer").textContent = t.toFixed(1) + " s";
    an.getFloatTimeDomainData(data);
    let p = 0; for (const v of data) p = Math.max(p, Math.abs(v));
    $("recLevel").style.width = Math.min(100, p * 140) + "%";
    $("recLevel").style.background = p > 0.95 ? "var(--bad)" : "var(--ok)";
    if (t >= MAX_REC_SEC) stopRecording();
  }, 60);
}
function stopRecording() {
  if (!recorder) return;
  clearInterval(recTick);
  recorder.stop();
  recStream.getTracks().forEach((t) => t.stop());
  meterCtx?.close();
  recorder = null;
  $("micBtn").classList.remove("rec"); $("micBtn").textContent = "🎙";
  $("recLevel").style.width = "0";
}
async function onRecordingDone() {
  const blob = new Blob(recChunks, { type: recChunks[0]?.type || "audio/webm" });
  await reviewClip(await blob.arrayBuffer());
}
$("uploadInput").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) await reviewClip(await f.arrayBuffer());
};

async function reviewClip(ab) {
  let pcm;
  try { pcm = await decodeToMono24k(ab); } catch { toast("Couldn't read that audio file"); return; }
  const ref = prepareReference(pcm);
  if (ref.speechSec < 3) { toast("Too short or too quiet — record at least 5 seconds"); return; }
  pendingRef = ref.pcm;
  const dur = (ref.pcm.length / SR).toFixed(1);
  $("reviewInfo").textContent = `${dur} s of speech captured.` + (ref.quiet ? " It's quite quiet — hold the phone a bit closer for a better clone." : " Sounds good? Give it a name and save.");
  $("reviewAudio").src = URL.createObjectURL(chunksToWavBlob([ref.pcm], SR));
  $("voiceName").value = "";
  $("reviewBox").classList.remove("hidden");
  $("reviewBox").scrollIntoView({ behavior: "smooth", block: "center" });
}
$("discardBtn").onclick = () => { pendingRef = null; $("reviewBox").classList.add("hidden"); };
$("saveVoiceBtn").onclick = async () => {
  if (!pendingRef) return;
  const id = "v" + Date.now();
  const name = $("voiceName").value.trim() || "My voice " + new Date().toLocaleDateString();
  await db.put("voices", { id, name, pcm: pendingRef, created: Date.now() });
  ls.set("activeVoice", id);
  pendingRef = null;
  $("reviewBox").classList.add("hidden");
  await renderVoices();
  toast(`Saved "${name}"`);
};

// ---------------------------------------------------------------- voices list
let voices = [];
async function renderVoices() {
  voices = (await db.all("voices")).sort((a, b) => b.created - a.created);
  let active = ls.get("activeVoice");
  if (!voices.find((v) => v.id === active)) { active = voices[0]?.id || null; active ? ls.set("activeVoice", active) : ls.del("activeVoice"); }
  const list = $("voiceList");
  list.innerHTML = voices.length ? "" : '<div class="meta">No voices yet — record one above.</div>';
  for (const v of voices) {
    const el = document.createElement("div");
    el.className = "voice" + (v.id === active ? " sel" : "");
    el.innerHTML = `<span class="radio"></span><div class="grow"><div class="name"></div><div class="meta">${(v.pcm.length / SR).toFixed(1)} s sample</div></div>`;
    el.querySelector(".name").textContent = v.name;
    const play = document.createElement("button"); play.className = "small"; play.textContent = "▶";
    const del = document.createElement("button"); del.className = "small danger"; del.textContent = "✕";
    let audio;
    play.onclick = (e) => { e.stopPropagation(); audio?.pause(); audio = new Audio(URL.createObjectURL(chunksToWavBlob([v.pcm], SR))); audio.play(); };
    del.onclick = async (e) => {
      e.stopPropagation();
      if (del.dataset.armed) { await db.del("voices", v.id); clonedRefs.delete(v.id); renderVoices(); toast("Voice deleted"); }
      else { del.dataset.armed = "1"; del.textContent = "Delete?"; setTimeout(() => { del.dataset.armed = ""; del.textContent = "✕"; }, 3000); }
    };
    el.append(play, del);
    el.onclick = () => { ls.set("activeVoice", v.id); renderVoices(); toast(`Using "${v.name}"`); };
    list.append(el);
  }
  const cur = voices.find((v) => v.id === active);
  $("voiceUsing").textContent = cur ? "Voice: " + cur.name : "No voice yet";
  $("st2").classList.toggle("done", !!cur);
  updateOnboard();
}

async function ensureCloned(voice) {
  if (clonedRefs.has(voice.id)) return clonedRefs.get(voice.id);
  const ref = await tts.cloneVoice(voice.pcm.slice(), { inputSampleRate: SR, name: "clone:" + voice.id });
  clonedRefs.set(voice.id, ref);
  return ref;
}

// ---------------------------------------------------------------- script + generation
const scriptEl = $("script");
scriptEl.value = ls.get("draft", "");
function updateCount() {
  const words = scriptEl.value.trim().split(/\s+/).filter(Boolean).length;
  const mins = words / 150;
  $("count").textContent = `${words} words · ~${mins < 1 ? Math.max(1, Math.round(mins * 60)) + " s" : mins.toFixed(1) + " min"} of audio`;
  $("st3").classList.toggle("done", words > 0);
}
let draftTimer;
scriptEl.oninput = () => { updateCount(); clearTimeout(draftTimer); draftTimer = setTimeout(() => ls.set("draft", scriptEl.value), 400); };
$("clearBtn").onclick = () => { scriptEl.value = ""; ls.set("draft", ""); updateCount(); scriptEl.focus(); };
$("livePlay").checked = ls.get("livePlay", "1") === "1";
$("livePlay").onchange = () => ls.set("livePlay", $("livePlay").checked ? "1" : "0");

let generating = false, stopRequested = false, player = null, wakeLock = null;

$("genBtn").onclick = async () => {
  const text = scriptEl.value.trim();
  if (!text) { toast("Paste a script first"); scriptEl.focus(); return; }
  const voice = voices.find((v) => v.id === ls.get("activeVoice"));
  if (!voice) { toast("Record your voice first"); showView("voices"); return; }
  if (engineState !== "ready") {
    if (engineState === "off") { showView("engine"); toast("Start the engine first"); }
    else toast("Engine is still loading…");
    return;
  }
  const live = $("livePlay").checked;
  // Create/resume audio inside the tap so Android allows playback.
  if (live) {
    player?.stop();
    player = new StreamingPlayer({ sampleRate: tts.sampleRate, primeSeconds: 0.8 });
    await player.resume();
  }
  generating = true; stopRequested = false;
  $("genBtn").disabled = true; $("stopBtn").classList.remove("hidden");
  $("genProgress").classList.remove("hidden");
  if (NATIVE) NATIVE.keepAwake(true);
  else { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }

  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const totalChars = paras.reduce((n, p) => n + p.length, 0);
  const chunks = [];
  let doneChars = 0, audioSec = 0;
  const t0 = performance.now();
  const setProg = (msg) => {
    $("genBar").style.width = Math.min(100, (doneChars / totalChars) * 100) + "%";
    $("genStatus").textContent = msg;
  };
  try {
    setProg("Preparing your voice…");
    const ref = await ensureCloned(voice);
    for (let i = 0; i < paras.length && !stopRequested; i++) {
      setProg(`Paragraph ${i + 1} of ${paras.length} · ${audioSec.toFixed(0)} s of audio so far`);
      await tts.generate(paras[i], {
        voice: ref,
        onChunk: (audio, meta) => {
          if (stopRequested) return;
          chunks.push(audio);
          audioSec += audio.length / tts.sampleRate;
          if (live) player.play(audio, { isLast: false });
        },
      });
      doneChars += paras[i].length;
      if (i < paras.length - 1 && !stopRequested) {
        const gap = new Float32Array(Math.round(PARA_PAUSE_SEC * tts.sampleRate));
        chunks.push(gap); audioSec += PARA_PAUSE_SEC;
        if (live) player.play(gap);
      }
    }
    if (live) player.flush();
    const secs = (performance.now() - t0) / 1000;
    if (!chunks.length) { setProg("Stopped."); return; }
    const blob = chunksToWavBlob(chunks, tts.sampleRate);
    const take = {
      id: "t" + Date.now(),
      title: text.replace(/\s+/g, " ").slice(0, 60),
      voice: voice.name,
      blob,
      duration: audioSec,
      created: Date.now(),
      partial: stopRequested,
    };
    await db.put("takes", take);
    trimTakes();
    doneChars = totalChars;
    setProg(`${stopRequested ? "Stopped early — kept" : "Done:"} ${fmtDur(audioSec)} of audio in ${secs.toFixed(0)} s (${(audioSec / secs).toFixed(1)}× real time)`);
    renderTakeCard(take, $("lastResult"), true);
  } catch (e) {
    console.error(e);
    setProg("Error: " + e.message);
    toast("Generation failed");
  } finally {
    generating = false;
    $("genBtn").disabled = false; $("stopBtn").classList.add("hidden");
    if (NATIVE) NATIVE.keepAwake(false);
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
  }
};
$("stopBtn").onclick = async () => {
  stopRequested = true;
  player?.stop();
  try { await tts?.stop(); } catch {}
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
function fmtDur(s) { const m = Math.floor(s / 60), r = Math.round(s % 60); return m ? `${m}:${String(r).padStart(2, "0")} min` : `${r} s`; }
function fileName(take) {
  const d = new Date(take.created);
  const slug = take.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "take";
  return `myvoice-${d.toISOString().slice(0, 10)}-${slug}.wav`;
}

// ---------------------------------------------------------------- takes
function renderTakeCard(take, container, replace = false) {
  const el = document.createElement("div");
  el.className = replace ? "card" : "take";
  const url = URL.createObjectURL(take.blob);
  el.innerHTML = `<div class="t"></div><div class="meta"></div><audio controls preload="metadata"></audio>
    <div class="row"><a class="btn small grow dl">⬇ Save</a><button class="small grow share">↗ Share</button>${replace ? "" : '<button class="small danger del">✕</button>'}</div>`;
  el.querySelector(".t").textContent = take.title;
  el.querySelector(".meta").textContent = `${fmtDur(take.duration)} · ${take.voice} · ${new Date(take.created).toLocaleString()}${take.partial ? " · partial" : ""}`;
  el.querySelector("audio").src = url;
  const a = el.querySelector(".dl"); a.href = url; a.download = fileName(take);
  if (NATIVE) a.onclick = async (e) => {
    e.preventDefault();
    const r = NATIVE.saveAudio(await blobToBase64(take.blob), fileName(take));
    if (r !== "ok") toast("Save failed: " + r);
  };
  el.querySelector(".share").onclick = async () => {
    if (NATIVE) {
      const r = NATIVE.shareAudio(await blobToBase64(take.blob), fileName(take));
      if (r !== "ok") toast("Share failed: " + r);
      return;
    }
    const file = new File([take.blob], fileName(take), { type: "audio/wav" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "My Voice take" }); } catch {}
    } else toast("Sharing isn't supported here — use Save");
  };
  const del = el.querySelector(".del");
  if (del) del.onclick = async () => { await db.del("takes", take.id); el.remove(); toast("Take deleted"); };
  if (replace) container.replaceChildren(el); else container.append(el);
}
async function renderTakes() {
  const takes = (await db.all("takes")).sort((a, b) => b.created - a.created);
  const list = $("takeList");
  list.innerHTML = takes.length ? "" : '<div class="meta">Nothing yet — generate a script on the Speak tab.</div>';
  takes.forEach((t) => renderTakeCard(t, list));
}
async function trimTakes() {
  const takes = (await db.all("takes")).sort((a, b) => b.created - a.created);
  for (const t of takes.slice(MAX_TAKES)) await db.del("takes", t.id);
}

// ---------------------------------------------------------------- boot
updateCount();
setPill();
renderVoices();
const prev = ls.get("engineReady");
if (prev) {
  $("quality").value = prev;
  loadEngine(); // loads from the on-phone cache, no network needed
} else {
  showView("speak");
}
