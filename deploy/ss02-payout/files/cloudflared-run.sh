#!/bin/sh
# Starts cloudflared with the tunnel token from the systemd credential, never on the command line.
set -eu
tok="$CREDENTIALS_DIRECTORY/cf-tunnel-token"
if /usr/bin/cloudflared tunnel run --help 2>/dev/null | grep -q -- '--token-file'; then
  exec /usr/bin/cloudflared --no-autoupdate tunnel run --token-file "$tok"
fi
TUNNEL_TOKEN="$(cat "$tok")"
export TUNNEL_TOKEN
exec /usr/bin/cloudflared --no-autoupdate tunnel run
