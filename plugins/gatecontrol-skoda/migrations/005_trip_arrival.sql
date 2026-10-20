-- gatecontrol-skoda 1.5.2: the vehicle parked somewhere else, but its mileage
-- was not reported higher yet (Škoda updates the reported mileage later than
-- the position). The arrival is kept here and the trip recorded from the last
-- spot to it once the mileage is higher; the spot stays the trip's start.
ALTER TABLE trip_state ADD COLUMN arrived_lat REAL;
ALTER TABLE trip_state ADD COLUMN arrived_lon REAL;
ALTER TABLE trip_state ADD COLUMN arrived_at TEXT;
