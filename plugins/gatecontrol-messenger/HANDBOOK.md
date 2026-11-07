<!-- version: 1.11.1 -->
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

## New in 1.11.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.11.0: the messenger takes over GateControl's virus scan – quarantined files are not sent, blocked files cannot be fetched.
