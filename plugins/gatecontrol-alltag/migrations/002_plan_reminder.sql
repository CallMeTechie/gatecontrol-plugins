-- gatecontrol-alltag 1.1.0: the reminder of each Abfuhrplan.
-- NULL in a column = the plugin settings (the defaults), so the plans of
-- 1.0.0 keep their behaviour (evening before at waste_evening_time, on the
-- morning when waste_morning is on) until they are edited.
ALTER TABLE plans ADD COLUMN remind_lead INTEGER;       -- days before the pickup 0–3, -1 = no reminder
ALTER TABLE plans ADD COLUMN remind_time TEXT;          -- 'HH:MM' of that reminder
ALTER TABLE plans ADD COLUMN remind_extra INTEGER;      -- 1/0: also on the pickup day
ALTER TABLE plans ADD COLUMN remind_extra_time TEXT;    -- 'HH:MM' of the pickup-day reminder
