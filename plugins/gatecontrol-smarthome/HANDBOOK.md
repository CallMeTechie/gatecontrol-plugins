<!-- version: 1.19.0 -->
# Smart Home

## What the plugin does

- **Phoscon/deCONZ gateways** (e.g. ConBee or RaspBee): lights, plugs, groups, scenes, sensors and switches. On/off, brightness, colour, colour temperature, scenes.
- **Shelly and Tasmota** through a GateControl gateway in the home network (since 1.7.0): switches with power metering, dimmers, shutters, awnings and gates, temperature and humidity sensors – without a vendor cloud.
- **Bluetooth sensors** through a GateControl gateway (since 1.8.0): thermometers and sensors you took over in GateControl under radio – encrypted ones too, once their key is entered there.
- **Zigbee devices of zigbee2mqtt** through a GateControl gateway (since 1.9.0): lights, plugs, shutters, sensors and buttons you paired in GateControl under radio with zigbee2mqtt. Since 1.10.0 also switches with several channels, thermostats and firmware updates.
- **Owners and areas:** you assign devices to people. They use them in the portal “Home” and in the app.
- **Logic chains:** for deCONZ on the deCONZ gateway; for Shelly and Tasmota on the GateControl gateway (since 1.10.0) – since 1.11.0 with buttons, times, conditions with AND/OR, steps with waits, test run and log; since 1.12.0 with sunrise/sunset, “for X min”, chains across several gateways (on the server), notifications and quick actions in the app; since 1.15.0 with zigbee2mqtt devices on the gateway too, once an administrator confirmed it for the gateway.
- **Heating** (since 1.14.0): radiator thermostats of zigbee2mqtt, deCONZ and – since 1.17.0 – Shelly TRV and Shelly BLU TRV per room with presets, weekly plans, boost, “window open”, holiday and “Heating away” ([Heating](#heizung)). If all thermostats of a room hang on one gateway (Shelly TRV, BLU TRV, since 1.18.0 zigbee2mqtt too once confirmed), its plan runs there – also without the server.
- **Notifications:** alarm (water, smoke, CO), window open too long, battery low, gateway unreachable.
- **Quick actions and widgets** in the GateControl apps for your own devices – since 1.13.0 with the battery level of battery devices.

## Requirements

- GateControl **1.317.0** or later (since 1.15.0).
- For deCONZ: a Phoscon/deCONZ gateway GateControl can reach (through a route, a VPN device or an address).
- For Shelly and Tasmota: a GateControl gateway **1.19.0** or later in the same home network, with the services `edge` and `mqtt` in its compose file.
- For Bluetooth sensors: a GateControl with radio (tab “Radio” of the gateway) and a gateway with Bluetooth.
- For zigbee2mqtt: a GateControl that knows zigbee2mqtt and a gateway newer than 1.30.0 with “zigbee2mqtt” in the tab “Radio” (edge and MQTT of the gateway are on for it). For several channels, thermostats and firmware updates: GateControl newer than 1.258.4 and a gateway newer than 1.34.2. For boost, window and preset of zigbee2mqtt thermostats (since 1.19.0): a gateway from 1.47.0 and a GateControl that passes them on to plugins ([Boost, window and preset](#heizung-z2m-ext)).
- For zigbee2mqtt in logic chains on the gateway (since 1.15.0): from gateway 1.46.0, and the confirmation under **Gateways › gateway › Edge plugins** ([zigbee2mqtt on the gateway](#logikketten-z2m)).

## Setting up

### Connecting Phoscon/deCONZ

1. **Assign the access target:** **Settings › Plugins › Smart Home › Settings › Access targets** › assign your gateway to the target “Phoscon/deCONZ gateway” (route, VPN device or address). For several gateways, assign the target several times.
2. In **Phoscon** › Settings › Gateway › Advanced press **“Authenticate app”**. You then have 60 seconds.
3. In the plugin › **“Add source”** › **“Connect Phoscon”**: choose a name and the access target. Leave the **API key** empty – GateControl fetches the key itself. If you already have a key, you can enter it.
4. **“Test connection”** and **“Synchronize”**. Lights, plugs, groups, scenes, sensors and switches then show on the page.

The API key is stored encrypted.

### Shelly and Tasmota through a gateway {#shelly-tasmota}

1. **Check the compose file:** the gateway needs the services `edge` and `mqtt` (gateway 1.19.0 or later). If they are missing, the gateway page says “Edge service missing” with the button to download docker-compose.yml. Put the new file in place and build the project again. The Raspberry Pi image maintains its compose file itself.
2. **Switch MQTT on:** **Gateways** › your gateway › **MQTT**.
3. **Switch the edge part on:** **Gateways** › your gateway › **Edge plugins** › switch “Smart Home” on.
4. In the plugin › **“Add source”**: per gateway it shows whether the edge part runs and the MQTT broker is on.
5. **“Add device”:** the gateway searches the home network for Shelly and Tasmota devices. Pick one, enter a name and area and click **“Set up automatically”**. If the device has a password, GateControl asks for it once (it is not stored). GateControl creates an MQTT account of its own for the device, enters it in the device and restarts it.
6. Devices that are not listed (e.g. a sleeping Shelly H&T) are set up **“By hand …”**: GateControl shows server, user, password and prefix to copy and instructions per device type. You see the password only in this window.
7. **Another user name on the device:** when GateControl asks for the device password, the field “User name on the device” is above it (first-generation Shelly and Tasmota). The default is `admin`; if you gave the device another name, enter it here. GateControl keeps the name with the device, not the password. Later you change it under **“Edit” › Connection**. Shelly devices from the second generation on only know `admin`.

GateControl only changes the device's MQTT settings. Cloud, Wi-Fi and schedules stay as they are.

**Radiator thermostats (since 1.17.0):** set up a **Shelly TRV** like any Shelly device. A **Shelly BLU TRV** comes through a **Shelly BLU Gateway Gen3**: set up the BLU Gateway here and pair the BLU TRVs with it in the Shelly app – every paired TRV then shows up as a thermostat of its own. The thermostats are then under **Heating** ([Heating](#heizung)); you set their target there, not on the device card.

### Bluetooth sensors

1. In GateControl, in the gateway's tab **“Radio”**, pair the sensor and **take it over** (BTHome, Xiaomi with ATC/pvvx firmware, Shelly BLU).
2. The sensor shows in the plugin under the source “Radio (GateControl gateway)” with temperature, humidity and battery. When you give it back in GateControl, it disappears here.
3. If it sends encrypted data (BTHome with a key, Xiaomi stock firmware), enter its key in GateControl at the sensor – then its values arrive here too.

### Zigbee devices of zigbee2mqtt {#zigbee2mqtt}

1. In GateControl, in the gateway's tab **“Radio”**, choose **“zigbee2mqtt”** as the Zigbee service and pair the devices with **“Start pairing”**.
2. The devices show up in the plugin by themselves under the gateway's source “Radio (GateControl gateway)”: lights with brightness, colour and colour temperature, plugs and switches, shutters (up / stop / down), sensors and buttons.
3. Owners, area and name work as for the other devices. A name you give here stays; otherwise the name from zigbee2mqtt counts.
4. When you remove a device from the Zigbee network in GateControl, it is hidden here – its owners stay in case it comes back.
5. **Several channels:** a 2- or 3-gang switch shows as one card per channel (“channel 1”, “channel 2” …). Each channel has its own name, area and owners and is switched by itself. Since 1.13.0 you choose per channel under **“Manage owners” › Kind** what it stands for: light, plug or switch. That changes the icon, the words and the quick action of the apps, not the device; a channel is only switched on and off, never dimmed.
6. **Thermostats:** the card shows the measured and the target temperature. Set the target with the slider and the mode (off, heat, auto) with the buttons below. Assigned people set the target in the portal with − and +.
7. **Firmware updates:** if a device takes updates over the air, its card says “Firmware” at the bottom. **“Check for an update”** asks zigbee2mqtt; if there is one, it says “Update available” with the button **“Update”**. An update takes 10 to 60 minutes, the card shows the progress. A battery device has to be awake for it – operate it once.

### Assigning and naming devices

- **“Manage owners”** (dialog “Assign owners”): which people may use a device, and its **area** (e.g. living room). The page and the portal group by area.
- In the same dialog you can rename lights and sensors. deCONZ devices are renamed in deCONZ itself, zigbee2mqtt devices and Bluetooth sensors here.
- For Shelly and Tasmota you also set, under **“Edit”**, the kind of each output (light, plug, switch) – on a Shelly 2PM, Pro 4PM or a Tasmota with several relays for every output by itself. A pair as a shutter, awning or gate is only offered when the device itself runs in shutter mode. The kind decides the icon, the words and the quick action; in logic chains every output stays switchable, only a dimmer is dimmed.
- For zigbee2mqtt devices with several channels you choose the kind per channel in the dialog “Manage owners” ([zigbee2mqtt](#zigbee2mqtt)).

### Settings

Under **Settings › Plugins › Smart Home › Settings**: polling interval (seconds), “window open” after … minutes (default 15), “battery low” below … % (default 15), notification language.

## Using it

- **Portal “Home”:** everyone sees the devices assigned to them – switch, dim, colour, scenes, shutters with up / stop / down. People without devices do not see the section.
- **App:** quick actions (home screen, quick settings, widget) for your own lights, plugs, groups and scenes, shutters with a position slider, power in the widget. Since 1.13.0 battery devices show their battery as a small icon with the percentage beside the name – yellow from the setting “battery low”, red from 5 %. Sensors with a battery (Shelly H&T, Zigbee and Bluetooth sensors) come along as a card with their value; a sleeping Shelly H&T shows its last value and how old it is, after more than 26 hours without a report “Battery empty?”. The page and the portal show the same battery icon on the card.
- **Logic chains** (page “Logic chains”): the list shows all sources, grouped by place. Rules of a deCONZ gateway run on that gateway. Chains for Shelly and Tasmota run on the GateControl gateway the devices are connected to – see [Logic chains for Shelly and Tasmota](#logikketten-edge).
- **Rules of other plugins** (e.g. Family: “everyone out → lights off”) set exactly the state they ask for.

### Logic chains for Shelly and Tasmota {#logikketten-edge}

The page **“Logic chains”** first shows **all sources**, grouped by place. Each chain says where it runs: green **“runs on the gateway”** (Shelly and Tasmota, also without the server), blue **“runs on deCONZ”** (as before). At the top you choose a single source.

A chain has three parts:

1. **WHEN – one of these happens** (one event is enough): a **button** (button 1–4: short, double, triple, long), an output **turns on** or **off**, a shutter **opens** or **closes**, **power**, **temperature** or **humidity** rises above or falls below a value, a **time**.
2. **ONLY IF** (optional) – **all (AND)** or **one (OR)** of these conditions holds right now: a device is on/off/open/closed, a value is above/below, **time between** two times, **weekdays**.
3. **THEN – in order:** **Switch** (on, off, brightness, shutter open/close/stop/position) and **Wait** (seconds, minutes, hours; at most 24 hours per step). At most 20 steps.

Below, choose what happens when the chain is **triggered while it is still running**: start again (the wait begins anew – good for “light on for 3 minutes”), ignore, or ignore and **stop as soon as “Only if” no longer holds**.

**Buttons:** Shelly Gen1 (`input_event`) and Shelly Gen2 and later (Plus i4 and others) report presses by themselves. **Tasmota** reports them only with `SetOption73 1` – choose **“Report buttons as push buttons for logic chains”** in the automatic set-up or set it in the device's console. The button then no longer switches the relay itself.

**Check when saving:** if two chains would surely switch each other back and forth (A switches X off, B switches X on again, without “Only if”), the chain cannot be saved. A possible loop is shown as a hint, and so are other chains switching the same device.

**Brakes on the gateway:** if a chain runs more than 10 times in a minute, the gateway stops it. It is then shown with a red border and the reason; **“Start again”** switches it on again. A chain does not react to its own device's report for 2 seconds. At most 60 commands per minute leave a gateway.

**Test run:** “Test” on a chain (or “Test run” in the editor) shows whether the conditions hold right now – with the gateway's values. It switches nothing. **“Run anyway”** really switches and skips “Only if”; the log shows it as “by hand”.

**Log:** the last 200 runs per gateway – time, chain, trigger, result (done, skipped, partly, cancelled, stopped) and the course of a run. Runs while the server could not be reached come in later (“reported later”) once the gateway is connected again.

The chains run in the edge part on the gateway, also while the server cannot be reached. Times are in the server's time zone; the gateway keeps them itself. A gateway takes at most 40 chains. All devices of a chain must be on the same gateway.

### zigbee2mqtt on the gateway (since 1.15.0) {#logikketten-z2m}

zigbee2mqtt devices behind the same gateway – lights, plugs, switches with several channels, shutters, contacts, motion sensors, water sensors and remotes (as buttons) – can be part of a chain on the gateway too. They then run on the gateway like Shelly and Tasmota, without the server as well. Thermostats belong to the heating and are in no chain on the gateway ([Plan on the gateway](#heizung-gateway)).

- **Confirmation:** for this the edge part needs the MQTT topic `zigbee2mqtt/#` as well. It is an **optional capability**: Smart Home keeps running on every gateway without a new confirmation, only zigbee2mqtt in chains has to be released by an administrator per gateway – under **Gateways › gateway › Edge plugins › Additional permissions (optional)**.
- **When you save** a chain with a zigbee2mqtt device, Smart Home asks for that release (a note in the activity log, at most once a day). The chain is saved; the editor and the list show **“waiting for confirmation”** with the hint “For zigbee2mqtt please confirm it under Gateways › gateway › Edge plugins” and the button **“Open the gateway”**. Until then only these chains do not run – every other chain of the gateway goes on.
- **Once confirmed**, the gateway gets the chains within about half a minute and the hint goes away. If an administrator takes the release back, the chains wait again.
- **Older gateways** (before gateway 1.46.0) do not know optional capabilities yet and refuse `zigbee2mqtt/#`. The chain then shows the pill **“from gateway 1.46.0”** in the list; Shelly and Tasmota go on. After an update to gateway 1.46.0 or later it works by itself.
- The devices are found by the names zigbee2mqtt gives them (`zigbee2mqtt/bridge/devices`); renaming a device in zigbee2mqtt does not break the chains.
- With a GateControl before 1.317.0, zigbee2mqtt devices are only available in [chains on the server](#logikketten-server).

**Existing rules (up to 1.10)** keep running unchanged. The editor shows their triggers as **“becomes true: A and B”**; saved, they become a chain in the new format.

### Sun, “for X min”, other chains, notifications (since 1.12.0) {#logikketten-stufe-2}

- **Sunrise and sunset:** “+ Time / sun” fires at sunrise or sunset, with minutes before (−) or after. **“Time between”** knows the sun too, e.g. “Sunset–23:30”. The chain needs the **location of the gateway** for that: without one the editor shows a hint with two fields for latitude and longitude (rounded to 0.01°, about 1 km). Without a location “sun” never fires, and “time between” with the sun stays open. The test run shows the day's sun time, e.g. “Sunset (16:31)”.
- **“for X min”:** a state or value has to hold that long – as a trigger (“washing machine below 5 W for 3 min”) and as a condition (“floor lamp is off for 10 min”). If the value rises before, nothing happens. After a restart of the gateway the time starts again.
- **Contacts, motion, water** (zigbee2mqtt, deCONZ, Bluetooth) are triggers and conditions in chains on the server (“cellar door opens”, “motion detected”) – zigbee2mqtt since 1.15.0 on the gateway too ([zigbee2mqtt on the gateway](#logikketten-z2m)).
- **Start another chain:** a step starts another chain of the same place. It checks its own “Only if”. Chains that start each other without “Only if” cannot be saved; with “Only if” there is a hint. A chain does not start itself, and four chains in a row is the end.
- **Send a notification:** a step sends a notification on the topic **“Logic chains”** (System › Notifications) – to everybody who subscribed, or only to the people ticked. The server sends it: a chain on a gateway keeps switching without the server, its notification comes once the gateway is connected again (up to an hour). The list then says “+ notification through the server”.

### Chains across several gateways (runs on the server) {#logikketten-server}

Choose **“Several gateways (through the server)”** as the place in the editor to connect devices of all gateways – deCONZ and devices of zigbee2mqtt (lights, plugs, shutters, sensors) and Bluetooth sensors too. Since 1.15.0 the zigbee2mqtt devices of a gateway also go into chains on that gateway ([zigbee2mqtt on the gateway](#logikketten-z2m)); here you connect them with devices of other gateways. The box at the top turns yellow, the chain carries the yellow pill **“runs on the server”**. Such chains do not run offline: without the server or with a gateway disconnected nothing happens. They react with a delay of 2–3 seconds, deCONZ devices with the polling interval. Buttons only work in chains on their gateway. Test run, protocol, brake and loop check work as on a gateway. For the sun the server takes its own location or a gateway's.

### By hand (app): chains as quick actions {#logikketten-app}

The trigger **“+ By hand (app)”** makes a chain a quick action “Start” in the GateControl apps (e.g. “Good night”). Administrators may always start it; people of the portal only when you **release** it for them in the editor. “Only if” applies when started from the app too. The protocol shows the run as “from the app”.

## Heating {#heizung}

You find the heating under **Smart Home › Heating** (button at the top of the page). It controls the radiator thermostats of zigbee2mqtt, since 1.14.0 those of deCONZ too (target temperature and mode) and since 1.17.0 Shelly TRV and Shelly BLU TRV through a GateControl gateway ([Shelly and Tasmota](#shelly-tasmota)).

### Rooms

- A **room** is the **area** of its thermostats (dialog “Manage owners”). A thermostat without an area is a room of its own.
- All thermostats of a room get **one common target**. “Now” is the mean of the thermostats.
- Window contacts with the same area belong to the room.
- The overview shows per room the temperature, what applies now (the preset's colour; violet: by hand; red: boost; yellow border: window open or device unreachable) and today's plan. **“Open”** leads to the room page.

### Presets

- There are four fixed presets: **Comfort, Eco, Night, Frost protection** (default 21 / 18 / 17 / 7 °C).
- You set the temperatures of the house under **“Presets”**. A plan or a room may have its own; the room's come before the plan's.
- **Boost** is no preset but an action for 15, 30 or 60 minutes. If the thermostat can boost itself (deCONZ with a preset, Shelly TRV, since 1.19.0 zigbee2mqtt too – [Boost, window and preset](#heizung-z2m-ext)), GateControl uses that, otherwise it sets 30 °C (a BLU TRV too). Afterwards what applied before applies again. The status then reads “Boost (device)”.

### Weekly plan

1. **“New plan”** opens the editor. Enter a name, pick a template and the rooms the plan applies to. A room has exactly one plan.
2. Every weekday is a bar of sections. Tap a section and change **From**, **To** and **Preset**. Switching points snap to 15 minutes. **“Split section”** makes two sections of one, **“Copy day to …”** takes the day over for other days.
3. Under **Exceptions** you set “Window open” (after 1, 2 or 5 minutes) and “Nobody at home”.
4. **“Save plan”** – the plan sends what applies now at once.

The plan **runs on the server**: about every 30 seconds it checks every room and sends the target at each switching point. While the server is away the thermostats keep the last target; a missed switching point is caught up as soon as the server is back. If a thermostat does not answer, the plan tries again after 5 minutes; a sleeping battery device gets the value as soon as it is back.

If a thermostat has a **weekly plan of its own in the device** (mode “auto”, deCONZ preset “auto”, schedule on or the schedule of a Shelly TRV), the editor shows a hint. As soon as the plan sends, GateControl sets the device to “manual” or “heat”. The plan in the device is not deleted.

### Plan on the gateway (since 1.17.0) {#heizung-gateway}

If all thermostats of a room are Shelly TRV or BLU TRV of **the same gateway** (at most 8 per room, 24 rooms per gateway), the plan of that room runs **on the gateway**. The room page then shows “Plan runs on the gateway”.

**zigbee2mqtt thermostats (since 1.18.0)** count too – alone or together with Shelly TRV / BLU TRV of the same gateway – once an administrator confirmed the additional capability `zigbee2mqtt/#` for that gateway under **Gateways › gateway › Edge plugins** (the same as for [zigbee2mqtt on the gateway](#logikketten-z2m), from gateway 1.46.0). Without the confirmation the room stays on the server as before; after it the room moves to the gateway within a minute, without any target being sent twice. On the gateway the target goes straight to zigbee2mqtt (the field the thermostat offers), **Off** switches the thermostat off where it can (else frost protection), a plan of its own in the device (“auto”) is set to “heat”, **boost** sets 30 °C – since 1.19.0 the gateway uses the thermostat's own boost when zigbee2mqtt offers it with an on and an off value (`boost_heating` or `boost`).

- The gateway sets the thermostats at every switching point itself – also while the server cannot be reached and after a restart of the gateway.
- For these rooms **only the gateway** sends commands, never the server. What you change (plan, presets, by hand, boost, mode, holiday, “Heating away”) the server sends to the gateway as a new plan; the gateway applies it at once. When the server comes back after an outage, nothing is sent twice.
- A change by hand lasts until the next switching point on the gateway too, a boost until its end.
- **Window open** comes from the server (contacts of every source). While it is away, an open window counts on the gateway for at most 2 more hours, then the plan applies again.
- Without the server no new changes arrive; the room card shows “Sending” until the thermostat reports its new target. A thermostat that does not report its target after three tries is left alone until the next switching point – so turning its knob is not overwritten.
- Rooms with deCONZ thermostats, with thermostats on two gateways or with zigbee2mqtt not confirmed keep running on the server; a Shelly TRV in them gets its target through its gateway.

### Room page and operation

- **− / +** changes the target in half degrees, a **preset** sets its temperature. Both last **until the next switching point**; then the plan takes over again. **“Back to plan”** ends it earlier.
- **Operation:** **By plan**, **By hand** (the target applies for good, without switching points) or **Off** (mode “off” where the thermostat has it, else frost protection). Only an administrator changes the operation.
- **“Pause plan today”** keeps the current target until midnight.
- A room **without a plan** keeps its target; a change there lasts for good.
- Below are the room's devices with temperature, target, valve and battery.

What applies, top first: Off · window open · boost · change by hand · holiday · by hand · plan (with “Heating away”) · the target of a room without a plan.

### Window open

If a contact in the room stays open longer than set in the plan (default 2 minutes; without a plan always 2 minutes), the plan sets the room to **frost protection**. Once it is closed, what is due then applies again. The thermostat's own window detection stays on. The notification “Window left open” then reads **“Window open, heating turned down”**.

### Boost, window and preset of zigbee2mqtt thermostats (since 1.19.0) {#heizung-z2m-ext}

If the GateControl gateway (from 1.47.0) reports boost, window and preset of its zigbee2mqtt thermostats, the heating uses them – only for thermostats that can do so according to zigbee2mqtt:

- **Boost** with the thermostat's own boost instead of 30 °C. If the device names the unit of its boost time (seconds or minutes), GateControl sets the length too; otherwise the length set in the device applies. At the end GateControl switches the boost off and sends the target that applies then.
- **Window open** reported by the thermostat itself (e.g. its window detection or a contact wired to it) counts like a window contact of the room – with the same rules (minutes from the plan, frost protection, on the gateway at most 2 hours without the server). The room page shows “Window open (device)” at the thermostat.
- The **preset in the device** (e.g. “manual”, “schedule”) is shown at the thermostat on the room page. The plan does not change it.

If the gateway does not report them (an older gateway or a GateControl that does not pass them on yet), everything stays as in 1.18.0.

### Holiday and Heating away

- **“Plan a holiday”:** start, return, a preset for all rooms (default Eco) and a different one per room. The holiday comes before the plans. **Preheat** (default 4 hours): this long before the return the plans apply again, so it is warm. After the return the holiday goes away by itself.
- **“Heating away”** (switch at the top, and a quick action for administrators in the app): Comfort becomes Eco in every room whose plan allows “Nobody at home”. The Family rules “Everybody away” / “First person comes home” can switch it when you choose the quick action there.

### Who may do what

- **Administrators:** everything – plans, presets of the house, holiday, operation, upper limits.
- **Assigned persons** (who has a thermostat of the room assigned) see the room in the portal “Home” and in the app and change target, preset and boost there.
- Under **“Room settings”** you set an **upper limit** (e.g. children's room at most 22 °C). It applies to assigned persons in the portal and in the app (the control goes no higher); boost is not available to them in that room then.

### In the app

Every room is a card: temperature, valve, window, humidity and battery, below the plan as text (“Comfort · by plan until 08:00, then Eco 18.0 °C”), the target with − / + in half degrees, the four presets and a day bar with today's plan (a colour per preset, a mark for now). Beside it the buttons **Boost 30 min** / **End boost** and **Back to plan** when they make sense. While no preset applies (boost, by hand, window open, off), none of the four is highlighted; the text says what applies. With a window open, no thermostat answering or the room off, target and presets stay visible but locked (grey) – the text says why.

## Permissions

- Administrators set up sources and devices and assign them.
- People only use devices assigned to them. The server checks this again on every action.
- Heating: assigned persons change target, preset and boost in their rooms (up to the room's upper limit); plans, presets of the house, holiday and operation only administrators ([Heating](#heizung)).
- “Window open” goes to the people the sensor is assigned to. Alarm, battery and gateway follow the topic's rule in GateControl's notification settings.

## FAQ / troubleshooting

**“Phoscon link window expired”.**
Press “Authenticate app” in Phoscon again and connect within 60 seconds.

**“No gateway with the edge part of “Smart Home” yet”.**
Switch it on under Gateways › your gateway › Edge plugins ([Shelly and Tasmota](#shelly-tasmota)).

**“Edge service missing” or “Edge container not running”.**
The gateway's compose file is too old or the container is stopped. The gateway page shows what to do.

**“MQTT broker is off”.**
Switch MQTT on under Gateways › your gateway › MQTT. The edge part then connects by itself.

**A Shelly or Tasmota is “unreachable”.**
The device signed off or has not reported for 30 minutes. Check power and Wi-Fi.

**A Shelly H&T says “asleep”.**
That is as it should be: battery devices only wake up every few hours or when the value changes. The card shows the last value and when it came. If the device stays silent for more than 26 hours, the card asks “Battery empty?”. Below the value of the setting “Battery low” (default 15 %) the card shows a hint.

**A chain for Shelly or Tasmota does not fire.**
If the gateway says “not connected”, changes only arrive once it is back. With MQTT off on the gateway the chain cannot switch. A state only triggers on a change: if it already holds when you create the chain, it waits for the next time. The **test run** and the **log** show which condition does not hold.

**A chain with the sun never fires.**
The editor misses the location of the gateway (hint under WHEN). Enter latitude and longitude ([sun](#logikketten-stufe-2)).

**A Tasmota button does nothing.**
Tasmota reports buttons only with `SetOption73 1` (see [Logic chains](#logikketten-edge)).

**A chain is “stopped”.**
It ran more than 10 times in a minute – usually another chain switches the same device back. Check the chains, then “Start again”.

**“Check for an update” says “check failed”.**
The device is asleep (battery device: operate it once) or zigbee2mqtt cannot reach the update server – the gateway needs internet access for it.

**Automatic set-up fails.**
Set the device up “By hand …”. The instructions are in the window.

**A chain with zigbee2mqtt on the gateway does not run (“waiting for confirmation” / “from gateway 1.46.0”).**
“Waiting for confirmation”: an administrator releases the additional capability `zigbee2mqtt/#` under **Gateways › gateway › Edge plugins**. “From gateway 1.46.0”: update the gateway – zigbee2mqtt in chains on the gateway works from gateway 1.46.0 ([zigbee2mqtt on the gateway](#logikketten-z2m)).

**A zigbee2mqtt device cannot be switched (“zigbee2mqtt on the gateway is not answering right now”).**
Look at the gateway's tab “Radio”: does zigbee2mqtt run, are edge and MQTT on? New devices show up within half a minute.

## New in 1.19.0

- **zigbee2mqtt thermostats with boost, window and preset:** boost with the device's own boost, “window open” from the device like a window contact, the device's preset on the room page – with a gateway from 1.47.0 ([Boost, window and preset](#heizung-z2m-ext)). Without it everything stays as before.
- In the plan on the gateway the gateway uses the boost of a zigbee2mqtt thermostat when zigbee2mqtt offers it; otherwise 30 °C as before.
- The note “zigbee2mqtt is not available on the gateway yet” names the heating too. The update needs no new confirmation.

## New in 1.18.0

- **zigbee2mqtt thermostats in the plan on the gateway:** if all thermostats of a room hang on the same gateway (zigbee2mqtt and/or Shelly TRV / BLU TRV), its weekly plan runs there – also without the server ([Plan on the gateway](#heizung-gateway)).
- zigbee2mqtt needs `zigbee2mqtt/#` confirmed on the gateway (as for logic chains); without it everything stays on the server as before. Otherwise the update needs no new confirmation.

## New in 1.17.0

- **Shelly TRV and Shelly BLU TRV** (through a Shelly BLU Gateway Gen3) are thermostats of the heating ([Shelly and Tasmota](#shelly-tasmota)).
- **Plan on the gateway:** if all thermostats of a room hang on one gateway, its weekly plan runs there – also without the server ([Plan on the gateway](#heizung-gateway)).
- The update needs no new confirmation on the gateway: Smart Home uses `shellies/#` for it, which is already granted.

## New in 1.16.0

- **Heating in the app:** every room card shows a **day bar** with today's plan.
- With a window open or no thermostat answering, target and presets are **locked** (grey) instead of hidden; the card says why.
- While no preset applies (boost, by hand), none is highlighted – the fifth button (“Boost”, “By hand”) is gone.
- Needs GateControl 1.317.1 and a current app. The update needs no new confirmation on the gateway.

## New in 1.15.0

- **zigbee2mqtt in chains on the gateway:** lights, plugs, shutters, contacts, motion, water and remotes of zigbee2mqtt run in chains on the gateway – without the server too ([zigbee2mqtt on the gateway](#logikketten-z2m)).
- For this an administrator confirms the optional capability `zigbee2mqtt/#` per gateway; Smart Home asks for it when you save. Until then only these chains do not run.
- The update needs no new confirmation on the gateway: Shelly, Tasmota, the existing chains and the heating keep running without a break. It needs GateControl 1.317.0.

## New in 1.14.0

- **Heating:** rooms from the areas of the thermostats, four presets, weekly plans, boost, “window open”, holiday with preheating and “Heating away”; the plan runs on the server ([Heating](#heizung)).
- **deCONZ thermostats** can now be controlled (target and mode), not only shown.
- **In the app** every room is a card with temperature, target in half degrees, presets, boost and “Back to plan”; administrators switch “Heating away” there.
- The notification about an open window reads “Window open, heating turned down” when the heating turned the room down.
- The update needs no new confirmation on the gateway.

## New in 1.13.0

- **Battery level in the apps:** battery devices show a battery icon with the percentage in quick actions and widgets, yellow from “battery low”, red from 5 %; sensors with a battery appear as a card. The Shelly H&T shows its last value with its age. The page and the portal show a small battery icon on the card; deCONZ sensors now report their battery too.
- **Kind per channel** for zigbee2mqtt devices with several channels too (light, plug, switch). Shelly and Tasmota had the kind per output already.
- **User name on the device** for first-generation Shelly and Tasmota exists since 1.10.0 ([Shelly and Tasmota](#shelly-tasmota)) – the device password is still used for that one step only and never stored.
- The update needs no new confirmation on the gateway.

## New in 1.12.0

- **Logic chains, stage 2:** sunrise and sunset with an offset (location of the gateway), “for X min”, contacts and motion, steps “Start another chain” and “Send a notification” ([stage 2](#logikketten-stufe-2)).
- **Chains across several gateways** – with deCONZ and zigbee2mqtt too – run on the server, marked yellow ([runs on the server](#logikketten-server)).
- The update needs no new confirmation on the gateway: Shelly, Tasmota and the chains of 1.11 keep running without a break.
- **By hand (app):** chains as quick actions in the apps; for people of the portal only when released ([quick action](#logikketten-app)).

## New in 1.11.0

- **Logic chains, stage 1** (Shelly and Tasmota on the GateControl gateway): buttons, times, conditions with AND/OR, steps in order with waits, test run, log, protection against loops. The list shows all sources at a glance ([Logic chains](#logikketten-edge)).
- When setting up a Tasmota automatically you can have its buttons reported as push buttons (`SetOption73`).

## New in 1.10.0

- **Logic chains for Shelly and Tasmota:** triggers, conditions and actions as for deCONZ – they run on the GateControl gateway ([Logic chains for Shelly and Tasmota](#logikketten-edge)).
- **Shelly H&T and other battery devices** say “asleep – last report …” instead of “unreachable”, with a hint when the battery is low.
- **User name on the device:** for first-generation Shelly and Tasmota you can set another name than `admin` ([Shelly and Tasmota](#shelly-tasmota)).
- **zigbee2mqtt:** switches with several channels, thermostats and firmware updates ([zigbee2mqtt](#zigbee2mqtt)). This needs GateControl newer than 1.258.4 and a gateway newer than 1.34.2.
- Dialogs now appear in the visible part of the page, even when you are far down.

## New in 1.9.1

- **Less writing:** Smart Home only stores devices when their state changed. “Last seen” of a gateway is accurate to the minute. On a slow disk (a NAS with hard disks) GateControl stays more responsive.

## New in 1.9.0

- **Zigbee devices of zigbee2mqtt** through a GateControl gateway – switched and assigned like the other devices ([zigbee2mqtt](#zigbee2mqtt)).
- Encrypted Bluetooth sensors deliver values once their key is entered in GateControl.

Last in 1.8.1: this manual in the tab “Manual”; in 1.8.0: Bluetooth sensors through a GateControl gateway.
