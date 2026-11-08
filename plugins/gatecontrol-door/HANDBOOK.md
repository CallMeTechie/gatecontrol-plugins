<!-- version: 1.7.1 -->
# Door & Camera

## What the plugin does

- **Nuki smart locks and openers:** lock, unlock, open (pull the latch), and the buzzer of an opener – in the GateControl app, the widget, quick actions and the portal.
- **Ring doorbells and cameras:** doorbell push with a picture and “Open door”, motion push, pictures in the history. Ring is reached through the **unofficial interface of the Ring app** – no warranty, Ring may change it at any time.
- **Ring mode** (Disarmed / Home / Away) per Ring location – also from Family rules.
- **Cameras in the home network** (since 1.6.0): cameras with ONVIF or RTSP (e.g. Reolink, Tapo, Hikvision) through a GateControl gateway, without a vendor cloud – live picture, snapshot, clips on motion on your NAS or gateway, push with a snapshot when the camera detects a person.
- **Automatic unlock on arrival** – only when you explicitly allow it for a person.
- **Rights per person**, lock and camera, with a time window. Every action is in the history.
- **Safety notices:** door open too long, lock jammed or unreachable, battery low, night check.
- **Doorbell in the family chat:** with the Messenger plugin every ring arrives as a card with the picture and “Open door” in the chat “Family”.

The plugin is a paid add-on (own subscription) and not included in GateControl Lifetime.

## Requirements

