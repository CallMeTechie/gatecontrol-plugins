<!-- version: 1.1.0 -->
# Print & Scan

## What the plugin does

- Use the **printers and scanners at home** from anywhere – without exposing them to the internet. Jobs go through GateControl and a gateway in the home network.
- **Scan** from your phone: from the glass or the feeder, with previews, several pages and one PDF in Drive – **searchable** (text recognition) and named and filed by the AI if you like.
- **Print** PDFs, pictures, text and office files (Word, Excel, PowerPoint, OpenDocument, RTF): printer, copies, colour, double-sided, paper and tray. When the printer is off, the job waits up to 24 hours.
- **Print from the GateControl apps:** on Android the print service “GateControl” in the print dialog and “Share › Print with GateControl”.
- **Rights per person:** print, scan, pages per day, black and white only.
- **Device overview** with state and ink levels, test page and history.

## Requirements

- GateControl **1.236.0** or later.
- A gateway **1.24.0** or later in the printers' home network. The gateway's compose file does not change.
- Printers and scanners with **AirPrint** or **AirScan** (IPP/eSCL). Almost every device since about 2015 can do that. Older devices without it do not show up.
- For printers that take no PDF (e.g. HP OfficeJet Pro 8720): GateControl **1.243.0** and a gateway **1.30.0** or later – the gateway then converts PDF files itself.
- For **text recognition**, **office files** and **paper/tray**: GateControl **1.246.0** and a gateway **1.32.0** or later, with “Text recognition for scans” or “Print office files” switched on at the gateway (see [Setting up](#einrichten)). Text files work without “Print office files”.
- To print from the Android app: the GateControl app **1.84.0** or later.
- For scans: the **Drive** plugin. Without Drive you can print but not file scans.
- For “Name and file with AI”: an AI provider in GateControl.

## Setting up {#einrichten}

1. **Update the gateway:** **Gateways** › your gateway › “Update to …” until it has at least 1.24.0.
2. **Switch it on:** **Gateways** › your gateway › **Functions** › “Devices at home” › **“Print & scan”**.
3. **Check the devices:** in the plugin on the page **“Devices”**. After about a minute it lists the printers and scanners the gateway found – with location, address, colour, double-sided, feeder, state and ink levels. **“Search again”** searches at once, **“Test page”** prints a sample. Nothing needs to be set up on the printer itself.
4. **Set the rights** on the page **“Permissions”** (see [Permissions](#permissions)).
5. **Text recognition and office files** (gateway 1.32.0 or later): **Gateways** › your gateway › **Functions** › “Print & scan” › tick **“Text recognition for scans (searchable PDFs)”** and/or **“Print office files”**. For office files the gateway loads an extra service with LibreOffice once (≈ 200 MB, ≈ 700 MB on disk); the row says what to do. The text recognition is already in the gateway.
6. **Where scans go** on the page **“Settings”**: the target in Drive – “My Drive › folder” (per person) or “Family › folder” – and whether the AI suggests name and folder. Also the notifications and how long the history is kept.

## Using it

### Scanning (portal, on the phone)

1. Open the portal tab **“Print & Scan”** › **“Scan”**.
2. Choose the scanner, the **source** (feeder for several pages, or glass) and the **kind** (document b/w 300 dpi, or photo in colour).
3. **“Scan”**. The page appears as a preview. **“Another page”** adds the next one; a wrong page can be removed.
4. With the AI the plugin suggests a name and folder, e.g. “2026-11-06 Stadtwerke invoice.pdf” into “Finances › Electricity”. You can change the name.
5. Tick **“Searchable PDF (text recognition)”** if you like – it shows when a gateway with text recognition is reachable.
6. **“Save”** files all pages as one PDF in Drive. With text recognition it says “Text recognition is running – page 1 of 3” for a moment; you can close the page, the PDF still goes to Drive. The recognised text lies invisibly in the PDF and goes to Drive with it – there you find the document by its content. If the text recognition does not work, the normal PDF is filed and the message says why.

For the AI suggestion the first page goes as a picture to GateControl's AI provider – only when GateControl allows pictures for the AI.

### Printing

- **Portal:** tab “Print & Scan” › **“Print”** › upload a file (PDF, picture, text or office file) › printer, copies, colour, double-sided, **paper** (A4, A5, Letter, photo 10 × 15 cm …) and **tray** where the printer names them › **“Print at home”**. Your last jobs are listed below, with their state (“out of paper”, “cover open” …) and “Cancel”.
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
“Print office files” must be on at the printer's gateway (gateway 1.32.0 or later) – the message says what is missing:
- “… once an administrator switches on “Print office files” …”: **Gateways** › your gateway › **Functions** › “Print & scan” › “Print office files”.
- “… the gateway's office service is not running yet”: the first time the gateway loads the service (a few minutes). When the row at the gateway says “… need the current compose file once”, use “Download docker-compose.yml” there.
- Old Word formats (.doc, .xls, .ppt) do not work – save the file as .docx/.xlsx/.pptx or PDF.

**“Searchable PDF” is missing when scanning.**
No gateway with text recognition is reachable right now, or it is switched on nowhere (**Gateways** › **Functions** › “Print & scan” › “Text recognition for scans”, gateway 1.32.0 or later).

**“Saved … – without text recognition”.**
The text recognition took too long or the gateway was not reachable. The PDF is in Drive anyway, just without text. On a Raspberry Pi 3 or Zero a page takes about a minute.

**Paper or tray cannot be chosen.**
Only what the printer itself reports is offered (gateway 1.32.0 or later). If it names nothing, it prints on its default paper.

**A PDF is refused: “This printer takes no PDF files directly …”.**
Some printers (e.g. HP OfficeJet Pro 8720) take no PDF over the network. The gateway converts PDF files for them – the text says what is missing:
- “… from version 1.30.0 …”: **Gateways** › your gateway › “Update to …” (and keep GateControl up to date).
- “… converting is switched off on the gateway”: **Gateways** › your gateway › **Features** › “Print & scan” › switch on “Convert PDF for printers without PDF”.
- “… names no format the gateway can convert them to”: the printer knows neither PWG raster nor URF nor JPEG. Pictures work, PDF files do not.

**The history says “The PDF file could not be converted for the printer”.**
The PDF is damaged or password-protected. Open it on the phone or PC and save or print it there as a new PDF.

**A job stays on “being converted for the printer” for a while.**
The gateway is turning the pages into the printer's format. On a Raspberry Pi 3 or Zero this takes a few minutes for large PDF files.

## New in 1.1.0

- **Searchable PDF:** tick “Searchable PDF (text recognition)” when scanning – a gateway recognises the text (German and English), the PDF in Drive is searchable and the text goes into Drive's search. If it does not work, the normal PDF is filed.
- **Print office and text files:** Word, Excel, PowerPoint, OpenDocument and RTF when “Print office files” is on at the gateway; text files always. The page count shows in the history after converting.
- Choose **paper and tray** – A4, A5, Letter, photo paper – where the printer names them.
- **The real state while printing:** “out of paper”, “cover open”, “paper jam” … at the job; the Android app shows it in the print dialog.
- For the apps: `GET jobs/<id>` returns a job with its current state.
- All of it needs GateControl 1.246.0 and a gateway 1.32.0 or later; with older ones everything stays as in 1.0.3.

## New in 1.0.3

- **PDF to printers without PDF** (e.g. HP OfficeJet Pro 8720): with GateControl 1.243.0 and a gateway 1.30.0 or later, the gateway converts the PDF to suit the printer when printing – from the portal, the Android print service and “Share”.
- Instead of “PDF files and pictures work” you now get the real reason: gateway too old, converting off, printer without a suitable format, file damaged – the old hint only for files that really are neither a PDF nor a picture.
- A job says “being converted for the printer” while the gateway converts.
- A PDF the phone hands over without a file type or without “.pdf” in its name still uploads as a PDF.

Before that in 1.0.2: this manual in the tab “Manual” and a notice while a gateway with “Print & scan” is older than 1.24.0.
