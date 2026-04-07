#!/usr/bin/env bash
# Apply IVC voice-call provider patches to OpenClaw dist.
# Run from the openclaw repo root after any dist rebuild or update.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$(dirname "$SCRIPT_DIR")/dist"

echo "Applying IVC patches to $DIST"

# 1. Copy IVC provider
echo "  -> ivc-provider-BivCpRov.js"
cp "$SCRIPT_DIR/ivc-provider-BivCpRov.js" "$DIST/"

# 2. Patch runtime-entry — add IVC to provider switch
RUNTIME=$(ls "$DIST"/runtime-entry-*.js | head -1)
if [ -z "$RUNTIME" ]; then echo "ERROR: runtime-entry not found"; exit 1; fi

if ! grep -q '"ivc"' "$RUNTIME"; then
  echo "  -> Patching provider switch in $(basename $RUNTIME)"
  # Add ivc case before mock case
  sed -i '/case "mock": {/i\\t\tcase "ivc": {\n\t\t\tconst { IvcProvider } = await import("./ivc-provider-BivCpRov.js");\n\t\t\treturn new IvcProvider(config.ivc);\n\t\t}' "$RUNTIME"
  # Add ivc to provider enum
  sed -i '/"mock"/{/CallStateSchema/!s/"mock"/"mock",\n\t"ivc"/}' "$RUNTIME"
  # Skip fromNumber for ivc
  sed -i 's/ctx.provider?.name === "mock"/ctx.provider?.name === "mock" || ctx.provider?.name === "ivc"/' "$RUNTIME"
else
  echo "  -> $(basename $RUNTIME) already patched"
fi

# 3. Patch processParsedEvents — add auto-respond for webhook speech events
if ! grep -q "Auto-respond to webhook-delivered speech" "$RUNTIME"; then
  echo "  -> Patching processParsedEvents for auto-respond"
  python3 -c "
import pathlib, sys
p = pathlib.Path('$RUNTIME')
content = p.read_text()
old = '''	processParsedEvents(events) {
		for (const event of events) try {
			this.manager.processEvent(event);
		} catch (err) {
			console.error(\\\`[voice-call] Error processing event \\\${event.type}:\\\`, err);
		}
	}'''
new = '''	processParsedEvents(events) {
		for (const event of events) try {
			this.manager.processEvent(event);
			// Auto-respond to webhook-delivered speech events (IVC provider)
			if (event.type === 'call.speech' && event.isFinal && event.transcript) {
				const call = this.manager.getCall(event.callId);
				if (call && (call.direction === 'inbound' || call.metadata?.mode === 'conversation')) {
					this.handleInboundResponse(call.callId, event.transcript).catch((err) => {
						console.warn('[voice-call] Failed to auto-respond to webhook speech:', err);
					});
				}
			}
		} catch (err) {
			console.error(\\\`[voice-call] Error processing event \\\${event.type}:\\\`, err);
		}
	}'''
if old in content:
    content = content.replace(old, new, 1)
    p.write_text(content)
    print('    patched')
else:
    print('    WARNING: processParsedEvents target not found — may need manual patch')
"
else
  echo "  -> processParsedEvents already patched"
fi

# 4. Patch config schema — add ivc to provider enum and config properties
CONFIG=$(ls "$DIST"/config-*.js | head -1)
if [ -z "$CONFIG" ]; then echo "ERROR: config file not found"; exit 1; fi

if ! grep -q '"ivc"' "$CONFIG"; then
  echo "  -> Patching config schema in $(basename $CONFIG)"
  sed -i '/"mock"/{/CallStateSchema/!s/"mock"/"mock",\n\t\t"ivc"/}' "$CONFIG"
  sed -i '/plivo: PlivoConfigSchema.optional(),/a\\tivc: zod_exports.z.object({ masterControllerUrl: zod_exports.z.string().optional(), ttsSecret: zod_exports.z.string().optional() }).strict().optional(),' "$CONFIG"
  sed -i 's/config.provider !== "mock"/config.provider !== "mock" \&\& config.provider !== "ivc"/' "$CONFIG"
else
  echo "  -> $(basename $CONFIG) already patched"
fi

# 5. Patch all plugin.json files
for pjson in "$DIST"/extensions/voice-call/openclaw.plugin.json \
             "$(dirname "$DIST")"/dist-runtime/extensions/voice-call/openclaw.plugin.json \
             "$(dirname "$DIST")"/extensions/voice-call/openclaw.plugin.json; do
  if [ -f "$pjson" ] && ! grep -q '"ivc"' "$pjson"; then
    echo "  -> Patching $(realpath --relative-to="$(dirname "$DIST")" "$pjson")"
    python3 -c "
import json, pathlib
p = pathlib.Path('$pjson')
d = json.loads(p.read_text())
props = d['configSchema']['properties']
enum_list = props['provider']['enum']
if 'ivc' not in enum_list:
    enum_list.append('ivc')
props['ivc'] = {'type': 'object', 'additionalProperties': False, 'properties': {'masterControllerUrl': {'type': 'string'}, 'ttsSecret': {'type': 'string'}}}
p.write_text(json.dumps(d, indent=2))
"
  fi
done

echo ""
echo "IVC patches applied successfully."
echo "Restart OpenClaw: openclaw gateway restart"
