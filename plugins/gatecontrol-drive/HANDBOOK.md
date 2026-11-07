<!-- version: 1.21.0 -->
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
- **Photos:** timeline by month, “camera uploads only”, albums, “show in the photo frame”, search by people, places and content, map, “Who is this?”. Faces are recognised on the devices only; Drive keeps no face pictures.
- **Vault folders:** “New” › “New vault”, who may open it (only me, family, team folder). Keep the recovery key safe. A new device asks with “Request access”, a device already approved grants it. Vaults lock after some minutes without input; the AI never reads them.
- **AI for documents:** “Document info” on a file, “Ask” below the search, the page “Deadlines” with “Into the family calendar” and “Remind me”, “Turn into a document” for scans.
- **Import** from Google Drive and OneDrive: connect, choose, pick the target.
- **Edit in the browser** for office documents when an office server is entered.

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

**Files are “held back by the virus scan”.**
GateControl's virus scan checks new files; Drive does not open or share blocked files. The picture and video view then only shows the reason. A file marked as malware shows only after “Show anyway”.

**A video does not play in the browser.**
Browsers cannot play some videos, often MKV or HEVC (H.265, e.g. from newer iPhones). Drive says so and offers “Download”. Most of them play in the GateControl apps. If you only hear the sound, the browser cannot decode the picture.

**“Full screen” is missing in the portal.**
Full screen in the portal needs the GateControl version after 1.241.1. Older versions show the video in the Drive window.

## New in 1.21.0

- **View pictures large in “Files” too:** a click on a picture opens the picture view instead of a download – with next and previous through the folder's pictures and videos, zoom, download, share and details. “Photos” now has the same view.
- **Play videos right in Drive:** MP4, WebM, MOV and M4V play in the browser without downloading them whole first (GateControl only sends the parts being played). Seek, sound and full screen; the place is kept while the tab is open. Videos the browser cannot play (often MKV or HEVC) say so and offer “Download”.
- The virus scan applies here too: the view does not show blocked files, and marked ones only after asking.

Last in 1.20.1: this manual in the tab “Manual”; in 1.20.0 the home cache.
