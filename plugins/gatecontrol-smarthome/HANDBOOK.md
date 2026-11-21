<!-- version: 1.12.0 -->
# Smart Home

## What the plugin does

- **Phoscon/deCONZ gateways** (e.g. ConBee or RaspBee): lights, plugs, groups, scenes, sensors and switches. On/off, brightness, colour, colour temperature, scenes.
- **Shelly and Tasmota** through a GateControl gateway in the home network (since 1.7.0): switches with power metering, dimmers, shutters, awnings and gates, temperature and humidity sensors – without a vendor cloud.
- **Bluetooth sensors** through a GateControl gateway (since 1.8.0): thermometers and sensors you took over in GateControl under radio – encrypted ones too, once their key is entered there.
- **Zigbee devices of zigbee2mqtt** through a GateControl gateway (since 1.9.0): lights, plugs, shutters, sensors and buttons you paired in GateControl under radio with zigbee2mqtt. Since 1.10.0 also switches with several channels, thermostats and firmware updates.
- **Owners and areas:** you assign devices to people. They use them in the portal “Home” and in the app.
- **Logic chains:** for deCONZ on the deCONZ gateway; for Shelly and Tasmota on the GateControl gateway (since 1.10.0) – since 1.11.0 with buttons, times, conditions with AND/OR, steps with waits, test run and log; since 1.12.0 with sunrise/sunset, “for X min”, zigbee2mqtt on the gateway, chains across several gateways (on the server), notifications and quick actions in the app.
- **Notifications:** alarm (water, smoke, CO), window open too long, battery low, gateway unreachable.
- **Quick actions and widgets** in the GateControl apps for your own devices.

## Requirements

- GateControl **1.228.1** or later.
- For deCONZ: a Phoscon/deCONZ gateway GateControl can reach (through a route, a VPN device or an address).
- For Shelly and Tasmota: a GateControl gateway **1.19.0** or later in the same home network, with the services `edge` and `mqtt` in its compose file.
- For Bluetooth sensors: a GateControl with radio (tab “Radio” of the gateway) and a gateway with Bluetooth.
- For zigbee2mqtt: a GateControl that knows zigbee2mqtt and a gateway newer than 1.30.0 with “zigbee2mqtt” in the tab “Radio” (edge and MQTT of the gateway are on for it). For several channels, thermostats and firmware updates: GateControl newer than 1.258.4 and a gateway newer than 1.34.2.

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

### Bluetooth sensors

1. In GateControl, in the gateway's tab **“Radio”**, pair the sensor and **take it over** (BTHome, Xiaomi with ATC/pvvx firmware, Shelly BLU).
2. The sensor shows in the plugin under the source “Radio (GateControl gateway)” with temperature, humidity and battery. When you give it back in GateControl, it disappears here.
3. If it sends encrypted data (BTHome with a key, Xiaomi stock firmware), enter its key in GateControl at the sensor – then its values arrive here too.

### Zigbee devices of zigbee2mqtt {#zigbee2mqtt}

1. In GateControl, in the gateway's tab **“Radio”**, choose **“zigbee2mqtt”** as the Zigbee service and pair the devices with **“Start pairing”**.
2. The devices show up in the plugin by themselves under the gateway's source “Radio (GateControl gateway)”: lights with brightness, colour and colour temperature, plugs and switches, shutters (up / stop / down), sensors and buttons.
3. Owners, area and name work as for the other devices. A name you give here stays; otherwise the name from zigbee2mqtt counts.
4. When you remove a device from the Zigbee network in GateControl, it is hidden here – its owners stay in case it comes back.
5. **Several channels:** a 2- or 3-gang switch shows as one card per channel (“channel 1”, “channel 2” …). Each channel has its own name, area and owners and is switched by itself.
6. **Thermostats:** the card shows the measured and the target temperature. Set the target with the slider and the mode (off, heat, auto) with the buttons below. Assigned people set the target in the portal with − and +.
7. **Firmware updates:** if a device takes updates over the air, its card says “Firmware” at the bottom. **“Check for an update”** asks zigbee2mqtt; if there is one, it says “Update available” with the button **“Update”**. An update takes 10 to 60 minutes, the card shows the progress. A battery device has to be awake for it – operate it once.

### Assigning and naming devices

- **“Manage owners”** (dialog “Assign owners”): which people may use a device, and its **area** (e.g. living room). The page and the portal group by area.
- In the same dialog you can rename lights and sensors. deCONZ devices are renamed in deCONZ itself, zigbee2mqtt devices and Bluetooth sensors here.
- For Shelly and Tasmota you also set, under **“Edit”**, the kind of each output (light, plug, switch; two outputs as a shutter, awning or gate).

### Settings

Under **Settings › Plugins › Smart Home › Settings**: polling interval (seconds), “window open” after … minutes (default 15), “battery low” below … % (default 15), notification language.

## Using it

