# Smart Home (gatecontrol-smarthome)

Phoscon/deCONZ-Integration als GateControl-Plugin – bisher fest in GateControl eingebaut; seit 1.7.0 auch Shelly und
Tasmota über ein GateControl-Gateway.

## 1.21.0

- **Tuya Stufe 1 – WLAN-Geräte lokal** (freigegebener Entwurf „Tuya lokal“, Fragen 60–69 jeweils Variante a). Steckdosen/Leisten (`cz`, `pc`), Schalter (`kg`, `tdq`), Lampen und LED-Streifen (`dj`, `dd`, `fwd`, `dc`, `xdd`) über das GateControl-Gateway, ohne Tuya-Cloud im Betrieb.
  - **Edge-Teil** `edge/tuya.js` (neu): Protokolle 3.1 (MD5-Signatur, AES-ECB), 3.2/3.3 (Versionskopf, AES-ECB, CRC32), 3.4 (Sitzungsschlüssel, HMAC-SHA256) und 3.5 (6699-Rahmen, AES-GCM); „device22“ (3.3, DP_QUERY → CONTROL_NEW). Eine TCP-Verbindung je Gerät (`gc.lan.tcp`, Port 6668), Heartbeat 10 s, Abbruch nach 35 s Stille, Wiederverbinden 2 s … 60 s; alle 10 min eine Abfrage aller Datenpunkte. Scan über UDP 6666/6667/7000 (Broadcast-Anfrage an 7000 für 3.5-Geräte, `gc.lan.udp.send` mit `udp.broadcast`); ein Gerät ohne feste IP folgt einer neuen Adresse. Drei Fehlversuche „wie falscher Key“ bei per Scan sichtbarem Gerät (bzw. eine nicht passende Sitzungsprüfung) → `key`, danach nur alle 10 min. Datenpunkte ↔ Kanäle `switch:<n>` (Leistung `cur_power`) und `light:0` (Helligkeit, Weißton als Mired, Farbe H/S, Szenen) über ein Profil je Gerät.
  - `edge/index.js`: Konfiguration `tuya` [{ id, key, ip?, hint?, ver?, p }] (Keys mit `gc.store` `tuya` gehalten – Frage 62a), Basis `tuya/<id>`, Familie `tuya`; Befehle ohne MQTT (`commands` liefert `{ tuya }`, auch in Logikketten und für `gc.handle('command')`), neue Handler `tuya.scan` und `tuya.status`, `info.tuya`. Grenze: Verbindungen des Gateways − 4 (64 ab Gateway 1.49.0 → 60).
  - **Server-Teil** `server/tuya.js` (neu): Import aus der Tuya-Cloud (signierte OpenAPI-Anfragen, Regionen als `permissions.network.internet`, Geräteliste `iot-01/associated-users/devices`, Datenpunkte über `shadow/properties` und `specification`), aus devices.json (tinytuya) oder von Hand; Profile aus dem Mapping, der Kategorie oder dem ersten Status (Art `auto`); Hub (`wg2`) und Untergeräte nur angezeigt (Stufe 2), unbekannte Geräte mit wählbarem Ein/Aus-Datenpunkt als Schalter (Frage 65a). Keys nur als Secrets `tuya.key.<id>`, Zugang als `tuya.cloud` (abwählbar, Frage 66a); nie an den Browser. Optionale Rechte `tcp.lan`, `udp.port:6666/6667/7000`, `udp.broadcast` werden mit `gc.edge.requestCapability` angefragt. „Key passt nicht mehr“: eine Mitteilung je Gerät (Thema `gateway_unreachable`), „Key neu holen“ (Cloud, devices.json, von Hand).
  - Routen `/edge/tuya/status|request|import|scan|add|cloud`, `POST /edge/devices/:id/tuya_key`, `PUT /edge/devices/:id { tuya: { ip, dp } }`.
  - **Seite:** Assistent „Tuya-Geräte hinzufügen“ (`ui/tuya.js`, drei Schritte wie im Entwurf), Karten mit „Key passt nicht mehr“, „Rechte fehlen“, „Nicht unterstützt“, Tuya-Teil im Gerätedialog (feste IP, Key neu holen, Schalter-Datenpunkt).
  - **Widgets:** Farblampen (Tuya, deCONZ, zigbee2mqtt) bekommen Weißton (Kelvin) und acht feste Farben als Bedienelemente, Tuya-Lampen ihre Szenen (Frage 64a); nicht erreichbare Edge-Geräte (und „Key passt nicht mehr“) sperren die Bedienelemente (`disabled`). Portal: `ct`/`color` auch für Edge-Lampen.
- **Manifest:** `edge.optionalCapabilities` um `tcp { lan }` und `udp { ports: [6666, 6667, 7000], broadcast }` ergänzt (kein `update_pending`), `edge.minGateway` **1.49.0** (Gateways 1.46–1.48 lehnen ein Paket mit tcp/udp in `optionalCapabilities` ganz ab – **Gateway zuerst aktualisieren**), `gatecontrol` **>=1.326.0**, `permissions.network.internet` mit den sechs Regionen der Tuya-OpenAPI (das Update fragt einmal nach Zustimmung). `gatecontrol.ref` auf v1.326.0.
- Mock-Host: optionale `tcp.lan`/`udp.port:<n>`/`udp.broadcast`, `gatewaySupported`/`unsupported`.
- Tests: `tuya_protocol` (Rahmen, CRC/HMAC/GCM, 3.1-Signatur, Broadcasts, Datenpunkte, Verbindungen 3.1/3.3/3.4/3.5 gegen ein unabhängig geschriebenes Testgerät, falscher Key, device22), `tuya_edge`, `tuya_server` – nur selbst erzeugte Keys.
- Offen: Tuya-Zigbee-Hub (Stufe 2), Energie (`add_ele`) und Strom/Spannung werden noch nicht gezeigt; die Szenen-Werte sind die Standardszenen der Tuya-App und an echten Lampen noch zu prüfen.

## 1.20.0

