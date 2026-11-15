<!-- version: 1.20.0 -->
# Messenger

## What the plugin does

- **Chats between the GateControl accounts** – in the GateControl app (tab “Chats”), the Windows client and the portal tab “Chats”.
- **Direct and group chats** with text, pictures, videos, voice messages, files and location; replies with a quote, reactions, editing and deleting, read receipts, “typing …”, disappearing chats.
- **Push with a reply field.**
- **Status and stories, polls, events with RSVPs, live arrival** and **home actions** (e.g. a light or the door from another plugin) in the chat.
- **Notifications in chats:** everyone can choose whether a topic's notifications appear in GateControl, the family chat or a chat of its own.
- **Group chats for GateControl groups** that keep their members in step by themselves.
- **Save to Drive:** a chat's pictures, voice messages and files into the Drive plugin.

Everything stays on your server. Texts, locations, file names and group titles are stored encrypted. Administrators cannot read private chats.

## Requirements

- GateControl **1.204.0** or later (group chats for GateControl groups from 1.200.0, virus scan from the version after 1.222.0).
- A licence for the plugin.
- For “Save to Drive”: the Drive plugin. For the family chat: the Family plugin.

## Setting up

After installing, every active GateControl account can chat. As an administrator you set on the page **“Overview”**:

- the longest voice message, **retention** (unlimited, 30, 90, 180, 365, 730 days), allow disappearing chats,
- how long a message may be edited or deleted for everyone (default 15 minutes),
- defaults for new accounts (read receipts, “typing …”, content in notifications),
- “allow stories” and “home actions in chats” (both on by default), how long a request stays open, who approves requests naming nobody, “children may ask”,
- **group chats for GateControl groups:** choose the groups the messenger keeps a group chat for. The Family plugin keeps the family group itself.

GateControl stores files encrypted (default 10 GB in all, 25 MB per file). Change the limits under **Settings › Plugins › Messenger › Overview › Media**. Files are only in backups with “plugin media in backup”.

## Using it

- **Start a chat:** pick one or more people in the app or the portal.
- **Attach:** file or photo, location (map, “My location”), poll, event, home action.
- **Tap or menu of a message:** reply, react, edit, delete, pin, “Remind me”, “Save to Drive” (into My files › Messenger).
- **Chat info:** members, shared media, archive, export, block.
- **Status and stories:** “My status” at the top of the list; stories as text or photo.
- **Where notifications appear:** in the messenger's settings, per topic GateControl, family chat or own chat. Locked topics always stay in GateControl.
- The pinned entry **“GateControl”** is your GateControl inbox.

In the portal, files other than pictures, audio and video open in the apps.

## Permissions

- Every active account may chat. Kiosk devices (wall tablet) have no tab “Chats” and are not offered as people.
- In group chats for GateControl groups members change neither members nor title and cannot leave; chat admins are the group's leads.
- Only administrators and parents from the Family plugin may set the family chat as the household's place for notifications.
- On “Overview” and “Log” administrators only see numbers and errors – never texts, titles, file names, members or who writes to whom.
- Bridges to other messengers (only when the server offers them): administrators switch them and see state, memory and the number of people linked – no numbers, contacts or contents. Every person can link only their own account; children only after a parent allowed the service (Family plugin, card “Other messengers”). When a parent takes the permission back, the child’s link is ended – GateControl records in its activity log who did it.

## FAQ / troubleshooting

**“Not sent – malware found.”**
GateControl's virus scan found something in the file. Blocked files show “File blocked”.

**A file does not open in the portal.**
The portal only shows pictures, audio and video. Open other files in the app.

**“My location” does not ask.**
The browser does not allow the location in the portal. Set the point on the map by hand.

**I cannot find the family chat.**
The Family plugin keeps it (page “Features” › messenger group).

**The older WhatsApp history is missing.**
It only comes when linking and appears at night. When “Load older history” is “Off”, or the administrator switched it off, none comes. WhatsApp does not send everything for every chat.

**Old messages are gone.**
The administrator set a retention, or the chat is a disappearing chat.

## New in 1.20.0

