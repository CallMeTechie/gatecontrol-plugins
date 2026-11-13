<!-- version: 1.14.0 -->
# Mail

## What the plugin does

- **All mail accounts in one place:** GMX, WEB.DE, T-Online, Gmail, Outlook.com, Microsoft 365 or any other IMAP account – in the GateControl app and the portal tab “Mail”.
- **One shared inbox** (“All inboxes”), split into **Relevant** and **Other**. Push for new mail.
- **Protection against tracking pixels:** pictures from the internet only load after “Load pictures” or “Always from this sender”.
- **Sending** with “Undo” (10 seconds) and “Send later”.
- **Attachments in Drive:** save them there and attach files from Drive.
- **AI** through GateControl's AI provider: “In short”, to-dos and reply suggestions.
- **Calendars:** own GateControl calendars, the accounts' calendars (Microsoft 365, CalDAV such as GMX or WEB.DE, Gmail read only), invitations, reminders; events from Family and Everyday and birthdays shown alongside.
- **Contacts:** an address book with the accounts' contacts, groups and duplicate merging.
- **Free/busy, shared calendars and resources** (since 1.9.0): plan meetings with others, share calendars, book rooms, vehicles and devices.

## Requirements

- GateControl **1.219.0** or later (the tab “Resources” and booking requests by e-mail from 1.225.0).
- A **licence** with seats for people (family or business).
- For attachments in Drive: the Drive plugin 1.15.0 or later. For the AI: an AI provider in GateControl.
- For Outlook.com and Microsoft 365: the Microsoft sign-in (the publisher's registration is preset).

## Setting up

### As an administrator

Under **Settings › Plugins › Mail › Settings**:

1. **Who may use Mail:** everybody or selected people and groups. Every allowed person gets a licence seat the first time they open Mail, while there is room. The card **“People and licence”** shows “x of y people” and every person's seat.
2. **Accounts per person** (1–20), **retention** (1/3/6/12/24 months or all), **attachments** (load on demand or always up to 10 MB) and **storage per person** (1–100 GB).
3. Switch the **AI** (the “In short” bar, sorting, filing to Drive), **calendars** and **contacts** on or off.
4. **Microsoft:** the preset registration or an own client ID. If your company blocks user consent, the Microsoft admin opens the consent link on this page.
5. **Storage places** (optional): where attachments are kept is chosen under **Settings › Plugins › Mail › Overview › Storage places** – this server or a storage target (NAS, S3, OneDrive, Google Drive).
6. **Resources** (optional): tab **“Resources”** – rooms, vehicles, devices with name, kind, location, seats, who may book, automatic answer or approval, and rules.

Administrators only see numbers – never other people's mail, events or contacts.

### As a person: add an account

In the portal tab **“Mail”** (or the app) › settings › **“Add account”** and pick the provider:

- **GMX / WEB.DE:** first allow IMAP access in the webmail under Settings › POP3/IMAP, then email and password.
- **T-Online:** the e-mail password from the Telekom customer centre, not the password of your Telekom login.
- **Gmail:** an **app password** – turn on 2-step verification, then create one under myaccount.google.com › Security › App passwords.
- **Outlook.com / Microsoft 365:** sign in at Microsoft. In the portal Mail shows a code you enter on Microsoft's page. GateControl never sees your password.
- **Other account (IMAP):** your provider's servers and credentials.

Credentials are stored encrypted. The first sync fetches the newest mail first.

## Using it

### Reading and writing mail

- **Several mails at once:** in the app press and hold a mail, in the portal click the box in front of it (Shift-click picks a range). Archive, delete, move, copy, read/unread, flag and spam then apply to all selected ones. **“Select all N”** takes every mail of the folder, including the ones not loaded yet (up to 2000). Afterwards **“Undo”** in the note at the bottom brings everything back – for two minutes.
- **Move and copy** into a folder of the same account; folders used last are on top. Copying into folders of other accounts comes later.
- **Delete:** the mails go to the trash. With **“Ask before deleting”** (settings) Mail asks first, otherwise there is “Undo”. In the trash they are deleted for good – Mail always asks then.
- **Swipe / quick actions:** in the settings one of seven actions per direction: archive, delete, read/unread, flag, move, to spam or nothing. It applies to all your devices; older apps show the three new actions as “nothing”.
- **Relevant / Other:** newsletters and automatic mail usually go to “Other”, mail from people you write to goes to “Relevant”. When you move a sender, Mail remembers it.
- **Conversations and filters:** with “With attachment” (or in Relevant/Other) a conversation shows with its newest mail that matches the filter.
- **Reading:** pictures only after “Load pictures”. Attachments with **“Save in Drive”** (with a folder suggestion) or “Save all in Drive”.
- **Writing:** “Send” goes out after 10 seconds – until then “Undo”. “Send later” schedules the mail. When the server is unreachable, Mail tries three times; then the notification “A mail could not be sent” follows.
- **AI:** “In short” summarises, to-dos lists tasks, plus reply suggestions. Tap a to-do › **“Done”** ticks it off (struck through), “Open again” undoes it.
- **“Notes & Tasks”** (when installed): the to-dos and your flagged mails show there in “My day” and among the tasks – mails of business accounts under “Work”. Ticking one off there marks the to-do done in Mail or removes the mail's flag; tapping it opens the mail.

### Calendars and contacts

- **Calendar:** day, week, month, list; create, change, delete events; answer invitations (the card in the mail). Reminders arrive as push.
- **Free/busy:** in an event Mail shows per person and resource free or busy – never titles – and **suggestions when everyone can** within your working hours.
- **Working hours:** in the portal under Calendar › Calendar settings, in the apps under Mail › Settings › Calendar – the working days and “From”/“To” (default Mon–Fri 8–18). Suggestions only come from this time.
- **Sharing:** in an own calendar's menu “Share” with people or groups – free/busy, read or edit. What is shared with you is under “Shared with me”. When a calendar is shared with you at “Edit”, you can also create new events in it (without attendees).
- **Book a resource** in the calendar or “Add resource” in an event. With approval a request goes to the approvers; they see it under “Requests”.
- **Contacts:** search, groups, merging duplicates, vCard import and export, “Save as contact” from a mail.

### Notifications

New mail, mail not sent, event reminder, invitation, shared calendar, booking request, approval or refusal of a booking. Everyone switches topics off in GateControl's notification settings.

From GateControl 1.225.0, booking requests and the approvals or refusals also come by e-mail to the address of your GateControl account. Switch that off per topic with **“Also by e-mail”**: in the portal under Notifications and in the apps under Settings › Notifications.

## Permissions

- Only people the administrator allows and who have a licence seat use Mail. Without a seat the portal says “Mail is not switched on for you yet”.
- Everyone only sees their own accounts, mail, calendars and contacts – and what others share with them.
- Private events are “busy” at every sharing level. Everyone can switch free/busy off in their Mail settings.
- Resources can only be booked by the people and groups the administrator enters.

## FAQ / troubleshooting

**GMX or WEB.DE refuses the sign-in.**
Allow IMAP access in the webmail under Settings › POP3/IMAP.

**Gmail refuses the password.**
Gmail needs an app password instead of your normal password.

**“The Microsoft sign-in is not set up yet”.**
The administrator sets it up under Settings › Plugins › Mail › Settings.

**My Microsoft account lacks the rights for calendars and contacts.**
Sign in at Microsoft once more. If your company only allows that to the Microsoft admin, pass on the consent link.

**“Notes & Tasks” says “Microsoft still needs your consent”.**
Tap “Consent at Microsoft” there under “Move over › Microsoft To Do” and enter the code. If your company blocks consent by users, the Microsoft administrator grants `Tasks.ReadWrite` through the consent link.

**An attachment cannot be opened right now.**
When attachments live on a storage target that is unreachable, Mail tries again later.

**Free/busy shows “unknown”.**
The person switched free/busy off or is not in GateControl. Colleagues in Microsoft 365 appear through your Microsoft account.

## New in 1.14.0

- **Full-text search as an option:** under Settings › Plugins › Mail there is a new card “Search” with the switch **“Full-text search”**. It is off until an administrator switches it on – so nothing changes right after the update.
- **Switched on**, Mail keeps a search index of the subject, sender, recipients and text of every mail. The search then no longer reads every mail for each request and gets much faster. It finds what it found before, also in the middle of a word (“bill” finds “phonebill”), and upper and lower case no longer matter for umlauts either.
- **Storage:** the index takes about as much storage as the texts of the mails themselves. Once switched on, Mail builds it in the background, newest mails first – with large mailboxes and slow disks this takes a while. The search still finds everything meanwhile. Beside the switch you see the state: off, being built (N mails to go), ready or being removed.
- **One or two characters:** only with the full-text search on, one or two characters are looked for in subject, sender, recipients and snippet, not in the whole text. From three characters on the text is searched too. With the full-text search off everything stays as before.
- **Switching it off** removes the index again, piece by piece in the background. Its room becomes free in the database and is used by new mail; the database file itself does not get smaller.

## New in 1.13.1

- **The background sync keeps its pace:** when a mail provider does not answer or is slow, the other accounts no longer wait for it. Every account gets its turn; large mailboxes are synced in portions and continued in the next run.
- **Clearer messages in the log:** when an account cannot be reached, the log says once which account it is and why – and when it is back.
- **Easier on slow disks:** when a folder has nothing new, Mail no longer writes to the disk.

## New in 1.13.0

- **Several mails at once:** select them (app: long press, portal: the box and Shift-click), “Select all N” for the whole folder, then archive, delete, move, copy, read/unread, flag or spam for all of them.
- **Copy** into another folder of the same account, and **move** now in the portal too.
- **“Undo”** after moving, copying, archiving, deleting and spam – for two minutes; deleted mail comes back from the trash into its folder.
- **Conversations:** an action on a conversation applies to all its mails in that folder – the row really goes.
- **Swiping with seven actions** (new: flag, move, to spam) and **“Ask before deleting”** in the settings.

## New in 1.12.1

- **Less writing when syncing Microsoft 365 calendars:** Mail only writes events and folders when something really changed. On a slow disk (a NAS with hard disks) GateControl stays more responsive.

## New in 1.12.0

- **Moving over from Microsoft To Do:** “Notes & Tasks” can take over your tasks from Microsoft To Do – through your Microsoft account in Mail. Microsoft asks once for your consent (a code at microsoft.com/devicelogin). “Notes & Tasks” only gets access to your tasks, never to your mail. Your mail goes on as usual meanwhile.
- An own Microsoft registration additionally needs the permission `Tasks.ReadWrite` (shown on the admin page).

## New in 1.11.0

- **Ticking off to-dos:** the AI's to-dos can be marked done.
- **“Notes & Tasks”:** with the plugin “Notes & Tasks” the to-dos and flagged mails show there and can be ticked off there. Without that plugin nothing changes.

## New in 1.10.1

- **Faster with large mailboxes:** Mail no longer reads every stored mail for the used storage and the background sync. The first start after the update prepares this once – with very many mails it takes up to a minute.
- **“With attachment”** in the conversation view now shows every conversation with an attachment, even when the last reply has none.

Last in 1.10.0: set your **working hours** in the portal (calendar settings). In 1.9.1: this manual in the tab “Manual” (GateControl ≥ 1.241.0). In 1.9.0: free/busy with meeting suggestions, shared GateControl calendars and bookable resources (rooms, vehicles, devices).