- **Bug: Bereich umbenennen verlor den Heizplan.** Ein Raum war an den Namen seines Bereichs gebunden (`heat_rooms.room_key 'a:<Bereich>'`); nach dem Umbenennen bekam der neue Name eine neue, leere Zeile, Plan, Betrieb und eigene Temperaturen blieben an der alten hängen. Jetzt merkt sich jede Zeile ihre Thermostate (`members_json`, Migration `007_heating_ext.sql`; vorher aus `applied_json.done` bzw. `t:<id>`); ein Bereich, der weg ist, gibt seine Zeile an den Bereich, in dem seine Thermostate jetzt sind (auch wenn sie einzeln umziehen: eine inzwischen angelegte, nicht eingerichtete Zeile weicht). Die Raum-ID bleibt (Portal, Apps, Urlaub).
- **Feiertage wie Sonntag** (freigegebener Entwurf „Thermostate“): neu `server/holidays.js` (Ostern nach Meeus/Jones/Butcher, Feiertage je Bundesland, Bundesland aus dem Standort der Logikketten). Schalter je Plan (`heat_plans.holidays`, Standard an; Plan-Dialog „Ausnahmen“), Einstellung `heat_region` (auto | DE | Bundesland). `presetAt`/`changesOf`/`slotStart`/`todayOf` laufen an Feiertagen den Sonntag. Am Gateway: `heat.hol` (Daten dieses und des nächsten Jahres) und `room.hol`, `edge/heat.js planAt` nimmt sie.
- **Versatz je Thermostat** (`heat_thermostats`, −5…+5 °C, halbe Grad): `PUT /heating/rooms/:id { offsets: { <id>: n | null } }`, Feld im Raum-Dialog. Anzeige (`thermostats[].value/setpoint`) korrigiert, Befehle `Soll − Versatz` (Server, Gateway `th.off`). zigbee2mqtt-Thermostate am Gateway mit setzbarem `local_temperature_calibration` (Exposes) bekommen den Versatz als Kalibrierung (`commands` Op `calibration`, `normalize` liest `cal`); Event `cal` meldet dem Server, was sie melden – dann rechnet er nichts mehr ein (`thermostats[].calibrated`).
- **Boost-Temperatur einstellbar** (Einstellung `heat_boost`, 20–30 °C, Standard 30) für Thermostate ohne eigenen Boost, am Server und am Gateway (`heat.bt`); Hinweistexte nennen den Wert.
- **Fensterkontakte am Gateway** (GateControl-Gateway mit Kennung `radio-contacts`, gatecontrol-gateway#77): neue optionale Fähigkeit `gatecontrol/contacts/#` (der Server fragt einmal je Gateway danach). Ist sie bestätigt, bekommt ein Raum am Gateway die Kontakte, die das Gateway selbst hört (Bluetooth `ble:<MAC>`, zigbee2mqtt `z2m:<IEEE>` desselben Gateways) als `ct` mit der Wartezeit `wm`; `edge/index.js` abonniert `gatecontrol/contacts/#` nur dann, `edge/heat.js` senkt nach der Wartezeit selbst (offen zählt 2 h nach der letzten Meldung, offline nicht). Event `contacts` (`ok` sobald das Gateway liefert, `none`, `denied`, `error`, `off`); mit `ok` und ohne andere Fensterquelle schickt der Server kein `win` mehr für den Raum. Ohne neues Gateway oder Bestätigung: wie 1.19.0.
- `edge.capabilities` und `gatecontrol` unverändert; `edge.optionalCapabilities` um `gatecontrol/contacts/#` ergänzt (optional, kein `update_pending`).
- Offen: zigbee2mqtt-Räume am Server bekommen den Versatz als Soll-Korrektur, nicht als Gerätekalibrierung (GateControl reicht `local_temperature_calibration` noch nicht durch). Shelly TRV / BLU TRV: Korrektur über das Soll.

## 1.19.0

- **zigbee2mqtt-Thermostate mit Preset, Boost und Fenster** (GateControl-Gateway 1.47.0, gatecontrol-gateway#75,
  Kennung `z2m-thermostat-ext`). Alles nur, wenn das Gateway die Kennung meldet und die caps des Geräts das Feld nennen
  – sonst wie 1.18.0.
  - **Server-Teil:** `server/zigbee.js` liest die Kennung aus `gc.radio.zigbee().gateways[].capabilities` (oder
    `.features`) und übernimmt dann für Thermostate `caps.boost` → `capabilities.boost` / `state.boost`, `caps.boostTime`
    → `capabilities.boost_time { min, max, step, unit }`, `caps.windowOpen` / `caps.windowDetection` →
    `capabilities.window_open` / `state.window_open`, `caps.presets` → `capabilities.presets`, `values.preset` →
    `state.preset`; `setState` schickt `boost` und – nur zusammen mit `boost: true` – `boost_time` (auf Grenzen und
    Schritt). Ohne Kennung kommt auch ein `caps.boost` nicht mehr in die Ressource (bisher vorweggenommen seit 1.14.0).
  - **Heizung am Server:** Boost über den Boost des Geräts (`{ boost: true }`, mit `boost_time` in der Einheit des
    Geräts, wenn es `s` oder `min` nennt), danach `{ setpoint, boost: false }`; „Aus“ nach einem Boost schaltet ihn mit
    aus. `window_open: true` eines Thermostats zählt wie ein Fensterkontakt des Raums (gleiche Regeln: Einstellung des
    Plans, 1 / 2 / 5 min, Frostschutz, `ttl` 2 h am Gateway). Raumansicht: `thermostats[].device_preset`, `.window_open`,
    `window.devices`, `boost.device`; Status „Boost (Gerät)“ (de/en), wenn jedes erreichbare Thermostat selbst boostet.
    „Wird übertragen“ für zigbee2mqtt-Thermostate am Gateway während eines Boosts: erledigt, sobald das Gerät seinen
    Boost oder 30 °C meldet; ohne Kennung weiß der Server nicht, welchen Weg das Gateway nimmt, und zählt es nicht.
  - **Plan am Gateway:** `edge/index.js` liest aus den Exposes (`zigbee2mqtt/bridge/devices`) einen setzbaren binären
    Boost (`boost_heating` vor `boost`) mit `value_on` und `value_off`; dann schickt `edge/heat.js` `{ <prop>: value_on }`
    statt 30 °C und am Ende `{ <prop>: value_off }` mit dem Soll (erledigt, sobald das Gerät es meldet; ein schon
    laufender Boost wird nicht noch einmal geschickt). Fehlt etwas davon: 30 °C wie bisher. `commands` kennt für
    zigbee2mqtt-Thermostate `boost` (mit `prop`, `on`, `off`), `normalize` liest den gemeldeten Boost.
  - **Seiten:** nur vorhandene Elemente – Status-Text / Hinweis „Boost (Gerät)“, beim Thermostat „Preset am Gerät“,
    „Fenster offen (Gerät)“ und die Fensterregel; die Fenster-Anzeige der App-Karte auch für Geräte-Fenster.
- Die Warnung bei „zigbee2mqtt abgelehnt“ (Log und Hinweis `chain.z2m_unavailable` de/en) nennt auch die Heizung.
- `edge.capabilities`, `edge.optionalCapabilities` und `gatecontrol` unverändert – kein `update_pending`.
  Hinweis: GateControl reicht die neuen Felder und die Kennung heute noch nicht an Plugins durch (`homeRadio.js`
  `cleanZigbeeCaps` / `cleanZigbeeValues` / `cleanCommand`, `pluginZigbee().gateways`); bis dahin gilt am Server
  1.18.0, der Boost am Gateway (Exposes) wirkt schon.

## 1.18.0

- **zigbee2mqtt-Thermostate im Plan am Gateway** (Fortsetzung von 1.17.0, gleiche Entscheidungen: Zuständigkeit Gateway vs.
  Server, `gc.store`, Bestätigung über das gemeldete Soll, höchstens 3 Versuche, Fenster-Gültigkeit 2 h, ≤ 8 Thermostate
  je Raum, ≤ 24 Räume je Gateway).
  - **Zuständigkeit:** Ein Raum, dessen Thermostate alle am selben Gateway hängen – Shelly/BLU TRV und/oder
    zigbee2mqtt-Thermostate dieses Gateways (`capabilities.gateway_id`) –, läuft am Gateway, zigbee2mqtt aber nur, wenn
    die optionale Fähigkeit `mqtt.topic:zigbee2mqtt/#` für das Gateway bestätigt ist (`gc.edge.capabilities`, je
    Gateway höchstens einmal pro Minute gefragt) und das Gateway das Topic nicht ablehnt (Ereignis `z2m` `denied` → Raum
    zurück an den Server; nach `$started` wird neu gefragt). Ohne Bestätigung, mit deCONZ oder mit Thermostaten an zwei
    Gateways bleibt der Raum am Server wie bisher. Die Heizung fragt die Fähigkeit nicht an (das tun nur die Ketten).
  - **Übergabe** wie 1.17.0: ab dem Wechsel schickt der Server dem Raum nichts mehr; das Gateway schickt nur, was ein
    Thermostat noch nicht meldet – ein Soll, das der Server schon geschickt hat, geht nicht noch einmal hinaus. Wird die
    Bestätigung zurückgenommen, übernimmt der Server wieder, das Gateway bekommt den Raum nicht mehr.
  - **Edge-Teil:** `edge/heat.js` nimmt Thermostate `fam: 'z2m'` (`zigbee2mqtt/0x<IEEE>`, `thermostat:0`, `name`,
    `step`, `modes`); Befehle an `zigbee2mqtt/<Name>/set` mit dem Soll-Feld, das das Gerät anbietet
    (`occupied_heating_setpoint` vor `current_heating_setpoint`, aus den Exposes von `zigbee2mqtt/bridge/devices`, sonst
    aus seiner Meldung – ohne Meldung wartet es), Aus als `system_mode: off` (sonst Frostschutz), zurück aus Aus bzw.
    eigener Plan (`auto`) beim Senden des Plans → `system_mode: heat`, Boost 30 °C. „Erledigt“, sobald Soll und Modus
    gemeldet sind. `normalize.parseZ2m` kennt `kind: 'thermostat'` → `thermostat:0` { temp, target, sp, mode, valve };
    `commands` `setpoint` (mit `prop`) / `mode` für zigbee2mqtt-Thermostate. `edge/index.js` abonniert `zigbee2mqtt/#`
    auch für die Thermostate der Heizung (auch aus `gc.store` nach einem Neustart ohne Server), wertet
    `zigbee2mqtt/<Name>/availability` aus (offline → wartet) und meldet `z2m` wie für die Ketten.
  - **Server-Teil:** `server/heating.js` `edgeGatewayOf` / `load` (Bestätigung), `edgeConfig` (zigbee2mqtt-Einträge),
    `edgePending` (Aus mit `system_mode off`, Boost 30 °C); `server/edge.js` setzt `denied` bei `$started` zurück.
  - **Seiten:** nur der vorhandene Hinweis „Plan läuft am Gateway“ und der Text im Plan-Editor.
- `edge.capabilities` und `edge.optionalCapabilities` unverändert (`zigbee2mqtt/#` ist schon optional) – kein
  `update_pending`. Kein Eingriff in Gateway oder Server nötig.

## 1.17.0

- **Thermostate Stufe 2** (freigegebener Entwurf „Thermostate“): Shelly TRV (Gen1) und Shelly BLU TRV über ein Shelly BLU
  Gateway Gen3 als Thermostate der Heizung; der Wochenplan je Raum läuft für sie **am Gateway**, auch ohne Server.
  - **Edge-Teil:** `normalize` liest `shellies/<id>/info` des Shelly TRV (`thermostats[]`: Ist, Soll, Ventil, eigener
    Zeitplan, Boost-Minuten, Fenster, Batterie) und die Komponenten `blutrv:200…` des BLU Gateway (`status/blutrv:<id>`,
    NotifyStatus / NotifyFullStatus: `current_C`, `target_C`, `pos`, `battery`, `paired`) als Kanal `thermostat:<n>`.
    `commands`: `setpoint` (Gen1 `thermostat/<n>/command/target_t`, BLU RPC `BluTrv.Call` → `TRV.SetTarget`), `boost`
    (Gen1 `boost_minutes`), `schedule_off` (Gen1 `schedule` 0).
  - **Plan am Gateway** (neu `edge/heat.js`): `gc.edge.configure { heat: { v, tz, plans, rooms } }`; das Gateway rechnet
    je Raum wie `server/heating.js decide` (Aus · Fenster · Boost · von Hand · Urlaub · Von Hand · Plan mit Abwesend ·
    gehaltenes Soll) in der Zeitzone des Servers und schickt nur bei neuer Signatur (echter Schaltpunkt). Ein Thermostat
    gilt als erledigt, sobald es das Soll meldet, sonst höchstens 3 Versuche im Abstand von 5 min; nicht erreichbare
    (offline, 2 h still, BLU nicht gekoppelt) bekommen es, sobald sie sich melden. Konfiguration und Angewandtes liegen in
    `gc.store` `heat` – nach einem Neustart ohne Server läuft der Plan weiter, nichts wird doppelt geschickt. Eine
    Konfiguration ohne `heat` (älterer Server-Teil) lässt die Räume, wie sie sind. `info` zeigt `heat`, neuer Handler `heat`.
  - **Zuständigkeit:** Ein Raum, dessen Thermostate alle Shelly/BLU TRV desselben Gateways sind (≤ 8 je Raum, ≤ 24
    Räume je Gateway), läuft am Gateway (`room.edge`); der Server schickt dessen Thermostaten **nie** Befehle, er
    schickt dem Gateway den Raum, wenn sich etwas ändert (Plan, Presets, von Hand, Boost, Betrieb, Urlaub, Abwesend,
    Fenster) – `pushEdge` nach jedem Lauf und jeder Änderung, fehlgeschlagen nach 5 min erneut, sonst bei `$online`.
    Fenster offen kommt mit `ttl` (2 h, erneuert, solange es offen ist): ohne Server endet es am Gateway von selbst.
    Gemischte Räume (mit zigbee2mqtt/deCONZ oder TRVs an zwei Gateways) bleiben am Server, ein TRV darin bekommt Befehle
    über sein Gateway. „Wird übertragen“ zählt für Gateway-Räume Thermostate, die das Soll noch nicht melden.
  - **Server-Teil:** Kanal `thermostat:<n>` → Ressource `thermostat` (`capabilities.trv` gen1 | blu, `gateway_id`,
    Grenzen 5–30 °C, `boost` nur Gen1); reine Thermostat-Geräte gelten 2 h als erreichbar; `setState` für
    Thermostate (`setpoint`, `boost`/`boost_minutes`, `schedule_on: false`). Thermostate sind keine Ressourcen von
    Ketten am Gateway; Server-Ketten lesen sie wie zigbee2mqtt-Thermostate als Temperatur. Passt die Heizung nicht mehr
    in die 48 KB der Konfiguration, geht sie ohne `heat` (das Gateway behält seinen Plan, Warnung einmal).
  - **Seiten:** Raumseite „Plan läuft am Gateway“ (Name des Gateways) statt „am Server“, Quelle „Shelly“; Gerätekarte und
    Kanäle zeigen Thermostate (Ist, Soll, Ventil); Hinweis im Plan-Editor ergänzt.
- `edge.capabilities` unverändert (`shellies/#` deckt Shelly TRV und BLU Gateway ab) – kein `update_pending`;
  `edge.optionalCapabilities` unverändert. Kein Eingriff in Gateway oder Server nötig.

## 1.16.0

- **Heizungs-Karte der Apps** mit den Widget-Erweiterungen von GateControl 1.317.1 (`"gatecontrol": ">=1.317.1"`):
  - **Ohne Behelfs-Option:** die choice der Presets hat nur noch Komfort / Eco / Nacht / Frost; gilt kein Preset
    (Boost, von Hand, Fenster offen, Aus), ist `value: null` – der Status-Text sagt weiter, was gilt. Die fünfte
    Option („Boost“, „Von Hand“, „Fenster“, „Aus“) und ihre Texte `heat.choice.window/off/manual` sind entfernt; ein
    Lauf mit einer anderen id als einem Preset → `qa.unknown`.
  - **Tagesbalken** `widget.timeline` aus `roomView.today` (Stunden, `now` = jetzt), je Preset eine Farbe, die auf
    hellen und dunklen Karten mindestens 3:1 erreicht (Komfort `#ea580c`, Eco `#16a36a`, Nacht `#5b7cf5`, Frost
    `#2b93b5`, Soll von Hand / gehalten `#8b6be8`); Lücken, wo nichts gilt; mehr als 12 Abschnitte → die kürzesten
    Nachbarn werden zusammengefasst; an Tagen der Zeitumstellung reicht der Balken bis 23 bzw. 25; im Betrieb „Aus“ kein Balken.
  - **Gesperrte Regler:** bei offenem Fenster, ohne erreichbares Thermostat oder im Betrieb „Aus“ bleiben Stepper
    und choice mit `disabled: true` (statt weggelassen); der Host lehnt ihre Läufe mit 409 `control_disabled` ab.
- `edge.capabilities` unverändert – kein `update_pending`.
- Mock-Host (GateControl 1.317.1, `opts.gatecontrol`): choice `value: null`, `control.disabled` (409
  `control_disabled`), `widget.timeline`; `gatecontrol.ref` auf v1.317.1. Smart-Home-Tests laufen gegen 1.317.1.

## 1.15.0

- **zigbee2mqtt in Logikketten am Gateway** über die optionale Edge-Fähigkeit von GateControl 1.317.0
  (`edge.optionalCapabilities: { mqtt: { topics: ['zigbee2mqtt/#'] } }`, `"gatecontrol": ">=1.317.0"`).
  `edge.capabilities` bleiben unverändert (`shellies/#`, `tasmota/#`, mDNS, LAN) – kein `update_pending`, Smart Home
  läuft auf allen Gateways ohne neue Bestätigung weiter.
  - **Edge-Teil:** abonniert `zigbee2mqtt/#` nur, wenn der Server-Teil eine Liste von zigbee2mqtt-Geräten schickt
    (nur für bestätigte Gateways, deren Ketten solche Geräte nutzen); Namen aus `zigbee2mqtt/bridge/devices`,
    Zustände über `normalize.parseZ2m`, Befehle an `zigbee2mqtt/<Name>/set` (Vorlage: die in 1.12.0 entfernte
    Umsetzung, angepasst – auch Kanäle der Art „Schalter“). Antwortet das Gateway mit `denied` (Gateway vor 1.46.0
    ohne optionale Fähigkeiten – sie gibt es ab Gateway 1.46.0 –, oder die Bestätigung ist noch nicht angekommen), laufen Shelly und Tasmota weiter, der
    Edge-Teil versucht es jede Minute neu und meldet Ereignis `z2m` { state } (`info` zeigt `z2m`).
  - **Server-Teil:** zigbee2mqtt-Geräte eines Gateways sind Ressourcen seiner Ketten, wenn der Host
    `gc.edge.capabilities` / `requestCapability` kennt (sonst wie bisher `foreign_resource`; Version-1-Ketten nehmen
    sie nie). Beim Speichern einer Kette mit solchen Geräten ohne Bestätigung → `gc.edge.requestCapability`
    (Hinweis höchstens 1×/24 h), die Kette wird gespeichert, aber nicht ans Gateway geschickt; `rule.z2m`
    `approval` / `unavailable` und `rule.z2m_link` (`/gateways#gw/<id>/edge`), `GET /rules/devices` liefert `z2m`.
    Der Hintergrund prüft je Gateway mit solchen Ketten, ob bestätigt (oder zurückgenommen) wurde, und schickt die
    Liste neu. Protokoll des Plugins: „chains … wait for zigbee2mqtt/#“ bzw. „not available on gateway … yet“.
  - **Seite:** Hinweis im Editor „Für zigbee2mqtt bitte unter Gateways › <Gateway> › Edge-Plugins bestätigen“ mit
    Knopf „Zum Gateway“, Pille „wartet auf Bestätigung“ / „ab Gateway 1.46.0“ und Hinweis an der Kette, Meldung nach
    dem Speichern.
- Heizung (1.14.0) unverändert am Server.
- Mock-Host: `gc.edge.capabilities` / `requestCapability` (GateControl 1.317.0, `opts.edge.optional`,
  `host.edgeRequests`); `gatecontrol.ref` auf v1.317.0.

## 1.14.0

- **Heizung** (freigegebener Entwurf „Thermostate“, Stufe 1a; neu `server/heating.js`, Migration `006_heating.sql`:
  `heat_house`, `heat_plans`, `heat_rooms`). Raum = Bereich der Thermostate (`a:<Bereich>`), ohne Bereich ein Raum je
  Thermostat (`t:<id>`); ein Soll je Raum für alle Thermostate, Fensterkontakte desselben Bereichs gehören dazu.
  - **Presets** Komfort / Eco / Nacht / Frostschutz (Haus 21 / 18 / 17 / 7 °C), Überschreiben je Plan und je Raum.
  - **Wochenpläne** je Raum (7 Tage, Abschnitte im 15-min-Raster, höchstens 12 je Tag, nur Presets), ein Plan je Raum.
  - **Planer im Server-Teil** (`tick`, ~30 s): rechnet je Raum, was jetzt gilt, und schickt es nur bei Änderung
    (Signatur mit Schaltpunkt) an jedes Thermostat; verpasste Schaltpunkte werden nachgeholt, fehlgeschlagene Befehle
    nach 5 min wiederholt, nicht erreichbare Geräte bekommen den Wert, sobald sie wieder da sind; ohne Server halten
    die Thermostate das letzte Soll. Ein eigener Plan im Gerät (Modus `auto`, deCONZ `preset: auto`, `schedule_on`)
    wird beim Senden auf manuell/heat gestellt.
  - Vorrang: Aus · Fenster offen · Boost · von Hand bis zum nächsten Schaltpunkt · Urlaub · „Von Hand“ auf Dauer ·
    Plan (mit „Heizung abwesend“: Komfort → Eco, je Plan abschaltbar) · gehaltenes Soll eines Raums ohne Plan.
  - **Betrieb** Nach Plan / Von Hand / Aus (Aus: Modus `off`, sonst Frostschutz; danach der Modus von vorher),
    „Zurück zum Plan“, „Plan heute aussetzen“ (bis Mitternacht).
  - **Boost** 15 / 30 / 60 min: deCONZ mit `config.preset` → `preset: boost` (danach `manual`), zigbee2mqtt mit
    `caps.boost` (ein späteres Gateway) → `boost`, sonst Soll 30 °C (bzw. Gerätemaximum).
  - **Fenster offen:** Kontakt im Bereich länger als 1 / 2 / 5 min (Plan, ohne Plan 2) → Frostschutz, danach was dann
    gilt. Die Mitteilung `window_open` heißt dann „Fenster offen, Heizung heruntergeregelt“ und kommt auch, wenn
    kein Thermostat heizt.
  - **Urlaub** für das ganze Haus: von – Rückkehr, Preset (Vorgabe Eco) und je Raum, Vorheizen (Vorgabe 4 h),
    Vorrang vor den Plänen; verschwindet nach der Rückkehr.
  - **Rechte:** Admins alles (`/heating…`); Personen, denen ein Thermostat des Raums zugewiesen ist, im Portal
    (`GET /portal/heating`, `POST /portal/heating/rooms/:id`) Soll, Preset, Boost, Zurück zum Plan – Betrieb und
    „Plan heute aussetzen“ nur Admins. Optionale Obergrenze je Raum (`max_setpoint`) für Zugewiesene, auch als
    `stepper.max` der Apps; über ihr kein Boost für sie.
- **Seite „Heizung“** (neu `ui/heating.html`, `ui/heating.js`, gemeinsam mit dem Portal `ui/heatui.js`): Übersicht
  Räume / Pläne / Presets, Schalter „Heizung abwesend“, „Urlaub planen“, Wochenplan-Editor (Vorlagen, Räume,
  eigene Temperaturen, Abschnitte, teilen, Tag kopieren, Ausnahmen, Hinweis auf eigenen Plan im Gerät), Raumseite
  (Ist/Soll, − / +, Betrieb, Presets, Boost, heutiger Plan, Geräte), Raum-Einstellungen (eigene Werte, Obergrenze).
  **Portal „Zuhause“:** Heizung mit den eigenen Räumen und ihrer Raumseite; Thermostate stehen nicht mehr als
  einzelne Kacheln da.
- **Schnellaktionen der Apps** je Raum (höchstens 8 der 16): Karte `heat:<raum>` (Ist als `value`, Ventil als
  `badge`, Fenster / Feuchte / Batterie als `readings`, Plan-Text als `status`, Soll als `stepper` mit Schritt 0,5 –
  ohne die Rundung auf ganze Zahlen –, Presets als `choice`), Knöpfe `heat:<raum>:boost` (Boost 30 min / beenden)
  und `heat:<raum>:plan` im selben `device`; `heat:away` (Toggle mit `targets`, nur Admins) für die Familie-Regeln
  über `gc.actions.run` mit `state`. Solange der Host `choice.value: null` nicht kennt, bekommt die `choice` bei
  Boost, von Hand, Fenster und Aus eine fünfte Option („Boost“, „Von Hand“ …), die ausgewählt ist – so leuchtet kein
  falsches Preset; sie zu wählen ändert nichts. Bei offenem Fenster oder ohne erreichbares Thermostat keine Regler.
- **deCONZ-Thermostate** (`ZHAThermostat`) sind jetzt Art `thermostat`: `heatsetpoint`, `mode`, Ventil, Batterie,
  `preset`, `schedule_on`; gesetzt über `PUT /sensors/<id>/config`. Sync-Zähler `thermostats`.
- **Keine neue Edge-Fähigkeit** (`edge.capabilities` wie 1.13.0, Test).
- Tests: Planer mit Fake-Uhr (Schaltpunkte, Nachholen, Fehler/Wiederholung, nicht erreichbar, von Hand, Betrieb,
  Aus, ohne Plan, Plan löschen, abwesend, Urlaub mit Vorheizen, Boost, eigener Plan im Gerät, Fenster offen,
  keine Schreibzugriffe ohne Änderung), deCONZ-Thermostate (Sync, Steuern, Boost über Preset), Mitteilung
  „heruntergeregelt“, Rechte (Portal-Umfang, Obergrenze, Admin-API), Schnellaktionen (Widget, Schritt 0,5, Extra-
  Option, Boost-Zeit, Fenster, nicht erreichbar, Toggle mit `state`), Manifest.

## 1.13.0

- **Batteriestand in den Schnellaktionen/Widgets der Apps** (`widget.badge` von GateControl, ab 1.175.0; ältere Hosts
  lassen ihn weg): `{ icon, value, unit: '%', state, label }` – Symbol eine Batterie mit 0–3 Balken nach Füllstand
  (SVG-Pfad 24×24), Wert in ganzen Prozent, `state` `good` | `warn` (≤ Einstellung „Batterie schwach“, Standard 15 %)
  | `crit` (≤ 5 %, deCONZ `lowbattery` ohne Prozentwert – dann `value: 'schwach'`/`'low'` –, oder ein schlafender
  Shelly länger als 26 h still → `label` „Batterie leer?“). Schläft ein Shelly H&T (oder ist ein Gerät nicht
  erreichbar), trägt das `label` das Alter des letzten Werts („Batterie, vor 2 h“, ≤ 20 Zeichen). Neu
  `server/battery.js` (eine Stelle für Apps, Portal und Seite).
  - An jedem Widget eines Geräts mit Batterie (Dimmer, Messsteckdose, Rollladen „Auf“); ein Schalter ohne eigenes
    Widget bekommt mit Batterie ein kleines (An/Aus als Wert, Art als Status, `power: true`).
  - **Sensoren mit Batterie** (Shelly H&T, deCONZ, zigbee2mqtt, Bluetooth) erscheinen als Knopf `sensor:<id>` mit
    Widget (Messwert, Feuchte als Messung, „schläft, Wert vor …“ im Status, `power: false`) – nach Schaltern,
    Rollläden und Szenen, innerhalb der 16. `runQuickAction` schaltet nichts und antwortet mit dem aktuellen Widget.
    Sensoren ohne Batterie und Taster bleiben draußen.
  - deCONZ-Sensoren speichern jetzt `config.battery` als `state.battery` und `state.lowbattery`.
- **Seite und Portal:** kleines Batteriesymbol mit Prozentwert an der Karte (deCONZ, zigbee2mqtt, Bluetooth, Shelly/
  Tasmota; `S.batteryChip`), Farbe aus `battery_level` (`good` | `warn` | `crit`) – neu in `GET /resources`,
  `GET /ble/resources`, `GET /edge/devices[/:id]` und im Portal (`state.battery_level`, auch für Geräte, nicht nur
  Sensoren). Thermostat-Karten bleiben unverändert.
- **Art je Kanal** auch für zigbee2mqtt-Geräte mit mehreren Kanälen: `PUT /resources/:id { kind: light | plug |
  relay }` (nur ein Kanal, `capabilities.channel`), gespeichert als `capabilities.kind_set` und bei jedem Bericht
  behalten; Auswahl „Art“ im Dialog „Besitzer verwalten“. Wirkt auf Symbol, Begriffe und Schnellaktion; ein Kanal
  bleibt nur schaltbar (`capabilities.bri: false` – auch in Ketten am Server). Shelly/Tasmota hatten die Art je
  Ausgang (Licht, Steckdose, Schalter; Rollladen nur im Rollladen-Modus des Geräts) schon seit 1.7.0.
- **Benutzername am Gerät** (Shelly Gen1 HTTP Basic, Tasmota `user=`) war seit 1.10.0 da – Einrichtungsdialog,
  „Bearbeiten“ › Verbindung, Edge-Teil (`setup { httpUser }`); unverändert. Das Gerätepasswort wird weiter nur für
  den einen Vorgang benutzt und nie gespeichert.
- **Keine neue Edge-Fähigkeit** (`edge.capabilities` wie 1.12.0, Test) – kein `update_pending` am Gateway.
- Tests: Badge (Stufen, Schwelle aus der Einstellung, Alter, „Batterie leer?“, Länge, Symbol nach Hostprüfung),
  Sensor-Karten deCONZ und Shelly H&T (schlafend / überfällig, Lauf), zigbee2mqtt mit Batterie (Rollladen, Dimmer,
  einfache Steckdose, Antwort eines Laufs), Art je Kanal (bleibt, Schnellaktion, Kette dimmt nicht, ungültige Arten,
  Geräte ohne Kanäle), Edge-Fähigkeiten unverändert.

## 1.12.0

- **Logikketten, Stufe 2** nach dem freigegebenen Entwurf (gleiche Seite, gleiche Bausteine):
  - **Sonnenauf-/-untergang** mit Versatz (−180…180 min) als WENN (`{ kind: 'sun', event, offset }` → Edge
    `{ k: 'sun', ev, off }`) und als Grenze von „Zeit zwischen“ (`from`/`to` auch `{ sun, offset }`). Gerechnet wird
    auf dem Gateway (`edge/sun.js`, NOAA-Näherung, ±1–2 min) mit dem **Standort des Ortes**: `GET/PUT /rules/location`
    (`gc.settings` `sun.<gateway>` / `sun.server`, auf 0,01° gerundet), mitgeschickt als `gc.edge.configure { sun }`.
    Ohne Standort zeigt der Editor einen Hinweis mit Breite/Länge; „Sonne“ löst dann nie aus, „Zeit zwischen“ mit
    Sonne gilt als offen. Der Testlauf zeigt die Sonnenzeit des Tages (`checks[].range`, `sun`).
  - **„seit X min“** (`for: 1…1440`) an Geräte-Auslösern (feuert, wenn der Zustand so lange gilt) und -Bedingungen.
  - **Kontakt, Bewegung, Wasser** (`contact` / `motion` / `water`, Felder `open` / `presence` / `water`) für Sensoren
    von zigbee2mqtt, deCONZ und Bluetooth (nur Version 2, in Ketten am Server).
  - **„Andere Kette starten“** (`{ kind: 'chain', ruleId }`, nur derselbe Ort, nie sich selbst): die andere Kette
    prüft ihr „Nur wenn“; höchstens 4 Ketten tief. Die Schleifenprüfung kennt Kettenstarts: gegenseitiges Starten
    ohne „Nur wenn“ wird abgelehnt, mit „Nur wenn“ als Hinweis gezeigt. Fehlt die gestartete Kette, gilt die Kette
    als „Gerät fehlt“.
  - **„Mitteilung senden“** (`{ kind: 'notify', text ≤ 200, users? }`): das Gateway meldet den Schritt mit dem
    Ereignis `notify` (vom Gateway bis zu 1 h gepuffert), der Server schickt über den vorhandenen Notifier
    (`gc.notify`, neues Thema `chains` „Logikketten“, Budget geteilt mit den übrigen Mitteilungen), nur an `users`,
    wenn gesetzt; doppelt gelieferte Ereignisse einmal. Liste: „läuft am Gateway“ + „+ Mitteilung über Server“.
  - **„Von Hand (App)“** (`{ kind: 'manual' }`): Ketten als Schnellaktion der Apps (siehe unten).
- **Keine neue Edge-Fähigkeit:** Das Update braucht keine Bestätigung am Gateway (kein `update_pending`) –
  Shelly/Tasmota und die Ketten aus 1.11 laufen weiter. zigbee2mqtt-Geräte sind deshalb nur in Ketten am Server
  dabei (über GateControls `gc.radio`); Ketten am Gateway mit zigbee2mqtt bräuchten `mqtt.topic: zigbee2mqtt/#`, und
  GateControl kennt (noch) keine optionalen oder bei Bedarf angefragten Edge-Fähigkeiten.
- **Ketten über mehrere Gateways / gemischt mit deCONZ oder zigbee2mqtt:** neuer Ort `source: 'server'` (`gateway_id 0`), Editor-Wahl
  „Mehrere Gateways (über Server)“, gelbe Box und Pille **„läuft am Server“**, nicht offline-fähig. Sie laufen mit
  derselben Engine (`edge/rules.js`) im Server-Teil (`server/serverchains.js`): Geräte `res/<id>` aus dem Zustands-
  Cache (alle 2 s gelesen, Shelly/Tasmota sofort nach dem Bündel), Schalten über `service.setResourceState`
  (auch Szenen), Protokoll in `rule_runs` mit `gateway_id 0` (`GET /rules/runs?server=1`), Bremse, Testlauf
  (`POST /rules/test { source: 'server' }`). Taster bleiben in Ketten an ihrem Gateway.
- **Server-API für App-Schnellaktionen:** Ketten mit „Von Hand (App)“ erscheinen in `quickActions` als Knopf
  `chain:<id>` (zuerst, höchstens 8; Gerät `chains`) – für Administratoren alle, für andere nur, wenn ein
  Administrator sie freigegeben hat (`quick_users`, Migration 005, `POST/PUT /rules { quick_users }`,
  `GET /rules/people`). `runQuickAction` prüft erneut und startet mit „Nur wenn“ (Edge `test { id, run, by: 'app' }`
  bzw. Server-Engine). Zusätzlich Portal-API für eigene App-Ansichten: `GET /portal/chains`,
  `POST /portal/chains/:id/run` → `{ ok, result: started | running | skip | unknown | stopped | error, message }`.
- Editor: `GET /rules/devices` liefert die Geräte eines Ortes (Gateway: Shelly/Tasmota; Server:
  alle mit Ortsnamen).
- Tests: Sonnenzeiten, Sonne/„seit“/Ketten/Mitteilung/Von Hand/`res`-Schritte der Engine, Edge-Teil
  (gleiche Fähigkeiten wie 1.11, `notify`), Server (Kompilieren, Standort, Schleifen, Server-Ketten end-to-end, Mitteilungen,
  Schnellaktionen mit Rechten, Portal-API) und der fehlende Test aus Stufe 1: `buttons: true` (SetOption73) geht vom
  Einrichtungs-Job des Servers nur auf Wunsch (nur `true`) an das Gateway.

## 1.11.0

- **Logikketten, Stufe 1 (Shelly und Tasmota am GateControl-Gateway, offline-fähig):** neuer Editor nach dem
  freigegebenen Entwurf – **WENN** (Ereignisse, eines genügt: Taster kurz/doppelt/dreifach/lang, Zustandswechsel,
  Wert über/unter, Uhrzeit), **NUR WENN** (UND/ODER, eine Ebene: Gerätezustand, Wert über/unter, Zeit zwischen,
  Wochentage), **DANN** (Schritte der Reihe nach: Schalten/Dimmen/Rollladen, Warten bis 24 h; höchstens 20 Schritte)
  und „ausgelöst, während sie läuft“: von vorn starten, ignorieren, abbrechen wenn „Nur wenn“ nicht mehr gilt.
  Definition `version: 2` (`server/edgerules.js`), kompiliert zu `{ v: 2, when, cond, steps, re }` für den Edge-Teil
  (`edge/rules.js`); das Gateway rechnet die Uhrzeit selbst mit der Zeitzone des Servers. Server und Edge prüfen
  jede Kette (wie `cleanRule`), nur Administratoren bearbeiten.
- **Taster:** `edge/normalize.js` gibt Tastendrücke als Ereignis an die Ketten (nicht als Zustand) – Shelly Gen1
  `input_event/<n>` (doppelt gemeldete Zähler und retained Meldungen zählen nicht), Gen2+ `NotifyEvent`
  (single/double/triple/long_push), Tasmota `stat/RESULT` `ButtonN.Action` (SetOption73). Die Einrichtungshilfe setzt
  `SetOption73 1` bei Tasmota auf Wunsch („Tasten als Taster für Logikketten melden“), sonst Hinweis im Editor.
- **Testlauf** (`POST /rules/test`, Edge `test`): prüft eine gespeicherte Kette oder den Entwurf im Editor mit den
  Werten vom Gateway und schaltet nichts; „Trotzdem ausführen“ überspringt „Nur wenn“ und steht im Protokoll als
  „von Hand“.
- **Protokoll** (`GET /rules/runs`, Tabelle `rule_runs`, Migration 004): letzte 200 Läufe je Gateway mit Auslöser,
  Prüfungen, Schritten und Bestätigung der Geräte. Der Edge-Teil hält einen Ring der letzten 200 Läufe (`gc.store`
  `runs`, höchstens einmal pro Minute geschrieben), meldet sie mit dem Ereignis `runs` und reicht nach, was der Server
  verpasst hat (Edge `runs`, nach `$online` / `$started`).
- **Schleifen- und Ratenbremse:** Beim Speichern wird eine sichere Schleife abgelehnt (`SMARTHOME_RULE_LOOP`), eine
  mögliche als Hinweis gezeigt, andere Ketten mit demselben Gerät genannt (`POST /rules/check`). Am Gateway: eigene
  Rückmeldung 2 s ignoriert, mehr als 10 Läufe pro Minute → Kette angehalten (der Server schaltet sie aus und zeigt
  den Grund, „Wieder starten“), höchstens 60 Befehle pro Minute je Gateway.
- **Startansicht „Alle Quellen“**, gruppiert nach Ort, mit Ort-Pille an jeder Kette (grün am Gateway, blau deCONZ),
  „heute n×“, rote Karte für angehaltene Ketten. deCONZ-Regeln bleiben unverändert (alter Editor).
- **Bestehende Ketten (1.10)** laufen unverändert; der Editor zeigt sie als „wird wahr: A und B“, gespeichert werden
  sie als `version: 2` (keine Datenmigration). Name einer Kette am Gateway bis 40 Zeichen. Grenzen: 40 Ketten je
  Gateway, 20 Schritte je Kette, Größe der Liste wie bisher geprüft.
- Kein neues Gateway nötig: MQTT-Topics (`shellies/#`, `tasmota/#`), `gc.store` und Timer reichen; Mindestversion
  des Gateways bleibt 1.19.0.
- Tests: Edge-Engine (Schritte, Warten, Retrigger, Uhrzeit, Bedingungen, Bremsen, Bestätigung, Testlauf),
  Taster in `normalize`, Edge-Teil (Ring, Nachreichen, Anhalten über einen Neustart), Server (v2, v1-Kompatibilität,
  Schleifenprüfung, Protokoll, Testlauf, nur Admins), Texte der Seite.

## 1.10.0

- **Logikketten für Shelly und Tasmota:** Die Seite „Logikketten“ kennt neben den deCONZ-Gateways die
  GateControl-Gateways als Quelle. Auslöser: Ausgang an/aus, Rollladen offen/geschlossen, Leistung, Temperatur und
  Feuchte über/unter einem Wert; Aktionen: schalten, dimmen, Rollladen Auf/Zu/Stopp/Position; Zeitfenster, Verzögerung
  und „bei erneuter Auslösung“ wie bisher. Die Regeln laufen im **Edge-Teil auf dem Gateway** (`edge/rules.js`): eine
  MQTT-Meldung des Geräts → Regel → MQTT-Befehl, ohne Umweg über den Server und auch, wenn er nicht erreichbar ist
  (die Liste liegt in `gc.store` des Edge-Teils). Sie feuern, wenn die Bedingungen eintreten (steigende Flanke der
  UND-Verknüpfung); was beim Anlegen, beim Start oder bei der ersten Meldung eines Geräts schon gilt, zählt nicht.
  Der Server-Teil prüft und übersetzt die Definition (`server/edgerules.js`) und schickt sie mit der Geräteliste
  (`gc.edge.configure { devices, rules, tz }`); das Ereignis `fired` trägt „Zuletzt ausgelöst“ ein. Tabelle `rules`:
  neue Spalten `source` (`deconz` | `edge`) und `last_fired_at` (Migration 003). Höchstens 40 Regeln je Gateway.
  deCONZ-Regeln bleiben unverändert.
- **Batteriegeräte (Shelly H&T):** „schläft – letzte Meldung vor …“ statt „nicht erreichbar“, nach mehr als 26 Stunden
  mit der Frage „Batterie leer?“; Hinweis „Batterie schwach“ ab dem Wert der Einstellung (Standard 15 %), auch im
  Portal. Die Kennzahl „Nicht erreichbar“ zählt schlafende Geräte nicht. Ein Shelly ab Gen2 an USB-Strom
  (`devicepower:0.external.present`) gilt als wach.
- **Benutzername am Gerät:** Für Shelly Gen1 (HTTP Basic) und Tasmota ist der Benutzername der Geräte-Weboberfläche je
  Gerät einstellbar (Standard `admin`) – im Schritt „Das Gerät hat ein Passwort“ und unter „Bearbeiten“ › Verbindung.
  Gespeichert wird nur der Name; das Gerätepasswort wird wie bisher für den einen Vorgang benutzt und nie gespeichert.
  „Neues MQTT-Passwort setzen“ nimmt jetzt wahlweise das Gerätepasswort an und trägt das Konto dann auch in ein
  geschütztes Gerät ein. Shelly ab Gen2 kennen nur `admin`.
- **zigbee2mqtt** (mit GateControl nach 1.258.4 und einem Gateway nach 1.34.2; ältere liefern die Felder nicht, dann
  bleibt alles wie bisher): **Mehrkanal-Geräte** – eine Ressource je Kanal (`caps.channels`, `values.ch`), geschaltet
  mit `{ on, channel }`; die bisherige Ressource des Geräts wird Kanal 1 und behält Name, Bereich und Besitzer.
  **Thermostate** – neue Art `thermostat` mit Ist-/Soll-Temperatur und Modus, Karte auf der Seite, Kachel im Portal
  (− / +, Modus), Soll innerhalb der Grenzen des Geräts. **OTA-Updates** – „Update verfügbar“, „Aktualisieren“,
  Fortschritt und „Nach Update suchen“ auf der Karte (`POST /resources/:id/ota`, `gc.radio.command(id, { ota })`).
- Geräte von zigbee2mqtt lassen sich im Dialog „Besitzer verwalten“ umbenennen (der Server konnte es schon, das Feld
  fehlte).
- Dialoge und Rückfragen holen den Anfang des Rahmens in den sichtbaren Bereich – über ein nicht fixiertes Element;
  für die fixierte Dialogfläche scrollt Chromium die umgebende Seite nicht.
- Regel-Editor: Gerät, Felder und × stehen in einer Zeile, solange Platz ist.
- Tests: Regel-Engine und Edge-Teil gegen simulierte MQTT-Meldungen (Shelly Gen1/Gen2, Tasmota), Server-Teil der
  Edge-Regeln, schlafende Geräte, Benutzername, zigbee2mqtt-Kanäle/Thermostate/OTA.

## 1.9.1

- **Weniger Schreibvorgänge:** der Abgleich mit Phoscon/deCONZ (alle 30 s) schreibt eine Leuchte, Gruppe, Szene oder einen Sensor nur noch, wenn sich etwas geändert hat, und alle Änderungen eines Abgleichs in **einer** Transaktion – vorher jede Ressource bei jedem Abgleich (im Protokoll von GateControl 1.253.5: `UPDATE resources …` 935 Mal in der Stunde, je ~300 ms auf einem langsamen Datenträger). Eine fehlende Ressource wird einmal abgeschaltet, nicht bei jedem Abgleich wieder.
- „Zuletzt gesehen“ eines Gateways (`gateways.last_seen_at`) höchstens einmal je Minute.
- Bluetooth-Sensoren, zigbee2mqtt-Geräte und Shelly/Tasmota-Kanäle: dieselben Werte noch einmal werden nicht geschrieben.
- Test: eine Stunde Abgleich ohne Änderung schreibt nichts, zwei geänderte Ressourcen sind ein Commit (`writes.test.js`).

## 1.9.0

- **Zigbee-Geräte von zigbee2mqtt über ein GateControl-Gateway:** Mit einem GateControl, das zigbee2mqtt kennt
  (`gc.radio.zigbee` / `gc.radio.command`; ein Gateway nach 1.30.0 mit „zigbee2mqtt“ unter Gateway › Funk),
  erscheinen die dort angelernten Geräte – Lichter (Helligkeit, Farbe, Farbtemperatur), Steckdosen/Schalter,
  Rollläden, Sensoren und Taster – unter der Quelle „Funk (GateControl-Gateway)“ des Gateways, zusammen mit den
  Bluetooth-Sensoren. Schalten, Besitzer, Bereiche, Umbenennen, Portal „Zuhause“ und „In Smart Home benennen“ wie bei
  den anderen Quellen; geschaltet wird über das Gateway (`zigbee2mqtt/<Name>/set`), der echte Zustand kommt mit dem
  nächsten Bericht. Ein Gerät, das zigbee2mqtt nicht mehr kennt (oder ein Gateway zurück auf deCONZ), wird hier
  ausgeschaltet – Besitzer bleiben. Keine neue Berechtigung (`permissions.radio`), keine neue Edge-Fähigkeit; ohne
  `gc.radio.zigbee` (älteres GateControl) bleibt alles wie bisher.
- Verschlüsselte Bluetooth-Sensoren (BTHome mit Schlüssel, Xiaomi-Originalfirmware mit Bindkey) liefern Werte, sobald
  der Schlüssel in GateControl eingetragen ist – im Plugin ändert sich dafür nichts.

## 1.8.1

- Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0): `HANDBUCH.md` / `HANDBOOK.md` im Paket, in `plugin.json` unter `handbook`. Ältere GateControl-Versionen ignorieren es; die Mindestversion bleibt `>=1.228.1`.

