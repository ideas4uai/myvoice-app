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
