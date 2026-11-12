<!-- version: 1.1.0 -->
# DNS-Schutz

## Was das Plugin kann

- **Werbung, Tracker und Schadseiten sperren** – für alle Geräte, die über das VPN von GateControl ins Internet gehen. Der Server filtert selbst; es braucht kein zweites Gerät und kein Pi-hole.
- **Listen aus dem Katalog** von GateControl: Werbung & Tracker, Schadsoftware & Betrug, Inhalte für Erwachsene, Glücksspiel. Dazu eigene Einträge **„Immer erlaubt“** und **„Immer gesperrt“**.
- **Profile** für Gruppen, Personen und einzelne Geräte – mit eigenen Listen, Sicherer Suche und Zeiten (z. B. abends keine sozialen Netzwerke).
- **Unterbrechen**: den Schutz für ein paar Minuten ausschalten, wenn eine Seite nicht geht – in der Android-App, der Windows-App und im Portal. Er schaltet sich von selbst wieder ein.
- **„Domain prüfen“** zeigt, ob und warum eine Adresse für ein Gerät gesperrt ist.
- **Abfrageprotokoll** (abschaltbar, nach der Installation aus) und Zähler: Anfragen, gesperrt, Top gesperrte Domains.
- **Zu Hause und unterwegs:** Ein Profil lässt sich mit einem Profil des DNS-Filters im Heimnetz verbinden. „Internet pausieren“ aus dem Plugin Familie wirkt auch auf die VPN-Geräte.
- **Umgehung erschweren:** Auf Wunsch sperrt der Server fremde DNS-Server und DNS über TLS für die gefilterten Geräte.
- **Fällt der Filter aus**, läuft das Internet der Geräte ungefiltert weiter. Der Server schaltet in wenigen Sekunden selbst zurück und meldet es den Admins.

## Voraussetzungen

- GateControl **1.267.0** oder neuer.
- Das interne DNS von GateControl ist eingeschaltet (das ist die Voreinstellung).
- Eine Lizenz für das Plugin. Ohne Lizenz oder wenn das Plugin ausgeschaltet wird, filtert der Server nicht; die Einstellungen bleiben erhalten.
- Für „Eltern unterbrechen für ihre Kinder“ und „Internet pausieren“: das Plugin **Familie** (ab 1.15.0). Es legt die Familie als Gruppe in GateControl an.
- Für „Mit Heimnetz-Profil verbinden“: ein Heimnetz-Gateway mit DNS-Filter.
- Für die Ansicht in den Apps: eine App-Version mit dem Bildschirm „DNS-Schutz“. Ältere Apps zeigen ihn nicht; das Portal geht immer.

> **Hinweis:** Gefiltert werden Geräte, die den DNS-Server von GateControl benutzen. Ein Gerät mit einem eigenen DNS-Server (in GateControl unter Peers eingetragen) fragt den Server nicht und wird nicht gefiltert. Der Reiter „Geräte“ zeigt solche Geräte.

## Einrichten {#einrichten}

1. Öffne **Einstellungen › Plugins › DNS-Schutz › Einstellungen**. Beim ersten Aufruf startet der Dialog **„DNS-Schutz einrichten“**.
2. **Listen wählen.** Vorgeschlagen sind „Werbung & Tracker“ und „Schadsoftware & Betrug“. Die Auswahl gilt für alle VPN-Geräte und lässt sich später ändern.
3. **Einschalten.** Der Server lädt die Listen, prüft den Filter mit zwei Proben und schaltet dann das DNS der VPN-Geräte um. Dabei bleibt das DNS etwa eine Sekunde ohne Antwort.
4. **Fertig.** Lege danach bei Bedarf Profile an (Reiter „Profile“).

Mit **„Später“** schließt du den Dialog. Du findest ihn wieder über „Einrichten“ in der Übersicht.

### Umzug von Pi-hole {#umzug-von-pi-hole}

Nutzt du bisher die Pi-hole-Anbindung von GateControl mit „DNS-Kette verwalten“, erkennt der Dialog das. Es kann nur einer filtern: Pi-hole oder der DNS-Schutz.

