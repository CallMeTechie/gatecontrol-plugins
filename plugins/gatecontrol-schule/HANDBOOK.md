<!-- version: 1.7.2 -->
# School

## What the plugin does

- The **WebUntis timetable** in GateControl – for student and parent accounts, each child in its colour: on the page “School”, in the portal, on the Family wall tablet and in the app.
- **Push on changes:** cancellations, substitutions, extra lessons and “takes place after all” for today and the next days.
- **Tests and homework** with a reminder the evening before.
- **School messages** with full text and attachments, read confirmation, and **absences** from the class register.
- Save **attachments in Drive** – by hand or automatically.
- **Start tile and widget** per child.
- With the **Family** plugin: rules with “lesson cancelled”, a pick-up hint when school ends early, “School today” on the wall tablet.

> **Note:** the plugin uses the **unofficial interface of the WebUntis web app** – no warranty. Untis does not support it; it may change at any time, and the school can restrict access. The plugin is not a product of Untis GmbH.

## Requirements

- GateControl **1.196.0** or later.
- A **WebUntis account** of the school: student account or parent account.
- For attachments in Drive: the Drive plugin 1.4.0 or later.
- For rules, pick-up and the wall tablet: the Family plugin (1.12.0 or 1.13.0 or later).

## Setting up

Everything is set up under **Settings › Plugins › School › Settings** (“Accounts & children”).

### Step 1: find the QR code in WebUntis

Open WebUntis in the browser and sign in with the child's account or the parent account. Then usually at the bottom left click the **profile** (name) › tab **“Sharing”** › at **“Access via Untis Mobile”** click **“Display”**. The wording differs between schools and versions. WebUntis shows a QR code.

### Step 2: add the account

**“Add WebUntis account”** and choose one of three ways:

- **“Scan QR code”** – GateControl opens its camera dialog and reads the QR code from the screen. The picture stays in GateControl.
- **“Upload QR picture”** – a screenshot or photo of the QR code.
- **“Enter manually”** – server (e.g. `xyz.webuntis.com`), school, user and the key below the QR code, or the account's password.

The plugin signs in once and shows the students it found: a student account is the student; a parent account brings its children. You can revoke the access in WebUntis at any time.

### Step 3: set up the children

Under **“Children”** click **“Edit”** for each child: display name (e.g. “Lena”), the child's **GateControl user** (optional), **colour**, **further recipients** (e.g. the parents), **“Show on the wall tablet”** and on/off.

### Step 4: settings

The school's time zone, polling interval (default 15 minutes), notification language, push for the next … days, **quiet time** (default 21:00–06:00), **reminder the evening before** (default 18:00, empty = off), “also report absences to the child” (default off), “users may link their WebUntis account themselves” (default on) and “save attachments of school messages to Drive automatically” (default off).

### Linking your own student account in the profile

Every signed-in person can link their **own student account**: in the portal under **“My devices”** › section **“WebUntis”** – scan the QR code, upload a picture or enter it. Parent accounts are set up by an administrator.

## Using it

- **Page and portal tab “School”:** a card per child (today from–to, cancellations, next test), below it the week Mon–Fri (day by day on the phone) and the lists **changes**, **tests**, **homework**, **messages** and **absences**. Cancellations are struck through in red, substitutions orange.
- **Messages:** a tap opens the full text with attachments. **“Save to Drive”** files an attachment in Drive (without a chosen folder in the family area under “Schule › child”). When the school asks for a read confirmation, **“Confirm reading”** sends it – only after a question.
- **App:** timetable, messages and absences, Start tile “School · name” and a widget per child.
- **Notifications:** timetable changes, tests, homework, school messages, absences. What is found during the quiet time arrives at its end. The first poll only records the state and reports nothing.

## Permissions

- **Administrators** see all students (push only when entered as a recipient).
- The **assigned child** and the **recipients** see “their” students – in the portal, the tile, the widget and the app.
- **Kiosk devices** (wall tablet) only see students with “Show on the wall tablet” – no messages and no absences.
- **Other people** see nothing, nor does a portal visit recognised only by device trust.
- **Messages** of a parent account are read by administrators and the recipients – not by the child. **Absences** are seen by administrators, the recipients and the child.

## FAQ / troubleshooting

**I cannot find the QR code in WebUntis.**
It is usually under profile › “Sharing” › “Access via Untis Mobile”. Some schools switch it off; then use “Enter manually” with user and password.

**“Tests are not released for this account in WebUntis”.**
The school does not release them for this account. The timetable still works; the plugin checks again once a day. The same goes for messages.

**The sign-in is refused.**
Check the access with “Change access”, e.g. with a new QR code. After failed sign-ins the plugin tries less often so WebUntis does not lock the account.

**No notifications arrive.**
Is the child assigned to a GateControl user, or are recipients entered? Is it quiet time right now? The diagnosis under “Accounts & children” shows the last polls and errors.

**Attachments do not end up in Drive.**
Drive must be installed and the person needs a Drive seat. For automatic saving a recipient of the child needs a Drive seat and a family in Drive.

## New in 1.7.2

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.7.1 and 1.7.0: save attachments of school messages in Drive (also automatically) and a clearer log line on polling errors.