## 1.8.0
- **Bluetooth-Sensoren über ein GateControl-Gateway:** Mit einem GateControl, das Funk kennt (`gc.radio`, Phase 3c
  Schritt 2), erscheinen die Bluetooth-Thermometer und -Sensoren, die du in GateControl unter Gateway › Funk
  „Übernommen“ hast (BTHome, Xiaomi mit ATC/pvvx-Firmware, Shelly BLU), als Sensoren im Plugin – eigene Quelle
  „Bluetooth-Sensoren (GateControl-Gateway)“ je Gateway, mit Temperatur bzw. Feuchte, Batterie, Bereich und Besitzern
  wie jeder andere Sensor, auch im Portal „Zuhause“. Gibt man einen Sensor in GateControl zurück, verschwindet er hier.
  Neue Berechtigung `permissions.radio` (ältere GateControl-Versionen ignorieren sie – dann bleibt alles wie bisher).
- **„In Smart Home benennen“:** Lampen und Sensoren lassen sich im Dialog „Zuweisen“ umbenennen – deCONZ-Geräte direkt
  in deCONZ (alle Teile eines Zigbee-Geräts zugleich, wie in Phoscon), Bluetooth-Sensoren im Plugin (der Name bleibt).
  GateControls Link `/plugins/gatecontrol-smarthome?focus=zigbee:<MAC>` bzw. `ble:<MAC>` (Reiter „Funk“ nach dem
  Anlernen) öffnet die richtige Quelle, zeigt das Gerät und öffnet den Dialog (`GET /find`). Der Link braucht ein
  GateControl, das `?focus=` an die Seite weitergibt; ältere zeigen die Seite ohne Sprung.

