<!-- version: 1.2.2 -->
# NAS (Synology)

## What the plugin does

- **Monitor Synology NAS:** model, DSM version, uptime, temperature, CPU and RAM, volumes, storage pools, drives with S.M.A.R.T. status and temperature, DSM updates, Hyper Backup tasks and UPS.
- **Control:** restart, shut down (with an explicit confirmation) and Hyper Backup “Back up now”.
- **Notifications:** NAS unreachable, storage degraded or almost full, drive warning or too hot, DSM update available, backup failed, NAS restarted / shut down.
- **GateControl apps:** a widget, quick actions and a Start tile per NAS – for administrators only.
- **Folders for GateDrop:** shared NAS folders the GateDrop plugin may put files into.

The page and the controls are for administrators only. Nothing appears in the web portal.

## Requirements

- GateControl **1.193.0** or later.
- A Synology NAS with DSM 6.0 to 7.2.
- A **DSM account in the group “administrators”**, ideally one only for GateControl.
- A way from GateControl to DSM that GateControl trusts (see step 2).

## Setting up

### Step 1: create an account in DSM

In DSM under **Control Panel › User** create an account of its own and add it to the group **“administrators”**. Status and control need administrator rights. If GateDrop should put files on the NAS, the account needs write access to those folders.

### Step 2: choose the way to DSM (certificate) {#step-2}

GateControl always verifies certificates; DSM's default certificate is self-signed. These ways work:

1. **Recommended:** a GateControl HTTP route through a home gateway to DSM, port 5001, with “HTTPS to the backend”. The gateway speaks HTTPS to the NAS, optionally with a stored certificate fingerprint.
2. DSM over **HTTP on port 5000** as a VPN device or address – the traffic runs through the WireGuard tunnel or the home network. Switch off “Automatically redirect HTTP connection to HTTPS” in DSM for it.
3. HTTPS with a **valid certificate** (e.g. Let's Encrypt) for the name the target uses.

### Step 3: assign the access target

**Settings › Plugins › NAS (Synology) › access targets** › assign the route, VPN device or address to the target “Synology NAS (DSM)” – one entry per NAS.

### Step 4: add the NAS

In the plugin › **“Add NAS”**: name, access target, user name and password of the DSM account. **“Test connection”** shows the model, the DSM version and whether the account has administrator rights.

If 2-factor authentication is on for the account, enter the code from the authenticator app **once**. DSM issues a device token “GateControl” for it (visible and revocable in DSM under Personal › Security › Trusted devices). Later sign-ins need no code.

Account, password and device token are stored encrypted.

### Step 5: settings

**Settings › Plugins › NAS (Synology) › Settings:** polling interval (default 120 seconds), “unreachable” after … failed polls (default 3), storage almost full from … % (default 90), drive temperature too high from … °C (default 55), notification language.

### Folders for GateDrop (optional)

On the plugin page under **“Folders for GateDrop”** you share NAS folders: NAS, path as in the File Station (e.g. `/Familie/Fotos`) and a name. GateDrop may only put files into these folders and their subfolders. Who may do that in GateDrop is decided by GateDrop (admins and parents).

## Using it

- **Page “NAS (Synology)”:** a card per NAS with state, usage, drives and notes; the details with volumes, pools, the drive table, backups and UPS; buttons for restart, shutdown and “Back up now”.
- **App (administrators only):** per NAS “Refresh” with the NAS widget (storage used, CPU, RAM, temperature, state), “Back up now” per Hyper Backup task, “Restart” and “Shut down” with a question first; plus a Start tile per NAS.
- The plugin cannot switch a NAS back on after a shutdown. That is why a **rule** never shuts the NAS down – only you by hand. Restart and backup also work from rules.

## Permissions

Only GateControl administrators see the page, the widget, the quick actions and the Start tile. Every action is in the plugin log with its way (“by admin (App)”, “by admin (rule)”); restart and shutdown also in the activity log. What the plugin may do on the NAS is set by the DSM account.

## FAQ / troubleshooting

**“HTTPS certificate not trusted”.**
Use one of the ways from [step 2](#step-2).

**“DSM redirects HTTP to HTTPS”.**
Switch off the redirect to HTTPS in DSM or use a route through a home gateway.

**“The account has no administrator rights”.**
Add the account to the group “administrators” in DSM.

**Polling pauses after a sign-in error.**
DSM blocks addresses after repeated failed sign-ins. Check user name and password and save again. If DSM asks for a code, click “Enter code” on the card.

**GateDrop cannot save anything.**
The folder is not shared under “Folders for GateDrop”, or the DSM account lacks write access.

## New in 1.2.2

- **Less writing:** Synology only stores the NAS status every 5 minutes; you still see the latest check. On a slow disk (a NAS with hard disks) GateControl stays more responsive.

## New in 1.2.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.2.0: folders for GateDrop – shared NAS folders GateDrop puts files into.
