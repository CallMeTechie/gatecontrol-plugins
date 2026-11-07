-- gatecontrol-print 1.1.0 — paper and tray of a job, searchable PDFs of scans (text recognition on a gateway)

-- the paper (PWG name, e.g. iso_a4_210x297mm) and the tray a person chose; null: the printer's default
ALTER TABLE jobs ADD COLUMN media TEXT;
ALTER TABLE jobs ADD COLUMN source TEXT;

-- a session being saved as a searchable PDF: state 'ocr' while GateControl's text recognition runs (gc.print.ocr)
ALTER TABLE scans ADD COLUMN ocr_id TEXT;        -- the running text recognition, null when none
ALTER TABLE scans ADD COLUMN ocr TEXT;           -- searchable (saved with text) | failed:<reason> (saved without) | null
ALTER TABLE scans ADD COLUMN save_opts TEXT;     -- { name, folderId } (JSON) — where it goes once the text is there