## 1.7.2
- **Verständlichere Protokollzeile, wenn MQTT aus ist:** Statt „the MQTT broker of this gateway is off – retrying
  every minute“ sagt der Edge-Teil jetzt, dass MQTT auf dem Gateway noch nicht eingeschaltet ist, wo man es
  einschaltet (GateControl: Gateways › Gateway › MQTT) und dass er sich danach von selbst verbindet. GateControl
  zeigt dazu beim Plugin und im Protokoll einen Hinweis mit dem Knopf „MQTT einschalten“ (de/en).

## 1.7.1
- **Warum ein Gateway „nicht verbunden“ ist:** Mit einem GateControl, das den Grund kennt (`gc.edge.gateways()` mit
  `reason`), zeigen „Quelle hinzufügen“, die Quellenauswahl und eine gescheiterte Einrichtung („Gerät erreicht“,
  „MQTT eintragen“) statt „Das Gateway ist gerade nicht verbunden.“ den Grund: Gateway offline, Edge-Dienst fehlt in
  der Compose-Datei, Edge-Container läuft nicht, Netzgrenze fehlt (Synology: `xt_owner`) oder der Edge-Container
  erreicht GateControl nicht – jeweils mit dem Weg zur Gateway-Seite. Ältere GateControl-Versionen: Text wie bisher.

