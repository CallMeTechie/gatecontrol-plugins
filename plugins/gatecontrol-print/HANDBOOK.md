<!-- version: 1.0.2 -->
# Print & Scan

## What the plugin does

- Use the **printers and scanners at home** from anywhere – without exposing them to the internet. Jobs go through GateControl and a gateway in the home network.
- **Scan** from your phone: from the glass or the feeder, with previews, several pages and one PDF in Drive – named and filed by the AI if you like.
- **Print** PDFs and pictures: printer, copies, colour, double-sided. When the printer is off, the job waits up to 24 hours.
- **Print from the GateControl apps:** on Android the print service “GateControl” in the print dialog and “Share › Print with GateControl”.
- **Rights per person:** print, scan, pages per day, black and white only.
- **Device overview** with state and ink levels, test page and history.

## Requirements

- GateControl **1.236.0** or later.
- A gateway **1.24.0** or later in the printers' home network. The gateway's compose file does not change.
- Printers and scanners with **AirPrint** or **AirScan** (IPP/eSCL). Almost every device since about 2015 can do that. Older devices without it do not show up.
- To print from the Android app: the GateControl app **1.84.0** or later.
- For scans: the **Drive** plugin. Without Drive you can print but not file scans.
- For “Name and file with AI”: an AI provider in GateControl.

## Setting up {#einrichten}

1. **Update the gateway:** **Gateways** › your gateway › “Update to …” until it has at least 1.24.0.
2. **Switch it on:** **Gateways** › your gateway › **Functions** › “Devices at home” › **“Print & scan”**.
3. **Check the devices:** in the plugin on the page **“Devices”**. After about a minute it lists the printers and scanners the gateway found – with location, address, colour, double-sided, feeder, state and ink levels. **“Search again”** searches at once, **“Test page”** prints a sample. Nothing needs to be set up on the printer itself.
4. **Set the rights** on the page **“Permissions”** (see [Permissions](#permissions)).
5. **Where scans go** on the page **“Settings”**: the target in Drive – “My Drive › folder” (per person) or “Family › folder” – and whether the AI suggests name and folder. Also the notifications and how long the history is kept.

## Using it

### Scanning (portal, on the phone)

1. Open the portal tab **“Print & Scan”** › **“Scan”**.
2. Choose the scanner, the **source** (feeder for several pages, or glass) and the **kind** (document b/w 300 dpi, or photo in colour).
3. **“Scan”**. The page appears as a preview. **“Another page”** adds the next one; a wrong page can be removed.
4. With the AI the plugin suggests a name and folder, e.g. “2026-11-06 Stadtwerke invoice.pdf” into “Finances › Electricity”. You can change the name.
5. **“Save”** files all pages as one PDF in Drive.

For the AI suggestion the first page goes as a picture to GateControl's AI provider – only when GateControl allows pictures for the AI.

### Printing

- **Portal:** tab “Print & Scan” › **“Print”** › upload a file (PDF or picture) › printer, copies, colour, double-sided › **“Print at home”**. Your last jobs are listed below, with their state and “Cancel”.
- **Android app:** choose the printer “GateControl” in an app's print dialog, or send a file with **“Share › Print with GateControl”**. Works with and without the VPN.

When the printer is off, the job waits up to 24 hours and prints as soon as it is back.

### Notifications

“Print done” and “Print failed” to the person who printed. Can be switched off on “Settings” and in GateControl's notification settings.

## Permissions

On the page **“Permissions”** per person: **Print**, **Scan**, **Limit** (pages per day, 0 = none) and **b/w only**.

- **Administrators** may always do everything.
- **Children of the family** (GateControl group “Family”, role child) print at most 20 pages a day in black and white unless you change it.
- **Everyone else** prints and scans without a limit.

Counted are pages × copies of the day's jobs that did not fail and were not cancelled. The server checks the rights before every job and scan. **“Reset”** restores a person's defaults.

## FAQ / troubleshooting

**“Devices” is empty.**
Is “Print & scan” switched on at the gateway and the gateway online? Wait a minute or click “Search again”. The device must support AirPrint/AirScan and be in the same network as the gateway.

**“No gateway with “Print & scan” is reachable right now.”**
The gateway is offline or the function is off. Check it under Gateways.

**A device shows “Certificate changed”.**
The device presents another security certificate, e.g. after a firmware update. Only confirm the new certificate when you know the device and nothing was swapped.

**A print job is refused.**
The person's daily limit is reached or they may only print in black and white. Change it on “Permissions”.

**Scans cannot be saved.**
The Drive plugin is missing or not running.

**Word or Excel files do not print.**
Only PDFs and pictures are printed. Save the file as a PDF first.

## New in 1.0.2

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).
- A notice at the top of the plugin page while a gateway with “Print & scan” is older than 1.24.0.

Last in 1.0.1: printing from the GateControl apps (Android print service “GateControl”, “Share › Print with GateControl”).
