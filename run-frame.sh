#!/bin/sh
# Serve the dashboard from this Mac and show it on the USB-connected frame.
cd "$(dirname "$0")/dashboard" || exit 1
npm run build >/dev/null || exit 1
adb -d reverse tcp:4173 tcp:4173 || exit 1
(sleep 3; adb -d shell 'am start -a android.intent.action.VIEW -d "http://127.0.0.1:4173/#home" -n com.wesbos.homehq/.MainActivity') &
exec npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
