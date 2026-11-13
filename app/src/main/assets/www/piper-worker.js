// Runs YOUR trained voice model (Piper/VITS ONNX) on the phone.
// Text -> espeak-ng phonemes (same rules Piper used in training) -> phoneme ids -> ONNX -> audio.
import { phonemize } from "./lib/phonemizer.js";

let ort = null;
let session = null;
let config = null;
let stopFlag = false;

async function loadOrt() {
  if (ort) return;
  const base = new URL("./ort/", self.location.href).href;
  const mod = await import(base + "ort.min.mjs");
  ort = mod.default || mod;
  ort.env.wasm.wasmPaths = base;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 6) : 1;
}

const TERMINATORS = ".!?,;:";

// Mirrors piper.phonemize_espeak: espeak phonemes per clause, keep the clause punctuation,
// add a space after , : ; and start a new sentence after . ! ?
export async function textToSentences(text, voice = "en-us") {
  const clean = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const parts = clean.match(/[^.!?,;:]+[.!?,;:]*|[.!?,;:]+/g) || [];
  const sentences = [];
  let cur = "";
  for (const part of parts) {
    const m = part.match(/[.!?,;:]+\s*$/);
    const body = m ? part.slice(0, m.index) : part;
    const term = m ? m[0].trim()[0] : "";
    if (body.trim()) {
      const ph = await phonemize(body.trim(), voice);
      cur += ph.join(" ");
    }
    if (term) {
      cur += term;
      if (",:;".includes(term)) cur += " ";
    }
    if (term && ".!?".includes(term)) {
      if (cur.trim()) sentences.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) sentences.push(cur.trim());
  return sentences.map(modernize);
}

// The bundled espeak-ng is a little older than the one Piper trains with.
// Patch its main systematic difference (the "or" vowel) so phonemes match training.
function modernize(s) {
  return s.replace(/oː/g, "ɔː");
}

export function phonemesToIds(phonemeStr, idMap) {
  const chars = Array.from(phonemeStr.normalize("NFD"));
  const ids = [...idMap["^"], ...idMap["_"]];
  for (const ch of chars) {
    const id = idMap[ch];
    if (!id) continue;
    ids.push(...id, ...idMap["_"]);
  }
  ids.push(...idMap["$"]);
  return ids;
}

async function synth(ids, lengthScale) {
  const inf = config.inference || {};
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([
      inf.noise_scale ?? 0.667,
      (inf.length_scale ?? 1.0) * lengthScale,
      inf.noise_w ?? 0.8,
    ]), [3]),
  };
  if (session.inputNames.includes("sid")) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
  const out = await session.run(feeds);
  return new Float32Array(out[session.outputNames[0]].data);
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === "load") {
      await loadOrt();
      config = payload.config;
      if (session) { try { await session.release(); } catch {} }
      session = await ort.InferenceSession.create(new Uint8Array(payload.model), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      self.postMessage({ id, type: "result", result: { sampleRate: config.audio.sample_rate } });
    } else if (type === "generate") {
      stopFlag = false;
      const voice = (config.espeak && config.espeak.voice) || "en-us";
      const sentences = await textToSentences(payload.text, voice);
      const sr = config.audio.sample_rate;
      const gap = new Float32Array(Math.round(sr * (payload.sentencePause ?? 0.18)));
      let audioSec = 0;
      const t0 = performance.now();
      for (let i = 0; i < sentences.length && !stopFlag; i++) {
        const audio = await synth(phonemesToIds(sentences[i], config.phoneme_id_map), payload.lengthScale || 1);
        audioSec += audio.length / sr;
        self.postMessage({ type: "chunk", audio }, [audio.buffer]);
        if (i < sentences.length - 1) {
          const g = gap.slice();
          audioSec += g.length / sr;
          self.postMessage({ type: "chunk", audio: g }, [g.buffer]);
        }
      }
      const genTime = (performance.now() - t0) / 1000;
      self.postMessage({ id, type: "result", result: { audioSec, genTime, sentences: sentences.length } });
    } else if (type === "stop") {
      stopFlag = true;
      self.postMessage({ id, type: "result", result: { ok: true } });
    } else if (type === "phonemize") {
      const sentences = await textToSentences(payload.text, payload.voice || "en-us");
      self.postMessage({ id, type: "result", result: { sentences } });
    }
  } catch (err) {
    self.postMessage({ id, type: "error", error: err && err.message ? err.message : String(err) });
  }
};
