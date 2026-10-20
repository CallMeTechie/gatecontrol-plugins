-- gatecontrol-schule 1.3.0: a colour per student, and links people made themselves in their
-- GateControl profile (portal "Meine Geräte" › „WebUntis verknüpfen“).

-- The student's colour (#RRGGBB of GateControl's palette): assigned automatically (distinct per
-- student) and changeable by an administrator; a student mapped to a GateControl user shows that
-- user's favourite colour instead.
ALTER TABLE students ADD COLUMN color TEXT;
-- Who mapped the student to user_id: 'admin' (settings) | 'self' (the user in the profile) | NULL
ALTER TABLE students ADD COLUMN link_source TEXT;

-- The GateControl user who connected this account in the profile (NULL = an administrator did)
ALTER TABLE accounts ADD COLUMN owner_user_id INTEGER;