1. **Erkannt:** Der Dialog nennt, was sich ändert und wo Pi-hole eingetragen ist (Adresse, Gateway). Bis zum Schritt „Umschalten“ filtert Pi-hole weiter.
2. **Listen:** Die Listen von Pi-hole lassen sich nicht auslesen. Vorgeschlagen ist, was Pi-hole ab Werk sperrt. Deine Ausnahmen kopierst du in Pi-hole unter „Domains“ → „Allowlist“ und fügst sie ein (eine Domain je Zeile).
3. **Umschalten:** Erst wenn der Filter wirklich antwortet, gibt Pi-hole die DNS-Kette ab. Schlägt ein Schritt fehl, bleibt Pi-hole aktiv und der Dialog nennt den Grund.
4. **Fertig:** Pi-hole wird für die VPN-Geräte nicht mehr gebraucht. Du kannst es ausschalten oder für das Heimnetz weiterlaufen lassen.

Zurück zu Pi-hole: Reiter „Einstellungen“ › **„Schutz ausschalten“**, danach in den Pi-hole-Einstellungen von GateControl „DNS-Kette verwalten“ wieder einschalten.

> **Hinweis:** Die Pi-hole-Anbindung in GateControl ist abgekündigt und entfällt in einer späteren Version.

## Benutzen

### Übersicht

Zeigt, ob gefiltert wird, die Zähler von heute, die häufigsten gesperrten Domains und die aktiven Listen. Ein Klick auf eine Domain öffnet „Domain prüfen“.

- **Unterbrechen für alle VPN-Geräte:** 5 Min., 30 Min., 1 Std. oder „bis ich wieder einschalte“. Solange wird nichts gesperrt und nichts gezählt. **„+30 Min.“** verlängert, **„Wieder einschalten“** beendet die Unterbrechung.
- **Gesperrt durch:** teilt die gesperrten Anfragen von heute auf – Listen, für alle gesperrt, im Profil gesperrt, Zeiten, Internet pausiert.
- **Internet pausiert:** Hat jemand im Plugin Familie das Internet einer Person pausiert, steht das hier mit Name und Ende.
- **Rückfall:** Antwortet der Filter nicht, steht hier und im Dashboard ein roter Hinweis. Das Internet der Geräte läuft weiter. **„Filter-Dienst neu starten“** startet ihn von Hand neu; meist schaltet der Server von selbst zurück.

### Listen & Ausnahmen

- **Listen aus dem Katalog:** Die Schalter gelten für das Standardprofil. Andere Profile wählen ihre Listen selbst. Listen werden täglich neu geladen; „Jetzt aktualisieren“ lädt sofort.
- **Domain prüfen:** Adresse eintragen, Gerät oder Profil wählen, „Prüfen“. Das Ergebnis nennt Profil, Grund und den treffenden Eintrag (z. B. „Treffer tiktok.com mit allen Unterseiten“) – bei eigenen Einträgen auch, ob sie für alle oder nur im Profil gelten – und bietet „Für alle erlauben“ oder „Nur im Profil … erlauben“ an.
- **Immer erlaubt / Immer gesperrt:** gelten in jedem Profil. Ein Eintrag umfasst die Domain und alle Unterseiten. Steht eine Domain in beiden Feldern, gewinnt „Immer erlaubt“. Mehrere Einträge kannst du als Liste einfügen.

Namen im eigenen Netz (Geräte, Routen, Portal) werden nie gesperrt.

### Profile {#profile}

Ein Profil bündelt Listen, Sichere Suche, Zeiten und eigene Einträge. Mitglieder sind **Gruppen**, **Personen** und **Geräte**.

**Welches Profil gilt?** Gerät schlägt Person schlägt Gruppe schlägt Standard: Hat ein Gerät ein eigenes Profil, gilt dieses. Sonst das Profil der Person, der das Gerät gehört. Sonst das Profil der Gruppe. Sonst das Standardprofil. Stehen zwei Profile auf derselben Stufe, gewinnt das weiter oben stehende.

