# My Voice — Android APK

Script-to-speech in your own cloned voice, fully on the phone (Kyutai Pocket TTS on ONNX Runtime, inside a WebView).

## Get the APK
Every push to `main` builds a signed APK on GitHub Actions and publishes it as a Release.
On the phone open: `https://github.com/<you>/<repo>/releases/latest/download/MyVoice.apk`
→ allow "Install unknown apps" for your browser → Install.

## Updating
Change files in `app/src/main/assets/www/` (the web app) and push. The fixed signing key in `app/myvoice.jks`
makes each new build install as an update, so your saved voices and takes stay.

## Build locally (optional)
Android Studio → Open this folder → Build → Build APK(s). Or `gradle :app:assembleRelease` with JDK 17 + Android SDK 35.

## Your own voice model
1. App → **Train** tab: record the sentences (5–10 min), then **Export recordings** → `Downloads/MyVoice/myvoice-dataset.zip`.
2. Upload the zip to Google Drive → `MyVoice/`.
3. Open [`colab/MyVoice_Train.ipynb` in Colab](https://colab.research.google.com/github/ideas4uai/myvoice-app/blob/main/colab/MyVoice_Train.ipynb), choose a T4 GPU, **Run all** (~1–3 h).
4. Import `my_voice.onnx` + `my_voice.onnx.json` from Drive in the app (**Train** → Import my model). It then runs offline on the phone.

Training fine-tunes a Piper (VITS) voice, starting from the public-domain LJSpeech voice by default.