- **WhatsApp channels get a page of their own.** Channels you follow in WhatsApp are no longer among your chats but under “Channels” (in the portal an entry above the list, with a grey dot for new posts). A post looks like in WhatsApp: preview picture, title, domain, text with formatting and a clickable link. Channels are read only, send no pushes by default (the bell in a channel turns them on) and do not count as “unread”. You can react to a post; WhatsApp shows other people's reactions only in its own app. If WhatsApp refuses reactions in channels, GateControl hides reacting there.
- **Groups where only admins post** show “Only admins can post in this group.” instead of the input field.
- **WhatsApp groups** are recognised as groups (before, some showed as direct chats).
- **Bold, italic, strikethrough, code** from WhatsApp show as such; **links are clickable in every chat**, link previews with a picture.
- Instead of “WA” the **WhatsApp logo** marks a chat's picture.
- Needs a GateControl server whose bridges support it (preview).

## New in 1.19.0

- **Chats over WhatsApp are named like the contact, never like their number.** When WhatsApp knows no name yet (e.g. right after linking), the chat is named after the contact in your address book (Mail), otherwise “WhatsApp contact” – until the contact shows their name. Chats and contacts that had only a phone number as their name are put right once at start (log: “… put right”). The number does not leave your server for it.
- **No more endless “loading …”:** when a picture, video or file from WhatsApp cannot be fetched after a few tries, the line says “did not arrive” with **“Try again”**. When only the bridge is not reachable right now, the file keeps waiting. The log names the reason (“Bridge: a file could not be fetched”) without names or numbers.

## New in 1.18.0

- **New chat with your contacts:** “New chat” (pen) shows three sections under one search field: **GateControl** (the accounts on your server), **WhatsApp** (your WhatsApp contacts) and **“From your address book”** (your contacts with a phone number from Mail). Long sections show the first hits and “All … ”. With a chat already there, the row says “Open chat”.
- **Tapping a WhatsApp contact** starts the chat at once, without a check.
- **Tapping an address book contact** checks exactly this one number with WhatsApp, then the chat opens. With several numbers you choose in the row – mobile first, landlines greyed out. Without WhatsApp under that number, GateControl remembers it for 30 days (without keeping the number) and does not ask again.
- **The same person only once:** if a number from your address book is also in WhatsApp, the person shows under WhatsApp with the name from your address book and “also in your address book”.
- **“Not listed? Enter a number”** at the bottom opens the previous dialog. Typing a number into the search shows “Check … on WhatsApp” at the bottom.
- **Brake:** every tap on an address book contact that asks WhatsApp counts like a typed number (10 an hour by default). WhatsApp contacts and existing chats always work.
- **Privacy:** your WhatsApp contacts stay on your server – the apps get names, no numbers. A number from your address book only goes to WhatsApp when you tap the contact. The log only notes “WhatsApp number checked” with source and result.
- **Requirements:** a GateControl with the bridges preview (stage 4c); for the address book the Mail plugin 1.16.0 or newer. Children without their parents' permission for new chats see GateControl only.

## New in 1.17.0

- **Load older history:** Under **“Linked services”** you choose how much older history comes along when linking: **Off**, **Last 30 days** (preset) or **Everything** WhatsApp sends. The choice applies at the (next) link.
- **At night, in small portions:** the older history appears in your chats overnight – in the right place, without push and as read. If somebody writes to you in one of these chats before, its history comes right along.
- **Files from the history** (pictures, videos, voice messages) show as a line “older history” with **“Load”** – only then does GateControl fetch them. WhatsApp often no longer has very old files; then the line says you can see them in WhatsApp.
- **“Phone not seen for … days”:** When your phone was not online for 12 days, you get a notification and see the note under “Linked services”. Open WhatsApp on the phone – otherwise WhatsApp ends the link after about 14 days.
- **“Bridge outdated”** also shows when WhatsApp refuses the bridge's version. Your administrator fixes it with a GateControl update; you do not have to link again.
- **For administrators** (card “Bridges” on “Overview”): allow or switch off older history, the night window (preset 01:00–05:00), where the media lie (change the place under Settings › Plugins › Messenger › Storage places – the same storage targets as Drive, always encrypted there), the daily encrypted backup of the bridges' state in the GateControl backup with **“Back up now”**.