- **Sichere Suche:** Google, Bing, DuckDuckGo und YouTube liefern nur jugendfreie Treffer.
- **Zeiten:** Tage und Uhrzeit, in der „Soziale Netzwerke“, „Spiele“, „Videos“ oder alles gesperrt ist. Liegt „Bis“ vor „Von“, geht die Zeit über Mitternacht. Es gilt die Zeitzone des Servers.
- Das **Standardprofil** hat keine Mitglieder und lässt sich nicht löschen.

### Mit Heimnetz-Profil verbinden {#heimnetz}

Hat dein Heimnetz-Gateway einen DNS-Filter, kann ein Profil **zu Hause und unterwegs** gelten. Öffne das Profil und wähle unter **„Mit Heimnetz-Profil verbinden“**:

- **ein Profil des Heimnetzes:** Beim Speichern übernimmt das Profil dessen Listen, Sichere Suche, Zeiten, „Immer erlaubt“, „Immer gesperrt“ und Personen. Die bisherigen Angaben hier werden ersetzt.
- **„Im Heimnetz … neu anlegen“:** Das Heimnetz bekommt dieses Profil mit seinem Inhalt und Namen.

Danach zeigt das Profil **„gilt zu Hause und unterwegs“**. Die Felder mit der Marke „Heimnetz“ stehen im Heimnetz-Profil: Eine Änderung hier wirkt auch zu Hause, eine Änderung auf der Gateway-Seite wirkt in Sekunden auch unterwegs. **Nur hier** gelten der Name, Gruppen und Geräte.

- **„Verbindung lösen“:** Beide Profile behalten ihren Stand und werden danach getrennt gepflegt.
- Das Standardprofil lässt sich nur mit dem Standardprofil des Heimnetzes verbinden.
- Ein Heimnetz-Profil kann nur mit einem Profil verbunden sein.
- Wird das Profil im Heimnetz gelöscht, löst sich die Verbindung von selbst; das Profil behält den letzten Stand.

### Geräte

Alle VPN-Geräte mit dem Profil, das für sie wirkt, und – bei eingeschaltetem Protokoll – den Zählern von heute. Über **„Profil ändern“** gibst du einem Gerät ein eigenes Profil oder nimmst es ganz aus. Gateways werden nie gefiltert.

**„Internet pausiert bis …“** steht bei Geräten einer Person, deren Internet im Plugin Familie pausiert ist. **„Zeiten ausgesetzt bis …“** zeigt „Zeit verlängern“ aus Familie.

### Protokoll {#protokoll}

Nach der Installation ist das Abfrageprotokoll **aus**: Der Server speichert dann nur Zähler, nichts je Gerät.

- **Einschalten:** Gespeichert wird, welches Gerät wann welche Adresse aufgerufen hat und ob sie gesperrt wurde.
- **Aufbewahrung:** 24 Stunden, 3, 7 (Standard) oder 30 Tage. Ältere Einträge löscht der Server von selbst.
- **Wer darf es sehen:** „Nur Admins“ oder „Benutzer sehen eigene Geräte“ (im Portal, nie die Geräte anderer).
- **Ausschalten** löscht das vorhandene Protokoll und die Zähler je Gerät.
- **„Erlauben“ / „Sperren“** in einer Zeile legt einen eigenen Eintrag an – für alle oder nur für das Profil des Geräts.
- **Grund:** Bei eigenen Einträgen steht dabei, ob sie für alle gelten („Immer gesperrt (für alle)“) oder zum Profil gehören. Der Filter „Eigene Einträge“ zeigt nur das eine oder das andere.

### Einstellungen

