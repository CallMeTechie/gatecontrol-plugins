<!-- version: 1.2.0 -->
# Media – Manual

## What the plugin does {#was-das-plugin-kann}

Media brings your own collection from **Jellyfin** and the **shares of your NAS** (SMB, WebDAV) into the GateControl apps – on the phone, GateControl TV and GateControl for Windows. You set the sources up **once on the server**. Everybody with the right “Media” then sees Media on every one of their devices by itself, with the sources you share with them. Nothing is entered on the device.

- **Jellyfin**: every person gets their own Jellyfin user, so progress and “watched” stay per person. The devices sign in invisibly through Quick Connect. Jellyfin's device list shows each one as “GateControl · …”.
- **NAS shares**: a pair of SMB (at home) and WebDAV (away) or a single share. The password of a read-only user is stored encrypted on the server and only goes to allowed devices.
- **Videos never pass through the server.** At home the devices play directly in the home network, away through the VPN. The server only hands out the list, addresses and access.
- **“Play on TV/PC”**: the phone sends title and position to the own TV or PC and stays the remote.

## Requirements {#voraussetzungen}

- GateControl 1.325.0 or newer.
- A **licence of its own for Media**. It is not part of GateControl Lifetime or a bundle.
- **Jellyfin 10.9 or newer** with Quick Connect (e.g. the Synology package) and/or SMB/WebDAV shares on the NAS.
- A gateway in the home network through which the server reaches Jellyfin (home target), and a VPN that routes the home network (e.g. 192.168.1.0/24).
- GateControl apps in a version with media from the server.

## Setting up {#einrichten}

### Home targets {#zugriffsziele}

There is no separate step: you choose where the server reaches a source only in the source dialog (**“Where does Jellyfin run?”**, **“Where is the NAS?”**). With **“Check and save”** Media allows the server itself to reach that target (the **server access**). For this Media has the permission **“Assign access targets itself”**. It works only in your session as an administrator, and every change is in the activity log. From GateControl 1.325.0 on, **Settings › Plugins › Media › Settings** no longer shows home targets – this is the one place for them. Existing assignments stay valid; the dialog offers them under “Other route or address …”.

- **Jellyfin server (HTTP)**: port 8096. For several Jellyfin servers one target each.
- **WebDAV of the NAS**: to check sign-in and folder of a share.
- **SMB of the NAS**: reachability only (with a VPN peer as the NAS). The server does not speak SMB; the devices check the SMB sign-in.

The Sources tab shows for every source **via** which route it runs and **“Server access: active”**. When you remove a source, Media removes its server access too if no other source uses it. The access of other sources always stays as it is.

### Adding Jellyfin {#jellyfin}

1. In Jellyfin: **Dashboard › API Keys › “+”**, app name “GateControl”. Copy the key.
2. In GateControl: **Settings › Plugins › Media › Sources › Add source › Jellyfin server**.
3. **Where does Jellyfin run?** Routes that look like Jellyfin (name or port 8096) are offered first. Everything else – any route, a VPN peer or an address already assigned – is under **“Other route or address …”**.
4. Paste the **API key**. Media takes the **name** from Jellyfin when checking (server name).
5. **Check and save**: reachable, version, key valid, Quick Connect – the result is shown in the dialog and on the source. If Quick Connect is off, **“Switch on in Jellyfin”** turns it on in Jellyfin's configuration after asking. The key can only be replaced afterwards, never read.

Under **“Advanced”**, filled in: the name, the **home address** (from the route's target, e.g. `http://192.168.2.151:8096`, else the address Jellyfin reports), **Away** (only through the VPN, or the exception without VPN with `https://<route domain>`) and **Download for offline**.

The DSM firewall must allow TCP 8096 from the gateway and the tunnel network. The home network search (UDP 7359) is not needed.

### Adding a NAS share {#freigabe}

1. In DSM create an own user with **read access** to the media shares only (e.g. “media-read”, without DSM sign-in).
2. **Add source › NAS share**: **Where is the NAS?** (route, VPN peer or an address already assigned), **share name** (e.g. `video`), **user** and **password**.
3. **Check and save.** Media creates the SMB address (`smb://<NAS>/video`) and – when the NAS speaks HTTPS – the WebDAV address (`https://<NAS>:5006/video`) itself and allows the server to reach the NAS.

Under **“Advanced”**: name, SMB and WebDAV address, the certificate (SHA-256, to pin a self-signed one) and Away. With a VPN peer as the NAS you enter the home-network addresses there yourself – the peer's VPN address cannot be reached at home. Use IP addresses rather than names like `\\nas`: names do not resolve away.

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
- **Jellyfin unreachable**: right route or peer under “Where does Jellyfin run?”? Gateway online? DSM firewall port 8096?
- **“unreachable through the tunnel”** on the tab Devices: the gateway does not route the home network into the tunnel, or the DSM firewall does not allow the tunnel network (8096, 5006, maybe 445).
- **A phone is lost**: remove it in GateControl (Jellyfin closes at once or within 5 minutes). The NAS password cannot be taken back from a device that never comes online again: change it in DSM and replace it under Sources.
- **Licence**: without a licence of its own for Media the apps hide Media. A GateControl Lifetime licence does not count here.

## New in 1.2.0 {#neu-1-2-0}

- **One place for sources:** the dialog asks only what is needed – **“Where does Jellyfin run?”**, the API key and the name from Jellyfin; for NAS shares **“Where is the NAS?”**, share name, user and password. Everything else is filled in under **“Advanced”**.
- **Server access automatically:** with “Check and save” Media allows the server to reach the chosen target; the dialog says which one beforehand. SMB and WebDAV addresses follow from the NAS and the share name.
- **Sources tab:** per source “via” with the route and “Server access: active”. Removing a source also removes access no other source uses.
- GateControl no longer shows Media's home targets under Settings (see [Home targets](#zugriffsziele)). Needs GateControl 1.325.0 or newer.

## New in 1.1.0 {#neu-1-1-0}

- **Setup in one place:** you add Jellyfin servers and NAS shares only under Media › Sources. In the dialog you pick the route or peer, and saving assigns the home target by itself. The button “Open home targets” is gone (see [Home targets](#zugriffsziele)).
- **Addresses filled in:** the home-network address comes from the route's target, the HTTPS address for away from its domain. You can overwrite both.
- Home targets you already assigned stay valid. Needs GateControl 1.324.0 or newer.

## New in 1.0.1 {#neu-1-0-1}

- **Home detected for every source:** so far the devices recognised home only by a Jellyfin with a known server ID or a WebDAV share with a pinned certificate. With an SMB-only share, or a Jellyfin that was off when saved, the devices went through the VPN even at home. Now every source gets a detection, if need be “the home address answers” (see [Network](#netz)).
- **Tab Sources and overview:** row “Home detection” and the mark **“Home not unique”**.

## New in 1.0.0 {#neu-1-0-0}

First version: Jellyfin and NAS shares set up on the server, the right Media and visibility per source, automatic linking to Jellyfin users, devices signing in without input through Quick Connect, revocation, the network rule (at home directly, away through the VPN, exception with an HTTPS address), “Play on TV/PC”.
