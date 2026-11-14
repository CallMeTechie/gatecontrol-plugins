<!-- version: 1.5.0 -->
# Notes & Tasks

## New in 1.5.0

- **A task at a place:** A task can hang on a place – “screws at the DIY store”, “return the deposit bottles at Lidl”, “return the ladder at grandma’s”. Your phone reminds when you **arrive** there or **leave** the place. Every task has the row **“Place”** for it; the quick entry finds the place in the text and shows it as a chip.
- **My places:** Places you name (“Grandma”, “Office”) are found without a search. “Home” and the rule places come from the Family plugin (1.22.0 or later). With **“Remember as my place”** a place becomes your usual DIY store, bakery or Lidl and is there at once next time.
- **Place search – can be switched off, and off at first:** “Which DIY store is near?” is answered by your own server. The administrator switches the search on under **Settings › Plugins › Notes & Tasks › Places**; everyone can switch it off again for themselves. See [Places](#places).
- **“Nearby”:** When you pass another fitting place, the task speaks up there as well – with “Done”, “Not here” and “Later”.
- **Left open yesterday** names the place of a task that has one (“Buy screws · DIY store North”).
- **Apps:** Only a phone reminds at a place. The Android app gets places with one of the next versions; until then you can set places in the portal, but they do not speak up yet. The place reminders of the Family plugin keep working unchanged.

## New in 1.4.0

- **Shopping lists:** The menu has a section **“Shopping lists”**. A shopping list has items with a quantity to tick off, can be shared (edit or view) and can have a shopping day. Ticked items stay at the bottom until you press “Remove ticked items”.
- **A list at a task:** Every task has the row **“Attached list”**. The task then shows e.g. “Shopping 0/8”; a click on it opens the list. When you write “shopping at Lidl”, the quick entry suggests the fitting list as a chip – you can take it away.
- **Everything ticked:** Once every item of the attached list is ticked, the task is done. **“Undo”** appears at the bottom for a moment. The list stays. The other way round, open items stay when you tick the task by hand.
- **Reminder with a list:** The message of a task with a list names the first items and has the button **“Open list”**.
- **Family:** With the Family plugin (1.21.0 or later) its shopping lists can move here – the button is in the settings of the Family plugin. After that the lists are shared with the whole family here, and “I’m going shopping” and “Ask someone …” are above the list.
- **Apps:** The Android and Windows apps show the shopping lists under “Tasks” with one of the next versions. Until then they keep using the shopping list through the Family plugin; both stay in step.

## New in 1.3.0

- **Buttons on the reminder:** The message when a task is due now has **“Done”**, **“In 1 hr”** and **“This evening”** (in the evening “Tomorrow morning” instead). “Done” ticks the task off without opening the app; the other two put the reminder off.
- **No reminder is lost silently any more:** If the server was off at the time, the message comes up to 24 hours late – saying “Was due at …”. If it is longer ago, the task is under “Left open yesterday” the next morning.
- **“Left open yesterday”:** What was due yesterday or was in “My Day” and was not ticked off is a card at the top of “My Day” and comes in **one** message in the morning (07:30 unless you change it). For each task: **Done**, **Today** or **Move** (Tomorrow, At the weekend, another date); with several also “All today”.
- **In the calendar:** With the Mail plugin (1.15.0 or newer) every task with a date and a time is a 30-minute event in the “Tasks” calendar – without an event reminder of its own, so that you do not get two messages. The sign “in the calendar” at the task shows it.
- **Switches:** Administrators find “Add tasks with a time to the calendar” in the plugin settings; everyone switches the calendar and the morning hint for themselves under “Settings” (gear at the bottom left).
- **Apps:** The new buttons on the message work with the current GateControl apps right away. The card “Left open yesterday” and the extra backup on the phone come with one of the next app versions; until then “Move” opens the portal.

## New in 1.2.1

- **Faster on slow disks:** the hourly clean-up of the trash no longer reads through all notes and tasks, and the plugin writes to its database less often. This eases servers whose disk is slow.
- **Nothing changes for you:** looks and handling stay the same; the trash still empties itself after 30 days.

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
- **Tasks** with sub-tasks, a due date and time, a **reminder as a push notification** or **at a place** (“at the DIY store”, “at grandma’s”), **repeats** (daily, weekdays, every Monday, every 2 weeks, monthly, yearly or "3 days after completion"), a note, attachments and a person it is assigned to.
- **Notes** in notebooks with tags, pinning, colours, headings, bold and italic, lists, **checklists**, tables, links, pictures and attachments. A checklist line becomes a task with "→ Task".
- **Full-text search** over tasks and notes – also across umlauts ("zahnarzt" finds "Zahnärztin").
- **Vault notebooks:** end-to-end encrypted. Only your devices can read titles and text, the server cannot.
- **Private and work** apart: switch at the top of the menu.

## Requirements

- GateControl **1.216.0** or newer. For tapping an item of another plugin to open it in the portal: GateControl **1.254.0** (otherwise the portal says where to find it).
- For Family, Mail, Drive, School and Everyday to show up here: their versions with "To-dos for Notes & Tasks". A missing source is shown under "Settings" (gear at the bottom left).
- For moving over from Microsoft To Do: the **Mail 1.12.0** plugin or newer with your Microsoft account.
- For vault notebooks in the portal: a current browser (Chrome, Edge, Firefox, Safari of the last years).
- For reminders at a place: a phone with a GateControl app that knows places, and the location permission “Allow all the time”. For “Home” and the rule places: the plugin **Family 1.22.0** or newer. The place search is optional.

## Setting up

1. Install and license it. Under **Settings › Plugins › Notes & Tasks › Settings** check the **time zone** (decides "today" and the reminders).
2. Decide whom people may **share** with: everyone, only family and team, or nobody.
3. Under **Settings › Tasks from other plugins** (gear at the bottom left of the tab) untick the plugins that should not show up here. The status line on top says which sources are connected.
4. Done: the portal has the tab **"Notes & Tasks"**, the start page the tile **"My Day"**.

## Tasks

- **Quick add:** type into the field on top and press Enter – or **Ctrl N**. The plugin understands e.g. "tomorrow 9 am call the dentist, important, #health": tomorrow 9:00, a reminder at 9:00, important, list "Health". Below the field it shows what it found. See [Quick entry](#quick-entry).
- **Ticking off:** the circle in front. A repeating task gets its next one right away (with the same sub-tasks, open again).
- **Reminder:** At the set time a message comes with **Done**, **In 1 hr** and **This evening** (in the evening “Tomorrow morning”). The evening and the morning time are your times from “Settings”. A task with a date only gets no message of its own – if it stays open, it is under “Left open yesterday” the next morning.
- **Left open yesterday:** the card at the top of “My Day”. **Done** ticks the task off, **Today** puts it on today (the time stays), **Move** offers Tomorrow, At the weekend and another date. The card stays until every row is decided.
- **In the calendar:** Tasks with a date and a time are a 30-minute event in the “Tasks” calendar of the Mail plugin, for the person they are assigned to (else the one who made them). Done ones stay as “✓ …”, deleted ones disappear. The “Tasks” calendar is always a GateControl calendar in Mail.
- **Details:** tap a task – the right side shows sub-tasks, "In My Day", Due, Reminder, Repeat, Assigned, List, Attachments and Note.
- **Lists and groups:** the **"+"** at "My lists" opens "New list or group". A group is a folder for several lists; "Ungroup" keeps the lists. Groups are just for you.
- **⋯ at a list:** edit (name, colour, symbol, group, shopping day, morning reminder), **share …**, move to a group, delete. The default list "Tasks" can be renamed, not deleted.
- **Sharing:** type a name, add the person and choose **Edit** or **View**. Whoever gets a shared list sees it at once and gets a notification. Members find "Show in My Day" and "Leave list" at the ⋯.
- **Shopping day:** on the chosen weekdays the list is at the top of "My Day" – for all members. Whoever does not want it switches it off for themselves at the ⋯ of the list.
- **Deleting** asks first and says what happens to the tasks; afterwards there is "Undo". **Deleted things** stay 30 days in the trash, then they are gone.

## Places

- **Setting a place:** Open the row **“Place”** in the task. You choose one of your places, a hit of the search, **“Any Lidl”** (reminds at the first branch you arrive at) or set a **point on the map** and give it a name. Below you decide: **On arriving** or **On leaving**. “No place” takes it away again.
- **From the text:** The quick entry finds a kind of place (“at the DIY store”, “at the pharmacy”, “petrol station”), a name (“at Lidl”), an address (“21 Ring Street”) and your own places (“at grandma’s”, “at home”). An own or remembered place is taken directly; otherwise a tap on the chip “Place: DIY store …” opens the choice. The chip can be taken away.
- **My places** are kept under **Settings** (gear at the bottom left) **› Places**: save a new place (name, a point on the map or an address, radius 50–2000 m), change, delete, “no longer remember”. A task keeps its place even when you delete it from the list.
- **Place search:** In the portal the search looks near one of your places (“near Home”), on the phone near where you are. The hits are sorted by distance, the ones chosen before first; the minutes are estimated from the distance. A search only runs when you press “Search” or open the choice – never while typing.
- **What leaves your server for it:** only the search word and your position **rounded to about one kilometre** – to a map service of OpenStreetMap. Your name, your device and your exact location are not sent. The position is not stored or logged.
- **Without the place search** (the default) your remembered places and the map work. No search leaves your server then.
- **Nearby:** When a task hangs on a DIY store, your phone also watches up to five more DIY stores in your area. When you pass one: “DIY store Ring is right here · you planned DIY store North”. **Not here** switches this one place off for the task, **Later** gives three hours of rest. Per task the hint comes at most once in three hours and not in your quiet hours (9 pm–7 am, to change under Settings › Places). Own places (“at grandma’s”) have no such hint.
- **For someone else:** When you set a place for a task that is someone else’s, that person is asked (“… would like to remind you”). Their phone only watches the place after **Accept**. When you change the place, they are asked again.
- **With a shopping list:** When the task also carries a list, the reminder at the place has the button “Open list”.
- **Never arrived?** The task is under “Left open yesterday” the next morning when it was planned or due yesterday. Give a task with a place a date when it should speak up then at the latest.
- **How many places?** Android allows an app 100 watched places. The place reminders of the Family plugin come first; “Notes & Tasks” takes what is left (at most 60), the most urgent tasks first.

### Switching the place search on (administrator)

Under **Settings › Plugins › Notes & Tasks › Settings › Places** there is **“Place search on the internet”**:

| Choice | Meaning |
|---|---|
| Off (default) | No search. Remembered places and the map work. |
| Public service of OpenStreetMap (Nominatim) | Your server asks `nominatim.openstreetmap.org`. Its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) applies: at most one request a second for the whole installation, only searches a person triggered, no bulk queries. The service runs on donated servers, without any guarantee, and may withdraw access. Meant for a household. |
| Own service | A Nominatim you run yourself. You enter its address under **Access targets › Place search**. |

The plugin keeps the rules of the public service by itself: one request after the other with a good second in between, a cache, at most 30 new searches per person and hour. The status line on the settings page says what applies right now.

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
| at the DIY store, at the pharmacy, at Lidl, at grandma’s, at home, 21 Ring Street | a place (see [Places](#places)) |

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
| Add tasks with a time to the calendar | on (default) / off. Needs the Mail plugin 1.15.0 or newer; without Mail nothing happens, once it is added later the open tasks are added. Off: the tasks' events are removed. |
| From other plugins | Family, Mail, Drive, School, Everyday one by one |
| Place search on the internet | Off (default), Public service of OpenStreetMap, Own service – see [Places](#places) |
| Moving over | Microsoft To Do, syncing both ways, DS Note |
| Largest file, space per person | for pictures and attachments |

Everyone also has their own **“Settings”** (gear at the bottom left): under “Notifications” the switch **In the morning: “Left open yesterday”** with the **time of the morning hint**, under “Calendar” the switch **Add tasks with a time to my “Tasks” calendar** (shown when Mail is installed and the administrator's setting is on).

## Without a connection (apps)

- The app shows the last state, also without a connection. From version 1.1.0 of this plugin you can also **create, change and delete** there – tasks, sub-tasks, lists, notebooks and notes. What has not reached the server yet is marked “Not sent yet”.
- Once the server can be reached, the app sends everything in the order you did it. A sub-task of a task created offline comes after its task.
- **Changed elsewhere:** if someone changed the same field meanwhile, the entry is marked “Changed elsewhere”. When you open it you choose “Keep mine” (your version overwrites) or “Load the other one” (your change is dropped).
- **Vault notes** can be changed offline only while the vault is open on the phone. Only the encrypted text is kept and sent – never readable on the phone or the server.
- Adding pictures and attachments, sharing and moving over still need a connection.

## Questions

**Why is a task from Mail missing?** Check under "Settings › Tasks from other plugins" whether Mail is connected and on and whether the account is hidden. "Sync now" fetches the state.

**Does the server learn where I am?** No. Your phone watches the places itself and at most tells the server “this place fired”, so that two devices do not both ring. For the place search the server gets a position rounded to about one kilometre, which it does not store.

**Why does a task not speak up at its place?** Only a phone reminds: it needs the location permission “Allow all the time” and an app version that knows places. When someone else set the place, you have to agree first. With very many places open, the phone watches the most urgent ones.

**Who sees my notes?** Only you – except in shared notebooks. Not even the server can read vault notebooks.

**Does the search find text in pictures?** When the app recognised the text of a picture, yes. The portal does not recognise text in pictures.
