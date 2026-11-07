<!-- version: 1.18.1 -->
# Family

## What the plugin does

The family in the GateControl app (a tab of its own), in the portal (tab “Family”) and on a wall tablet. Everything stays on your server. Each function is switched on or off on its own:

- **Everyday:** shared shopping lists (usable offline, “I'm going shopping”), tasks with reminders (fixed, in turn or whoever is first), events and birthdays, pinboard and packing lists, meal plan.
- **On the way:** pick-ups & rides (“Who picks up Tim?”), place reminders on arriving or leaving.
- **Children & safety:** stars for children, locating children on request (the child sees every request, it ends at 18), “I've arrived” and SOS, emergency card.
- **Money:** pocket money (bookkeeping only), wish lists, household book.
- **Home:** presence through the app or the home Wi-Fi with smart home rules (only with consent), rules and reminders, **internet at home** (pause and “longer today” for children).
- **Working together:** the group “Family” in GateControl and in the Messenger, events from Everyday and School, quick actions of other plugins in rules.

## Requirements

- GateControl **1.216.0** or later (presence through the home network from 1.230.0, internet at home from 1.231.0).
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
- **Rules:** e.g. “Everyone is out” › lights off, “First person comes home” › scene, “Child home alone” › notify the parents; with a time window and “after sunset”.
- **Internet at home** (parents, portal): per minor child “Pause …” (30 min, 1 h, until 7 tomorrow, until a time), “End pause”, “Longer today …”. The child is told. It does not apply on mobile data.
- **Wall tablet:** events, tasks to tick off, shopping, meals, who is at home, “School today” (with the School plugin), Wi-Fi card (with the Vault plugin).

## Permissions

- **Parents** create tasks, events and rules, locate children, see the household book and every child's pocket money and control internet at home.
- **Children** tick off tasks, see their pocket money, send “I've arrived” and SOS. Locating ends by itself at the 18th birthday.
- The **wall tablet** ticks off tasks and adds shopping, but sees no positions.
- Portal visits recognised only by device trust can only read – no positions, no SOS, no presence.
- Presence and places only count in rules for people who consented themselves.

## FAQ / troubleshooting

**The app tab “Family” is missing.**
The person is not a member, or no function is switched on.

**Locating says the child's phone did not answer.**
The phone did not answer within 10 minutes (off, no network, app closed). Try again later; at least 60 seconds lie between two requests.

**A rule does not fire.**
Did everyone involved switch on “Share presence”? A rule fires once per change and at most every 10 minutes. The rules' log shows every run; “action no longer available” means the other plugin no longer offers the quick action.

**The wall tablet cannot be paired.**
An administrator account or a disabled account cannot be a wall tablet. Use an account of its own with the role member.

**The card “Internet at home” is missing.**
It needs GateControl 1.231.0 and a gateway with the DNS filter, and it only shows for parents after signing in.

## New in 1.18.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.18.0: internet at home – parents pause a child's internet in the home network or give it “longer today”; the child is told.
