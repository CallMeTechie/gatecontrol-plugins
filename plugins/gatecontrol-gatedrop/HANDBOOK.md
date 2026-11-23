<!-- version: 1.7.0 -->
# GateDrop

## What the plugin does

Sharing like Quick Share – through your own GateControl server:

- Send **files** (1 to 20 per send, up to 2 GB each), a **text** or a **link**.
- **To people:** as a message in the Messenger.
- **To your own devices** (Android, Windows): directly device to device on the same Wi-Fi, otherwise through the server. GateControl TV always receives through the server.
- **Into NAS folders** (the NAS (Synology) plugin) and **into your own Drive** (the Drive plugin).
- **As a link for outsiders:** time-limited, optionally with a PIN.
- What you receive stays on the server until it is picked up – an administrator sets for how long (default 7 days).
- GateControl's virus scan checks new files when it is set up.

## Requirements

- GateControl **1.193.0** or later.
- To send to people: the **Messenger** plugin.
- For NAS folders: the **NAS (Synology)** plugin with shared folders (“Folders for GateDrop”).
- For your own Drive: the **Drive** plugin 1.4.0 or later and a Drive seat for the person.
- For devices: the GateControl app on Android, the Windows client or GateControl TV (receiving through the server only).

## Setting up

1. **Install the plugin.** Sending to people and your own devices works right away.
2. **Links for outsiders** (optional): **Settings › Plugins › GateDrop › Permissions** › switch **“Allow public links”** on (default off). Links use your server's public address.
3. **NAS folders** (optional): share folders in the NAS (Synology) plugin under “Folders for GateDrop”.
4. **Retention** on the admin page **“Overview”**: “after pick-up” at once / 1 / 3 / 7 days and “not picked up” 3 / 7 / 14 / 30 days (default 7 / 7).
5. **On the devices:** on the GateDrop page of the app or the Windows client you choose who may send to that device – only you (default) or every account of this GateControl.

## Using it

### Sending

- **Portal tab “GateDrop”:** drop or choose files, paste a text or link (Ctrl+V), pick the target under **“Send to”**, **“Send”**.
- **Apps:** the app's GateDrop page or “Share” from another app.
- Targets: people (also the whole family), your devices, other people's opened devices, NAS folders, your Drive, “Link for outsiders …”.

### Link for outsiders

Valid for 1 hour, 1 day, 7 days or 1 download, optionally **protected with a PIN** – pass the PIN on separately, e.g. by phone. After 5 wrong PINs the link is locked. Under **“Active links”** you see your links and can end them.

### Receiving

- On devices the app picks the files up; “picked up” only counts once the device has saved everything.
- People get the send as a message in the Messenger.
- Notifications: “Received” and “Link downloaded” (how often, “link locked” after 5 wrong PINs).

### Overview (administrators)

Storage used, arrived sends, the way (direct or through the server), what is not picked up, and the list of all sends with their status – **without** file names, texts, links and paths, only names of people and devices. **“Free up storage”** deletes server copies of old or picked-up sends; what is already on devices, the NAS, in Drive or the Messenger stays there.

## Permissions

- **Send to people and your own devices:** every account – never a kiosk device, never a visit through device trust alone.
- **To another person's device:** only when that person opened it for everyone on that device.
- **Links for outsiders and NAS folders:** administrators and parents from the Family plugin. Links also only with “Allow public links”.
- **Own Drive:** everyone with a Drive seat.

## FAQ / troubleshooting

**“Links for outsiders are switched off.”**
An administrator switches them on under Settings › Plugins › GateDrop › Permissions › “Allow public links”.

**My device is not listed as a target.**
Only app installations that have used GateDrop before are listed as your devices – the Android app, the Windows client and GateControl TV. Open the app's GateDrop page once. The Linux agent, gateways and iOS are never listed; they cannot receive.

**A direct send shows "direct …" for a moment.**
It counts as delivered only once the receiving device confirms it saved everything. Without that confirmation within 20 seconds GateDrop takes the way through the server by itself – the device still gets the send, once.

**The transfer does not go direct.**
Direct transfers only work when both devices are on the same Wi-Fi. Otherwise GateDrop takes the way through the server by itself.

**“The virus scan is not reachable right now”.**
Send again later. Blocked files are never passed on.

**A send says “Removed by the admin”.**
An administrator deleted its files on the server.

## New in 1.7.0

- **The TV as a target:** GateControl TV shows up under “Send to” as one of your devices (or as someone else's shared device) with a TV icon and receives files, text and links. The TV never takes a send directly on the Wi-Fi – GateDrop sends everything to it through the server, by itself and without a second delivery.

## New in 1.6.0

- **Only devices with GateDrop as targets:** the Linux agent, gateways and other devices without GateDrop are no longer listed under "Send to" – not among other people's shared devices either.
- **Delivered directly only with a confirmation:** a send directly over Wi-Fi reads "delivered" and "picked up" only once the receiving device has saved everything. Until then it shows "direct …".
- **Falling back to the server:** if the receiving device does not confirm within 20 seconds, the send goes through the server by itself – never delivered twice.
- **Calmer during the nightly virus re-check:** many scan results at once are written together and only when something changes. Sends waiting for the check go on right after.

## New in 1.5.2

- **Less writing:** GateDrop no longer stores who was there on every request of the apps. On a slow disk (a NAS with hard disks) GateControl stays more responsive.

## New in 1.5.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.5.0: overview with all sends (without contents), adjustable retention, “free up storage” and “picked up” only with a real confirmation.