## New in 1.16.0

- **New WhatsApp chat by number:** When you linked WhatsApp under “Linked services”, “New chat” (pen) has the line **“WhatsApp chat by number”** under the tabs. Enter the number – the code +49 is preset, a leading 0 and spaces do not matter –, below it says “Checked as +49 …”. Only on **“Check”** does GateControl ask WhatsApp through your bridge. Then you see the name and start the chat with **“Start chat”**; it opens at once.
- **The chat exists:** When you started a chat with that number before, it says “You already have a chat” and **“Open chat”** – without a new question to WhatsApp.
- **When it does not work,** the dialog says why: no WhatsApp under the number, not a complete number, too many checks (with the time of the next one), bridge not reachable, WhatsApp signed out (“Link again”) or – for children – locked by the parents.
- **At most 10 checks an hour** (the administrator can change the value), so that WhatsApp does not block your account for many number lookups. Invalid numbers and chats that exist do not count.
- **Children** need a second permission of their parents for this (“New chats by number” in the Family card “Other messengers”), off at first. Answers in existing chats always work.
- **Privacy:** to check it, the number goes to WhatsApp through your bridge. GateControl does not write it to the log; it is only kept when you start the chat.

## New in 1.15.0

- **Pictures, videos, voice messages and files over WhatsApp:** what a contact sends first shows as “loading …” in the chat and appears shortly after like any other attachment. It is checked for malware like your own attachments.
- When a file is too large for GateControl, of a kind GateControl does not take, or gone at WhatsApp, the line stays and says why – then see it in WhatsApp. A location opens the map view.
- **Sending:** with the paper clip you send pictures, videos and files, with the microphone voice messages into a WhatsApp chat. They go out once the malware check is finished. WhatsApp does not take some formats – GateControl tells you then.
- **Profile pictures:** the chat list shows the picture of your contact or the group.
- **New chat by number:** the server can already start a chat with a phone number; the apps and the portal get the input for it in a later version.

## New in 1.14.0

- **Chats over WhatsApp:** once you linked your WhatsApp account under “Linked services”, a chat with a contact or a group appears in your chat list as soon as a new message arrives there. The picture carries the mark “WA”; above the list you can filter by service.
- **Only you** see these chats – no other member of the family and no administrator.
- **What works:** text, replies, reactions, editing, deleting for everyone, read receipts and “typing …”. Under your message you see whether it was sent, delivered or read – or not sent, with the reason and “Send again”.
- **What does not work yet:** pictures, videos, voice messages and files. When something like that arrives, the chat shows a line such as “Picture – follows; see it in WhatsApp”. Polls, events, home actions, cards and locations do not exist in these chats.
- **Important:** these chats run over WhatsApp and not only over your server. WhatsApp’s encryption ends at the bridge next to your GateControl server.
- **Unlink** under “Linked services” ends the delivery; the chats stay readable. Children still need their parents’ permission.
- **For administrators:** on “Overview” first switch on the main switch of the bridges, then each service under “3 · Which services?”.

## New in 1.13.0

Only on a GateControl server that offers bridges (still a preview there) and has them switched on – nothing changes anywhere else.

- **“Linked services” in the portal:** Under **Chats › Settings › Linked services** you link your own WhatsApp account. First you read and confirm the notes; then you choose **With a code** (enter your number, type the code shown into WhatsApp under “Linked devices › Link a device › Link with phone number instead”) or **QR code** (show it on a second screen and scan it with your phone). The page shows whether the account is linked, whether WhatsApp signed the bridge out (“Link again” – a new code is enough) and lets you **unlink** at any time.
- **Children:** The parents’ switches are now in the Family plugin (portal, card “Other messengers”). When a parent takes the permission back, the child’s link is ended.
- **For administrators:** The card “Bridges” shows “Outdated” when a bridge runs an older version than intended, and names the command that measures memory and disk writes on the server.
- In this version accounts can be linked; the chats with the service’s contacts follow later.

Last in 1.12.0: the card “Bridges to other messengers” on “Overview” (switch, place, state of each bridge, memory in use, number of people linked) and the permission “Bridges to other messengers”.
