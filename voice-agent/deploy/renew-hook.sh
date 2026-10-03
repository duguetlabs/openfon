#!/bin/sh
set -eu
# Certbot calls only after successful renewal. TLS is terminated by nginx for
# signaling and by LiveKit for TURN; both must load the new certificate.
nginx -t
systemctl reload nginx
for environment in staging production; do
  dir="/opt/openfon-voice/$environment"
  if [ -f "$dir/compose.yaml" ]; then
    (cd "$dir" && docker compose restart livekit)
  fi
done
