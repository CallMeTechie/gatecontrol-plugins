<!-- version: 1.23.0 -->
# Family

## New in 1.23.0

- **Other messengers – parents decide:** When your GateControl server offers bridges to other messengers (still a preview there, with the Messenger plugin 1.13.0 or later), parents see the card **“Other messengers”** in the portal tab “Family”. Per child and service (WhatsApp first) there is a switch: may the child link its own account with the chat in GateControl? Everything is off at first. The child links itself, in the chat under “Settings › Linked services”.
- **Taking it back unlinks:** When you lock a service again, the child’s link is ended; its account at the service stays. The services’ age limits still apply.
- When updating, GateControl asks once for the two new services of the Messenger that the Family plugin calls for this.

## New in 1.22.0

- **Places for “Notes & Tasks”:** With “Notes & Tasks” 1.5.0 or later a task can hang on a place. “Home” (the location from the settings) and the family's rule places can be chosen there – for members of the family only.
- **Sharing the watched places:** Android allows an app 100 watched places. The Family plugin tells “Notes & Tasks” how many places your phone already watches for place reminders and rule places – only the number, no place. The family's place reminders come first.
- The place reminders stay where they are; nothing changes for you here.

## What the plugin does

The family in the GateControl app (a tab of its own), in the portal (tab “Family”) and on a wall tablet. Everything stays on your server. Each function is switched on or off on its own:

