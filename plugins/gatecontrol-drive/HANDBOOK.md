<!-- version: 1.28.0 -->
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
- **Home cache:** gateways keep often used files and the previews at home; “available offline” for single files and folders.

Drive is a subscription of its own (Family, Business or Combo, five people included, more on callmetechie.de) and not part of GateControl Lifetime.

## Requirements

- GateControl **1.216.0** or later (home cache from 1.231.0, previews in it from 1.249.0).
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
- **Photos:** timeline by month, “camera uploads only”, “All · Photos · Videos” (show only photos or only videos; a video shows its length when the device sent it), albums, “show in the photo frame”, search by people, places and content, map, “Who is this?”. Faces are recognised on the devices only; Drive keeps no face pictures.
- **Memories:** in the overview “All” opens the page **“Memories”** (portal, Android and Windows app with Drive 1.26.0). It has: **Today X years ago** (every earlier year in which you took more than 10 photos on this day – counting the day before and after), **Trips** (days in a row at a place at least 40 km from home, from 10 photos), **With Noah** and so on (your named people, from 10 photos), **This month X years ago** (from 20 photos), **Year in review** (every past year from 50 photos) and **Places** (e.g. “Langenlonsheim · 12 photos”, from 10 photos). Tap a card to see its photos; tap a photo to open it large. “Home” is the place where you took photos on the most days. **Memories show private photos only:** nothing from your work folder, nothing still waiting under “Check”, nothing from team folders. The overview's cards “Today X years ago” also need more than 10 photos on that day; on other days the tile “Memories” shows other collections of the page (since Drive 1.28.0).
- **Vault folders:** “New” › “New vault”, who may open it (only me, family, team folder). Keep the recovery key safe. A new device asks with “Request access”, a device already approved grants it. Vaults lock after some minutes without input; the AI never reads them. A tap on a file opens it in the vault viewer (pictures, PDFs, texts, in the apps also videos) – see below.
- **Finding videos:** in the search, “All · Photos · Videos” (portal) or “Videos” (apps) filters the hits. Without a search word “Videos” shows the newest videos.
- **Backing up photos and videos from the phone (Android):** in the app under **Drive › Photo backup**. “Videos too” is off at first. If you switch it on later, the app asks: **“All videos”** also backs up the videos already on the phone (photos are not uploaded again), **“Only new”** only those from now on. What the backup leaves out is listed under **“Skipped”** with the reason; **“Try again”** tries once more.
- **AI for documents:** “Document info” on a file, “Ask” below the search, the page “Deadlines” with “Into the family calendar”, “Remind me” and “Done”, “Turn into a document” for scans. A deadline marked done counts for everyone who sees the file and sends no more reminders.
- **“Notes & Tasks”** (when installed): the deadlines of your files show there with date and amount – deadlines from team folders under “Work”. Ticking one off there is the same as “Done” in Drive; tapping it opens the file.
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
- **Offline (Android app):** In a vault, switch on “Available offline” for a file or a folder (menu ⋮) or “Keep the whole vault offline” at the top. The phone then keeps only the encrypted content, exactly as the server has it. As always a file opens only after unlocking, in memory only – also without a connection. For that the phone keeps the wrapped vault key; it stays protected by the phone's device key. If the device is removed from the vault or you sign out, the app deletes the vault's offline files.

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

**Videos from the phone are missing in Drive.**
In the Android app under **Drive › Photo backup**, check that “Videos too” is on. If it says “GateControl may not see your videos yet”, tap **“Allow access”** and choose **“Allow all”** for “Photos and videos”. The app then catches up on the videos that are not in Drive yet. **“Skipped”** lists the files that did not go up, and why.

**“Full screen” is missing in the portal.**
Full screen in the portal needs GateControl 1.244.0. Older versions show the video in the Drive window.

**A day is missing from the memories.**
“Today X years ago” only shows days with more than 10 private photos (the day before and after count too). Photos in the work folder, in team folders and those still waiting under “Check” do not count – sort them as “Private” under **Photos › Check** and they do. Trips and places need photos with a location.

**At home the photos do not show up faster.**
The previews reach the gateway bit by bit (a few hundred per run, every 15 minutes). Check at the gateway under **Gateways › Home cache** that it is “on” and that “Photos” or “Drive” are switched on. Previews from the home network need GateControl 1.249.0 and a current app.

## New in 1.28.0

- **Memories on the overview every day:** when there is no “Heute vor X Jahren” today (that needs more than 10 private photos on this day), the tile “Erinnerungen” now shows other collections of the page “Erinnerungen” – a trip, “Mit Noah”, “Diesen Monat vor X Jahren” or a year in review, for example. A tap opens the photos, “Alle” the page. Before, the tile was missing on those days.

## New in 1.27.0

- **Ticking off deadlines:** “Done” on the page “Deadlines” – for everyone who sees the file; no reminder comes after that.
- **Deadlines in “Notes & Tasks”:** with the plugin “Notes & Tasks” your deadlines show there (team folders under “Work”) and can be ticked off there. Without that plugin nothing changes.

## New in 1.26.1

- **Vault files offline (Android app):** Files, folders or the whole vault can be kept offline on the phone – encrypted only; a file opens after unlocking, in memory, also without a connection (see “Viewing files in a vault”). Nothing changes on the server.

## New in 1.26.0

- **Page “Memories”:** “All” at the memories of the overview now opens a page of its own with “Today X years ago” (every year, not only four), “Trips”, “With Noah” (your people), “This month X years ago”, “Year in review” and “Places” – each with a cover and a count. Tap one to see its photos.
- **Private photos only:** memories show no photos from the work folder, none still waiting under “Check” and none from team folders – whatever the old setting “Never show work photos in memories and on the photo frame” said. It is now called “Never show work photos on the photo frame” and is only for the photo frame.
- **Only from more than 10 photos:** “Today X years ago” shows – in the overview and on the page – only when more than 10 private photos were taken that day (± 1 day).
- Older apps open “Photos” with “All” as before.

## New in 1.25.0

- **Only photos or only videos:** in “Photos” choose “All · Photos · Videos”. Videos show their length.
- **Searching videos:** the search has the same filter; “Videos” without a search word shows the newest videos.
- **Backing up older videos (Android):** switching on “Videos too” can now also back up the videos already on the phone. If “Videos too” was on already, the app catches up on its own with the videos not in Drive yet. The app lists skipped files with the reason.

## New in 1.24.1

- **PDFs and texts in the apps:** the Android and the Windows app now show PDFs, texts and Markdown of normal files themselves instead of handing them to another app at once (see “Viewing PDFs and texts”). Nothing changes on the server.

## New in 1.24.0

- **Previews in the home cache:** the home gateways now also keep the small pictures of the photo and file lists. At home the photos show up in the app at once, older ones too. The large previews of new photos are kept there as well. Needs GateControl 1.249.0.

## New in 1.23.0

- **Find scanned documents by their content:** scans that “Print & Scan” files as a searchable PDF (text recognition on the gateway) bring their text along – the search and “Ask” find them by what is written in them.

## New in 1.22.0

- **View vault files:** pictures, PDFs, texts and Markdown open in the portal with one click in a viewer of their own – decrypted only in the browser tab's memory. Videos play in the apps.
- In the viewer: zoom, “Lock vaults now” and “Download” (asks first, because the copy is not encrypted).

Before that in 1.21.0: pictures and videos large in “Files”, videos played right in the browser; in 1.20.1 this manual in the tab “Manual”.
