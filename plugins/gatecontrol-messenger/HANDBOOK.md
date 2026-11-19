<!-- version: 1.28.2 -->
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

- GateControl **1.294.0** or later (WhatsApp status in the status row; Telegram bridge from 1.293.0; Signal bridge from 1.291.0; group chats for GateControl groups from 1.200.0, virus scan from the version after 1.222.0).
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

**The older Signal history is missing.**
Signal sends it only once when linking, and only if you choose “Transfer” on your phone. GateControl takes at most 30 days. Changing it later brings nothing from Signal.

**The older WhatsApp history is missing.**
It only comes when linking and appears at night. When “Load older history” is “Off”, or the administrator switched it off, none comes. WhatsApp does not send everything for every chat.

**Old messages are gone.**
The administrator set a retention, or the chat is a disappearing chat.

**A service is missing from the card “Bridges”.**
GateControl may already offer a service this Messenger version does not know yet. It appears once you update the Messenger.

## New in 1.28.2

- **New service, older Messenger:** when GateControl offers a service this Messenger version does not know yet, it no longer shows up anywhere – neither in the card “Bridges” nor under “Linked services”. Before, a text key such as “admin.br_net_telegram” stood there. After an update of the Messenger the service appears as usual.

## New in 1.28.1

- **Virus scan after an outage:** when the virus scanner was away for a while and then checked many files at once, not every result reached the chat – some pictures and files stayed at “Being checked …”. Now every result arrives, and the chats show it at once.

## New in 1.28.0

- **My places:** for place messages and “live arrival” you can now also choose your own places from “My profile › My places”, next to the Familie places. The places you use most here come first.
- **One place, the same everywhere:** when you move a place in your profile or change its radius, your place messages follow at once. The phone then watches the new point.
- **Deleted place:** when you delete a place that still has a place message, the place message stays at the old point. The app tells you, and you can choose another place.
- The profile shows for each place how many place messages use it (“Used by”).
- **Event from a message:** “30.11 um 08:00” is now read as 30 November (before: today 08:00), also without a dot after the month. The suggested title no longer holds the date or “um” / “Uhr”.
- Needs GateControl 1.298.0 or newer.

## New in 1.27.1

- **Place messages with every Familie place:** a place message with a place from “Familie” other than “Home” (for example “School”) could not be saved. Now it works with all Familie places.

## New in 1.27.0

- **Send messages via:** when a person has several ways (GateControl and WhatsApp), choose in the chat info under “Send messages via”: **Automatic** (the way of their last message, as before), **Always GateControl** or **Always WhatsApp** (or Signal, Telegram). When WhatsApp is not connected right now, the message goes via GateControl and the line under the composer says “WhatsApp not connected”. When you reply to a particular message, the reply still goes the way of that message. The choice holds in the portal, the app and the Windows client.
- **Calmer composer:** the line above the composer (“Goes via WhatsApp …”) is gone. The composer itself says which way your message takes (“Message via WhatsApp”). The header shows only the logos of the ways under the name.
- **Full plus menu:** even when your text goes via WhatsApp, the plus menu offers polls, events and home actions. They carry the GateControl logo and go to the person's GateControl chat (only when they have a GateControl account).
- **Location via WhatsApp and Telegram:** a location goes out as a real location message when the chat runs via WhatsApp or Telegram. Via Signal it goes, with the GateControl logo, to the GateControl chat (Signal has no location message). A location someone sends you via WhatsApp or Telegram shows as a map. Needs GateControl with the new bridge version.
- **Place messages:** in the Android app a message can be sent automatically when you reach or leave a place (“Send on arrival”). The phone watches the place itself; the server never learns where you are. At most 10 active ones, each at most once an hour; without network it is sent up to 30 minutes later. Your own message shows a small “Place message · Home”; the recipients see only the text.
- Needs GateControl 1.296.0 or newer.

## New in 1.26.0

- **Older WhatsApp pictures, videos and voice messages** of the history that WhatsApp no longer keeps no longer show an English note but “Older voice message – open it in WhatsApp” (or picture, video, file, sticker).
- **Fetch from the phone:** the administrator can turn on **“Fetch old media from the phone”** on the card “Bridges” – “Once a day (recommended)” or “Right away”. The chat then says “… – will be loaded from the phone later” or “… – loading”, and once the phone sends the file it replaces the placeholder. The phone has to be online; it costs data volume and battery. “Once a day” means about 8 hours after the bridges' nightly backup (the card names the time); to have it at night, move the backup to the evening. When the phone no longer has the file, it says “… – the phone could not send it; open it in WhatsApp”.
- WhatsApp only. Needs GateControl 1.295.0 or newer.