- GateControl **1.169.0** or later.
- For Nuki: a **Nuki Bridge** in the home network (recommended) or a **Nuki Web** account.
- For Ring: your Ring account (email, password and the verification code Ring sends you).
- For cameras in the home network: GateControl **1.240.0** or later, a gateway **1.28.0** or later and a camera with ONVIF or RTSP. Everything in the chapter [Setting up cameras in the home network](#kameras-einrichten).
- For the doorbell in the family chat: the Messenger plugin 1.4.0 or later (GateControl 1.177.0 or later).
- For automatic unlock and the Ring mode in rules: the Family plugin with presence.

## Setting up

### Nuki Bridge (recommended, stays in the home network)

1. In the **Nuki app**: Bridge › Manage bridge › **enable HTTP API** and note the **API token** it shows.
2. In GateControl: **Settings › Plugins › Door & Camera › access targets**. Assign the bridge to the target **“Nuki Bridge”** – its address in the home network with port 8080, or a route. For several bridges, assign the target several times.
3. In the plugin on the page **“Devices”** › **“Add bridge”**: enter a name, the access target and the API token, save.
4. **“Find devices”** lists the locks and openers of the bridge. Add the ones you want (see [Adding locks](#adding-locks)).

The token is stored encrypted and never shown again. The plugin never sends it in plain text to the bridge; it signs in with a hash.

### Nuki Web (without a bridge, through the Nuki cloud)

1. On **web.nuki.io** › menu › API › **generate API token**. Rights: view and operate smart locks, view log.
2. In the plugin on **“Devices”** › section “Nuki Web (Cloud)” enter the token and **save** it.

Nuki Web only delivers the cloud's copy. When the lock is not connected to the internet, the state shown may be out of date. The bridge is more reliable.

### Adding locks

On **“Devices”** › **“Add lock”**:

- **Name**, e.g. “Front door”.
- **Source:** bridge or Nuki Web, plus the Nuki ID and the device type (smart lock or opener).
- **Available actions:** lock, unlock, open (latch); the buzzer for an opener. What you leave out is offered to nobody.
- **Door sensor present:** only tick it when the lock really has a door sensor.
- **“Open too long” after minutes** (default 5, 0 = off).
- **Night check** (default 22:00, empty = off): if the door is not locked by then, a notification is sent.

### Connecting Ring (unofficial, no warranty)

1. On **“Devices”** › **“Sign in with Ring”**: email and password of your Ring account.
2. Enter the **verification code** Ring sends you by SMS, email or authenticator app.
3. The Ring app then lists a signed-in device “GateControl”.
4. Under “Cameras & doorbells” **link each camera to a lock**. Cameras without a lock (e.g. at the letterbox) are shared on the page “Permissions” instead.

The password is only sent to Ring for this sign-in and never stored. Only a token that renews itself is kept.

### Settings

On the plugin's page **“Settings”**:

- **Time zone** (for time windows and the night check; empty = the server's) and the **notification language**.
- **Keep pictures** 1 to 30 days (default 7).
- **Motion push** at most every … minutes per camera.
- **Poll Ring** on/off. Off means: no rings, no motion, no notifications – the chime and the TV keep ringing directly from Ring.
- **Import the Nuki Web log:** operations at the lock and the keypad appear in the history.
- **Doorbell in the family chat** (default on, needs the Messenger plugin).
- Below it the **doorbell diagnosis**: the last ring noticed, how fast, and what came of it.

## Setting up cameras in the home network {#kameras-einrichten}

Cameras in the home network work without a vendor cloud: the gateway talks to the camera, pictures and clips stay at the gateway (on a Synology: on the NAS). Do these steps once, in this order.

### Step 1: update GateControl, the gateway and the plugin

1. Update **GateControl** to **1.240.0** or later.
2. Every gateway that should serve cameras to **1.28.0** or later: **Gateways** › your gateway › **“Update to …”** and wait until the new version is shown.
3. This plugin to **1.6.0** or later: **Settings › Plugins** › “Check for updates”.

If the gateway is too old, the row “Cameras” says so (“from 1.28.0”). If GateControl is too old, the page “Devices” says “Cameras in the home network need GateControl 1.240.0 or later”. Ring and the locks keep working in both cases.

### Step 2: renew the compose file (Synology and Linux) {#kameras-compose}

The live picture and clips come from the new service `kameras` next to the gateway (a small container with ffmpeg, without privileges and without an open port). A gateway on **Synology** or **Linux/Docker** only gets it with the new compose file. Without it, search, test picture and motion events already work, the live picture and clips do not.

1. In GateControl: **Gateways** › your gateway › **Functions** › “Devices at home” › row **“Cameras”** › **download docker-compose.yml**. This creates no new keys – do **not** download the whole package or the `gateway.env` again.
2. **Synology:** File Station › `docker/gatecontrol-gateway` › keep a copy of the old `docker-compose.yml`. Container Manager › **Project** › `gatecontrol-gateway` › **Stop**, replace the content in the tab “YAML configuration” with the new file, save, **build and start** the project again.
3. **Linux/Docker:** in the gateway's folder (usually `/opt/gatecontrol-gateway`) keep a copy of the old file, put the new one there and run `sudo docker compose up -d`.
4. Check: the Container Manager or `sudo docker compose ps` now also shows the service `kameras` running.

**Clips on a shared folder (optional):** by default the clips go to the Docker volume `cam-recordings`. On a Synology you can put them in a folder of the NAS: create the folder (e.g. `/volume1/kameras` in the File Station), then enter it in GateControl under **Gateways** › your gateway › **Features** › row “Cameras” › **“Storage and networks”** › “Folder for clips” (GateControl ≥ 1.242.0), download the compose file as above and build the project again. The row says “Clips in the folder /volume1/kameras”; while the gateway still uses the old storage it says “takes effect with the new compose file”. Older GateControl versions: create a file `.env` next to the compose file with the line `GC_CAMERA_DIR=/volume1/kameras`.

**Raspberry Pi:** the Pi image maintains its compose file itself. The service `kameras` comes with the **new Pi image**; it then starts by itself as soon as you switch cameras on.

If your old compose file had your own changes (e.g. another folder), carry them over into the new file.

### Step 3: switch “Cameras” on at the gateway

**Gateways** › your gateway › **Functions** › “Devices at home” › switch **“Cameras”** on. On a Raspberry Pi a hint says how many cameras with motion detection it manages (Pi 3 B+: one, Pi 4: four) – you can switch it on anyway.

### Step 4: enable ONVIF and RTSP on the camera {#kameras-onvif}

The gateway reaches a camera only through ONVIF or RTSP. Many cameras ship with both switched off.

- **Reolink:** in the Reolink app or the web interface › Settings › **Network › Advanced › Server settings** › switch **ONVIF** and **RTSP** on. The ONVIF port is usually **8000**.
- **Tapo:** in the **Tapo app** › camera › camera settings › **Advanced › Camera account** – create one. You enter this account's user and password in GateControl later – **not** your TP-Link account. The ONVIF port is **2020**.
- **Other cameras:** look for “ONVIF” or “RTSP” in the camera's manual.

The camera needs a **private IPv4 address** (e.g. 192.168.x.x) in the gateway's home network. Cameras in another network (such as a camera VLAN) are only reached when that network is listed in GateControl under **Gateways** › your gateway › **Features** › “Cameras” › **“Storage and networks”** › “More networks for the camera search” (e.g. `192.168.20.0/24`). Best give the camera a fixed address in your router.

### Step 5: add the camera

1. In the plugin on **“Devices”** › card “Cameras” › **“Add camera”**.
2. The gateway searches the home network, e.g. “Reolink E1 Zoom · 192.168.1.73 · ONVIF – newly found”. Pick one – or **“Enter the address yourself”** with `rtsp://…` or just the IP address (e.g. `rtsp://192.168.1.80:554/stream1` or `192.168.1.80`).
3. Enter the **gateway**, a **name** (e.g. “Driveway”), the **camera user** and the **camera password**.
4. **“Connect and test”.** The camera is only saved once a test picture arrives.

**Cameras with HTTPS** (from 1.7.0, GateControl ≥ 1.242.0, gateway ≥ 1.29.0): when the camera offers ONVIF only encrypted, tick **“HTTPS”** (without it the gateway tries port 443 last as well). The camera's certificate is **always checked**. Most cameras have a self-signed certificate – then you get “The camera's certificate is not trusted”. Only if you trust the camera in your home network, tick **“Do not check the certificate”** and connect again. The connection stays encrypted; you can untick it later under “Recordings”.

The password is stored encrypted in GateControl and only goes to the gateway. At most 16 cameras per gateway.

### Step 6: set up recordings

On **“Devices”** › **“Recordings”**, per camera:

- **Record clips:** “on motion (people, cars, animals)”, “on motion, only when nobody is at home” or “never – live picture only”. “Nobody at home” comes from the Family plugin's presence. When it is unknown, the gateway does not record in that mode.
- Motion, people, cars and animals are detected by the **camera itself** (ONVIF events) – the gateway does no image analysis.
- **Store on:** the gateway with its free space.
- **Keep:** 7, 14 (default) or 30 days.
- **Push with a snapshot for people** – at most once per camera every 5 minutes.
- **Record sound** (default off). Recording conversations is only allowed with everybody's consent. “Sound” in the portal and the app only appears when sound is on and the camera delivers it.
- **Do not check the certificate** (cameras with HTTPS only).

A clip starts 5 seconds before the motion and ends 10 seconds after it, at most 2 minutes. With less than 1 GB free the gateway records nothing new.

### Step 7: choose who sees the camera

On **“Permissions”** each home camera has a column **“sees”**. Only people ticked there see the camera in the portal and the app, find its clips and get its push. That includes administrators: without a tick they only see the camera on the admin pages.

## Automatic unlock on arrival

1. On **“Permissions”** give the person at least “lock/unlock” and tick **“Allow automatic unlock on arrival”**.
2. In the Family plugin › Presence & smart home › new rule **“Person comes home”** (choose the person) › action **“Unlock front door”** (Door & Camera).

The rule runs as the person who set its actions – that person's rights apply. The plugin only unlocks when everything fits: only “unlock” (never open automatically), inside the time window, at most every 10 minutes, lock reachable and locked, door closed (with a door sensor). Otherwise it refuses and writes the reason to the history and a notification. If the door is not opened within 3 minutes, it locks again (with a door sensor); without one, a notification offers “Lock”.

> **Note:** “home” means the phone is on the home network's Wi-Fi. That can also be the case in front of the house or at the neighbour's. Only switch it on for people who want it, ideally with a door sensor and a time window. Tip: rule “Everyone is out” › action “Lock front door”.

## Ring mode

As in the Ring app under “Modes”: which cameras record in which mode is set in the Ring app. The plugin only shows and switches the mode. Modes must be switched on for the location in the Ring app.

- Switch it on “Devices” › Ring mode, in the portal, from the Start tile and the app's quick actions (toggle Home ⇄ Away and the button “Disarmed”).
- In Family rules, e.g. “Everyone is out” › “Away” and “First person comes home” › “Home”.
- Right “Switch Ring mode” per person and location on “Permissions”. Administrators always may.
- Locations with a Ring Alarm are never switched – there the mode belongs to the alarm system.

## Using it

### Portal and app

The portal tab and the app tab **“Door”** show the locks shared with you, with state, battery and buttons for the actions you may use. Also the cameras, the history and – with the right – the Ring mode. Without signing in (e.g. a kiosk device) you can only look.

The app also offers quick actions and a widget for your locks and the Ring mode.

### Cameras in the portal

- Every home camera you may see, with a snapshot.
- **Live picture** (“● LIVE · HD · over VPN”) only when the phone or PC is in the **VPN** (or in the same network as the server). Without the VPN the app shows a new snapshot every 10 seconds. From 1.7.0 (GateControl ≥ 1.242.0) the live picture also plays in **Firefox** and in Chrome/Edge on the PC (through GateControl's player).
- Resolution (e.g. 2560×1440) and “with sound” under each camera.
- **“Push for people to me”** per camera: switches the push “People at the camera” off or on for you only (from 1.7.0, also in the apps).
- **“Snapshot”** (save), **“Full screen”**, **“Sound”**.
- **“Clips today”** with thumbnails and the **“Last notification”**.
- Ring cameras show the last picture from the Ring cloud.

### Notifications

| Topic | When |
|---|---|
| Doorbell | it rings – with a picture, with “Open door” for people who may also open |
| Camera motion (default off) | Ring reports motion, at most every few minutes per camera |
| People at the camera (home network) | a home camera detects a person – with a snapshot, “Nobody is at home” when nobody is, and the button **“View”** (opens the camera in the app). Can be switched off for you per camera |
| Door & lock | open too long, jammed, unreachable, battery critical, night check |
| Automatic unlock | unlocked, refused, locked again, question |

You choose which topics you get in GateControl's notification settings.

## Permissions

On the page **“Permissions”**, per person:

- per **lock**: none / view / lock+unlock / also open, optionally a **weekly time window** (one that crosses midnight belongs to its start day).
- **Allow automatic unlock on arrival.**
- per **Ring camera**: doorbell and motion push. Cameras linked to a lock follow the lock's rights; cameras without a lock are shared with a tick.
- per **home camera**: “sees”.
- per **Ring location**: “Switch Ring mode”.

**Administrators get no lock rights automatically** – you have to give them to yourself too. Kiosk devices and portal visitors recognised only by device trust can only look. The server checks every action again (right, time window, at most 10 per minute) and writes it to the history – refused ones too.

## FAQ / troubleshooting

**The lock shows “State unclear – last: Locked”.**
The bridge or Nuki Web is stuck on an intermediate state (“Unlocking …”). The plugin then asks the lock itself. With Nuki Web the lock is often not connected to the internet – check in the Nuki app or use the bridge. The page “Devices” shows the raw values under “Diagnosis”; send them along when you need help.

**A ring arrives late.**
The plugin polls Ring every 5 seconds; expect 5 to 15 seconds, the picture up to 8 seconds later. When Ring restricts the instant query for your account, it takes 15 to 60 seconds. The doorbell diagnosis on “Settings” shows what happened.

**A ring reaches nobody.**
The page “Settings” warns when “Poll Ring” is off or a camera is seen by nobody. Link the camera to a lock or tick people on “Permissions”.

**“Add camera” does not find my camera.**
ONVIF is still off on the camera ([step 4](#kameras-onvif)), or the camera is in another network than the gateway. Enter the address yourself (`rtsp://…` or the IP address).

**“The camera refused the user or password.”**
For Tapo you need the camera account from the Tapo app, not your TP-Link account. For Reolink the camera's user (usually `admin`).

**“This address is not in the gateway's home network.”**
The gateway only connects to private IPv4 addresses in its own network (or in networks entered in its settings).

**“The live picture and clips need the service “kameras””.**
The gateway still has the old compose file – see [step 2](#kameras-compose).

**I see no live video, only a picture every 10 seconds.**
Live video is only available in the VPN or in the server's home network. Switch the VPN on in the GateControl app. Some browsers cannot play H.265 cameras (Safari and iOS can) – then set the camera to H.264 in its own settings.

**“The camera's certificate is not trusted.”**
The camera speaks HTTPS with a self-signed certificate. If you trust it, tick “Do not check the certificate” when adding it (or under “Recordings”).

**The live picture stays black in Firefox.**
Firefox plays the live picture from GateControl 1.242.0 through the built-in player. Firefox cannot play H.265 cameras – set the camera to H.264 (sub stream).

**No clips are recorded.**
Check the mode under “Recordings”. With “only when nobody is at home” the Family presence must be known. With less than 1 GB free the gateway records nothing.

## New in 1.7.1

- **Less writing:** Door only stores a lock's state when it changed, otherwise every 5 minutes. The latest check is still what you see. On a slow disk (a NAS with hard disks) GateControl stays more responsive.

## New in 1.7.0

- **Push “People at the camera” with “View”** – opens exactly this camera in the app. Everybody can switch the push off per camera **for themselves** (“Push for people to me” in the portal and the apps).
- **Resolution and sound** in the camera list (e.g. “2560×1440 · with sound”); “Sound” only when the camera delivers it.
- **Cameras with HTTPS:** “HTTPS” and “Do not check the certificate” when adding and under “Recordings”. Default: the certificate is checked (GateControl ≥ 1.242.0, gateway ≥ 1.29.0).
- **Live picture in Firefox** and in Chrome/Edge on the PC through GateControl's player (≥ 1.242.0).
- The clip folder and further networks are now set in GateControl (gateway › Features › Cameras › “Storage and networks”).

## New in 1.6.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0), with the chapter [Setting up cameras in the home network](#kameras-einrichten).
- Notices at the top of the plugin page while a gateway with “Cameras” lacks the new compose file and until you have enabled ONVIF/RTSP on the cameras.

Last in 1.6.0: cameras in the home network (ONVIF/RTSP) through the gateways – live picture over the VPN, clips on motion, push with a snapshot for people, column “sees” per camera on “Permissions”.