- **Everyday:** shared shopping lists (usable offline, “I'm going shopping”), tasks with reminders (fixed, in turn or whoever is first), events and birthdays, pinboard and packing lists, meal plan.
- **On the way:** pick-ups & rides (“Who picks up Tim?”), place reminders on arriving or leaving.
- **Children & safety:** stars for children, locating children on request (the child sees every request, it ends at 18), “I've arrived” and SOS, emergency card.
- **Money:** pocket money (bookkeeping only), wish lists, household book.
- **Home:** presence through the app or the home Wi-Fi with smart home rules (only with consent), rules and reminders, **internet at home** (pause and “longer today” for children).
- **Working together:** the group “Family” in GateControl and in the Messenger, events from Everyday and School, quick actions of other plugins in rules.

## Requirements

- GateControl **1.216.0** or later (presence through the home network from 1.230.0, internet at home from 1.231.0, “pause the internet” in rules from 1.259.0).
- GateControl accounts for every family member.
- For presence through the home network and internet at home: a GateControl gateway with the network watch or DNS filter on which the phones are assigned to the people.
- For the family chat: the Messenger plugin. For switching in the smart home: the device's plugin (e.g. Smart Home, Door & Camera).

## Setting up

1. **Members:** admin page **“Members & locating”** – add GateControl accounts as **parent** or **child**, with birth date (required for children), colour, star goal and the way each child is located (*child confirms*, *automatic*, *off*).
2. **Functions:** admin page **“Features”** – switch the functions you want on. “Preview as …” shows the app tab as a member sees it. Here you also switch the group “Family” in the Messenger.
3. **Settings** (**Settings › Plugins › Family › Settings**): time zone, notification language, latitude and longitude of the home (for “after sunset”), “children may create their own reminders”, shopping and early end of school.
4. **Presence & smart home** (optional): everyone consents themselves (“Share presence” in the app, or in the portal the card about how the family knows you are at home). For the home Wi-Fi an administrator assigns the phone to the person at the gateway; the person switches it on. Parents create rules on the page **“Presence & smart home”** or in the portal.
5. **Wall tablet** (optional):
   1. Create a GateControl account of its own (e.g. “Kitchen”, role member, not an administrator).
   2. Add it under “Members & locating” as **“Wall tablet”**.
   3. In GateControl open the account › **“Pair kiosk device”**. On the tablet scan the QR code or open `https://<your portal>/portal/kiosk` and enter the code.
   4. Point the tablet's kiosk browser to `https://<your portal>/portal`.
   The pairing lasts 90 days and renews with every use. To end it: in GateControl at the user › “Kiosk devices” › “Revoke”, or “Sign out” on the tablet.

## Using it

- **App tab and portal tab “Family”:** the day's overview, shopping lists, tasks, events, pinboard, meal plan, wish lists, pocket money, rides and the functions switched on.
- **Locating children** (parents): a request with countdown and map. The child sees every request; with *child confirms* it sends or declines. At most 30 requests per child and day.
- **“I've arrived” and SOS** (app): “I've arrived” to the parents, SOS as an urgent notification with position – even during quiet hours.
- **Rules:** e.g. “Everyone is out” › lights off, “First person comes home” › scene, “Child home alone” › notify the parents; with a time window and “after sunset”. In the rule editor's tab **“Internet at home”** parents can have a rule pause or resume a child's internet, e.g. “daily 18:30 › pause Tim's internet for 30 min”.
- **Internet at home** (parents, portal): per minor child “Pause …” (30 min, 1 h, until 7 tomorrow, until a time), “End pause”, “Longer today …”. The child is told – also when a pause or extra time runs out by itself. The card shows whether the child is at home (if it shares its presence) and who or which rule paused. It does not apply on mobile data. The notifications run in the topic “Internet at home”, which everyone can switch off for themselves in the notification settings.
- **Wall tablet:** events, tasks to tick off, shopping, meals, who is at home, “School today” (with the School plugin), Wi-Fi card (with the Vault plugin).
- **“Notes & Tasks”** (when installed): your tasks, the children's tasks (for parents), shopping lists with something open and today's reminders show there in “My day”. Ticking off there counts in Family (with stars). **Pinboard and packing lists** then move into “Notes & Tasks” – you keep seeing and editing them in Family as before, and the hub has them as the notebooks “Pinboard” and “Packing lists” for the whole family. When the plugin cannot be reached for a while, Family works on and catches up later; templates stay in Family.

## Permissions

- **Parents** create tasks, events and rules, locate children, see the household book and every child's pocket money, control internet at home and decide which other messengers a child may link with the chat (card “Other messengers”, only with the bridges of the Messenger plugin).
- **Children** tick off tasks, see their pocket money, send “I've arrived” and SOS. Locating ends by itself at the 18th birthday.
- The **wall tablet** ticks off tasks and adds shopping, but sees no positions.
- Portal visits recognised only by device trust can only read – no positions, no SOS, no presence.
- Presence and places only count in rules for people who consented themselves.
- “Pause the internet” in a rule runs in the name of the parent who saved the rule last. If that person is no longer a parent of the family, the step does not run; the rule's log says so.

## FAQ / troubleshooting

**The app tab “Family” is missing.**
The person is not a member, or no function is switched on.

**Locating says the child's phone did not answer.**
The phone did not answer within 10 minutes (off, no network, app closed). Try again later; at least 60 seconds lie between two requests.

**A rule does not fire.**
Did everyone involved switch on “Share presence”? A rule fires once per change and at most every 10 minutes. The rules' log shows every run; “action no longer available” means the other plugin no longer offers the quick action.

**The wall tablet cannot be paired.**
An administrator account or a disabled account cannot be a wall tablet. Use an account of its own with the role member.

**A change of the pinboard is missing in “Notes & Tasks” (or the other way round).**
Changes in Family go over at once, changes in the hub come back within 15 minutes at the latest (mostly within half a minute). If “Notes & Tasks” could not be reached, Family catches up with the next run.

**The card “Internet at home” is missing.**
It needs GateControl 1.231.0 and a gateway with the DNS filter, and it only shows for parents after signing in.

**A rule does not pause the internet (“not run”).**
The step needs GateControl 1.259.0 or later and a gateway with the DNS filter. “No longer allowed” means: whoever saved the rule last is no longer a parent of the family – a parent opens the rule and saves it again. “No longer a minor child of the family”: remove the step.

## New in 1.21.0

- **Shopping lists in “Notes & Tasks”:** With the plugin “Notes & Tasks” (1.4.0 or later) installed, the shopping lists can move there. Under **Settings › Plugins › Family › Functions** the card “Shopping lists in ‘Notes & Tasks’” shows what moves (e.g. “2 shopping lists with 14 items”); **Move** starts it. Nothing moves by itself.
- **What changes:** Afterwards the lists are under “Tasks”, stay shared with the whole family and a task can carry one (“shopping at Lidl”). Once every item is ticked, the task is done.
- **What stays:** The card “Shopping list” in the Family tab, the wall tablet and the cards in the chat stay and show the lists “from Notes & Tasks”. “I'm going shopping” and “Can you do the shopping?” work as before.
- **Safe:** The Family plugin keeps a copy. If “Notes & Tasks” is switched off or removed, it works on with it. **Bring back** gives the lists back to the Family plugin. Moving again never makes anything twice.
- **Without “Notes & Tasks”** nothing changes.

## New in 1.20.0

- **Rules can pause the internet:** the rule editor has the tab “Internet at home” – per child “Pause” (30 min, 1 h, 2 h, until a time) or “Resume”. The rule acts in the name of the parent who saved it (GateControl ≥ 1.259.0).
- **“Time is up”:** when a pause or extra time runs out by itself, the child is told.
- **Card “Internet at home”:** shows “at home · Wi-Fi”, “at home · app” or “away” and names the rule that paused.

## New in 1.19.0

- **“Notes & Tasks”:** with the plugin “Notes & Tasks” the family's tasks, shopping lists and reminders show in its “My day” and can be ticked off there. Pinboard and packing lists move there and stay visible and editable in Family. Without that plugin nothing changes.

## New in 1.18.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.18.0: internet at home – parents pause a child's internet in the home network or give it “longer today”; the child is told.