## New in 1.25.2

- **WhatsApp status with the right name and picture.** A status sometimes showed in the status row with the name “.” and no profile picture, although WhatsApp shows the contact with name and picture. For a status WhatsApp gives the bridge only the contact’s public name, and some people set it to “.”. Now the contact is named as you know them: first as in your address book (Mail), then as your chat with them, then as in your WhatsApp contacts. If none of these is known, it says “WhatsApp contact”, never “.” and never the number. The picture is the one of your chat, else the contact’s own. This applies to the status row and the status viewer.
- **In the chat list too** a chat is no longer called “.”, “-” or “…”, but as in your address book or “WhatsApp contact”.

## New in 1.25.1

- **WhatsApp status updates also arrive after updating in the "wrong" order.** When GateControl was updated before the Messenger, the chat "WhatsApp Status Broadcast" stayed in the chat list (with a group icon) and the status row showed no WhatsApp status – until a contact posted a new one. The Messenger now catches up the next time the chat list or the status row is opened: the chat leaves the list and its status updates appear in the status row. Nothing is lost; status updates older than 24 hours are deleted as usual.

## New in 1.25.0

- **WhatsApp status in the status row.** The status updates of your WhatsApp contacts appear at the top of the chats in the status row, mixed with the GateControl people: unseen first, then the newest. The WhatsApp logo at the picture marks them. The chat “WhatsApp Status Broadcast” leaves the list, the search and the unread count.
- **Viewing:** pictures, videos and text; a text status in the app colour (WhatsApp does not pass on colour and font). There is no list of viewers.
- **Replies and reactions:** both go as a normal message to your WhatsApp chat with that person, a reaction as “❤️ on your status”. The bridge cannot react to a status directly; the line under the reply field says so.
- **“Seen”:** a status is marked as seen here (grey ring). WhatsApp learns it only when you turn on **“Tell WhatsApp when I view a status”** under “Status” in the settings (off by default). It works only with read receipts on and only for status updates you really viewed.
- **24 hours:** as in WhatsApp. Then the status and its file are deleted. When the contact deletes a status, it goes at once. WhatsApp status updates cause no notification.
- **Where:** in the portal, the Android app and the Windows client in their new versions. Needs GateControl with `gc.bridges` version 12. With an older GateControl nothing changes.

## New in 1.24.0

- **Telegram in the messenger.** Under “Linked services” you link your own Telegram. Telegram chats are in the same list with the paper-plane logo and the chip “Telegram”; Telegram channels are on the channels page.
- **Two ways:** on a computer the QR code comes first (Telegram › Settings › Devices › Link Desktop Device). On a phone you use your phone number: Telegram sends the code into the Telegram app. With two-step verification on, GateControl asks for the password once – it goes to Telegram only and is stored nowhere.
- **Bots** are direct chats marked “Bot”; their buttons work only in Telegram. **Large groups** of 200 members and more are muted at first. Files too large for GateControl open in Telegram. **Secret chats** never arrive, they stay on your phone.
- **For administrators:** Telegram starts only with an application id of its own. In the card “Bridges” → Telegram → “Set up”: sign in at my.telegram.org with your Telegram number, create an application under “API development tools” (name “GateControl”, platform “Other”) and enter `api_id` and `api_hash` in the form – never in a chat or a file. GateControl stores both encrypted and never shows them again. The switch “Convert animated stickers” now works for Telegram.
- **Parents** allow Telegram per child in Familie, and additionally “Telegram channels” (off by default).

## New in 1.23.0

- **Signal in the messenger.** Under “Linked services” you link your own Signal – like Signal Desktop, as a linked device. Signal chats stand with a blue logo in the same list as GateControl and WhatsApp, with a chip “Signal”, groups included.
- **QR code only.** Signal links only with a code on a second screen. In the app you tap “Continue in the portal” or “Continue in the Windows client” – the step opens there, signed in as you, and you scan it with Signal on your phone. The code renews itself.
- **Older history:** after the scan Signal asks on your phone whether to transfer your history. GateControl takes at most the last 30 days of it, at night and in small portions. Signal does not allow this later.
- **Safety numbers** are checked in the Signal app only: the bridge accepts new keys on its own, a line at the top of a Signal chat says so.
- **Disappearing messages** from Signal hold here too (“Messages disappear after 1 week”); only Signal can change them. Open a **view-once** message in Signal. Stickers arrive as pictures.
- **Recognition per service:** after linking, the messenger asks once: “May others on this server recognise you by your Signal?” – separate from WhatsApp, changeable in “My profile” under “Recognition”.
- **For administrators:** the card “Bridges” has a row for Signal and the switch “Convert animated stickers” (default off: a still picture). When the server's `docker-compose.yml` does not know Signal yet, the card says so – replace it once with the new one.

