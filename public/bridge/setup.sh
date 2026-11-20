#!/bin/bash
# Installs or updates the Group Digest sync server on a Linux VM (Debian,
# Ubuntu or Oracle Linux; x64 or arm64) and runs it as a systemd service.
#
#   curl -fsSL https://<your app>/bridge/setup.sh | sudo bash -s -- <relay-url> <room> <secret>
#
# Safe to run again: it keeps the WhatsApp link and only refreshes the code.
set -euo pipefail

RELAY="${1:-}"; ROOM="${2:-}"; SECRET="${3:-}"
APP=/opt/group-digest-sync
DATA=/var/lib/group-digest
CONF=/etc/group-digest/sync.json
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }

if [ -n "$RELAY" ]; then
  [[ "$ROOM" =~ ^[a-f0-9]{32}$ ]] || { echo "Bad room id"; exit 1; }
  [[ "$SECRET" =~ ^[A-Za-z0-9_-]{40,}$ ]] || { echo "Bad secret"; exit 1; }
  [[ "$RELAY" =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo "Bad relay URL"; exit 1; }
elif [ -f "$CONF" ]; then
  RELAY=$(sed -n 's/.*"relay": *"\([^"]*\)".*/\1/p' "$CONF")
else
  echo "Usage: setup.sh <relay-url> <room> <secret>"; exit 1
fi

echo "==> Group Digest sync: setting up"
id gdsync >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin gdsync
mkdir -p "$APP" "$DATA" /etc/group-digest
chown gdsync:gdsync "$DATA"; chmod 700 "$DATA"

if [ -n "${SECRET}" ]; then
  umask 077
  printf '{"relay": "%s", "room": "%s", "secret": "%s"}\n' "$RELAY" "$ROOM" "$SECRET" > "$CONF"
  chown root:gdsync "$CONF"; chmod 640 "$CONF"
  umask 022
fi

# Small VMs (1 GB) need some swap for npm install.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && ! swapon --show | grep -q .; then
  echo "==> Adding 1 GB swap"
  (fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024) && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node.js 22 from nodejs.org, checksum verified.
need_node=1
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then need_node=0; fi
if [ $need_node = 1 ]; then
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) echo "Unsupported CPU $(uname -m)"; exit 1;; esac
  BASE=https://nodejs.org/dist/latest-v22.x
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SUMS"
  FILE=$(grep -o "node-v[0-9.]*-linux-$ARCH.tar.xz" "$TMP/SUMS" | head -1)
  echo "==> Installing $FILE"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SUMS | sha256sum -c - >/dev/null)
  command -v xz >/dev/null || { apt-get install -y xz-utils >/dev/null 2>&1 || dnf install -y xz >/dev/null 2>&1 || true; }
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$TMP/$FILE" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node; ln -sf /opt/node/bin/npm /usr/local/bin/npm
  rm -rf "$TMP"
fi

# Code refresh script, also run before every service start.
cat > "$APP/update.sh" <<UPD
#!/bin/bash
set -e
cd "$APP"
FILES=\$(curl -fsSL "$RELAY/bridge/files.txt" 2>/dev/null | tr -cd 'a-z0-9.\\n-' || true)
[ -n "\$FILES" ] || FILES="bridge.mjs crypto.mjs parse.mjs package.json"
for f in \$FILES; do
  curl -fsSL "$RELAY/bridge/\$f" -o "\$f.new" && mv "\$f.new" "\$f"
done
if ! cmp -s package.json .installed-package.json || [ ! -d node_modules ]; then
  /usr/local/bin/npm install --omit=dev --no-audit --no-fund --loglevel=error
  cp package.json .installed-package.json
fi
UPD
chmod 755 "$APP/update.sh"
echo "==> Downloading the sync server and its libraries"
"$APP/update.sh"
chown -R gdsync:gdsync "$APP"

cat > /etc/systemd/system/group-digest-sync.service <<UNIT
[Unit]
Description=Group Digest WhatsApp sync
After=network-online.target
Wants=network-online.target

[Service]
User=gdsync
Group=gdsync
WorkingDirectory=$APP
Environment=GD_DATA=$DATA NODE_ENV=production
ExecStartPre=-$APP/update.sh
ExecStart=/usr/local/bin/node --max-old-space-size=384 $APP/bridge.mjs
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA $APP

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable group-digest-sync >/dev/null 2>&1
systemctl restart group-digest-sync
sleep 3
systemctl is-active --quiet group-digest-sync && echo "==> Done. The sync server is running. Go back to the app to scan the QR code." || { echo "Service did not start:"; journalctl -u group-digest-sync -n 30 --no-pager; exit 1; }
