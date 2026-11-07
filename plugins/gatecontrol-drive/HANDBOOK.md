<!-- version: 1.23.1 -->
# Drive

## What the plugin does

- **The files of the family and the team on your own storage** – this server, a NAS or S3.
- **Areas with rights:** My files, Family, the children's folders and team folders.
- **Versions, trash, links** for people without an account and **sync** with every device (apps).
- **Photos:** timeline, albums, memories, places and people, a photo frame on the wall tablet.
- **Vault folders:** end-to-end encrypted folders only your devices open.
- **AI for documents:** recognise kind, name and deadlines, ask your files, turn scans into documents, deadlines into the family calendar.
- **Ransomware protection:** Drive stops a device that changes unusually many files.
- **Import** from Google Drive and OneDrive, **office in the browser** with an office server of your own.
- **Home cache:** gateways keep often used files at home; “available offline” for single files and folders.

Drive is a subscription of its own (Family, Business or Combo, five people included, more on callmetechie.de) and not part of GateControl Lifetime.

## Requirements

- GateControl **1.216.0** or later (home cache from 1.231.0).
- A Drive licence.
- For the family and the children's folders: a GateControl group of the kind family.
- For AI and import: the AI provider or cloud accounts in GateControl.
- Optionally a storage target (NAS over SMB or WebDAV, S3 …) under **Settings › Plugins › Storage**.

## Setting up

1. **Switch people on:** admin page **“People”** – per person **Family** or **Business** (depending on the licence). Only people switched on use Drive.
2. **Storage places:** **Settings › Plugins › Drive › Storage places** – per area this server or a storage target. On a NAS in the readable form the files are plain files.
3. **Team folders** (Business): admin page **“Team folders”** – create folders and enter people or groups with read, write or manage.
4. **Settings** (**Settings › Plugins › Drive › Settings**): keep versions, empty the trash after … days, space per person, “parents may view the children's folders”, ransomware protection (from how many files or percent within what time), photo frame, AI for documents, import, address of the office server, address of GateControl for direct links.
5. **Backup:** GateControl's backup holds **no Drive files**, only the database. When the files are in one place only, the overview shows a note. Back the files up yourself (e.g. a storage target in S3 or a backup of the NAS).
6. **Home cache** (optional): switch it on at the gateway under **Gateways › Home cache** and choose which kinds it keeps.

## Using it

