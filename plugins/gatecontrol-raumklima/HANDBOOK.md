<!-- version: 2.2.4 -->
# Indoor climate

## What the plugin does

- Control **Midea air conditioners** – through the Midea cloud (account of the MSmartHome or NetHome Plus app) or directly in the home network (protocol V2 and V3): on/off, target temperature, mode, fan speed, turbo, eco; indoor and outdoor temperature.
- **Dreo heaters and air conditioners** through the Dreo cloud with a live connection: commands arrive at once, changes on the device show at once.
- **Owners:** you assign devices to people. They control them in the portal “Home” and in the app.
- **Notifications:** device unreachable, clean filter, malfunction of the air conditioner.
- **GateControl apps:** quick actions and a widget per device (indoor temperature, target temperature, mode).

Until 1.6.0 the plugin was called `gatecontrol-midea` (“Klimaanlage”). Version 2.0.0 replaced it and took everything over.

## Requirements

- GateControl **1.185.0** or later.
- For the Midea cloud: your Midea app account (MSmartHome or NetHome Plus).
- For Midea in the home network: GateControl must reach the device (its home address through an access target). Devices with protocol V3 also need the Midea account for their key.
- For Dreo: your Dreo account with **email and password**. If you sign in to the Dreo app with Apple or Google, the email account has no devices.

## Setting up

### Step 1: enter the accounts

**Settings › Plugins › Indoor climate › Settings** (or “Accounts” on the plugin page):

- **Midea:** app, email, password.
- **Dreo:** email, password. Only a checksum of the Dreo password is kept.

Saving signs in at once. Per account a status line says “Connected as …” or shows the error.

### Step 2: add devices

- **Dreo:** the account's heaters and air conditioners appear on the page by themselves – right after saving and then every hour. By hand: “Add device” › “Dreo”.
- **Midea cloud:** **“Add device”** › “Midea cloud” › choose the account's air conditioners.
- **Midea in the home network:**
  1. **“Discover devices”** searches the home network for air conditioners.
  2. Assign the device's address to the target “Air conditioner (home network)” under **Settings › Plugins › Indoor climate › access targets**.
  3. **“Add device”** › “Home network” › choose the access target, a name and – for V3 devices – the matching cloud device for the key.

### Step 3: set the owners

On each device **“Manage owners”**: the people listed see and control the device in the portal and the app. New devices are visible to administrators only at first.

## Using it

- **Portal “Home”, section “Indoor climate”:** your devices with temperature and state. Controlling needs a sign-in.
- **App:** per device you own an on/off toggle with a widget – indoor and outdoor temperature, sliders for target temperature and mode. Rules of other plugins (e.g. Family) set exactly the state they ask for.
- **Plugin page (admin):** all devices, account status, discover, add, edit (name, access target, active).

**Dreo heaters** offer, depending on the model, heat levels, eco with a thermostat (5–35 °C), fan, oscillation, child lock, key sound and window detection; **Dreo air conditioners** cool, dry, fan, sleep, eco, target temperature 16–30 °C, fan speed and swing.

## Permissions

- Administrators set up accounts and devices and choose the owners.
- People only control devices they own. The server checks this again on every command.
- Notifications go to a device's owners; without owners the topic's rule in GateControl's notification settings decides.

## FAQ / troubleshooting

**The Dreo account says there is no device in it.**
Is the device linked in the Dreo app to exactly this account? With an Apple or Google sign-in the email account has no devices. The plugin log shows what was asked.

**A Dreo heater does not respond.**
Dreo heaters lock remote control after 24 hours without use. Press the Wi-Fi button on the device once.

**“The Midea account needs to be confirmed again”.**
Confirm it in the Midea app and save the plugin settings again.

**“GateControl no longer signs in to the account by itself” / notification “Connect account again”.**
The maker's cloud refused the session repeatedly. So that the maker does not flood you with sign-in notices or lock the account, the plugin signs in by itself at most 3 times an hour and 6 times a day and then stops. Open the plugin settings and save them again – that connects the account anew. If that does not help, the plugin log shows the cloud's code.

**Midea keeps reporting a “new sign-in”.**
From 2.2.4 the plugin only signs in when the session really has expired. The Midea app and GateControl can still sign each other out when both use the same account – a Midea account of its own for GateControl, with which you share the devices in the Midea app, helps then.

**A discovered Midea device is unreachable.**
Its address must be assigned under access targets as “Air conditioner (home network)”.

**Cloud devices report no malfunction.**
Notifications only come from devices in the home network that the plugin polls (and from Dreo devices for “unreachable”).

## New in 2.2.4

- The plugin no longer signs in again on every error of the cloud. It signs in only when the session really has expired – at most 3 times an hour and 6 times a day, with a growing wait (1, 5, 15, 60 minutes).
- When the limit is reached, the password is wrong or a confirmation is needed, “connect again” appears and you get a notification (topic “Connect account again”). Saving the settings again connects anew.
- On “too many requests” the cloud calls pause (5, 15, 60 minutes).

Last in 2.2.3: this manual in the tab “Manual” (GateControl ≥ 1.241.0).
