#!/bin/bash
# ============================================================================
# OpenClaw VPS Security Hardening Script
# Target: Hetzner Cloud VPS (Ubuntu/Debian)
#
# Run as root, then switch to the unprivileged 'openclaw' user.
# Usage: sudo bash harden-vps.sh
# ============================================================================

set -euo pipefail

OPENCLAW_USER="openclaw"
OPENCLAW_HOME="/home/${OPENCLAW_USER}"
OPENCLAW_DIR="${OPENCLAW_HOME}/.openclaw"
GATEWAY_PORT=18789

echo "=== OpenClaw VPS Security Hardening ==="
echo ""

# ------------------------------------------------------------------
# 1. CREATE UNPRIVILEGED USER (never run the agent as root)
# ------------------------------------------------------------------
echo "[1/10] Creating unprivileged user..."
if ! id "${OPENCLAW_USER}" &>/dev/null; then
    useradd -m -s /bin/bash "${OPENCLAW_USER}"
    echo "  Created user: ${OPENCLAW_USER}"
else
    echo "  User ${OPENCLAW_USER} already exists"
fi

# ------------------------------------------------------------------
# 2. FIREWALL (only allow SSH + reverse proxy)
# ------------------------------------------------------------------
echo "[2/10] Configuring firewall (ufw)..."
apt-get update -qq && apt-get install -y -qq ufw > /dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
# Do NOT allow the gateway port publicly - it should only be
# accessible via SSH tunnel, Tailscale, or reverse proxy.
# ufw allow ${GATEWAY_PORT}  # INTENTIONALLY COMMENTED OUT
ufw --force enable
echo "  Firewall enabled. Gateway port ${GATEWAY_PORT} is NOT exposed."

# ------------------------------------------------------------------
# 3. FAIL2BAN (brute-force protection for SSH)
# ------------------------------------------------------------------
echo "[3/10] Installing fail2ban..."
apt-get install -y -qq fail2ban > /dev/null
systemctl enable fail2ban
systemctl start fail2ban
echo "  fail2ban active for SSH."

# ------------------------------------------------------------------
# 4. SSH HARDENING
# ------------------------------------------------------------------
echo "[4/10] Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"
# Disable password auth (key-only)
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "${SSHD_CONFIG}"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "${SSHD_CONFIG}"
sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' "${SSHD_CONFIG}"
systemctl reload sshd || systemctl reload ssh
echo "  SSH: password auth disabled, root login disabled."

# ------------------------------------------------------------------
# 5. RESTRICTIVE UMASK FOR OPENCLAW USER
# ------------------------------------------------------------------
echo "[5/10] Setting restrictive umask..."
# Ensure all new files are owner-only by default
if ! grep -q "umask 077" "${OPENCLAW_HOME}/.bashrc" 2>/dev/null; then
    echo "umask 077" >> "${OPENCLAW_HOME}/.bashrc"
fi
echo "  umask 077 set for ${OPENCLAW_USER}."

# ------------------------------------------------------------------
# 6. SECURE DIRECTORIES
# ------------------------------------------------------------------
echo "[6/10] Securing OpenClaw directories..."
mkdir -p "${OPENCLAW_DIR}"
mkdir -p "${OPENCLAW_DIR}/credentials"
mkdir -p "${OPENCLAW_DIR}/logs"

# Lock down the entire .openclaw tree
chown -R "${OPENCLAW_USER}:${OPENCLAW_USER}" "${OPENCLAW_DIR}"
chmod 700 "${OPENCLAW_DIR}"
chmod 700 "${OPENCLAW_DIR}/credentials"
chmod 700 "${OPENCLAW_DIR}/logs"

# Secure /tmp/openclaw logs (create with restrictive perms)
OPENCLAW_TMP="/tmp/openclaw"
mkdir -p "${OPENCLAW_TMP}"
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${OPENCLAW_TMP}"
chmod 700 "${OPENCLAW_TMP}"
echo "  All directories locked to owner-only."

# ------------------------------------------------------------------
# 7. GENERATE STRONG GATEWAY AUTH TOKEN
# ------------------------------------------------------------------
echo "[7/10] Generating gateway auth token..."
GATEWAY_TOKEN=$(openssl rand -hex 32)
TOKEN_FILE="${OPENCLAW_DIR}/.gateway-token"
echo "${GATEWAY_TOKEN}" > "${TOKEN_FILE}"
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"
echo "  Gateway token saved to ${TOKEN_FILE}"
echo "  Token (save this): ${GATEWAY_TOKEN}"