## 1.7.0
- **Shelly und Tasmota über ein GateControl-Gateway** (GateControl ≥ 1.228.1, Gateway ≥ 1.19.0): neben
  Phoscon/deCONZ-Gateways gibt es Quellen vom Typ „GateControl-Gateway“ – je Gateway, auf dem der neue
  **Edge-Teil** von „Smart Home“ eingeschaltet ist (GateControl: Gateways › Gateway › Edge-Plugins) und der lokale
  MQTT-Broker läuft. „Quelle hinzufügen“ zeigt je Gateway, ob der Edge-Teil läuft, noch aus ist oder das Gateway zu
  alt ist; „Phoscon verbinden“ steht im selben Dialog.
- **Edge-Teil** (`edge/`, 32 MB, Fähigkeiten: mDNS `_shelly._tcp`/`_http._tcp`, HTTP im Heimnetz, MQTT `shellies/#`
  und `tasmota/#`): findet Shelly- und Tasmota-Geräte im Heimnetz, liest ihre Meldungen am Broker des Gateways und
  meldet sie gebündelt (alle 2 s, nur Änderungen) an den Server, schaltet, dimmt und fährt Rollläden per MQTT und
  fragt die Geräte alle 10 Minuten nach ihrem Stand.
- **Unterstützt:** Shelly Gen2/3/4 (Schalter mit Leistungsmessung, Rollladen/Cover, Licht/Dimmer, Plug S, H&T),
  Shelly Gen1 (Relais, Roller, Dimmer, H&T), Tasmota (POWER/POWERn, Dimmer, Shutter, ENERGY mit Leistung und
  „Heute“, Temperatur/Feuchte aus SENSOR); online/offline über LWT bzw. `online`. Unbekannte Meldungen werden
  ignoriert.
