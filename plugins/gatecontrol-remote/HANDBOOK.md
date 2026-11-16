<!-- version: 1.1.0 -->
# Remote access – Handbook

## What the plugin does {#was-das-plugin-kann}

Remote access is GateControl's former "Remote desktops" as a plugin of its own. You add devices – Windows PCs, servers, a Raspberry Pi, a NAS – and connect to them:

- **in the browser** over RDP, VNC, SSH or Telnet. The session runs on a page of GateControl in a new tab.
- **in the GateControl apps** (Android, Windows) with RDP as before. The apps do not notice the move.

On top: wake-on-LAN, maintenance windows, a reminder to renew credentials, rights per person and group, and the history of every session.

Since 1.1.0 **Windows PCs register themselves**: when somebody switches on "Allow Remote Desktop" in the GateControl app for Windows, the PC shows up at once under Remote access › Devices. One connects with the code shown on the PC and only after the confirmation at the PC (see [Windows PCs from the app](#windows-pcs)).

Passwords and SSH keys are not stored by the plugin but in GateControl's encrypted vault. The plugin only knows a reference to them.

## Requirements {#voraussetzungen}

- GateControl **1.284.0** or newer (remote access interface version 2: registration of the Windows PCs, firewall per session, silent signals to the PC).
- For Windows PCs from the app: the GateControl app for Windows (Pro) with "Allow Remote Desktop" and Windows **Pro, Enterprise or Education**. Windows Home cannot offer Remote Desktop.
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

## Using it {#benutzen}

**In the portal:** the tab **Remote access** shows your devices with their state. "Connect" opens the session in a new tab. If "Open session" appears instead, tap it. "Wake up" sends a wake-on-LAN packet. A Windows PC with "Code only" shows "Enter code" there. With the right "Redeem support codes" there is "Enter code" at the top as well, for PCs that are not in your list.

**In the apps:** RDP devices are listed in the GateControl apps under Remote Desktop as before.

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

**Recording:** recording sessions comes with a later version.

**The PC does not show up:** the person needs the right "Share own devices". Windows Home has no Remote Desktop – the app says so.

**"The PC did not open the connection in time":** the app on the PC did not report within 15 seconds that port 3389 is open. Is the app running and connected to GateControl?

**"Too many wrong codes":** wait 15 minutes or let the PC show a new code.

**In the browser Windows does not ask for the sign-in:** when the PC requires network level authentication (NLA), the session in the browser needs a user name and password that the session page does not ask for yet. Connect from the GateControl app then.

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