## New in 1.22.0

- **“Who can see your picture?” now applies everywhere in GateControl.** The setting is no longer in the Messenger but in your profile (“My profile” in the portal, the profile in the app): Everyone on this server, **Contacts**, Family or Only me. It applies in chats, in Family, in Drive and everywhere else.
- **Contacts** means your family and everyone you share a direct chat or a group with. Whoever may not see your picture sees your initials in your colour – in the list, the chat header, as the sender in groups and in the push notification.
- **Taken over once:** On the first start with the new GateControl the Messenger takes over your earlier choice (“Family” stays Family, “Nobody” becomes “Only me”) – only if you have not chosen anything in the profile yet.
- In the app's privacy settings, “Profile picture” now leads to your profile. Older apps that still change the setting in the Messenger change it in the profile.
- WhatsApp, Signal and Telegram never get your GateControl picture.
- On an older GateControl everything stays in the Messenger as before.

## New in 1.21.0

- **One person, one chat.** Someone who writes to you over GateControl and over WhatsApp can stand in your list once – with one shared history, mixed by time. Each message carries the logo of its way; at the top of the chat you filter “All”, “GateControl” or “WhatsApp”. The ways stand behind the name in the list.
- **Asked first, merged after.** When GateControl recognises the same person on two ways, a card appears above the list (“"Schatzimausi 💕" on WhatsApp may be Jenny Backes.”). Nothing is merged before you tap “Merge”; you pick the name (the GateControl account's by default). “Not now” hides the suggestion for 7 days, “Don't suggest again” for good. GateControl only recognises people who agreed (in their profile under “Recognition”) – never by name.
- **By hand:** in the chat info of a chat with one person, “Merge with person …” – a GateControl account or another chat. Groups and channels are never merged.
- **Answers:** your answer goes automatically over the way of the last message you received (on a tie and without an incoming message over GateControl). The input field names the way (“Message via WhatsApp”); when it goes over WhatsApp a line reminds you that WhatsApp's encryption ends at the bridge next to your server. An answer to a particular message goes over that message's way.
- **For the person:** unread counts both ways, mute and archive hold for both, a push reads “Jenny Backes · via WhatsApp”. Search finds every name of the person.
- **Only for you:** the other person sees nothing of it. “Separate” in “Ways to reach …” shows the chats apart again – no message is lost.
- **When you link WhatsApp** the messenger asks once: “May others on this server recognise you by your WhatsApp?” (default: no; change it in “My profile” under “Recognition”).
- Suggestions and the question at the link need a GateControl server with the user profile and bridges in the new version; merging by hand works with any server with bridges.

## New in 1.20.0

- **WhatsApp channels get a page of their own.** Channels you follow in WhatsApp are no longer among your chats but under “Channels” (in the portal an entry above the list, with a grey dot for new posts). A post looks like in WhatsApp: preview picture, title, domain, text with formatting and a clickable link. Channels are read only, send no pushes by default (the bell in a channel turns them on) and do not count as “unread”. You can react to a post; WhatsApp shows other people's reactions only in its own app. If WhatsApp refuses reactions in channels, GateControl hides reacting there.
- **Groups where only admins post** show “Only admins can post in this group.” instead of the input field.
- **WhatsApp groups** are recognised as groups (before, some showed as direct chats).
- **Bold, italic, strikethrough, code** from WhatsApp show as such; **links are clickable in every chat**, link previews with a picture.
- Instead of “WA” the **WhatsApp logo** marks a chat's picture.
- Needs a GateControl server whose bridges support it (preview).

## New in 1.19.1

- **Profile pictures from WhatsApp arrive after all.** When the picture of a chat or contact could not be fetched a few times (e.g. before GateControl 1.278.1, when the server did not take the bridge’s answer), the Messenger gave it up for good – the chat only showed initials. Now it tries again later, at growing intervals (at most every 6 hours), and at start fetches once every picture still missing. When a contact does not show you their profile picture in WhatsApp (privacy), the initials honestly stay.
- **Initials without a replacement mark:** a name with an emoji (“Schatzimausi 💕”) shows “S” instead of “S” with a replacement mark. Initials are letters and digits only; a name made of emoji only shows the person symbol.

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