- **Gerät hinzufügen:** gefundene Geräte automatisch einrichten – eigenes MQTT-Konto je Gerät (nur seine Topics
  `shellies/<name>/#` bzw. `tasmota/<name>/#`), Gerät erreicht, Gerätepasswort (nur für diesen Vorgang, nie
  gespeichert oder protokolliert; Shelly Gen2+ mit Digest), MQTT im Gerät eintragen und neu starten, warten bis
  es sich meldet – als Schrittliste live. Oder **von Hand**: die Daten zum Kopieren (das Passwort nur in diesem
  Fenster) mit Anleitung je Gerätetyp und „Warte auf das Gerät …“.
- **Gerät bearbeiten:** Name, Bereich, Art je Ausgang (Licht, Steckdose, Schalter; Paar als Rollladen, Markise oder
  Tor), wer es bedienen darf, neues MQTT-Passwort (trägt es im Gerät ein, sonst zum Abtippen), Entfernen (löscht
  auch das MQTT-Konto).
- **Seite:** Quellenauswahl getrennt nach deCONZ und „über Gateway“, Hinweis „n neue Geräte gefunden“, Kennzahlen
  Geräte / eingeschaltet / Leistung jetzt / nicht erreichbar, Karten für Rollläden, Strommessung, Dimmer, Sensoren
  und nicht erreichbare Geräte (LWT offline oder 30 Minuten ohne Meldung, Batteriesensoren 26 Stunden).
