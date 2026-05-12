import json, glob, os

pattern = os.path.join(r"d:\Projects\Convo\Ai Automation\Talent Acquisition", "talent_acquisition.json")
files = glob.glob(pattern)
if not files:
    pattern2 = os.path.join(r"d:\Projects\Convo\Ai Automation\Talent Acquisition", "Talent*.json")
    files = glob.glob(pattern2)

if not files:
    print("ERROR: No JSON file found!")
    exit(1)

fp = files[0]
print(f"File: {fp}")

with open(fp, "r", encoding="utf-8") as f:
    data = json.load(f)

node_names = set()
node_types = {}
for n in data.get("nodes", []):
    node_names.add(n["name"])
    node_types[n["name"]] = n["type"]

sheets = [k for k, v in node_types.items() if "googleSheets" in v]
print(f"Total nodes: {len(node_names)}")
print(f"Google Sheets nodes remaining: {len(sheets)}")
for s in sheets:
    print(f"  - {s}")

conns = data.get("connections", {})
broken = []
for src, targets in conns.items():
    if src not in node_names:
        broken.append(f"SOURCE missing: {src}")
    for conn_type, port_groups in targets.items():
        for ports in port_groups:
            for port in ports:
                tgt = port.get("node", "")
                if tgt not in node_names:
                    broken.append(f"{src} -> {tgt} (TARGET missing)")

print(f"Broken connections: {len(broken)}")
for b in broken:
    print(f"  - {b}")

if not sheets and not broken:
    print("RESULT: Workflow is CLEAN - no Google Sheets, no broken connections!")
