#!/usr/bin/env python3
"""Read-only deployment identity audit. No inference requests or credentials.

Requires an already authorized SSH connection (sudo read access to the running
gateway process) and an already signed-in Azure CLI with deployment read access.
Infrastructure identifiers are explicit arguments, not machine-specific defaults.
"""
import argparse
import datetime
import json
import re
import shlex
import subprocess
import sys

EXPECTED_SOURCE = {
    "gateway.py": "69c6443b947d07c868a8b4d346f93f8ec1c5cc61766393d4bed3fd280a5b6357",
    "voicelive_engine.py": "3a4e80a9b236dec8ac5cbecf3a8f768fa22474e98d3b32213210cb6aa880626d",
}
MODELS = ["gpt-realtime-2", "gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-live-1"]


def run(command, source=None):
    result = subprocess.run(command, input=source, capture_output=True, text=True, timeout=45)
    if result.returncode:
        # External tool diagnostics can contain account details. Do not relay
        # arbitrary stderr/stdout from an authenticated command.
        raise ValueError(f"{command[0]} read failed (exit {result.returncode}); check local authorization")
    return json.loads(result.stdout)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,256}", value):
        raise ValueError("Metadata contained an invalid model identifier")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["ssh-host", "gateway-directory", "service", "subscription", "resource-group", "account"]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    # The remote helper prints ONLY exact nonsecret routing fields and source
    # hashes. It never prints raw environment, credential files or key material.
    source = '''import hashlib,json,pathlib,subprocess,sys,urllib.parse
service,directory=sys.argv[1:]
pid=int(subprocess.check_output(['systemctl','show',service,'--property=MainPID','--value'],text=True).strip())
if pid <= 0: raise RuntimeError('gateway is not running')
allowed={'VOICELIVE_MODEL','AZURE_REALTIME_DEPLOYMENT','AZURE_REALTIME_DEPLOYMENT_GPT_REALTIME_2','AZURE_REALTIME_DEPLOYMENT_GPT_REALTIME_2_1','AZURE_REALTIME_DEPLOYMENT_GPT_REALTIME_2_1_MINI'}
values={}; origins={}
for entry in pathlib.Path('/proc/'+str(pid)+'/environ').read_bytes().split(b'\\0'):
    key,sep,value=entry.partition(b'=')
    name=key.decode(errors='replace')
    if name in allowed: values[name]=value.decode(errors='replace')
    if name in {'VOICELIVE_ENDPOINT','AZURE_REALTIME_ENDPOINT'}:
        origins[name]=urllib.parse.urlsplit(value.decode()).hostname
hashes={name:hashlib.sha256((pathlib.Path(directory)/name).read_bytes()).hexdigest() for name in ['gateway.py','voicelive_engine.py']}
print(json.dumps({'routing':values,'source':hashes,'origins':origins}))
'''
    remote = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", args.ssh_host,
                  "sudo python3 - " + shlex.quote(args.service) + " " + shlex.quote(args.gateway_directory)], source)
    if remote.get("source") != EXPECTED_SOURCE:
        raise ValueError("Gateway source changed: audit dispatch code before trusting the model mapping")
    origins = remote["origins"]
    allowed_hosts = {args.account.lower() + suffix for suffix in [".openai.azure.com", ".cognitiveservices.azure.com"]}
    if origins.get("VOICELIVE_ENDPOINT") not in allowed_hosts or (origins.get("AZURE_REALTIME_ENDPOINT") or origins.get("VOICELIVE_ENDPOINT")) not in allowed_hosts:
        raise ValueError("Azure metadata account does not match the running gateway's upstream endpoints")
    deployments = run(["az", "cognitiveservices", "account", "deployment", "list",
                       "--subscription", args.subscription, "--resource-group", args.resource_group,
                       "--name", args.account, "--query",
                       "[].{deployment:name,model:properties.model.name,version:properties.model.version,state:properties.provisioningState}",
                       "-o", "json"])
    routing = remote["routing"]
    rows = []
    for model in MODELS:
        override = "AZURE_REALTIME_DEPLOYMENT_" + re.sub(r"[^A-Z0-9]", "_", model.upper())
        deployment = model if model == "gpt-live-1" else routing.get(override) or (
            routing.get("AZURE_REALTIME_DEPLOYMENT") if model == "gpt-realtime-2" else None) or model
        deployment = identifier(deployment)
        found = next((row for row in deployments if row.get("deployment") == deployment), None)
        if not found or found.get("state") != "Succeeded":
            raise ValueError(f"Deployment for {model} is missing or not provisioned")
        actual = identifier(found.get("model"))
        if actual != model:
            raise ValueError(f"Route {model} maps to a different Azure model; identity verification failed")
        rows.append({"requestedModel": model, "upstreamDeployment": deployment,
                     "upstreamModel": actual, "upstreamVersion": identifier(found.get("version"))})
    if len({row["upstreamModel"] for row in rows}) != len(rows):
        raise ValueError("Multiple routes map to the same Azure model")
    hd = identifier(routing.get("VOICELIVE_MODEL") or "gpt-4.1-mini")
    if hd in {row["upstreamModel"] for row in rows}:
        raise ValueError("Managed HD configuration collides with a native model")
    print(json.dumps({"checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      "nativeModelsDistinct": True, "routes": rows,
                      "managedHd": {"upstreamModel": hd, "evidence": "configuration-only"},
                      "sourceHashes": remote["source"], "liveSessionVerified": False}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.TimeoutExpired):
        # A fixed failure keeps unexpected external diagnostics out of logs.
        print("Routing verification failed. Check authorization, source revision, routing and deployment identities; no traffic was generated.", file=sys.stderr)
        sys.exit(1)
