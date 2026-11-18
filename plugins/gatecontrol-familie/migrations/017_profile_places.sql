-- gatecontrol-familie 1.30.0: „Meine Orte“ from GateControl's profile (server/profileplaces.js, gc.places).
--
-- places.place_ref — a place reminder at a place of a person's profile: 'profile:<id>'. lat / lon / radius stay the copy
-- the target's phone watches; the hook placesChanged moves it along. place_missing = 1: the profile place went or the
-- reminder's owner may not see it any more — the copy still holds (missing in the answer).
ALTER TABLE places ADD COLUMN place_ref TEXT;
ALTER TABLE places ADD COLUMN place_missing INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_places_ref ON places(place_ref);

-- rule_places.profile_ref — a rule place linked to a profile place the owner shows to the family (visibility family or
-- all): made when a rule chooses 'profile:<id>', kept while a rule uses it, not one of the parents' 20 places and not
-- editable as one. name / lat / lon / radius are the copy the phones watch; profile_by = who chose it (the person the
-- place is resolved for); profile_missing as above.
ALTER TABLE rule_places ADD COLUMN profile_ref TEXT;
ALTER TABLE rule_places ADD COLUMN profile_by INTEGER;
ALTER TABLE rule_places ADD COLUMN profile_missing INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_rule_places_profile ON rule_places(profile_ref) WHERE profile_ref IS NOT NULL;
