-- Mail 1.17.1: the list „mit Anhang“ along the mails that have one. Before, it walked the list of the folder
-- (messages_list) and read every mail's row to look at has_att: with few attachments nearly the whole folder for each
-- page — on a slow disk seconds. The index holds only the mails with an attachment (server/messages.js page names it).
CREATE INDEX messages_att ON messages (folder_id, date DESC, id DESC) WHERE has_att = 1;
-- the hook mediaScanned finds the attachments and the files of drafts of a file by its media id (server/scan.js) —
-- before, every result of the virus scan read all attachments
CREATE INDEX attachments_media ON attachments (media_id);
CREATE INDEX draft_atts_media ON draft_atts (media_id);
