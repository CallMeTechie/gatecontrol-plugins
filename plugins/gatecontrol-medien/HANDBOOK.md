<!-- version: 1.0.1 -->
# Media – Manual

## What the plugin does {#was-das-plugin-kann}

Media brings your own collection from **Jellyfin** and the **shares of your NAS** (SMB, WebDAV) into the GateControl apps – on the phone, GateControl TV and GateControl for Windows. You set the sources up **once on the server**. Everybody with the right “Media” then sees Media on every one of their devices by itself, with the sources you share with them. Nothing is entered on the device.

- **Jellyfin**: every person gets their own Jellyfin user, so progress and “watched” stay per person. The devices sign in invisibly through Quick Connect. Jellyfin's device list shows each one as “GateControl · …”.
- **NAS shares**: a pair of SMB (at home) and WebDAV (away) or a single share. The password of a read-only user is stored encrypted on the server and only goes to allowed devices.
- **Videos never pass through the server.** At home the devices play directly in the home network, away through the VPN. The server only hands out the list, addresses and access.
- **“Play on TV/PC”**: the phone sends title and position to the own TV or PC and stays the remote.

## Requirements {#voraussetzungen}

- GateControl 1.301.0 or newer (instant revocation when a device is removed from 1.322.0, otherwise within 5 minutes).
- A **licence of its own for Media**. It is not part of GateControl Lifetime or a bundle.
- **Jellyfin 10.9 or newer** with Quick Connect (e.g. the Synology package) and/or SMB/WebDAV shares on the NAS.
- A gateway in the home network through which the server reaches Jellyfin (home target), and a VPN that routes the home network (e.g. 192.168.1.0/24).
- GateControl apps in a version with media from the server.

## Setting up {#einrichten}

### Home targets {#zugriffsziele}

Under **Settings › Plugins › Media › Settings › Home targets** you decide how the server reaches the NAS, e.g. “192.168.1.20 through gateway Home”. The plugin cannot create home targets itself; the source dialog only picks one (“Open home targets” leads there).

- **Jellyfin server (HTTP)**: port 8096. For several Jellyfin servers one target each.
- **WebDAV of the NAS**: only to check sign-in and folder of a share (optional).
- **SMB of the NAS**: reachability only. The server does not speak SMB; the devices check the SMB sign-in.

You enter the addresses for the devices in the source dialog; they do not come from the home target.

### Adding Jellyfin {#jellyfin}

1. In Jellyfin: **Dashboard › API Keys › “+”**, app name “GateControl”. Copy the key.
2. In GateControl: **Settings › Plugins › Media › Sources › Add source › Jellyfin server**.
3. Pick the home target, enter the **address for the devices** (best the IP address, e.g. `http://192.168.1.20:8096`; “Check” suggests Jellyfin's own) and paste the key.
4. **Check**: reachable, version, key valid, Quick Connect. If Quick Connect is off, **“Switch on in Jellyfin”** turns it on in Jellyfin's configuration after asking.
5. Save. The key can only be replaced afterwards, never read.

The DSM firewall must allow TCP 8096 from the gateway and the tunnel network. The home network search (UDP 7359) is not needed.

### Adding a NAS share {#freigabe}

1. In DSM create an own user with **read access** to the media shares only (e.g. “media-read”, without DSM sign-in).
2. **Add source › NAS share**: SMB address (`smb://192.168.1.20/movies`) and/or WebDAV address (`https://192.168.1.20:5006/movies`, HTTPS only), for a self-signed certificate its SHA-256 to pin, user and password.
3. With a WebDAV home target “Check” checks sign-in and folder.

Use IP addresses rather than names like `\\nas`: names do not resolve away.

### Network: at home directly, away through the VPN {#netz}

- **At home** the devices play directly in the home network, never through the server or the tunnel, also with the VPN on. A device finds out itself that it is at home, over the Wi-Fi/LAN (never through the tunnel): it asks the Jellyfin server (matching server ID) or checks the pinned certificate of the WebDAV share. Without either it checks whether the source's home address answers (e.g. the NAS's SMB port 445) – enough to keep the device off the VPN at home, but not unique: a foreign network with the same address answers too. The tab Sources marks such sources with **“Home not unique”**; a WebDAV address with its certificate (SHA-256) makes them unique. The plugin keeps Jellyfin's server ID from saving; if Jellyfin was off then, “Check” or the next reconcile (every 5 minutes) fetches it. Any 192.168.1.x address alone is not enough.
- **Away** media go **only through the VPN**. If it is off, the app switches it on when playing. Without VPN the app plays nothing away and says “Away only through the VPN”.
- **Exception “Allow away without VPN”**: per source in the source dialog or for all sources under Settings › Network. The source then needs an **HTTPS address for away**, e.g. a GateControl route (`https://jellyfin.example.test`). The dialog refuses an `http://` address. Sources without such an address stay with the VPN away.

