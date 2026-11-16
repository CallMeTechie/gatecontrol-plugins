-- gatecontrol-remote 1.4.0 — controlling a phone (stage 6, gc.remote version 5): whether the app of a phone can carry
-- input out at all (the GitHub build with its accessibility service; the Google Play build only shows its screen).
-- Whether the person allows it is asked at the phone for every request; nothing of an input is stored.
ALTER TABLE devices ADD COLUMN screen_control INTEGER;   -- 1 = this phone's app can be controlled, 0/NULL = view only
