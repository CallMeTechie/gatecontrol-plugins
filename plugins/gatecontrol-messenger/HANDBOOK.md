<!-- version: 1.15.0 -->
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

- GateControl **1.193.0** or later (group chats for GateControl groups from 1.200.0, virus scan from the version after 1.222.0).
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

**Old messages are gone.**
The administrator set a retention, or the chat is a disappearing chat.

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
