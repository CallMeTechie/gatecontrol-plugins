<!-- version: 1.6.2 -->
# Vehicles

## What the plugin does

- **Škoda vehicles** from your MySkoda account: charge level, range, state (doors, windows, lights, locking), charging, climate, position with address, mileage, warnings and service.
- **Control:** climate and target temperature, window heating, charging and charge limit, lock and unlock (with the S-PIN), departure timers.
- **Logbook:** trips are recorded automatically after parking – with a purpose (private, business, commute), a map and export as PDF or CSV.
- **Owners:** you assign vehicles to people. They see and control them in the portal (tab “Vehicle”) and in the app.
- **Notifications:** charging done, battery low, vehicle not locked, climate ready, trip recorded.
- **GateControl apps:** quick actions and widgets per vehicle, a widget “Logbook” and – in the Android app 1.56 or later – a logbook page of its own.

## Requirements

- GateControl **1.186.0** or later.
- A **MySkoda account** with your vehicles in its garage.
- To lock and unlock: your account's **S-PIN**.

## Setting up

1. In the plugin › page **“Vehicles”** › **“Add account”**: email and password of your MySkoda account. The garage's vehicles appear after the sign-in; **“Sync”** fetches them at once.
2. To lock and unlock, enter the **S-PIN**. If Škoda refuses the S-PIN, the plugin blocks locking and unlocking until you enter the correct one – otherwise Škoda would lock the account.
3. **Assign owners** to each vehicle: these people see the vehicle in the portal and can control it after signing in.
4. **Settings › Plugins › Vehicles › Settings:** polling interval (minutes), “battery low” below … %, “not locked” after … minutes, purpose of new trips in the logbook (a fixed purpose = no question after each trip), notification language.

Password, S-PIN and session are stored encrypted and only used to sign in to Škoda.

## Using it

### Portal and app

- **Portal, tab “Vehicle”:** your vehicles with charge level, range and state. Control, location and departure times only after signing in, never through device trust alone.
- **App:** quick actions and widgets for climate, charging and locking of your vehicles.

### Logbook

- When the vehicle reports a new parking position and a higher mileage after a trip, the plugin records it: date, departure and arrival, start and destination address, mileage and distance. The departure time is as accurate as the polling interval.
- After each trip the owners get a notification with the buttons Private / Business / Commute. Occasion, business partner and driver are added in the logbook; start and destination can be corrected.
- **Map:** every trip is drawn on an OpenStreetMap map. Škoda only reports where the car parks – the plugin asks OpenStreetMap's routing service once per trip for the road route. If it finds no fitting route, the map shows a straight line (dashed).
- **Admin page “Logbook”:** all vehicles month by month with totals per purpose, edit, delete, trips by hand (e.g. without network).
- **Export** as PDF or CSV for one month or up to 24 months.
- In the portal (section “Logbook”) and in the Android app the owners sort their trips themselves.

## Permissions

- Administrators add accounts, assign owners and see all logbooks.
- Owners see their vehicle in the portal and the app, control it after signing in and sort their trips.
- People who are not owners do not see the vehicle. The server checks this again on every command.

## FAQ / troubleshooting

**“Login failed”.**
Usually the email or password is wrong. Check the sign-in in the MySkoda app and enter the correct password with “Change password” on the account.

**“Rate limited — next retry: …”.**
Škoda slows down too many requests. The plugin waits by itself; a longer polling interval helps.

**“S-PIN refused”.**
Enter the correct S-PIN via “S-PIN”. Until then locking and unlocking are blocked.

**A trip is missing from the logbook.**
Without a parking position the plugin detects no trip. When Škoda reports the position but no higher mileage yet, the logbook says it is parked at a new place and the trip will be recorded once the mileage arrives. Add missing trips by hand.

**The map only shows a dashed line.**
The mileage does not fit the calculated route (detour, stops), or the routing service found no route.

## New in 1.6.2

- **Less writing** when syncing with Škoda. On a slow disk (a NAS with hard disks) GateControl stays more responsive.

## New in 1.6.1

- This manual in the tab “Manual” (GateControl ≥ 1.241.0).

Last in 1.6.0: logbook with a map (page, portal and Android app) and the widget “Logbook” opens the logbook in the app.
