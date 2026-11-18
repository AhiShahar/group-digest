#!/usr/bin/env bash
# Builds a signed, sideloadable APK without Gradle, using only:
#   aapt, zipalign, apksigner, dx (Ubuntu: apt install android-sdk android-sdk-platform-23 dalvik-exchange)
#   a JDK (javac, keytool)
# The web app must be built first into android/assets/www (npm run build:android-web).
set -euo pipefail
unset _JAVA_OPTIONS 2>/dev/null || true
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-/usr/lib/android-sdk}"
PLATFORM="${ANDROID_JAR:-$SDK/platforms/android-23/android.jar}"
VERSION_NAME="${VERSION_NAME:-$(node -p "require('../package.json').version")}"
VERSION_CODE="${VERSION_CODE:-$(date +%y%m%d%H)}"
KEYSTORE="${KEYSTORE:-./group-digest-test.keystore}"
KS_PASS="${KS_PASS:-groupdigest}"
OUT="${OUT:-./dist/group-digest-${VERSION_NAME}.apk}"

[ -f assets/www/index.html ] || { echo "Run npm run build:android-web first"; exit 1; }

rm -rf build && mkdir -p build/gen build/classes "$(dirname "$OUT")"

if [ ! -f "$KEYSTORE" ]; then
  echo "Creating test signing key $KEYSTORE (keep it: updates must be signed with the same key)"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias groupdigest -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Group Digest test build" >/dev/null 2>&1
fi

# 1. Resources and manifest. Compiled against API 23, targets API 34.
aapt package -f -m -M AndroidManifest.xml -S res -A assets -I "$PLATFORM" -J build/gen \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -F build/app.unaligned.apk

# 2. Java to dex
if ! javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$PLATFORM" -d build/classes \
  build/gen/app/groupdigest/R.java src/app/groupdigest/*.java 2> build/javac.log; then
  grep -v '^Picked up' build/javac.log; exit 1
fi
ls build/classes/app/groupdigest/MainActivity.class >/dev/null
dalvik-exchange --dex --min-sdk-version=24 --output=build/classes.dex build/classes
(cd build && zip -q app.unaligned.apk classes.dex)

# 3. Align and sign (v1 + v2 + v3)
zipalign -f -p 4 build/app.unaligned.apk build/app.aligned.apk
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --ks-key-alias groupdigest \
  --min-sdk-version 24 --out "$OUT" build/app.aligned.apk
apksigner verify --print-certs "$OUT" | head -2
echo "Built $OUT ($(du -h "$OUT" | cut -f1)), version $VERSION_NAME ($VERSION_CODE)"
