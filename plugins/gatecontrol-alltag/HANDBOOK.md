<!-- version: 1.5.0 -->
# Everyday

## What the plugin does

- **Waste collection:** collection plans for one or more addresses (e.g. home and parents) from online waste calendars (AbfallNavi, abfall.io / AbfallPlus, AWIDO), from your municipality's ICS file or from your own rules. Bins with colour and symbol, exceptions for moved dates.
- **Calendars:** iCal subscriptions from Google Calendar, iCloud and Outlook or from the home network (Nextcloud, Radicale …).
- **Reminders** in the GateControl app: “Tomorrow: yellow bag”, events at their start or some minutes before.
- **Portal “Home”:** the next collection days and the events of today and the next 7 days, tiles on the start page.
- **For other plugins:** Family uses the calendars for rules with “event today/tomorrow”, Mail shows them in its calendar (read only).
- **“Notes & Tasks”:** with the plugin “Notes & Tasks” the waste collections show in “My day” on the evening before (“Put out: Yellow bag”).

## Requirements

- GateControl **1.216.0** or later.
- For an online waste calendar: your municipality uses AbfallNavi, abfall.io or AWIDO. Otherwise an ICS file of the municipality or your own rules.
- For calendars: the secret iCal address of your calendar or a calendar server in the home network.

## Setting up

### Waste collection

1. In the plugin › tab **“Waste collection”** › **“Add collection plan”**.
2. Choose the **source of the dates**:
   - **Online waste calendar:** provider → municipality/collector → place → street → house number, with a preview. The plugin fetches the dates at most twice a day.
   - Upload the municipality's **ICS file** (up to 900 KB).
   - **Own rules:** bin, first date, every N weeks, optionally until when.
3. **People:** everyone or only selected people. They see the plan in the portal and get its reminders.
4. **Reminder:** none, on the collection day, 1 day before (default), 2 or 3 days before, with a time; optionally also on the collection day.
5. Rename bins, change their colour or kind or hide them, and enter **exceptions** (date cancelled or moved).

### Calendars

1. In the plugin › tab **“Calendar”** › **“Subscribe to a calendar”**.
2. **Internet address (iCal):** the calendar's secret iCal address. Where to find it:
   - **Google:** Settings → your calendar → “Secret address in iCal format”.
   - **iCloud:** share calendar → “Public calendar”.
   - **Outlook:** “Publish calendar” → ICS.
   `webcal://` works too. Other internet services are not fetched, for security reasons.
3. **Calendar in the home network** (Nextcloud, Radicale …): assign the server to the target “Calendar (home network)” under **Settings › Plugins › Everyday › access targets**, then enter the path of the export address and, if needed, user and password in the dialog.
4. **People:** calendars are personal – only the chosen people see it and get its reminders.

The address and the credentials are stored encrypted and never shown again. The plugin fetches calendars every 30 minutes.

### Settings

**Settings › Plugins › Everyday › Settings:** switch the areas “Waste collection” and “Calendar” on or off, time zone (default Europe/Berlin), default reminder times (evening before 18:00, on the collection day 06:30, all-day events 07:00), notification language.

## Using it

- **Portal “Home”:** section “Waste collection” with the next collection days and section “Events” (today and the next 7 days). Event details only after signing in, otherwise only the number. Tiles “Next collection” and “Today” on the start page.
- **App:** reminders of the topics “Waste collection” and “Events”; the Family app shows the events in the calendar's colour.
- **“Send test reminder”** per area sends you a sample.
- **“Notes & Tasks”** (when installed): the collections of the next 14 days, one line per bin, in “My day” on the evening before. Who sees them is the plan's choice (its people). They cannot be ticked off there; they go away by themselves after the collection day.

## Permissions

- Administrators create collection plans and calendars and see all of them.
- People see the collection plans they are chosen for and the calendars assigned to them – in the portal, the app and other plugins (Family, Mail).
- A calendar's address never leaves the plugin.

## FAQ / troubleshooting

**My municipality is not with any provider.**
Upload the ICS file from your municipality's website or create your own rules.

**A calendar cannot be subscribed.**
Only Google, iCloud and Outlook are allowed. For your own servers use the access target “Calendar (home network)”.

**Dates are out of date.**
After errors the plugin asks less often (calendars up to every 6 hours, waste calendars up to every 12 hours). The last good dates stay; the error is shown on the page.

**No reminder arrived.**
Did you switch off the topic “Waste collection” or “Events” in the notification settings? Are you chosen as a person for the plan or calendar? “Send test reminder” shows whether notifications arrive.

## New in 1.5.0

- **Waste collection in “Notes & Tasks”:** with the plugin “Notes & Tasks” the collections show in “My day” on the evening before – “Put out: Yellow bag”, for the plan's people. Without that plugin nothing changes.

## New in 1.4.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.4.0: calendars in Mail – Mail shows a person's Everyday calendars in its calendar.
