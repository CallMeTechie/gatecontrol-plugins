<!-- version: 1.9.0 -->
# Remote access – Handbook

## What the plugin does {#was-das-plugin-kann}

Remote access is GateControl's former "Remote desktops" as a plugin of its own. You add devices – Windows PCs, servers, a Raspberry Pi, a NAS – and connect to them:

- **in the browser** over RDP, VNC, SSH or Telnet. The session runs on a page of GateControl in a new tab.
- **in the GateControl apps** (Android, Windows) with RDP as before. The apps do not notice the move.

On top: wake-on-LAN, maintenance windows, a reminder to renew credentials, rights per person and group, and the history of every session.

Since 1.8.0 the page **Devices shows cards or a table** with search, filters and icon buttons. **“Set up the key automatically”** puts GateControl's SSH key onto the device once with a user and a password – the password is not stored. For a **Linux computer with the agent** the page makes the code with the finished command itself and shows live how the device registers; a device made by hand can be switched to the agent this way. Before connecting, **tmux sessions and windows can be ended** (see [Set up the key automatically](#schluessel), [Linux device with agent](#agent-code) and [SSH in the terminal](#terminal)).

Since 1.7.0 **“Add device” starts with the target**: GateControl lists the devices in the VPN, the devices behind each gateway and the shared services, checks the ports and picks the way itself (see [Add a device](#hinzufuegen)).

Since 1.5.0 a **Windows PC can share its screen** too – with “Share screen” in the GateControl app for Windows, also on **Windows Home**. The helper sees the screen in the browser and may control it with mouse and keyboard after the confirmation at the PC (see [Share a Windows screen](#windows-teilen)).

Since 1.4.0 the helper may also **control** the phone on request – tap, swipe, type, Back/Home/Overview – when the person at the phone allows it for this request. That needs the app **from GitHub**; the app from Google Play only shows the screen (see [Control a phone](#steuern)).

Since 1.3.0 an **Android phone can share its screen**: in the GateControl app for Android the person switches on "Share screen", passes the code to the person who helps and confirms on the phone. The helper sees the screen in the browser – for now **view only** (see [Share a phone's screen](#handy)).

Since 1.2.0 **SSH runs in GateControl's own terminal** – in the browser and natively in the apps, with **tmux** (the session keeps running on the device when the connection drops) and a checked host key. Sessions can be **recorded** on request and played back in the browser (see [SSH in the terminal](#terminal) and [Recording](#aufzeichnung)).

Since 1.1.0 **Windows PCs register themselves**: when somebody switches on "Allow Remote Desktop" in the GateControl app for Windows, the PC shows up at once under Remote access › Devices. One connects with the code shown on the PC and only after the confirmation at the PC (see [Windows PCs from the app](#windows-pcs)).

Passwords and SSH keys are not stored by the plugin but in GateControl's encrypted vault. The plugin only knows a reference to them.

## Requirements {#voraussetzungen}

- GateControl **1.300.1** or newer. From this version on GateControl also dims the header when a long dialog moves the page, and tells the plugin the free room correctly – the dialogs then fit the window exactly.
- For “Set up the key automatically”, ending tmux sessions and codes for the Linux agent on the admin page: GateControl with remote access interface **version 9** (GateControl **1.297.0** or newer). With an older GateControl these buttons are missing; “Generate SSH key” stays, and you make the code for the agent as before under Users › Add device.
- To control a phone: GateControl with remote access interface **version 5** (GateControl 1.287.0 or newer) and the GateControl app for Android **from GitHub** with the accessibility service "GateControl remote control" switched on. With an older GateControl or the app from Google Play only viewing works.
- For screen sharing from a phone: GateControl **1.286.0** or newer (remote access interface version 4, the relay of the picture) and the GateControl app for Android with "Share screen". An older GateControl refuses the phone's registration.
- GateControl **1.285.0** or newer (remote access interface version 3: terminal in the core, tmux, host keys, recording; plus version 2: registration of the Windows PCs, firewall per session, silent signals to the PC).
- For recordings: the drive `remote-recordings` of the `docker-compose.yml` of the new version (GateControl and guacd). Without it nothing is recorded.
- For Windows PCs from the app: the GateControl app for Windows (Pro) with "Allow Remote Desktop" and Windows **Pro, Enterprise or Education**. Windows Home cannot offer Remote Desktop – it has “Share screen”.
- For the new “Add device” dialog: GateControl with the remote access interface **version 7** (GateControl **1.292.0** or newer). With an older GateControl the previous form with tabs stays.
- For Linux devices: GateControl **1.289.0** or newer and the agent **gatecontrol-agent** on the computer (see [Linux devices](#linux)).
- For “Share screen” on a Windows PC: GateControl **1.287.0** or newer and the GateControl app for Windows (Pro) with “Share screen”. Mouse and keyboard as they are (shortcuts, several displays) come with GateControl's remote access interface **version 6** (GateControl 1.288.0 or newer); with version 5 control means clicking, dragging, scrolling and text.
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

### Add a device {#hinzufuegen}

“Add device” opens a large dialog. On wide screens the list is on the left and the check of the ports and the way of the choice right next to it; then only the sign-in follows. On narrow screens there are three steps:

1. **Target:** you pick from a list. “In the VPN” shows the VPN devices with their name in the VPN, “Behind gateway …” the devices the gateway’s network watch sees in the home network (name, address, vendor and the open ports SSH, RDP, VNC). Devices without these ports are one line down under “show”. “Shared services” are L4 routes that look like SSH, RDP or VNC, and “Enter another target …” takes a name or an address outside your network. Search and the filters SSH, RDP, VNC help with long lists. Greyed out is what already is a device or registers itself (Windows PCs with the app, Linux computers with the agent).

   **Gateways in a pool:** the gateways of a failover pool see the same home network. They therefore share *one* section “Home network · pool …” with the state “Online (2 of 2)” or “1 of 2 online”, and each device is listed once – the same address in the same subnet is one device; the ports of all gateways are merged. A device from it goes through the pool: if one gateway fails, the other takes over. Checking and waking go through a gateway of the pool that is online right now. Gateways without a pool keep their own section “Behind gateway …”.
2. **Connection:** protocol and port are filled in. On opening, GateControl checks the ports 22, 3389, 5900 and 23 of this one device – through the gateway or from the server – and shows the way as one line: **in the VPN**, **through gateway “…”** or **over the internet**. What used to be “Access” is under “Advanced”.
3. **Login:** user name and password, for SSH by default a key made by GateControl (you copy its public part once into `~/.ssh/authorized_keys`). “Connect in the browser too” is on for new devices.

At the very top of the list are **“Linux device with agent”** (see [Linux device with agent](#agent-code)) and **“Windows PC or Android phone”** – those come by themselves through the app.

Afterwards you see what was set up with defaults. At first only administrators see the device – “Share with people” changes that. If the device has a second protocol open, GateControl offers “Add with VNC too?” (or SSH, RDP) with everything filled in; a device has one protocol.

**When it does not go smoothly:**

| State | What GateControl shows |
|---|---|
| Not reachable | No port answers. If the watch knows the MAC, you can wake the device. “Add anyway” works, e.g. for a PC that only runs when needed. |
| Port closed | The chosen protocol does not answer, others do – with “Use VNC”, “Enter another port” or “Add anyway”. |
| Gateway offline | Protocol and port come from the last scan. Adding works now, checking once the gateway is back. If the gateway is in a pool, GateControl takes the pool. |
| Known twice | A device with a VPN client that is also in the home network. GateControl suggests the VPN and only asks in this case. |
| Registers itself | Windows PCs with the app and Linux computers with the agent keep address, port and firewall up to date themselves – “Go to the device” opens the existing device. |
| Outside, port open | The server reaches the target. It is stored like “Both”: the browser goes through the server, the apps connect directly. |
| Outside, no port | What is missing: easiest the GateControl app on the PC, else a gateway in that network or port forwarding at the router. |

**The way:** a VPN address goes directly. An address in the home network of a gateway goes through the gateway – GateControl picks the port on the server itself (40000–40999, only reachable in the VPN). Everything else goes from the server.

**Edit** opens the same large dialog: the sections on the left (“Target & way”, “Sign-in”, for SSH “Agent” and “Terminal & tmux”, “Who may use it”, “Wake & maintenance”, “Display & performance”, “Browser & recording”, “Notes & tags”) with a short summary, the chosen section on the right. An error when saving marks its section red and jumps there. “Sign-in” shows whether the last sign-in failed, the choice password / GateControl's key / own key and – for SSH – “Set up the key automatically” or the key set up with fingerprint, path, origin and “Remove key”. “Change target” (under “Target & way”) opens steps 1 and 2. Taken-over devices keep their data, the port on the server too. If the address of a device under “VPN only” lies in the home network of a gateway, GateControl suggests “Connect through the gateway” – before, such a device went nowhere.

### Devices {#geraete}

**The list:** On top the figures (devices, online, offline, sign-in failed, active sessions, waiting agent codes). Below the search (name, address, owner, tag), the protocol chips, “State, way, sign-in” as a drop-down (filters set show as chips with ×; “Problems” means offline, sign-in failed, gateway port missing, credentials unreadable or due), the sorting and the switch **Cards | Table**. The browser remembers the choice; without one there are cards up to 12 devices, the table from 13. In the table every column head sorts.

- **Way** of each device: via gateway “…” (house), in the VPN or app (shield), agent (chip), internet (globe), server's network.
- **Sign-in:** password, key (GateControl's), own key, agent key, code + confirmation or without code – and in red **“Sign-in failed”** when the terminal was refused last time. The card then offers “Set up the key automatically” right away.
- **Actions** are icon buttons with a hint on hover or keyboard focus: Connect (the only one with text), key, check or lock/allow “without code”, wake, edit, switch off/on, delete (red, always with a question). Rare ones are in the menu **⋮**: tmux sessions, connect with the agent, reset host key, history, duplicate, credentials renewed, switch to the terminal.
- **Phone:** below about 700 px width a compact list with a round connect button and ⋮; the menu opens a sheet from below with every action as text.
- **Placeholders:** an agent code not redeemed yet shows as a dashed card “waiting” in the list – with “Show command” and “Remove”. Expired it turns grey (“New code”), after 24 hours it goes.

With a GateControl without remote access interface version 7 (and for devices that register themselves) a device has these tabs:

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
### Set up the key automatically {#schluessel}

Instead of copying the public key into `~/.ssh/authorized_keys` yourself, GateControl signs in **once with a user and a password**, puts its own key in, tests it and switches the device to “sign in with the key”. Administrators only, only for SSH devices you made yourself.

1. Choose **“Set up the key automatically”** on the card (after “Sign-in failed”), in the menu ⋮ or under Edit › Sign-in.
2. Enter user and password and choose the account the key is for: **this account** (default) or **root through sudo** – the account must then be allowed sudo, and the terminal then signs in as root (only when `PermitRootLogin` allows keys, the Debian default `prohibit-password` does).
3. When no host key is pinned yet, the process stops and shows the fingerprint – **before** the password is sent. Compare it on the device with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` and confirm.
4. GateControl puts the line in (folder 700, file 600), signs in again with the key only and shows account, fingerprint, path and origin.

- **The password is not stored** – not in the vault, not in the plugin, not in a log. Under “Advanced” (on by default) a password stored in the vault is deleted too; a stale wrong password would otherwise be tried before the key.
- **Valid only from GateControl** (default, can be switched off under “Advanced”): the line gets `from="…"` with the address the device sees (in the VPN the server's, through a gateway its home network address, with a pool all of them) and `no-agent-forwarding,no-X11-forwarding,no-port-forwarding`. Other lines stay untouched; its own line is found by the comment `gatecontrol:dev-<number>`.
- **An existing key of GateControl** is used again. An own key pasted by hand is only replaced with the tick under “Advanced”.
- **At most 5 attempts in 10 minutes** per device – that protects against a ban by fail2ban.
- **Remove key** (Edit › Sign-in): GateControl signs in a last time with the key, deletes only its line and then the key in the vault. When the device cannot be reached, the line stays there – the message says so.
- Switch password sign-in off on the device yourself afterwards (`PasswordAuthentication no` in `/etc/ssh/sshd_config`) – GateControl does not change the sshd configuration.

| Message | What to do |
|---|---|
| Sign-in refused | User or password do not match; nothing was changed on the device. Enter the password again. |
| Device does not allow signing in with a password | It only takes keys. Put the line in yourself (the dialog shows it to copy, “Put in, test the sign-in” checks it) or use the Linux agent. |
| sudo asks for another password / account may not use sudo | Enter the sudo password (not stored either) or “Set it up for … instead” (the sign-in account itself). |
| No Unix shell | Windows OpenSSH, for example: put the line in yourself, for administrators into `C:\ProgramData\ssh\administrators_authorized_keys`. |
| File cannot be written | Read-only file system or `chattr +i`. |
| Key not accepted | Another `AuthorizedKeysFile`, `PubkeyAuthentication no` or permissions. GateControl takes its line out again. |
| The host key changed | Locked, no password sent. Use “Reset host key” only when the change was planned. |

### Linux device with agent {#agent-code}

With GateControl from remote access interface version 9 you make the code for the agent right here:

1. **Add device › “Linux device with agent” › Next.**
2. On the left choose name, **owner** (default: yourself; else a person with the right “Share own devices” – they then see the device in the portal), SSH with the account (not root), tmux, “install tmux when it is missing”, desktop and **who may connect**. The default is **“Without a code for people with access”** – on a server without a screen nobody would confirm otherwise; for another person's device with a desktop “Only with a code”.
3. **“Make a code”**: on the right the code (10 minutes, once), the finished command to copy and the **live state** in four steps – code made, redeemed, VPN connected, registered in Remote access. Every change on the left builds the command again, the code stays. “New code” makes the old one invalid. You can close the dialog; the code stays a placeholder in the list.

```
sudo gatecontrol-agent enroll https://gate.example.org 4C2E-8A17-D3F0-5B96 --name nas-keller
sudo gatecontrol-agent share ssh --as kim --tmux --install-tmux
sudo gatecontrol-agent share open
```

The server address comes from GateControl's `GC_BASE_URL`. When it hangs: after 2 minutes without the VPN the state asks about `gatecontrol-agent.service` and the UDP port; when the VPN is up but the share is missing, it names the command `share ssh`.

**Connect with the agent** (Edit › Agent or the menu ⋮ of an SSH device): switches a **device made by hand** to the agent. It stays **one** device – same number, name, rights, history, tmux name. Only when the agent registers do the way (the agent's own VPN) and the sign-in (the agent's key) change; until then the old way works. The password in the vault and the port through the gateway are removed, the old settings stay stored in the device. When the agent reports **another host key** than the pinned one (reinstalled, wrong computer), nothing is merged automatically: both devices stay until you choose **“Keep as a device of its own”** or **“Merge anyway”**.

### Linux devices {#linux}

A Linux computer – with or without a desktop (Debian, Ubuntu, Raspberry Pi OS, CachyOS) – signs up through the service **gatecontrol-agent** (a package of its own, repository `gatecontrol-linux-agent`). The portal tab Remote access shows the same steps under **“Set up a Linux device”**.

1. Install the package – the newest version from the [Releases](https://github.com/CallMeTechie/gatecontrol-linux-agent/releases) page (older versions and `SHA256SUMS` are there too):
   - Debian, Ubuntu, Raspberry Pi OS: `curl -LO https://github.com/CallMeTechie/gatecontrol-linux-agent/releases/latest/download/gatecontrol-agent_amd64.deb && sudo apt install ./gatecontrol-agent_amd64.deb` – instead of `amd64` use `arm64` or `armhf` depending on the computer (`dpkg --print-architecture` names it).
   - CachyOS, Arch: `curl -LO https://github.com/CallMeTechie/gatecontrol-linux-agent/releases/latest/download/gatecontrol-agent_x86_64.pkg.tar.zst && sudo pacman -U gatecontrol-agent_x86_64.pkg.tar.zst` (ARM: `aarch64`).
   - Fedora, openSUSE (no promise): `curl -LO https://github.com/CallMeTechie/gatecontrol-linux-agent/releases/latest/download/gatecontrol-agent_x86_64.rpm && sudo dnf install ./gatecontrol-agent_x86_64.rpm`.
2. Create a code – as an administrator under **Remote access › Devices › Add device › “Linux device with agent”** (GateControl with version 9, see [Linux device with agent](#agent-code)), else under **My devices › Add device** or **Users › Add device** (“App on a device”, rights “Everything for the app”, VPN peer “New peer (automatic)”) – and sign in: `sudo gatecontrol-agent enroll https://<server> <code>`. The agent sets up WireGuard for the VPN network only (no default route, no DNS).
3. Share: `sudo gatecontrol-agent share ssh --as <account> --tmux` and – with a desktop – `sudo gatecontrol-agent share desktop`. `gatecontrol-agent code` shows the code for the helper, `gatecontrol-agent status` the state.

- **SSH:** GateControl makes a key of its own for each Linux device in the vault; the agent adds the public half to the account's `authorized_keys`, valid only from the server. The computer's **host key** is pinned at sign-up – the first connection is checked too. With tmux the session keeps running when the connection drops.
- **Desktop:** detected are KRdp (KDE), GNOME Remote Desktop, wayvnc (Raspberry Pi OS), xrdp and x11vnc. The agent opens the port per session for exactly one address.
- **Default “code only” and confirmation at the device:** the code alone does not connect. Each request waits 30 seconds at the device: `gatecontrol-agent requests` shows it, `sudo gatecontrol-agent allow <id>` allows, `deny <id>` declines. The portal shows the helper the matching command with the request's number. “No code for permitted people”: `sudo gatecontrol-agent share open`.
- **Devices without a screen and nobody at them:** with `sudo gatecontrol-agent confirm code` the code is enough – whoever has it connects without being asked. That is a deliberate setting (the CLI warns); back with `confirm ask`.
- **Helping:** in the portal **“Enter code”**; for a device with SSH and a desktop choose the **connection** (SSH or desktop).
- Under Devices (admin) a Linux device shows “Linux”, the account, tmux, the desktop and the pinned host key.

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

- **Switching:** open the device, tab **Terminal**, and click **"Try in the terminal"**. When the connection works, the device shows "Terminal tested". Then **"Switch to the terminal"** in the menu ⋮ of the list – or **"Switch all SSH devices"** at the top. You go back in the Terminal tab under "Connect with".
- **tmux:** with "Resume the session with tmux" the session keeps running on the device when the connection drops or you move from the phone to the PC. The name is "gc-" and the short name of the device or one of your own (letters, digits, `_` and `-`). In the portal you choose "Resume" with the name of the session or "Start a new session" before connecting. Without tmux on the device there is a normal shell and a hint.
- **Host key:** on the first connection the terminal shows the fingerprint of the device. Compare it (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) and confirm. From then on GateControl only connects with exactly this key. If it changes, the connection is blocked. If the change was planned (a reinstalled device), reset the key in the Terminal tab with **"Reset host key"**.
- **SSH key instead of a password:** **“Set up the key automatically”** puts it in with a user and a password once (see [Set up the key automatically](#schluessel)). Without version 9 **"Generate SSH key"** makes a key in GateControl; add the public part on the device to `~/.ssh/authorized_keys`. The private key stays in the vault.
- **Ending tmux sessions** (version 9): before connecting – in the portal, on the admin page and in the apps – every session can be expanded: windows with number, name, running command and “active”. **“End”** ends a session, **“Close”** a window (with the last one the session ends), **“End all detached sessions”** (from two) every session nobody is attached to – with a list to untick. Every question names what runs in it; when someone is connected, it says so in red. Everybody who may connect the device may do this. It concerns every session of the account GateControl signs in with (also ones that cannot be resumed, with a space in the name), not those of other accounts.

### Recording {#aufzeichnung}

Sessions are recorded only when you allow it – per device in the tab **Recording** and per person or group under **Permissions** (column "Recording"). The stricter of the two holds.

- **Off** (default): no recording.
- **Optional:** the person ticks "Record this session" before connecting.
- **Always:** every session is recorded, also those of family members. Before the start the hint "This session is recorded" always appears, a red dot during the session. The person sees it in their profile as well.

The SSH terminal records what the terminal shows, no keystrokes; RDP and VNC the picture of the session. Recordings are stored encrypted by GateControl. Under **Sessions › Recordings** you play and delete them. Only administrators and the owner of the device may watch; every viewing is in the protocol (filter "Sharing"). How long they are kept is set under **Settings** (default 30 days).

## Using it {#benutzen}

**In the portal:** the tab **Remote access** shows your devices with their state. "Connect" opens the session in a new tab. If "Open session" appears instead, tap it. "Wake up" sends a wake-on-LAN packet. A Windows PC with "Code only" shows "Enter code" there. With the right "Redeem support codes" there is "Enter code" at the top as well, for PCs that are not in your list.

**In the apps:** RDP devices are listed in the GateControl apps under Remote Desktop as before. As an administrator you see every device and every registered PC there. A PC that is not shared with you only lets you in with the code and the confirmation at the PC – also when "without a code for permitted people" is on. You enter the code in the portal under "Enter code". SSH devices with the terminal open in a terminal of the app itself, once the app can do it.

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
- **Administrators** may always do everything and reach every device. In the apps they see every registered PC; to a PC that is not shared with them they connect there only with the code and the confirmation at the PC.
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

## New in 1.9.0 {#neu-1-9-0}

- **Administrators see every PC in the apps:** under Remote Desktop administrators find every device and every registered PC, also "Code only" ones and ones that are offline right now.
- **Seeing is not getting in:** a PC that is not shared with you lets you in only with the code and the confirmation at the PC, also when "without a code for permitted people" is on. For everybody else nothing changes.

## New in 1.8.1 {#neu-1-8-1}

- **Dialogs fit the window:** “Add device”, “Edit” and the wizard are as tall as the free room in the window, also in a lower window. Before, they were at least 420 pixels tall and then reached past the window. Only in a very low window (e.g. a phone held sideways) they stay tall enough for the buttons to show; then the page scrolls, without a light band.
- Needs GateControl 1.300.1 or newer.

## New in 1.8.0 {#neu-1-8-0}

- **Devices as cards or a table** with search, protocol chips, filters “State, way, sign-in” and sorting; actions as icon buttons with hints, rare ones in the menu ⋮, on the phone a compact list with a sheet from below.
- **Large dialog** for “Add device” (list on the left, check on the right) and “Edit” (sections on the left, new “Sign-in” and “Agent”).
- **Set up the key automatically:** GateControl puts its SSH key in once with a user and a password – host key first, the password never stored, `from=` only from the server, also for root through sudo. “Remove key” deletes the line on the device again.
- **“Sign-in failed”** on the card when the terminal was refused, with the fitting button.
- **Linux device with agent:** code, finished command and live state right on the admin page; waiting codes as placeholders in the list. **Connect with the agent** switches a device made by hand to the agent – one device instead of two.
- **tmux:** see the windows, end sessions, close windows, end all detached sessions – in the portal, on the admin page and in the apps.
- Needs GateControl with remote access interface version 9 (GateControl 1.297.0 or newer); with an older GateControl everything stays as it was, the new buttons are missing.

## New in 1.7.2 {#neu-1-7-2}

- **Gateways of a pool once:** two gateways of the same failover pool show one section “Home network · pool …” in “Add device”, with “Online (2 of 2)” or “1 of 2 online”, each device once. New devices from it go through the pool; checking and waking through a gateway that is online. Typing an address in the pool’s home network no longer asks which gateway.
- **No light band when scrolling any more:** the wizard keeps to the visible space and scrolls inside; the head with the steps and the buttons stay in place.

## New in 1.7.1 {#neu-1-7-1}

- **Download the Linux agent:** the guide “Set up a Linux device” (portal and [Linux devices](#linux)) now gives the fixed download links that always fetch the newest version of the agent, and the page with every release – instead of placeholders like `<version>` and `<arch>`.

## New in 1.7.0 {#neu-1-7-0}

- **“Add device” anew in three steps:** pick the target from the list (VPN, behind each gateway, shared services, another target), protocol and port are filled in, the way is shown as one line. A targeted check of 22, 3389, 5900 and 23 of the one device, no new broad scan.
- **Port on the server automatic** through a gateway; the field is only under “Advanced”.
- **“Connect in the browser” is on for new devices**; old devices keep their value. New devices are seen by administrators only at first.
- **Edit on one page** with sections instead of ten tabs, “Change target”, a hint for old devices with a home-network address under “VPN only”.
- **“Add with VNC too?”** after saving when the device has another protocol open.
- The apps notice nothing: the data keep “Access” as before. With an older GateControl the previous form stays.

## New in 1.6.0 {#neu-1-6-0}

- **Linux devices** through the agent **gatecontrol-agent** – with or without a desktop: SSH in GateControl's terminal (with tmux) and the desktop over RDP or VNC, default “code only” and **every request confirmed at the device** (`gatecontrol-agent allow <id>`).
- **A key of its own per device** from the vault, the **host key is pinned right away**.
- **Portal:** “Set up a Linux device”, choice between SSH and desktop with a code; device list with “Linux”.

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