- **Portal tab “Drive” and apps:** the menu on the left with “Personal” (My files) and “Shared” (Family, children's folders, team folders) as a folder tree, “Photos”, “Albums” and “Vaults”. Drive opens on the **overview**: to do, recently opened, new in the family, memories, people, places.
- **Files:** upload (whole folders too), new folder, rename, move, copy, versions, trash, share, “copy direct link”. Choose several with Ctrl/Shift and download them as a ZIP, move or delete them.
- **Sharing:** links for people without an account; “Shared links” lists them.
- **Devices:** your devices with their backed-up folders and the last backup.
- **Viewing pictures and videos:** a click on a picture or video – in “Files”, in the search and in “Photos” – opens it large, without downloading it first. The arrows, the arrow keys or a swipe go to the next picture or video in the same folder. Zoom pictures with the mouse wheel, “+”/“−”, a double click or two fingers. Videos play right in Drive (play, pause, seek, sound, full screen); Drive remembers where you stopped while the tab is open. At the top: download, share, details and the file's menu.
- **Viewing PDFs and texts (apps):** in the Android app and the Windows app a tap on a PDF, text or Markdown file opens it right in the app – in the same view as vault files. Texts can be selected and copied there. “Open with another app” (Android) or “Open with another program” (Windows) stays in the view. Very large files (a PDF over 100 MB, a text over 2 MB) and Office files still open in another app. In the portal a click on a PDF still offers “Download”.
- **Photos:** timeline by month, “camera uploads only”, albums, “show in the photo frame”, search by people, places and content, map, “Who is this?”. Faces are recognised on the devices only; Drive keeps no face pictures.
- **Vault folders:** “New” › “New vault”, who may open it (only me, family, team folder). Keep the recovery key safe. A new device asks with “Request access”, a device already approved grants it. Vaults lock after some minutes without input; the AI never reads them. A tap on a file opens it in the vault viewer (pictures, PDFs, texts, in the apps also videos) – see below.
- **AI for documents:** “Document info” on a file, “Ask” below the search, the page “Deadlines” with “Into the family calendar” and “Remind me”, “Turn into a document” for scans.
- **Import** from Google Drive and OneDrive: connect, choose, pick the target.
- **Edit in the browser** for office documents when an office server is entered.

### Viewing files in a vault – why it stays safe

A vault folder stays end-to-end encrypted while you look at a file in it:

- **In memory only:** the file is decrypted only on your device and shown from its working memory – in the portal in the browser tab, in the apps in the app. No unencrypted file is written to the disk, the cache, the gallery or a thumbnail. The apps load videos encrypted and decrypt only the piece that is playing.
- **No detour through other programs:** the viewer hands nothing to other apps or programs. Only “Download” (portal) and “Open with another app” (apps) take the file out of the vault on purpose – and ask first, because the other app gets it unencrypted.
- **Locking closes the viewer:** when the vault locks (after the time set without input, when you leave the tab or app, by hand), the viewer closes at once and what was decrypted is deleted. Scrolling, zooming and a playing video count as use.
- **No screenshots:** in the Android app and on Windows the viewer cannot be captured and does not show in the recent apps.
- **The server sees nothing new:** it serves encrypted data and the viewer's program only. Administrators still cannot open vaults.
- **Limits:** very large files, office files and, in the browser, videos are not shown – you get a note and can download the file on purpose or view it in the app.

## Permissions

| Area | Who | Right |
|---|---|---|
| My files | every person switched on | manage |
| Family | members of the family with a family seat | write |
| Children · name | the child | manage |
| | its parents, while “parents may view the children's folders” is on | read (the child gets a note once a day) |
| Team folder | people and groups entered, with a business seat | read / write / manage |

“Read” means view and download, “write” also upload, create, rename, move, delete. Without a seat Drive answers “not switched on”, without a valid licence nothing works but the display. Administrators see numbers, people and areas on their pages – they cannot open vaults either.

## FAQ / troubleshooting

**Someone does not see Drive.**
Switch them on on the page “People”. If the licence is full, only after booking another seat.

**A device is “stopped”.**
The ransomware protection saw unusually many changes. In the red banner choose “Undo” or, if it was you, release it.

**The overview warns that Drive files are not backed up.**
GateControl's backup does not hold the files. Set up a backup of your own or use a storage target with its own backup.

**“Edit in the browser” is missing.**
No office server address is entered in the settings.

**A vault does not open on a new device.**
Request access and grant it on a device already approved – or open it with the recovery key.

**A video from a vault does not play in the browser.**
The portal tab may not play videos from memory, and a decrypted copy on the disk would no longer be protected. Watch the video in the Android or Windows app or download it on purpose.

**Files are “held back by the virus scan”.**
GateControl's virus scan checks new files; Drive does not open or share blocked files. The picture and video view then only shows the reason. A file marked as malware shows only after “Show anyway”.

**A video does not play in the browser.**
Browsers cannot play some videos, often MKV or HEVC (H.265, e.g. from newer iPhones). Drive says so and offers “Download”. Most of them play in the GateControl apps. If you only hear the sound, the browser cannot decode the picture.

**“Full screen” is missing in the portal.**
Full screen in the portal needs GateControl 1.244.0. Older versions show the video in the Drive window.

## New in 1.23.1

- **PDFs and texts in the apps:** the Android and the Windows app now show PDFs, texts and Markdown of normal files themselves instead of handing them to another app at once (see “Viewing PDFs and texts”). Nothing changes on the server.

## New in 1.23.0

- **Find scanned documents by their content:** scans that “Print & Scan” files as a searchable PDF (text recognition on the gateway) bring their text along – the search and “Ask” find them by what is written in them.

## New in 1.22.0

- **View vault files:** pictures, PDFs, texts and Markdown open in the portal with one click in a viewer of their own – decrypted only in the browser tab's memory. Videos play in the apps.
- In the viewer: zoom, “Lock vaults now” and “Download” (asks first, because the copy is not encrypted).

Before that in 1.21.0: pictures and videos large in “Files”, videos played right in the browser; in 1.20.1 this manual in the tab “Manual”.