### Linking people {#personen}

Tab **People**:

- **Media**: the right to see the media area in the apps. “like groups” takes it from the groups (table Groups below). Administrators have it without a setting.
- **Jellyfin user**: automatic by name (whole name or first name, case ignored), otherwise pick one, “deliberately none” or **“Create in Jellyfin”** (a normal user with a random password nobody sees). Libraries and age limit are set per user in Jellyfin. Jellyfin administrators are never offered. Whoever is a Jellyfin admin gets a second, normal user.
- **Tick per source**: who sees the source. “Default” removes a person's own setting.

For a family TV create a person “Living room” in GateControl and link it to a Jellyfin user “family”.

## Using {#benutzen}

- In the apps **Media** appears by itself once the person has the right and at least one source. **Media › Sources** is only a display there.
- **Tab Devices**: every app of people with the right Media, whether it is signed in to Jellyfin, which share passwords it got and what it reports about its way. **Sign out** deletes the device in Jellyfin and sends it a silent message (delete access and downloads). As long as the person has the right it signs in again by itself.
- **Replace password**: every allowed device gets the new password with its next contact.
- **Overview** (sidebar Apps › Media): licence, numbers, state of the sources, log.
- **“Play on TV/PC”** (setting under Devices): the phone offers the own GateControl TV and Windows devices. The TV fetches the video from the NAS itself.

## Permissions {#berechtigungen}

| Who | What |
|---|---|
| Administrators | set everything up. They have the right Media unless it is switched off for them. |
| People with Media | see Media in their apps with the sources shared with them. |
| Children (family: child) | see NAS shares only with the setting “Children see NAS shares”. For Jellyfin the parental control of their Jellyfin user applies. |
| Devices | get a NAS password only with device binding, an active person with the right to the share. The Jellyfin access is made on the device itself; the server never sees it. |

The Jellyfin key never leaves the server. The log names people, devices and sources, never passwords, keys, codes or Jellyfin tokens.

## FAQ / troubleshooting {#fehlersuche}

- **“The administrator has to switch Quick Connect on”**: Sources › Jellyfin › “Switch on in Jellyfin”, or in Jellyfin Dashboard › General › Quick Connect.
- **“The administrator has to link you to a Jellyfin user”**: tab People, pick or create a Jellyfin user.
- **Jellyfin unreachable**: home target assigned? Gateway online? DSM firewall port 8096?
- **“unreachable through the tunnel”** on the tab Devices: the gateway does not route the home network into the tunnel, or the DSM firewall does not allow the tunnel network (8096, 5006, maybe 445).
- **A phone is lost**: remove it in GateControl (Jellyfin closes at once or within 5 minutes). The NAS password cannot be taken back from a device that never comes online again: change it in DSM and replace it under Sources.
- **Licence**: without a licence of its own for Media the apps hide Media. A GateControl Lifetime licence does not count here.

## New in 1.0.1 {#neu-1-0-1}

- **Home detected for every source:** so far the devices recognised home only by a Jellyfin with a known server ID or a WebDAV share with a pinned certificate. With an SMB-only share, or a Jellyfin that was off when saved, the devices went through the VPN even at home. Now every source gets a detection, if need be “the home address answers” (see [Network](#netz)).
- **Tab Sources and overview:** row “Home detection” and the mark **“Home not unique”**.

## New in 1.0.0 {#neu-1-0-0}

First version: Jellyfin and NAS shares set up on the server, the right Media and visibility per source, automatic linking to Jellyfin users, devices signing in without input through Quick Connect, revocation, the network rule (at home directly, away through the VPN, exception with an HTTPS address), “Play on TV/PC”.