- **Portal “Home”:** everyone sees the devices assigned to them – switch, dim, colour, scenes, shutters with up / stop / down. People without devices do not see the section.
- **App:** quick actions (home screen, quick settings, widget) for your own lights, plugs, groups and scenes, shutters with a position slider, power in the widget.
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

**Existing rules (up to 1.10)** keep running unchanged. The editor shows their triggers as **“becomes true: A and B”**; saved, they become a chain in the new format.

### Sun, “for X min”, other chains, notifications (since 1.12.0) {#logikketten-stufe-2}

- **Sunrise and sunset:** “+ Time / sun” fires at sunrise or sunset, with minutes before (−) or after. **“Time between”** knows the sun too, e.g. “Sunset–23:30”. The chain needs the **location of the gateway** for that: without one the editor shows a hint with two fields for latitude and longitude (rounded to 0.01°, about 1 km). Without a location “sun” never fires, and “time between” with the sun stays open. The test run shows the day's sun time, e.g. “Sunset (16:31)”.
- **“for X min”:** a state or value has to hold that long – as a trigger (“washing machine below 5 W for 3 min”) and as a condition (“floor lamp is off for 10 min”). If the value rises before, nothing happens. After a restart of the gateway the time starts again.
- **Contacts, motion, water** of zigbee2mqtt are triggers and conditions (“cellar door opens”, “motion detected”).
- **zigbee2mqtt on the gateway:** devices the gateway connects through zigbee2mqtt are part of this gateway's chains – lights, plugs (single channels too), shutters, sensors and remotes (as buttons). The chain switches them right on the gateway, without the server too. The edge part needs the new capability **`zigbee2mqtt/#`** for that: confirm it after the update under Gateways › your gateway › Edge plugins. Until then “Smart Home” is off on that gateway (“update waiting for confirmation”) – the other chains too.
- **Start another chain:** a step starts another chain of the same place. It checks its own “Only if”. Chains that start each other without “Only if” cannot be saved; with “Only if” there is a hint. A chain does not start itself, and four chains in a row is the end.
- **Send a notification:** a step sends a notification on the topic **“Logic chains”** (System › Notifications) – to everybody who subscribed, or only to the people ticked. The server sends it: a chain on a gateway keeps switching without the server, its notification comes once the gateway is connected again (up to an hour). The list then says “+ notification through the server”.

### Chains across several gateways (runs on the server) {#logikketten-server}

Choose **“Several gateways (through the server)”** as the place in the editor to connect devices of all gateways – deCONZ, Bluetooth and zigbee2mqtt sensors too. The box at the top turns yellow, the chain carries the yellow pill **“runs on the server”**. Such chains do not run offline: without the server or with a gateway disconnected nothing happens. They react with a delay of 2–3 seconds, deCONZ devices with the polling interval. Buttons only work in chains on their gateway. Test run, protocol, brake and loop check work as on a gateway. For the sun the server takes its own location or a gateway's.

### By hand (app): chains as quick actions {#logikketten-app}

The trigger **“+ By hand (app)”** makes a chain a quick action “Start” in the GateControl apps (e.g. “Good night”). Administrators may always start it; people of the portal only when you **release** it for them in the editor. “Only if” applies when started from the app too. The protocol shows the run as “from the app”.

## Permissions

- Administrators set up sources and devices and assign them.
- People only use devices assigned to them. The server checks this again on every action.
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

**After the update “Smart Home” is off on a gateway (“update waiting for confirmation”).**
1.12.0 needs the new capability `zigbee2mqtt/#`. Confirm it under Gateways › your gateway › Edge plugins – then every chain runs again.

**A Tasmota button does nothing.**
Tasmota reports buttons only with `SetOption73 1` (see [Logic chains](#logikketten-edge)).

**A chain is “stopped”.**
It ran more than 10 times in a minute – usually another chain switches the same device back. Check the chains, then “Start again”.

**“Check for an update” says “check failed”.**
The device is asleep (battery device: operate it once) or zigbee2mqtt cannot reach the update server – the gateway needs internet access for it.

**Automatic set-up fails.**
Set the device up “By hand …”. The instructions are in the window.

**A zigbee2mqtt device cannot be switched (“zigbee2mqtt on the gateway is not answering right now”).**
Look at the gateway's tab “Radio”: does zigbee2mqtt run, are edge and MQTT on? New devices show up within half a minute.

## New in 1.12.0

- **Logic chains, stage 2:** sunrise and sunset with an offset (location of the gateway), “for X min”, contacts and motion, steps “Start another chain” and “Send a notification” ([stage 2](#logikketten-stufe-2)).
- **zigbee2mqtt on the gateway** in the gateway's chains – works offline. After the update confirm the new capability `zigbee2mqtt/#` per gateway.
- **Chains across several gateways** run on the server, marked yellow ([runs on the server](#logikketten-server)).
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
