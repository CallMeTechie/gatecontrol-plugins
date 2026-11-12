<!-- version: 1.0.0 -->
# DNS Protection

## What the plugin does

- **Blocks ads, trackers and malicious sites** – for every device that reaches the internet through GateControl’s VPN. The server filters itself; no second device and no Pi-hole are needed.
- **Lists from GateControl’s catalogue**: ads & trackers, malware & fraud, adult content, gambling. Plus own entries **“Always allowed”** and **“Always blocked”**.
- **Profiles** for groups, people and single devices – with their own lists, safe search and times (e.g. no social networks in the evening).
- **Suspending**: switch the protection off for a few minutes when a page does not work – in the Android app, the Windows app and the portal. It switches itself back on.
- **“Check a domain”** shows whether and why an address is blocked for a device.
- **Query log** (can be switched off, off after the installation) and counters: queries, blocked, top blocked domains.
- **If the filter fails**, the devices’ internet goes on unfiltered. The server switches back by itself within seconds and tells the administrators.

## Requirements

- GateControl **1.264.0** or later.
- GateControl’s internal DNS is switched on (that is the default).
- A licence for the plugin. Without a licence, or when the plugin is switched off, the server does not filter; the settings are kept.
- For “parents suspend for their children”: the plugin **Familie** (1.15.0 or later). It creates the family as a group in GateControl.
- For the view in the apps: an app version with the screen “DNS protection”. Older apps do not show it; the portal always works.

> **Note:** Devices that use GateControl’s DNS server are filtered. A device with a DNS server of its own (entered in GateControl under Peers) does not ask the server and is not filtered. The tab “Devices” shows such devices.

## Setting up {#einrichten}

1. Open **Settings › Plugins › DNS Protection › Settings**. On the first visit the dialog **“Set up the DNS protection”** starts.
2. **Pick the lists.** “Ads & trackers” and “Malware & fraud” are suggested. The selection holds for all VPN devices and can be changed later.
3. **Switch on.** The server loads the lists, checks the filter with two probes and then switches the VPN devices’ DNS over. The DNS stays without an answer for about a second.
4. **Done.** Create profiles afterwards if you need them (tab “Profiles”).

**“Later”** closes the dialog. You find it again with “Set up” in the overview.

### Moving from Pi-hole {#umzug-von-pi-hole}

If you have used GateControl’s Pi-hole integration with “Manage the DNS chain”, the dialog notices it. Only one can filter: Pi-hole or the DNS protection.

1. **Found:** the dialog says what changes. Pi-hole keeps filtering until the step “Switch over”.
2. **Lists:** Pi-hole’s lists cannot be read. What Pi-hole blocks out of the box is suggested. Copy your exceptions in Pi-hole under “Domains” → “Allowlist” and paste them (one domain per line).
3. **Switch over:** Pi-hole gives up the DNS chain only once the filter really answers. If a step fails, Pi-hole stays active and the dialog names the reason.
4. **Done:** Pi-hole is no longer needed for the VPN devices. Switch it off or keep it running for the home network.

Back to Pi-hole: tab “Settings” › **“Switch the protection off”**, then switch “Manage the DNS chain” back on in GateControl’s Pi-hole settings.

> **Note:** GateControl’s Pi-hole integration is deprecated and will be removed in a later version.

## Using it

### Overview

Shows whether filtering is on, today’s counters, the most blocked domains and the active lists. A click on a domain opens “Check a domain”.

- **Suspend for all VPN devices:** 5 min, 30 min, 1 h or “until I switch it back on”. Meanwhile nothing is blocked and nothing is counted. **“+30 min”** extends, **“Switch back on”** ends the suspension.
- **Fallback:** when the filter does not answer, a red notice appears here and on the dashboard. The devices’ internet keeps working. **“Restart the filter service”** restarts it by hand; mostly the server switches back by itself.

### Lists & exceptions

- **Lists from the catalogue:** the switches hold for the default profile. Other profiles pick their own lists. Lists are loaded again every day; “Update now” loads them at once.
- **Check a domain:** enter the address, pick a device or profile, “Check”. The result names the profile and the reason and offers “Allow for everybody” or “Allow only in the profile …”.
- **Always allowed / Always blocked:** hold in every profile. An entry covers the domain and all its subdomains. When a domain is in both fields, “Always allowed” wins. Several entries can be pasted as a list.

Names of the own network (devices, routes, portal) are never blocked.

