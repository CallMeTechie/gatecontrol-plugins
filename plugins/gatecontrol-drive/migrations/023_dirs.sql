-- Drive 1.29.1: the folders by their parent, with what the walk down a tree asks of each (in the trash? a vault?).
-- The photo pages below a folder (the camera folder, a work folder) walk the folders of that tree in every statement;
-- inside a statement over the photos SQLite did not take nodes_parent for it but made itself an index of all folders
-- for the run — one pass over every node per statement. Only folders are in this index: a file never writes it.
CREATE INDEX nodes_dirs ON nodes (parent_id, deleted_at, vault_id) WHERE is_dir = 1;