# ------------------------------------------------------------------
# 8. CREATE SECURE ENVIRONMENT FILE
# ------------------------------------------------------------------
echo "[8/10] Creating environment file..."
ENV_FILE="${OPENCLAW_HOME}/.openclaw-env"
cat > "${ENV_FILE}" << 'ENVEOF'
# OpenClaw Environment Variables
# Store ALL secrets here, NOT in openclaw.json
# Load with: set -a; source ~/.openclaw-env; set +a

# Anthropic API key (REQUIRED)
ANTHROPIC_API_KEY=

# Gateway auth token (auto-generated)
OPENCLAW_GATEWAY_TOKEN=

# Optional: Telegram bot token
# TELEGRAM_BOT_TOKEN=

# Optional: Discord bot token
# DISCORD_BOT_TOKEN=

# Disable debug payload logging (IMPORTANT for privacy)
OPENCLAW_ANTHROPIC_PAYLOAD_LOG=0

# Disable verbose cache tracing
OPENCLAW_CACHE_TRACE=0
ENVEOF

# Inject the generated token
sed -i "s/^OPENCLAW_GATEWAY_TOKEN=$/OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}/" "${ENV_FILE}"
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
echo "  Environment file: ${ENV_FILE}"
echo "  Add your ANTHROPIC_API_KEY there."

# ------------------------------------------------------------------
# 9. CREATE SECURE OPENCLAW CONFIG
# ------------------------------------------------------------------
echo "[9/10] Creating secure OpenClaw config..."
CONFIG_FILE="${OPENCLAW_DIR}/openclaw.json"
if [ ! -f "${CONFIG_FILE}" ]; then
    cat > "${CONFIG_FILE}" << 'CFGEOF'
{
  "gateway": {
    "bind": "loopback",
    "port": 18789,
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "tls": {
      "enabled": false
    },
    "controlUi": {
      "allowedOrigins": []
    }
  },
  "agents": {
    "defaults": {
      "thinkingDefault": "low",
      "tokenBudget": 500000,
      "maxHistoryTurns": 30,
      "promptCache": {
        "enabled": true,
        "retention": "short"
      },
      "sandbox": {
        "enabled": true
      }
    }
  },
  "logging": {
    "level": "info"
  }
}
CFGEOF
    chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${CONFIG_FILE}"
    chmod 600 "${CONFIG_FILE}"
    echo "  Config created at ${CONFIG_FILE}"
else
    echo "  Config already exists, skipping."
fi

# ------------------------------------------------------------------
# 10. SYSTEMD SERVICE (run as unprivileged user)
# ------------------------------------------------------------------
echo "[10/10] Creating systemd service..."
cat > /etc/systemd/system/openclaw-gateway.service << SVCEOF
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${OPENCLAW_USER}
Group=${OPENCLAW_USER}
WorkingDirectory=${OPENCLAW_HOME}
EnvironmentFile=${OPENCLAW_HOME}/.openclaw-env
ExecStart=/usr/bin/env openclaw gateway run --bind loopback --port ${GATEWAY_PORT}
Restart=on-failure
RestartSec=5

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${OPENCLAW_DIR} /tmp/openclaw
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
MemoryDenyWriteExecute=no
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
echo "  Service created: openclaw-gateway.service"
echo "  Start with: systemctl start openclaw-gateway"

# ------------------------------------------------------------------
# SUMMARY
# ------------------------------------------------------------------
echo ""
echo "============================================"
echo "  HARDENING COMPLETE"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Add your ANTHROPIC_API_KEY to ${ENV_FILE}"
echo "  2. Install OpenClaw: sudo -u ${OPENCLAW_USER} npm i -g openclaw@latest"
echo "  3. Start: systemctl start openclaw-gateway"
echo "  4. Access via SSH tunnel: ssh -L ${GATEWAY_PORT}:localhost:${GATEWAY_PORT} ${OPENCLAW_USER}@your-vps"
echo ""
echo "NEVER expose port ${GATEWAY_PORT} to the public internet."
echo "Use SSH tunnels or Tailscale for remote access."
echo ""
echo "Gateway token: ${GATEWAY_TOKEN}"
echo "(Save this - you'll need it to connect)"
