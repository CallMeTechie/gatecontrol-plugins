<!-- version: 1.2.0 -->
# Notes & Tasks

## New in 1.2.0

- **A new menu as in Drive:** always on the left, on a phone behind the ☰ button. On top My Day, Important, Planned, Assigned to me and "Tasks", below **"My lists"** with **groups as folders that open and close**, "From other plugins" and the **notebooks**. New lists, groups and notebooks come from the **"+"** at the heading.
- **⋯ at every list, group and notebook:** edit (name, colour, symbol, group), share, move to a group, shopping day, delete.
- **Shopping day:** a list can be at the top of "My Day" on chosen weekdays – "Shopping day today" with its first items to tick off. This is for everyone the list is shared with. If you like, a notification comes in the morning.
- **Sharing with rights:** each person gets **Edit** or **View**. Whoever may only view cannot add or change anything – only tick off what is assigned to them.
- **Assigning you can see:** in shared lists the person's small picture is at the task; on top you filter by "All", "Assigned to me", a person or "Nobody". In the quick entry "@name" works too.
- **Deleting asks first:** deleting a list or a notebook says how much is affected and who will no longer see it. Open tasks can move to "Tasks", notes to "Notes". Afterwards there is **"Undo"** for a few seconds.
- **Settings** (gear at the bottom left) instead of "Sources": tasks from other plugins, My Day, times of the quick entry, notifications and "Move over" in one place.

## New in 1.1.0

- **Keep working without a connection:** in the Android app, tasks, sub-tasks, lists, notebooks and notes can now be created, changed and deleted offline too. They show at once (marked “Not sent yet”) and go out once the server can be reached – even if the app sends a create twice, only one is made.
- **Changed elsewhere at the same time?** If someone changed the same field on another device meanwhile, the app asks when you open it: “Keep mine” or “Load the other one”. Changes to different fields (e.g. you the title, your partner the date) both stay.
- **Tapping a notification opens the page:** a reminder or an assignment the task, a shared list the list, a shared notebook the notebook, “A new device asks for access” the approval in the vault.

## New in 1.0.1

Correction: moving over from Microsoft To Do needs **Mail 1.12.0** or newer (this said 1.11.0 by mistake).

## New in 1.0.0

The plugin is new: your own tasks and notes plus everything the other plugins have to do, in one place. Moving over from Microsoft To Do and Synology DS Note, vault notebooks, quick entry in plain language.

## What the plugin does

- **My Day:** today's events (e.g. "put out the yellow bin" the evening before, a parent evening), what is overdue, what is due today, what is coming up (two weeks) and what was done today – from your lists and from Family, Mail, Drive, School and Everyday.
- **Important, Planned, Assigned to me** and your **lists** (also in **groups** and **shared**, e.g. "House & garden" with your partner).
- **Tasks** with sub-tasks, a due date and time, a **reminder as a push notification**, **repeats** (daily, weekdays, every Monday, every 2 weeks, monthly, yearly or "3 days after completion"), a note, attachments and a person it is assigned to.
- **Notes** in notebooks with tags, pinning, colours, headings, bold and italic, lists, **checklists**, tables, links, pictures and attachments. A checklist line becomes a task with "→ Task".
- **Full-text search** over tasks and notes – also across umlauts ("zahnarzt" finds "Zahnärztin").
- **Vault notebooks:** end-to-end encrypted. Only your devices can read titles and text, the server cannot.
- **Private and work** apart: switch at the top of the menu.

## Requirements

- GateControl **1.216.0** or newer. For tapping an item of another plugin to open it in the portal: GateControl **1.254.0** (otherwise the portal says where to find it).
- For Family, Mail, Drive, School and Everyday to show up here: their versions with "To-dos for Notes & Tasks". A missing source is shown under "Settings" (gear at the bottom left).
- For moving over from Microsoft To Do: the **Mail 1.12.0** plugin or newer with your Microsoft account.
- For vault notebooks in the portal: a current browser (Chrome, Edge, Firefox, Safari of the last years).