- **Bereich** für alle Geräte – auch deCONZ (im Dialog „Besitzer verwalten“): die Seite und das Portal „Zuhause“
  gruppieren danach, Geräte ohne Bereich stehen wie bisher.
- **Portal und Apps** wie bei deCONZ: eigene Shelly-/Tasmota-Geräte schalten und dimmen (Zielzustand an/aus),
  Rollläden als Tasten Auf / Stopp / Zu mit Position als Widget (Regler), Leistung als Wert im Widget von Steckdosen
  und Schaltern, „Heute“ als Zusatzwert. An den Apps ist nichts Neues nötig.
- Logikketten bleiben bei deCONZ-Gateways.
- Mindestversion GateControl 1.228.1 (`gc.edge`, `gc.mqtt.accounts`). Ohne diese Schnittstellen läuft deCONZ
  unverändert weiter und die Seite zeigt einen Hinweis statt Shelly/Tasmota.

## 1.6.1
- **Batterie-Hinweis ohne Wiederholungen**: Ein Gerät mit mehreren Sensoren (z. B. ein
  Bewegungsmelder mit Bewegung, Helligkeit und Temperatur) stand bisher mit jedem Sensor
  einzeln in „Batterie schwach“ – jetzt einmal pro Gerät, mit dem niedrigsten Wert.

