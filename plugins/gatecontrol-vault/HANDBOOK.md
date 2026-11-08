<!-- version: 1.4.3 -->
# Vault

## What the plugin does

- **Password manager on your own server:** logins, 2FA codes, notes, cards, Wi-Fi credentials and identities.
- **End-to-end encrypted:** encryption and decryption happen only in the GateControl apps (Android, Windows) and in the portal tab “Vault” in the browser. The server only keeps data it cannot read – no administrator can either.
- **Personal vault** and **shared vaults** (e.g. family, team) with roles.
- **Offline** in the apps, sync without the VPN through the server's normal address.
- **Recovery key** for a forgotten master password and **emergency access** for trusted people.
- **Trash** (30 days) and the last 10 versions of every entry.
- **2FA from a QR code** – from a picture, a screenshot or with the camera.
- **Share a Wi-Fi** on the wall tablet and the portal's start page, for a time you choose.

## Requirements

- GateControl **1.197.0** or later (for “Scan with camera” in the portal 1.196.0 or later).
- For the Wi-Fi share on the wall tablet: the **Family** plugin 1.14.0 or later with the wall tablet switched on.

## Setting up

Everyone sets up Vault themselves – in the app or in the portal tab **“Vault”**:

1. **“Set up Vault”** and choose a **master password**. Only that person knows it. Nobody can reset it, no administrator either.
2. Write down, copy or save the **recovery key** as a text file and keep it in a safe place. Without it, the data is lost if the master password is forgotten.
3. Confirm that you have stored it safely. Only then is Vault set up.

Administrators have nothing to set up. The admin page **“Overview”** only shows who uses Vault, and counts – never names of vaults or entries.

## Using it

### Entries

- **“New”** creates an entry: login, 2FA code, note, card, Wi-Fi or identity, with custom fields and the password generator.
- Secret fields stay hidden until you click **“Show”**. **“Copy”** puts the value on the clipboard.
- 2FA: next to the 2FA key, **“QR code from picture”** (choose a picture, paste a screenshot with Ctrl+V or drop it in) or **“Scan with camera”**. Google Authenticator's export is recognised too.
- Wi-Fi entries show a **QR code** to connect; “Hidden network” for a network that does not broadcast its name.
- **Trash:** deleted entries stay 30 days. **History:** the last 10 versions of an entry.
- **Import / export:** import from other password managers; the CSV export is **not encrypted** – the portal warns first and asks for the master password once more.

### Sharing vaults

Under **“Vaults & sharing”** you create shared vaults and add people. Before adding someone, Vault shows a **safety number** – compare it with the person (e.g. on the phone). Roles:

- **View** – see and copy entries,
- **Edit** – also create, change, delete,
- **Manage** – also add and remove people, change roles, rename or delete the vault.

A vault always keeps at least one manager. The personal vault is never shared.

### Emergency access

Under **“Emergency access”** you name trusted people with a waiting time (1 to 720 hours). When a trusted person asks for access, you get a notification and can refuse. Only when the waiting time has passed (or you agree earlier) can they read all your vaults – read only. You can take the access back at any time.

### Sharing a Wi-Fi

On a Wi-Fi entry under **“Shares”**: share on the **wall tablet** or on the **portal page**, for 5 minutes, 1 hour, 24 hours or permanently. Running shares are shown with the time left on the entry and can be ended at any time.

> **Note:** a share is a **readable copy** of network name, security and password on the server – otherwise the tablet and the portal could not show it. The dialog says so first. The portal start page shows it to every signed-in person, never to a kiosk device and never without signing in.

### Locking

The portal tab locks after 5 minutes without input, on **“Lock now”** and when it is closed. The keys live only in the tab's memory.

## Permissions

- Every signed-in person can use Vault – never a kiosk device and never a visit recognised only by device trust.
- Shared vaults use the roles View, Edit, Manage. Only people who may at least edit in the vault can share a Wi-Fi or end a share.
- Administrators only see the overview with counts. There is **no reset by an administrator**.

## FAQ / troubleshooting

**I forgot my master password.**
Choose the recovery key when unlocking. You then pick a new master password and get a new recovery key – the old one no longer works. Without a recovery key only a released emergency access or other people's shared vaults can help.

**The portal shows “Please sign in”.**
Vault needs a real sign-in in the portal. Vault is not available on kiosk devices.

**“Scan with camera” is missing.**
It needs GateControl 1.196.0 or later. “QR code from picture” always works.

**Saving reports a newer version.**
Someone changed the entry in the meantime. Choose to save your version (the other stays in the history) or save as a copy.

**The Wi-Fi card on the tablet shows an old password.**
A share is a copy. After changing the entry, the entry offers to update the share.

## New in 1.4.3

- **Less writing:** “Last seen” of an account is now accurate to 10 minutes. On a slow disk (a NAS with hard disks) GateControl stays more responsive.

## New in 1.4.2

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.4.1: “Hidden network” in the portal's Wi-Fi editor; the QR code and the share then also find networks that do not broadcast their name.
