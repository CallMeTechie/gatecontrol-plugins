<!-- version: 1.19.0 -->
# Familie

## Was das Plugin kann

Die Familie in der GateControl-App (eigener Tab), im Portal (Tab „Familie“) und auf einem Wand-Tablet. Alles bleibt auf deinem Server. Jede Funktion schaltest du einzeln ein oder aus:

- **Alltag:** gemeinsame Einkaufslisten (offline nutzbar, „Ich gehe einkaufen“), Aufgaben mit Erinnerung (fest, reihum oder wer zuerst), Termine und Geburtstage, Pinnwand und Packlisten, Essensplan.
- **Unterwegs:** Abholen & Fahrten („Wer holt Tim?“), Orts-Erinnerungen beim Ankommen oder Verlassen.
- **Kinder & Sicherheit:** Sterne für Kinder, Kinder orten auf Anfrage (das Kind sieht jede Abfrage, endet mit 18), „Bin angekommen“ und SOS, Notfall-Karte.
- **Geld:** Taschengeld (nur Buchhaltung), Wunschlisten, Haushaltsbuch.
- **Zuhause:** Anwesenheit per App oder Heim-WLAN mit Smart-Home-Regeln (nur mit Zustimmung), Regeln und Erinnerungen, **Internet zu Hause** (Pause und „Heute länger“ für Kinder).
- **Zusammenspiel:** Gruppe „Familie“ in GateControl und im Messenger, Termine aus Alltag und Schule, Schnellaktionen anderer Plugins in Regeln.

## Voraussetzungen

- GateControl **1.216.0** oder neuer (Anwesenheit über das Heimnetz ab 1.230.0, Internet zu Hause ab 1.231.0).
- GateControl-Konten für alle Familienmitglieder.
- Für die Anwesenheit über das Heimnetz und Internet zu Hause: ein GateControl-Gateway mit Netzwerk-Wächter bzw. DNS-Filter, auf dem die Handys den Personen zugeordnet sind.
- Für den Familien-Chat: das Plugin Messenger. Für Schalten im Smart Home: das Plugin des Geräts (z. B. Smart Home, Tür & Kamera).

## Einrichten

1. **Mitglieder:** Admin-Seite **„Mitglieder & Ortung“** – GateControl-Konten als **Elternteil** oder **Kind** hinzufügen, mit Geburtsdatum (für Kinder Pflicht), Farbe, Sterne-Ziel und Ortungsart je Kind (*Kind bestätigt*, *Automatisch*, *Aus*).
2. **Funktionen:** Admin-Seite **„Funktionen“** – die gewünschten Funktionen einschalten. Mit „Vorschau als …“ siehst du den App-Tab so, wie ein Mitglied ihn sieht. Hier schaltest du auch die Gruppe „Familie“ im Messenger.
3. **Einstellungen** (**Einstellungen › Plugins › Familie › Einstellungen**): Zeitzone, Sprache der Mitteilungen, Breiten- und Längengrad des Zuhauses (für „nach Sonnenuntergang“), „Kinder dürfen eigene Erinnerungen anlegen“, Einkaufen und früher Schulschluss.
4. **Anwesenheit & Smart Home** (optional): Jede Person stimmt selbst zu („Anwesenheit teilen“ in der App bzw. im Portal die Karte „Wie erkennt die Familie, dass ich zu Hause bin?“). Für das Heim-WLAN ordnet ein Administrator das Handy am Gateway der Person zu; die Person schaltet es selbst ein. Regeln legen Eltern auf der Seite **„Anwesenheit & Smart Home“** oder im Portal an.
5. **Wand-Tablet** (optional):
   1. Ein eigenes GateControl-Konto anlegen (z. B. „Küche“, Rolle Mitglied, kein Administrator).
   2. Unter „Mitglieder & Ortung“ als **„Wand-Tablet“** hinzufügen.
   3. In GateControl das Konto öffnen › **„Kiosk-Gerät koppeln“**. Auf dem Tablet den QR-Code scannen oder `https://<dein Portal>/portal/kiosk` öffnen und den Code eingeben.
   4. Den Kiosk-Browser des Tablets auf `https://<dein Portal>/portal` stellen.
   Die Kopplung hält 90 Tage und verlängert sich bei jeder Benutzung. Beenden: in GateControl beim Benutzer › „Kiosk-Geräte“ › „Widerrufen“ oder „Abmelden“ auf dem Tablet.

## Benutzen