## 1.6.0
- **Zielzustand statt Umschalten** (GateControl ≥ 1.173.0): Lampen, Steckdosen und Gruppen
  nennen ihre Befehle („Einschalten“ / „Ausschalten“, englisch „Turn on“ / „Turn off“) und
  nehmen einen gewünschten Zustand an: eine Regel (z. B. der Familie: „alle weg → Licht aus“)
  oder eine App, die „aus“ verlangt, schaltet aus – ein schon ausgeschaltetes Licht bleibt
  aus. Szenen bleiben Tasten.
- Ohne Zielzustand (Apps, ältere GateControl-Versionen) wird wie bisher umgeschaltet – das
  Plugin läuft weiter ab GateControl 1.154.0.

## 1.5.1
- **Keine eigene Seitenüberschrift mehr**: GateControl zeigt den Seitentitel im Kopf; die
  Seiten „Smart Home“ und „Logikketten“ beginnen direkt mit ihrer Knopfleiste (Gateway-Auswahl,
  Verbindung testen, … bzw. Zurück, Neue Regel) – Überschrift und Beschreibung oben entfallen.

## 1.5.0
- Geräte: jede Lampe, Steckdose und Gruppe ist ein eigenes Gerät (Name und Symbol); die
  Szenen einer Gruppe gehören zum Gerät der Gruppe, wenn die Person diese Gruppe hat, sonst
  sind sie ein eigenes Gerät – die GateControl-Apps ab 1.38.0 zeigen so z. B. „Wohnzimmer“
  mit Schalter, Helligkeit und den Szenen als eine Zeile.
- Widget: der große Wert heißt „Helligkeit“ (für die Auswahl, was das Widget zeigt).
- Optional: GateControl ab 1.172.0 gibt die neuen Felder weiter, ältere Versionen lassen
  sie weg – die Mindestversion bleibt unverändert.

## 1.4.0
- Widget für den Start-Tab der GateControl-Apps: dimmbare Lampen und Gruppen bringen
  bei ihrer Schnellaktion jetzt ein Widget mit – eingeschaltet die Helligkeit in Prozent
  als großer Wert, ausgeschaltet „Aus“; darunter die Art (Licht/Gruppe, ggf. „nicht
  erreichbar“) und ein Helligkeitsregler (1–100 %). Steckdosen, Schalter-Lampen ohne
  Dimmung und Szenen bleiben einfache Schaltflächen.
- Helligkeitsregler bedienen: die Helligkeit wird am Gateway gesetzt und die Lampe bzw.
  Gruppe dabei eingeschaltet (nur für eigene Geräte, Prüfung wie beim Schalten); jede
  Antwort – auch das Umschalten – liefert das Widget mit dem neuen Zustand. Ein
  unbekannter Regler oder Wert ändert nichts.
- Neuer Text „Helligkeit“/„Brightness“ (Beschriftung des Reglers).
- Optional: GateControl ab 1.171.0 zeigt die Widgets, ältere Versionen lassen das Feld
  weg – die Mindestversion bleibt unverändert.

## 1.3.0
- Schnellaktionen für die GateControl-Apps (Verknüpfungen auf dem Startbildschirm,
  Schnelleinstellungen, Widget): je ein Schalter für die eigenen Lampen, Steckdosen und
  Gruppen (an/aus, Zustand aus dem zuletzt abgefragten Stand) und je eine Taste für die
  Szenen eigener Gruppen; höchstens 16, Schalter vor Szenen.
- Sichtbar und auslösbar ist genau das, was die Person im Portal „Zuhause“ schalten darf
  (Zuweisung durch einen Administrator); die Prüfung läuft beim Auslösen erneut.
- Optional: GateControl-Versionen ohne Schnellaktionen rufen sie nie auf –
  die Mindestversion bleibt unverändert.

## 1.2.0
- Farben ändern geht wieder: Die Farbvorgaben schickten Farbton/Sättigung, Farblampen
  mit „xy“-Farbraum (die meisten, z. B. „Extended color light“) bekamen dadurch keine
  Farbe. Die Vorgaben werden für diese Lampen jetzt in xy umgerechnet.
- Lampen mit Farbe **und** Farbtemperatur zeigen beide Regler (Seite und Portal).
- Portal „Zuhause“: Farbauswahl und Farbtemperatur für zugewiesene Lampen
  (nach Anmeldung), zusätzlich zu Schalter und Helligkeit.

## 1.1.0
- Benachrichtigungen über die Benachrichtigungszentrale von GateControl (Apps, Portal),
  jeweils als eigenes Thema, das jede Person selbst an- und abschalten kann:
  - **Alarm (Wasser, Rauch, CO)** (an, Priorität hoch): Wasser-, Rauch-/Feuer-, CO- oder
    Alarmsensor löst aus; endet der Alarm, ersetzt eine Entwarnung die Meldung.
  - **Fenster lange offen** (aus): Kontakt länger als N Minuten offen (Einstellung,
    Standard 15) – auf Gateways mit Thermostaten nur, während geheizt wird.
  - **Batterie schwach** (an): Sensorbatterie unter der Schwelle (Einstellung, Standard
    15 %) oder „Batterie schwach“ gemeldet; höchstens einmal pro Gerät und Tag, alle
    Geräte eines Gateways in einer Meldung.
  - **Gateway nicht erreichbar** (an, Priorität hoch): Gateway antwortet 5 Minuten lang
    nicht; ist es wieder da, ersetzt „wieder erreichbar“ die Meldung.
- Grundlage ist die ohnehin laufende Hintergrund-Abfrage (keine zusätzlichen Anfragen an
  die Gateways). Der zuletzt gesehene Zustand wird gespeichert: kein erneutes Melden nach
  einem Neustart, und beim ersten Lauf wird nichts gemeldet, was schon vorher so war.
- Empfänger: Alarm, Batterie und Gateway nach der Regel des Themas in GateControl
  (System › Benachrichtigungen); „Fenster offen“ an die dem Sensor zugewiesenen Personen,
  sonst ebenfalls nach der Regel. Eigene Obergrenze unter dem Limit von GateControl
  (30/h), Alarme haben Vorrang.
- Neue Einstellungen: Minuten für „Fenster offen“, Schwelle für „Batterie schwach“,
  Sprache der Benachrichtigungen (Deutsch/English).
- Neue Berechtigung **Benachrichtigungen** (`permissions.notify`) – beim Update fragt
  GateControl nach der Zustimmung. Benötigt GateControl ab 1.154.0.

## 1.0.0
- Erste Version als Plugin, Funktionsumfang der eingebauten Smart-Home-Integration:
  Gateways verbinden (API-Key automatisch holen oder eintragen), testen, synchronisieren;
  Lichter, Steckdosen, Gruppen, Szenen, Sensoren und Schalter; Steuerung (Ein/Aus,
  Helligkeit, Farbe, Farbtemperatur, Szenen); Besitzer je Gerät; Logikketten auf dem
  Gateway (Auslöser, Zeitfenster, Verzögerung mit ignorieren/zurücksetzen/abbrechen);
  Hintergrund-Abfrage (Abfrageintervall einstellbar).
- Portal: Abschnitt „Smart Home“ im gemeinsamen Tab „Zuhause“ (nur für Personen mit
  zugewiesenen Geräten), Kacheln auf der Startseite (Geräte und Sensorwerte) und
  Treffer in der Portal-Suche.
- Mehrere Gateways: je Gateway ein Zugriffsziel (GateControl-Route, VPN-Gerät oder Adresse),
  zugewiesen unter Einstellungen → Plugins → Smart Home → Zugriffsziele.
- deCONZ-API-Keys werden als verschlüsselte Plugin-Geheimnisse gespeichert.
- Übernahme der Daten der eingebauten Integration (Gateways inkl. API-Key und Route,
  Geräte, Besitzer, Regeln) – angeboten von GateControl ab 1.149.0.