### Profiles {#profile}

A profile bundles lists, safe search, times and own entries. Its members are **groups**, **people** and **devices**.

**Which profile holds?** Device beats person beats group beats default: if a device has a profile of its own, that one holds. Else the profile of the person the device belongs to. Else the profile of the group. Else the default profile. When two profiles are on the same level, the one further up wins.

- **Safe search:** Google, Bing, DuckDuckGo and YouTube only return results suitable for minors.
- **Times:** days and a time of day during which “Social networks”, “Games”, “Videos” or everything is blocked. When “To” lies before “From”, the time runs past midnight. The server’s time zone counts.
- The **default profile** has no members and cannot be deleted.

### Devices

All VPN devices with the profile that holds for them and – with the log switched on – today’s counters. **“Change profile”** gives a device a profile of its own or excludes it entirely. Gateways are never filtered.

### Log {#protokoll}

After the installation the query log is **off**: the server then keeps only counters, nothing per device.

- **Switching on:** it keeps which device asked for which address when, and whether it was blocked.
- **Retention:** 24 hours, 3, 7 (default) or 30 days. The server deletes older entries by itself.
- **Who may see it:** “Administrators only” or “Users see their own devices” (in the portal, never other people’s devices).
- **Switching off** deletes the existing log and the counters per device.
- **“Allow” / “Block”** in a row makes an own entry – for everybody or only for the profile of the device.

### Settings

- **Switch the protection off / on.**
- **Forward to:** what is not blocked, the server asks Quad9, Cloudflare or a service of your own for – encrypted (DNS over HTTPS). “Fall back to the server’s DNS servers” keeps the internet reachable when the service does not answer.
- **Suspending** – see [Permissions](#berechtigungen).
- **Notifications:** “When the filter is down” (to all administrators) and “Weekly report” (Mondays).

### In the apps and the portal

- **Android and Windows app:** state, counters and suspending for the own device.
- **Portal tab “DNS Protection”:** state, suspending for the own VPN devices, “My devices”, for administrators and parents “Suspend for others” and – when released – “My log”.

While the log is off, app and portal show the counters of the whole server.

## Permissions {#berechtigungen}

**Who may suspend?**

- **Everybody** for their own devices.
- **Administrators** for everybody – on the settings page for all VPN devices at once.
- **Parents** also for the members of their family (plugin Familie), but never for administrators.

The tab “Settings” sets:

- **Who may suspend the protection in the app:** “Administrators only”, “All users” (default) or “Per profile”. With “Per profile” every profile has the switch “Members may suspend the protection in the app”. Parents can suspend for their children even when the children’s profile is locked.
- **Longest duration for users:** 5 min, 30 min, 1 h (default) or 4 h.
- **“Until I switch it back on”:** off for users (default). Administrators can always suspend without an end.

Everybody may switch the protection back on for their own devices. A suspension for all devices is ended by an administrator only. Every suspension is in GateControl’s activity log with the person and the duration.

**What the plugin may do** (shown when installing): filter the DNS of the VPN devices; read users and groups; send notifications; appear in app and portal; run in the background (weekly report).

## Frequently asked questions / troubleshooting

**A device is not filtered.**
Look at the tab “Devices”. “Own DNS”: the device has a DNS server of its own – remove it under Peers › the device. “Excluded”: take it back in with “Change profile”. “Private DNS” in Android or a browser with its own DNS bypass the filter as well.

**A page stopped working.**
“Check a domain” names the list or the entry. “Allow for everybody” makes an exception. For the moment “Suspend” helps.

**The overview says “Fallback”.**
The filter service does not answer; the devices are unfiltered. The server tries again every 2 seconds. “Restart the filter service” helps when it hangs.

**The app says “Suspending not allowed”.**
The administrator chose “Administrators only” or locked suspending for the profile.

**“The server’s internal DNS is switched off”.**
GateControl runs with `GC_DNS_ENABLED=false`. The DNS protection needs the internal DNS.

**The columns “Queries” and “Blocked” show “–”.**
Counters per device exist only while the query log is on.

**Will “Block foreign DNS and DoT” come?**
Yes, in a later version. So will “Share profiles with the home network”.

## New in 1.0.0

First version: lists and exceptions, profiles for groups, people and devices, suspending in the app, the portal and on the settings page, the query log, the set-up dialog with the move from Pi-hole, notifications on an outage and the weekly report.