- **App-Tab „Familie“ und Portal-Tab „Familie“:** Übersicht des Tages, Einkaufslisten, Aufgaben, Termine, Pinnwand, Essensplan, Wunschlisten, Taschengeld, Fahrten und die eingeschalteten Funktionen.
- **Kinder orten** (Eltern): Anfrage mit Countdown und Karte. Das Kind sieht jede Abfrage; bei *Kind bestätigt* sendet oder lehnt es ab. Höchstens 30 Anfragen pro Kind und Tag.
- **„Bin angekommen“ und SOS** (App): „Bin angekommen“ an die Eltern, SOS als dringende Mitteilung mit Position – auch in der Ruhezeit.
- **Regeln:** z. B. „Alle sind unterwegs“ › Licht aus, „Erste Person kommt heim“ › Szene, „Kind allein zu Hause“ › Mitteilung an die Eltern; mit Zeitfenster und „nach Sonnenuntergang“.
- **Internet zu Hause** (Eltern, Portal): je minderjährigem Kind „Pause …“ (30 Min., 1 Std., bis morgen 7 Uhr, bis Uhrzeit), „Pause beenden“, „Heute länger …“. Das Kind bekommt Bescheid. Unterwegs im Mobilfunk gilt das nicht.
- **Wand-Tablet:** Termine, Aufgaben zum Abhaken, Einkauf, Essen, wer zu Hause ist, „Schule heute“ (mit Plugin Schule), WLAN-Karte (mit Plugin Vault).
- **„Notizen & Aufgaben“** (wenn installiert): deine Aufgaben, die Aufgaben der Kinder (für Eltern), Einkaufslisten mit Offenem und die Erinnerungen von heute stehen dort in „Mein Tag“. Abhaken dort zählt in Familie (mit Sternen). **Pinnwand und Packlisten** ziehen dann in „Notizen & Aufgaben“ um – du siehst und bearbeitest sie in Familie weiter wie bisher, und im Hub stehen sie als Notizbücher „Pinnwand“ und „Packlisten“ für die ganze Familie. Ist das Plugin einmal nicht erreichbar, arbeitet Familie weiter und gleicht später ab; Vorlagen bleiben in Familie.

## Berechtigungen

- **Eltern** legen Aufgaben, Termine und Regeln an, orten Kinder, sehen Haushaltsbuch und Taschengeld aller Kinder und steuern Internet zu Hause.
- **Kinder** haken Aufgaben ab, sehen ihr Taschengeld, senden „Bin angekommen“ und SOS. Ab dem 18. Geburtstag endet die Ortung von selbst.
- **Wand-Tablet** hakt Aufgaben ab und fügt Einkäufe hinzu, sieht aber keine Positionen.
- Portal-Besuche, die nur über Geräte-Vertrauen erkannt sind, lesen nur – keine Positionen, kein SOS, keine Anwesenheit.
- Anwesenheit und Orte zählen in Regeln nur für Personen, die selbst zugestimmt haben.

## Häufige Fragen / Fehlersuche

**Der App-Tab „Familie“ fehlt.**
Die Person ist kein Mitglied, oder keine Funktion ist eingeschaltet.

**Eine Ortung meldet „Keine Antwort von …s Handy“.**
Das Handy hat 10 Minuten nicht geantwortet (aus, kein Netz, App beendet). Versuch es später noch einmal; zwischen zwei Anfragen liegen mindestens 60 Sekunden.

**Eine Regel löst nicht aus.**
Haben alle betroffenen Personen „Anwesenheit teilen“ eingeschaltet? Eine Regel greift einmal pro Wechsel und höchstens alle 10 Minuten. Das Protokoll der Regeln zeigt jeden Lauf; „Aktion nicht mehr verfügbar“ heißt, das andere Plugin bietet die Schnellaktion nicht mehr an.

**Das Wand-Tablet lässt sich nicht koppeln.**
Ein Administrator-Konto oder ein deaktiviertes Konto kann kein Wand-Tablet sein. Nimm ein eigenes Konto mit der Rolle Mitglied.

**Eine Änderung an der Pinnwand fehlt in „Notizen & Aufgaben“ (oder umgekehrt).**
Änderungen in Familie gehen sofort hinüber, Änderungen im Hub kommen nach spätestens 15 Minuten (meist nach einer halben Minute). War „Notizen & Aufgaben“ nicht erreichbar, holt Familie das beim nächsten Lauf nach.

**Die Karte „Internet zu Hause“ fehlt.**
Sie braucht GateControl 1.231.0 und ein Gateway mit DNS-Filter, und sie erscheint nur für Eltern nach der Anmeldung.

## Neu in 1.19.0

- **„Notizen & Aufgaben“:** Mit dem Plugin „Notizen & Aufgaben“ stehen Aufgaben, Einkaufslisten und Erinnerungen der Familie dort in „Mein Tag“ und lassen sich dort abhaken. Pinnwand und Packlisten ziehen dorthin um und bleiben in Familie sichtbar und bearbeitbar. Ohne das Plugin ändert sich nichts.

## Neu in 1.18.1

- Dieses Handbuch im Reiter „Handbuch“ (GateControl ≥ 1.241.0).

Zuletzt in 1.18.0: Internet zu Hause – Eltern pausieren das Internet eines Kindes im Heimnetz oder geben ihm „Heute länger“; das Kind bekommt Bescheid.
