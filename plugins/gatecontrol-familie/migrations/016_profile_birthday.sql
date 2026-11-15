-- gatecontrol-familie 1.26.0: the birthday from the user profile (server/profile.js, GateControl ≥ 1.280.0).
--   members.birthdate_profile   1 = members.birthdate is the copy Familie took over once from the person's profile
--                               (a parent with an empty birthday); it goes when the person removes the birthday from her
--                               profile. 0 = entered by the parents (children) or from before.
ALTER TABLE members ADD COLUMN birthdate_profile INTEGER NOT NULL DEFAULT 0;
