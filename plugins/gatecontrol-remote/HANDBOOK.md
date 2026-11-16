<!-- version: 1.5.0 -->
# Remote access – Handbook

## What the plugin does {#was-das-plugin-kann}

Remote access is GateControl's former "Remote desktops" as a plugin of its own. You add devices – Windows PCs, servers, a Raspberry Pi, a NAS – and connect to them:

- **in the browser** over RDP, VNC, SSH or Telnet. The session runs on a page of GateControl in a new tab.
- **in the GateControl apps** (Android, Windows) with RDP as before. The apps do not notice the move.

On top: wake-on-LAN, maintenance windows, a reminder to renew credentials, rights per person and group, and the history of every session.

Since 1.5.0 a **Windows PC can share its screen** too – with “Share screen” in the GateControl app for Windows, also on **Windows Home**. The helper sees the screen in the browser and may control it with mouse and keyboard after the confirmation at the PC (see [Share a Windows screen](#windows-teilen)).

Since 1.4.0 the helper may also **control** the phone on request – tap, swipe, type, Back/Home/Overview – when the person at the phone allows it for this request. That needs the app **from GitHub**; the app from Google Play only shows the screen (see [Control a phone](#steuern)).

Since 1.3.0 an **Android phone can share its screen**: in the GateControl app for Android the person switches on "Share screen", passes the code to the person who helps and confirms on the phone. The helper sees the screen in the browser – for now **view only** (see [Share a phone's screen](#handy)).

Since 1.2.0 **SSH runs in GateControl's own terminal** – in the browser and natively in the apps, with **tmux** (the session keeps running on the device when the connection drops) and a checked host key. Sessions can be **recorded** on request and played back in the browser (see [SSH in the terminal](#terminal) and [Recording](#aufzeichnung)).

Since 1.1.0 **Windows PCs register themselves**: when somebody switches on "Allow Remote Desktop" in the GateControl app for Windows, the PC shows up at once under Remote access › Devices. One connects with the code shown on the PC and only after the confirmation at the PC (see [Windows PCs from the app](#windows-pcs)).

Passwords and SSH keys are not stored by the plugin but in GateControl's encrypted vault. The plugin only knows a reference to them.

## Requirements {#voraussetzungen}

- To control a phone: GateControl with remote access interface **version 5** (GateControl 1.287.0 or newer) and the GateControl app for Android **from GitHub** with the accessibility service "GateControl remote control" switched on. With an older GateControl or the app from Google Play only viewing works.
- For screen sharing from a phone: GateControl **1.286.0** or newer (remote access interface version 4, the relay of the picture) and the GateControl app for Android with "Share screen". An older GateControl refuses the phone's registration.
- GateControl **1.285.0** or newer (remote access interface version 3: terminal in the core, tmux, host keys, recording; plus version 2: registration of the Windows PCs, firewall per session, silent signals to the PC).
- For recordings: the drive `remote-recordings` of the `docker-compose.yml` of the new version (GateControl and guacd). Without it nothing is recorded.
- For Windows PCs from the app: the GateControl app for Windows (Pro) with "Allow Remote Desktop" and Windows **Pro, Enterprise or Education**. Windows Home cannot offer Remote Desktop – it has “Share screen”.
- For “Share screen” on a Windows PC: GateControl **1.287.0** or newer and the GateControl app for Windows (Pro) with “Share screen”. Mouse and keyboard as they are (shortcuts, several displays) come with GateControl's remote access interface **version 6**; with version 5 control means clicking, dragging, scrolling and text.
- A **licence of its own** for Remote access: month, year or a lifetime licence of the plugin. Remote access is **not** part of the GateControl plan or a server lifetime licence.
- For devices in the home network: a home gateway that reaches the device.

## Set-up {#einrichten}

1. Install Remote access under **Settings › Plugins › Catalogue** and enter the licence under **Settings › Plugins › Remote access › Licence**.
2. If you used "Remote desktops": open **Settings › Plugins › Remote access** and click **"Take over data"** (see [Take-over from Remote desktops](#uebernahme)).
3. Add more devices under **Remote access › Devices › "Add device"** (see [Devices](#geraete)).
4. Give the rights under **Remote access › Permissions** (see [Permissions](#berechtigungen)).

### Take-over from Remote desktops {#uebernahme}

"Take over data" copies from "Remote desktops":

- every target with its number and all settings,
- the credentials (they stay in GateControl's vault),
- who could see a target (people, groups, old app tokens),
- the maintenance windows and the latest 20,000 sessions.

Whoever could see an RDP or VNC target gets the right "Use remote desktops". Whoever saw an SSH or Telnet target gets "Use SSH". A target through a home gateway keeps its port on the server.

**"Take over again"** fetches the state of "Remote desktops" once more. Taken-over devices and their history are replaced; changes to them are lost. Devices you added in the plugin stay. The take-over never removes a right you already set.

"Remote desktops" stays in GateControl; the data is only copied. **Remote access › Settings** shows when it was last taken over.

> **Note:** If a device says "Enter credentials again", GateControl could no longer read them, e.g. after a restore on another server. Open the device, enter username and password again and save.

### Devices {#geraete}

A device has these tabs:

| Tab | What you set |
|---|---|
| Connection | host, port, access, tags, description, whether it is checked regularly |
| Sign-in | username, password, SSH key, domain and what the apps get |
| Display, Resources, Performance, Session | as in Remote desktops (RDP only, Display also VNC) |
| Wake & maintenance | wake-on-LAN with the MAC address, maintenance windows, the reminder to renew credentials |
| Browser | whether people may connect in the browser, clipboard, sound |
| Terminal (SSH only) | GateControl's terminal or Guacamole, tmux, host key, generate an SSH key |
| Recording | off, optional or always |

**Access:**

- **VPN only (internal):** the host is the VPN address or the name of the computer.
- **Public port forward:** the browser connects through the external host name and port.
- **Both:** the apps take the external way, the browser the internal one.
- **Through a home gateway:** the host is the address in the home network; you also pick the gateway or a gateway pool. GateControl opens a port on the server that the gateway passes on into the home network. If the port is in use, pick another number.

**Maintenance windows:** one line per window, e.g. `Mon-Fri 22:00-06:00` or `Sat 08:00-12:00`. Days: Mon Tue Wed Thu Fri Sat Sun (or the German Mo Di Mi Do Fr Sa So). The server's time counts. Nobody connects during that time, not from the apps either.

Empty credential fields stay as they are. "Delete the stored credentials" removes all of them.

### Windows PCs from the app {#windows-pcs}

When somebody switches on **"Allow Remote Desktop"** in the GateControl app for Windows, the app registers the PC. It shows up at once under **Remote access › Devices** marked "Registered by the app", with its owner and the person signed in at the PC.

- **Who sees it:** at first only the owner and the administrators. The owner can share it with more people and groups in the app.
- **Code only (default):** the PC shows a code of 9 digits (e.g. 482-913-075). Whoever wants to help opens the tab Remote access in the portal, taps **"Enter code"** and picks "View and control" or "View only". The PC asks with the person's name and picture. Only when somebody allows it there does the session open. Without an answer it ends after 30 seconds. A code works once and for at most 10 minutes. After every session the PC shows a new one.
- **Without a code for permitted people:** a second switch in the app. Then people with the right "Use remote desktops" and access to the PC connect directly, without a code and without a question. As an administrator you can forbid that per PC with **"Lock “without a code”"**.
- **Firewall per session:** between sessions port 3389 on the PC is closed. For a session the app opens it for exactly one counterpart – in the browser for GateControl itself, in an app for the helper's device – and closes it when the session ends, after 8 hours at the latest.
- **Switch off:** the PC stays in the list as "Signed off", the history stays. Open sessions end, the code is void.
- **Guessing:** after 5 wrong codes in 10 minutes a person waits 15 minutes. The whole server allows 30 attempts per hour. After 10 wrong codes on one PC its code is void.


### Share a Windows screen {#windows-teilen}

In the GateControl app for Windows, **Settings › Security** has the switch **“Share screen”** next to “Allow Remote Desktop” – for help: both see the same, nobody is signed off. It works with every Windows edition, **Windows Home** included.

- **Helping:** open the tab Remote access in the portal, tap **“Enter code”**, type the code from the PC and pick “View and control” or “View only”. When the PC also offers Remote Desktop you choose the **connection** (“Share screen” or “Remote Desktop”). The PC asks with your name; the person there picks “Decline”, “View only” or “View and control”. Without an answer it ends after 30 seconds.
- **While sharing** a red bar at the top of the PC's screen says “… is viewing your screen” or “… is controlling your screen”, with **“Stop”** (and **“View only”** while controlled). Stop disconnects at once and lets go of pressed keys. Then the PC shows a new code.
- **Control:** mouse and keyboard go to the PC as you use them – shortcuts included. What your own browser or system catches (e.g. Alt+Tab) does not arrive. Pasting types text. With several displays you pick the one you see in the toolbar.
- **What does not work:** Windows' prompt for administrator rights (UAC), the lock and sign-in screen and Ctrl+Alt+Del cannot be operated remotely – only the person at the PC can. While such a screen is open the picture stands still and a hint shows.
- **Without a code for permitted people** only spares the code for the screen: **the PC always asks.**
- **Through the server:** picture and input run over your GateControl server as for phones. It only passes them on, stores nothing and logs no input – but it is not end-to-end encryption.
- Sharing needs no open port and no VPN address on the PC; Remote Desktop still does.
### Share a phone's screen {#handy}

In the GateControl app for Android, **Remote access** has the switch **"Share screen"**. When it is on, the app registers the phone and shows a code of 9 digits.

- **Helping:** open the Remote access tab in the portal, tap **"Enter code"** and type the code from the phone. The phone asks "… wants to see your screen" with your name and picture. After "Allow", Android asks once more ("Start now"). Only then the page with the phone's screen opens for you.
- **View or control:** choose "View and control" or "View only" with the code. Control only works when the phone's app comes from GitHub – otherwise the portal offers "View only" alone (see [Control a phone](#steuern)).
- **While sharing** the phone shows a red bar and a notification "Screen is being shared", both with **"Stop"**. Stop disconnects at once. Right after, the phone shows a new code.
- **No code for permitted people:** the phone has the second switch, too. People with access to the phone then tap "Connect" in the portal and skip the code. **The question on the phone and Android's prompt always stay.**
- **Who sees it:** at first only the person and the administrators; share it like a PC. With the right "Redeem support codes" it works with the code without access.
- **Through the server:** the picture runs through your GateControl server. It only passes it on and stores nothing, but it is not end-to-end encryption. Banking apps, password fields and the app's vault pages stay black for the helper.
- The phone needs no VPN for sharing. It counts as offline when its app has not reported for 20 minutes.

### Control a phone {#steuern}

With the GateControl app for Android **from GitHub** the helper may operate the phone – but only when the person at the phone allows it **for this very request**.

- **Set it up once on the phone:** the card "Share screen" says "Control is still off". **"Set up control"** explains what the accessibility service does and leads to Android's accessibility settings. Switch on "GateControl remote control" there. From Android 13, an app from GitHub first needs "Allow restricted settings" in its app info – the app shows the way. It can be switched off at any time in the accessibility settings.
- **Asking:** choose "View and control" in the portal (with "no code", the button of that name). The phone then shows "… wants to see and control your screen" with the box **"View only"**. Without the tick the helper may control, with it only watch. With the accessibility service off it stays at viewing.
- **While being controlled** the phone shows a red bar "… is controlling your screen", a notification and a red frame with "Stop control" over all apps. **"View only"** (bar, notification) or "Stop control" (frame) takes control away at once; viewing goes on. Control again only with a new request. "Stop" disconnects completely.
- **What the helper can do:** click on the picture (tap), hold (long press), drag (swipe), scroll with the wheel, right button for back; buttons Back, Home, Overview and Text. Typed text goes into the field selected on the phone.
- **What does not work:** the lock screen, the PIN entry and Android's own prompts cannot be operated remotely. Password fields cannot be typed into remotely. With only one app shared there is no control.
- **Privacy:** the service only taps and swipes in a session that was approved and sends nothing outside it. Input runs through your GateControl server like the picture and lands in no log.

### SSH in the terminal {#terminal}

An SSH device connects either with **GateControl's terminal** or with **Guacamole** as before. New SSH devices get the terminal; existing and taken-over ones stay on Guacamole until you switch them.

- **Switching:** open the device, tab **Terminal**, and click **"Try in the terminal"**. When the connection works, the device shows "Terminal tested". Then **"Switch to the terminal"** in the list – or **"Switch all SSH devices"** at the top. You go back in the Terminal tab under "Connect with".
- **tmux:** with "Resume the session with tmux" the session keeps running on the device when the connection drops or you move from the phone to the PC. The name is "gc-" and the short name of the device or one of your own (letters, digits, `_` and `-`). In the portal you choose "Resume" with the name of the session or "Start a new session" before connecting. Without tmux on the device there is a normal shell and a hint.
- **Host key:** on the first connection the terminal shows the fingerprint of the device. Compare it (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) and confirm. From then on GateControl only connects with exactly this key. If it changes, the connection is blocked. If the change was planned (a reinstalled device), reset the key in the Terminal tab with **"Reset host key"**.
- **SSH key instead of a password:** **"Generate SSH key"** makes a key in GateControl. Add the public part on the device to `~/.ssh/authorized_keys`. The private key stays in the vault.

### Recording {#aufzeichnung}

Sessions are recorded only when you allow it – per device in the tab **Recording** and per person or group under **Permissions** (column "Recording"). The stricter of the two holds.

- **Off** (default): no recording.
- **Optional:** the person ticks "Record this session" before connecting.
- **Always:** every session is recorded, also those of family members. Before the start the hint "This session is recorded" always appears, a red dot during the session. The person sees it in their profile as well.

The SSH terminal records what the terminal shows, no keystrokes; RDP and VNC the picture of the session. Recordings are stored encrypted by GateControl. Under **Sessions › Recordings** you play and delete them. Only administrators and the owner of the device may watch; every viewing is in the protocol (filter "Sharing"). How long they are kept is set under **Settings** (default 30 days).

## Using it {#benutzen}

**In the portal:** the tab **Remote access** shows your devices with their state. "Connect" opens the session in a new tab. If "Open session" appears instead, tap it. "Wake up" sends a wake-on-LAN packet. A Windows PC with "Code only" shows "Enter code" there. With the right "Redeem support codes" there is "Enter code" at the top as well, for PCs that are not in your list.

**In the apps:** RDP devices are listed in the GateControl apps under Remote Desktop as before. SSH devices with the terminal open in a terminal of the app itself, once the app can do it.

**As an administrator:** under **Remote access › Devices** you can connect to every device – to a Windows PC from the app only "without a code", otherwise with the code like everybody. **Sessions** shows the history, ends open browser sessions and downloads everything as CSV. The filter **"Sharing"** shows redeemed and wrong codes, requests, changes of "without a code" and the opening and closing of the firewall.

**In the profile:** in the portal under "My devices" the section **Remote access** shows what you may do, your registered PCs and the history of their sharing.

## Permissions {#berechtigungen}

| Right | Meaning |
|---|---|
| Use remote desktops | RDP and VNC to the devices the person may reach |
| Use SSH | SSH and Telnet |
| Redeem support codes | connect with the code of a Windows PC, also without access to that PC; off by default |
| Share own devices | register the own PC in the app and show codes; on by default |

- You set a right per **group** or per **person**. "yes" or "no" for a person wins over their groups.
- Without an entry a person has a right as soon as one of their groups has it.
- **Administrators** may always do everything and reach every device.
- **Which devices:** per device "Everybody with the right" or "Only selected" people and groups. Old app tokens from Remote desktops keep working, for the old apps only.
- "What may this person do?" (click the name) shows the rights and reachable devices of a person.

The right is checked again on every connect.

## FAQ / troubleshooting {#fehlersuche}

**"Remote access has no valid licence":** without a licence devices, rights and history are kept, but no new sessions open. Enter the licence under Settings › Plugins › Remote access › Licence.

**A device is missing in the portal:** check whether the person has the right for the protocol and whether the device is set to "Only selected". "What may this person do?" shows it.

**"In the GateControl apps only":** browser access is off for the device. Switch it on in the tab "Browser".

**"Gateway port missing":** the port on the server could not be set up, usually because it is in use. Open the device, pick another "Port on the server" and save.

**The apps show other devices than the portal:** the apps show RDP devices only. Until GateControl has the new interface, their list still comes from "Remote desktops".

**"The host key of the device has changed":** GateControl does not connect because the device shows another key than the first time. If you reinstalled the device, reset the key in the Terminal tab. Otherwise: do not connect and check who answers there.

**Recording does not start:** GateControl needs the drive for recordings of the new `docker-compose.yml`. Without it a device with "always record" does not open. RDP and VNC recordings come once guacd has the drive too (after the next update).

**tmux is missing:** install tmux on the device (`sudo apt install tmux`). Until then the session runs without tmux.

**The phone does not show up / "Screen sharing needs a newer GateControl":** the person needs the right "Share own devices", and GateControl needs remote access interface version 4.

**The portal offers only "View only" for a phone:** the phone's app comes from Google Play or is older, or GateControl does not have remote access interface version 5 yet. Control only works with the app from GitHub.

**"The person at the device switched to 'View only'":** control was ended on the phone. You can keep watching; to control again you need a new request.

**The helper only sees "Waiting for the picture from the device …":** Android's prompt on the phone has not been confirmed with "Start now" yet, or the person declined it. Then the request ends and the helper sees "Sharing was ended on the device".

**The PC does not show up:** the person needs the right "Share own devices". Windows Home has no Remote Desktop – the app says so.

**"The PC did not open the connection in time":** the app on the PC did not report within 15 seconds that port 3389 is open. Is the app running and connected to GateControl?

**"Too many wrong codes":** wait 15 minutes or let the PC show a new code.

**In the browser Windows does not ask for the sign-in:** when the PC requires network level authentication (NLA), the session in the browser needs a user name and password that the session page does not ask for yet. Connect from the GateControl app then.

## New in 1.5.0 {#neu-1-5-0}

- **Share a Windows screen** – “Share screen” in the GateControl app for Windows, also on **Windows Home**: view, and after the confirmation at the PC control with mouse and keyboard, over the same relay as the phones.
- **The person at the PC decides every time** (“View only” / “View and control”) and sees a bar at the top with “Stop”; also “without a code” the PC asks.
- **Portal:** for a PC with Remote Desktop and the screen the choice of the connection; the device list says “Windows · Share screen”.
- Windows Home shows up under Devices as soon as “Share screen” is on.

## New in 1.4.0 {#neu-1-4-0}

- **Control a phone** – "View and control" for phones with the app from GitHub: tap, swipe, scroll, type, Back/Home/Overview.
- **The person at the phone decides every time** ("View only") and can switch to "View only" at any time.
- The app from Google Play stays at viewing; the portal shows "View only" alone for such phones.
- History: "control allowed" and "Switched to 'View only'".

## New in 1.3.0 {#neu-1-3-0}

- **Android phones share their screen** – switch "Share screen" in the app, code, confirmation on the phone and Android's prompt; a new code right after.
- **View only** for now: the screen appears in the browser on a page of GateControl.
- **"No code for permitted people"** on the phone, too – the question on the phone stays.
- Phones show up under Devices as "Android phone", in the portal with "view only"; the profile section is now called "My devices".
- Protocol: "Screen being viewed" and "Screen sharing ended".

## New in 1.2.0 {#neu-1-2-0}

- **SSH in GateControl's own terminal**, in the browser and in the apps – with tmux ("Resume" / "New session") and a checked host key.
- Old SSH devices stay on Guacamole; **switch** them one by one or all at once, "Try in the terminal" first.
- **Generate SSH keys** in GateControl, view and reset the host key.
- **Recording** per device and per person or group: off, optional or always – "always" only with the hint before the start.
- **Recordings** under Sessions: play and delete, retention under Settings; owners of a PC see them in their profile.

## New in 1.1.0 {#neu-1-1-0}

- **Windows PCs from the app:** "Allow Remote Desktop" in the GateControl app for Windows registers the PC. It shows up at once under Devices and for everybody permitted.
- **Code only** (default) with the confirmation at the PC, or **without a code for permitted people**. As an administrator you can lock "without a code" per PC.
- **"Enter code"** in the portal tab, with "Waiting for the confirmation on the device …".
- **Firewall per session:** port 3389 opens for exactly one counterpart and only for the length of the session.
- The rights "Redeem support codes" and "Share own devices" take effect now.
- Filter "Sharing" under Sessions, your PCs and their history in the profile.
- New permission **Notifications** (only silent signals to the own PC) – you confirm it with the update.

## New in 1.0.0 {#neu}

- First version: Remote desktops as a plugin with the pages Devices, Permissions, Sessions and Settings.
- Portal tab "Remote access" and profile section "Remote access".
- Take-over from "Remote desktops" with "Take over again".
- The GateControl apps keep connecting unchanged, credentials only end-to-end encrypted.
- A licence of its own, not part of the plan or a server lifetime licence.