- **Schutz ausschalten / einschalten.**
- **Weiterleiten an:** Was nicht gesperrt wird, fragt der Server verschlüsselt bei Quad9, Cloudflare oder einem eigenen Dienst (DNS über HTTPS) nach. „Rückfall auf die DNS-Server des Servers“ hält das Internet erreichbar, wenn der Dienst nicht antwortet.
- **Unterbrechen** – siehe [Berechtigungen](#berechtigungen).
- **Mitteilungen:** „Bei Ausfall des Filters“ (an alle Admins), „Auch Benutzer benachrichtigen“ (dann auch an alle, deren VPN-Geräte gefiltert werden; Standard aus) und „Wochenbericht“ (montags).
- **Umgehung erschweren** – siehe unten.
- **Heimnetz und Familie:** „„Internet pausieren“ aus Familie wirkt auch unterwegs“ (Standard an) und welche Profile mit dem Heimnetz verbunden sind.

### Umgehung erschweren {#umgehung}

Der Schalter **„Fremden DNS und DoT sperren“** ist nach der Installation **aus**. Eingeschaltet gilt für jedes Gerät, das gerade gefiltert wird:

- Anfragen an fremde DNS-Server (Port 53) beantwortet der DNS-Schutz – mit dem Profil des Geräts.
- DNS über TLS (Port 853, „Privates DNS“ von Android) wird abgewiesen. Android im Modus „Automatisch“ nutzt dann das normale DNS.

**Unberührt bleiben** Geräte mit eigenem DNS-Server, ausgenommene Geräte und Gateways mit den Netzen dahinter.

**Die Regeln entfallen**, solange der Filter ausgefallen ist (Rückfall), der Schutz aus ist oder für alle unterbrochen wurde. Für ein einzeln unterbrochenes Gerät entfallen sie, solange es unterbrochen ist.

Die Karte zeigt den Zustand: „aktiv für N Geräte“, „ruht“ oder einen Fehler. Bei einem Fehler laufen Internet und Filter normal weiter; nur die Sperre fehlt.

> **Hinweis:** DNS über HTTPS (DoH) wird **nicht** gesperrt. Im Netz sieht es aus wie normales HTTPS. Firefox schaltet sein eigenes DoH hinter dem DNS-Schutz ab. Ein von Hand eingetragener DoH-Server, ein weiteres VPN oder ein Browser mit eingebautem Proxy umgehen den Filter weiterhin.

> **Hinweis:** Ein Gerät mit fest eingetragenem „Privatem DNS“ löst keine Namen mehr auf. Stelle es auf „Automatisch“ oder nimm das Gerät aus.

### In den Apps und im Portal

- **Android- und Windows-App:** Zustand, Zähler und Unterbrechen für das eigene Gerät.
- **Portal-Tab „DNS-Schutz“:** Zustand, Unterbrechen für die eigenen VPN-Geräte, „Meine Geräte“, für Admins und Eltern „Für andere unterbrechen“ und – wenn freigegeben – „Mein Protokoll“.

Ist das Protokoll aus, zeigen App und Portal die Zähler des ganzen Servers.

Ist das Internet einer Person pausiert (Familie), zeigt das Portal „Internet pausiert bis …“. „Unterbrechen“ wird solange nicht angeboten – es würde die Pause nicht aufheben.

## Berechtigungen {#berechtigungen}

**Wer darf unterbrechen?**

- **Jeder** für die eigenen Geräte.
- **Admins** für alle – auf der Einstellungsseite für alle VPN-Geräte auf einmal.
- **Eltern** auch für die Mitglieder ihrer Familie (Plugin Familie), aber nie für Admins.

Im Reiter „Einstellungen“ legst du fest:

- **Wer darf den Schutz in der App unterbrechen:** „Nur Admins“, „Alle Benutzer“ (Voreinstellung) oder „Je Profil“. Bei „Je Profil“ hat jedes Profil den Schalter „Mitglieder dürfen den Schutz in der App unterbrechen“. Eltern können für ihre Kinder auch dann unterbrechen, wenn das Profil der Kinder gesperrt ist.
- **Längste Dauer für Benutzer:** 5 Min., 30 Min., 1 Std. (Voreinstellung) oder 4 Std.
- **„Bis ich wieder einschalte“:** für Benutzer aus (Voreinstellung). Admins können immer ohne Ende unterbrechen.

Wieder einschalten darf jeder für die eigenen Geräte. Eine Unterbrechung für alle Geräte beendet nur ein Admin. Jede Unterbrechung steht mit Person und Dauer in der Aktivität von GateControl.

**Das darf das Plugin** (bei der Installation gezeigt): DNS der VPN-Geräte filtern; Benutzer und Gruppen lesen; Mitteilungen senden; in App und Portal erscheinen; im Hintergrund laufen (Wochenbericht).

## Häufige Fragen / Fehlersuche

**Ein Gerät wird nicht gefiltert.**
Sieh im Reiter „Geräte“ nach. „Eigener DNS“: Das Gerät hat einen eigenen DNS-Server eingetragen – entferne ihn unter Peers › Gerät. „Ausgenommen“: über „Profil ändern“ wieder aufnehmen. Auch „Privates DNS“ in Android oder ein Browser mit eigenem DNS umgeht den Filter – dagegen hilft [„Fremden DNS und DoT sperren“](#umgehung), nicht aber gegen DNS über HTTPS.

**Eine Seite geht nicht mehr.**
„Domain prüfen“ nennt die Liste oder den Eintrag. Mit „Für alle erlauben“ legst du eine Ausnahme an. Für den Moment hilft „Unterbrechen“.

**In der Übersicht steht „Rückfall“.**
Der Filter-Dienst antwortet nicht; die Geräte laufen ungefiltert. Der Server versucht es alle 2 Sekunden erneut. „Filter-Dienst neu starten“ hilft, wenn er hängt.

**In der App steht „Unterbrechen nicht erlaubt“.**
Der Admin hat „Nur Admins“ gewählt oder das Unterbrechen für das Profil gesperrt.

**„Das interne DNS des Servers ist ausgeschaltet“.**
GateControl läuft mit `GC_DNS_ENABLED=false`. Der DNS-Schutz braucht das interne DNS.

**Die Spalten „Anfragen“ und „Gesperrt“ zeigen „–“.**
Zähler je Gerät gibt es nur mit eingeschaltetem Abfrageprotokoll.

**Bei einem Gerät steht „Internet pausiert“.**
Jemand hat im Plugin Familie das Internet dieser Person pausiert. Es antworten nur Einträge aus „Immer erlaubt“. Beenden lässt sich die Pause nur in Familie. Soll sie unterwegs nicht gelten: Reiter „Einstellungen“ › „Heimnetz und Familie“.

**Nach „Fremden DNS und DoT sperren“ hat ein Handy kein Internet mehr.**
Auf dem Gerät ist ein fester Anbieter als „Privates DNS“ eingetragen. Stelle „Privates DNS“ auf „Automatisch“ oder nimm das Gerät im Reiter „Geräte“ aus.

**„Im Heimnetz gibt es schon ein Profil mit diesem Namen“.**
Verbinde mit dem vorhandenen Heimnetz-Profil, statt es neu anzulegen – oder gib dem Profil erst einen anderen Namen.

## Neu in 1.1.0

- **Umgehung erschweren:** Schalter „Fremden DNS und DoT sperren“ mit Anzeige des Zustands.
- **Profile gemeinsam mit dem Heimnetz:** „Mit Heimnetz-Profil verbinden“ im Profil-Dialog – gilt zu Hause und unterwegs.
- **„Internet pausieren“ aus Familie** wirkt auch auf die VPN-Geräte (abschaltbar) und wird in Übersicht, Geräten und Portal gezeigt.
- **Domain prüfen** nennt den treffenden Eintrag; Übersicht und Protokoll unterscheiden „für alle gesperrt“ und „im Profil gesperrt“.
- **Umzug von Pi-hole** nennt Adresse und Gateway von Pi-hole.
- **Mitteilung „Filter ausgefallen“** auf Wunsch auch an Benutzer.
- Braucht GateControl 1.267.0.

## Neu in 1.0.0

Erste Version: Listen und Ausnahmen, Profile für Gruppen, Personen und Geräte, Unterbrechen in App, Portal und auf der Einstellungsseite, Abfrageprotokoll, Einrichtungsdialog mit Umzug von Pi-hole, Mitteilungen bei Ausfall und Wochenbericht.