## Setting up

1. Install and license it. Under **Settings › Plugins › Notes & Tasks › Settings** check the **time zone** (decides "today" and the reminders).
2. Decide whom people may **share** with: everyone, only family and team, or nobody.
3. Under **Settings › Tasks from other plugins** (gear at the bottom left of the tab) untick the plugins that should not show up here. The status line on top says which sources are connected.
4. Done: the portal has the tab **"Notes & Tasks"**, the start page the tile **"My Day"**.

## Tasks

- **Quick add:** type into the field on top and press Enter – or **Ctrl N**. The plugin understands e.g. "tomorrow 9 am call the dentist, important, #health": tomorrow 9:00, a reminder at 9:00, important, list "Health". Below the field it shows what it found. See [Quick entry](#quick-entry).
- **Ticking off:** the circle in front. A repeating task gets its next one right away (with the same sub-tasks, open again).
- **Details:** tap a task – the right side shows sub-tasks, "In My Day", Due, Reminder, Repeat, Assigned, List, Attachments and Note.
- **Lists and groups:** the **"+"** at "My lists" opens "New list or group". A group is a folder for several lists; "Ungroup" keeps the lists. Groups are just for you.
- **⋯ at a list:** edit (name, colour, symbol, group, shopping day, morning reminder), **share …**, move to a group, delete. The default list "Tasks" can be renamed, not deleted.
- **Sharing:** type a name, add the person and choose **Edit** or **View**. Whoever gets a shared list sees it at once and gets a notification. Members find "Show in My Day" and "Leave list" at the ⋯.
- **Shopping day:** on the chosen weekdays the list is at the top of "My Day" – for all members. Whoever does not want it switches it off for themselves at the ⋯ of the list.
- **Deleting** asks first and says what happens to the tasks; afterwards there is "Undo". **Deleted things** stay 30 days in the trash, then they are gone.

## From other plugins

What Family (tasks, shopping lists), Mail ("To do", flagged mails), Drive (deadlines from bills and notices), School (homework, exams, parent evenings) and Everyday (waste collection the evening before) have to do shows up in "My Day" and under "From other plugins".

- **The original stays in its plugin.** Ticking it off here ticks it off there; tapping it shows "From Mail … open".
- Want your own **sub-tasks, a note or a reminder** for it: "Sub-tasks, note, reminder …" – then it becomes a task here. Done here = done there.
- **Settings › Tasks from other plugins** (gear at the bottom left): each source on/off, "Show the children's tasks" (all / only mine / none), "Shopping lists in My Day", "Flagged mails as tasks", "Remind at" for the waste collection the evening before. Mail accounts and children can be mapped to an area ("Work (Microsoft 365) → Work") or hidden. "Sync now" fetches the state right away.
- Vehicles, NAS and Proxmox come in step 2.

> **Note:** The plugins send their changes themselves; a full reconciliation runs about every 12 hours. A change in a source therefore shows up within seconds, at the latest after the next reconciliation.

## Notes

- **New note** in the notebook, top right. "Edit" opens the text with a toolbar: heading, bold, italic, list, numbered list, checklist, table, link, picture or file. **Ctrl S** saves and closes; it also saves while you type.
- **#word** in the text becomes a tag; the menu lists the most used ones.
- **Pin** and **colour** below the note.
- In a checklist: tick it in the note; **"→ Task"** next to a line makes a task of it (the line then shows "Task · Wed").
- **Family's pinboard and packing lists** are notebooks here ("(Family)" in their name) and are shown in Family – what you change here, the family sees there.

## Vault notebooks

A vault is a notebook only your devices can read.

1. **New notebook › Vault**, enter a name.
2. The **recovery key** is shown once (56 characters). Write it down or save it as a file – without it and without an approved device the notes are lost.
3. A **new device** (another browser, the app) asks "Ask for access" and shows a **safety number**. A device with access shows "devices ask for the vault" – only approve when the number is the same on both. Or use "With the recovery key" on the new device.
4. Sharing works too: whoever is taken out loses their keys; the vault then asks for a **new key**.

A vault has no search, no tags and no "→ Task" – the server does not know the text. The portal locks the vault after 15 minutes without use and when the page is left.

## Quick entry

| You write | Result |
|---|---|
| today, tomorrow, the day after tomorrow | the date |
| Monday … Sunday, Mon. … Sun., "Fri 10 am" | the next such day |
| in 3 days, in a week, in 2 weeks, in a month | the date |
| November 13, 13 Nov, 2026-11-13 | the date |
| 9 am, 9:30, at 9, 14h | the time (and a reminder) |
| morning, noon, afternoon, evening, tonight, tomorrow morning | 9:00, 12:00, 15:00, 19:00 |
| daily, every day, weekdays, every Monday, every monday and thursday, every 2 weeks, monthly, yearly, 3 days after completion | a repeat |
| @Jenny | assigned to Jenny (if she is in the list) |
| #health | into the list "Health" (if there is none: "New list …") |
| important, urgent, ! | important |

German works too: "morgen 9 Uhr", "jeden Montag", "in 2 Wochen".

## Moving over

### From Microsoft To Do

1. **Settings › Move over › Microsoft To Do:** pick your Microsoft account from Mail.
2. The first time **"Consent at Microsoft"**: enter the shown code at microsoft.com/devicelogin. Microsoft asks whether GateControl may read and change your tasks.
3. The lists appear with the number of open tasks; work lists are set to "Work" already. Choose whether **done tasks** come along (e.g. the last 90 days) and whether a **transition period syncs both ways**.
4. **"Take over … tasks".** It goes on in the background, also when you close the page.

Nothing is deleted in To Do. End the sync under **Settings › Move over › In step with To Do › End sync** – the list stays here.

### From Synology DS Note

1. In DS Note: **Settings › Import/Export › Export** – you get an .nsx file.
2. **Settings › Move over › Synology DS Note › Choose the export file (.nsx).** The browser reads the file itself; only pictures and attachments are uploaded one by one.
3. **Protected notes:** with the password they become a **vault notebook** (the recovery key is shown first). A note that does not open is skipped – then remove the protection in DS Note and export again.
4. **"Take over … notes".** Moving the same file over again creates nothing twice.

Fetching straight from the NAS is not possible yet.

## Settings

| Setting | Meaning |
|---|---|
| Time zone | decides "today", due dates and reminders |
| Language of reminders | German or English |
| Share lists and notebooks with | Everyone, Family and team, Nobody |
| Allow vault notebooks | on/off |
| From other plugins | Family, Mail, Drive, School, Everyday one by one |
| Moving over | Microsoft To Do, syncing both ways, DS Note |
| Largest file, space per person | for pictures and attachments |

## Without a connection (apps)

- The app shows the last state, also without a connection. From version 1.1.0 of this plugin you can also **create, change and delete** there – tasks, sub-tasks, lists, notebooks and notes. What has not reached the server yet is marked “Not sent yet”.
- Once the server can be reached, the app sends everything in the order you did it. A sub-task of a task created offline comes after its task.
- **Changed elsewhere:** if someone changed the same field meanwhile, the entry is marked “Changed elsewhere”. When you open it you choose “Keep mine” (your version overwrites) or “Load the other one” (your change is dropped).
- **Vault notes** can be changed offline only while the vault is open on the phone. Only the encrypted text is kept and sent – never readable on the phone or the server.
- Adding pictures and attachments, sharing and moving over still need a connection.

## Questions

**Why is a task from Mail missing?** Check under "Settings › Tasks from other plugins" whether Mail is connected and on and whether the account is hidden. "Sync now" fetches the state.

**Who sees my notes?** Only you – except in shared notebooks. Not even the server can read vault notebooks.

**Does the search find text in pictures?** When the app recognised the text of a picture, yes. The portal does not recognise text in pictures.
