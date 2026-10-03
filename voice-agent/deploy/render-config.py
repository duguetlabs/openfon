#!/usr/bin/env python3
"""Render root-only service configuration from a restricted JSON credential file.
Never prints credentials. Invoke on the VM as root after certificates exist.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--environment', required=True, choices=['staging', 'production'])
parser.add_argument('--credentials', type=Path, required=True)
parser.add_argument('--agent-image', required=True)
parser.add_argument('--root', type=Path, default=Path('/opt/openfon-voice'))
parser.add_argument('--cert-name', choices=['openfon-voice'], default='openfon-voice')
args = parser.parse_args()
if not re.fullmatch(r'(?:[a-z0-9./:_-]+@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})', args.agent_image):
    parser.error('Agent image must use an immutable sha256 identifier')
if not re.fullmatch(r'[a-zA-Z0-9_-]+', args.cert_name):
    parser.error('Invalid certificate name')
os.umask(0o077)
secrets = json.loads(args.credentials.read_text())
required = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENFON_AGENT_SERVICE_TOKEN', 'KATALEPTIC_API_KEY']
for key in required:
    if not isinstance(secrets.get(key), str) or not secrets[key] or any(c in secrets[key] for c in '\r\n\x00'):
        parser.error('Missing or invalid credential field: '+key)
# Docker env-file raw values may interpret quoting/interpolation. Restrict generated
# values and gateway keys to printable non-whitespace safe token characters.
for key in required:
    if not re.fullmatch(r'[A-Za-z0-9_./+=:-]+', secrets[key]):
        parser.error('Unsupported credential encoding: '+key)
staging = args.environment == 'staging'
port, tcp, udp, turn_udp, turn_tls = (7890, 7891, 7892, 3479, 5350) if staging else (7880, 7881, 7882, 3478, 5349)
voice = 'voice-staging.openfon.ai' if staging else 'voice.openfon.ai'
turn = 'turn-staging.openfon.ai' if staging else 'turn.openfon.ai'
callback = 'https://openfon-staging.duguetlabs.workers.dev' if staging else 'https://openfon.ai'
out = args.root / args.environment
out.mkdir(parents=True, exist_ok=True, mode=0o700)
# JSON is valid YAML, avoiding unsafe string interpolation into YAML.
config = {
    'port': port,
    'bind_addresses': ['0.0.0.0'],
    'rtc': {'tcp_port': tcp, 'udp_port': udp, 'use_external_ip': True},
    # tls_port is the internal TLS listener behind nginx SNI passthrough.
    # Pinned LiveKit 1.13.7 advertises turns:<domain>:443 whenever TLSPort > 0:
    # https://github.com/livekit/livekit/blob/8d11efdfcd4220092b6ac7b8a21af28526da5a6b/pkg/service/roommanager.go#L1069
    'turn': {'enabled': True, 'proxy_protocol': True, 'proxy_protocol_trusted_cidrs': ['127.0.0.1/32'], 'domain': turn, 'tls_port': turn_tls, 'udp_port': turn_udp,
             'cert_file': f'/etc/letsencrypt/live/{args.cert_name}/fullchain.pem',
             'key_file': f'/etc/letsencrypt/live/{args.cert_name}/privkey.pem'},
    'keys': {secrets['LIVEKIT_API_KEY']: secrets['LIVEKIT_API_SECRET']},
    'logging': {'level': 'warn'},
    'room': {'empty_timeout': 60, 'departure_timeout': 20, 'max_participants': 3},
}
(out / 'livekit.yaml').write_text(json.dumps(config, indent=2)+'\n')
agent = dict(secrets)
agent.update(LIVEKIT_URL=f'ws://127.0.0.1:{port}', OPENFON_API_URL=callback, LK_OPENAI_DEBUG='0', LIVEKIT_AGENT_PORT='8091' if staging else '8081')
(out / 'agent.env').write_text(''.join(f'{k}={agent[k]}\n' for k in [*required, 'LIVEKIT_URL', 'OPENFON_API_URL', 'LK_OPENAI_DEBUG', 'LIVEKIT_AGENT_PORT']))
(out / '.env').write_text('LIVEKIT_IMAGE=livekit/livekit-server@sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3\nAGENT_IMAGE='+args.agent_image+'\n')
shutil.copyfile(Path(__file__).with_name('compose.yaml'), out / 'compose.yaml')
for path in out.iterdir():
    if path.is_file():
        path.chmod(0o600)
print('Rendered '+args.environment+' service configuration (credentials not displayed)')
