<!-- version: 1.1.1 -->
# Proxmox VE

## What the plugin does

- Keep an eye on **Proxmox VE hosts and clusters**: nodes with CPU, RAM, storage, swap, uptime, version and load; VMs and containers; storage, backups and HA.
- **Control VMs and containers:** start, shut down cleanly, stop hard (with its own warning), restart. The plugin deliberately never shuts down a node.
- **Notifications:** host or node unreachable, VM/CT stopped unexpectedly, storage almost full, backup failed, high load on a node.
- **GateControl apps:** widgets, quick actions and a Start tile “Proxmox” – for administrators only.

Everything is for administrators only. Nothing appears in the portal.

## Requirements

- GateControl **1.154.0** or later (quick actions from 1.160.0, widgets from 1.171.0).
- Proxmox VE 8.x with an API token (see below).
- A way from GateControl to the Proxmox API (port 8006) with a certificate GateControl trusts – easiest a route through a home gateway.

## Setting up

### Step 1: create an API token in Proxmox

On a Proxmox node as root in the shell:

```
pveum user add gatecontrol@pve --comment "GateControl"
pveum acl modify / --users gatecontrol@pve --roles PVEAuditor
pveum role add GateControlPower --privs "VM.PowerMgmt VM.Audit"
pveum acl modify /vms --users gatecontrol@pve --roles GateControlPower
pveum user token add gatecontrol@pve monitor --privsep 0
```

Proxmox shows the **secret only once** – note it together with the token ID `gatecontrol@pve!monitor`.

- **PVEAuditor** on `/` is enough for the status (read only).
- **VM.PowerMgmt** on `/vms` is needed to start, shut down, stop and restart. Without it the plugin stays read-only.
- **Sys.Modify** on `/nodes` only if you want “Show available updates”.

### Step 2: the way to the Proxmox API (certificate)

GateControl always checks the certificate over HTTPS. Proxmox's self-signed certificate is refused on a direct assignment (“certificate not trusted”). Two ways work:

- **Recommended:** a **GateControl HTTP route through a home gateway** to the Proxmox IP, port 8006, with **“Backend HTTPS”**. The gateway speaks HTTPS into the home network and accepts the self-signed certificate (optionally pinned with its SHA-256 fingerprint). Make the route internal only or protect it.
- **Or:** give Proxmox a certificate from a public authority (Datacenter › ACME, node › certificates, e.g. Let's Encrypt with a DNS challenge). Then assign the address with that DNS name, HTTPS and port 8006.

### Step 3: assign the access target

**Settings › Plugins › Proxmox VE › access targets** › assign the route or address from step 2 to the target “Proxmox VE host or cluster”. For several hosts or clusters, assign the target several times.

### Step 4: add a connection

In the plugin › tab **“Connections”** › **“Add connection”**: name, access target, **API token ID** (e.g. `gatecontrol@pve!monitor`) and **token secret**. **“Test connection”** shows version, cluster and nodes.

The secret is stored encrypted and never shown again.

### Step 5: monitor guests and settings

- In the tab **“VMs & containers”** switch **“Watch”** on for the important guests. Only monitored guests report “stopped unexpectedly” and appear as toggles in the app.
- **Settings › Plugins › Proxmox VE › Settings:** polling interval (default 60 seconds), storage almost full from … % (default 90), CPU and RAM thresholds of a node (default off) and how long they must last, “Show available updates”, recipients and language of the notifications.

## Using it

- **Overview:** per connection the nodes with bars for CPU, RAM, disk and swap, uptime, version, load, updates and HA.
- **VMs & containers:** search and filters, a table with status and load, actions. The plugin asks before every action; “Stop” needs an extra confirmation. The result of the Proxmox task is shown.
- **Storage & backups:** usage of the storages and the latest backups.
- **Connections:** add, edit, test, delete, “Recent actions” and the setup help.
- **App (administrators only):** per connection “Refresh” with a widget (active guests, CPU, RAM, storage, reachability); per monitored guest a toggle (on = start, off = clean shutdown, never a hard stop) and “Restart”; the Start tile “Proxmox”.

## Permissions

The page, actions, widgets and Start tile exist for GateControl administrators only. Every action checks the role again and is logged with the name and the origin (“admin (App)”, “admin (rule)”) in the log and under “Recent actions”. What the plugin may do in Proxmox is set by the token's roles (step 1).

## FAQ / troubleshooting

**“Certificate not trusted”.**
Proxmox uses a self-signed certificate. Use a route through a home gateway with “Backend HTTPS” or a public certificate (step 2).

**The buttons report missing rights.**
The token lacks VM.PowerMgmt on `/vms` (step 1).

**No update list.**
“Show available updates” is off, or the token lacks Sys.Modify on `/nodes`.

**A guest does not report “stopped unexpectedly”.**
Only monitored guests do, and not when the guest was controlled through the plugin in the last 30 minutes.

**The values are old.**
After errors the plugin polls less often (up to every 5 minutes) and shows the last good data with “last updated” and the error.

## New in 1.1.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.1.0: widgets, quick actions and the Start tile “Proxmox” in the GateControl apps for administrators.
